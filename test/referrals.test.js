// Unit tests for the referral engine's pure halves (src/lib/referrals.js):
// folding a typed code into its canonical form, and validating the knobs an
// operator sets in the Incentives tab. Both decide before any query runs, so no
// database is needed.
//
// The database-backed half — attribution rules, the sweep, budgets, and the
// one-referral-per-student guarantee — is covered by test/sql/behavior-039.sql,
// which runs the real migration chain against a throwaway postgres:16:
//   powershell -File test/sql/run.ps1 -Migration migration-039.sql `
//              -Seed seed-039.sql -Behavior behavior-039.sql
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCode, validReferralConfig, REFERRAL_DEFAULTS } from '../src/lib/referrals.js';

/* ---------- normalizeCode ---------- */

test('a well-formed code passes through unchanged', () => {
  assert.equal(normalizeCode('ABC234'), 'ABC234');
});

test('a code is accepted however a student actually types it', () => {
  // Lower case off a keyboard, a stray space from a copy-paste, and the dash
  // someone adds because it looks like a coupon.
  for (const raw of ['abc234', ' ABC234 ', 'abc-234', 'ABC 234', 'aBc234']) {
    assert.equal(normalizeCode(raw), 'ABC234', `should fold ${JSON.stringify(raw)}`);
  }
});

test('anything that cannot be a code is rejected rather than looked up', () => {
  for (const raw of ['', '   ', 'ABC23', 'ABC2345', null, undefined, 42, {}, 'ABC23!']) {
    assert.equal(normalizeCode(raw), null, `should reject ${JSON.stringify(raw)}`);
  }
});

test('the excluded look-alike characters are refused, not silently mapped', () => {
  // generate_referral_code() never emits I, L, O, 0 or 1, so a code containing
  // one was mistyped. Guessing which character was meant would turn a typo into
  // a lookup on somebody else's code.
  for (const raw of ['ABC2I4', 'ABC2O4', 'ABC2L4', 'ABC204', 'ABC214']) {
    assert.equal(normalizeCode(raw), null, `should reject ${raw}`);
  }
});

test('normalizeCode is idempotent', () => {
  const once = normalizeCode('abc-234');
  assert.equal(normalizeCode(once), once);
});

/* ---------- validReferralConfig ---------- */

test('an empty config falls back to the defaults, except for the cap', () => {
  // REFERRAL_DEFAULTS.maxPerReferrer is what the admin form is PRE-FILLED with,
  // not what an absent value means. Absent means the operator cleared the field,
  // and a cleared cap is "unlimited" — the placeholder in the form says so.
  // The other three have no such second meaning, so blank is just the default.
  const { config, error } = validReferralConfig({});
  assert.equal(error, undefined);
  assert.deepEqual(config, { ...REFERRAL_DEFAULTS, maxPerReferrer: null });
});

test('the form’s strings are coerced to whole numbers', () => {
  // Every field arrives from an <input>, so they are strings even when numeric.
  const { config } = validReferralConfig({
    referrerPoints: '250',
    friendPoints: '75',
    maxPerReferrer: '5',
    signupWindowDays: '30',
  });
  assert.deepEqual(config, {
    referrerPoints: 250, friendPoints: 75, maxPerReferrer: 5, signupWindowDays: 30,
  });
});

test('a blank cap means unlimited, which is different from zero', () => {
  for (const blank of ['', null, undefined]) {
    const { config } = validReferralConfig({ maxPerReferrer: blank });
    assert.equal(config.maxPerReferrer, null, `${JSON.stringify(blank)} should mean unlimited`);
  }
  // ...and 0 is not a valid cap, because "0 referrals allowed" is a program
  // that silently never pays rather than one that is switched off.
  assert.match(validReferralConfig({ maxPerReferrer: 0 }).error, /1 to 1000/);
});

test('one bonus may be zero, but not both', () => {
  assert.equal(validReferralConfig({ friendPoints: 0 }).error, undefined);
  assert.equal(validReferralConfig({ referrerPoints: 0 }).error, undefined);
  // A program paying nobody anything would sit in the tab looking live.
  assert.match(
    validReferralConfig({ referrerPoints: 0, friendPoints: 0 }).error,
    /at least one/
  );
});

test('point bounds are enforced at both ends (boundaries)', () => {
  assert.equal(validReferralConfig({ referrerPoints: 5000 }).error, undefined);
  assert.match(validReferralConfig({ referrerPoints: 5001 }).error, /0 to 5000/);
  assert.match(validReferralConfig({ referrerPoints: -1 }).error, /0 to 5000/);
  assert.equal(validReferralConfig({ friendPoints: 5000 }).error, undefined);
  assert.match(validReferralConfig({ friendPoints: 5001 }).error, /0 to 5000/);
});

test('the signup window is bounded, so a code cannot stay claimable forever', () => {
  assert.equal(validReferralConfig({ signupWindowDays: 1 }).error, undefined);
  assert.equal(validReferralConfig({ signupWindowDays: 365 }).error, undefined);
  assert.match(validReferralConfig({ signupWindowDays: 0 }).error, /1 to 365/);
  assert.match(validReferralConfig({ signupWindowDays: 366 }).error, /1 to 365/);
});

test('fractional and non-numeric values are refused, not rounded', () => {
  // These land in integer columns. Rounding a typo into a valid value is how a
  // program quietly pays 3 points instead of 300.
  assert.match(validReferralConfig({ referrerPoints: 12.5 }).error, /whole number/);
  assert.match(validReferralConfig({ referrerPoints: 'lots' }).error, /whole number/);
  assert.match(validReferralConfig({ signupWindowDays: 7.5 }).error, /whole number/);
});

test('a missing config object is treated as defaults rather than throwing', () => {
  for (const raw of [null, undefined]) {
    assert.deepEqual(validReferralConfig(raw).config, { ...REFERRAL_DEFAULTS, maxPerReferrer: null });
  }
});

test('the runtime fallback still caps a config written without one', () => {
  // attributeReferral reads `{ ...REFERRAL_DEFAULTS, ...program.config }`, so a
  // config row missing the key entirely (hand-edited, or written by an older
  // build) inherits a cap rather than becoming unlimited by omission. An
  // EXPLICIT null still means unlimited — the validator's output always carries
  // the key, so the two cases stay distinguishable.
  assert.equal({ ...REFERRAL_DEFAULTS, ...{} }.maxPerReferrer, REFERRAL_DEFAULTS.maxPerReferrer);
  assert.equal({ ...REFERRAL_DEFAULTS, ...{ maxPerReferrer: null } }.maxPerReferrer, null);
});
