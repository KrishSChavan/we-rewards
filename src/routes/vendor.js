import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '../lib/supabase.js';
import { computeTierProfile, persistTierSnapshot } from '../lib/tiers.js';
import { requireVendor, requirePin } from '../middleware/auth.js';
import { emitBalance, emitPunch, emitDeal } from '../lib/realtime.js';
import { CAMPAIGN_CONFIG, CAMPAIGN_DURATIONS } from '../lib/campaigns.js';
import { mintPunchToken, punchUrl, currentWindow, secondsLeftInWindow, PUNCH_WINDOW_SECONDS } from '../lib/punch.js';
import { geocode } from '../lib/geocode.js';
import { isUuid } from '../lib/ids.js';
import { rollupVendorAnalytics } from '../lib/analytics.js';

// Max stored address length — keeps a pasted essay out of the column and the geocoder.
const ADDRESS_MAX = 300;

// Logo is a base64 data-URL, resized to ~128px client-side. Cap the stored
// string (~375KB decoded) so a hand-crafted request can't bloat the row.
const LOGO_MAX_CHARS = 500_000;
const LOGO_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

// A staff PIN session (from verify-pin) stays valid for one shift.
const PIN_SESSION_HOURS = 8;

// Hard per-transaction award ceiling. A single award can never exceed this many
// dollars — the fraud limit on a rogue/lost terminal (award isn't PIN-gated).
// Enforced server-side; there is intentionally NO daily cap and NO PIN bypass.
// Keep in sync with the keypad + quick-button caps in public/vendor/terminal.js
// and validTiers below.
const MAX_AWARD_DOLLARS = 200;

const router = Router();
router.use(requireVendor);

// ---- short-code resolution (replaces the old signed QR tokens) ----

/** Resolve a live 6-digit earn code to its student, or throw CODE_INVALID. */
async function resolveEarnCode(code) {
  const c = String(code ?? '').trim();
  if (!/^[0-9]{6}$/.test(c)) throw new Error('CODE_INVALID');
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
    // paid_with tells the terminal WHICH currency this code spends, so the
    // typed-code path no longer has to guess by trying one preview and falling
    // back to the other (migration-029 folded both code tables into this one).
    .select('user_id, reward_id, paid_with, visits_charged')
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
    tiers: v.tiers ?? [],
    hasPin: Boolean(v.pin_hash),
    punchEnabled: Boolean(v.punch_enabled),
  });
});

/**
 * GET /api/vendor/punch-token
 * The rotating punch-in code for the PUNCH tab. Mints a fresh HMAC-signed URL
 * for the current 30-second slot; the terminal re-asks when expiresIn runs
 * out. Not PIN-gated: displaying the code IS the feature (it can only give
 * students punches), same trust level as the un-gated scan screen.
 */
router.get('/punch-token', (req, res) => {
  const v = req.vendor;
  if (!v.punch_enabled) {
    return res.status(403).json({ error: 'PUNCH_DISABLED', message: 'Turn on visits in Settings first.' });
  }
  const windowIndex = currentWindow();
  const token = mintPunchToken(v.id, windowIndex);
  // Prefer an explicit APP_ORIGIN (prod behind proxies/CDN); otherwise trust
  // the request's own origin — correct in dev and single-host deploys.
  const origin = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
  res.json({
    url: punchUrl(origin, token),
    windowSeconds: PUNCH_WINDOW_SECONDS,
    expiresIn: secondsLeftInWindow(),
  });
});

/**
 * POST /api/vendor/scan  { code }
 * Resolve the customer's 6-digit earn code so the terminal can show name +
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
    const { code, exactAmount, requestId } = req.body ?? {};
    const userId = await resolveEarnCode(code);
    const ratio = Number(req.vendor.points_per_dollar);

    // Idempotency key: a client-generated token the terminal reuses when it
    // retries an award after a network failure (see terminal.js). award_points
    // treats a repeat token as a no-op, so a retry can't double-award. A missing
    // or malformed token just falls back to the non-idempotent path (still works).
    const clientToken = (typeof requestId === 'string' && /^[\w-]{8,64}$/.test(requestId))
      ? requestId
      : null;

    const dollarAmount = Number(exactAmount);
    if (!Number.isFinite(dollarAmount) || dollarAmount <= 0) {
      return res.status(400).json({ error: 'BAD_AMOUNT', message: 'Enter a valid amount.' });
    }
    // Hard single-transaction ceiling — no daily cap, no PIN override.
    if (dollarAmount > MAX_AWARD_DOLLARS) {
      return res.status(400).json({ error: 'AMOUNT_TOO_LARGE', message: `Max award ($${MAX_AWARD_DOLLARS}) reached` });
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
      p_client_token: clientToken,
    });
    if (error) throw error;

    const newBalance = data?.[0]?.new_balance;
    // award_points also mints 10% into the student's cross-vendor pool
    // (migration-026). One event carries both numbers: the student app reads
    // payload.community when it's there and refetches when it isn't
    // (public/student/app.js), so no new room or event type is needed.
    const newCommunity = data?.[0]?.new_community;
    emitBalance(userId, { vendorId: req.vendor.id, balance: newBalance, community: newCommunity }); // live push
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
    const { user_id: userId, reward_id: rewardId, paid_with: paidWith, visits_charged: visitsCharged } =
      await resolveRedeemCode(req.body?.code, req.vendor.id);

    const [{ data: profile }, { data: bal }, { data: reward }, { data: card }] = await Promise.all([
      supabaseAdmin.from('profiles').select('name').eq('user_id', userId).maybeSingle(),
      supabaseAdmin.from('point_balances').select('balance').eq('user_id', userId).eq('vendor_id', req.vendor.id).maybeSingle(),
      supabaseAdmin.from('rewards').select('title, cost_in_points, emoji').eq('id', rewardId).eq('vendor_id', req.vendor.id).maybeSingle(),
      supabaseAdmin.from('punch_cards').select('punches').eq('user_id', userId).eq('vendor_id', req.vendor.id).maybeSingle(),
    ]);
    if (!reward) throw new Error('REWARD_NOT_FOUND');

    res.json({
      name: profile?.name ?? 'Customer',
      balance: bal?.balance ?? 0,
      rewardTitle: reward.title,
      cost: reward.cost_in_points,
      emoji: reward.emoji || '🎁',
      paidWith,
      // The confirm screen names both numbers so staff can see the forfeit
      // before they tap: redeeming a 5-visit reward with 12 banked spends all 12.
      visitsCharged: visitsCharged ?? null,
      visitsBalance: card?.punches ?? 0,
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

    const { new_balance: newBalance, reward_title: rewardTitle,
            paid_with: paidWith, visits_left: visitsLeft } = data[0];
    emitBalance(userId, { vendorId: req.vendor.id, balance: newBalance }); // live push

    // A visits redemption doesn't move the points balance, so the balance push
    // alone leaves the student's counter showing its pre-reset value and the
    // reward still rendering as redeemable — inviting a second tap that fails.
    if (paidWith === 'visits') {
      emitPunch(userId, {
        vendorId: req.vendor.id,
        visits: visitsLeft,
        redeemed: true,
        reward: rewardTitle,
      });
    }

    res.json({ rewardTitle, newBalance, paidWith, visitsLeft });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/vendor/visit-impact?from=<int>&to=<int>
 * How many of this vendor's customers can afford a reward at the CURRENT visit
 * price but could not at a higher one. Read-only preflight for the Items form,
 * which warns before a vendor raises a visit price — unlike points, visits take
 * weeks to accumulate, so silently pushing a reward out of reach stings.
 */
router.get('/visit-impact', requirePin, async (req, res, next) => {
  try {
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to <= from) {
      return res.json({ affected: 0 });
    }
    const { count, error } = await supabaseAdmin
      .from('punch_cards')
      .select('user_id', { count: 'exact', head: true })
      .eq('vendor_id', req.vendor.id)
      .gte('punches', from)
      .lt('punches', to);
    if (error) throw error;
    res.json({ affected: count ?? 0 });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/vendor/reverse  { transactionId }
 * Void a transaction the vendor made in error (wrong amount, wrong item). The
 * atomic reverse_transaction RPC writes a compensating row (never deletes),
 * adjusts the balance (clamped at 0), and refuses to double-reverse — see
 * migration-010. PIN-gated: this moves points, so it's owner-level.
 */
router.post('/reverse', requirePin, async (req, res, next) => {
  try {
    const transactionId = String(req.body?.transactionId ?? '').trim();
    if (!isUuid(transactionId)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'A transaction to undo is required.' });
    }

    const { data, error } = await supabaseAdmin.rpc('reverse_transaction', {
      p_transaction_id: transactionId,
      p_vendor_id: req.vendor.id,
    });
    if (error) throw error;
    if (!data?.length) throw new Error('TX_NOT_FOUND');

    const { affected_user: userId, new_balance: newBalance, reversed_type: type,
            reversed_points: points, paid_with: paidWith, restored_visits: restoredVisits } = data[0];
    emitBalance(userId, { vendorId: req.vendor.id, balance: newBalance }); // live push to the student

    // Undoing a visits redemption adds the forfeited visits back, so the
    // student's counter has to hear about it the same way a fill does.
    if (restoredVisits > 0) {
      const { data: card } = await supabaseAdmin
        .from('punch_cards').select('punches')
        .eq('user_id', userId).eq('vendor_id', req.vendor.id).maybeSingle();
      emitPunch(userId, { vendorId: req.vendor.id, visits: card?.punches ?? 0 });
    }

    res.json({ newBalance, type, points, paidWith, restoredVisits });
  } catch (err) {
    next(err);
  }
});

/** GET /api/vendor/rewards — all rewards incl. inactive, for the Items screen */
router.get('/rewards', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('rewards')
      .select('id, title, cost_in_points, cost_in_visits, emoji, active, created_at')
      .eq('vendor_id', req.vendor.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// A price is: a positive integer, or null meaning "not sold in this currency".
// Blank string counts as null so an emptied form field clears the price.
function validPrice(raw, label, max) {
  if (raw == null || raw === '') return { value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    return { error: `${label} must be a whole number from 1 to ${max}.` };
  }
  return { value: n };
}

// Mirrors the DB's rewards_has_a_price CHECK (migration-029): points, visits,
// or both, but never neither.
function validReward(title, cost, visits, emoji) {
  const t = String(title ?? '').trim();
  const e = String(emoji ?? '🎁').trim().slice(0, 16) || '🎁'; // emoji can be multi-codepoint
  if (!t || t.length > 60) return { error: 'Give the item a name (up to 60 characters).' };

  const p = validPrice(cost, 'Point cost', 100000);
  if (p.error) return { error: p.error };
  const v = validPrice(visits, 'Visit cost', 50);
  if (v.error) return { error: v.error };
  if (p.value == null && v.value == null) {
    return { error: 'Set a point cost, a visit cost, or both.' };
  }
  return { title: t, cost: p.value, visits: v.value, emoji: e };
}

/** POST /api/vendor/rewards  { title, costInPoints, costInVisits, emoji } */
router.post('/rewards', requirePin, async (req, res, next) => {
  try {
    const v = validReward(req.body?.title, req.body?.costInPoints, req.body?.costInVisits, req.body?.emoji);
    if (v.error) return res.status(400).json({ error: 'BAD_REWARD', message: v.error });

    const { data, error } = await supabaseAdmin
      .from('rewards')
      .insert({
        vendor_id: req.vendor.id,
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

/** PATCH /api/vendor/rewards/:id  { title?, costInPoints?, costInVisits?, emoji?, active? } */
router.patch('/rewards/:id', requirePin, async (req, res, next) => {
  try {
    // A malformed id is a clean 404, not a uuid-cast 500 in the update query.
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Reward not found.' });
    }

    const touchesFields =
      req.body?.title !== undefined || req.body?.costInPoints !== undefined ||
      req.body?.costInVisits !== undefined || req.body?.emoji !== undefined;

    const updates = {};
    if (touchesFields) {
      // Merge against the STORED row rather than validating placeholder
      // sentinels. The old code passed `costInPoints ?? 1`, which meant a
      // partial PATCH silently revalidated a dummy price and, worse, made
      // clearing a price impossible — the exact operation dual pricing needs.
      const { data: current } = await supabaseAdmin
        .from('rewards').select('title, cost_in_points, cost_in_visits, emoji')
        .eq('id', req.params.id).eq('vendor_id', req.vendor.id).maybeSingle();
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
      .eq('id', req.params.id)
      .eq('vendor_id', req.vendor.id) // vendors can only touch their own rewards
      .select()
      .maybeSingle();
    if (error) {
      // The DB CHECK is the backstop for anything the merge above missed;
      // surface it as a readable 400 rather than a raw 500.
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

    // Per-vendor lockout (independent of the per-IP pinLimiter): if this vendor
    // is currently locked from too many wrong PINs, refuse before checking, so
    // an attacker rotating IPs still can't keep guessing.
    const lockedUntil = req.vendor.pin_locked_until ? new Date(req.vendor.pin_locked_until) : null;
    if (lockedUntil && lockedUntil > new Date()) {
      return res.status(429).json({
        error: 'PIN_LOCKED',
        message: 'Too many incorrect PINs. Wait a few minutes and try again.',
        retryAfterSeconds: Math.ceil((lockedUntil - Date.now()) / 1000),
      });
    }

    const ok = await bcrypt.compare(String(pin ?? ''), req.vendor.pin_hash);
    if (!ok) {
      // Record the failure atomically; the RPC locks the vendor at the threshold.
      const { data: lock } = await supabaseAdmin.rpc('record_pin_result', {
        p_vendor_id: req.vendor.id, p_success: false,
      });
      const newLock = lock?.[0]?.locked_until ? new Date(lock[0].locked_until) : null;
      if (newLock && newLock > new Date()) {
        return res.status(429).json({
          error: 'PIN_LOCKED',
          message: 'Too many incorrect PINs. Wait a few minutes and try again.',
          retryAfterSeconds: Math.ceil((newLock - Date.now()) / 1000),
        });
      }
      return res.status(401).json({ error: 'BAD_PIN', message: 'Incorrect PIN.' });
    }

    // Correct PIN — clear any accumulated failure count / lock.
    await supabaseAdmin.rpc('record_pin_result', { p_vendor_id: req.vendor.id, p_success: true });

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

/** GET /api/vendor/recent — last 20 transactions, for the terminal's history strip.
 *  Includes reversal links so the UI can mark rows already voided (reversed_by)
 *  and the compensating rows themselves (reverses) as not undoable. */
router.get('/recent', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('transactions')
      // paid_with / visits_spent so the Undo copy can say "visits restored"
      // instead of "points refunded" on a visits redemption (points there is 0).
      .select('id, type, points, dollar_amount, paid_with, visits_spent, created_at, reverses, reversed_by, profiles:user_id(name), rewards(title)')
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
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const t0 = startToday.getTime();      // start of today, server-local
    const since = new Date(t0 - 29 * 86_400_000).toISOString(); // 30 local days incl. today

    // Cap the fetch, but detect when we hit it: past TX_LIMIT rows in the window,
    // the rollup silently undercounts. Rare at pilot scale; the `truncated` flag
    // lets the UI warn and signals it's time to aggregate in SQL instead.
    const TX_LIMIT = 10_000;
    const { data: txns, error } = await supabaseAdmin
      .from('transactions')
      .select('type, points, dollar_amount, created_at, user_id, rewards(title)')
      .eq('vendor_id', req.vendor.id)
      .gte('created_at', since)
      .limit(TX_LIMIT);
    if (error) throw error;

    const truncated = (txns?.length ?? 0) >= TX_LIMIT;
    if (truncated) {
      console.warn(`[analytics] vendor ${req.vendor.id} hit the ${TX_LIMIT}-row cap — 30-day totals may undercount.`);
    }

    res.json({ ...rollupVendorAnalytics(txns ?? [], t0), truncated });
  } catch (err) {
    next(err);
  }
});

/* ---------- campaigns: deals pushed to a vendor's own customers ---------- */

const CAMPAIGN_TITLE_MAX = 60;
const CAMPAIGN_BODY_MAX = 140;
const CAMPAIGN_KINDS = new Set(['deal', 'event', 'notice']);
const CAMPAIGN_AUDIENCES = new Set(['top', 'lapsed', 'close']);
// "Top 100" is the product promise; the RPC clamps to this too.
const CAMPAIGN_AUDIENCE_MAX = 100;

/**
 * Campaigns this vendor has sent in the rolling week, for the quota display.
 *
 * EVERY campaign counts, including one that was taken down. Taking a deal down
 * does not give the send back, and the reason is worth stating: a campaign is
 * "delivered" the moment create_campaign writes its recipient rows, because the
 * in-app deals list is materialised there and is never throttled. sent_count
 * only ever counts the PUSH half — it stays 0 when push is unconfigured, and in
 * a small pilot it stays 0 most of the time anyway. Refunding on sent_count = 0
 * would therefore have made "send, let it run, take down, send again" an
 * unlimited in-app fan-out against a 2-per-week cap.
 *
 * The typo case that would otherwise argue for a refund is covered by PATCH:
 * fixing the wording costs nothing and does not need a takedown at all.
 *
 * Mirrored in create_campaign (migration-034) — the display and the enforcement
 * must agree, or a vendor sees sends they cannot spend.
 */
async function campaignQuota(vendorId) {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { count } = await supabaseAdmin
    .from('vendor_campaigns')
    .select('id', { count: 'exact', head: true })
    .eq('vendor_id', vendorId)
    .gte('created_at', since);
  const used = count ?? 0;
  return {
    used,
    perWeek: CAMPAIGN_CONFIG.vendorWeeklySends,
    left: Math.max(0, CAMPAIGN_CONFIG.vendorWeeklySends - used),
  };
}

/**
 * GET /api/vendor/campaigns
 * The DEALS tab: what this vendor has sent, how many sends are left this week,
 * and the delivery rules to show in the composer. PIN-gated (a campaign speaks
 * to customers in the vendor's name, which is owner-level).
 */
router.get('/campaigns', requirePin, async (req, res, next) => {
  try {
    const [{ data, error }, quota] = await Promise.all([
      supabaseAdmin
        .from('vendor_campaigns')
        .select('id, title, body, kind, audience, status, queued_count, sent_count, deliver_after, expires_at, created_at')
        .eq('vendor_id', req.vendor.id)
        .order('created_at', { ascending: false })
        .limit(20),
      campaignQuota(req.vendor.id),
    ]);
    if (error) throw error;

    // Opens are a per-campaign count over the recipient ledger. One extra query
    // for the whole page rather than one per row.
    const ids = (data ?? []).map((c) => c.id);
    const opens = new Map();
    if (ids.length) {
      const { data: rows } = await supabaseAdmin
        .from('campaign_recipients')
        .select('campaign_id, opened_at')
        .in('campaign_id', ids)
        .not('opened_at', 'is', null);
      for (const r of rows ?? []) opens.set(r.campaign_id, (opens.get(r.campaign_id) ?? 0) + 1);
    }

    res.json({
      quota,
      durations: CAMPAIGN_DURATIONS,
      // Shown in the composer so a vendor understands why delivery is not
      // instant, and can see it is a fairness rule rather than a bug.
      delivery: {
        holdMinutes: CAMPAIGN_CONFIG.coalesceMinutes,
        quietStart: CAMPAIGN_CONFIG.quietStart,
        quietEnd: CAMPAIGN_CONFIG.quietEnd,
      },
      campaigns: (data ?? []).map((c) => ({ ...c, opened_count: opens.get(c.id) ?? 0 })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/vendor/campaigns/reach?audience=top
 * How many students an audience currently resolves to. A COUNT, deliberately:
 * a vendor never learns who is on the list, only how big it is. (Privacy Policy
 * §"Marketing communications".)
 */
router.get('/campaigns/reach', requirePin, async (req, res, next) => {
  try {
    const audience = String(req.query.audience ?? 'top');
    if (!CAMPAIGN_AUDIENCES.has(audience)) {
      return res.status(400).json({ error: 'BAD_AUDIENCE', message: 'Pick a valid audience.' });
    }
    const { data, error } = await supabaseAdmin.rpc('campaign_audience', {
      p_vendor_id: req.vendor.id,
      p_audience: audience,
      p_limit: CAMPAIGN_AUDIENCE_MAX,
    });
    if (error) throw error;
    res.json({ audience, reach: data?.length ?? 0, max: CAMPAIGN_AUDIENCE_MAX });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/vendor/campaigns  { title, body, kind, audience, durationHours, requestId }
 *
 * ENQUEUES. Nothing is delivered on this request: create_campaign writes one
 * recipient row per targeted student (their in-app list is live immediately)
 * and sets a release time a few minutes out. The worker in lib/campaigns.js
 * decides what each student actually receives, subject to the per-student
 * cooldown and caps that make a five-vendor pile-up impossible.
 *
 * `requestId` is the same idempotency contract as /award: a retry after a
 * network drop returns the original campaign instead of fanning out twice.
 */
router.post('/campaigns', requirePin, async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const title = String(b.title ?? '').trim();
    const body = String(b.body ?? '').trim();
    const kind = String(b.kind ?? 'deal');
    const audience = String(b.audience ?? 'top');
    const durationHours = Number(b.durationHours ?? CAMPAIGN_CONFIG.defaultDurationHours);

    if (!title || title.length > CAMPAIGN_TITLE_MAX) {
      return res.status(400).json({
        error: 'BAD_CAMPAIGN',
        message: `Give the deal a headline (up to ${CAMPAIGN_TITLE_MAX} characters).`,
      });
    }
    if (!body || body.length > CAMPAIGN_BODY_MAX) {
      return res.status(400).json({
        error: 'BAD_CAMPAIGN',
        message: `Write the message (up to ${CAMPAIGN_BODY_MAX} characters).`,
      });
    }
    if (!CAMPAIGN_KINDS.has(kind) || !CAMPAIGN_AUDIENCES.has(audience)) {
      return res.status(400).json({ error: 'BAD_CAMPAIGN', message: 'Pick a valid type and audience.' });
    }
    if (!CAMPAIGN_DURATIONS.includes(durationHours)) {
      return res.status(400).json({ error: 'BAD_CAMPAIGN', message: 'Pick how long the deal runs.' });
    }

    const clientToken = (typeof b.requestId === 'string' && /^[\w-]{8,64}$/.test(b.requestId))
      ? b.requestId
      : null;

    const { data, error } = await supabaseAdmin.rpc('create_campaign', {
      p_vendor_id: req.vendor.id,
      p_created_by: req.user.id,
      p_title: title,
      p_body: body,
      p_kind: kind,
      p_audience: audience,
      p_limit: CAMPAIGN_AUDIENCE_MAX,
      p_client_token: clientToken,
      p_coalesce_minutes: CAMPAIGN_CONFIG.coalesceMinutes,
      p_duration_hours: durationHours,
      p_weekly_sends: CAMPAIGN_CONFIG.vendorWeeklySends,
    });
    if (error) throw error;

    const row = data?.[0] ?? {};

    // Nudge any student who already has the app open, so the deal appears in
    // their list without waiting for a poll. Recipient ids stay server-side —
    // they are never in the response the vendor reads. Fire-and-forget: a
    // campaign that is safely queued must not fail on a socket hiccup.
    if (!row.reused) {
      supabaseAdmin
        .from('campaign_recipients')
        .select('user_id')
        .eq('campaign_id', row.campaign_id)
        .then(({ data: rows }) => {
          for (const r of rows ?? []) emitDeal(r.user_id, { campaignId: row.campaign_id });
        }, () => {});
    }

    res.json({
      campaignId: row.campaign_id,
      queued: row.queued ?? 0,
      sendsLeft: row.sends_left ?? 0,
      reused: Boolean(row.reused),
      holdMinutes: CAMPAIGN_CONFIG.coalesceMinutes,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Load one of THIS vendor's campaigns. The vendor_id equality is the whole
 * authorisation story for the two routes below: a campaign id is a uuid a
 * vendor could conceivably learn, and without this check they could rewrite a
 * competitor's live deal.
 */
async function ownCampaign(vendorId, id) {
  const { data, error } = await supabaseAdmin
    .from('vendor_campaigns')
    .select('id, title, body, kind, audience, status, queued_count, sent_count, deliver_after, expires_at, created_at')
    .eq('id', id)
    .eq('vendor_id', vendorId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** Tell every targeted student's open app to re-read its deals list. */
function refreshRecipients(campaignId) {
  supabaseAdmin
    .from('campaign_recipients')
    .select('user_id')
    .eq('campaign_id', campaignId)
    .then(({ data: rows }) => {
      for (const r of rows ?? []) emitDeal(r.user_id, { campaignId });
    }, () => { /* a socket hiccup must not fail the edit */ });
}

/**
 * PATCH /api/vendor/campaigns/:id  { title?, body?, durationHours? }
 *
 * Corrects a LIVE deal in place. What this can and cannot do is worth being
 * precise about, because the two halves of a campaign have different physics:
 *
 *   • the in-app deals list reads vendor_campaigns on every load, so an edit is
 *     immediately and completely true there;
 *   • a notification that already went out is gone. It is a copy of the old
 *     text sitting in someone's shade and nothing can reach it.
 *
 * So this fixes the record, not the interruption. An edit deliberately does NOT
 * re-notify anyone and does NOT spend a send — otherwise "edit" would be a way
 * to push the same audience twice for free.
 *
 * Audience is immutable: recipient rows are materialised at creation, so
 * changing it would mean fanning out to new students, which is a new campaign.
 */
router.patch('/campaigns/:id', requirePin, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'That deal no longer exists.' });
    }
    const campaign = await ownCampaign(req.vendor.id, req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'That deal no longer exists.' });
    }
    if (campaign.status === 'cancelled' || new Date(campaign.expires_at) <= new Date()) {
      return res.status(409).json({
        error: 'CAMPAIGN_OVER',
        message: 'That deal has already ended. Send a new one instead.',
      });
    }

    const b = req.body ?? {};
    const patch = {};

    if (b.title !== undefined) {
      const title = String(b.title).trim();
      if (!title || title.length > CAMPAIGN_TITLE_MAX) {
        return res.status(400).json({
          error: 'BAD_CAMPAIGN',
          message: `Give the deal a headline (up to ${CAMPAIGN_TITLE_MAX} characters).`,
        });
      }
      patch.title = title;
    }
    if (b.body !== undefined) {
      const body = String(b.body).trim();
      if (!body || body.length > CAMPAIGN_BODY_MAX) {
        return res.status(400).json({
          error: 'BAD_CAMPAIGN',
          message: `Write the message (up to ${CAMPAIGN_BODY_MAX} characters).`,
        });
      }
      patch.body = body;
    }
    if (b.durationHours !== undefined) {
      const hours = Number(b.durationHours);
      if (!CAMPAIGN_DURATIONS.includes(hours)) {
        return res.status(400).json({ error: 'BAD_CAMPAIGN', message: 'Pick how long the deal runs.' });
      }
      // Measured from when it was sent, so the chip a vendor picks means the
      // same thing on an edit as it did in the composer.
      const expires = new Date(new Date(campaign.created_at).getTime() + hours * 3_600_000);
      if (expires <= new Date()) {
        return res.status(400).json({
          error: 'BAD_CAMPAIGN',
          message: 'That would end the deal immediately. Take it down instead.',
        });
      }
      patch.expires_at = expires.toISOString();
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'BAD_CAMPAIGN', message: 'Nothing to change.' });
    }

    const { data, error } = await supabaseAdmin
      .from('vendor_campaigns')
      .update(patch)
      .eq('id', campaign.id)
      .eq('vendor_id', req.vendor.id)
      .select('id, title, body, kind, audience, status, queued_count, sent_count, expires_at, created_at')
      .maybeSingle();
    if (error) throw error;

    refreshRecipients(campaign.id);
    res.json({ campaign: data, quota: await campaignQuota(req.vendor.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/vendor/campaigns/:id
 *
 * Takes a deal down. expires_at = now() is the mechanism for both halves at
 * once: /api/me/deals filters on expires_at > now(), and so does the driving
 * scan in claim_campaign_pushes, so one write removes it from every student's
 * list AND abandons every push that had not yet been claimed.
 *
 * The row is kept, not deleted. Its recipient ledger carries the open counts
 * the vendor's own DEALS tab reports, and a campaign that genuinely reached
 * people is a thing that happened — the history shows it as taken down rather
 * than quietly rewriting the week.
 *
 * Recipients already in 'sending' are left alone: a worker owns that batch and
 * is mid-flight: finish_campaign_batch settles it. Flipping those rows here
 * would corrupt the batch it is about to settle, and the notification has in
 * any case already left.
 */
router.delete('/campaigns/:id', requirePin, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'That deal no longer exists.' });
    }
    const campaign = await ownCampaign(req.vendor.id, req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'That deal no longer exists.' });
    }
    // Idempotent: taking down an already-cancelled deal is a no-op, not a 409,
    // so a double-tap on a flaky connection reads as success.
    if (campaign.status !== 'cancelled') {
      const nowIso = new Date().toISOString();
      const { error } = await supabaseAdmin
        .from('vendor_campaigns')
        .update({ status: 'cancelled', expires_at: nowIso })
        .eq('id', campaign.id)
        .eq('vendor_id', req.vendor.id);
      if (error) throw error;

      // Bookkeeping only — expires_at above is what actually stops delivery.
      await supabaseAdmin
        .from('campaign_recipients')
        .update({ status: 'expired' })
        .eq('campaign_id', campaign.id)
        .eq('status', 'queued');

      refreshRecipients(campaign.id);
    }

    // Note there is no `refunded` here: a takedown never gives the send back.
    // See campaignQuota for why, and use PATCH if the problem is the wording.
    res.json({ ok: true, quota: await campaignQuota(req.vendor.id) });
  } catch (err) {
    next(err);
  }
});

/* ---------- vendor self-service settings ---------- */

const RATIO_MIN = 0.5;
const RATIO_MAX = 1000;

/** Validate quick-amount buttons: 1–8 rows, each a label + a fixed dollar amount. */
function validTiers(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) {
    return { error: 'Add between 1 and 8 quick-amount buttons.' };
  }
  const tiers = [];
  for (const row of raw) {
    const label = String(row?.label ?? '').trim();
    const amount = Number(row?.amount);
    if (!label || label.length > 40) return { error: 'Each button needs a label (up to 40 characters).' };
    // Cap at the per-award ceiling so a saved button can always actually award
    // (an amount over MAX_AWARD_DOLLARS would be rejected on tap by /award).
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AWARD_DOLLARS) {
      return { error: `“${label || 'button'}”: enter a dollar amount between $0 and $${MAX_AWARD_DOLLARS}.` };
    }
    tiers.push({ label, amount: Math.round(amount * 100) / 100 }); // numeric-safe dollars
  }
  return { tiers };
}

/** Validate a settings PATCH body → { updates } (DB columns) + optional plaintext pin, or { error }. */
function validSettings(body) {
  const updates = {};
  let pin = null;

  if (body?.pointsPerDollar != null) {
    const r = Number(body.pointsPerDollar);
    if (!Number.isFinite(r) || r < RATIO_MIN || r > RATIO_MAX) {
      return { error: `Points per dollar must be between ${RATIO_MIN} and ${RATIO_MAX}.` };
    }
    updates.points_per_dollar = Math.round(r * 100) / 100; // column is numeric(6,2)
  }

  if (body?.allowExactEntry != null) {
    if (typeof body.allowExactEntry !== 'boolean') return { error: 'Exact entry must be on or off.' };
    updates.allow_exact_entry = body.allowExactEntry;
  }

  if (body?.tiers != null) {
    const t = validTiers(body.tiers);
    if (t.error) return { error: t.error };
    updates.tiers = t.tiers;
  }

  if (body?.address != null) {
    const a = String(body.address).trim();
    if (a.length > ADDRESS_MAX) return { error: `Address must be ${ADDRESS_MAX} characters or fewer.` };
    updates.address = a || null; // '' clears the address (and its coordinates)
  }

  // logo: null/'' clears it; otherwise a small base64 image data-URL.
  if (body && Object.prototype.hasOwnProperty.call(body, 'logo')) {
    const logo = body.logo;
    if (logo == null || logo === '') {
      updates.logo = null;
    } else if (typeof logo === 'string' && logo.length <= LOGO_MAX_CHARS && LOGO_DATA_URL.test(logo)) {
      updates.logo = logo;
    } else {
      return { error: 'Logo must be a small PNG, JPEG, or WebP image.' };
    }
  }

  if (body?.pin != null && body.pin !== '') {
    if (!/^\d{4}$/.test(String(body.pin))) return { error: 'The staff PIN must be exactly 4 digits.' };
    pin = String(body.pin);
  }

  // Punch cards (migration-028): the vendor's own on/off switch + card shape.
  if (body?.punchEnabled != null) {
    if (typeof body.punchEnabled !== 'boolean') return { error: 'Punch cards must be on or off.' };
    updates.punch_enabled = body.punchEnabled;
  }
  // punchTarget / punchReward retired by migration-029: there is no vendor-level
  // card any more, each reward carries its own cost_in_visits.

  if (!Object.keys(updates).length && pin == null) return { error: 'Nothing to update.' };
  return { updates, pin };
}

const settingsView = (v) => ({
  pointsPerDollar: Number(v.points_per_dollar),
  allowExactEntry: v.allow_exact_entry,
  tiers: v.tiers ?? [],
  hasPin: Boolean(v.pin_hash),
  address: v.address ?? '',
  logo: v.logo ?? null,
  punchEnabled: Boolean(v.punch_enabled),
});

/** GET /api/vendor/settings — current economics + config for the Settings tab. */
router.get('/settings', requirePin, (req, res) => {
  res.json(settingsView(req.vendor));
});

/**
 * PATCH /api/vendor/settings  { pointsPerDollar?, allowExactEntry?, tiers?, pin? }
 * Lets a vendor tune their own economics. Strict validation (ratio bounds,
 * well-formed ascending/non-overlapping tiers, 4-digit PIN). A PIN change is
 * re-hashed with bcrypt and invalidates every existing PIN session for this
 * vendor — including this request's own token — so old sessions can't linger.
 */
router.patch('/settings', requirePin, async (req, res, next) => {
  try {
    const v = validSettings(req.body ?? {});
    if (v.error) return res.status(400).json({ error: 'BAD_SETTINGS', message: v.error });

    const updates = { ...v.updates };
    let pinChanged = false;
    if (v.pin != null) {
      updates.pin_hash = await bcrypt.hash(v.pin, 10);
      // A new PIN starts clean — drop any accumulated failures / active lock.
      updates.failed_pin_attempts = 0;
      updates.pin_locked_until = null;
      pinChanged = true;
    }

    // Only re-geocode when the address actually changed (the Settings form
    // always sends `address`, so compare against the stored value to avoid a
    // Nominatim hit on every unrelated save). Clearing the address ('' → null)
    // also clears its coordinates; a geocode miss keeps the address but drops
    // coords (no map until it resolves on a later save).
    if ('address' in updates && updates.address !== (req.vendor.address ?? null)) {
      const coords = updates.address ? await geocode(updates.address) : null;
      updates.latitude = coords?.lat ?? null;
      updates.longitude = coords?.lng ?? null;
    } else {
      delete updates.address; // unchanged — don't rewrite it or its coords
    }

    const { data, error } = await supabaseAdmin
      .from('vendors')
      .update(updates)
      .eq('id', req.vendor.id)
      .select()
      .single();
    if (error) throw error;

    if (pinChanged) {
      // Drop every session for this vendor; the terminal must re-enter the PIN.
      await supabaseAdmin.from('vendor_pin_sessions').delete().eq('vendor_id', req.vendor.id);
    }

    res.json({ ...settingsView(data), pinChanged });
  } catch (err) {
    next(err);
  }
});

export default router;
