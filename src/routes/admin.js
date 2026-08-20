import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAdmin, isAdminEmail } from '../middleware/auth.js';
import { geocode } from '../lib/geocode.js';
import { getVapidPublicKey, notifyAdminEndpoint } from '../lib/push.js';
import { isUuid } from '../lib/ids.js';
import { rollupPlatformOverview } from '../lib/analytics.js';
import { generateResetCode, normalizeResetCode } from '../lib/reset-codes.js';
import { validReward, validRatio } from '../lib/rewards.js';
import { validReferralConfig, runReferralSweep } from '../lib/referrals.js';
import { validSignupConfig } from '../lib/signup-bonus.js';
import {
  getPoster, putPoster, deletePoster, readPoster, decodePosterBody,
  POSTER_MAX_BYTES, POSTER_EXTENSIONS,
} from '../lib/qr-poster.js';
import { emitBalance } from '../lib/realtime.js';
import { invalidateVendorCaches } from '../lib/cache.js';
import { normalizeCuisine, normalizePriceLevel } from '../lib/cuisines.js';
import { validLogo } from '../lib/logo.js';

const router = Router();
router.use(requireAdmin);

const DAY = 86_400_000;
const ADDRESS_MAX = 300;   // keep a pasted essay out of the column and the geocoder

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
 * the fields that only exist to help the operator judge an application (contact
 * name, phone, message) and have nowhere to live on a vendors row.
 */
export function validNewVendor(body) {
  const b = body ?? {};
  const n = validVendorName(b.name);
  if (n.error) return { error: n.error };

  const email = String(b.email ?? '').trim().toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  const address = String(b.address ?? '').trim();
  const label = String(b.locationLabel ?? '').trim();
  const logo = validLogo(b.logo);

  if (!EMAIL_RE.test(email) || email.length > EMAIL_MAX) return { error: 'Enter a valid email address.' };
  if (password.length < PASSWORD_MIN) return { error: `Password must be at least ${PASSWORD_MIN} characters.` };
  if (password.length > PASSWORD_MAX) return { error: `Password must be ${PASSWORD_MAX} characters or fewer.` };
  if (address.length > ADDRESS_MAX) return { error: `Address must be ${ADDRESS_MAX} characters or fewer.` };
  if (label.length > LABEL_MAX) return { error: `The location name must be ${LABEL_MAX} characters or fewer.` };
  if (logo.error) return { error: logo.error };

  // Not validated, NORMALISED (migration-042): both are optional pickers, and
  // an unrecognised tag drops out rather than 400ing a form the operator has
  // otherwise filled in correctly. See src/lib/cuisines.js.
  return {
    name: n.value, email, password, address: address || null, logo: logo.value,
    cuisine: normalizeCuisine(b.cuisine),
    priceLevel: normalizePriceLevel(b.priceLevel),
    locationLabel: label || null,
  };
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
  const limit = Math.min(max, Math.max(1, Math.floor(Number(q.limit) || def)));
  const offset = Math.max(0, Math.floor(Number(q.offset) || 0));
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
      .select('id, name, slug, location_label, active, points_per_dollar, address, latitude, longitude, cuisine, price_level, has_logo, created_at')
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
 * @param loc  { name, address?, logo?, cuisine?, priceLevel?, locationLabel? }
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
      })
      .select(`id, name, slug, location_label, ${INHERITED_CONFIG.join(', ')}`)
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
 * (redeem is ungated until the vendor sets a PIN in terminal Settings).
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
  locationLabel = null, locations = [],
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
  // CONFIG ONLY. Reward items, deals, balances, history and the staff PIN are
  // per-location and start empty, so one store's menu never turns up on
  // another's ITEMS tab and its PIN never unlocks another's till.
  let config = await inheritedConfig(userId);

  // Locations sharing a business name (which is most of a chain) all slugify to
  // the same base. Remembering where the last one landed keeps the collision
  // retry linear instead of re-walking every taken suffix per location.
  const slugStart = new Map();

  const created = [];
  try {
    // Location one is this call's own arguments; the rest came from a /join
    // application that named several (migration-043).
    const all = [{ name, address, logo, cuisine, priceLevel, locationLabel }, ...locations];
    for (const loc of all) {
      const row = await createVendorRow(loc, config, slugStart);
      created.push(row);
      config ??= pickConfig(row);   // location one sets the pattern for its siblings

      const { error: staffErr } = await supabaseAdmin
        .from('vendor_staff')
        .insert({ vendor_id: row.id, user_id: userId, role: 'owner' });
      if (staffErr) throw staffErr;
    }

    // A new spot should appear for students on their next load, not up to the
    // catalogue TTL later. See src/lib/cache.js.
    invalidateVendorCaches();
  } catch (err) {
    // Unwind EVERY row this call made, not only the one that failed. A
    // half-onboarded chain is worse than none: the application is still queued
    // (it is deleted last, by the caller), so a retry would create the earlier
    // locations a second time, and the vendor would sign in to duplicates.
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
 * Only the fields a vendors row actually holds are collected. An application
 * also carries a contact name, phone and free-text message, but those exist to
 * help the operator DECIDE — an operator adding a vendor by hand has already
 * decided, and there is nowhere to store them.
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
 * Mint a one-time password-reset code for one of this vendor's logins, for the
 * operator to read to them over the phone. This is the whole recovery channel —
 * there is no SMTP in this stack, and vendors sign in with a password rather
 * than Google, so Supabase's own recovery email is not available to them.
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
    res.json({
      ok: true,
      code,                                     // shown once, never retrievable again
      email: row?.reset_email ?? target.email,  // the address the vendor must type
      expiresAt: row?.reset_expires_at ?? null,
      ttlMinutes: RESET_TTL_MINUTES,
      vendor: { id: vendor.id, name: vendor.name },
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
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Nothing to update (send name, active, address, locationLabel, pointsPerDollar, cuisine, priceLevel, and/or logo).' });
    }

    // Geocode a changed address so the student card's map stays in sync.
    if ('address' in updates) {
      const coords = updates.address ? await geocode(updates.address) : null;
      updates.latitude = coords?.lat ?? null;
      updates.longitude = coords?.lng ?? null;
    }

    const { data, error } = await supabaseAdmin
      .from('vendors')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, name, slug, location_label, active, points_per_dollar, address, latitude, longitude, cuisine, price_level, has_logo, created_at')
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
 */
router.delete('/vendors/:id', async (req, res, next) => {
  try {
    // Same guard as PATCH: a malformed id is a clean 404, not a uuid cast 500.
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Vendor not found.' });
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
    for (const { user_id: uid } of staff ?? []) {
      const { count } = await supabaseAdmin
        .from('vendor_staff')
        .select('vendor_id', { count: 'exact', head: true })
        .eq('user_id', uid);
      if (!count) {
        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('user_id')
          .eq('user_id', uid)
          .maybeSingle();
        if (!profile) await supabaseAdmin.auth.admin.deleteUser(uid).catch(() => {});
      }
    }

    res.json({ ok: true, id: data.id });
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
      .select('id, business_name, contact_name, phone, email, address, location_label, locations, logo, message, cuisine, price_level, created_at')
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
 * vendors row → vendor_staff link), then delete the application. The login is
 * created from the stored bcrypt hash (password_hash), so the vendor signs in
 * with the password they chose when applying — unless the email already had an
 * account, which is linked instead and keeps its own password (`linkedExisting`
 * tells the dashboard to say so; see onboardVendor).
 *
 * The application row is only deleted at the very end, and onboardVendor unwinds
 * itself on failure — so any failed accept leaves a clean slate and the
 * application still in the queue to retry.
 */
router.post('/applications/:id/accept', async (req, res, next) => {
  try {
    // Same guard as the vendor routes: malformed id → clean 404, not a uuid 500.
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Application not found.' });
    }

    const { data: app, error: appErr } = await supabaseAdmin
      .from('vendor_applications')
      .select('id, business_name, email, password_hash, address, location_label, locations, logo, cuisine, price_level')
      .eq('id', req.params.id)
      .maybeSingle();
    if (appErr) throw appErr;
    // Already accepted/rejected (double-click, or a second admin got there first).
    if (!app) return res.status(404).json({ error: 'NOT_FOUND', message: 'Application not found.' });

    const { vendor, vendors, linkedExisting, conflict } = await onboardVendor({
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
    });
    // The taken email's account vanished mid-accept. Nothing was created, so
    // leave the application queued for a retry.
    if (conflict) {
      return res.status(409).json({
        error: 'EMAIL_EXISTS',
        message: 'This email’s account changed mid-accept. Reload and try again.',
      });
    }

    const { error: delErr } = await supabaseAdmin
      .from('vendor_applications')
      .delete()
      .eq('id', app.id);
    if (delErr) throw delErr; // vendor IS onboarded; surfacing the 500 beats hiding a stuck row

    // `vendors` is every location this accept created, so the dashboard can say
    // "3 locations added" rather than naming only the first.
    res.json({ ok: true, vendor, vendors, linkedExisting });
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

/**
 * GET /api/admin/incentives
 * Every incentive plus the counts the tab draws. Referral counts come from one
 * grouped read rather than a per-row query, so this stays a fixed number of
 * round-trips however many programs exist.
 */
router.get('/incentives', async (req, res, next) => {
  try {
    const { data: rows, error } = await supabaseAdmin
      .from('incentives')
      .select(INCENTIVE_COLS)
      .order('active', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;

    const { data: refs, error: refErr } = await supabaseAdmin
      .from('referrals')
      .select('incentive_id, status');
    if (refErr) throw refErr;

    const stats = new Map();
    for (const r of refs ?? []) {
      const s = stats.get(r.incentive_id) ?? { pending: 0, paid: 0, void: 0 };
      if (s[r.status] !== undefined) s[r.status] += 1;
      stats.set(r.incentive_id, s);
    }

    // How many students a program has actually paid. For a referral program
    // that is roughly its referral count; for a signup bonus it is the only
    // count there is, since nothing else records one.
    const { data: paid, error: pErr } = await supabaseAdmin
      .from('community_grants')
      .select('incentive_id');
    if (pErr) throw pErr;
    const payouts = new Map();
    for (const g of paid ?? []) {
      if (g.incentive_id) payouts.set(g.incentive_id, (payouts.get(g.incentive_id) ?? 0) + 1);
    }

    res.json((rows ?? []).map((row) => ({
      ...row,
      referrals: stats.get(row.id) ?? { pending: 0, paid: 0, void: 0 },
      payouts: payouts.get(row.id) ?? 0,
    })));
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

    const { data: profile, error: pErr } = await supabaseAdmin
      .from('profiles')
      .select('user_id, email')
      .ilike('email', email)
      .maybeSingle();
    if (pErr) throw pErr;
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

    res.status(201).json({ ok: true, student: profile.email, points, newBalance });
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
    const { error } = await supabaseAdmin
      .from('push_subscriptions')
      .upsert({ endpoint, p256dh, auth, user_id: req.user.id, role: 'admin' }, { onConflict: 'endpoint' });
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
 */
export function safeSearch(raw) {
  return String(raw ?? '').replace(/[,()"'\\%*]/g, ' ').trim().slice(0, STUDENT_Q_MAX);
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
    // Two reads for the whole page, not two per student.
    const [bal, comm] = ids.length ? await Promise.all([
      supabaseAdmin.from('point_balances').select('user_id, balance').in('user_id', ids),
      supabaseAdmin.from('community_balances').select('user_id, balance').in('user_id', ids),
    ]) : [{ data: [] }, { data: [] }];
    if (bal.error) throw bal.error;
    if (comm.error) throw comm.error;

    const agg = new Map();   // user_id -> { points, spots }
    for (const b of bal.data ?? []) {
      const a = agg.get(b.user_id) ?? { points: 0, spots: 0 };
      a.points += b.balance ?? 0;
      if ((b.balance ?? 0) > 0) a.spots += 1;   // "spots" = places they can spend today
      agg.set(b.user_id, a);
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

    const [profile, balances, community, txRes, cards, visits, referredBy, referred, notify, subs, terms] =
      await Promise.all([
        supabaseAdmin.from('profiles').select('user_id, name, email, created_at').eq('user_id', id).maybeSingle(),
        supabaseAdmin.from('point_balances').select('vendor_id, balance, updated_at, vendors(name, active)').eq('user_id', id),
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
      ]);
    for (const r of [profile, balances, community, txRes, cards, visits, referredBy, referred, notify, subs, terms]) {
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
      };
      spots.set(vendorId, s);
      return s;
    };
    for (const b of balances.data ?? []) {
      const s = spot(b.vendor_id, b.vendors);
      s.points = b.balance ?? 0;
      s.updatedAt = b.updated_at;
    }
    for (const c of cards.data ?? []) {
      spot(c.vendor_id, c.vendors).visits = c.punches ?? 0;
    }
    const bal = [...spots.values()].sort((a, b) => b.points - a.points || b.visits - a.visits);

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
        points: bal.reduce((s, b) => s + b.points, 0),
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

export default router;
