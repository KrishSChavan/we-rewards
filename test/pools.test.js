// Unit tests for the purse rule (src/lib/pools.js) — the pure half, which is
// where the rule actually lives. The queries are covered by the SQL harness and
// the integration suite; what has to be right HERE is which table a vendor's
// points come from, because getting it wrong shows a customer a balance they
// cannot spend or hides one they can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPooled, purseOf, balanceFrom } from '../src/lib/pools.js';

const solo   = { id: 'v-solo', pool_id: null };
const down   = { id: 'v-down', pool_id: 'p-joes' };
const campus = { id: 'v-campus', pool_id: 'p-joes' };

test('a vendor with no pool_id keeps its own purse', () => {
  assert.equal(isPooled(solo), false);
  assert.deepEqual(purseOf(solo), {
    table: 'point_balances', column: 'vendor_id', id: 'v-solo', shared: false,
  });
});

test('a pooled vendor spends from the pool, not from itself', () => {
  assert.equal(isPooled(down), true);
  assert.deepEqual(purseOf(down), {
    table: 'pool_balances', column: 'pool_id', id: 'p-joes', shared: true,
  });
});

test('siblings in one pool resolve to the SAME purse', () => {
  // The whole feature in one assertion: earn at Downtown, spend at Campus.
  assert.equal(purseOf(down).id, purseOf(campus).id);
  assert.equal(purseOf(down).table, purseOf(campus).table);
});

test('a null/undefined vendor does not throw, and points nowhere', () => {
  // Defensive because purseOf feeds a query builder: a bad row must produce a
  // filter that matches nothing, never one that matches everything.
  for (const junk of [null, undefined, {}]) {
    const p = purseOf(junk);
    assert.equal(p.id, null);
    assert.equal(p.shared, false);
  }
});

/* ---------- reading a balance out of the two maps ---------- */

const maps = () => ({
  byVendor: new Map([['v-solo', 40], ['v-down', 300], ['v-campus', 120]]),
  byPool: new Map([['p-joes', 420]]),
});

test('an unpooled vendor reads its own row', () => {
  assert.equal(balanceFrom(solo, maps()), 40);
});

test('a pooled vendor reads the POOL, ignoring any stale per-vendor row', () => {
  // The stale rows are real: joining zeroes them, but a row that was zeroed
  // still exists, and a later leave writes into it again. If this ever read the
  // vendor row for a pooled vendor, a customer would see 300 at Downtown and
  // 120 at Campus for one 420-point purse and believe they had 420 twice.
  assert.equal(balanceFrom(down, maps()), 420);
  assert.equal(balanceFrom(campus, maps()), 420);
});

test('both siblings show the same number', () => {
  const m = maps();
  assert.equal(balanceFrom(down, m), balanceFrom(campus, m));
});

test('never-visited spots are zero, not undefined', () => {
  // These reach a template as `${balance} pts`, so undefined is a visible bug.
  const empty = { byVendor: new Map(), byPool: new Map() };
  assert.equal(balanceFrom(solo, empty), 0);
  assert.equal(balanceFrom(down, empty), 0);
  assert.equal(balanceFrom(down, {}), 0);
});

test('a pooled spot the customer has never earned at still shows the chain balance', () => {
  // The point of sharing: a first visit to Campus is not a zero balance.
  const m = { byVendor: new Map(), byPool: new Map([['p-joes', 420]]) };
  assert.equal(balanceFrom(campus, m), 420);
});

test('a zero pool balance is not confused with an absent one', () => {
  const m = { byVendor: new Map([['v-down', 300]]), byPool: new Map([['p-joes', 0]]) };
  assert.equal(balanceFrom(down, m), 0, 'a spent-out pool reads 0, not the stale local 300');
});
