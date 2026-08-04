/* WeRewards Terminal — minimal service worker (scope: /terminal/).
   Network-first with cache fallback for the app shell; API calls untouched.
   Registered from /terminal/sw.js so it controls ONLY the vendor terminal, never
   the student app at / (its own worker at /sw.js) or /admin (its own at
   /admin/sw.js).

   NOTE: CacheStorage is shared across all workers on one origin, so cleanup is
   scoped to this app's own 'werewards-terminal-' prefix — deleting every other
   cache here would wipe the student and admin PWA caches (and vice-versa). */

// v8: DEALS tab (send a deal to your regulars) — index.html + terminal.js + terminal.css.
//
// v7: "Forgot password?" recovery screen (index.html + terminal.js + terminal.css).
// The bump matters more than it looks: the precache holds BARE paths, the fetch
// fallback matches with ignoreSearch, and Cache.match returns the first entry
// inserted — so an un-bumped cache keeps serving the install-time terminal.js
// alongside a freshly cached index.html, and the new button does nothing offline.
// Bump this whenever a SHELL asset's contents change.
//
// v6: punch tab (rotating punch-in QR) + qrcode.js encoder; offline precache
// now actually matches the ?v= versioned asset URLs.
// v10: a live deal can be edited or taken down from the DEALS history.
// v11: AWARD + REDEEM merged into one SCAN tab with a single camera that routes
// by what it decodes (index.html + terminal.js + terminal.css).
// v12: phone layout — tabs become a fixed bottom bar, portrait viewfinder, and
// every side-by-side pair stacks (terminal.css + index.html viewport/titles).
const CACHE = 'werewards-terminal-v12';
const SHELL = [
  '/terminal/', '/terminal/terminal.css', '/terminal/terminal.js', '/terminal/jsQR.js', '/terminal/qrcode.js',
  '/terminal/no-zoom.js', '/terminal/manifest.json',
  '/terminal/icons/icon-192.png', '/terminal/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('werewards-terminal-') && k !== CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;    // supabase-js CDN + fonts manage their own caching
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
        hit || (e.request.mode === 'navigate' ? caches.match('/terminal/') : Response.error())
      )))
  );
});
