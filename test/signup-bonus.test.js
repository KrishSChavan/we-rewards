// Unit tests for the signup bonus's pure halves (src/lib/signup-bonus.js):
// parsing the operator's domain list, validating the form, and deciding whether
// an email address qualifies. All decide before any query runs.
//
// The domain match is the part worth being paranoid about — it is the whole
// gate on a payout, and a sloppy "endsWith" would hand points to anyone who
// registered notpsu.edu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDomains, validSignupConfig, emailMatchesDomains, SIGNUP_DEFAULTS,
} from '../src/lib/signup-bonus.js';

/* ---------- parseDomains ---------- */

test('a domain list is normalised the way an operator actually types it', () => {
  // The leading @ is what everyone types first; case and spacing are noise.
  assert.deepEqual(parseDomains('@PSU.edu').domains, ['psu.edu']);
  assert.deepEqual(parseDomains(' psu.edu , alumni.psu.edu ').domains, ['psu.edu', 'alumni.psu.edu']);
  assert.deepEqual(parseDomains(['psu.edu', '@psu.edu']).domains, ['psu.edu'], 'duplicates collapse');
});

test('an empty list is refused rather than matching everything', () => {
  for (const raw of ['', '   ', ',', [], null, undefined]) {
    assert.match(parseDomains(raw).error, /at least one/, `should reject ${JSON.stringify(raw)}`);
  }
});

test('anything that is not a plain hostname is refused', () => {
  // A domain is compared against the tail of an email address, so any of these
  // is either a typo or an attempt to widen the match.
  for (const raw of ['psu', 'psu.', '.edu', 'psu edu', 'http://psu.edu', 'psu.edu/x', '*.psu.edu', 'a@psu.edu']) {
    assert.match(parseDomains(raw).error, /isn’t a valid email domain/, `should reject ${raw}`);
  }
});

test('more than five domains is refused', () => {
  assert.equal(parseDomains('a.edu,b.edu,c.edu,d.edu,e.edu').error, undefined);
  assert.match(parseDomains('a.edu,b.edu,c.edu,d.edu,e.edu,f.edu').error, /At most 5/);
});

/* ---------- emailMatchesDomains ---------- */

test('an address on the domain qualifies', () => {
  assert.equal(emailMatchesDomains('abc123@psu.edu', ['psu.edu']), true);
  assert.equal(emailMatchesDomains('ABC123@PSU.EDU', ['psu.edu']), true, 'case-insensitive');
});

test('a subdomain qualifies, because a university hands those out', () => {
  assert.equal(emailMatchesDomains('x@med.psu.edu', ['psu.edu']), true);
  assert.equal(emailMatchesDomains('x@a.b.psu.edu', ['psu.edu']), true);
});

test('a look-alike domain does NOT qualify', () => {
  // The bug a bare endsWith() would have: anyone who registers notpsu.edu
  // could mint themselves the bonus.
  assert.equal(emailMatchesDomains('x@notpsu.edu', ['psu.edu']), false);
  assert.equal(emailMatchesDomains('x@psu.edu.evil.com', ['psu.edu']), false);
  assert.equal(emailMatchesDomains('x@gmail.com', ['psu.edu']), false);
});

test('the domain must be in the HOST, not anywhere in the address', () => {
  // A local part is attacker-chosen. "psu.edu@gmail.com" must not qualify.
  assert.equal(emailMatchesDomains('psu.edu@gmail.com', ['psu.edu']), false);
  assert.equal(emailMatchesDomains('a@b@psu.edu', ['psu.edu']), true, 'the LAST @ starts the host');
});

test('junk input is false, never a throw', () => {
  for (const raw of ['', 'nope', null, undefined, 42, '@', 'x@']) {
    assert.equal(emailMatchesDomains(raw, ['psu.edu']), false, `should reject ${JSON.stringify(raw)}`);
  }
  assert.equal(emailMatchesDomains('x@psu.edu', null), false, 'no domains configured matches nothing');
  assert.equal(emailMatchesDomains('x@psu.edu', []), false);
});

/* ---------- validSignupConfig ---------- */

test('an empty config falls back to the documented defaults', () => {
  const { config, error } = validSignupConfig({});
  assert.equal(error, undefined);
  assert.deepEqual(config, SIGNUP_DEFAULTS);
});

test('the form’s strings are coerced', () => {
  const { config } = validSignupConfig({ points: '25', domains: '@psu.edu' });
  assert.deepEqual(config, { points: 25, domains: ['psu.edu'] });
});

test('point bounds are enforced at both ends (boundaries)', () => {
  assert.equal(validSignupConfig({ points: 1 }).error, undefined);
  assert.equal(validSignupConfig({ points: 5000 }).error, undefined);
  // Zero is not "switched off" — that is what the active flag is for. A
  // zero-point program would sit in the tab looking live and pay nothing.
  assert.match(validSignupConfig({ points: 0 }).error, /1 to 5000/);
  assert.match(validSignupConfig({ points: 5001 }).error, /1 to 5000/);
  assert.match(validSignupConfig({ points: 12.5 }).error, /whole number/);
  assert.match(validSignupConfig({ points: 'lots' }).error, /whole number/);
});

test('a bad domain fails the whole config, not just its own field', () => {
  assert.match(validSignupConfig({ points: 10, domains: 'psu' }).error, /isn’t a valid email domain/);
});
