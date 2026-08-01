// Unit tests for the vendor password-reset code helpers (src/lib/reset-codes.js).
// No database: generation and normalisation are pure, and they are the two
// places where a mistake is invisible until a vendor is on the phone unable to
// get back into their terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateResetCode,
  formatResetCode,
  normalizeResetCode,
  RESET_CODE_ALPHABET,
  RESET_CODE_LENGTH,
} from '../src/lib/reset-codes.js';

test('the alphabet excludes every glyph pair that sounds or looks alike', () => {
  // The code is dictated over a phone. O/0, I/1, L/1, S/5, Z/2, B/8 and Q/O are
  // the pairs that get misheard or mistyped; only one member of each survives.
  for (const banned of ['O', 'I', 'L', 'S', 'Z', 'B', 'Q']) {
    assert.equal(RESET_CODE_ALPHABET.includes(banned), false, `${banned} must not be in the alphabet`);
  }
  // ...and the survivor of each pair is still there, or codes lose entropy for
  // no reason.
  for (const kept of ['0', '1', '5', '2', '8']) {
    assert.equal(RESET_CODE_ALPHABET.includes(kept), true, `${kept} should still be usable`);
  }
});

test('the alphabet has no duplicates (a repeat would skew the distribution)', () => {
  assert.equal(new Set(RESET_CODE_ALPHABET).size, RESET_CODE_ALPHABET.length);
});

test('generated codes are hyphenated and normalise back to the canonical form', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateResetCode();
    assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/, `unexpected shape: ${code}`);
    const bare = normalizeResetCode(code);
    assert.equal(bare?.length, RESET_CODE_LENGTH);
    // Every character must come from the alphabet — a stray glyph here is what
    // the confusion-folding would silently rewrite into a different code.
    for (const ch of bare) assert.equal(RESET_CODE_ALPHABET.includes(ch), true);
  }
});

test('generated codes do not repeat (the CSPRNG is actually being used)', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(generateResetCode());
  assert.equal(seen.size, 500, 'duplicate code in 500 draws');
});

test('normalize accepts the code however it comes back from a phone call', () => {
  const canonical = normalizeResetCode('K7M2NP94');
  for (const variant of [
    'K7M2-NP94',      // as printed
    'k7m2-np94',      // typed lower case
    ' K7M2 NP94 ',    // spaces and padding
    'K7M2—NP94',      // an em dash, because autocorrect
    'K7M2.NP94',
  ]) {
    assert.equal(normalizeResetCode(variant), canonical, `failed on ${variant}`);
  }
});

test('normalize folds the look-alikes a listener actually types', () => {
  // Someone hears "oh" and types the letter; the code that was minted holds the
  // digit. Folding here is what stops a correct reading from being rejected.
  assert.equal(normalizeResetCode('OK7M2QP9'), normalizeResetCode('0K7M20P9'));
  assert.equal(normalizeResetCode('I234567L'), normalizeResetCode('12345671'));
  assert.equal(normalizeResetCode('SZB45678'), normalizeResetCode('52845678'));
});

test('normalize rejects anything that cannot be a code', () => {
  for (const bad of [
    '',                 // empty
    'K7M2QP9',          // one short
    'K7M2NP945',        // one long
    'K7M2-QP9!',        // punctuation strips to 7 chars
    null,
    undefined,
    12345678,           // not a string
    {},
  ]) {
    assert.equal(normalizeResetCode(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('normalize is idempotent — re-normalising its own output is a no-op', () => {
  for (let i = 0; i < 50; i++) {
    const once = normalizeResetCode(generateResetCode());
    assert.equal(normalizeResetCode(once), once);
  }
});

test('formatResetCode groups a bare code and leaves anything else alone', () => {
  assert.equal(formatResetCode('K7M2NP94'), 'K7M2-NP94');
  assert.equal(formatResetCode('K7M2QP9'), 'K7M2QP9');   // wrong length: untouched
  assert.equal(formatResetCode(''), '');
});
