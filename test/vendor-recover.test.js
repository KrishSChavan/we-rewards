// Unit tests for the request-shape policy on POST /api/vendor/recover
// (src/routes/vendor-recover.js). Every branch here decides before any query
// runs, so no database is needed — the code-verification path is exercised by
// the DB-backed suites.
//
// The endpoint is PUBLIC (a locked-out vendor has no session to authenticate
// with), so the thing these tests are really protecting is the uniformity of the
// failure response: if an unknown address ever answered differently from a wrong
// code, this becomes an oracle for which emails are vendor logins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecoverInput } from '../src/routes/vendor-recover.js';

const GOOD_CODE = 'K7M2-NP94';
const GOOD_PW = 'a-good-password';

test('a well-formed request passes through cleaned up', () => {
  const out = validateRecoverInput({
    email: '  Owner@Example.COM ',
    code: 'k7m2 np94',
    newPassword: GOOD_PW,
  });
  assert.equal(out.rejection, undefined);
  assert.equal(out.email, 'owner@example.com', 'email is trimmed and lower-cased');
  assert.equal(out.code, 'K7M2NP94', 'code is normalised to its canonical form');
  assert.equal(out.newPassword, GOOD_PW, 'the password is passed through byte-for-byte');
});

test('a short password is refused precisely, before any code lookup', () => {
  const out = validateRecoverInput({ email: 'a@b.co', code: GOOD_CODE, newPassword: 'short' });
  assert.equal(out.rejection.status, 400);
  assert.equal(out.rejection.body.error, 'BAD_PASSWORD');
  assert.match(out.rejection.body.message, /at least 8/);
});

test('a password past bcrypt’s 72-byte limit is refused, not silently truncated', () => {
  // bcrypt reads the first 72 bytes only. Accepting 100 characters would store a
  // password that is not the one the vendor typed, and the 73rd character on
  // would never matter again.
  const out = validateRecoverInput({ email: 'a@b.co', code: GOOD_CODE, newPassword: 'x'.repeat(73) });
  assert.equal(out.rejection.status, 400);
  assert.equal(out.rejection.body.error, 'BAD_PASSWORD');
  assert.match(out.rejection.body.message, /72 characters or fewer/);
});

test('exactly 8 and exactly 72 characters are both accepted (boundaries)', () => {
  for (const pw of ['x'.repeat(8), 'x'.repeat(72)]) {
    const out = validateRecoverInput({ email: 'a@b.co', code: GOOD_CODE, newPassword: pw });
    assert.equal(out.rejection, undefined, `length ${pw.length} should be allowed`);
  }
});

test('a non-string password is treated as empty, not coerced', () => {
  // `{ newPassword: 12345678 }` must not become the string "12345678" and sail
  // through the length check.
  for (const pw of [12345678, null, undefined, {}, ['abcdefgh']]) {
    const out = validateRecoverInput({ email: 'a@b.co', code: GOOD_CODE, newPassword: pw });
    assert.equal(out.rejection?.body.error, 'BAD_PASSWORD', `should reject ${JSON.stringify(pw)}`);
  }
});

test('every code/address failure returns the SAME opaque body', () => {
  const bodies = [
    { email: '', code: GOOD_CODE, newPassword: GOOD_PW },                       // no address
    { email: 'a@b.co', code: '', newPassword: GOOD_PW },                        // no code
    { email: 'a@b.co', code: 'TOOSHORT1234', newPassword: GOOD_PW },            // wrong length
    { email: 'a@b.co', code: '!!!!-!!!!', newPassword: GOOD_PW },               // nothing usable
    { email: `${'x'.repeat(250)}@b.co`, code: GOOD_CODE, newPassword: GOOD_PW }, // over-long address
    { email: 'a@b.co', code: null, newPassword: GOOD_PW },
    { email: null, code: GOOD_CODE, newPassword: GOOD_PW },
  ].map((b) => validateRecoverInput(b).rejection);

  for (const r of bodies) {
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'RESET_INVALID');
  }
  // Identical strings, not merely the same code — a differing message would be
  // just as good an oracle.
  const messages = new Set(bodies.map((r) => r.body.message));
  assert.equal(messages.size, 1, 'all invalid-code responses must read identically');
});

test('a missing body is rejected rather than throwing', () => {
  for (const b of [undefined, null, {}]) {
    assert.equal(validateRecoverInput(b).rejection.status, 400);
  }
});

test('the code is normalised the same way the minting side hashes it', () => {
  // The admin route hashes normalizeResetCode(code), so anything this accepts
  // must produce that exact string — including the look-alike folding. A vendor
  // who hears "oh pee nine four" and types the LETTER O still lands on the digit
  // the code was actually minted with.
  const typedDigit = validateRecoverInput({ email: 'a@b.co', code: 'K7M2-0P94', newPassword: GOOD_PW });
  const typedLetter = validateRecoverInput({ email: 'a@b.co', code: 'k7m2-op94', newPassword: GOOD_PW });
  assert.equal(typedLetter.code, typedDigit.code, 'O folds to 0');
  assert.equal(typedDigit.code, 'K7M20P94');
});
