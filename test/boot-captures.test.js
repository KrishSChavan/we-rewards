// The boot-time captures in public/student/app.js and the constants they read.
//
// boot() is an async IIFE that runs capturePunchLink(), captureReferralLink(),
// capturePosterQr() and captureSpotLink() synchronously, before its first
// await, while the file is still being evaluated. Each of those strips its
// parameter from the URL with history.replaceState and then writes it to
// storage under a key held in a `const`. A const declared BELOW the IIFE is in
// its temporal dead zone at that moment: the write throws a ReferenceError, the
// capture's own catch swallows it, and the parameter is already gone from the
// URL. That is exactly what shipped (found 2026-10-14 while adding the tag tap
// capture): invite links and scanned punch links were stripped and never
// stored, and nothing logged it. The fix is the declaration order, and this
// test is what keeps it. It reads the source rather than running the file: the
// failure is positional, and running app.js needs a browser's worth of stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/student/app.js', import.meta.url), 'utf8');

const BOOT = '(async function boot() {';
const KEYS = ['PENDING_PUNCH_KEY', 'PENDING_REF_KEY', 'PENDING_REF_TTL_MS', 'PENDING_QR_KEY', 'PENDING_QR_TTL_MS', 'PENDING_TAP_KEY', 'PENDING_TAP_TTL_MS'];
const CAPTURES = ['capturePunchLink()', 'captureReferralLink()', 'capturePosterQr()', 'captureSpotLink()', 'captureInstallFlag()'];

test('boot() is a top-level async IIFE that calls the captures before its first await', () => {
  const boot = src.indexOf(BOOT);
  assert.ok(boot > 0, 'boot IIFE landmark moved in public/student/app.js; re-anchor this test');
  const firstAwait = src.indexOf('await ', boot);
  assert.ok(firstAwait > boot, 'boot() has no await?');
  const sync = src.slice(boot, firstAwait);
  for (const call of CAPTURES) {
    assert.ok(sync.includes(call), `${call} must run synchronously at boot, before the first await`);
  }
});

test('every storage key a boot-time capture reads is declared ABOVE the boot IIFE', () => {
  const boot = src.indexOf(BOOT);
  for (const key of KEYS) {
    const decl = src.indexOf(`const ${key} =`);
    assert.ok(decl > 0, `const ${key} not found`);
    assert.equal(src.indexOf(`const ${key} =`, decl + 1), -1, `const ${key} declared twice`);
    assert.ok(decl < boot, `const ${key} is declared below boot(): it is in its temporal dead zone when the capture runs`);
  }
});
