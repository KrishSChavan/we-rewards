import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAdmin } from '../middleware/auth.js';
import { geocode } from '../lib/geocode.js';

const router = Router();
router.use(requireAdmin);

const DAY = 86_400_000;
const ADDRESS_MAX = 300;   // keep a pasted essay out of the column and the geocoder

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

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
        .limit(20_000),
    ]);
    for (const r of [vendors, students, txTotal, newStudents30, newStudents7, newVendors30, errors24h, errorsTotal, txRes]) {
      if (r.error) throw r.error;
    }

    const blank = () => ({ awards: 0, redemptions: 0, pointsAwarded: 0, pointsRedeemed: 0, revenue: 0, students: new Set() });
    const today = blank(), last7 = blank(), last30 = blank();
    const vendorAgg = new Map(); // vendor_id -> { name, revenue, awards }
    const dayAgg = new Map();    // dayKey -> { revenue, awards, redemptions }

    for (const tx of txRes.data ?? []) {
      const ms = new Date(tx.created_at).getTime();
      const earn = tx.type === 'earn';
      const pts = Number(tx.points) || 0;
      const rev = earn ? Number(tx.dollar_amount) || 0 : 0;

      const add = (b) => {
        if (earn) { b.awards += pts >= 0 ? 1 : -1; b.pointsAwarded += pts; b.revenue += rev; }
        else { b.redemptions += pts <= 0 ? 1 : -1; b.pointsRedeemed += -pts; }
        if (tx.user_id) b.students.add(tx.user_id);
      };
      add(last30);
      if (ms >= t7) add(last7);
      if (ms >= t0) add(today);

      if (earn) {
        const va = vendorAgg.get(tx.vendor_id) ?? { name: tx.vendors?.name ?? 'Vendor', revenue: 0, awards: 0 };
        va.revenue += rev; va.awards += pts >= 0 ? 1 : -1;
        vendorAgg.set(tx.vendor_id, va);
      }
      const k = dayKey(ms);
      const da = dayAgg.get(k) ?? { revenue: 0, awards: 0, redemptions: 0 };
      if (earn) { da.revenue += rev; da.awards += pts >= 0 ? 1 : -1; }
      else { da.redemptions += pts <= 0 ? 1 : -1; }
      dayAgg.set(k, da);
    }

    const finish = (b) => ({
      awards: b.awards,
      redemptions: b.redemptions,
      pointsAwarded: b.pointsAwarded,
      pointsRedeemed: b.pointsRedeemed,
      revenue: Number(b.revenue.toFixed(2)),
      activeStudents: b.students.size,
    });

    const daily = [];
    for (let i = 13; i >= 0; i--) {
      const k = dayKey(t0 - i * DAY);
      const da = dayAgg.get(k) ?? { revenue: 0, awards: 0, redemptions: 0 };
      daily.push({ date: k, revenue: Number(da.revenue.toFixed(2)), awards: da.awards, redemptions: da.redemptions });
    }

    const topVendors = [...vendorAgg.values()]
      .map((v) => ({ name: v.name, revenue: Number(v.revenue.toFixed(2)), awards: v.awards }))
      .filter((v) => v.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    res.json({
      totals: {
        vendors: vendors.count ?? 0,
        students: students.count ?? 0,
        transactions: txTotal.count ?? 0,
      },
      today: finish(today),
      last7: { ...finish(last7), newStudents: newStudents7.count ?? 0 },
      last30: { ...finish(last30), newStudents: newStudents30.count ?? 0, newVendors: newVendors30.count ?? 0 },
      daily,
      topVendors,
      errors: { last24h: errors24h.count ?? 0, total: errorsTotal.count ?? 0 },
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
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
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
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
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
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
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
