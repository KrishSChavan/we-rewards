// Unit tests for the pure engagement-scoring math (src/lib/tiers.js).
// No database: scoreProfile() is fed synthetic earn transactions directly.
// These lock in the score/tier/multiplier mapping and the two anti-farming
// caps that protect the multiplier from being gamed:
//   1. one visit per vendor per day (repeat earns same day = one visit)
//   2. at most $30 of spend credited per visit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreProfile, TIERS } from '../src/lib/tiers.js';

// Build one earn transaction. `day` is a YYYY-MM-DD string; scoreProfile only
// reads the first 10 chars of created_at, so the time-of-day is irrelevant.
const earn = (vendor_id, dollar_amount, day) => ({
  vendor_id,
  dollar_amount,
  created_at: `${day}T12:00:00.000Z`,
});

// The tier the scoring is *supposed* to land on for a given score, derived
// straight from the TIERS ladder — lets us assert the selection is consistent
// with the score no matter what the score works out to.
function expectedTier(score) {
  return [...TIERS].reverse().find((t) => score >= t.minScore) ?? TIERS[0];
}

test('empty history scores 0 and sits at the base tier (1x)', () => {
  const p = scoreProfile({ vendorCount: 5, txns: [], revisits: 0 });
  assert.equal(p.score, 0);
  assert.equal(p.tier, 1);
  assert.equal(p.multiplier, 1);
  assert.equal(p.totalVisits, 0);
  assert.equal(p.totalSpend, 0);
  assert.equal(p.distinctVendors, 0);
});

test('anti-farming: repeat earns at one vendor on one day count as a single visit', () => {
  const txns = [
    earn('v1', 10, '2026-07-01'),
    earn('v1', 10, '2026-07-01'),
    earn('v1', 10, '2026-07-01'),
  ];
  const p = scoreProfile({ vendorCount: 5, txns });
  assert.equal(p.totalVisits, 1, 'three same-day earns collapse to one visit');
  assert.equal(p.distinctVendors, 1);
  assert.equal(p.revisitVendors, 0, 'a single day is not a revisit');
});

test('anti-farming: a visit credits at most $30 of spend even on a huge ticket', () => {
  // One vendor, one day, $500 spent across two receipts — capped at $30.
  const p = scoreProfile({
    vendorCount: 5,
    txns: [earn('v1', 300, '2026-07-01'), earn('v1', 200, '2026-07-01')],
  });
  assert.equal(p.totalVisits, 1);
  assert.equal(p.totalSpend, 30, 'per-visit spend is capped at $30');
});

test('spend under the cap is credited in full and sums across visit-days', () => {
  const p = scoreProfile({
    vendorCount: 5,
    txns: [earn('v1', 12, '2026-07-01'), earn('v1', 8, '2026-07-02')],
  });
  assert.equal(p.totalVisits, 2, 'different days at the same vendor are separate visits');
  assert.equal(p.totalSpend, 20);
  assert.equal(p.distinctVendors, 1);
  assert.equal(p.revisitVendors, 1, 'two days at the same vendor makes it a revisit');
});

test('distinct vendors drive breadth; visiting more spots raises the score', () => {
  const oneSpot = scoreProfile({ vendorCount: 5, txns: [earn('v1', 15, '2026-07-01')] });
  const threeSpots = scoreProfile({
    vendorCount: 5,
    txns: [earn('v1', 15, '2026-07-01'), earn('v2', 15, '2026-07-01'), earn('v3', 15, '2026-07-01')],
  });
  assert.equal(oneSpot.distinctVendors, 1);
  assert.equal(threeSpots.distinctVendors, 3);
  assert.ok(threeSpots.breadth > oneSpot.breadth);
  assert.ok(threeSpots.score > oneSpot.score, 'more breadth ⇒ higher score');
});

test('a fully-engaged customer reaches the top tier (2x)', () => {
  // Visit all 5 vendors every day for 30 days, maxing every ticket at the cap.
  const txns = [];
  for (let d = 1; d <= 30; d++) {
    const day = `2026-07-${String(d).padStart(2, '0')}`;
    for (let v = 1; v <= 5; v++) txns.push(earn(`v${v}`, 30, day));
  }
  const p = scoreProfile({ vendorCount: 5, txns });
  assert.equal(p.score, 1000);
  assert.equal(p.tier, 3);
  assert.equal(p.multiplier, 2);
});

test('a moderately-engaged customer lands in the middle tier (1.5x)', () => {
  const txns = [];
  // vendor A on 4 distinct days, vendor B on 3 distinct days, ~$15 each visit.
  for (let d = 1; d <= 4; d++) txns.push(earn('vA', 15, `2026-07-0${d}`));
  for (let d = 1; d <= 3; d++) txns.push(earn('vB', 15, `2026-07-1${d}`));
  const p = scoreProfile({ vendorCount: 5, txns });
  assert.ok(p.score >= 350 && p.score < 700, `expected mid-band score, got ${p.score}`);
  assert.equal(p.tier, 2);
  assert.equal(p.multiplier, 1.5);
});

test('cutoffs and the reported tier always agree with the TIERS ladder', () => {
  assert.deepEqual(scoreProfile({ vendorCount: 5, txns: [] }).cutoffs, [350, 700]);
  const scenarios = [
    { vendorCount: 5, txns: [] },
    { vendorCount: 5, txns: [earn('v1', 15, '2026-07-01')] },
    { vendorCount: 5, txns: [earn('vA', 15, '2026-07-01'), earn('vB', 15, '2026-07-02')] },
  ];
  for (const s of scenarios) {
    const p = scoreProfile(s);
    const want = expectedTier(p.score);
    assert.equal(p.tier, want.tier);
    assert.equal(p.multiplier, want.multiplier);
  }
});

test('the lifetime revisit counter is passed through untouched', () => {
  assert.equal(scoreProfile({ vendorCount: 5, txns: [], revisits: 42 }).revisits, 42);
  assert.equal(scoreProfile({ vendorCount: 5, txns: [] }).revisits, 0, 'defaults to 0');
});

test('a zero active-vendor count degrades gracefully (no divide-by-zero)', () => {
  const p = scoreProfile({ vendorCount: 0, txns: [earn('v1', 15, '2026-07-01')] });
  assert.equal(p.breadth, 0);
  assert.ok(Number.isFinite(p.score));
});

test('txns at an admin-hidden vendor contribute nothing to visits, spend, or breadth', () => {
  // vHidden was hidden by the admin (vendors.active = false), so it is absent
  // from activeVendorIds — its earns must not feed any component.
  const p = scoreProfile({
    vendorCount: 2,
    activeVendorIds: new Set(['v1', 'v2']),
    txns: [
      earn('v1', 15, '2026-07-01'),
      earn('vHidden', 25, '2026-07-01'),
      earn('vHidden', 25, '2026-07-02'),
    ],
  });
  assert.equal(p.distinctVendors, 1, 'hidden vendor is not a distinct vendor');
  assert.equal(p.totalVisits, 1, 'hidden-vendor days are not visits');
  assert.equal(p.totalSpend, 15, 'hidden-vendor dollars are not credited');
  assert.equal(p.revisitVendors, 0, 'two days at a hidden vendor is not a revisit');
});

test('filtering hidden-vendor txns matches scoring only the active-vendor txns', () => {
  const activeTxns = [
    earn('v1', 12, '2026-07-01'),
    earn('v1', 8, '2026-07-02'),
    earn('v2', 15, '2026-07-03'),
  ];
  const hiddenTxns = [earn('vHidden', 30, '2026-07-01'), earn('vHidden', 30, '2026-07-04')];
  const filtered = scoreProfile({
    vendorCount: 3,
    activeVendorIds: new Set(['v1', 'v2', 'v3']),
    txns: [...activeTxns, ...hiddenTxns],
  });
  const activeOnly = scoreProfile({ vendorCount: 3, txns: activeTxns });
  assert.deepEqual(filtered, activeOnly, 'hidden-vendor txns must be a no-op end to end');
});

test('activeVendorIds also accepts a plain array of ids', () => {
  const asSet = scoreProfile({
    vendorCount: 1,
    activeVendorIds: new Set(['v1']),
    txns: [earn('v1', 15, '2026-07-01'), earn('vHidden', 15, '2026-07-01')],
  });
  const asArray = scoreProfile({
    vendorCount: 1,
    activeVendorIds: ['v1'],
    txns: [earn('v1', 15, '2026-07-01'), earn('vHidden', 15, '2026-07-01')],
  });
  assert.deepEqual(asArray, asSet);
  assert.equal(asArray.distinctVendors, 1);
});

test('omitting activeVendorIds preserves the legacy behavior (every txn scores)', () => {
  const txns = [earn('v1', 15, '2026-07-01'), earn('vGone', 20, '2026-07-02')];
  const legacy = scoreProfile({ vendorCount: 5, txns });
  assert.equal(legacy.distinctVendors, 2, 'no filter param ⇒ all vendors count');
  assert.equal(legacy.totalVisits, 2);
  assert.equal(legacy.totalSpend, 35);
  // …and passing a set that covers every vendor in the txns changes nothing.
  const covered = scoreProfile({ vendorCount: 5, activeVendorIds: new Set(['v1', 'vGone']), txns });
  assert.deepEqual(covered, legacy);
});

/* ---------- `remaining`: what each lever still needs for full credit ----------
   The home screen's "how you climb" rows print these verbatim ("2 more spots"),
   so they have to be counts the student can act on, never negative, and zero
   exactly when that component is already maxed. */

test('remaining counts down to zero as each component reaches full credit', () => {
  // one visit, one vendor, out of five active vendors
  const early = scoreProfile({ vendorCount: 5, txns: [earn('v1', 5, '2026-07-01')] });
  assert.equal(early.remaining.spots, 4, 'four unvisited vendors left');
  assert.equal(early.remaining.revisits, 3, 'revisit target floors at 3');
  assert.equal(early.remaining.visits, 23, 'one of the 24 visit-days done');
  assert.equal(early.remaining.spend, 245, '$5 of $250 credited');
  assert.equal(early.remaining.smallOrders, true, '$5 is under a meal-sized ticket');
});

test('remaining never goes negative once a target is passed', () => {
  // every vendor visited many times, well past every target
  const txns = [];
  for (const v of ['v1', 'v2']) {
    for (let d = 1; d <= 28; d++) {
      txns.push(earn(v, 25, `2026-07-${String(d).padStart(2, '0')}`));
    }
  }
  const maxed = scoreProfile({ vendorCount: 2, txns });   // revisit ask is capped at V
  for (const [key, value] of Object.entries(maxed.remaining)) {
    if (key === 'smallOrders') continue;
    assert.equal(value, 0, `${key} should bottom out at 0, got ${value}`);
    assert.ok(!Number.isNaN(value), `${key} must be a number`);
  }
  assert.equal(maxed.remaining.smallOrders, false, '$25 tickets are meal-sized');
});

test('remaining.spend reflects the credited spend, not the raw total', () => {
  // a single $200 visit: only $30 of it is credited (anti receipt-stuffing)
  const p = scoreProfile({ vendorCount: 1, txns: [earn('v1', 200, '2026-07-01')] });
  assert.equal(p.totalSpend, 30, 'the per-visit cap applies before this is reported');
  assert.equal(p.remaining.spend, 220, 'so $220 of credit is still outstanding');
});

test('remaining.smallOrders is false when there is no visit to judge', () => {
  const none = scoreProfile({ vendorCount: 4, txns: [] });
  assert.equal(none.remaining.smallOrders, false, 'no visits ⇒ nothing to call small');
  assert.equal(none.remaining.spots, 4);
  assert.equal(none.remaining.visits, 24);
});

test('remaining.revisits is capped at the vendor count, so the ask is always possible', () => {
  // Two active vendors, both already revisited. revisitTarget floors at 3, so
  // the raw gap is 1 — but there is no third vendor to go back to.
  const txns = [
    earn('v1', 12, '2026-07-01'), earn('v1', 12, '2026-07-02'),
    earn('v2', 12, '2026-07-03'), earn('v2', 12, '2026-07-04'),
  ];
  const p = scoreProfile({ vendorCount: 2, txns });
  assert.equal(p.revisitVendors, 2);
  assert.equal(p.remaining.revisits, 0, 'nothing left to ask for on a two-vendor campus');
});
