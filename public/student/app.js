/* WeRewards — student app
   Home (vendor carousel) → tap a card → vendor screen (points bar with back
   button → your earn code → rewards → item detail modal → redemption code). */

let sb = null;
let allVendors = [];  // every active vendor + this student's balance at each
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
let activeTab = 0;          // 0 = home, 1 = history, 2 = account
let historyLoaded = false;  // has the history tab fetched at least once?
let paneSlide = null;       // the in-flight #home <-> #vendor slide, so it can be cut short
let justSignedIn = false;         // true between a Google sign-in and the consent check

const $ = (id) => document.getElementById(id);

// The PWA install nudge — deferred-prompt capture, platform routing, suppression
// rules, the 5 trigger points, and its funnel analytics — lives in
// install-prompt.js → window.InstallPrompt. This file only calls its trigger
// methods at the right moments (redemption / points earned / app open / manual).

/* ---------- client crash reporting ---------- */
// Uncaught errors + promise rejections post to /api/client-error so they land in
// the same error log the operator /admin dashboard reads. Best-effort: attaches
// the auth token if we have a session, never blocks, never throws.
function installErrorReporter() {
  const send = async (message, stack, context) => {
    let auth = {};
    try {
      const { data } = (await sb?.auth?.getSession?.()) ?? {};
      if (data?.session) auth = { Authorization: `Bearer ${data.session.access_token}` };
    } catch { /* not signed in yet */ }
    fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ source: 'student', message, stack, url: location.pathname, context }),
    }).catch(() => {});
  };
  window.addEventListener('error', (e) => send(e.message || 'error', e.error?.stack, { line: e.lineno, col: e.colno }));
  window.addEventListener('unhandledrejection', (e) => send(String(e.reason?.message || e.reason || 'unhandledrejection'), e.reason?.stack));
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

/* ---------- boot ---------- */

(async function boot() {
  installErrorReporter();
  capturePunchLink();              // stash a camera-scanned ?punch= link BEFORE anything can navigate it away
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
  void securePendingPunchHold();

  document.querySelectorAll('[data-signin]').forEach((b) => b.addEventListener('click', signInWithGoogle));
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
    // Home tapped while drilled into a vendor's redeem screen → return to the
    // carousel with a leftward slide, rather than re-selecting the open tab.
    if (tab === 0 && !$('vendor').hidden) {
      if (activeTab === 0) backToHomeSlide();   // on screen: animate the slide
      else { backToHome(); setTab(0); }         // off screen: reset, then slide the tab in
      return;
    }
    setTab(tab);
  });
  wireTabSwipe();   // …and the same three tabs by dragging the track itself
  // appearance: dark-mode toggle (the <head> script already applied the theme)
  applyTheme(currentTheme());
  $('dark-toggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    setTheme(next);
  });
  $('vendor-carousel').addEventListener('click', onVendorTap);
  // Info popovers: the tier (i) opens on its button; the community explainer
  // closes like every popover but no longer opens on the card itself — with a
  // balance the card opens the Move-points sheet instead (community-points.md
  // step 5), and only an empty wallet gets the explainer, because a new user's
  // first tap should say what this is, not show an empty picker.
  wireInfo('tier-info', 'tier-info-btn');
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
  $('back-btn').addEventListener('click', backToHomeSlide);
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
  // never leave the punch camera running while the tab is backgrounded
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPunchScanner();
    else if ($('punch-scan-modal').classList.contains('is-open')) startPunchScanner();
  });
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
    closeEarnSheet();
    closeMoveSheet();
    closePunchScanSheet();
    closePunchModal();
    closeInfo('tier-info', 'tier-info-btn');
    closeInfo('community-info', 'community-card');
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
  }
})();

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

  if (!session) {
    endPaneSlide(false);        // a drill-in still mid-slide would re-hide #home behind us
    $('home').hidden = false;   // reset the Home tab's sub-view for the next sign-in
    $('vendor').hidden = true;
    dropSwipe();                // a finger still down would keep writing --tab over the reset
    setTab(0, false);
    stopMyCode();
    disconnectSocket();
    balanceReady = false;   // re-login should show the balance instantly, no ticker
    communityPoints = 0;
    communityReady = false; // same: the next sign-in paints its count, no ticker
    $('community-balance').textContent = '0';
    allVendors = [];
    vendor = null;
    historyLoaded = false;
    dropHistory();              // …and unpaint the rows, or the next student reads them
    consentOk = false;          // next sign-in re-checks; never trust a stale pass
    hideConsentModal();
    dropEarnSheet();            // it lives at body level, so it would otherwise sit over the landing page
    dropMoveSheet();            // same
    dropPunchScanSheet();       // same (and it holds the camera)
    dropPunchModal();           // same
    dropItemModal();            // same, and it can be holding a live redemption QR
    syncPendingPunchNote();     // landing may need the "punch spotted" note
    // the popovers live at body level too — same reason
    closeInfo('tier-info', 'tier-info-btn');
    closeInfo('community-info', 'community-card');
    InstallPrompt.clearUser();  // stop keying install suppression to the signed-out user
    return;
  }

  // Signed in but unverified: ask the server, then this function runs again.
  if (!ready) {
    void ensureConsent(session);
    return;
  }
  // A fresh sign-in lands on the Home tab, carousel view. onAuthStateChange also
  // fires on silent token refreshes — those must NOT yank the user off a vendor
  // screen or their current tab, so only reset when the app was hidden.
  if (wasSignedOut) {
    $('home').hidden = false;
    $('vendor').hidden = true;
    setTab(0, false);
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
  startMyCode();
  connectSocket();
  void claimPendingPunch();   // a camera-scanned punch waiting through sign-in lands now
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

let consentOk = false;        // server confirmed agreement to the CURRENT version
let consentChecking = false;  // in-flight guard: auth events can fire in bursts
let consentIsRevision = false;

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
  } finally {
    consentChecking = false;
  }
}

function openConsentModal(info) {
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
  const track = $('tab-track');
  if (!animate) track.style.transition = 'none';
  track.style.setProperty('--tab', i);
  if (!animate) { void track.offsetWidth; track.style.transition = ''; }  // restore for next time

  document.querySelectorAll('.tab-btn').forEach((btn, idx) => {
    const on = idx === i;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-current', on ? 'page' : 'false');
  });

  if (i === 1) loadHistory();   // refresh activity whenever the History tab opens
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
  if ($('tab-home').classList.contains('home-sliding')) return;   // the home ↔ vendor slide owns the axis
  const t = e.touches[0];
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

// Capture phase on the track, so it lands ahead of every delegated handler
// inside it (#vendor-carousel, #items, #community-card, #back-btn, the Account
// rows). Self-removing, because a swipe that produced no click at all must not
// then eat a real tap.
function eatNextClick() {
  const track = $('tab-track');
  let timer = 0;
  const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); clearTimeout(timer); };
  track.addEventListener('click', eat, { capture: true, once: true });
  timer = setTimeout(() => track.removeEventListener('click', eat, true), 400);
}

/* ---------- history tab (last 30 days) ---------- */

async function loadHistory() {
  try {
    const res = await authFetch('/api/me/history');
    if (!res.ok) throw new Error();
    renderHistory(await res.json());
    historyLoaded = true;
  } catch {
    $('history-loading').hidden = true;
    if (!historyLoaded) {          // keep any existing list on a transient refresh failure
      $('history-list').innerHTML = '';
      $('history-empty').textContent = 'Couldn’t load your activity. Check your connection and try again.';
      $('history-empty').hidden = false;
    }
  }
}

function renderHistory(items) {
  const list = $('history-list');
  $('history-loading').hidden = true;
  list.innerHTML = '';

  if (!items.length) {
    $('history-empty').textContent = 'No activity in the last 30 days.';
    $('history-empty').hidden = false;
    return;
  }
  $('history-empty').hidden = true;

  let lastDay = null;
  items.forEach((tx) => {
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

// Back to the first-load state. historyLoaded = false alone only stops the
// background refreshes — it doesn't unpaint anything, so without this a
// sign-out leaves one student's rows on screen for whoever signs in next on the
// same device, right up until their own fetch returns.
function dropHistory() {
  $('history-list').innerHTML = '';
  $('history-loading').hidden = false;
  $('history-empty').hidden = true;
}

function historyRow(tx) {
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

/* ---------- home: tier bar (30-day score → earn multiplier) ---------- */

// Paint the meter under the wordmark: fill = score / 1000, marks at the tier
// cutoffs, scale labels sized to match each tier's share of the bar.
async function loadTier() {
  try {
    const res = await authFetch('/api/me/tier');
    if (!res.ok) throw new Error();
    renderTier(await res.json());
  } catch {
    // keep the last state (or stay hidden) on a transient failure
  }
}

function renderTier(t) {
  const bar = $('tier-bar');
  const pct = (v) => `${Math.min(100, (v / t.maxScore) * 100)}%`;

  $('tier-fill').style.width = pct(t.score);
  bar.querySelectorAll('.tier-mark').forEach((m, i) => {
    if (t.cutoffs[i] != null) m.style.left = pct(t.cutoffs[i]);
  });

  // Each label spans its tier's slice of the track (e.g. 35% / 35% / 30%)
  const edges = [0, ...t.cutoffs, t.maxScore];
  bar.querySelectorAll('.tier-scale span').forEach((s, i) => {
    if (edges[i + 1] != null) s.style.width = pct(edges[i + 1] - edges[i]);
  });

  $('tier-badge').textContent = `${t.multiplier}x points`;
  $('tier-hint').textContent =
    t.nextTierScore != null
      ? `${t.nextTierScore - t.score} to ${t.nextMultiplier}x`
      : 'Max multiplier ✓';

  bar.classList.remove('t1', 't2', 't3');
  bar.classList.add(`t${t.tier}`);
  bar.hidden = false;
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

/* ---------- home: community points (the cross-vendor wallet) ----------
   10% of everything earned at a spot is also minted into this pool
   (migration-026), and the pool isn't tied to the spot that issued it. Spending
   it means MOVING it into one vendor's balance (migration-027) — the move sheet
   below — after which the existing redeem flow takes over.

   loadCommunity() is the single seam: the socket push carries the new balance
   on an award or a move, and this refetches whenever it doesn't (an undo, a
   reconnect). */

async function loadCommunity() {
  try {
    const res = await authFetch('/api/me/community');
    if (!res.ok) throw new Error();
    setCommunityPoints((await res.json()).balance ?? 0);
  } catch {
    // keep the last painted count on a transient failure, like loadTier() does
  }
}

// Paint the counter. After the first paint a change counts up (or down) the same
// way the vendor meter does, so points landing over the socket are actually seen
// rather than silently swapped in.
function setCommunityPoints(next) {
  const prev = communityPoints;
  communityPoints = next;

  const el = $('community-balance');
  if (!communityReady) {          // first paint: just show it, no ticker
    communityReady = true;
    el.textContent = next;
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
async function loadVendors() {
  try {
    const res = await authFetch('/api/me/balances');
    if (!res.ok) throw new Error();
    allVendors = await res.json();
    renderVendors();

    if (vendor && !$('vendor').hidden) {
      const v = allVendors.find((x) => x.vendorId === vendor.vendorId);
      if (v) { vendor = v; renderItems(); renderPunchUi(); applyBalance(v.balance ?? 0); }
    }
  } catch {
    $('vendors-empty').textContent = 'Couldn’t load your spots. Check your connection and try again.';
    $('vendors-empty').hidden = false;
  }
}

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

function renderVendors() {
  const wrap = $('vendor-carousel');
  wrap.innerHTML = '';
  wrap.classList.toggle('single', allVendors.length === 1);   // lone vendor → full width
  $('vendors-empty').hidden = allVendors.length > 0;

  allVendors.forEach((v) => {
    const card = document.createElement('button');
    card.className = 'vendor-card';
    card.dataset.id = v.vendorId;
    const map = v.latitude != null && v.longitude != null ? vendorMapHtml(v.latitude, v.longitude) : '';
    if (!map) card.classList.add('no-map');   // center name + points when there's no map
    const address = v.address ? `<span class="vc-address">📍 ${escapeHtml(v.address)} 👆</span>` : '';
    // Logo (if any) loads from the cacheable endpoint, sized to the name+points height.
    const logo = v.hasLogo
      ? `<span class="vc-logo" role="img" aria-label="${escapeHtml(v.name)} logo" style="background-image:url('/api/vendor-logo/${encodeURIComponent(v.vendorId)}')"></span>`
      : '';
    // Column layout: [logo | name + points], then address, then the map at the bottom.
    card.innerHTML = `
      <span class="vc-body">
        <span class="vc-head">
          ${logo}
          <span class="vc-title">
            <span class="vc-name">${escapeHtml(v.name)}</span>
            <span class="vc-points"><span class="vc-num">${v.balance ?? 0}</span><small>pts</small></span>
          </span>
        </span>
        ${address}
      </span>
      ${map}`;
    wrap.appendChild(card);
  });
}

// Live-patch just the points number on a card (used by socket pushes on home).
function patchVendorCard(vendorId, next) {
  const card = [...$('vendor-carousel').querySelectorAll('.vendor-card')]
    .find((c) => c.dataset.id === String(vendorId));
  const num = card?.querySelector('.vc-num');
  if (num) num.textContent = next;
}

/* ---------- open / leave a vendor screen ---------- */

function onVendorTap(e) {
  const card = e.target.closest('.vendor-card');
  if (!card) return;
  // Tapping the map or the address opens directions in the user's maps app;
  // the rest of the card still opens the vendor's rewards screen.
  if (e.target.closest('.vc-map, .vc-address')) {
    const v = allVendors.find((x) => String(x.vendorId) === card.dataset.id);
    if (v?.address) openMaps(v.address);
    return;
  }
  openVendor(card.dataset.id);
}

function openVendor(vendorId) {
  const v = allVendors.find((x) => String(x.vendorId) === String(vendorId));
  if (!v) return;
  vendor = v;
  balanceReady = false;                       // paint the number instantly, no ticker
  $('pb-vendor').textContent = v.name.toUpperCase();
  renderItems();
  applyBalance(v.balance ?? 0);
  slidePanes($('vendor'), $('home'), 1);      // vendor screen in from the right, home out left
  // After the slide, not before: it un-hides the pane, and the stamp rows are
  // measured against a card that has no width while #vendor is still hidden.
  // Nothing has painted between the two calls, so the block still arrives with
  // the screen rather than a frame late.
  renderPunchUi();
}

function backToHome() {
  vendor = null;
  balanceReady = false;
  // A drill-in slide may still be in flight — tap a card, tab away, then tap
  // Home inside the 360ms. Its pending settle would hide #home, the very pane
  // we're about to show, leaving tab 0 blank until a reload. End it first, and
  // let the two hidden flags below decide what shows rather than that settle.
  endPaneSlide(false);
  $('vendor').hidden = true;
  $('home').hidden = false;
  loadVendors();                              // refresh card balances on the way back
  $('tab-home').scrollTop = 0;
}

// End the in-flight pane slide: transition listeners off, classes and inline
// transforms cleared. `hideOutgoing` is false only for an interrupting
// navigation, which sets both panes' hidden flags itself a moment later.
// Split out of slidePanes so a slide can be cut short — see backToHome.
function endPaneSlide(hideOutgoing = true) {
  if (!paneSlide) return;
  const { incoming, outgoing, settle, timer } = paneSlide;
  paneSlide = null;                               // first, so a re-entrant call is a no-op
  clearTimeout(timer);
  incoming.removeEventListener('transitionend', settle);
  const page = $('tab-home');
  page.classList.remove('home-sliding', 'home-sliding-run');
  incoming.style.transform = '';
  outgoing.style.transform = '';
  if (hideOutgoing) outgoing.hidden = true;
  page.scrollTop = 0;
}

// Slide between the two Home-tab panes. `incoming` enters from `dir` (1 = from
// the right, moving left — drilling into a vendor; -1 = from the left, moving
// right — backing out) while `outgoing` exits the other way; `outgoing` hides
// once it settles. JS drives the transforms against the .home-sliding layout.
function slidePanes(incoming, outgoing, dir) {
  const page = $('tab-home');
  if (paneSlide) return;   // a slide is already running

  // Reduced motion (or no matchMedia support): skip the animation, just swap.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    incoming.hidden = false;
    outgoing.hidden = true;
    page.scrollTop = 0;
    return;
  }

  incoming.hidden = false;                       // both panes on screen for the transition
  page.classList.add('home-sliding');
  incoming.style.transform = `translateX(${dir * 100}%)`;   // incoming waits off one edge
  outgoing.style.transform = 'translateX(0)';
  void page.offsetWidth;                          // commit the start positions

  page.classList.add('home-sliding-run');         // arm the transition...
  incoming.style.transform = 'translateX(0)';     // ...then slide the pair across
  outgoing.style.transform = `translateX(${dir * -100}%)`;

  const settle = (e) => {
    if (e && e.target !== incoming) return;       // ignore transitions bubbling from children
    endPaneSlide();
  };
  // Held in paneSlide rather than a local `done` flag, so an interrupting
  // navigation can cancel this settle instead of letting it fire against panes
  // it no longer describes.
  paneSlide = { incoming, outgoing, settle, timer: setTimeout(settle, 420) };  // timer: if transitionend never fires
  incoming.addEventListener('transitionend', settle);
}

// Back arrow / Home tap: carousel in from the left, vendor screen out to the right.
function backToHomeSlide() {
  vendor = null;
  balanceReady = false;
  loadVendors();                                  // refresh card balances on the way back
  slidePanes($('home'), $('vendor'), -1);
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
    // Catch up on (re)connect in case an update landed while we were offline.
    socket.on('connect', () => { loadVendors(); loadTier(); loadCommunity(); });
  }
  if (!socket.connected) socket.connect();
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
