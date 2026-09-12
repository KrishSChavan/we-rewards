// Pure in-memory rollups for the analytics endpoints, extracted from the route
// handlers so the signed-reversal netting is unit-testable without a database.
// See test/analytics.test.js. The routes keep the DB fetch (+ count queries) and
// hand the rows here.
//
// Reversals (migration-010) post a COMPENSATING row that negates the original's
// points + dollar_amount. Every total adds SIGNED values, so a reversed earn
// contributes +award and −correction (0 net) and the ±1 counts step by sign. For
// pre-reversal data (earns positive, redeems negative) this equals the old
// unconditional +1s.

const DAY = 86_400_000;

export const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Vendor-scoped 30-day rollup.
 * @param {Array<{type,points,dollar_amount,created_at,user_id,rewards?}>} txns
 *        earn/redeem rows within the 30-day window (any order)
 * @param {number} t0  start of today (ms, server-local)
 * @returns {{today,last7,last30,daily,topRewards}}
 */
/**
 * How many customers finished two or more separate days with points actually
 * awarded. Reads the netted customer-day map, so a day whose award was later
 * undone is not a visit and cannot make a one-time customer look like a
 * regular. src/lib/roi.js derives its own visit counts from the same rule.
 */
function countReturning(custDayNet) {
  const perUser = new Map();   // user_id -> surviving award-day count
  for (const [key, points] of custDayNet) {
    if (points <= 0) continue;
    const user = key.slice(0, key.lastIndexOf('|'));
    perUser.set(user, (perUser.get(user) ?? 0) + 1);
  }
  let n = 0;
  for (const days of perUser.values()) if (days >= 2) n += 1;
  return n;
}

export function rollupVendorAnalytics(txns, t0) {
  const t7 = t0 - 6 * DAY;
  const blank = () => ({ earnPoints: 0, redeemPoints: 0, awards: 0, redemptions: 0, revenue: 0, movedIn: 0, movedInPoints: 0, customers: new Set() });
  const today = blank(), last7 = blank(), last30 = blank();
  // `${user_id}|${dayKey}` -> signed points on that customer-day. Resolved into
  // award-days after the loop so an undo cancels the award it reverses.
  const custDayNet = new Map();
  const dayAgg = new Map();       // dayKey  -> { revenue, awards, earnPoints }
  const rewardCounts = new Map(); // reward title -> redemption count

  for (const tx of txns ?? []) {
    const ms = new Date(tx.created_at).getTime();
    const earn = tx.type === 'earn';
    // Inbound community transfers (migration-027) carry POSITIVE points but are
    // neither awards nor redemptions. Without this branch a +80 transfer falls
    // into the redeem arm, where `redeemPoints += -pts` subtracts 80 and the
    // ±1 count step DECREMENTS redemptions — quietly erasing real ones.
    // Tallied separately: "community points moved in" is information the vendor
    // wants, but it isn't a visit (customers/returning stay purchase-only) and
    // it isn't revenue.
    const transfer = tx.type === 'community_transfer';
    const pts = Number(tx.points) || 0;
    const rev = earn ? Number(tx.dollar_amount) || 0 : 0;

    const add = (b) => {
      if (transfer) { b.movedIn += 1; b.movedInPoints += pts; return; }
      if (earn) { b.earnPoints += pts; b.awards += pts >= 0 ? 1 : -1; b.revenue += rev; }
      else { b.redeemPoints += -pts; b.redemptions += pts <= 0 ? 1 : -1; }
      if (tx.user_id) b.customers.add(tx.user_id);
    };
    add(last30);
    if (ms >= t7) add(last7);
    if (ms >= t0) add(today);

    if (transfer) continue;   // not a purchase-day, not a reward — nothing below applies

    const k = dayKey(ms);
    // Returning-customer calc counts real award-days only: a voided award
    // shouldn't register as a visit. Summed SIGNED per customer-day and
    // resolved after the loop, because an undo is a SECOND `earn` row carrying
    // the negation of the first (migration-045's reverse_transaction) — so
    // testing `pts > 0` row by row let the original put the day in the set and
    // the reversal do nothing, counting a cancelled sale as a customer who
    // came back. src/lib/roi.js nets the same way off the same rule.
    if (earn && tx.user_id) {
      const ck = `${tx.user_id}|${k}`;
      custDayNet.set(ck, (custDayNet.get(ck) ?? 0) + pts);
    }
    if (earn) {
      const da = dayAgg.get(k) ?? { revenue: 0, awards: 0, earnPoints: 0 };
      da.revenue += rev; da.awards += pts >= 0 ? 1 : -1; da.earnPoints += pts;
      dayAgg.set(k, da);
    } else {
      const title = tx.rewards?.title ?? 'Reward';
      rewardCounts.set(title, (rewardCounts.get(title) ?? 0) + (pts <= 0 ? 1 : -1));
    }
  }

  const finish = (b) => ({
    earnPoints: b.earnPoints,
    redeemPoints: b.redeemPoints,
    awards: b.awards,
    redemptions: b.redemptions,
    revenue: Number(b.revenue.toFixed(2)),
    movedIn: b.movedIn,
    movedInPoints: b.movedInPoints,
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
    .filter((r) => r.count > 0)   // a fully-reversed reward can net to 0
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    today: finish(today),
    last7: finish(last7),
    last30: { ...finish(last30), returningCustomers: countReturning(custDayNet) },
    daily,
    topRewards,
  };
}

/**
 * Platform-wide 30-day rollup. Returns only the windowed portion; the route
 * merges in the lifetime count totals + newStudents/newVendors.
 * @param {Array<{type,points,dollar_amount,created_at,user_id,vendor_id,vendors?:{name?:string,active?:boolean}}>} txns
 * @param {number} t0  start of today (ms, server-local)
 * @returns {{today,last7,last30,daily,topVendors}}
 */
export function rollupPlatformOverview(txns, t0) {
  const t7 = t0 - 6 * DAY;
  const blank = () => ({ awards: 0, redemptions: 0, pointsAwarded: 0, pointsRedeemed: 0, revenue: 0, transfers: 0, pointsMoved: 0, students: new Set() });
  const today = blank(), last7 = blank(), last30 = blank();
  const vendorAgg = new Map(); // vendor_id -> { name, revenue, awards }
  const dayAgg = new Map();    // dayKey -> { revenue, awards, redemptions }

  for (const tx of txns ?? []) {
    const ms = new Date(tx.created_at).getTime();
    const earn = tx.type === 'earn';
    // Community transfers are the SAME points the mint already counted, moving
    // — not new activity. Fold them into awards/redemptions and the platform
    // double-counts (and the redeem arm would run redemptions backwards, as in
    // the vendor rollup). Counted on their own so the operator can see volume.
    const transfer = tx.type === 'community_transfer';
    const pts = Number(tx.points) || 0;
    const rev = earn ? Number(tx.dollar_amount) || 0 : 0;

    const add = (b) => {
      if (transfer) { b.transfers += 1; b.pointsMoved += pts; return; }
      if (earn) { b.awards += pts >= 0 ? 1 : -1; b.pointsAwarded += pts; b.revenue += rev; }
      else { b.redemptions += pts <= 0 ? 1 : -1; b.pointsRedeemed += -pts; }
      if (tx.user_id) b.students.add(tx.user_id);
    };
    add(last30);
    if (ms >= t7) add(last7);
    if (ms >= t0) add(today);

    if (transfer) continue;   // keep the daily series + top-vendors purchase-only

    // A vendor switched OFF is hidden from every student surface and its terminal
    // is blocked, so ranking it here would spend one of five slots on a spot
    // nobody can visit. Only the ranking skips it: the windows, the daily series
    // and the totals above still count what it earned while it was on, because
    // turning a vendor off is not a deletion and that revenue did happen.
    // `active` is undefined for a deleted vendor (the join has no row left, and
    // those already fold into one generic "Vendor"); only an explicit false is
    // treated as off, so a missing join never silently drops a spot.
    if (earn && tx.vendors?.active !== false) {
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
    transfers: b.transfers,
    pointsMoved: b.pointsMoved,
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

  return {
    today: finish(today),
    last7: finish(last7),
    last30: finish(last30),
    daily,
    topVendors,
  };
}
