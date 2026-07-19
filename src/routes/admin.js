import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAdmin } from '../middleware/auth.js';
import { geocode } from '../lib/geocode.js';
import { getVapidPublicKey } from '../lib/push.js';
import { isUuid } from '../lib/ids.js';
import { rollupPlatformOverview } from '../lib/analytics.js';

const router = Router();
router.use(requireAdmin);

const DAY = 86_400_000;
const ADDRESS_MAX = 300;   // keep a pasted essay out of the column and the geocoder

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
    res.json(data ?? []);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/admin/vendors/:id  { active?: boolean, address?: string }
 * Operator edits for one vendor. Two independent updates:
 *  - `active` is the kill-switch. Off = fully cut off: hidden from students
 *    (active=true filters) and its terminal is blocked at requireVendor.
 *    Non-destructive — balances, rewards, and history are preserved, so
 *    toggling back on restores the vendor exactly as it was.
 *  - `address` sets/clears the street address shown as a map on the student
 *    card. It's geocoded (Nominatim) so latitude/longitude stay in sync; a
 *    geocode miss keeps the address but drops coords (no map until it resolves).
 *    Sending '' clears the address and its coordinates.
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

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Nothing to update (send active and/or address).' });
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

    // Remove each login that's now orphaned (no remaining vendor_staff link).
    for (const { user_id: uid } of staff ?? []) {
      const { count } = await supabaseAdmin
        .from('vendor_staff')
        .select('vendor_id', { count: 'exact', head: true })
        .eq('user_id', uid);
      if (!count) {
        await supabaseAdmin.auth.admin.deleteUser(uid).catch(() => {});
      }
    }

    res.json({ ok: true, id: data.id });
  } catch (err) {
    next(err);
  }
});

/* ---------- vendor applications (public /join queue) ---------- */

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
 * Onboard the applicant — the same three steps as scripts/onboard-vendor.js:
 * auth login → vendors row → vendor_staff link — then delete the application.
 * The login is created from the stored bcrypt hash (password_hash), so the
 * vendor signs in with the password they chose when applying. Ratio/tiers stay at
 * table defaults and pin_hash stays null (redeem is ungated until the vendor
 * sets a PIN in terminal Settings — existing behavior).
 *
 * Each later step unwinds the earlier ones on failure, and the application row
 * is only deleted at the very end — so any failed accept leaves a clean slate
 * and the application still in the queue to retry.
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

    const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.createUser({
      email: app.email,
      password_hash: app.password_hash,
      email_confirm: true,
    });
    if (userErr) {
      // Someone signed up with this email after the application was submitted.
      if (userErr.code === 'email_exists' || userErr.status === 422) {
        return res.status(409).json({
          error: 'EMAIL_EXISTS',
          message: 'An account with this email already exists — reject this application or resolve it manually.',
        });
      }
      throw userErr;
    }
    const userId = userData.user.id;

    // A geocode miss is never fatal (matches onboard-vendor.js / PATCH vendors):
    // the address is kept, the student card just shows no map until it's edited.
    const coords = app.address ? await geocode(app.address) : null;

    // Slug collisions get a numeric suffix (local-eats, local-eats-2, …). Bounded
    // so a pathological name can't loop forever; on exhaustion or any other
    // failure, unwind the auth user so a retry of accept starts clean.
    const base = slugify(app.business_name);
    let vendor = null;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const { data, error } = await supabaseAdmin
          .from('vendors')
          .insert({
            name: app.business_name,
            slug: attempt ? `${base}-${attempt + 1}` : base,
            address: app.address,
            latitude: coords?.lat ?? null,
            longitude: coords?.lng ?? null,
            logo: app.logo,
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
      await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
      throw err;
    }

    const { error: delErr } = await supabaseAdmin
      .from('vendor_applications')
      .delete()
      .eq('id', app.id);
    if (delErr) throw delErr; // vendor IS onboarded; surfacing the 500 beats hiding a stuck row

    res.json({ ok: true, vendor });
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
