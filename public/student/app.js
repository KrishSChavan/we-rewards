/* WeRewards — student app
   Home (vendor carousel) → tap a card → vendor screen (points bar with back
   button → your earn code → rewards → item detail modal → redemption code). */

// Tells the boot guard this file parsed and is executing. Keep it the first
// statement: if the browser can't read the syntax below, nothing here runs, the
// guard's timer finds this uncalled and replaces the stuck splash with an
// explanation instead of leaving it spinning. See public/shared/boot-guard.js.
if (window.__wrBooted) window.__wrBooted();

let sb = null;
let allVendors = [];  // every active vendor + this student's balance at each
// What the carousel is actually showing: allVendors when the search box is
// empty, otherwise the matches in rank order. Everything that pages the row —
// the dots, the snap offsets, the "single" class — counts THIS list, never
// allVendors; the lookups-by-id keep using allVendors, because a spot you have
// filtered out of view is still a spot you have points at.
let shownVendors = [];
// Which list the home carousel is showing, when the student has said. null is
// the normal state and means "whatever the data says" — recent spots if there
// are any, recommendations if there are not. Deliberately in memory only, and
// deliberately NOT persisted: it is a way of looking at the row, not a setting,
// the same call spotsFilter makes and for the same reason.
let homeLens = null;        // null | 'recent' | 'recommended'
// Card elements survive filtering, keyed by vendor id. Re-rendering the row
// from HTML on every keystroke would rebuild every card's 4-tile map mosaic —
// 120 <img> for 30 spots — so cards are built once and MOVED instead.
const vendorCards = new Map();
let vendor = null;    // the vendor whose screen is currently open (null on home)
let balance = 0;
let myCodeTimer = null;     // home-screen earn-code refresh loop
let redeemCountdown = null; // redemption-code modal countdown
let selectedItem = null;
let socket = null;          // socket.io connection for live balance pushes
let currentToken = null;    // latest Supabase access token (socket auth)
let balanceReady = false;   // first balance shown yet? (skip the ticker on load)
let communityPoints = 0;    // cross-vendor wallet (see community-points.md)
let communityReady = false; // first community count shown yet? (same reason)
const tickRaf = new WeakMap(); // per-element requestAnimationFrame id for the counting ticker
let toastTimer = null;
let activeTab = 0;          // index into TABS (see there)
let vendorOrigin = 0;       // which tab the open vendor screen was entered from
let historyLoaded = false;  // has the history tab fetched at least once?
let paneSlide = null;       // the in-flight #home <-> #vendor slide, so it can be cut short
let justSignedIn = false;         // true between a Google sign-in and the consent check
let pendingDealLink = null;       // a ?deal=/?deals= notification tap, held until the app is ready
// Consent-gate state (the gate itself is far below, see ensureConsent). It is
// declared up here with the rest of the module's state rather than beside the
// feature because Splash.giveUp() reads consentChecking, and boot() can call
// that synchronously while this file is still evaluating — a `let` declared
// below the boot IIFE would be in its temporal dead zone at that moment and
// throw a ReferenceError out of the very path that exists to handle failure.
let consentOk = false;            // server confirmed agreement to the CURRENT version
let consentChecking = false;      // in-flight guard: auth events can fire in bursts
let consentIsRevision = false;
// Carousel page dots (see renderVendorDots). The window is at most DOT_CAP wide;
// dotStart is its first index, so the row only ever holds DOT_CAP buttons however
// many spots there are.
let dotStart = 0;           // first vendor index shown in the dot window
let dotActive = 0;          // vendor index the carousel is parked on
let dotSnaps = [];          // scrollLeft each card snaps to; [] = needs measuring
let dotsRaf = 0;            // pending sync frame, cancelled on rebuild (cf. tickRaf)
let dotJump = null;         // index a tapped-dot scroll is flying toward, or null
let dotJumpTimer = null;    // backstop for browsers without scrollend
let dotJumpAbort = null;    // drops that jump's listeners in one go, however it ends

const $ = (id) => document.getElementById(id);

// The PWA install nudge — deferred-prompt capture, platform routing, suppression
// rules, the 5 trigger points, and its funnel analytics — lives in
// install-prompt.js → window.InstallPrompt. This file only calls its trigger
// methods at the right moments (redemption / points earned / app open / manual).

/* ---------- client crash reporting ---------- */
// Uncaught errors + promise rejections post to /api/client-error so they land in
// the same error log the operator /admin dashboard reads. Best-effort: attaches
// the auth token if we have a session, never blocks, never throws.
// What the app was doing when it crashed, so /admin shows more than a line
// number: which tab was open, installed-vs-browser, and whether the phone was
// even online. Never allowed to throw — it runs inside the error handler, and a
// failure here would swallow the report it was decorating.
/* ---------- the tab registry ----------
   ONE source of truth for tab order. This used to be three independent
   positional systems that all had to be edited together — a names array for
   crash reports, a `data-tab` attribute the nav's click handler read, and the
   button's DOM index, which setTab used to paint the active state. Adding a tab
   between two existing ones desynced them silently: taps routed to one page
   while the highlight lit a different button.

   TABS is now the order, TAB is the lookup, and NOTHING below may compare
   activeTab against a bare number. The `if (i === 1) loadHistory()` that used
   to sit at the foot of setTab is exactly the bug this prevents: inserting a
   tab ahead of History would not have made History load late, it would have
   stopped History loading at all — historyLoaded is only ever set inside
   loadHistory(), and both background refreshers are gated on it, so the tab
   would have sat on its skeleton forever with no error and no empty state.

   Keep in step with the .tab-btn order in index.html; the data-tab attributes
   are asserted against this at boot (see wireTabs). */
const TABS = ['home', 'spots', 'history', 'account'];
const TAB = Object.fromEntries(TABS.map((name, i) => [name, i]));

// Kept for the crash reporter, which wants a name for whatever tab was open.
const TAB_NAMES = TABS;

function crashContext(extra) {
  const ctx = { ...extra };
  try {
    ctx.tab = TAB_NAMES[activeTab] ?? String(activeTab);
    ctx.installed = window.matchMedia?.('(display-mode: standalone)')?.matches === true
      || window.navigator.standalone === true;
    ctx.online = navigator.onLine;
    ctx.viewport = `${window.innerWidth}x${window.innerHeight}`;
  } catch { /* report what we have */ }
  return ctx;
}

// Module scope rather than a closure inside installErrorReporter(), because
// boot() files one of these by hand when it finds a script missing (see there).
async function reportClientError(message, stack, context) {
  let auth = {};
  try {
    const { data } = (await sb?.auth?.getSession?.()) ?? {};
    if (data?.session) auth = { Authorization: `Bearer ${data.session.access_token}` };
  } catch { /* not signed in yet */ }
  fetch('/api/client-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ source: 'student', message, stack, url: location.pathname, context: crashContext(context) }),
  }).catch(() => {});
}

// An error thrown inside a CROSS-ORIGIN script reaches this handler stripped to
// the bare string "Script error." with line 0, column 0 and no `error` object:
// browsers will not leak another origin's source, and there is no way to opt
// back in from this side. Every script this page loads is same-origin (see the
// block at the foot of index.html), so one of these is never our code — it is a
// content blocker, a Safari extension, or an in-app browser's injected wrapper
// throwing in its own script. The report would carry no message, no file, no
// line and no stack, which in /admin is a row that can only ever be read and
// closed again, so it is dropped instead of filed.
//
// If our own bundles ever move to another origin (a CDN host), their real
// errors would start arriving looking exactly like this — the fix then is
// crossorigin="anonymous" on the tags plus Access-Control-Allow-Origin on the
// responses, NOT loosening the test below.
const isOpaqueCrossOriginError = (e) => /^script error\.?$/i.test(e.message || '') && !e.error;

function installErrorReporter() {
  window.addEventListener('error', (e) => {
    if (isOpaqueCrossOriginError(e)) return;
    reportClientError(e.message || 'error', e.error?.stack, { line: e.lineno, col: e.colno });
  });
  window.addEventListener('unhandledrejection', (e) => reportClientError(String(e.reason?.message || e.reason || 'unhandledrejection'), e.reason?.stack));
}

/* ---------- install-funnel analytics ---------- */
// Best-effort → /api/client-event. Same posture as the crash reporter: attaches
// the auth token when we have a session, never blocks, never throws. keepalive
// so an event fired as the page unloads (e.g. a dismissal) still sends.
function track(event, props) {
  (async () => {
    let auth = {};
    try {
      const { data } = (await sb?.auth?.getSession?.()) ?? {};
      if (data?.session) auth = { Authorization: `Bearer ${data.session.access_token}` };
    } catch { /* not signed in yet — event posts anonymously */ }
    fetch('/api/client-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ source: 'student', event, trigger: props?.trigger, props, url: location.pathname }),
      keepalive: true,
    }).catch(() => {});
  })();
}

/* ---------- boot splash ---------- */
// index.html paints #splash before any script runs, so the first frame is
// branded rather than the bare paper page you'd otherwise get while both
// #landing and #app are still hidden. It comes down at exactly one moment: when
// render() (or the consent gate) has settled which screen this visitor belongs
// on. That ordering is the point — hiding it any earlier would flash the landing
// page at someone whose stored session was about to sign them straight in.
const Splash = (() => {
  const MIN_MS = 500;    // a splash that blinks past in 80ms reads as a glitch, not a load
  const MAX_MS = 9000;   // backstop, see armBackstop
  const shownAt = Date.now();
  let leaving = false;
  let backstop = null;

  function hide() {
    const el = $('splash');
    if (leaving || !el) return;   // render() runs again on every token refresh
    leaving = true;
    clearTimeout(backstop);
    setTimeout(() => {
      el.classList.add('is-hiding');
      // Remove it rather than leave a transparent full-screen layer parked over
      // the app, which would swallow every tap. Longer than the 0.55s slide.
      setTimeout(() => el.remove(), 700);
    }, Math.max(0, MIN_MS - (Date.now() - shownAt)));
  }

  // If boot() dies before render() ever runs — /api/public-config down, a
  // vendored script that never arrived — nothing would ever call hide() and the
  // splash would sit there for good. Fall back to the landing page carrying the
  // same message a failed consent check shows.
  function giveUp() {
    if (leaving) return;
    $('landing').hidden = false;
    // A consent check still in flight isn't a failure, just a slow one, and it
    // ends by calling render() itself. Uncover it without claiming it broke.
    if (!consentChecking) {
      $('auth-error').textContent = 'Couldn’t reach WeRewards. Check your connection and try again.';
      $('auth-error').hidden = false;
    }
    hide();
  }

  function armBackstop() {
    backstop = setTimeout(giveUp, MAX_MS);
  }

  // giveUp is exported so boot() can take this exit the moment it KNOWS it can't
  // continue, rather than leaving the student watching the splash for the rest
  // of MAX_MS. Same screen either way, so the two can't drift apart.
  return { hide, armBackstop, giveUp };
})();

/* ---------- boot ---------- */

// The globals boot() dereferences without asking first, and the <script> at the
// foot of index.html that defines each. Only these two: the other vendored
// libraries (qrcode, jsQR, Leaflet, socket.io) are reached lazily from a screen
// that opens later, and drawMockQr already drops its block when the encoder
// isn't there. Aborting the whole app because the map library is missing would
// be worse than the missing map.
const BOOT_SCRIPTS = { supabase: '/supabase.js', InstallPrompt: '/install-prompt.js' };

(async function boot() {
  installErrorReporter();
  Splash.armBackstop();            // nothing below this may leave the splash up forever

  // Each <script> on the page is its own fetch, and any one of them can go
  // missing: a dropped connection, a 5xx from the dyno, an extension that
  // blocks it, or a crawler's renderer deciding it has fetched enough for one
  // page (Googlebot does exactly this, which is where the reports of
  // "Cannot read properties of undefined (reading 'createClient')" came from).
  // The global is then simply absent, and the first line below that touches it
  // throws a TypeError naming app.js and never naming the file that actually
  // went missing. Ask up front instead: the log gets the filename, and the
  // student gets the try-again screen now rather than after the 9s backstop.
  const missing = Object.entries(BOOT_SCRIPTS).filter(([g]) => !window[g]).map(([, file]) => file);
  if (missing.length) {
    reportClientError(`boot aborted: ${missing.join(', ')} did not load`);
    Splash.giveUp();
    return;
  }
  capturePunchLink();              // stash a camera-scanned ?punch= link BEFORE anything can navigate it away
  captureReferralLink();           // same, for a friend's ?ref= invite link
  pendingDealLink = captureDealLink();   // same, for a ?deal=/?deals= notification tap
  drawMockQr();                    // landing hero card — paint it before any await, so a slow/failed config fetch never leaves it blank
  InstallPrompt.init({ track });   // capture the deferred prompt + fire pwa_launched if standalone
  const pub = await (await fetch('/api/public-config')).json();
  // Student + vendor apps share this origin and Supabase project, so they MUST
  // use separate auth storage keys — otherwise signing into the vendor terminal
  // overwrites the student's session (and the student then reads the vendor's
  // empty balances as 0). See the vendor terminal's matching 'psu-vendor-auth'.
  sb = window.supabase.createClient(pub.supabaseUrl, pub.supabaseAnonKey, {
    auth: { storageKey: 'psu-student-auth' },
  });

  // A camera-scanned punch link dies in ~90s, but sign-in takes minutes — swap
  // the token for a 10-minute hold right away (no auth needed), then claim it
  // once the session is ready. Fire-and-forget; claiming retries the pieces.
  syncPendingPunchNote();
  showSignupBonusNote(pub.signupBonus);   // must be read BEFORE the account chooser opens
  void securePendingPunchHold();

  document.querySelectorAll('[data-signin]').forEach((b) => b.addEventListener('click', signInWithGoogle));
  // Vendor path: same auth pool, password credentials (the terminal login).
  $('vendor-signin-toggle').addEventListener('click', () => {
    const form = $('vendor-signin');
    form.hidden = !form.hidden;
    if (!form.hidden) $('vendor-signin-email').focus();
  });
  $('vendor-signin').addEventListener('submit', signInWithPassword);
  $('invite-btn').addEventListener('click', shareInvite);
  $('account-signout').addEventListener('click', async () => {
    await sb.auth.signOut();
    render(null);
  });
  // account → your data: export + delete
  $('account-export').addEventListener('click', exportMyData);
  $('account-delete').addEventListener('click', openDeleteModal);
  $('delete-cancel').addEventListener('click', closeDeleteModal);
  $('delete-close').addEventListener('click', closeDeleteModal);
  $('delete-confirm').addEventListener('click', confirmDelete);
  $('delete-modal').addEventListener('click', (e) => { if (e.target === $('delete-modal')) closeDeleteModal(); });
  // Consent gate. No ✕ and no backdrop-to-dismiss on purpose: Agree or Decline
  // are the only exits, so a stray tap can't skip the gate or delete an account.
  $('consent-terms').addEventListener('change', syncConsentButton);
  $('consent-accept').addEventListener('click', acceptConsent);
  $('consent-decline').addEventListener('click', declineConsent);
  // bottom nav: slide between Home / History / Account
  $('tabbar').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tab = Number(btn.dataset.tab);
    // Home tapped while drilled into a spot's redeem screen → return to the
    // carousel with a leftward slide, rather than re-selecting the open tab.
    // Asking for Home explicitly overrides where the spot was opened from: the
    // student pressed Home, so Home is the destination even if they arrived
    // from Spots.
    if (tab === TAB.home && !$('vendor').hidden) {
      vendorOrigin = TAB.home;
      if (activeTab === TAB.home) backToHomeSlide();   // on screen: animate the slide
      else { backToHome(); setTab(TAB.home); }         // off screen: reset, then slide the tab in
      return;
    }
    // Tapping any OTHER tab while a spot is open leaves the drill-in mounted
    // behind Home. Tear it down on the way out, so coming back to Home lands on
    // the carousel rather than on a spot the student had already left.
    if (tab !== TAB.home && !$('vendor').hidden) backToHome();
    setTab(tab);
  });
  wireSpots();      // the Spots tab's search field, rows, and hearts
  wireHistory();    // …the Activity tab's spot chips and its Load older button
  wireTabSwipe();   // …and the four tabs by dragging the track itself
  wireVendorSwipe(); // …and a rightward drag on the vendor screen backs out to Home
  // appearance: dark-mode toggle (the <head> script already applied the theme)
  applyTheme(currentTheme());
  $('dark-toggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    setTheme(next);
  });
  $('vendor-carousel').addEventListener('click', onVendorTap);
  // Page dots under the carousel. #vendor-carousel and #vendor-dots are stable
  // elements — only their children are replaced — so these bind exactly once.
  $('vendor-carousel').addEventListener('scroll', onCarouselScroll, { passive: true });
  $('vendor-dots').addEventListener('click', onDotTap);
  window.addEventListener('resize', () => {
    dotSnaps = [];        // card widths changed; re-measure lazily
    // The height changed too, and in mobile Safari this is the ONLY signal that
    // it did: showing and hiding the URL bar resizes the window without any
    // other event. Two layout reads, so it is cheap enough to run inline.
    syncHomeDensity();
  });
  // install-prompt.js is a separate ES5 IIFE with no import of its own; it calls
  // this by name when the nudge opens or closes, since either changes the home
  // screen's height by a whole block.
  window.syncHomeDensity = syncHomeDensity;
  // Which spots the row shows. Same story as the two above: the heading is a
  // stable element that is only relabelled, never replaced, so this binds once.
  $('home-sub').addEventListener('click', toggleHomeLensMenu);
  // Delegated to the menu, not bound per item: the items are static markup, and
  // this way the data-lens attribute stays the only thing that maps a row to a
  // mode.
  $('home-lens-menu').addEventListener('click', (e) => {
    const item = e.target.closest('.home-lens-item');
    if (item) pickHomeLens(item.dataset.lens);
  });
  // Anything outside the menu closes it. Capture, so a tap that also does
  // something else (a card, the Map pill) still puts the menu away first.
  document.addEventListener('pointerdown', (e) => {
    if ($('home-lens-menu').hidden) return;
    if (e.target.closest('#home-lens-menu') || e.target.closest('#home-sub')) return;
    closeHomeLensMenu();
  }, true);
  // spots map: the 🗺️ opens every pin; a card's map thumbnail opens it focused
  // on that one (see onVendorTap). ✕ / Esc close it, and Esc puts the pin sheet
  // away first if one is up.
  $('map-open-btn').addEventListener('click', () => openMapScreen(null));
  // Same screen from inside a spot, focused on the spot you are standing in.
  $('vendor-map-btn').addEventListener('click', onShowVendorInMap);
  $('map-close').addEventListener('click', closeMapScreen);
  $('map-locate').addEventListener('click', onMapLocateTap);
  $('map-pin-close').addEventListener('click', () => closePinSheet());
  $('map-pin-open').addEventListener('click', onMapPinOpenVendor);
  $('map-pin-dir').addEventListener('click', onMapPinDirections);
  // Info popovers: the tier (i) opens on its button; the community explainer
  // closes like every popover but no longer opens on the card itself — with a
  // balance the card opens the Move-points sheet instead (community-points.md
  // step 5), and only an empty wallet gets the explainer, because a new user's
  // first tap should say what this is, not show an empty picker.
  wireInfo('tier-info', 'tier-info-btn');
  // rewards hub: the wordmark pill opens it; the header row, the dimmed page,
  // a flick up on the header, or Esc close it
  $('hub-toggle').addEventListener('click', openHub);
  $('hub-collapse').addEventListener('click', onHubToggleTap);
  $('hub-modal').addEventListener('click', (e) => { if (e.target === $('hub-modal')) closeHub(); });
  $('hub-collapse').addEventListener('pointerdown', onHubDragStart);
  $('hub-collapse').addEventListener('pointermove', onHubDragMove);
  $('hub-collapse').addEventListener('pointerup', onHubDragEnd);
  $('hub-collapse').addEventListener('pointercancel', onHubDragEnd);
  $('community-card').addEventListener('click', onCommunityCardTap);
  $('community-info-close').addEventListener('click', () => closeInfo('community-info', 'community-card'));
  $('community-info').addEventListener('click', (e) => { if (e.target === $('community-info')) closeInfo('community-info', 'community-card'); });
  // move-points sheet: picker + amount, then a one-way confirm
  $('move-close').addEventListener('click', closeMoveSheet);
  $('move-modal').addEventListener('click', (e) => { if (e.target === $('move-modal')) closeMoveSheet(); });
  $('move-whatis').addEventListener('click', () => { closeMoveSheet(); openInfo('community-info', 'community-card'); });
  $('move-vendors').addEventListener('click', onMoveVendorTap);
  $('move-amount').addEventListener('input', syncMoveContinue);
  $('move-max').addEventListener('click', () => { $('move-amount').value = communityPoints; syncMoveContinue(); });
  $('move-continue').addEventListener('click', showMoveConfirm);
  $('move-back').addEventListener('click', showMovePick);
  $('move-confirm').addEventListener('click', submitMove);
  // add-to-home-screen: the permanent manual entry point (settings) + the dev
  // reset. The sheet's own buttons are wired inside install-prompt.js.
  $('account-install').addEventListener('click', () => InstallPrompt.openManual());
  $('account-install-reset').addEventListener('click', () => { InstallPrompt.reset(); syncInstallRow(); });
  window.addEventListener('appinstalled', syncInstallRow);   // drop the row the moment it's installed
  // Back arrow: returns to whichever tab the spot was opened from, animating
  // only when that is Home (see exitVendor).
  $('back-btn').addEventListener('click', () => exitVendor(true));
  $('items').addEventListener('click', onItemTap);
  $('item-close').addEventListener('click', closeItemModal);
  $('item-redeem').addEventListener('click', () => onRedeemTap('points'));
  $('item-redeem-visits').addEventListener('click', () => onRedeemTap('visits'));
  $('item-modal').addEventListener('click', (e) => { if (e.target === $('item-modal')) closeItemModal(); });
  // visits: the vendor-page counter opens the progress sheet; the bottom
  // button opens the full-screen scanner
  $('punch-card-btn').addEventListener('click', openPunchModal);
  $('punch-close').addEventListener('click', closePunchModal);
  $('punch-modal').addEventListener('click', (e) => { if (e.target === $('punch-modal')) closePunchModal(); });
  $('punch-scan-btn').addEventListener('click', openPunchScanSheet);
  $('punch-scan-close').addEventListener('click', closePunchScanSheet);
  $('punch-scan-modal').addEventListener('click', (e) => { if (e.target === $('punch-scan-modal')) closePunchScanSheet(); });
  // deals: the home card opens the sheet; ✕ / backdrop / Esc close it
  $('deals-card').addEventListener('click', () => openDealsSheet());
  $('deals-close').addEventListener('click', closeDealsSheet);
  $('deals-modal').addEventListener('click', (e) => { if (e.target === $('deals-modal')) closeDealsSheet(); });
  $('deals-optin-yes').addEventListener('click', enableDealAlerts);
  $('deals-optin-no').addEventListener('click', dismissDealOptin);
  $('deals-alert-retry').addEventListener('click', retryPushSubscribe);
  $('deals-toggle').addEventListener('click', onDealsToggle);
  // never leave the punch camera running while the tab is backgrounded
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPunchScanner();
    else if ($('punch-scan-modal').classList.contains('is-open')) startPunchScanner();
    // Tell the server whether we're in the foreground, so the campaign worker
    // can spend a notification on someone who actually needs one.
    reportVisibility();
    // Coming back from the background is also when a deal may have landed
    // while we were away.
    if (!document.hidden && dealsLoaded) loadDeals();
  });
  // receipt: photo → server OCR → points. The hidden file input is the actual
  // picker; "take or choose" and "use a different photo" both just click it.
  $('scan-receipt-btn').addEventListener('click', openReceiptSheet);
  $('receipt-close').addEventListener('click', closeReceiptSheet);
  $('receipt-modal').addEventListener('click', (e) => { if (e.target === $('receipt-modal')) closeReceiptSheet(); });
  $('receipt-pick').addEventListener('click', () => $('receipt-file').click());
  $('receipt-retake').addEventListener('click', () => $('receipt-file').click());
  $('receipt-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';            // re-picking the same file must re-fire change
    onReceiptFile(file);
  });
  $('receipt-submit').addEventListener('click', submitReceipt);
  $('receipt-done').addEventListener('click', closeReceiptSheet);
  // earn code: the home button opens the full-screen sheet; ✕ / drag / Esc close it
  $('show-code-btn').addEventListener('click', openEarnSheet);
  $('earn-close').addEventListener('click', closeEarnSheet);
  // the sheet no longer fills the screen, so the dimmed strip above it is a
  // tap-to-dismiss target like every other overlay here
  $('earn-modal').addEventListener('click', (e) => { if (e.target === $('earn-modal')) closeEarnSheet(); });
  $('earn-grab').addEventListener('pointerdown', onEarnDragStart);
  $('earn-grab').addEventListener('pointermove', onEarnDragMove);
  $('earn-grab').addEventListener('pointerup', onEarnDragEnd);
  $('earn-grab').addEventListener('pointercancel', onEarnDragEnd);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // The map screen covers everything under it, so while it is up it owns Esc
    // outright — otherwise one press would also close sheets the student can't
    // even see, and they'd come back to Home with the hub collapsed.
    if (!$('map-modal').hidden) { onMapEscape(); return; }
    // Before the sheets: the lens menu is the shallowest thing on screen, and a
    // press that closed a sheet *and* this would be one press doing two jobs.
    if (!$('home-lens-menu').hidden) { closeHomeLensMenu(); return; }
    closeEarnSheet();
    closeReceiptSheet();
    closeDealsSheet();
    closeMoveSheet();
    closeFilterSheet();
    closePickSheet();
    closePunchScanSheet();
    closePunchModal();
    closeInfo('tier-info', 'tier-info-btn');
    closeInfo('community-info', 'community-card');
    closeHub();
  });

  sb.auth.onAuthStateChange((event, session) => {
    // SIGNED_IN fires when supabase-js consumes the OAuth redirect — i.e. they
    // just picked a Google account. INITIAL_SESSION fires for a session restored
    // from storage on page load. The consent gate only prompts on the former, so
    // a stored session that never cleared the gate is signed out instead of
    // being ambushed with a modal on load.
    if (event === 'SIGNED_IN') justSignedIn = true;
    if (event === 'SIGNED_OUT') justSignedIn = false;
    currentToken = session?.access_token ?? null;   // keep the socket's token fresh
    render(session);
  });

  const { data } = await sb.auth.getSession();
  currentToken = data?.session?.access_token ?? null;
  render(data?.session ?? null);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    // Tapping a deal notification when a tab is already open focuses that tab
    // rather than navigating it, so the worker hands us the target instead.
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type !== 'open-deals') return;
      const id = readDealParam(e.data.url);
      openDealsSheet(id);
    });
  }
})();

/* Deep links from a notification: /?deals=1 opens the list, /?deal=<id> opens
   it with that campaign pulled to the top. Read once and stripped from the URL
   so a reload (or the OAuth round-trip) doesn't reopen the sheet forever. */
function readDealParam(href) {
  try {
    const u = new URL(href, location.origin);
    return u.searchParams.get('deal') || null;
  } catch { return null; }
}

function captureDealLink() {
  try {
    const params = new URLSearchParams(location.search);
    const id = params.get('deal');
    const all = params.get('deals');
    if (!id && !all) return null;
    params.delete('deal');
    params.delete('deals');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
    return { id: id || null };
  } catch { return null; }
}

async function signInWithGoogle() {
  $('auth-error').hidden = true;
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) {
    $('auth-error').textContent = 'Couldn’t start sign-in. Try again in a moment.';
    $('auth-error').hidden = false;
  }
}

// Vendor accounts are password-based (created by the /join application flow)
// and live in the same Supabase auth pool as students, so a vendor's email
// works on both apps: here it starts a normal student session (consent gate and
// all), while the terminal keeps its own separate 'psu-vendor-auth' session.
async function signInWithPassword(e) {
  e.preventDefault();
  $('auth-error').hidden = true;
  const email = $('vendor-signin-email').value.trim();
  const password = $('vendor-signin-password').value;
  if (!email || !password) return;
  const btn = $('vendor-signin-go');
  btn.disabled = true;
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      $('auth-error').textContent = 'Wrong email or password. Vendors use the same login as the terminal.';
      $('auth-error').hidden = false;
      return;
    }
    // Success: onAuthStateChange takes it from here (consent check → app).
    $('vendor-signin-password').value = '';
  } catch {
    $('auth-error').textContent = 'No connection. Try again in a moment.';
    $('auth-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function render(session) {
  const wasSignedOut = $('app').hidden;
  // Signed in is not enough — the app shell stays hidden until the server
  // confirms current consent, so an unconsented user never sees the UI (and the
  // data loaders below never fire, which would just 403 anyway).
  const ready = !!session && consentOk;
  // Landing stays up until the app is genuinely usable, so the consent check and
  // the modal have a backdrop instead of a blank screen on a slow connection.
  $('landing').hidden = ready;
  $('app').hidden = !ready;
  // Nothing inside #app has a height until this line runs, so the first fit
  // decision has to be taken after it — renderVendors() may well have already
  // run against a shell that measured zero.
  if (ready) syncHomeDensity();

  if (!session) {
    Splash.hide();              // settled: this visitor gets the landing page
    // A drill-in still mid-slide would settle over the landing page behind us.
    closeVendorPane(false);     // park the spot screen instantly — no animation on sign-out
    dropSwipe();                // a finger still down would keep writing --tab over the reset
    vendorOrigin = TAB.home;    // …and the return tab, or the next student inherits it
    setTab(TAB.home, false);
    stopMyCode();
    disconnectSocket();
    balanceReady = false;   // re-login should show the balance instantly, no ticker
    communityPoints = 0;
    communityReady = false; // same: the next sign-in paints its count, no ticker
    $('community-balance').textContent = '0';   // on-screen, so it has to be cleared
    showCommunityAmount(false); // …and back behind its placeholder, or the next student reads that 0 as theirs
    resetTier();            // …as is the tier chip on the pill above it
    allVendors = [];
    resetVendorRow();           // …and unpaint the cards, or the next student reads them
    resetSpots();               // …and the directory, which carries their saved spots
    vendor = null;
    historyLoaded = false;
    dropHistory();              // …and unpaint the rows, or the next student reads them
    consentOk = false;          // next sign-in re-checks; never trust a stale pass
    hideConsentModal();
    dropEarnSheet();            // it lives at body level, so it would otherwise sit over the landing page
    dropHub();                  // same
    dropMoveSheet();            // same
    dropReceiptSheet();         // same, and it may hold a photo preview the next student must not see
    dropPunchScanSheet();       // same (and it holds the camera)
    dropPunchModal();           // same
    dropDealsSheet();           // same, and the next student must not read these
    dropItemModal();            // same, and it can be holding a live redemption QR
    dropMapScreen();            // same, and it must not leave a location dot up for the next student
    syncPendingPunchNote();     // landing may need the "punch spotted" note
    // the popovers live at body level too — same reason
    closeInfo('tier-info', 'tier-info-btn');
    closeInfo('community-info', 'community-card');
    InstallPrompt.clearUser();  // stop keying install suppression to the signed-out user
    return;
  }

  // Signed in but unverified: ask the server, then this function runs again.
  // The splash stays up through that round trip on purpose — it's the same
  // "still deciding" state as the session check itself, and dropping it here
  // would show the landing page to someone who is already signed in.
  if (!ready) {
    void ensureConsent(session);
    return;
  }
  Splash.hide();                // settled: this visitor gets the app shell
  // A fresh sign-in lands on the Home tab, carousel view. onAuthStateChange also
  // fires on silent token refreshes — those must NOT yank the user off a vendor
  // screen or their current tab, so only reset when the app was hidden.
  if (wasSignedOut) {
    closeVendorPane(false);    // a fresh sign-in always lands on a tab, never on a spot
    vendorOrigin = TAB.home;   // never inherit the previous user's return tab
    setTab(TAB.home, false);
    // App just opened for this user: key install suppression to them + count the
    // session, then let trigger 3 (third session) fire once the shell is up.
    InstallPrompt.setUser(session.user.id);
    InstallPrompt.onAppReady();
    syncInstallRow();
  }
  fillAccount(session);
  loadVendors();
  loadTier();
  loadCommunity();
  const dealsReady = loadDeals();
  startMyCode();
  connectSocket();
  void claimPendingPunch();   // a camera-scanned punch waiting through sign-in lands now
  void claimPendingReferral().then(loadReferral);   // an invite link that waited through sign-in, then the share card

  // A notification tap that had to go through sign-in first opens its sheet
  // once the list has actually loaded, so it never flashes the empty state on
  // the way in.
  if (pendingDealLink) {
    const { id } = pendingDealLink;
    pendingDealLink = null;
    dealsReady.then(() => openDealsSheet(id));
  }
}

/* ---------- add-to-home-screen: account entry point (trigger 5) ----------
   The prompt logic itself lives in install-prompt.js. Here we only keep the
   permanent manual row in sync: show it whenever the app isn't installed (never
   gated by cooldown), plus a dev-only reset for re-testing the prompts. */
function syncInstallRow() {
  const installed = InstallPrompt.isInstalled();
  const isDev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  $('account-install').hidden = installed;
  $('account-install-reset').hidden = !isDev;
  $('account-app-title').hidden = installed && !isDev;   // hide the header only if the section is empty
}

/* ---------- appearance: theme ---------- */

const THEME_KEY = 'psu-theme';

// an explicit saved choice wins; otherwise default to dark
function currentTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0f1826' : '#12294b');
  $('dark-toggle').setAttribute('aria-checked', theme === 'dark' ? 'true' : 'false');
}

function setTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}

/* ---------- account tab: profile card ---------- */

function fillAccount(session) {
  const user = session?.user;
  const meta = user?.user_metadata ?? {};
  const email = user?.email ?? meta.email ?? '';
  const name = meta.full_name ?? meta.name ?? '';
  const avatar = meta.avatar_url ?? meta.picture ?? '';

  $('account-email').textContent = email || '';
  $('account-name').textContent = name;
  $('account-name').hidden = !name;
  setAvatar(avatar, name || email);
}

// Show the Google avatar; fall back to the first initial if it's missing/blocked.
function setAvatar(url, seed) {
  const img = $('account-avatar');
  const fb = $('account-avatar-fallback');
  fb.textContent = (seed || '?').trim().charAt(0).toUpperCase() || '?';
  if (url) {
    img.onload = () => { img.hidden = false; fb.hidden = true; };
    img.onerror = () => { img.hidden = true; fb.hidden = false; };
    img.src = url;
  } else {
    img.hidden = true;
    fb.hidden = false;
  }
}

/* ---------- account tab: export + delete my data ---------- */

// Download everything the server holds about this student as a JSON file.
async function exportMyData() {
  const btn = $('account-export');
  const name = btn.querySelector('.data-btn-name');
  const label = name.textContent;
  btn.disabled = true;
  name.textContent = 'Preparing…';
  try {
    const res = await authFetch('/api/me/export');
    if (!res.ok) throw new Error();
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'werewards-data.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    name.textContent = 'Downloaded ✓';
  } catch {
    name.textContent = 'Couldn’t download, try again';
  } finally {
    btn.disabled = false;
    setTimeout(() => { name.textContent = label; }, 2200);
  }
}

/* ---------- consent gate ----------
   Google OAuth signs someone in, but it does not make them a WeRewards user:
   since migration-022 the server creates the profile only when they accept the
   Terms + Privacy Policy. Until then every /api/me service route answers 403
   CONSENT_REQUIRED, so this modal isn't the security boundary — it's the way to
   satisfy one. Declining deletes the auth user, leaving nothing behind. */

// consentOk / consentChecking / consentIsRevision are declared with the rest of
// the module state at the top of this file, not here — see the note there.

async function ensureConsent(session) {
  if (consentChecking) return;
  consentChecking = true;
  try {
    const res = await authFetch('/api/me/consent');
    if (!res.ok) throw new Error('consent check failed');
    const info = await res.json();

    if (info.accepted) {
      consentOk = true;
      hideConsentModal();
      render(session);        // re-entry: this time `ready` is true
      return;
    }

    // A revision: they have a real account with points, so prompt wherever they
    // are — silently signing out someone mid-use to re-accept would be worse.
    if (info.isRevision) {
      openConsentModal(info);
      return;
    }

    // Fresh sign-in: they just picked a Google account and it has no agreement
    // on record. This is the gate. Their profile stays hidden behind it.
    if (justSignedIn) {
      openConsentModal(info);
      return;
    }

    // Otherwise this is a stored session from a previous visit that never got
    // past the gate. Prompting here would ambush them on page load, and the
    // session is unusable anyway — drop it and show the landing screen.
    await sb.auth.signOut();
    render(null);
  } catch {
    // Can't confirm consent, so we can't let them in — but don't destroy the
    // session over a dropped connection. Drop back to the landing screen; a
    // retry or reload runs the check again.
    hideConsentModal();
    $('app').hidden = true;
    $('landing').hidden = false;
    $('auth-error').textContent = 'Couldn’t reach WeRewards. Check your connection and try again.';
    $('auth-error').hidden = false;
    Splash.hide();   // settled, badly — but they must see the error, not a spinner
  } finally {
    consentChecking = false;
  }
}

function openConsentModal(info) {
  // The gate is the answer for this visitor, so the splash has to come down —
  // it outranks every overlay in the stylesheet and would bury the modal.
  Splash.hide();
  consentIsRevision = Boolean(info?.isRevision);

  // Someone re-consenting after a revision already has an account and points,
  // so both the ask and the cost of declining are different.
  if (consentIsRevision) {
    $('consent-title').textContent = 'We’ve updated our terms';
    $('consent-desc').textContent =
      'Our Terms of Service and Privacy Policy have changed since you last agreed. Please review them and accept to keep using WeRewards.';
    $('consent-accept').textContent = 'Agree & continue';
    $('consent-decline').textContent = 'Decline and delete my account';
    $('consent-decline-note').textContent =
      'Declining deletes your account and your points. You can download your data first from the Account tab.';
  } else {
    $('consent-title').textContent = 'One quick thing';
    $('consent-desc').textContent =
      'Before we set up your account, please read and agree to the two documents below. They open in a new tab, so you won’t lose your place.';
    $('consent-accept').textContent = 'Agree & create my account';
    $('consent-decline').textContent = 'No thanks';
    $('consent-decline-note').textContent =
      'Choosing “No thanks” signs you out and no account is created.';
  }

  $('consent-terms').checked = false;
  $('consent-error').hidden = true;
  syncConsentButton();

  const ov = $('consent-modal');
  ov.hidden = false;
  void ov.offsetWidth;                 // reflow so the slide-up transition runs
  ov.classList.add('is-open');
}

function hideConsentModal() {
  const ov = $('consent-modal');
  if (ov.hidden || !ov.classList.contains('is-open')) { ov.hidden = true; return; }
  ov.classList.remove('is-open');
  setTimeout(() => { ov.hidden = true; }, 360);   // wait out the slide-down
}

// The 18+ requirement is a representation in ToS §2, not a separate tick — one
// box, covering both documents. The server enforces the same single rule.
function syncConsentButton() {
  $('consent-accept').disabled = !$('consent-terms').checked;
}

async function acceptConsent() {
  const { data } = await sb.auth.getSession();
  await submitConsent(data?.session ?? null);
}

// Records the acceptance server-side; this is the call that creates the account.
async function submitConsent(session) {
  const btn = $('consent-accept');
  btn.disabled = true;
  $('consent-error').hidden = true;
  try {
    const res = await authFetch('/api/me/accept-terms', {
      method: 'POST',
      body: JSON.stringify({ agreedToTerms: true }),
    });
    if (!res.ok) throw new Error('accept failed');

    consentOk = true;
    hideConsentModal();
    render(session ?? (await sb.auth.getSession()).data?.session ?? null);
  } catch {
    $('consent-error').textContent = 'Couldn’t save that. Check your connection and try again.';
    $('consent-error').hidden = false;
    syncConsentButton();   // let them retry if the box is still ticked
  }
}

async function declineConsent() {
  const btn = $('consent-decline');
  btn.disabled = true;
  $('consent-error').hidden = true;
  try {
    // A first-time decline removes an auth user with no profile behind it; a
    // revision-decline removes a real account. Same call — the button label and
    // the note above already told them which one this is.
    const res = await authFetch('/api/me/decline', { method: 'POST' });
    if (!res.ok) throw new Error('decline failed');
    await sb.auth.signOut();
    hideConsentModal();
    render(null);
  } catch {
    $('consent-error').textContent = 'Couldn’t complete that. Try again in a moment.';
    $('consent-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function openDeleteModal() {
  $('delete-error').hidden = true;
  $('delete-confirm').disabled = false;
  const ov = $('delete-modal');
  ov.hidden = false;
  void ov.offsetWidth;                 // reflow so the slide-up transition runs
  ov.classList.add('is-open');
}

function closeDeleteModal() {
  const ov = $('delete-modal');
  if (ov.hidden || !ov.classList.contains('is-open')) return;
  ov.classList.remove('is-open');
  setTimeout(() => { ov.hidden = true; }, 360);   // wait out the slide-down
}

async function confirmDelete() {
  const btn = $('delete-confirm');
  btn.disabled = true;
  $('delete-error').hidden = true;
  try {
    const res = await authFetch('/api/me/delete', { method: 'POST' });
    if (!res.ok) throw new Error();
    // Account gone — drop the local session and return to the landing page.
    await sb.auth.signOut();
    closeDeleteModal();
    render(null);
  } catch {
    $('delete-error').textContent = 'Couldn’t delete your account. Try again in a moment.';
    $('delete-error').hidden = false;
    btn.disabled = false;
  }
}

/* ---------- bottom nav: sliding tabs ---------- */

// Slide the track to tab `i` and sync the nav highlight. `animate: false` snaps
// (used on sign-in/out so the reset isn't a visible swipe).
function setTab(i, animate = true) {
  activeTab = i;
  // The hub belongs to Home. It overlays the tab track and the bottom nav sits
  // above it, so leaving it open while History slides in underneath would read
  // as the panel having escaped its screen.
  closeHub();
  const track = $('tab-track');
  if (!animate) track.style.transition = 'none';
  track.style.setProperty('--tab', i);
  if (!animate) { void track.offsetWidth; track.style.transition = ''; }  // restore for next time

  // Keyed on data-tab, NOT on the button's DOM position. Those were two
  // different numbering schemes over the same buttons: the nav's click handler
  // has always dispatched on data-tab, so painting by index meant a markup
  // reorder lit the wrong button while taps still went to the right page.
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const on = Number(btn.dataset.tab) === i;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-current', on ? 'page' : 'false');
  });

  if (i === TAB.history) loadHistory();   // refresh activity whenever the History tab opens
}

/* ---------- bottom nav: swipe between tabs ----------
   The track already slides on a CSS transition when you tap the bar; this is the
   same slide with a finger on it. Touch events rather than pointer events on
   purpose: the only thing that stops the browser scrolling once we take a
   gesture is preventDefault() on a non-passive touchmove, and *whether* to take
   it can't be said in CSS — it depends on which way the finger went and on
   whether the carousel under it still has room to scroll that way. No mouse
   path either; the bottom bar is already the pointer + keyboard route. */

const SWIPE_SLOP = 10;      // px of travel before the axis is called (the browsers' own tap slop)
const SWIPE_RATIO = 1.2;    // |dx| must beat |dy| by this much — a ~40° cone, forgiving of a thumb's arc
const SWIPE_COMMIT = 0.35;  // drag this share of a page and letting go changes tab
const SWIPE_FLING = 0.4;    // px/ms at release: a short flick counts for as much as a long drag
const SWIPE_IDLE_MS = 90;   // parked longer than this before lifting? not a flick, whatever it was doing before
const SWIPE_RESIST = 0.3;   // past the first/last tab the track still moves, at this fraction
let swipe = null;           // the gesture in flight, or null

function wireTabSwipe() {
  const track = $('tab-track');
  // Bound on the track, not on document: every sheet and popover lives at body
  // level (see the OVERLAYS block in index.html), so a touch on an open one
  // can't reach these listeners at all — that guard comes for free.
  track.addEventListener('touchstart', onSwipeStart, { passive: true });
  track.addEventListener('touchmove', onSwipeMove, { passive: false });   // must be non-passive to preventDefault
  // …but the release goes on window. Touch events keep firing at whatever node
  // took the touchstart, so if that node is torn out mid-gesture — a socket push
  // lands while a finger is on a history row, renderHistory() wipes the list —
  // it's detached, and a track-level touchend never arrives. The track would sit
  // parked mid-slide until the next tap. Both are passive, so this costs nothing.
  window.addEventListener('touchend', onSwipeEnd, { passive: true });
  window.addEventListener('touchcancel', onSwipeEnd, { passive: true });
  window.addEventListener('resize', onSwipeResize);
}

// One page wide. The track's own box is what a % translate resolves against, so
// it's the right denominator for both halves of the maths — and reading it live
// means the first gesture after a rotation is already scaled to the new width.
function tabWidth() {
  return $('tab-track').clientWidth || window.innerWidth;
}

// Where the track is sitting *right now*, in tabs — mid-transition included,
// which is why this reads the composited matrix rather than trusting activeTab.
// Same reasoning (and the same guard) as sheetOffset() under the earn sheet.
function trackPos() {
  const t = getComputedStyle($('tab-track')).transform;
  if (!t || t === 'none') return activeTab;
  try { return -new DOMMatrixReadOnly(t).m41 / tabWidth(); } catch { return activeTab; }
}

// Paint only — deliberately not setTab(). A drag that snapped back hasn't
// changed tab, and setTab re-fires loadHistory() every time it lands on 1, so
// routing snap-backs through it would refetch the list on every thumb wiggle.
function paintTab(pos) {
  $('tab-track').style.setProperty('--tab', pos);
}

// Past either end there's nothing to slide to, so the track still gives — just
// far less — and springs back on release. A hard clamp reads as broken.
function paintSwipe(pos, last) {
  let out = pos;
  if (out < 0) out *= SWIPE_RESIST;
  else if (out > last) out = last + (out - last) * SWIPE_RESIST;
  paintTab(out);
}

// Easing back on with the dragged offset as its start point — the same
// remove-class-then-reflow hand-off onEarnDragEnd does for the sheet.
function releaseTrack() {
  const track = $('tab-track');
  track.classList.remove('is-dragging');
  void track.offsetWidth;
}

// Give the gesture back without changing tab: the track eases home from
// wherever the finger left it.
function abortSwipe() {
  if (!swipe) return;
  const wasOurs = swipe.axis === 'x';
  swipe = null;
  if (!wasOurs) return;
  releaseTrack();
  paintTab(activeTab);
}

// Hard reset, no animation — for sign-out, where the shell disappears out from
// under the track while a finger already down keeps firing moves at it. Same
// posture as dropEarnSheet(); the setTab(0, false) right after does the paint.
function dropSwipe() {
  swipe = null;
  $('tab-track').classList.remove('is-dragging');
}

// Does anything under the finger still want this horizontal drag? Only the
// vendor carousel can (it's the one overflow-x in the stylesheet), and only
// while it hasn't already hit the end it's being dragged toward — otherwise the
// last card would swallow every swipe off Home. The walk stops at the .tab-page
// because nothing above it pans sideways: .tab-viewport is overflow: hidden.
function scrollerInWay(target, dx) {
  let el = target && target.nodeType === 1 ? target : null;   // touches land on <path> inside the card SVGs
  while (el) {
    // First, before any overflow test: a .tab-page only authors overflow-y, and
    // a lone overflow-y makes overflow-x compute to `auto` rather than visible.
    if (el.classList.contains('tab-page')) return false;
    // 2px of slop rather than an exact compare — scrollWidth/clientWidth are
    // rounded to integers while scrollLeft is fractional, and scroll-snap parks
    // the carousel on layout-derived fractions.
    const max = el.scrollWidth - el.clientWidth;
    if (max > 2 && /^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowX)) {
      if (dx < 0 ? el.scrollLeft < max - 2 : el.scrollLeft > 2) return true;
    }
    el = el.parentElement;
  }
  return false;
}

function onSwipeStart(e) {
  if (swipe) abortSwipe();                      // a stale gesture whose touchend never landed
  if (e.touches.length !== 1) return;           // a second finger is a pinch or a two-finger scroll, never a tab change
  if ($('app').hidden) return;                  // landing page / consent gate
  // Structurally these can't reach us — every overlay is a body-level sibling of
  // #app — but it's one selector and it survives someone nesting a future sheet.
  // Keyed on [hidden], not .is-open: is-open comes off a few hundred ms before
  // the element actually stops hit-testing.
  if (document.querySelector('.overlay:not([hidden]), .info-overlay:not([hidden])')) return;
  const t = e.touches[0];
  // A sideways drag inside a text field is the caret being moved or a selection
  // being made — the field wants it, and stealing it to change tab makes the
  // spot search unusable one-handed. scrollerInWay can't cover this: an <input>
  // is not an overflow-x scroller.
  if (t.target?.closest?.('input, textarea, [contenteditable="true"]')) return;
  const base = trackPos();
  swipe = {
    id: t.identifier,
    target: t.target,
    x0: t.clientX, y0: t.clientY,
    x: t.clientX, xPrev: t.clientX, tPrev: e.timeStamp,
    v: null,                        // px/ms, smoothed; null until there's a sample
    axis: null,                     // null = undecided, 'x' = ours, 'off' = the page's
    base,                           // grabbing mid-animation picks the track up where it visually is…
    from: Math.round(base),         // …and commits relative to the tab it was nearest
    pos: base,
    width: tabWidth(),
    last: $('tab-track').children.length - 1,
  };
}

function onSwipeMove(e) {
  if (!swipe || swipe.axis === 'off') return;
  if (e.touches.length !== 1) { abortSwipe(); return; }
  const t = e.touches[0];
  if (t.identifier !== swipe.id) return;
  const dx = t.clientX - swipe.x0;
  const dy = t.clientY - swipe.y0;

  if (swipe.axis === null) {
    // Undecided: prevent nothing, return. Staying out of the way here is what
    // keeps an ordinary vertical scroll on the browser's fast path.
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_SLOP) return;
    // Called once and never revisited — re-testing every move is what makes a
    // track judder when a thumb arcs through a scroll.
    if (Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) { swipe.axis = 'off'; return; }
    // A momentum scroll still running under the finger makes moves
    // uncancelable; taking the gesture then slides the track *and* the page.
    if (!e.cancelable) { swipe.axis = 'off'; return; }
    if (scrollerInWay(swipe.target, dx)) { swipe.axis = 'off'; return; }
    // The rightward-drag carve-out that used to sit here is gone. It existed
    // because the spot screen lived INSIDE #tab-home, so a back-swipe on it
    // also reached this listener and the two gestures fought over the axis.
    // The pane is an overlay on .tab-viewport now — outside #tab-track, which
    // is where these listeners are bound — so a touch on it never gets here.
    swipe.axis = 'x';
    $('tab-track').classList.add('is-dragging');   // cut the easing; the finger is the animation now
  }

  if (e.cancelable) e.preventDefault();

  const dt = e.timeStamp - swipe.tPrev;
  if (dt > 0) {
    const v = (t.clientX - swipe.xPrev) / dt;
    swipe.v = swipe.v === null ? v : swipe.v * 0.4 + v * 0.6;   // one jittery sample shouldn't read as a fling
    swipe.xPrev = t.clientX;
    swipe.tPrev = e.timeStamp;
  }
  swipe.x = t.clientX;

  // One tab per gesture, the way a paged scroller works: however far the drag
  // runs it can't fly past History straight into Account.
  swipe.pos = Math.min(swipe.from + 1, Math.max(swipe.from - 1, swipe.base - dx / swipe.width));
  paintSwipe(swipe.pos, swipe.last);
}

function onSwipeEnd(e) {
  if (!swipe) return;
  const s = swipe;
  swipe = null;
  if (s.axis !== 'x') return;   // the page took this one; nothing of ours to settle

  releaseTrack();

  // A finger that parked before lifting isn't flicking, however fast it was
  // moving a moment earlier. A cancel (a call landing, the app backgrounding)
  // has no release velocity at all, so it settles on distance alone — which
  // means a cancel at 80% still commits and one at 5% still goes back.
  const idle = e.timeStamp - s.tPrev;
  const v = (e.type === 'touchcancel' || idle > SWIPE_IDLE_MS) ? 0 : (s.v ?? 0);
  const dx = s.x - s.x0;

  let target;
  if (Math.abs(v) >= SWIPE_FLING) {
    // Commit the way the flick went, but never past where the gesture started:
    // a hard flick back the way you came is a cancel, not a jump.
    target = v < 0 ? Math.max(s.from, Math.ceil(s.pos)) : Math.min(s.from, Math.floor(s.pos));
  } else if (Math.abs(dx) >= s.width * SWIPE_COMMIT) {
    target = s.from + (dx < 0 ? 1 : -1);
  } else {
    target = s.from;
  }
  target = Math.max(0, Math.min(s.last, target));   // the ends don't wrap

  // setTab only on a real arrival — it's what calls loadHistory(), and a drag
  // that snapped back onto Activity must not refetch the list.
  if (target === activeTab) paintTab(activeTab);
  else setTab(target);

  // The browser can still fire a click on whatever was under the finger when it
  // went down — onVendorTap would drill into a vendor, or open the Maps app.
  if (Math.abs(dx) > SWIPE_SLOP) eatNextClick();
}

function onSwipeResize() {
  // A rotation changes the width the drag was scaled against, so its numbers are
  // now wrong. A soft keyboard or a collapsing URL bar only moves the height —
  // those must not kill a live gesture.
  if (!swipe || tabWidth() === swipe.width) return;
  abortSwipe();
}

// Capture phase on the given element (defaults to the tab track), so it lands
// ahead of every delegated handler inside it (#vendor-carousel, #items,
// #hub-toggle, #back-btn, the Account rows). Self-removing, because a
// swipe that produced no click at all must not then eat a real tap.
function eatNextClick(el = $('tab-track')) {
  let timer = 0;
  const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); clearTimeout(timer); };
  el.addEventListener('click', eat, { capture: true, once: true });
  timer = setTimeout(() => el.removeEventListener('click', eat, true), 400);
}

/* ---------- vendor screen: swipe right to back out to Home ----------
   Same axis-lock / fling / commit-by-distance feel as the tab swipe above,
   but scoped to #vendor and to one direction — a leftward drag there means
   nothing of its own, so it's left for the tab swipe to claim as normal (see
   the `closest('#vendor')` check in onSwipeMove, which steps aside for the
   rightward case so the two gestures never fight over the same touch). */

let vswipe = null;   // the vendor back-gesture in flight, or null

function wireVendorSwipe() {
  // Bound to #vendor itself now. It used to be bound to #tab-home, because the
  // pane was only as tall as its content and a vendor with few rewards left a
  // strip of bare page below it where a touch never reached this listener — the
  // tab swipe took the drag instead, so the back-swipe appeared to work on some
  // spots and not others. As an overlay the pane is inset:0 against
  // .tab-viewport, so it always fills the screen and that gap cannot exist.
  //
  // It also means a touch on the spot screen never reaches the TAB swipe, which
  // is bound to #tab-track — the pane is outside the track entirely. The
  // explicit "is the vendor open?" guard that used to sit in onSwipeMove is gone
  // with it; the DOM position is the guard now.
  const el = $('vendor');
  el.addEventListener('touchstart', onVendorSwipeStart, { passive: true });
  el.addEventListener('touchmove', onVendorSwipeMove, { passive: false });   // non-passive to preventDefault
  window.addEventListener('touchend', onVendorSwipeEnd, { passive: true });
  window.addEventListener('touchcancel', onVendorSwipeEnd, { passive: true });
  window.addEventListener('resize', onVendorSwipeResize);
}

// Hand the pane over to the finger: no transition in the way, so it tracks 1:1.
function beginVendorBackDrag() {
  $('vendor').classList.add('is-dragging');
  paintVendorDrag(0);
}

// pos 0 = the spot screen fully covering (drag start), pos 1 = fully dismissed.
// Only the one element moves now; the tab underneath is a real page that was
// never hidden, so there is no second pane to counter-animate.
function paintVendorDrag(pos) {
  $('vendor').style.transform = `translateX(${pos * 100}%)`;
}

// Give the gesture back without navigating: the vendor screen eases back into
// place from wherever the finger left it.
function abortVendorSwipe() {
  if (!vswipe) return;
  const wasOurs = vswipe.axis === 'x';
  vswipe = null;
  if (wasOurs) settleVendorDrag(false);
}

function onVendorSwipeStart(e) {
  if (vswipe) abortVendorSwipe();               // a stale gesture whose touchend never landed
  if (e.touches.length !== 1) return;            // a second finger is a pinch, never a back-swipe
  if ($('vendor').hidden) return;                // on the carousel, not drilled in — nothing to back out of
  if ($('vendor').classList.contains('is-sliding')) return;       // a slide already owns the axis
  if (document.querySelector('.overlay:not([hidden]), .info-overlay:not([hidden])')) return;
  const t = e.touches[0];
  vswipe = {
    id: t.identifier,
    x0: t.clientX, y0: t.clientY,
    x: t.clientX, xPrev: t.clientX, tPrev: e.timeStamp,
    v: null,                    // px/ms, smoothed; null until there's a sample
    axis: null,                 // null = undecided, 'x' = ours, 'off' = someone else's
    width: $('tab-home').clientWidth || window.innerWidth,
  };
}

function onVendorSwipeMove(e) {
  if (!vswipe || vswipe.axis === 'off') return;
  if (e.touches.length !== 1) { abortVendorSwipe(); return; }
  const t = e.touches[0];
  if (t.identifier !== vswipe.id) return;
  const dx = t.clientX - vswipe.x0;
  const dy = t.clientY - vswipe.y0;

  if (vswipe.axis === null) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_SLOP) return;
    // Leftward (or too vertical) isn't the back gesture — the tab swipe owns that.
    if (dx <= 0 || dx < Math.abs(dy) * SWIPE_RATIO) { vswipe.axis = 'off'; return; }
    if (!e.cancelable) { vswipe.axis = 'off'; return; }
    vswipe.axis = 'x';
    beginVendorBackDrag();
  }

  if (e.cancelable) e.preventDefault();

  const dt = e.timeStamp - vswipe.tPrev;
  if (dt > 0) {
    const v = (t.clientX - vswipe.xPrev) / dt;
    vswipe.v = vswipe.v === null ? v : vswipe.v * 0.4 + v * 0.6;   // one jittery sample shouldn't read as a fling
    vswipe.xPrev = t.clientX;
    vswipe.tPrev = e.timeStamp;
  }
  vswipe.x = t.clientX;

  paintVendorDrag(Math.max(0, Math.min(1, dx / vswipe.width)));
}

function onVendorSwipeEnd(e) {
  if (!vswipe) return;
  const s = vswipe;
  vswipe = null;
  if (s.axis !== 'x') return;   // the tab swipe (or nothing) took this one

  const idle = e.timeStamp - s.tPrev;
  const v = (e.type === 'touchcancel' || idle > SWIPE_IDLE_MS) ? 0 : (s.v ?? 0);
  const dx = s.x - s.x0;

  settleVendorDrag(v >= SWIPE_FLING || dx >= s.width * SWIPE_COMMIT);

  // The browser can still fire a click on whatever was under the finger when it
  // went down — a reward card or the back button. Scoped to the page for the
  // same reason the listeners are: a drag can start outside the pane's own box.
  if (Math.abs(dx) > SWIPE_SLOP) eatNextClick($('tab-home'));
}

function onVendorSwipeResize() {
  if (!vswipe || ($('tab-home').clientWidth || window.innerWidth) === vswipe.width) return;
  abortVendorSwipe();
}

// Finish the drag from wherever the finger left it: `commit` slides the rest
// of the way home, same as tapping the back button; otherwise the vendor
// screen springs back into place. Populates `paneSlide` exactly like
// openVendorPane() does, so an interrupting nav can still cut it short.
function settleVendorDrag(commit) {
  const pane = $('vendor');
  pane.classList.remove('is-dragging');

  if (commit) {
    // backToHome(true) does the rest: clears the spot, refreshes balances, and
    // animates the pane the remaining distance off the right edge. The inline
    // transform the drag left behind is cleared inside closeVendorPane, so the
    // class-driven translateX(100%) is what the transition runs to.
    vendorOrigin = TAB.home;
    backToHome(true);
    return;
  }

  // Not committed: spring back into place from wherever the finger let go. The
  // inline transform is the START of that transition, so it is cleared only
  // after .is-sliding is armed and a layout has been forced against it.
  pane.classList.add('is-sliding');
  void pane.offsetWidth;
  pane.style.transform = '';

  const settle = (e) => {
    if (e && e.target !== pane) return;
    endPaneSlide();
  };
  paneSlide = { settle, timer: setTimeout(settle, 420) };
  pane.addEventListener('transitionend', settle);
}

/* ---------- history tab ---------- */

// Must match the route's own default and ceiling (src/routes/student.js).
const HISTORY_DAYS = 30;
const HISTORY_DAYS_MAX = 360;

// How wide a window the tab is showing, and which spot it is filtered to. Both
// live in memory only: they are a way of looking at the list, not a setting, so
// a student who comes back tomorrow starts at the default window with every spot
// in view — the same posture spotsFilter takes on the directory.
//
// historyDays rides on EVERY fetch, including the two background ones. A scan
// landing at the counter fires loadHistory() with no arguments, and without the
// window in module state that push would snap a list the student just expanded
// back to 30 days under their thumb.
let historyDays = HISTORY_DAYS;
let historyVendor = 'all';   // vendor_id the chips are filtering to, or 'all'
let historyMore = false;     // the server says there is something older to reach
let historyTruncated = false; // …and that the feed came back capped, not complete
let historyRows = [];        // the last payload, unfiltered — what the chips are built from
let historySeq = 0;          // which fetch is the newest one out (cf. the admin roster's pager)

async function loadHistory() {
  const seq = ++historySeq;
  try {
    const res = await authFetch(`/api/me/history?days=${historyDays}`);
    if (!res.ok) throw new Error();
    const body = await res.json();
    // A "Load older" and a background push can be in flight at once, and the
    // wider request is not necessarily the one that lands last. Anything that
    // isn't the newest request is dropped rather than painted, or the rows on
    // screen and the window the strapline claims for them disagree.
    if (seq !== historySeq) return;
    // The route still answers a paramless request with a bare array, for clients
    // cached from before the window existed. We always name a window, so this is
    // the envelope — but read both shapes rather than trust one, because the
    // failure mode of guessing wrong is a silently empty tab, not an error.
    const envelope = !Array.isArray(body);
    historyMore = envelope && body.hasMore === true;
    historyTruncated = envelope && body.truncated === true;
    renderHistory(envelope ? (body.items ?? []) : body);
    historyLoaded = true;
  } catch {
    if (seq !== historySeq) return;   // a superseded request's failure is not this view's
    $('history-loading').hidden = true;
    if (!historyLoaded) {          // keep any existing list on a transient refresh failure
      $('history-list').innerHTML = '';
      $('history-empty').textContent = 'Couldn’t load your activity. Check your connection and try again.';
      $('history-empty').hidden = false;
      // …and with no rows there is nothing to filter or extend.
      $('history-filters').hidden = true;
      $('history-more').hidden = true;
    }
  }
}

// The spots this payload actually has rows for, in the order they first appear —
// the feed is newest-first, so that is most-recently-active first.
//
// A row with no vendor belongs to no spot and gets no chip: community grants
// ship vendor_id: null, and so does a transaction whose vendor the operator has
// since deleted (migration-017). Both stay visible under "All", which is where a
// student would look for them.
function historySpots(items) {
  const spots = new Map();
  items.forEach((tx) => {
    if (!tx.vendor_id || spots.has(tx.vendor_id)) return;
    spots.set(tx.vendor_id, { id: tx.vendor_id, name: tx.vendors?.name ?? 'Vendor' });
  });
  return [...spots.values()];
}

// Chips are rebuilt on every render, because every render can come from a socket
// push. The selected one is therefore re-applied from historyVendor and never
// read back off the DOM, or a scan at the counter would silently clear the
// filter. The row element itself is only ever refilled, never replaced, so the
// delegated listener in wireHistory() survives the rebuild.
function renderHistoryFilters(spots) {
  const row = $('history-filters');
  if (spots.length < 2) {          // one spot is not a choice
    row.innerHTML = '';
    row.hidden = true;
    return;
  }
  const left = row.scrollLeft;     // a background refresh must not scroll the row home
  // Tapping a chip rebuilds the row the chip lives in, so without this a
  // keyboard or switch user loses focus to <body> on every activation and the
  // next Tab restarts from the top of the page.
  const held = document.activeElement;
  const refocus = held && held.parentNode === row ? held.dataset.vendor : null;
  let refocused = null;

  row.innerHTML = '';
  [{ id: 'all', name: 'All' }, ...spots].forEach((spot) => {
    const chip = document.createElement('button');
    const on = spot.id === historyVendor;
    chip.type = 'button';
    chip.className = on ? 'hfilter is-selected' : 'hfilter';
    chip.dataset.vendor = spot.id;
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    chip.textContent = spot.name;  // not innerHTML: a vendor name is theirs to choose
    if (refocus && spot.id === refocus) refocused = chip;
    row.appendChild(chip);
  });
  row.hidden = false;
  row.scrollLeft = left;
  if (refocused) refocused.focus();
}

function renderHistory(items) {
  const list = $('history-list');
  $('history-loading').hidden = true;
  historyRows = items;

  // Chips come from the payload, so a spot with nothing left inside the current
  // window takes the filter back to All rather than leaving the tab filtered to
  // a chip that is no longer on screen. `spots.length < 2` is that same case
  // wearing a different hat: the row hides itself below two spots, and a filter
  // left running with no chip to clear it strands the tab — every grant and
  // every deleted-vendor row gone, and nothing on screen to tap to get back.
  const spots = historySpots(items);
  const stranded = spots.length < 2 || !spots.some((s) => s.id === historyVendor);
  if (historyVendor !== 'all' && stranded) historyVendor = 'all';
  renderHistoryFilters(spots);

  // The window — unless the feed came back capped, in which case the honest line
  // is how many rows this is, not a span of days the list does not cover.
  $('history-sub').textContent = historyTruncated
    ? `Your most recent ${items.length} items`
    : `Your last ${historyDays} days`;
  $('history-more').hidden = !historyMore;

  // Filter BEFORE the loop below, never by hiding rows afterwards: the day
  // dividers are emitted on day-change while walking the list, so a hidden row
  // would leave its "YESTERDAY" heading standing over nothing.
  const shown = historyVendor === 'all'
    ? items
    : items.filter((tx) => tx.vendor_id === historyVendor);

  list.innerHTML = '';
  if (!shown.length) {
    // Three messages share this one paragraph — the two here and the connection
    // failure in loadHistory() — and it is never reset when hidden, so each
    // branch has to write its own text rather than just unhide it.
    $('history-empty').textContent = items.length
      ? 'No activity at this spot in this window.'
      : `No activity in the last ${historyDays} days.`;
    $('history-empty').hidden = false;
    return;
  }
  $('history-empty').hidden = true;

  let lastDay = null;
  shown.forEach((tx) => {
    const day = dayLabel(new Date(tx.created_at));
    if (day !== lastDay) {
      lastDay = day;
      const h = document.createElement('p');
      h.className = 'history-day';
      h.textContent = day;
      list.appendChild(h);
    }
    list.appendChild(historyRow(tx));
  });
}

// #history-filters and #history-more are stable elements — only the chips inside
// the row are replaced — so both bind exactly once, here. Nothing inside
// #history-list takes a listener: renderHistory() replaces that subtree on every
// socket push, and a handler bound to a row would go with it (the same tearing
// wireTabSwipe() has to put its release on window for).
function wireHistory() {
  $('history-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.hfilter');
    if (!chip) return;
    if (chip.dataset.vendor === historyVendor) return;
    historyVendor = chip.dataset.vendor;
    renderHistory(historyRows);      // no fetch: the rows are already here
  });
  $('history-more').addEventListener('click', onHistoryMore);
}

// One more window's worth. It goes through loadHistory() rather than fetching on
// its own because historyLoaded is only ever set in there, and both background
// refreshers are gated on it (see the header note) — a pager with its own fetch
// would quietly turn the live updates off.
async function onHistoryMore() {
  const btn = $('history-more');
  if (btn.disabled) return;          // one window per tap, however fast the taps
  historyDays = Math.min(historyDays + HISTORY_DAYS, HISTORY_DAYS_MAX);
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    await loadHistory();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load older';
  }
}

// Back to the first-load state. historyLoaded = false alone only stops the
// background refreshes — it doesn't unpaint anything, so without this a
// sign-out leaves one student's rows on screen for whoever signs in next on the
// same device, right up until their own fetch returns.
function dropHistory() {
  $('history-list').innerHTML = '';
  $('history-loading').hidden = false;
  $('history-empty').hidden = true;
  // The chips name the spots this student goes to, which is the one part of the
  // tab that would still be readable during the next student's fetch — and a
  // stale window would quietly widen theirs too.
  $('history-filters').innerHTML = '';
  $('history-filters').hidden = true;
  $('history-more').hidden = true;
  // The strapline is painted from historyDays, so resetting the variable alone
  // would leave the next student's skeleton sitting under "Your last 120 days".
  $('history-sub').textContent = `Your last ${HISTORY_DAYS} days`;
  historyRows = [];
  historyDays = HISTORY_DAYS;
  historyVendor = 'all';
  historyMore = false;
  historyTruncated = false;
  historySeq++;      // a fetch still in flight belongs to the student who just left
}

/** How a community-point grant reads in History, by the ledger's `kind`. */
const GRANT_TITLES = {
  referral_friend: 'Invite bonus',
  referral_referrer: 'A friend you invited started earning',
  signup_domain: 'Signup bonus',
};

function historyRow(tx) {
  // A community-point grant (migration-039): an incentive payout, or points an
  // operator gave by hand. It has no vendor and is not a transaction at all —
  // the server shapes it into this envelope so the day-grouped list doesn't
  // have to interleave two feeds. Handled before everything below because none
  // of the vendor/reward logic applies to it.
  if (tx.type === 'grant') {
    const gtime = new Date(tx.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const gtitle = GRANT_TITLES[tx.grant_kind] ?? 'Bonus points';
    // The operator's own note on a manual grant is the only honest explanation
    // of why it happened, so it wins over the generic "added by WeRewards".
    const gsub = [tx.reason || 'added by WeRewards', gtime].filter(Boolean).join(' · ');
    const grow = document.createElement('div');
    grow.className = 'history-row transfer';
    grow.innerHTML = `
      <span class="hr-icon">🎉</span>
      <span class="hr-body">
        <span class="hr-title">${escapeHtml(gtitle)}</span>
        <span class="hr-sub">${escapeHtml(gsub)}</span>
      </span>
      <span class="hr-points">+${Number(tx.community_points) || 0}<small>community</small></span>`;
    return grow;
  }

  const earn = tx.type === 'earn';
  // A community transfer (migration-027): the student moved pool points INTO
  // this vendor's balance. Without its own branch it would fall into the
  // redeem arm and render as "Redeemed a reward · −80", which is backwards.
  const transfer = tx.type === 'community_transfer';
  // Falls back to a generic label when the vendor is gone: a deleted vendor
  // (admin dashboard) leaves anonymized transactions with vendor_id → null, so
  // the joined vendors row is missing (migration-017).
  const vendorName = tx.vendors?.name ?? 'Vendor';
  const reward = tx.rewards?.title;
  const time = new Date(tx.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // earn → "Earned at X" + "$Y spent"; redeem → "Redeemed <reward>" + "at X";
  // transfer → "Moved to X" + where they came from
  // A reversal is a compensating row carrying the ORIGINAL row's type with every
  // number negated, so without this it renders as a second identical entry:
  // redeem then undo reads as two redemptions.
  const undone = tx.reverses != null;
  const title = undone
    ? (transfer ? 'Undone move' : earn ? `Undone at ${vendorName}` : 'Undone redemption')
    : transfer
      ? `Moved to ${vendorName}`
      : earn
        ? `Earned at ${vendorName}`
        : (reward ? `Redeemed ${reward}` : 'Redeemed a reward');
  // Earn rows also surface the 10% that rode along ("+150 pts · +15 community");
  // a compensating row's negative community_points stays out of the sub.
  const mint = earn && (tx.community_points ?? 0) > 0 ? `+${tx.community_points} community` : null;
  const sub = transfer
    ? `from your community points · ${time}`
    : earn
      ? [tx.dollar_amount != null ? `$${Number(tx.dollar_amount).toFixed(2)} spent` : null, mint, time].filter(Boolean).join(' · ')
      : `at ${vendorName} · ${time}`;

  // A visits redemption costs 0 points, so the usual chip would read "−0 pts".
  // Show what was actually spent instead (migration-029). Both arms sign from
  // the stored number rather than assuming it: a reversal negates it, so the old
  // `+${tx.points}` printed the literal "+-150" on an undone earn, and a
  // reversed visits row must read "+12", not another "12".
  const sign = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}`;
  const chip = tx.paid_with === 'visits'
    ? `${sign(-(tx.visits_spent ?? 0))}<small>visits</small>`
    : `${sign(tx.points)}<small>pts</small>`;

  const row = document.createElement('div');
  row.className = `history-row ${transfer ? 'transfer' : earn ? 'earn' : 'redeem'}`;
  row.innerHTML = `
    <span class="hr-icon">${transfer ? '🫂' : earn ? '✨' : '🎁'}</span>
    <span class="hr-body">
      <span class="hr-title">${escapeHtml(title)}</span>
      <span class="hr-sub">${escapeHtml(sub)}</span>
    </span>
    <span class="hr-points">${chip}</span>`;
  return row;
}

// "Today" / "Yesterday" / "Mon, Jul 8" — used for the day dividers.
function dayLabel(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

async function authFetch(path, opts = {}) {
  const { data } = await sb.auth.getSession();
  return fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data?.session?.access_token ?? ''}`,
      ...(opts.headers || {}),
    },
  });
}

/* ---------- QR codes (earn + redeem) ---------- */

// Payloads are a shared contract with the vendor terminal:
//   earn → WRW:E:<6 digits>      redeem → WRW:R:<4 digits>
// Uppercase keeps the QR in alphanumeric mode (a version-1 symbol with big,
// fast-scanning modules). The numeric code itself is exactly what the server
// mints — the QR is pure transport, and reading the digits out loud at the
// counter still works as the fallback.
function drawQr(canvas, payload, targetCss) {
  const qr = qrcode(0, 'M');               // 0 = smallest version that fits
  qr.addData(payload, 'Alphanumeric');     // default is Byte — force alnum
  qr.make();

  // Crispness: an integer number of device pixels per module (including a
  // 4-module quiet zone on all sides), and a canvas whose CSS size maps 1:1
  // onto those device pixels — no fractional scaling, so edges never blur.
  const quiet = 4;
  const count = qr.getModuleCount();
  const units = count + quiet * 2;
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.max(2, Math.round((targetCss * dpr) / units));
  const px = units * scale;

  canvas.width = px;
  canvas.height = px;
  canvas.style.width = `${px / dpr}px`;
  canvas.style.height = `${px / dpr}px`;

  // Always dark-on-white, hard-coded on purpose: the QR must NOT follow the
  // app theme (no CSS vars here) — an inverted or low-contrast QR is a known
  // real-world scan failure.
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
}

/* ---------- landing: the QR in the hero mock card ---------- */

// Decorative only — the hero card is aria-hidden, and this is a sample earn
// payload, not a live code (nothing mints one for a signed-out visitor). It
// exists so the landing shows what the home screen actually looks like now
// that the QR, not the digits, is the thing students hold up at the counter.
function drawMockQr() {
  try {
    drawQr($('mock-code-qr'), 'WRW:E:742916', 130);
  } catch {
    $('mock-code').hidden = true;   // no encoder → drop the block rather than leave an empty white box
  }
}

/* ---------- home earn code (shown right on the home screen) ---------- */

function startMyCode() {
  refreshMyCode();
  if (!myCodeTimer) myCodeTimer = setInterval(refreshMyCode, 120_000);
}

function stopMyCode() {
  clearInterval(myCodeTimer);
  myCodeTimer = null;
}

async function refreshMyCode() {
  try {
    const res = await authFetch('/api/me/earn-code', { method: 'POST' });
    if (!res.ok) throw new Error();
    const { code } = await res.json();
    $('my-code-value').textContent = code;   // digits first: the QR is transport, they're the fallback
    // The sheet grows to fit the QR, so this is what decides how far up the
    // screen it reaches: width minus the body's gutters, height minus the grab
    // strip and the digits below. Capped at 300 so it doesn't balloon on a
    // tablet, floored at 180 so a cramped landscape phone still gets a scannable
    // symbol (there the sheet hits its max-height and the body scrolls).
    const room = Math.min(window.innerWidth - 90, window.innerHeight - 300);
    drawQr($('my-code-qr'), `WRW:E:${code}`, Math.max(180, Math.min(300, room)));
    $('my-code-qr-card').hidden = false;     // stays hidden until the first successful render
  } catch {
    // keep the last code + QR visible on a transient failure rather than blanking them
  }
}

/* ---------- home → the full-screen earn code sheet ---------- */

// "Halfway" is measured against the sheet's own height, which it re-reads at
// every grab — the sheet is content-sized, so that height moves. Released past
// 50% it carries on down and closes, anything less springs back to the top. One
// pointer-event path covers touch, pen, and mouse.
let earnDrag = null;

function openEarnSheet() {
  const ov = $('earn-modal');
  if (ov.classList.contains('is-open')) return;
  // Note the guard is on is-open, not on hidden: hidden stays false through the
  // 400ms close animation, and reopening inside that window has to catch the
  // sheet on its way down rather than being swallowed.
  const card = $('earn-card');
  earnDrag = null;
  card.classList.remove('is-dragging');
  card.style.transform = '';        // clear anything a previous drag left behind
  ov.hidden = false;
  void ov.offsetWidth;              // reflow so the slide-up transition runs
  ov.classList.add('is-open');
  $('show-code-btn').setAttribute('aria-expanded', 'true');
  refreshMyCode();                  // freshest code, and a QR sized to this viewport
  $('earn-close').focus({ preventScroll: true });
}

function closeEarnSheet() {
  const ov = $('earn-modal');
  if (ov.hidden || !ov.classList.contains('is-open')) return;  // already closing/closed
  const card = $('earn-card');
  earnDrag = null;
  card.classList.remove('is-dragging');
  card.style.transform = '';         // hand the slide-down back to the CSS transition
  ov.classList.remove('is-open');
  const btn = $('show-code-btn');
  btn.setAttribute('aria-expanded', 'false');
  // Only pull focus back if it's still inside the sheet — otherwise a close
  // triggered by something else (sign-out, Esc from elsewhere) would yank it.
  if (card.contains(document.activeElement)) btn.focus({ preventScroll: true });
  setTimeout(() => {
    if (!ov.classList.contains('is-open')) ov.hidden = true;   // unless it reopened mid-slide
  }, 400);
}

// Hard reset, no animation — for sign-out, where the app shell disappears out
// from under the sheet and sliding it down over the landing page looks broken.
function dropEarnSheet() {
  const ov = $('earn-modal');
  const card = $('earn-card');
  earnDrag = null;
  card.classList.remove('is-dragging');
  card.style.transform = '';
  ov.classList.remove('is-open');
  ov.hidden = true;
  $('show-code-btn').setAttribute('aria-expanded', 'false');
}

// How far down the sheet is sitting *right now* — mid-transition included, which
// is why this reads the composited matrix rather than any value we stored.
function sheetOffset(card) {
  const t = getComputedStyle(card).transform;
  if (!t || t === 'none') return 0;
  try { return new DOMMatrixReadOnly(t).m42; } catch { return 0; }
}

function onEarnDragStart(e) {
  if (earnDrag) return;                                 // one finger owns the sheet
  if (!$('earn-modal').classList.contains('is-open')) return;   // not on one that's leaving
  if (e.target.closest('#earn-close')) return;          // the ✕ is a tap, not a handle
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const card = $('earn-card');
  // Grabbing the pill mid-animation (the slide-up, or a snap-back still in
  // flight) must not teleport the sheet: pin it to where it visually is, and
  // only then cut the easing, so the finger picks it up exactly where it was.
  const base = sheetOffset(card);
  card.style.transform = `translateY(${base}px)`;
  card.classList.add('is-dragging');
  earnDrag = {
    id: e.pointerId,
    y0: e.clientY,
    base,
    dy: base,
    height: card.getBoundingClientRect().height || window.innerHeight,
  };
  e.currentTarget.setPointerCapture(e.pointerId);   // keep the moves coming past the strip
}

function onEarnDragMove(e) {
  if (!earnDrag || e.pointerId !== earnDrag.id) return;
  // downward only — dragging up would tear the sheet off the top of the screen
  earnDrag.dy = Math.max(0, earnDrag.base + (e.clientY - earnDrag.y0));
  $('earn-card').style.transform = `translateY(${earnDrag.dy}px)`;
}

function onEarnDragEnd(e) {
  if (!earnDrag || e.pointerId !== earnDrag.id) return;
  const { dy, height } = earnDrag;
  earnDrag = null;
  const card = $('earn-card');
  card.classList.remove('is-dragging');   // easing back on for either outcome…
  void card.offsetWidth;                  // …with the dragged offset as its start point
  if (dy >= height / 2) closeEarnSheet(); // past halfway → let it carry on down
  else card.style.transform = '';         // short of it → snap cleanly back to the top
}

/* ---------- hub: tier meter (30-day score → earn multiplier) ---------- */

// Paint the meter inside the rewards hub, plus the multiplier chip the
// collapsed pill shows when the hub is shut.
async function loadTier() {
  try {
    const res = await authFetch('/api/me/tier');
    if (!res.ok) throw new Error();
    renderTier(await res.json());
  } catch {
    // keep the last state (or stay hidden) on a transient failure — but drop
    // the placeholder either way. The chip is allowed to be absent; a
    // permanently shimmering stand-in for it is not.
    $('hub-tier-skel').hidden = true;
  }
}

function renderTier(t) {
  const nodes = [...$('tier-nodes').querySelectorAll('.tier-node')];
  const n = nodes.length;
  // One node per multiplier, and the score that unlocks each: [0, ...cutoffs].
  // The nodes are spaced EVENLY and the score is mapped onto that spacing —
  // not the other way round — so every leg of the bar is worth exactly one
  // tier's progress even though the real cutoffs (350, 700 of 1000) aren't
  // evenly spaced, and so the last node means "maxed" rather than "score 1000",
  // which is a number the multiplier stops caring about at 700.
  const edges = [0, ...(t.cutoffs ?? [])].slice(0, n);

  nodes.forEach((el, i) => {
    const at = n > 1 ? i / (n - 1) : 0;
    // the track is inset by half a dot at each end, so a node's left is that
    // inset plus its share of what's left — this is what lines the fill up
    // with the dots (see .tier-meter in styles.css)
    el.style.left = `calc(var(--tier-inset) + (100% - var(--tier-dot)) * ${at})`;
  });

  // How far along, piecewise: which leg the score sits on, plus its progress
  // across that leg.
  let leg = 0;
  while (leg < n - 1 && t.score >= (edges[leg + 1] ?? Infinity)) leg++;
  let fill = 1;                                   // past the last cutoff = maxed
  if (leg < n - 1) {
    const span = (edges[leg + 1] ?? 0) - edges[leg];
    const within = span > 0 ? Math.max(0, Math.min(1, (t.score - edges[leg]) / span)) : 0;
    fill = (leg + within) / (n - 1);
  }
  $('tier-fill').style.width = `${fill * 100}%`;

  // The tier the server reports wins over anything derived above; they agree,
  // but this is the authoritative one.
  const cur = Math.min(n - 1, Math.max(0, (t.tier ?? 1) - 1));
  nodes.forEach((el, i) => {
    el.classList.toggle('is-done', i < cur);
    el.classList.toggle('is-current', i === cur);
    el.querySelector('.tier-node-cap').textContent =
      i === cur ? 'Current tier' : i === 0 ? 'Base tier' : i === n - 1 ? 'Max tier' : '';
  });

  const mult = `${t.multiplier}x`;
  $('tier-earning-mult').textContent = mult;
  $('tier-hint').textContent =
    t.nextTierScore != null
      ? `${t.nextTierScore - t.score} pts to ${t.nextMultiplier}x`
      : 'Max multiplier ✓';

  // The same chip in two places: the collapsed pill and the panel's own header.
  // Both are painted here so they can never disagree.
  for (const [id, multId] of [['hub-tier', 'hub-tier-mult'], ['hub-tier-panel', 'hub-tier-panel-mult']]) {
    const chip = $(id);
    $(multId).textContent = mult;
    chip.classList.remove('t1', 't2', 't3');
    chip.classList.add(`t${t.tier}`);
    chip.hidden = false;
  }
  $('hub-tier-skel').hidden = true;   // the real chip is up; its stand-in steps aside

  $('tier-bar').hidden = false;
  renderLevers(t);
}

/* ---------- hub: "how you climb" (the three score levers) ----------
   The bar is where you are; the text beside it is what is left to do, never
   where you stand — "2 more spots", not "4 of 9". A number you can act on beats
   a number you can only read.

   Those asks come from the server (scoreProfile → `remaining` in
   src/lib/tiers.js), computed next to the thresholds that define them. So the
   targets never cross the wire and there is no second copy of VISIT_TARGET /
   SPEND_TARGET here to go stale the day the scoring is tuned. */

const LEVER_TIPS = [
  'Variety is holding you back most. Any spot you haven’t tried counts.',
  'Loyalty is holding you back most. Head back somewhere you’ve already been.',
  'Spend is holding you back most. Meal-sized orders count for more than a coffee.',
];
const LEVER_DONE = 'Maxed ✓';

function renderLevers(t) {
  const el = $('tier-levers');
  const comps = [t.breadth, t.loyalty, t.spend];
  const rem = t.remaining;
  // An older server that sends neither the components nor the asks: show the
  // meter alone rather than three empty bars.
  if (comps.some((c) => typeof c !== 'number') || !rem) { el.hidden = true; return; }

  $('lever-window').textContent = `last ${t.windowDays ?? 30} days`;

  const pct = (v) => `${Math.max(0, Math.min(1, v)) * 100}%`;
  const more = (n, word) => `${n} more ${word}${n === 1 ? '' : 's'}`;

  $('lever-variety-fill').style.width = pct(t.breadth);
  $('lever-variety-val').textContent = rem.spots > 0 ? more(rem.spots, 'spot') : LEVER_DONE;

  // Loyalty is two things at once: going back to the same spots (the bigger
  // half) and going out often. Ask for one at a time, revisits first, or the
  // row turns into a sentence.
  $('lever-loyalty-fill').style.width = pct(t.loyalty);
  $('lever-loyalty-val').textContent =
    rem.revisits > 0 ? more(rem.revisits, 'revisit')
      : rem.visits > 0 ? more(rem.visits, 'visit')
        : LEVER_DONE;

  // Dollars are the credited figure: a visit counts at most $30 (the anti
  // receipt-stuffing cap), which the (i) explainer spells out. Past the dollar
  // target there is still the ticket-size half of the term to satisfy.
  $('lever-spend-fill').style.width = pct(t.spend);
  $('lever-spend-val').textContent =
    rem.spend > 0 ? `$${rem.spend} more`
      : rem.smallOrders ? 'Bigger orders'
        : LEVER_DONE;

  // The rows say how much; this says which one to spend the effort on.
  let low = 0;
  comps.forEach((c, i) => { if (c < comps[low]) low = i; });
  $('lever-tip').textContent = t.nextTierScore == null
    ? 'You’re at the top tier. Keep visiting to hold it: the score covers a rolling 30 days.'
    : LEVER_TIPS[low];

  el.hidden = false;
}

// Unpaint on sign-out. The multiplier is visible on the home screen the moment
// the shell appears now, so leaving the last student's tier chip up would show
// it to the next one.
function resetTier() {
  $('tier-bar').hidden = true;
  $('tier-levers').hidden = true;
  $('hub-tier').hidden = true;
  $('hub-tier-panel').hidden = true;
  $('hub-tier-skel').hidden = false;   // back to first-load state, like dropHistory()
}

/* ---------- shared info popovers (tier meter + community points) ----------
   A small explainer card fading in over a dimmed backdrop. `id` is the overlay,
   `triggerId` the button that opened it (kept in sync via aria-expanded), and
   the ✕ inside is `<id>-close` by convention. */

function wireInfo(id, triggerId) {
  $(triggerId).addEventListener('click', () => openInfo(id, triggerId));
  $(`${id}-close`).addEventListener('click', () => closeInfo(id, triggerId));
  // the backdrop closes it; a click on the card itself must not
  $(id).addEventListener('click', (e) => { if (e.target === $(id)) closeInfo(id, triggerId); });
}

function openInfo(id, triggerId) {
  const ov = $(id);
  ov.hidden = false;
  void ov.offsetWidth;          // reflow so the fade-in transition runs
  ov.classList.add('is-open');
  $(triggerId).setAttribute('aria-expanded', 'true');
  $(`${id}-close`).focus({ preventScroll: true });
}

function closeInfo(id, triggerId) {
  const ov = $(id);
  if (ov.hidden) return;
  const card = $(`${id}-card`);
  ov.classList.remove('is-open');
  $(triggerId).setAttribute('aria-expanded', 'false');
  // Only pull focus back if it's still inside the popover, so a close triggered
  // from elsewhere (sign-out, Esc while focus has moved on) doesn't yank it.
  if (card?.contains(document.activeElement)) $(triggerId).focus({ preventScroll: true });
  setTimeout(() => { ov.hidden = true; }, 160);   // wait out the fade
}

/* ---------- the rewards hub (tier meter + community wallet) ----------
   The two numbers that aren't tied to any one spot live behind the wordmark
   pill at the top of Home, so the home screen itself can lead with the spots.
   Collapsed, the pill still carries both (multiplier chip + balance) — the
   panel hides the detail, never the fact that you have something.

   Three ways out, all of them: the header row, a tap on the dimmed page, and a
   flick up on the header. Escape too, with the other overlays. */

let hubDrag = null;      // the finger currently on the panel, if any
let hubDragged = false;  // …and whether it moved, so the click it fires is ignored
let hubHideTimer = null; // backstop for the hide at the end of a fold (see closeHub)

function openHub(e) {
  const ov = $('hub-modal');
  const panel = $('hub-panel');
  hubDrag = null;
  hubDragged = false;
  clearTimeout(hubHideTimer);
  panel.classList.remove('is-dragging');
  $('hub-body').style.gridTemplateRows = '';   // clear anything a previous drag left behind
  ov.hidden = false;
  void ov.offsetWidth;              // reflow so the unfold transition runs
  ov.classList.add('is-open');
  $('hub-toggle').setAttribute('aria-expanded', 'true');
  // Move focus onto the panel's own close control — but only when the open came
  // from the keyboard. Chrome treats a programmatic focus() as focus-VISIBLE and
  // paints the ring even when the panel was opened by a tap, which is the stray
  // rectangle that used to appear on the first open and go away on the second
  // (by then focus is already inside, so this line is a no-op). A click event
  // synthesised by Enter/Space reports detail 0; a real pointer click never
  // does. Pointer opens leave focus on the pill, which closeHub() is happy with.
  if (!e || e.detail === 0) $('hub-collapse').focus({ preventScroll: true });
}

function closeHub() {
  const ov = $('hub-modal');
  if (ov.hidden || !ov.classList.contains('is-open')) return;   // already closing/closed
  const panel = $('hub-panel');
  const body = $('hub-body');
  hubDrag = null;
  panel.classList.remove('is-dragging');
  body.style.gridTemplateRows = '';   // hand the fold-up back to the CSS transition
  ov.classList.remove('is-open');
  $('hub-toggle').setAttribute('aria-expanded', 'false');
  // Only pull focus back if it's still inside the panel, so a close triggered
  // from elsewhere (a tab change, sign-out) doesn't yank it.
  if (panel.contains(document.activeElement)) $('hub-toggle').focus({ preventScroll: true });

  // Hiding is what ends the fold, so it has to land AFTER the last frame and
  // never on one. A fixed timer can't promise that: the transition doesn't start
  // until the next style recalc, so a timer set to just clear its duration
  // lops off the tail and the panel vanishes a few pixels early — a snap right
  // at the end of the close. transitionend is the honest signal; the timer is
  // only the backstop for when there is no transition to end (reduced motion,
  // or a drag released with the panel already folded shut) or the event is lost
  // to a backgrounded tab.
  const finish = () => {
    clearTimeout(hubHideTimer);
    body.removeEventListener('transitionend', onFoldEnd);
    if (!ov.classList.contains('is-open')) ov.hidden = true;   // unless it reopened mid-fold
  };
  // Both halves of the guard earn their keep: the tier meter and the lever bars
  // animate their own width inside this element, and those events bubble up
  // here. Hence no { once: true } either — one of them would eat the listener.
  const onFoldEnd = (e) => {
    if (e.target === body && e.propertyName === 'grid-template-rows') finish();
  };
  clearTimeout(hubHideTimer);
  body.addEventListener('transitionend', onFoldEnd);
  hubHideTimer = setTimeout(finish, 400);
}

// Hard reset, no animation — for sign-out, same reason as dropEarnSheet().
function dropHub() {
  const ov = $('hub-modal');
  const panel = $('hub-panel');
  hubDrag = null;
  hubDragged = false;
  clearTimeout(hubHideTimer);
  panel.classList.remove('is-dragging');
  $('hub-body').style.gridTemplateRows = '';
  ov.classList.remove('is-open');
  ov.hidden = true;
  $('hub-toggle').setAttribute('aria-expanded', 'false');
}

// The header row is both the collapse button and the drag handle. A tap closes;
// a flick that rolls up a third of what's open closes; anything shorter snaps
// back — and hubDragged stops the click that follows a real drag from closing a
// panel the user just decided to keep.
//
// The panel never moves, so the finger drives the FOLD, not an offset: the drag
// writes a fractional row size on .hub-body (0fr = shut, 1fr = full height), the
// same track the CSS transition animates, so a released drag hands straight back
// to the easing without the value changing type under it.
function onHubToggleTap() {
  if (hubDragged) { hubDragged = false; return; }
  closeHub();
}

function onHubDragStart(e) {
  if (hubDrag) return;                                          // one finger owns the panel
  if (!$('hub-modal').classList.contains('is-open')) return;     // not on one that's leaving
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const panel = $('hub-panel');
  const body = $('hub-body');
  // How much there is to roll up, and how much of it is showing right now. Both
  // come off the live boxes, mid-animation included, so grabbing the panel while
  // it is still unfolding pins it where it looks rather than where it ends up.
  // scrollHeight, not offsetHeight: the inner block is squashed to the row, and
  // its natural height is exactly what a full 1fr resolves to.
  // Capped at openH because these two are measured differently — the live box is
  // fractional, scrollHeight is rounded — so a fully open panel can read as a
  // hair over 1fr, and pinning it there bumps the panel a pixel the instant a
  // finger lands on the row to close it.
  const openH = $('hub-body-inner').scrollHeight || 1;
  const shown = Math.min(openH, body.getBoundingClientRect().height);
  body.style.gridTemplateRows = `${shown / openH}fr`;
  panel.classList.add('is-dragging');
  hubDrag = { id: e.pointerId, y0: e.clientY, base: shown, shown, openH, moved: false };
  e.currentTarget.setPointerCapture(e.pointerId);   // keep the moves coming past the row
}

function onHubDragMove(e) {
  if (!hubDrag || e.pointerId !== hubDrag.id) return;
  const { base, openH } = hubDrag;
  // upward only — there is nothing past fully open to drag into
  const shown = Math.max(0, Math.min(openH, base + (e.clientY - hubDrag.y0)));
  hubDrag.shown = shown;
  if (Math.abs(shown - base) > 4) hubDrag.moved = true;
  $('hub-body').style.gridTemplateRows = `${shown / openH}fr`;
}

function onHubDragEnd(e) {
  if (!hubDrag || e.pointerId !== hubDrag.id) return;
  const { shown, openH, moved } = hubDrag;
  hubDrag = null;
  const panel = $('hub-panel');
  panel.classList.remove('is-dragging');   // easing back on for either outcome…
  void panel.offsetWidth;                  // …with the dragged row size as its start point
  hubDragged = moved;
  if (openH - shown >= openH / 3) closeHub();          // past a third → let it carry on up
  else $('hub-body').style.gridTemplateRows = '';      // short of it → unfold cleanly again
}

/* ---------- hub: community points (the cross-vendor wallet) ----------
   10% of everything earned at a spot is also minted into this pool
   (migration-026), and the pool isn't tied to the spot that issued it. Spending
   it means MOVING it into one vendor's balance (migration-027) — the move sheet
   below — after which the existing redeem flow takes over.

   loadCommunity() is the single seam: the socket push carries the new balance
   on an award or a move, and this refetches whenever it doesn't (an undo, a
   reconnect). */

// Reveal the amount and drop its placeholder. Idempotent, and called from both
// the success and the failure path: a fetch that never lands must not leave the
// card shimmering for the rest of the session.
function showCommunityAmount(on) {
  $('community-skel').hidden = on;
  $('community-amount').hidden = !on;
}

async function loadCommunity() {
  try {
    const res = await authFetch('/api/me/community');
    if (!res.ok) throw new Error();
    setCommunityPoints((await res.json()).balance ?? 0);
  } catch {
    // keep the last painted count on a transient failure, like loadTier() does
    // — but if there has never been one, show the card's own 0 rather than a
    // placeholder for a number that isn't coming.
    showCommunityAmount(true);
  }
}

// Paint the counter. After the first paint a change counts up (or down) the same
// way the vendor meter does, so points landing over the socket are actually seen
// rather than silently swapped in.
//
// One place shows this number: the community card on Home. It's on-screen
// whenever points land over the socket, so the ticker is worth running.
function setCommunityPoints(next) {
  const prev = communityPoints;
  communityPoints = next;

  const el = $('community-balance');
  if (!communityReady) {          // first paint: just show it, no ticker
    communityReady = true;
    el.textContent = next;
    showCommunityAmount(true);    // …and retire the placeholder it was hiding behind
    return;
  }
  if (next === prev) return;
  tickTo(el, prev, next);
}

/* ---------- home: move community points (the transfer sheet) ----------
   Step 5 of community-points.md. One-way by design: a reversible move is a
   free-item exploit (move in, redeem, move back — item AND points), so the
   confirm view names the destination and amount and says plainly it's final.
   The picker and the amount bound are advisory — the RPC re-checks vendor
   eligibility, the monthly inbound cap, and balance >= amount server-side. */

let moveVendorId = null;    // destination picked in the sheet
let moveRequestId = null;   // idempotency token, minted once per confirmed intent
let moveBusy = false;       // one in-flight move at a time

function onCommunityCardTap() {
  if (communityPoints > 0) openMoveSheet();
  else openInfo('community-info', 'community-card');
}

function openMoveSheet() {
  moveVendorId = null;
  moveRequestId = null;
  renderMoveVendors();
  $('move-amount').value = communityPoints;   // default: move the full balance
  $('move-amount').max = String(communityPoints);
  showMovePick();
  syncMoveContinue();
  const ov = $('move-modal');
  ov.hidden = false;
  void ov.offsetWidth;              // reflow so the slide-up transition runs
  ov.classList.add('is-open');
  $('community-card').setAttribute('aria-expanded', 'true');
}

function closeMoveSheet() {
  const ov = $('move-modal');
  if (ov.hidden || !ov.classList.contains('is-open')) return;
  ov.classList.remove('is-open');
  $('community-card').setAttribute('aria-expanded', 'false');
  setTimeout(() => { ov.hidden = true; }, 360);   // wait out the slide-down
}

// Hard reset, no animation — for sign-out, same reason as dropEarnSheet().
function dropMoveSheet() {
  const ov = $('move-modal');
  ov.classList.remove('is-open');
  ov.hidden = true;
  $('community-card').setAttribute('aria-expanded', 'false');
}

/* ---------- home → the scan-a-receipt sheet (migration-038) ---------- */

// Downscaled before upload: OCR gains nothing above ~1600px, and the server's
// 8MB body cap is headroom for THIS output, not for 12MP originals.
const RECEIPT_MAX_EDGE = 1600;
const RECEIPT_JPEG_QUALITY = 0.72;
let receiptDataUrl = null;
let receiptBusy = false;

function openReceiptSheet() {
  const ov = $('receipt-modal');
  if (ov.classList.contains('is-open')) return;
  resetReceiptSheet();
  ov.hidden = false;
  void ov.offsetWidth;              // reflow so the slide-up transition runs
  ov.classList.add('is-open');
  $('scan-receipt-btn').setAttribute('aria-expanded', 'true');
  $('receipt-close').focus({ preventScroll: true });
}

// Closing mid-upload is allowed on purpose: the request finishes server-side
// either way, and the balance push repaints the card whether the sheet is up
// or not. Blocking the ✕ to babysit a fetch would just trap the student.
function closeReceiptSheet() {
  const ov = $('receipt-modal');
  if (ov.hidden || !ov.classList.contains('is-open')) return;
  ov.classList.remove('is-open');
  const btn = $('scan-receipt-btn');
  btn.setAttribute('aria-expanded', 'false');
  if (ov.contains(document.activeElement)) btn.focus({ preventScroll: true });
  setTimeout(() => { if (!ov.classList.contains('is-open')) ov.hidden = true; }, 360);
}

// Hard reset, no animation — for sign-out, same reason as dropEarnSheet().
function dropReceiptSheet() {
  const ov = $('receipt-modal');
  ov.classList.remove('is-open');
  ov.hidden = true;
  $('scan-receipt-btn').setAttribute('aria-expanded', 'false');
  resetReceiptSheet();
}

function resetReceiptSheet() {
  receiptDataUrl = null;
  receiptBusy = false;
  $('receipt-file').value = '';
  const img = $('receipt-preview');
  img.hidden = true;
  img.removeAttribute('src');
  setReceiptStatus('');
  $('receipt-pick').hidden = false;
  $('receipt-submit').hidden = true;
  $('receipt-submit').disabled = false;
  $('receipt-retake').hidden = true;
  $('receipt-retake').disabled = false;
  $('receipt-pick-view').hidden = false;
  $('receipt-success-view').hidden = true;
}

function setReceiptStatus(msg, ok) {
  const el = $('receipt-status');
  el.textContent = msg;
  el.className = ok ? 'detail-status ok' : 'detail-status locked';
}

// Same createImageBitmap-then-<img> ladder as the vendor-logo picker in
// public/join/join.js — big phone photos decoded off the main thread where
// possible, EXIF orientation respected. Neither path reads HEIC.
async function decodeReceiptImage(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file); } catch { /* fall through to <img> */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

async function onReceiptFile(file) {
  if (!file) return;
  try {
    const src = await decodeReceiptImage(file);
    const scale = Math.min(1, RECEIPT_MAX_EDGE / Math.max(src.width, src.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(src.width * scale));
    canvas.height = Math.max(1, Math.round(src.height * scale));
    canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
    src.close?.();                  // release the ImageBitmap if that's what we got
    receiptDataUrl = canvas.toDataURL('image/jpeg', RECEIPT_JPEG_QUALITY);
  } catch {
    // Library HEICs, mostly. The camera option always yields something readable.
    setReceiptStatus('That photo format isn’t supported here — try the camera option instead.');
    return;
  }
  const img = $('receipt-preview');
  img.src = receiptDataUrl;
  img.hidden = false;
  setReceiptStatus('');
  $('receipt-pick').hidden = true;
  $('receipt-submit').hidden = false;
  $('receipt-retake').hidden = false;
}

async function submitReceipt() {
  if (receiptBusy || !receiptDataUrl) return;
  receiptBusy = true;
  $('receipt-submit').disabled = true;
  $('receipt-retake').disabled = true;
  // No fixed number any more: the AI reader answers in a few seconds and the
  // tesseract fallback in ~10, so promising either one misreads as a hang.
  setReceiptStatus('Checking your receipt… this can take a few seconds.', true);
  try {
    const res = await authFetch('/api/me/receipt', {
      method: 'POST',
      body: JSON.stringify({ image: receiptDataUrl }),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body → generic copy below */ }
    if (!res.ok) {
      setReceiptStatus(data?.message || 'Something went wrong. Try again.');
      return;
    }
    // The card/meter/tier/history repaint arrives over the socket push, same
    // as a counter award — this view just says what landed.
    $('receipt-success-line').textContent =
      `+${data.awarded} pts at ${data.vendorName} on your $${Number(data.total).toFixed(2)} receipt 🎉`;
    $('receipt-pick-view').hidden = true;
    $('receipt-success-view').hidden = false;
    $('receipt-done').focus({ preventScroll: true });
  } catch {
    setReceiptStatus('No connection — your photo wasn’t sent. Try again.');
  } finally {
    receiptBusy = false;
    $('receipt-submit').disabled = false;
    $('receipt-retake').disabled = false;
  }
}

// Every active vendor that takes inbound transfers, the student's existing
// spots first (that's where moved points are most likely headed), keeping the
// /balances order inside each group.
function eligibleMoveVendors() {
  const list = allVendors.filter((v) => v.acceptsCommunity !== false);
  return [...list.filter((v) => (v.balance ?? 0) > 0), ...list.filter((v) => (v.balance ?? 0) <= 0)];
}

function renderMoveVendors() {
  const wrap = $('move-vendors');
  wrap.innerHTML = '';
  const list = eligibleMoveVendors();
  if (!list.length) {
    wrap.innerHTML = `<p class="move-empty">No spots can take moved points right now, check back soon.</p>`;
    return;
  }
  list.forEach((v) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'move-vendor';
    btn.dataset.id = v.vendorId;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.innerHTML = `
      <span class="mv-name">${escapeHtml(v.name)}</span>
      <span class="mv-balance">${v.balance ?? 0} pts there now</span>`;
    wrap.appendChild(btn);
  });
}

function onMoveVendorTap(e) {
  const btn = e.target.closest('.move-vendor');
  if (!btn) return;
  moveVendorId = btn.dataset.id;
  $('move-vendors').querySelectorAll('.move-vendor').forEach((b) => {
    const on = b === btn;
    b.classList.toggle('is-selected', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  syncMoveContinue();
}

function syncMoveContinue() {
  const amount = Number($('move-amount').value);
  const okAmount = Number.isInteger(amount) && amount >= 1 && amount <= communityPoints;
  const status = $('move-status');
  if ($('move-amount').value !== '' && !okAmount) {
    status.textContent = `You have ${communityPoints} pts to move. Enter 1 to ${communityPoints}.`;
    status.className = 'detail-status locked';
  } else {
    status.textContent = '';
    status.className = 'detail-status';
  }
  $('move-continue').disabled = !(okAmount && moveVendorId);
}

function showMovePick() {
  $('move-pick').hidden = false;
  $('move-confirm-view').hidden = true;
  $('move-confirm-status').textContent = '';
  $('move-confirm-status').className = 'detail-status';
}

function showMoveConfirm() {
  const amount = Number($('move-amount').value);
  const v = allVendors.find((x) => x.vendorId === moveVendorId);
  if (!v || !Number.isInteger(amount) || amount < 1 || amount > communityPoints) return;
  // One intent, one token: minted here so a network retry of THIS confirm can't
  // move the points twice, and re-minted if they go Back and change anything.
  moveRequestId = crypto.randomUUID?.() ?? `mv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  $('move-summary').innerHTML =
    `Move <strong>${amount} pts</strong> to <strong>${escapeHtml(v.name)}</strong>? ` +
    `They'll show up in your ${escapeHtml(v.name)} balance right away.`;
  $('move-pick').hidden = true;
  $('move-confirm-view').hidden = false;
}

async function submitMove() {
  if (moveBusy) return;
  const amount = Number($('move-amount').value);
  const v = allVendors.find((x) => x.vendorId === moveVendorId);
  if (!v || !Number.isInteger(amount) || amount < 1) { showMovePick(); return; }
  moveBusy = true;
  const btn = $('move-confirm');
  btn.disabled = true;
  try {
    const res = await authFetch('/api/me/community-transfer', {
      method: 'POST',
      body: JSON.stringify({ vendorId: moveVendorId, amount, requestId: moveRequestId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('move-confirm-status').textContent = data.message || 'Couldn’t move your points, try again.';
      $('move-confirm-status').className = 'detail-status locked';
      // Our number was stale (e.g. an undo landed while the sheet was open) —
      // re-read so the picker bound is honest on the next try.
      if (data.error === 'INSUFFICIENT_POINTS') loadCommunity();
      return;
    }
    // Success: both numbers move. The socket push carries the same pair, so
    // these direct updates just beat it by a beat (and no-op when it lands).
    setCommunityPoints(data.newCommunity ?? 0);
    v.balance = data.newBalance ?? v.balance;
    patchVendorCard(v.vendorId, v.balance);
    if (vendor && vendor.vendorId === v.vendorId) applyBalance(v.balance);
    if (historyLoaded) loadHistory();
    closeMoveSheet();
    moveToast(amount, v.name);
  } catch {
    $('move-confirm-status').textContent = 'No connection, try again.';
    $('move-confirm-status').className = 'detail-status locked';
  } finally {
    moveBusy = false;
    btn.disabled = false;
  }
}

// Same pill the earn/redeem pushes use, so a move reads as the same kind of event.
function moveToast(amount, name) {
  const toast = $('points-toast');
  toast.className = 'points-toast gain';
  toast.textContent = `🫂  Moved ${amount} pts to ${name}`;
  toast.hidden = false;
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => { toast.hidden = true; }, 300);
  }, 2200);
}

/* ---------- home: vendor carousel ---------- */

// Fetch every vendor + this student's balance at each, render the cards, and
// (if a vendor screen is open) keep that screen's items + meter in sync.
// Swap the spots row between its placeholder cards and the real carousel. Only
// one of the two is ever mounted: both carry the row's padding, and the
// carousel is measured by the page dots the moment it has cards in it — a
// scroller sitting [hidden] under the skeleton would measure as a row of zeros.
function showVendorSkeleton(on) {
  $('vendor-skel').hidden = !on;
  $('vendor-carousel').hidden = on;
}

async function loadVendors() {
  try {
    const res = await authFetch('/api/me/balances');
    if (!res.ok) throw new Error();
    allVendors = await res.json();
    renderVendors();

    if (vendor && !$('vendor').hidden) {
      const v = allVendors.find((x) => x.vendorId === vendor.vendorId);
      if (v) { vendor = v; renderVendorRate(v); renderItems(); renderPunchUi(); applyBalance(v.balance ?? 0); }
    }
  } catch {
    // The placeholders have to come down here too, or a student with no
    // connection is left watching two cards shimmer forever with the error
    // message stranded underneath them.
    showVendorSkeleton(false);
    $('vendors-empty').textContent = 'Couldn’t load your spots. Check your connection and try again.';
    $('vendors-empty').hidden = false;
  }
}

// Whether each vendor card carries the map thumbnail at its bottom. To restore
// it, set data-vendor-map="on" on <html> in index.html — that attribute is the
// only declaration, and this reads it.
//
// It lives in the HTML rather than as a const here because the loading skeleton
// has to reserve the right card shape in the FIRST paint of the shell, before
// this file has even been fetched. A const in app.js is unreadable at that
// point, which is exactly how the skeleton came to reserve 150px of map for
// cards that hadn't rendered one since the flag was turned off. styles.css keys
// off the same attribute (see .vskel-map).
//
// Anything other than "on" — including a missing attribute — means off, on both
// sides. The two can disagree only if someone edits one of them to a value the
// other doesn't recognise, and there is no such value.
const SHOW_VENDOR_CARD_MAP = document.documentElement.dataset.vendorMap === 'on';
const TILE_Z = 16;   // OSM zoom for the vendor card thumbnail (~street level)

// Build a 2×2 OpenStreetMap tile mosaic centred on (lat,lng) as the inner HTML
// for a vendor card's .vc-map. Keyless — tiles are pulled straight from
// tile.openstreetmap.org (no API key). Four tiles guarantee the point stays
// covered even when it sits near a single tile's edge; the inner block is then
// translated so the exact point lands dead-centre under the 📍 pin.
function vendorMapHtml(lat, lng) {
  const n = 2 ** TILE_Z;
  const latRad = (lat * Math.PI) / 180;
  const xf = ((lng + 180) / 360) * n;
  const yf = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const x = Math.floor(xf);
  const y = Math.floor(yf);
  const px = (xf - x) * 256;                 // point's pixel within its own tile (0..256)
  const py = (yf - y) * 256;
  const x0 = px < 128 ? x - 1 : x;           // top-left tile of the surrounding 2×2 block
  const y0 = py < 128 ? y - 1 : y;
  const mx = (x - x0) * 256 + px;            // point's pixel within the 512×512 mosaic
  const my = (y - y0) * 256 + py;
  const tile = (tx, ty, left, top) =>
    `<img class="vc-tile" alt="" loading="lazy" style="left:${left}px;top:${top}px"` +
    ` src="https://tile.openstreetmap.org/${TILE_Z}/${tx}/${ty}.png" />`;
  return (
    `<span class="vc-map">` +
    `<span class="vc-map-inner" style="transform:translate(${-mx}px,${-my}px)">` +
    tile(x0, y0, 0, 0) + tile(x0 + 1, y0, 256, 0) +
    tile(x0, y0 + 1, 0, 256) + tile(x0 + 1, y0 + 1, 256, 256) +
    `</span>` +
    `<span class="vc-map-pin" aria-hidden="true">📍</span>` +
    `</span>`
  );
}

// Open the platform's own maps app with directions to `address` (keyless deep
// links): iOS → Apple Maps, Android → the OS map chooser, else → Google Maps web.
function openMaps(address) {
  const q = encodeURIComponent(address);
  const ua = navigator.userAgent || '';
  let url;
  if (/iphone|ipad|ipod/i.test(ua)) url = `https://maps.apple.com/?daddr=${q}`;
  else if (/android/i.test(ua)) url = `geo:0,0?q=${q}`;
  else url = `https://www.google.com/maps/dir/?api=1&destination=${q}`;
  const win = window.open(url, '_blank', 'noopener');
  if (!win) location.href = url;   // popup blocked / custom scheme → navigate directly
}

// Every spot on here is in downtown State College, so "State College, PA 16801"
// is the same eleven characters of noise on every card — and it is the part that
// pushes the street line into a second row on a phone. Trim the tail off for
// DISPLAY only: "123 College Ave, State College, PA 16801" reads as "123 College
// Ave", while openMaps() below still gets handed the full stored address, or the
// maps app would be guessing which College Ave the student meant.
//
// Only a comma-separated part that is ENTIRELY city/state/ZIP is dropped, so a
// street named "Pennsylvania Ave" and a "Suite 200" both survive. An address
// that is nothing but a city ("State College, PA") would trim to empty, and
// falls back to its original text rather than rendering a bare pin.
const ADDR_TAIL_TOKEN = '(?:state\\s*coll?ege|pennsylvania|pa|usa?|united\\s+states|\\d{5}(?:-\\d{4})?)';
const ADDR_TAIL_PART = new RegExp(`^${ADDR_TAIL_TOKEN}(?:[\\s,]+${ADDR_TAIL_TOKEN})*[.]?$`, 'i');
// The comma-free spelling ("123 College Ave State College PA"). Anchored on the
// city name specifically — without it, a trailing "Suite 10012" looks exactly
// like a ZIP to a regex, and the suite is the half a student actually needs.
const ADDR_TAIL_RUN = new RegExp(`[\\s,]+state\\s*coll?ege\\b(?:[\\s,]+${ADDR_TAIL_TOKEN})*[\\s,.]*$`, 'i');

function shortAddress(address) {
  const full = String(address ?? '').trim();
  if (!full) return '';
  const parts = full.split(',').map((p) => p.trim()).filter(Boolean);
  while (parts.length && ADDR_TAIL_PART.test(parts[parts.length - 1])) parts.pop();
  const out = parts.join(', ').replace(ADDR_TAIL_RUN, '').replace(/[\s,]+$/, '').trim();
  return formatAddress(out || full);
}

/* ---------- how an address is spelled ----------
   Addresses are typed by whoever onboarded the vendor, and they arrive in every
   spelling a person uses: "123 east college ave", "123 EAST COLLEGE AVE",
   "1234 N. Atherton Street". The card gives the line one row and no more, so
   the spelling decides both whether it reads as an address and whether it fits.

   DISPLAY-only, the same seam shortAddress() above already is, and for the same
   reason: the STORED text is what openMaps() hands the platform's maps app, and
   rewriting a query someone else has to resolve is not worth a tidier card. It
   is also what buildVendorIndex() reads — and that indexes both spellings of a
   compass word (see there), so "east college" and "e college" find the same
   shop whichever way the address happens to be stored.

   Two rules:

     1. Every word starts with a capital — but ONLY a word that is entirely
        lower case is touched. A word already carrying a capital past its first
        letter was typed that way on purpose, and a title-caser is precisely
        what gets those wrong: "McAllister" (a real street here) would become
        "Mcallister", "O'Brien" would become "O'brien". A SHORT all-caps word is
        left for the same reason — "PSU", "HUB", "BJC" and "PA" are how those
        are written, and "Psu Hub" is not an improvement on anything.

     2. A compass word standing on its own becomes its letter: "East College
        Ave" → "E College Ave". The match is EXACT, and that is the whole
        safeguard — State College has a Northland Center, a Westerly Parkway, a
        Southgate Drive and an Easterly Parkway, and not one of them is a
        direction. A trailing period leaves with the word ("S." → "S"), since
        "S. Allen St" and "S Allen St" are the same address and only one of them
        is short.

   The collateral, named so nobody re-derives it: a street whose NAME is a bare
   compass word ("120 North St") abbreviates too. It stays unambiguous to a
   reader and to the maps app, which gets the stored text anyway.

   Words with a digit in them never go through rule 1 — "3rd" must not become
   "3Rd" — and are handled first. */

const ADDR_DIRECTIONS = { east: 'E', west: 'W', north: 'N', south: 'S' };
// Words that are upper case in an address however they were typed. The
// preserve-what-was-typed rule below can only recognise an acronym that ARRIVED
// as one, so an address typed entirely in lower case ("state college, pa") needs
// this short list to keep its state code from becoming "Pa". Deliberately not a
// general abbreviation dictionary: every entry is something that appears in a US
// postal address and nowhere else, so none of them can collide with a shop or a
// street name.
const ADDR_ALWAYS_UPPER = new Set(['pa', 'us', 'usa', 'po', 'ne', 'nw', 'se', 'sw']);
// Spelled out rather than \p{L}: unicode property escapes need the /u flag and
// a Safari past this app's floor. Same call, and the same range, as
// vendorMonogram() above.
const ADDR_WORD_PARTS = /^([^0-9A-Za-zÀ-ɏ]*)([\s\S]*?)([^0-9A-Za-zÀ-ɏ]*)$/;
const ADDR_ORDINAL = /^[0-9]+(?:st|nd|rd|th)$/i;

// Capitalise the first letter, and the first letter after a hyphen — "bell-vue"
// is two names. After an apostrophe only when more than one letter follows, so
// "o'brien" gets its B while "vito's" keeps its lower-case s.
function addrTitleCase(core) {
  const lower = core.toLowerCase();
  let out = '';
  for (let i = 0; i < lower.length; i += 1) {
    const prev = i === 0 ? '' : lower[i - 1];
    const boundary = i === 0
      || prev === '-' || prev === '–'
      || ((prev === "'" || prev === '\u2019') && lower.length - i > 1);
    out += boundary ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

// One whitespace-separated word, with whatever punctuation is welded to it. The
// punctuation is peeled off so the core can be matched EXACTLY (rule 2 depends
// on that) and put back afterwards — "Ave," has to keep its comma and "(rear)"
// its brackets.
function addrWord(word, shouted) {
  const m = ADDR_WORD_PARTS.exec(word);
  if (!m) return word;
  const [, lead, core, trail] = m;
  if (!core) return word;

  // Rule 2 first: a direction is a whole word, so no other rule can apply to
  // it. Addresses already stored short come through here too, which is what
  // drops the period a card has no room for.
  const dir = ADDR_DIRECTIONS[core.toLowerCase()]
    || (/^[ewns]$/i.test(core) ? core.toUpperCase() : '');
  if (dir) return lead + dir + (trail === '.' ? '' : trail);

  if (ADDR_ALWAYS_UPPER.has(core.toLowerCase())) return lead + core.toUpperCase() + trail;

  // "3rd" keeps its lower-case suffix; everything else carrying a digit gets
  // upper case, which is what turns a unit "4b" into "4B" and a route "us-322"
  // into "US-322".
  if (/[0-9]/.test(core)) {
    return lead + (ADDR_ORDINAL.test(core) ? core.toLowerCase() : core.toUpperCase()) + trail;
  }

  if (!shouted) {
    if (/[A-ZÀ-Þ]/.test(core.slice(1))) return word;                    // McAllister, O'Brien
    if (core === core.toUpperCase() && core.length <= 4) return word;   // PSU, HUB, PA
  }
  return lead + addrTitleCase(core) + trail;
}

/** Rules 1 and 2 over a whole address. Pure; safe to run twice. */
function formatAddress(text) {
  const s = String(text ?? '');
  if (!s) return '';
  // An address in ALL CAPS is shouting, not acronyms: nothing inside it can be
  // told apart from "PSU", so the whole thing is title-cased. Only a MIXED-case
  // address keeps its short all-caps words, which is the one way "PSU HUB"
  // survives without "123 COLLEGE AVE" surviving with it.
  const shouted = s === s.toUpperCase();
  // Capturing split, so the original spacing is rebuilt rather than guessed at.
  return s.split(/(\s+)/).map((w) => (w && !/\s/.test(w) ? addrWord(w, shouted) : w)).join('');
}

// A vendor's earn rate, worded for a student. points_per_dollar crosses the
// wire as a JSON number, so 10.00 has already parsed to 10 by the time it gets
// here; toLocaleString is what keeps that "10" rather than toFixed(2)'s "10.00",
// while still printing 2.5 as "2.5" and 1000 as "1,000".
//
// This is the BASE rate. The award path is
// floor(floor(dollars * points_per_dollar) * multiplier) (routes/vendor.js), so
// a tier 2 student at a 10-point spot actually earns 15. Surfaces with enough
// room explain that the student's multiplier applies on top; compact cards show
// only the ratio.
//
// A missing or nonsense rate renders NOTHING rather than a number. Number(null)
// is 0, and "0 pts per $1" is both a lie and outside the 0.5-1000 range the
// vendor settings enforce, so an old cached payload with no rate in it must go
// quiet instead of promising a student they earn nothing here.
function earnRateText(n) {
  const r = Number(n);
  if (!isFinite(r) || r <= 0) return '';
  // "1 pts" reads as a typo, and a vendor setting exactly 1 is inside the
  // 0.5-1000 range their Settings tab allows, so it is a rate a student will see.
  const unit = r === 1 ? 'pt' : 'pts';
  return `${r.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit} per $1`;
}

// The rate line on the vendor screen. Kept beside the card's copy of the same
// idea rather than down with openVendor, so a change to the wording lands on
// both surfaces at once.
function renderVendorRate(v) {
  const el = $('vendor-rate');
  if (!el) return;
  const text = earnRateText(v?.pointsPerDollar);
  // The one surface with room for the whole truth, so it names the multiplier
  // rather than just hinting at it with the word "base".
  el.textContent = text ? `Base rate: ${text}. Your tier multiplier applies on top.` : '';
  el.hidden = !text;
}

// Words that carry no identity of their own, so "The Waffle Shop" initials as
// WS rather than TW. Only ever applied when something survives the filter — a
// vendor literally called "The Diner" still gets a monogram, not a blank plate.
const MONOGRAM_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'at', 'on', 'in', 'for']);

// Initials for a vendor who never uploaded a logo. Every card gets a mark on
// its plate this way, which is what lets the card assume ONE layout instead of
// branching on hasLogo (styles.css → .vc-band).
//
// Split on separators first and strip punctuation inside each word, not the
// other way around: splitting on every non-letter turns "Webster's Bookstore"
// into Webster / s / Bookstore and yields WS. The character class is spelled
// out rather than using \p{L}, which needs the /u flag and a Safari newer than
// this app's floor (scripts/build-client.js lowers syntax, not regex features).
function vendorMonogram(name) {
  const raw = String(name ?? '').trim();
  // Ampersands and periods are stripped INSIDE a word rather than split on:
  // "A&B Deli" has to stay two words (AD), because splitting it into A / B / Deli
  // makes the stopword filter below eat the vendor's actual first initial.
  const words = raw
    .split(/[\s\-–—/]+/)
    .map((w) => w.replace(/[^0-9A-Za-zÀ-ɏ]/g, ''))
    .filter(Boolean);
  // Nothing Latin to work with. A name in another script keeps its own opening
  // characters — far better than a placeholder glyph, and toUpperCase would be
  // a no-op on it anyway.
  if (!words.length) return Array.from(raw).slice(0, 2).join('') || '•';
  const named = words.filter((w) => !MONOGRAM_STOPWORDS.has(w.toLowerCase()));
  const use = named.length ? named : words;
  // Two letters read as a mark; one reads as a typo. A single-word vendor
  // borrows its own second letter ("Irving's" -> IR).
  const initials = use.length > 1 ? use[0].charAt(0) + use[1].charAt(0) : use[0].slice(0, 2);
  return initials.toUpperCase();
}

function buildVendorCard(v) {
  const card = document.createElement('button');
  card.className = 'vendor-card';
  card.dataset.id = v.vendorId;
  const map = SHOW_VENDOR_CARD_MAP && v.latitude != null && v.longitude != null
    ? vendorMapHtml(v.latitude, v.longitude)
    : '';
  if (!map) card.classList.add('no-map');   // shrink to content + centre in the row (styles.css)
  const address = v.address ? `<span class="vc-address">📍 ${escapeHtml(shortAddress(v.address))} 👆</span>` : '';
  // What a dollar spent here is worth, right under the balance it feeds. Empty
  // string when the rate is missing, so the line disappears rather than lying.
  const rate = earnRateText(v.pointsPerDollar);
  // The mark in the letterhead: the vendor's own artwork from the cacheable
  // endpoint when they have it, their initials when they don't. Never empty, so
  // both kinds of vendor render the same card — the point of the whole layout.
  // aria-hidden because it is the vendor name rendered as a picture and the name
  // itself sits right beside it; announcing it twice buys nothing.
  const mark = v.hasLogo
    ? `<span class="vc-logo" style="background-image:url('/api/vendor-logo/${encodeURIComponent(v.vendorId)}')"></span>`
    : `<span class="vc-mono">${escapeHtml(vendorMonogram(v.name))}</span>`;
  // Two zones sharing one left edge: the letterhead band says who, the body says
  // how much. Then the map at the bottom — band and map are the two parts that
  // bleed to the card's rounded edges.
  card.innerHTML = `
    <span class="vc-band">
      <span class="vc-mark" aria-hidden="true">${mark}</span>
      <span class="vc-name">${escapeHtml(v.name)}</span>
    </span>
    <span class="vc-body">
      <span class="vc-points"><span class="vc-num">${v.balance ?? 0}</span><small>pts</small></span>
      ${rate ? `<span class="vc-rate">${rate}</span>` : ''}
      ${address}
    </span>
    ${map}`;
  return card;
}

// Everything on a card except the points number is fixed for the life of that
// vendor, so this is what decides "reuse it" vs "build it again". Balances move
// constantly and are patched in place below — deliberately NOT part of the
// signature, or every socket push would throw the map tiles away and refetch.
// pointsPerDollar IS in it: a vendor can change the rate from their Settings
// tab, and without it here the card would keep rendering the old one forever,
// since syncVendorCards only ever patches .vc-num on a reused card. That costs
// a rebuild on a ratio change, which is a rare edit and worth the correctness.
function vendorCardSig(v) {
  return JSON.stringify([v.name, v.address ?? '', v.latitude ?? null, v.longitude ?? null, !!v.hasLogo, v.pointsPerDollar ?? null]);
}

// Bring the card pool in line with allVendors — build what's new, patch what
// moved, drop what's gone. Nothing here touches the DOM order; paintVendorRow()
// owns that, because the order depends on the search, not on the data.
function syncVendorCards() {
  const live = new Set();
  allVendors.forEach((v) => {
    const id = String(v.vendorId);
    live.add(id);
    const sig = vendorCardSig(v);
    const card = vendorCards.get(id);
    if (!card || card.dataset.sig !== sig) {
      const next = buildVendorCard(v);
      next.dataset.sig = sig;
      card?.remove();                      // the stale node may still be mounted
      vendorCards.set(id, next);
      return;
    }
    const num = card.querySelector('.vc-num');
    const points = String(v.balance ?? 0);
    if (num && num.textContent !== points) num.textContent = points;
  });
  vendorCards.forEach((card, id) => {      // deleting while iterating a Map is safe
    if (!live.has(id)) { card.remove(); vendorCards.delete(id); }
  });
}

// Mount exactly shownVendors, in order. appendChild/insertBefore MOVE a node
// that is already in the document rather than recreating it, so a card that
// survives a keystroke keeps its loaded map tiles and its layout — the whole
// reason cards are pooled. Set membership rather than an array scan for the
// unmount pass: that one is otherwise quadratic, which is exactly the stall the
// search is supposed to avoid.
function paintVendorRow() {
  const wrap = $('vendor-carousel');
  const want = shownVendors.map((v) => vendorCards.get(String(v.vendorId))).filter(Boolean);
  const wanted = new Set(want);
  [...wrap.children].forEach((el) => { if (!wanted.has(el)) el.remove(); });
  want.forEach((el, k) => {
    // Live HTMLCollection: index k is re-read after each move, so this settles
    // in one pass with a move only where the order actually differs.
    if (wrap.children[k] !== el) wrap.insertBefore(el, wrap.children[k] ?? null);
  });
}

/* ============================================================
 * The Spots tab — every vendor, alphabetical, searchable.
 *
 * Home's carousel answers "where have I been lately"; this answers "where can
 * I go". It renders from the SAME allVendors array the carousel uses, so it
 * costs no extra request — every field it needs (balance, logo, favorite) is
 * already in the /api/me/balances payload the app fetched on load.
 * ============================================================ */

let spotsQuery = '';
// 'all' | 'recent' | 'top' — the pill beside the strapline. In memory only:
// it is a way of looking at the list, not a setting, and a student who comes
// back tomorrow should get the whole directory rather than yesterday's lens.
let spotsFilter = 'all';
// Cuisine tags and price tiers the student has ticked in the filter sheet
// (migration-042). Sets, because both are membership tests run once per vendor
// per render and the answer is "is this one of them".
//
// They are a SEPARATE axis from spotsFilter above, not more values of it: a
// student can ask for saved AND coffee AND cheap, and each narrows the last.
// In memory only, for the same reason spotsFilter is — see above.
const spotsCuisine = new Set();
const spotsPrice = new Set();
// Rows are pooled by vendor id, exactly like the carousel's cards: a keystroke
// re-orders the list rather than rebuilding it, so a row keeps its loaded logo
// and its heart doesn't flicker mid-save.
const spotRows = new Map();
// Vendor ids with a favorite request in flight. The heart is painted
// optimistically, and this is what stops a second tap racing the first.
const favoritePending = new Set();

/** Alphabetical by name, case- and accent-insensitively. */
function spotsOrder(a, b) {
  return searchFold(a.name).localeCompare(searchFold(b.name), undefined, { numeric: true });
}

/** Newest first. Ties keep the server's order, which is already created_at DESC. */
function newestFirst(a, b) {
  return new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime();
}

/** Spots that joined inside the server's new-vendor window, newest first. */
function newVendors() {
  return allVendors.filter((v) => v.isNew).sort(newestFirst);
}

/** How many spots the Recommended row aims to show. */
const RECOMMENDED_TARGET = 5;

/**
 * The Recommended list — shared by the Home carousel's fallback row and the
 * Spots tab's "Top" filter, so the two can never disagree about what is being
 * recommended.
 *
 * Three rules, in order:
 *
 *   1. A SMALL CATALOGUE IS ITS OWN RECOMMENDATION. At five spots or fewer,
 *      ranking them is theatre — the student can see the whole town either way,
 *      and a "top 3 of 4" reads as though something is being withheld. So the
 *      whole list is returned, alphabetically.
 *   2. Otherwise the server's visit ranking leads, best first.
 *   3. If that ranking is short of the target — a young deployment where few
 *      spots have visits yet — the remainder is filled from the newest spots.
 *      They go at the BOTTOM, after everything that earned its place by being
 *      visited, so topping up never displaces a genuinely popular spot.
 *
 * Rule 3 is why the row is labelled "Recommended" rather than "Most visited":
 * a brand-new spot has no visits by definition, so it is there on the strength
 * of being new, and the heading has to be able to carry both.
 */
function recommendedList() {
  if (allVendors.length <= RECOMMENDED_TARGET) {
    return allVendors.slice().sort(spotsOrder);
  }

  const ranked = allVendors
    .filter((v) => v.recommendedRank != null)
    .sort((a, b) => a.recommendedRank - b.recommendedRank);

  if (ranked.length >= RECOMMENDED_TARGET) return ranked;

  // Top up with new spots the ranking didn't already include.
  const taken = new Set(ranked.map((v) => String(v.vendorId)));
  const filler = newVendors().filter((v) => !taken.has(String(v.vendorId)));
  return ranked.concat(filler.slice(0, RECOMMENDED_TARGET - ranked.length));
}

/**
 * The list the current filter describes, before any search is applied.
 *
 *   all       — every spot, alphabetical. The directory.
 *   favorites — the spots this student saved with the heart, alphabetical.
 *   recent    — spots with activity in the last 7 days (the server's `recent`
 *               flag), alphabetical. The set the Home carousel draws from.
 *   top       — the most-visited spots, in the server's ranking.
 *               `recommendedRank` is only set on the ranked few, so this is a
 *               short list by design.
 *
 * Each returns a NEW array; nothing here may sort allVendors in place, or the
 * carousel's own ordering would change underneath it.
 */
function spotsFilterList() {
  return applySpotsTags(baseSpotsList());
}

function baseSpotsList() {
  if (spotsFilter === 'favorites') {
    return allVendors.filter((v) => v.favorite).sort(spotsOrder);
  }
  if (spotsFilter === 'recent') {
    return allVendors.filter((v) => v.recent).sort(spotsOrder);
  }
  if (spotsFilter === 'top') return recommendedList();
  return allVendors.slice().sort(spotsOrder);
}

/**
 * Narrow a list by the ticked cuisine tags and price tiers (migration-042).
 *
 * The two axes are ANDed with each other and ORed within themselves, which is
 * what a chip row means to the person tapping it: ticking Coffee and Pizza asks
 * for either, ticking Coffee and $ asks for both. Nothing ticked in an axis
 * means that axis is not asking anything, NOT that it matches nothing.
 *
 * An UNTAGGED spot fails a filter it can't answer. `{}` never contains coffee
 * and a null price is not $$, so a vendor who hasn't said drops out of a
 * narrowed view rather than being shown on the chance they might qualify — the
 * filter has to mean what it says, and spotsEmptyText explains the case where
 * that empties the list. Untagged spots are untouched with nothing ticked,
 * which is the default and the overwhelmingly common view.
 *
 * Order is preserved: this filters, it never re-sorts.
 */
function applySpotsTags(list) {
  if (!spotsCuisine.size && !spotsPrice.size) return list;
  return list.filter((v) => {
    if (spotsCuisine.size && !(v.cuisine ?? []).some((c) => spotsCuisine.has(c))) return false;
    if (spotsPrice.size && !spotsPrice.has(Number(v.priceLevel))) return false;
    return true;
  });
}

/** How many separate things the student has narrowed by. Drives the pill. */
function activeFilterCount() {
  return (spotsFilter === 'all' ? 0 : 1) + spotsCuisine.size + spotsPrice.size;
}

/* ---------- naming a tag ----------
   Prettifying the slug ("bubble-tea" → "Bubble tea") is right for every tag in
   src/lib/cuisines.js except the acronyms, so only those are listed here. A tag
   added there and not here still renders sensibly — the drift this can produce
   is cosmetic, never functional, which is the whole reason the chips are built
   from the data rather than from a copy of the vocabulary shipped in this file. */
const CUISINE_EXCEPTIONS = { bbq: 'BBQ' };

function cuisineLabel(slug) {
  return CUISINE_EXCEPTIONS[slug]
    ?? String(slug).replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

const priceLabel = (n) => '$'.repeat(Number(n) || 0);

/** Every narrowing currently on, in the order the sheet lists them. */
function activeFilterNames() {
  const showing = { favorites: 'Saved', recent: 'Recent', top: 'Top' }[spotsFilter];
  return [
    ...(showing ? [showing] : []),
    ...[...spotsCuisine].map(cuisineLabel),
    ...[...spotsPrice].map(priceLabel),
  ];
}

/** Just the tag axes, phrased for a sentence: "coffee or pizza", "$ or $$". */
function filterTagSummary() {
  const parts = [
    ...[...spotsCuisine].map((c) => cuisineLabel(c).toLowerCase()),
    ...[...spotsPrice].map(priceLabel),
  ];
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

/** What to say when the current filter (plus any query) matches nothing. */
function spotsEmptyText(query) {
  // The tag axes are checked FIRST and answer for the whole empty state. When
  // they are on they are overwhelmingly the reason the list is empty, and every
  // message below would actively mislead: "No saved spots yet, tap the heart to
  // save one" is wrong advice for a student who has saved six spots, none of
  // which happen to sell coffee.
  if (spotsCuisine.size || spotsPrice.size) {
    const what = filterTagSummary();
    if (query) return `Nothing matching “${query}” in ${what}.`;
    // Names the exclusion rule, because a spot the student KNOWS is in the app
    // going missing under a price filter otherwise reads as a bug rather than
    // as the filter doing its job.
    return `Nothing here for ${what} yet. Spots that haven't said what they sell are hidden while a filter is on.`;
  }

  if (query) {
    if (spotsFilter === 'favorites') return `None of your saved spots match “${query}”.`;
    if (spotsFilter === 'recent') return `No recent spots match “${query}”.`;
    if (spotsFilter === 'top') return `No top spots match “${query}”.`;
    return `No spots match “${query}”.`;
  }
  // Says what to DO, not just what is missing: an empty Favorites list is the
  // one empty state here a student can fix in one tap, so it should say how.
  if (spotsFilter === 'favorites') return 'No saved spots yet. Tap the heart on a spot to save it.';
  if (spotsFilter === 'recent') return "You haven't been anywhere in the last 7 days.";
  if (spotsFilter === 'top') return 'No visits recorded yet, so there is nothing to rank.';
  return 'No spots yet, check back soon!';
}

function buildSpotRow(v) {
  // A <div role="button"> rather than a <button>: the heart is itself a button
  // and nesting one inside another is invalid HTML, which browsers "fix" by
  // un-nesting them — the heart would end up as a sibling and the row's layout
  // would break. Both elements carry their own handler; the heart's stops
  // propagation so tapping it never also opens the spot.
  const row = document.createElement('div');
  row.className = 'spot-row';
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.dataset.id = v.vendorId;

  const mark = v.hasLogo
    ? `<span class="spot-logo" style="background-image:url('/api/vendor-logo/${encodeURIComponent(v.vendorId)}')"></span>`
    : `<span class="spot-mono">${escapeHtml(vendorMonogram(v.name))}</span>`;

  const rate = earnRateText(v.pointsPerDollar);

  row.innerHTML = `
    <span class="spot-mark" aria-hidden="true">${mark}</span>
    <span class="spot-name">${escapeHtml(v.name)}${rate ? `<small class="spot-sub">${escapeHtml(rate)}</small>` : ''}</span>
    <span class="spot-points"><span class="spot-num">${v.balance ?? 0}</span><small>pts</small></span>
    <button class="spot-heart" type="button" aria-pressed="false">
      <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 20.4S3.6 15 3.6 9.1a4.6 4.6 0 0 1 8.4-2.6 4.6 4.6 0 0 1 8.4 2.6c0 5.9-8.4 11.3-8.4 11.3z" />
      </svg>
    </button>`;

  paintSpotHeart(row, Boolean(v.favorite), v.name);
  return row;
}

/** The heart's two states, in one place so the class and the label can't drift. */
function paintSpotHeart(row, on, name) {
  const heart = row.querySelector('.spot-heart');
  if (!heart) return;
  heart.classList.toggle('is-on', on);
  heart.setAttribute('aria-pressed', on ? 'true' : 'false');
  // The accessible name has to carry the ACTION, not just the icon: "heart"
  // tells a screen-reader user nothing about what tapping it will do.
  heart.setAttribute('aria-label', `${on ? 'Remove' : 'Save'} ${name}${on ? ' from' : ' to'} your spots`);
}

// Everything on a row except the balance and the heart is fixed for the life of
// the vendor, so this decides reuse vs rebuild — same contract as
// vendorCardSig(). `favorite` is deliberately NOT in it: the heart is patched
// in place, and rebuilding on a toggle would throw the logo away mid-tap.
function spotRowSig(v) {
  return JSON.stringify([v.name, !!v.hasLogo, v.pointsPerDollar ?? null]);
}

/**
 * Mount exactly `vendors`' rows into `container`, in order, and return them.
 *
 * insertBefore MOVES a node that is already in the document rather than
 * recreating it, which is the whole reason rows are pooled: a row that survives
 * a keystroke — or moves between the NEW strip and the main list — keeps its
 * loaded logo and its heart state. Set membership for the unmount pass, since
 * an array scan there is quadratic.
 */
function mountRows(container, vendors) {
  const want = vendors.map((v) => spotRows.get(String(v.vendorId))).filter(Boolean);
  const wanted = new Set(want);
  [...container.children].forEach((el) => { if (!wanted.has(el)) el.remove(); });
  want.forEach((el, k) => {
    // Live HTMLCollection: index k is re-read after each move, so this settles
    // in one pass with a move only where the order actually differs.
    if (container.children[k] !== el) container.insertBefore(el, container.children[k] ?? null);
  });
  return want;
}

/**
 * Exactly the spots the tab is showing right now — filter, then search.
 *
 * That order is deliberate: the filter is an explicit choice the student can
 * see in the pill, so a search running outside it would quietly return spots
 * they had just asked to exclude. When nothing matches, spotsEmptyText names
 * the filter so the empty state reads as "not in Recent" rather than "does not
 * exist".
 *
 * Shared by the three places that must agree on this set — the list itself, the
 * sheet's "Show N spots" footer, and the random pick. They were three copies of
 * these eight lines, which is three chances for the number in the footer, the
 * rows behind it, and the spot the dice lands on to disagree.
 *
 * Includes the vendors renderSpots() lifts into the NEW strip: those are still
 * on screen, just in a different container, and a random pick that could not
 * land on them would be lying about its pool.
 */
function shownSpots() {
  const base = spotsFilterList();
  if (!spotsQuery.trim()) return base;
  // filterVendors() returns RELEVANCE order over the whole catalogue, which is
  // what a query wants; intersecting preserves that ranking while honouring the
  // pill. A Set because this is otherwise quadratic on every keystroke.
  const allowed = new Set(base.map((v) => String(v.vendorId)));
  return filterVendors(spotsQuery).filter((v) => allowed.has(String(v.vendorId)));
}

function renderSpots() {
  const list = $('spots-list');
  const skel = $('spots-skel');
  const empty = $('spots-empty');

  // Bring the pool in line with allVendors — build what's new, patch what
  // moved, drop what's gone.
  const live = new Set();
  allVendors.forEach((v) => {
    const id = String(v.vendorId);
    live.add(id);
    const sig = spotRowSig(v);
    const existing = spotRows.get(id);
    if (!existing || existing.dataset.sig !== sig) {
      const next = buildSpotRow(v);
      next.dataset.sig = sig;
      existing?.remove();
      spotRows.set(id, next);
      return;
    }
    const num = existing.querySelector('.spot-num');
    const points = String(v.balance ?? 0);
    if (num && num.textContent !== points) num.textContent = points;
    // Don't stomp a heart the student just tapped — the optimistic paint is
    // ahead of the payload until the save lands.
    if (!favoritePending.has(id)) paintSpotHeart(existing, Boolean(v.favorite), v.name);
  });
  spotRows.forEach((row, id) => {
    if (!live.has(id)) { row.remove(); spotRows.delete(id); }
  });

  const q = spotsQuery.trim();
  const shown = shownSpots();

  // The NEW strip only exists on the unfiltered, unsearched view — once the
  // student has narrowed things deliberately, a strip of unrelated spots is
  // noise. When it is not showing, new spots are NOT lifted out; they stay in
  // the main list wherever their name sorts.
  const strip = $('spots-new');
  const stripList = $('spots-new-list');
  // activeFilterCount() rather than `spotsFilter === 'all'`: a cuisine or price
  // chip narrows the view just as deliberately as the list picker does, and a
  // strip of unrelated new spots is exactly as much noise in that view.
  const newOnes = (!q && !activeFilterCount()) ? newVendors() : [];
  const lifted = new Set(newOnes.map((v) => String(v.vendorId)));

  // Mount into the strip first, so a row moving between the two containers has
  // left the list before the list is measured. One pool serves both: a row can
  // only be in one place at a time, and lifting it out of `shown` below is what
  // guarantees no vendor is asked to render twice.
  mountRows(stripList, newOnes);
  strip.hidden = newOnes.length === 0;

  const rest = shown.filter((v) => !lifted.has(String(v.vendorId)));
  const want = mountRows(list, rest);

  const loaded = allVendors.length > 0;
  skel.hidden = loaded;
  list.hidden = !loaded || want.length === 0;
  // The empty state speaks for the WHOLE tab, so a directory whose only spots
  // are new ones (all of them lifted into the strip) is not empty.
  const total = want.length + newOnes.length;
  empty.hidden = total > 0 || !loaded;
  if (!total && loaded) empty.textContent = spotsEmptyText(q);

  // Announced for a query OR a filter change — both are actions the student
  // took whose only visible result is the list changing under them, and a screen
  // reader gets no cue from that on its own. Silent otherwise: an idle live
  // region that re-announced on every socket push would talk over everything.
  $('spots-search-status').textContent = (q || activeFilterCount())
    ? `${total} ${total === 1 ? 'spot' : 'spots'} found`
    : '';
  $('spots-search-clear').hidden = !q;
  // shown.length, not want.length: the NEW strip's rows are on screen too, and
  // they are in the pool the dice draws from.
  syncRandomBtn(shown.length);

  // Last: the pill names the active filter, which is downstream of the state
  // this render just applied.
  syncFilterPill();
  // The sheet only when it is actually up. Its chips are rebuilt from scratch
  // on open, so a closed sheet has nothing worth keeping current — and this
  // runs on every socket push, where walking the modal's inputs to set state
  // nobody can see is pure waste.
  if (!$('spots-filter-modal').hidden) syncFilterSheet();
}

/* ---------- "Pick a random spot" ----------
   Draws from shownSpots(), so the pick is always one of the spots on screen —
   narrow to $ coffee places and the dice can only land on a $ coffee place.
   That is the whole feature: the filter sheet answers "which of these", this
   answers "I don't care, choose".

   THE WAIT IS DELIBERATE AND IT IS NOT HIDING ANY WORK. The catalogue is
   already in memory and Math.random() returns before the tap's own ripple
   finishes, so a button that navigated on the click would read as a mis-tap —
   the spot screen would simply appear, with nothing connecting it to the thing
   that was pressed. The roll spends that second flashing candidate NAMES, which
   also happens to be the only honest evidence the pick respected the filter:
   every name that goes past is one the student could have got.

   THE RESULT IS A SHEET, NOT A NAVIGATION. A draw is a suggestion, and landing
   the student on the spot's own screen makes declining it a back-tap — the same
   gesture as undoing a mistake. openPickSheet() offers it over a dimmed list
   instead, with "Check it out" as the only forward move.

   `picking` spans BOTH the roll and the sheet it opens, because the button has
   to hold the name it landed on for that whole stretch and must not take a
   second tap until the first result has been decided about. Closing the sheet
   is what releases it — which makes closing the only route back to a fresh
   draw, and is why nothing here needs a "pick again" button.

   Cancelled from resetSpots() on sign-out, or the timer would fire into the
   next student's session and open a spot from the previous one's list. */

const ROLL_STEPS = 11;        // names flashed before it lands
const ROLL_FAST = 55;         // ms between the first few…
const ROLL_SLOW = 190;        // …and the last, so it visibly comes to rest
const ROLL_HOLD = 340;        // the name sits on the button before the sheet arrives

let rollTimer = null;
let picking = false;
let pickedVendor = null;      // what the sheet is currently offering
let randomIdleLabel = '';     // read off the markup at wire time so the two can't drift

/**
 * Show or hide the button. Called from renderSpots with what it just mounted.
 *
 * Hidden below two spots for the same reason the carousel hides its dots at
 * one: there is no choice to make, and a control that can only return the row
 * directly beneath it is worse than no control. That also covers the skeleton —
 * an unloaded catalogue is zero spots — so there is no separate loading branch.
 *
 * Never touches the button while a pick is live. renderSpots() runs on every
 * socket push, and a balance landing mid-roll — or while the sheet is up —
 * would otherwise wipe the name the student is looking at.
 */
function syncRandomBtn(count) {
  if (picking) return;
  const btn = $('spots-random');
  if (btn) btn.hidden = count < 2;
}

/** Back to idle: a fresh draw is one tap away again. Safe to call when idle. */
function stopRoll() {
  clearTimeout(rollTimer);
  rollTimer = null;
  picking = false;
  pickedVendor = null;
  const btn = $('spots-random');
  if (!btn) return;
  btn.classList.remove('is-rolling', 'is-landed');
  btn.removeAttribute('aria-busy');
  btn.disabled = false;
  $('spots-random-label').textContent = randomIdleLabel;
  // The pool can have moved while the sheet was up — on a socket push the sync
  // above deliberately ignored — so re-decide visibility now that it may act.
  syncRandomBtn(shownSpots().length);
}

function pickRandomSpot() {
  if (picking) return;
  const pool = shownSpots();
  if (pool.length < 2) return;

  const winner = pool[Math.floor(Math.random() * pool.length)];
  const btn = $('spots-random');
  const label = $('spots-random-label');
  picking = true;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.classList.add('is-rolling');

  const land = () => {
    label.textContent = winner.name;
    btn.classList.remove('is-rolling');
    btn.classList.add('is-landed');
    btn.removeAttribute('aria-busy');
    // The name holds on the button for a beat before the sheet covers the list,
    // so the two read as one event rather than as a button press and then an
    // unrelated dialog. It stays there for as long as the sheet is up.
    rollTimer = setTimeout(() => { rollTimer = null; openPickSheet(winner); }, ROLL_HOLD);
  };

  // Reduced motion gets the pause without the flicker — a label changing eleven
  // times in under a second is precisely the effect that setting asks us not to
  // produce. The wait stays, because the wait is what makes the result read as
  // a draw rather than as a link.
  if (reducedMotion()) {
    label.textContent = 'Picking…';
    rollTimer = setTimeout(land, 700);
    return;
  }

  let step = 0;
  const tick = () => {
    label.textContent = pool[Math.floor(Math.random() * pool.length)].name;
    step += 1;
    if (step >= ROLL_STEPS) { land(); return; }
    // Eased, not evenly spaced: constant intervals read as a progress bar,
    // slowing down reads as a wheel losing momentum.
    const t = step / ROLL_STEPS;
    rollTimer = setTimeout(tick, ROLL_FAST + (ROLL_SLOW - ROLL_FAST) * t * t);
  };
  tick();
}

/** Fill the sheet from the vendor it landed on, and slide it up. */
function openPickSheet(v) {
  pickedVendor = v;

  // The same two-way mark buildSpotRow() puts on every row, so the spot the
  // sheet names is recognisably the row it came out of.
  $('pick-mark').innerHTML = v.hasLogo
    ? `<span class="spot-logo" style="background-image:url('/api/vendor-logo/${encodeURIComponent(v.vendorId)}')"></span>`
    : `<span class="spot-mono">${escapeHtml(vendorMonogram(v.name))}</span>`;
  $('pick-title').textContent = v.name;

  // Cuisine and price (migration-042) as one line of "what this place is" — the
  // only surface that SHOWS the tags rather than filtering on them, because
  // after a blind draw "Coffee · Vegan · $$" is what decides whether to accept
  // it. Hidden rather than left blank when the vendor has declared neither: an
  // empty line under the name reads as something that failed to render.
  const tags = (v.cuisine ?? []).map(cuisineLabel);
  if (v.priceLevel) tags.push(priceLabel(v.priceLevel));
  $('pick-tags').textContent = tags.join(' · ');
  $('pick-tags').hidden = tags.length === 0;

  const bal = Number(v.balance) || 0;
  $('pick-rate').textContent = [
    earnRateText(v.pointsPerDollar),
    bal > 0 ? `You have ${bal} pts here.` : '',
  ].filter(Boolean).join(' · ');

  const ov = $('spots-pick-modal');
  ov.hidden = false;
  void ov.offsetWidth;              // reflow so the slide-up transition runs
  ov.classList.add('is-open');
  $('spots-random').setAttribute('aria-expanded', 'true');
  // The CLOSE button, not "Check it out": the dialog is labelled by the spot's
  // name, so focus landing inside announces the pick, and an Enter on the way
  // in does not commit to a navigation nobody has agreed to yet. Same call the
  // filter sheet makes, for the same reason.
  $('pick-close').focus();
}

/**
 * Close it and hand the picker back.
 *
 * The stopRoll() here is what makes dismissing the sheet the way to draw again:
 * the button is disabled from the moment it is tapped until this runs.
 *
 * `{ focus: false }` on the "Check it out" path only — the spot's own screen is
 * about to take focus, and putting it back on the picker first makes a screen
 * reader announce a control that is already sliding away.
 */
function closePickSheet(opts) {
  const ov = $('spots-pick-modal');
  if (ov.hidden || !ov.classList.contains('is-open')) return;   // already closing/closed
  ov.classList.remove('is-open');
  $('spots-random').setAttribute('aria-expanded', 'false');
  setTimeout(() => { ov.hidden = true; }, 360);   // wait out the slide-down
  const restore = opts?.focus !== false;
  stopRoll();
  if (restore) $('spots-random').focus();
}

/** Hard reset, no animation — for sign-out, same as dropFilterSheet(). */
function dropPickSheet() {
  const ov = $('spots-pick-modal');
  ov.classList.remove('is-open');
  ov.hidden = true;
  $('spots-random').setAttribute('aria-expanded', 'false');
}

/** The one forward move out of the sheet. */
function checkOutPick() {
  const v = pickedVendor;             // read before closePickSheet clears it
  closePickSheet({ focus: false });
  // After the sheet has slid away rather than under it — the same beat
  // openVendor gets when the map sheet hands a spot over.
  if (v) setTimeout(() => openVendor(v.vendorId, TAB.spots), 260);
}

/**
 * Save or un-save a spot.
 *
 * Painted optimistically, because a heart that waits for a round trip feels
 * broken on a phone. The request sends the STATE WANTED (PUT to save, DELETE to
 * un-save) rather than a toggle, so a double-tap or a retry converges instead
 * of alternating. On failure the paint is reverted and a toast says so — a
 * silent revert reads as the tap not having registered.
 */
async function toggleFavorite(vendorId, row) {
  const id = String(vendorId);
  if (favoritePending.has(id)) return;          // a save is already in flight

  const v = allVendors.find((x) => String(x.vendorId) === id);
  if (!v) return;

  const want = !v.favorite;
  favoritePending.add(id);
  row.querySelector('.spot-heart')?.classList.add('is-busy');
  v.favorite = want;                            // optimistic, so the next render agrees
  paintSpotHeart(row, want, v.name);

  try {
    const res = await authFetch(`/api/me/favorites/${encodeURIComponent(id)}`, {
      method: want ? 'PUT' : 'DELETE',
    });
    if (!res.ok) throw new Error('FAVORITE_FAILED');
    // The response carries the full saved list, so the client never has to
    // guess what the server now believes — reconcile every row against it
    // rather than trusting the one we just painted.
    const { favorites } = await res.json();
    if (Array.isArray(favorites)) {
      const saved = new Set(favorites.map(String));
      allVendors.forEach((x) => { x.favorite = saved.has(String(x.vendorId)); });
      spotRows.forEach((r, rid) => {
        const rv = allVendors.find((x) => String(x.vendorId) === rid);
        if (rv) paintSpotHeart(r, Boolean(rv.favorite), rv.name);
      });
    }
  } catch {
    v.favorite = !want;                         // put it back
    paintSpotHeart(row, !want, v.name);
    // The same pill every other event uses, in its "lose" colour — a silent
    // revert reads as the tap never having registered.
    punchToast(want ? "Couldn't save that spot" : "Couldn't remove that spot", false);
  } finally {
    // Cleared BEFORE the re-render below, or renderSpots would skip this row's
    // heart — it deliberately leaves pending rows alone so an in-flight save is
    // not stomped by a socket push landing mid-tap.
    favoritePending.delete(id);
    row.querySelector('.spot-heart')?.classList.remove('is-busy');
    // Under the Favorites filter the heart decides MEMBERSHIP, not just the
    // icon: un-saving a spot means it no longer belongs in the list at all.
    // Re-render so the row leaves (and the empty state appears when it was the
    // last one) at a moment the student can connect to their own tap — without
    // this it lingered until some unrelated socket push happened to repaint,
    // which is the same outcome arriving at a random time.
    //
    // Only for this filter. Everywhere else the row's membership is unchanged
    // and the in-place heart paint above is the whole update, so a full
    // re-render would be wasted work that can also shift the scroll position.
    if (spotsFilter === 'favorites') renderSpots();
  }
}

// One filter per frame at most, same reasoning as the carousel's search.
let spotsSearchRaf = 0;
function onSpotsSearchInput() {
  if (spotsSearchRaf) return;
  spotsSearchRaf = requestAnimationFrame(() => {
    spotsSearchRaf = 0;
    spotsQuery = $('spots-search').value ?? '';
    renderSpots();
  });
}

/* ---------- the filter sheet ----------
   The pill's label does the work a closed <select> used to do for free: name
   what the list is currently showing, so a student who opens the tab to a short
   list can see why without opening anything. One name plus a count for the
   rest — three chip names would not fit the pill on any phone. */

function syncFilterPill() {
  const names = activeFilterNames();
  const btn = $('spots-filter-btn');
  const count = $('spots-filter-count');
  $('spots-filter-label').textContent = names[0] ?? 'Filter';
  // "+2", not "3": the label already accounts for the first one, and a bare 3
  // beside the word "Saved" reads as three saved spots.
  count.textContent = names.length > 1 ? `+${names.length - 1}` : '';
  count.hidden = names.length <= 1;
  btn.classList.toggle('is-on', names.length > 0);
  btn.setAttribute('aria-label', names.length
    ? `Filter spots. Showing ${names.join(', ')}.`
    : 'Filter spots');
}

/**
 * The cuisines worth offering: every tag the loaded spots actually carry.
 *
 * Union'd with what is already ticked, so a chip cannot disappear out from
 * under the filter it is applying — if the last coffee shop is deactivated
 * while Coffee is ticked, the chip has to stay visible or the student is left
 * with an empty list and no way to see why.
 */
function availableCuisines() {
  const seen = new Set(spotsCuisine);
  allVendors.forEach((v) => (v.cuisine ?? []).forEach((c) => seen.add(c)));
  // By label, not by slug: the student reads labels, and the vocabulary's own
  // order (src/lib/cuisines.js) is a server-side judgement the client can't see.
  return [...seen].sort((a, b) => cuisineLabel(a).localeCompare(cuisineLabel(b)));
}

/** True if any loaded spot has said what it costs (or a tier is ticked). */
function anyPriceTagged() {
  return spotsPrice.size > 0 || allVendors.some((v) => v.priceLevel != null);
}

// Chips are rebuilt only when the SET of them changes, not on every render:
// this runs on every socket push, and replacing the nodes each time would drop
// a chip mid-tap and lose focus inside an open sheet.
let cuisineChipSig = '';

function syncFilterSheet() {
  const cuisines = availableCuisines();
  const sig = cuisines.join(',');
  if (sig !== cuisineChipSig) {
    cuisineChipSig = sig;
    const box = $('filter-cuisine');
    box.innerHTML = '';
    cuisines.forEach((c) => {
      const label = document.createElement('label');
      label.className = 'filter-chip';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'spots-cuisine';
      input.value = c;
      const span = document.createElement('span');
      span.textContent = cuisineLabel(c);
      label.append(input, span);
      box.append(label);
    });
  }

  // A group with nothing in it is a promise the data can't keep — hide the
  // whole thing rather than show an empty row under a heading.
  $('filter-cuisine-group').hidden = cuisines.length === 0;
  $('filter-price-group').hidden = !anyPriceTagged();

  // Push state INTO the controls, so the sheet always opens agreeing with the
  // list. paintFilterChip carries the .is-on class the styling actually uses —
  // see the :has() note in styles.css.
  document.querySelectorAll('#spots-filter-modal input').forEach((el) => {
    if (el.name === 'spots-show') el.checked = el.value === spotsFilter;
    else if (el.name === 'spots-cuisine') el.checked = spotsCuisine.has(el.value);
    else if (el.name === 'spots-price') el.checked = spotsPrice.has(Number(el.value));
    el.closest('.filter-chip')?.classList.toggle('is-on', el.checked);
  });

  $('filter-clear').hidden = activeFilterCount() === 0;

  // The footer button counts what the student would be left with, so the sheet
  // answers "how many" before they dismiss it to find out. shownSpots() is the
  // same list renderSpots() mounts, so this number and the rows behind the
  // sheet cannot disagree.
  const n = shownSpots().length;
  $('filter-done').textContent = n === 1 ? 'Show 1 spot' : `Show ${n} spots`;
}

function readFilterSheet() {
  spotsCuisine.clear();
  spotsPrice.clear();
  document.querySelectorAll('#spots-filter-modal input:checked').forEach((el) => {
    if (el.name === 'spots-show') spotsFilter = el.value;
    else if (el.name === 'spots-cuisine') spotsCuisine.add(el.value);
    else if (el.name === 'spots-price') spotsPrice.add(Number(el.value));
  });
}

// Applied LIVE, with no Apply button: the list is one tap behind the sheet on a
// phone, and making every adjustment cost two taps and a guess is worse than
// re-rendering a list that is already cheap to re-render (rows are pooled).
function onFilterChange() {
  readFilterSheet();
  renderSpots();
  // The list under the sheet just became a different list, so being scrolled to
  // where row 30 used to be is meaningless. Same reason applyVendorFilter
  // resets the carousel on a query change.
  $('tab-spots').scrollTop = 0;
}

function openFilterSheet() {
  syncFilterSheet();
  const ov = $('spots-filter-modal');
  ov.hidden = false;
  void ov.offsetWidth;              // reflow so the slide-up transition runs
  ov.classList.add('is-open');
  $('spots-filter-btn').setAttribute('aria-expanded', 'true');
  // Focus lands INSIDE the dialog, or a keyboard student's next Tab walks the
  // page behind it. The close button rather than the first chip: landing on a
  // radio would announce the group as if it were the point of opening.
  $('filter-close').focus();
}

function closeFilterSheet() {
  const ov = $('spots-filter-modal');
  if (ov.hidden || !ov.classList.contains('is-open')) return;   // already closing/closed
  ov.classList.remove('is-open');
  $('spots-filter-btn').setAttribute('aria-expanded', 'false');
  // Focus back on the control that opened it — a dialog that dumps focus onto
  // <body> leaves a keyboard student at the top of the document.
  $('spots-filter-btn').focus();
  setTimeout(() => { ov.hidden = true; }, 360);   // wait out the slide-down
}

// Hard reset, no animation — for sign-out, same reason as dropMoveSheet().
function dropFilterSheet() {
  const ov = $('spots-filter-modal');
  ov.classList.remove('is-open');
  ov.hidden = true;
  $('spots-filter-btn').setAttribute('aria-expanded', 'false');
}

function clearFilters() {
  spotsFilter = 'all';
  spotsCuisine.clear();
  spotsPrice.clear();
  renderSpots();                    // repaints the chips through syncFilterSheet
  $('tab-spots').scrollTop = 0;
}

function wireSpots() {
  $('spots-filter-btn').addEventListener('click', openFilterSheet);
  $('filter-close').addEventListener('click', closeFilterSheet);
  $('filter-done').addEventListener('click', closeFilterSheet);
  $('filter-clear').addEventListener('click', clearFilters);
  // Backdrop only, not the card — the same dismiss every other overlay here has.
  $('spots-filter-modal').addEventListener('click', (e) => {
    if (e.target === $('spots-filter-modal')) closeFilterSheet();
  });
  // Delegated: the cuisine chips are rebuilt whenever the catalogue's tag set
  // changes, so listeners bound to the inputs would have to be rebound with them.
  $('spots-filter-modal').addEventListener('change', onFilterChange);

  $('spots-search').addEventListener('input', onSpotsSearchInput);
  $('spots-search-clear').addEventListener('click', () => {
    $('spots-search').value = '';
    spotsQuery = '';
    renderSpots();
    $('spots-search').focus();
  });

  // Delegated on the PAGE, not on #spots-list. Rows live in two containers —
  // the NEW strip and the main list — and a listener on the list alone is deaf
  // to every row in the strip, which made both the heart and the row tap dead
  // there. Binding one level up covers both, and covers any container added
  // later without this having to be remembered again. Everything above a row
  // (the search field, the filter pill) fails the .spot-row test and falls
  // through untouched.
  // Its own listener rather than another branch in the row delegation below:
  // the button is not a .spot-row and would fall straight through it.
  randomIdleLabel = $('spots-random-label').textContent;
  $('spots-random').addEventListener('click', pickRandomSpot);
  $('pick-close').addEventListener('click', () => closePickSheet());
  $('pick-go').addEventListener('click', checkOutPick);
  // Backdrop only, not the card — the same dismiss every other overlay here has.
  $('spots-pick-modal').addEventListener('click', (e) => {
    if (e.target === $('spots-pick-modal')) closePickSheet();
  });

  $('spots').addEventListener('click', (e) => {
    const row = e.target.closest('.spot-row');
    if (!row) return;
    if (e.target.closest('.spot-heart')) {
      // The heart is inside the row's hit area, so this must not also drill in.
      e.stopPropagation();
      void toggleFavorite(row.dataset.id, row);
      return;
    }
    openVendor(row.dataset.id, TAB.spots);
  });

  // role="button" carries no built-in keyboard activation, so it has to be
  // written out — Enter and Space, matching what a real <button> does. Same
  // page-level delegation, for the same reason.
  $('spots').addEventListener('keydown', (e) => {
    const row = e.target.closest?.('.spot-row');
    if (!row || e.target !== row) return;
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    openVendor(row.dataset.id, TAB.spots);
  });
}

/** Sign-out unpaint: the next student must not read the previous one's list. */
function resetSpots() {
  // Before anything else: a roll left running would fire into the next
  // student's session and open a spot off the previous one's list.
  stopRoll();
  $('spots-random').hidden = true;
  spotsQuery = '';
  spotsFilter = 'all';
  spotsCuisine.clear();
  spotsPrice.clear();
  dropFilterSheet();                  // may be open over the landing page
  dropPickSheet();                    // …and so may the random pick
  // The chips keep their own checked state, and the signature guard would skip
  // rebuilding them for the next student if the tag set happened to match.
  cuisineChipSig = '';
  $('filter-cuisine').innerHTML = '';
  syncFilterPill();
  const input = $('spots-search');
  if (input) input.value = '';
  spotRows.forEach((row) => row.remove());
  spotRows.clear();
  favoritePending.clear();
  $('spots-new').hidden = true;      // …including the NEW strip's rows, which share the pool
  $('spots-list').hidden = true;
  $('spots-skel').hidden = false;
  $('spots-empty').hidden = true;
  $('spots-search-clear').hidden = true;
}

/* ---------- Home's carousel: recent spots, or a recommendation ----------
   The row used to be every vendor in the app, ordered by the date each one
   signed up — so at twenty spots a student's daily coffee shop could sit at
   card seventeen, behind sixteen places they had never been. It is now the
   places they actually go.

   Two modes, decided by the data rather than by a setting:

     RECENT — anything with activity in the last 7 days (the server's `recent`
       flag: bought, redeemed, scanned a receipt, or collected a visit).
     RECOMMENDED — the fallback when there is no recent activity at all, which
       is every brand-new student and anyone back from a break. Shows the five
       most-visited spots, so the first screen of the app is never empty.

   Saved spots (the heart on the Spots tab) sort to the front of the recent row.
   They do not ADD to it — a spot you saved but haven't been to in a month
   belongs in the directory, not in a row that claims to be recent. */
const RECOMMENDED_HEADING = 'RECOMMENDED';
const RECENT_HEADING = 'RECENT SPOTS';

/**
 * The vendors the carousel shows, and what to call the row.
 * Returns { list, heading, mode }.
 *
 * Pure, and it stays pure: `homeLens` is READ here and only ever written by the
 * menu's own handlers (pickHomeLens / resetVendorRow). A student who asked for
 * RECENT and then went quiet for a week self-heals below — the empty recent set
 * falls through to the recommendations rather than the lens being rewritten out
 * from under them, so the choice comes back the moment they shop again.
 */
function recentVendors() {
  // Asked for recommendations explicitly: skip the recent branch entirely,
  // however much activity there is.
  const recent = homeLens === 'recommended' ? [] : allVendors.filter((v) => v.recent);
  if (recent.length) {
    // Saved first, then the rest; alphabetical within each group so the order
    // is stable between loads rather than reshuffling on every socket push.
    const sorted = recent.slice().sort((a, b) => {
      const fav = Number(Boolean(b.favorite)) - Number(Boolean(a.favorite));
      return fav || spotsOrder(a, b);
    });
    return { list: sorted, heading: RECENT_HEADING, mode: 'recent' };
  }

  // No recent activity — show the Recommended list instead. recommendedList()
  // handles the small-catalogue and top-up rules, and is the same function the
  // Spots tab's "Top" filter uses, so the two surfaces can never disagree.
  // Its final fallback covers a brand-new deployment with nothing ranked and
  // nothing new: better the whole list than an empty carousel, since "check
  // back soon" is wrong when spots plainly exist.
  const list = recommendedList();
  return {
    list: list.length ? list : allVendors.slice().sort(spotsOrder),
    heading: RECOMMENDED_HEADING,
    mode: 'recommended',
  };
}

/* ---------- home: fitting one screen ----------
 * Home is built to fit a phone exactly once (see .home-main's gap arithmetic in
 * styles.css) and degrades to scrolling rather than clipping when it can't. On
 * a short phone it can't: at 8 spots the blocks add up to ~655px, and an
 * iPhone SE gives the scroller 606px — worse in mobile Safari, and worse again
 * with the install nudge up.
 *
 * The earn actions are what gives. Ranked (a full-width earn code over a shared
 * row) they are 145-167px; collapsed to one row of three they are 88px. That is
 * the whole of .is-flat.
 *
 * Why a measurement and not @media (max-height): #app is `height: 100vh` with a
 * `100dvh` after it, and dvh is dead below Safari 15.4 (the CSS floor is 13.1),
 * so in mobile Safari the layout is laid out to the FULL screen height while the
 * URL bar covers the bottom ~110px of it. A height query would report 667 on a
 * phone showing 553. The scroll container's own clientHeight does not lie.
 */
const HOME_OVERFLOW_TOLERANCE = 24;   // px of scroll not worth reshaping the screen for

function syncHomeDensity() {
  const page = $('tab-home');
  const actions = document.querySelector('.home-actions');
  if (!page || !actions) return;
  // Shell still hidden (landing page, consent gate, cold boot): everything
  // measures zero, which would read as "fits" and drop a collapse that was
  // right. Leave the class alone and wait to be called again from render().
  if (!page.clientHeight) return;
  // Measure in the RANKED form every time, then decide. Reading the collapsed
  // height would be reading the consequence of the last decision: the row would
  // fit, un-collapse, stop fitting, re-collapse, and flip on every resize.
  actions.classList.remove('is-flat');
  const overflow = page.scrollHeight - page.clientHeight;   // forces the layout we need
  actions.classList.toggle('is-flat', overflow > HOME_OVERFLOW_TOLERANCE);
}

function renderVendors() {
  // First, and before anything measures: applyVendorFilter() ends in
  // renderVendorDots(), which reads the carousel's geometry back off the page.
  showVendorSkeleton(false);
  syncVendorCards();
  buildVendorIndex();
  applyVendorFilter();          // …which ends in syncHomeLens(), so the heading follows the data
  // The directory shares allVendors with the carousel, so it repaints on the
  // same data — including every socket-driven balance push.
  renderSpots();
  // The map's own entry point and, if the screen happens to be open, its badges.
  // Both are cheap no-ops when there is nothing to change, which matters: this
  // runs on every socket push, not just the first load.
  syncMapButton();
  refreshMapPins();
  // Last: the carousel's own height is part of what decides this, so it has to
  // be measured after the row it pages through exists.
  syncHomeDensity();
}

// The one place the visible row is decided. `reset` is for a lens change: the
// list under the finger just became a different list, so being parked on card 7
// of the old one is meaningless — go back to the start. A socket push must NOT
// pass it, or an award landing while you browse would yank you to the first card.
function applyVendorFilter(reset = false) {
  const wrap = $('vendor-carousel');
  const { list, heading, mode } = recentVendors();
  shownVendors = list;
  $('home-sub-label').textContent = heading;
  syncHomeLens(mode);
  paintVendorRow();
  wrap.classList.toggle('single', shownVendors.length === 1);   // lone vendor → full width

  const empty = $('vendors-empty');
  empty.hidden = shownVendors.length > 0;
  // `allVendors.length` guarded, not just `shownVendors`: loadVendors' catch
  // writes a connection error into this same element WITHOUT going through
  // render(), and overwriting it with a claim about the catalogue would turn a
  // true "check your connection" into a false "there are no spots".
  if (!shownVendors.length && allVendors.length === 0) {
    empty.textContent = 'No spots yet, check back soon!';
  }

  if (reset) wrap.scrollLeft = 0;   // before the dots: they read the row back
  renderVendorDots();               // the pager rebuilds with the row it pages through
}

/* ---------- home: which list, and who decides ----------
   The row has two possible contents — the spots you have been to lately, and a
   set of recommendations — and until now the DATA chose, permanently: one
   purchase flipped a student to RECENT and there was no way back to
   RECOMMENDED for as long as they kept shopping. That is fine as a default and
   wrong as a rule, so the heading became the control.

   `homeLens` is the override and null is the normal state, which is what keeps
   the default behaviour intact for a student who never opens the menu.

   The menu is only offered when there is something to switch BETWEEN. A student
   with no recent activity has one meaningful list, and a picker whose second
   option produces an empty carousel is worse than no picker — same rule the
   Spots tab's cuisine group follows ("a group with nothing in it is a promise
   the data can't keep"). */

/** True when the student has spots the RECENT list would actually contain. */
const hasRecentSpots = () => allVendors.some((v) => v.recent);

// Paints the heading's control state. Runs from applyVendorFilter, so it is
// re-evaluated on every socket push — which is exactly when a last visit can
// age out of the 7-day window and take the choice away again.
//
// `mode` is what recentVendors() actually RESOLVED to, not what homeLens asked
// for, and the difference is the whole reason it is a parameter. A student who
// picked Recent and then went quiet for a week still has homeLens === 'recent'
// while the row has fallen through to the recommendations — ticking "Recent
// spots" there would have the menu disagree with the heading directly above it.
function syncHomeLens(mode) {
  const offered = hasRecentSpots();
  const btn = $('home-sub');
  btn.classList.toggle('is-static', !offered);
  btn.setAttribute('aria-haspopup', offered ? 'true' : 'false');
  // The menu can be up when the last recent spot ages out from under it. Close
  // it rather than leave a menu whose owner has stopped being a menu button.
  // Focus goes back to the heading, which is still there, so this cannot strand
  // a keyboard or switch user on an element that just became display:none.
  if (!offered && !$('home-lens-menu').hidden) closeHomeLensMenu(true);
  Array.from($('home-lens-menu').children).forEach((item) => {
    item.setAttribute('aria-checked', item.dataset.lens === mode ? 'true' : 'false');
  });
}

function toggleHomeLensMenu() {
  if ($('home-lens-menu').hidden) openHomeLensMenu();
  else closeHomeLensMenu();
}

function openHomeLensMenu() {
  if (!hasRecentSpots()) return;    // nothing to switch between; the heading is just a heading
  $('home-lens-menu').hidden = false;
  $('home-sub').setAttribute('aria-expanded', 'true');
}

function closeHomeLensMenu(refocus = false) {
  if ($('home-lens-menu').hidden) return;
  $('home-lens-menu').hidden = true;
  $('home-sub').setAttribute('aria-expanded', 'false');
  // Only on a deliberate dismiss (Esc, a pick). A tap elsewhere on the page has
  // already decided where focus belongs, and yanking it back to the heading
  // would undo that.
  if (refocus) $('home-sub').focus();
}

function pickHomeLens(lens) {
  if (lens !== 'recent' && lens !== 'recommended') return;
  homeLens = lens;
  closeHomeLensMenu(true);
  applyVendorFilter(true);          // a different list — start at card 1
  // Written ONLY here. The cards swap silently, and this is the one moment a
  // student asked for that to happen, so it is the one moment worth saying it
  // out loud; on every other repaint the region stays quiet.
  const n = shownVendors.length;
  $('home-spots-status').textContent =
    `${$('home-sub-label').textContent.toLowerCase()}, ${n} ${n === 1 ? 'spot' : 'spots'}`;
}

/* ---------- searching the spots ----------
   The Spots tab's field, and the only search in the app now that Home's is gone
   (see index.html → .home-sub-row). It stays here, above the home code that used
   to be its first caller, because the ranking rules below were written against
   the vendor list and are read alongside it.

   The matching is an index, not a scan: an inverted index over the spot names
   and addresses, held in a trie keyed by character, so a keystroke costs the
   length of the word being typed instead of a pass over every vendor.

   Each token is inserted at every start position, not just at 0 — that is what
   makes "bucks" find Starbucks. It costs O(len^2) characters per token at BUILD
   time (once per vendor list, capped below) to buy an O(len) LOOKUP on every
   keystroke, which is the trade that matters: the build happens when the list
   arrives, the lookup happens while a thumb is moving.

   Every node carries the set of vendors reachable through it, so a prefix walk
   ends holding the answer with no subtree to collect. Multi-word queries
   intersect those sets smallest-first, so "star camp" costs the size of the
   rarer word, not the sum.

   Ranking then runs over MATCHES ONLY — never the full list — which is why the
   .some() calls in scoreVendor are not the for-loop this is meant to replace. */

const SEARCH_SUFFIX_CAP = 24;  // start positions indexed per token (a bound on the O(len^2))
// Fold to a comparable form: case and accents are not something a student typing
// one-handed should have to match ("Café" and "cafe" are the same shop).
const SEARCH_SPLIT = /[^\p{L}\p{N}]+/u;
const searchFold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const searchTokens = (s) => searchFold(s).split(SEARCH_SPLIT).filter(Boolean);

// The address, tokenised for the index, with every compass word carrying BOTH
// its spellings. The card shows "E College Ave" (formatAddress, above) while the
// column may well hold "East College Ave", or the other way round — so a student
// typing what they can see has to find the shop either way. Indexing both is a
// build-time cost paid once per vendor list; the alternative is rewriting the
// query on every keystroke, and that only works in one direction.
const ADDR_SEARCH_ALIAS = { east: 'e', west: 'w', north: 'n', south: 's', e: 'east', w: 'west', n: 'north', s: 'south' };
function addressSearchTokens(address) {
  const tokens = searchTokens(address);
  const out = tokens.slice();
  tokens.forEach((t) => {
    const alias = ADDR_SEARCH_ALIAS[t];
    if (alias && !out.includes(alias)) out.push(alias);
  });
  return out;
}

const trieNode = () => ({ kids: new Map(), ids: new Set() });
// recs[i] describes allVendors[i]: folded name, its words, and the address's.
const vendorIndex = { root: trieNode(), recs: [], sig: '' };

function trieAdd(root, token, id) {
  const chars = [...token];   // by code point: an emoji in a shop name is one key, not two
  const starts = Math.min(chars.length, SEARCH_SUFFIX_CAP);
  for (let s = 0; s < starts; s += 1) {
    let node = root;
    for (let k = s; k < chars.length; k += 1) {
      let next = node.kids.get(chars[k]);
      if (!next) { next = trieNode(); node.kids.set(chars[k], next); }
      next.ids.add(id);
      node = next;
    }
  }
}

// The set of vendors whose name or address contains `term`, or null if nothing does.
function trieFind(root, term) {
  let node = root;
  for (const ch of term) {
    node = node.kids.get(ch);
    if (!node) return null;
  }
  return node.ids;
}

// Rebuilt only when the SPOTS change, not when their balances do — loadVendors()
// runs on every punch push and every reconnect, and re-indexing there would be
// pure waste.
function buildVendorIndex() {
  const sig = JSON.stringify(allVendors.map((v) => [v.vendorId, v.name, v.address ?? '']));
  if (sig === vendorIndex.sig) return;
  const root = trieNode();
  const recs = allVendors.map((v, i) => {
    const nameTokens = searchTokens(v.name);
    const addrTokens = addressSearchTokens(v.address);
    nameTokens.forEach((t) => trieAdd(root, t, i));
    addrTokens.forEach((t) => trieAdd(root, t, i));
    // "Joe's Coffee" is two tokens to a tokenizer and one word to anyone typing
    // "joes", so the punctuation-free run gets indexed too — otherwise the
    // apostrophe is a wall you can only get past by guessing it's there.
    const squashed = nameTokens.join('');
    if (nameTokens.length > 1) trieAdd(root, squashed, i);
    return { flat: nameTokens.join(' '), squashed, nameTokens, addrTokens };
  });
  vendorIndex.root = root;
  vendorIndex.recs = recs;
  vendorIndex.sig = sig;
}

// AND across the query's words, intersecting the smaller set into the larger.
function searchVendorIds(terms) {
  let acc = null;
  for (const term of terms) {
    const ids = trieFind(vendorIndex.root, term);
    if (!ids || !ids.size) return [];
    if (acc === null) { acc = ids; continue; }   // never mutated: it may BE an index node's set
    const [small, big] = acc.size <= ids.size ? [acc, ids] : [ids, acc];
    const next = new Set();
    small.forEach((id) => { if (big.has(id)) next.add(id); });
    if (!next.size) return [];
    acc = next;
  }
  return acc === null ? [] : [...acc];
}

// What "best match" means here, in order: the whole query leads the name, then a
// word of the name starts with it, then it appears anywhere in the name, then
// the address. Runs per match, never per vendor.
function scoreVendor(rec, terms, joined, squashed) {
  let score = rec.flat.startsWith(joined) || rec.squashed.startsWith(squashed) ? 100 : 0;
  for (const term of terms) {
    if (rec.nameTokens.some((t) => t.startsWith(term))) score += 10;
    else if (rec.squashed.includes(term)) score += 5;
    else if (rec.addrTokens.some((t) => t.startsWith(term))) score += 2;
  }
  return score;
}

function filterVendors(query) {
  const terms = searchTokens(query);
  if (!terms.length) return allVendors.slice();   // no query: the row is the whole list
  buildVendorIndex();                             // no-op unless the spots changed
  const ids = searchVendorIds(terms);
  if (!ids.length) return [];
  // Both spellings of the query, so a name is ranked by whichever way the
  // student happened to type it — "joe s" and "joes" both lead Joe's Coffee.
  const joined = terms.join(' ');
  const squashed = terms.join('');
  return ids
    .map((i) => ({ i, score: scoreVendor(vendorIndex.recs[i], terms, joined, squashed) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)   // ties keep the server's order
    .map((m) => allVendors[m.i]);
}

// Sign-out: the next student must not find the last one's spots — the same
// reason dropHistory() unpaints the activity list.
function resetVendorRow() {
  homeLens = null;
  closeHomeLensMenu();
  // The live region is written on a pick and never cleared by one, so without
  // this the next student signs in to the previous one's spot count sitting in
  // a role="status" node.
  $('home-spots-status').textContent = '';
  vendorCards.forEach((card) => card.remove());
  vendorCards.clear();
  vendorIndex.root = trieNode();
  vendorIndex.recs = [];
  vendorIndex.sig = '';
  shownVendors = [];
  renderVendorDots();
  showVendorSkeleton(true);   // back to first-load state for whoever signs in next
}

/* ---------- carousel page dots ----------
   At most DOT_CAP dots are in the DOM at once, showing a window onto the full
   list. The rule the whole thing hangs off: the active dot is never a window
   edge unless it is genuinely the first or last spot — i.e. there is always one
   dot of lookahead in the direction you are heading. Walking onto the
   second-to-last dot is therefore what pushes the window along by one.

   That invariant also keeps the window from juddering: the band it accepts is
   DOT_CAP - 2 wide, so crossing back over a boundary you just crossed does not
   shift it back. And because a shrunken edge dot can never be the active one,
   .is-active and .is-edge never land on the same dot. */

const DOT_CAP = 8;          // most dots on screen at once
const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Where the window should start, given the active index and where it starts now.
function dotWindowStart(n, i, prevStart) {
  if (n <= DOT_CAP) return 0;                     // whole list fits: no window
  let s = clampNum(prevStart, 0, n - DOT_CAP);    // prevStart can be stale after n changed
  if (i < s + 1) s = i - 1;                       // walked off the left lookahead
  else if (i > s + DOT_CAP - 2) s = i - DOT_CAP + 2;
  return clampNum(s, 0, n - DOT_CAP);
}

// Rebuilt with the carousel. Note that emptying and refilling the scroller in one
// task does NOT reset its scrollLeft — the browser never lays out against the empty
// element, so it never clamps the offset, and no scroll event fires either. The
// card on screen therefore survives a rebuild and the active dot has to be read
// back from the scroller rather than assumed (see below).
function renderVendorDots() {
  cancelAnimationFrame(dotsRaf); dotsRaf = 0;   // a frame queued against the old cards
  endDotJump();
  dotSnaps = [];                                 // dirty; measured on demand, see syncDots
  const row = $('vendor-dots');
  const wrap = $('vendor-carousel');
  const n = shownVendors.length;
  row.hidden = n < 2;                            // 0 or 1 spots: nothing to page through
  row.innerHTML = '';
  dotStart = 0;
  dotActive = 0;
  if (n < 2) return;

  // Read the carousel's position back rather than assuming it reset. Emptying a
  // scroller does NOT reliably zero scrollLeft when it is refilled in the same
  // task, so after backing out of a vendor screen (loadVendors → renderVendors)
  // the card on screen is still the one you left from — and defaulting to 0 lit
  // the first dot while a different card was in view.
  // Guarded on the carousel having a width: this also runs from socket pushes
  // while #home is hidden, where [hidden] makes every offset read 0. In that case
  // dotSnaps stays dirty and the first scroll (or the next rebuild, once home is
  // back on screen) corrects it.
  if (wrap.clientWidth > 0) {
    measureDotSnaps();
    dotActive = activeFromScroll();
    dotStart = dotWindowStart(n, dotActive, dotActive - Math.floor(DOT_CAP / 2));
  }

  for (let k = dotStart; k < Math.min(n, dotStart + DOT_CAP); k += 1) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vdot';
    b.dataset.i = k;
    // The circle is a real element rather than a ::before on the button: iOS
    // Safari can leave a pseudo-element holding its previous paint when the
    // parent's class changes, which left every dot you scrolled past still
    // wearing the active look. A real child repaints reliably.
    const circle = document.createElement('span');
    circle.className = 'vdot-i';
    b.appendChild(circle);
    row.appendChild(b);
  }
  paintDots();
}

// Classes + labels only, never innerHTML: this runs on every scroll frame, and
// rebuilding would drop focus and restart the transitions mid-flight.
function paintDots() {
  const n = shownVendors.length;
  const dots = $('vendor-dots').children;
  // More list past the window on this side → that edge dot shrinks. Both can.
  const shrinkLeft = n > DOT_CAP && dotStart > 0;
  const shrinkRight = n > DOT_CAP && dotStart + DOT_CAP < n;
  for (let d = 0; d < dots.length; d += 1) {
    const k = dotStart + d;
    const b = dots[d];
    b.dataset.i = k;
    b.classList.toggle('is-active', k === dotActive);
    b.classList.toggle('is-edge', (d === 0 && shrinkLeft) || (d === dots.length - 1 && shrinkRight));
    if (k === dotActive) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
    // Only the windowed dots exist, so the label is what carries the real count.
    b.setAttribute('aria-label', `${shownVendors[k]?.name ?? 'Spot'}, spot ${k + 1} of ${n}`);
  }
}

// The scrollLeft each card actually parks at, mirroring the alignment styles.css
// hands it: the first card to the start gutter (0), the last to the end gutter
// (the maximum scroll), and every card between them to the middle of the view.
// Measured off live rects rather than offsetLeft — a .vendor-card's offsetParent
// is not the scroller, and the centred case needs the card's width and the
// viewport's, not just an offset. Reading `left` for both and subtracting keeps
// it correct under the pane's slide transform, which shifts the pair together.
// Deferred until the carousel is actually on screen: renderVendors() also runs
// from socket pushes while #home is hidden, and [hidden] makes every rect 0.
function measureDotSnaps() {
  const wrap = $('vendor-carousel');
  const cards = [...wrap.querySelectorAll('.vendor-card')];
  const max = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
  const mid = wrap.getBoundingClientRect().left + wrap.clientWidth / 2;
  dotSnaps = cards.map((c, k) => {
    if (k === 0) return 0;
    if (k === cards.length - 1) return max;
    const r = c.getBoundingClientRect();
    // Clamped for the same reason the ends are special-cased: a card close to
    // either end may not have the room to reach the true centre.
    return clampNum(wrap.scrollLeft + r.left + r.width / 2 - mid, 0, max);
  });
}

// Nearest snap wins — an argmin, never an equality test, so scroll-snap's
// fractional scrollLeft is fine.
function activeFromScroll() {
  const x = $('vendor-carousel').scrollLeft;
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < dotSnaps.length; k += 1) {
    const d = Math.abs(x - dotSnaps[k]);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

function onCarouselScroll() {
  if (dotsRaf) return;                    // coalesce a burst of scroll events into one frame
  dotsRaf = requestAnimationFrame(() => { dotsRaf = 0; syncDots(); });
}

function syncDots() {
  const n = shownVendors.length;
  if (n < 2) return;
  if (dotSnaps.length !== n) measureDotSnaps();
  const i = activeFromScroll();
  // A tapped-dot scroll fires `scroll` across every card on the way; the dots
  // already show the destination, so ignore what's under us until it lands.
  if (dotJump !== null) { if (i === dotJump) endDotJump(); return; }
  if (i === dotActive) return;            // nothing moved: no DOM writes
  dotActive = i;
  dotStart = dotWindowStart(n, i, dotStart);
  paintDots();
}

// Re-derive the active dot from where the carousel actually sits, ignoring the
// tapped-dot guard. Idempotent, and a no-op while #home is hidden — [hidden]
// makes every offset read 0, and measuring then would poison dotSnaps with a
// full-length row of zeros that nothing would ever re-measure.
function dotsFromScroll() {
  const n = shownVendors.length;
  if (n < 2) return;
  const wrap = $('vendor-carousel');
  if (!wrap.clientWidth) return;
  if (dotSnaps.length !== n) measureDotSnaps();
  dotActive = activeFromScroll();
  dotStart = dotWindowStart(n, dotActive, dotStart);
  paintDots();
}

// Release the tapped-dot guard, whichever way the jump ended, and take that
// jump's listeners with it — scrollend is not universal, so a `once` listener
// waiting on it would otherwise pile up one per tap on the browsers that lack it.
// `resync` re-reads the carousel: an INTERRUPTED jump (wheel-scrolled away
// mid-flight, or a finger that cancelled the smooth scroll) never reaches its
// target, so every scroll event on the way was swallowed by the guard and
// dotActive is left pointing at a card that is no longer on screen.
function endDotJump(resync = false) {
  dotJump = null;
  clearTimeout(dotJumpTimer);
  dotJumpTimer = null;
  dotJumpAbort?.abort();
  dotJumpAbort = null;
  if (resync) dotsFromScroll();
}

function onDotTap(e) {
  const btn = e.target.closest('.vdot');
  if (!btn) return;
  const k = Number(btn.dataset.i);
  if (!Number.isInteger(k) || k < 0 || k >= shownVendors.length) return;
  const wrap = $('vendor-carousel');
  if (dotSnaps.length !== shownVendors.length) measureDotSnaps();   // on screen by now
  endDotJump();                           // supersede a jump still in flight
  dotJump = k;
  dotActive = k;
  dotStart = dotWindowStart(shownVendors.length, k, dotStart);
  paintDots();                            // the dots lead, the scroll follows
  const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  wrap.scrollTo({ left: dotSnaps[k] ?? 0, behavior: smooth ? 'smooth' : 'auto' });
  // The jump may never land exactly on the target (see activeFromScroll), and a
  // finger on the carousel cancels the browser's smooth scroll outright — so
  // release on either, with the timer as the backstop that always fires.
  dotJumpAbort = new AbortController();
  const { signal } = dotJumpAbort;
  const release = () => endDotJump(true);   // re-read the carousel: the jump may have been cut short
  wrap.addEventListener('scrollend', release, { once: true, signal });
  wrap.addEventListener('touchstart', release, { once: true, passive: true, signal });
  wrap.addEventListener('wheel', release, { once: true, passive: true, signal });   // trackpad/mouse has no touchstart
  dotJumpTimer = setTimeout(release, 700);
}

// Live-patch just the points number on a card (used by socket pushes on home).
// Straight off the pool rather than a scan of the row: a card filtered out by a
// search is still that student's card, and it has to be right the moment the
// query is cleared — not a loadVendors() later.
function patchVendorCard(vendorId, next) {
  const num = vendorCards.get(String(vendorId))?.querySelector('.vc-num');
  if (num) num.textContent = next;
}

/* ==================== the spots map ====================
   A full-screen Leaflet map of every vendor that has coordinates. It opens two
   ways: the 🗺️ in the YOUR SPOTS row (all pins, nothing focused) or a tap on a
   card's map thumbnail (that vendor centred, its sheet already up).

   The map is walled to the vendors' own extent — pan hits a hard edge just past
   the outermost pin instead of letting someone flick off to the Atlantic and
   wonder where the app went. Nothing here is keyed or metered: Leaflet is
   self-hosted (public/student/leaflet/) and the tiles are the same keyless
   tile.openstreetmap.org the card thumbnails already pull from, so the whole
   screen costs nothing and needs no account. */

const MAP_MAX_ZOOM = 18;      // deepest zoom we ask OSM for (19 exists but is patchy)
const MAP_FOCUS_ZOOM = 17;    // "this one, right here" when opening from a card
const MAP_VIEW_PAD = 0.22;    // breathing room around the pins when fully zoomed out
const MAP_MIN_SPAN = 0.008;   // ~900m: the smallest world one lone spot may own
const MAP_PIN_W = 40;         // must match .mp-body in styles.css
const MAP_PIN_H = 48;         // ...and the bottom of .mp-tip, which is the anchor

let spotsMap = null;             // the Leaflet map, built once on first open
let mapPins = null;              // L.LayerGroup holding every vendor marker
const mapMarkers = new Map();    // vendorId -> L.Marker, for lookups by id
let mapWall = null;              // the LatLngBounds panning is clamped to
let mapFocusId = null;           // vendor whose pin is highlighted (null = none)
let mapPinId = null;             // vendor whose sheet is showing
let mapMe = null;                // the "you are here" marker, once located
let mapSheetTimer = null;        // pin-sheet slide-out, so it can be cut short
let mapNoteBase = '';            // the persistent note; flashes restore to this
let mapNoteTimer = null;

// A coordinate we can actually put on a map, or NaN.
//
// The null check is load-bearing and cannot be folded into Number.isFinite:
// Number(null) and Number('') are both 0, so a vendor with no coordinates would
// come back as a perfectly finite (0, 0) — a pin in the Gulf of Guinea, and a
// map walled to a box stretching from campus to the Atlantic.
function mapCoord(x) {
  if (x == null || x === '') return NaN;
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

// A vendor we can actually put somewhere. One with no address (or one Nominatim
// could not geocode) has null coordinates — see src/lib/geocode.js.
function vendorMappable(v) {
  return !!v && !Number.isNaN(mapCoord(v.latitude)) && !Number.isNaN(mapCoord(v.longitude));
}

function mappableVendors() {
  return allVendors.filter(vendorMappable);
}

// The 🗺️ is pointless with nothing to show, so it only appears once at least one
// spot has coordinates. Called from renderVendors, i.e. on every balances load.
function syncMapButton() {
  const btn = $('map-open-btn');
  if (btn) btn.hidden = mappableVendors().length === 0;
}

// Same rule one spot down: "Show in map" can only ever open a map with THIS spot
// on it, so it goes away for a vendor with no coordinates rather than opening a
// map that quietly focuses nothing. Called from openVendor, so it is decided
// once per screen — coordinates do not move while the screen is up.
function syncVendorMapCta(v) {
  const bar = $('vendor-map-cta');
  if (bar) bar.hidden = !vendorMappable(v);
}

function mapScreenOpen() {
  return $('map-modal').classList.contains('is-open');
}

/* ---------- geometry ---------- */

// Grow `bounds` by `ratio` on each side, but never let it come out smaller than
// minSpanLat tall. Without that floor a single vendor (or two doors apart) makes
// a zero-area box, which fitBounds answers with the maximum zoom and a view of
// one rooftop. A degree of longitude shrinks with latitude, so the east-west
// floor is divided by cos(lat) — otherwise the smallest world is a letterbox.
function padBounds(bounds, ratio, minSpanLat) {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const midLat = (sw.lat + ne.lat) / 2;
  const midLng = (sw.lng + ne.lng) / 2;
  const minSpanLng = minSpanLat / Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const latSpan = Math.max(ne.lat - sw.lat, minSpanLat) * (1 + ratio * 2);
  const lngSpan = Math.max(ne.lng - sw.lng, minSpanLng) * (1 + ratio * 2);
  return L.latLngBounds(
    [Math.max(-85, midLat - latSpan / 2), Math.max(-180, midLng - lngSpan / 2)],
    [Math.min(85, midLat + latSpan / 2), Math.min(180, midLng + lngSpan / 2)]
  );
}

// Fit the pins, then decide the two limits that make the map finite:
//   minZoom — you cannot zoom out past the whole set of spots
//   maxBounds — you cannot pan past the edge of what that zoom shows
//
// The wall is read back off the map AFTER fitting rather than computed
// alongside `view`, and that ordering is the whole trick: getBoundsZoom floors
// to a whole zoom level, so what is actually on screen at full zoom-out is a
// little wider than `view`. Walling to `view` would leave the viewport larger
// than its own limit, and Leaflet resolves that contradiction by jamming the
// map into the wall's top-left corner. Measuring the real bounds instead makes
// the two agree by construction.
function frameMap(spots, focusId) {
  const view = padBounds(
    L.latLngBounds(spots.map((v) => [mapCoord(v.latitude), mapCoord(v.longitude)])),
    MAP_VIEW_PAD,
    MAP_MIN_SPAN
  );

  spotsMap.setMinZoom(0);          // ...or fitBounds cannot zoom out far enough to measure
  spotsMap.setMaxBounds(null);
  spotsMap.fitBounds(view, { animate: false });
  spotsMap.setMinZoom(spotsMap.getZoom());
  mapWall = spotsMap.getBounds().pad(0.02);   // the hair of slack keeps the edge off the outermost pin
  spotsMap.setMaxBounds(mapWall);

  const focus = focusId && spots.find((v) => String(v.vendorId) === focusId);
  if (!focus) return;
  // Clamped to minZoom: a single spot can leave the whole map zoomed further out
  // than FOCUS_ZOOM, and asking for a zoom below the floor is ignored anyway.
  const zoom = Math.max(spotsMap.getMinZoom(), MAP_FOCUS_ZOOM);
  spotsMap.setView([mapCoord(focus.latitude), mapCoord(focus.longitude)], zoom, { animate: false });
  // Bias the centre up by half the sheet, so the pin the student tapped is not
  // sitting underneath the card describing it. panBy moves the viewport down,
  // which moves the pin up the screen.
  const lift = mapSheetHeight() / 2;
  if (lift > 0) spotsMap.panBy([0, lift], { animate: false });
}

/* ---------- pins ---------- */

// 1240 -> "1.2k". A four-figure balance in a 20px badge is unreadable, and the
// exact number is one tap away in the sheet.
function shortPoints(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
}

// Array.from, not [0]: a name starting with an emoji or an astral character
// would otherwise be cut mid-surrogate and render as a replacement box.
function firstLetter(name) {
  const ch = Array.from(String(name ?? '').trim())[0] ?? '?';
  return ch.toUpperCase();
}

function pinHtml(v, focused) {
  const pts = Number(v.balance ?? 0);
  const cls = ['mp'];
  if (pts <= 0) cls.push('is-zero');     // still tappable, just quieter
  if (focused) cls.push('is-focus');
  const face = v.hasLogo
    ? `<span class="mp-body" style="background-image:url('/api/vendor-logo/${encodeURIComponent(v.vendorId)}')"></span>`
    : `<span class="mp-body"><span class="mp-initial">${escapeHtml(firstLetter(v.name))}</span></span>`;
  const badge = pts > 0 ? `<span class="mp-badge">${escapeHtml(shortPoints(pts))}</span>` : '';
  return `<span class="${cls.join(' ')}">${face}<span class="mp-tip"></span>${badge}</span>`;
}

// Rebuilt outright on every open rather than diffed like the vendor cards. The
// screen opens rarely and holds a handful of markers, so the pooling that the
// carousel needs (it rebuilds on every keystroke) would be complexity for
// nothing here; logo URLs are already in the browser cache either way.
function buildMapPins(spots) {
  mapPins.clearLayers();
  mapMarkers.clear();
  spots.forEach((v) => {
    const id = String(v.vendorId);
    const focused = id === mapFocusId;
    const marker = L.marker([mapCoord(v.latitude), mapCoord(v.longitude)], {
      icon: L.divIcon({
        // className replaces Leaflet's own 'leaflet-div-icon', which would
        // otherwise draw a white box with a grey border behind every pin.
        className: 'mp-wrap',
        html: pinHtml(v, focused),
        iconSize: [MAP_PIN_W, MAP_PIN_H],
        iconAnchor: [MAP_PIN_W / 2, MAP_PIN_H],   // the tip, not the middle
      }),
      title: v.name,
      riseOnHover: true,
      zIndexOffset: focused ? 1000 : 0,
    });
    marker.on('click', () => openPinSheet(id, true));
    // Leaflet gives the element a tabindex but no role and no name of its own,
    // so a screen reader would announce every pin as a bare focusable div.
    //
    // On 'add' rather than straight after addTo, and this ordering matters: a
    // map that has not been given a view yet is not "ready", and Leaflet queues
    // the whole layer-add — icon element included — until it is. frameMap() is
    // what sets the first view, so at addTo time getElement() is still null and
    // labelling there silently does nothing on the very first open.
    marker.on('add', () => {
      const el = marker.getElement();
      if (!el) return;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', `${v.name}, ${Number(v.balance ?? 0)} points`);
      // Re-assert the ring here for the same reason: setFocusPin runs while the
      // screen is opening, which is before this element exists. pinHtml bakes
      // the class in for the pin that opened the screen, but a pin tapped
      // during that window would otherwise never light up.
      el.querySelector('.mp')?.classList.toggle('is-focus', id === mapFocusId);
    });
    marker.addTo(mapPins);
    mapMarkers.set(id, marker);
  });
}

// Balances move while the screen is up (socket pushes land in loadVendors), so
// the badges are patched in place. Deliberately not a rebuild: re-creating the
// markers mid-view would drop the focus ring and re-request every logo.
function refreshMapPins() {
  if (!spotsMap || !mapScreenOpen()) return;
  mapMarkers.forEach((marker, id) => {
    const v = allVendors.find((x) => String(x.vendorId) === id);
    if (!v) return;
    const el = marker.getElement();
    const mp = el?.querySelector('.mp');
    if (!mp) return;
    const pts = Number(v.balance ?? 0);
    let badge = mp.querySelector('.mp-badge');
    if (pts > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'mp-badge';
        mp.appendChild(badge);
      }
      const next = shortPoints(pts);
      if (badge.textContent !== next) badge.textContent = next;
    } else if (badge) {
      badge.remove();
    }
    mp.classList.toggle('is-zero', pts <= 0);
    el.setAttribute('aria-label', `${v.name}, ${pts} points`);
  });
  if (mapPinId) {
    const v = allVendors.find((x) => String(x.vendorId) === mapPinId);
    if (v) $('map-pin-num').textContent = String(v.balance ?? 0);
  }
}

/* ---------- the note strip ---------- */

function paintMapNote(text) {
  const note = $('map-note');
  note.textContent = text;
  note.hidden = !text;
}

// The standing message ("2 spots aren't on the map yet"), which every transient
// one falls back to.
function setMapNote(text) {
  mapNoteBase = text;
  clearTimeout(mapNoteTimer);
  paintMapNote(text);
}

function flashMapNote(text) {
  clearTimeout(mapNoteTimer);
  paintMapNote(text);
  mapNoteTimer = setTimeout(() => paintMapNote(mapNoteBase), 5000);
}

/* ---------- the pin sheet ---------- */

function mapSheetHeight() {
  const sheet = $('map-pin-sheet');
  return sheet.hidden ? 0 : sheet.offsetHeight;
}

// The locate button and the OSM attribution both ride on this: the sheet's
// height depends on how far the address wraps, so it cannot be a constant in
// the stylesheet. The attribution is licence-required, so it gets moved out of
// the way rather than covered.
function syncMapSheetVar() {
  $('map-stage').style.setProperty('--map-sheet-h', `${mapSheetHeight()}px`);
}

function openPinSheet(vendorId, pan) {
  const id = String(vendorId);
  const v = allVendors.find((x) => String(x.vendorId) === id);
  if (!v) return;
  mapPinId = id;
  clearTimeout(mapSheetTimer);

  $('map-pin-name').textContent = v.name;
  $('map-pin-num').textContent = String(v.balance ?? 0);
  const addr = $('map-pin-address');
  addr.textContent = v.address ? `📍 ${shortAddress(v.address)}` : '';
  addr.hidden = !v.address;
  const rate = $('map-pin-rate');
  const rateText = earnRateText(v.pointsPerDollar);
  rate.textContent = rateText ? `Base rate: ${rateText}` : '';
  rate.hidden = !rateText;
  // Directions need an address to hand to the platform's maps app; a vendor
  // pinned from coordinates alone gets the rewards button on its own.
  $('map-pin-dir').hidden = !v.address;
  const logo = $('map-pin-logo');
  logo.hidden = !v.hasLogo;
  logo.style.backgroundImage = v.hasLogo
    ? `url('/api/vendor-logo/${encodeURIComponent(v.vendorId)}')`
    : '';
  if (v.hasLogo) logo.setAttribute('aria-label', `${v.name} logo`);

  const sheet = $('map-pin-sheet');
  sheet.hidden = false;
  void sheet.offsetWidth;              // reflow so the slide-up transition runs
  sheet.classList.add('is-open');
  syncMapSheetVar();

  // Whichever pin is showing is the one that gets the ring, so tapping around
  // the map moves the highlight rather than leaving the original card's pin lit.
  setFocusPin(id);

  if (!pan) return;
  const marker = mapMarkers.get(id);
  if (marker) {
    spotsMap.panInside(marker.getLatLng(), {
      paddingTopLeft: [28, 28],
      paddingBottomRight: [28, mapSheetHeight() + 28],
    });
  }
}

function closePinSheet(instant = false) {
  const sheet = $('map-pin-sheet');
  mapPinId = null;
  // The sheet IS the selection, so putting it away drops the ring, the lift, and
  // the full-strength pin with it — whichever way it was closed (the X, a tap on
  // open map, Esc). Otherwise the map is left claiming a pin is selected with
  // nothing on screen to select it.
  setFocusPin(null);
  clearTimeout(mapSheetTimer);
  sheet.classList.remove('is-open');
  $('map-stage').style.setProperty('--map-sheet-h', '0px');
  if (instant) { sheet.hidden = true; return; }
  mapSheetTimer = setTimeout(() => {
    if (!sheet.classList.contains('is-open')) sheet.hidden = true;   // unless it reopened mid-slide
  }, 340);
}

// Move the ring (and the z-order) to `id`, or clear it with null.
function setFocusPin(id) {
  mapFocusId = id == null ? null : String(id);
  mapMarkers.forEach((marker, key) => {
    const mp = marker.getElement()?.querySelector('.mp');
    const on = key === mapFocusId;
    if (mp) mp.classList.toggle('is-focus', on);
    marker.setZIndexOffset(on ? 1000 : 0);
  });
}

/* ---------- open / close the screen ---------- */

function buildSpotsMap() {
  if (spotsMap) return;
  spotsMap = L.map('map-canvas', {
    maxZoom: MAP_MAX_ZOOM,
    zoomControl: true,
    // A wall, not a rubber band. At the default viscosity a flick sails past the
    // edge and springs back, which reads as the map being broken rather than
    // finite; 1 makes the boundary immovable.
    maxBoundsViscosity: 1,
    bounceAtZoomLimits: false,
    // The page kills the wheel-zoom gesture everywhere else (no-zoom.js), but
    // inside a map a wheel IS a zoom. no-zoom.js skips events over this element.
    scrollWheelZoom: true,
  });
  spotsMap.zoomControl.setPosition('topleft');
  spotsMap.attributionControl.setPosition('bottomleft');
  spotsMap.attributionControl.setPrefix('');   // drop the Leaflet flag, keep the licence

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: MAP_MAX_ZOOM,
    // Required by the OpenStreetMap tile licence, and listed as a third party in
    // legal/student-privacy-policy.html. Do not remove this.
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(spotsMap);

  mapPins = L.layerGroup().addTo(spotsMap);
  // Tapping the map itself (not a pin) puts the sheet away.
  spotsMap.on('click', () => closePinSheet());
  spotsMap.on('locationfound', onMapLocationFound);
  spotsMap.on('locationerror', onMapLocationError);
}

// `focusId` null opens the whole set with nothing selected.
function openMapScreen(focusId = null) {
  const spots = mappableVendors();
  // Leaflet is same-origin and cached by the service worker, but if the script
  // did not make it we fall back to the behaviour the thumbnail used to have
  // rather than doing nothing at all.
  if (typeof L === 'undefined') {
    const v = focusId && allVendors.find((x) => String(x.vendorId) === String(focusId));
    if (v?.address) openMaps(v.address);
    return;
  }
  if (!spots.length || mapScreenOpen()) return;

  mapFocusId = focusId == null ? null : String(focusId);
  const ov = $('map-modal');
  ov.hidden = false;
  void ov.offsetWidth;                 // reflow so the slide-up transition runs
  ov.classList.add('is-open');

  buildSpotsMap();
  // The container had no size until the line above un-hid it, so whatever
  // Leaflet measured on construction is stale. Everything below reads geometry.
  spotsMap.invalidateSize(false);
  buildMapPins(spots);

  // Sheet first, then frame: frameMap lifts the focused pin by half the sheet,
  // and it can only measure a sheet that is already laid out.
  if (mapFocusId) openPinSheet(mapFocusId, false);
  else closePinSheet(true);
  frameMap(spots, mapFocusId);

  const missing = allVendors.length - spots.length;
  setMapNote(missing > 0 ? `${missing} ${missing === 1 ? 'spot isn’t' : 'spots aren’t'} on the map yet` : '');
}

function closeMapScreen() {
  const ov = $('map-modal');
  if (ov.hidden || !ov.classList.contains('is-open')) return;   // already closing/closed
  ov.classList.remove('is-open');
  stopMapLocate();
  closePinSheet(true);   // clears the focus ring too
  setMapNote('');
  setTimeout(() => {
    if (!ov.classList.contains('is-open')) ov.hidden = true;     // unless it reopened mid-slide
  }, 400);
}

// Hard reset, no animation — for sign-out, same reason as dropItemModal: the
// screen is a body-level sibling of #app, so hiding #app cannot hide it.
function dropMapScreen() {
  const ov = $('map-modal');
  ov.classList.remove('is-open');
  ov.hidden = true;
  stopMapLocate();
  closePinSheet(true);
  setMapNote('');
  // The pins are the previous student's spots and balances. The map object
  // itself is kept — it is expensive to build and holds no personal data once
  // the layer is empty — but nothing of theirs may survive into the next
  // session, and the entry point goes with it until fresh balances land.
  mapPins?.clearLayers();
  mapMarkers.clear();
  mapFocusId = null;
  $('map-open-btn').hidden = true;
  $('vendor-map-cta').hidden = true;   // ...and the way in from a spot's screen
}

// Esc backs out one layer at a time: the sheet if it is up, otherwise the map.
function onMapEscape() {
  if (mapPinId) closePinSheet();
  else closeMapScreen();
}

function onMapPinOpenVendor() {
  const id = mapPinId;
  if (!id) return;
  closeMapScreen();
  openVendor(id);
}

// The other direction: from a spot's own screen up to its pin. The map is a
// body-level overlay above .tabbar, so it slides up OVER the spot screen and
// leaves it standing — closing the map drops the student back exactly where they
// were, with no pane to rebuild and no back-stack to keep.
function onShowVendorInMap() {
  if (vendor) openMapScreen(vendor.vendorId);
}

function onMapPinDirections() {
  const v = mapPinId && allVendors.find((x) => String(x.vendorId) === mapPinId);
  if (v?.address) openMaps(v.address);
}

/* ---------- my location ----------
   Read on tap only, never on open, and never sent anywhere: the coordinates go
   from the browser straight into a marker on this student's own screen. See
   "Location on the Map" in legal/student-privacy-policy.html. */

function onMapLocateTap() {
  if (!spotsMap) return;
  const btn = $('map-locate');
  // Second tap on a dot we already have: put it away rather than re-prompting.
  if (mapMe) { stopMapLocate(); return; }
  btn.classList.add('is-busy');
  spotsMap.locate({ setView: false, enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
}

function onMapLocationFound(e) {
  const btn = $('map-locate');
  btn.classList.remove('is-busy');
  btn.classList.add('is-on');
  if (!mapMe) {
    mapMe = L.marker(e.latlng, {
      // A 0x0 box: the dot and its halo are absolutely positioned children that
      // centre themselves on the anchor, so there is nothing to line up.
      icon: L.divIcon({
        className: 'map-me',
        html: '<span class="map-me-ring"></span><span class="map-me-dot"></span>',
        iconSize: [0, 0],
      }),
      interactive: false,
      keyboard: false,
      zIndexOffset: -500,        // never on top of a pin they are trying to tap
    }).addTo(spotsMap);
  } else {
    mapMe.setLatLng(e.latlng);
  }
  // Only chase them if they are inside the walled area. Pan to a student who is
  // home for the summer and the wall stops the map at a corner of campus with no
  // dot anywhere in sight, which looks like a bug.
  if (mapWall?.contains(e.latlng)) {
    spotsMap.panInside(e.latlng, {
      paddingTopLeft: [28, 28],
      paddingBottomRight: [28, mapSheetHeight() + 28],
    });
  } else {
    flashMapNote('You’re outside the map area, so the view stayed on your spots.');
  }
}

function onMapLocationError(e) {
  $('map-locate').classList.remove('is-busy');
  // code 1 is PERMISSION_DENIED — worth saying plainly, because the browser only
  // asks once and the fix is in settings, not in here.
  flashMapNote(e?.code === 1
    ? 'Location is off for this site. Turn it on in your browser settings.'
    : 'Couldn’t get your location. Try again in a moment.');
}

function stopMapLocate() {
  spotsMap?.stopLocate();
  if (mapMe) { mapMe.remove(); mapMe = null; }
  const btn = $('map-locate');
  btn.classList.remove('is-on', 'is-busy');
}

/* ---------- open / leave a vendor screen ---------- */

function onVendorTap(e) {
  const card = e.target.closest('.vendor-card');
  if (!card) return;
  // Three targets, three destinations. The map picture opens the in-app map on
  // this vendor's pin; the address line keeps its one tap to walking directions
  // in the platform's own maps app; the rest of the card opens the rewards
  // screen. Splitting the first two is why nobody loses the fast path out.
  if (e.target.closest('.vc-map')) {
    openMapScreen(card.dataset.id);
    return;
  }
  if (e.target.closest('.vc-address')) {
    const v = allVendors.find((x) => String(x.vendorId) === card.dataset.id);
    if (v?.address) openMaps(v.address);
    return;
  }
  openVendor(card.dataset.id);
}

/**
 * Open a spot's screen.
 *
 * The pane is an overlay on .tab-viewport (see index.html), so it slides in from
 * the right over WHICHEVER tab is showing and there is no tab to change. That
 * is the whole reason it was moved out of #tab-home: while it lived inside the
 * Home page it could only ever cover Home, so opening a spot from anywhere else
 * had to snap the track first — which meant either a visible flash of the Home
 * carousel, or no animation at all.
 *
 * `origin` is now advisory only, kept so the caller can say where the student
 * should end up if a future path needs to differ. Closing the pane simply
 * uncovers the tab that was underneath it, so the common case needs no bookkeeping.
 */
function openVendor(vendorId, origin) {
  const v = allVendors.find((x) => String(x.vendorId) === String(vendorId));
  if (!v) return;
  closeHub();     // the spot's own screen slides in over it — same story as setTab
  vendorOrigin = origin ?? activeTab;
  vendor = v;
  balanceReady = false;                       // paint the number instantly, no ticker
  $('pb-vendor').textContent = v.name.toUpperCase();
  renderVendorRate(v);
  syncVendorMapCta(v);
  renderItems();
  applyBalance(v.balance ?? 0);
  openVendorPane();
  // After the pane is shown, not before: it un-hides the pane, and the stamp
  // rows are measured against a card that has no width while #vendor is still
  // hidden. Nothing has painted between the two calls, so the block still
  // arrives with the screen rather than a frame late.
  renderPunchUi();
}

/**
 * Leave the spot screen.
 *
 * The tab underneath never moved, so this is just the pane sliding back out —
 * a spot opened from Spots reveals Spots, one opened from Home reveals Home,
 * with no tab bookkeeping and no snap.
 */
function exitVendor(animate) {
  vendorOrigin = TAB.home;
  backToHome(animate);
}

/**
 * Tear the spot screen down and put the pane back where it started.
 *
 * `animate` slides it out to the right; without it the pane is parked instantly
 * (sign-out, an interrupting navigation, reduced motion).
 */
function backToHome(animate = false) {
  vendor = null;
  balanceReady = false;
  loadVendors();                              // refresh card balances on the way back
  closeVendorPane(animate);
  // The carousel keeps its scroll position while the pane is over it, so the
  // dots are re-read as soon as it is uncovered rather than waiting on the next
  // loadVendors() to land — that fetch can fail, and the pager would otherwise
  // sit on the wrong card until the user scrolled.
  dotsFromScroll();
}

/* ---------- the spot screen's slide ----------
   #vendor is an overlay on .tab-viewport now, not one of a pair of panes inside
   #tab-home, so this is a single element moving between translateX(100%) and 0.
   The old slidePanes/endPaneSlide pair drove two panes against a .home-sliding
   layout and is gone with them: it could only ever animate over the Home tab,
   because both panes lived on it.

   paneSlide holds the in-flight settle so an interrupting navigation can cancel
   it rather than letting it fire against a pane it no longer describes. */

/** Cut any in-flight slide short. Leaves the pane wherever the caller puts it. */
function endPaneSlide() {
  if (!paneSlide) return;
  const { settle, timer } = paneSlide;
  paneSlide = null;                     // first, so a re-entrant call is a no-op
  clearTimeout(timer);
  $('vendor').removeEventListener('transitionend', settle);
  $('vendor').classList.remove('is-sliding');
}

/** True when the device asks for less motion (or can't be asked). */
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** Slide the spot screen in from the right over whatever tab is showing. */
function openVendorPane() {
  const pane = $('vendor');
  endPaneSlide();
  pane.hidden = false;
  pane.scrollTop = 0;

  // Already standing where it is going. "Show in map" made this ordinary: open a
  // spot, open the map on its pin, tap View rewards — openVendor runs against a
  // pane that never left. Re-running the slide would park it off the right edge
  // for a frame and drag it back in, which reads as a flicker behind the map
  // sliding down. The content swap above is the whole job here.
  if (pane.classList.contains('is-open')) return;

  if (reducedMotion()) { pane.classList.add('is-open'); return; }

  // Two frames' worth of care: the pane was display:none a moment ago, so it has
  // no layout yet and a transform set now would be its FIRST computed value —
  // there would be nothing to transition from. Force layout while it is still
  // parked at translateX(100%), then flip the class.
  pane.classList.remove('is-open');
  void pane.offsetWidth;
  pane.classList.add('is-sliding', 'is-open');

  const settle = (e) => {
    if (e && e.target !== pane) return;   // ignore transitions bubbling from children
    endPaneSlide();
  };
  paneSlide = { settle, timer: setTimeout(settle, 420) };  // timer: if transitionend never fires
  pane.addEventListener('transitionend', settle);
}

/** Slide it back out to the right, or park it instantly. */
function closeVendorPane(animate = true) {
  const pane = $('vendor');
  endPaneSlide();
  pane.classList.remove('is-dragging');

  if (!animate || reducedMotion()) {
    pane.classList.remove('is-open', 'is-sliding');
    pane.style.transform = '';
    pane.hidden = true;
    return;
  }

  // A drag may have left an inline transform mid-way; clearing it lets the
  // class-driven translateX(100%) be what the transition runs to.
  pane.style.transform = '';
  pane.classList.add('is-sliding');
  pane.classList.remove('is-open');

  const settle = (e) => {
    if (e && e.target !== pane) return;
    endPaneSlide();
    pane.hidden = true;                   // only once it is actually off-screen
  };
  paneSlide = { settle, timer: setTimeout(settle, 420) };
  pane.addEventListener('transitionend', settle);
}

// Back arrow: the spot screen slides out to the right, revealing the tab that
// was underneath it all along — Home, Spots, wherever it was opened from.
function backToHomeSlide() {
  backToHome(true);
}

/* ---------- live balance: socket push + ticker + notification ---------- */

// The server pushes a { vendorId, balance } event the instant a vendor awards
// or redeems, so the meter updates live with no polling. The socket.io client
// is served by our own server at /socket.io/socket.io.js.
function connectSocket() {
  if (!socket) {
    socket = io({ autoConnect: false, auth: (cb) => cb({ token: currentToken }) });
    socket.on('balance', (payload) => {
      if (!payload?.vendorId) return;
      const next = payload.balance ?? 0;
      const v = allVendors.find((x) => x.vendorId === payload.vendorId);
      const prev = v ? (v.balance ?? 0) : 0;
      if (v) v.balance = next;
      patchVendorCard(payload.vendorId, next);                       // live-update the home card
      if (vendor && payload.vendorId === vendor.vendorId) applyBalance(next); // and the open meter
      // A gain here is a scan landing → install triggers 2 (near a reward
      // threshold) and 4 (first points earned). `v` carries the vendor's rewards
      // so the hook can decide "within 1 visit". Redemptions (a drop) are handled
      // in applyBalance, which knows the code sheet was open.
      if (next > prev) {
        InstallPrompt.onPointsEarned({ vendor: v, prevBalance: prev, newBalance: next, earned: next - prev });
      }
      loadTier();                             // an earn just landed — score may have moved
      // The 10% community mint rides along on the same push (community-points.md
      // step 3), so honour it the moment the field appears; until then fall back
      // to a re-read. Neither does anything visible before the mint path exists.
      if (payload.community != null) setCommunityPoints(payload.community);
      else loadCommunity();
      if (historyLoaded) loadHistory();       // ...and it's a new activity row
    });
    // Visit pushes (migration-029). EVERY event carries the new count: a punch
    // from another device, a counter redemption, or an undo restoring visits.
    // Patch locally for instant feedback, then let loadVendors() confirm.
    socket.on('punch', (payload) => {
      if (!payload?.vendorId) return;
      const v = allVendors.find((x) => x.vendorId === payload.vendorId);
      if (v?.punch && payload.visits != null) v.punch.visits = payload.visits;
      if (vendor && vendor.vendorId === payload.vendorId) {
        renderPunchUi();
        // Visits changed, so every reward's lock state may have too.
        document.querySelectorAll('.item-card').forEach(decorateCard);
      }
      if (payload.redeemed) {
        punchToast(`🎉 Redeemed${payload.reward ? ` · ${payload.reward}` : ''}`);
        if (!$('punch-modal').hidden) closePunchModal();
        if (!$('item-modal').hidden) closeItemModal();
      }
      loadVendors();
    });
    // A vendor queued a deal aimed at us (migration-032). This fires at
    // CREATION, not at delivery, so the list is current the moment it exists —
    // whether or not a notification is ever allowed or sent. It is also why the
    // server skips pushing to students whose app is open: this already told us.
    socket.on('deal', () => loadDeals());
    // Catch up on (re)connect in case an update landed while we were offline.
    socket.on('connect', () => { loadVendors(); loadTier(); loadCommunity(); loadDeals(); reportVisibility(); });
  }
  if (!socket.connected) socket.connect();
}

// Foreground/background, so the campaign worker can skip students who are
// looking at the app rather than spending one of their two daily notification
// slots to tell them something they can already see.
function reportVisibility() {
  if (socket?.connected) socket.emit('visible', !document.hidden);
}

function disconnectSocket() {
  if (socket) socket.disconnect();
}

// Update the balance everywhere. After the first load, a change animates the
// meter and pops a toast so gains/losses register live.
function applyBalance(next) {
  const prev = balance;
  if (next === prev && balanceReady) return;   // no change — nothing to do
  balance = next;
  document.querySelectorAll('.item-card').forEach(decorateCard); // live lock/unlock

  if (!balanceReady) {              // first paint: just show it, no ticker/toast
    balanceReady = true;
    $('pb-balance').textContent = next;
    return;
  }
  tickTo($('pb-balance'), prev, next);
  notifyPoints(next - prev);

  // A drop while the sheet is showing a code means this redemption just went
  // through — close the card (after a beat so the "Redeemed" toast registers).
  if (next < prev && !$('item-modal').hidden && !$('item-code').hidden) {
    setTimeout(closeItemModal, 1000);
    // Trigger 1: first successful redemption. The hook waits ~1.5s so the nudge
    // lands after the success toast + card-close animation, not during them.
    InstallPrompt.onRedemption();
  }
}

// Count an element from one value to another (eased, capped at 1s). The frame id
// is keyed per element so the vendor meter and the community counter — which can
// move on the same push — don't cancel each other's animation.
function tickTo(el, from, to) {
  cancelAnimationFrame(tickRaf.get(el) ?? 0);
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = to;
    return;
  }
  const start = performance.now();
  const dur = Math.min(1000, 300 + Math.abs(to - from) * 3);
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * eased);
    if (p < 1) tickRaf.set(el, requestAnimationFrame(step));
    else el.textContent = to;
  };
  tickRaf.set(el, requestAnimationFrame(step));
}

// Pop a pill + bump/flash the meter: green for points added, amber for redeemed.
function notifyPoints(delta) {
  const gain = delta > 0;

  const toast = $('points-toast');
  toast.className = `points-toast ${gain ? 'gain' : 'lose'}`;
  toast.textContent = gain ? `✨  +${delta} pts` : `🎉  Redeemed · ${Math.abs(delta)} pts`;
  toast.hidden = false;
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => { toast.hidden = true; }, 300);
  }, 2200);

  const pts = document.querySelector('.pb-points');
  pts.classList.remove('is-bump');
  void pts.offsetWidth;                       // restart the animation
  pts.classList.add('is-bump', gain ? 'gain' : 'lose');
  setTimeout(() => pts.classList.remove('gain', 'lose'), 900);
}

function renderItems() {
  const wrap = $('items');

  // Remove previously rendered live cards (keep placeholders where they are)
  wrap.querySelectorAll('.item-card.live').forEach((el) => el.remove());

  // Live items from the vendor's ITEMS tab, cheapest first.
  // A visits-only reward at a spot with punch cards OFF is unreachable, so it
  // is dropped rather than rendered as a permanently locked card.
  const live = (vendor?.rewards ?? [])
    .filter((r) => r.cost_in_points != null || vendor?.punch?.enabled)
    .slice()
    .sort(rewardOrder);

  live.forEach((r) => {
    const card = document.createElement('button');
    card.className = 'item-card live';
    card.dataset.id = r.id;
    card.dataset.title = r.title;
    // Two independent prices, either of which may be absent. Empty string (not
    // the string "null") so Number() never yields NaN downstream.
    card.dataset.costPoints = r.cost_in_points ?? '';
    card.dataset.costVisits = r.cost_in_visits ?? '';
    card.dataset.emoji = r.emoji || '🎁';
    wrap.appendChild(card);
  });

  // Decorate every card (placeholders included) with the same inner layout + lock state
  wrap.querySelectorAll('.item-card').forEach(decorateCard);

  const total = wrap.querySelectorAll('.item-card').length;
  $('items-empty').hidden = total > 0;
}

// Cheapest first across two currencies. A visit is worth far more than a point
// (one a night, versus points per dollar), so visits are weighted before they
// are compared; absent prices sort last instead of poisoning the sort with NaN.
// The visit price only counts when it is actually on show: with punch cards off
// it is hidden everywhere else, so ranking by it would order the list by a
// number the student cannot see.
function rewardOrder(a, b) {
  const visitsOn = Boolean(vendor?.punch?.enabled);
  const key = (r) => Math.min(
    r.cost_in_points ?? Infinity,
    (visitsOn ? (r.cost_in_visits ?? Infinity) : Infinity) * 100
  );
  return key(a) - key(b);
}

// The single affordability read, shared by the row and the sheet so the two can
// never disagree. `balance` is the open vendor's points; visits come off the
// vendor's counter and only count while punch cards are on.
function affordability(card) {
  const pts = card.dataset.costPoints === '' || card.dataset.costPoints == null
    ? null : Number(card.dataset.costPoints);
  const vis = card.dataset.costVisits === '' || card.dataset.costVisits == null
    ? null : Number(card.dataset.costVisits);
  const visitsOn = Boolean(vendor?.punch?.enabled);
  const visits = vendor?.punch?.visits ?? 0;
  return {
    pts, vis, visitsOn, visits,
    byPoints: pts != null && balance >= pts,
    byVisits: visitsOn && vis != null && visits >= vis,
  };
}

// "50 pts / 5 visits", or just the half that exists.
function priceBits(a) {
  const bits = [];
  if (a.pts != null) bits.push(`${a.pts} pts`);
  if (a.vis != null && a.visitsOn) bits.push(`${a.vis} visits`);
  return bits;
}

function decorateCard(card) {
  const a = affordability(card);
  const ready = a.byPoints || a.byVisits;
  card.classList.toggle('locked', !ready);

  // Per-currency shortfall: never say "pts" for a reward sold only in visits.
  const gaps = [];
  if (a.pts != null && !a.byPoints) gaps.push(`${a.pts - balance} pts to go`);
  if (a.vis != null && a.visitsOn && !a.byVisits) gaps.push(`${a.vis - a.visits} visits to go`);

  // The prices stack in their own right-hand column rather than running on one
  // line, so a long title has somewhere to give (it ellipsises) and two prices
  // never push the row past the card edge.
  // join() puts the dot only BETWEEN the two lines, so a single-price reward
  // gets no stray separator.
  const prices = priceBits(a)
    .map((b) => `<span class="ic-cost-line">${escapeHtml(b)}</span>`)
    .join('<span class="ic-cost-dot" aria-hidden="true">•</span>');
  card.innerHTML = `
    <span class="ic-emoji">${escapeHtml(card.dataset.emoji || '🎁')}</span>
    <span class="ic-body">
      <span class="ic-title">${escapeHtml(card.dataset.title)}</span>
      <p class="ic-status">${ready ? 'Ready to redeem ✓' : escapeHtml(gaps.join(' or '))}</p>
    </span>
    <span class="ic-cost">${prices}</span>`;
}

/* ---------- item detail modal ---------- */

function onItemTap(e) {
  const card = e.target.closest('.item-card');
  if (!card) return;
  const a = affordability(card);
  selectedItem = {
    id: card.dataset.id ?? null,
    title: card.dataset.title,
    emoji: card.dataset.emoji || '🎁',
    pts: a.pts,
    vis: a.vis,
  };

  const bits = priceBits(a);
  $('item-emoji').textContent = selectedItem.emoji;
  $('item-title').textContent = selectedItem.title;
  $('item-cost').textContent = bits.join(' / ');
  // A screen reader would otherwise announce the slash: "50 pts slash 5 visits".
  $('item-cost').setAttribute('aria-label', bits.join(' or '));
  $('item-desc').textContent = `Redeem at ${vendor?.name ?? 'this spot'}.`;

  // The buttons carry the user's own wording, so the numbers live here instead
  // of vanishing with the old disabled-button state.
  const status = $('item-status');
  status.textContent = `You have ${balance} pts${a.visitsOn ? ` · ${a.visits} visits` : ''}`;
  status.className = (a.byPoints || a.byVisits) ? 'detail-status ok' : 'detail-status locked';

  $('item-redeem').hidden = !a.byPoints;
  $('item-redeem').disabled = false;
  $('item-redeem-visits').hidden = !a.byVisits;
  $('item-redeem-visits').disabled = false;
  $('item-notready').hidden = a.byPoints || a.byVisits;

  // Only warn when there is actually surplus to lose: spending exactly what you
  // have forfeits nothing.
  // Names the action, not just the cost: with a points button beside it, a bare
  // "Uses all 12 of your visits" reads as if either button would burn them.
  const surplus = a.byVisits && a.visits > a.vis;
  $('item-forfeit').hidden = !surplus;
  if (surplus) $('item-forfeit').textContent = `Redeeming with visits uses all ${a.visits} of your visits`;

  // fresh open: hide any prior code, then slide up
  clearInterval(redeemCountdown);
  redeemCountdown = null;
  $('item-code').hidden = true;
  openSheet();
}

function openSheet() {
  const overlay = $('item-modal');
  overlay.hidden = false;
  void overlay.offsetWidth;          // reflow so the slide-up transition runs
  overlay.classList.add('is-open');
}

function closeItemModal() {
  const overlay = $('item-modal');
  if (overlay.hidden || !overlay.classList.contains('is-open')) return; // already closing/closed
  overlay.classList.remove('is-open'); // slide the card down + fade the backdrop
  clearInterval(redeemCountdown);
  redeemCountdown = null;
  setTimeout(() => {
    overlay.hidden = true;
    // Every node onItemTap can flip has to be reset here, or state leaks into
    // the next open. onItemTap decides visibility from scratch, so both buttons
    // start hidden rather than shown.
    $('item-redeem').hidden = true;
    $('item-redeem').disabled = false;
    $('item-redeem-visits').hidden = true;
    $('item-redeem-visits').disabled = false;
    $('item-notready').hidden = true;
    $('item-forfeit').hidden = true;
    $('item-code').hidden = true;
    selectedItem = null;
    loadVendors();                     // balance may have changed while open
  }, 360);
}

// Hard reset, no animation — for sign-out (same reason as dropEarnSheet). The
// sheet is a body-level sibling of #app, so hiding #app cannot hide it, and it
// may be showing a live code whose countdown would keep ticking on the landing
// page. Deliberately NOT closeItemModal: that animates for 360ms and then calls
// loadVendors() with a token we no longer have.
function dropItemModal() {
  const ov = $('item-modal');
  ov.classList.remove('is-open');
  ov.hidden = true;
  clearInterval(redeemCountdown);
  redeemCountdown = null;
  $('item-redeem').hidden = true;
  $('item-redeem').disabled = false;
  $('item-redeem-visits').hidden = true;
  $('item-redeem-visits').disabled = false;
  $('item-notready').hidden = true;
  $('item-forfeit').hidden = true;
  $('item-code').hidden = true;
  selectedItem = null;
}

/* ---------- redemption code ---------- */

async function onRedeemTap(paidWith = 'points') {
  if (!selectedItem || !vendor) return;
  // Both buttons go down: whichever currency wins, the other code is invalidated
  // server-side (one live code per student per vendor across both).
  $('item-redeem').disabled = true;
  $('item-redeem-visits').disabled = true;
  try {
    const res = await authFetch('/api/me/redeem-code', {
      method: 'POST',
      body: JSON.stringify({ vendorId: vendor.vendorId, rewardId: selectedItem.id, paidWith }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('item-status').textContent = data.message || 'Couldn’t start redemption, try again.';
      $('item-status').className = 'detail-status locked';
      $('item-redeem').disabled = false;
      $('item-redeem-visits').disabled = false;
      return;
    }
    showRedemptionCode(data.code, data.ttlSeconds ?? 120);
  } catch {
    $('item-status').textContent = 'No connection, try again.';
    $('item-redeem').disabled = false;
    $('item-redeem-visits').disabled = false;
  }
}

/* Replace the Redeem button, in place, with the live QR + code + a countdown. */
function showRedemptionCode(code, seconds) {
  // All three of the pre-code affordances go, or one would sit live beside the QR.
  $('item-redeem').hidden = true;
  $('item-redeem-visits').hidden = true;
  $('item-notready').hidden = true;
  $('item-forfeit').hidden = true;
  $('item-status').textContent = 'Show this at the counter';
  $('item-status').className = 'detail-status ok';
  $('item-code-value').textContent = code;
  try {
    drawQr($('item-code-qr'), `WRW:R:${code}`, 190);
  } catch { /* QR failed to render — the digits below still work */ }
  $('item-code').hidden = false;

  clearInterval(redeemCountdown);
  let left = seconds;
  const tick = () => {
    if (left > 0) {
      $('item-code-timer').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    } else {
      $('item-code-timer').textContent = 'Expired';
      clearInterval(redeemCountdown);
    }
    left -= 1;
  };
  tick();
  redeemCountdown = setInterval(tick, 1000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ==================== punch cards (migration-028) ====================
   The vendor's terminal shows a rotating, server-signed QR (a URL carrying
   ?punch=<token>). Scanning it in here — or with the phone camera, which
   lands on this origin and stashes the token through sign-in — earns one
   punch per vendor per night. A full card becomes a 4-digit WRW:P: code the
   counter scans, mirroring the reward redemption flow. */

/* ---------- pending punch: camera-scan → sign-in handoff ---------- */

const PENDING_PUNCH_KEY = 'wrw-pending-punch';

function readPendingPunch() {
  try {
    const raw = sessionStorage.getItem(PENDING_PUNCH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writePendingPunch(v) {
  try { sessionStorage.setItem(PENDING_PUNCH_KEY, JSON.stringify(v)); } catch { /* private mode */ }
}
function clearPendingPunch() {
  try { sessionStorage.removeItem(PENDING_PUNCH_KEY); } catch { /* private mode */ }
  syncPendingPunchNote();
}

// Runs before anything else at boot: pull ?punch= out of the URL (so a reload
// can't double-claim and the OAuth redirect keeps a clean origin URL) and
// stash it for the claim after sign-in. sessionStorage survives the Google
// round-trip in this tab, and — unlike localStorage — dies with it, so a
// stale token never ambushes a later visit.
function capturePunchLink() {
  try {
    const params = new URLSearchParams(location.search);
    const token = params.get('punch');
    if (!token) return;
    params.delete('punch');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
    writePendingPunch({ token, at: Date.now() });
  } catch { /* malformed URL — nothing to capture */ }
}

/* ---------- referrals (migration-039) ----------
   A friend's invite link is `/?ref=<code>`. The code is stashed at boot, claimed
   once a session exists, and the same button that shares it doubles as the
   status line for the ones already sent.

   localStorage, not sessionStorage (which is what capturePunchLink uses): a
   punch token dies in ninety seconds, but an invite link is routinely opened on
   Monday and acted on when the app is finally installed on Thursday. The code
   is not a secret and the server decides whether it is still claimable, so
   there is nothing to protect by letting it die with the tab. */
const PENDING_REF_KEY = 'wr-pending-ref';
// A stashed code the server would refuse anyway (the signup window is far
// shorter than this). Purely so a code can't sit in storage forever.
const PENDING_REF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let referralState = null;   // last /api/me/referral payload, or null

function readPendingRef() {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_REF_KEY) || 'null');
    if (!raw?.code) return null;
    if (Date.now() - (raw.at ?? 0) > PENDING_REF_TTL_MS) return null;
    return raw.code;
  } catch { return null; }
}

function clearPendingRef() {
  try { localStorage.removeItem(PENDING_REF_KEY); } catch { /* private mode */ }
}

// Runs at boot, before anything can navigate: pull ?ref= out of the URL and
// stash it. Stripping the query matters twice over — a reload must not look
// like a second claim, and the OAuth redirect has to leave from a clean origin
// URL, because Google sends the browser back WITHOUT the query string. That
// round trip is the entire reason this is stored rather than read on demand.
function captureReferralLink() {
  try {
    const params = new URLSearchParams(location.search);
    const code = params.get('ref');
    if (!code) return;
    params.delete('ref');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
    localStorage.setItem(PENDING_REF_KEY, JSON.stringify({ code, at: Date.now() }));
  } catch { /* malformed URL or private mode — nothing to capture */ }
}

// Claim a stashed code, once, after sign-in. Every outcome except a network
// failure clears the stash: "you already used a code", "that code doesn't
// exist" and "too late" are all final answers, and retrying them on every app
// open would mean a toast every time. A network failure keeps it for next time.
async function claimPendingReferral() {
  const code = readPendingRef();
  if (!code) return;
  try {
    const res = await authFetch('/api/me/referral', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    let body = {};
    try { body = await res.json(); } catch { /* non-JSON body → generic copy below */ }
    clearPendingRef();

    if (res.ok) {
      if (body.friendPoints > 0) {
        punchToast(`Invite accepted, +${body.friendPoints} community points!`);
        loadCommunity();
      } else {
        punchToast('Invite accepted!');
      }
      return;
    }
    // Silent on the two that aren't the student's doing and aren't news: no
    // program running, and a code they already used. Everything else gets the
    // server's own sentence.
    if (body.error === 'REFERRAL_INACTIVE' || body.error === 'REFERRAL_ALREADY_SET') return;
    punchToast(body.message || 'That invite code didn’t work.', false);
  } catch {
    /* offline — keep the stash and try again next launch */
  }
}

// Row two of the earn actions divides itself between whatever is showing, so
// the receipt button is either sharing it with invite or holding all of it. Wide
// is the markup's default because invite ships hidden; this is the one thing
// that has to move when that changes.
function syncEarnRowWidth(inviteShown) {
  const receipt = $('scan-receipt-btn');
  if (receipt) receipt.classList.toggle('earn-btn-wide', !inviteShown);
  // A third button is a taller block, so the fit decision has to be taken again.
  syncHomeDensity();
}

// The invite button's label and visibility. `program: null` means nothing is
// running, and the button stays hidden rather than promising a bonus that
// wouldn't be paid.
async function loadReferral() {
  try {
    const res = await authFetch('/api/me/referral');
    if (!res.ok) return;
    referralState = await res.json();
  } catch {
    return;   // offline — leave the button as it is
  }

  const btn = $('invite-btn');
  if (!btn) return;
  if (!referralState?.program || !referralState.shareUrl) {
    btn.hidden = true;
    syncEarnRowWidth(false);
    return;
  }

  const { program, joined, waiting, earned } = referralState;
  let sub;
  if (!joined) {
    sub = program.friendPoints > 0
      ? `They get ${program.friendPoints}, you get ${program.referrerPoints}`
      : `Get ${program.referrerPoints} points when they buy something`;
  } else if (waiting) {
    // Naming the condition is the point: "waiting" with no reason reads as a
    // bug, and the student can actually do something about this one.
    sub = `${joined} joined · ${waiting} yet to buy anything`;
  } else {
    sub = `${joined} joined · ${earned} points earned`;
  }
  // Half a row is no room for this line, and unlike the other two buttons there
  // is no sheet to move it into — tapping goes straight to the OS share sheet —
  // so it becomes the button's accessible name instead of a subtitle. Written
  // here rather than in the markup because every one of these sentences is live
  // state, and a stale one announced over the real one is worse than no line at
  // all. Set BEFORE unhiding, so the button is never reachable without it.
  btn.setAttribute('aria-label', `Invite a friend — ${sub}`);
  btn.hidden = false;
  syncEarnRowWidth(true);
}

// Hand the link to the OS share sheet where there is one (every iOS and Android
// browser this app targets), and fall back to the clipboard where there isn't —
// desktop Chrome and Firefox. A cancelled share sheet throws AbortError, which
// is a decision, not a failure, so it must not fall through to the clipboard.
async function shareInvite() {
  const url = referralState?.shareUrl;
  if (!url) return;

  const text = referralState.program?.friendPoints > 0
    ? `Join me on WeRewards and get ${referralState.program.friendPoints} community points to start.`
    : 'Join me on WeRewards.';

  if (navigator.share) {
    try {
      await navigator.share({ title: 'WeRewards', text, url });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
      /* share unavailable in this context → clipboard below */
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    punchToast('Invite link copied!');
  } catch {
    // No share sheet and no clipboard permission: show the code itself, which
    // is short enough to read aloud and is all the link really carries.
    punchToast(`Your invite code: ${referralState.code}`);
  }
}

/**
 * Landing-page nudge for the signup bonus (migration-040), shown above the
 * Google button and only while a program is actually running.
 *
 * The timing is the whole point. The bonus is decided by the email address the
 * student arrives with, and once they have picked a Google account there is no
 * way to change which address WeRewards sees short of deleting the account. So
 * this has to be readable BEFORE the chooser opens — which is why it is drawn
 * from /api/public-config during boot rather than after sign-in.
 */
function showSignupBonusNote(bonus) {
  const el = $('signup-bonus-note');
  if (!el) return;
  const points = Number(bonus?.points) || 0;
  const domains = Array.isArray(bonus?.domains) ? bonus.domains.filter(Boolean) : [];
  if (!points || !domains.length) { el.hidden = true; return; }

  // "@psu.edu" for the usual single-domain case; "@psu.edu or @alumni.psu.edu"
  // when an operator has listed more than one.
  const list = domains.map((d) => `@${d}`);
  const which = list.length === 1
    ? list[0]
    : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;

  el.textContent = `🎓 Sign in with your ${which} email and start with ${points} community points.`;
  el.hidden = false;
}

// Landing-page nudge: "sign in and the punch lands".
function syncPendingPunchNote() {
  const el = $('pending-punch-note');
  if (el) el.hidden = !readPendingPunch();
}

// Swap the short-lived token for a 10-minute single-use hold, pre-auth. On a
// definitive "expired" answer, say so now — before the student bothers to
// sign in. On network failure keep the raw token; claim retries the swap.
//
// One swap at a time, and never write back into a stash that changed while we
// were in flight: boot fires this and claimPendingPunch can too, so a slow
// first response could otherwise resurrect a stash the claim already cleared —
// and the orphan would surface hours later as a phantom "already punched"
// toast in an idle session.
let punchHoldSwap = null;

function securePendingPunchHold() {
  if (punchHoldSwap) return punchHoldSwap;
  punchHoldSwap = (async () => {
    const pending = readPendingPunch();
    if (!pending?.token || pending.holdId) return;
    try {
      const res = await fetch('/api/punch/hold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: pending.token }),
      });
      const data = await res.json().catch(() => ({}));
      const current = readPendingPunch();
      // Claimed, cleared, or replaced while we waited — this answer is stale.
      if (!current?.token || current.holdId || current.token !== pending.token) return;
      if (res.ok && data.holdId) {
        writePendingPunch({ holdId: data.holdId, expiresAt: Date.now() + (data.expiresIn ?? 600) * 1000 });
      } else if (res.status === 401 || res.status === 403) {
        clearPendingPunch();
        punchToast(data.message || 'That visit code expired. Scan the live code at the counter.', false);
      }
      // other statuses (rate limit, 5xx): keep the token and let the claim retry
    } catch { /* offline — keep the token, the claim will retry */ }
  })().finally(() => {
    punchHoldSwap = null;
    syncPendingPunchNote();
  });
  return punchHoldSwap;
}

let punchClaiming = false;

// Called whenever the app becomes ready (signed in + consented). Claims the
// stashed hold/token, then defers to loadVendors() for the authoritative
// counts. Network failures keep the stash so the next render retries.
async function claimPendingPunch() {
  if (punchClaiming) return;
  const pending = readPendingPunch();
  if (!pending) return;
  punchClaiming = true;
  try {
    if (!pending.holdId && pending.token) {
      // The pre-auth swap never landed (offline at boot?) — try once more now;
      // if the token is somehow still fresh a direct claim below also works.
      await securePendingPunchHold();
    }
    const current = readPendingPunch();
    if (!current) return;
    if (current.holdId && current.expiresAt && Date.now() > current.expiresAt) {
      clearPendingPunch();
      punchToast('That visit link expired. Scan the code at the counter again.', false);
      return;
    }
    const body = current.holdId ? { holdId: current.holdId } : { token: current.token };
    const res = await authFetch('/api/me/punch', { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && (data.error === 'CONSENT_REQUIRED' || data.error === 'CONSENT_STALE')) {
      return;   // keep the stash — the consent flow re-renders and we retry
    }
    if (res.status === 429 || res.status >= 500) {
      return;   // transient server-side trouble — keep the stash, retry on the next render
    }
    clearPendingPunch();   // definitive answer either way: never claim twice
    if (!res.ok) {
      punchToast(data.message || 'Couldn’t add that visit.', false);
      return;
    }
    onPunchClaimed(data);
  } catch {
    // network hiccup — keep the stash; the next render() retries
  } finally {
    punchClaiming = false;
  }
}

/* ---------- punch state on the vendor page ---------- */

// A punch just landed (scanner or claimed link): patch the local state for
// instant feedback, toast, and let loadVendors() confirm.
function onPunchClaimed(data) {
  const v = allVendors.find((x) => x.vendorId === data.vendorId);
  if (v?.punch) v.punch.visits = data.visits ?? v.punch.visits;
  if (vendor && vendor.vendorId === data.vendorId) {
    renderPunchUi();
    document.querySelectorAll('.item-card').forEach(decorateCard);
  }
  punchToast(`🎟️ Visit added at ${data.vendorName} · ${data.visits} total`);
  loadVendors();
}

// The cheapest visits-priced reward still out of reach, or null when the
// student can already afford every one of them.
function nextVisitReward(visits) {
  return (vendor?.rewards ?? [])
    .filter((r) => r.cost_in_visits != null && r.cost_in_visits > visits)
    .sort((a, b) => a.cost_in_visits - b.cost_in_visits)[0] ?? null;
}

// Any visits-priced reward the student can afford right now.
function hasUnlockedVisitReward(visits) {
  return (vendor?.rewards ?? []).some((r) => r.cost_in_visits != null && r.cost_in_visits <= visits);
}

// Render the visit counter + bottom scan button for the OPEN vendor page.
// Both follow punch_enabled: with the feature off there is no counter to show
// and nothing a visit could buy.
function renderPunchUi() {
  const p = vendor?.punch;
  const enabled = Boolean(p?.enabled);
  $('punch-block').hidden = !enabled;
  $('punch-scan-btn').hidden = !enabled;
  if (!enabled) return;

  const visits = p.visits ?? 0;
  const unit = visits === 1 ? 'visit' : 'visits';
  $('punch-count').textContent = visits;
  $('punch-count-unit').textContent = unit;
  // The digits are aria-hidden, so the button needs its own name.
  $('punch-card-btn').setAttribute(
    'aria-label',
    `${visits} ${unit} at ${vendor.name}, open your visits`
  );

  // A vendor can have visits on while nothing is priced in them (they
  // deactivated or repriced those rewards). Say so, rather than leaving the
  // counter with a blank subtitle and the sheet with an empty list.
  const anyVisitPriced = (vendor?.rewards ?? []).some((r) => r.cost_in_visits != null);
  const next = nextVisitReward(visits);
  const ready = hasUnlockedVisitReward(visits);
  $('punch-next').textContent =
    !anyVisitPriced ? 'Nothing to spend these on here yet'
    : visits === 0  ? 'Scan the code at the counter to start'
    : next          ? `${next.cost_in_visits - visits} more for ${next.title}`
    : ready         ? 'Ready to redeem, see the rewards below'
                    : '';
  $('punch-next').classList.toggle('is-ready', ready && !next);
  $('punch-scan-sub').textContent = 'Scan the code at the counter';
}

/* ---------- visits sheet: progress only ---------- */

function openPunchModal() {
  const p = vendor?.punch;
  if (!p) return;

  const visits = p.visits ?? 0;
  const unit = visits === 1 ? 'visit' : 'visits';
  const priced = (vendor?.rewards ?? [])
    .filter((r) => r.cost_in_visits != null)
    .sort((a, b) => a.cost_in_visits - b.cost_in_visits);

  $('punch-modal-title').textContent = `${visits} ${unit}`;
  $('punch-modal-desc').textContent =
    !priced.length ? `${vendor.name} hasn’t priced anything in visits yet. Yours are safe, keep collecting.`
    : visits === 0 ? `Scan the visit code at the counter to collect your first visit at ${vendor.name}. One a night.`
                   : `Collected at ${vendor.name}, one a night. Spend them on any reward below that shows a visit price.`;

  // What the counter buys, cheapest first. Redemption itself lives on the
  // reward, so this is a read-out, not a control.
  const list = $('punch-modal-list');
  list.innerHTML = '';
  priced
    .forEach((r) => {
      const ready = visits >= r.cost_in_visits;
      const li = document.createElement('li');
      if (ready) li.className = 'is-ready';
      li.innerHTML = `
        <span class="pml-title">${escapeHtml(r.title)}</span>
        <span class="pml-need">${ready ? 'Ready ✓' : `${r.cost_in_visits - visits} more`}</span>`;
      list.appendChild(li);
    });

  const ov = $('punch-modal');
  ov.hidden = false;
  void ov.offsetWidth;                 // reflow so the slide-up transition runs
  ov.classList.add('is-open');
  $('punch-card-btn').setAttribute('aria-expanded', 'true');
}

function closePunchModal() {
  const ov = $('punch-modal');
  if (ov.hidden || !ov.classList.contains('is-open')) return;
  ov.classList.remove('is-open');
  $('punch-card-btn').setAttribute('aria-expanded', 'false');
  setTimeout(() => {
    if (ov.classList.contains('is-open')) return;   // reopened mid-slide
    ov.hidden = true;
  }, 360);
}

// Hard reset, no animation — for sign-out (same reason as dropEarnSheet).
function dropPunchModal() {
  const ov = $('punch-modal');
  ov.classList.remove('is-open');
  ov.hidden = true;
  $('punch-card-btn').setAttribute('aria-expanded', 'false');
}

/* ============================================================
   DEALS — vendor campaigns (migration-032)

   THIS LIST IS THE MESSAGE. The notification is only a shortcut to it.

   That distinction is the whole design. A student's favourite spots overlap
   heavily with everyone else's (the tier score pays for breadth, so the
   regulars at one place are regulars at five), which means the naive version of
   this feature buries the best students under five notifications on a Friday
   and gets the channel blocked forever. So the server hard-limits notifications
   to at most two a day, never closer than four hours apart, never at night, and
   bundles whatever several vendors queued at once into ONE. Everything it
   suppresses still lands HERE, in full, immediately. See the header of
   supabase/migration-032.sql.
   ============================================================ */

let deals = [];
let dealsLoaded = false;
let vapidKey = null;              // server's public VAPID key; null = push disabled
let pushInitDone = false;
// Whether the SERVER holds a push endpoint for this student. The browser's own
// permission state is not enough to know that: permission can be granted while
// the subscribe never completed, or while the endpoint we had was pruned as dead
// (see the 401/403/404/410 handling in src/lib/push.js). That combination is
// silent — the switch reads "on" and nothing is ever delivered — so the server
// reports it and syncDealAlertUi() offers the repair.
let pushReady = null;             // null = not known yet
// The student's own switch (Account → Deal alerts), mirrored from the server.
// Kept apart from pushReady because "I turned this off" and "this is broken"
// look identical from the endpoint count alone, and only one of them should be
// offered a repair prompt.
let dealAlertsOn = true;
// Why the last enable attempt failed, in the student's words. There is no
// console on a phone PWA, so a subscribe that fails there is otherwise
// indistinguishable from one that worked — which is exactly how this went
// unnoticed. Shown on the repair line; cleared by a success.
let pushFailNote = '';
const DEAL_OPTIN_DISMISS_KEY = 'wr-deal-optin-dismissed';

async function loadDeals() {
  try {
    const res = await authFetch('/api/me/deals');
    if (!res.ok) return;
    const data = await res.json();
    deals = data.deals ?? [];
    dealsLoaded = true;
    pushReady = data.pushReady ?? null;
    dealAlertsOn = data.dealAlerts !== false;
    renderDealsCard(data.unread ?? 0);
    setDealsToggle(dealAlertsOn);
    if (!$('deals-modal').hidden) renderDealsList();
    // Only ask about notifications once there is something to be notified
    // about. A permission prompt before the first deal exists is a prompt
    // about nothing, and the browser only grants it once.
    if (deals.length) void initPush();
    else syncDealAlertUi();
  } catch { /* deals are a nice-to-have — never let them break the app */ }
}

// The deals block lives at the foot of the rewards hub, so with the hub shut
// there is nothing on screen to say a deal landed — that is what #hub-dot on the
// collapsed pill is for. Both dots are driven from the same unread count.
function renderDealsCard(unread) {
  const block = $('hub-deals');
  if (!deals.length) {
    block.hidden = true;
    $('hub-dot').hidden = true;
    return;
  }
  const first = deals[0];
  $('deals-card-line').textContent = deals.length === 1
    ? `${first.vendor}: ${first.title}`
    : `${first.vendor} and ${deals.length - 1} more have something on`;
  $('deals-dot').hidden = !unread;
  $('hub-dot').hidden = !unread;
  block.hidden = false;
  syncDealAlertUi();
}

function openDealsSheet(focusId) {
  if (!dealsLoaded) void loadDeals();
  renderDealsList(focusId);
  // The button that opens this sits INSIDE the hub panel, which would otherwise
  // stay unfolded behind the sheet (.overlay is z-index 40, .hub-modal 25) and
  // still be there when the sheet slides away. Fold it on the way out. Harmless
  // when the sheet was opened from a notification tap instead — closeHub()
  // returns immediately if the hub was never open.
  closeHub();
  const ov = $('deals-modal');
  ov.hidden = false;
  void ov.offsetWidth;                 // reflow so the slide-up transition runs
  ov.classList.add('is-open');
  $('deals-card').setAttribute('aria-expanded', 'true');
  // Opening the list IS reading it: both dots go away and stay away.
  authFetch('/api/me/deals/read', { method: 'POST', body: '{}' })
    .then(() => {
      $('deals-dot').hidden = true;
      $('hub-dot').hidden = true;
      deals.forEach((d) => { d.read = true; });
    })
    .catch(() => {});
}

function closeDealsSheet() {
  const ov = $('deals-modal');
  if (ov.hidden || !ov.classList.contains('is-open')) return;
  ov.classList.remove('is-open');
  $('deals-card').setAttribute('aria-expanded', 'false');
  setTimeout(() => {
    if (ov.classList.contains('is-open')) return;   // reopened mid-slide
    ov.hidden = true;
  }, 360);
}

// Hard reset, no animation — for sign-out (same reason as dropEarnSheet).
function dropDealsSheet() {
  const ov = $('deals-modal');
  ov.classList.remove('is-open');
  ov.hidden = true;
  $('hub-deals').hidden = true;
  $('hub-dot').hidden = true;
  $('deals-dot').hidden = true;
  $('deals-card').setAttribute('aria-expanded', 'false');
  deals = [];
  dealsLoaded = false;
  pushReady = null;
  dealAlertsOn = true;
  pushFailNote = '';
}

function renderDealsList(focusId) {
  const list = $('deals-list');
  list.innerHTML = '';
  $('deals-empty').hidden = deals.length > 0;

  // A deal opened from its own notification sorts to the top, so the tap lands
  // on the thing the student actually tapped.
  const ordered = focusId
    ? [...deals].sort((a, b) => (a.id === focusId ? -1 : b.id === focusId ? 1 : 0))
    : deals;

  for (const d of ordered) {
    const li = document.createElement('li');
    if (!d.read) li.className = 'is-unread';
    const logo = d.hasLogo
      ? `<span class="deal-logo" style="background-image:url('/api/vendor-logo/${encodeURIComponent(d.vendorId)}')"></span>`
      : '<span class="deal-logo">🏷️</span>';
    li.innerHTML = `
      ${logo}
      <span class="deal-text">
        <span class="deal-vendor">${escapeHtml(d.vendor)}</span>
        <span class="deal-head">${escapeHtml(d.title)}</span>
        <span class="deal-copy">${escapeHtml(d.body)}</span>
        <span class="deal-ends">${dealEndsLabel(d.expiresAt)}</span>
      </span>`;
    li.addEventListener('click', () => onDealTap(d));
    list.appendChild(li);
  }
}

function dealEndsLabel(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return 'Ended';
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return 'Ends within the hour';
  if (hours < 24) return `Ends in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(hours / 24);
  return `Ends in ${days} ${days === 1 ? 'day' : 'days'}`;
}

// Tapping a deal takes you to the spot it came from — the point of the whole
// feature — and records the click-through the vendor's DEALS tab counts.
function onDealTap(d) {
  authFetch('/api/me/deals/open', { method: 'POST', body: JSON.stringify({ id: d.id }) }).catch(() => {});
  // Captured before anything moves: the deals sheet can be opened from any tab,
  // and this is the tab the student should come back to.
  const from = activeTab;
  closeDealsSheet();
  // The manual setTab(0, false) that used to sit here is gone: openVendor now
  // hops to the Home tab itself, because #vendor lives inside it. Hopping here
  // ALSO meant openVendor read activeTab as 0 and recorded Home as the return
  // tab, so backing out of a deal always dumped you on Home no matter where you
  // opened it from.
  setTimeout(() => openVendor(d.vendorId, from), 260);   // after the sheet has slid away
}

/* ---------- notification permission ---------- */

// Runs once a deal exists. Already granted: (re-)subscribe, since the server
// upserts and endpoints do rotate. Never asked: show the soft ask in the hub,
// because requestPermission() has to come from a gesture and the browser only
// ever grants it once. Denied: stay out of the way, since re-prompting is
// impossible.
//
// pushInitDone latches the SETUP, not the subscribe. A subscribe that failed
// used to be latched too, which made it unrecoverable for the life of the page
// and — because the throw skipped the UI sync below — completely silent: the
// student saw an Account switch reading "on" and received nothing, forever. The
// failure is caught around the subscribe alone now, so the state it leaves is
// reported (pushReady stays false) and syncDealAlertUi offers the retry.
async function initPush() {
  try {
    // Latched AFTER the support guard, not before: on a platform where push
    // isn't available yet (an iOS tab before Add to Home Screen) this costs one
    // cheap property check per call, and leaves onDealsToggle's `if (!vapidKey)
    // await initPush()` able to succeed later instead of being a no-op for the
    // rest of the page's life.
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      syncDealAlertUi();
      return;
    }
    if (!pushInitDone) {
      // Latched only on SUCCESS. Latching before the fetch meant one failed
      // public-key request disabled push for the rest of the page's life —
      // line below is the only place vapidKey is ever assigned, and every
      // later call (including the toggle's own `if (!vapidKey) await
      // initPush()`) found the latch set and gave up without retrying.
      const res = await authFetch('/api/me/push/public-key');
      if (!res.ok) return;                       // not latched — the next call retries
      vapidKey = (await res.json())?.publicKey ?? null;
      pushInitDone = true;
    }
    if (!vapidKey) return;              // server has no VAPID keys → push disabled
    // Permission granted is NOT the same as "the server can reach this device".
    // Re-post on every load: the upsert is idempotent and cheap, and it is what
    // repairs a subscribe that failed earlier or an endpoint the server pruned.
    // The dealAlertsOn gate respects an explicit opt-out: without it, a student
    // who toggled alerts OFF was silently re-subscribed on the next load —
    // /push/subscribe force-sets push_opt_in=true server-side, so their choice
    // was quietly undone while the switch went on reading "off".
    if (Notification.permission === 'granted' && dealAlertsOn) {
      try {
        await subscribePush();
        pushReady = true;
        pushFailNote = '';
      } catch (err) {
        pushReady = false;
        pushFailNote = pushErrorNote(err);
        console.warn('[push] subscribe failed:', err?.message ?? err);
      }
    }
  } catch (err) {
    console.warn('[push] setup failed:', err?.message ?? err);
  }
  syncDealAlertUi();
}

function optinDismissed() {
  try { return !!localStorage.getItem(DEAL_OPTIN_DISMISS_KEY); } catch { return false; }
}

/**
 * Every notification state the hub's deals block can be in, in one place. The
 * point is that a student receiving nothing can always see WHY: silence with no
 * explanation is the state that makes people stop trusting the app.
 *
 *   unsupported  — an iOS tab before Add to Home Screen; say so, since installing
 *                  is the fix and nothing else here will work until they do
 *   switched off — their own choice, in Account. Say it and offer nothing: a
 *                  "fix this" prompt under a switch they deliberately turned off
 *                  is nagging, not help
 *   default      — the soft ask (the only gesture that may call requestPermission)
 *   denied       — blocked at the browser; we cannot re-prompt, so just say it
 *   granted, no endpoint — the silent-failure case; offer the repair
 *   granted, endpoint    — "alerts on"
 */
function syncDealAlertUi() {
  const state = $('deals-alert-state');
  const optin = $('deals-optin');
  const fix = $('deals-alert-fix');
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const perm = supported ? Notification.permission : null;

  let label = '';
  let showOptin = false;
  let showFix = false;

  if (!supported) {
    // Only worth saying on iOS, where installing genuinely unlocks it. Anywhere
    // else "unsupported" is a dead end the student cannot act on.
    label = isIosSafariTab() ? 'add to home screen for alerts' : '';
  } else if (!vapidKey) {
    label = '';                                    // server has push disabled — not their problem
  } else if (perm === 'denied') {
    label = 'alerts blocked';
  } else if (!dealAlertsOn) {
    label = 'alerts off';                          // their own switch — no repair offered
  } else if (perm === 'default') {
    showOptin = !optinDismissed();
    label = showOptin ? '' : 'alerts off';
  } else if (pushReady === false) {
    label = 'alerts off';
    showFix = true;
  } else if (pushReady === true) {
    label = 'alerts on';
  }

  state.textContent = label;
  state.hidden = !label;
  optin.hidden = !showOptin;
  fix.hidden = !showFix;
  // The repair line carries the actual reason when we have one. Without it the
  // student sees the same "not registered yet" whether their browser refused the
  // prompt, the push service was unreachable, or the save failed — three
  // different problems with three different next steps.
  $('deals-alert-why').textContent = pushFailNote;
  $('deals-alert-why').hidden = !(showFix && pushFailNote);
}

/**
 * Turn a subscribe failure into something a student can act on. The three that
 * actually happen in the field are worth naming; anything else keeps its own
 * message, because a specific string a student can read out beats "something
 * went wrong" when the next step is them telling us what they saw.
 */
function pushErrorNote(err) {
  const msg = String(err?.message ?? err ?? '');
  const name = err?.name ?? '';
  if (name === 'NotAllowedError') return 'Your browser refused the notification prompt.';
  // Chrome on a device with no Google Play services, and every browser when the
  // push service itself is unreachable.
  if (name === 'AbortError' || /registration failed|service not available/i.test(msg)) {
    return 'Your browser could not reach its push service. Check your connection and try again.';
  }
  if (/^(subscribe|notify) failed: \d\d\d$/.test(msg)) return 'We could not save this device. Try again.';
  if (/never became ready/i.test(msg)) return 'The app did not finish setting up on this device. Reload and try again.';
  if (/timed out/i.test(msg)) return 'The push service did not answer. Try again in a moment.';
  return msg || 'Something stopped this device registering.';
}

// iOS gates PushManager behind an installed PWA, so a Safari tab reports push as
// unsupported outright. Distinguishing it matters: on iOS the student can fix it
// (Share → Add to Home Screen), everywhere else "unsupported" means nothing they
// can do.
function isIosSafariTab() {
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);   // iPadOS
  return iOS && !window.InstallPrompt?.isInstalled?.();
}

/**
 * Ask for notification permission. MUST be called with NOTHING awaited before it
 * in the handler — that is the whole reason it exists as its own function.
 *
 * requestPermission() needs transient user activation, and an `await` spends it:
 * the browser sees the call arrive a network round-trip after the tap and is
 * entitled to refuse. Safari does refuse, and the promise it hands back can sit
 * unsettled forever rather than rejecting — which is worse than a refusal,
 * because the caller then never reaches the code that would put the switch back.
 *
 * So: call this FIRST, keep the promise, and do the network work while it is in
 * flight. Awaiting the result later is fine; only the CALL has to be in the
 * gesture. The timeout is the backstop for the never-settles case.
 */
function askNotificationPermission() {
  if (!('Notification' in window)) return Promise.resolve('unsupported');
  if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
  let p;
  try {
    p = Promise.resolve(Notification.requestPermission());
  } catch {
    return Promise.resolve('default');           // older callback-only signature
  }
  return Promise.race([
    p.catch(() => 'default'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 60_000)),
  ]);
}

/**
 * The one path that turns deal alerts on, shared by the soft opt-in and the
 * Account switch.
 *
 * It reports success ONLY when the server ends up holding an endpoint for this
 * device. Both callers used to be able to finish "successfully" having created
 * no subscription at all — the permission branch is skipped when `vapidKey` is
 * null or permission is not granted, nothing throws, and the switch was left
 * reading "on" over a server that could not reach this device. It looked fine
 * until the next launch, when the truth arrived from /api/me/deals and the
 * switch went back to off on its own.
 *
 * @returns {Promise<boolean>} whether alerts are genuinely on now
 */
async function enablePushAlerts(permPromise) {
  // The caller started the permission request inside its gesture; if it didn't,
  // this is still correct, just liable to be refused.
  const permP = permPromise ?? askNotificationPermission();
  if (!vapidKey) await initPush();
  const perm = await permP;
  if (perm !== 'granted') {
    dealAlertsOn = false;
    // 'timeout' is the never-settled case: the prompt was never really put to
    // them, so say that rather than "you declined".
    pushFailNote = perm === 'timeout'
      ? 'Your browser never answered the permission prompt. Try again.'
      : perm === 'unsupported'
        ? 'This browser cannot show notifications.'
        : perm === 'default'
          // Dismissed — or never shown at all: after enough dismissals the
          // browser quiets the prompt and resolves 'default' with no UI. From
          // the outside that is "the switch refuses and nothing says why".
          ? 'The notification prompt went unanswered. If you never saw one, your browser is quieting prompts for this site — allow notifications in your browser\'s site settings, then try again.'
          : '';                                  // an explicit Block gets deals-blocked-note instead
    return false;
  }
  if (!vapidKey) {
    // Two different states end here, and only one is fixable from the student's
    // side. pushInitDone latched = the server ANSWERED and said it has no push
    // keys (publicKey: null) — true until someone configures the server, so
    // "reload and try again" would be a lie. Not latched = the key fetch itself
    // failed this session (initPush above retries it); a reload can fix that.
    // (This branch used to be the ONE enable path that failed with no note and
    // no switch movement — a switch that silently refuses.)
    pushFailNote = pushInitDone
      ? 'Deal alerts aren\'t available right now. Try again later.'
      : 'Alerts could not be set up. Reload the app and try again.';
    return false;
  }
  // Record the INTENT before attempting the subscribe, and in this order.
  // A student who said yes and whose endpoint then failed to register has opted
  // in with a broken device, not opted out: leaving dealAlertsOn false here made
  // syncDealAlertUi read it as "their own switch, no repair offered" and hide the
  // very explanation they need. /push/subscribe would set the flag too, but it is
  // the call that just failed.
  dealAlertsOn = true;
  const saved = await authFetch('/api/me/notify', { method: 'PATCH', body: JSON.stringify({ dealAlerts: true }) });
  // authFetch resolves on a 4xx; unchecked, a rejected opt-in read as success.
  if (!saved.ok) throw new Error(`notify failed: ${saved.status}`);
  // initPush above may already have subscribed on its own — it does that whenever
  // permission was granted by the time it ran, which is every re-enable and any
  // prompt the browser answered instantly. Subscribing again would be harmless
  // (the server upserts) but it is a second pushManager.subscribe and a second
  // round trip for nothing.
  if (pushReady !== true) await subscribePush();  // throws if the endpoint never lands
  pushFailNote = '';
  pushReady = true;
  return true;
}

async function enableDealAlerts() {
  const permP = askNotificationPermission();     // FIRST — see askNotificationPermission
  const btn = $('deals-optin-yes');
  btn.disabled = true;
  try {
    await enablePushAlerts(permP);
  } catch (err) {
    // Permission may well have been granted and only the subscribe failed, so
    // this is not "they said no" — it is the repairable state, and
    // syncDealAlertUi below is what offers the repair.
    pushReady = false;
    pushFailNote = pushErrorNote(err);
    console.warn('[push] enable failed:', err?.message ?? err);
  }
  btn.disabled = false;
  $('deals-optin').hidden = true;
  setDealsToggle(dealAlertsOn);
  syncDealAlertUi();
}

// The explicit repair for "permission granted, no endpoint on file".
async function retryPushSubscribe() {
  const btn = $('deals-alert-retry');
  btn.disabled = true;
  btn.textContent = 'Fixing…';
  try {
    if (!vapidKey) await initPush();
    // Throw the browser's own subscription away first. This path is reached
    // precisely when the endpoint we hold is unusable, and getSubscription()
    // would otherwise hand the same dead one back to be re-uploaded.
    try {
      const reg = await swReady();
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch { /* nothing to drop */ }
    await subscribePush();
    pushReady = true;
    dealAlertsOn = true;
    pushFailNote = '';
  } catch (err) {
    pushReady = false;
    pushFailNote = pushErrorNote(err);
    console.warn('[push] retry failed:', err?.message ?? err);
  }
  btn.disabled = false;
  btn.textContent = 'Fix it';
  setDealsToggle(dealAlertsOn);
  syncDealAlertUi();
}

function dismissDealOptin() {
  try { localStorage.setItem(DEAL_OPTIN_DISMISS_KEY, '1'); } catch { /* private mode */ }
  $('deals-optin').hidden = true;
  syncDealAlertUi();          // the block now reads "alerts off" instead of going blank
}

// navigator.serviceWorker.ready has no failure mode: if registration failed
// (the register() call swallows its error) it never resolves, and an await on
// it freezes whichever handler is holding the switch disabled — with no
// :disabled styling, that reads as a switch that ignores taps. Race a timeout.
function swReady(ms = 10_000) {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('service worker never became ready')), ms)),
  ]);
}

async function subscribePush() {
  // No key means the server has push disabled: subscribing is impossible, and
  // without this guard urlBase64ToUint8Array(null) throws a raw TypeError that
  // reaches the student's fail note verbatim (the "Fix it" path gets here even
  // when initPush could not produce a key).
  if (!vapidKey) throw new Error('Deal alerts aren\'t available right now. Try again later.');
  const reg = await swReady();
  const appKey = urlBase64ToUint8Array(vapidKey);
  let sub = await reg.pushManager.getSubscription();
  // A subscription is bound to the applicationServerKey it was minted with. If
  // the server's keypair has changed since, the push service answers every send
  // with 403 "credentials do not correspond" — the endpoint is alive, reusable
  // and completely dead. getSubscription() hands the same one back forever, so
  // reusing it blindly makes that state unrecoverable: the client keeps
  // re-uploading the rejected endpoint on every load. Compare, and re-mint.
  if (sub && !sameAppServerKey(sub.options?.applicationServerKey, appKey)) {
    try { await sub.unsubscribe(); } catch { /* already gone */ }
    sub = null;
  }
  sub ??= await mintPushSubscription(reg, appKey);
  const { endpoint, keys } = sub.toJSON();
  const res = await authFetch('/api/me/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint, keys }),
  });
  // authFetch resolves on a 4xx, so without this a rejected subscribe would
  // leave the switch reading "on" with nothing stored server-side.
  if (!res.ok) throw new Error(`subscribe failed: ${res.status}`);
}

// pushManager.subscribe() is the one await in the enable path with no backstop
// of its own, and it needs one twice over: right after an unsubscribe() the
// push service is still tearing the old token down, and a subscribe() inside
// that window can reject with AbortError — or simply never settle, which would
// hang the caller (and the disabled switch above it) forever. So: race a hard
// timeout, and give the teardown one short-fuse retry to finish. A second
// failure is a real outage and is thrown to the caller for the fail note.
// The repair path (retryPushSubscribe) unsubscribes deliberately, so it walks
// straight into this race every time; the timeout is what keeps the never-
// settles case from freezing the UI.
async function mintPushSubscription(reg, appKey) {
  const attempt = () => Promise.race([
    reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('push subscribe timed out')), 20_000)),
  ]);
  try {
    return await attempt();
  } catch (err) {
    if (err?.name === 'NotAllowedError') throw err;   // permission problem — a retry cannot help
    await new Promise((r) => setTimeout(r, 3000));
    return attempt();
  }
}

function sameAppServerKey(stored, want) {
  if (!stored) return false;
  const a = new Uint8Array(stored);
  return a.length === want.length && a.every((v, i) => v === want[i]);
}

// Standard VAPID key decoder: base64url → the Uint8Array PushManager expects.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/* ---------- account: the deal-alerts switch ---------- */

// The switch shows what actually happens, not what the server has on file: a
// student whose browser has never granted permission receives nothing, however
// the opt-in flag reads, and a switch sitting on "on" while nothing arrives is
// the kind of thing people stop trusting the app over.
//
// Permission alone was not enough to make that promise. The server also has to
// HOLD an endpoint for this device, and it can be granted without one — a
// subscribe that failed, or an endpoint pruned as dead (src/lib/push.js). That
// is the exact state this switch used to render as "on", so pushReady is part of
// the answer. `null` means not yet known, and is treated as fine rather than
// flickering the switch off on every load.
function setDealsToggle(on) {
  const supported = 'Notification' in window;
  const blocked = supported && Notification.permission === 'denied';
  const granted = supported && Notification.permission === 'granted';
  const reachable = pushReady !== false;
  $('deals-toggle').setAttribute('aria-checked', on && granted && reachable ? 'true' : 'false');
  $('deals-toggle').disabled = blocked;
  $('deals-blocked-note').hidden = !blocked;
}

async function onDealsToggle() {
  const wasOn = $('deals-toggle').getAttribute('aria-checked') === 'true';
  const next = !wasOn;
  // Turning ON is asked for here but not granted here: it needs a permission
  // prompt and a round trip, either of which can fail or never come back. So the
  // switch does NOT move yet. It used to move optimistically, which is how it
  // could sit on "on" all session over a device the server could not reach and
  // then appear to "turn itself off" at the next launch — that was the truth
  // arriving, not a setting being lost.
  //
  // Turning OFF moves immediately: that direction is safe to promise, since the
  // worst case is we stop sending to a device that would have accepted.
  const sw = $('deals-toggle');
  sw.disabled = true;
  if (!next) { dealAlertsOn = false; setDealsToggle(false); }
  // Started before any await, inside this click's gesture — see
  // askNotificationPermission. Cheap and side-effect-free when it isn't needed.
  const permP = next ? askNotificationPermission() : null;
  let ok = true;
  try {
    if (next) {
      // enablePushAlerts owns the whole ON path — permission, the opt-in flag,
      // and the subscription — so the switch and the soft opt-in cannot drift.
      ok = await enablePushAlerts(permP);
    } else {
      // Server-side only: PATCH false deletes every stored endpoint, and an
      // endpoint nobody holds cannot be pushed to — that alone is "off".
      // The browser's own subscription is deliberately KEPT. unsubscribe()
      // tears the push service's token down ASYNCHRONOUSLY, and a re-enable
      // landing inside that window gets an AbortError — or a subscribe() that
      // never settles — out of pushManager.subscribe(). The never-settles case
      // is the worst: it hangs this handler while the switch is disabled, so
      // the switch stays dead for the life of the page ("it won't turn back
      // on"). Keeping the subscription also makes re-enable instant and
      // prompt-free: the same subscription is simply uploaded again.
      const res = await authFetch('/api/me/notify', { method: 'PATCH', body: JSON.stringify({ dealAlerts: false }) });
      if (!res.ok) throw new Error(`notify failed: ${res.status}`);   // catch puts the switch back
      pushReady = false;
    }
  } catch (err) {
    ok = false;
    if (next) { pushReady = false; pushFailNote = pushErrorNote(err); }
    else dealAlertsOn = wasOn;               // the server never heard the opt-out
    console.warn('[push] toggle failed:', err?.message ?? err);
  }
  sw.disabled = false;
  // The switch now shows what is actually true, not what was asked for.
  setDealsToggle(dealAlertsOn);
  // …and the hub's deals block has to agree with it — "alerts on" up there while
  // this reads off is the confusion the whole pushReady thread exists to prevent.
  syncDealAlertUi();
  // A turn-on that failed snaps the switch straight back — which reads as "it
  // won't let me" unless the reason is said HERE, at the switch being touched.
  // The hub's repair line is a different screen entirely. An explicit Block is
  // the one case with its own note (deals-blocked-note, via setDealsToggle).
  const denied = 'Notification' in window && Notification.permission === 'denied';
  const showWhy = next && !ok && Boolean(pushFailNote) && !denied;
  $('deals-fail-note').textContent = showWhy ? pushFailNote : '';
  $('deals-fail-note').hidden = !showWhy;
}

/* ---------- the full-screen punch-in scanner ---------- */

const PUNCH_SCAN_DEFAULT = 'Point your camera at the visit code on the counter screen.';
const PUNCH_JSQR_INTERVAL_MS = 120;   // ~8 decode attempts/sec
const PUNCH_JSQR_MAX_DIM = 640;       // downscale frames before jsQR for speed
const PUNCH_DETECTOR_GRACE_MS = 3000; // BarcodeDetector's head start before jsQR joins

let punchScanSession = 0;   // bumped by stop(); stale async work checks it and bails
let punchScanStream = null;
let punchScanRunning = false;
let punchScanBusy = false;  // a claim is mid-flight — ignore sightings
let punchScanRaf = 0;
let punchScanDetectorTimer = null;
let punchScanJsqrTimer = null;
let punchScanRetryTimer = null;
let punchScanCanvas = null;
let punchScanCtx = null;
let punchScanLastAttempt = 0;
let punchScanLastPayload = null;
let punchScanLastPayloadAt = 0;

function setPunchScanStatus(msg, isError) {
  const el = $('punch-scan-status');
  el.textContent = msg;
  el.classList.toggle('is-error', Boolean(isError));
}

// The rotating QR carries a URL (?punch=<token>); accept a bare token too.
function punchTokenFromPayload(raw) {
  const s = String(raw ?? '').trim();
  try {
    const u = new URL(s);
    const t = u.searchParams.get('punch');
    if (t) return t;
  } catch { /* not a URL */ }
  if (/^[0-9a-f-]{36}\.\d{1,12}\.[0-9a-f]{16}$/i.test(s)) return s;
  return null;
}

function openPunchScanSheet() {
  if (!vendor?.punch?.enabled) return;
  $('punch-scan-vendor').textContent = vendor.name;
  setPunchScanStatus(PUNCH_SCAN_DEFAULT, false);
  const ov = $('punch-scan-modal');
  if (ov.classList.contains('is-open')) return;
  ov.hidden = false;
  void ov.offsetWidth;                 // reflow so the slide-up transition runs
  ov.classList.add('is-open');
  $('punch-scan-btn').setAttribute('aria-expanded', 'true');
  startPunchScanner();
  $('punch-scan-close').focus({ preventScroll: true });
}

function closePunchScanSheet() {
  const ov = $('punch-scan-modal');
  if (ov.hidden || !ov.classList.contains('is-open')) return;
  stopPunchScanner();
  clearTimeout(punchScanRetryTimer);
  ov.classList.remove('is-open');
  $('punch-scan-btn').setAttribute('aria-expanded', 'false');
  setTimeout(() => {
    if (!ov.classList.contains('is-open')) ov.hidden = true;
  }, 400);
}

// Hard reset, no animation — for sign-out (it also releases the camera).
function dropPunchScanSheet() {
  stopPunchScanner();
  clearTimeout(punchScanRetryTimer);
  const ov = $('punch-scan-modal');
  ov.classList.remove('is-open');
  ov.hidden = true;
  $('punch-scan-btn').setAttribute('aria-expanded', 'false');
}

async function startPunchScanner() {
  if (punchScanRunning) return;
  const my = ++punchScanSession;
  const video = $('punch-scan-video');
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return setPunchScanStatus('This browser can’t use the camera here. Scan the code with your phone camera instead.', true);
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: 'environment' } },
    });
  } catch (err) {
    if (punchScanSession !== my) return;
    const name = err?.name || '';
    return setPunchScanStatus(
      name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Camera access is blocked. Allow it in your browser settings, or scan the code with your phone camera.'
        : 'Couldn’t start the camera. Scan the code with your phone camera instead.',
      true
    );
  }
  if (punchScanSession !== my) { stream.getTracks().forEach((t) => t.stop()); return; }
  punchScanStream = stream;
  video.srcObject = stream;
  try { await video.play(); } catch { /* autoplay+muted+playsinline: frames still arrive */ }
  if (punchScanSession !== my) { stream.getTracks().forEach((t) => t.stop()); return; }
  punchScanRunning = true;
  startPunchDecoders(my, video);
}

function stopPunchScanner() {
  punchScanSession += 1;
  punchScanRunning = false;
  cancelAnimationFrame(punchScanRaf);
  clearInterval(punchScanDetectorTimer);
  clearTimeout(punchScanJsqrTimer);
  // Also the "look again in 2s" timer: without this, backgrounding the app
  // during a retry wait would let that timer re-open the camera on a hidden
  // page — permission is already granted, so the indicator light would come on
  // with nothing on screen. submitPunch stops the scanner BEFORE scheduling a
  // retry, so a just-scheduled retry is never cancelled here.
  clearTimeout(punchScanRetryTimer);
  if (punchScanStream) { punchScanStream.getTracks().forEach((t) => t.stop()); punchScanStream = null; }
  $('punch-scan-video').srcObject = null;
}

// Belt-and-braces decoding, same rationale as the terminal: BarcodeDetector
// where it works, jsQR joining after a grace period (or from the start).
async function startPunchDecoders(my, video) {
  let detector = null;
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    } catch { detector = null; }
  }
  if (punchScanSession !== my) return;
  const startJsqr = () => {
    if (punchScanSession !== my) return;
    punchScanLastAttempt = 0;
    const tick = (ts) => {
      if (punchScanSession !== my || !punchScanRunning) return;
      punchScanRaf = requestAnimationFrame(tick);
      if (ts - punchScanLastAttempt < PUNCH_JSQR_INTERVAL_MS || !video.videoWidth) return;
      punchScanLastAttempt = ts;
      const scale = Math.min(1, PUNCH_JSQR_MAX_DIM / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.max(1, Math.round(video.videoWidth * scale));
      const h = Math.max(1, Math.round(video.videoHeight * scale));
      if (!punchScanCanvas) {
        punchScanCanvas = document.createElement('canvas');
        punchScanCtx = punchScanCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (punchScanCanvas.width !== w) punchScanCanvas.width = w;
      if (punchScanCanvas.height !== h) punchScanCanvas.height = h;
      let img;
      try {
        punchScanCtx.drawImage(video, 0, 0, w, h);
        img = punchScanCtx.getImageData(0, 0, w, h);
      } catch { return; }
      const hit = typeof jsQR === 'function' ? jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' }) : null;
      if (hit?.data) onPunchScanPayload(String(hit.data));
    };
    punchScanRaf = requestAnimationFrame(tick);
  };
  if (!detector) return startJsqr();
  let produced = false;
  let detBusy = false;
  punchScanDetectorTimer = setInterval(async () => {
    if (detBusy || punchScanSession !== my) return;
    detBusy = true;
    try {
      const codes = await detector.detect(video);
      if (punchScanSession === my && codes?.length) {
        produced = true;
        if (codes[0].rawValue != null) onPunchScanPayload(String(codes[0].rawValue));
      }
    } catch { /* jsQR below covers builds that throw forever */
    } finally { detBusy = false; }
  }, 130);
  punchScanJsqrTimer = setTimeout(() => { if (punchScanSession === my && !produced) startJsqr(); }, PUNCH_DETECTOR_GRACE_MS);
}

function onPunchScanPayload(raw) {
  if (!punchScanRunning || punchScanBusy) return;
  const now = Date.now();
  if (raw === punchScanLastPayload && now - punchScanLastPayloadAt < 3000) {
    punchScanLastPayloadAt = now;   // still in view — hold the debounce open
    return;
  }
  punchScanLastPayload = raw;
  punchScanLastPayloadAt = now;

  const token = punchTokenFromPayload(raw);
  if (!token) return setPunchScanStatus('That’s not a visit code. Look for it on the counter screen.', true);
  submitPunch(token);
}

// Back to looking, after a failure the student can retry through. Bails while
// the page is hidden — the visibilitychange handler restarts the scanner when
// they come back, so nothing is lost and the camera never wakes off-screen.
function retryPunchScan() {
  if (document.hidden) return;
  if (!$('punch-scan-modal').classList.contains('is-open')) return;
  setPunchScanStatus(PUNCH_SCAN_DEFAULT, false);
  startPunchScanner();
}

async function submitPunch(token) {
  if (punchScanBusy) return;
  punchScanBusy = true;
  stopPunchScanner();
  setPunchScanStatus('Punching in…', false);
  try {
    const res = await authFetch('/api/me/punch', { method: 'POST', body: JSON.stringify({ token }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setPunchScanStatus(data.message || 'Couldn’t punch in, try again.', true);
      if (data.error === 'ALREADY_PUNCHED' || data.error === 'PUNCH_DISABLED') {
        // Re-scanning won't change the answer tonight — close after a beat.
        punchScanRetryTimer = setTimeout(closePunchScanSheet, 2600);
      } else {
        // Stale slot / hiccup: keep the sheet up and look again.
        punchScanRetryTimer = setTimeout(retryPunchScan, 2200);
      }
      return;
    }
    closePunchScanSheet();
    onPunchClaimed(data);
  } catch {
    setPunchScanStatus('No connection. Check the internet and try again.', true);
    punchScanRetryTimer = setTimeout(retryPunchScan, 2200);
  } finally {
    punchScanBusy = false;
  }
}

/* ---------- shared punch toast (reuses the points pill) ---------- */

function punchToast(msg, gain = true) {
  const toast = $('points-toast');
  toast.className = `points-toast ${gain ? 'gain' : 'lose'}`;
  toast.textContent = msg;
  toast.hidden = false;
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => { toast.hidden = true; }, 300);
  }, 2600);
}
