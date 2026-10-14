// Which navigations the student service worker refuses to answer for
// (public/student/sw.js: FOREIGN and the `fetch` listener).
//
// WHY THIS IS TESTED AT ALL. The worker registers at '/', so every page on the
// origin sits inside its scope, and its offline fallback for a navigation is
// caches.match('/'): the STUDENT SHELL. Online that is invisible (network-first),
// which is exactly why every entry in FOREIGN was added only after a page had
// already been answered wrongly: /terminal (v81), the public pages (v82),
// /support (v105). v106 adds the NFC tag landing, /t and /t/<ref>, where the
// failure would be an installed PWA on a flaky connection answering a tag tap
// with Home sitting at a /t/<slug> URL, and the first navigation an Android
// WebAPK makes when it catches a tag is precisely that one. The regex is also
// easy to get subtly wrong: 't' as an alternative must not swallow /terminal,
// /tea or /tap.js, and the cases below pin both edges.
//
// The CACHE constant is asserted too, because the bump is the load-bearing half
// of any FOREIGN change: production serves this worker verbatim, so an installed
// phone only learns the list changed when that string does.
//
// WHY THE SOURCE IS READ RATHER THAN IMPORTED: see
// test/sw-notification-routing.test.js, whose sandbox this copies. The real
// listener runs; only the worker globals are faked.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../public/student/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://we-rewards.test';

/**
 * Evaluate sw.js in a fake worker global, hand its fetch listener one
 * navigation, and say whether the worker claimed it (called respondWith).
 */
function navigate(path, { method = 'GET', mode = 'navigate' } = {}) {
  const listeners = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (name, fn) => { listeners[name] = fn; },
    registration: { showNotification: async () => {} },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  const clients = { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} };
  const caches = {
    open: async () => ({ addAll: async () => {}, match: async () => undefined, put: async () => {} }),
    keys: async () => [],
    delete: async () => {},
    match: async () => undefined,
  };
  // `location` is a parameter as well as self.location: the fetch listener reads
  // the bare global, which a worker has and Node does not.
  // eslint-disable-next-line no-new-func
  new Function('self', 'clients', 'caches', 'fetch', 'location', SRC)(
    self, clients, caches, async () => new Response('', { status: 200 }), self.location,
  );
  const handler = listeners.fetch;
  assert.ok(handler, 'sw.js registered no fetch listener');

  let handled = false;
  handler({
    request: { method, url: ORIGIN + path, mode, clone() { return this; } },
    // Swallow the promise: the network branch runs against the fake fetch and
    // cache above, and an unhandled rejection from it would fail the wrong test.
    respondWith(p) { handled = true; Promise.resolve(p).catch(() => {}); },
  });
  return handled;
}

describe('FOREIGN: navigations the student worker must leave to the server', () => {
  test('the NFC tag landing and every ref under it pass through', () => {
    for (const p of ['/t', '/t/', '/t/irvings', '/t/irvings?x=1', '/t/irvings/']) {
      assert.equal(navigate(p), false, `${p} must always come from the server`);
    }
  });

  test("Apple's well-known file passes through", () => {
    assert.equal(navigate('/.well-known/apple-app-site-association'), false);
  });

  test('the other apps and the server routes still pass through', () => {
    for (const p of ['/terminal', '/terminal/', '/r/abc', '/api/x']) {
      assert.equal(navigate(p), false, `${p} must reach the server`);
    }
  });

  test("'t' does not swallow the student app's own paths", () => {
    for (const p of ['/', '/app.js', '/tap.js', '/tea', '/tapestry']) {
      assert.equal(navigate(p), true, `${p} is the worker's to answer`);
    }
  });
});

describe('the cache version', () => {
  test('is at least v106, the bump that put /t in FOREIGN', () => {
    const m = /const CACHE = 'werewards-v(\d+)'/.exec(SRC);
    assert.ok(m, 'CACHE constant not found in sw.js');
    assert.ok(Number(m[1]) >= 106,
      `CACHE is v${m[1]}: an installed PWA only learns FOREIGN changed when this string does`);
  });
});
