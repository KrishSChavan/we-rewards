// Unit tests for the ROI rollup (src/lib/roi.js) — the numbers the operator
// reads down the phone to a vendor who is deciding whether to keep paying.
//
// These lock in the two things that make this rollup different from
// rollupVendorAnalytics, and one thing it has to inherit from it:
//
//   * A VISIT IS AN AWARD-DAY. Two purchases in an afternoon are one visit, the
//     same anti-farming rule src/lib/tiers.js uses. If this drifted, a vendor
//     with chatty regulars would look like it had twice the repeat business,
//     and the tier bar and the ROI screen would disagree about the same person.
//   * REPEAT REVENUE EXCLUDES THE FIRST VISIT. The whole claim is "these people
//     came BACK", so the trip that introduced them cannot count towards it.
//   * SIGNED REVERSALS STILL NET OUT (migration-010), and a voided award is not
//     a visit — inherited from analytics.js, and re-asserted because a separate
//     implementation is a separate chance to get it wrong.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rollupRoi, median } from '../src/lib/roi.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const iso = (ms) => new Date(ms).toISOString();

const V = { id: 'v1', name: 'Fava Kitchen', active: true, plan: 'discovery', points_per_dollar: 10 };
const earn = (user, ms, dollars, points) => ({
  type: 'earn', user_id: user, vendor_id: 'v1',
  created_at: iso(ms), dollar_amount: dollars, points: points ?? dollars * 10,
});
const redeem = (user, ms, points) => ({
  type: 'redeem', user_id: user, vendor_id: 'v1',
  created_at: iso(ms), dollar_amount: 0, points: -points,
});

const roll = (txns, opts = {}) => rollupRoi({
  txns,
  priorPairs: opts.priorPairs ?? new Set(),
  vendors: opts.vendors ?? [V],
  t0: opts.t0 ?? startOfToday(),
  days: opts.days ?? 30,
});

describe('visits are award-days, not transactions', () => {
  test('two purchases on one day are one visit and do not make a returning customer', () => {
    const t0 = startOfToday();
    const r = roll([
      earn('u1', t0 + 2 * HOUR, 12),
      earn('u1', t0 + 6 * HOUR, 8),
    ], { t0 });
    const c = r.vendors[0];

    assert.equal(c.visits, 1, 'same calendar day = one visit');
    assert.equal(c.customers, 1);
    assert.equal(c.returningCustomers, 0, 'one day is not coming back');
    assert.equal(c.repeatVisits, 0);
    assert.equal(c.repeatRevenue, 0, 'no repeat visit means no repeat revenue');
    assert.equal(c.revenue, 20, 'both purchases still count as revenue');
  });

  test('two separate days make a returning customer', () => {
    const t0 = startOfToday();
    const r = roll([
      earn('u1', t0 - 3 * DAY + HOUR, 10),
      earn('u1', t0 + HOUR, 15),
    ], { t0 });
    const c = r.vendors[0];

    assert.equal(c.visits, 2);
    assert.equal(c.returningCustomers, 1);
    assert.equal(c.repeatVisits, 1, 'the second day is the repeat');
    assert.equal(c.returnRate, 1);
  });
});

describe('repeat revenue', () => {
  test('excludes the first visit and sums every later one', () => {
    const t0 = startOfToday();
    const r = roll([
      earn('u1', t0 - 5 * DAY, 20),   // first visit — NOT repeat revenue
      earn('u1', t0 - 2 * DAY, 14),   // repeat
      earn('u1', t0, 6),              // repeat
    ], { t0 });
    const c = r.vendors[0];

    assert.equal(c.revenue, 40);
    assert.equal(c.repeatRevenue, 20, '14 + 6, the first $20 trip excluded');
    assert.equal(c.repeatVisits, 2);
  });

  test('sums same-day repeat purchases into the day they belong to', () => {
    const t0 = startOfToday();
    const r = roll([
      earn('u1', t0 - DAY, 10),           // first visit
      earn('u1', t0 + HOUR, 7),           // repeat day...
      earn('u1', t0 + 5 * HOUR, 3),       // ...same day, same visit
    ], { t0 });
    const c = r.vendors[0];

    assert.equal(c.repeatVisits, 1, 'one repeat DAY');
    assert.equal(c.repeatRevenue, 10, 'but both purchases on it count: 7 + 3');
  });
});

describe('new vs. existing customers', () => {
  test('priorPairs decides who is new, per vendor', () => {
    const t0 = startOfToday();
    const r = roll([
      earn('u1', t0, 10),
      earn('u2', t0, 10),
    ], { t0, priorPairs: new Set(['v1:u1']) });
    const c = r.vendors[0];

    assert.equal(c.customers, 2);
    assert.equal(c.newCustomers, 1, 'u2 had never earned here before the window');
  });

  test('a prior visit at a DIFFERENT vendor does not make you an old customer here', () => {
    const t0 = startOfToday();
    const r = roll([earn('u1', t0, 10)], { t0, priorPairs: new Set(['v9:u1']) });
    assert.equal(r.vendors[0].newCustomers, 1);
  });
});

describe('reversals (migration-010)', () => {
  test('a reversed earn nets out of revenue and is not a visit', () => {
    const t0 = startOfToday();
    const r = roll([
      earn('u1', t0 + HOUR, 25),
      earn('u1', t0 + 2 * HOUR, -25, -250),   // the compensating row
    ], { t0 });
    const c = r.vendors[0];

    assert.equal(c.revenue, 0, '+$25 and −$25 net to zero');
    assert.equal(c.awards, 0);
    assert.equal(c.pointsAwarded, 0);
    assert.equal(c.repeatRevenue, 0);
    // The day is netted before it is judged, so a sale that was cancelled is
    // not a visit and the person who made it is not a customer. This used to
    // read 1/1: the positive row put the day in the set and the reversal did
    // nothing, because the test was `pts > 0` on each row rather than on the
    // day's total.
    assert.equal(c.visits, 0, 'a cancelled sale is not a visit');
    assert.equal(c.customers, 0, 'and nobody shopped here');
    assert.equal(r.platform.activeStudents, 0);
  });

  test('a voided RETURN visit cannot become repeat revenue', () => {
    // The case that made the screen read higher than the vendor's own till:
    // a real first visit, then a second one that was rung up and immediately
    // undone. Before the day-netting fix this reported $40 of repeat spend and
    // a net of $40 against $10 actually taken, plus a "came back" customer who
    // had not.
    const t0 = startOfToday();
    const r = roll([
      earn('u1', t0 - 5 * DAY + 12 * HOUR, 10),        // genuine first visit
      earn('u1', t0 - 2 * DAY + 12 * HOUR, 40),        // second visit, rung up...
      earn('u1', t0 - 2 * DAY + 13 * HOUR, -40, -400), // ...and voided an hour later
    ], { t0 });
    const c = r.vendors[0];

    assert.equal(c.revenue, 10, 'the till took $10');
    assert.equal(c.visits, 1, 'one real visit, not two');
    assert.equal(c.returningCustomers, 0, 'they did not come back');
    assert.equal(c.returnRate, 0);
    assert.equal(c.repeatRevenue, 0, 'no repeat visit means no repeat revenue');
    assert.equal(c.net, 0);
    assert.ok(c.repeatRevenue <= c.revenue,
      'repeat revenue can never exceed the revenue it is a subset of');
  });

  test('a void of an award from BEFORE the window does not invent a negative visit', () => {
    // The compensating row lands inside the window while the award it reverses
    // does not, so the day nets negative. That is not a visit either.
    const t0 = startOfToday();
    const r = roll([earn('u1', t0 + HOUR, -25, -250)], { t0 });
    const c = r.vendors[0];

    assert.equal(c.visits, 0);
    assert.equal(c.customers, 0);
    assert.equal(c.revenue, -25, 'the refund still shows against revenue');
  });

  test('a reversed redemption nets out of the giveaway value', () => {
    const t0 = startOfToday();
    const r = roll([
      redeem('u1', t0 + HOUR, 500),
      { type: 'redeem', user_id: 'u1', vendor_id: 'v1', created_at: iso(t0 + 2 * HOUR), dollar_amount: 0, points: 500 },
    ], { t0 });
    const c = r.vendors[0];

    assert.equal(c.pointsRedeemed, 0);
    assert.equal(c.redemptions, 0);
    assert.equal(c.giveawayValue, 0);
  });
});

describe('giveaway value', () => {
  test('is points burned at the vendor’s own rate — the terminal’s implied-spend formula', () => {
    const t0 = startOfToday();
    const r = roll([redeem('u1', t0, 500)], { t0 });
    assert.equal(r.vendors[0].giveawayValue, 50, '500 points ÷ 10 per dollar');
  });

  test('a different rate gives a different value for the same points', () => {
    const t0 = startOfToday();
    const r = roll([redeem('u1', t0, 500)], {
      t0, vendors: [{ ...V, points_per_dollar: 20 }],
    });
    assert.equal(r.vendors[0].giveawayValue, 25);
  });

  test('a zero ratio yields 0, never Infinity', () => {
    const t0 = startOfToday();
    const r = roll([redeem('u1', t0, 500)], { t0, vendors: [{ ...V, points_per_dollar: 0 }] });
    assert.equal(r.vendors[0].giveawayValue, 0);
  });
});

describe('net', () => {
  test('charges every giveaway against repeat revenue only', () => {
    const t0 = startOfToday();
    const r = roll([
      earn('u1', t0 - 4 * DAY, 30),   // first visit: NOT credited
      earn('u1', t0 - DAY, 30),       // repeat: credited
      redeem('u1', t0, 100),          // $10 given away
    ], { t0 });
    const c = r.vendors[0];

    assert.equal(c.repeatRevenue, 30);
    assert.equal(c.giveawayValue, 10);
    assert.equal(c.net, 20, 'conservative on purpose: full cost, repeat-only credit');
  });
});

describe('empty and edge states', () => {
  test('a vendor with no activity reports null rates, not zero', () => {
    const r = roll([], { });
    const c = r.vendors[0];

    assert.equal(c.customers, 0);
    assert.equal(c.returnRate, null, '0% would read as "everybody churned"');
    assert.equal(c.avgTicket, null);
    assert.equal(c.visitsPerCustomer, null);
    assert.equal(c.net, 0);
  });

  test('rows older than the window are ignored', () => {
    const t0 = startOfToday();
    const r = roll([earn('u1', t0 - 40 * DAY, 99)], { t0, days: 30 });
    assert.equal(r.vendors[0].revenue, 0);
    assert.equal(r.vendors[0].customers, 0);
  });

  test('community transfers are neither revenue nor a visit', () => {
    const t0 = startOfToday();
    const r = roll([
      { type: 'community_transfer', user_id: 'u1', vendor_id: 'v1', created_at: iso(t0), points: 80, dollar_amount: 0 },
    ], { t0 });
    const c = r.vendors[0];

    assert.equal(c.customers, 0, 'moving points in is not walking in');
    assert.equal(c.revenue, 0);
    assert.equal(c.pointsAwarded, 0);
  });
});

describe('platform benchmark', () => {
  test('active students are distinct across vendors, not summed', () => {
    const t0 = startOfToday();
    const vendors = [V, { id: 'v2', name: 'Yallah', active: true, points_per_dollar: 10 }];
    const r = rollupRoi({
      txns: [
        earn('u1', t0, 10),
        { ...earn('u1', t0, 10), vendor_id: 'v2' },
        { ...earn('u2', t0, 10), vendor_id: 'v2' },
      ],
      priorPairs: new Set(), vendors, t0, days: 30,
    });

    // The breadth tier means the same students appear everywhere; summing the
    // per-vendor counts would report 3 students against a base of 2.
    assert.equal(r.platform.activeStudents, 2);
    assert.equal(r.vendors.find((c) => c.id === 'v1').customers, 1);
    assert.equal(r.vendors.find((c) => c.id === 'v2').customers, 2);
  });

  test('the median ignores vendors with no customers at all', () => {
    const t0 = startOfToday();
    const vendors = [
      V,
      { id: 'v2', name: 'Yallah', active: true, points_per_dollar: 10 },
      { id: 'v3', name: 'Nobody Came', active: true, points_per_dollar: 10 },
    ];
    const r = rollupRoi({
      txns: [
        // v1: one customer, two days → 100% return rate
        earn('u1', t0 - DAY, 10),
        earn('u1', t0, 10),
        // v2: one customer, one day → 0% return rate
        { ...earn('u2', t0, 10), vendor_id: 'v2' },
      ],
      priorPairs: new Set(), vendors, t0, days: 30,
    });

    assert.equal(r.platform.vendorsWithActivity, 2, 'v3 is not in the benchmark');
    assert.equal(r.platform.medianReturnRate, 0.5, 'median of [0, 1]');
  });
});

describe('median', () => {
  test('odd, even, and empty', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    assert.equal(median([]), null, 'empty is null so a caller cannot render 0 as a benchmark');
  });
});
