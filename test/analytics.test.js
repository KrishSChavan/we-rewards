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

  test('the daily series is 14 days ending today', () => {
    const t0 = startOfToday();
    const r = rollupPlatformOverview([], t0);
    assert.equal(r.daily.length, 14);
    assert.equal(r.daily[13].date, dayKey(t0));
  });
});
