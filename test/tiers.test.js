// Unit tests for the engagement-scoring math (src/lib/tiers.js).
// No database: scoreProfile() is fed synthetic earn transactions directly, and
// rankTier() synthetic fields of other students' scores. These lock in the two
// anti-farming caps that protect the multiplier from being gamed:
//   1. one visit per vendor per day (repeat earns same day = one visit)
//   2. at most $30 of spend credited per visit
// and the rank → tier rule (top 50% = 1.5x, top 10% = 2x, rounded up, ties up,
// a score of 0 never ranked). The last block drives computeTierProfile and
// loadTierRanking against a faked supabaseAdmin.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreProfile, rankTier, buildRanking, computeTierProfile, loadTierRanking, TIERS,
} from '../src/lib/tiers.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { resetAllCaches, vendorCatalogueCache, tierRankingCache } from '../src/lib/cache.js';

// Build one earn transaction. `day` is a YYYY-MM-DD string; scoreProfile only
// reads the first 10 chars of created_at, so the time-of-day is irrelevant.
const earn = (vendor_id, dollar_amount, day) => ({
  vendor_id,
  dollar_amount,
  created_at: `${day}T12:00:00.000Z`,
});

test('empty history scores 0', () => {
  const p = scoreProfile({ vendorCount: 5, txns: [], revisits: 0 });
  assert.equal(p.score, 0);
  assert.equal(p.tier, undefined, 'the tier is rankTier’s to decide, not scoreProfile’s');
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

test('a fully-engaged customer scores the maximum', () => {
  // Visit all 5 vendors every day for 30 days, maxing every ticket at the cap.
  const txns = [];
  for (let d = 1; d <= 30; d++) {
    const day = `2026-07-${String(d).padStart(2, '0')}`;
    for (let v = 1; v <= 5; v++) txns.push(earn(`v${v}`, 30, day));
  }
  const p = scoreProfile({ vendorCount: 5, txns });
  assert.equal(p.score, 1000);
});

test('one visit anywhere is a score above 0, even on a long vendor list', () => {
  // The "ranked at all" bar is score > 0, so a single cheap visit at one of 40
  // spots has to clear it, or a first-time student would sit unranked.
  const p = scoreProfile({ vendorCount: 40, txns: [earn('v1', 3, '2026-07-01')] });
  assert.ok(p.score > 0, `expected a positive score, got ${p.score}`);
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

test('totalSpend is the credited spend, not the raw total', () => {
  // a single $200 visit: only $30 of it is credited (anti receipt-stuffing),
  // and the hub's Spend row prints this figure
  const p = scoreProfile({ vendorCount: 1, txns: [earn('v1', 200, '2026-07-01')] });
  assert.equal(p.totalSpend, 30, 'the per-visit cap applies before this is reported');
});

/* ---------- rankTier: top 50% = 1.5x, top 10% = 2x ----------
   The pool is every signed-up student (studentCount), most of whom may never
   have scanned. Places round up, ties go up, and a score of 0 is never ranked. */

test('the tier ladder is still 1x / 1.5x / 2x, the values the bonus window math is exact for', () => {
  assert.deepEqual(TIERS.map((t) => t.multiplier), [1, 1.5, 2]);
  assert.deepEqual(TIERS.map((t) => t.topPercent), [100, 50, 10]);
});

test('a score of 0 is never ranked, even when nobody else is active', () => {
  for (const others of [[], [400, 300]]) {
    const r = rankTier({ score: 0, others, studentCount: 87 });
    assert.equal(r.tier, 1);
    assert.equal(r.multiplier, 1);
    assert.equal(r.topPercent, null);
    assert.equal(r.rank, null);
    assert.equal(r.nextMultiplier, 1.5);
  }
});

test('every signed-up student counts: one visit beats the students who never scanned', () => {
  // 87 signups, 5 of them active. A sixth student with a tiny score is ahead of
  // the 81 who have never scanned, which is the top 6% — the 2x tier.
  const r = rankTier({ score: 10, others: [900, 500, 300, 100, 50], studentCount: 87 });
  assert.equal(r.rank, 6);
  assert.equal(r.topPercent, 6);
  assert.equal(r.tier, 3);
  assert.equal(r.multiplier, 2);
  assert.equal(r.nextMultiplier, null);
  assert.equal(r.nextTierScore, null);
});

test('places round up: with 87 students the top 10% is 9 places, not 8', () => {
  const others = Array.from({ length: 20 }, (_, i) => 1000 - i * 10); // 1000, 990, … 810
  const ninth = rankTier({ score: 925, others, studentCount: 87 });   // 8 students ahead
  assert.equal(ninth.rank, 9);
  assert.equal(ninth.topPercent, 10);
  assert.equal(ninth.multiplier, 2);
  const tenth = rankTier({ score: 915, others, studentCount: 87 });   // 9 ahead
  assert.equal(tenth.rank, 10);
  assert.equal(tenth.topPercent, 11);
  assert.equal(tenth.multiplier, 1.5);
});

test('the 50% line: with 10 students the 5th place earns 1.5x and the 6th does not', () => {
  const others = [900, 800, 700, 600, 500, 400, 300, 200, 100];
  assert.equal(rankTier({ score: 550, others, studentCount: 10 }).multiplier, 1.5); // 4 ahead
  assert.equal(rankTier({ score: 450, others, studentCount: 10 }).multiplier, 1);   // 5 ahead
});

test('ties go up: everyone level on the last 2x place gets 2x', () => {
  // 20 students, so the top 10% is 2 places. Four are level on second place.
  const others = [800, 700, 700, 700];
  const r = rankTier({ score: 700, others, studentCount: 20 });
  assert.equal(r.rank, 2, 'only the 800 is strictly ahead');
  assert.equal(r.multiplier, 2);
});

test('three active students: 2x, 1.5x, 1x (the example the owner was given)', () => {
  const field = [300, 200, 100];
  const tierOf = (score) => rankTier({ score, others: field.filter((s) => s !== score), studentCount: 3 }).multiplier;
  assert.deepEqual(field.map(tierOf), [2, 1.5, 1]);
});

test('the only active student, alone, is the top tier', () => {
  assert.equal(rankTier({ score: 1, others: [], studentCount: 1 }).multiplier, 2);
});

test('a stale student count never undercounts the field it is ranking', () => {
  // The cached count can be older than the scores; n is at least everyone scored.
  const r = rankTier({ score: 100, others: [500, 400, 300], studentCount: 2 });
  assert.equal(r.studentCount, 4);
  assert.equal(r.topPercent, 76);
  assert.equal(r.multiplier, 1);
});

test('others may arrive unsorted and with zeros; neither changes the answer', () => {
  const tidy = rankTier({ score: 300, others: [500, 400, 200], studentCount: 10 });
  const messy = rankTier({ score: 300, others: [0, 200, 500, 0, 400], studentCount: 10 });
  assert.deepEqual(messy, tidy);
});

/* A deterministic PRNG, so a failure here reproduces. mulberry32. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('the score cutoffs and the rank rule agree, and reaching nextTierScore always promotes', () => {
  // cutoffs/nextTierScore are computed by a different route (the K-th best
  // score) from the tier itself (floor(100 * ahead / n) + 1). Over thousands
  // of random fields, with heavy ties, they must never disagree.
  const rand = rng(20261018);
  for (let i = 0; i < 4000; i++) {
    const studentCount = 1 + Math.floor(rand() * 150);
    const active = Math.floor(rand() * studentCount);       // others with a score
    const spread = 1 + Math.floor(rand() * 40);             // small spread = many ties
    const others = Array.from({ length: active }, () => 1 + Math.floor(rand() * spread));
    const score = Math.floor(rand() * (spread + 2));         // includes 0 and ties

    const r = rankTier({ score, others, studentCount });
    const byCutoffs = score <= 0 ? 1 : 1 + r.cutoffs.filter((c) => score >= c).length;
    assert.equal(r.tier, byCutoffs, `case ${i}: ${JSON.stringify({ score, others, studentCount, r })}`);

    // The tier never exceeds what the rank allows.
    if (r.tier === 3) assert.ok(r.topPercent <= 10);
    if (r.tier === 2) assert.ok(r.topPercent > 10 && r.topPercent <= 50);
    if (r.tier === 1 && r.topPercent != null) assert.ok(r.topPercent > 50);

    if (r.tier < 3) {
      assert.equal(r.nextTierScore, r.cutoffs[r.tier - 1]);
      const promoted = rankTier({ score: r.nextTierScore, others, studentCount });
      assert.ok(promoted.tier > r.tier, `case ${i}: reaching ${r.nextTierScore} did not promote`);
    } else {
      assert.equal(r.nextTierScore, null);
    }
  }
});

/* ---------- buildRanking: everyone's score from one month of earns ---------- */

const userEarn = (user_id, vendor_id, dollar_amount, day) => ({ user_id, ...earn(vendor_id, dollar_amount, day) });

test('buildRanking scores each student exactly as scoreProfile would, best first', () => {
  const txns = [
    userEarn('a', 'v1', 15, '2026-07-01'),
    userEarn('b', 'v1', 15, '2026-07-01'), userEarn('b', 'v2', 15, '2026-07-02'),
    userEarn('a', 'v1', 15, '2026-07-03'),
  ];
  const active = new Set(['v1', 'v2']);
  const { ranked, studentCount } = buildRanking({ txns, activeVendorIds: active, studentCount: 50 });
  assert.equal(studentCount, 50);
  const solo = (u) => scoreProfile({
    vendorCount: 2, activeVendorIds: active, txns: txns.filter((t) => t.user_id === u),
  }).score;
  assert.deepEqual(ranked, [
    { userId: 'b', score: solo('b') },
    { userId: 'a', score: solo('a') },
  ].sort((x, y) => y.score - x.score));
});

test('buildRanking leaves out students whose only earns are at hidden vendors', () => {
  const { ranked } = buildRanking({
    txns: [userEarn('a', 'v1', 15, '2026-07-01'), userEarn('ghost', 'vHidden', 15, '2026-07-01')],
    activeVendorIds: ['v1'],
    studentCount: 2,
  });
  assert.deepEqual(ranked.map((e) => e.userId), ['a'], 'a zero score is not ranked');
});

/* ---------- computeTierProfile / loadTierRanking against a fake database ---------- */

let realFrom;
beforeEach(() => {
  resetAllCaches();
  realFrom = supabaseAdmin.from;
});
afterEach(() => {
  supabaseAdmin.from = realFrom;
  resetAllCaches();
});

// A PostgREST-ish chain: every filter returns itself, awaiting it resolves
// `result(calls)`, where calls records each method and its arguments.
function fakeTable(result) {
  const calls = [];
  const chain = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(result(calls)).then(res, rej);
      if (prop === 'maybeSingle') return () => Promise.resolve(result(calls));
      return (...args) => { calls.push([prop, args]); return chain; };
    },
  });
  return chain;
}

const primeVendors = (ids) => vendorCatalogueCache.get('all', async () => ids.map((id) => ({ id })));

test('computeTierProfile ranks the live score and ignores the student’s own cached entry', async () => {
  await primeVendors(['v1', 'v2']);
  // The cache still holds this student at 900 from earlier in the month; their
  // live score is lower now. That old 900 must not count as someone ahead of them.
  await tierRankingCache.get('all', async () => ({
    ranked: [{ userId: 'me', score: 900 }, { userId: 'other', score: 5 }],
    studentCount: 2,
  }));
  supabaseAdmin.from = (table) => fakeTable(() => (table === 'transactions'
    ? { data: [earn('v1', 15, '2026-07-01'), earn('v2', 15, '2026-07-02')], error: null }
    : { data: { revisits: 0 }, error: null }));

  const p = await computeTierProfile('me');
  assert.ok(p.score > 5 && p.score < 900, `live score ${p.score}`);
  assert.equal(p.rank, 1, 'ahead of the only other student');
  assert.equal(p.tier, 3);
  assert.equal(p.multiplier, 2);
  assert.equal(p.distinctVendors, 2, 'the score fields ride along for the hub');
  assert.deepEqual(p.rankCutoffs, [50, 10]);
});

test('loadTierRanking pages past 1000 rows and counts every profile', async () => {
  await primeVendors(['v1']);
  const page = (from) => Array.from({ length: from === 0 ? 1000 : 3 }, (_, i) =>
    userEarn(`u${from + i}`, 'v1', 12, '2026-07-01'));
  const ranges = [];
  supabaseAdmin.from = (table) => fakeTable((calls) => {
    if (table === 'profiles') return { count: 1234, data: null, error: null };
    const range = calls.find(([m]) => m === 'range')[1];
    ranges.push(range);
    assert.ok(calls.some(([m, a]) => m === 'eq' && a[0] === 'type' && a[1] === 'earn'), 'earns only');
    return { data: page(range[0]), error: null };
  });

  const { ranked, studentCount } = await loadTierRanking();
  assert.deepEqual(ranges, [[0, 999], [1000, 1999]]);
  assert.equal(ranked.length, 1003);
  assert.equal(studentCount, 1234);
});
