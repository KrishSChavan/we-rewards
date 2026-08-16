// Unit tests for the paging window the operator lists share (src/routes/admin.js).
//
// pageParams is what turns "?limit=&offset=" into a range four routes hand to
// PostgREST (students, errors, referrals, grants). It is the only thing between
// a hand-typed URL and a whole-table read, and it is also what "Show more" walks
// forward one page at a time — so both the clamping and the fallbacks are tested
// as a boundary. It decides before any query runs, so no database is needed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pageParams } from '../src/routes/admin.js';

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
