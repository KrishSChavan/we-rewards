// Unit tests for the paging window the operator lists share (src/routes/admin.js).
//
// pageParams is what turns "?limit=&offset=" into a range four routes hand to
// PostgREST (students, errors, referrals, grants). It is the only thing between
// a hand-typed URL and a whole-table read, and it is also what "Show more" walks
// forward one page at a time — so both the clamping and the fallbacks are tested
// as a boundary. It decides before any query runs, so no database is needed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pageParams, pageOf } from '../src/routes/admin.js';

const BOUNDS = { def: 50, max: 200 };

describe('pageParams', () => {
  test('a plain page request passes through', () => {
    assert.deepEqual(pageParams({ limit: '50', offset: '100' }, BOUNDS), { limit: 50, offset: 100 });
  });

  test('a missing page is the first page at the caller default', () => {
    assert.deepEqual(pageParams({}, BOUNDS), { limit: 50, offset: 0 });
    assert.deepEqual(pageParams(undefined, BOUNDS), { limit: 50, offset: 0 });
    // Each list brings its own default; the roster's is not the error log's.
    assert.equal(pageParams({}, { def: 100, max: 200 }).limit, 100);
  });

  test('limit is capped, so no URL can ask for the whole table', () => {
    assert.equal(pageParams({ limit: '10000' }, BOUNDS).limit, 200);
    assert.equal(pageParams({ limit: 'Infinity' }, BOUNDS).limit, 200);
  });

  test('a limit below one page of a single row is raised to one', () => {
    assert.equal(pageParams({ limit: '0' }, BOUNDS).limit, 50);   // 0 is "unset"
    assert.equal(pageParams({ limit: '-5' }, BOUNDS).limit, 1);
  });

  test('a negative offset reads as the first page, never a negative range', () => {
    // offset feeds .range(offset, offset + limit - 1); a negative start is a
    // PostgREST error, not an empty page.
    assert.equal(pageParams({ offset: '-1' }, BOUNDS).offset, 0);
    assert.equal(pageParams({ offset: '-999999' }, BOUNDS).offset, 0);
  });

  test('fractions are floored, because a range is row counts', () => {
    assert.deepEqual(pageParams({ limit: '10.9', offset: '5.9' }, BOUNDS), { limit: 10, offset: 5 });
  });

  test('junk falls back rather than 400ing or reaching the query as NaN', () => {
    for (const junk of ['abc', '', ' ', null, undefined, {}, []]) {
      assert.deepEqual(
        pageParams({ limit: junk, offset: junk }, BOUNDS),
        { limit: 50, offset: 0 },
        `${JSON.stringify(junk)} must not survive into a range`,
      );
    }
  });

  test('an offset past the end is left alone: an empty page is the honest answer', () => {
    assert.equal(pageParams({ offset: '10000' }, BOUNDS).offset, 10000);
  });

  test('a repeated query key (?limit=1&limit=2) cannot produce NaN', () => {
    // Express hands duplicated keys over as an array; Number(['5']) is 5, and
    // Number(['1','2']) is NaN, which must land on the default.
    assert.equal(pageParams({ limit: ['5'] }, BOUNDS).limit, 5);
    assert.equal(pageParams({ limit: ['1', '2'] }, BOUNDS).limit, 50);
  });
});

/* pageOf is the other half: pageParams says which rows to ask for, pageOf asks.
   The builder it takes is faked here — these tests are about what pageOf does
   with each answer PostgREST can give, which is exactly where the interesting
   case lives. Verified against the real stack first: with `count: 'exact'`, an
   offset past the end comes back as 416/PGRST103 carrying NO rows and NO count,
   which unhandled would turn an empty page into a 500. */
describe('pageOf', () => {
  // A builder that answers a page the way postgrest-js does, and records the
  // range it was asked for. `head` calls resolve straight to a count.
  const fakeBuilder = ({ page, count = null, error = null, total = 0, calls = [] }) => (opts) => {
    if (opts && opts.head) {
      calls.push({ head: true });
      return Promise.resolve({ data: null, count: total, error: null });
    }
    return {
      range(from, to) {
        calls.push({ from, to });
        return Promise.resolve({ data: page, count, error });
      },
    };
  };

  test('a normal page comes back with its rows and the exact total', async () => {
    const calls = [];
    const build = fakeBuilder({ page: [{ id: 'a' }, { id: 'b' }], count: 312, calls });
    const got = await pageOf(build, { limit: 50, offset: 100 });
    assert.deepEqual(got, { rows: [{ id: 'a' }, { id: 'b' }], total: 312 });
    // The range is inclusive at both ends, so a 50-row page is 100..149 — one
    // row short or long here silently overlaps or skips a row between pages.
    assert.deepEqual(calls, [{ from: 100, to: 149 }]);
  });

  test('an offset past the end is an empty page, not a 500', async () => {
    const calls = [];
    const build = fakeBuilder({
      page: null,
      error: { code: 'PGRST103', message: 'Requested range not satisfiable' },
      total: 7,
      calls,
    });
    const got = await pageOf(build, { limit: 50, offset: 99999 });
    assert.deepEqual(got, { rows: [], total: 7 });
    // The total the 416 threw away is re-read, so "Show more" still knows the
    // real size of the log rather than reporting it as empty.
    assert.deepEqual(calls, [{ from: 99999, to: 100048 }, { head: true }]);
  });

  test('any other query error is still thrown, not swallowed into an empty page', async () => {
    const build = fakeBuilder({ page: null, error: { code: '42P01', message: 'no such table' } });
    // Rethrown as-is (a PostgREST error object, not an Error) so the route's
    // next(err) reports the same thing it always did.
    await assert.rejects(
      () => pageOf(build, { limit: 50, offset: 0 }),
      (thrown) => thrown.code === '42P01' && thrown.message === 'no such table',
    );
  });

  test('a missing count falls back to what was returned rather than NaN', async () => {
    const build = fakeBuilder({ page: [{ id: 'a' }], count: null });
    assert.deepEqual(await pageOf(build, { limit: 50, offset: 0 }), { rows: [{ id: 'a' }], total: 1 });
  });

  test('an empty first page reports zero, and asks only once', async () => {
    const calls = [];
    const build = fakeBuilder({ page: [], count: 0, calls });
    assert.deepEqual(await pageOf(build, { limit: 50, offset: 0 }), { rows: [], total: 0 });
    assert.equal(calls.length, 1, 'an honest empty answer must not cost a second query');
  });
});
