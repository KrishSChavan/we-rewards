// How a vendor's address is SPELLED on the student's card — shortAddress() and
// formatAddress() in public/student/app.js.
//
// WHY THIS TEST LOOKS LIKE THIS. The four front-ends under public/ are browser
// scripts, not modules: scripts/build-client.js runs esbuild.transformSync per
// file with no bundling, so nothing in public/ can import from src/lib and
// nothing in test/ can import from public/. The repo therefore has no client
// tests at all, and these rules are exactly the kind that need one — a dozen
// small cases, most of them about a street name that must NOT be rewritten.
//
// So the block is sliced out by its own first and last landmarks and evaluated.
// The slice is deliberately brittle: if either landmark moves, this file throws
// rather than quietly testing nothing, which is the failure mode that matters
// for a harness like this. It reads public/, not .build/, because the source is
// what a person edits and the build is a pure lowering of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../public/student/app.js', import.meta.url));
const src = readFileSync(APP, 'utf8');
const from = src.indexOf('const ADDR_TAIL_TOKEN');
const to = src.indexOf('function earnRateText');
assert.ok(from > 0 && to > from, 'address block landmarks moved in public/student/app.js — re-anchor this test');

// eslint-disable-next-line no-new-func
const { shortAddress, formatAddress } = new Function(
  `${src.slice(from, to)}\nreturn { shortAddress, formatAddress };`,
)();

/* ---------- rule 1: a capital on every word ---------- */

test('a lower-case address is title-cased', () => {
  assert.equal(shortAddress('129 s pugh st'), '129 S Pugh St');
  assert.equal(shortAddress('the corner room'), 'The Corner Room');
});

test('a SHOUTED address is title-cased too, acronyms and all', () => {
  // Nothing inside an all-caps string can be told apart from a real acronym, so
  // the whole thing is treated as shouting rather than half-preserved.
  assert.equal(shortAddress('123 EAST COLLEGE AVE'), '123 E College Ave');
});

test('a word already carrying an inner capital is left exactly as typed', () => {
  // The cases a title-caser gets WRONG. "Mcallister" and "O'brien" are the
  // outputs this rule exists to avoid.
  assert.equal(shortAddress('218 McAllister St'), '218 McAllister St');
  assert.equal(shortAddress("O'Brien Plaza"), "O'Brien Plaza");
});

test('a short all-caps word in a mixed-case address is an acronym, not shouting', () => {
  assert.equal(shortAddress('PSU HUB, University Park'), 'PSU HUB, University Park');
});

test('hyphens and apostrophes start a new word — except a trailing possessive', () => {
  assert.equal(shortAddress('bell-vue manor'), 'Bell-Vue Manor');
  assert.equal(shortAddress("o'brien plaza"), "O'Brien Plaza");
  assert.equal(shortAddress("vito's pizza"), "Vito's Pizza", "the possessive s must not be capitalised");
});

test('an ordinal keeps its lower-case suffix', () => {
  // The most visible way a naive title-caser breaks: "3Rd Ave".
  assert.equal(shortAddress('3rd ave'), '3rd Ave');
  assert.equal(shortAddress('1st st'), '1st St');
});

test('a unit letter and a route number go upper', () => {
  assert.equal(shortAddress('apt 4b'), 'Apt 4B');
  assert.equal(shortAddress('us-322 w'), 'US-322 W');
});

/* ---------- rule 2: the compass words ---------- */

test('a standalone compass word becomes its letter', () => {
  assert.equal(shortAddress('123 east college ave'), '123 E College Ave');
  assert.equal(shortAddress('1000 north atherton st'), '1000 N Atherton St');
  assert.equal(shortAddress('456 West Beaver Avenue'), '456 W Beaver Avenue');
  assert.equal(shortAddress('700 south allen st'), '700 S Allen St');
});

test('the period goes with it, so both spellings converge', () => {
  // "S. Allen St" and "S Allen St" are the same address; only one is short.
  assert.equal(shortAddress('1234 N. Atherton Street'), '1234 N Atherton Street');
  assert.equal(shortAddress('S. Allen St'), shortAddress('S Allen St'));
});

test('a street whose NAME merely starts with a direction is untouched', () => {
  // Every one of these is a real State College street, and every one of them
  // would be mangled by a substring match instead of an exact-token one.
  assert.equal(shortAddress('100 Northland Center'), '100 Northland Center');
  assert.equal(shortAddress('1620 Westerly Pkwy'), '1620 Westerly Pkwy');
  assert.equal(shortAddress('300 Southgate Dr'), '300 Southgate Dr');
  assert.equal(shortAddress('700 Easterly Pkwy'), '700 Easterly Pkwy');
  assert.equal(shortAddress('Eastview Terrace'), 'Eastview Terrace');
});

/* ---------- composing with the city/state/ZIP trim ---------- */

test('the city, state and ZIP are still dropped, and what is left is formatted', () => {
  assert.equal(shortAddress('233 e beaver ave, state college, pa 16801'), '233 E Beaver Ave');
  assert.equal(shortAddress('456 W College Ave, State College, PA'), '456 W College Ave');
});

test('an address that is nothing BUT a city still renders, formatted', () => {
  // The fallback branch: trimming would leave nothing, so the original is used —
  // and it has to come out formatted too, not raw.
  assert.equal(shortAddress('state college, pa'), 'State College, PA');
});

test('empty and missing addresses stay empty', () => {
  for (const blank of ['', '   ', null, undefined]) assert.equal(shortAddress(blank), '');
});

/* ---------- the property the whole thing rests on ---------- */

test('formatting is idempotent', () => {
  // Both spellings of every rule already appear in the corpus below, so running
  // the formatter over its own output must be a no-op — otherwise a card that
  // re-rendered would drift, and an already-short stored address would be
  // treated differently from a long one.
  const corpus = [
    '123 east college ave', '123 E College Ave', '1234 N. Atherton Street',
    '218 McAllister St', "vito's pizza", '3rd ave', 'apt 4b', 'us-322 w',
    'PSU HUB, University Park', '100 Northland Center', '123 EAST COLLEGE AVE',
    'state college, pa', 'bell-vue manor', '',
  ];
  for (const raw of corpus) {
    const once = formatAddress(raw);
    assert.equal(formatAddress(once), once, `not idempotent: ${JSON.stringify(raw)}`);
  }
});
