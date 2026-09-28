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
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/* ---------- the orderings the write paths depend on ----------

   WHY THIS BLOCK LOOKS LIKE THIS. Everything above is an exported validator, so
   it is called directly. The four rules below live inside route handlers, which
   are NOT exported and cannot be reached without importing server.js (which
   rm -rf's .build/ at import) and a database to answer the queries with. What
   they are protecting is not a return value either — it is the ORDER two writes
   happen in, and which errors are allowed to be ignored. Those are exactly the
   properties a well-meaning tidy-up silently reverses, and each one of them has
   already cost either a card that kept being charged or a duplicate vendor.

   So each rule is checked against the handler's own source text, sliced out by
   its first and last landmarks — the same technique, and the same deliberate
   brittleness, as test/address-format.test.js: if a landmark moves this file
   throws instead of quietly testing nothing. Comments are stripped before the
   assertions run, because several of these handlers now DISCUSS the wrong way of
   doing it in prose ("this used to be .ilike", "this used to run the other way
   round") and a grep that could not tell prose from code would pass on a
   reverted fix that still carried its comment. */

const ADMIN_SRC = readFileSync(fileURLToPath(new URL('../src/routes/admin.js', import.meta.url)), 'utf8');

/** The source between two landmarks, comments removed. Throws if either moved. */
function handler(from, to) {
  const start = ADMIN_SRC.indexOf(from);
  const end = ADMIN_SRC.indexOf(to, start + 1);
  assert.ok(start > 0, `landmark moved in src/routes/admin.js — re-anchor this test: ${from}`);
  assert.ok(end > start, `landmark moved in src/routes/admin.js — re-anchor this test: ${to}`);
  return ADMIN_SRC.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/(^|\s)\/\/[^\n]*/g, ' ');  // line comments (no // inside these strings)
}

describe('DELETE /api/admin/vendors/:id', () => {
  const src = () => handler("router.delete('/vendors/:id'", '/* ---------- points pools (migration-044/046)');

  test('a paid subscription is cancelled BEFORE the row that records it is deleted', () => {
    // The vendors row is the only place stripe_subscription_id exists
    // (migration-055). Delete it first and there is no longer anything that can
    // cancel the subscription: the webhook's resolveVendor matches nothing, and
    // the vendor's own portal needs a login the orphan sweep removes. Stripe
    // just keeps charging.
    const body = src();
    assert.match(body, /select\('pool_id, stripe_subscription_id'\)/, 'the pre-delete read must take the subscription id off the row');
    const cancel = body.indexOf('cancelSubscription(');
    const remove = body.indexOf('.delete()');
    assert.ok(cancel > 0, 'the handler must call cancelSubscription()');
    assert.ok(remove > 0 && cancel < remove, 'cancelSubscription() must run before the vendors delete');
  });

  test('a cancel that does not land refuses the delete instead of billing a deleted vendor', () => {
    const body = src();
    // Both refusals matter: Stripe saying no, and Stripe not being configured on
    // this deployment at all (no keys set yet), which is not a licence to delete.
    assert.match(body, /VENDOR_BILLING_CANCEL_FAILED/);
    assert.match(body, /VENDOR_HAS_BILLING/);
    assert.match(body, /!stripeEnabled/);
    // ...except the already-cancelled 404, which is nothing left to bill and
    // must not wedge the vendor undeletable forever.
    assert.match(body, /status !== 404/);
  });

  test('the orphan-login sweep refuses to act on a lookup that failed', () => {
    // postgrest-js sets count = null / data = null on ANY failed response, so
    // "no links left, not a student" and "the query broke" are the same answer.
    // Deleting the auth user on the second one takes a real person's account,
    // and vendor_staff cascades from auth.users so it takes their other store's
    // access with it.
    const body = src();
    assert.match(body, /error: countErr/, 'the remaining-links count must keep its error');
    assert.match(body, /error: profileErr/, 'the profiles lookup must keep its error');
    const kill = body.indexOf('deleteUser(');
    assert.ok(kill > 0, 'the sweep must still delete genuinely orphaned logins');
    assert.ok(body.indexOf('if (countErr)') > 0 && body.indexOf('if (countErr)') < kill);
    assert.ok(body.indexOf('if (profileErr)') > 0 && body.indexOf('if (profileErr)') < kill);
  });
});

describe('POST /api/admin/applications/:id/accept', () => {
  const src = () => handler("router.post('/applications/:id/accept'", "router.delete('/applications/:id'");

  test('the application is claimed by deleting it BEFORE anything is onboarded', () => {
    // The delete is the only lock this route has. Onboarding first and deleting
    // last means a retry — which the admin client offers on any non-404 — runs
    // onboardVendor a second time: the login is linked rather than refused, and
    // createVendorRow's suffix loop adds "name-2" with a duplicate of every
    // starter reward. Two operators clicking together do the same.
    const body = src();
    const claim = body.indexOf('.delete()');
    const onboard = body.indexOf('onboardVendor(');
    assert.ok(claim > 0, 'the claim delete must still be there');
    assert.ok(onboard > claim, 'onboardVendor must run after the claim, not before it');
    assert.match(body, /\.maybeSingle\(\)/, 'the claim must return the row only to the request that removed it');
  });

  test('a failed onboard puts the claimed application back, and says so if it cannot', () => {
    const body = src();
    // Called twice: once where onboardVendor threw, once on the EMAIL_EXISTS
    // conflict, which is the other way out of here having created nothing.
    assert.match(body, /const restoreApplication = /, 'the restore must still exist');
    assert.equal((body.match(/restoreApplication\(\)/g) ?? []).length, 2, 'called on both no-vendor exits');
    // The last resort: an application that can be neither onboarded nor put back
    // has to be readable out of the log, or a real business's application is
    // simply gone. But NOT verbatim — the row carries a bcrypt hash (a credential
    // stdout must never hold) and a logo of up to 500_000 base64 chars, which on
    // one line would push every field after it past Heroku's 10 KB truncation and
    // lose the applicant's pitch. So: a redacted copy, and the original left
    // untouched because a later retry still inserts it.
    assert.match(body, /JSON\.parse\(JSON\.stringify\(app\)\)/, 'log a copy, never mutate the row');
    assert.match(body, /recoverable\.password_hash = /, 'the credential must be redacted out of the log line');
    assert.match(body, /recoverable\.logo = /, 'the blob must be dropped so the rest of the row survives');
    assert.match(body, /JSON\.stringify\(recoverable\)/, 'and it is the redacted copy that gets logged');
    // migration-043: a chain applies with a `locations` array and EVERY entry
    // carries its own base64 logo (a sibling inherits location one's by default),
    // so redacting only the top-level field still put ~500KB on the line and still
    // lost everything after it to Logplex's 10KB cut. The walk is what makes the
    // multi-location case survive, and without an assertion it can be deleted
    // again with every existing test still green.
    assert.match(body, /Array\.isArray\(recoverable\.locations\)/, 'the nested logos must be walked too');
    assert.match(body, /recoverable\.locations = recoverable\.locations\.map\(/, 'and rewritten on the copy');
    // Guard against a regression to logging the row itself: the only
    // JSON.stringify of `app` may be the one inside the JSON.parse round-trip.
    assert.equal((body.match(/JSON\.stringify\(app\)/g) ?? []).length, 1,
      'the raw row must not be logged alongside the redacted copy');
  });
});

describe('GET /api/admin/incentives', () => {
  const src = () => handler("router.get('/incentives'", "router.post('/incentives'");

  test('the counts are counted in the database, not by reading whole tables', () => {
    // supabase/config.toml sets max_rows = 1000. The old whole-table reads
    // truncated there in silence, so every referral and payout number on the tab
    // would have frozen at a thousand rows and stayed frozen.
    const body = src();
    assert.equal((body.match(/count: 'exact', head: true/g) ?? []).length, 2, 'referrals and community_grants both counted');
    assert.doesNotMatch(body, /select\('incentive_id, status'\)/, 'the whole-table referral read must not come back');
    assert.doesNotMatch(body, /select\('incentive_id'\)/, 'the whole-table grants read must not come back');
  });

  test('the response still spells the counts the way public/admin/admin.js reads them', () => {
    // The panel renders referrals.pending / .paid / .void and payouts. This is a
    // pure-performance fix; the shape is not allowed to move with it.
    const body = src();
    assert.match(body, /referrals:/);
    assert.match(body, /payouts:/);
    // The keys of `referrals` are this list, in this order — which is also the
    // CHECK on referrals.status in migration-039. A status added to the table
    // without being added here would simply never be counted.
    assert.match(body, /REFERRAL_STATUSES/, 'the per-status counts must come from the shared list');
    assert.match(ADMIN_SRC, /const REFERRAL_STATUSES = \['pending', 'paid', 'void'\];/);
  });
});

describe('POST /api/admin/grants', () => {
  const src = () => handler("router.post('/grants'", '/* ---------- the "scan here" QR poster');

  test('the student is matched on an exact address, never a LIKE pattern', () => {
    // .ilike appends the operator's typing verbatim as a pattern, and EMAIL_RE
    // admits `_` and `%`. On a path that hands out points with no reversal, that
    // is a legitimate j_smith@school.edu 500ing on PGRST116 — or worse, a typed
    // address that does not exist quietly crediting an account one character
    // away from it. profiles.email is not unique, hence limit(1) and [0] rather
    // than maybeSingle(), exactly as findAccountByEmail does it.
    const body = src();
    assert.match(body, /\.eq\('email', email\)/);
    assert.match(body, /\.limit\(1\)/);
    assert.doesNotMatch(body, /\.ilike\(/, 'a LIKE pattern must not come back to this lookup');
  });
});
