/* WeRewards — minimal service worker.
   Network-first with cache fallback for the app shell; API calls untouched. */

const CACHE = 'werewards-v35';   // v35: vendor card widens when a big balance won't fit
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

/* ---------- vendor deals (migration-032) ----------
   Payload: { title, body, url, icon?, tag, count }. The server has already done
   the hard part — the campaign worker guarantees a student can never be sent
   two of these close together, and bundles whatever several vendors queued at
   once into ONE payload. See src/lib/campaigns.js.

   `tag` is the belt-and-braces half of that: a notification with the same tag
   REPLACES the one already in the shade instead of stacking beside it, and
   renotify:false means the replacement is silent. So even if something ever
   did slip past the server-side throttle (a second dyno, a clock skew, a
   retried delivery), the student's phone still shows exactly one WeRewards
   notification and only the first one made a sound. */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data?.json() ?? {}; } catch { /* non-JSON payload — show defaults */ }
  e.waitUntil(self.registration.showNotification(d.title || 'WeRewards', {
    body: d.body || '',
    icon: d.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: d.tag || 'wr-deals',
    renotify: false,
    data: { url: d.url || '/?deals=1' },
  }));
});

// Focus an open app if there is one (and route it to the deal), otherwise open
// a fresh window at the deep link.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/?deals=1';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const hit = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (hit) {
        // A focused tab won't re-navigate, so hand it the target instead and
        // let app.js open the right sheet.
        hit.postMessage({ type: 'open-deals', url });
        return hit.focus();
      }
      return clients.openWindow(url);
    })
  );
});
