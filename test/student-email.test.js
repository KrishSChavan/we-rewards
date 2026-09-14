// Unit tests for the student-email link primitives (src/lib/student-email.js) —
// the halves that decide things before any query runs.
//
// WHY THESE, AND NOT A HAPPY PATH. Every test below guards something that
// either moves money or leaks an account, and fails silently if it breaks:
//
//   • THE +TAG FOLD is the whole bonus fence. student_email_claims is keyed on
//     the folded address, so a hole here means one inbox collects one payout
//     per tag it can invent — abc123+a@, abc123+b@, forever. It is the single
//     most valuable line in the file and it is four characters of string work.
//   • DOTS MUST SURVIVE. The mirror-image mistake: Gmail treats first.last@ and
//     firstlast@ as one mailbox, most mail systems (a university's included) do
//     not. Stripping them would fold two real students into one claim and lock
//     the second out of a feature they are entitled to.
//   • THE DOMAIN CHECK is what makes this a student feature. It is delegated to
//     emailMatchesDomains (tested thoroughly in signup-bonus.test.js); what is
//     asserted here is that the delegation is intact, including the trap where
//     an attacker-chosen local part carries the university's name.
//   • THE CODE is a six-digit credential against a five-guess cap.
//
// Sibling of test/reset-codes.test.js, deliberately mirroring its shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStudentEmail,
  normalizeLinkCode,
  generateLinkCode,
  isStudentAddress,
  CODE_LENGTH,
  CODE_TTL_MINUTES,
  CODE_MAX_ATTEMPTS,
} from '../src/lib/student-email.js';

/* ---------- the address ---------- */

test('an address is lowercased and trimmed, so one inbox is not two claims', () => {
  // A phone keyboard capitalises, and a pasted address brings whitespace.
  // Either one landing in the table as a distinct string is a second claim on
  // the same mailbox.
  assert.deepEqual(
    { ...normalizeStudentEmail('  ABC1234@PSU.EDU  ') },
    { email: 'abc1234@psu.edu', norm: 'abc1234@psu.edu' }
  );
});

test('a +tag is folded out of the fence key — THE bonus farm this stops', () => {
  // abc123+one@ and abc123+two@ deliver to the same inbox. Without folding,
  // one student can link, collect, unlink, and relink under a fresh tag for as
  // many payouts as they can be bothered to type.
  const a = normalizeStudentEmail('abc1234+one@psu.edu');
  const b = normalizeStudentEmail('abc1234+two@psu.edu');
  const plain = normalizeStudentEmail('abc1234@psu.edu');

  assert.equal(a.norm, 'abc1234@psu.edu');
  assert.equal(b.norm, 'abc1234@psu.edu');
  assert.equal(a.norm, b.norm, 'two tags on one mailbox must be ONE claim');
  assert.equal(a.norm, plain.norm, '...and the same claim as the untagged form');
});

test('the address we MAIL keeps its tag, even though the fence drops it', () => {
  // The code has to arrive. If a student typed the tagged form, that is the
  // address the mail server was told about; folding before sending would
  // deliver to an address they did not ask for (or nowhere at all, on a system
  // where the tag is the whole routing rule).
  const { email, norm } = normalizeStudentEmail('abc1234+shopping@psu.edu');
  assert.equal(email, 'abc1234+shopping@psu.edu', 'mail goes to what they typed');
  assert.equal(norm, 'abc1234@psu.edu', 'the fence sees through it');
});

test('dots are NEVER stripped — that is a Gmail rule, not an email rule', () => {
  // The mirror image of the +tag fold, and getting it wrong is worse: it would
  // make two different people one claim, and lock the second out entirely.
  const dotted = normalizeStudentEmail('first.last@psu.edu');
  const plain = normalizeStudentEmail('firstlast@psu.edu');
  assert.equal(dotted.norm, 'first.last@psu.edu');
  assert.notEqual(dotted.norm, plain.norm, 'two students, two claims');
});

test('a tag that eats the whole local part is refused, not turned into "@host"', () => {
  // '+tag@psu.edu' folds to '@psu.edu', which is not an address — and as a
  // primary key it would be one row every such attempt collides on.
  assert.ok(normalizeStudentEmail('+tag@psu.edu').error);
});

test('anything that is not an address is refused rather than stored', () => {
  for (const raw of [
    '', '   ', null, undefined, {}, 42,
    'abc1234', 'abc1234@', '@psu.edu', 'abc1234@psu',
    'a b@psu.edu', 'a@b@psu.edu', 'abc<1234>@psu.edu',
    'abc1234@psu.edu, other@psu.edu', 'abc1234@psu.edu;other@psu.edu',
  ]) {
    assert.ok(normalizeStudentEmail(raw).error, `should refuse ${JSON.stringify(raw)}`);
  }
});

test('the length bounds are the RFC ones, checked before any hashing or mail', () => {
  // A typo must cost no bcrypt and no API call.
  const longLocal = `${'a'.repeat(65)}@psu.edu`;
  assert.ok(normalizeStudentEmail(longLocal).error, 'local part over 64');

  const longWhole = `${'a'.repeat(250)}@psu.edu`;
  assert.ok(normalizeStudentEmail(longWhole).error, 'whole address over 254');

  assert.ok(!normalizeStudentEmail(`${'a'.repeat(64)}@psu.edu`).error, '64 is allowed');
});

/* ---------- the domain gate ---------- */

test('the domain check covers subdomains but cannot be widened by a local part', () => {
  // Delegated to emailMatchesDomains; this asserts the wiring, including the
  // two traps that matter. A university hands out addresses on subdomains, so
  // med.psu.edu must pass. The local part is attacker-chosen, so a local part
  // spelling the university's name must not.
  assert.equal(isStudentAddress('abc1234@psu.edu', ['psu.edu']), true);
  assert.equal(isStudentAddress('abc1234@med.psu.edu', ['psu.edu']), true);

  assert.equal(isStudentAddress('psu.edu@gmail.com', ['psu.edu']), false);
  assert.equal(isStudentAddress('abc1234@notpsu.edu', ['psu.edu']), false);
  assert.equal(isStudentAddress('abc1234@psu.edu.evil.com', ['psu.edu']), false);
  assert.equal(isStudentAddress('abc1234@gmail.com', ['psu.edu']), false);
});

test('no configured domains matches nothing, rather than everything', () => {
  // The failure direction matters: an empty list arriving from a misread
  // program config must close the feature, not open it to every address alive.
  assert.equal(isStudentAddress('abc1234@psu.edu', []), false);
  assert.equal(isStudentAddress('abc1234@psu.edu', null), false);
});

/* ---------- the code ---------- */

test('a code is exactly six digits, and not the same one twice running', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const code = generateLinkCode();
    assert.equal(code.length, CODE_LENGTH);
    assert.match(code, /^[0-9]{6}$/);
    seen.add(code);
  }
  // 200 draws from 10^6 collide with probability ~2%; a generator stuck on one
  // value (a Math.random seeded wrong, a cached constant) shows up instantly.
  assert.ok(seen.size > 150, `only ${seen.size} distinct codes in 200 draws`);
});

test('a typed code is forgiven its spaces and dashes, and nothing else', () => {
  // People re-type the separator they see, or don't. What is NOT forgiven is a
  // wrong length: it must be indistinguishable from a wrong code, so the caller
  // has exactly one shape to compare against.
  assert.equal(normalizeLinkCode('123456'), '123456');
  assert.equal(normalizeLinkCode('123 456'), '123456');
  assert.equal(normalizeLinkCode('123-456'), '123456');
  assert.equal(normalizeLinkCode('  123456  '), '123456');

  for (const bad of ['12345', '1234567', 'abcdef', '12a456', '', null, undefined, 123456, {}]) {
    assert.equal(normalizeLinkCode(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('the advertised limits are the ones the code actually uses', () => {
  // These three numbers appear in the email template, in the app's copy and in
  // the SQL defaults. A change in one that misses the others tells a student
  // something untrue about a credential they are holding.
  assert.equal(CODE_LENGTH, 6);
  assert.equal(CODE_TTL_MINUTES, 15);
  assert.equal(CODE_MAX_ATTEMPTS, 5);
});
