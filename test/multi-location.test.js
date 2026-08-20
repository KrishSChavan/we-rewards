// Unit tests for one login running several stores (migration-043). Two pure
// pieces carry the whole feature and neither needs a database:
//
//   • validApplication (src/routes/apply.js) decides what a /join application
//     may name. It is the only public, unauthenticated door into onboarding, so
//     everything a chain sends arrives here first.
//   • chooseVendorLink (src/middleware/auth.js) decides WHICH of an account's
//     stores a request is about. Getting this wrong doesn't 500 — it rings a
//     sale up at the wrong shop and tells nobody, which is why it is pulled out
//     of requireVendor and tested branch by branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validApplication } from '../src/routes/apply.js';
import { chooseVendorLink } from '../src/middleware/auth.js';

const GOOD = {
  businessName: 'Joe’s Pizza',
  contactName: 'Joe',
  phone: '814 555 0100',
  email: 'joe@example.com',
  password: 'a-good-password',
};

const apply = (extra) => validApplication({ ...GOOD, ...extra });

/* ---------- the single-location application is unchanged ---------- */

test('an application that names no extra locations lands with locations: []', () => {
  const out = apply({});
  assert.equal(out.error, undefined);
  assert.deepEqual(out.fields.locations, []);
  assert.equal(out.fields.location_label, null);
});

test('a location label is trimmed, and blank stays null rather than empty string', () => {
  assert.equal(apply({ locationLabel: '  Downtown  ' }).fields.location_label, 'Downtown');
  assert.equal(apply({ locationLabel: '   ' }).fields.location_label, null);
});

test('40 characters of label is allowed, 41 is not (boundary)', () => {
  assert.equal(apply({ locationLabel: 'x'.repeat(40) }).fields.location_label.length, 40);
  assert.match(apply({ locationLabel: 'x'.repeat(41) }).error, /40 characters/);
});

/* ---------- extra locations ---------- */

test('extra locations are normalised the same way location one is', () => {
  const out = apply({
    locations: [{ name: '  Joe’s Pizza  ', locationLabel: ' Campus ', address: ' 1 College Ave ' }],
  });
  assert.equal(out.error, undefined);
  assert.deepEqual(out.fields.locations, [{
    name: 'Joe’s Pizza',
    locationLabel: 'Campus',
    address: '1 College Ave',
    logo: null,
    cuisine: [],
    priceLevel: null,
  }]);
});

test('a nameless extra location is refused, and the message says which one', () => {
  // Counting the application's own location as 1, so "Location 3" is the second
  // row of the form — the number the applicant is actually looking at.
  const out = apply({ locations: [{ name: 'Two' }, { locationLabel: 'Westgate' }] });
  assert.match(out.error, /Location 3/);
  assert.match(out.error, /business name/i);
});

test('a location that is not an object at all is refused, not skipped', () => {
  for (const junk of [null, 'Campus', 42, ['Campus']]) {
    assert.match(apply({ locations: [junk] }).error, /Location 2/, `should reject ${JSON.stringify(junk)}`);
  }
});

test('`locations` must be a list', () => {
  assert.match(apply({ locations: { name: 'Campus' } }).error, /list/);
});

test('12 locations total is allowed, 13 is not (boundary)', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ name: `Shop ${i + 2}` }));
  assert.equal(apply({ locations: rows(11) }).fields.locations.length, 11);   // 11 + the application's own = 12
  assert.match(apply({ locations: rows(12) }).error, /12 locations/);
});

/* ---------- what a branch inherits ----------
   A chain sells the same food at the same prices under the same artwork, so
   /join asks once and every branch inherits. Sending a value explicitly still
   wins, which is what keeps a genuinely different second brand expressible. */

test('cuisine, price and logo fall back to location one', () => {
  const logo = 'data:image/png;base64,iVBORw0KGgo=';
  const out = apply({
    cuisine: ['pizza'],
    priceLevel: 2,
    logo,
    locations: [{ name: 'Joe’s Pizza', locationLabel: 'Campus' }],
  });
  assert.equal(out.error, undefined);
  const branch = out.fields.locations[0];
  assert.deepEqual(branch.cuisine, out.fields.cuisine);
  assert.equal(branch.priceLevel, out.fields.price_level);
  assert.equal(branch.logo, logo);
});

test('an explicit value on a branch overrides what it would have inherited', () => {
  const out = apply({
    cuisine: ['pizza'],
    priceLevel: 2,
    locations: [{ name: 'Joe’s Coffee', cuisine: ['coffee'], priceLevel: 1 }],
  });
  assert.deepEqual(out.fields.locations[0].cuisine, ['coffee']);
  assert.equal(out.fields.locations[0].priceLevel, 1);
  assert.deepEqual(out.fields.cuisine, ['pizza'], 'location one is untouched');
});

test('an explicit null logo on a branch means NO logo, not the inherited one', () => {
  // The distinction only exists because the key was sent: an omitted logo
  // inherits, a null one is the branch saying it has none.
  const logo = 'data:image/png;base64,iVBORw0KGgo=';
  const out = apply({ logo, locations: [{ name: 'Joe’s Pizza', logo: null }] });
  assert.equal(out.error, undefined);
  assert.equal(out.fields.locations[0].logo, null);
  assert.equal(out.fields.logo, logo, 'location one keeps its own');
});

test('a bad logo on a branch names the branch in the error', () => {
  const out = apply({ locations: [{ name: 'Joe’s Pizza', logo: 'https://example.com/logo.png' }] });
  assert.match(out.error, /Location 2/);
});

/* ---------- which store a request is about ---------- */

const link = (id) => ({ vendor_id: id, vendors: { id } });

test('one store: the header is ignored entirely', () => {
  // Including a header naming someone else's vendor. A single-location terminal
  // that never learned its own id still works, and a stale remembered id can
  // never lock out the one store this account has.
  const only = link('a');
  assert.equal(chooseVendorLink([only], undefined), only);
  assert.equal(chooseVendorLink([only], 'b'), only);
});

test('several stores with no header is ambiguous, never a guess', () => {
  assert.equal(chooseVendorLink([link('a'), link('b')], undefined), null);
  assert.equal(chooseVendorLink([link('a'), link('b')], ''), null);
});

test('several stores: the header picks one of THIS account’s stores', () => {
  const [a, b] = [link('a'), link('b')];
  assert.equal(chooseVendorLink([a, b], 'b'), b);
});

test('a header naming a store this account does not hold resolves to nothing', () => {
  // The 400 that follows is the point: answering with the account's first store
  // would silently redirect a sale, and answering 403 would confirm the id
  // exists to whoever guessed it.
  assert.equal(chooseVendorLink([link('a'), link('b')], 'c'), null);
});
