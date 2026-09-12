// Per-vendor return-on-investment rollup for /admin.
//
// WHY THIS IS NOT rollupVendorAnalytics. That one answers "what happened at my
// till" — points in, points out, revenue, a 14-day bar chart. This one answers
// a different and much harder question, the one an owner asks before they pay:
// "what did WeRewards actually do for me?" Those need different arithmetic,
// because the second one is about REPEAT BEHAVIOUR and the first is about
// volume. A shop with great revenue and no repeat customers has a fine
// analytics tab and no reason to pay us.
//
// THE HONESTY RULE, and it is the whole design. Nothing here is called
// "attributed revenue", because this system cannot attribute. It never touches
// the transaction (mds/notes.md: "WeRewards never touches the transaction"),
// there is no control group, and a student who would have come back anyway
// still scans. What it CAN measure truthfully is repeat behaviour among people
// who use the app, so every figure is named for what it literally counts:
//
//   repeatRevenue    revenue on award-days that were NOT this customer's first
//                    award-day at this vendor in the window. A real, checkable
//                    number. It is NOT a claim that the repeat was caused by us.
//   giveawayValue    what the vendor handed over, priced at the vendor's OWN
//                    rate (pointsRedeemed / points_per_dollar) — the identical
//                    formula the terminal's ITEMS editor already shows as
//                    "implied spend", so the two screens can never disagree.
//   net              repeatRevenue − giveawayValue. The only number on the
//                    screen that is an argument, and it is a conservative one:
//                    it charges the vendor for every giveaway while crediting
//                    them only for repeat visits.
//
// An overclaiming ROI screen is worse than no ROI screen, because the operator
// reads these numbers down the phone to somebody who has their own till receipts.
//
// A VISIT IS AN AWARD-DAY, not a transaction — the same anti-farming rule
// src/lib/tiers.js uses (visits count once per vendor per day). Two purchases in
// one afternoon are one visit, so this screen and the tier bar agree about what
// "came back" means. An award that was later undone is not an award-day at all:
// the day is netted first, so a cancelled sale cannot become a repeat visit.
//
// ⚠ ONE CAVEAT ON "THE SAME RULE". tiers.js buckets a day with
// `String(created_at).slice(0, 10)`, which is the UTC date; this file and
// analytics.js bucket with dayKey, which is the SERVER's local date. They are
// the same day only while the server runs on UTC. Heroku does, and no TZ config
// var is set, so production agrees — but a laptop in America/New_York does not,
// and an evening award there lands on tomorrow's tier day and today's ROI day.
// Do not "fix" this by changing tiers.js: that column drives every student's
// tier, and re-bucketing it would silently re-rank the whole network.

const DAY = 86_400_000;

// The SAME day bucketer the vendor's own STATS tab uses, imported rather than
// re-declared: an ROI screen and an analytics screen that disagree about where
// a day starts would report different visit counts for the same afternoon.
// (Both bucket in the server's local zone. Heroku runs UTC and no TZ config var
// is set, so in production that is a UTC day.)
import { dayKey } from './analytics.js';

const money = (n) => Number((Number(n) || 0).toFixed(2));

/** Median of an array of numbers. Empty → null, so a caller can't render 0 as a benchmark. */
export function median(values) {
  const xs = (values ?? []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * @param {object} args
 * @param {Array}  args.txns        earn/redeem rows in the window, any order.
 *                                  Needs: type, points, dollar_amount, created_at,
 *                                  user_id, vendor_id.
 * @param {Set<string>} args.priorPairs  `${vendor_id}:${user_id}` for every
 *                                  student who had already earned at that vendor
 *                                  BEFORE the window opened. Anyone in the window
 *                                  and not in here is new to that vendor.
 * @param {Array}  args.vendors     [{ id, name, active, plan, grandfathered,
 *                                     points_per_dollar }]
 * @param {number} args.t0          start of today (ms, server-local)
 * @param {number} [args.days=30]   window length, inclusive of today
 */
export function rollupRoi({ txns, priorPairs, vendors, t0, days = 30 }) {
  const since = t0 - (days - 1) * DAY;
  const prior = priorPairs ?? new Set();

  // vendor_id -> accumulator
  const agg = new Map();
  const blank = () => ({
    revenue: 0,
    repeatRevenue: 0,
    pointsAwarded: 0,
    pointsRedeemed: 0,
    redemptions: 0,
    awards: 0,
    // `${user_id}|${dayKey}` -> { user, day, points, revenue }, summed SIGNED
    // across the day. Resolved into award-days after the loop; see the comment
    // on the accumulation below for why it cannot be decided row by row.
    dayNet: new Map(),
  });

  for (const tx of txns ?? []) {
    const ms = new Date(tx.created_at).getTime();
    if (ms < since) continue;

    // Community transfers carry positive points but are neither a purchase nor
    // a giveaway — the same branch rollupVendorAnalytics needs, for the same
    // reason. Folding them in would count moved points as revenue-free awards.
    if (tx.type === 'community_transfer') continue;

    const vid = tx.vendor_id;
    if (!vid) continue;
    if (!agg.has(vid)) agg.set(vid, blank());
    const a = agg.get(vid);

    const earn = tx.type === 'earn';
    const pts = Number(tx.points) || 0;
    const rev = earn ? Number(tx.dollar_amount) || 0 : 0;

    if (earn) {
      a.pointsAwarded += pts;
      a.awards += pts >= 0 ? 1 : -1;
      a.revenue += rev;
    } else {
      // Signed, so a reversed redemption nets back out exactly as it does in
      // the vendor's own STATS tab.
      a.pointsRedeemed += -pts;
      a.redemptions += pts <= 0 ? 1 : -1;
    }

    // A VOIDED AWARD IS NOT A VISIT — and that has to be decided per DAY, not
    // per row. migration-045's reverse_transaction undoes an award by inserting
    // a second `earn` row carrying the negation of the original, so a cancelled
    // sale arrives as +400/$40 followed by -400/-$40. Testing `pts > 0` on each
    // row let the positive half put the day in the set while the negative half
    // did nothing at all, so a sale that never happened still counted as a
    // visit, as a customer who "came back", and as repeat revenue. That makes
    // the screen read HIGHER than the vendor's own till — the one direction an
    // ROI number must never be wrong in, because the operator reads it down the
    // phone to somebody holding their receipts.
    if (earn && tx.user_id) {
      const k = dayKey(ms);
      const rk = `${tx.user_id}|${k}`;
      const d = a.dayNet.get(rk) ?? { user: tx.user_id, day: k, points: 0, revenue: 0 };
      d.points += pts;
      d.revenue += rev;
      a.dayNet.set(rk, d);
    }
  }

  /**
   * Netted customer-days -> the two maps every repeat figure is read from.
   * A day survives only if the customer ended it with points actually awarded.
   */
  const resolveDays = (a) => {
    const custDays = new Map();    // user_id -> Set(dayKey)
    const dayRevenue = new Map();  // `${user}|${day}` -> revenue that survived
    for (const [rk, d] of a.dayNet) {
      if (d.points <= 0) continue;
      if (!custDays.has(d.user)) custDays.set(d.user, new Set());
      custDays.get(d.user).add(d.day);
      dayRevenue.set(rk, d.revenue);
    }
    return { custDays, dayRevenue };
  };

  const cards = [];

  for (const v of vendors ?? []) {
    const a = agg.get(v.id) ?? blank();
    const ratio = Number(v.points_per_dollar) || 0;
    const { custDays, dayRevenue } = resolveDays(a);

    let customers = 0;
    let newCustomers = 0;
    let returningCustomers = 0;
    let visits = 0;
    let repeatVisits = 0;
    let repeatRevenue = 0;

    for (const [userId, dayset] of custDays) {
      customers += 1;
      visits += dayset.size;
      if (!prior.has(`${v.id}:${userId}`)) newCustomers += 1;
      if (dayset.size >= 2) returningCustomers += 1;

      // Everything after a customer's FIRST award-day in this window counts as
      // repeat. Sorting the day keys works because dayKey is zero-padded
      // ISO-ish, so lexical order is chronological order.
      const sorted = [...dayset].sort();
      repeatVisits += Math.max(0, sorted.length - 1);
      for (let i = 1; i < sorted.length; i++) {
        repeatRevenue += dayRevenue.get(`${userId}|${sorted[i]}`) ?? 0;
      }
    }

    // Priced at the vendor's own rate — identical to the terminal's implied
    // spend hint. A ratio of 0 would divide by zero; a vendor cannot actually
    // have one (the column is bounded 0.5-1000) but a deleted-vendor join can
    // arrive without it, so guard rather than emit Infinity.
    const giveawayValue = ratio > 0 ? a.pointsRedeemed / ratio : 0;

    cards.push({
      id: v.id,
      name: v.name,
      active: v.active !== false,
      plan: v.plan ?? 'freshman',
      grandfathered: !!v.grandfathered,
      pointsPerDollar: ratio,

      customers,
      newCustomers,
      returningCustomers,
      // null rather than 0 when nobody came at all: 0% reads as "everybody
      // churned", which is a different and much worse claim than "no data".
      returnRate: customers ? Number((returningCustomers / customers).toFixed(4)) : null,

      visits,
      repeatVisits,
      visitsPerCustomer: customers ? Number((visits / customers).toFixed(2)) : null,

      revenue: money(a.revenue),
      repeatRevenue: money(repeatRevenue),
      avgTicket: a.awards > 0 ? money(a.revenue / a.awards) : null,

      awards: a.awards,
      pointsAwarded: a.pointsAwarded,
      redemptions: a.redemptions,
      pointsRedeemed: a.pointsRedeemed,
      giveawayValue: money(giveawayValue),

      net: money(repeatRevenue - giveawayValue),
    });
  }

  // The benchmark only means anything against vendors that had any customers at
  // all; a shop with nobody through the door would drag the median to zero and
  // make every real vendor look above average.
  const rates = cards.filter((c) => c.returnRate !== null).map((c) => c.returnRate);
  const tickets = cards.filter((c) => c.avgTicket !== null).map((c) => c.avgTicket);

  const platform = {
    vendorsWithActivity: rates.length,
    medianReturnRate: median(rates),
    medianAvgTicket: median(tickets),
    totalRevenue: money(cards.reduce((s, c) => s + c.revenue, 0)),
    totalRepeatRevenue: money(cards.reduce((s, c) => s + c.repeatRevenue, 0)),
    totalGiveawayValue: money(cards.reduce((s, c) => s + c.giveawayValue, 0)),
    // Distinct students across the whole platform in this window, which is NOT
    // the sum of the per-vendor counts — the breadth tier means the same
    // students appear at many vendors, and adding them up would multiply the
    // student base by the vendor count.
    //
    // Counted off the netted award-days for the same reason as everything
    // above: a student whose only purchase in the window was voided did not
    // shop here, and this figure is what the thin-data warning is measured
    // against, so inflating it would silence the warning.
    activeStudents: (() => {
      const students = new Set();
      for (const a of agg.values()) {
        for (const d of a.dayNet.values()) if (d.points > 0) students.add(d.user);
      }
      return students.size;
    })(),
  };

  cards.sort((a, b) => b.net - a.net || b.revenue - a.revenue);

  return {
    window: { days, since: new Date(since).toISOString() },
    vendors: cards,
    platform,
  };
}
