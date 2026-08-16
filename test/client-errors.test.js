// What reaches error_logs from a BROWSER, and what is turned away on the path.
//
// Both halves here exist because of live reports that were wrong in a way no
// amount of staring at the dashboard would have explained:
//
//   1. A device posted `boot failed: syntax error (…/no-zoom.js#6)` and the
//      guard filed it as reason "boot-timeout", so the student was shown "check
//      your connection" and a Try again button on a browser that could never
//      parse the app however many times they pressed it. The message plainly
//      said syntax error; the test for it only knew the one-word "SyntaxError".
//   2. Googlebot's renderer skips subresources it doesn't need, so
//      window.supabase was absent when the student app's boot() reached it, and
//      every crawl filed the same TypeError against a bug no one can fix.
//
// The boot guard is the reason for the vm harness below. It only ever runs on
// browsers too old to run the app itself, which are exactly the browsers nobody
// here can attach a console to, so the choice it makes has to be checkable from
// a test. The harness runs the REAL public/shared/boot-guard.js — never a copy,
// or this would test a paraphrase of the thing that broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { isCrawler } from '../src/lib/errors.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD_SRC = fs.readFileSync(path.join(ROOT, 'public/shared/boot-guard.js'), 'utf8');

/**
 * Run boot-guard.js against a stub DOM, report `message` through the error hook
 * it installs, then let the page finish loading and the check fire.
 * Returns the body it posted to /api/client-error, or null if it stayed quiet.
 *
 * @param {string|null} message  what the engine reported, or null for "nothing threw"
 * @param {object} [opts]
 * @param {boolean} [opts.booted]   did the app's own script call __wrBooted()?
 * @param {boolean} [opts.flexGap]  does the stub support gap in flex containers?
 */
function runGuard(message, { booted = false, flexGap = true } = {}) {
  const posted = [];
  const timers = [];
  let onLoad = null;

  const node = () => ({
    style: {},
    scrollHeight: flexGap ? 1 : 0,          // what hasFlexGap() measures
    parentNode: { removeChild() {} },
    appendChild() {}, removeChild() {}, setAttribute() {},
    firstChild: null, onclick: null,
  });

  const win = {
    document: {
      documentElement: { className: '', appendChild() {}, setAttribute() {} },
      createElement: node,
      createTextNode: (t) => ({ t }),
      body: { firstChild: null, appendChild() {}, removeChild() {} },
    },
    navigator: { userAgent: 'stub' },
    location: { pathname: '/', href: 'https://we-rewards.com/' },
    onerror: null,
    addEventListener(type, fn) { if (type === 'load') onLoad = fn; },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    XMLHttpRequest: class {
      open() {} setRequestHeader() {}
      send(body) { posted.push(JSON.parse(body)); }
    },
  };
  win.window = win;

  vm.runInContext(GUARD_SRC, vm.createContext(win));

  if (booted) win.__wrBooted();
  if (message !== null) {
    win.onerror(message, 'https://we-rewards.com/no-zoom.js?v=2d814220', 6, 12, null);
  }
  onLoad();
  timers.forEach((fn) => fn());   // the 1200ms check after load
  return posted[0] ?? null;
}

const reasonFor = (message) => runGuard(message)?.context?.reason;

/* ---------- the boot guard's verdict ---------- */

test('a script that parsed keeps the guard silent', () => {
  assert.equal(runGuard(null, { booted: true }), null);
  // Even a runtime error after boot is the app's own reporter's business, not
  // this file's: __wrBooted() means the browser could read the code.
  assert.equal(runGuard('TypeError: x is not a function', { booted: true }), null);
});

test('the live report that was misfiled reads as an unsupported browser', () => {
  // Verbatim from error log 43bc2044 (2026-08-15). Two words and lowercase,
  // which the original /SyntaxError/ test did not match.
  assert.equal(
    reasonFor('syntax error (https://we-rewards.com/no-zoom.js?v=2d814220#6)'),
    'unsupported-browser'
  );
});

test('every engine wording for a parse failure reads as an unsupported browser', () => {
  for (const message of [
    "Uncaught SyntaxError: Unexpected token '?'",   // V8
    'SyntaxError: Unexpected identifier',           // JavaScriptCore
    'SyntaxError: Unexpected end of script',        // older JavaScriptCore
    'Syntax error',                                 // IE
    'Expected identifier',                          // IE
    'Invalid or unexpected token',                  // V8
    'illegal character U+003F',                     // SpiderMonkey
    'SyntaxError: Parse error',                     // old WebKit
  ]) {
    assert.equal(reasonFor(message), 'unsupported-browser', `misfiled: ${message}`);
  }
});

test('a browser that could parse but not load is told to try again, not that it is too old', () => {
  // The distinction is the whole point: "too old" ships no Try again button,
  // because on a device that cannot parse the app pressing it only ever fails
  // again. Get this backwards and a student on bad wifi is told to buy a phone.
  for (const message of ['Script error.', 'NetworkError: Failed to load resource', null]) {
    assert.equal(reasonFor(message), 'boot-timeout', `misfiled: ${message}`);
  }
});

test('the report says which app it came from and carries the failing line', () => {
  const body = runGuard('SyntaxError: Unexpected token');
  assert.equal(body.source, 'student');
  assert.equal(body.context.line, 6);
  assert.match(body.message, /^boot failed: /);
});

test('the flex-gap fallback class is set only when gap is unsupported', () => {
  // Same file, unrelated job, and it runs before the error hook is even
  // installed — a throw here would take the guard down with it.
  assert.doesNotThrow(() => runGuard(null, { flexGap: false }));
  assert.doesNotThrow(() => runGuard(null, { flexGap: true }));
});

/* ---------- crawlers ---------- */

test('JS-executing crawlers are recognised', () => {
  for (const ua of [
    // Verbatim from error log 8f38f398 (2026-08-16): the one that filed
    // "Cannot read properties of undefined (reading 'createClient')".
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/151.0.7922.108 Safari/537.36',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Chrome-Lighthouse',
  ]) {
    assert.equal(isCrawler(ua), true, `should have been read as a crawler: ${ua}`);
  }
});

test('real devices are never mistaken for crawlers', () => {
  for (const ua of [
    // Both from live reports: a real iPhone, and the Windows 7 Chrome that
    // filed the parse failure above. Neither may be filtered out of the log.
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.61 Safari/537.36',
    // The reason this is an explicit list and not /bot/: CUBOT make phones.
    'Mozilla/5.0 (Linux; Android 10; CUBOT NOTE 20) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPad; CPU OS 12_5_7 like Mac OS X) AppleWebKit/605.1.15 Version/12.1.2 Safari/604.1',
    '',
  ]) {
    assert.equal(isCrawler(ua), false, `should NOT have been read as a crawler: ${ua}`);
  }
  assert.equal(isCrawler(undefined), false);
  assert.equal(isCrawler(null), false);
});
