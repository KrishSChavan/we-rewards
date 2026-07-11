import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '../lib/supabase.js';
import { computeTierProfile, persistTierSnapshot } from '../lib/tiers.js';
import { requireVendor, requirePin } from '../middleware/auth.js';
import { emitBalance } from '../lib/realtime.js';

// A staff PIN session (from verify-pin) stays valid for one shift.
const PIN_SESSION_HOURS = 8;

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
      computeTierProfile(userId), // read-only: scan just displays the tier
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
    // can't bump its own multiplier mid-award. Server-side recompute is
    // required (never trust a multiplier sent by the terminal).
    const tierProfile = await computeTierProfile(userId);
    const { tier, multiplier } = tierProfile;
    // Floor to whole points: multipliers can be fractional (e.g. 1.5x) but
    // points/balances are integer columns and award_points takes an integer.
    const points = Math.floor(basePoints * multiplier);

    const { data, error } = await supabaseAdmin.rpc('award_points', {
      p_user_id: userId,
      p_vendor_id: req.vendor.id,
      p_points: points,
      p_dollar_amount: dollarAmount,
    });
    if (error) throw error;

    const newBalance = data?.[0]?.new_balance;
    emitBalance(userId, { vendorId: req.vendor.id, balance: newBalance }); // live push
    // Snapshot the score for analytics — off the critical path, non-fatal.
    persistTierSnapshot(userId, tierProfile).catch(() => {});

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
router.post('/redeem-preview', requirePin, async (req, res, next) => {
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
router.post('/redeem', requirePin, async (req, res, next) => {
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
router.post('/rewards', requirePin, async (req, res, next) => {
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
router.patch('/rewards/:id', requirePin, async (req, res, next) => {
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
 * On a correct PIN, mints a server-side session token (vendor_pin_sessions) the
 * terminal must send as `X-Vendor-Pin` on redeem/manage requests — so the PIN is
 * enforced server-side, not just in the UI. Token is memory-only client-side, so
 * a page reload re-asks; it also expires server-side after one shift.
 */
router.post('/verify-pin', async (req, res, next) => {
  try {
    const { pin } = req.body ?? {};
    if (!req.vendor.pin_hash) return res.json({ ok: true, note: 'No PIN set for this vendor.' });
    const ok = await bcrypt.compare(String(pin ?? ''), req.vendor.pin_hash);
    if (!ok) return res.status(401).json({ error: 'BAD_PIN', message: 'Incorrect PIN.' });

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + PIN_SESSION_HOURS * 60 * 60 * 1000).toISOString();
    // housekeeping: clear this vendor's expired sessions, then record the new one
    await supabaseAdmin.from('vendor_pin_sessions').delete().lt('expires_at', new Date().toISOString());
    const { error } = await supabaseAdmin.from('vendor_pin_sessions').insert({
      token,
      vendor_id: req.vendor.id,
      user_id: req.user.id,
      expires_at: expiresAt,
    });
    if (error) throw error;

    res.json({ ok: true, token });
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

/**
 * GET /api/vendor/analytics  (PIN-gated — owner-level revenue/customer data)
 * Aggregates this vendor's last 30 local days of transactions into today /
 * 7-day / 30-day totals, a 14-day daily series, and top redeemed rewards.
 * One query + in-memory rollup; transactions is the source of truth (not the
 * user_scores cache).
 */
router.get('/analytics', requirePin, async (req, res, next) => {
  try {
    const DAY = 86_400_000;
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const t0 = startToday.getTime();      // start of today, server-local
    const t7 = t0 - 6 * DAY;              // start of the 7-day window (incl. today)
    const since = new Date(t0 - 29 * DAY).toISOString(); // 30 local days incl. today

    const { data: txns, error } = await supabaseAdmin
      .from('transactions')
      .select('type, points, dollar_amount, created_at, user_id, rewards(title)')
      .eq('vendor_id', req.vendor.id)
      .gte('created_at', since)
      .limit(10_000);
    if (error) throw error;

    const dayKey = (ms) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const blank = () => ({ earnPoints: 0, redeemPoints: 0, awards: 0, redemptions: 0, revenue: 0, customers: new Set() });
    const today = blank(), last7 = blank(), last30 = blank();
    const custDays = new Map();   // user_id -> Set(dayKey)  (returning-customer calc)
    const dayAgg = new Map();     // dayKey  -> { revenue, awards, earnPoints }
    const rewardCounts = new Map(); // reward title -> redemption count

    for (const tx of txns ?? []) {
      const ms = new Date(tx.created_at).getTime();
      const earn = tx.type === 'earn';
      const pts = Number(tx.points) || 0;
      const rev = earn ? Number(tx.dollar_amount) || 0 : 0;

      const add = (b) => {
        if (earn) { b.earnPoints += pts; b.awards += 1; b.revenue += rev; }
        else { b.redeemPoints += Math.abs(pts); b.redemptions += 1; }
        if (tx.user_id) b.customers.add(tx.user_id);
      };
      add(last30);
      if (ms >= t7) add(last7);
      if (ms >= t0) add(today);

      const k = dayKey(ms);
      if (earn && tx.user_id) {
        if (!custDays.has(tx.user_id)) custDays.set(tx.user_id, new Set());
        custDays.get(tx.user_id).add(k);
      }
      if (earn) {
        const da = dayAgg.get(k) ?? { revenue: 0, awards: 0, earnPoints: 0 };
        da.revenue += rev; da.awards += 1; da.earnPoints += pts;
        dayAgg.set(k, da);
      } else {
        const title = tx.rewards?.title ?? 'Reward';
        rewardCounts.set(title, (rewardCounts.get(title) ?? 0) + 1);
      }
    }

    const finish = (b) => ({
      earnPoints: b.earnPoints,
      redeemPoints: b.redeemPoints,
      awards: b.awards,
      redemptions: b.redemptions,
      revenue: Number(b.revenue.toFixed(2)),
      customers: b.customers.size,
    });

    const daily = [];
    for (let i = 13; i >= 0; i--) {
      const k = dayKey(t0 - i * DAY);
      const da = dayAgg.get(k) ?? { revenue: 0, awards: 0, earnPoints: 0 };
      daily.push({ date: k, revenue: Number(da.revenue.toFixed(2)), awards: da.awards, earnPoints: da.earnPoints });
    }

    const topRewards = [...rewardCounts.entries()]
      .map(([title, count]) => ({ title, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    res.json({
      today: finish(today),
      last7: finish(last7),
      last30: { ...finish(last30), returningCustomers: [...custDays.values()].filter((s) => s.size >= 2).length },
      daily,
      topRewards,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
