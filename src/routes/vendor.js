import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '../lib/supabase.js';
import { getTierProfile } from '../lib/tiers.js';
import { requireVendor } from '../middleware/auth.js';
import { emitBalance } from '../lib/realtime.js';

const router = Router();
router.use(requireVendor);

// ---- short-code resolution (replaces the old signed QR tokens) ----

/** Resolve a live 6-char earn code to its student, or throw CODE_INVALID. */
async function resolveEarnCode(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(c)) throw new Error('CODE_INVALID');
  const { data } = await supabaseAdmin
    .from('earn_codes')
    .select('user_id')
    .eq('code', c)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (!data) throw new Error('CODE_INVALID');
  return data.user_id;
}

/** Resolve a live 4-digit redeem code for THIS vendor, or throw CODE_INVALID. */
async function resolveRedeemCode(code, vendorId) {
  const c = String(code ?? '').trim();
  if (!/^\d{4}$/.test(c)) throw new Error('CODE_INVALID');
  const { data } = await supabaseAdmin
    .from('redeem_codes')
    .select('user_id, reward_id')
    .eq('code', c)
    .eq('vendor_id', vendorId)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (!data) throw new Error('CODE_INVALID');
  return data;
}

/** GET /api/vendor/config — everything the terminal needs to render itself */
router.get('/config', (req, res) => {
  const v = req.vendor;
  res.json({
    vendorId: v.id,
    name: v.name,
    pointsPerDollar: Number(v.points_per_dollar),
    allowExactEntry: v.allow_exact_entry,
    hasPin: Boolean(v.pin_hash),
  });
});

/**
 * POST /api/vendor/scan  { code }
 * Resolve the customer's 6-char earn code so the terminal can show name +
 * balance BEFORE the vendor enters an amount. Doesn't award anything.
 */
router.post('/scan', async (req, res, next) => {
  try {
    const userId = await resolveEarnCode(req.body?.code);
    const [{ data: profile }, { data: bal }, tierProfile] = await Promise.all([
      supabaseAdmin.from('profiles').select('name').eq('user_id', userId).maybeSingle(),
      supabaseAdmin.from('point_balances').select('balance').eq('user_id', userId).eq('vendor_id', req.vendor.id).maybeSingle(),
      getTierProfile(userId),
    ]);
    res.json({
      userId,
      name: profile?.name ?? 'Customer',
      balance: bal?.balance ?? 0,
      tier: tierProfile.tier,
      multiplier: tierProfile.multiplier,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/vendor/award  { code, exactAmount }
 * Resolves the student's earn code, computes points server-side from the
 * vendor's own ratio (never trusts client-sent point values), applies the
 * customer's tier multiplier, and calls the atomic award_points RPC.
 */
router.post('/award', async (req, res, next) => {
  try {
    const { code, exactAmount } = req.body ?? {};
    const userId = await resolveEarnCode(code);
    const ratio = Number(req.vendor.points_per_dollar);

    const dollarAmount = Number(exactAmount);
    if (!Number.isFinite(dollarAmount) || dollarAmount <= 0 || dollarAmount > 500) {
      return res.status(400).json({ error: 'BAD_AMOUNT', message: 'Enter a valid amount.' });
    }
    const basePoints = Math.floor(dollarAmount * ratio);
    if (basePoints < 1) {
      return res.status(400).json({ error: 'BAD_AMOUNT', message: 'Amount is too small to earn points.' });
    }

    // Tier is computed before this purchase lands, so today's transaction
    // can't bump its own multiplier mid-award.
    const { tier, multiplier } = await getTierProfile(userId);
    const points = basePoints * multiplier;

    const { data, error } = await supabaseAdmin.rpc('award_points', {
      p_user_id: userId,
      p_vendor_id: req.vendor.id,
      p_points: points,
      p_dollar_amount: dollarAmount,
    });
    if (error) throw error;

    const newBalance = data?.[0]?.new_balance;
    emitBalance(userId, { vendorId: req.vendor.id, balance: newBalance }); // live push

    const { data: profile } = await supabaseAdmin.from('profiles').select('name').eq('user_id', userId).maybeSingle();
    res.json({
      awarded: points,
      basePoints,
      bonusPoints: points - basePoints,
      tier,
      multiplier,
      newBalance,
      customerName: profile?.name ?? 'Customer',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/vendor/redeem-preview  { code }
 * Looks up the live 4-digit redemption code WITHOUT redeeming — the terminal
 * shows "is this the user?" (name + points + item) and only /redeem deducts.
 */
router.post('/redeem-preview', async (req, res, next) => {
  try {
    const { user_id: userId, reward_id: rewardId } = await resolveRedeemCode(req.body?.code, req.vendor.id);

    const [{ data: profile }, { data: bal }, { data: reward }] = await Promise.all([
      supabaseAdmin.from('profiles').select('name').eq('user_id', userId).maybeSingle(),
      supabaseAdmin.from('point_balances').select('balance').eq('user_id', userId).eq('vendor_id', req.vendor.id).maybeSingle(),
      supabaseAdmin.from('rewards').select('title, cost_in_points, emoji').eq('id', rewardId).eq('vendor_id', req.vendor.id).maybeSingle(),
    ]);
    if (!reward) throw new Error('REWARD_NOT_FOUND');

    res.json({
      name: profile?.name ?? 'Customer',
      balance: bal?.balance ?? 0,
      rewardTitle: reward.title,
      cost: reward.cost_in_points,
      emoji: reward.emoji || '🎁',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/vendor/redeem  { code }
 * Final step after the vendor confirms. redeem_by_code consumes the code and
 * deducts points in ONE transaction — a double-submit finds no code the second
 * time, and any failure rolls back so the code stays live and reusable.
 */
router.post('/redeem', async (req, res, next) => {
  try {
    const code = String(req.body?.code ?? '').trim();
    if (!/^\d{4}$/.test(code)) throw new Error('CODE_INVALID');

    // Whose code is this? (looked up before the RPC consumes it, for the live push)
    const { user_id: userId } = await resolveRedeemCode(code, req.vendor.id);

    const { data, error } = await supabaseAdmin.rpc('redeem_by_code', {
      p_code: code,
      p_vendor_id: req.vendor.id,
    });
    if (error) throw error;
    if (!data?.length) throw new Error('CODE_INVALID');

    const newBalance = data[0].new_balance;
    emitBalance(userId, { vendorId: req.vendor.id, balance: newBalance }); // live push

    res.json({ rewardTitle: data[0].reward_title, newBalance });
  } catch (err) {
    next(err);
  }
});

/** GET /api/vendor/rewards — all rewards incl. inactive, for the Items screen */
router.get('/rewards', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('rewards')
      .select('id, title, cost_in_points, emoji, active, created_at')
      .eq('vendor_id', req.vendor.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

function validReward(title, cost, emoji) {
  const t = String(title ?? '').trim();
  const c = Number(cost);
  const e = String(emoji ?? '🎁').trim().slice(0, 16) || '🎁'; // emoji can be multi-codepoint
  if (!t || t.length > 60) return { error: 'Give the item a name (up to 60 characters).' };
  if (!Number.isInteger(c) || c < 1 || c > 100000) return { error: 'Point cost must be a whole number of at least 1.' };
  return { title: t, cost: c, emoji: e };
}

/** POST /api/vendor/rewards  { title, costInPoints, emoji } */
router.post('/rewards', async (req, res, next) => {
  try {
    const v = validReward(req.body?.title, req.body?.costInPoints, req.body?.emoji);
    if (v.error) return res.status(400).json({ error: 'BAD_REWARD', message: v.error });

    const { data, error } = await supabaseAdmin
      .from('rewards')
      .insert({ vendor_id: req.vendor.id, title: v.title, cost_in_points: v.cost, emoji: v.emoji })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/vendor/rewards/:id  { title?, costInPoints?, emoji?, active? } */
router.patch('/rewards/:id', async (req, res, next) => {
  try {
    const updates = {};
    if (req.body?.title != null || req.body?.costInPoints != null || req.body?.emoji != null) {
      const v = validReward(
        req.body?.title ?? 'placeholder',
        req.body?.costInPoints ?? 1,
        req.body?.emoji
      );
      if (v.error) return res.status(400).json({ error: 'BAD_REWARD', message: v.error });
      if (req.body?.title != null) updates.title = v.title;
      if (req.body?.costInPoints != null) updates.cost_in_points = v.cost;
      if (req.body?.emoji != null) updates.emoji = v.emoji;
    }
    if (typeof req.body?.active === 'boolean') updates.active = req.body.active;
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Nothing to update.' });
    }

    const { data, error } = await supabaseAdmin
      .from('rewards')
      .update(updates)
      .eq('id', req.params.id)
      .eq('vendor_id', req.vendor.id) // vendors can only touch their own rewards
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'NOT_FOUND', message: 'Reward not found.' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/vendor/verify-pin  { pin }
 * Gates redeem + items until the page is refreshed (session lives client-side
 * in memory, so a reload always re-asks).
 */
router.post('/verify-pin', async (req, res, next) => {
  try {
    const { pin } = req.body ?? {};
    if (!req.vendor.pin_hash) return res.json({ ok: true, note: 'No PIN set for this vendor.' });
    const ok = await bcrypt.compare(String(pin ?? ''), req.vendor.pin_hash);
    if (!ok) return res.status(401).json({ error: 'BAD_PIN', message: 'Incorrect PIN.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** GET /api/vendor/recent — last 20 transactions, for the terminal's history strip */
router.get('/recent', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select('id, type, points, dollar_amount, created_at, profiles:user_id(name), rewards(title)')
      .eq('vendor_id', req.vendor.id)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
