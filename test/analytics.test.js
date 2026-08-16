// Unit tests for the pure analytics rollups (src/lib/analytics.js), extracted
// from the /api/vendor/analytics and /api/admin/overview handlers. No database:
// synthetic transaction rows are fed straight in. These lock in the tricky part
// — the SIGNED reversal netting (migration-010): a compensating row must cancel
// the original out of every total, count, revenue figure, and top-list.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rollupVendorAnalytics, rollupPlatformOverview, dayKey } from '../src/lib/analytics.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
// Start of local today, exactly how the routes derive t0.
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const iso = (ms) => new Date(ms).toISOString();

describe('rollupVendorAnalytics', () => {
  test('a reversed earn nets back out (0 net) in every window', () => {
    const t0 = startOfToday();
    const r = rollupVendorAnalytics([
      { type: 'earn', points: 100, dollar_amount: 10, created_at: iso(t0 + 2 * HOUR), user_id: 'u1' },
      { type: 'earn', points: -100, dollar_amount: -10, created_at: iso(t0 + 3 * HOUR), user_id: 'u1' }, // reversal
    ], t0);

    assert.equal(r.today.awards, 0, '+1 and −1 award net to 0');
    assert.equal(r.today.revenue, 0, '+$10 and −$10 net to 0');
    assert.equal(r.today.earnPoints, 0);
    assert.equal(r.last30.awards, 0);
    assert.equal(r.last30.revenue, 0);
    assert.equal(r.today.customers, 1, 'the customer is still counted once');
  });

  test('redeems are counted; a fully-reversed reward drops out of topRewards', () => {
    const t0 = startOfToday();
    const r = rollupVendorAnalytics([
      { type: 'redeem', points: -50, created_at: iso(t0 + HOUR), user_id: 'u2', rewards: { title: 'Free drink' } },
      { type: 'redeem', points: -30, created_at: iso(t0 + HOUR), user_id: 'u3', rewards: { title: 'Latte' } },
      { type: 'redeem', points: 30, created_at: iso(t0 + 2 * HOUR), user_id: 'u3', rewards: { title: 'Latte' } }, // reversal
    ], t0);

    assert.equal(r.today.redemptions, 1, 'Free drink +1, Latte +1 then −1 = net 1');
    assert.equal(r.today.redeemPoints, 50, '50 + 30 − 30');
    assert.deepEqual(r.topRewards, [{ title: 'Free drink', count: 1 }], 'Latte nets to 0 and is filtered out');
  });

  test('returningCustomers = users with 2+ distinct award-days', () => {
    const t0 = startOfToday();
    const r = rollupVendorAnalytics([
      { type: 'earn', points: 10, dollar_amount: 1, created_at: iso(t0 + HOUR), user_id: 'u1' },
      { type: 'earn', points: 10, dollar_amount: 1, created_at: iso(t0 - DAY + HOUR), user_id: 'u1' }, // different day
      { type: 'earn', points: 10, dollar_amount: 1, created_at: iso(t0 + HOUR), user_id: 'u2' },
      { type: 'earn', points: 10, dollar_amount: 1, created_at: iso(t0 + 2 * HOUR), user_id: 'u2' },   // same day
    ], t0);
    assert.equal(r.last30.returningCustomers, 1, 'only u1 visited on two distinct days');
  });

  test('windowing: an earn only in the 30-day window is absent from 7-day/today', () => {
    const t0 = startOfToday();
    const r = rollupVendorAnalytics([
      { type: 'earn', points: 200, dollar_amount: 20, created_at: iso(t0 - 10 * DAY + HOUR), user_id: 'u1' },
    ], t0);
    assert.equal(r.last30.awards, 1);
    assert.equal(r.last30.revenue, 20);
    assert.equal(r.last7.awards, 0);
    assert.equal(r.today.awards, 0);
  });

  test('the daily series is 14 days ending today', () => {
    const t0 = startOfToday();
    const r = rollupVendorAnalytics([], t0);
    assert.equal(r.daily.length, 14);
    assert.equal(r.daily[13].date, dayKey(t0), 'last bucket is today');
    assert.equal(r.daily[0].date, dayKey(t0 - 13 * DAY), 'first bucket is 13 days ago');
  });

  // The community-points.md step-5 audit made concrete: before migration-027 a
  // +80 transfer fell into the redeem arm, where redeemPoints dropped by 80 and
  // redemptions DECREMENTED — quietly erasing a real redemption.
  test('an inbound community transfer never pollutes awards/redemptions/customers', () => {
    const t0 = startOfToday();
    const r = rollupVendorAnalytics([
      { type: 'redeem', points: -50, created_at: iso(t0 + HOUR), user_id: 'u1', rewards: { title: 'Free drink' } },
      { type: 'community_transfer', points: 80, created_at: iso(t0 + 2 * HOUR), user_id: 'u2' },
    ], t0);

    assert.equal(r.today.redemptions, 1, 'the transfer must not decrement the real redemption');
    assert.equal(r.today.redeemPoints, 50, 'the transfer must not subtract from redeemed points');
    assert.equal(r.today.awards, 0, 'a transfer is not an award either');
    assert.equal(r.today.revenue, 0);
    assert.equal(r.today.customers, 1, 'a transfer is not a visit — only the redeemer counts');
    assert.equal(r.today.movedIn, 1, 'but it IS surfaced on its own');
    assert.equal(r.today.movedInPoints, 80);
    assert.equal(r.last30.movedInPoints, 80);
    assert.deepEqual(r.topRewards, [{ title: 'Free drink', count: 1 }], 'and stays out of topRewards');
  });
});

describe('rollupPlatformOverview', () => {
  test('reversed earn nets out; activeStudents dedups; net-zero vendor drops from topVendors', () => {
    const t0 = startOfToday();
    const r = rollupPlatformOverview([
      { type: 'earn', points: 100, dollar_amount: 10, created_at: iso(t0 + HOUR), user_id: 'u1', vendor_id: 'v1', vendors: { name: 'A' } },
      { type: 'earn', points: -100, dollar_amount: -10, created_at: iso(t0 + 2 * HOUR), user_id: 'u1', vendor_id: 'v1', vendors: { name: 'A' } },
      { type: 'earn', points: 50, dollar_amount: 5, created_at: iso(t0 + HOUR), user_id: 'u2', vendor_id: 'v2', vendors: { name: 'B' } },
    ], t0);

    assert.equal(r.today.awards, 1, 'v1 nets 0, v2 +1');
    assert.equal(r.today.revenue, 5, '$10 − $10 + $5');
    assert.equal(r.today.activeStudents, 2, 'u1 and u2');
    assert.equal(r.topVendors.length, 1, 'vendor A netted to $0 revenue and is filtered out');
    assert.equal(r.topVendors[0].name, 'B');
    assert.equal(r.topVendors[0].revenue, 5);
  });

  test('topVendors is sorted by revenue descending', () => {
    const t0 = startOfToday();
    const r = rollupPlatformOverview([
      { type: 'earn', points: 50, dollar_amount: 5, created_at: iso(t0 + HOUR), user_id: 'u1', vendor_id: 'v2', vendors: { name: 'B' } },
      { type: 'earn', points: 80, dollar_amount: 8, created_at: iso(t0 + HOUR), user_id: 'u2', vendor_id: 'v3', vendors: { name: 'C' } },
    ], t0);
    assert.deepEqual(r.topVendors.map((v) => v.name), ['C', 'B'], 'higher revenue first');
  });

  // A vendor the operator switched off is gone from every student surface, so it
  // must not hold a slot in the top-5. Its money still happened, though: the
  // windows and the chart keep counting it, or an off-toggle would look like the
  // platform lost revenue it really earned.
  test('a switched-off vendor drops out of topVendors but stays in the totals', () => {
    const t0 = startOfToday();
    const r = rollupPlatformOverview([
      { type: 'earn', points: 900, dollar_amount: 90, created_at: iso(t0 + HOUR), user_id: 'u1', vendor_id: 'v1', vendors: { name: 'Closed', active: false } },
      { type: 'earn', points: 50, dollar_amount: 5, created_at: iso(t0 + HOUR), user_id: 'u2', vendor_id: 'v2', vendors: { name: 'Open', active: true } },
    ], t0);

    assert.deepEqual(r.topVendors.map((v) => v.name), ['Open'], 'the off vendor is not ranked, despite the higher revenue');
    assert.equal(r.today.revenue, 95, 'platform revenue still counts what the off vendor earned');
    assert.equal(r.today.awards, 2);
    assert.equal(r.daily[13].revenue, 95, 'and so does the chart');
  });

  // Deleting a vendor leaves the join empty, which is not the same thing as
  // switching one off; those rows already collapse into one generic "Vendor".
  test('a missing vendor join is still ranked', () => {
    const t0 = startOfToday();
    const r = rollupPlatformOverview([
      { type: 'earn', points: 100, dollar_amount: 10, created_at: iso(t0 + HOUR), user_id: 'u1', vendor_id: null, vendors: null },
    ], t0);
    assert.deepEqual(r.topVendors.map((v) => v.name), ['Vendor']);
  });

  test('the daily series is 14 days ending today', () => {
    const t0 = startOfToday();
    const r = rollupPlatformOverview([], t0);
    assert.equal(r.daily.length, 14);
    assert.equal(r.daily[13].date, dayKey(t0));
  });

  // Platform totals must not double-count a transfer: the mint already counted
  // these points once, and the move is the same points changing pockets.
  test('a community transfer is counted on its own, not as an award or redemption', () => {
    const t0 = startOfToday();
    const r = rollupPlatformOverview([
      { type: 'earn', points: 100, dollar_amount: 10, created_at: iso(t0 + HOUR), user_id: 'u1', vendor_id: 'v1', vendors: { name: 'A' } },
      { type: 'community_transfer', points: 40, created_at: iso(t0 + 2 * HOUR), user_id: 'u1', vendor_id: 'v2', vendors: { name: 'B' } },
    ], t0);

    assert.equal(r.today.awards, 1, 'only the earn is an award');
    assert.equal(r.today.redemptions, 0, 'the transfer must not run redemptions backwards');
    assert.equal(r.today.pointsAwarded, 100);
    assert.equal(r.today.pointsRedeemed, 0);
    assert.equal(r.today.transfers, 1);
    assert.equal(r.today.pointsMoved, 40);
    assert.equal(r.topVendors.length, 1, 'B earned nothing — a transfer is not revenue');
    assert.equal(r.topVendors[0].name, 'A');
  });
});
