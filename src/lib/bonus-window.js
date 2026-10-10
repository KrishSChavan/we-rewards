// The bonus window (migration-063) — incentive kind #3.
//
// "Between Friday 5pm and Sunday midnight, everything earned at every spot is
// worth 2x." The operator creates one in /admin → Incentives, turns it on, and
// every award at every active vendor is multiplied until it ends.
//
// ⚠ THIS KIND SPENDS VENDOR POINTS, NOT COMMUNITY POINTS. Every other incentive
// pays out of the cross-vendor community pool precisely so the platform is
// never handing away a vendor's product on their behalf (migration-039's
// header). This one scales the balance a student spends AT THE SHOP, at every
// active shop, with no vendor opt-in. The thin guard rails are: the window is
// created switched off, both dates are REQUIRED (see validIncentive in
// src/routes/admin.js), and maxMultiplier caps the combined multiplier.
// bonus_window_credits is what lets the operator answer a vendor who asks what
// it cost them.
//
// WHERE THIS IS CALLED FROM, and the one rule both call sites share. Two earn
// paths exist and both compute points in JavaScript before handing an integer
// to the database: POST /api/vendor/award (a terminal) and POST /api/me/receipt
// (a claimed paper receipt). Both call bonusBoost() in place of reading
// tierProfile.multiplier directly, and both then log through
// logBonusWindowCredit(). award_points is NOT touched — see migration-063 on
// why that is worth protecting.
//
// ⚠ A FAILURE HERE PAYS THE BASE RATE, IT NEVER FAILS THE SALE. Every function
// below returns rather than throwing, and a bonusBoost() that cannot read the
// incentives table resolves to "no window" — the student earns what they would
// have earned on an ordinary day, and a cashier sees a successful award. That
// direction is not arbitrary: 039's header states the rule this file inherits,
// that nothing a cashier does can ever fail because of the incentives system.
// The cost of the other direction is a customer told their points didn't go
// through, at a counter, in front of them.

import { supabaseAdmin } from './supabase.js';
import { bonusWindowCache } from './cache.js';

/** What the admin form starts from. Only a pre-fill; a saved window keeps its own. */
export const BONUS_WINDOW_DEFAULTS = {
  multiplier: 2,
  maxMultiplier: 3,
};

/**
 * ⚠ HALF STEPS ONLY, AND IT IS NOT A STYLE CHOICE. Both award paths carry the
 * same comment about why they use pointsFor() instead of `Math.floor(dollars *
 * ratio)`: the inputs are decimal money, doubles are binary, and the naive
 * product lands a hair below the whole number for many ordinary amounts, so the
 * floor pays the customer one point less than the rate on their receipt
 * promised. src/lib/tiers.js then gets away with a plain float multiply for the
 * tier, and says exactly why: "every multiplier in src/lib/tiers.js is 1, 1.5
 * or 2 — all exact in binary, so there is no dust for the floor to eat."
 *
 * A window multiplier of 1.1 or 2.3 would end that. It is not representable, so
 * `basePoints * applied` would land fractionally low on some amounts and the
 * floor would eat a point — the bug the whole award path is written to avoid,
 * reintroduced from the one direction nobody would look. Multiples of 0.5 are
 * exact, their products with the tier multipliers (1, 1.5, 2) are multiples of
 * 0.25 and also exact, and nothing a promotion wants to say — double points,
 * triple points, 1.5x — needs finer than half steps.
 *
 * Changing STEP to anything that is not a negative power of two reopens this.
 */
const MULTIPLIER_STEP = 0.5;
const MULTIPLIER_MIN = 1.5;      // below this it is not a promotion
const MULTIPLIER_MAX = 5;
const CAP_MAX = 10;

/** The tier multipliers a window combines with, for the admin form's preview. */
const TIER_MULTIPLIERS = [1, 1.5, 2];

/** Is this a clean multiple of MULTIPLIER_STEP? See the note above. */
const onStep = (n) => Number.isFinite(n) && Math.abs(n / MULTIPLIER_STEP - Math.round(n / MULTIPLIER_STEP)) < 1e-9;

const fmt = (n) => String(Number(n));

/**
 * Validate the admin form's knobs. Never throws; the caller turns error into a
 * 400. Mirrors validSignupConfig's contract exactly.
 */
export function validBonusWindowConfig(raw) {
  const body = raw ?? {};

  const blank = (v) => v === '' || v == null;
  const multiplier = blank(body.multiplier) ? BONUS_WINDOW_DEFAULTS.multiplier : Number(body.multiplier);
  if (!onStep(multiplier) || multiplier < MULTIPLIER_MIN || multiplier > MULTIPLIER_MAX) {
    return {
      error: `The multiplier must be between ${fmt(MULTIPLIER_MIN)} and ${fmt(MULTIPLIER_MAX)}, `
        + `in steps of ${fmt(MULTIPLIER_STEP)} — so 1.5, 2, 2.5 and so on.`,
    };
  }

  const maxMultiplier = blank(body.maxMultiplier)
    ? BONUS_WINDOW_DEFAULTS.maxMultiplier
    : Number(body.maxMultiplier);
  if (!onStep(maxMultiplier) || maxMultiplier < MULTIPLIER_MIN || maxMultiplier > CAP_MAX) {
    return {
      error: `The cap must be between ${fmt(MULTIPLIER_MIN)} and ${fmt(CAP_MAX)}, `
        + `in steps of ${fmt(MULTIPLIER_STEP)}.`,
    };
  }

  // A cap below the window's own multiplier is always an operator mistake: it
  // silently makes the headline number unreachable, so a "2x weekend" capped at
  // 1.5 would pay 1.5x to everybody and nothing on screen would explain why.
  if (maxMultiplier < multiplier) {
    return { error: `The cap can’t be lower than the multiplier itself (${fmt(multiplier)}x).` };
  }

  return { config: { multiplier, maxMultiplier } };
}

/**
 * The combined multiplier, and whether the cap bit. PURE — this is the half
 * worth testing hard, because it decides what every award during a window pays.
 *
 * The two multipliers MULTIPLY rather than taking the higher or adding: a
 * student who has earned 2x through thirty days of visiting should get more out
 * of a double-points weekend than one who just joined, which is what the tier
 * system is for. The cap is what keeps that from running away — 2x tier times
 * 2x window is 4x, and four times the usual product off one ticket is not a
 * promotion, it is a mistake with a multiplication sign in it.
 *
 * ⚠ THE CAP FLATTENS THE TOP TIERS, by construction. With a 2x window capped at
 * 3x, a tier-2 student (1.5x) and a tier-3 student (2x) both land on exactly 3x
 * and the tier-3 student's extra loyalty buys nothing that weekend. That is
 * inherent to capping a product, not a bug, and it is why the admin panel draws
 * the effective multiplier for all three tiers next to the form instead of
 * leaving the operator to work it out.
 */
export function effectiveMultiplier({ tierMultiplier, windowMultiplier, maxMultiplier }) {
  const tier = Number(tierMultiplier) || 1;
  // No window, or a nonsense one: the tier's own multiplier, untouched. Never a
  // throw and never a 0 — this runs inside an award.
  if (!Number.isFinite(Number(windowMultiplier)) || Number(windowMultiplier) <= 1) {
    return { applied: tier, capped: false };
  }
  const cap = Number.isFinite(Number(maxMultiplier)) && Number(maxMultiplier) >= 1
    ? Number(maxMultiplier)
    : Infinity;

  const product = tier * Number(windowMultiplier);
  const applied = Math.min(product, cap);
  // Both are exact in binary (see MULTIPLIER_STEP), so this comparison is
  // meaningful rather than a float coin toss.
  return { applied, capped: applied < product };
}

/** What the three tiers would actually earn under these knobs. Admin preview. */
export function tierPreview({ multiplier, maxMultiplier }) {
  return TIER_MULTIPLIERS.map((tierMultiplier) => {
    const { applied, capped } = effectiveMultiplier({
      tierMultiplier, windowMultiplier: multiplier, maxMultiplier,
    });
    return { tierMultiplier, applied, capped };
  });
}

/** The columns the window is read with. Shared so no caller invents its own. */
const WINDOW_COLS = 'id, name, active, starts_at, ends_at, config';

/**
 * The one live bonus window, or null.
 *
 * migration-039's partial unique index guarantees at most one active row per
 * kind, so the first match is the only one there could be. The date window is
 * applied HERE rather than in SQL for the same reason activeSignupProgram does
 * it: the admin tab shows a finished window still marked active — which is the
 * truth — while it quietly stops multiplying.
 *
 * ⚠ NEVER THROWS, and returns null on any failure. See the header: a window
 * that cannot be read has to degrade to an ordinary day, not to a failed award.
 * The cache's stale-on-error window (10 minutes, src/lib/cache.js) means a
 * Supabase blip keeps serving the last known answer long before this catch is
 * reached; the catch is the floor under that.
 */
export async function activeBonusWindow() {
  try {
    const row = await bonusWindowCache.get('active', async () => {
      const { data, error } = await supabaseAdmin
        .from('incentives')
        .select(WINDOW_COLS)
        .eq('kind', 'bonus_window')
        .eq('active', true)
        .limit(1);
      // Thrown so the cache's stale-on-error path can see it — a loader that
      // returned null here would CACHE "there is no window" for the whole TTL
      // on one bad read, which during a live weekend is 30 seconds of awards
      // quietly paying the base rate.
      if (error) throw error;
      return data?.[0] ?? null;
    });

    if (!row) return null;
    const now = Date.now();
    if (row.starts_at && new Date(row.starts_at).getTime() > now) return null;
    if (row.ends_at && new Date(row.ends_at).getTime() <= now) return null;
    return row;
  } catch (err) {
    // One line, not silence: a window an operator has turned on and students
    // have been pushed about, quietly paying base rate, is worth finding in the
    // logs. Not a throw, for the reason in the header.
    console.warn(`[bonus-window] read failed, awarding base rate: ${err?.message ?? err}`);
    return null;
  }
}

/** Drop the cached window. Called by every admin write to an incentive. */
export function invalidateBonusWindow() {
  bonusWindowCache.invalidate();
}

/**
 * THE AWARD-PATH HELPER. Both earn paths call this instead of reading
 * tierProfile.multiplier, and use `applied` as their multiplier.
 *
 * @param {number} tierMultiplier the student's tier multiplier (src/lib/tiers.js)
 * @returns {Promise<{applied:number, tierMultiplier:number, windowMultiplier:number|null,
 *                    capped:boolean, window:object|null}>}
 *          `applied` is always a usable multiplier, window or not.
 */
export async function bonusBoost(tierMultiplier) {
  const tier = Number(tierMultiplier) || 1;
  const window = await activeBonusWindow();
  if (!window) {
    return { applied: tier, tierMultiplier: tier, windowMultiplier: null, capped: false, window: null };
  }
  const cfg = { ...BONUS_WINDOW_DEFAULTS, ...(window.config ?? {}) };
  const { applied, capped } = effectiveMultiplier({
    tierMultiplier: tier,
    windowMultiplier: cfg.multiplier,
    maxMultiplier: cfg.maxMultiplier,
  });
  return {
    applied,
    tierMultiplier: tier,
    windowMultiplier: cfg.multiplier,
    capped,
    window,
  };
}

/**
 * Record what a window added to one award. BEST EFFORT, ALWAYS — see the header
 * and migration-063's note on why this table is a report and not a ledger. The
 * points have already moved and `transactions` is their record; this row only
 * answers "what did the promotion cost, and at which spots".
 *
 * Writes NOTHING when the window added nothing. That is the cap-clamped case —
 * a 2x window capped at 2x pays a tier-3 student exactly their tier's 2x — and
 * a row claiming zero exposure would make the awards count wrong while adding
 * no information. The CHECK in migration-063 says the same thing.
 *
 * @param {object} a
 * @param {object} a.boost        what bonusBoost() returned
 * @param {number} a.basePoints   pre-multiplier points
 * @param {number} a.awarded      what was actually awarded (post-floor)
 * @param {'counter'|'receipt'} a.source which earn path
 */
export async function logBonusWindowCredit({
  boost, userId, vendorId, basePoints, awarded, source, clientToken = null,
}) {
  try {
    if (!boost?.window) return;
    // What the tier alone would have paid, floored the same way the award path
    // floors — so bonusPoints is the true marginal difference between the two
    // worlds and not an estimate that drifts by a point.
    const withoutWindow = Math.floor(basePoints * boost.tierMultiplier);
    const bonusPoints = awarded - withoutWindow;
    if (!(bonusPoints > 0)) return;

    const { error } = await supabaseAdmin.from('bonus_window_credits').insert({
      incentive_id: boost.window.id,
      user_id: userId,
      vendor_id: vendorId,
      base_points: basePoints,
      bonus_points: bonusPoints,
      tier_multiplier: boost.tierMultiplier,
      window_multiplier: boost.windowMultiplier,
      applied_multiplier: boost.applied,
      source,
      client_token: clientToken,
    });
    if (error) {
      // 23505 is the retry landing on idx_bonus_credits_once, which is the index
      // doing its job rather than a fault: the original award already logged
      // this exposure and counting it twice is the thing being prevented.
      if (error.code !== '23505') {
        console.warn(`[bonus-window] credit not logged for ${userId}: ${error.message}`);
      }
    }
  } catch (err) {
    console.warn(`[bonus-window] credit log threw: ${err?.message ?? err}`);
  }
}

/**
 * What a signed-in student's app needs to draw the window, or null. Served on
 * GET /api/me/tier — the endpoint the home screen already polls for its
 * multiplier chip, so this is one field on an existing call rather than a new
 * round trip, the same trick publicSignupBonus plays on /api/public-config.
 *
 * Deliberately says nothing about the cap or the per-tier maths: the student is
 * told the multiplier THEY get (`applied`, computed against their own tier) and
 * when it ends. "Capped at 3x" is an operator's concern and would read as a
 * limit being imposed on them.
 */
export async function studentBonusWindow(tierMultiplier) {
  const boost = await bonusBoost(tierMultiplier);
  if (!boost.window) return null;
  return {
    name: boost.window.name,
    multiplier: boost.applied,        // what THIS student earns
    windowMultiplier: boost.windowMultiplier,
    endsAt: boost.window.ends_at,
  };
}
