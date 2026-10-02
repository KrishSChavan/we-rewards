// How the student service worker routes a tapped notification
// (public/student/sw.js, the `notificationclick` listener).
//
// WHY THIS IS TESTED AT ALL. There are now four kinds of push reaching a
// student, and the difference between them is a query parameter:
//
//   /?deal=<id>   a vendor deal        -> open the deals list
//   /?deals=1     a bundle of them     -> open the deals list
//   /?spot=<id>   a nearby alert, or a reminder about one spot's points
//                                      -> open that spot's screen
//   /             a generic reminder, or an operator broadcast sent with no
//                 link at all          -> focus the app and open NOTHING
//
// The last row is the one worth a test. It only misbehaves when a tab is
// ALREADY OPEN: with no window, the worker calls openWindow(url) and '/' lands
// on Home correctly, so the bug is invisible in the common case and in every
// manual check that starts from a closed app. With a window, the worker
// postMessages a type instead, and a type of 'open-deals' makes app.js open the
// deals sheet over whatever the student was doing — so an announcement about new
// spots joining opened a list of vendor offers that said nothing about it.
//
// WHY THE SOURCE IS READ RATHER THAN IMPORTED. sw.js is a service worker: it
// registers listeners on `self` at module scope and is not an ES module this
// harness can import. test/nearby-client.test.js solves the same problem the
// same way for app.js. The listener body is evaluated in a fake worker global so
// the REAL routing expression runs, rather than a copy of it in this file that
// could silently drift from the one that ships.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../public/student/sw.js', import.meta.url), 'utf8');

/** Evaluate sw.js in a fake worker global and return what one tap did. */
function tap(url) {
  const sent = [];
  const opened = [];
  const listeners = {};
  // An OBJECT, not a `let focused = false`. The handler's work happens inside
  // the promise it hands to waitUntil, which the caller awaits AFTER tap()
  // returns — so a primitive would be copied into the result while still false
  // and the focus assertion would fail for a reason that has nothing to do with
  // sw.js. The arrays above work by accident of being mutated in place; this
  // makes the same thing true on purpose.
  const state = { focused: false };

  const self = {
    location: { origin: 'https://we-rewards.test' },
    addEventListener: (name, fn) => { listeners[name] = fn; },
    registration: { showNotification: async () => {} },
    skipWaiting: () => {},
  };
  const clients = {
    claim: async () => {},
    matchAll: async () => ([{
      url: 'https://we-rewards.test/',
      focus: () => { state.focused = true; },
      postMessage: (m) => sent.push(m),
    }]),
    openWindow: async (u) => { opened.push(u); },
  };
  const caches = {
    open: async () => ({ addAll: async () => {}, match: async () => undefined, put: async () => {} }),
    keys: async () => [],
    delete: async () => {},
    match: async () => undefined,
  };

  // eslint-disable-next-line no-new-func
  new Function('self', 'clients', 'caches', 'fetch', SRC)(
    self, clients, caches, async () => new Response('', { status: 200 }),
  );

  const handler = listeners.notificationclick;
  assert.ok(handler, 'sw.js registered no notificationclick listener');

  const waits = [];
  handler({
    notification: { close() {}, data: url === undefined ? {} : { url } },
    waitUntil: (p) => waits.push(p),
  });
  return { sent, opened, state, waits };
}

describe('notificationclick routing', () => {
  test('a vendor deal opens the deals list', async () => {
    for (const url of ['/?deal=abc', '/?deals=1']) {
      const r = tap(url);
      await Promise.all(r.waits);
      assert.deepEqual(r.sent, [{ type: 'open-deals', url }], `${url} should open the deals list`);
    }
  });

  test('a spot link opens that spot, not the deals list', async () => {
    const r = tap('/?spot=v-1');
    await Promise.all(r.waits);
    assert.deepEqual(r.sent, [{ type: 'open-spot', url: '/?spot=v-1' }]);
  });

  test('a push with no link focuses the app and opens nothing', async () => {
    // The regression this file exists for. 'open-deals' here would open a list
    // of vendor offers over an operator announcement.
    for (const url of ['/', '/?ref=x']) {
      const r = tap(url);
      await Promise.all(r.waits);
      assert.equal(r.sent.length, 1, 'exactly one message to the focused tab');
      assert.equal(r.sent[0].type, 'focus', `${url} must not open the deals sheet`);
      assert.ok(r.state.focused, 'the open tab should still be focused');
    }
  });

  test('a missing or unparseable target still focuses rather than throwing', async () => {
    // d.url is absent for a payload that predates this, and the worker falls
    // back to a literal. Whatever it falls back to, it must not throw inside
    // notificationclick: the tap would do nothing at all.
    for (const url of [undefined, 'http://['.repeat(3)]) {
      const r = tap(url);
      await Promise.all(r.waits);
      assert.equal(r.sent.length, 1, `no message sent for ${JSON.stringify(url)}`);
      assert.ok(['focus', 'open-deals'].includes(r.sent[0].type));
    }
  });

  test('with no window open it navigates instead of messaging', async () => {
    // Both halves of the same decision: the url is what openWindow receives, so
    // a wrong url here is a wrong landing page rather than a wrong sheet.
    const sent = [];
    const opened = [];
    const listeners = {};
    const self = {
      location: { origin: 'https://we-rewards.test' },
      addEventListener: (n, fn) => { listeners[n] = fn; },
      registration: { showNotification: async () => {} },
      skipWaiting: () => {},
    };
    const clients = {
      claim: async () => {},
      matchAll: async () => [],                 // nothing open
      openWindow: async (u) => { opened.push(u); },
    };
    const caches = {
      open: async () => ({ addAll: async () => {}, match: async () => undefined, put: async () => {} }),
      keys: async () => [], delete: async () => {}, match: async () => undefined,
    };
    // eslint-disable-next-line no-new-func
    new Function('self', 'clients', 'caches', 'fetch', SRC)(
      self, clients, caches, async () => new Response('', { status: 200 }),
    );
    const waits = [];
    listeners.notificationclick({
      notification: { close() {}, data: { url: '/' } },
      waitUntil: (p) => waits.push(p),
    });
    await Promise.all(waits);
    assert.deepEqual(sent, [], 'nothing to message when no tab is open');
    assert.deepEqual(opened, ['/'], 'a linkless push should land on Home');
  });
});
