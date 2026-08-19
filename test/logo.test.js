// The vendor logo rule (src/lib/logo.js) — the one thing four write paths share.
//
// This file is the reason the module exists. The rule used to be three
// hand-copied pairs of constants in src/routes/{admin,apply,vendor}.js under
// "keep in sync" comments, and they had already drifted: `logo: ''` was a 400 on
// the /join door and a silent CLEAR on the operator's. Asserting the shared
// function is the only way that answer stays one answer, so the tests below are
// deliberately about the CONTRACT (what a value MEANS) rather than about any one
// route's plumbing.
//
// The boundary case derives its length from LOGO_MAX_CHARS rather than typing
// 500_000 again. A test that hard-codes the cap is a fourth copy of it, in the
// file whose job is to stop there being copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validLogo, LOGO_MAX_CHARS } from '../src/lib/logo.js';

const PREFIX = 'data:image/png;base64,';
const ok = `${PREFIX}iVBORw0KGgo=`;

test('a well-formed data-URL passes through byte-for-byte', () => {
  assert.deepEqual(validLogo(ok), { value: ok });
});

test('all three allowed media types are accepted', () => {
  for (const type of ['png', 'jpeg', 'webp']) {
    const url = `data:image/${type};base64,iVBORw0KGgo=`;
    assert.equal(validLogo(url).value, url, `should accept image/${type}`);
  }
});

test("null and '' both mean NO LOGO, and neither is an error", () => {
  // The two doors disagreed about '' before this module existed: /join 400'd on
  // it while the operator's form read it as "clear". One answer now, and it is
  // the forgiving one — an empty string is what an untouched file input sends.
  for (const blank of [null, undefined, '']) {
    assert.deepEqual(validLogo(blank), { value: null }, `should clear on ${JSON.stringify(blank)}`);
  }
});

test('anything that is not an inline raster image is refused', () => {
  const bad = [
    'https://example.com/logo.png',           // a remote URL is not an inline image
    'data:text/html;base64,PHNjcmlwdD4=',     // wrong media type
    'data:image/svg+xml;base64,PHN2Zz4=',     // SVG carries script; not in the allow-list
    'data:image/gif;base64,R0lGODlh',         // outside the allow-list too
    'data:image/png,notbase64',               // missing the base64 marker
    `${PREFIX}not base64 at all!`,            // spaces and ! are outside the alphabet
  ];
  for (const logo of bad) {
    assert.match(validLogo(logo).error, /Logo/, `should reject ${logo.slice(0, 40)}`);
  }
});

test('a non-string is refused rather than coerced', () => {
  // String(x) on an object yields "[object Object]", which fails the pattern
  // anyway — but only by accident. Refusing the type outright is what makes that
  // deliberate.
  for (const logo of [12345, {}, [], true, { toString: () => ok }]) {
    assert.match(validLogo(logo).error, /Logo/, `should reject ${JSON.stringify(logo)}`);
  }
});

test('the cap is a boundary, not an approximation', () => {
  // Exactly at the cap passes: the route's headroom argument (500_000 chars
  // inside server.js's 600 kb JSON limit) depends on the largest ACCEPTED body,
  // so a test that only proves "way over fails" never checks it.
  const atCap = PREFIX + 'A'.repeat(LOGO_MAX_CHARS - PREFIX.length);
  assert.equal(atCap.length, LOGO_MAX_CHARS);
  assert.equal(validLogo(atCap).value, atCap);
  assert.match(validLogo(`${atCap}A`).error, /Logo/, 'one character over must fail');
});
