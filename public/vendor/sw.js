/* WeRewards Terminal — minimal service worker (scope: /terminal/).
   Network-first with cache fallback for the app shell; API calls untouched.
   Registered from /terminal/sw.js so it controls ONLY the vendor terminal, never
   the student app at / (its own worker at /sw.js) or /admin (its own at
   /admin/sw.js).

   NOTE: CacheStorage is shared across all workers on one origin, so cleanup is
   scoped to this app's own 'werewards-terminal-' prefix — deleting every other
   cache here would wipe the student and admin PWA caches (and vice-versa). */

const CACHE = 'werewards-terminal-v2';
const SHELL = [
  '/terminal/', '/terminal/terminal.css', '/terminal/terminal.js', '/terminal/manifest.json',
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
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/terminal/')))
  );
});
