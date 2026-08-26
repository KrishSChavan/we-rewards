// The proximity logic in public/student/app.js — the half of migration-051 that
// runs on the phone and decides WHETHER to ask the server anything at all.
//
// This is the part of the feature with no other safety net. The SQL side has
// test/sql/behavior-051.sql and a row lock; the client side is a distance
// calculation, a dwell timer and a filter, and every bug available in it is
// silent: too tight a radius or a reset dwell means nobody is ever notified,
// which produces no error, no log line and no complaint — just a feature that
// quietly does nothing. So the cases below are mostly about the boundary and
// the timer, not the happy path.
//
// SLICED AND EVALUATED, following test/address-format.test.js: the four
// front-ends under public/ are browser scripts, not modules (build-client.js
// transforms each file with no bundling), so nothing in test/ can import from
// them. The landmarks are deliberately brittle — if either moves, this throws
// rather than quietly testing nothing. It reads public/, not .build/, because
// the source is what a person edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../public/student/app.js', import.meta.url));
const src = readFileSync(APP, 'utf8');
const from = src.indexOf('const NEARBY_DEFAULTS');
const to = src.indexOf('/* ---------- the full-screen punch-in scanner ---------- */');
assert.ok(from > 0 && to > from, 'nearby block landmarks moved in public/student/app.js — re-anchor this test');
const slice = src.slice(from, to);

/**
 * Build a fresh sandbox per test. Everything the block reaches for that only
 * exists in a browser is shadowed by a local binding, so the slice runs
 * unmodified and nothing leaks between tests.
 *
 * `now` is a mutable clock: the dwell timer is the thing under test in half
 * this file, and waiting thirty real seconds per case is not a test suite.
 */
function sandbox({ vendors = [], allowed = true, ua = '', platform = '', touch = 0, installed = false } = {}) {
  const calls = { claims: [], notifications: [] };
  const clock = { now: 1_000_000 };
  const deps = {
    allVendors: vendors,
    Date: { now: () => clock.now },
    earnRateText: (n) => (Number(n) > 0 ? `${Number(n)} pts per $1` : ''),
    authFetch: async (url, opts) => {
      calls.claims.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ allowed }) };
    },
    // Only the ids the pure-logic paths touch are real; anything else returns a
    // throwaway so a stray render call cannot crash a test about distance.
    $: () => ({ hidden: false, textContent: '', classList: { add() {}, remove() {}, contains: () => false },
                setAttribute() {}, getAttribute: () => 'false', addEventListener() {}, innerHTML: '',
                appendChild() {}, disabled: false, offsetWidth: 0 }),
    navigator: {
      userAgent: ua,
      platform,
      maxTouchPoints: touch,
      geolocation: { watchPosition: () => 1, clearWatch() {}, getCurrentPosition() {} },
      serviceWorker: {
        ready: Promise.resolve({
          showNotification: async (title, opts) => { calls.notifications.push({ title, ...opts }); },
        }),
      },
      permissions: null,
    },
    Notification: { permission: 'granted' },
    window: {
      InstallPrompt: { isInstalled: () => installed },
      matchMedia: () => ({ matches: false }),
      navigator: { standalone: false },
    },
    localStorage: { getItem: () => null, setItem() {} },
    document: { createElement: () => ({ set textContent(_v) {} }) },
    console: { warn() {} },
    setTimeout: () => 0,
  };
  // eslint-disable-next-line no-new-func
  const api = new Function('deps', `
    let { allVendors, Date, earnRateText, authFetch, $, navigator, Notification,
          window, localStorage, document, console, setTimeout } = deps;
    ${slice}
    return {
      metersBetween, nearbyCandidates, onNearbyPosition, pruneNearbyDwell,
      applyNearbyConfig, nearbyPlatform, NEARBY_HELP,
      dwell: () => nearbyDwell,
      fired: () => nearbyFired,
      setVendors: (v) => { allVendors = v; },
      resetThrottle: () => { nearbyLastScanAt = 0; },
    };
  `)(deps);
  return { api, calls, clock };
}

const fix = (lat, lon, accuracy = 10) => ({ coords: { latitude: lat, longitude: lon, accuracy } });

// One spot on campus, and a second far enough away to be irrelevant.
const HERE = { lat: 40.7982, lon: -77.8599 };
const spot = (over = {}) => ({
  vendorId: over.vendorId ?? 'v1',
  name: over.name ?? 'Fresh Spot',
  // 'in', not ??: the whole point of one case below is passing an explicit
  // null, and "null ?? HERE.lat" would quietly hand it a real coordinate --
  // the test then passes a valid spot and proves nothing.
  latitude: 'latitude' in over ? over.latitude : HERE.lat,
  longitude: 'longitude' in over ? over.longitude : HERE.lon,
  visited: over.visited ?? false,
  favorite: over.favorite ?? false,
  poolId: over.poolId ?? null,
  pointsPerDollar: over.pointsPerDollar ?? 10,
  rewards: over.rewards ?? [{ id: 'r1', title: 'Free coffee' }],
});

/* ---------- the distance itself ---------- */

test('metersBetween: identical points are zero, not NaN', () => {
  const { api } = sandbox();
  // asin(sqrt(0)) is the case a naive haversine gets wrong by way of a tiny
  // negative under the root; 0 rather than NaN is what stops every spot in the
  // catalogue reading as out of range.
  assert.equal(api.metersBetween(HERE.lat, HERE.lon, HERE.lat, HERE.lon), 0);
});

test('metersBetween: a thousandth of a degree of latitude is ~111m', () => {
  const { api } = sandbox();
  const d = api.metersBetween(40.7982, -77.8599, 40.7992, -77.8599);
  assert.ok(Math.abs(d - 111.2) < 1, `expected ~111m, got ${d}`);
});

test('metersBetween: longitude shrinks with latitude', () => {
  const { api } = sandbox();
  // The mistake this catches is treating a degree of longitude as a fixed
  // distance. At Penn State's latitude it is about 76% of a degree of latitude,
  // so a flat-earth version would over-estimate east-west distance by a third —
  // enough to put a spot across the street outside a 150m radius.
  const ns = api.metersBetween(40.7982, -77.8599, 40.7992, -77.8599);
  const ew = api.metersBetween(40.7982, -77.8599, 40.7982, -77.8589);
  assert.ok(ew < ns * 0.8, `east-west (${ew}) should be well under north-south (${ns})`);
});

/* ---------- which spots are even candidates ---------- */

test('a clean, active, never-visited spot is a candidate', () => {
  const { api } = sandbox({ vendors: [spot()] });
  assert.deepEqual(api.nearbyCandidates().map((v) => v.vendorId), ['v1']);
});

test('somewhere they have already been is not', () => {
  const { api } = sandbox({ vendors: [spot({ visited: true })] });
  assert.deepEqual(api.nearbyCandidates(), []);
});

test('a spot with no coordinates is not', () => {
  const { api } = sandbox({ vendors: [spot({ latitude: null, longitude: null })] });
  assert.deepEqual(api.nearbyCandidates(), []);
});

test('a spot with nothing on the menu is not', () => {
  // "You haven't earned here yet" is a thin thing to interrupt someone for when
  // there is nothing to walk in for.
  const { api } = sandbox({ vendors: [spot({ rewards: [] })] });
  assert.deepEqual(api.nearbyCandidates(), []);
});

test('a second branch of a chain they already use is not', () => {
  // THE rule migration-048 cannot express. student_visited_vendor_ids answers
  // per vendor ROW, so the other Starbucks comes back visited:false — and "a
  // spot you haven't tried" is simply false about it. pool_id is what makes two
  // rows one business.
  const { api } = sandbox({
    vendors: [
      spot({ vendorId: 'known', visited: true, poolId: 'chain-1' }),
      spot({ vendorId: 'sibling', visited: false, poolId: 'chain-1' }),
      spot({ vendorId: 'unrelated', visited: false, poolId: 'chain-2' }),
    ],
  });
  assert.deepEqual(api.nearbyCandidates().map((v) => v.vendorId), ['unrelated']);
});

test('an unpooled spot is never collapsed into another by a null poolId', () => {
  // The bug the test above would hide: if `null` were treated as a pool key,
  // one visited unpooled spot would silence every other unpooled spot on campus.
  const { api } = sandbox({
    vendors: [spot({ vendorId: 'been', visited: true }), spot({ vendorId: 'new' })],
  });
  assert.deepEqual(api.nearbyCandidates().map((v) => v.vendorId), ['new']);
});

/* ---------- the dwell timer ---------- */

const settle = () => new Promise((r) => setImmediate(r));

test('arriving starts the clock and claims nothing yet', async () => {
  const { api, calls } = sandbox({ vendors: [spot()] });
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  await settle();
  assert.equal(calls.claims.length, 0, 'claimed on arrival — the dwell requirement is gone');
  assert.equal(api.dwell().size, 1, 'no dwell timer was started');
});

test('staying put past the dwell claims exactly once', async () => {
  const { api, calls, clock } = sandbox({ vendors: [spot()] });
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  clock.now += 31_000;
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  await settle();
  assert.equal(calls.claims.length, 1);
  assert.deepEqual(calls.claims[0].body, { vendorId: 'v1' });
  // Another fix after the claim must not post a second one: nearbyFired is what
  // stops a page burning a student's whole cap on one shop.
  clock.now += 10_000;
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  await settle();
  assert.equal(calls.claims.length, 1, 'claimed twice for one spot in one session');
});

test('a drive-past never dwells long enough', async () => {
  const { api, calls, clock } = sandbox({ vendors: [spot()] });
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));          // inside
  clock.now += 12_000;                                     // ~11s to cross 150m at 30mph
  api.onNearbyPosition(fix(HERE.lat + 0.004, HERE.lon));   // ~445m away, well past the exit
  clock.now += 30_000;
  api.onNearbyPosition(fix(HERE.lat + 0.004, HERE.lon));
  await settle();
  assert.equal(calls.claims.length, 0, 'a spot crossed at speed was claimed');
  assert.equal(api.dwell().size, 0, 'the dwell entry survived leaving the radius');
});

test('GPS jitter at the boundary does not restart the clock', async () => {
  // Without the wider exit radius a student standing near the edge has their
  // timer reset by every wobble and is NEVER notified — a silent failure.
  const { api, calls, clock } = sandbox({ vendors: [spot()] });
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  clock.now += 10_000;
  // ~178m: outside the 150m entry radius, inside the 202m exit radius.
  api.onNearbyPosition(fix(HERE.lat + 0.0016, HERE.lon));
  assert.equal(api.dwell().size, 1, 'jitter past the entry radius cleared the timer');
  clock.now += 25_000;
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  await settle();
  assert.equal(calls.claims.length, 1, 'the dwell never completed through the wobble');
});

test('a vague fix is ignored rather than acted on', async () => {
  // A 500m-accurate cell fix cannot answer "am I within 150m of that door", and
  // acting on one is how a student is told they are passing a shop across campus.
  const { api, calls, clock } = sandbox({ vendors: [spot()] });
  api.onNearbyPosition(fix(HERE.lat, HERE.lon, 500));
  clock.now += 31_000;
  api.onNearbyPosition(fix(HERE.lat, HERE.lon, 500));
  await settle();
  assert.equal(calls.claims.length, 0, 'a ±500m fix started a dwell');
  assert.equal(api.dwell().size, 0);
});

test('position updates are throttled', () => {
  const { api, clock } = sandbox({ vendors: [spot()] });
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  const first = api.dwell().get('v1');
  clock.now += 1000;                       // watchPosition can fire every second
  api.onNearbyPosition(fix(HERE.lat + 0.01, HERE.lon));   // far away — would clear it
  assert.equal(api.dwell().get('v1'), first, 'the throttled update was still processed');
});

/* ---------- choosing between several, and what gets shown ---------- */

test('only ONE claim goes out per position update', async () => {
  // The student's cooldown means the server would refuse the rest anyway, so
  // firing three claims to collect two refusals is two round trips for nothing.
  const { api, calls, clock } = sandbox({
    vendors: [spot({ vendorId: 'a' }), spot({ vendorId: 'b' }), spot({ vendorId: 'c' })],
  });
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  clock.now += 31_000;
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  await settle();
  assert.equal(calls.claims.length, 1);
});

test('a saved spot wins over a nearer one', async () => {
  const { api, calls, clock } = sandbox({
    vendors: [
      spot({ vendorId: 'near-stranger' }),                                     // right here
      spot({ vendorId: 'saved', favorite: true, latitude: HERE.lat + 0.0009 }), // ~100m off
    ],
  });
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  clock.now += 31_000;
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  await settle();
  assert.equal(calls.claims[0].body.vendorId, 'saved');
});

test('with no favourite in range the nearest wins', async () => {
  const { api, calls, clock } = sandbox({
    vendors: [
      spot({ vendorId: 'further', latitude: HERE.lat + 0.001 }),
      spot({ vendorId: 'nearest' }),
    ],
  });
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  clock.now += 31_000;
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  await settle();
  assert.equal(calls.claims[0].body.vendorId, 'nearest');
});

test('a refused claim shows nothing and leaves the spot claimable later', async () => {
  const { api, calls, clock } = sandbox({ vendors: [spot()], allowed: false });
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  clock.now += 31_000;
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  await settle();
  assert.equal(calls.notifications.length, 0, 'a refused claim still showed a notification');
  assert.equal(api.fired().has('v1'), false, 'a refused claim burned the spot for this session');
});

test('a granted claim shows the spot name and its earn rate', async () => {
  const { api, calls, clock } = sandbox({ vendors: [spot({ name: 'Irving’s' })] });
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  clock.now += 31_000;
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  await settle();
  assert.equal(calls.notifications.length, 1);
  const n = calls.notifications[0];
  assert.equal(n.title, 'You’re near Irving’s');
  assert.match(n.body, /haven’t earned here yet/);
  assert.match(n.body, /10 pts per \$1/);
  // Its OWN tag family. Sharing 'wr-deals' would silently REPLACE an unread
  // deal notification (renotify:false in sw.js) — destroying a message to
  // deliver an interruption.
  assert.equal(n.tag, 'wr-nearby-v1');
  assert.ok(!String(n.tag).startsWith('wr-deals'));
  assert.equal(n.data.url, '/?spot=v1');
});

test('a spot with no sensible rate says nothing rather than promising zero', async () => {
  const { api, calls, clock } = sandbox({ vendors: [spot({ pointsPerDollar: 0 })] });
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  clock.now += 31_000;
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  await settle();
  assert.equal(calls.notifications[0].body, 'You haven’t earned here yet.');
});

/* ---------- the catalogue changing under a running timer ---------- */

test('earning at a spot mid-dwell retires its timer', () => {
  const { api } = sandbox({ vendors: [spot()] });
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  assert.equal(api.dwell().size, 1);
  api.setVendors([spot({ visited: true })]);     // they walked in and bought something
  api.pruneNearbyDwell();
  assert.equal(api.dwell().size, 0, 'a timer survived the spot becoming visited');
});

/* ---------- the "turn location back on" instructions ---------- */
//
// Reached only when the browser has already recorded a denial — a state no web
// page can undo. Sending someone to the wrong Settings screen is the difference
// between a 20-second fix and giving up, so which list is chosen matters.

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120';

test('an installed iOS app is sent to its own entry, not to Safari', () => {
  const { api } = sandbox({ ua: IPHONE, installed: true });
  assert.equal(api.nearbyPlatform(), 'ios-app');
});

test('an iOS Safari tab is sent to Safari Websites', () => {
  const { api } = sandbox({ ua: IPHONE, installed: false });
  assert.equal(api.nearbyPlatform(), 'ios-browser');
});

test('an iPad that lies about being a Mac is still iOS', () => {
  // iPadOS reports a desktop UA; maxTouchPoints is the only tell, and the same
  // check isIosSafariTab() already relies on.
  const { api } = sandbox({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', touch: 5 });
  assert.equal(api.nearbyPlatform(), 'ios-browser');
});

test('a real Mac is desktop, not iPad', () => {
  const { api } = sandbox({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', touch: 0 });
  assert.equal(api.nearbyPlatform(), 'desktop');
});

test('installed and browser Android get different steps', () => {
  const app = sandbox({ ua: ANDROID, installed: true });
  const tab = sandbox({ ua: ANDROID, installed: false });
  assert.equal(app.api.nearbyPlatform(), 'android-app');
  assert.equal(tab.api.nearbyPlatform(), 'android-browser');
  assert.notDeepEqual(app.api.NEARBY_HELP['android-app'], tab.api.NEARBY_HELP['android-browser']);
});

test('every platform the detector can return has steps to show', () => {
  const { api } = sandbox();
  for (const key of ['ios-app', 'ios-browser', 'android-app', 'android-browser', 'desktop']) {
    assert.ok(Array.isArray(api.NEARBY_HELP[key]) && api.NEARBY_HELP[key].length,
      `no instructions for ${key} — openNearbyHelp would fall back to desktop steps on a phone`);
  }
});

/* ---------- the tunable knobs ---------- */

test('a missing or nonsense config falls back rather than disabling the feature', () => {
  const { api } = sandbox({ vendors: [spot()] });
  // A deployment whose /api/public-config predates migration-051 sends no
  // `nearby` key at all. Radius 0 would silently mean "never notify anyone".
  api.applyNearbyConfig(undefined);
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  assert.equal(api.dwell().size, 1, 'the fallback radius came out as zero');
});

test('a served radius is actually used', async () => {
  const { api, calls, clock } = sandbox({ vendors: [spot({ latitude: HERE.lat + 0.0018 })] });   // ~200m
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  assert.equal(api.dwell().size, 0, '200m was inside the default 150m radius');
  api.applyNearbyConfig({ radiusMeters: 300, dwellSeconds: 0 });
  api.resetThrottle();
  clock.now += 6000;
  // TWO updates even at dwellSeconds: 0, and that is the design rather than an
  // accident of this test. The first fix inside the radius only ever STARTS the
  // timer, so a spot is always seen on two separate fixes before anything is
  // claimed — a second, cheap guard against one spurious position reading, on
  // top of the accuracy gate.
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  clock.now += 6000;
  api.onNearbyPosition(fix(HERE.lat, HERE.lon));
  await settle();
  assert.equal(calls.claims.length, 1, 'the widened radius was ignored');
});
