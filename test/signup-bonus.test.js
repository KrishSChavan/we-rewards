// Unit tests for the signup bonus's pure halves (src/lib/signup-bonus.js):
// parsing the operator's domain list, validating the form, and deciding whether
// an email address qualifies. All decide before any query runs.
//
// The domain match is the part worth being paranoid about — it is the whole
// gate on a payout, and a sloppy "endsWith" would hand points to anyone who
// registered notpsu.edu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/* ---------- what the student is actually told ----------
   The half of this feature that failed in the field. The payout worked; nobody
   was informed it had, so it was reported as broken. welcomeBonusMessage() is
   the whole announcement, and it lives in public/student/app.js — a browser
   script, not a module (build-client.js transforms each file with no bundling),
   so nothing here can import it. Sliced out and evaluated instead, following
   test/nearby-client.test.js; the landmarks are deliberately brittle so a moved
   function throws rather than quietly testing nothing. */
const APP = fileURLToPath(new URL('../public/student/app.js', import.meta.url));
const appSrc = readFileSync(APP, 'utf8');
const from = appSrc.indexOf('function welcomeBonusMessage(');
const to = appSrc.indexOf('// Records the acceptance server-side');
assert.ok(from > 0 && to > from, 'welcomeBonusMessage moved in public/student/app.js — re-anchor this test');
// eslint-disable-next-line no-new-func
const welcomeBonusMessage = new Function(`${appSrc.slice(from, to)}; return welcomeBonusMessage;`)();

test('a school-email signup is told about its points, not just credited', () => {
  const msg = welcomeBonusMessage({ signupBonus: 10, qrBonus: null });
  assert.match(msg, /\+10 community points/);
  assert.match(msg, /school email/);
});

test('both awards at once become ONE sentence, because there is one toast', () => {
  // Two punchToast calls would replace the first before it could be read, so a
  // student who signed up with a psu.edu address through a poster must not lose
  // half the news.
  const msg = welcomeBonusMessage({ signupBonus: 10, qrBonus: { points: 3 } });
  assert.match(msg, /\+13 community points/, 'the total, not one of the two');
});

test('a poster award on its own still names the poster', () => {
  assert.match(welcomeBonusMessage({ signupBonus: 0, qrBonus: { points: 5 } }), /poster/);
});

test('nothing paid says nothing at all', () => {
  for (const accepted of [{}, null, undefined, { signupBonus: 0 }, { signupBonus: 0, qrBonus: { points: 0 } }]) {
    assert.equal(welcomeBonusMessage(accepted), null, JSON.stringify(accepted));
  }
});
