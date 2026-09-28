/* WeRewards Scan — minimal service worker (scope: /scan/).
   Network-first with cache fallback for the app shell; API calls untouched.
   Registered from /scan/sw.js so it controls ONLY this app, never the student
   app at / (its own worker at /sw.js), /terminal (its own at /terminal/sw.js),
   or /admin (its own at /admin/sw.js).

   NOTE: CacheStorage is shared across all workers on one origin, so cleanup is
   scoped to this app's own 'werewards-scan-' prefix — deleting every other
   cache here would wipe the other three apps' PWA caches. */

// v1: first version, alongside making /scan installable at all (see the
// STANDALONE_CAM_COOKIE comment in scan.js for why that took this long: an
// installed home-screen icon on iOS below 14.3 has no getUserMedia at all, so
// the manifest/apple-touch-icon/apple-mobile-web-app-capable additions here
// only ship together with client-side detection that drops back to a plain
// Safari tab on a device where the camera would otherwise go dark).
// v2: browser tab favicon (index.html).
// v3: the boot guard recognises more engines' wording for a parse failure. This
// mount is the one aimed at devices old enough to hit that path, so the screen
// it shows has to be the right one (boot-guard.js).
// v5: pooled points (migration-044). The scan screen names the store it is
// ringing up for, and the two balance figures carry a 'shared' chip when this
// location spends from a purse shared with its siblings. Both are shell changes
// (index.html/scan.css/scan.js), so an installed iPad keeps serving the old
// three from cache until this constant moves.
// v6: the VISITS tab. A header tab row (hidden until the vendor has visits on)
// and the rotating punch-in code the full terminal shows, which brings a new
// precached file with it: /scan/qrcode.js, the QR generator. All four of the
// others changed too, so an installed iPad keeps serving the old shell until
// this constant moves.
// v7: crash reports from this screen name the vendor (and its id), the same as
// the full terminal's do — scan.js only. /scan had been the one POS screen whose
// errors arrived in the log with no idea which counter they came from.
// v8: scan.js only — renderPad() and renderQuickAwards() compute the award
// preview with the integer-cent expression pointsFor() uses in
// src/lib/rewards.js instead of Math.floor(amt * config.pointsPerDollar), which
// at some allowed rates floors a hair short (1.16 × 25 is 28.999999999999996,
// so the pad promised 28 where /api/vendor/award grants 29). This mount is the
// phone/iPad till, so that number is read out loud to the customer. The
// constant has to move or an installed device that loses connectivity after the
// deploy keeps previewing off the PRE-DEPLOY scan.js: the fallback below
// matches with ignoreSearch and Cache.match returns the first-INSERTED entry,
// i.e. the bare '/scan/scan.js' precached under v7. Production serves this
// worker off disk verbatim — the build-id suffix serveTestSw stamps on in
// server.js is behind IS_TEST_ENV — so this line is the only deploy signal an
// installed till gets. Online tills are unaffected: the fetch is network-first
// and versionAssets re-stamps ?v=<hash> from the new bytes.
const CACHE = 'werewards-scan-v8';
const SHELL = [
  '/scan/', '/scan/boot-guard.js', '/scan/scan.css', '/scan/scan.js',
  '/scan/jsQR.js', '/scan/qrcode.js', '/scan/no-zoom.js', '/scan/manifest.json',
  '/scan/icons/icon-192.png', '/scan/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('werewards-scan-') && k !== CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;    // Supabase auth REST manages its own caching
  if (url.pathname.startsWith('/api/')) return;   // live balances/redeems must never be stale

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      // ignoreSearch: server.js stamps local .js/.css refs with ?v=<hash>, and
      // Cache.match compares full URLs — without it the precached bare paths
      // never match a real request. The shell fallback is navigation-only, so a
      // missing subresource fails cleanly instead of being handed HTML bytes.
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => (
        hit || (e.request.mode === 'navigate' ? caches.match('/scan/') : Response.error())
      )))
  );
});
