import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireUser } from '../middleware/auth.js';

const router = Router();
router.use(requireUser);

/**
 * GET /api/me/balances
 * All vendors + this student's balance at each (0 if never visited),
 * plus each vendor's active rewards so the app can show "1 punch away" style progress.
 */
router.get('/balances', async (req, res, next) => {
  try {
    const [{ data: vendors, error: vErr }, { data: balances, error: bErr }] = await Promise.all([
      supabaseAdmin.from('vendors').select('id, name, slug, rewards(id, title, cost_in_points, emoji, active)').eq('active', true).order('created_at', { ascending: true }),
      supabaseAdmin.from('point_balances').select('vendor_id, balance').eq('user_id', req.user.id),
    ]);
    if (vErr) throw vErr;
    if (bErr) throw bErr;

    const balanceMap = Object.fromEntries((balances ?? []).map((b) => [b.vendor_id, b.balance]));
    res.json(
      (vendors ?? []).map((v) => ({
        vendorId: v.id,
        name: v.name,
        slug: v.slug,
        balance: balanceMap[v.id] ?? 0,
        rewards: (v.rewards ?? []).filter((r) => r.active),
      }))
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/earn-code
 * The 6-char A–Z0–9 identity code the student shows to earn points. The RPC
 * reuses the student's live code (stable across the app's periodic refresh) and
 * guarantees it's unique across all live codes. Client refreshes every ~2 min.
 */
router.post('/earn-code', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin.rpc('create_earn_code', {
      p_user_id: req.user.id,
      p_ttl_seconds: 300,
    });
    if (error) throw error;
    res.json({ code: data, ttlSeconds: 300 });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/redeem-code  { vendorId, rewardId }
 * Pre-checks affordability so the student gets a clear error before showing a
 * code, then mints a unique 4-digit redemption code (one live code per student).
 * The final atomic check + single-use consumption happens in redeem_by_code.
 */
router.post('/redeem-code', async (req, res, next) => {
  try {
    const { vendorId, rewardId } = req.body ?? {};
    if (!vendorId || !rewardId) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'vendorId and rewardId required.' });
    }

    const [{ data: reward }, { data: bal }] = await Promise.all([
      supabaseAdmin.from('rewards').select('cost_in_points, active').eq('id', rewardId).eq('vendor_id', vendorId).maybeSingle(),
      supabaseAdmin.from('point_balances').select('balance').eq('user_id', req.user.id).eq('vendor_id', vendorId).maybeSingle(),
    ]);

    if (!reward?.active) throw new Error('REWARD_NOT_FOUND');
    if ((bal?.balance ?? 0) < reward.cost_in_points) throw new Error('INSUFFICIENT_POINTS');

    const { data, error } = await supabaseAdmin.rpc('create_redeem_code', {
      p_user_id: req.user.id,
      p_vendor_id: vendorId,
      p_reward_id: rewardId,
      p_ttl_seconds: 120,
    });
    if (error) throw error;
    res.json({ code: data, ttlSeconds: 120 });
  } catch (err) {
    next(err);
  }
});

/** GET /api/me/history — recent activity for the student's profile tab */
router.get('/history', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select('id, vendor_id, type, points, created_at, vendors(name), rewards(title)')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
