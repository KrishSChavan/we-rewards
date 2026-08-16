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
// v13: safe-area fallback — <body> carries the colour of whatever meets the
// screen edge, so a shell served without viewport-fit=cover no longer shows a
// gap under the tab bar (terminal.css).
// v14: no-zoom.js re-adds viewport-fit=cover when a cached shell is missing it.
// v15: dropped apple-mobile-web-app-status-bar-style=black-translucent, which
// was stranding ~93px below the tab bar in the INSTALLED app only (the same
// page was flush in a Safari tab, where that meta is ignored).
// v16: the bottom band again, and v13-v15 were all treating the wrong cause. The
// status-bar-style meta was a passenger; apple-mobile-web-app-capable is what opts
// the icon into the legacy WebClip container that sizes the web view to the screen
// minus the status bar and still pins it to y=0. server.js now emits that tag only
// for iOS < 16.4 (see needsLegacyCapable), so modern devices get the manifest path
// the student PWA has always used. Confirmed on an iPhone: iOS re-reads that tag at
// launch, so this fixed an already-installed icon on the next force-quit, with no
// delete-and-re-add. Also: #main's bottom padding was 3px short of the tab bar's
// real height, because --nav-h omits the bar's own border-top.
// v17: quick-amount buttons are optional (empty list = keypad only, wrapper
// collapses); Save & leave no longer swallows a tap while a request is in
// flight; a save that hits an expired PIN session replays after the unlock
// instead of losing the edits.
// v19: the counter iPad again, and this time it is CSS, not syntax. Every
// `aspect-ratio` in terminal.css was silently dropped (it is Safari 15, these
// iPads are iOS 13/14), so the QR viewfinder fell back to the <video>'s
// intrinsic 300x150 and rendered as a letterbox slot, its targeting square
// stretched to the full frame height, and the keypad/PIN keys collapsed to
// twelve 47px slivers. Ratios are now carried by custom properties and spent on
// both axes instead. Also: an install that finds getUserMedia missing while
// running chrome-less now flags itself so server.js stops sending
// apple-mobile-web-app-capable, which is what puts it in the pre-14.3 WebClip
// container that has no camera at all (terminal.js + terminal.css + server.js).
//
// v18: bundles lowered to ES2017 so an older counter iPad can parse them at all;
// supabase-js self-hosted off the CDN; boot guard added.
// v20: browser tab favicon (index.html).
// v21: Settings can download the scan-here QR poster published by WeRewards
// (index.html + terminal.js + terminal.css).
// v22: Settings split into three regions by save model — Your spot (batched,
// with Save settings inside it), Access (staff PIN now self-saving, password,
// sign out) and Downloads (index.html + terminal.js + terminal.css).
// v23: a terminal whose supabase.js didn't arrive puts the sign-in card back
// with the reason instead of showing a white screen, and the boot guard
// recognises more engines' wording for a parse failure, so a counter iPad too
// old to parse terminal.js is told so instead of being offered a Try again
// button that can only fail again (terminal.js + boot-guard.js).
// v24: the tab row is one line that scrolls instead of a row that wraps, so the
// header is the same height on a phone, a 768px iPad and a 1024px one, and a
// seventh tab extends the scroll rather than growing the header into the
// viewfinder. Bottom bar on phones scrolls only once labels would clip
// (index.html + terminal.js + terminal.css).
const CACHE = 'werewards-terminal-v24';
// '/terminal/supabase.js' is precached now that it is served from this origin
// instead of jsDelivr (see scripts/build-client.js). It was never cacheable
// before: the fetch handler skips cross-origin requests, so an offline launch
// found the shell in cache and then failed on the CDN.
const SHELL = [
  '/terminal/', '/terminal/boot-guard.js', '/terminal/terminal.css', '/terminal/terminal.js',
  '/terminal/supabase.js', '/terminal/jsQR.js', '/terminal/qrcode.js',
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
