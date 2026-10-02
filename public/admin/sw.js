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
// v18: the crash reporter is installed FIRST, so a boot that dies on a missing
// script is reported at all; that boot now puts the sign-in card back with the
// reason rather than leaving the page blank; and the boot guard recognises more
// engines' wording for a parse failure, so a device too old to run admin.js gets
// the "too old" screen instead of a Try again button that can only fail again
// (admin.js + boot-guard.js).
// v19: every operator list can now be searched and paged. Vendors, applications,
// the error log, referrals and the payout log each got the filter row the student
// roster already had, plus a count that says what it is counting; the three logs
// the server pages gained a "Show more" and an exact total behind it
// (index.html + admin.js + admin.css).
// v20: the Edit dialog gained a Logo section — pick, Remove and "Save logo"
// against PATCH /api/admin/vendors/:id, with the current artwork read back from
// the new GET /api/admin/vendors/:id/logo (index.html + admin.js + admin.css)
// v25: the application review card lists the redeemable items the applicant named
// on /join, and Add vendor takes an optional first item, both priced in dollars
// (index.html + admin.js + admin.css).
// v26: new Ambassadors tab — add a person with a code they chose, copy it, show
// its QR, edit them, turn their link off or delete them; scans and signups roll
// up per person off the shared /r/ rail (index.html + admin.js + admin.css).
// NOT bumped for the admin.js change that ships alongside this line (deleteVendor
// printing the server's own 409 sentence — VENDOR_IN_POOL / VENDOR_HAS_BILLING /
// VENDOR_BILLING_CANCEL_FAILED from the pre-delete guards of DELETE
// /api/admin/vendors/:id). That is deliberate, and it is the one place this worker
// differs from its three siblings: the fetch fallback below is a plain exact-URL
// caches.match with NO ignoreSearch, so a '/admin/admin.js?v=<newhash>' request
// can never be satisfied by the bare '/admin/admin.js' this cache precached before
// the deploy — the stale-shell path that forces a bump in public/vendor/sw.js,
// public/student/sw.js and public/scan/sw.js cannot fire here.
//
// Bumping would make the offline story WORSE, not better: the dashboard's own
// online load after a deploy puts '?v=<newhash>' into whichever cache is current,
// and a bump then throws that cache away at activate, leaving a cache holding only
// the bare precached paths. An offline relaunch in that window asks for
// '?v=<newhash>', misses, and falls through to `caches.match('/admin/')` — which
// answers a SCRIPT request with the shell's HTML, so admin.js is parsed as HTML
// and the boot dies. Driven both ways against the real handlers in this file
// (scratchpad/sw-bump-proof-all.mjs): un-bumped serves the post-deploy admin.js
// offline, bumped serves the HTML document.
//
// What keeps that safe is that every key in here is refreshed by an ordinary
// online load: a stamped asset arrives under a NEW key, and an unstamped one
// ('/admin/', the manifest, the icons) is overwritten in place by the put in the
// fetch handler. Give the fallback an ignoreSearch — the sensible fix for the
// HTML-answering-a-script bug above, and what the other three already do — and
// that stops being true, because the first-inserted bare entry then wins over the
// stamped one. Whoever makes that change must bump this constant in the same
// commit, and from then on every admin.js change needs the bump the siblings do.
const CACHE = 'werewards-admin-v31';   // v31: a Broadcast tab — compose one push to a chosen student audience (everyone / can-redeem-now / stopped-coming / one spot's customers), with a live audience count, a two-tap arm on Send and a history card that can stop a queue mid-flight (migration-061; index.html + admin.js + admin.css, all three precached). Without this bump an operator keeps a shell whose VIEWS array has no 'broadcast' in it, so the tab button renders and setView refuses it   // v30: the Refer a friend panel describes the new rule — both bonuses paid at signup (migration-058), "Waiting" now meaning a refused payout rather than a friend who hasn't bought anything, and the two caps called out as the only remaining limit on the program. index.html + admin.js, both precached: an operator left on v29 reads the old anti-fraud reasoning as if it still held and leaves the cap blank
// v29: the error log names the spot each failure came from — a Vendor row in the detail, the name on the summary line, and a Vendor line in "Copy details" so a pasted report carries it too (admin.js only). Without this bump an operator with the dashboard installed reads rows that have the vendor in their context and no row showing it
// v28: an ROI tab — per spot, who came back, what the repeat visits were worth, what was given away to get them, and the net, plus the downtown median to compare against; carries each vendor's plan, free-for-life flag and days-past-due from migration-055 (index.html + admin.js + admin.css)
const SHELL = [
  '/admin/', '/admin/boot-guard.js', '/admin/admin.css', '/admin/admin.js', '/admin/supabase.js',
  '/admin/no-zoom.js', '/admin/manifest.json', '/admin/qrcode.js',
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
