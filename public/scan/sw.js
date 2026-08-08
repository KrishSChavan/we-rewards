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
const CACHE = 'werewards-scan-v2';
const SHELL = [
  '/scan/', '/scan/boot-guard.js', '/scan/scan.css', '/scan/scan.js',
  '/scan/jsQR.js', '/scan/no-zoom.js', '/scan/manifest.json',
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
