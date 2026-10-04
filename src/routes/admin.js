import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAdmin, isAdminEmail } from '../middleware/auth.js';
import { geocode } from '../lib/geocode.js';
// notifyAdmins rides along for ONE case: a vendor delete that could not confirm
// a subscription stopped billing (see DELETE /vendors/:id). A console line alone
// is not enough there — nobody tails a dyno log — and the id in that push is the
// only remaining handle on a card that may still be charged every month.
import { getVapidPublicKey, notifyAdminEndpoint, notifyAdmins, pushEnabled } from '../lib/push.js';
// The notification log + queue screen (migration-062) reads, never steers, the
// three send workers: their status, their in-memory backoff lists and their
// config, so the queue it shows is computed with the numbers the claims use.
import { NOTIFICATION_KINDS, deviceLabelFromUA, notificationLogState, serviceOf } from '../lib/notification-log.js';
import { CAMPAIGN_CONFIG, campaignWorkerStatus } from '../lib/campaigns.js';
import { REMINDER_CONFIG, previewReminder, reminderBackoff, reminderWorkerStatus } from '../lib/reminders.js';
import { broadcastBackoff, broadcastWorkerStatus } from '../lib/broadcasts.js';
import { isUuid } from '../lib/ids.js';
import { rollupPlatformOverview } from '../lib/analytics.js';
import { rollupRoi } from '../lib/roi.js';
import { generateResetCode, normalizeResetCode } from '../lib/reset-codes.js';
import { sendEmail, emailUrl, emailEnabled } from '../lib/email.js';
import { applicationAccepted, vendorResetCode } from '../lib/email-templates.js';
import { validReward, validRatio, validStarterItems, starterItemToReward } from '../lib/rewards.js';
import { validReferralConfig, runReferralSweep } from '../lib/referrals.js';
import { validSignupConfig } from '../lib/signup-bonus.js';
import {
  getPoster, putPoster, deletePoster, readPoster, decodePosterBody,
  POSTER_MAX_BYTES, POSTER_EXTENSIONS,
} from '../lib/qr-poster.js';
import {
  createTrackedQr,
  NAME_MAX as QR_NAME_MAX,
  NOTE_MAX as QR_NOTE_MAX,
  POINTS_MAX as QR_POINTS_MAX,
} from '../lib/tracked-qr.js';
// Aliased on the way in, all of them: this file already has a NAME_MAX, an
// EMAIL_RE and a normalizeCode-shaped idea of its own, and the ambassador rules
// are deliberately different from every one of them (migration-053).
import {
  normalizeCode as normalizeAmbassadorCode,
  normalizeEmail as normalizeAmbassadorEmail,
  findAccountByEmail,
  isValidPhone,
  NAME_MAX as AMB_NAME_MAX,
  CODE_MIN as AMB_CODE_MIN,
  CODE_MAX as AMB_CODE_MAX,
  POINTS_MAX as AMB_POINTS_MAX,
} from '../lib/ambassadors.js';
import { emitBalance, visibleUserIds } from '../lib/realtime.js';
// The one place the "which table holds this vendor's points" rule is written
// down (migration-044). Re-deriving it inline in a support screen is how the
// support screen ends up disagreeing with the till.
import { balanceFrom } from '../lib/pools.js';
import { invalidateVendorCaches } from '../lib/cache.js';
import { normalizeCuisine, normalizePriceLevel } from '../lib/cuisines.js';
import { validLogo } from '../lib/logo.js';
// The operator panel does not sell anything, so this is the only reason it talks
// to Stripe at all: DELETE /vendors/:id has to stop a subscription before it
// destroys the row that records it (migration-055 keeps the customer and
// subscription ids on vendors). `stripeEnabled` rides along because this
// deployment may have no keys set yet, and "we could not even try to cancel" is
// a different answer to the operator than "Stripe refused".
//
// getSubscription is imported for one job only: reading a subscription BACK
// after a cancel answered 404, which is the only way to tell "already cancelled"
// from "not in this Stripe account or mode" — the two things Stripe answers that
// 404 for. stripeMode() names which mode this process is actually keyed for, so
// the refusal it produces points the operator at the right dashboard.
import { cancelSubscription, getSubscription, stripeEnabled, stripeMode } from '../lib/stripe.js';

const router = Router();
router.use(requireAdmin);

const DAY = 86_400_000;
const ADDRESS_MAX = 300;   // keep a pasted essay out of the column and the geocoder

// The Stripe subscription statuses that mean "this object can never bill a card
// again": 'canceled' is what a cancel leaves behind (the object is NOT removed —
// see cancelSubscription in src/lib/stripe.js), and 'incomplete_expired' is a
// subscription whose first payment never completed inside Stripe's window. Used
// by DELETE /vendors/:id ONLY, to decide whether a 404 from a cancel really did
// mean "already cancelled". Deliberately NOT the inverse of statusIsPaying:
// 'paused', 'unpaid' and 'incomplete' are neither paying nor finished, and a
// subscription in one of those can still start charging again, so they must not
// license destroying the row that holds the id.
//
// ⚠ DUPLICATED, deliberately and for now, as TERMINAL_STATUSES in
// src/routes/stripe-webhook.js — which carries the full note, and is read there
// by cancel404Verdict and refuseDuplicateSubscription. Both copies answer the
// same question, "did a GET prove this subscription is finished?", both are read
// straight after a DELETE answered 404, and THEY MUST STAY IN STEP: a status
// added to one and not the other makes one path treat a subscription as dead
// that the other still pages the operator about. Change both or neither. The
// follow-up that removes the obligation is the one that file names — hoist a
// single export into src/lib/stripe.js beside PAYING_STATUSES — which needs a
// change willing to touch both files; this note exists because until then the
// only thing holding the pair together was a warning on the other side.
const TERMINAL_SUBSCRIPTION_STATUSES = ['canceled', 'incomplete_expired'];

// Keep in sync with src/routes/apply.js — the operator's "Add vendor" form is
// the same onboarding as an accepted /join application, so what one accepts the
// other must accept too. The logo rule is no longer among these: it moved to
// src/lib/logo.js, which all four doors import, because "keep in sync" had
// already failed there once (see that file).
const NAME_MAX = 80;
const EMAIL_MAX = 254;
const LABEL_MAX = 40;      // same cap as vendors.location_label (apply.js / vendor.js)
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;   // bcrypt reads 72 bytes; refuse longer, never truncate
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The contact the operator phones (migration-049). Same cap and the same
// permissive shape as /join's, because a number typed on one door and a number
// typed on the other end up in the same column. Permissive on purpose: this is
// dialled by a human, so a plausible-looking string beats a strict format that
// rejects the way somebody actually writes their own number.
const PHONE_MAX = 20;      // same cap as vendors.phone (migration-049)
const PHONE_RE = /^[\d\s()+.-]{7,20}$/;

// How long a minted password-reset code stays usable. Long enough to finish the
// phone call and walk to the terminal, short enough that a code read out and
// forgotten about doesn't sit there for the rest of the day.
const RESET_TTL_MINUTES = 30;

/** Trimmed vendor display name → { value } or { error }. Shared by create + rename. */
export function validVendorName(raw) {
  const name = String(raw ?? '').trim();
  if (!name || name.length > NAME_MAX) {
    return { error: `Business name is required (max ${NAME_MAX} characters).` };
  }
  return { value: name };
}

/**
 * Validate POST /vendors → the fields onboardVendor needs, or { error } to 400.
 * Deliberately the same rules as validApplication in src/routes/apply.js, minus
 * `message` — the applicant's free-text pitch, which exists to help the operator
 * judge an application and has nowhere to live on a vendors row.
 *
 * The contact name and phone were in that same "review-time only" category until
 * migration-049, on the reasoning that an operator adding a vendor by hand has
 * already decided. That was wrong in one specific way: the phone number's job
 * starts AFTER onboarding, not before — it is how a reset code reaches a vendor
 * who has lost their mailbox as well as their password (migration-031). They are
 * columns now, and both doors collect them.
 *
 * The one difference between the doors is that a phone is REQUIRED on /join and
 * optional here; see the comment on the check below for why that is a decision
 * rather than drift.
 */
export function validNewVendor(body) {
  const b = body ?? {};
  const n = validVendorName(b.name);
  if (n.error) return { error: n.error };

  const email = String(b.email ?? '').trim().toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  const address = String(b.address ?? '').trim();
  const label = String(b.locationLabel ?? '').trim();
  const contactName = String(b.contactName ?? '').trim();
  const phone = String(b.phone ?? '').trim();
  const logo = validLogo(b.logo);

  if (!EMAIL_RE.test(email) || email.length > EMAIL_MAX) return { error: 'Enter a valid email address.' };
  if (password.length < PASSWORD_MIN) return { error: `Password must be at least ${PASSWORD_MIN} characters.` };
  if (password.length > PASSWORD_MAX) return { error: `Password must be ${PASSWORD_MAX} characters or fewer.` };
  if (address.length > ADDRESS_MAX) return { error: `Address must be ${ADDRESS_MAX} characters or fewer.` };
  if (label.length > LABEL_MAX) return { error: `The location name must be ${LABEL_MAX} characters or fewer.` };
  if (logo.error) return { error: logo.error };
  if (contactName.length > NAME_MAX) return { error: `Contact name must be ${NAME_MAX} characters or fewer.` };
  // OPTIONAL HERE, REQUIRED ON /join, and the asymmetry is deliberate rather
  // than drift. An applicant typing into a public form is telling us how to
  // reach them and has no other way to; an operator adding a vendor at a demo
  // is standing next to the person and may not have written the number down
  // yet. Refusing the whole save over it would push them to invent one, which
  // is strictly worse than a blank the roster visibly flags. The SHAPE is held
  // to /join's rule exactly, so a number that gets in here is one that could
  // have come in through the other door.
  if (phone && !PHONE_RE.test(phone)) return { error: 'Enter a valid phone number.' };

  // OPTIONAL HERE, REQUIRED ON /join, the same asymmetry the phone number has
  // three lines up and for a closely related reason. An applicant is telling us
  // what their spot will offer and is looking at a form built to ask; an
  // operator adding a vendor at a demo may not have agreed an item yet, and
  // refusing the save would push them to invent one. An invented item is worse
  // than none, because it is an obligation the vendor never agreed to and a
  // student can walk in and redeem it. The SHAPE is held to /join’s rule
  // exactly, so anything that gets in here could have come through that door.
  const starter = validStarterItems(b.rewards, { required: false });
  if (starter.error) return { error: starter.error };
  // Not validated, NORMALISED (migration-042): both are optional pickers, and
  // an unrecognised tag drops out rather than 400ing a form the operator has
  // otherwise filled in correctly. See src/lib/cuisines.js.
  return {
    name: n.value, email, password, address: address || null, logo: logo.value,
    cuisine: normalizeCuisine(b.cuisine),
    priceLevel: normalizePriceLevel(b.priceLevel),
    locationLabel: label || null,
    // '' → null for the same reason address does it: an empty string would read
    // back as a real (blank) contact and the roster could not tell "nobody has
    // filled this in" apart from "there is nobody to call".
    contactName: contactName || null,
    phone: phone || null,
    rewards: starter.items,
  };
}

/**
 * A query parameter as the scalar the reader meant to read, or `undefined`.
 *
 * ⚠ NOTHING IN THIS FILE MAY COERCE A req.query VALUE WITHOUT GOING THROUGH
 * HERE. express 4's query parser is qs.parse(str, { allowPrototypes: true })
 * (node_modules/express/lib/utils.js), so a caller can put an arbitrary object
 * where a scalar was expected: `?days[toString]=1` arrives as
 * { toString: '1' } — an OWN, NON-CALLABLE property shadowing
 * Object.prototype.toString — and both Number() and String() on that THROW
 * "Cannot convert object to primitive value" instead of answering NaN or
 * "[object Object]". None of the coercions below sit inside their own
 * try/catch, so that TypeError reaches the handler in server.js, which has no
 * branch for it: an error_logs INSERT, a web-push alert to every subscribed
 * operator, and a 500 — off a typed URL. authorize() in
 * src/routes/unsubscribe.js carries the long version of this note, including
 * why `?u[__proto__]=x` is NOT one of the dangerous shapes on the qs this repo
 * installs; this is the same gate for the parameters that are read as numbers.
 *
 * A REPEATED KEY STILL COERCES AS IT ALWAYS HAS. `?limit=1&limit=2` arrives as
 * ['1','2'] and pageParams's tested contract (test/admin-lists.test.js, "a
 * repeated query key cannot produce NaN") is that Number() decides — 5 for
 * ['5'], NaN for two values, which then lands on the default. So arrays pass
 * through, but only while every member is itself a primitive: one poisoned
 * member, which `?q[][toString]=x` produces, would throw from inside
 * Array#toString for exactly the same reason.
 *
 * ⚠ SCOPE: req.query ONLY, deliberately. A JSON BODY can carry the identical
 * shape — `{"email":{"toString":"x"}}` throws in exactly the same way at
 * `String(req.body?.email ?? '')` in POST /grants, and at the three other body
 * coercions in this file (the label on POST /pools, and points/reason in /grants) —
 * but that surface is not this parser's, it is the same in every route file
 * (src/routes/vendor.js's `String(req.body?.interval ?? 'monthly')` is the twin),
 * and closing it in one file only would leave the half-swept state this note
 * exists to prevent. It wants one shared gate, sized to touch all five doors at
 * once, and is recorded here so the next reader knows it was seen rather than
 * missed.
 */
function queryScalar(raw) {
  if (typeof raw !== 'object' || raw === null) return raw;
  if (Array.isArray(raw) && raw.every((v) => typeof v !== 'object' || v === null)) return raw;
  return undefined;
}

/**
 * `?limit=&offset=` for one page of a list, clamped to something a server can
 * answer. Shared by every paged operator list (students, errors, referrals,
 * grants) so "Show more" means the same thing on all of them, and so no route
 * can be talked into a whole-table read by a hand-typed URL.
 *
 * Anything unreadable falls back to the caller's default rather than 400ing: a
 * missing or junk page number is a UI bug, and answering it with the first page
 * keeps the operator looking at data instead of an error.
 */
export function pageParams(query, { def, max }) {
  const q = query ?? {};
  const limit = Math.min(max, Math.max(1, Math.floor(Number(queryScalar(q.limit)) || def)));
  const offset = Math.max(0, Math.floor(Number(queryScalar(q.offset)) || 0));
  return { limit, offset };
}

// PostgREST's code for "you asked for a range that starts past the end".
const RANGE_PAST_END = 'PGRST103';

/**
 * One page of rows plus the exact total, for a list the operator can page
 * through.
 *
 * `build(selectOptions)` must return a FRESH query each call — its select, its
 * filters and its order, but no range. It is called twice at most.
 *
 * The second call only happens on a page that starts past the end of the list.
 * PostgREST answers that with 416/PGRST103 rather than an empty page, and
 * postgrest-js drops the Content-Range that came with it, so such a request
 * arrives back here as a failure carrying neither rows nor a total. It isn't a
 * failure: "rows 500 to 549 of a 40-row log" has an honest empty answer, and
 * returning it as one is what keeps a stale Show more (or a hand-typed offset)
 * from turning into a 500. The total is re-read with a HEAD count, which costs
 * one cheap round trip on a page that had no rows to send anyway.
 */
export async function pageOf(build, { limit, offset }) {
  const { data, error, count } = await build({ count: 'exact' }).range(offset, offset + limit - 1);
  if (!error) {
    const rows = data ?? [];
    return { rows, total: count ?? rows.length };
  }
  if (error.code !== RANGE_PAST_END) throw error;

  const { count: total, error: countError } = await build({ count: 'exact', head: true });
  if (countError) throw countError;
  return { rows: [], total: total ?? 0 };
}

/**
 * GET /api/admin/overview
 * Platform-wide health for the operator: lifetime totals (vendors, students,
 * transactions), today / 7-day / 30-day activity (awards, redemptions, points,
 * revenue, active + new students), a 14-day daily series, top vendors by
 * revenue, and an error count. Windowed metrics roll up the last 30 days of
 * transactions in memory (signed, so reversals net out — same approach as the
 * per-vendor analytics); lifetime totals use count queries.
 */
router.get('/overview', async (req, res, next) => {
  try {
    const now = Date.now();
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const t0 = startToday.getTime();
    const t7 = t0 - 6 * DAY;
    const since30 = new Date(t0 - 29 * DAY).toISOString();
    const since7ISO = new Date(t7).toISOString();
    const since24h = new Date(now - DAY).toISOString();
    const TX_LIMIT = 20_000; // rows pulled for the windowed rollup; see truncation check below

    const [
      vendors, students, txTotal,
      newStudents30, newStudents7, newVendors30,
      errors24h, errorsTotal,
      txRes,
    ] = await Promise.all([
      // Count ALL vendors (active + disabled) so the headline total doesn't drop
      // like a deletion when the operator toggles one off — the Vendors card
      // below shows the on/off split. Matches newVendors (also unfiltered).
      supabaseAdmin.from('vendors').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('profiles').select('user_id', { count: 'exact', head: true }),
      supabaseAdmin.from('transactions').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('profiles').select('user_id', { count: 'exact', head: true }).gte('created_at', since30),
      supabaseAdmin.from('profiles').select('user_id', { count: 'exact', head: true }).gte('created_at', since7ISO),
      supabaseAdmin.from('vendors').select('id', { count: 'exact', head: true }).gte('created_at', since30),
      supabaseAdmin.from('error_logs').select('id', { count: 'exact', head: true }).gte('created_at', since24h),
      supabaseAdmin.from('error_logs').select('id', { count: 'exact', head: true }),
      supabaseAdmin
        .from('transactions')
        // vendors.active rides along so the rollup can keep switched-off vendors
        // out of the top-5 ranking. NOT a filter on the query: the windowed
        // totals and the daily chart must still count what an off vendor earned
        // while it was on, or toggling one off rewrites platform history.
        .select('type, points, dollar_amount, created_at, user_id, vendor_id, vendors(name, active)')
        .gte('created_at', since30)
        .limit(TX_LIMIT),
    ]);
    for (const r of [vendors, students, txTotal, newStudents30, newStudents7, newVendors30, errors24h, errorsTotal, txRes]) {
      if (r.error) throw r.error;
    }

    // Detect a hit on the row cap so the windowed rollup doesn't silently
    // undercount as the platform grows (see the per-vendor analytics note).
    const truncated = (txRes.data?.length ?? 0) >= TX_LIMIT;
    if (truncated) {
      console.warn(`[overview] hit the ${TX_LIMIT}-row cap — windowed totals may undercount; aggregate in SQL.`);
    }

    const roll = rollupPlatformOverview(txRes.data ?? [], t0);

    res.json({
      totals: {
        vendors: vendors.count ?? 0,
        students: students.count ?? 0,
        transactions: txTotal.count ?? 0,
      },
      today: roll.today,
      last7: { ...roll.last7, newStudents: newStudents7.count ?? 0 },
      last30: { ...roll.last30, newStudents: newStudents30.count ?? 0, newVendors: newVendors30.count ?? 0 },
      daily: roll.daily,
      topVendors: roll.topVendors,
      errors: { last24h: errors24h.count ?? 0, total: errorsTotal.count ?? 0 },
      truncated,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/roi?days=30
 *
 * The screen the operator reads down the phone to a vendor. Per location:
 * how many people came, how many came BACK, what the repeat visits were worth,
 * what the vendor gave away to get them, and the net — plus the platform median
 * so "you're above average downtown" is a checkable statement rather than a
 * sales line. The billing state rides along from vendor_billing_overview, so
 * the operator can see who is in trouble on the same screen as what they are
 * getting for their money.
 *
 * Deliberately admin-only for now. The vendor-facing version is the same
 * rollup behind requirePin, and shipping it here first means the numbers can be
 * sanity-checked against a real till before any vendor sees them.
 *
 * THREE READS, none of them cheap-looking and all of them small at this scale:
 * the window, the roster, and the "who had already been here" set that turns a
 * customer into a NEW customer. The third is the only non-obvious one — it
 * cannot be derived from a 30-day window, because the whole question is what
 * happened before the window opened.
 */
router.get('/roi', async (req, res, next) => {
  try {
    // queryScalar, not a bare Number(): `?days[toString]=1` throws on coercion,
    // and a 500 with an error_logs row and a push behind it is a poor answer to a
    // mistyped window. Junk widens or narrows nothing — it falls back to 30 days,
    // the same posture historyWindowDays takes in src/routes/student.js.
    const days = Math.min(Math.max(Number(queryScalar(req.query.days)) || 30, 7), 90);

    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const t0 = startToday.getTime();
    const since = new Date(t0 - (days - 1) * DAY).toISOString();

    // Same cap and the same truncation confession as /overview and
    // /api/vendor/analytics. Past this the rollup undercounts silently, which
    // is the one failure mode an ROI screen must never have — a vendor shown a
    // number lower than their own till receipts stops trusting all of them.
    const TX_LIMIT = 20_000;
    const PRIOR_LIMIT = 20_000;

    const [txRes, vendorRes, priorRes, billingRes] = await Promise.all([
      supabaseAdmin
        .from('transactions')
        .select('type, points, dollar_amount, created_at, user_id, vendor_id')
        .gte('created_at', since)
        .limit(TX_LIMIT),
      supabaseAdmin
        .from('vendors')
        .select('id, name, active, plan, grandfathered, points_per_dollar')
        .order('name', { ascending: true }),
      // Every (vendor, student) pair that existed BEFORE the window. Anyone in
      // the window and not in here is new to that vendor. Only positive earns
      // count, matching the award-day rule in the rollup — a reversed award is
      // not a prior visit.
      supabaseAdmin
        .from('transactions')
        .select('user_id, vendor_id')
        .eq('type', 'earn')
        .gt('points', 0)
        .lt('created_at', since)
        .limit(PRIOR_LIMIT),
      supabaseAdmin
        .from('vendor_billing_overview')
        .select('id, plan, grandfathered, subscription_status, days_past_due, billing_state, current_period_end'),
    ]);

    for (const r of [txRes, vendorRes, priorRes, billingRes]) {
      if (r.error) throw r.error;
    }

    const truncated =
      (txRes.data?.length ?? 0) >= TX_LIMIT || (priorRes.data?.length ?? 0) >= PRIOR_LIMIT;
    if (truncated) {
      console.warn(`[roi] hit a ${TX_LIMIT}-row cap — figures may undercount; aggregate in SQL.`);
    }

    const priorPairs = new Set(
      (priorRes.data ?? [])
        .filter((r) => r.vendor_id && r.user_id)
        .map((r) => `${r.vendor_id}:${r.user_id}`),
    );

    const roll = rollupRoi({
      txns: txRes.data ?? [],
      priorPairs,
      vendors: vendorRes.data ?? [],
      t0,
      days,
    });

    // Fold the billing facts onto each card so the dashboard renders one row
    // per vendor instead of joining two lists in the browser.
    const billing = new Map((billingRes.data ?? []).map((b) => [b.id, b]));
    const vendors = roll.vendors.map((c) => {
      const b = billing.get(c.id);
      return {
        ...c,
        billing: {
          state: b?.billing_state ?? 'ok',
          status: b?.subscription_status ?? null,
          daysPastDue: b?.days_past_due ?? null,
          currentPeriodEnd: b?.current_period_end ?? null,
        },
      };
    });

    res.json({ ...roll, vendors, truncated });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/vendors
 * Every vendor — active AND inactive — for the operator's on/off control panel.
 * The public/student surfaces only ever see active=true, so this is the one
 * place the full roster is listed. Newest first.
 */
router.get('/vendors', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('vendors')
      // has_logo, never `logo`: the flag is a generated column (migration-016)
      // that exists so a list can say whether there is artwork without dragging
      // a 500 KB base64 blob per row through the response. The bytes themselves
      // are fetched one vendor at a time by GET /vendors/:id/logo below.
      //
      // pool_id and the pool's label ride along because pool_id is what decides
      // WHICH TABLE a location's points live in (src/lib/pools.js), and this
      // roster is the only screen that shows every location at once. Without
      // them the operator cannot see that three rows here are one purse, which
      // is exactly what they need to know before switching one of them off.
      // Null and absent for every vendor until an operator creates a pool.
      //
      // contact_name + phone (migration-049) are the operator's own contact
      // details for the storefront, and this roster is where they are read: the
      // question "who do I call about this location" is asked while looking at
      // the location, not from inside a dialog. Null for every vendor onboarded
      // before 049, whose number was destroyed with their application row —
      // which is exactly why the row renders the gap rather than hiding it.
      .select('id, name, slug, location_label, active, points_per_dollar, address, latitude, longitude, cuisine, price_level, has_logo, created_at, contact_name, phone, pool_id, point_pools(label)')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const vendors = data ?? [];

    // Attach the login(s) behind each vendor so the dashboard can name the
    // account a password reset would target — a vendor can have several staff
    // logins (multi-location owners; see requireVendor). The addresses live in
    // auth.users, which PostgREST can't read, hence the definer RPC from
    // migration-031. One call for the whole roster, not one per row.
    //
    // Non-fatal: a vendor whose emails we couldn't resolve still renders with
    // its on/off switch and address editor, just without the reset button. The
    // roster is the operator's main control surface and shouldn't 500 because a
    // lookup that only feeds one button failed.
    //
    // But it must not fail SILENTLY either. `staff: []` means "this vendor has
    // no login"; a failed lookup means "we don't know" — and those render
    // identically unless we say which happened. Without staffUnavailable the
    // only password-recovery channel would just quietly vanish from the UI (for
    // instance before migration-031 is applied, when the RPC doesn't exist yet).
    if (vendors.length) {
      const { data: staff, error: staffErr } = await supabaseAdmin
        .rpc('vendor_staff_emails', { p_vendor_ids: vendors.map((v) => v.id) });
      if (staffErr) {
        console.error('vendor_staff_emails failed:', staffErr.message);
        vendors.forEach((v) => { v.staff = []; v.staffUnavailable = true; });
      } else {
        const byVendor = new Map();
        (staff ?? []).forEach((s) => {
          if (!byVendor.has(s.vendor_id)) byVendor.set(s.vendor_id, []);
          byVendor.get(s.vendor_id).push({ userId: s.user_id, email: s.email, role: s.role });
        });
        vendors.forEach((v) => { v.staff = byVendor.get(v.id) ?? []; });
      }
    }

    res.json(vendors);
  } catch (err) {
    next(err);
  }
});

/* ---------- creating a vendor ----------
   One code path onboards a vendor, whichever door it came in by: the operator's
   own "Add vendor" form (POST /vendors, below) and accepting a /join application
   (POST /applications/:id/accept) both call onboardVendor. Keeping them on one
   implementation is what stops the two from drifting into subtly different
   vendors depending on who filled the form in. */

/** vendors.slug from a business name: lowercase, alnum runs joined by '-'. */
function slugify(name) {
  const s = String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || 'vendor';
}

// The columns a sibling location inherits when one login runs several stores
// (migration-043): how the terminal prices and rings up a sale, and nothing
// else. Deliberately NOT here: pin_hash (each till gets its own PIN, or none),
// address/logo/cuisine/price_level (per-location by definition), and anything
// that is content rather than configuration.
const INHERITED_CONFIG = ['points_per_dollar', 'tiers', 'allow_exact_entry', 'punch_enabled'];

/** Just the inheritable columns of a vendors row, ready to spread into an insert. */
const pickConfig = (row) => Object.fromEntries(INHERITED_CONFIG.map((k) => [k, row[k]]));

/**
 * The config a NEW location for this login should start from: its owner's
 * oldest existing vendor, or null when this login runs nothing yet (→ table
 * defaults).
 *
 * Oldest rather than newest because that is the one the vendor set up by hand
 * and has been trading on; the newest may itself be a location that inherited
 * from somewhere and tells us nothing new.
 */
async function inheritedConfig(userId) {
  const { data, error } = await supabaseAdmin
    .from('vendor_staff')
    .select(`vendors(created_at, ${INHERITED_CONFIG.join(', ')})`)
    .eq('user_id', userId);
  if (error) throw error;

  const rows = (data ?? [])
    .map((s) => s.vendors)
    .filter(Boolean)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return rows.length ? pickConfig(rows[0]) : null;
}

/**
 * Insert ONE vendors row and return it (with the inheritable columns, so the
 * caller can hand them to the next location).
 *
 * @param loc  { name, address?, logo?, cuisine?, priceLevel?, locationLabel?,
 *               contactName?, phone? }
 * @param config  inherited economics to spread in, or null for table defaults
 * @param slugStart  Map<base, next attempt> shared across one onboarding
 */
async function createVendorRow(loc, config, slugStart) {
  // A geocode miss is never fatal (matches onboard-vendor.js / PATCH vendors):
  // the address is kept, the student card just shows no map until it's edited.
  // One location at a time rather than Promise.all over a chain: Nominatim's
  // usage policy asks for a request a second, and an accept is a single
  // operator click, not a hot path.
  const coords = loc.address ? await geocode(loc.address) : null;

  // Slug collisions get a numeric suffix (local-eats, local-eats-2, …). Every
  // location of a chain after the first collides by construction, since they
  // share a business name — hence slugStart, which resumes where the previous
  // sibling landed instead of re-walking the taken suffixes from zero. Still
  // bounded, so a pathological name can't loop forever.
  const base = slugify(loc.name);
  const first = slugStart.get(base) ?? 0;
  for (let attempt = first; attempt < first + 25; attempt++) {
    const { data, error } = await supabaseAdmin
      .from('vendors')
      .insert({
        // Spread FIRST so nothing inherited can overwrite this location's own
        // identity below (an inherited row carries no name/slug today, and this
        // is what keeps that true if INHERITED_CONFIG ever grows).
        ...(config ?? {}),
        name: loc.name,
        slug: attempt ? `${base}-${attempt + 1}` : base,
        // Which branch this row is, when one login runs several (migration-043).
        // Null for the single-location vendor that is still the common case.
        location_label: loc.locationLabel ?? null,
        address: loc.address ?? null,
        latitude: coords?.lat ?? null,
        longitude: coords?.lng ?? null,
        logo: loc.logo ?? null,
        // Normalised at the door rather than trusted (migration-042): every
        // door into this function carries operator- or applicant-typed values,
        // and a vendor onboarded with junk here would be quietly unfilterable
        // rather than visibly broken.
        cuisine: normalizeCuisine(loc.cuisine),
        price_level: normalizePriceLevel(loc.priceLevel),
        // Who the operator calls about this storefront (migration-049). Carried
        // here rather than left on the application because the application row
        // is DELETED at the START of an accept — the delete is that handler's
        // claim lock, so by the time we run it is already gone, and anything the
        // accept did not read off the row before deleting it is lost the moment
        // the vendor becomes real. Before 049 that is precisely
        // where the phone number went, and the vendor who most needs phoning
        // (locked out, no mailbox) was the one with no number on file.
        contact_name: loc.contactName ?? null,
        phone: loc.phone ?? null,
      })
      .select(`id, name, slug, location_label, contact_name, phone, ${INHERITED_CONFIG.join(', ')}`)
      .single();
    if (!error) { slugStart.set(base, attempt + 1); return data; }
    if (error.code !== '23505') throw error;
  }
  throw new Error('SLUG_EXHAUSTED');
}

/**
 * Onboard a vendor: auth login → vendors row(s) → vendor_staff link(s), the same
 * steps as scripts/onboard-vendor.js. `passwordHash` (an application's stored
 * bcrypt hash) and `password` (plaintext the operator just typed) are the two
 * ways to set the login's credential; pass exactly one. pin_hash stays null
 * (redeem is ungated until the vendor sets a PIN in terminal Settings). *
 * `rewards` are the starter items the applicant named on /join (migration-052),
 * priced in dollars and converted to points per location at that location's own
 * rate. [] is legal and is what the operator's own "Add vendor" form sends when
 * they haven't agreed an item yet; the vendor then opens with an empty ITEMS tab,
 * which is what every vendor did before 052.
 *
 * MULTI-LOCATION (migration-043): `locations` names further branches the same
 * owner is opening — one vendors row each, every one linked to the SAME login,
 * so the terminal's store switcher has something to switch between. The
 * locations stay fully independent vendors (separate points, items, deals,
 * stats, PIN); what they share is a login and, via INHERITED_CONFIG, the
 * economics they open on.
 *
 * Dual-role accounts (migration-035): when the email already has an account
 * (typically a student who wants to run a vendor under the same login), that
 * EXISTING account is linked as the vendor login instead of failing, and its
 * password is deliberately left untouched — neither door verifies that whoever
 * supplied the address owns the inbox, so applying a new password to a
 * pre-existing account would let anyone hijack it by naming a stranger's email.
 * Callers get `linkedExisting: true` so they can say so.
 *
 * Each later step unwinds the earlier ones on failure, so a failed onboard
 * leaves a clean slate to retry from. Returns { vendor, vendors, linkedExisting }
 * — `vendor` is location one, for the callers that only ever make one — or
 * { conflict: true } when the taken email's account vanished mid-flight.
 */
async function onboardVendor({
  name, email, password, passwordHash, address, logo, cuisine, priceLevel,
  locationLabel = null, locations = [], contactName = null, phone = null,
  rewards = [],
}) {
  let userId;
  let linkedExisting = false;

  const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    ...(passwordHash ? { password_hash: passwordHash } : { password }),
    email_confirm: true,
  });
  if (userErr) {
    if (userErr.code === 'email_exists' || userErr.status === 422) {
      const { data: existingId, error: lookupErr } = await supabaseAdmin
        .rpc('auth_user_id_by_email', { p_email: email });
      if (lookupErr) throw lookupErr;
      // createUser said taken but the lookup finds nothing — the account went
      // away between the two calls. Let the caller answer 409; nothing was made.
      if (!existingId) return { conflict: true };
      userId = existingId;
      linkedExisting = true;
    } else {
      throw userErr;
    }
  } else {
    userId = userData.user.id;
  }

  // The economics every location created here starts from. An account that
  // already runs a store inherits THAT store's settings, because a chain's
  // third shop opening on the default 10 points/$ while the other two run on 5
  // is a silent mispricing rather than a fresh start; a brand-new login takes
  // the table defaults and its second location copies its first, so the stores
  // in one application always agree with each other.
  //
  // CONFIG ONLY. Deals, balances, history and the staff PIN are per-location
  // and start empty, so one store's takings never turn up on another's stats
  // and its PIN never unlocks another's till.
  //
  // Reward items are per-location too and are NOT inherited from a store this
  // login already runs — an existing shop’s menu turning up on a new one’s
  // ITEMS tab would be a guess. They come from `rewards` instead, the items
  // named on this application, and are created per location below.
  let config = await inheritedConfig(userId);

  // Locations sharing a business name (which is most of a chain) all slugify to
  // the same base. Remembering where the last one landed keeps the collision
  // retry linear instead of re-walking every taken suffix per location.
  const slugStart = new Map();

  const created = [];
  try {
    // Location one is this call's own arguments; the rest came from a /join
    // application that named several (migration-043).
    //
    // THE CONTACT IS SHARED, spread first so a location that ever carries its
    // own still wins. /join asks for one contact name and one phone number for
    // the whole application however many branches it names, and on day one that
    // is simply true — one owner is opening three shops. The columns live on
    // each vendors row rather than on the login (migration-049) so that can stop
    // being true later without a schema change: a chain that puts a manager in
    // each store is corrected branch by branch from this dashboard.
    const contact = { contactName, phone };
    const all = [{ name, address, logo, cuisine, priceLevel, locationLabel }, ...locations]
      .map((loc) => ({ ...contact, ...loc }));
    for (const loc of all) {
      const row = await createVendorRow(loc, config, slugStart);
      created.push(row);
      config ??= pickConfig(row);   // location one sets the pattern for its siblings

      const { error: staffErr } = await supabaseAdmin
        .from('vendor_staff')
        .insert({ vendor_id: row.id, user_id: userId, role: 'owner' });
      if (staffErr) throw staffErr;

      // The items the applicant named on /join (migration-052), one rewards
      // row per item on EVERY location — a chain's branches are independent
      // vendors and each needs its own copy, which is also what lets one shop
      // stop doing the cookie without the others losing it.
      //
      // Priced HERE rather than at /join, because only now is there a rate to
      // price against: `row.points_per_dollar` is whatever this location
      // actually landed on — the table default, or a sibling store's, via the
      // inheritance a few lines up. An applicant who said "$25 of purchases"
      // gets 250 points at 10/$ and 125 at 5/$, which is the same promise in
      // both cases. See starterItemToReward.
      //
      // Inside the try on purpose: a failure here unwinds the whole onboard
      // like any other, and the vendors delete in the catch cascades these
      // away with it. Better a clean retry than a vendor whose first item
      // silently did not exist.
      if (rewards.length) {
        const { error: rewardErr } = await supabaseAdmin
          .from('rewards')
          .insert(rewards.map((item) => ({
            vendor_id: row.id,
            ...starterItemToReward(item, row.points_per_dollar),
          })));
        if (rewardErr) throw rewardErr;
      }
    }

    // A new spot should appear for students on their next load, not up to the
    // catalogue TTL later. See src/lib/cache.js.
    invalidateVendorCaches();
  } catch (err) {
    // Unwind EVERY row this call made, not only the one that failed. A
    // half-onboarded chain is worse than none, because this throw is not the end
    // of the story: POST /applications/:id/accept claims the application by
    // DELETING it before it calls us (the delete is its lock), and its catch
    // calls restoreApplication() to put the row straight back in the queue when
    // we throw. So the operator is looking at a pressable Accept again, and a
    // retry would create the earlier locations a second time — the vendor would
    // sign in to duplicates. Leaving these rows behind is what would turn that
    // restore, which exists to make a failed accept retryable, into the
    // duplicate-vendor bug it was written to prevent.
    for (const row of created) {
      await supabaseAdmin.from('vendors').delete().eq('id', row.id).then(() => {}, () => {});
      // The rollback is also a write — if the insert above got far enough to
      // populate the cache, the deleted vendor must not survive in it.
      invalidateVendorCaches(row.id);
    }
    // Unwind only a login WE created. A linked pre-existing account (a
    // student's, possibly) must survive a failed onboard untouched.
    if (!linkedExisting) await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
    throw err;
  }

  return { vendor: created[0], vendors: created, linkedExisting };
}

/**
 * POST /api/admin/vendors  { name, email, password, address?, logo? }
 * Add a vendor from the operator's side: /join without the queue, for a vendor
 * signed up in person, over the phone, or at a demo. It runs the identical
 * onboarding an accepted application does, so the vendor can sign in to the
 * terminal immediately with the email and password set here.
 *
 * Only the fields a vendors row actually holds are collected. The one an
 * application carries that still has nowhere to live is `message`, the
 * applicant's free-text pitch: it exists to help the operator DECIDE, and an
 * operator adding a vendor by hand has already decided. The contact name and
 * phone used to be in that category too — until migration-049 gave them
 * columns, on the grounds that a number you can only read before you accept
 * somebody is a number you do not have when they call you locked out.
 *
 * The response mirrors accept's, including `linkedExisting` for the case where
 * the email already had an account and was linked rather than created (the
 * typed password does not apply then — see onboardVendor).
 */
router.post('/vendors', async (req, res, next) => {
  try {
    const v = validNewVendor(req.body);
    if (v.error) return res.status(400).json({ error: 'BAD_VENDOR', message: v.error });

    const result = await onboardVendor({
      name: v.name,
      email: v.email,
      password: v.password,
      address: v.address,
      logo: v.logo,
      cuisine: v.cuisine,
      priceLevel: v.priceLevel,
      // Adding a second location for an email that already runs one is exactly
      // this form filled in again: onboardVendor links the existing login
      // rather than failing, and the label is what tells the two apart in the
      // terminal's store switcher (migration-043).
      locationLabel: v.locationLabel,
      // Both optional on this door (migration-049); a vendor added at a demo can
      // have their number filled in from the roster afterwards.
      contactName: v.contactName,
      phone: v.phone,
      // The vendor’s first redeemable item, if the operator has one to type
      // (migration-052). [] means the ITEMS tab opens empty and students see
      // "No rewards yet" until somebody adds one — which the vendor editor on
      // this same dashboard can do the moment this returns.
      rewards: v.rewards,
    });
    if (result.conflict) {
      return res.status(409).json({
        error: 'EMAIL_EXISTS',
        message: 'This email’s account changed mid-save. Try again.',
      });
    }

    res.status(201).json({ ok: true, vendor: result.vendor, linkedExisting: result.linkedExisting });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/vendors/:id/reset-code   { userId? }
 * Mint a one-time password-reset code for one of this vendor's logins. The code
 * is emailed to that login AND returned here for the operator to read down the
 * phone (migration-047 added the mail half; before it, dictation was the whole
 * channel). Vendors sign in with a password rather than Google, so Supabase's
 * own recovery email is not available to them either way.
 *
 * This is now the OPERATOR OVERRIDE path. The everyday one is self-serve:
 * POST /api/vendor/recover/request, which a locked-out vendor drives themselves
 * from the terminal. This endpoint stays because it is the only thing that works
 * for a vendor who has also lost access to the mailbox.
 *
 * The plaintext is returned EXACTLY ONCE, here. Only its bcrypt hash is stored
 * (migration-031), matching how pin_hash and vendor_applications.password_hash
 * are handled — so a leaked database still can't be used to seize a vendor
 * terminal, and a code the operator loses has to be re-minted rather than looked
 * up.
 *
 * `userId` is optional and only needed when the vendor has more than one staff
 * login; with exactly one, the choice is unambiguous and the client can omit it.
 * The RPC re-checks the staff link either way, so naming a foreign user id can't
 * aim a reset at someone else's account.
 */
router.post('/vendors/:id/reset-code', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Vendor not found.' });
    }

    const { data: vendor, error: vendErr } = await supabaseAdmin
      .from('vendors')
      .select('id, name')
      .eq('id', req.params.id)
      .maybeSingle();
    if (vendErr) throw vendErr;
    if (!vendor) return res.status(404).json({ error: 'NOT_FOUND', message: 'Vendor not found.' });

    const { data: staff, error: staffErr } = await supabaseAdmin
      .rpc('vendor_staff_emails', { p_vendor_ids: [vendor.id] });
    if (staffErr) throw staffErr;

    const logins = staff ?? [];
    if (!logins.length) {
      return res.status(409).json({
        error: 'NO_LOGIN',
        message: 'This vendor has no staff login to reset.',
      });
    }

    const requested = req.body?.userId;
    let target;
    if (requested != null) {
      if (!isUuid(requested)) {
        return res.status(400).json({ error: 'BAD_USER_ID', message: 'That login id is not valid.' });
      }
      target = logins.find((s) => s.user_id === requested);
      if (!target) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'That login is not staff of this vendor.' });
      }
    } else if (logins.length === 1) {
      target = logins[0];
    } else {
      // Mirrors requireVendor's VENDOR_AMBIGUOUS: never guess which account to
      // hand a credential to.
      return res.status(400).json({
        error: 'LOGIN_AMBIGUOUS',
        message: 'This vendor has multiple logins, pick which one to reset.',
        logins: logins.map((s) => ({ userId: s.user_id, email: s.email, role: s.role })),
      });
    }

    // Generated hyphenated for reading aloud; hashed in its bare canonical form
    // so the terminal's normaliser (which strips separators) always produces the
    // exact string that was hashed.
    const code = generateResetCode();
    const codeHash = await bcrypt.hash(normalizeResetCode(code), 10);

    const { data: issued, error: issueErr } = await supabaseAdmin.rpc('vendor_reset_issue', {
      p_vendor_id: vendor.id,
      p_user_id: target.user_id,
      p_code_hash: codeHash,
      p_ttl_minutes: RESET_TTL_MINUTES,
      p_created_by: req.user?.email ?? null,
    });
    if (issueErr) {
      // The RPC's own guards (staff link, missing email) shouldn't be reachable
      // after the checks above, but surface them as 409s rather than 500s if the
      // roster shifted between the lookup and the insert.
      if (/NOT_VENDOR_STAFF|NO_LOGIN_EMAIL/.test(issueErr.message || '')) {
        return res.status(409).json({
          error: 'NO_LOGIN',
          message: 'That login can no longer be reset. Reload the page and try again.',
        });
      }
      throw issueErr;
    }

    const row = Array.isArray(issued) ? issued[0] : issued;
    const address = row?.reset_email ?? target.email;

    // Since migration-047 the code is ALSO emailed. The phone call is still the
    // channel this flow was designed around — the operator recognising a voice
    // is a stronger gate than a mailbox, and it still works for a vendor locked
    // out of their email — so the plaintext is returned here exactly as before
    // and the operator can read it out regardless of what the mail API did.
    //
    // The email is the convenience half: it saves dictating eight characters
    // over a noisy counter, and it is the only version the vendor can copy and
    // paste. `emailed` says which happened, so /admin can tell the operator to
    // read it aloud rather than letting them assume it arrived.
    const mail = vendorResetCode({
      businessName: vendor.name,
      code,
      ttlMinutes: RESET_TTL_MINUTES,
      terminalUrl: emailUrl('/terminal/', req),
      selfServe: false,
    });
    const sent = await sendEmail({
      to: address,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      // Transactional: a reset code goes even to someone who muted deal emails.
      category: 'transactional',
      // Deliberately NOT keyed on anything stable. Every mint is a NEW code, and
      // de-duplicating two mints would deliver the first code for the second
      // request — which reads to the vendor as "the code you sent me is wrong".
      idempotencyKey: `reset:${row?.reset_id ?? ''}`,
      tags: ['vendor-reset'],
      // The code is in this template's subject AND body. `secrets` scrubs it
      // from anything the log keeps, and the fixed logSubject means the stored
      // title never depended on that scrub in the first place.
      log: {
        kind: 'vendor_reset',
        recipientKind: 'vendor',
        vendorId: vendor.id,
        recipientUserId: target.user_id,
        recipientLabel: vendor.name,
        ref: { resetId: row?.reset_id ?? null, issuedBy: 'admin' },
        secrets: [code],
        logSubject: 'Your WeRewards reset code (code hidden)',
      },
    });

    res.json({
      ok: true,
      code,                                     // shown once, never retrievable again
      email: address,                           // the address the vendor must type
      expiresAt: row?.reset_expires_at ?? null,
      ttlMinutes: RESET_TTL_MINUTES,
      vendor: { id: vendor.id, name: vendor.name },
      emailed: sent.ok,
      emailConfigured: emailEnabled,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/admin/vendors/:id
 *   { name?, active?, address?, pointsPerDollar?, cuisine?, priceLevel?, logo? }
 * Operator edits for one vendor. Independent updates:
 *  - `name` is the vendor's display name, everywhere it appears: the student
 *    app's card, its transaction history, the terminal header, and the operator
 *    roster. The vendor has no way to change this itself, so a rebrand or a typo
 *    at onboarding is fixed here. `slug` is deliberately NOT regenerated: it's
 *    the vendor's stable internal id (unique column, shown in the roster meta),
 *    and nothing user-facing reads it, so churning it on a rename would buy
 *    nothing and risk a collision.
 *  - `active` is the kill-switch. Off = fully cut off: hidden from students
 *    (active=true filters) and its terminal is blocked at requireVendor.
 *    Non-destructive — balances, rewards, and history are preserved, so
 *    toggling back on restores the vendor exactly as it was.
 *  - `address` sets/clears the street address shown as a map on the student
 *    card. It's geocoded (Nominatim) so latitude/longitude stay in sync; a
 *    geocode miss keeps the address but drops coords (no map until it resolves).
 *    Sending '' clears the address and its coordinates.
 *  - `pointsPerDollar` is the vendor's earn ratio, same bounds as the vendor's
 *    own Settings save (validRatio, shared in src/lib/rewards.js). The terminal
 *    picks it up on its next /api/vendor/config fetch.
 *  - `cuisine` / `priceLevel` are what the place sells (migration-042).
 *    Normalised rather than rejected — see below.
 *  - `logo` is the vendor's artwork, the same base64 data-URL the vendor's own
 *    Settings tab writes and the same one "Add vendor" accepts (src/lib/logo.js
 *    is the shared rule). `null` or `''` CLEARS it; omitting the key leaves it
 *    alone. This is the operator's copy of a control the vendor already has,
 *    and it exists because most vendors never open Settings: a logo mailed to
 *    the operator otherwise has no way into the app short of the vendor being
 *    talked through the terminal over the phone.
 *
 *    `has_logo` is deliberately NOT written. It is `generated always as (logo is
 *    not null) stored` (migration-016), so writing the column is what maintains
 *    the flag, and an explicit update would be rejected by Postgres.
 */
router.patch('/vendors/:id', async (req, res, next) => {
  try {
    // Reject a malformed id up front so a bad path param is a clean 404 rather
    // than a Postgres uuid cast error (22P02) surfacing as a logged 500.
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Vendor not found.' });
    }

    const body = req.body ?? {};
    const updates = {};

    if (body.name != null) {
      const n = validVendorName(body.name);
      if (n.error) return res.status(400).json({ error: 'BAD_REQUEST', message: n.error });
      updates.name = n.value;
    }

    if (body.active != null) {
      if (typeof body.active !== 'boolean') {
        return res.status(400).json({ error: 'BAD_REQUEST', message: 'active must be true or false.' });
      }
      updates.active = body.active;
    }

    if (body.address != null) {
      const a = String(body.address).trim();
      if (a.length > ADDRESS_MAX) {
        return res.status(400).json({ error: 'BAD_REQUEST', message: `Address must be ${ADDRESS_MAX} characters or fewer.` });
      }
      updates.address = a || null;
    }

    // Which branch this row is, for a login that runs several (migration-043).
    // `!= null` admits '', which is how the label is CLEARED back to unlabelled.
    if (body.locationLabel != null) {
      const l = String(body.locationLabel).trim();
      if (l.length > LABEL_MAX) {
        return res.status(400).json({ error: 'BAD_REQUEST', message: `The location name must be ${LABEL_MAX} characters or fewer.` });
      }
      updates.location_label = l || null;
    }

    // Who the operator phones about this location (migration-049). `!= null`
    // admits '', which is how either is CLEARED back to blank — same convention
    // as address and locationLabel above.
    //
    // This is the ONLY way the existing roster ever gets a phone number. Every
    // vendor onboarded before 049 had their application row deleted at accept,
    // so the number is not recoverable from anywhere: it is re-collected by
    // hand, one vendor at a time, through this endpoint.
    if (body.contactName != null) {
      const c = String(body.contactName).trim();
      if (c.length > NAME_MAX) {
        return res.status(400).json({ error: 'BAD_REQUEST', message: `Contact name must be ${NAME_MAX} characters or fewer.` });
      }
      updates.contact_name = c || null;
    }

    if (body.phone != null) {
      const p = String(body.phone).trim();
      // Held to /join's shape exactly (PHONE_RE), so a number the operator types
      // here is one the public form would have accepted. Length is checked
      // first: the regex is bounded at 20 too, so a longer string would fail it
      // anyway, but "must be 20 characters or fewer" tells the operator what to
      // do and "enter a valid phone number" does not.
      if (p.length > PHONE_MAX) {
        return res.status(400).json({ error: 'BAD_REQUEST', message: `A phone number must be ${PHONE_MAX} characters or fewer.` });
      }
      if (p && !PHONE_RE.test(p)) {
        return res.status(400).json({ error: 'BAD_REQUEST', message: 'Enter a valid phone number.' });
      }
      updates.phone = p || null;
    }

    if (body.pointsPerDollar != null) {
      const r = validRatio(body.pointsPerDollar);
      if (r.error) return res.status(400).json({ error: 'BAD_REQUEST', message: r.error });
      updates.points_per_dollar = r.value;
    }

    // What the place sells (migration-042). Both are normalised rather than
    // rejected — see src/lib/cuisines.js on why an unknown tag is dropped
    // instead of failing the whole save.
    //
    // `!= null` deliberately admits `[]`, which is how the operator CLEARS the
    // tags: an empty array is a real value here, not a missing one.
    if (body.cuisine != null) {
      if (!Array.isArray(body.cuisine)) {
        return res.status(400).json({ error: 'BAD_REQUEST', message: 'cuisine must be an array of tags.' });
      }
      updates.cuisine = normalizeCuisine(body.cuisine);
    }

    // `!== undefined`, NOT `!= null`: null is the value that clears a price
    // back to untagged, and `!= null` would silently ignore exactly that.
    if (body.priceLevel !== undefined) {
      updates.price_level = normalizePriceLevel(body.priceLevel);
    }

    // `hasOwnProperty`, not a null check, for the same reason as priceLevel but
    // one step further: BOTH null and '' are meaningful values here (they clear
    // the logo), so the only thing that distinguishes "remove it" from "leave it
    // alone" is whether the key was sent at all. This is the same test
    // validSettings uses on the vendor's own side.
    if (Object.prototype.hasOwnProperty.call(body, 'logo')) {
      const l = validLogo(body.logo);
      if (l.error) return res.status(400).json({ error: 'BAD_REQUEST', message: l.error });
      updates.logo = l.value;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Nothing to update (send name, active, address, locationLabel, contactName, phone, pointsPerDollar, cuisine, priceLevel, and/or logo).' });
    }

    // Geocode a changed address so the student card's map stays in sync.
    if ('address' in updates) {
      const coords = updates.address ? await geocode(updates.address) : null;
      updates.latitude = coords?.lat ?? null;
      updates.longitude = coords?.lng ?? null;
    }

    // ---- the two edits a pool constrains (migration-046) ----
    // Only read the row when one of them is actually in play, so the ordinary
    // rename/logo/tag save costs nothing extra.
    const touchesPool = 'points_per_dollar' in updates || updates.active === false;
    let poolId = null;
    if (touchesPool) {
      const { data: v, error: vErr } = await supabaseAdmin
        .from('vendors').select('pool_id').eq('id', req.params.id).maybeSingle();
      if (vErr) throw vErr;
      if (!v) return res.status(404).json({ error: 'NOT_FOUND', message: 'Vendor not found.' });
      poolId = v.pool_id;
    }

    // SWITCHING OFF the last active member of a pool that still holds money
    // would make that money invisible and unreachable: the student catalogue
    // filters on active, so no card would show it, and requireVendor answers
    // VENDOR_DISABLED at every till that could have spent it. Deactivating any
    // OTHER member is fine — its customers keep spending at the siblings.
    if (poolId && updates.active === false) {
      const [{ count: others, error: cErr }, { data: held, error: hErr }] = await Promise.all([
        supabaseAdmin.from('vendors').select('id', { count: 'exact', head: true })
          .eq('pool_id', poolId).eq('active', true).neq('id', req.params.id),
        supabaseAdmin.from('pool_balances').select('user_id')
          .eq('pool_id', poolId).gt('balance', 0).limit(1),
      ]);
      if (cErr) throw cErr;
      if (hErr) throw hErr;
      if ((others ?? 0) === 0 && (held ?? []).length) {
        return res.status(409).json({
          error: 'POOL_LAST_ACTIVE_MEMBER',
          message: 'This is the last open location sharing these points, and customers still hold some. Take it out of the pool first, or open another location in it.',
        });
      }
    }

    // RATE PARITY, kept by fanning out rather than refusing. Locations sharing a
    // purse must charge the same points per dollar (earning at 20 and spending
    // against a menu priced for 5 means one shop systematically funds the
    // other), and pool_join enforces that at the door. But a chain has to be
    // able to reprice: refusing here would mean leaving the pool to change a
    // rate, and leaving moves customers' money. So the new rate lands on every
    // member at once, in one statement, and parity is never briefly false.
    if (poolId && 'points_per_dollar' in updates) {
      const { error: fanErr } = await supabaseAdmin
        .from('vendors')
        .update({ points_per_dollar: updates.points_per_dollar })
        .eq('pool_id', poolId)
        .neq('id', req.params.id);
      if (fanErr) throw fanErr;
      invalidateVendorCaches();   // every sibling's rate just changed
    }

    const { data, error } = await supabaseAdmin
      .from('vendors')
      .update(updates)
      .eq('id', req.params.id)
      // Same column list as GET /vendors above, pool_id and label included: the
      // dashboard swaps this row straight into the roster it already has, so a
      // shape narrower than the list's would blank the pool marker — or, since
      // migration-049, the contact line — on the one row the operator just
      // edited. Keep the two lists identical.
      .select('id, name, slug, location_label, active, points_per_dollar, address, latitude, longitude, cuisine, price_level, has_logo, created_at, contact_name, phone, pool_id, point_pools(label)')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'NOT_FOUND', message: 'Vendor not found.' });
    // Covers the on/off kill-switch, so a vendor toggled off disappears from
    // students immediately rather than at the end of the catalogue TTL.
    invalidateVendorCaches(req.params.id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/* ---------- per-vendor reward items (operator side) ----------
   Mirrors the vendor's own /api/vendor/rewards routes — same validators from
   src/lib/rewards.js, same merge-then-validate PATCH semantics — but keyed by
   the vendor id in the path and admin-gated instead of PIN-gated. Deliberately
   works on disabled vendors too: requireVendor's active=false kill-switch only
   blocks the terminal, and the operator may need to fix a catalog before
   switching a vendor back on. */

/** Path :id → true if the vendor exists; otherwise responds 404 and returns false. */
async function vendorExists(req, res) {
  if (!isUuid(req.params.id)) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Vendor not found.' });
    return false;
  }
  const { data, error } = await supabaseAdmin
    .from('vendors').select('id').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!data) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Vendor not found.' });
    return false;
  }
  return true;
}

/**
 * GET /api/admin/vendors/:id/logo → { logo: string|null }
 * The artwork itself, for the Edit dialog's preview. One lazy request per modal
 * open, the same shape as loadVendorRewards below it.
 *
 * WHY NOT `<img src="/api/vendor-logo/:id">`, which already serves this image as
 * real bytes and out of a cache. Because loadVendorLogo() answers null for an
 * INACTIVE vendor (src/lib/cache.js), and a vendor toggled off is precisely the
 * one an operator opens this dialog to fix — the preview would go blank and read
 * as "no logo", which is the one thing it must never say wrongly.
 *
 * The second reason is freshness. That route sets max-age=3600 with a
 * stale-while-revalidate window on top, so the operator's own browser can go on
 * showing the artwork they just replaced. Everything under /api is Cache-Control:
 * no-store (server.js), so this JSON read is current by construction. It is the
 * heavier of the two per open — uncached, and base64 is 4/3 the size of the
 * bytes — and that is the price of both properties.
 */
router.get('/vendors/:id/logo', async (req, res, next) => {
  try {
    if (!(await vendorExists(req, res))) return;
    const { data, error } = await supabaseAdmin
      .from('vendors')
      .select('logo')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    res.json({ logo: data?.logo ?? null });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/vendors/:id/rewards — all of one vendor's items incl. inactive. */
router.get('/vendors/:id/rewards', async (req, res, next) => {
  try {
    if (!(await vendorExists(req, res))) return;
    const { data, error } = await supabaseAdmin
      .from('rewards')
      .select('id, title, cost_in_points, cost_in_visits, emoji, active, created_at')
      .eq('vendor_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/vendors/:id/rewards  { title, costInPoints, costInVisits, emoji } */
router.post('/vendors/:id/rewards', async (req, res, next) => {
  try {
    if (!(await vendorExists(req, res))) return;
    const v = validReward(req.body?.title, req.body?.costInPoints, req.body?.costInVisits, req.body?.emoji);
    if (v.error) return res.status(400).json({ error: 'BAD_REWARD', message: v.error });

    const { data, error } = await supabaseAdmin
      .from('rewards')
      .insert({
        vendor_id: req.params.id,
        title: v.title,
        cost_in_points: v.cost,
        cost_in_visits: v.visits,
        emoji: v.emoji,
      })
      .select()
      .single();
    if (error) throw error;
    // Rewards ride inside the cached catalogue payload.
    invalidateVendorCaches(req.params.id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/vendors/:id/rewards/:rewardId  { title?, costInPoints?, costInVisits?, emoji?, active? } */
router.patch('/vendors/:id/rewards/:rewardId', async (req, res, next) => {
  try {
    if (!(await vendorExists(req, res))) return;
    if (!isUuid(req.params.rewardId)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Reward not found.' });
    }

    const touchesFields =
      req.body?.title !== undefined || req.body?.costInPoints !== undefined ||
      req.body?.costInVisits !== undefined || req.body?.emoji !== undefined;

    const updates = {};
    if (touchesFields) {
      // Merge against the STORED row so a partial PATCH revalidates real values
      // and clearing one of the two prices stays possible (same reasoning as
      // the vendor-side PATCH in src/routes/vendor.js).
      const { data: current } = await supabaseAdmin
        .from('rewards').select('title, cost_in_points, cost_in_visits, emoji')
        .eq('id', req.params.rewardId).eq('vendor_id', req.params.id).maybeSingle();
      if (!current) return res.status(404).json({ error: 'NOT_FOUND', message: 'Reward not found.' });

      const merged = {
        title: req.body?.title !== undefined ? req.body.title : current.title,
        cost: req.body?.costInPoints !== undefined ? req.body.costInPoints : current.cost_in_points,
        visits: req.body?.costInVisits !== undefined ? req.body.costInVisits : current.cost_in_visits,
        emoji: req.body?.emoji !== undefined ? req.body.emoji : current.emoji,
      };
      const v = validReward(merged.title, merged.cost, merged.visits, merged.emoji);
      if (v.error) return res.status(400).json({ error: 'BAD_REWARD', message: v.error });

      if (req.body?.title !== undefined) updates.title = v.title;
      if (req.body?.costInPoints !== undefined) updates.cost_in_points = v.cost;
      if (req.body?.costInVisits !== undefined) updates.cost_in_visits = v.visits;
      if (req.body?.emoji !== undefined) updates.emoji = v.emoji;
    }
    if (typeof req.body?.active === 'boolean') updates.active = req.body.active;
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Nothing to update.' });
    }

    const { data, error } = await supabaseAdmin
      .from('rewards')
      .update(updates)
      .eq('id', req.params.rewardId)
      .eq('vendor_id', req.params.id) // an id from another vendor is a 404, not a cross-edit
      .select()
      .maybeSingle();
    if (error) {
      // The DB CHECK is the backstop for anything the merge above missed.
      if (String(error.message ?? '').includes('rewards_has_a_price')) {
        return res.status(400).json({ error: 'BAD_REWARD', message: 'Set a point cost, a visit cost, or both.' });
      }
      throw error;
    }
    if (!data) return res.status(404).json({ error: 'NOT_FOUND', message: 'Reward not found.' });
    // Covers hiding an item too — a "delete" here is active: false, not a row
    // removal, and it still has to leave the students' catalogue.
    invalidateVendorCaches(req.params.id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/vendors/:id
 * Hard-delete a vendor — the irreversible counterpart to the `active` toggle.
 * Removing the vendors row cascades away everything vendor-scoped (staff links,
 * balances, rewards, redeem codes, PIN sessions) and clears the logo, which is
 * stored on the row itself. Transaction rows are KEPT but anonymized:
 * migration-017 switches the vendor_id + reward_id FKs to ON DELETE SET NULL, so
 * a student's history survives (rendered as a generic "Vendor") and the platform
 * totals don't silently drop.
 *
 * The vendor's dedicated login account(s) are removed too, so nothing lingers —
 * but ONLY a login that, after this delete, is no longer staff of any vendor. A
 * multi-location owner who still runs another vendor keeps their login (and its
 * access there). Deleting the auth user cascades its profile/balances; its own
 * transactions, if any, anonymize via migration-011. Best-effort and non-fatal:
 * the vendor is already gone, so a failed auth cleanup just leaves an inert
 * login rather than 500-ing the whole request. Unlike the toggle, none of this
 * can be undone.
 *
 * A PAID SUBSCRIPTION IS CANCELLED FIRST, and this route refuses to delete if
 * that cancel does not land — see the block below for why nothing downstream can
 * clean it up afterwards.
 */
router.delete('/vendors/:id', async (req, res, next) => {
  try {
    // Same guard as PATCH: a malformed id is a clean 404, not a uuid cast 500.
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Vendor not found.' });
    }

    // One read for both pre-delete guards below. Both columns live on the row
    // this route is about to destroy, so anything either guard needs has to be
    // taken off it now: after the delete, pool_id and the migration-055 billing
    // ids are gone and there is nothing left to check them against.
    const { data: existing, error: readErr } = await supabaseAdmin
      .from('vendors').select('pool_id, stripe_subscription_id').eq('id', req.params.id).maybeSingle();
    if (readErr) throw readErr;

    // A location that shares points cannot be deleted while it is in the pool.
    // vendors -> point_balances is ON DELETE CASCADE, and a pooled location's
    // customers hold their money in pool_balances, which has NO cascade path
    // from vendors (migration-044) — so a delete here would strand their share
    // in a purse this shop no longer belongs to, with the pool_moves row that
    // recorded its contribution nulled out and the settlement history gone.
    // Taking it out of the pool first runs the contribution split, which hands
    // its customers their points back where they can actually spend them.
    if (existing?.pool_id) {
      return res.status(409).json({
        error: 'VENDOR_IN_POOL',
        message: 'This location shares points with others. Take it out of the pool first, which gives its customers their points back.',
      });
    }

    // STOP THE MONEY BEFORE THE ROW GOES, because the row IS the billing link.
    // migration-055 keeps stripe_customer_id / stripe_subscription_id on
    // vendors, and nothing else in the system knows this subscription exists:
    // once the row is deleted, resolveVendor in src/routes/stripe-webhook.js
    // matches nothing and every further invoice event is answered 200 with
    // "matched no vendor - ignoring". The vendor cannot reach Stripe's own
    // cancel screen either — POST /api/vendor/billing-portal needs a login, and
    // the orphan sweep at the end of this handler deletes it. So the card just
    // keeps being charged every month until a human happens to notice the
    // subscription in the Stripe dashboard, and there is no record here of whose
    // it was.
    //
    // Deliberately NOT best-effort, unlike the auth cleanup below. That one
    // fails safe (an inert login nobody can sign into); this one fails into
    // "we destroyed the only record of who is being charged, and kept charging
    // them", so a failure has to leave the vendor standing and say so. Same 409
    // shape as VENDOR_IN_POOL: a precondition the operator can go and fix.
    //
    // Cancelling first costs one narrow window in the other direction: if the
    // row delete a few lines down then fails, the subscription is already gone
    // and the vendor is left standing on the free plan (which is the state the
    // customer.subscription.deleted webhook writes anyway). That is recoverable
    // by starting a plan again; the reverse is not recoverable by anybody.
    if (existing?.stripe_subscription_id) {
      if (!stripeEnabled) {
        // No STRIPE_SECRET_KEY on this deployment. A subscription id on the row
        // still means a real, billing subscription somewhere in Stripe (the
        // webhook nulls the column when one ends), and we have no way to reach
        // it from here — so this is the same refusal, not a silent delete.
        return res.status(409).json({
          error: 'VENDOR_HAS_BILLING',
          message: 'This vendor has a paid subscription and Stripe isn’t configured on this server, so it can’t be cancelled from here. Cancel it in the Stripe dashboard first, then delete.',
        });
      }
      try {
        await cancelSubscription(existing.stripe_subscription_id);
      } catch (err) {
        // Anything that is not a 404 is Stripe refusing, or the network failing:
        // the subscription may well still be live, so the vendor stays standing.
        if (err?.status !== 404) {
          console.error(
            `[admin] vendor ${req.params.id} NOT deleted — could not cancel subscription ` +
            `${existing.stripe_subscription_id}: ${err?.message ?? err}`,
          );
          return res.status(409).json({
            error: 'VENDOR_BILLING_CANCEL_FAILED',
            message: 'Stripe wouldn’t cancel this vendor’s subscription, so nothing has been deleted — deleting now would keep charging their card with no way to stop it. Cancel the subscription in the Stripe dashboard, then try again.',
          });
        }

        // A 404 HERE HAS TWO MEANINGS AND ONLY ONE OF THEM IS SAFE, so it is not
        // by itself a licence to delete the row.
        //
        //   * ALREADY CANCELLED. DELETE on a subscription Stripe no longer has to
        //     cancel answers 404 `resource_missing` (see cancelSubscription in
        //     src/lib/stripe.js). That is the state a missed
        //     customer.subscription.deleted webhook leaves migration-055's column
        //     in. Nothing is being charged, and refusing would wedge the vendor
        //     undeletable — the operator cannot cancel what is already cancelled.
        //
        //   * NOT VISIBLE TO THIS KEY. Stripe answers the SAME 404
        //     `resource_missing` for an id that exists but not under the key this
        //     process holds: a subscription in another Stripe account (rotated
        //     STRIPE_SECRET_KEY) or in the other livemode — sk_test_ keys on a box
        //     whose vendors were signed up live, which is exactly the silent
        //     misconfiguration stripeMode() is printed at boot to catch. Here the
        //     card IS still being charged every month, and deleting the row throws
        //     away the only copy of the id (nothing else in the system knows it —
        //     see the block above), which is verbatim the disaster this whole
        //     pre-cancel exists to prevent.
        //
        // err.status and err.code are identical in both (404 / resource_missing),
        // so the error cannot tell them apart. A READ can: cancelling does not
        // remove the object, so GET on a cancelled subscription still answers 200
        // with status 'canceled', while GET on an id this key cannot see 404s
        // again just like the DELETE did.
        let status = null;
        let probeErr = null;
        try {
          status = (await getSubscription(existing.stripe_subscription_id))?.status ?? null;
        } catch (e) {
          probeErr = e;
        }

        // REFUSE unless the read PROVED the thing is finished. Refusing is the
        // recoverable half of this choice: the vendor and its ids stay on the
        // table, and the operator's escape hatches are real (point the keys at the
        // right account and retry, cancel it in the account that does own it, or
        // — for an id no key on this server can reach at all — the explicit
        // override below, which is why the id is in the log line and the push).
        // Proceeding is the half nobody can undo: the id is gone, resolveVendor in
        // src/routes/stripe-webhook.js matches nothing from then on, and the
        // charges continue with no record of whose they are.
        //
        // UNREACHABLE IS NOT THE SAME REFUSAL AS UNCONFIRMED, and this is where
        // the deploy state actually bites. A vendor onboarded while this server
        // held sk_test_ keys carries a test-mode subscription id; under the live
        // keys the operator has now set, the cancel 404s and the read-back 404s,
        // so no retry and no dashboard visit can ever make this branch pass —
        // the object simply is not in the account these keys address. Without a
        // way out that vendor is undeletable except from a SQL console (there is
        // still no /admin control for vendors.stripe_subscription_id), so:
        //
        //   `?unreachable_subscription=1` deletes anyway — and ONLY in the
        //   double-404 case (`probeErr` is itself a 404). That restriction is the
        //   whole safety argument. Where the read-back answered with a LIVE
        //   status, the subscription IS reachable with these keys and IS billing a
        //   card, so the override is refused there and the operator is sent to the
        //   dashboard that can actually cancel it; same for a read that failed for
        //   any other reason, which is "we don't know yet", not "we can't ever
        //   know". It also cannot be pressed by accident: deleteVendor in
        //   public/admin/admin.js sends no query string, so this needs a typed URL,
        //   and it never skips the cancel — the cancel and the probe have both
        //   already run and both already 404'd by the time it is consulted.
        const proved = TERMINAL_SUBSCRIPTION_STATUSES.includes(String(status));
        // 404 on the cancel AND 404 on the read-back: not in this key's account or
        // livemode. Nothing here can cancel it, so nothing here can confirm it.
        const unreachable = probeErr?.status === 404 || probeErr?.code === 'resource_missing';
        const overrideAsked = req.query.unreachable_subscription === '1';

        if (!proved && !(unreachable && overrideAsked)) {
          // Never silent, whichever way the read went — an unconfirmed
          // subscription is a live billing relationship until a human says
          // otherwise, and the id is the only handle on it.
          //
          // THREE DIFFERENT THINGS HAPPENED HERE and the operator has to be told
          // which: the read said the subscription is alive, or the read 404'd
          // too (these keys cannot see it), or the read failed for some other
          // reason. `why` has carried that distinction into the log line since
          // this block was written, and the 409 below now carries it as well —
          // the version that hard-coded "Stripe has no subscription X under this
          // server's keys" told an operator whose subscription had just read back
          // as 'active' the exact opposite of what had happened, and sent them
          // hunting for an object that was sitting in the dashboard they were
          // already looking at. The PUSH stays one generic sentence on purpose:
          // it is a nudge to go and read this response, it names the id and the
          // mode, and web-push bodies are truncated by the OS. (cancel404Verdict
          // in src/routes/stripe-webhook.js is the same decision table; it stays
          // duplicated here for the same reason TERMINAL_SUBSCRIPTION_STATUSES
          // does — see that constant.)
          const why = probeErr
            ? (unreachable
              ? 'and reading it back failed too (a second 404: it is not in this Stripe account or mode)'
              : `and reading it back failed too (${probeErr?.message ?? probeErr})`)
            : `and it reads back as '${status}', which is not a finished subscription`;
          const line =
            `[admin] vendor ${req.params.id} NOT deleted — Stripe answered 404 when cancelling ` +
            `subscription ${existing.stripe_subscription_id} ${why}. It may still be billing a card. ` +
            `These keys are ${stripeMode() ?? 'unset'} mode; look ${existing.stripe_subscription_id} up ` +
            'in the dashboard of the account they belong to.';
          console.error(line);
          await notifyAdmins({
            title: 'Vendor not deleted — subscription unconfirmed',
            body:
              `Could not confirm subscription ${existing.stripe_subscription_id} is cancelled, so the ` +
              'vendor was left standing rather than losing the only record of it. It may still be ' +
              `charging a card. Check it in Stripe (${stripeMode() ?? 'no keys'} mode).`,
            url: '/admin',
          });

          const mode = stripeMode() ?? 'not set';
          const message = unreachable
            // Both calls 404'd. Saying "these keys cannot see it" is the true
            // sentence; "Stripe has no such subscription" is not, and it is the
            // one that makes an operator conclude the column is junk and reach
            // for the database. This is also the only arm that offers the
            // override, and it spells out the exact thing to check first.
            ? `Neither cancelling nor reading subscription ${existing.stripe_subscription_id} worked — these keys (${mode} mode) can’t see it, which is what Stripe answers for a subscription in the other mode or in another account. Nothing has been deleted, because deleting would destroy the only record of that subscription. If it belongs to a Stripe account or mode you can reach, cancel it there and try again. If you have checked it is charging nobody (a leftover test-mode id, for instance), append ?unreachable_subscription=1 to this DELETE to remove the vendor anyway — the id is written to the error log and pushed to every operator first.`
            : overrideAsked
              // They asked for the override on a subscription that answered. The
              // param must not read as "delete regardless", so the refusal says
              // why it did not apply rather than ignoring it in silence.
              ? (probeErr
                ? `Stripe answered 404 when cancelling subscription ${existing.stripe_subscription_id}, and reading it back failed for a different reason (${probeErr?.message ?? probeErr}), so we can’t tell yet whether it is still charging. Nothing has been deleted, and unreachable_subscription does not apply — it only covers an id these keys cannot see at all. Try again in a moment.`
                : `Stripe answered 404 when cancelling subscription ${existing.stripe_subscription_id}, but it still reads back as ‘${status}’, so these keys CAN see it and it is not finished. unreachable_subscription does not apply to a subscription that answers — cancel it in the Stripe dashboard (${mode} mode), then delete.`)
              : probeErr
                ? `Stripe answered 404 when cancelling subscription ${existing.stripe_subscription_id}, and reading it back failed too (${probeErr?.message ?? probeErr}), so we can’t confirm this vendor has stopped being charged — nothing has been deleted, because deleting would destroy the only record of that subscription. Try again in a moment; if it keeps failing, find ${existing.stripe_subscription_id} in the Stripe dashboard (${mode} mode) and cancel it there.`
                : `Stripe answered 404 when cancelling subscription ${existing.stripe_subscription_id}, but it still reads back as ‘${status}’, which is not a finished subscription — so this vendor may still be being charged and nothing has been deleted. Find it in the Stripe dashboard (these keys are ${mode} mode) and cancel it there, then try again.`;

          return res.status(409).json({ error: 'VENDOR_BILLING_CANCEL_FAILED', message });
        }

        if (!proved) {
          // The override path. LOUDER than the refusal it replaced, because this
          // is the one outcome where the row that held the id goes away without
          // anything having proved the subscription is dead: the id has to be
          // recoverable from the log afterwards, and an operator who used the
          // param by mistake has to find out from a push rather than from a
          // statement in three weeks.
          const line =
            `[admin] vendor ${req.params.id} DELETED with unreachable_subscription=1 — subscription ` +
            `${existing.stripe_subscription_id} could be neither cancelled nor read with these ` +
            `${stripeMode() ?? 'unset'}-mode keys (404 to both), and an operator (${req.user?.email ?? 'unknown'}) ` +
            'overrode the refusal. If that id is live in some other Stripe account or mode, it is now ' +
            'the only copy of it — cancel it there.';
          console.error(line);
          await notifyAdmins({
            title: 'Vendor deleted with an unconfirmed subscription',
            body:
              `${req.user?.email ?? 'An operator'} deleted a vendor whose subscription ` +
              `${existing.stripe_subscription_id} these ${stripeMode() ?? 'unset'}-mode keys cannot see. ` +
              'If it exists in another account or mode, cancel it there — this was the last record of it.',
            url: '/admin',
          });
        }

        // Guarded on `proved` so the happy 404 ("already cancelled") is not also
        // announced on the override path above, where the status is null or still
        // alive and this sentence would be false.
        if (proved) {
          console.warn(
            `[admin] subscription ${existing.stripe_subscription_id} for vendor ${req.params.id} was ` +
            `already gone at Stripe (404) and reads back as '${status}' — nothing left to cancel or to ` +
            'bill, continuing with the delete.',
          );
        }
      }
    }

    // Read the linked login accounts BEFORE the delete — the vendors delete
    // cascades vendor_staff away, so they're unreadable afterward.
    const { data: staff, error: staffErr } = await supabaseAdmin
      .from('vendor_staff')
      .select('user_id')
      .eq('vendor_id', req.params.id);
    if (staffErr) throw staffErr;

    const { data, error } = await supabaseAdmin
      .from('vendors')
      .delete()
      .eq('id', req.params.id)
      .select('id')          // returns the row only if one was actually deleted
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'NOT_FOUND', message: 'Vendor not found.' });
    // Before the orphaned-login sweep below, which can take a while: a deleted
    // vendor must not keep being served to students out of the cache meanwhile.
    invalidateVendorCaches(req.params.id);

    // Remove each login that's now orphaned (no remaining vendor_staff link) —
    // UNLESS it is also a student account (has a profiles row). Deleting a
    // dual-role auth user here would cascade the person's balances, history,
    // and profile away with the vendor; instead they simply stop being vendor
    // staff (the cascade already removed the link, and the migration-035
    // trigger flipped profiles.is_vendor off).
    //
    // BOTH LOOKUPS MUST SUCCEED BEFORE ANYTHING IS DELETED, and that is the
    // whole shape of this loop. postgrest-js reports a failed response by
    // setting count = null / data = null and putting the reason in `error`, so a
    // dropped connection or a PostgREST hiccup is byte-for-byte
    // indistinguishable from the answers that mean "no links left" and "not a
    // student" — and this is the one place in the file where believing those two
    // answers destroys an account. A vendor login has no profiles row at all
    // (migration-022 dropped the auto-create trigger), so one failed count
    // query while deleting a single store of a multi-location owner would read
    // as "orphaned, not a student" and delete their login — and auth.users ->
    // vendor_staff is ON DELETE CASCADE, so the store they still run loses its
    // access too. onboardVendor also LINKS a pre-existing account when
    // createUser says email_exists, and deliberately refuses to delete a linked
    // account when it rolls back; this sweep has no memory of that
    // (`linkedExisting` is not recorded anywhere), so the account at risk can be
    // an operator's own Google login or a student who never consented to being
    // vendor staff. The safe default is therefore to leave a login alone on any
    // unknown state: an inert extra auth user costs nothing and is deletable by
    // hand, and the vendor itself is already gone either way.
    for (const { user_id: uid } of staff ?? []) {
      const { count, error: countErr } = await supabaseAdmin
        .from('vendor_staff')
        .select('vendor_id', { count: 'exact', head: true })
        .eq('user_id', uid);
      if (countErr) {
        console.error(`[admin] left login ${uid} in place — could not count its remaining vendor_staff links: ${countErr.message}`);
        continue;
      }
      if (!count) {
        const { data: profile, error: profileErr } = await supabaseAdmin
          .from('profiles')
          .select('user_id')
          .eq('user_id', uid)
          .maybeSingle();
        if (profileErr) {
          console.error(`[admin] left login ${uid} in place — could not check whether it is also a student account: ${profileErr.message}`);
          continue;
        }
        if (!profile) await supabaseAdmin.auth.admin.deleteUser(uid).catch(() => {});
      }
    }

    res.json({ ok: true, id: data.id });
  } catch (err) {
    next(err);
  }
});

/* ---------- points pools (migration-044/046) ----------
   Operator-only, and deliberately so. Putting two locations in a pool merges
   their customers' balances, which is irreversible in the sense that matters:
   the split that undoes it hands each location back only what its own trading
   funded, which is correct but is not the state anyone was in before. The
   vendor side has no way to prove a location is theirs, and a staff PIN is one
   shop's four digits authorising a change to all of them. So there is no
   vendor-facing route and no terminal control: an owner asks, and this is where
   it happens. See supabase/migrations/20260820140000_migration-046.sql. */

const POOL_LABEL_MAX = 80;   // same cap as point_pools_label_len (migration-044)

/**
 * GET /api/admin/pools
 * Every pool with its members, for the operator's panel. Two queries whatever
 * the number of pools; the roster is small and this page is one operator.
 */
router.get('/pools', async (req, res, next) => {
  try {
    const [{ data: pools, error: pErr }, { data: members, error: mErr }] = await Promise.all([
      supabaseAdmin.from('point_pools').select('id, label, created_at').order('created_at'),
      supabaseAdmin.from('vendors').select('id, name, location_label, active, points_per_dollar, pool_id, pool_joined_at')
        .not('pool_id', 'is', null),
    ]);
    if (pErr) throw pErr;
    if (mErr) throw mErr;

    // What the purse is holding, so the operator can see at a glance whether a
    // pool can be retired and how much is riding on it.
    const ids = (pools ?? []).map((p) => p.id);
    let held = new Map();
    if (ids.length) {
      const { data: balances, error: bErr } = await supabaseAdmin
        .from('pool_balances').select('pool_id, balance').in('pool_id', ids).gt('balance', 0);
      if (bErr) throw bErr;
      for (const b of balances ?? []) {
        const cur = held.get(b.pool_id) ?? { points: 0, customers: 0 };
        cur.points += b.balance ?? 0;
        cur.customers += 1;
        held.set(b.pool_id, cur);
      }
    }

    res.json((pools ?? []).map((p) => ({
      ...p,
      members: (members ?? []).filter((m) => m.pool_id === p.id),
      held: held.get(p.id) ?? { points: 0, customers: 0 },
    })));
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/pools  { label } — create an empty pool. Holds nothing until
 *  a location joins, so this is the one harmless step. */
router.post('/pools', async (req, res, next) => {
  try {
    const label = String(req.body?.label ?? '').trim();
    if (!label || label.length > POOL_LABEL_MAX) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
        message: `Give the pool a name (max ${POOL_LABEL_MAX} characters). Customers see it: "Shared across 3 <name> spots."`,
      });
    }
    const { data, error } = await supabaseAdmin
      .from('point_pools').insert({ label }).select('id, label, created_at').single();
    if (error) throw error;
    res.status(201).json({ ok: true, pool: { ...data, members: [], held: { points: 0, customers: 0 } } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/pools/:id/members  { vendorId }
 * The moment sharing turns on for a location: pool_join drains its customers'
 * balances into the purse, in one transaction, with an audit row each.
 * Preconditions (a staff PIN everywhere, one earning rate) are enforced inside
 * the RPC, where they cannot be raced.
 */
router.post('/pools/:id/members', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'POOL_NOT_FOUND', message: 'That points pool no longer exists.' });
    }
    const vendorId = req.body?.vendorId;
    if (!isUuid(vendorId)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Pick a location to add.' });
    }

    const { data, error } = await supabaseAdmin.rpc('pool_join', {
      p_pool_id: req.params.id,
      p_vendor_id: vendorId,
    });
    if (error) throw error;

    // The catalogue carries pool_id and the pool's label, and every card in the
    // student app is about to show a different number. Coarse invalidation on
    // purpose: this changed several vendors at once.
    invalidateVendorCaches();

    const row = data?.[0] ?? { customers: 0, points_moved: 0 };
    res.json({ ok: true, customers: row.customers, pointsMoved: row.points_moved });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/pools/:id/members/:vendorId
 * Stop sharing at one location. pool_leave runs the contribution split: it
 * takes back what its own trading funded and leaves the rest, so points are
 * conserved and nobody is confiscated. The last member out takes the remainder,
 * or it would be stranded where no one can spend it.
 */
router.delete('/pools/:id/members/:vendorId', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id) || !isUuid(req.params.vendorId)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Not found.' });
    }
    const { data, error } = await supabaseAdmin.rpc('pool_leave', { p_vendor_id: req.params.vendorId });
    if (error) throw error;
    invalidateVendorCaches();

    const row = data?.[0] ?? { customers: 0, points_moved: 0 };
    res.json({ ok: true, customers: row.customers, pointsMoved: row.points_moved });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/admin/pools/:id — retire an empty pool. Refuses while it has
 *  members or holds points; taking the members out is what empties it. */
router.delete('/pools/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'POOL_NOT_FOUND', message: 'That points pool no longer exists.' });
    }
    const { error } = await supabaseAdmin.rpc('pool_delete', { p_pool_id: req.params.id });
    if (error) throw error;
    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/pools/:id/settlement — who funded whom inside one pool. */
router.get('/pools/:id/settlement', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'POOL_NOT_FOUND', message: 'That points pool no longer exists.' });
    }
    const { data, error } = await supabaseAdmin.rpc('pool_settlement', { p_pool_id: req.params.id });
    if (error) throw error;
    res.json(data ?? []);
  } catch (err) {
    next(err);
  }
});

/* ---------- vendor applications (public /join queue) ---------- */

/**
 * GET /api/admin/applications
 * Every pending vendor application, oldest first (a FIFO review queue — the
 * badge count on the dashboard is just this array's length). password_hash is
 * deliberately not selected: the operator never needs it, only accept does.
 */
router.get('/applications', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('vendor_applications')
      .select('id, business_name, contact_name, phone, email, address, location_label, locations, logo, message, cuisine, price_level, rewards, created_at')
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data ?? []);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/applications/:id/accept
 * Onboard the applicant through the shared onboardVendor path (auth login →
 * vendors row → vendor_staff link). The login is created from the stored bcrypt
 * hash (password_hash), so the vendor signs in with the password they chose when
 * applying — unless the email already had an account, which is linked instead
 * and keeps its own password (`linkedExisting` tells the dashboard to say so;
 * see onboardVendor).
 *
 * THE DELETE OF THE APPLICATION ROW HAPPENS FIRST, BEFORE ANY ONBOARDING, and
 * that ordering is the whole idempotency story for this route — read the comment
 * on the delete below before changing it back.
 */
router.post('/applications/:id/accept', async (req, res, next) => {
  try {
    // Same guard as the vendor routes: malformed id → clean 404, not a uuid 500.
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Application not found.' });
    }

    // CLAIM THE APPLICATION BY DELETING IT. The delete is the lock: `.select()
    // .maybeSingle()` returns a row only to the request that actually removed
    // it, so a double-click, a retry, or a second operator pressing Accept at
    // the same moment gets no row and falls straight through to the 404 below,
    // having created nothing.
    //
    // This used to run the other way round — onboard, then delete — and there is
    // no lock anywhere in that order. onboardVendor COMMITS as it goes (an auth
    // user, a vendors row per location, vendor_staff links, starter rewards),
    // and a failure of the delete afterwards threw a 500 with the vendor already
    // real; the admin client treats any non-404 as retryable and re-enables
    // Accept with the row still in the queue. The retry re-enters onboardVendor,
    // createUser reports email_exists so the existing login is LINKED, and
    // createVendorRow's 23505 suffix loop cheerfully inserts "name-2" with its
    // own staff link and a second copy of every starter reward. Nothing refuses
    // it: many vendors per login is a deliberate feature (migration-043), so no
    // constraint stands between a retry and a duplicate store.
    //
    // `message` and `created_at` are selected purely so a restore below can put
    // the row back as it was — everything not read here is destroyed with the
    // row, and a restored application that had lost the applicant's pitch or
    // jumped to the front of the FIFO queue would be a quieter version of the
    // same bug.
    const { data: app, error: appErr } = await supabaseAdmin
      .from('vendor_applications')
      .delete()
      .eq('id', req.params.id)
      // contact_name opens the acceptance email with a person's name rather
      // than the business's — and, since migration-049, is ALSO copied onto
      // every vendors row this accept creates, along with `phone`.
      //
      // That copy is the whole point of 049. This handler has just deleted the
      // application row, so anything not carried across here is destroyed,
      // permanently, at the moment the vendor becomes real. The phone number
      // spent this entire project in that gap: asked for on a public form, shown
      // to the operator once in the review queue, gone. It is also the one field
      // that matters most AFTER acceptance rather than before, because dictating
      // a reset code down the phone (migration-031) is the only recovery left
      // for a vendor who has lost their mailbox too.
      .select('id, business_name, contact_name, phone, email, password_hash, address, location_label, locations, logo, message, cuisine, price_level, rewards, created_at')
      .maybeSingle();
    if (appErr) throw appErr;
    // Already accepted/rejected (double-click, or a second admin got there
    // first) — or, now, a concurrent accept that won the claim a moment ago.
    if (!app) return res.status(404).json({ error: 'NOT_FOUND', message: 'Application not found.' });

    /**
     * Put a claimed application back so the operator can press Accept again.
     * Only reached when the onboarding that followed the claim produced no
     * vendor, so re-inserting cannot resurrect a row for a business that now
     * exists. The id and created_at go back as they were: the same row, in the
     * same place in the queue, not a new application at the back of it.
     *
     * If the re-insert ALSO fails we have nothing left but the log, so the row
     * goes into it as JSON and that line is what makes the application
     * recoverable by hand — losing a real business's application silently is the
     * one outcome worse than a duplicate vendor.
     *
     * TWO KINDS OF VALUE ARE DELIBERATELY NOT IN THAT LINE, and what is lost with
     * each is the point of the paragraphs below.
     *
     * EVERY LOGO ON THE ROW — not just the `logo` column. One logo is up to
     * LOGO_MAX_CHARS = 500_000 characters of base64 (src/lib/logo.js) on ONE
     * console line. Heroku's Logplex truncates a log line at 10 KB, and PostgREST
     * returns keys in select order, so shipping a blob would cut off everything
     * after it — `message`, `cuisine`, `price_level`, `rewards`, `created_at`: the
     * applicant's pitch and what they promised students. The line meant to make the
     * row recoverable would be the one thing guaranteed not to survive the
     * pipeline. Only the lengths are logged; the operator re-asks for the image, or
     * sets it later on the Spots tab.
     *
     * AND THERE IS ONE LOGO PER LOCATION, which is why the redaction below walks
     * the array instead of touching one column. `locations` (migration-043) holds
     * locations two and up, and each element carries its own `logo` — worse,
     * validLocation in src/routes/apply.js INHERITS location one's data URL when a
     * branch sends no logo of its own, which /join always does (its own comment:
     * "WHAT THE SHOP SELLS IS INHERITED … /join asks for all three exactly once").
     * So a chain at MAX_LOCATIONS = 12 (apply.js) is up to TWELVE verbatim copies
     * of the same 500 KB blob: redacting only the column left ~5.5 MB on this line
     * and lost the whole tail regardless, i.e. exactly the failure the paragraph
     * above says it prevents.
     *
     * NOTHING ELSE ON THE ROW IS A BLOB, so logos are the whole job here: `rewards`
     * is at most MAX_STARTER_ITEMS = 6 items of a 60-character title plus a
     * 16-character emoji (validStarterItem, src/lib/rewards.js), and `cuisine` — on
     * the row and on every location — is at most MAX_CUISINES = 3 slugs from a fixed
     * list (normalizeCuisine, src/lib/cuisines.js). With every remaining field at
     * its /join cap and all 12 locations present, the line measures ~9 KB and fits.
     * What is left is arithmetic rather than an unbounded value, and it is stated so
     * nobody re-derives it: a 12-location row whose every free-text field is filled
     * to its cap with multi-byte characters can still reach ~20 KB of UTF-8, and it
     * is again the tail that would drop. Tightening the /join caps, not this line,
     * is where that would be fixed.
     *
     * `password_hash` is a credential, and stdout is the one place this repo
     * refuses to put one (src/lib/errors.js:13-19 redacts pass/token/key/logo for
     * exactly this reason). The consequence is real and must be said out loud:
     * WITHOUT THE HASH, THE APPLICANT'S CHOSEN PASSWORD IS GONE. Re-keying this
     * application therefore means the operator adds the vendor with POST
     * /api/admin/vendors and a password they type, then tells them — or issues a
     * reset code (migration-031) — so the applicant picks a new one. An extra
     * email beats a bcrypt hash sitting in a log aggregator forever.
     */
    const restoreApplication = async () => {
      const { error: restoreErr } = await supabaseAdmin.from('vendor_applications').insert(app);
      if (restoreErr) {
        // Copied, not mutated: `app` is still the row this same function hands to
        // insert() on a later retry, and onboardVendor reads its fields above. A
        // JSON round-trip because that is all the row is — plain JSON out of
        // PostgREST — and it leaves `locations` / `rewards` as their own arrays
        // rather than aliases of the live row's.
        const recoverable = JSON.parse(JSON.stringify(app));
        recoverable.password_hash = app.password_hash ? '[redacted — applicant must choose a new password]' : null;
        recoverable.logo = app.logo ? `[logo dropped — ${app.logo.length} chars of base64]` : null;
        // The same redaction, once per branch (see the doc comment above). Lengths
        // are read off the COPY, not off `app.locations[i]`, so this cannot drift
        // out of alignment with the array it is rewriting. Guards, because this is
        // jsonb and only /join's validLocation promises the element shape: a
        // non-object (or an array, whose spread would silently become an object with
        // numeric keys) is passed through untouched rather than mangled — a row a
        // human hand-edited is still a row the operator has to be able to recover.
        if (Array.isArray(recoverable.locations)) {
          recoverable.locations = recoverable.locations.map((l) => (
            l && typeof l === 'object' && !Array.isArray(l)
              ? { ...l, logo: l.logo ? `[logo dropped — ${String(l.logo).length} chars of base64]` : null }
              : l
          ));
        }
        // WHY IT COULD NOT GO BACK CHANGES WHAT THE OPERATOR SHOULD DO, so the
        // one failure that is not a broken database is named. 23505 here is the
        // unique index on lower(email) (idx_vendor_applications_email,
        // supabase/migrations/00000000000018_migration-018.sql): the claim delete
        // above freed the address, and somebody re-submitted /join with it inside
        // the window this onboard took — which /join answers as a clean duplicate
        // only while the row is present. The applicant's own words are therefore
        // back in the queue already, and re-keying them out of this log line
        // would make a second copy of a live application. This is a known,
        // accepted residual of claim-by-delete (the alternative, claiming with a
        // status column, needs a migration): the row survives in the queue or in
        // this line, never in neither.
        const conflict = restoreErr.code === '23505'
          ? ' A NEWER APPLICATION FOR THIS EMAIL ALREADY EXISTS — the applicant re-submitted /join while ' +
            'this accept was running, so look for their new row in the queue and accept that one INSTEAD ' +
            'of re-keying this copy.'
          : '';
        console.error(
          `[admin] application ${app.id} was claimed, onboarding failed, and it could NOT be put back ` +
          `(${restoreErr.message}).${conflict} Recover it from this row: ${JSON.stringify(recoverable)}`,
        );
      }
    };

    let onboarded;
    try {
      onboarded = await onboardVendor({
        name: app.business_name,
        email: app.email,
        passwordHash: app.password_hash,
        address: app.address,
        logo: app.logo,
        // What they told us on /join, carried straight onto the vendors row so a
        // newly accepted spot is filterable on the Spots tab immediately rather
        // than sitting untagged until someone edits it (migration-042).
        cuisine: app.cuisine,
        priceLevel: app.price_level,
        // One application, one login, one vendors row PER LOCATION
        // (migration-043). `locations` is [] for the single-location application
        // that is still the common case, which makes this the same onboarding it
        // always was.
        locationLabel: app.location_label,
        locations: Array.isArray(app.locations) ? app.locations : [],
        // The applicant's own contact details, onto every location this creates
        // (migration-049). Read the comment on the select above for why this line
        // is the one that stops the number being thrown away.
        contactName: app.contact_name,
        phone: app.phone,
        // What this spot will actually GIVE students (migration-052). Created
        // once per location, at each location’s own rate. [] for an application
        // submitted before 052 shipped, which onboards exactly as it used to.
        rewards: Array.isArray(app.rewards) ? app.rewards : [],
      });
    } catch (err) {
      // onboardVendor unwinds every row it made before it throws, so nothing
      // half-built survives — but the application is already claimed, and
      // without this the operator's queue would simply be one business short
      // with a 500 to explain it. Put it back, then let the error surface.
      await restoreApplication();
      throw err;
    }

    const { vendor, vendors, linkedExisting, conflict } = onboarded;
    // The taken email's account vanished mid-accept. Nothing was created, so put
    // the application back in the queue for a retry.
    if (conflict) {
      await restoreApplication();
      return res.status(409).json({
        error: 'EMAIL_EXISTS',
        message: 'This email’s account changed mid-accept. Reload and try again.',
      });
    }

    // The one email in this flow that has to actually work: it is how the vendor
    // learns they can sign in, and — when the address already had an account —
    // WHICH password does it (see applicationAccepted). Awaited so the operator's
    // 200 means the attempt is finished, never throws, and never blocks the
    // accept: the vendor exists either way, and /admin can re-send by hand.
    const accepted = applicationAccepted({
      businessName: app.business_name,
      contactName: app.contact_name,
      email: app.email,
      linkedExisting,
      locationCount: vendors?.length ?? 1,
      terminalUrl: emailUrl('/terminal/', req),
    });
    const mailed = await sendEmail({
      to: app.email,
      subject: accepted.subject,
      html: accepted.html,
      text: accepted.text,
      category: 'transactional',
      idempotencyKey: `accept:${app.id}`,
      tags: ['application-accepted'],
      log: {
        kind: 'application_accepted',
        recipientKind: 'vendor',
        vendorId: vendor?.id ?? null,
        recipientLabel: app.business_name,
        ref: { applicationId: app.id },
      },
    });

    // `vendors` is every location this accept created, so the dashboard can say
    // "3 locations added" rather than naming only the first. `emailed` lets it
    // say "we told them" — or, more usefully, that we could not.
    res.json({ ok: true, vendor, vendors, linkedExisting, emailed: mailed.ok });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/applications/:id
 * Reject an application — permanently deletes it (including the password hash
 * and logo). Nothing else was ever created for a pending application, so this
 * is the entire cleanup.
 */
router.delete('/applications/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Application not found.' });
    }
    const { data, error } = await supabaseAdmin
      .from('vendor_applications')
      .delete()
      .eq('id', req.params.id)
      .select('id')          // returns the row only if one was actually deleted
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'NOT_FOUND', message: 'Application not found.' });
    res.json({ ok: true, id: data.id });
  } catch (err) {
    next(err);
  }
});

/* ---------- incentives (migration-039) ---------- */

// Rows returned to the dashboard. spent_points is authoritative (the RPC keeps
// it), so the tab never has to sum the ledger to draw a budget bar.
const INCENTIVE_COLS = 'id, kind, name, active, starts_at, ends_at, budget_points, spent_points, config, created_by, created_at';

/**
 * Parse a date the operator typed (or cleared). Returns { value } with an ISO
 * string or null, or { error }. A blank field is a deliberate "no bound", which
 * is different from a bad date and has to stay different.
 */
function optionalDate(raw, label) {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) return { error: `${label} isn’t a valid date.` };
  return { value: t.toISOString() };
}

function optionalBudget(raw) {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10_000_000) {
    return { error: 'Budget must be blank (unlimited) or a whole number of points from 1 to 10,000,000.' };
  }
  return { value: n };
}

/** kind -> its config validator. Adding a kind means adding a row here AND an
    evaluator; anything not listed is refused before it can reach the CHECK
    constraint, whose message is not something to show an operator. */
const INCENTIVE_CONFIG_VALIDATORS = {
  referral: validReferralConfig,
  signup_domain: validSignupConfig,
};

/**
 * Validate the whole incentive body.
 *
 * `existingKind` is passed on an edit: `kind` is fixed at creation (changing it
 * would reinterpret every referral row already pointing at the incentive), so
 * an edit validates against what the row already is rather than trusting a
 * field the form may not even send.
 */
function validIncentive(body, { existingKind = null } = {}) {
  const kind = existingKind ?? body?.kind;
  const validateConfig = INCENTIVE_CONFIG_VALIDATORS[kind];
  if (!validateConfig) return { error: 'Pick a valid incentive type.' };

  const name = String(body?.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) {
    return { error: 'Give the incentive a name (2 to 80 characters).' };
  }

  const starts = optionalDate(body?.startsAt, 'Start date');
  if (starts.error) return { error: starts.error };
  const ends = optionalDate(body?.endsAt, 'End date');
  if (ends.error) return { error: ends.error };
  if (starts.value && ends.value && new Date(ends.value) <= new Date(starts.value)) {
    return { error: 'The end date has to be after the start date.' };
  }

  // A signup bonus MUST have a start. Without one, every existing student with
  // a matching address qualifies the moment they next re-accept revised terms —
  // which is a campus-wide payout for a program meant to reward new signups.
  // The evaluator checks profiles.created_at against this bound.
  if (kind === 'signup_domain' && !starts.value) {
    return { error: 'A signup bonus needs a start date: it only pays students who sign up after it.' };
  }

  const budget = optionalBudget(body?.budgetPoints);
  if (budget.error) return { error: budget.error };

  const cfg = validateConfig(body?.config);
  if (cfg.error) return { error: cfg.error };

  return {
    row: {
      kind,
      name,
      starts_at: starts.value,
      ends_at: ends.value,
      budget_points: budget.value,
      config: cfg.config,
    },
  };
}

// The three values referrals.status can hold (the CHECK in migration-039), in
// the order the tab draws them. Counted one at a time below, so this list is
// also the shape of the `referrals` object in the response.
const REFERRAL_STATUSES = ['pending', 'paid', 'void'];

/**
 * GET /api/admin/incentives
 * Every incentive plus the counts the tab draws.
 *
 * THE COUNTS ARE `count: 'exact', head: true` QUERIES, NOT TALLIES OF A
 * WHOLE-TABLE READ, and that is not a style preference. This route used to pull
 * `referrals(incentive_id, status)` and `community_grants(incentive_id)` entire
 * and count them in JS, with no range and no limit — and supabase/config.toml
 * sets max_rows = 1000, so PostgREST simply stopped sending rows at a thousand.
 * The dashboard's referral and payout numbers would have frozen there and stayed
 * frozen, getting quietly more wrong with every new referral, with nothing on
 * screen to say so. Unlike /overview, which pulls a windowed slab of
 * transactions and at least confesses `truncated` when it hits its own cap,
 * there was no cap to notice here.
 *
 * That makes it four counts per program instead of two reads flat — N+1, and
 * accepted deliberately: the programs list is a handful of rows an operator
 * created by hand, this panel is opened by one person, and a count PostgREST
 * computes in the database cannot truncate. Promise.all keeps each program's
 * four counts concurrent so the panel stays about as quick as it was.
 */
router.get('/incentives', async (req, res, next) => {
  try {
    const { data: rows, error } = await supabaseAdmin
      .from('incentives')
      .select(INCENTIVE_COLS)
      .order('active', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;

    const incentives = rows ?? [];
    const tallies = await Promise.all(incentives.map(async (row) => {
      const results = await Promise.all([
        ...REFERRAL_STATUSES.map((status) => supabaseAdmin
          .from('referrals')
          .select('id', { count: 'exact', head: true })
          .eq('incentive_id', row.id)
          .eq('status', status)),
        // How many students a program has actually paid. For a referral program
        // that is roughly its referral count; for a signup bonus it is the only
        // count there is, since nothing else records one.
        supabaseAdmin
          .from('community_grants')
          .select('id', { count: 'exact', head: true })
          .eq('incentive_id', row.id),
      ]);
      // Any failure has to surface as a 500 rather than a zero: a count that
      // silently reads 0 because the query failed is the same lie the row cap
      // was telling, just faster.
      for (const r of results) if (r.error) throw r.error;

      // The statuses came back in REFERRAL_STATUSES order; the grants count is
      // the one after them.
      const payouts = results[REFERRAL_STATUSES.length];
      return {
        referrals: Object.fromEntries(
          REFERRAL_STATUSES.map((status, i) => [status, results[i].count ?? 0]),
        ),
        payouts: payouts.count ?? 0,
      };
    }));

    res.json(incentives.map((row, i) => ({ ...row, ...tallies[i] })));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/incentives
 * Create a deal, always SWITCHED OFF. Turning it on is a separate, deliberate
 * action (PATCH { active: true }).
 *
 * Saving and launching used to be the same click, and that is the wrong shape
 * for something that spends money: a typo in the budget, or a program the
 * operator wanted to prepare for later, would go live the instant it was saved.
 * It also means creating a program can never collide with the
 * one-active-per-kind index, so the only place that 409 can arise is the
 * turn-on, where it is exactly the right question to be asked.
 */
router.post('/incentives', async (req, res, next) => {
  try {
    const v = validIncentive(req.body ?? {});
    if (v.error) return res.status(400).json({ error: 'BAD_REQUEST', message: v.error });

    const { data, error } = await supabaseAdmin
      .from('incentives')
      .insert({ ...v.row, active: false, created_by: req.user?.email ?? null })
      .select(INCENTIVE_COLS)
      .single();
    if (error) throw error;
    res.status(201).json({ ...data, referrals: { pending: 0, paid: 0, void: 0 }, payouts: 0 });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/admin/incentives/:id
 * Two shapes, deliberately separate: `{ active }` alone is the on/off switch,
 * and a full body is an edit. Mixing them would let a save quietly flip a
 * program live because the form happened to hold a stale checkbox.
 *
 * NOTE an edit changes what FUTURE referrals are worth. Live ones snapshot
 * their payout at attribution (referrals.friend_points / referrer_points), so
 * lowering a bonus never rewrites what a student was already promised.
 */
router.patch('/incentives/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Incentive not found.' });
    }
    const body = req.body ?? {};
    const onlyActive = Object.keys(body).length === 1 && typeof body.active === 'boolean';

    // The row's own kind, not the body's: kind is fixed at creation (changing it
    // would reinterpret every referral row already pointing here), and it is
    // what decides which config validator runs.
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('incentives')
      .select('kind')
      .eq('id', req.params.id)
      .maybeSingle();
    if (exErr) throw exErr;
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'Incentive not found.' });

    let patch;
    if (onlyActive) {
      patch = { active: body.active };
    } else {
      const v = validIncentive(body, { existingKind: existing.kind });
      if (v.error) return res.status(400).json({ error: 'BAD_REQUEST', message: v.error });
      const { kind, ...rest } = v.row;
      patch = rest;
      if (typeof body.active === 'boolean') patch.active = body.active;
    }

    const { data, error } = await supabaseAdmin
      .from('incentives')
      .update(patch)
      .eq('id', req.params.id)
      .select(INCENTIVE_COLS)
      .maybeSingle();
    if (error) {
      // The one-active-per-kind index. Reachable only on a turn-on, which is
      // where the question "you already have one running, which do you want?"
      // is exactly the right thing to be asked.
      if (error.code === '23505') {
        return res.status(409).json({
          error: 'INCENTIVE_ACTIVE_EXISTS',
          message: 'Another program of this type is already running. Turn that one off first.',
        });
      }
      throw error;
    }
    if (!data) return res.status(404).json({ error: 'NOT_FOUND', message: 'Incentive not found.' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/incentives/:id
 * Only ever allowed for a program that has never paid anything. Once points
 * have moved, the row is the record of why — deleting it would leave grants
 * pointing at nothing and a budget nobody can audit. A spent program is turned
 * off, not deleted, and the dashboard says so.
 */
router.delete('/incentives/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Incentive not found.' });
    }
    const { count, error: cErr } = await supabaseAdmin
      .from('community_grants')
      .select('id', { count: 'exact', head: true })
      .eq('incentive_id', req.params.id);
    if (cErr) throw cErr;
    if ((count ?? 0) > 0) {
      return res.status(409).json({
        error: 'INCENTIVE_HAS_PAYOUTS',
        message: 'This program has already paid points out, so it can’t be deleted. Turn it off instead.',
      });
    }

    const { data, error } = await supabaseAdmin
      .from('incentives')
      .delete()
      .eq('id', req.params.id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'NOT_FOUND', message: 'Incentive not found.' });
    res.json({ ok: true, id: data.id });
  } catch (err) {
    next(err);
  }
});

/* ---------- the two ledgers behind the Incentives tab ----------
   Both are logs that only ever grow, so both are paged the same way the roster
   is: one page per request, newest first, with an exact `total` so the dashboard
   can say how much it is NOT showing rather than leave the operator guessing
   whether the last row is the last row. */
const REFERRAL_PAGE = 50;
const REFERRAL_PAGE_MAX = 200;
const GRANT_PAGE = 50;
const GRANT_PAGE_MAX = 200;

/**
 * GET /api/admin/referrals?limit=&offset= — the newest referrals with both sides
 * named, one page at a time.
 * Two follow-up reads rather than an embedded join: referrals has two FKs to
 * profiles, so PostgREST can't tell which relationship an embed means without
 * naming the constraint, and naming it here would couple this route to a
 * constraint name the schema is free to change.
 */
router.get('/referrals', async (req, res, next) => {
  try {
    const page = pageParams(req.query, { def: REFERRAL_PAGE, max: REFERRAL_PAGE_MAX });
    const { limit, offset } = page;
    const { rows, total } = await pageOf((opts) => supabaseAdmin
      .from('referrals')
      .select(
        'id, referrer_id, friend_id, code, status, friend_points, referrer_points, qualified_at, paid_at, created_at',
        opts,
      )
      .order('created_at', { ascending: false }), page);
    if (!rows.length) return res.json({ referrals: [], total, offset, limit });

    const ids = [...new Set(rows.flatMap((r) => [r.referrer_id, r.friend_id]))];
    const { data: people, error: pErr } = await supabaseAdmin
      .from('profiles')
      .select('user_id, email, name')
      .in('user_id', ids);
    if (pErr) throw pErr;
    const who = new Map((people ?? []).map((p) => [p.user_id, p]));

    // Which friend bonuses actually landed. Derived from the ledger rather than
    // a flag, for the same reason the sweep is: the ledger is the money.
    const { data: paid, error: gErr } = await supabaseAdmin
      .from('community_grants')
      .select('ref_id')
      .eq('kind', 'referral_friend')
      .in('ref_id', rows.map((r) => r.id));
    if (gErr) throw gErr;
    const friendPaid = new Set((paid ?? []).map((g) => g.ref_id));

    res.json({
      referrals: rows.map((r) => ({
        id: r.id,
        code: r.code,
        status: r.status,
        referrer: who.get(r.referrer_id)?.email ?? '(deleted)',
        friend: who.get(r.friend_id)?.email ?? '(deleted)',
        friendPoints: r.friend_points,
        referrerPoints: r.referrer_points,
        friendPaid: friendPaid.has(r.id),
        qualifiedAt: r.qualified_at,
        paidAt: r.paid_at,
        createdAt: r.created_at,
      })),
      total,
      offset,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/referrals/settle
 * Run a sweep now instead of waiting for the timer. Purely a convenience: the
 * worker does this on its own every REFERRAL_SWEEP_SECONDS, and the sweep is
 * idempotent, so pressing this twice is harmless.
 */
router.post('/referrals/settle', async (req, res, next) => {
  try {
    res.json(await runReferralSweep(200));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/grants?limit=&offset= — the community-point payout log, newest
 * first, one page at a time.
 * This is the answer to "where did these points come from", so it is deliberately
 * the raw ledger rather than a per-student rollup.
 */
router.get('/grants', async (req, res, next) => {
  try {
    const page = pageParams(req.query, { def: GRANT_PAGE, max: GRANT_PAGE_MAX });
    const { limit, offset } = page;
    const { rows, total } = await pageOf((opts) => supabaseAdmin
      .from('community_grants')
      .select('id, user_id, points, kind, reason, granted_by, created_at', opts)
      .order('created_at', { ascending: false }), page);
    if (!rows.length) return res.json({ grants: [], total, offset, limit });

    // user_id is null for grants whose student has since deleted their account
    // (ON DELETE SET NULL — the row outlives them so the budget still adds up).
    const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    const who = new Map();
    if (ids.length) {
      const { data: people, error: pErr } = await supabaseAdmin
        .from('profiles')
        .select('user_id, email')
        .in('user_id', ids);
      if (pErr) throw pErr;
      for (const p of people ?? []) who.set(p.user_id, p.email);
    }

    res.json({
      grants: rows.map((r) => ({
        id: r.id,
        points: r.points,
        kind: r.kind,
        reason: r.reason,
        grantedBy: r.granted_by,
        student: r.user_id ? (who.get(r.user_id) ?? '(unknown)') : '(deleted account)',
        createdAt: r.created_at,
      })),
      total,
      offset,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/grants  { email, points, reason }
 * Hand community points to one student by hand — the "sorry about that" button,
 * and the manual fallback for any incentive that hasn't been automated yet.
 * Looked up by email because that is what an operator has in front of them; the
 * RPC is what actually moves the points, so the migration-025 guard, the ledger
 * row and the ceiling all apply exactly as they do to an automated payout.
 */
router.post('/grants', async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const points = Number(req.body?.points);
    const reason = String(req.body?.reason ?? '').trim().slice(0, 200);

    if (!EMAIL_RE.test(email) || email.length > EMAIL_MAX) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Enter the student’s email address.' });
    }
    if (!Number.isInteger(points) || points < 1 || points > 100_000) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Points must be a whole number from 1 to 100,000.' });
    }
    if (!reason) {
      // Not bureaucracy: an unexplained grant is indistinguishable from a
      // mistake or an abuse when someone reads this log in three months.
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Say what this grant is for.' });
    }

    // EXACT MATCH, and .limit(1) rather than .maybeSingle() — the same shape as
    // findAccountByEmail in src/lib/ambassadors.js, for the same two reasons.
    // A SECOND LOOKUP RUNS ONLY ON A MISS, and it is a repair rather than a
    // nicety: see the auth_user_id_by_email fallback below.
    //
    // This used to be .ilike('email', email), which is a LIKE pattern, not a
    // case-insensitive equals: postgrest-js appends whatever was typed verbatim,
    // there is no LIKE-escaping helper anywhere in this repo, and `_` and `%` are
    // wildcards that the loose EMAIL_RE above happily admits. On a money path
    // with no reversal (grant_community_points appends to the ledger; nothing
    // takes points back) that is the worst possible matcher. A real address like
    // j_smith@school.edu 500'd with PGRST116 whenever j.smith@school.edu also
    // existed — and, far worse, an address that does NOT exist could match a
    // student who is one character different and silently credit them instead.
    // The address is already lower-cased above, and profiles.email is written
    // from auth.users.email in both places anything writes it — handle_new_user
    // (the on_auth_user_created trigger, migration 00000000000001_schema.sql) and
    // the terms upsert in src/routes/student.js, whose `email` is req.user.email —
    // and GoTrue stores that lower-cased. So .eq matches every row this app has
    // written itself.
    //
    // ⚠ BUT .eq IS CASE-SENSITIVE AND profiles.email CARRIES NO LOWER-CASE
    // CONSTRAINT. migration-053 says outright that profiles.email is neither
    // unique nor not-null, and the `check (email = lower(email))` in that same
    // migration is on ambassadors, not here. So "every row this app has written"
    // is an argument about code, not a guarantee from the schema: one legacy,
    // imported or hand-edited 'Jane.Smith@school.edu' and the operator gets
    // "No student account with that email" for an account that plainly exists —
    // which is what swapping .ilike for .eq cost, and is not a trade this route
    // has to make. The fallback below buys the case-insensitivity back without
    // buying the wildcards back with it.
    //
    // ⚠ profiles.email IS NOT UNIQUE (see findAccountByEmail): auth.users.email
    // is what enforces one account per address, so in practice this matches at
    // most one row. limit(1) is here because "in practice" is not a constraint,
    // and a duplicate must not turn a hand-typed grant into a 500.
    const { data: matches, error: pErr } = await supabaseAdmin
      .from('profiles')
      .select('user_id, email')
      .eq('email', email)
      .limit(1);
    if (pErr) throw pErr;
    let profile = matches?.[0] ?? null;

    // CASE-INSENSITIVE SECOND ATTEMPT, VIA SQL, NEVER VIA A PATTERN.
    // auth_user_id_by_email (migration-035 §5) is `select id from auth.users
    // where lower(email) = lower(trim(p_email)) limit 1` in a security-definer
    // function granted to service_role alone. That is an equality on a
    // lower()'d column, so:
    //
    //   * it is case-insensitive in the one direction that matters — the stored
    //     address — where lower-casing the INPUT (done above) cannot help; and
    //   * `_`, `%` and `*` have NO meaning in it. The old .ilike('email', email)
    //     appended the operator's typing as a LIKE pattern, and the loose
    //     EMAIL_RE above admits both wildcards, so a typed j_smith@psu.edu could
    //     match j.smith@psu.edu and silently credit a student one character away
    //     from the intended one. On grant_community_points, which only ever
    //     appends to the ledger, that is irreversible. Escaping the pattern
    //     instead was the alternative and was rejected: this repo has no
    //     LIKE-escaping helper, PostgREST's own `*`→`%` rewrite would have to be
    //     escaped around as well, and the result is only ever testable against a
    //     live PostgREST — whereas lower() = lower() is a documented equality
    //     that already has three other callers in this app (src/lib/
    //     student-email.js, src/lib/terminal-admin.js, onboardVendor above).
    //
    // auth.users is also the authoritative copy of the address, and it is unique
    // there, so this cannot widen into "several students matched": it returns one
    // id or null. The profiles row is then fetched BY user_id — the grant needs
    // profiles to exist anyway (the response quotes profile.email back at the
    // operator, and an account with no profiles row is not a student account),
    // so an operator/vendor-only login still gets the same 404 it gets today.
    if (!profile) {
      const { data: authId, error: authErr } = await supabaseAdmin
        .rpc('auth_user_id_by_email', { p_email: email });
      if (authErr) throw authErr;
      if (authId) {
        const { data: byId, error: idErr } = await supabaseAdmin
          .from('profiles')
          .select('user_id, email')
          .eq('user_id', authId)
          .limit(1);
        if (idErr) throw idErr;
        profile = byId?.[0] ?? null;
      }
    }

    if (!profile) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'No student account with that email.' });
    }

    const { data, error } = await supabaseAdmin.rpc('grant_community_points', {
      p_user_id: profile.user_id,
      p_points: points,
      p_kind: 'manual',
      p_reason: reason,
      p_incentive_id: null,
      p_ref_id: null,
      p_granted_by: req.user?.email ?? 'admin',
    });
    if (error) throw error;

    // Same event the award and transfer paths push, so an open student tab's
    // community counter moves the moment an operator presses Give.
    const newBalance = data?.[0]?.new_balance ?? 0;
    emitBalance(profile.user_id, { community: newBalance });

    // `student` is the address the points landed on, echoed back so the operator
    // can see WHICH row matched — it is the stored spelling, which after the
    // case-insensitive fallback above may differ in case from what they typed.
    // profiles.email is nullable (migration-053), and a row reached through that
    // fallback can have none, so the typed address stands in rather than letting
    // public/admin/admin.js print "gave 5 points to null".
    res.status(201).json({ ok: true, student: profile.email ?? email, points, newBalance });
  } catch (err) {
    next(err);
  }
});

/* ---------- the "scan here" QR poster ---------- */
// One file, uploaded here and downloaded by every vendor terminal from its
// Settings tab (GET /api/vendor/qr-poster). See src/lib/qr-poster.js for why it
// lives in a private Supabase Storage bucket and not in a table.

/** GET /api/admin/qr-poster — what vendors would download right now, if anything. */
router.get('/qr-poster', async (req, res, next) => {
  try {
    const poster = await getPoster();
    res.json({ poster, maxBytes: POSTER_MAX_BYTES, extensions: POSTER_EXTENSIONS });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/qr-poster  { filename, data }
 * Replace the poster. `data` is the file base64-encoded (bare or as a data: URL)
 * — this API takes JSON bodies only, and server.js mounts a larger parser for
 * this one path. Whatever was there before is deleted once the new file lands.
 */
router.put('/qr-poster', async (req, res, next) => {
  try {
    const file = decodePosterBody(req.body);
    if (file.error) return res.status(400).json({ error: 'BAD_FILE', message: file.error });

    const poster = await putPoster(file);
    res.json({ ok: true, poster });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/qr-poster/file
 * The same bytes a terminal gets, so the operator can check what they published
 * without signing into a vendor account. Streamed through the server; the bucket
 * is private and stays that way.
 */
router.get('/qr-poster/file', async (req, res, next) => {
  try {
    const poster = await readPoster();
    if (!poster) {
      return res.status(404).json({ error: 'NO_POSTER', message: 'No QR poster has been published yet.' });
    }
    res.set('Content-Type', poster.contentType);
    res.set('Content-Disposition', `attachment; filename="${poster.name}"`);
    res.set('Content-Length', String(poster.bytes.length));
    res.send(poster.bytes);
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/admin/qr-poster — take the download away from terminals. */
router.delete('/qr-poster', async (req, res, next) => {
  try {
    const removed = await deletePoster();
    res.json({ ok: true, removed });
  } catch (err) {
    next(err);
  }
});

/* ---------- web-push subscriptions (new-application alerts) ---------- */

/**
 * GET /api/admin/push/public-key
 * The VAPID public key the dashboard needs to subscribe this browser to push.
 * null when the server has no keys configured — the UI hides the enable button.
 */
router.get('/push/public-key', (req, res) => {
  res.json({ publicKey: getVapidPublicKey() });
});

/**
 * POST /api/admin/push/subscribe  { endpoint, keys: { p256dh, auth } }
 * Store (or refresh) this browser's push subscription. Upserted on endpoint, so
 * the dashboard can safely re-post on every load without piling up duplicates.
 */
router.post('/push/subscribe', async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const endpoint = typeof b.endpoint === 'string' ? b.endpoint : '';
    const p256dh = typeof b.keys?.p256dh === 'string' ? b.keys.p256dh : '';
    const auth = typeof b.keys?.auth === 'string' ? b.keys.auth : '';
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth
        || p256dh.length > 300 || auth.length > 100) {
      return res.status(400).json({ error: 'BAD_SUBSCRIPTION', message: 'That push subscription looks invalid.' });
    }
    // device_label ("Windows Chrome") is what the notification log shows for
    // each device instead of the endpoint (migration-062). On a database
    // without the column the upsert is retried without it: turning alerts on
    // must keep working before the operator has pasted 062.
    const row = { endpoint, p256dh, auth, user_id: req.user.id, role: 'admin' };
    const upsert = (r) => supabaseAdmin.from('push_subscriptions').upsert(r, { onConflict: 'endpoint' });
    let { error } = await upsert({ ...row, device_label: deviceLabelFromUA(req.get('user-agent')) });
    if (error && isMissingColumn(error, 'device_label')) ({ error } = await upsert(row));
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/push/test  { endpoint } - verify this browser end to end. */
router.post('/push/test', async (req, res, next) => {
  try {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) {
      return res.status(400).json({ error: 'BAD_SUBSCRIPTION', message: 'That push subscription looks invalid.' });
    }

    const delivered = await notifyAdminEndpoint(req.user.id, endpoint, {
      title: 'WeRewards alerts are working',
      body: 'You will be notified about every vendor application and logged error.',
      url: '/admin/',
    });
    if (!delivered) {
      return res.status(502).json({
        error: 'PUSH_NOT_DELIVERED',
        message: 'The push service did not accept the test. Turn alerts on again and retry.',
      });
    }
    res.json({ ok: true, delivered });
  } catch (err) {
    next(err);
  }
});

/* ---------- broadcasts: one operator message to students (migration-061) ----------

   The only path in this product by which WeRewards itself addresses students.
   Everything else is composed by a vendor, by proximity, or by the absence of
   activity. That makes it the most dangerous button in /admin, and the limits
   below are the whole reason it is safe to have:

     • Nothing is delivered here. create_admin_broadcast writes recipient rows
       and returns; delivery is src/lib/broadcasts.js draining that queue. A
       request cannot hold a few thousand sequential pushes open, and a dyno
       restart mid-send must not lose the back half.
     • Nothing escapes the shared budget. The claim spends the same
       student_notify_state counters deal alerts, nearby alerts and reminders
       spend, so a broadcast costs a deal-alert slot and obeys quiet hours.
       Privacy Policy §7.4 promises "two per day… whatever the reason", and our
       own reasons are reasons.
     • The operator never learns who is in an audience. /reach answers a COUNT,
       the same shape the vendor composer's own reach endpoint uses — a list of
       names would be a disclosure we have no reason to make.
*/

const BROADCAST_TITLE_MAX = 60;    // what a notification shade actually shows
const BROADCAST_BODY_MAX = 140;    // matches CAMPAIGN_BODY_MAX; same shade, same room
const BROADCAST_AUDIENCES = new Set(['all', 'lapsed', 'spendable', 'vendor']);
const BROADCAST_PAGE = 20;         // recent broadcasts listed under the composer

/**
 * Where tapping the notification lands. Same-origin paths only, and deliberately
 * strict rather than clever: an operator typing a full https:// URL here would
 * produce a notification that walks the student out of the PWA (and, inside the
 * Capacitor iOS wrapper, out of the app), while a protocol-relative '//evil.com'
 * is a redirect wearing a path's clothes. One leading slash, no second one.
 */
export function broadcastUrl(raw) {
  const v = String(raw ?? '').trim();
  // One shape on every path: { url } or { error }, never a bare null. The field
  // is optional, so "nothing typed" is a legitimate answer rather than a
  // refusal, and it is expressed as a null URL rather than by returning a
  // different type the caller has to remember to narrow.
  if (!v) return { url: null };
  if (!v.startsWith('/') || v.startsWith('//')) return { error: 'Use a path that starts with a single /, like /?deals=1' };
  if (v.length > 200) return { error: 'That link is too long.' };
  return { url: v };
}

/**
 * GET /api/admin/broadcasts/reach?audience=&vendorId=
 * How many students that audience currently matches. A COUNT, never identities.
 *
 * Advisory on purpose, and the UI says so: this is the audience size, not the
 * number who will be reached. Reachability (a live subscription, deal alerts on)
 * and every student's own frequency budget are decided later, at claim time.
 */
router.get('/broadcasts/reach', async (req, res, next) => {
  try {
    const audience = String(queryScalar(req.query?.audience) ?? 'all');
    const vendorId = queryScalar(req.query?.vendorId) ?? null;
    if (!BROADCAST_AUDIENCES.has(audience)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Pick a valid audience.' });
    }
    if (audience === 'vendor' && !isUuid(vendorId)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Pick which spot’s customers to message.' });
    }

    const { data, error } = await supabaseAdmin.rpc('admin_broadcast_audience', {
      p_audience: audience,
      p_vendor_id: audience === 'vendor' ? vendorId : null,
    });
    if (error) throw error;
    res.json({ audience, reach: Array.isArray(data) ? data.length : 0 });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/broadcasts
 * The last few broadcasts, newest first, with how they are getting on.
 */
router.get('/broadcasts', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('admin_broadcasts')
      .select('id, title, body, url, audience, vendor_id, status, queued_count, sent_count, expires_at, created_at')
      .order('created_at', { ascending: false })
      .limit(BROADCAST_PAGE);
    if (error) throw error;

    // Spot names for the 'vendor' rows, resolved in one read rather than per row.
    const ids = [...new Set((data ?? []).map((b) => b.vendor_id).filter(Boolean))];
    const names = new Map();
    if (ids.length) {
      const { data: vs } = await supabaseAdmin.from('vendors').select('id, name').in('id', ids);
      (vs ?? []).forEach((v) => names.set(v.id, v.name));
    }

    res.json({
      broadcasts: (data ?? []).map((b) => ({
        id: b.id,
        title: b.title,
        body: b.body,
        url: b.url,
        audience: b.audience,
        vendorName: b.vendor_id ? (names.get(b.vendor_id) ?? null) : null,
        status: b.status,
        queued: b.queued_count,
        sent: b.sent_count,
        expiresAt: b.expires_at,
        createdAt: b.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/broadcasts  { title, body, url?, audience, vendorId?, requestId? }
 *
 * Queues one. `requestId` is the double-tap guard, the same mechanism and the
 * same shape the vendor deal composer uses: a repeated token returns the FIRST
 * broadcast rather than queueing the student body twice, so a retried request is
 * indistinguishable from the original.
 */
router.post('/broadcasts', async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const title = String(b.title ?? '').trim();
    const body = String(b.body ?? '').trim();
    const audience = String(b.audience ?? 'all');
    const vendorId = b.vendorId ?? null;

    if (!title || title.length > BROADCAST_TITLE_MAX) {
      return res.status(400).json({ error: 'BAD_BROADCAST', message: `Give it a headline (up to ${BROADCAST_TITLE_MAX} characters).` });
    }
    if (!body || body.length > BROADCAST_BODY_MAX) {
      return res.status(400).json({ error: 'BAD_BROADCAST', message: `Write the message (up to ${BROADCAST_BODY_MAX} characters).` });
    }
    if (!BROADCAST_AUDIENCES.has(audience)) {
      return res.status(400).json({ error: 'BAD_BROADCAST', message: 'Pick a valid audience.' });
    }
    if (audience === 'vendor' && !isUuid(vendorId)) {
      return res.status(400).json({ error: 'BAD_BROADCAST', message: 'Pick which spot’s customers to message.' });
    }
    // No em dash, because the repo copy rule applies to everything a student
    // reads and this is the one place an operator types it by hand. Refused
    // rather than silently rewritten: the operator should see their own words.
    if (title.includes('—') || body.includes('—')) {
      return res.status(400).json({ error: 'BAD_BROADCAST', message: 'Use a comma or a full stop instead of an em dash (house copy rule).' });
    }

    const link = broadcastUrl(b.url);
    if (link?.error) return res.status(400).json({ error: 'BAD_BROADCAST', message: link.error });

    const clientToken = (typeof b.requestId === 'string' && /^[\w-]{8,64}$/.test(b.requestId)) ? b.requestId : null;

    const { data, error } = await supabaseAdmin.rpc('create_admin_broadcast', {
      p_created_by: req.user.id,
      p_title: title,
      p_body: body,
      p_url: link?.url ?? null,
      p_audience: audience,
      p_vendor_id: audience === 'vendor' ? vendorId : null,
      p_client_token: clientToken,
    });
    if (error) throw error;

    // The RPC returns a one-row set, which supabase-js hands back as an array.
    const row = Array.isArray(data) ? data[0] : data;
    res.status(201).json({ id: row?.out_id ?? null, queued: Number(row?.out_queued ?? 0) });
  } catch (err) {
    // The RPC's own refusals, turned into sentences for the operator rather than
    // a 500. Anything unrecognised still goes to the error handler.
    const m = String(err?.message ?? '');
    if (m.includes('BAD_AUDIENCE')) return res.status(400).json({ error: 'BAD_BROADCAST', message: 'Pick a valid audience.' });
    if (m.includes('VENDOR_REQUIRED')) return res.status(400).json({ error: 'BAD_BROADCAST', message: 'Pick which spot’s customers to message.' });
    if (m.includes('TITLE_REQUIRED') || m.includes('BODY_REQUIRED')) {
      return res.status(400).json({ error: 'BAD_BROADCAST', message: 'Write a headline and a message.' });
    }
    if (m.includes('admin_broadcast') || m.includes('create_admin_broadcast')) {
      return res.status(503).json({ error: 'BROADCAST_UNAVAILABLE', message: 'Broadcasts need migration-061 applied to the database.' });
    }
    next(err);
  }
});

/**
 * POST /api/admin/broadcasts/:id/cancel
 * Stop one that is still going out. Already-delivered pushes are gone — a
 * notification cannot be recalled — so this only prevents the remainder, and the
 * UI says exactly that rather than implying an undo.
 */
router.post('/broadcasts/:id/cancel', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Unknown broadcast.' });
    const { data, error } = await supabaseAdmin
      .from('admin_broadcasts')
      .update({ status: 'cancelled' })
      .eq('id', req.params.id)
      .eq('status', 'queued')
      .select('id, sent_count')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'NOT_CANCELLABLE', message: 'That broadcast has already finished or been cancelled.' });
    res.json({ ok: true, alreadySent: data.sent_count });
  } catch (err) {
    next(err);
  }
});

/* ---------- notifications: the send log and the queue (migration-062) ----------

   Two questions the operator could not answer before this: "did that student
   actually get anything?" (the LOG, one notification_log row per push or email
   attempt) and "is anything waiting to go out, and why is it waiting?" (the
   QUEUE, computed live by the read-only admin_*_queue functions). Both are view
   only. Nothing under /notifications writes, claims or sends; the reminder
   preview runs the worker's composer without its claim.

   Every route here has to keep answering on a database that is missing
   migrations, because code ships before the operator pastes the SQL and prod
   carries a backlog. A missing table, column or function is answered 200 with
   `unavailable: 'migration-0NN'` naming WHICH paste is missing, rather than a
   500: a 500 here files an error_logs row, which pushes an alert to every
   operator device, about a screen whose only problem is a known pending step.
   Anything else still reaches next(err), because that one is a real fault.

   The sub-router is mounted on `router` BELOW router.use(requireAdmin), which
   is its only gate. It is exported for test/admin-notifications.test.js and
   must never be mounted anywhere else. */

const NOTIF_PAGE = 50;
const NOTIF_PAGE_MAX = 200;
const NOTIF_STUDENT_RECENT = 20;
// Profiles a log search may expand into. A search term that matches more
// students than this is too vague to be a lookup, and every id rides in the
// URL of the log query that follows.
const NOTIF_Q_PROFILE_CAP = 200;
const QUEUE_DEALS_LIMIT = 100;
const QUEUE_BROADCASTS_LIMIT = 100;
// Reminder candidates are fetched four pages deep and the ones time WILL
// release are listed first. The function ranks by staleness, so its top rows
// are mostly students who will never be reminded (opted out, no device), and
// a plain top-50 buried the few that will go next behind them.
const QUEUE_REMINDERS_FETCH = 200;
const QUEUE_REMINDERS_SHOWN = 50;
// One student's own queued rows (the functions filter by p_user_id before
// their limit). Far above what a student realistically has queued.
const QUEUE_STUDENT_LIMIT = 200;
// Ids per .in() read when resolving names. Each uuid is 37 characters of URL;
// a 600-id list is a 22KB request line, and the gateway in front of PostgREST
// is not obliged to accept that. A page usually fits in one chunk.
const NAME_CHUNK = 100;
const QUEUE_ACTIVE = ['queued', 'sending'];

const NOTIF_CHANNELS = new Set(['push', 'email']);
const NOTIF_OUTCOMES = new Set(['sent', 'failed', 'refused', 'allowed']);
const NOTIF_RECIPIENTS = new Set(['student', 'vendor', 'applicant', 'admin', 'other']);
const NOTIF_RANGES = new Set(['today', '7d', '30d']);

const NOTIF_SUMMARY_COLS = 'id, created_at, channel, kind, outcome, reason, recipient_kind, student_id, '
  + 'recipient_email, recipient_label, vendor_id, title, devices_tried, devices_accepted, delivery_status, source';
const NOTIF_DETAIL_COLS = `${NOTIF_SUMMARY_COLS}, body, url, template, ref, devices, provider_id, delivery_at, dedupe_key`;

// Postgres and PostgREST's ways of saying "that object is not in this
// database": relation, column, function (by name, or by PostgREST's schema
// cache), and PostgREST's cache misses for a column or a table.
const MISSING_OBJECT_CODES = new Set(['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205']);
const MISSING_FUNCTION_CODES = new Set(['42883', 'PGRST202']);

/** True when `err` means a table, column or function does not exist (yet). */
export function isMissingObject(err) {
  return Boolean(err && MISSING_OBJECT_CODES.has(err.code));
}

/**
 * Which migration a missing-object error points at, or null for any other
 * error. A missing FUNCTION is always migration-062's (every function these
 * routes call is created there). A missing table or column inside one of those
 * functions is the prerequisite it reads: 061's broadcast tables, 060's
 * reminder column, 047's email reach. For a plain table read, the caller names
 * the table's own migration as the prerequisite.
 */
export function unavailableFor(err, prerequisite) {
  if (!isMissingObject(err)) return null;
  return MISSING_FUNCTION_CODES.has(err.code) ? 'migration-062' : prerequisite;
}

/**
 * The column an insert or select named is not there (pre-migration DB). Both
 * halves are required: the code alone would also match a different missing
 * column, and the name alone would match any other fault that mentions it
 * (a constraint on that column, say), which the caller's retry without the
 * column would then quietly paper over.
 */
function isMissingColumn(err, column) {
  if (!err || (err.code !== '42703' && err.code !== 'PGRST204')) return false;
  return typeof err.message === 'string' && err.message.includes(column);
}

/* ----- campus-local time, for "today" and the quiet-hours banner ----- */

/** A timezone Intl accepts, else UTC: a bad env value must not 500 the log. */
function safeTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute, second: p.second };
}

/**
 * The instant a local wall-clock time names in `timeZone`. Two correction
 * passes because the offset at the first guess can differ from the offset at
 * the answer when a DST change falls between them.
 */
function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let i = 0; i < 2; i += 1) {
    const p = zonedParts(new Date(guess), timeZone);
    const diff = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - target;
    if (!diff) break;
    guess -= diff;
  }
  return new Date(guess);
}

/** Start of the campus-local day containing `now`, as a Date. */
export function localMidnight(now, timeZone) {
  const tz = safeTimezone(timeZone);
  const p = zonedParts(now, tz);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day }, tz);
}

/**
 * Whether `now` is inside the campus quiet window, and when it ends. Same
 * window semantics as the claim functions: [start, end) in local hours,
 * start === end disables it, start > end wraps midnight.
 */
export function quietHoursAt(now, { quietStart, quietEnd, timezone }) {
  const tz = safeTimezone(timezone);
  const start = Number(quietStart);
  const end = Number(quietEnd);
  const out = { active: false, endsAt: null, start, end, timezone: tz };
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return out;
  const p = zonedParts(now, tz);
  const h = p.hour;
  const active = start < end ? (h >= start && h < end) : (h >= start || h < end);
  if (!active) return out;
  // The next local `end`:00. Before it today means today; otherwise tomorrow
  // (Date.UTC normalises day + 1 across month and year ends).
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day + (h < end ? 0 : 1)));
  const endsAt = zonedTimeToUtc({
    year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: end,
  }, tz);
  return { ...out, active: true, endsAt: endsAt.toISOString() };
}

/* ----- shaping ----- */

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>]+/gi;

/**
 * DeviceResult[] as stored, cut back to its seven documented keys. The writer
 * already never stores an endpoint, but a push service's error text is free
 * text from a third party and can quote the URL it was sent to; the endpoint is
 * a capability (anyone holding it can push to that phone), so any URL in the
 * error is blanked here too.
 */
function cleanDevices(devices) {
  if (!Array.isArray(devices)) return [];
  return devices.filter((d) => d && typeof d === 'object').map((d) => ({
    subId: typeof d.subId === 'string' ? d.subId : null,
    service: typeof d.service === 'string' ? d.service : 'other',
    label: typeof d.label === 'string' ? d.label : null,
    ok: d.ok === true,
    status: Number.isFinite(d.status) ? d.status : null,
    pruned: d.pruned === true,
    error: typeof d.error === 'string' ? d.error.replace(URL_IN_TEXT, '[url]') : null,
  }));
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Names for a response: one profiles read and one vendors read per response
 * (chunked only past NAME_CHUNK ids), never one per row.
 *
 * Fail-soft on purpose. Names decorate rows that already carry a recipient
 * label and email snapshot; a profiles hiccup should cost the operator the
 * pretty names, not the whole log.
 */
async function resolveNames(studentIds, vendorIds) {
  const profiles = new Map();
  const vendors = new Map();
  const sIds = [...new Set(studentIds.filter(isUuid))];
  const vIds = [...new Set(vendorIds.filter(isUuid))];
  const reads = [
    ...chunks(sIds, NAME_CHUNK).map((ids) => supabaseAdmin.from('profiles').select('user_id, name, email').in('user_id', ids)
      .then(({ data, error }) => {
        if (error) throw error;
        (data ?? []).forEach((p) => profiles.set(p.user_id, { name: p.name ?? null, email: p.email ?? null }));
      })),
    ...chunks(vIds, NAME_CHUNK).map((ids) => supabaseAdmin.from('vendors').select('id, name').in('id', ids)
      .then(({ data, error }) => {
        if (error) throw error;
        (data ?? []).forEach((v) => vendors.set(v.id, v.name ?? null));
      })),
  ];
  const results = await Promise.allSettled(reads);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) console.warn(`[admin] notification names unavailable: ${failed.reason?.message ?? failed.reason}`);
  return { profiles, vendors };
}

/**
 * One notification_log row as the list shows it.
 *
 * A student is named from their CURRENT profile (the row's label is only a
 * snapshot). For an email row the address shown is the one the row records,
 * because that is where the message actually went; a student who has since
 * changed their address would otherwise appear to have been mailed somewhere
 * they never were.
 */
export function notifSummary(row, names = { profiles: new Map(), vendors: new Map() }) {
  const p = row.student_id ? names.profiles.get(row.student_id) : null;
  const emailRow = row.channel === 'email' && row.recipient_email;
  return {
    id: row.id,
    createdAt: row.created_at,
    channel: row.channel,
    kind: row.kind,
    outcome: row.outcome,
    reason: row.reason ?? null,
    recipientKind: row.recipient_kind,
    studentId: row.student_id ?? null,
    recipientName: p?.name ?? row.recipient_label ?? null,
    recipientEmail: emailRow ? row.recipient_email : (p?.email ?? row.recipient_email ?? null),
    vendorId: row.vendor_id ?? null,
    vendorName: row.vendor_id ? (names.vendors.get(row.vendor_id) ?? null) : null,
    title: row.title ?? null,
    devicesTried: Number(row.devices_tried ?? 0),
    devicesAccepted: Number(row.devices_accepted ?? 0),
    deliveryStatus: row.delivery_status ?? null,
    source: row.source ?? 'live',
  };
}

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * `s` itself when it is a full ISO-8601 instant with a zone, else null.
 *
 * Returned verbatim, never re-serialised. The `after` cursor is the newest
 * row's own created_at, which PostgREST prints to the microsecond
 * ('...12:00:00.123456+00:00'); a trip through Date keeps milliseconds only,
 * the row's .123456 then sorts after the cursor's .123, and the "N new" poll
 * counts a row the operator already has on every tick, forever.
 *
 * The calendar check is there because Date.parse rolls Feb 30 over into
 * March, while Postgres refuses it with an error that would 500 the log.
 */
function isoInstant(s) {
  const m = typeof s === 'string' ? ISO_INSTANT.exec(s) : null;
  if (!m || !Number.isFinite(Date.parse(s))) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number);
  const oh = Number(m[7] ?? 0);
  const om = Number(m[8] ?? 0);
  const monthDays = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > monthDays || h > 23 || mi > 59 || sec > 59 || oh > 15 || om > 59) return null;
  return s;
}

/**
 * The log's query-string filters, validated. An unknown value is DROPPED
 * rather than 400ed (same stance as pageParams: a junk filter is a UI bug, and
 * answering with the unfiltered list keeps the operator looking at data). The
 * one exception is `student`: dropping a junk id would answer with EVERY
 * student's rows under a heading that names one, so it is reported back as
 * `impossible` and the route answers an empty page.
 */
export function notifFilters(query, now = new Date(), timeZone = CAMPAIGN_CONFIG.timezone) {
  const q = query ?? {};
  const str = (k) => {
    const v = queryScalar(q[k]);
    return typeof v === 'string' ? v.trim() : '';
  };
  const f = { channel: null, kind: null, outcome: null, recipient: null, since: null, after: null, student: null, q: '', impossible: false };
  if (NOTIF_CHANNELS.has(str('channel'))) f.channel = str('channel');
  if (NOTIFICATION_KINDS.includes(str('kind'))) f.kind = str('kind');
  if (NOTIF_OUTCOMES.has(str('outcome'))) f.outcome = str('outcome');
  if (NOTIF_RECIPIENTS.has(str('recipient'))) f.recipient = str('recipient');
  const range = str('range');
  if (NOTIF_RANGES.has(range)) {
    f.since = range === 'today'
      ? localMidnight(now, timeZone).toISOString()
      : new Date(now.getTime() - (range === '7d' ? 7 : 30) * DAY).toISOString();
  }
  f.after = isoInstant(str('after'));
  const student = str('student');
  if (student) {
    if (isUuid(student)) f.student = student;
    else f.impossible = true;
  }
  f.q = safeSearch(q.q);
  return f;
}

/** A fresh, unranged log query for pageOf (which may build it twice). */
function notifLogQuery(opts, f, matchedStudentIds = []) {
  let qb = supabaseAdmin.from('notification_log').select(NOTIF_SUMMARY_COLS, opts);
  if (f.channel) qb = qb.eq('channel', f.channel);
  if (f.kind) qb = qb.eq('kind', f.kind);
  if (f.outcome) qb = qb.eq('outcome', f.outcome);
  if (f.recipient) qb = qb.eq('recipient_kind', f.recipient);
  if (f.student) qb = qb.eq('student_id', f.student);
  if (f.since) qb = qb.gte('created_at', f.since);
  if (f.after) qb = qb.gt('created_at', f.after);
  if (f.q) {
    const terms = [
      `recipient_email.ilike.*${f.q}*`,
      `recipient_label.ilike.*${f.q}*`,
      `title.ilike.*${f.q}*`,
    ];
    if (matchedStudentIds.length) terms.push(`student_id.in.(${matchedStudentIds.join(',')})`);
    qb = qb.or(terms.join(','));
  }
  return qb.order('created_at', { ascending: false }).order('id', { ascending: false });
}

/**
 * One queue function, mapped to a section result. Missing objects become
 * `unavailable` for this section only, so a database without 061 still shows
 * the deal and reminder queues. Any other error is thrown: that is a fault in
 * the function, and hiding it behind "not applied" would send the operator off
 * to paste SQL that is already there.
 */
async function runQueueRpc(fn, params, prerequisite) {
  const { data, error } = await supabaseAdmin.rpc(fn, params);
  if (error) {
    const unavailable = unavailableFor(error, prerequisite);
    if (unavailable) return { available: false, unavailable, data: [] };
    throw error;
  }
  return { available: true, data: Array.isArray(data) ? data : [] };
}

/** Parameters every queue function shares, from the worker's own config. */
function queueParams(now) {
  const c = CAMPAIGN_CONFIG;
  return {
    p_cooldown_minutes: c.cooldownMinutes,
    p_daily_cap: c.dailyCap,
    p_weekly_cap: c.weeklyCap,
    p_quiet_start: c.quietStart,
    p_quiet_end: c.quietEnd,
    p_timezone: safeTimezone(c.timezone),
    p_now: now.toISOString(),
  };
}

/**
 * The gate values the queue was computed with, for the blocker copy ("4h
 * cooldown", "Same spot in last 20h"). Sent rather than hard-coded in the
 * page, because each one is an env var and copy that disagrees with the gate
 * that actually ran sends the operator after the wrong cause.
 */
function notifyConfig() {
  const c = CAMPAIGN_CONFIG;
  return {
    cooldownMinutes: c.cooldownMinutes,
    dailyCap: c.dailyCap,
    weeklyCap: c.weeklyCap,
    vendorCooldownHours: c.vendorCooldownHours,
    minIntervalHours: REMINDER_CONFIG.minIntervalHours,
    quietStart: c.quietStart,
    quietEnd: c.quietEnd,
    timezone: safeTimezone(c.timezone),
  };
}

const latest = (a, b) => (!a ? b : !b ? a : (Date.parse(a) >= Date.parse(b) ? a : b));

/**
 * One queue function row as a QueueRow, plus the two blockers only this
 * process can know: `app_open` (every worker passes over a student whose app
 * is in the foreground, see visibleUserIds) and `backoff` (the broadcast and
 * reminder workers skip a student for a while after a failed send). Neither is
 * visible to SQL, and without them a row would read "nothing blocking" while
 * the worker skips it every tick.
 */
export function queueRow(source, r, index, { names, visible, backoff }) {
  const studentId = r.user_id ?? null;
  const p = studentId ? names.profiles.get(studentId) : null;
  const blockers = Array.isArray(r.blockers) ? [...r.blockers] : [];
  let nextEligibleAt = r.next_eligible_at ?? null;
  if (studentId && visible.has(studentId) && !blockers.includes('app_open')) blockers.push('app_open');
  const until = studentId && source !== 'deal' ? backoff.get(studentId) : null;
  if (until) {
    if (!blockers.includes('backoff')) blockers.push('backoff');
    // Null stays null: it means time alone will not release this row.
    if (nextEligibleAt) nextEligibleAt = latest(nextEligibleAt, until);
  }
  const base = {
    source,
    studentId,
    studentName: p?.name ?? null,
    studentEmail: p?.email ?? null,
    nextEligibleAt,
    blockers,
  };
  if (source === 'reminder') {
    return {
      ...base,
      itemId: null,
      title: null,
      vendorName: null,
      status: 'due',
      queuedAt: null,
      expiresAt: null,
      position: Number(r.queue_position ?? index + 1),
    };
  }
  return {
    ...base,
    itemId: (source === 'deal' ? r.campaign_id : r.broadcast_id) ?? null,
    title: r.title ?? null,
    vendorName: r.vendor_id ? (names.vendors.get(r.vendor_id) ?? null) : null,
    status: r.status === 'sending' ? 'sending' : 'queued',
    queuedAt: r.queued_at ?? null,
    expiresAt: r.expires_at ?? null,
    position: index + 1,
  };
}

function backoffMap(list) {
  const m = new Map();
  for (const b of Array.isArray(list) ? list : []) if (b?.userId) m.set(b.userId, b.until ?? null);
  return m;
}

/**
 * True when any worker that SHOULD be running is not doing its job: its loop
 * is not armed, its claim function is missing, or its last tick failed more
 * recently than one succeeded. An unconfigured worker (no VAPID keys, no mail
 * key) is not "down", it is off, and the health strip says that separately.
 */
export function anyWorkerDown(statuses) {
  return statuses.some((s) => {
    if (!s || !s.configured) return false;
    if (!s.running || s.rpcMissing) return true;
    if (!s.lastErrorAt) return false;
    return !s.lastTickAt || Date.parse(s.lastErrorAt) > Date.parse(s.lastTickAt);
  });
}

/**
 * Is `column` of `table` there? true / false (missing) / null (could not
 * tell). A GET with a one-row limit, NOT a HEAD: postgrest-js turns a HEAD
 * that 404s with an empty body into a success with no rows, so a HEAD probe
 * reports a table that does not exist as present.
 */
async function probe(table, column) {
  try {
    const { error } = await supabaseAdmin.from(table).select(column).limit(1);
    if (!error) return true;
    return isMissingObject(error) ? false : null;
  } catch {
    return null;
  }
}

/**
 * An exact count, by GET with a one-row limit for the same reason probe()
 * avoids HEAD. Throws the PostgREST error so the caller can map it.
 */
async function exactCount(build) {
  const { count, error } = await build().limit(1);
  if (error) throw error;
  return count ?? 0;
}

/** A student's push devices. Never the endpoint: only its service. */
async function studentDevices(userId) {
  const read = (cols) => supabaseAdmin.from('push_subscriptions').select(cols)
    .eq('user_id', userId).eq('role', 'student').order('created_at', { ascending: false });
  let { data, error } = await read('id, endpoint, created_at, device_label');
  if (error && isMissingColumn(error, 'device_label')) ({ data, error } = await read('id, endpoint, created_at'));
  if (error) throw error;
  return (data ?? []).map((s) => ({
    id: s.id,
    service: serviceOf(s.endpoint),
    label: s.device_label ?? null,
    createdAt: s.created_at ?? null,
  }));
}

function budgetFrom(row, visible) {
  if (!row) return null;
  const blockers = Array.isArray(row.blockers) ? [...row.blockers] : [];
  if (visible && !blockers.includes('app_open')) blockers.push('app_open');
  return {
    userId: row.user_id,
    hasState: row.has_state === true,
    pushOptIn: row.push_opt_in ?? null,
    emailOptIn: row.email_opt_in ?? null,
    nearbyOptIn: row.nearby_opt_in ?? null,
    reminderOptIn: row.reminder_opt_in ?? null,
    lastPushAt: row.last_push_at ?? null,
    lastEmailAt: row.last_email_at ?? null,
    lastReminderAt: row.last_reminder_at ?? null,
    dayCount: Number(row.day_count ?? 0),
    weekCount: Number(row.week_count ?? 0),
    dayResetsAt: row.day_resets_at ?? null,
    weekResetsAt: row.week_resets_at ?? null,
    cooldownUntil: row.cooldown_until ?? null,
    inQuietHours: row.in_quiet_hours === true,
    quietEndsAt: row.quiet_ends_at ?? null,
    devices: Number(row.devices ?? 0),
    nextEligibleAt: row.next_eligible_at ?? null,
    blockers,
  };
}

const notificationRoutes = Router();

/**
 * GET /api/admin/notifications?limit&offset&channel&kind&outcome&recipient&range&q&student&after
 * One page of the send log, newest first. `after` is the "N new" poll: only
 * rows newer than the newest one the operator already has.
 */
notificationRoutes.get('/', async (req, res, next) => {
  const page = pageParams(req.query, { def: NOTIF_PAGE, max: NOTIF_PAGE_MAX });
  const { limit, offset } = page;
  try {
    const f = notifFilters(req.query);
    if (f.impossible) return res.json({ rows: [], total: 0, offset, limit });

    let matched = [];
    if (f.q) {
      const { data, error } = await supabaseAdmin.from('profiles').select('user_id')
        .or(`name.ilike.*${f.q}*,email.ilike.*${f.q}*`).limit(NOTIF_Q_PROFILE_CAP);
      if (error) throw error;
      matched = (data ?? []).map((p) => p.user_id).filter(isUuid);
    }

    const { rows, total } = await pageOf((opts) => notifLogQuery(opts, f, matched), page);
    const names = await resolveNames(rows.map((r) => r.student_id), rows.map((r) => r.vendor_id));
    res.json({ rows: rows.map((r) => notifSummary(r, names)), total, offset, limit });
  } catch (err) {
    if (unavailableFor(err, 'migration-062')) {
      return res.json({ unavailable: 'migration-062', rows: [], total: 0, offset, limit });
    }
    next(err);
  }
});

/**
 * GET /api/admin/notifications/summary
 * The dashboard tile: today's outcomes, what is queued, and whether anything
 * needs attention.
 */
notificationRoutes.get('/summary', async (req, res, next) => {
  try {
    const now = new Date();
    const since = localMidnight(now, CAMPAIGN_CONFIG.timezone).toISOString();
    const outcomes = ['sent', 'failed', 'refused', 'allowed'];

    const today = { sent: 0, failed: 0, refused: 0, allowed: 0 };
    let logAvailable = true;
    try {
      const counts = await Promise.all(outcomes.map((o) => exactCount(() => supabaseAdmin
        .from('notification_log').select('id', { count: 'exact' }).eq('outcome', o).gte('created_at', since))));
      outcomes.forEach((o, i) => { today[o] = counts[i]; });
    } catch (err) {
      if (!isMissingObject(err)) throw err;
      logAvailable = false;
    }

    const queuedCount = async (table, column) => {
      try {
        return await exactCount(() => supabaseAdmin.from(table).select(column, { count: 'exact' }).in('status', QUEUE_ACTIVE));
      } catch (err) {
        if (isMissingObject(err)) return null;
        throw err;
      }
    };
    const [deals, broadcasts] = await Promise.all([
      queuedCount('campaign_recipients', 'campaign_id'),
      queuedCount('admin_broadcast_recipients', 'broadcast_id'),
    ]);

    res.json({
      logAvailable,
      today,
      queued: { deals, broadcasts },
      workerDown: anyWorkerDown([campaignWorkerStatus(), reminderWorkerStatus(), broadcastWorkerStatus()]),
      pushConfigured: pushEnabled,
      emailConfigured: emailEnabled,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/notifications/health
 * Everything the health strip shows: what is configured, each worker's last
 * tick, and which of the migrations this feature reads are actually applied.
 */
notificationRoutes.get('/health', async (req, res, next) => {
  try {
    const PROBES = [
      ['047', 'campaign_recipients', 'channel'],
      ['051', 'nearby_notifications', 'user_id'],
      ['060', 'student_notify_state', 'last_reminder_at'],
      ['061', 'admin_broadcasts', 'id'],
      ['062', 'notification_log', 'id'],
    ];
    const found = await Promise.all(PROBES.map(([, table, column]) => probe(table, column)));
    const migrations = Object.fromEntries(PROBES.map(([n], i) => [n, found[i]]));
    const writer = notificationLogState();
    res.json({
      generatedAt: new Date().toISOString(),
      push: { configured: pushEnabled },
      email: { configured: emailEnabled },
      webhook: { configured: Boolean(process.env.RESEND_WEBHOOK_SECRET) },
      // `available` is whether the table can be READ. `writing` is the
      // writer's own view (false while it is cooling down after a failed
      // insert), so "the table exists but nothing is landing in it" is visible.
      log: { available: migrations['062'], writing: writer.available, lastError: writer.lastError },
      workers: {
        campaigns: campaignWorkerStatus(),
        reminders: reminderWorkerStatus(),
        broadcasts: broadcastWorkerStatus(),
      },
      migrations,
      visibleStudents: visibleUserIds().length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/notifications/queue
 * What the three workers would consider next, and what each row is waiting
 * on. Computed by the queue functions with the workers' own config, so it
 * answers the question the claim asks rather than a lookalike of it.
 */
notificationRoutes.get('/queue', async (req, res, next) => {
  try {
    const now = new Date();
    const common = queueParams(now);
    const [deals, broadcasts, reminders] = await Promise.all([
      runQueueRpc('admin_campaign_queue', {
        ...common,
        p_limit: QUEUE_DEALS_LIMIT,
        p_email_enabled: emailEnabled,
        p_vendor_cooldown_hours: CAMPAIGN_CONFIG.vendorCooldownHours,
      }, 'migration-047'),
      runQueueRpc('admin_broadcast_queue', { ...common, p_limit: QUEUE_BROADCASTS_LIMIT }, 'migration-061'),
      runQueueRpc('admin_reminder_queue', {
        ...common,
        p_limit: QUEUE_REMINDERS_FETCH,
        p_min_interval_hours: REMINDER_CONFIG.minIntervalHours,
      }, 'migration-060'),
    ]);

    // Releasable candidates first, by their queue position; the rest after.
    // Sorting on the function's next_eligible_at is the same split queueRow
    // makes, because backoff never turns null into a time or a time into null.
    const releasable = (r) => r.next_eligible_at != null;
    const reminderPos = (r, i) => Number(r.queue_position ?? i + 1);
    const ranked = reminders.data.map((r, i) => ({ r, i }))
      .sort((a, b) => (releasable(b.r) - releasable(a.r)) || (reminderPos(a.r, a.i) - reminderPos(b.r, b.i)));
    const reminderShown = ranked.slice(0, QUEUE_REMINDERS_SHOWN);
    const blockedForever = reminders.data.filter((r) => !releasable(r)).length;

    const all = [...deals.data, ...broadcasts.data, ...reminderShown.map(({ r }) => r)];
    const names = await resolveNames(all.map((r) => r.user_id), deals.data.map((r) => r.vendor_id));
    const ctx = { names, visible: new Set(visibleUserIds()), backoff: new Map() };
    const broadcastCtx = { ...ctx, backoff: backoffMap(broadcastBackoff()) };
    const reminderCtx = { ...ctx, backoff: backoffMap(reminderBackoff()) };

    const section = (result, source, totalKey, c) => {
      if (!result.available) return { available: false, unavailable: result.unavailable, total: 0, rows: [] };
      return {
        available: true,
        total: Number(result.data[0]?.[totalKey] ?? 0),
        rows: result.data.map((r, i) => queueRow(source, r, i, c)),
      };
    };
    const reminderSection = reminders.available
      ? {
        available: true,
        total: Number(reminders.data[0]?.total_candidates ?? 0),
        blockedForever,
        rows: reminderShown.map(({ r, i }) => queueRow('reminder', r, i, reminderCtx)),
      }
      : { available: false, unavailable: reminders.unavailable, total: 0, blockedForever: 0, rows: [] };

    res.json({
      generatedAt: now.toISOString(),
      quietHours: quietHoursAt(now, CAMPAIGN_CONFIG),
      config: notifyConfig(),
      deals: section(deals, 'deal', 'total_queued', ctx),
      broadcasts: section(broadcasts, 'broadcast', 'total_queued', broadcastCtx),
      reminders: reminderSection,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/notifications/student/:id
 * One student's notification picture: their shared budget, their devices,
 * what is queued for them and what was sent to them recently.
 */
notificationRoutes.get('/student/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isUuid(id)) return res.status(404).json({ error: 'NOT_FOUND', message: 'Student not found.' });
    const { data: profile, error: profErr } = await supabaseAdmin
      .from('profiles').select('user_id, name, email').eq('user_id', id).maybeSingle();
    if (profErr) throw profErr;
    if (!profile) return res.status(404).json({ error: 'NOT_FOUND', message: 'Student not found.' });

    const now = new Date();
    const common = queueParams(now);
    const visible = new Set(visibleUserIds());

    const budgetP = supabaseAdmin.rpc('admin_student_notify_budget', { p_user_id: id, ...common })
      .then(({ data, error }) => {
        if (error) {
          const unavailable = unavailableFor(error, 'migration-047');
          if (unavailable) return { budget: null, budgetUnavailable: unavailable };
          throw error;
        }
        const row = Array.isArray(data) ? data[0] : data;
        return { budget: budgetFrom(row ?? null, visible.has(id)) };
      });

    const recentP = supabaseAdmin.from('notification_log').select(NOTIF_SUMMARY_COLS)
      .eq('student_id', id)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(NOTIF_STUDENT_RECENT)
      .then(({ data, error }) => {
        if (error) {
          if (unavailableFor(error, 'migration-062')) return { rows: [], recentUnavailable: 'migration-062' };
          throw error;
        }
        return { rows: data ?? [] };
      });

    // Their own queued rows, with the same blockers the whole-queue view
    // shows. The functions filter by p_user_id BEFORE their limit: a deep
    // whole-queue page filtered here instead was silently cut at PostgREST's
    // max_rows (1000), so a student at position 1200 of a big send showed
    // nothing queued. A cheap "anything queued at all?" read first, so the
    // common case (nothing queued) runs no queue function. Best effort: a
    // queue that cannot be read costs this panel its "queued" list, not the
    // budget and history beside it.
    const queuedFor = async (table, column, fn, params, prerequisite) => {
      try {
        const { data: hit, error } = await supabaseAdmin.from(table).select(column)
          .eq('user_id', id).in('status', QUEUE_ACTIVE).limit(1);
        if (error) {
          if (isMissingObject(error)) return [];
          throw error;
        }
        if (!hit?.length) return [];
        const result = await runQueueRpc(fn, { ...params, p_limit: QUEUE_STUDENT_LIMIT, p_user_id: id }, prerequisite);
        return result.data;
      } catch (err) {
        console.warn(`[admin] queued items for one student unavailable (${fn}): ${err?.message ?? err}`);
        return [];
      }
    };

    const [budget, recent, devices, dealRows, broadcastRows] = await Promise.all([
      budgetP,
      recentP,
      studentDevices(id),
      queuedFor('campaign_recipients', 'campaign_id', 'admin_campaign_queue', {
        ...common, p_email_enabled: emailEnabled, p_vendor_cooldown_hours: CAMPAIGN_CONFIG.vendorCooldownHours,
      }, 'migration-047'),
      queuedFor('admin_broadcast_recipients', 'broadcast_id', 'admin_broadcast_queue', common, 'migration-061'),
    ]);

    const names = await resolveNames(
      [id, ...recent.rows.map((r) => r.student_id)],
      [...recent.rows.map((r) => r.vendor_id), ...dealRows.map((r) => r.vendor_id)],
    );
    // The profile was just read; it is the freshest name whatever the chunked
    // read above managed.
    names.profiles.set(id, { name: profile.name ?? null, email: profile.email ?? null });
    const ctx = { names, visible, backoff: new Map() };
    const bctx = { ...ctx, backoff: backoffMap(broadcastBackoff()) };

    const out = {
      ...budget,
      config: notifyConfig(),
      devices,
      recent: recent.rows.map((r) => notifSummary(r, names)),
      queued: [
        ...dealRows.map((r, i) => queueRow('deal', r, i, ctx)),
        ...broadcastRows.map((r, i) => queueRow('broadcast', r, i, bctx)),
      ],
    };
    if (recent.recentUnavailable) out.recentUnavailable = recent.recentUnavailable;
    res.json(out);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/notifications/reminders/preview/:userId
 * What a reminder to this student would say right now. POST because it does
 * real work (the same reads the worker does), but it is read-only:
 * previewReminder never claims, refunds, sends or logs.
 */
notificationRoutes.post('/reminders/preview/:userId', async (req, res, next) => {
  try {
    const id = req.params.userId;
    if (!isUuid(id)) return res.status(404).json({ error: 'NOT_FOUND', message: 'Student not found.' });
    // previewReminder itself reads nothing from migration-060, so it would
    // happily compose copy on a database the reminder worker cannot run on.
    // Saying "not applied" is the honest answer there: no reminder will go.
    if (await probe('student_notify_state', 'last_reminder_at') === false) {
      return res.json({ unavailable: 'migration-060', candidate: null, composed: null });
    }
    const { data: profile, error } = await supabaseAdmin
      .from('profiles').select('user_id').eq('user_id', id).maybeSingle();
    if (error) throw error;
    if (!profile) return res.status(404).json({ error: 'NOT_FOUND', message: 'Student not found.' });
    const { candidate, composed } = await previewReminder(id);
    res.json({ candidate: candidate ?? null, composed: composed ?? null });
  } catch (err) {
    if (unavailableFor(err, 'migration-060')) return res.json({ unavailable: 'migration-060', candidate: null, composed: null });
    next(err);
  }
});

/**
 * GET /api/admin/notifications/:id
 * One row in full, with the campaigns or broadcast it came from. Registered
 * LAST: it is the only parameterised GET here, and above the fixed paths it
 * would read "/queue" as an id.
 */
notificationRoutes.get('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isUuid(id)) return res.status(404).json({ error: 'NOT_FOUND', message: 'Notification not found.' });
    const { data: row, error } = await supabaseAdmin
      .from('notification_log').select(NOTIF_DETAIL_COLS).eq('id', id).maybeSingle();
    if (error) {
      if (unavailableFor(error, 'migration-062')) return res.json({ unavailable: 'migration-062', notification: null });
      throw error;
    }
    if (!row) return res.status(404).json({ error: 'NOT_FOUND', message: 'Notification not found.' });

    const ref = row.ref && typeof row.ref === 'object' && !Array.isArray(row.ref) ? row.ref : {};
    const campaignIds = (Array.isArray(ref.campaignIds) ? ref.campaignIds : []).filter(isUuid).slice(0, 20);
    const broadcastId = isUuid(ref.broadcastId) ? ref.broadcastId : null;

    // Linked sources are decoration. Each is read best-effort: the campaign
    // may have been pruned (30 days after expiry) or the broadcast table may
    // not exist yet, and either way the row itself is still worth showing.
    const [campaigns, broadcast] = await Promise.all([
      campaignIds.length
        ? supabaseAdmin.from('vendor_campaigns').select('id, title, vendor_id').in('id', campaignIds)
          .then(({ data, error: e }) => (e ? [] : data ?? []), () => [])
        : [],
      broadcastId
        ? supabaseAdmin.from('admin_broadcasts').select('id, title, audience, status').eq('id', broadcastId).maybeSingle()
          .then(({ data, error: e }) => (e ? null : data ?? null), () => null)
        : null,
    ]);

    const names = await resolveNames([row.student_id], [row.vendor_id, ...campaigns.map((c) => c.vendor_id)]);
    const linked = {};
    if (campaigns.length) {
      linked.campaigns = campaigns.map((c) => ({
        id: c.id, title: c.title ?? null, vendorName: names.vendors.get(c.vendor_id) ?? null,
      }));
    }
    if (broadcast) {
      linked.broadcast = { id: broadcast.id, title: broadcast.title ?? null, audience: broadcast.audience ?? null, status: broadcast.status ?? null };
    }

    res.json({
      notification: {
        ...notifSummary(row, names),
        body: row.body ?? null,
        url: row.url ?? null,
        template: row.template ?? null,
        ref,
        devices: cleanDevices(row.devices),
        providerId: row.provider_id ?? null,
        deliveryAt: row.delivery_at ?? null,
        dedupeKey: row.dedupe_key ?? null,
        linked,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.use('/notifications', notificationRoutes);
export { notificationRoutes };

/* ---------- students ---------- */

/**
 * The student roster behind the "Students" tile. READ-ONLY by design: this is a
 * support surface (someone writes in about their points and you need to see what
 * the app thinks), not an editor. Nothing under /students writes, so no amount of
 * clicking here can move a balance — the points-write guard would refuse it
 * anyway (migration-025).
 */
const STUDENT_PAGE = 100;        // rows per request
const STUDENT_PAGE_MAX = 200;
const STUDENT_Q_MAX = 100;       // longest search term accepted
const STUDENT_TX_SCAN = 500;     // transactions read to total up one student
const STUDENT_TX_SHOWN = 25;     // of those, how many come back as activity
const STUDENT_REFERRALS = 50;    // friends listed on one student's card

/**
 * PostgREST parses `or=(…)` as its own small grammar, so a comma, paren or quote
 * typed into the search box would rewrite the filter instead of being searched
 * for. Blanking those (plus the `%`/`*` wildcards) leaves something that can only
 * ever be a literal substring. `_` is left alone: it is a single-character LIKE
 * wildcard, but it is also in real email addresses, and matching a superset is
 * not a hazard.
 *
 * queryScalar first, because String() is the other coercion that throws on the
 * object `?q[toString]=x` parses to — see that function. An array still coerces
 * ('a,b' for ?q=a&q=b, whose comma is then blanked like any other), which is the
 * behaviour test/admin-students.test.js pins.
 */
export function safeSearch(raw) {
  return String(queryScalar(raw) ?? '').replace(/[,()"'\\%*]/g, ' ').trim().slice(0, STUDENT_Q_MAX);
}

/**
 * GET /api/admin/students?q=&limit=&offset=
 * One page of the roster, newest first, with each student's live point totals.
 * `q` matches name OR email as a substring, server-side — the operator searching
 * for someone is usually looking for a student who is NOT on the loaded page.
 */
router.get('/students', async (req, res, next) => {
  try {
    const page = pageParams(req.query, { def: STUDENT_PAGE, max: STUDENT_PAGE_MAX });
    const { limit, offset } = page;
    const q = safeSearch(req.query.q);

    const { rows, total } = await pageOf((opts) => {
      const sel = supabaseAdmin
        .from('profiles')
        .select('user_id, name, email, created_at', opts)
        .order('created_at', { ascending: false });
      return q ? sel.or(`name.ilike.*${q}*,email.ilike.*${q}*`) : sel;
    }, page);
    const ids = rows.map((r) => r.user_id);
    // Three reads for the whole page, not three per student. pool_balances is
    // the third because a pooled location's money is not in point_balances at
    // all (src/lib/pools.js): without it a chain's customer would be listed here
    // with zero points and zero spots, and the operator searching for the person
    // who just called would decide the app had lost their balance.
    const [bal, comm, pooled] = ids.length ? await Promise.all([
      // vendor_id rides along so a pooled location's row can be skipped: without
      // it this sum structurally cannot tell a drained husk from a real balance.
      supabaseAdmin.from('point_balances').select('user_id, vendor_id, balance').in('user_id', ids),
      supabaseAdmin.from('community_balances').select('user_id, balance').in('user_id', ids),
      supabaseAdmin.from('pool_balances').select('user_id, pool_id, balance').in('user_id', ids),
    ]) : [{ data: [] }, { data: [] }, { data: [] }];
    if (bal.error) throw bal.error;
    if (comm.error) throw comm.error;
    if (pooled.error) throw pooled.error;

    // "spots" means places they can spend today, and ONE shared purse is
    // spendable at every active location in its pool, so a pool counts as its
    // member count rather than as one. Active members only, matching poolFacts:
    // a location the operator switched off is not somewhere they can go.
    //
    // One query for the whole page, keyed on the handful of pools this page's
    // students actually hold money in. With no pools anywhere there are no rows
    // to key on and the query is never made at all.
    const purseRows = (pooled.data ?? []).filter((p) => (p.balance ?? 0) > 0);
    const poolSizes = new Map();
    if (purseRows.length) {
      const { data: members, error: memErr } = await supabaseAdmin
        .from('vendors')
        .select('id, pool_id')
        .in('pool_id', [...new Set(purseRows.map((p) => p.pool_id))])
        .eq('active', true);
      if (memErr) throw memErr;
      for (const m of members ?? []) poolSizes.set(m.pool_id, (poolSizes.get(m.pool_id) ?? 0) + 1);
    }

    // Which vendors spend from a pool, so their point_balances rows can be left
    // out of the sum below. pool_join zeroes those rows as it drains them, so in
    // a healthy database they add nothing anyway — but "adds nothing" and "is
    // not counted" are different claims, and only the second one survives a bug
    // in the drain. The drill-in (GET /students/:id) already takes the second
    // position; this makes the two screens agree by construction rather than by
    // both being right about pool_join.
    //
    // One tiny query, and with no pools anywhere it returns no rows and the Set
    // is empty, so nothing is filtered and this is exactly the old sum.
    const { data: pooledVendors, error: pvErr } = await supabaseAdmin
      .from('vendors').select('id').not('pool_id', 'is', null);
    if (pvErr) throw pvErr;
    const pooledVendorIds = new Set((pooledVendors ?? []).map((v) => v.id));

    const agg = new Map();   // user_id -> { points, spots }
    for (const b of bal.data ?? []) {
      if (pooledVendorIds.has(b.vendor_id)) continue;   // counted via its pool below
      const a = agg.get(b.user_id) ?? { points: 0, spots: 0 };
      a.points += b.balance ?? 0;
      if ((b.balance ?? 0) > 0) a.spots += 1;   // "spots" = places they can spend today
      agg.set(b.user_id, a);
    }
    // Added, not double counted: joining a pool moves a location's own purse
    // INTO the pool and records the transfer in pool_moves (migration-044), and
    // the loop above skipped whatever that left behind.
    for (const p of purseRows) {
      const a = agg.get(p.user_id) ?? { points: 0, spots: 0 };
      a.points += p.balance ?? 0;
      a.spots += poolSizes.get(p.pool_id) ?? 0;
      agg.set(p.user_id, a);
    }
    const community = new Map((comm.data ?? []).map((c) => [c.user_id, c.balance ?? 0]));

    res.json({
      students: rows.map((r) => ({
        id: r.user_id,
        name: r.name ?? null,
        email: r.email ?? null,
        createdAt: r.created_at,
        points: agg.get(r.user_id)?.points ?? 0,
        spots: agg.get(r.user_id)?.spots ?? 0,
        community: community.get(r.user_id) ?? 0,
      })),
      total,
      offset,
      limit,
      query: q,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/students/:id
 * Everything the platform knows about one student, gathered in one round of
 * parallel reads: balances per spot, the community pool, punch cards, lifetime
 * totals, recent activity, referral position, alert state and terms acceptance.
 *
 * Lifetime totals are summed over the most recent STUDENT_TX_SCAN transactions
 * and report `truncated` when that cap is hit, the same contract the platform
 * overview uses — a silently short total is worse than one labelled short.
 */
router.get('/students/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isUuid(id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Student not found.' });
    }

    const [profile, balances, community, txRes, cards, visits, referredBy, referred, notify, subs, terms, purses] =
      await Promise.all([
        supabaseAdmin.from('profiles').select('user_id, name, email, created_at').eq('user_id', id).maybeSingle(),
        // pool_id (and the pool's name) come through the same vendors embed the
        // spot rows are already named from. It is not decoration: pool_id is
        // what says whether this row is still the vendor's purse, and a vendors
        // row fetched without it reads as unpooled — which would report a
        // chain's customer from the wrong table without any error to notice.
        supabaseAdmin.from('point_balances')
          .select('vendor_id, balance, updated_at, vendors(name, active, pool_id, point_pools(label))')
          .eq('user_id', id),
        supabaseAdmin.from('community_balances').select('balance, lifetime_earned').eq('user_id', id).maybeSingle(),
        supabaseAdmin.from('transactions')
          .select('id, type, points, dollar_amount, community_points, created_at, vendors(name), rewards(title)')
          .eq('user_id', id).order('created_at', { ascending: false }).limit(STUDENT_TX_SCAN),
        // Post-029 a punch card is a plain counter: `punches` IS the student's
        // spendable visit count at that vendor, reset by a visits redemption.
        supabaseAdmin.from('punch_cards')
          .select('vendor_id, punches, vendors(name, active)').eq('user_id', id),
        // One punch = one business day at one vendor, so this is visit-days, not scans.
        supabaseAdmin.from('punches').select('id', { count: 'exact', head: true }).eq('user_id', id),
        supabaseAdmin.from('referrals').select('status, created_at, friend_points, referrer_id').eq('friend_id', id).maybeSingle(),
        supabaseAdmin.from('referrals').select('status, created_at, referrer_points, friend_id')
          .eq('referrer_id', id).order('created_at', { ascending: false }).limit(STUDENT_REFERRALS),
        supabaseAdmin.from('student_notify_state').select('push_opt_in, last_push_at').eq('user_id', id).maybeSingle(),
        supabaseAdmin.from('push_subscriptions').select('id', { count: 'exact', head: true }).eq('user_id', id).eq('role', 'student'),
        supabaseAdmin.from('terms_acceptances').select('terms_version, accepted_at')
          .eq('user_id', id).order('accepted_at', { ascending: false }).limit(1),
        // The shared purses this student holds. This screen is what an operator
        // opens when someone says "the app says 420 and the till says no", and
        // for a pooled location the 420 is in pool_balances keyed on the POOL,
        // with nothing under the vendor at all: read point_balances alone and
        // every spot shows zero exactly when the screen is needed.
        supabaseAdmin.from('pool_balances').select('pool_id, balance, updated_at').eq('user_id', id),
      ]);
    for (const r of [profile, balances, community, txRes, cards, visits, referredBy, referred, notify, subs, terms, purses]) {
      if (r.error) throw r.error;
    }
    if (!profile.data) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Student not found.' });
    }

    // Name the other side of every referral in one lookup rather than per row.
    const otherIds = [
      ...(referredBy.data?.referrer_id ? [referredBy.data.referrer_id] : []),
      ...(referred.data ?? []).map((r) => r.friend_id),
    ];
    const names = new Map();
    if (otherIds.length) {
      const { data: others } = await supabaseAdmin
        .from('profiles').select('user_id, name, email').in('user_id', [...new Set(otherIds)]);
      for (const o of others ?? []) names.set(o.user_id, o.name || o.email || null);
    }

    const txns = txRes.data ?? [];
    const totals = { earned: 0, redeemed: 0, spend: 0, awards: 0, redemptions: 0 };
    for (const t of txns) {
      const pts = Number(t.points) || 0;
      // Same netting rule as the platform rollup: a reversal is a negative row of
      // the same type, so it cancels rather than counting as a second event.
      if (t.type === 'earn') {
        totals.earned += pts;
        totals.spend += Number(t.dollar_amount) || 0;
        totals.awards += pts >= 0 ? 1 : -1;
      } else if (t.type === 'redeem') {
        totals.redeemed += -pts;
        totals.redemptions += pts <= 0 ? 1 : -1;
      }
    }

    // The purses this student holds, keyed the way balanceFrom wants them, so
    // the "which table" rule is read out of src/lib/pools.js here instead of
    // being spelled out a second time and drifting from the SQL the till
    // actually spends against. poolTouched rides along because a shared row's
    // updated_at lives on the pool, not on any one location.
    const purseRows = purses.data ?? [];
    const byVendor = new Map((balances.data ?? []).map((b) => [b.vendor_id, b.balance ?? 0]));
    const byPool = new Map(purseRows.map((p) => [p.pool_id, p.balance ?? 0]));
    const poolTouched = new Map(purseRows.map((p) => [p.pool_id, p.updated_at]));

    // Every location that spends from one of those shared purses, so the money
    // is shown against the shops it can be spent at rather than as a floating
    // number with no counter attached. Inactive members are included on purpose:
    // they still share the purse, and a spot the operator switched off is a
    // thing they may be drilling in to explain. One query for all of them, and
    // none at all for a student holding no shared money, which is every student
    // until the first pool exists.
    let poolMembers = [];
    if (purseRows.length) {
      const { data: members, error: memErr } = await supabaseAdmin
        .from('vendors')
        .select('id, name, active, pool_id, point_pools(label)')
        .in('pool_id', purseRows.map((p) => p.pool_id));
      if (memErr) throw memErr;
      poolMembers = members ?? [];
    }

    // One row per spot the student has anything at. Points and visits are
    // separate tables and either can exist without the other (visits with no
    // points is normal after a redemption), so they're merged rather than
    // listed twice.
    const spots = new Map();
    const spot = (vendorId, vendors) => {
      const s = spots.get(vendorId) ?? {
        vendorId,
        vendor: vendors?.name ?? 'Vendor',
        vendorActive: vendors?.active !== false,
        points: 0,
        visits: 0,
        updatedAt: null,
        // Additive purse identity: false/null on every row until a location
        // joins a pool. Stamped here rather than at each call site because a
        // spot is reached from three tables below, and two of them disagreeing
        // about whether this row is shared is worse than neither saying so.
        shared: false,
        poolId: null,
        poolLabel: null,
      };
      if (vendors?.pool_id) {
        s.shared = true;
        s.poolId = vendors.pool_id;
        s.poolLabel = vendors.point_pools?.label ?? s.poolLabel;
      }
      spots.set(vendorId, s);
      return s;
    };
    for (const b of balances.data ?? []) {
      const s = spot(b.vendor_id, b.vendors);
      // Through the purse, never straight off the row: once a location is
      // pooled its own point_balances row is what pool_join left behind, and
      // printing that is how this screen ends up agreeing with neither the
      // customer's app nor the till.
      s.points = balanceFrom({ id: b.vendor_id, pool_id: b.vendors?.pool_id ?? null }, { byVendor, byPool });
      s.updatedAt = b.updated_at;
    }
    for (const c of cards.data ?? []) {
      // No pool_id needed on this embed: punch cards are per-location and stay
      // that way (only the money is shared), and a pooled spot reached only
      // through a punch card gets its purse and its label from the member loop
      // below, which is authoritative for both.
      spot(c.vendor_id, c.vendors).visits = c.punches ?? 0;
    }
    for (const m of poolMembers) {
      const s = spot(m.id, m);
      s.points = byPool.get(m.pool_id) ?? 0;
      // The shared purse's own timestamp beats the husk row's: a sale at a
      // sibling is what moved this number, and the stale date under it is the
      // first thing an operator would misread as "nothing has happened here".
      s.updatedAt = poolTouched.get(m.pool_id) ?? s.updatedAt;
    }
    const bal = [...spots.values()].sort((a, b) => b.points - a.points || b.visits - a.visits);

    // Sum the PURSES, not the rows. A shared balance is printed on every member
    // location's row above, so adding the rows up would report a chain
    // customer's money once per branch and put a number on this screen that
    // exists nowhere in the database. With no pools the second term is zero and
    // the first is every row, i.e. exactly the row sum this replaces.
    const purseTotal =
      (balances.data ?? []).reduce((s, b) => s + (b.vendors?.pool_id ? 0 : (b.balance ?? 0)), 0)
      + purseRows.reduce((s, p) => s + (p.balance ?? 0), 0);

    res.json({
      student: {
        id: profile.data.user_id,
        name: profile.data.name ?? null,
        email: profile.data.email ?? null,
        joinedAt: profile.data.created_at,
      },
      totals: {
        ...totals,
        spend: Number(totals.spend.toFixed(2)),
        points: purseTotal,
        community: community.data?.balance ?? 0,
        communityLifetime: community.data?.lifetime_earned ?? 0,
        visits: visits.count ?? 0,
        truncated: txns.length >= STUDENT_TX_SCAN,
      },
      spots: bal,
      recent: txns.slice(0, STUDENT_TX_SHOWN).map((t) => ({
        id: t.id,
        type: t.type,
        points: t.points,
        dollarAmount: t.dollar_amount,
        communityPoints: t.community_points ?? 0,
        vendor: t.vendors?.name ?? null,
        reward: t.rewards?.title ?? null,
        createdAt: t.created_at,
      })),
      referral: {
        referredBy: referredBy.data ? {
          name: names.get(referredBy.data.referrer_id) ?? null,
          status: referredBy.data.status,
          points: referredBy.data.friend_points,
          at: referredBy.data.created_at,
        } : null,
        made: (referred.data ?? []).map((r) => ({
          name: names.get(r.friend_id) ?? null,
          status: r.status,
          points: r.referrer_points,
          at: r.created_at,
        })),
      },
      alerts: {
        optIn: notify.data?.push_opt_in ?? null,   // null = never touched the switch
        lastPushAt: notify.data?.last_push_at ?? null,
        subscriptions: subs.count ?? 0,
      },
      terms: terms.data?.[0]
        ? { version: terms.data[0].terms_version, acceptedAt: terms.data[0].accepted_at }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Resolve the user ids on a page of error rows to something an operator can act
 * on: an email, a name, and whether that person was a student, a vendor (which
 * one), or another operator. A raw uuid in the log names nobody — it can't be
 * searched for, emailed, or matched to the support message that prompted the
 * look. Two lookups for the whole page, not one per row.
 *
 * Vendor logins have no profiles row (they're auth users linked through
 * vendor_staff), so anyone still unidentified after the profiles join is looked
 * up in auth directly — capped, because that call is one round trip per id.
 */
const ACTOR_AUTH_LOOKUPS = 20;

async function resolveActors(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  const actors = new Map();
  if (!ids.length) return actors;

  const [profiles, staff] = await Promise.all([
    supabaseAdmin.from('profiles').select('user_id, name, email').in('user_id', ids),
    supabaseAdmin.from('vendor_staff').select('user_id, vendors(name)').in('user_id', ids),
  ]);

  for (const p of profiles.data ?? []) {
    actors.set(p.user_id, { id: p.user_id, email: p.email ?? null, name: p.name ?? null, role: 'student' });
  }
  // A vendor link wins over a profiles row: an operator who also has a student
  // profile is far less confusing labelled by the terminal they were using.
  for (const s of staff.data ?? []) {
    const prev = actors.get(s.user_id);
    actors.set(s.user_id, {
      id: s.user_id,
      email: prev?.email ?? null,
      name: prev?.name ?? null,
      role: 'vendor',
      vendor: s.vendors?.name ?? null,
    });
  }

  const unknown = ids.filter((id) => !actors.get(id)?.email).slice(0, ACTOR_AUTH_LOOKUPS);
  await Promise.all(unknown.map(async (id) => {
    try {
      const { data } = await supabaseAdmin.auth.admin.getUserById(id);
      const u = data?.user;
      if (!u) return;
      const prev = actors.get(id);
      actors.set(id, {
        id,
        email: u.email ?? null,
        name: prev?.name ?? u.user_metadata?.full_name ?? u.user_metadata?.name ?? null,
        role: prev?.role ?? (isAdminEmail(u.email) ? 'admin' : 'unknown'),
        ...(prev?.vendor ? { vendor: prev.vendor } : {}),
      });
    } catch { /* best-effort: the row still renders, just without a name */ }
  }));

  return actors;
}

const ERROR_PAGE = 50;
const ERROR_PAGE_MAX = 200;

/**
 * GET /api/admin/errors?source=&limit=&offset=
 * One page of error_logs rows (server 500s + client-reported errors), newest
 * first. Optional `source` filter (server|student|vendor|admin).
 *
 * `total` counts the whole log under the same source filter, so the dashboard's
 * "Show more" can say how many rows it has not fetched yet. Paged rather than
 * limit-only because the operator hunting a failure from Tuesday needs to reach
 * past the newest page, and re-requesting the same rows with a bigger limit to
 * get there is a read the database doesn't need to do twice.
 *
 * Each row carries an `actor` (who hit it) so the dashboard can say who and
 * where, not just what — see resolveActors above.
 */
router.get('/errors', async (req, res, next) => {
  try {
    const page = pageParams(req.query, { def: ERROR_PAGE, max: ERROR_PAGE_MAX });
    const { limit, offset } = page;
    const source = req.query.source;
    const filtered = source && ['server', 'student', 'vendor', 'admin'].includes(source);

    // The source filter is part of the query the count is taken from, so `total`
    // is the size of the log the dashboard is actually looking at, not the size
    // of the whole table.
    const { rows, total } = await pageOf((opts) => {
      const q = supabaseAdmin
        .from('error_logs')
        .select(
          'id, source, message, stack, path, method, status, user_id, user_agent, context, created_at',
          opts,
        )
        .order('created_at', { ascending: false });
      return filtered ? q.eq('source', source) : q;
    }, page);

    const actors = await resolveActors(rows.map((r) => r.user_id));
    res.json({
      errors: rows.map((r) => ({
        ...r,
        actor: r.user_id ? actors.get(r.user_id) ?? { id: r.user_id, role: 'unknown' } : null,
      })),
      total,
      offset,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/errors/:id
 * Permanently remove one error_logs row — the operator dismissing a log they've
 * handled (or noise) so it never shows on the dashboard again. Deletes only the
 * one row; irreversible.
 */
router.delete('/errors/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Error not found.' });
    }
    const { data, error } = await supabaseAdmin
      .from('error_logs')
      .delete()
      .eq('id', req.params.id)
      .select('id')          // returns the row only if one was actually deleted
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'NOT_FOUND', message: 'Error not found.' });
    res.json({ ok: true, id: data.id });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/errors?source=
 * Bulk-clear the error log — the "Clear all" control. With a valid `source`
 * filter it clears just that source (matching whatever the dashboard is filtered
 * to); with no source it wipes the whole log. Irreversible.
 */
router.delete('/errors', async (req, res, next) => {
  try {
    const source = req.query.source;
    let q = supabaseAdmin.from('error_logs').delete();
    if (source && ['server', 'student', 'vendor', 'admin'].includes(source)) {
      q = q.eq('source', source);
    } else {
      // PostgREST refuses an unfiltered DELETE; `id is not null` matches every
      // row (id is the primary key, never null) to clear the whole table.
      q = q.not('id', 'is', null);
    }
    const { error } = await q;
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ===================== Trackable QR codes (migration-050) =====================
   The operator makes a code here, prints the QR onto a banner, and reads the
   traffic back here. Everything below is CRUD plus two read shapes; the payout
   itself is nowhere near this file — it happens at signup, in
   src/lib/tracked-qr.js, because that is the only moment it can be earned.

   ⚠ Not to be confused with the /qr-poster endpoints above, which are the ONE
   static "scan here" artwork file every vendor terminal downloads. Same tab in
   the UI, unrelated features. */

// The list reads the roll-up view, not the table: counting scans in Node would
// mean pulling every scan row down the wire (see migration-050).
const TRACKED_QR_COLS = 'id, code, name, note, points, active, created_by, created_at, updated_at, '
  + 'scans, uniques, first_scan, last_scan, signups, points_awarded';

/**
 * Validate the admin form. Never throws; the caller turns `error` into a 400.
 *
 * `partial` is what makes one validator serve both the create form and the
 * inline row editor: on a PATCH an absent field means "leave it alone", which
 * is a different thing from an empty one ("clear it").
 */
function validTrackedQr(raw, { partial = false } = {}) {
  const body = raw ?? {};
  const out = {};

  if (!partial || body.name != null) {
    const name = String(body.name ?? '').trim();
    if (!name || name.length > QR_NAME_MAX) {
      return { error: `Give the banner a name you'll recognise later (max ${QR_NAME_MAX} characters), e.g. "HUB east entrance".` };
    }
    out.name = name;
  }

  if (!partial || body.note != null) {
    const note = String(body.note ?? '').trim();
    if (note.length > QR_NOTE_MAX) {
      return { error: `Keep the placement note under ${QR_NOTE_MAX} characters.` };
    }
    out.note = note || null;
  }

  if (!partial || body.points != null) {
    const points = body.points === '' || body.points == null ? 0 : Number(body.points);
    if (!Number.isInteger(points) || points < 0 || points > QR_POINTS_MAX) {
      return { error: `The award must be a whole number of community points from 0 to ${QR_POINTS_MAX}. 0 means track traffic only.` };
    }
    out.points = points;
  }

  if (body.active != null) {
    if (typeof body.active !== 'boolean') return { error: 'Active must be true or false.' };
    out.active = body.active;
  }

  return { row: out };
}

/** GET /api/admin/tracked-qr — every banner with its traffic roll-up. */
router.get('/tracked-qr', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tracked_qr_overview')
      .select(TRACKED_QR_COLS)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ codes: data ?? [] });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/tracked-qr  { name, note, points }
 * Mints a code. Harmless until the QR is printed and put somewhere, so there is
 * no confirmation step here — the dangerous direction is editing the award on a
 * banner that is already on a wall, which the PATCH below guards instead.
 */
router.post('/tracked-qr', async (req, res, next) => {
  try {
    const parsed = validTrackedQr(req.body);
    if (parsed.error) return res.status(400).json({ error: 'BAD_REQUEST', message: parsed.error });

    const row = await createTrackedQr({
      name: parsed.row.name,
      note: parsed.row.note ?? null,
      points: parsed.row.points ?? 0,
      createdBy: req.user?.email ?? null,
    });
    res.status(201).json({
      ok: true,
      code: { ...row, scans: 0, uniques: 0, first_scan: null, last_scan: null, signups: 0, points_awarded: 0 },
    });
  } catch (err) {
    if (String(err?.message ?? '') === 'TRACKED_QR_CODE_COLLISION') {
      return res.status(503).json({
        error: 'TRACKED_QR_BUSY',
        message: 'Couldn’t mint a unique code just now. Try once more.',
      });
    }
    next(err);
  }
});

/**
 * PATCH /api/admin/tracked-qr/:id  { name?, note?, points?, active? }
 *
 * Editing the award on a banner that is ALREADY PRINTED is the one genuinely
 * dangerous button in this feature, because the banner cannot be recalled and
 * community_grants has no reversal path — reverse_transaction only unwinds
 * transactions rows. So a raise is confirmed in the client before it gets here,
 * and the ceiling is enforced here regardless of what the client did.
 */
router.patch('/tracked-qr/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'TRACKED_QR_NOT_FOUND', message: 'That QR code no longer exists.' });
    }
    const parsed = validTrackedQr(req.body, { partial: true });
    if (parsed.error) return res.status(400).json({ error: 'BAD_REQUEST', message: parsed.error });
    if (!Object.keys(parsed.row).length) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Nothing to change.' });
    }

    const { data, error } = await supabaseAdmin
      .from('tracked_qr_codes')
      .update({ ...parsed.row, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'TRACKED_QR_NOT_FOUND', message: 'That QR code no longer exists.' });
    }

    // Read the roll-up back rather than echoing the update: the row the list
    // renders carries scan counts this handler never touched, and returning a
    // half-populated row would blank them until the next refresh.
    const { data: full, error: readErr } = await supabaseAdmin
      .from('tracked_qr_overview').select(TRACKED_QR_COLS).eq('id', req.params.id).single();
    if (readErr) throw readErr;
    res.json({ ok: true, code: full });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/tracked-qr/:id
 *
 * REFUSED once anyone has scanned it, unless ?force=1. A banner with traffic is
 * a physical object on a wall that people are still scanning; deleting the row
 * makes every future scan land on the home page with no record that it
 * happened, and takes the history of the ones that already did. Pausing is
 * almost always what the operator actually wants, so that is what the refusal
 * says. The escape hatch exists for the real case this protects against being
 * annoying about: a banner created by mistake, never printed.
 */
router.delete('/tracked-qr/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'TRACKED_QR_NOT_FOUND', message: 'That QR code no longer exists.' });
    }
    // Strict compare, no String(): the coercion throws on the object
    // ?force[toString]=1 parses to (see queryScalar), and a flag that only the
    // exact string '1' can set is the same shape as ?resubscribe=1 in
    // src/routes/unsubscribe.js. public/admin/admin.js sends literally '?force=1'.
    const force = req.query.force === '1';

    const { data: row, error: readErr } = await supabaseAdmin
      .from('tracked_qr_overview').select('id, name, scans, signups').eq('id', req.params.id).maybeSingle();
    if (readErr) throw readErr;
    if (!row) {
      return res.status(404).json({ error: 'TRACKED_QR_NOT_FOUND', message: 'That QR code no longer exists.' });
    }
    if (!force && (row.scans > 0 || row.signups > 0)) {
      return res.status(409).json({
        error: 'TRACKED_QR_IN_USE',
        message: `“${row.name}” has been scanned ${row.scans} time${row.scans === 1 ? '' : 's'}. Pause it instead — the banner is still on a wall, and deleting it throws away its history.`,
      });
    }

    const { error } = await supabaseAdmin.from('tracked_qr_codes').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/tracked-qr/:id/detail?days=30 — the two series behind one row's panel. */
router.get('/tracked-qr/:id/detail', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'TRACKED_QR_NOT_FOUND', message: 'That QR code no longer exists.' });
    }
    // Same gate as /roi's window: see queryScalar.
    const days = Math.min(365, Math.max(1, Math.floor(Number(queryScalar(req.query.days)) || 30)));
    const { data, error } = await supabaseAdmin.rpc('tracked_qr_detail', {
      p_qr_id: req.params.id,
      p_days: days,
    });
    if (error) throw error;
    res.json(data ?? { days, daily: [], hourly: [] });
  } catch (err) {
    next(err);
  }
});

/* ---------- CSV export ----------
   Written out by hand because the app has no CSV anywhere else and one
   serialiser for two endpoints is not worth a dependency.

   TWO ESCAPES, and the second one is the one that gets forgotten. Quoting
   handles commas, quotes and newlines so the file parses. The leading-quote
   rule handles the other thing: Excel and Sheets evaluate a cell that starts
   with = + - or @ as a FORMULA, so a banner an operator innocently named
   "=HUB entrance" would execute on open. The operator types these names
   themselves, which makes it less of an attack than a foot-gun — but a
   user-agent string arrives from the open internet and lands in the same file. */
const CSV_FORMULA_RE = /^[=+\-@\t\r]/;

export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (CSV_FORMULA_RE.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvRow = (cells) => cells.map(csvCell).join(',');

function sendCsv(res, filename, rows) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('Cache-Control', 'no-store');
  // A BOM, so Excel on Windows reads it as UTF-8 instead of mangling the curly
  // quotes and accents that operator-typed names are full of.
  res.send('\uFEFF' + rows.join('\r\n') + '\r\n');
}

/** GET /api/admin/tracked-qr/export — one row per banner, the whole roll-up. */
router.get('/tracked-qr/export', async (req, res, next) => {
  try {
    const origin = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
    const { data, error } = await supabaseAdmin
      .from('tracked_qr_overview').select(TRACKED_QR_COLS).order('created_at', { ascending: false });
    if (error) throw error;

    const rows = [csvRow([
      'Name', 'Code', 'URL', 'Placement note', 'Award (community points)', 'Status',
      'Scans', 'Unique visitors', 'Signups', 'Points awarded', 'First scan', 'Last scan', 'Created',
    ])];
    for (const c of data ?? []) {
      rows.push(csvRow([
        c.name, c.code, `${origin}/r/${c.code}`, c.note, c.points, c.active ? 'Active' : 'Paused',
        c.scans, c.uniques, c.signups, c.points_awarded, c.first_scan, c.last_scan, c.created_at,
      ]));
    }
    sendCsv(res, 'werewards-qr-codes.csv', rows);
  } catch (err) {
    next(err);
  }
});

// One page of scans per round trip, and a hard ceiling on how many pages. The
// ceiling is announced in the file rather than silently applied: a truncated
// export that looks complete is how someone ends up reporting the wrong number
// in a meeting.
const SCAN_EXPORT_PAGE = 1000;
const SCAN_EXPORT_MAX = 50_000;

/** GET /api/admin/tracked-qr/:id/export — the raw scan log for one banner. */
router.get('/tracked-qr/:id/export', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'TRACKED_QR_NOT_FOUND', message: 'That QR code no longer exists.' });
    }
    const { data: code, error: codeErr } = await supabaseAdmin
      .from('tracked_qr_codes').select('code, name').eq('id', req.params.id).maybeSingle();
    if (codeErr) throw codeErr;
    if (!code) {
      return res.status(404).json({ error: 'TRACKED_QR_NOT_FOUND', message: 'That QR code no longer exists.' });
    }

    const rows = [csvRow(['Scanned at (UTC)', 'Visitor', 'Device / user agent'])];
    let offset = 0;
    let truncated = false;
    for (;;) {
      // pageOf's 416-past-the-end handling isn't needed here: this loop never
      // asks for a page it hasn't been told exists by the previous one.
      const { data, error } = await supabaseAdmin
        .from('tracked_qr_scans')
        .select('scanned_at, visitor_hash, user_agent')
        .eq('qr_id', req.params.id)
        .order('scanned_at', { ascending: false })
        .range(offset, offset + SCAN_EXPORT_PAGE - 1);
      if (error) throw error;
      const page = data ?? [];
      for (const s of page) {
        // A short prefix of the hash, not the hash: enough to see the same
        // phone twice in the file, useless for anything else.
        rows.push(csvRow([
          s.scanned_at,
          s.visitor_hash ? s.visitor_hash.slice(0, 12) : 'no cookie',
          s.user_agent,
        ]));
      }
      offset += page.length;
      if (page.length < SCAN_EXPORT_PAGE) break;
      if (offset >= SCAN_EXPORT_MAX) { truncated = true; break; }
    }
    if (truncated) {
      rows.push(csvRow([`TRUNCATED — only the most recent ${SCAN_EXPORT_MAX} scans are listed.`, '', '']));
      console.warn(`[tracked-qr] export of ${code.code} truncated at ${SCAN_EXPORT_MAX} rows`);
    }
    sendCsv(res, `werewards-qr-${code.code}-scans.csv`, rows);
  } catch (err) {
    next(err);
  }
});

/* ===================== Ambassadors (migration-053) =====================
   A person recruiting for the app, with a short code they chose and a QR the
   operator hands them. Everything below is CRUD plus one read shape.

   ⚠ NO MONEY IS ANYWHERE NEAR THIS BLOCK. There is no points field to validate
   and no grant to make: an ambassador is measured, not paid (migration-053).

   ⚠ Sibling of the trackable-QR block above, and three rules do NOT carry over:
   the code is typed rather than minted, the email is unique, and `active` stops
   the LINK rather than a payout. See src/lib/ambassadors.js.

   THE ERRORS HERE ARE SHAPED FOR THE FORM. A create that collides comes back
   with a `field` naming which input was wrong ('code' or 'email'), because the
   dialog puts its red text under that input rather than at the top of the
   dialog. Any handler that adds a new refusal must carry a `field` too, or the
   message lands nowhere. */

const AMBASSADOR_COLS = 'id, code, name, email, phone, active, points, user_id, has_account, '
  + 'created_by, created_at, updated_at, '
  + 'scans, uniques, first_scan, last_scan, signups, points_awarded';

/**
 * Validate the ambassador dialog. Never throws.
 *
 * Returns `{ row }`, or `{ error, field }` — the field is what lets the client
 * put the message under the right input. `partial` makes one validator serve
 * both the create form and the edit form: on a PATCH an absent key means "leave
 * it alone", which is a different thing from an empty one ("clear it").
 */
function validAmbassador(raw, { partial = false } = {}) {
  const body = raw ?? {};
  const out = {};

  if (!partial || body.name != null) {
    const name = String(body.name ?? '').trim();
    if (!name || name.length > AMB_NAME_MAX) {
      return { error: `Enter a name, up to ${AMB_NAME_MAX} characters.`, field: 'name' };
    }
    out.name = name;
  }

  if (!partial || body.email != null) {
    const email = normalizeAmbassadorEmail(body.email);
    if (!email) return { error: 'Enter a valid email address.', field: 'email' };
    out.email = email;
  }

  // Optional, so blank is a real answer and clears the column. Only a non-empty
  // string that doesn't look like a phone number is refused.
  if (!partial || body.phone != null) {
    const phone = String(body.phone ?? '').trim();
    if (phone && !isValidPhone(phone)) {
      return { error: 'That doesn’t look like a phone number. Digits, spaces and ( ) + - . only.', field: 'phone' };
    }
    out.phone = phone || null;
  }

  if (!partial || body.code != null) {
    // Passed RAW, not pre-stringified: normalizeCode refuses a non-string on
    // purpose, and String()-ing it here would hand it "true" or "42" and undo
    // that. `typed` below is only ever used to word the error.
    const code = normalizeAmbassadorCode(body.code);
    const typed = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) {
      // Two different mistakes, worded apart, because "invalid code" leaves the
      // operator guessing which of the two rules they broke.
      const stripped = typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (typed && stripped !== typed.toUpperCase()) {
        return { error: 'Letters and numbers only, no spaces or symbols.', field: 'code' };
      }
      return {
        error: `The code must be ${AMB_CODE_MIN} to ${AMB_CODE_MAX} letters or numbers.`,
        field: 'code',
      };
    }
    out.code = code;
  }

  // What one signup through their code pays THEM. 0 is a real setting: measure
  // somebody and pay them nothing. Absent on a PATCH means "leave it alone",
  // which is why this is not folded into the `points ?? 0` shorthand.
  if (!partial || body.points != null) {
    const points = body.points === '' || body.points == null ? 0 : Number(body.points);
    if (!Number.isInteger(points) || points < 0 || points > AMB_POINTS_MAX) {
      return {
        error: `The payout must be a whole number of community points from 0 to ${AMB_POINTS_MAX}. 0 pays nothing.`,
        field: 'points',
      };
    }
    out.points = points;
  }

  if (body.active != null) {
    if (typeof body.active !== 'boolean') return { error: 'Active must be true or false.', field: 'active' };
    out.active = body.active;
  }

  return { row: out };
}

/**
 * Resolve the student account an ambassador is paid into, from their email.
 *
 * ⚠ THIS IS A REFUSAL, NOT A WARNING, and the reason is that the alternative
 * fails silently. grant_community_points raises GRANT_STUDENT_UNKNOWN for a
 * user with no profiles row, and the evaluator swallows that (it must — a
 * payout may never cost a student their consent). So an ambassador created
 * against an address nobody has signed up with would recruit people, show
 * signups climbing on their row, and simply never be paid, with the only trace
 * a line on stderr. Refusing at the door is the difference between an operator
 * fixing a typo now and somebody being owed points a month later.
 *
 * Returns `{ userId }`, or a `{ error, field, message }` the caller can send back.
 */
async function resolveAmbassadorAccount(email) {
  const account = await findAccountByEmail(email);
  if (account) return { userId: account.user_id };
  return {
    error: 'AMBASSADOR_NO_ACCOUNT',
    field: 'email',
    message: `No WeRewards account uses ${email}. They need to sign up in the student app first, then you can add them here.`,
  };
}

/**
 * Is this code or email already spoken for? Returns a `{ error, field }` the
 * caller can send straight back, or null.
 *
 * WHY A LOOKUP AND NOT JUST THE UNIQUE CONSTRAINT. The constraint is the real
 * guard and is still caught below — but it can only say "duplicate key", and
 * the dialog has to say WHICH field and, more usefully, WHO already has it.
 * "SARAH7 already belongs to Sarah Chen" is the difference between an operator
 * fixing it in five seconds and an operator filing a bug.
 *
 * `exceptId` is what makes this reusable for the edit form: a row is allowed to
 * keep its own code and email.
 */
async function ambassadorConflict({ code, email, exceptId = null }) {
  const checks = [];
  if (code) checks.push(['code', code]);
  if (email) checks.push(['email', email]);

  for (const [field, value] of checks) {
    let q = supabaseAdmin.from('ambassadors').select('id, name, code, email').eq(field, value).limit(1);
    if (exceptId) q = q.neq('id', exceptId);
    const { data, error } = await q;
    if (error) throw error;
    const clash = data?.[0];
    if (!clash) continue;
    return field === 'code'
      ? { error: 'AMBASSADOR_CODE_TAKEN', field: 'code', message: `${clash.code} is already ${clash.name}’s code.` }
      : { error: 'AMBASSADOR_EMAIL_TAKEN', field: 'email', message: `${clash.email} is already an ambassador (${clash.name}).` };
  }

  // The other namespace sharing /r/<code>. A banner's code is 8 lowercase
  // characters, so an operator can genuinely type one in (SARAHXYZ is legal
  // here and lowercases into a legal banner code), and the resolver tries
  // banners FIRST — the ambassador would simply never be reached, with nothing
  // on screen to explain why. Refused here, where it can be explained.
  //
  // Only this direction is guarded: a minted banner code landing on an existing
  // ambassador's is 1 in 31^8, and the mint loop would have to grow a second
  // query per attempt to catch it. See migration-053.
  if (code) {
    const { data, error } = await supabaseAdmin
      .from('tracked_qr_codes').select('name').eq('code', code.toLowerCase()).limit(1);
    if (error) throw error;
    if (data?.[0]) {
      return {
        error: 'AMBASSADOR_CODE_TAKEN',
        field: 'code',
        message: `${code} is already a poster QR code (“${data[0].name}”). Pick another.`,
      };
    }
  }

  return null;
}

/** The UNIQUE constraint firing anyway — a second operator saved the same code
 *  between the lookup above and the write. Rarer than the pre-check it backs
 *  up, and it can only name the column, not the person holding it. */
function ambassadorDupe(err, row) {
  if (err?.code !== '23505') return null;
  const on = String(err.details ?? err.message ?? '');
  if (on.includes('email')) {
    return { error: 'AMBASSADOR_EMAIL_TAKEN', field: 'email', message: 'That email is already an ambassador.' };
  }
  return {
    error: 'AMBASSADOR_CODE_TAKEN',
    field: 'code',
    message: `${row?.code ?? 'That code'} is already taken. Pick another.`,
  };
}

/** GET /api/admin/ambassadors — everyone, with their scan/signup roll-up. */
router.get('/ambassadors', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('ambassador_overview')
      .select(AMBASSADOR_COLS)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ ambassadors: data ?? [] });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/ambassadors  { name, email, phone?, code } */
router.post('/ambassadors', async (req, res, next) => {
  try {
    const parsed = validAmbassador(req.body);
    if (parsed.error) {
      return res.status(400).json({ error: 'BAD_REQUEST', field: parsed.field, message: parsed.error });
    }

    const clash = await ambassadorConflict({ code: parsed.row.code, email: parsed.row.email });
    if (clash) return res.status(409).json(clash);

    // They must already be a student, because that is the account the payout
    // lands in. Checked even when the rate is 0: a 0-rate ambassador is very
    // often one the operator is about to give a rate to, and discovering then
    // that there was never an account is discovering it too late.
    const account = await resolveAmbassadorAccount(parsed.row.email);
    if (account.error) return res.status(409).json(account);

    const { data, error } = await supabaseAdmin
      .from('ambassadors')
      .insert({ ...parsed.row, user_id: account.userId, created_by: req.user?.email ?? null })
      .select('id, code, name, email, phone, active, points, user_id, created_by, created_at, updated_at')
      .single();
    if (error) {
      const dupe = ambassadorDupe(error, parsed.row);
      if (dupe) return res.status(409).json(dupe);
      throw error;
    }

    // The list renders roll-up columns this insert never touched. A brand-new
    // ambassador has none of them, so they are filled in as zeros rather than
    // read back — the alternative is a second query for a row we already know
    // the answer for. has_account is computed the same way the view computes it.
    res.status(201).json({
      ok: true,
      ambassador: {
        ...data,
        has_account: data.user_id != null,
        scans: 0, uniques: 0, first_scan: null, last_scan: null, signups: 0, points_awarded: 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/ambassadors/:id  { name?, email?, phone?, code?, active? } */
router.patch('/ambassadors/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'AMBASSADOR_NOT_FOUND', message: 'That ambassador no longer exists.' });
    }
    const parsed = validAmbassador(req.body, { partial: true });
    if (parsed.error) {
      return res.status(400).json({ error: 'BAD_REQUEST', field: parsed.field, message: parsed.error });
    }
    if (!Object.keys(parsed.row).length) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Nothing to change.' });
    }

    // exceptId, or saving a row without touching its code would collide with
    // itself and the dialog would refuse an edit that changed nothing.
    const clash = await ambassadorConflict({
      code: parsed.row.code,
      email: parsed.row.email,
      exceptId: req.params.id,
    });
    if (clash) return res.status(409).json(clash);

    /* A CHANGED EMAIL IS A CHANGED PAYEE. The stored user_id was resolved from
       the old address, so leaving it alone would keep paying the previous person
       indefinitely — the worst possible outcome of an edit that looks purely
       cosmetic.

       ⚠ COMPARED AGAINST THE CURRENT ROW, not merely "is email present". The
       edit dialog posts all four fields on every save, so a presence check would
       re-resolve on every edit — and then an ambassador whose student account
       has since been deleted (user_id is null, by ON DELETE SET NULL) could not
       be renamed, or even switched off, because a save that changed nothing
       would be refused for an account nobody was asking about. */
    const { data: before, error: beforeErr } = await supabaseAdmin
      .from('ambassadors').select('email, user_id').eq('id', req.params.id).maybeSingle();
    if (beforeErr) throw beforeErr;
    if (!before) {
      return res.status(404).json({ error: 'AMBASSADOR_NOT_FOUND', message: 'That ambassador no longer exists.' });
    }

    if (parsed.row.email && parsed.row.email !== before.email) {
      const account = await resolveAmbassadorAccount(parsed.row.email);
      if (account.error) return res.status(409).json(account);
      parsed.row.user_id = account.userId;
    } else if (before.user_id == null) {
      // Same address, no account on file. They deleted their account and have
      // since signed up again, or the row predates this column. Saving re-links
      // them if an account is there now, and quietly leaves it null if not —
      // this is a heal, not a gate, so it must never refuse the edit.
      const account = await resolveAmbassadorAccount(before.email);
      if (!account.error) parsed.row.user_id = account.userId;
    }

    const { data, error } = await supabaseAdmin
      .from('ambassadors')
      .update({ ...parsed.row, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('id')
      .maybeSingle();
    if (error) {
      const dupe = ambassadorDupe(error, parsed.row);
      if (dupe) return res.status(409).json(dupe);
      throw error;
    }
    if (!data) {
      return res.status(404).json({ error: 'AMBASSADOR_NOT_FOUND', message: 'That ambassador no longer exists.' });
    }

    // Read the roll-up back rather than echoing the update: the row the list
    // renders carries scan counts this handler never touched, and returning a
    // half-populated row would blank them until the next refresh.
    const { data: full, error: readErr } = await supabaseAdmin
      .from('ambassador_overview').select(AMBASSADOR_COLS).eq('id', req.params.id).single();
    if (readErr) throw readErr;
    res.json({ ok: true, ambassador: full });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/ambassadors/:id
 *
 * REFUSED once the code has been scanned, unless ?force=1 — the same bargain
 * the tracked-QR delete strikes, for a slightly different reason. The code is
 * in somebody's bio and on the back of their phone, and deleting the row makes
 * every future scan land on the home page and throws away the record of the
 * students they already brought in. Turning them OFF does the first without the
 * second, so that is what the refusal points at.
 */
router.delete('/ambassadors/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'AMBASSADOR_NOT_FOUND', message: 'That ambassador no longer exists.' });
    }
    // Strict compare, no String(): the coercion throws on the object
    // ?force[toString]=1 parses to (see queryScalar), and a flag that only the
    // exact string '1' can set is the same shape as ?resubscribe=1 in
    // src/routes/unsubscribe.js. public/admin/admin.js sends literally '?force=1'.
    const force = req.query.force === '1';

    const { data: row, error: readErr } = await supabaseAdmin
      .from('ambassador_overview').select('id, name, scans, signups').eq('id', req.params.id).maybeSingle();
    if (readErr) throw readErr;
    if (!row) {
      return res.status(404).json({ error: 'AMBASSADOR_NOT_FOUND', message: 'That ambassador no longer exists.' });
    }
    if (!force && (row.scans > 0 || row.signups > 0)) {
      return res.status(409).json({
        error: 'AMBASSADOR_IN_USE',
        message: `${row.name}’s code has been scanned ${row.scans} time${row.scans === 1 ? '' : 's'}. Turn them off instead: deleting throws away the ${row.signups} signup${row.signups === 1 ? '' : 's'} they brought in.`,
      });
    }

    const { error } = await supabaseAdmin.from('ambassadors').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
