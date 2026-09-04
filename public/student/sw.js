/* WeRewards — minimal service worker.
   Network-first with cache fallback for the app shell; API calls untouched. */

const CACHE = 'werewards-v83';   // v83: the app boots on a browser with site data blocked. Reading localStorage there THROWS rather than returning null, and the theme read in boot() was the one unguarded call left — so the whole app died and told the student "Couldn't reach WeRewards. Check your connection and try again." on a perfectly good connection
// v82: the server-rendered public pages (/spots, /spots/<slug>, /how-it-works, /faq) and the two crawler files (/robots.txt, /sitemap.xml) join FOREIGN. This worker's scope is '/', so without it an installed PWA answered a navigation to any of them from cache, and an offline one with the student shell sitting at a /spots/<slug> URL. Those pages exist to be crawled and shared, so they must always come from the server
// v81: this worker stops answering for the other apps on the origin. Its scope is '/', so /terminal, /admin, /scan, /join, /legal and /unsubscribe all sat inside it, and an offline navigation to any of them was answered with the student shell
// v80: the iOS install guide's bouncing arrow moved from the middle of Safari's bottom bar to its right end — over the menu that actually holds Add to Home Screen — and the home install banner now asks for the download in as many words instead of naming the payoff
// v77: installing is a button, not a lesson — Chromium installs outright from the Home card or the Account row, iPhone gets an arrow pointing at Safari's real Share button instead of a numbered sheet, the card is permanent (dismissible for 14 days) rather than a one-off first-points nudge, and the automatic triggers now only fire where a one-tap install actually exists
// v76: the Chromium install prompt waits for the student's next tap instead of firing from a timer (Chrome refuses prompt() without a user gesture, so every automatic nudge had been a crash report that also burned a lifetime-cap slot); boot names the step when /api/public-config can't be reached, and retries it once
// v75: map pins are never translucent — the zero-balance dimming is gone and focus is a scale-up alone, so an unfocused pin is the same size and strength as its neighbours
// v74: nearby-spot notifications (migration-051) — a local showNotification when the student dwells near somewhere they've never earned, its own tag family so it can't replace an unread deal, and /?spot=<id> deep links open that spot
// v73: a printed banner's QR (/r/<code>) is passed through instead of cached, and ?qr= is stashed at boot so a signup through that poster can be credited (app.js + sw.js)
// v71: the Deal emails row only appears when the deployment can actually send mail (/api/public-config emailEnabled). A switch that cannot do anything reads as a promise.
// v68: Home's search field is gone (the Spots tab owns searching) and the heading it shared a row with is now a two-item menu — Recent spots / Recommended; addresses render title-cased with E/W/N/S for the compass words
// v66: Spots tab gained a "Pick a random spot" button under the search box — draws from shownSpots(), the same filter+search pipeline the list itself renders
// v65: the Spots filter is a sheet, not a select — the list picker now combines with cuisine and price chips (migration-042), and the chips are built from the tags the loaded spots actually carry rather than a list shipped here
// v63: the earn actions are ranked — earn code keeps a full-width row, receipt and invite share the one beneath it (receipt takes the whole row when there is no invite)
// v62: the three earn buttons are one row of icon tiles; each button's explanatory line now lives in the sheet it opens (invite's, being live state with no sheet, moved to the aria-label)
// v61: boot names the script that didn't load instead of dying on it; the boot guard recognises more engines' wording for a parse failure (app.js + boot-guard.js)
// v60: Activity filters by spot (a chip row built from the rows that arrived) and pages back 30 days at a time with "Load older"
// v59: the map entry point is a labelled "Map 🗺️" pill; a spot's screen gets a pinned "Show in map" bar that opens the map on that spot's pin
// v58: Spots tab (searchable directory + saved spots); Home carousel is Recent spots / Recommended; #vendor moved out of the tab track to an overlay so it slides in over any tab
// v51: receipt scans go through the AI reader (forgery check + extraction), tesseract as fallback
// v49: each spot shows its earn rate (card, spot screen, map pin); browser tab favicon
// v48: bundles lowered to ES2017 for old Safari; supabase-js self-hosted off the CDN; boot guard added
// v47: vendor email+password sign-in on the landing page (dual-role accounts, migration-035)
// v46: server-without-push-keys gets an honest fail note (was "reload and try again"); subscribePush guards the null key
// v45: app icons redrawn in Archivo — REWARDS in accent under the WE, thin accent border, no rule
// v44: app icons redrawn — REWARDS set under the WE
// v43: no silent enable failures (key-fetch retries, vapid-null note, sw-ready timeout, PATCH checked); load no longer re-subscribes an opted-out student
// v42: toggle-off keeps the browser subscription (unsubscribe→resubscribe race froze the switch)
// v41: a failed turn-on says why at the switch (dismissed/quieted permission prompt)
// v40: permission asked inside the gesture; switch reports only confirmed state
// v39: deals moved into the rewards hub; push subscription self-heals
// v38: push re-subscribes when the server's VAPID key has changed
// Leaflet's own images are NOT precached: the map uses divIcon pins and no layers
// control, so nothing ever requests them. The OSM tiles aren't either — they're
// cross-origin, and the fetch handler below hands those straight to the network.
// '/supabase.js' is precached now that it is served from this origin instead of
// jsDelivr (see scripts/build-client.js). It was never cacheable before: the
// fetch handler below skips cross-origin requests, so an offline launch used to
// find the shell in cache and then fail on the CDN.
const SHELL = ['/', '/boot-guard.js', '/theme-init.js', '/no-zoom.js', '/styles.css', '/supabase.js', '/app.js', '/qrcode.js', '/jsQR.js', '/leaflet/leaflet.js', '/leaflet/leaflet.css', '/install-prompt.js', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

/* Paths this worker must never answer for. It registers as '/sw.js' (app.js), so
   its scope is the WHOLE ORIGIN and every other app on we-rewards.com sits inside
   it. Online that is invisible — the fetch below is network-first, so the real page
   still arrives and the only cost is a wasted cache entry. Offline it is wrong: the
   catch falls back to caches.match('/'), which is the STUDENT shell, so a vendor
   opening the /terminal/ link in their approval email would get the student app
   sitting at a /terminal/ URL.

   /terminal, /admin and /scan each register a worker at their own, narrower scope,
   and the longest matching scope wins — but only on a device where those apps are
   installed. On a phone that has just the student app, this worker is the only one
   there is. /join, /legal and /unsubscribe ship no worker at all; the server renders
   them. Passing them through costs the student nothing: none of them is in SHELL,
   and app.js only ever reaches /legal as a target="_blank" navigation.

   The mount itself matches as well as everything under it, because server.js answers
   both '/terminal' and '/terminal/'. */
const FOREIGN = /^\/(?:terminal|admin|scan|join|legal|unsubscribe|spots|how-it-works|faq|robots\.txt|sitemap\.xml)(?:\/|$)/;

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
  // A poster QR resolve (migration-050). Two separate reasons, either one fatal:
  // a cached copy would stop the scan ever reaching the server, so the traffic
  // numbers would flatten out the moment a student installed the app — and the
  // response is a redirect, which for a navigation request arrives here as an
  // opaqueredirect that Cache.put rejects on, unhandled, below.
  if (url.pathname.startsWith('/r/')) return;
  if (FOREIGN.test(url.pathname)) return;         // another app's page, or the server's — see FOREIGN
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
  // Two kinds of notification arrive here now. A nearby-spot one (migration-051)
  // points at /?spot=<vendorId> and wants that spot's own screen; everything
  // else is a deal and wants the deals list. The message type is what tells
  // app.js which, since a focused tab is handed the target rather than being
  // navigated to it.
  let type = 'open-deals';
  try {
    if (new URL(url, self.location.origin).searchParams.get('spot')) type = 'open-spot';
  } catch { /* keep the deals default */ }
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const hit = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (hit) {
        // A focused tab won't re-navigate, so hand it the target instead and
        // let app.js open the right sheet.
        hit.postMessage({ type, url });
        return hit.focus();
      }
      return clients.openWindow(url);
    })
  );
});
