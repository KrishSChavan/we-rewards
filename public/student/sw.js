/* WeRewards — minimal service worker.
   Network-first with cache fallback for the app shell; API calls untouched. */

const CACHE = 'werewards-v28';   // v28: punch cards + offline precache actually matching
const SHELL = ['/', '/theme-init.js', '/no-zoom.js', '/styles.css', '/app.js', '/qrcode.js', '/jsQR.js', '/install-prompt.js', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // Scope cleanup to this app's own cache family. CacheStorage is shared per
      // origin, so deleting every non-current cache would wipe the /admin PWA's
      // cache ('werewards-admin-*'), which lives here too. Only prune old
      // 'werewards-v*' versions.
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('werewards-v') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;   // CDNs manage their own caching
  if (url.pathname.startsWith('/api/')) return;       // live data must never be stale
  if (url.pathname.startsWith('/socket.io/')) return; // let the realtime transport pass through

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      // ignoreSearch matters: server.js stamps every local .js/.css reference
      // with ?v=<content-hash>, and Cache.match compares full URLs — so without
      // it the precached bare paths above can NEVER satisfy a page request and
      // a first-visit-then-offline load finds nothing.
      // The '/' fallback is for navigations only: answering a missing script or
      // stylesheet with the HTML document gives the browser HTML bytes to parse
      // as JavaScript, which is worse than a clean failure.
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => (
        hit || (e.request.mode === 'navigate' ? caches.match('/') : Response.error())
      )))
  );
});
