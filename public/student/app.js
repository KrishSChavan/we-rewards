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
  // appearance: dark-mode toggle (the <head> script already applied the theme)
  applyTheme(currentTheme());
  $('dark-toggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    setTheme(next);
  });
  $('vendor-carousel').addEventListener('click', onVendorTap);
  // Info popovers: the tier (i) and the community card share one open/close
  // path. Each closes via its ✕, a click on the backdrop (but not the card),
  // or Esc (wired at the bottom of boot alongside the earn sheet).
  wireInfo('tier-info', 'tier-info-btn');
  wireInfo('community-info', 'community-card');
  // add-to-home-screen: the permanent manual entry point (settings) + the dev
  // reset. The sheet's own buttons are wired inside install-prompt.js.
  $('account-install').addEventListener('click', () => InstallPrompt.openManual());
  $('account-install-reset').addEventListener('click', () => { InstallPrompt.reset(); syncInstallRow(); });
  window.addEventListener('appinstalled', syncInstallRow);   // drop the row the moment it's installed
  $('back-btn').addEventListener('click', backToHomeSlide);
  $('items').addEventListener('click', onItemTap);
  $('item-close').addEventListener('click', closeItemModal);
  $('item-redeem').addEventListener('click', onRedeemTap);
  $('item-modal').addEventListener('click', (e) => { if (e.target === $('item-modal')) closeItemModal(); });
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
    $('home').hidden = false;   // reset the Home tab's sub-view for the next sign-in
    $('vendor').hidden = true;
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
    consentOk = false;          // next sign-in re-checks; never trust a stale pass
    hideConsentModal();
    dropEarnSheet();            // it lives at body level, so it would otherwise sit over the landing page
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

  $('account-email').textContent = email || '—';
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
    name.textContent = 'Couldn’t download — try again';
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

function historyRow(tx) {
  const earn = tx.type === 'earn';
  // Falls back to a generic label when the vendor is gone: a deleted vendor
  // (admin dashboard) leaves anonymized transactions with vendor_id → null, so
  // the joined vendors row is missing (migration-017).
  const vendorName = tx.vendors?.name ?? 'Vendor';
  const reward = tx.rewards?.title;
  const time = new Date(tx.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // earn → "Earned at X" + "$Y spent"; redeem → "Redeemed <reward>" + "at X"
  const title = earn
    ? `Earned at ${vendorName}`
    : (reward ? `Redeemed ${reward}` : 'Redeemed a reward');
  const sub = earn
    ? (tx.dollar_amount != null ? `$${Number(tx.dollar_amount).toFixed(2)} spent · ${time}` : time)
    : `at ${vendorName} · ${time}`;

  // points are stored positive for earn, negative for redeem
  const pts = earn ? `+${tx.points}` : `−${Math.abs(tx.points)}`;

  const row = document.createElement('div');
  row.className = `history-row ${earn ? 'earn' : 'redeem'}`;
  row.innerHTML = `
    <span class="hr-icon">${earn ? '✨' : '🎁'}</span>
    <span class="hr-body">
      <span class="hr-title">${escapeHtml(title)}</span>
      <span class="hr-sub">${escapeHtml(sub)}</span>
    </span>
    <span class="hr-points">${pts}<small>pts</small></span>`;
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
   10% of everything earned at a spot is also minted into this pool, and the
   pool spends at ANY spot rather than the one that issued it. The mint and
   redeem paths aren't built yet — community-points.md has the full plan — so
   the counter reads 0, which is the truth: nothing has been minted.

   loadCommunity() is the single seam the backend plugs into. When
   GET /api/me/community ships (step 4 of that doc) only this function body
   changes; the rendering, the ticker, and the socket path below already work. */

async function loadCommunity() {
  // TODO(community-points.md step 4): swap for the live balance —
  //   const res = await authFetch('/api/me/community');
  //   if (res.ok) setCommunityPoints((await res.json()).balance ?? 0);
  setCommunityPoints(communityPoints);
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
      if (v) { vendor = v; renderItems(); applyBalance(v.balance ?? 0); }
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
}

function backToHome() {
  vendor = null;
  balanceReady = false;
  $('vendor').hidden = true;
  $('home').hidden = false;
  loadVendors();                              // refresh card balances on the way back
  $('tab-home').scrollTop = 0;
}

// Slide between the two Home-tab panes. `incoming` enters from `dir` (1 = from
// the right, moving left — drilling into a vendor; -1 = from the left, moving
// right — backing out) while `outgoing` exits the other way; `outgoing` hides
// once it settles. JS drives the transforms against the .home-sliding layout.
function slidePanes(incoming, outgoing, dir) {
  const page = $('tab-home');
  if (page.classList.contains('home-sliding')) return;   // a slide is already running

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

  let done = false;
  const settle = (e) => {
    if (e && e.target !== incoming) return;       // ignore transitions bubbling from children
    if (done) return;
    done = true;
    incoming.removeEventListener('transitionend', settle);
    page.classList.remove('home-sliding', 'home-sliding-run');
    incoming.style.transform = '';
    outgoing.style.transform = '';
    outgoing.hidden = true;
    page.scrollTop = 0;
  };
  incoming.addEventListener('transitionend', settle);
  setTimeout(settle, 420);                        // fallback if transitionend never fires
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

  // Live items from the vendor's ITEMS tab, cheapest first
  const live = (vendor?.rewards ?? [])
    .slice()
    .sort((a, b) => a.cost_in_points - b.cost_in_points);

  live.forEach((r) => {
    const card = document.createElement('button');
    card.className = 'item-card live';
    card.dataset.id = r.id;
    card.dataset.title = r.title;
    card.dataset.cost = r.cost_in_points;
    card.dataset.emoji = r.emoji || '🎁';
    card.dataset.desc = `Redeem at ${vendor.name} for ${r.cost_in_points} points.`;
    wrap.appendChild(card);
  });

  // Decorate every card (placeholders included) with the same inner layout + lock state
  wrap.querySelectorAll('.item-card').forEach(decorateCard);

  const total = wrap.querySelectorAll('.item-card').length;
  $('items-empty').hidden = total > 0;
}

function decorateCard(card) {
  const cost = Number(card.dataset.cost);
  const affordable = balance >= cost;
  card.classList.toggle('locked', !affordable);
  card.innerHTML = `
    <span class="ic-emoji">${escapeHtml(card.dataset.emoji || '🎁')}</span>
    <span class="ic-body">
      <span class="ic-title">${escapeHtml(card.dataset.title)}</span>
      <p class="ic-status">${affordable ? 'Ready to redeem ✓' : `${cost - balance} pts to go`}</p>
    </span>
    <span class="ic-cost">${cost} pts</span>`;
}

/* ---------- item detail modal ---------- */

function onItemTap(e) {
  const card = e.target.closest('.item-card');
  if (!card) return;
  selectedItem = {
    id: card.dataset.id ?? null,
    sample: card.dataset.sample === '1',
    title: card.dataset.title,
    cost: Number(card.dataset.cost),
    emoji: card.dataset.emoji || '🎁',
    desc: card.dataset.desc || '',
  };

  $('item-emoji').textContent = selectedItem.emoji;
  $('item-title').textContent = selectedItem.title;
  $('item-cost').textContent = `${selectedItem.cost} pts`;
  $('item-desc').textContent = selectedItem.desc;

  const affordable = balance >= selectedItem.cost;
  const status = $('item-status');
  const btn = $('item-redeem');

  if (selectedItem.sample) {
    status.textContent = 'Sample item — this spot hasn’t added it yet.';
    status.className = 'detail-status locked';
    btn.disabled = true;
    btn.textContent = 'Sample item';
  } else if (!affordable) {
    status.textContent = `You have ${balance} pts — ${selectedItem.cost - balance} more to go.`;
    status.className = 'detail-status locked';
    btn.disabled = true;
    btn.textContent = 'Redeem';
  } else {
    status.textContent = `You have ${balance} pts — you’re good! ✓`;
    status.className = 'detail-status ok';
    btn.disabled = false;
    btn.textContent = 'Redeem';
  }

  // fresh open: show the Redeem button, hide any prior code, then slide up
  clearInterval(redeemCountdown);
  redeemCountdown = null;
  $('item-redeem').hidden = false;
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
    $('item-redeem').hidden = false;
    $('item-redeem').disabled = false;
    $('item-code').hidden = true;
    selectedItem = null;
    loadVendors();                     // balance may have changed while open
  }, 360);
}

/* ---------- redemption code ---------- */

async function onRedeemTap() {
  if (!selectedItem || selectedItem.sample || !vendor) return;
  const btn = $('item-redeem');
  btn.disabled = true;
  try {
    const res = await authFetch('/api/me/redeem-code', {
      method: 'POST',
      body: JSON.stringify({ vendorId: vendor.vendorId, rewardId: selectedItem.id }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('item-status').textContent = data.message || 'Couldn’t start redemption — try again.';
      $('item-status').className = 'detail-status locked';
      btn.disabled = false;
      return;
    }
    showRedemptionCode(data.code, data.ttlSeconds ?? 120);
  } catch {
    $('item-status').textContent = 'No connection — try again.';
    btn.disabled = false;
  }
}

/* Replace the Redeem button, in place, with the live QR + code + a countdown. */
function showRedemptionCode(code, seconds) {
  $('item-redeem').hidden = true;
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
