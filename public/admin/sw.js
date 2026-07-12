/* WeRewards Admin — minimal service worker (scope: /admin/).
   Network-first with cache fallback for the app shell; API calls untouched.
   Registered from /admin/sw.js so it controls ONLY the operator dashboard, never
   the student app at / (which has its own worker at /sw.js).

   NOTE: CacheStorage is shared across all workers on one origin, so cleanup is
   scoped to this app's own 'werewards-admin-' prefix — deleting every other
   cache here would wipe the student PWA's cache (and vice-versa). */

const CACHE = 'werewards-admin-v1';
const SHELL = [
  '/admin/', '/admin/admin.css', '/admin/admin.js', '/admin/manifest.json',
  '/admin/icons/icon-192.png', '/admin/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('werewards-admin-') && k !== CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;    // supabase-js CDN manages its own caching
  if (url.pathname.startsWith('/api/')) return;   // live analytics/errors must never be stale

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/admin/')))
  );
});
