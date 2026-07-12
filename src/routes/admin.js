import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(requireAdmin);

const DAY = 86_400_000;

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
      supabaseAdmin.from('vendors').select('id', { count: 'exact', head: true }).eq('active', true),
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

export default router;
