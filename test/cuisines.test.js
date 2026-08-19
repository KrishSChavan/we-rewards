// Unit tests for the cuisine vocabulary and its normalisers (src/lib/cuisines.js,
// migration-042). No database: these are pure, and they are the one gate between
// four write paths (the /join application, both admin editors, and the shared
// onboardVendor) and a column whose only constraint is a cardinality cap. What
// the DB does not enforce, this does — so a mistake here is a vendor stored with
// tags the filter sheet can never match, which looks like the vendor being
// missing rather than like a bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUISINES,
  MAX_CUISINES,
  normalizeCuisine,
  normalizePriceLevel,
} from '../src/lib/cuisines.js';

const VALUES = CUISINES.map((c) => c.value);

test('every tag is a lowercase slug with a distinct display label', () => {
  for (const c of CUISINES) {
    // The student app derives its chip labels by prettifying these slugs, and
    // the DB stores them verbatim — an uppercase or spaced value would round-trip
    // as a tag no chip matches.
    assert.match(c.value, /^[a-z]+(-[a-z]+)*$/, `bad slug: ${c.value}`);
    assert.ok(c.label && typeof c.label === 'string', `missing label for ${c.value}`);
  }
  assert.equal(new Set(VALUES).size, VALUES.length, 'duplicate tag value');
  assert.equal(new Set(CUISINES.map((c) => c.label)).size, CUISINES.length, 'duplicate label');
});

test('MAX_CUISINES matches the cardinality cap the migration enforces', () => {
  // vendors_cuisine_len is `cardinality(cuisine) <= 3`. If these drift, the
  // pickers offer a fourth tick that the database then rejects outright.
  assert.equal(MAX_CUISINES, 3);
});

test('known tags pass through, unknown ones are dropped rather than rejected', () => {
  assert.deepEqual(normalizeCuisine(['coffee', 'pizza']), ['coffee', 'pizza']);
  // A stale client offering a retired tag must not fail the vendor's whole save.
  assert.deepEqual(normalizeCuisine(['coffee', 'not-a-real-tag']), ['coffee']);
  assert.deepEqual(normalizeCuisine(['nope']), []);
});

test('input is trimmed and case-folded before it is matched', () => {
  assert.deepEqual(normalizeCuisine(['  COFFEE ', 'Pizza']), ['coffee', 'pizza']);
});

test('duplicates collapse and the result is capped at MAX_CUISINES', () => {
  assert.deepEqual(normalizeCuisine(['coffee', 'coffee', 'coffee']), ['coffee']);
  assert.equal(normalizeCuisine(VALUES).length, MAX_CUISINES);
});

test('order is canonical, so re-saving the same picks is a genuine no-op', () => {
  // Two students of the same shop ticking the same boxes in a different order
  // must store byte-identical arrays, or every save looks like a change.
  assert.deepEqual(normalizeCuisine(['pizza', 'coffee']), normalizeCuisine(['coffee', 'pizza']));
});

test('a non-array (or nothing at all) normalises to the empty list, not a throw', () => {
  // The /join form omits the field entirely on an older cached page.
  for (const junk of [undefined, null, '', 'coffee', 42, {}, { 0: 'coffee' }]) {
    assert.deepEqual(normalizeCuisine(junk), []);
  }
  assert.deepEqual(normalizeCuisine([1, null, undefined, {}]), []);
});

test('price tiers 1..4 survive, as numbers, from either a string or a number', () => {
  for (const n of [1, 2, 3, 4]) {
    assert.equal(normalizePriceLevel(n), n);
    assert.equal(normalizePriceLevel(String(n)), n);   // a <select> value is a string
  }
});

test('everything outside 1..4 becomes null — "not said", never a real tier', () => {
  // 0 is the one that matters: an untagged spot must not read as the cheapest
  // option in town, which is why the column is nullable in the first place.
  for (const junk of [0, 5, -1, 1.5, '', ' ', 'free', NaN, Infinity, null, undefined, {}, []]) {
    assert.equal(normalizePriceLevel(junk), null, `expected null for ${JSON.stringify(junk)}`);
  }
});

test('a price tier stays within the range the DB check constraint allows', () => {
  // vendors_price_level_range is `price_level is null or between 1 and 4`.
  for (const input of [0, 1, 2, 3, 4, 5, 99, '3', 'x', null]) {
    const out = normalizePriceLevel(input);
    assert.ok(out === null || (Number.isInteger(out) && out >= 1 && out <= 4),
      `${JSON.stringify(input)} normalised to an unstorable ${out}`);
  }
});
