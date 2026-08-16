// Unit tests for the two decisions GET /api/me/history makes before it renders
// anything: how wide a window a `?days=` is allowed to ask for, and how the two
// sources (transactions + community_grants) merge into one day-ordered feed.
//
// Both are worth a boundary. The window is the only query parameter in
// src/routes/student.js, and it is reachable by anyone with a URL bar — the
// clamp is what stands between a typo and a year-long table scan. The merge is
// where the "Load older" button gets its honesty: `truncated` is what stops the
// tab offering a wider window it could not actually show.
//
// Runs in the default suite (no DB): both functions are pure, and the handler's
// Supabase calls are not exercised here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { historyWindowDays, mergeHistory } from '../src/routes/student.js';

describe('historyWindowDays', () => {
  test('no parameter is the default window', () => {
    assert.equal(historyWindowDays(undefined), 30);
  });

  test('a window the client asked for passes through', () => {
    assert.equal(historyWindowDays('60'), 60);
    assert.equal(historyWindowDays('330'), 330);
    assert.equal(historyWindowDays(90), 90);
  });

  test('never narrows below the default', () => {
    // The parameter exists to widen. A student cannot be shown less than the
    // tab has always shown them.
    assert.equal(historyWindowDays('7'), 30);
    assert.equal(historyWindowDays('0'), 30);
    assert.equal(historyWindowDays('-90'), 30);
  });

  test('clamps at the ceiling', () => {
    assert.equal(historyWindowDays('9999'), 360);
    assert.equal(historyWindowDays('1e400'), 360);   // Infinity
  });

  test('junk lands on the default instead of 400ing', () => {
    // A 400 here would blank the whole Activity tab: the client throws on
    // !res.ok and falls into its connection-failure branch.
    assert.equal(historyWindowDays('abc'), 30);
    assert.equal(historyWindowDays(''), 30);
    assert.equal(historyWindowDays(null), 30);
  });

  test('a repeated or bracketed parameter lands on the default, not NaN', () => {
    // Express's qs parser hands ?days=30&days=60 over as an array and ?days[]=60
    // as an object. Number() makes both NaN, which must not propagate through
    // the clamp — this is why the fallback sits inside it.
    assert.equal(historyWindowDays(['30', '60']), 30);
    assert.equal(historyWindowDays({ 0: '60' }), 30);
  });
});

describe('mergeHistory', () => {
  const tx = (id, iso, extra = {}) => ({ id, type: 'earn', created_at: iso, vendor_id: 'v1', ...extra });
  const grant = (id, iso, points = 25) => ({ id, points, kind: 'referral_friend', reason: null, created_at: iso });

  test('a grant is reshaped into the row envelope historyRow() already reads', () => {
    const { items } = mergeHistory([], [grant('g1', '2026-08-10T12:00:00Z', 40)]);
    assert.deepEqual(items, [{
      id: 'g1',
      type: 'grant',
      grant_kind: 'referral_friend',
      reason: null,
      points: 0,                     // no vendor balance moved
      community_points: 40,
      vendor_id: null,               // a grant belongs to no spot
      created_at: '2026-08-10T12:00:00Z',
    }]);
  });

  test('both sources interleave strictly newest-first', () => {
    const { items } = mergeHistory(
      [tx('t1', '2026-08-12T09:00:00Z'), tx('t2', '2026-08-10T09:00:00Z')],
      [grant('g1', '2026-08-11T09:00:00Z'), grant('g2', '2026-08-09T09:00:00Z')],
    );
    assert.deepEqual(items.map((r) => r.id), ['t1', 'g1', 't2', 'g2']);
  });

  test('a missing source is an empty one, not a crash', () => {
    assert.deepEqual(mergeHistory(null, undefined).items, []);
    assert.equal(mergeHistory(null, undefined).truncated, false);
  });

  test('a feed inside the caps is not truncated', () => {
    const { items, truncated } = mergeHistory(
      [tx('t1', '2026-08-12T09:00:00Z')],
      [grant('g1', '2026-08-11T09:00:00Z')],
      { max: 10, grantMax: 5 },
    );
    assert.equal(items.length, 2);
    assert.equal(truncated, false);
  });

  test('the merge overflowing the cap is reported, and the newest rows win', () => {
    const rows = Array.from({ length: 6 }, (_, i) => tx(`t${i}`, `2026-08-${String(20 - i).padStart(2, '0')}T09:00:00Z`));
    const { items, truncated } = mergeHistory(rows, [], { max: 4, grantMax: 50 });
    assert.equal(truncated, true);
    assert.deepEqual(items.map((r) => r.id), ['t0', 't1', 't2', 't3']);
  });

  test('a merge landing exactly on the cap is a full page, not a complete one', () => {
    // The boundary the button turns on. Widening the window cannot reveal a row
    // that isn't already on screen once the page is full, so calling this
    // complete would offer a tap that provably changes nothing.
    const { items, truncated } = mergeHistory(
      [tx('t1', '2026-08-12T09:00:00Z'), tx('t2', '2026-08-11T09:00:00Z')],
      [grant('g1', '2026-08-10T09:00:00Z'), grant('g2', '2026-08-09T09:00:00Z')],
      { max: 4, grantMax: 50 },
    );
    assert.equal(items.length, 4);
    assert.equal(truncated, true);
  });

  test('grants saturating their own limit truncate a feed with room to spare', () => {
    // Their limit sits far below the merge cap, so they can come back capped
    // while the feed is half empty — the one case the row count cannot show.
    const grants = Array.from({ length: 3 }, (_, i) => grant(`g${i}`, `2026-08-0${i + 1}T09:00:00Z`));
    const { items, truncated } = mergeHistory([], grants, { max: 100, grantMax: 3 });
    assert.equal(items.length, 3);
    assert.equal(truncated, true);
  });
});
