// Unit tests for the operator dashboard's vendor-write validators
// (src/routes/admin.js): renaming a vendor (PATCH /api/admin/vendors/:id) and
// adding one by hand (POST /api/admin/vendors). Both decide before any query
// runs, so no database is needed.
//
// What these are really protecting is the parity between the two ways a vendor
// gets onboarded. The operator's "Add vendor" form and an accepted /join
// application land in the same onboardVendor call, so anything validNewVendor
// waves through has to be something validApplication (src/routes/apply.js) would
// have accepted too — otherwise the admin door quietly becomes the loose one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validVendorName, validNewVendor } from '../src/routes/admin.js';

const GOOD = {
  name: 'Local Eats',
  email: 'owner@example.com',
  password: 'a-good-password',
};

/* ---------- rename ---------- */

test('a name is trimmed and passed through', () => {
  const out = validVendorName('  Local Eats  ');
  assert.equal(out.error, undefined);
  assert.equal(out.value, 'Local Eats');
});

test('an empty or whitespace-only name is refused', () => {
  // The column is `not null` and the name is what students see on the card, so
  // a blank rename would leave an unnameable vendor in the roster.
  for (const raw of ['', '   ', '\t\n', null, undefined]) {
    assert.match(validVendorName(raw).error, /required/, `should reject ${JSON.stringify(raw)}`);
  }
});

test('80 characters is allowed, 81 is not (boundary)', () => {
  assert.equal(validVendorName('x'.repeat(80)).value.length, 80);
  assert.match(validVendorName('x'.repeat(81)).error, /80 characters/);
});

/* ---------- add vendor ---------- */

test('a well-formed vendor passes through cleaned up', () => {
  const out = validNewVendor({
    ...GOOD,
    name: '  Local Eats ',
    email: '  Owner@Example.COM ',
    address: '  123 College Ave  ',
  });
  assert.equal(out.error, undefined);
  assert.equal(out.name, 'Local Eats', 'name is trimmed');
  assert.equal(out.email, 'owner@example.com', 'email is trimmed and lower-cased');
  assert.equal(out.password, GOOD.password, 'the password is passed through byte-for-byte');
  assert.equal(out.address, '123 College Ave');
  assert.equal(out.logo, null, 'an absent logo is null, not undefined');
});

test('an omitted address or logo becomes null rather than an empty string', () => {
  // Both columns are nullable and '' would show as a real (empty) address on the
  // student card and a real (broken) logo, so blank has to normalise to null.
  const out = validNewVendor({ ...GOOD, address: '   ', logo: '' });
  assert.equal(out.address, null);
  assert.equal(out.logo, null);
});

test('the email must look like an address, and fit the column', () => {
  for (const email of ['', 'not-an-email', 'no@domain', 'two words@x.co', `${'x'.repeat(250)}@b.co`]) {
    assert.match(validNewVendor({ ...GOOD, email }).error, /valid email/, `should reject "${email}"`);
  }
});

test('password bounds match /join exactly (8 to 72)', () => {
  // Same window as validApplication and the recovery form: bcrypt reads 72 bytes,
  // so a longer one would store a password that is not the one that was typed.
  assert.equal(validNewVendor({ ...GOOD, password: 'x'.repeat(8) }).error, undefined);
  assert.equal(validNewVendor({ ...GOOD, password: 'x'.repeat(72) }).error, undefined);
  assert.match(validNewVendor({ ...GOOD, password: 'x'.repeat(7) }).error, /at least 8/);
  assert.match(validNewVendor({ ...GOOD, password: 'x'.repeat(73) }).error, /72 characters or fewer/);
});

test('a non-string password is treated as empty, not coerced', () => {
  for (const password of [12345678, null, undefined, {}, ['abcdefgh']]) {
    assert.match(
      validNewVendor({ ...GOOD, password }).error, /at least 8/,
      `should reject ${JSON.stringify(password)}`,
    );
  }
});

test('an over-long address is refused rather than truncated at the column', () => {
  assert.equal(validNewVendor({ ...GOOD, address: 'x'.repeat(300) }).error, undefined);
  assert.match(validNewVendor({ ...GOOD, address: 'x'.repeat(301) }).error, /300 characters/);
});

test('the logo must be a small base64 image data-URL', () => {
  const ok = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(validNewVendor({ ...GOOD, logo: ok }).logo, ok);

  const bad = [
    'https://example.com/logo.png',            // a remote URL is not an inline image
    'data:text/html;base64,PHNjcmlwdD4=',      // wrong media type
    'data:image/svg+xml;base64,PHN2Zz4=',      // SVG carries script; not in the allow-list
    'data:image/png,notbase64',                // missing the base64 marker
    `data:image/png;base64,${'A'.repeat(500_001)}`, // past the size cap
  ];
  for (const logo of bad) {
    assert.match(validNewVendor({ ...GOOD, logo }).error, /Logo/, `should reject ${logo.slice(0, 40)}`);
  }
});

test('a missing body is rejected rather than throwing', () => {
  for (const b of [undefined, null, {}]) {
    assert.ok(validNewVendor(b).error, 'should return an error, not throw');
  }
});

/* ---------- the contact the operator phones (migration-049) ----------

   These columns exist because the phone number used to be DESTROYED at accept:
   /join collected it onto vendor_applications, the vendors table had nowhere to
   put it, and the accept handler deletes the application row as its last step.
   The number that mattered most after onboarding was the one guaranteed not to
   survive it.

   So what these tests hold is the seam that fix runs through. The shape rule has
   to match apply.js's exactly (one column, two doors), and '' has to become null
   rather than an empty string, because the admin roster distinguishes "nobody
   has filled this in yet" from "there is nobody to call" and an empty string
   reads as the second. */

test('a contact name and phone are trimmed and passed through', () => {
  const out = validNewVendor({ ...GOOD, contactName: '  Sam  ', phone: '  814 555 0134  ' });
  assert.equal(out.error, undefined);
  assert.equal(out.contactName, 'Sam');
  assert.equal(out.phone, '814 555 0134');
});

test('an omitted or blank contact becomes null, never an empty string', () => {
  // The roster renders a missing phone as a visible "no phone" so the pre-049
  // vendors get re-collected by hand. '' would render as a filled-in blank and
  // that prompt would never appear.
  for (const b of [GOOD, { ...GOOD, contactName: '', phone: '' }, { ...GOOD, contactName: '   ', phone: '  ' }]) {
    const out = validNewVendor(b);
    assert.equal(out.contactName, null);
    assert.equal(out.phone, null);
  }
});

test('the phone shape is exactly /join’s, so one column has one rule', () => {
  // Same regex as PHONE_RE in src/routes/apply.js. Permissive on purpose: this
  // is dialled by a human, so the way somebody writes their own number wins
  // over a canonical format.
  for (const phone of ['8145550134', '814 555 0134', '(814) 555-0134', '+1 814.555.0134']) {
    assert.equal(validNewVendor({ ...GOOD, phone }).error, undefined, `should accept ${phone}`);
  }
  for (const phone of ['123', 'call me', '814-555-0134 ext 12', '=8145550134']) {
    assert.match(validNewVendor({ ...GOOD, phone }).error, /phone/i, `should reject ${phone}`);
  }
});

test('a phone is OPTIONAL here and REQUIRED on /join, deliberately', () => {
  // The one place the two doors are allowed to differ, and only in this
  // direction. An applicant on a public form has no other way to tell us how to
  // reach them; an operator adding a vendor at a demo is standing next to the
  // person and can fill it in from the roster later. Refusing the whole save
  // over it just gets an invented number typed in.
  assert.equal(validNewVendor(GOOD).error, undefined, 'no phone must still onboard');
  // ...but anything actually SUPPLIED is held to the same rule, so a number that
  // gets in through this door is one the public form would have taken.
  assert.ok(validNewVendor({ ...GOOD, phone: 'nope' }).error);
});

test('an over-long contact name is refused rather than truncated at the column', () => {
  // vendors_contact_name_len (migration-049) caps this at 80. A validator that
  // let 81 through would turn an operator's typo into a 500 from a check
  // constraint instead of a message they can act on.
  assert.equal(validNewVendor({ ...GOOD, contactName: 'x'.repeat(80) }).error, undefined);
  assert.match(validNewVendor({ ...GOOD, contactName: 'x'.repeat(81) }).error, /80 characters/);
});
