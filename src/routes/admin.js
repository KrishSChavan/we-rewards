import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAdmin } from '../middleware/auth.js';
import { geocode } from '../lib/geocode.js';
import { getVapidPublicKey } from '../lib/push.js';
import { isUuid } from '../lib/ids.js';
import { rollupPlatformOverview } from '../lib/analytics.js';
import { generateResetCode, normalizeResetCode } from '../lib/reset-codes.js';
import { validReward, validRatio } from '../lib/rewards.js';

const router = Router();
router.use(requireAdmin);

const DAY = 86_400_000;
const ADDRESS_MAX = 300;   // keep a pasted essay out of the column and the geocoder

// Keep in sync with src/routes/apply.js — the operator's "Add vendor" form is
// the same onboarding as an accepted /join application, so what one accepts the
// other must accept too (and the logo caps must match src/routes/vendor.js,
// since all three run the same client-side shrink-to-128px pipeline).
const NAME_MAX = 80;
const EMAIL_MAX = 254;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;   // bcrypt reads 72 bytes; refuse longer, never truncate
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGO_MAX_CHARS = 500_000;
const LOGO_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

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
  const logo = b.logo == null || b.logo === '' ? null : String(b.logo);

  if (!EMAIL_RE.test(email) || email.length > EMAIL_MAX) return { error: 'Enter a valid email address.' };
  if (password.length < PASSWORD_MIN) return { error: `Password must be at least ${PASSWORD_MIN} characters.` };
  if (password.length > PASSWORD_MAX) return { error: `Password must be ${PASSWORD_MAX} characters or fewer.` };
  if (address.length > ADDRESS_MAX) return { error: `Address must be ${ADDRESS_MAX} characters or fewer.` };
  if (logo !== null && (logo.length > LOGO_MAX_CHARS || !LOGO_DATA_URL.test(logo))) {
    return { error: 'Logo image looks invalid, try re-picking it.' };
  }

  return { name: n.value, email, password, address: address || null, logo };
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
        .select('type, points, dollar_amount, created_at, user_id, vendor_id, vendors(name)')
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
      .select('id, name, slug, active, points_per_dollar, address, latitude, longitude, created_at')
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

/**
 * Onboard a vendor: auth login → vendors row → vendor_staff link, the same three
 * steps as scripts/onboard-vendor.js. `passwordHash` (an application's stored
 * bcrypt hash) and `password` (plaintext the operator just typed) are the two
 * ways to set the login's credential; pass exactly one. Ratio/tiers stay at
 * table defaults and pin_hash stays null (redeem is ungated until the vendor
 * sets a PIN in terminal Settings).
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
 * leaves a clean slate to retry from. Returns { vendor, linkedExisting }, or
 * { conflict: true } when the taken email's account vanished mid-flight.
 */
async function onboardVendor({ name, email, password, passwordHash, address, logo }) {
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

  // A geocode miss is never fatal (matches onboard-vendor.js / PATCH vendors):
  // the address is kept, the student card just shows no map until it's edited.
  const coords = address ? await geocode(address) : null;

  // Slug collisions get a numeric suffix (local-eats, local-eats-2, …). Bounded
  // so a pathological name can't loop forever; on exhaustion or any other
  // failure, unwind so a retry starts clean.
  const base = slugify(name);
  let vendor = null;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, error } = await supabaseAdmin
        .from('vendors')
        .insert({
          name,
          slug: attempt ? `${base}-${attempt + 1}` : base,
          address: address ?? null,
          latitude: coords?.lat ?? null,
          longitude: coords?.lng ?? null,
          logo: logo ?? null,
        })
        .select('id, name, slug')
        .single();
      if (!error) { vendor = data; break; }
      if (error.code !== '23505') throw error;
    }
    if (!vendor) throw new Error('SLUG_EXHAUSTED');

    const { error: staffErr } = await supabaseAdmin
      .from('vendor_staff')
      .insert({ vendor_id: vendor.id, user_id: userId, role: 'owner' });
    if (staffErr) throw staffErr;
  } catch (err) {
    if (vendor) await supabaseAdmin.from('vendors').delete().eq('id', vendor.id).then(() => {}, () => {});
    // Unwind only a login WE created. A linked pre-existing account (a
    // student's, possibly) must survive a failed onboard untouched.
    if (!linkedExisting) await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
    throw err;
  }

  return { vendor, linkedExisting };
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
 * PATCH /api/admin/vendors/:id  { name?, active?, address?, pointsPerDollar? }
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

    if (body.pointsPerDollar != null) {
      const r = validRatio(body.pointsPerDollar);
      if (r.error) return res.status(400).json({ error: 'BAD_REQUEST', message: r.error });
      updates.points_per_dollar = r.value;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Nothing to update (send name, active, address, and/or pointsPerDollar).' });
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
      .select('id, name, slug, active, points_per_dollar, address, latitude, longitude, created_at')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'NOT_FOUND', message: 'Vendor not found.' });
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
      .select('id, business_name, contact_name, phone, email, address, logo, message, created_at')
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
      .select('id, business_name, email, password_hash, address, logo')
      .eq('id', req.params.id)
      .maybeSingle();
    if (appErr) throw appErr;
    // Already accepted/rejected (double-click, or a second admin got there first).
    if (!app) return res.status(404).json({ error: 'NOT_FOUND', message: 'Application not found.' });

    const { vendor, linkedExisting, conflict } = await onboardVendor({
      name: app.business_name,
      email: app.email,
      passwordHash: app.password_hash,
      address: app.address,
      logo: app.logo,
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

    res.json({ ok: true, vendor, linkedExisting });
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
      .upsert({ endpoint, p256dh, auth, user_id: req.user.id }, { onConflict: 'endpoint' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/errors?source=&limit=
 * The most recent error_logs rows (server 500s + client-reported errors),
 * newest first. Optional `source` filter (server|student|vendor|admin).
 */
router.get('/errors', async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const source = req.query.source;

    let q = supabaseAdmin
      .from('error_logs')
      .select('id, source, message, stack, path, method, status, user_id, user_agent, context, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (source && ['server', 'student', 'vendor', 'admin'].includes(source)) {
      q = q.eq('source', source);
    }
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
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
