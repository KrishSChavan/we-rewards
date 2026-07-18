/* WeRewards Admin — minimal service worker (scope: /admin/).
   Network-first with cache fallback for the app shell; API calls untouched.
   Registered from /admin/sw.js so it controls ONLY the operator dashboard, never
   the student app at / (which has its own worker at /sw.js).

   NOTE: CacheStorage is shared across all workers on one origin, so cleanup is
   scoped to this app's own 'werewards-admin-' prefix — deleting every other
   cache here would wipe the student PWA's cache (and vice-versa). */

const CACHE = 'werewards-admin-v2';
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

/* Web push: "new vendor application" alerts sent by the server (src/lib/push.js)
   to every subscribed operator browser — this fires even with the dashboard
   closed. Payload: { title, body, url }. */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data?.json() ?? {}; } catch { /* non-JSON payload — show defaults */ }
  e.waitUntil(self.registration.showNotification(d.title || 'WeRewards Admin', {
    body: d.body || '',
    icon: '/admin/icons/icon-192.png',
    badge: '/admin/icons/icon-192.png',
    data: { url: d.url || '/admin/' },
  }));
});

// Clicking the notification focuses an open dashboard if there is one,
// otherwise opens a fresh /admin window.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const hit = list.find((c) => new URL(c.url).pathname.startsWith('/admin'));
      return hit ? hit.focus() : clients.openWindow(e.notification.data?.url || '/admin/');
    })
  );
});
