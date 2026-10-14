// The NFC tag tap handoff in public/student/app.js: the block between
// '/* ---------- NFC tag taps (/t/<ref>) ---------- */' and its end marker, with
// captureSpotLink/readSpotParam just above it, plus the two constants that live
// with the module state.
//
// WHY THIS IS TESTED. A tag tap is the first thing a brand-new student does with
// the app, and every failure in this block is silent: the page strips ?spot=
// from the URL at boot, so if the value is then lost (to Google's OAuth round
// trip, to a catalogue that had not loaded yet, to localStorage throwing with
// site data blocked, to a native deep link delivered twice) the student simply
// lands on Home with no spot open and nothing logged. The cases below are the
// hand-offs, not the happy path, plus the one beacon the native shell sends to
// count a tag the landing page never saw (migration-065): also silent, and a
// miscount in /admin is all a mistake there would ever show.
//
// SLICED AND EVALUATED, following test/nearby-client.test.js: the front-ends
// under public/ are browser scripts, not modules, so nothing in test/ can import
// from them. The landmarks are deliberately brittle: if one moves, this throws
// rather than quietly testing nothing. It reads public/, not .build/, because
// the source is what a person edits.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../public/student/app.js', import.meta.url));
const src = readFileSync(APP, 'utf8');

/** Slice `src` between two landmarks, insisting both are still there. */
function block(fromNeedle, toNeedle) {
  const from = src.indexOf(fromNeedle);
  const to = src.indexOf(toNeedle, from + 1);
  assert.ok(from > 0 && to > from,
    `landmark moved in public/student/app.js, re-anchor this test: ${fromNeedle}`);
  return src.slice(from, to);
}

// The key and TTL are declared with the module state, above the boot IIFE (the
// comment there says why: boot reaches them before the block has evaluated), so
// they are sliced on their own and evaluated ahead of the functions.
const constants = block('const PENDING_TAP_KEY', 'let pendingTap = null;');
const slice = block('function captureSpotLink', '/* ---------- end NFC tag taps ---------- */');

const KEY = 'wr-pending-tap';
const UUID = '6f1c2a4e-9b0d-4c7a-8e3f-1d2b3c4d5e6f';
const IRVINGS = [{ vendorId: 'u1', slug: 'Irvings', name: "Irving's" }];

/**
 * Build a fresh sandbox per test. Everything the block reaches for that only
 * exists in a browser is shadowed by a local binding, so the slice runs
 * unmodified and nothing leaks between tests.
 *
 * `bag` lets two sandboxes share one localStorage, which is how the OAuth round
 * trip is modelled: a page that stashed a tap, and a fresh page after it.
 * `store.throwing` turns every storage call into the throw a browser with site
 * data blocked produces. `clock.now` is the only clock the slice sees.
 * `counting: false` leaves authFetch out, as a sandbox that does not fake it
 * would; the beacon has to cope.
 */
function sandbox({ search = '', vendors = [], loaded = false, canOffer = true,
                   now = 1_000_000, bag = new Map(), counting = true } = {}) {
  const clock = { now };
  const calls = { opened: [], replaced: [], manual: 0, timers: [], beacons: [] };
  const store = { bag, throwing: false };
  const localStorage = {
    getItem(k) { if (store.throwing) throw new Error('SecurityError'); return store.bag.has(k) ? store.bag.get(k) : null; },
    setItem(k, v) { if (store.throwing) throw new Error('SecurityError'); store.bag.set(k, v); },
    removeItem(k) { if (store.throwing) throw new Error('SecurityError'); store.bag.delete(k); },
  };
  const location = { origin: 'https://we-rewards.com', pathname: '/', search, hash: '' };
  const history = {
    replaceState(_state, _title, url) {
      calls.replaced.push(url);
      // A real replaceState updates location, and the second capture at boot
      // reads the URL the first one left behind.
      const u = new URL(url, location.origin);
      location.pathname = u.pathname; location.search = u.search; location.hash = u.hash;
    },
  };
  const state = { canOffer };
  const deps = {
    location, history, localStorage,
    Date: { now: () => clock.now },
    allVendors: vendors,
    vendorsLoaded: loaded,
    openVendor: (id, origin) => { calls.opened.push([id, origin]); },
    TAB: { home: 0 },
    window: { InstallPrompt: { canOffer: () => state.canOffer, openManual: () => { calls.manual += 1; } } },
    // Runs the callback at once and records the delay, so the nudge is
    // observable without a real timer.
    setTimeout: (fn, ms) => { calls.timers.push(ms); fn(); return 0; },
    console: { warn() {} },
    // The real one adds the bearer token and returns fetch's promise; the
    // recorder keeps the call and answers like the route's 204 would.
    authFetch: counting
      ? (path, opts) => { calls.beacons.push([path, opts]); return Promise.resolve({ ok: true }); }
      : undefined,
  };
  // eslint-disable-next-line no-new-func
  const api = new Function('deps', `
    let { location, history, localStorage, Date, allVendors, vendorsLoaded,
          openVendor, TAB, window, setTimeout, console, authFetch } = deps;
    ${constants}
    let pendingTap = null;
    ${slice}
    return {
      captureSpotLink, readSpotParam, captureInstallFlag,
      readPendingTap, writePendingTap, clearPendingTap,
      resolveVendorRef, mergePending, flushPendingTap, routeUniversalLink, queueSpot,
      // The boot line, as app.js writes it (the wiring test below pins the text).
      boot: () => { pendingTap = { spot: captureSpotLink(), install: captureInstallFlag() }; mergePending(); },
      pending: () => pendingTap,
      lastTap: () => ({ id: lastTapVendorId, at: lastTapAt }),
      set: (p) => {
        if ('allVendors' in p) allVendors = p.allVendors;
        if ('vendorsLoaded' in p) vendorsLoaded = p.vendorsLoaded;
      },
    };
  `)(deps);
  return { api, calls, clock, store, state, location };
}

const stored = (s) => JSON.parse(s.store.bag.get(KEY) ?? 'null');

/* ---------- boot: capture ---------- */

describe('boot captures', () => {
  test('?spot= and ?install=1 are read once, stripped surgically, and stashed together', () => {
    const s = sandbox({ search: '?spot=irvings&install=1&ref=ABC' });
    s.api.boot();
    assert.deepEqual(s.api.pending(), { spot: 'irvings', install: true });
    assert.equal(s.calls.replaced.length, 2, 'one replaceState per captured parameter');
    assert.equal(s.location.search, '?ref=ABC', 'only our two parameters are stripped');
    assert.equal(s.calls.replaced.at(-1), '/?ref=ABC');
    const raw = stored(s);
    assert.equal(raw.spot, 'irvings');
    assert.equal(raw.install, true);
    assert.equal(typeof raw.at, 'number');
  });

  test('a bare origin captures nothing and leaves the URL alone', () => {
    const s = sandbox({ search: '' });
    s.api.boot();
    assert.equal(s.api.pending(), null, 'nothing captured and nothing stored normalises to null');
    assert.deepEqual(s.calls.replaced, []);
    assert.equal(s.store.bag.has(KEY), false);
  });

  test('a stashed tap expires after 30 minutes', () => {
    const s = sandbox({ search: '?spot=irvings' });
    s.api.boot();
    assert.deepEqual(s.api.readPendingTap(), { spot: 'irvings', install: false });
    s.clock.now += 29 * 60 * 1000;
    assert.ok(s.api.readPendingTap(), 'still there at 29 minutes');
    s.clock.now += 2 * 60 * 1000;
    assert.equal(s.api.readPendingTap(), null, 'gone at 31 minutes');
  });

  test('a malformed entry reads as nothing rather than throwing', () => {
    const s = sandbox();
    for (const junk of ['{', '42', '"irvings"', 'null', '[]']) {
      s.store.bag.set(KEY, junk);
      assert.doesNotThrow(() => s.api.readPendingTap(), junk);
      assert.equal(s.api.readPendingTap(), null, junk);
    }
    // No timestamp reads as malformed, not as fresh; an entry with nothing in
    // it reads as nothing.
    s.store.bag.set(KEY, '{"spot":"irvings"}');
    assert.equal(s.api.readPendingTap(), null);
    s.store.bag.set(KEY, `{"spot":null,"install":false,"at":${s.clock.now}}`);
    assert.equal(s.api.readPendingTap(), null);
  });
});

/* ---------- flush: the hand-off to the catalogue ---------- */

describe('flushPendingTap', () => {
  test('waits for the catalogue, then opens the spot and nudges the install exactly once', () => {
    const s = sandbox({ search: '?spot=irvings&install=1' });
    s.api.boot();

    s.api.flushPendingTap();
    assert.deepEqual(s.calls.opened, [], 'nothing opens before the catalogue lands');
    assert.ok(s.store.bag.has(KEY), 'the entry waits');
    assert.deepEqual(s.api.pending(), { spot: 'irvings', install: true });

    s.api.set({ vendorsLoaded: true, allVendors: IRVINGS });
    s.api.flushPendingTap();
    assert.deepEqual(s.calls.opened, [['u1', 0]], 'the slug resolves, case-insensitively, to the vendor id');
    assert.equal(s.calls.manual, 1, 'InstallPrompt.openManual once');
    assert.deepEqual(s.calls.timers, [800], 'after the home screen has painted');
    assert.equal(s.store.bag.has(KEY), false, 'consumed');
    assert.equal(s.api.pending(), null);
    assert.deepEqual(s.api.lastTap(), { id: 'u1', at: 1_000_000 });

    s.api.flushPendingTap();
    assert.deepEqual(s.calls.opened, [['u1', 0]], 'a second flush opens nothing');
    assert.equal(s.calls.manual, 1, 'and nudges nothing');
  });

  test('install alone does not wait for the catalogue, and is dropped where there is nothing to offer', () => {
    const a = sandbox({ search: '?install=1' });
    a.api.boot();
    a.api.flushPendingTap();
    assert.equal(a.calls.manual, 1);
    assert.deepEqual(a.calls.opened, []);

    // Installed already, the native shell, a desktop: canOffer() says no.
    const b = sandbox({ search: '?install=1', canOffer: false });
    b.api.boot();
    b.api.flushPendingTap();
    assert.equal(b.calls.manual, 0);
    assert.equal(b.store.bag.has(KEY), false, 'still consumed');
  });

  test('a uuid resolves by vendor id; an unknown ref opens nothing but is still consumed', () => {
    const vendors = [{ vendorId: UUID, slug: 'irvings' }];
    const a = sandbox({ search: `?spot=${UUID}`, vendors, loaded: true });
    a.api.boot();
    a.api.flushPendingTap();
    assert.deepEqual(a.calls.opened, [[UUID, 0]]);

    const b = sandbox({ search: '?spot=nowhere', vendors, loaded: true });
    b.api.boot();
    b.api.flushPendingTap();
    assert.deepEqual(b.calls.opened, []);
    assert.equal(b.store.bag.has(KEY), false, 'an unknown ref does not re-fire on every load');
    assert.equal(b.api.pending(), null);
    assert.deepEqual(b.api.lastTap(), { id: null, at: 0 });
  });

  test('survives the OAuth round trip: a fresh page with a bare URL finds the stash', () => {
    const bag = new Map();
    const before = sandbox({ search: '?spot=irvings&install=1', bag });
    before.api.boot();
    assert.deepEqual(before.calls.opened, []);

    // Google sends the browser back to the bare origin: new page, empty memory.
    const after = sandbox({ search: '', bag, vendors: IRVINGS, loaded: true, now: 1_000_000 + 5 * 60 * 1000 });
    after.api.boot();
    assert.deepEqual(after.api.pending(), { spot: 'irvings', install: true }, 'the stash joins memory at boot');
    after.api.flushPendingTap();
    assert.deepEqual(after.calls.opened, [['u1', 0]]);
    assert.equal(after.calls.manual, 1);
    assert.equal(bag.has(KEY), false);
  });

  test('with site data blocked (localStorage throws) the tap still opens from memory', () => {
    const s = sandbox({ search: '?spot=irvings&install=1', vendors: IRVINGS, loaded: true });
    s.store.throwing = true;
    s.api.boot();
    assert.deepEqual(s.api.pending(), { spot: 'irvings', install: true });
    assert.equal(s.location.search, '', 'the strip still happened');
    assert.equal(s.api.readPendingTap(), null, 'reads as nothing rather than throwing');
    assert.doesNotThrow(() => s.api.clearPendingTap());
    s.api.flushPendingTap();
    assert.deepEqual(s.calls.opened, [['u1', 0]]);
    assert.equal(s.calls.manual, 1);
    assert.equal(s.api.pending(), null);
  });
});

/* ---------- one stash per tap ---------- */

describe('one stash per tap', () => {
  test("a later tap replaces an earlier one, so tag A's install flag does not ride on tag B", () => {
    const bag = new Map();
    const a = sandbox({ search: '?spot=a&install=1', bag });
    a.api.boot();
    const b = sandbox({ search: '?spot=b', bag, vendors: [{ vendorId: 'ub', slug: 'b' }], loaded: true, now: 1_000_000 + 60_000 });
    b.api.boot();
    assert.deepEqual(b.api.pending(), { spot: 'b', install: false });
    b.api.flushPendingTap();
    assert.deepEqual(b.calls.opened, [['ub', 0]]);
    assert.equal(b.calls.manual, 0, 'no install nudge: this tap did not ask for one');
  });

  test('an older signed-in tab never consumes a stash a newer tab just wrote', () => {
    const bag = new Map();
    const old = sandbox({ search: '', bag, vendors: IRVINGS, loaded: true });
    old.api.boot();
    const fresh = sandbox({ search: '?spot=irvings', bag, vendors: IRVINGS, loaded: false });
    fresh.api.boot();
    old.api.flushPendingTap();   // a token refresh or a socket reconnect in the old tab
    assert.deepEqual(old.calls.opened, [], 'the old tab opens nothing');
    assert.ok(bag.has(KEY), 'and leaves the stash for the tab that asked');
    fresh.api.set({ vendorsLoaded: true });
    fresh.api.flushPendingTap();
    assert.deepEqual(fresh.calls.opened, [['u1', 0]]);
    assert.equal(bag.has(KEY), false);
  });

  test('a notification tap into an open tab is held for the catalogue, not dropped', () => {
    const s = sandbox({ loaded: false });
    assert.equal(s.api.queueSpot('irvings'), true);   // what the worker message path calls
    assert.deepEqual(s.calls.opened, []);
    s.api.set({ vendorsLoaded: true, allVendors: IRVINGS });
    s.api.flushPendingTap();
    assert.deepEqual(s.calls.opened, [['u1', 0]]);
  });
});

/* ---------- refs ---------- */

describe('resolveVendorRef', () => {
  test('matches the id exactly and the slug case-insensitively; nothing else', () => {
    const s = sandbox({ vendors: [{ vendorId: 'u1', slug: 'Irvings' }, { vendorId: 'u2', slug: null }] });
    assert.equal(s.api.resolveVendorRef('u1'), 'u1');
    assert.equal(s.api.resolveVendorRef('IRVINGS'), 'u1');
    assert.equal(s.api.resolveVendorRef('irvings'), 'u1');
    assert.equal(s.api.resolveVendorRef('u2'), 'u2', 'a row with no slug still resolves by id');
    assert.equal(s.api.resolveVendorRef('irving'), null);
    assert.equal(s.api.resolveVendorRef(''), null);
    assert.equal(s.api.resolveVendorRef(null), null);
  });

  test('an id matches case-insensitively too: a Universal Link hands over the tag URL as written', () => {
    const s = sandbox({ vendors: [{ vendorId: UUID, slug: 'irvings' }] });
    assert.equal(s.api.resolveVendorRef(UUID.toUpperCase()), UUID);
  });
});

/* ---------- native: Universal Links ---------- */

describe('routeUniversalLink', () => {
  test('a tag URL opens its spot; the duplicate delivery inside 5 s is dropped', () => {
    const s = sandbox({ vendors: IRVINGS, loaded: true });
    assert.equal(s.api.routeUniversalLink('https://we-rewards.com/t/irvings'), true);
    assert.deepEqual(s.calls.opened, [['u1', 0]]);
    assert.equal(s.api.routeUniversalLink('https://we-rewards.com/t/irvings'), false,
      'the same URL delivered twice in quick succession');
    assert.deepEqual(s.calls.opened, [['u1', 0]]);
    s.clock.now += 6000;
    assert.equal(s.api.routeUniversalLink('https://we-rewards.com/t/irvings'), true, 'a real second tap, later');
    assert.equal(s.calls.opened.length, 2);
  });

  test('refuses other origins, custom schemes, the generic tag and junk, touching nothing', () => {
    const s = sandbox({ vendors: IRVINGS, loaded: true });
    for (const url of [
      'https://evil.example/t/irvings',
      'http://we-rewards.com/t/irvings',
      'com.werewards.app://auth-callback?code=x',
      'https://we-rewards.com/t',
      'https://we-rewards.com/t/',
      'https://we-rewards.com/terminal',
      'https://we-rewards.com/spots/irvings',
      'not a url',
      '',
    ]) {
      assert.equal(s.api.routeUniversalLink(url), false, url);
    }
    assert.deepEqual(s.calls.opened, []);
    assert.equal(s.api.pending(), null);
    assert.equal(s.store.bag.has(KEY), false);
  });

  test("the landing page's /?spot= form routes too, and an encoded ref is decoded", () => {
    const s = sandbox({ vendors: [...IRVINGS, { vendorId: 'u3', slug: 'café' }], loaded: true });
    assert.equal(s.api.routeUniversalLink('https://we-rewards.com/?spot=u1'), true);
    assert.equal(s.api.routeUniversalLink('https://we-rewards.com/t/caf%C3%A9'), true);
    assert.deepEqual(s.calls.opened, [['u1', 0], ['u3', 0]]);
  });

  test('a link that arrives before the catalogue is held for loadVendors', () => {
    const s = sandbox({ loaded: false });
    assert.equal(s.api.routeUniversalLink('https://we-rewards.com/t/irvings'), true);
    assert.deepEqual(s.calls.opened, []);
    assert.equal(stored(s).spot, 'irvings', 'stashed, in case sign-in comes first');
    s.api.set({ vendorsLoaded: true, allVendors: IRVINGS });
    s.api.flushPendingTap();   // what loadVendors() does when the rows land
    assert.deepEqual(s.calls.opened, [['u1', 0]]);
    assert.equal(s.store.bag.has(KEY), false);
  });
});

/* ---------- the beacon: the native shell counts its own taps ---------- */

describe('the app tap beacon', () => {
  const beacons = (s) => s.calls.beacons.map(([path, opts]) => ({ path, method: opts.method, body: JSON.parse(opts.body) }));
  const ONE = [{ path: '/api/me/nfc-tap', method: 'POST', body: { ref: 'irvings' } }];

  test('a tag URL the shell caught posts exactly one beacon, and never again', () => {
    const s = sandbox({ vendors: IRVINGS, loaded: true });
    assert.equal(s.api.routeUniversalLink('https://we-rewards.com/t/irvings'), true);
    assert.deepEqual(beacons(s), ONE);
    assert.deepEqual(s.calls.opened, [['u1', 0]], 'the spot still opens');
    s.api.flushPendingTap();
    s.api.flushPendingTap();
    assert.equal(s.calls.beacons.length, 1, 'consumed with the stash: a second flush sends nothing');
    assert.equal(s.api.routeUniversalLink('https://we-rewards.com/t/irvings'), false);
    assert.equal(s.calls.beacons.length, 1, 'the doubled delivery the 5 s guard drops sends nothing either');
  });

  test('held for the catalogue, it goes out from the flush that opens the spot, not from the link', () => {
    const s = sandbox({ loaded: false });
    s.api.routeUniversalLink('https://we-rewards.com/t/irvings');
    assert.deepEqual(s.calls.beacons, [], 'the catalogue is signed-in only, so this page may have no session yet');
    assert.equal(stored(s).via, 'app', 'the origin waits with the ref');
    s.api.set({ vendorsLoaded: true, allVendors: IRVINGS });
    s.api.flushPendingTap();
    assert.deepEqual(beacons(s), ONE);
  });

  test('a ?spot= the page captured posts nothing: the landing page counted that tap', () => {
    const s = sandbox({ search: '?spot=irvings&install=1', vendors: IRVINGS, loaded: true });
    s.api.boot();
    assert.deepEqual(s.api.pending(), { spot: 'irvings', install: true }, 'no via');
    s.api.flushPendingTap();
    assert.deepEqual(s.calls.opened, [['u1', 0]]);
    assert.deepEqual(s.calls.beacons, []);
  });

  test("nor does a notification's spot, nor the landing page's /?spot= form handed to the shell", () => {
    const s = sandbox({ vendors: IRVINGS, loaded: true });
    s.api.queueSpot('irvings');                                     // the worker message path
    s.api.routeUniversalLink('https://we-rewards.com/?spot=u1');   // a page link: counted when the page was served
    assert.equal(s.calls.opened.length, 2);
    assert.deepEqual(s.calls.beacons, []);
  });

  test('an unknown ref is still reported: the server files it under Unmatched', () => {
    const s = sandbox({ vendors: IRVINGS, loaded: true });
    s.api.routeUniversalLink('https://we-rewards.com/t/stale-slug');
    assert.deepEqual(s.calls.opened, []);
    assert.deepEqual(beacons(s), [{ path: '/api/me/nfc-tap', method: 'POST', body: { ref: 'stale-slug' } }]);
  });

  test('via rides through storage: the shell reloading under a stashed tag counts it once', () => {
    const bag = new Map();
    const before = sandbox({ loaded: false, bag });
    before.api.routeUniversalLink('https://we-rewards.com/t/irvings');
    assert.deepEqual(before.calls.beacons, []);
    assert.deepEqual(before.api.readPendingTap(), { spot: 'irvings', install: false, via: 'app' });

    const after = sandbox({ bag, vendors: IRVINGS, loaded: true, now: 1_000_000 + 60_000 });
    after.api.boot();
    assert.deepEqual(after.api.pending(), { spot: 'irvings', install: false, via: 'app' }, 'mergePending keeps the stored via');
    after.api.flushPendingTap();
    assert.deepEqual(after.calls.opened, [['u1', 0]]);
    assert.deepEqual(beacons(after), ONE);
    assert.equal(bag.has(KEY), false);
    after.api.flushPendingTap();
    assert.equal(after.calls.beacons.length, 1);
  });

  test('with site data blocked the count still goes out from memory', () => {
    const s = sandbox({ loaded: false });
    s.store.throwing = true;
    s.api.routeUniversalLink('https://we-rewards.com/t/irvings');
    s.api.set({ vendorsLoaded: true, allVendors: IRVINGS });
    s.api.flushPendingTap();
    assert.deepEqual(beacons(s), ONE);
  });

  test("a later notification tap drops the tag's via rather than inheriting its beacon", () => {
    const s = sandbox({ loaded: false });
    s.api.routeUniversalLink('https://we-rewards.com/t/irvings');
    s.api.queueSpot('u1');   // a nearby alert while the catalogue is still loading
    assert.deepEqual(s.api.pending(), { spot: 'u1' });
    assert.equal('via' in stored(s), false);
    s.api.set({ vendorsLoaded: true, allVendors: IRVINGS });
    s.api.flushPendingTap();
    assert.deepEqual(s.calls.opened, [['u1', 0]]);
    assert.deepEqual(s.calls.beacons, []);
  });

  test('a stored via that is neither app nor web reads as none', () => {
    const s = sandbox();
    s.store.bag.set(KEY, `{"spot":"irvings","install":false,"via":"tag","at":${s.clock.now}}`);
    assert.deepEqual(s.api.readPendingTap(), { spot: 'irvings', install: false });
  });

  test('without authFetch the tap still opens and nothing throws', () => {
    const s = sandbox({ vendors: IRVINGS, loaded: true, counting: false });
    assert.doesNotThrow(() => s.api.routeUniversalLink('https://we-rewards.com/t/irvings'));
    assert.deepEqual(s.calls.opened, [['u1', 0]], 'counted or not, the spot opens');
  });
});

/* ---------- wiring: the call sites outside the block ---------- */

describe('wiring in app.js', () => {
  test('boot, render, loadVendors, the worker message and the native listener all reach the block', () => {
    assert.ok(src.includes('pendingTap = { spot: captureSpotLink(), install: captureInstallFlag() };'),
      'boot captures both halves into pendingTap');
    assert.ok(/captureInstallFlag\(\) \};[^\n]*\r?\n\s*mergePending\(\);/.test(src), 'boot merges the stash an earlier page left, once');
    assert.ok(src.includes('vendorsReady.then(flushPendingTap);'), 'render() flushes once the catalogue lands');
    assert.ok(src.includes('if (spot) queueSpot(spot);'), 'the worker message path holds a tap for the catalogue, id or slug');
    assert.equal(src.includes('pendingSpotLink'), false, 'the old single-purpose holder is gone');
    assert.ok(src.includes('async function authFetch(path, opts = {}) {'),
      'the beacon reaches for the module-level authFetch the sandbox above fakes');

    const load = block('async function loadVendors()', 'showVendorSkeleton(false);');
    assert.ok(load.includes('flushPendingTap();'), 'loadVendors() flushes a tap that arrived mid-load');

    const native = block('function wireNativeOAuthCallback()', 'async function signInWithGoogle()');
    assert.ok(native.includes('routeUniversalLink(url);'), 'appUrlOpen routes what is not the OAuth callback');
    assert.ok(!native.includes('plugins.App.getLaunchUrl'), 'getLaunchUrl is never consulted: Capacitor keeps it for the whole process and a reload would replay the tag');
    assert.ok(native.includes('url.startsWith(NATIVE_OAUTH_REDIRECT)'), 'the OAuth branch is still gated on its scheme');
  });
});
