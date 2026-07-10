import { supabaseAdmin } from './supabase.js';

/* 30-day rolling engagement score (0–1000) from three balanced parts:
     B breadth — % of active vendors visited
     L depth   — vendors they keep coming back to + overall visit frequency
     S spend   — capped volume w/ diminishing returns + meal-sized tickets
   A linear blend guarantees one-dimensional customers still move a little;
   the geometric blend (cbrt of the product) only pays out when all three
   are strong together — so looping through vendors beats whaling one. */

const WINDOW_DAYS = 30;
const SPEND_CAP_PER_VISIT = 30; // anti receipt-stuffing: a visit credits at most $30
const VISIT_TARGET = 24;        // ~visiting most days of the month
const SPEND_TARGET = 250;       // monthly spend for full credit
const MEAL_TICKET = 11;         // avg ticket that reads as "they're getting a meal"

// Score cutoffs → earn multiplier. Tier 1 is the vendor's own ratio untouched.
export const TIERS = [
  { tier: 1, multiplier: 1, minScore: 0 },
  { tier: 2, multiplier: 2, minScore: 350 },
  { tier: 3, multiplier: 3, minScore: 700 },
];

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Score a student's last 30 days of earn activity and map it to a tier.
 * Persists the result to user_scores (transactions stays the source of
 * truth) and returns { score, tier, multiplier, nextMultiplier,
 * nextTierScore, cutoffs, maxScore, windowDays, revisits } — everything
 * the home-screen bar needs to render.
 */
export async function getTierProfile(userId) {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [{ count: vendorCount, error: vErr }, { data: txns, error: tErr }, { data: prof }] = await Promise.all([
    supabaseAdmin.from('vendors').select('id', { count: 'exact', head: true }).eq('active', true),
    supabaseAdmin
      .from('transactions')
      .select('vendor_id, dollar_amount, created_at')
      .eq('user_id', userId)
      .eq('type', 'earn')
      .gte('created_at', since),
    supabaseAdmin.from('profiles').select('revisits').eq('user_id', userId).maybeSingle(),
  ]);
  if (vErr) throw vErr;
  if (tErr) throw tErr;

  // Collapse to one visit per vendor per day (anti-farming), summing that
  // day's spend at the vendor but crediting at most SPEND_CAP_PER_VISIT of it.
  const visitDays = new Map(); // "vendorId|YYYY-MM-DD" -> dollars that day
  for (const t of txns ?? []) {
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

  const current = [...TIERS].reverse().find((t) => score >= t.minScore) ?? TIERS[0];
  const next = TIERS.find((t) => t.minScore > score) ?? null;

  // Snapshot the computed score into user_scores so it lives in the DB.
  // Non-fatal: scans/awards must still work if migration-005 hasn't run yet.
  const { error: sErr } = await supabaseAdmin.from('user_scores').upsert({
    user_id: userId,
    score,
    tier: current.tier,
    multiplier: current.multiplier,
    breadth: Number(B.toFixed(4)),
    loyalty: Number(L.toFixed(4)),
    spend: Number(S.toFixed(4)),
    distinct_vendors: distinct,
    revisit_vendors: revisitVendors,
    total_visits: totalVisits,
    total_spend: Number(totalSpend.toFixed(2)),
    window_days: WINDOW_DAYS,
    computed_at: new Date().toISOString(),
  });
  if (sErr) console.error(`user_scores upsert failed (run migration-005?): ${sErr.message}`);

  return {
    score,
    tier: current.tier,
    multiplier: current.multiplier,
    nextMultiplier: next?.multiplier ?? null,
    nextTierScore: next?.minScore ?? null,
    cutoffs: TIERS.slice(1).map((t) => t.minScore),
    maxScore: 1000,
    windowDays: WINDOW_DAYS,
    revisits: prof?.revisits ?? 0, // lifetime counter, maintained by award_points
  };
}
