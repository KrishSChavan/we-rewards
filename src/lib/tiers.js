import { supabaseAdmin } from './supabase.js';
import { loadActiveVendorIds, tierRankingCache } from './cache.js';

/* 30-day rolling engagement score (0–1000) from three balanced parts:
     B breadth — % of active vendors visited
     L depth   — vendors they keep coming back to + overall visit frequency
     S spend   — capped volume w/ diminishing returns + meal-sized tickets
   A linear blend guarantees one-dimensional customers still move a little;
   the geometric blend (cbrt of the product) only pays out when all three
   are strong together — so looping through vendors beats whaling one.

   The score no longer sets the tier on its own: the multiplier goes to where it
   RANKS among every signed-up student (see TIERS and rankTier). Breadth and the
   revisit target both grow with the vendor list, so a fixed 350/700 bar got
   further away with every spot that joined; a rank is measured against the same
   list for everybody, so a bigger list moves nobody. */

const WINDOW_DAYS = 30;
const SPEND_CAP_PER_VISIT = 30; // anti receipt-stuffing: a visit credits at most $30
const VISIT_TARGET = 24;        // ~visiting most days of the month
const SPEND_TARGET = 250;       // monthly spend for full credit
const MEAL_TICKET = 11;         // avg ticket that reads as "they're getting a meal"

// Rank cutoffs → earn multiplier: the top 50% of students earn 1.5x and the top
// 10% earn 2x. Tier 1 is the base rate untouched. `topPercent` counts EVERY
// signed-up student, including the ones who have never scanned, so while few
// students are active, one visit is enough for the top tier (the owner chose
// that knowingly, 2026-10-18). Ties go up, and a score of 0 is never ranked.
// Fractional multipliers are fine: the award path floors basePoints * multiplier
// to whole points (see routes/vendor.js), and user_scores.multiplier is numeric.
export const TIERS = [
  { tier: 1, multiplier: 1, topPercent: 100 },
  { tier: 2, multiplier: 1.5, topPercent: 50 },
  { tier: 3, multiplier: 2, topPercent: 10 },
];

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Pure scoring: map a set of earn transactions to a score. The tier is NOT
 * decided here, because it depends on everyone else's score (see rankTier).
 * No I/O — the caller supplies the count of active vendors, the student's earn
 * transactions in the window, and their lifetime revisit counter. Split out of
 * computeTierProfile so the math (and its anti-farming caps) is unit-testable
 * without a database. See test/tiers.test.js.
 *
 * When activeVendorIds is supplied, transactions at any other vendor are
 * dropped before scoring — visits/spend at a vendor the admin has since
 * hidden (vendors.active = false) contribute nothing to breadth, loyalty, or
 * spend. Omitting it preserves the historical behavior (score every txn).
 *
 * @param {object} input
 * @param {number} input.vendorCount  count of active vendors (breadth denominator)
 * @param {Array<{vendor_id:string, dollar_amount:number|string|null, created_at:string}>} input.txns
 * @param {Set<string>|Array<string>} [input.activeVendorIds]
 *        ids of active vendors; txns at vendors outside this set are excluded
 *        from the tier math entirely. Omit to score all txns (legacy behavior).
 * @param {number} [input.revisits]   lifetime revisit counter (passed through untouched)
 */
export function scoreProfile({ vendorCount, txns, activeVendorIds, revisits = 0 }) {
  const activeSet = activeVendorIds == null
    ? null
    : activeVendorIds instanceof Set ? activeVendorIds : new Set(activeVendorIds);

  // Collapse to one visit per vendor per day (anti-farming), summing that
  // day's spend at the vendor but crediting at most SPEND_CAP_PER_VISIT of it.
  const visitDays = new Map(); // "vendorId|YYYY-MM-DD" -> dollars that day
  for (const t of txns ?? []) {
    if (activeSet && !activeSet.has(t.vendor_id)) continue; // hidden vendor: no credit
    const key = `${t.vendor_id}|${String(t.created_at).slice(0, 10)}`;
    visitDays.set(key, (visitDays.get(key) ?? 0) + Number(t.dollar_amount ?? 0));
  }

  const perVendorVisits = new Map(); // vendorId -> visit-day count
  let totalVisits = 0;
  let totalSpend = 0;
  for (const [key, spend] of visitDays) {
    const vendorId = key.slice(0, key.indexOf('|'));
    perVendorVisits.set(vendorId, (perVendorVisits.get(vendorId) ?? 0) + 1);
    totalVisits += 1;
    totalSpend += Math.min(spend, SPEND_CAP_PER_VISIT);
  }

  const V = vendorCount ?? 0;
  const distinct = perVendorVisits.size;
  const revisitVendors = [...perVendorVisits.values()].filter((n) => n >= 2).length;
  const avgTicket = totalVisits ? totalSpend / totalVisits : 0;
  const revisitTarget = Math.max(3, Math.round(0.4 * V));

  const B = V ? clamp01(distinct / V) : 0;
  const L = 0.6 * clamp01(revisitVendors / revisitTarget) + 0.4 * clamp01(totalVisits / VISIT_TARGET);
  const S = 0.5 * Math.sqrt(clamp01(totalSpend / SPEND_TARGET)) + 0.5 * clamp01(avgTicket / MEAL_TICKET);

  const linear = 0.35 * B + 0.30 * L + 0.35 * S;
  const synergy = Math.cbrt(B * L * S);
  const score = Math.round(1000 * (0.45 * linear + 0.55 * synergy));

  return {
    score,
    maxScore: 1000,
    windowDays: WINDOW_DAYS,
    revisits, // lifetime counter, maintained by award_points
    // raw components + aggregates: the hub's three rows read these, and
    // persistTierSnapshot stores them
    breadth: B,
    loyalty: L,
    spend: S,
    distinctVendors: distinct,
    revisitVendors,
    totalVisits,
    totalSpend,
  };
}

/**
 * Where a score ranks, and the tier that buys. PURE, like scoreProfile.
 *
 * "Top P%" is decided by how many students are strictly ahead of you:
 * topPercent = floor(100 * ahead / studentCount) + 1. That is the same rule as
 * "the best ceil(P% of studentCount) places", rounded up, so with 87 students
 * the top 10% is 9 places, not 8. Ties go up because only students STRICTLY
 * ahead count against you: everyone level on the 9th place score is in.
 *
 * A score of 0 is never ranked and always earns 1x. That is not only "you have
 * to show up": the pool counts students who have never scanned, so while fewer
 * than 10% of students are active the 10% line falls among the zeros, and with
 * ties going up every one of them would be handed 2x.
 *
 * @param {object} input
 * @param {number} input.score         this student's own score, computed live
 * @param {number[]} input.others      every OTHER student's score (order and
 *                                     zeros don't matter)
 * @param {number} input.studentCount  every signed-up student, this one included
 */
export function rankTier({ score, others = [], studentCount = 0 }) {
  const desc = others.filter((s) => s > 0).sort((a, b) => b - a);
  // A signup newer than the cached count would otherwise leave n one short.
  const n = Math.max(1, studentCount, desc.length + 1);

  // The lowest score that is in the top `pct`% right now: matching the K-th
  // best of the others is enough (ties go up), and nothing below 1 is ranked.
  // Equivalent to the topPercent rule below; test/tiers.test.js checks both
  // against each other over random fields.
  const scoreFor = (pct) => Math.max(1, desc[Math.ceil((pct * n) / 100) - 1] ?? 0);

  const ranked = score > 0;
  const ahead = ranked ? desc.filter((s) => s > score).length : null;
  const topPercent = ranked ? Math.floor((100 * ahead) / n) + 1 : null;
  const current = ranked
    ? [...TIERS].reverse().find((t) => topPercent <= t.topPercent)
    : TIERS[0];
  const next = TIERS.find((t) => t.tier === current.tier + 1) ?? null;

  return {
    tier: current.tier,
    multiplier: current.multiplier,
    nextMultiplier: next?.multiplier ?? null,
    // Scores, not ranks: what this student's score would have to reach right
    // now. The hub doesn't print them (they move as everyone else visits), but
    // a terminal or a page that predates ranking reads `cutoffs` to fill its
    // meter, and against live lines it still fills correctly.
    nextTierScore: next ? scoreFor(next.topPercent) : null,
    cutoffs: TIERS.slice(1).map((t) => scoreFor(t.topPercent)),
    rankCutoffs: TIERS.slice(1).map((t) => t.topPercent),
    rank: ranked ? ahead + 1 : null,
    topPercent,
    studentCount: n,
  };
}

/**
 * Every student's score from one month of earn transactions, best first. PURE.
 * Students with a score of 0 are left out: they are never ranked (rankTier),
 * and studentCount, not this list, is what counts them.
 *
 * @param {object} input
 * @param {Array<{user_id:string, vendor_id:string, dollar_amount:number|string|null, created_at:string}>} input.txns
 * @param {Set<string>|Array<string>} input.activeVendorIds
 * @param {number} input.studentCount
 */
export function buildRanking({ txns, activeVendorIds, studentCount }) {
  const activeSet = activeVendorIds instanceof Set ? activeVendorIds : new Set(activeVendorIds ?? []);
  const byUser = new Map();
  for (const t of txns ?? []) {
    const list = byUser.get(t.user_id);
    if (list) list.push(t);
    else byUser.set(t.user_id, [t]);
  }

  const ranked = [];
  for (const [userId, list] of byUser) {
    const { score } = scoreProfile({ vendorCount: activeSet.size, activeVendorIds: activeSet, txns: list });
    if (score > 0) ranked.push({ userId, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return { ranked, studentCount: studentCount ?? 0 };
}

// PostgREST caps a response at 1000 rows by default, so the month is read in
// pages of exactly that.
const RANKING_PAGE = 1000;

/**
 * The ranking every award is measured against, from tierRankingCache (2 min).
 *
 * SCALE NOTE: this reads every earn transaction of the last 30 days, a page at
 * a time, once per cache refresh. At hundreds of students that is one or two
 * requests. If it ever gets slow, move the scoring into SQL or a scheduled
 * job; the cache key and rankTier stay as they are.
 */
export function loadTierRanking() {
  return tierRankingCache.get('all', async () => {
    const [vendors, { count, error: cErr }, txns] = await Promise.all([
      loadActiveVendorIds(),
      // Every profile, the same count the admin dashboard calls "students".
      // It includes a few vendor staff and the operator, which moves the 10%
      // line by a fraction of one place.
      supabaseAdmin.from('profiles').select('user_id', { count: 'exact', head: true }),
      loadWindowEarns(windowStart()),
    ]);
    if (cErr) throw cErr;
    return buildRanking({
      txns,
      activeVendorIds: new Set((vendors ?? []).map((v) => v.id)),
      studentCount: count ?? 0,
    });
  });
}

async function loadWindowEarns(since) {
  const rows = [];
  // Oldest first: a row inserted mid-read lands after every page already read,
  // so the offsets never shift under us.
  for (let from = 0; ; from += RANKING_PAGE) {
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select('user_id, vendor_id, dollar_amount, created_at')
      .eq('type', 'earn')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + RANKING_PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < RANKING_PAGE) return rows;
  }
}

const windowStart = () => new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

/**
 * Score a student's last 30 days of earn activity and rank it for a tier.
 * PURE READ — does not write anything (the home bar polls this on every
 * balance push, so writing here caused heavy write-amplification). Returns
 * everything the home bar needs plus the raw components/aggregates, so a
 * caller that wants a durable snapshot can hand the result to
 * persistTierSnapshot() without recomputing. Fetches the inputs, then defers
 * the math to the pure scoreProfile() and rankTier() above.
 *
 * The student's OWN score is always live; only the others it is ranked against
 * come from the 2-minute cache. Their own entry in that cache is left out, or a
 * score that has since dropped would be counted as someone ahead of them.
 *
 * Only ACTIVE vendors count: their ids are fetched (a small list — same single
 * round-trip as the old head-count) and passed to scoreProfile, which sizes
 * the breadth denominator from them AND drops earn txns at admin-hidden
 * vendors (vendors.active = false) so those feed none of the components.
 */
export async function computeTierProfile(userId) {
  const since = windowStart();

  const [vendors, { data: txns, error: tErr }, { data: prof }, ranking] = await Promise.all([
    // Served off the shared catalogue cache (src/lib/cache.js). This used to be
    // its own `select('id').eq('active', true)`, which meant a tier refresh ran
    // a SECOND sequential scan of `vendors` alongside the one GET
    // /api/me/balances was already running in the same refresh cycle.
    loadActiveVendorIds(),
    supabaseAdmin
      .from('transactions')
      .select('vendor_id, dollar_amount, created_at')
      .eq('user_id', userId)
      .eq('type', 'earn')
      .gte('created_at', since),
    supabaseAdmin.from('profiles').select('revisits').eq('user_id', userId).maybeSingle(),
    loadTierRanking(),
  ]);
  if (tErr) throw tErr;

  const activeVendorIds = new Set((vendors ?? []).map((v) => v.id));
  const profile = scoreProfile({
    vendorCount: activeVendorIds.size,
    activeVendorIds,
    txns: txns ?? [],
    revisits: prof?.revisits ?? 0,
  });
  const others = ranking.ranked.filter((e) => e.userId !== userId).map((e) => e.score);
  return { ...profile, ...rankTier({ score: profile.score, others, studentCount: ranking.studentCount }) };
}

/**
 * Snapshot a computed tier profile into user_scores so analytics can read
 * scores straight from the DB (transactions stays the source of truth). Called
 * after an award lands — NOT on reads. Non-fatal: awards must still succeed if
 * this write fails (e.g. migration-005 not yet run).
 */
export async function persistTierSnapshot(userId, p) {
  const { error } = await supabaseAdmin.from('user_scores').upsert({
    user_id: userId,
    score: p.score,
    tier: p.tier,
    multiplier: p.multiplier,
    breadth: Number(p.breadth.toFixed(4)),
    loyalty: Number(p.loyalty.toFixed(4)),
    spend: Number(p.spend.toFixed(4)),
    distinct_vendors: p.distinctVendors,
    revisit_vendors: p.revisitVendors,
    total_visits: p.totalVisits,
    total_spend: Number(p.totalSpend.toFixed(2)),
    window_days: p.windowDays,
    computed_at: new Date().toISOString(),
  });
  if (error) console.error(`user_scores upsert failed (run migration-005?): ${error.message}`);
}
