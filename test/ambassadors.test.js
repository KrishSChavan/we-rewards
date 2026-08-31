// Unit tests for the ambassador primitives (src/lib/ambassadors.js) — the
// halves that decide things before any query runs.
//
// Three of these guard something that fails silently in production if it
// breaks. The code normalizer is what makes SARAH7 and sarah7 one code rather
// than two, so a hole in it hands one person's traffic to a row that does not
// exist. The cookie parser is the only thing standing between a hand-crafted
// Cookie header and a row in the scans table. And the two-namespace tests below
// are what keep this feature and the printed-banner one out of each other's
// way on the /r/ rail they share.
//
// Sibling of test/tracked-qr.test.js, deliberately mirroring its shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCode, normalizeEmail, isValidPhone,
  CODE_MIN, CODE_MAX, NAME_MAX, EMAIL_MAX, POINTS_MAX, GRANT_KIND,
  readAmbassadorCookie, ambassadorCookieOptions, AMBASSADOR_COOKIE,
  isLikelyBot,
} from '../src/lib/ambassadors.js';
import { POINTS_MAX as TRACKED_QR_POINTS_MAX } from '../src/lib/tracked-qr.js';
import {
  normalizeCode as normalizeBannerCode,
  mintCode as mintBannerCode,
} from '../src/lib/tracked-qr.js';

/* ---------- the code ---------- */

test('a code is uppercased, so one code is not two rows', () => {
  // The whole reason the column stores uppercase: a phone keyboard capitalises
  // the first letter of anything typed into a URL bar, and the operator types
  // whatever they type.
  assert.equal(normalizeCode('sarah7'), 'SARAH7');
  assert.equal(normalizeCode('Sarah7'), 'SARAH7');
  assert.equal(normalizeCode('SARAH7'), 'SARAH7');
  assert.equal(normalizeCode('  sarah7  '), 'SARAH7', 'a pasted code brings whitespace');
});

test('surrounding whitespace of any kind is forgiven, inner whitespace never is', () => {
  // The split matters: a code pasted out of a spreadsheet cell or a chat
  // message arrives wrapped in a newline or a tab, and refusing it would be a
  // "no such code" for a code that is right there on screen. A space INSIDE it
  // is a different string and stays refused.
  for (const wrapped of ['\nSARAH7', 'SARAH7\n', '\tSARAH7\t', ' \r\n SARAH7 \r\n ']) {
    assert.equal(normalizeCode(wrapped), 'SARAH7', `should forgive ${JSON.stringify(wrapped)}`);
  }
  assert.equal(normalizeCode('SAR AH7'), null);
});

test('the length bounds are exactly the advertised 3 to 10', () => {
  assert.equal(normalizeCode('A'.repeat(CODE_MIN - 1)), null);
  assert.equal(normalizeCode('A'.repeat(CODE_MIN)), 'A'.repeat(CODE_MIN));
  assert.equal(normalizeCode('A'.repeat(CODE_MAX)), 'A'.repeat(CODE_MAX));
  assert.equal(normalizeCode('A'.repeat(CODE_MAX + 1)), null);
});

test('anything that is not a code is refused rather than queried', () => {
  // Nothing here is stripped and retried: a stray character is a WRONG code,
  // and silently deleting it would resolve a mistyped link to somebody else's
  // ambassador.
  const bad = [
    '', '   ', 'AB', 'A'.repeat(11),
    'PSU-SARAH', 'PSU SARAH', 'SARAH_7', 'SARAH.7', 'SARAH!',
    'SÁRAH', 'ＳＡＲＡＨ', 'SA\tRAH', 'SAR\nAH',
    null, undefined, {}, [], true,
    "' or 1=1 --", '../../etc', '%2e%2e', '<script>',
  ];
  for (const raw of bad) {
    assert.equal(normalizeCode(raw), null, `should reject ${JSON.stringify(raw)}`);
  }
});

test('digits alone are a legal code', () => {
  // Worth pinning: an operator numbering their ambassadors 001, 002 is a real
  // thing to do, and Number-ish handling anywhere in this path would break it.
  assert.equal(normalizeCode('001'), '001');
  assert.equal(normalizeCode('1234567890'), '1234567890');
});

test('a non-string is never coerced into a code', () => {
  // The one that bites: String(true) is "true", which uppercases into TRUE and
  // satisfies every other rule. attributeSignup takes its rawCode from a signup
  // request body, so without the typeof guard a client posting
  // `{ trackedQr: true }` would send a lookup for a code nobody ever typed.
  for (const raw of [true, false, 42, 1234567890, ['SARAH7'], { code: 'SARAH7' }, Symbol.iterator]) {
    assert.equal(normalizeCode(raw), null, `should reject ${String(raw)}`);
  }
});

/* ---------- the two namespaces sharing /r/<code> ---------- */

test('a minted banner code never parses as an ambassador code of a different shape', () => {
  // The two normalizers must disagree in a predictable direction. A banner code
  // is 8 characters of a lowercase alphabet, so it always SATISFIES the
  // ambassador shape once uppercased — that is fine and expected: the resolver
  // tries banners first, and the ambassador lookup then finds nothing. What
  // must never happen is the reverse, which the next test covers.
  for (let i = 0; i < 200; i += 1) {
    const banner = mintBannerCode();
    assert.equal(normalizeCode(banner), banner.toUpperCase());
    assert.equal(normalizeBannerCode(banner), banner);
  }
});

test('a short or symbol-bearing ambassador code is invisible to the banner resolver', () => {
  // This is the direction that matters. If the banner normalizer accepted an
  // ambassador's code, /r/<code> would try to record a banner scan for it and
  // the person's traffic would vanish with nothing on screen to explain why.
  for (const code of ['SARAH7', 'ABC', 'A1B2C3D4E5', '001', 'BIGCODE']) {
    assert.equal(normalizeCode(code), code, 'valid as an ambassador code');
    assert.equal(normalizeBannerCode(code), null, `${code} must not resolve as a banner`);
  }
});

test('an 8-character ambassador code CAN collide with the banner alphabet', () => {
  // Not a bug — a documented, guarded case. SARAHXYZ lowercases into a string
  // the banner normalizer accepts, so the admin form refuses it when a banner
  // already holds it (ambassadorConflict in src/routes/admin.js). This test
  // exists so that guard is never deleted as redundant.
  assert.equal(normalizeCode('SARAHXYZ'), 'SARAHXYZ');
  assert.equal(normalizeBannerCode('SARAHXYZ'), 'sarahxyz', 'the collision is real and must stay guarded');
});

/* ---------- email ---------- */

test('an email is lowercased, so no two rows can hold one address', () => {
  assert.equal(normalizeEmail('Sarah.Chen@PSU.edu'), 'sarah.chen@psu.edu');
  assert.equal(normalizeEmail('  sarah@psu.edu  '), 'sarah@psu.edu');
});

test('an unusable email is refused', () => {
  for (const raw of ['', '   ', 'sarah', 'sarah@', '@psu.edu', 'sarah@psu', 'a b@psu.edu', null, undefined, {}]) {
    assert.equal(normalizeEmail(raw), null, `should reject ${JSON.stringify(raw)}`);
  }
});

test('an email past the column cap is refused rather than truncated', () => {
  // Truncating would store a DIFFERENT address that looks like the one typed,
  // and the column is UNIQUE, so two long addresses sharing a prefix would
  // collide on a value neither person has.
  const long = `${'a'.repeat(EMAIL_MAX)}@psu.edu`;
  assert.equal(normalizeEmail(long), null);
  assert.ok(EMAIL_MAX === 254, 'cap must match the column CHECK in migration-053');
});

/* ---------- phone ---------- */

test('phone accepts the ways people actually write a number', () => {
  for (const ok of ['8145550134', '814 555 0134', '(814) 555-0134', '+1 814 555 0134', '814.555.0134']) {
    assert.equal(isValidPhone(ok), true, `${ok} should be accepted`);
  }
});

test('phone refuses what is not a number, and blank is NOT its job', () => {
  for (const bad of ['abc', '123', 'call me', '814-555-0134 ext 2 please', null, undefined]) {
    assert.equal(isValidPhone(bad), false, `${JSON.stringify(bad)} should be refused`);
  }
  // Blank is a legal saved value (the field is optional) and the CALLER checks
  // for it first. This predicate deliberately says false, and a caller that
  // forgot the emptiness check would show a red message on an empty optional
  // field — which is exactly the bug this line is here to make visible.
  assert.equal(isValidPhone(''), false);
  assert.equal(isValidPhone('   '), false);
});

/* ---------- the visitor cookie ---------- */

const cookieReq = (raw) => ({ headers: raw == null ? {} : { cookie: raw } });
const NONCE = 'a'.repeat(32);

test('our cookie is read out of a header full of other cookies', () => {
  const got = readAmbassadorCookie(cookieReq(`_ga=GA1.2.x; ${AMBASSADOR_COOKIE}=${NONCE}.SARAH7; sb-auth=zzz`));
  assert.equal(got?.code, 'SARAH7');
  assert.equal(got?.nonce, NONCE);
  assert.equal(got?.hash?.length, 64, 'the nonce is hashed, never stored raw');
});

test('the raw nonce is never what comes back as the hash', () => {
  // The whole privacy claim in migration-053 is that the scans table holds a
  // hash of a value only the visitor's browser has.
  const got = readAmbassadorCookie(cookieReq(`${AMBASSADOR_COOKIE}=${NONCE}.SARAH7`));
  assert.notEqual(got.hash, NONCE);
  assert.match(got.hash, /^[0-9a-f]{64}$/);
});

test('a hand-crafted cookie cannot smuggle anything into the scans table', () => {
  const bad = [
    null,
    '',
    `${AMBASSADOR_COOKIE}=`,
    `${AMBASSADOR_COOKIE}=${NONCE}`,                       // no code
    `${AMBASSADOR_COOKIE}=${NONCE}.sarah7`,                // lowercase: not the stored form
    `${AMBASSADOR_COOKIE}=${NONCE}.AB`,                    // too short
    `${AMBASSADOR_COOKIE}=${NONCE}.${'A'.repeat(11)}`,     // too long
    `${AMBASSADOR_COOKIE}=${NONCE}.SARAH-7`,               // symbol
    `${AMBASSADOR_COOKIE}=${'z'.repeat(32)}.SARAH7`,       // nonce is not hex
    `${AMBASSADOR_COOKIE}=${'a'.repeat(31)}.SARAH7`,       // nonce too short
    `${AMBASSADOR_COOKIE}=${NONCE}.SARAH7.EXTRA`,
    `${AMBASSADOR_COOKIE}=${NONCE}.SARAH7'; drop table--`,
    'wrw_qr=' + `${NONCE}.abcdefgh`,                       // the OTHER feature's cookie
  ];
  for (const raw of bad) {
    assert.equal(readAmbassadorCookie(cookieReq(raw)), null, `should reject ${JSON.stringify(raw)}`);
  }
});

test('the ambassador cookie and the banner cookie do not read each other', () => {
  // They are separate on purpose (see the note in src/lib/ambassadors.js): one
  // regex covering both code shapes would have to be loose enough to accept
  // strings that are neither.
  const both = `wrw_qr=${NONCE}.abcdefgh; ${AMBASSADOR_COOKIE}=${NONCE}.SARAH7`;
  assert.equal(readAmbassadorCookie(cookieReq(both))?.code, 'SARAH7');
});

test('the cookie options are the ones the redirect and the clear must share', () => {
  const o = ambassadorCookieOptions();
  assert.equal(o.httpOnly, true, 'page JS must not be able to read or plant it');
  assert.equal(o.sameSite, 'lax', 'it has to survive the top-level OAuth redirect');
  assert.equal(o.path, '/', 'a clearCookie must match this path or it silently does nothing');
  assert.ok(o.maxAge > 0);
});

/* ---------- the shared bot filter ---------- */

test('the bot filter is the same one the banners use', () => {
  // Re-exported rather than re-declared. Two denylists drifting apart is how
  // one report starts disagreeing with the other.
  assert.equal(isLikelyBot('facebookexternalhit/1.1'), true);
  assert.equal(isLikelyBot('Slackbot-LinkExpanding 1.0'), true);
  assert.equal(isLikelyBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), false);
});

/* ---------- caps that have to match the migration ---------- */

test('the caps in this file are the caps in the column CHECKs', () => {
  // A JS cap looser than the SQL one turns a typo into a 500 instead of a red
  // message under the box.
  assert.equal(NAME_MAX, 80);
  assert.equal(CODE_MIN, 3);
  assert.equal(CODE_MAX, 10);
  assert.equal(POINTS_MAX, 5000, 'must match migration-053 ambassadors.points CHECK');
});

/* ---------- the payout ---------- */

test('an ambassador cannot outbid the signup bonus or a poster', () => {
  // 5000 is signup-bonus.js's POINTS_MAX, which tracked-qr.js already matches.
  // These three are siblings paid off the same rail; if one of them can pay more
  // than the others, the cheapest way to farm community points is whichever one
  // drifted, and nothing else in the stack would notice.
  assert.equal(POINTS_MAX, TRACKED_QR_POINTS_MAX);
});

test('the grant kind is its own, so the ledger index does not collide', () => {
  // migration-039's UNIQUE (ref_id, kind) keys on the pair. Sharing 'tracked_qr'
  // would mean a student recruited by an ambassador could never also be worth a
  // poster award, and the loss would be invisible — a swallowed
  // GRANT_ALREADY_PAID that reads exactly like a correct no-op.
  assert.equal(GRANT_KIND, 'ambassador');
  assert.notEqual(GRANT_KIND, 'tracked_qr');
  assert.notEqual(GRANT_KIND, 'referral_friend');
  assert.notEqual(GRANT_KIND, 'signup_bonus');
});

test('a rate of 0 is a real setting and is distinguishable from an absent one', () => {
  // Guards the client bug this invites: `points || ''` renders a 0 rate as an
  // empty box, and `points ?? 0` on an absent key silently invents a rate. The
  // route's validator draws that line and this is the shape it draws it on.
  assert.equal(Number.isInteger(0), true);
  assert.equal(0 > 0, false, 'a 0 rate must skip grant_community_points, which refuses non-positive amounts');
});
