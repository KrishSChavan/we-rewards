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
let tickRaf = 0;            // requestAnimationFrame id for the counting ticker
let toastTimer = null;
let activeTab = 0;          // 0 = home, 1 = history, 2 = account
let historyLoaded = false;  // has the history tab fetched at least once?
let deferredInstallPrompt = null; // Android/Chrome: captured beforeinstallprompt event
let installPlatform = null;       // 'ios' | 'android' for the current visitor

const $ = (id) => document.getElementById(id);

// Android/Chrome fires this before showing its own install banner. Stash it so
// our "Install app" button can trigger the native prompt on demand. (No effect
// on iOS Safari, which has no such API — there we show manual steps instead.)
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = $('install-native');
  if (btn && !$('install-steps').hidden) btn.hidden = false;  // reveal it if the sheet is already open
});
window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; closeInstallModal(); });

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

/* ---------- boot ---------- */

(async function boot() {
  installErrorReporter();
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
  $('tier-info-btn').addEventListener('click', openTierInfo);
  $('tier-info-close').addEventListener('click', closeTierInfo);
  // click on the backdrop (but not the card) closes the popover
  $('tier-info').addEventListener('click', (e) => { if (e.target === $('tier-info')) closeTierInfo(); });
  // "add to home screen" prompt: Yes → per-device steps; native install on Android
  $('install-yes').addEventListener('click', showInstallSteps);
  $('install-no').addEventListener('click', closeInstallModal);
  $('install-done').addEventListener('click', closeInstallModal);
  $('install-close').addEventListener('click', closeInstallModal);
  $('install-native').addEventListener('click', triggerNativeInstall);
  $('install-modal').addEventListener('click', (e) => { if (e.target === $('install-modal')) closeInstallModal(); });
  $('back-btn').addEventListener('click', backToHomeSlide);
  $('items').addEventListener('click', onItemTap);
  $('item-close').addEventListener('click', closeItemModal);
  $('item-redeem').addEventListener('click', onRedeemTap);
  $('item-modal').addEventListener('click', (e) => { if (e.target === $('item-modal')) closeItemModal(); });

  sb.auth.onAuthStateChange((_event, session) => {
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
  $('landing').hidden = !!session;
  $('app').hidden = !session;

  if (!session) {
    $('home').hidden = false;   // reset the Home tab's sub-view for the next sign-in
    $('vendor').hidden = true;
    setTab(0, false);
    stopMyCode();
    disconnectSocket();
    balanceReady = false;   // re-login should show the balance instantly, no ticker
    allVendors = [];
    vendor = null;
    historyLoaded = false;
    return;
  }
  // A fresh sign-in lands on the Home tab, carousel view. onAuthStateChange also
  // fires on silent token refreshes — those must NOT yank the user off a vendor
  // screen or their current tab, so only reset when the app was hidden.
  if (wasSignedOut) {
    $('home').hidden = false;
    $('vendor').hidden = true;
    setTab(0, false);
    maybeShowInstallPrompt();   // nudge phone-browser users to add it to their home screen
  }
  fillAccount(session);
  loadVendors();
  loadTier();
  startMyCode();
  connectSocket();
}

/* ---------- "add to home screen" prompt ----------
   This is a plain phone website, not a native app — "download" here means adding
   it to the home screen (an installed PWA). We only nudge on a phone browser that
   isn't already running standalone, and re-ask on every load (per the design). */

// iOS Safari has no install API, so we show manual share-sheet steps; Android
// Chrome exposes beforeinstallprompt, so we can offer a one-tap native install.
const INSTALL_STEPS = {
  ios: {
    lead: 'In Safari:',
    steps: [
      ['⬆️', 'Tap the <strong>Share</strong> button in the bar at the bottom of the screen.'],
      ['➕', 'Scroll down and tap <strong>Add to Home Screen</strong>.'],
      ['✅', 'Tap <strong>Add</strong> — WeRewards lands on your home screen.'],
    ],
  },
  android: {
    lead: 'In Chrome:',
    steps: [
      ['⋮', 'Tap the <strong>menu</strong> (three dots) in the top-right.'],
      ['➕', 'Tap <strong>Add to Home screen</strong> (or <strong>Install app</strong>).'],
      ['✅', 'Tap <strong>Add</strong> — WeRewards lands on your home screen.'],
    ],
  },
};

// Running as an installed app already? Then there's nothing to nudge.
function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || window.navigator.standalone === true;   // iOS Safari's own flag
}

// 'ios' | 'android' | null (null = desktop/other → don't show at all).
function detectInstallPlatform() {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  // iPadOS 13+ reports a desktop UA, so fall back to touch-capable Mac = iPad.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return null;
}

function maybeShowInstallPrompt() {
  if (isStandalone()) return;                 // already added to the home screen
  installPlatform = detectInstallPlatform();
  if (!installPlatform) return;               // desktop / unsupported browser
  setTimeout(openInstallModal, 900);          // let the app paint first, then slide up
}

function openInstallModal() {
  if ($('app').hidden) return;                 // signed out again before the delay elapsed
  $('install-steps').hidden = true;            // always open on the yes/no ask
  $('install-ask').hidden = false;
  const ov = $('install-modal');
  ov.hidden = false;
  void ov.offsetWidth;                        // reflow so the slide-up transition runs
  ov.classList.add('is-open');
}

function closeInstallModal() {
  const ov = $('install-modal');
  if (!ov || ov.hidden || !ov.classList.contains('is-open')) return;
  ov.classList.remove('is-open');
  setTimeout(() => { ov.hidden = true; }, 360);   // wait out the slide-down
}

// "Yes, show me how" → expand the sheet to the device-specific steps.
function showInstallSteps() {
  const cfg = INSTALL_STEPS[installPlatform] || INSTALL_STEPS.android;
  $('install-steps-lead').textContent = cfg.lead;

  const list = $('install-steps-list');
  list.innerHTML = '';
  cfg.steps.forEach(([ico, html]) => {
    const li = document.createElement('li');
    // ico + copy are fixed developer strings (no user input), so innerHTML is safe here.
    li.innerHTML = `<span class="step-ico" aria-hidden="true">${ico}</span><span>${html}</span>`;
    list.appendChild(li);
  });

  // Android with a captured prompt → offer the real one-tap install above the steps.
  $('install-native').hidden = !(installPlatform === 'android' && deferredInstallPrompt);

  $('install-ask').hidden = true;
  $('install-steps').hidden = false;
}

// Fire Chrome's native install dialog (Android). Each captured event is single-use.
async function triggerNativeInstall() {
  const promptEvent = deferredInstallPrompt;
  if (!promptEvent) return;
  deferredInstallPrompt = null;
  $('install-native').hidden = true;
  promptEvent.prompt();
  try { await promptEvent.userChoice; } catch { /* dismissed */ }
  closeInstallModal();
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
  const vendorName = tx.vendors?.name ?? 'a spot';
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
    $('my-code-value').textContent = code;
  } catch {
    // keep the last code visible on a transient failure rather than blanking it
  }
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

// Fade the "how it works" popover in/out (mirrors the item sheet pattern).
function openTierInfo() {
  const ov = $('tier-info');
  ov.hidden = false;
  void ov.offsetWidth;          // reflow so the fade-in transition runs
  ov.classList.add('is-open');
}

function closeTierInfo() {
  const ov = $('tier-info');
  if (ov.hidden) return;
  ov.classList.remove('is-open');
  setTimeout(() => { ov.hidden = true; }, 160);   // wait out the fade
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
    const address = v.address ? `<span class="vc-address">📍 ${escapeHtml(v.address)}</span>` : '';
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
      if (v) v.balance = next;
      patchVendorCard(payload.vendorId, next);                       // live-update the home card
      if (vendor && payload.vendorId === vendor.vendorId) applyBalance(next); // and the open meter
      loadTier();                             // an earn just landed — score may have moved
      if (historyLoaded) loadHistory();       // ...and it's a new activity row
    });
    // Catch up on (re)connect in case an update landed while we were offline.
    socket.on('connect', () => { loadVendors(); loadTier(); });
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
  tickTo(prev, next);
  notifyPoints(next - prev);

  // A drop while the sheet is showing a code means this redemption just went
  // through — close the card (after a beat so the "Redeemed" toast registers).
  if (next < prev && !$('item-modal').hidden && !$('item-code').hidden) {
    setTimeout(closeItemModal, 1000);
  }
}

// Count the meter from one value to another (eased, capped at 1s).
function tickTo(from, to) {
  const el = $('pb-balance');
  cancelAnimationFrame(tickRaf);
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
    if (p < 1) tickRaf = requestAnimationFrame(step);
    else el.textContent = to;
  };
  tickRaf = requestAnimationFrame(step);
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

/* Replace the Redeem button, in place, with the live code + a countdown. */
function showRedemptionCode(code, seconds) {
  $('item-redeem').hidden = true;
  $('item-status').textContent = 'Show this code at the counter';
  $('item-status').className = 'detail-status ok';
  $('item-code-value').textContent = code;
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
