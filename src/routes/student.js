import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { computeTierProfile } from '../lib/tiers.js';
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
 * The 6-digit identity code the student shows to earn points. The RPC
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
 * code, then mints a unique 4-digit redemption code (one live code per student
 * per vendor — pending redemptions at other vendors are unaffected).
 * The final atomic check + single-use consumption happens in redeem_by_code.
 */
router.post('/redeem-code', async (req, res, next) => {
  try {
    const { vendorId, rewardId } = req.body ?? {};
    if (!vendorId || !rewardId) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'vendorId and rewardId required.' });
    }

    const [{ data: vendorRow }, { data: reward }, { data: bal }] = await Promise.all([
      supabaseAdmin.from('vendors').select('active').eq('id', vendorId).maybeSingle(),
      supabaseAdmin.from('rewards').select('cost_in_points, active').eq('id', rewardId).eq('vendor_id', vendorId).maybeSingle(),
      supabaseAdmin.from('point_balances').select('balance').eq('user_id', req.user.id).eq('vendor_id', vendorId).maybeSingle(),
    ]);

    // Belt-and-suspenders for a stale client: a vendor disabled by the operator
    // between page-load and redeem is cut off here too, not just hidden on the
    // next refresh. (The terminal is already blocked, so the code couldn't be
    // used anyway — this just gives a clear error instead of a dead code.)
    if (!vendorRow?.active) throw new Error('VENDOR_UNAVAILABLE');
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

/**
 * GET /api/me/tier
 * 30-day engagement score + current earn multiplier for the home tier bar.
 */
router.get('/tier', async (req, res, next) => {
  try {
    res.json(await computeTierProfile(req.user.id));
  } catch (err) {
    next(err);
  }
});

/** GET /api/me/history — the student's transactions over the last 30 days */
router.get('/history', async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select('id, vendor_id, type, points, dollar_amount, created_at, vendors(name), rewards(title)')
      .eq('user_id', req.user.id)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/me/export
 * Everything WeRewards holds about the signed-in student, as a JSON download:
 * profile (Google identity we store), per-vendor balances, full transaction
 * history, and the latest engagement-score snapshot. A privacy baseline.
 */
router.get('/export', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const [profile, balances, transactions, scores] = await Promise.all([
      supabaseAdmin.from('profiles').select('user_id, name, email, revisits, created_at').eq('user_id', uid).maybeSingle(),
      supabaseAdmin.from('point_balances').select('vendor_id, balance, updated_at').eq('user_id', uid),
      supabaseAdmin
        .from('transactions')
        .select('id, vendor_id, type, points, dollar_amount, reward_id, created_at, vendors(name), rewards(title)')
        .eq('user_id', uid)
        .order('created_at', { ascending: false }),
      supabaseAdmin.from('user_scores').select('*').eq('user_id', uid).maybeSingle(),
    ]);
    for (const r of [profile, balances, transactions, scores]) if (r.error) throw r.error;

    res.setHeader('Content-Disposition', 'attachment; filename="werewards-data.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      account: { id: uid, email: req.user.email },
      profile: profile.data,
      balances: balances.data ?? [],
      transactions: transactions.data ?? [],
      scores: scores.data,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/delete
 * Deletes the signed-in student's auth user. `on delete cascade` removes the
 * profile, balances, live codes, and score snapshot; transaction rows are kept
 * but anonymized (user_id → null, migration-011) so vendors' revenue totals
 * don't silently change. Irreversible.
 */
router.post('/delete', async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
