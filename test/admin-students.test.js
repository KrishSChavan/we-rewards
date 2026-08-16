// Unit tests for the student roster's search sanitizer (src/routes/admin.js).
//
// The search box is interpolated into a PostgREST `or=(name.ilike.*term*,…)`
// filter, which is a grammar, not a value: an unescaped comma or paren would
// let a typed term rewrite the query rather than be searched for. safeSearch is
// the only thing standing between the two, so it is tested as a boundary.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { safeSearch } from '../src/routes/admin.js';

describe('safeSearch', () => {
  test('ordinary terms pass through untouched', () => {
    assert.equal(safeSearch('Casey'), 'Casey');
    assert.equal(safeSearch('casey.jones+tag@psu.edu'), 'casey.jones+tag@psu.edu');
  });

  test('every character with meaning in a PostgREST filter is blanked', () => {
    for (const c of [',', '(', ')', '"', "'", '\\']) {
      assert.equal(safeSearch(`a${c}b`), 'a b', `"${c}" must not survive into the filter`);
    }
  });

  test('an injected second condition cannot survive', () => {
    // The shape that would matter: closing the ilike and opening another filter.
    const hostile = 'x*,email.ilike.*@psu.edu';
    const safe = safeSearch(hostile);
    assert.ok(!safe.includes(','), 'no comma to separate a second condition');
    assert.ok(!safe.includes('*'), 'no wildcard to close the pattern');
  });

  test('LIKE wildcards are dropped so a term is always literal', () => {
    assert.equal(safeSearch('%'), '');
    assert.equal(safeSearch('a%b*c'), 'a b c');
  });

  test('underscore is kept: it is in real addresses, and a superset match is harmless', () => {
    assert.equal(safeSearch('first_last@psu.edu'), 'first_last@psu.edu');
  });

  test('whitespace is trimmed and the term is capped', () => {
    assert.equal(safeSearch('   casey   '), 'casey');
    assert.equal(safeSearch('a'.repeat(500)).length, 100);
  });

  test('non-strings are treated as no search, never coerced into one', () => {
    assert.equal(safeSearch(undefined), '');
    assert.equal(safeSearch(null), '');
    // Express gives an array when the query key repeats (?q=a&q=b).
    assert.equal(safeSearch(['a', 'b']), 'a b');
  });
});
