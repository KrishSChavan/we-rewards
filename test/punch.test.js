// Unit tests for the rotating punch-token scheme and the hold binding
// (src/lib/punch.js). Pure functions — no network, no database.
//
// The business-night boundary is NOT tested here: it lives in punch_in
// (migration-028), computed in local wall-clock space from the scanned slot.
// Its DST behavior is asserted against a real Postgres in the migration
// harness, where the timezone database actually applies.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintPunchToken, verifyPunchToken, currentWindow, secondsLeftInWindow,
  punchUrl, mintPunchBinding, punchBindingHash, PUNCH_BINDING_COOKIE,
  PUNCH_WINDOW_SECONDS, PUNCH_GRACE_WINDOWS,
} from '../src/lib/punch.js';

const VENDOR = '5b3f9d2e-8a41-4c6d-9f2b-1a2b3c4d5e6f';
const NOW = Date.UTC(2026, 6, 29, 22, 0, 0); // 2026-07-29T22:00:00Z

describe('punch tokens', () => {
  test('a freshly minted token verifies and round-trips vendor + window', () => {
    const token = mintPunchToken(VENDOR, currentWindow(NOW));
    const parsed = verifyPunchToken(token, NOW);
    assert.ok(parsed, 'fresh token must verify');
    assert.equal(parsed.vendorId, VENDOR);
    assert.equal(parsed.windowIndex, currentWindow(NOW));
  });

  test('the token survives the URL round-trip a camera scan takes', () => {
    const token = mintPunchToken(VENDOR, currentWindow(NOW));
    const url = punchUrl('https://example.test', token);
    const back = new URL(url).searchParams.get('punch');
    assert.equal(back, token, 'nothing in the token needs URL-encoding');
    assert.ok(verifyPunchToken(back, NOW));
  });

  test('a token from the previous window still verifies (scan-to-submit lag)', () => {
    const token = mintPunchToken(VENDOR, currentWindow(NOW) - 1);
    assert.ok(verifyPunchToken(token, NOW));
  });

  test('a token older than the grace window is rejected', () => {
    const stale = mintPunchToken(VENDOR, currentWindow(NOW) - PUNCH_GRACE_WINDOWS - 1);
    assert.equal(verifyPunchToken(stale, NOW), null);
    // ...which is exactly what happens as time passes over a fixed token:
    const token = mintPunchToken(VENDOR, currentWindow(NOW));
    const later = NOW + (PUNCH_GRACE_WINDOWS + 1) * PUNCH_WINDOW_SECONDS * 1000;
    assert.equal(verifyPunchToken(token, later), null, 'the same token dies with its slot');
  });

  test('a token from the far future is rejected', () => {
    const future = mintPunchToken(VENDOR, currentWindow(NOW) + 5);
    assert.equal(verifyPunchToken(future, NOW), null);
  });

  test('tampering with any field breaks the signature', () => {
    const token = mintPunchToken(VENDOR, currentWindow(NOW));
    const [vid, win, sig] = token.split('.');
    const otherVendor = '00000000-0000-4000-8000-000000000000';
    assert.equal(verifyPunchToken(`${otherVendor}.${win}.${sig}`, NOW), null, 'vendor swap');
    assert.equal(verifyPunchToken(`${vid}.${Number(win) - 1}.${sig}`, NOW), null, 'window swap');
    const flipped = sig.endsWith('0') ? `${sig.slice(0, -1)}1` : `${sig.slice(0, -1)}0`;
    assert.equal(verifyPunchToken(`${vid}.${win}.${flipped}`, NOW), null, 'signature bit-flip');
  });

  test('garbage shapes are rejected without throwing', () => {
    for (const bad of [null, undefined, '', 'hello', 'a.b.c', `${VENDOR}..deadbeefdeadbeef`, `${VENDOR}.12`, 42]) {
      assert.equal(verifyPunchToken(bad, NOW), null);
    }
  });

  test('secondsLeftInWindow stays within (0, window]', () => {
    for (const t of [NOW, NOW + 1000, NOW + 29_000, NOW + 30_000]) {
      const left = secondsLeftInWindow(t);
      assert.ok(left > 0 && left <= PUNCH_WINDOW_SECONDS, `bad remainder ${left}`);
    }
  });
});

describe('hold binding', () => {
  const cookieReq = (raw) => ({ headers: { cookie: raw } });

  test('a minted binding round-trips from its cookie to the same hash', () => {
    const { nonce, hash } = mintPunchBinding();
    assert.match(nonce, /^[0-9a-f]{64}$/, 'nonce is 32 random bytes of hex');
    assert.notEqual(nonce, hash, 'the stored value is the hash, never the nonce');
    assert.equal(punchBindingHash(cookieReq(`${PUNCH_BINDING_COOKIE}=${nonce}`)), hash);
  });

  test('every mint is distinct, so one browser cannot replay another binding', () => {
    const a = mintPunchBinding();
    const b = mintPunchBinding();
    assert.notEqual(a.nonce, b.nonce);
    assert.notEqual(a.hash, b.hash);
  });

  test('the cookie is found alongside others and ignored when absent', () => {
    const { nonce, hash } = mintPunchBinding();
    assert.equal(punchBindingHash(cookieReq(`foo=1; ${PUNCH_BINDING_COOKIE}=${nonce}; bar=2`)), hash);
    assert.equal(punchBindingHash(cookieReq('foo=1; bar=2')), null);
    assert.equal(punchBindingHash(cookieReq('')), null);
    assert.equal(punchBindingHash({ headers: {} }), null);
    assert.equal(punchBindingHash(undefined), null);
  });

  test('a malformed cookie value yields null rather than a bogus hash', () => {
    for (const bad of ['', 'not-hex!!', 'abc']) {
      assert.equal(punchBindingHash(cookieReq(`${PUNCH_BINDING_COOKIE}=${bad}`)), null);
    }
  });
});
