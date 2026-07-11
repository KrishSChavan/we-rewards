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
