/* WeRewards Admin — minimal service worker (scope: /admin/).
   Network-first with cache fallback for the app shell; API calls untouched.
   Registered from /admin/sw.js so it controls ONLY the operator dashboard, never
   the student app at / (which has its own worker at /sw.js).

   NOTE: CacheStorage is shared across all workers on one origin, so cleanup is
   scoped to this app's own 'werewards-admin-' prefix — deleting every other
   cache here would wipe the student PWA's cache (and vice-versa). */

// v4: zoom disabled app-wide (no-zoom.js).
// v5: vendor password-reset dialog (index.html + admin.js + admin.css).
// v6: dropped apple-mobile-web-app-status-bar-style=black-translucent and moved
// apple-mobile-web-app-capable behind server.js's iOS-version gate. The vendor
// terminal shipped the identical pair and it cost four attempts to work out that
// `capable` was selecting a web view sized to the screen minus the status bar and
// pinned to the top, stranding that height under the layout. Admin had never been
// installed on a phone, so it was latent rather than reported.
// v7: per-vendor Edit modal (points-per-dollar + reward items); accept flow can
// link an existing account as the vendor login (dual-role, migration-035).
// v8: bundles lowered to ES2017 for old Safari; supabase-js self-hosted off the
// CDN (and therefore precachable now); boot guard added.
// v9: browser tab favicon (index.html).
// v10: vendor rename in the Edit modal + "Add vendor" dialog (index.html +
// admin.js + admin.css).
// v11: Incentives tab — referral program editor, referrals list, manual
// community-point grants and the payout log (migration-039).
// v12: second incentive kind, the signup bonus (migration-040); programs are
// now created switched OFF and turned on as a separate step.
// v13: responsive admin shell, roster controls and modal editors for phones.
// v14: reliable admin alert enrollment, test delivery, and per-error pushes.
// v15: error log rows now explain what each failure was FOR (who hit it, what
// the request carried, which device) and the scan-here QR poster card was added
// (index.html + admin.js + admin.css).
// v16: dashboard reordered around the two jobs it gets opened for. The error log
// moved from last-of-eight to first card, directly under the "Errors · 24h" tile,
// which is now a button that jumps to it; the publish-once QR poster card moved
// off the dashboard into its own tab (index.html + admin.js + admin.css).
// v17: student roster behind the Students tile. A searchable, paged list of
// every signed-up student (GET /api/admin/students) and a read-only card per
// student (GET /api/admin/students/:id) with balances, visits, activity,
// referral position and account state (index.html + admin.js + admin.css).
const CACHE = 'werewards-admin-v17';
const SHELL = [
  '/admin/', '/admin/boot-guard.js', '/admin/admin.css', '/admin/admin.js', '/admin/supabase.js',
  '/admin/no-zoom.js', '/admin/manifest.json',
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

/* Web push: vendor-application and logged-error alerts sent by the server to
   subscribed operator browsers, even while the dashboard is closed.
   Payload: { title, body, url }. */
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
