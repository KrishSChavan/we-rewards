/* WeRewards — vendor terminal client
   Tabs:  AWARD  → scan customer's QR (or type their 6-digit code) → name + balance + $ keypad → award
          REDEEM → PIN → scan redemption QR (or type the 4-digit code) → confirm (name + points + item) → deduct
          ITEMS  → PIN → manage rewards (add / edit / on-off)
*/

let sb = null;             // supabase client
let config = null;         // vendor config from /api/vendor/config
let rewards = [];          // vendor's rewards from /api/vendor/rewards
let mode = 'award';        // 'award' | 'redeem' | 'manage'
let pinTarget = null;      // where the PIN gate leads on success
let currentEarnCode = null;    // customer's 6-digit earn code on the award pad
let currentMultiplier = 1;     // scanned customer's tier multiplier (1x/1.5x/2x)
let pendingRedeemCode = null;  // 4-digit redeem code awaiting vendor confirmation
let pendingRedeemKind = 'reward'; // 'reward' (redeem_codes) | 'punch' (punch_redeem_codes)
let padValue = '';         // exact-amount entry string
let pinValue = '';
let pinUnlocked = false;   // set once the PIN is entered correctly; lives in
                           // memory only, so a page refresh always re-asks
let pinToken = null;       // server-side PIN session token from verify-pin, sent
                           // as X-Vendor-Pin on redeem/manage requests
let pinAction = null;      // callback to run after a successful PIN unlock (e.g.
                           // "undo last" from the un-gated award screen)
let selectedEmoji = '🎁';  // emoji picked in the item form
let busy = false;          // guards double-taps / double-submits
let idleTimeout = null;
let editingRewardId = null;
let editingVisitsWas = null;   // punch price the item had when the form opened
let rewardRaiseArmed = false;  // two-tap confirm for raising a punch price
let logoValue = null;      // current logo data-URL (null = none) shown in Settings
let logoChanged = false;   // only PATCH the logo when the vendor actually changed it
let lastActivity = null;   // most recent transaction (for the "Undo last" button)
let undoLastArmed = false; // two-tap confirm state for "Undo last"
let undoLastTimer = null;
let undoExpiryTimer = null; // hides "Undo last" when the 1-min window elapses
let settingsBaseline = null; // keyed snapshot of the Settings form at load/save, for the unsaved-changes guard
let pendingMode = null;    // tab the vendor tried to open while Settings had unsaved edits
// Idempotency for awards: reuse one token across a retry of the SAME award
// (customer + amount) so the server can dedupe if a network drop hid a success.
// { key, token } — kept only while the last attempt failed at the network layer.
let pendingAward = null;

// Undo is only allowed within 1 minute of a transaction (anti-abuse). The server
// enforces this authoritatively (reverse_transaction RPC); the client mirrors it
// so the button simply disappears once the window is gone.
const UNDO_WINDOW_MS = 60_000;

const $ = (id) => document.getElementById(id);

/* ---------- client crash reporting ---------- */
// Uncaught errors + rejections post to /api/client-error → the operator /admin
// error log. Best-effort, non-blocking.
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
      body: JSON.stringify({ source: 'vendor', message, stack, url: location.pathname, context }),
    }).catch(() => {});
  };
  window.addEventListener('error', (e) => send(e.message || 'error', e.error?.stack, { line: e.lineno, col: e.colno }));
  window.addEventListener('unhandledrejection', (e) => send(String(e.reason?.message || e.reason || 'unhandledrejection'), e.reason?.stack));
}

const screens = [
  'screen-login', 'screen-recover', 'screen-scan', 'screen-pad',
  'screen-pin', 'screen-redeem-scan', 'screen-redeem-confirm', 'screen-manage', 'screen-stats',
  'screen-settings', 'screen-punch', 'screen-deals',
];

/* ---------- boot ---------- */

(async function boot() {
  installErrorReporter();
  const pub = await (await fetch('/api/public-config')).json();
  // Separate storage key from the student app (same origin + project) so a
  // vendor sign-in never clobbers a student session on the same device.
  sb = window.supabase.createClient(pub.supabaseUrl, pub.supabaseAnonKey, {
    auth: { storageKey: 'psu-vendor-auth' },
  });

  $('login-btn').addEventListener('click', signIn);
  $('login-password').addEventListener('keydown', (e) => e.key === 'Enter' && signIn());
  $('login-forgot').addEventListener('click', enterRecover);
  $('recover-back').addEventListener('click', leaveRecover);
  $('recover-btn').addEventListener('click', submitRecover);
  $('recover-confirm').addEventListener('keydown', (e) => e.key === 'Enter' && submitRecover());
  // Show the code the way it was read out (grouped, upper case) while it's typed.
  $('recover-code').addEventListener('input', (e) => { e.target.value = formatResetCodeInput(e.target.value); });
  $('tab-award').addEventListener('click', () => switchMode('award'));
  $('tab-redeem').addEventListener('click', () => switchMode('redeem'));
  $('tab-punch').addEventListener('click', () => switchMode('punch'));
  $('tab-manage').addEventListener('click', () => switchMode('manage'));
  $('tab-deals').addEventListener('click', () => switchMode('deals'));
  $('tab-stats').addEventListener('click', () => switchMode('stats'));
  $('tab-settings').addEventListener('click', () => switchMode('settings'));
  $('punch-fullscreen').addEventListener('click', enterPunchFullscreen);
  $('punch-exit-fs').addEventListener('click', exitPunchFullscreen);
  // System fullscreen exited some other way (Esc, swipe): drop the CSS kiosk too.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('punch-fs')) exitPunchFullscreen();
  });
  $('set-punch').addEventListener('click', () => { toggleSwitch($('set-punch')); refreshSettingsDirty(); });
  $('stats-refresh').addEventListener('click', () => loadAnalytics());
  $('settings-save').addEventListener('click', () => saveSettings());
  $('settings-reset').addEventListener('click', () => renderSettings(loadedSettings));
  $('set-pw-save').addEventListener('click', () => updatePassword());
  $('tier-add').addEventListener('click', () => { addTierRow(); refreshSettingsDirty(); });
  $('set-ratio').addEventListener('input', updateRatioExample);
  $('set-exact').addEventListener('click', () => { toggleSwitch($('set-exact')); refreshSettingsDirty(); });
  $('set-logo-input').addEventListener('change', onLogoPick);
  $('set-logo-remove').addEventListener('click', removeLogo);
  $('signout-btn').addEventListener('click', openSignOutConfirm);
  $('signout-cancel').addEventListener('click', closeSignOutConfirm);
  $('signout-go').addEventListener('click', signOut);
  // Any keystroke inside Settings re-checks whether there's something unsaved.
  $('screen-settings').addEventListener('input', refreshSettingsDirty);
  $('guard-save').addEventListener('click', guardSaveAndLeave);
  $('guard-discard').addEventListener('click', guardDiscardAndLeave);
  $('guard-stay').addEventListener('click', closeSettingsGuard);
  // Refreshing / closing the tab with unsaved Settings edits gets the browser's
  // native "leave site?" prompt (mirrors the in-app guard for real navigation).
  window.addEventListener('beforeunload', (e) => {
    if (isSettingsDirty()) { e.preventDefault(); e.returnValue = ''; }
  });
  $('pad-cancel').addEventListener('click', () => enterScan());
  $('pad-award').addEventListener('click', () => awardAmount(Number(padValue)));
  $('quick-awards').addEventListener('click', onQuickAward);
  $('undo-last-award').addEventListener('click', onUndoLastTap);
  $('undo-last-redeem').addEventListener('click', onUndoLastTap);
  $('amount-keypad').addEventListener('click', onAmountKey);
  $('pin-keypad').addEventListener('click', onPinKey);
  $('redeem-cancel').addEventListener('click', () => enterRedeemScan());
  $('redeem-confirm').addEventListener('click', confirmRedeem);
  $('add-reward-btn').addEventListener('click', () => openRewardForm(null));
  $('reward-form-cancel').addEventListener('click', closeRewardForm);
  $('reward-form-save').addEventListener('click', saveReward);
  $('emoji-grid').addEventListener('click', onEmojiPick);
  $('earn-code-form').addEventListener('submit', (e) => { e.preventDefault(); submitEarnCode(); });
  $('redeem-code-form').addEventListener('submit', (e) => { e.preventDefault(); submitRedeemCode(); });
  $('earn-code-input').addEventListener('input', (e) => { e.target.value = normalizeEarn(e.target.value); });
  $('redeem-code-input').addEventListener('input', (e) => { e.target.value = normalizeRedeem(e.target.value); });
  $('earn-keypad').addEventListener('click', (e) => onCodeKey(e, 'earn-code-input', normalizeEarn));
  $('redeem-keypad').addEventListener('click', (e) => onCodeKey(e, 'redeem-code-input', normalizeRedeem));
  $('deal-title').addEventListener('input', onDealInput);
  $('deal-body').addEventListener('input', onDealInput);
  $('deal-audience').addEventListener('click', onAudiencePick);
  $('deal-duration').addEventListener('click', onDurationPick);
  $('deal-send').addEventListener('click', onDealSendTap);
  $('deal-history').addEventListener('click', onDealHistoryTap);
  setupQrScanning();

  const { data } = await sb.auth.getSession();
  if (data?.session) await enterApp();
  else show('screen-login');

  // Register the PWA service worker (scope /terminal/) so the terminal is
  // installable to a device and its shell works offline. Best-effort.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/terminal/sw.js').catch(() => {});
  }
})();

async function signIn() {
  const btn = $('login-btn');
  btn.disabled = true;
  $('login-error').hidden = true;
  $('login-success').hidden = true;   // clear the "password updated" note once they act on it
  const { error } = await sb.auth.signInWithPassword({
    email: $('login-email').value.trim(),
    password: $('login-password').value,
  });
  btn.disabled = false;
  if (error) {
    $('login-error').textContent = 'Sign-in failed. Check email and password.';
    $('login-error').hidden = false;
    return;
  }
  await enterApp();
}

/* ---------- forgot password ----------
   There is no recovery email in this stack (no SMTP, and vendors sign in with a
   password rather than Google), so recovery is out-of-band: the operator mints a
   one-time code in /admin, reads it down the phone, and it gets typed in here.
   POST /api/vendor/recover verifies it and sets the new password.

   The server treats every failure identically on purpose — unknown email, wrong
   code, expired, already used — so this screen must not try to explain which one
   it was. Just show what came back. */

function enterRecover() {
  // Carry over whatever they already typed on the login card.
  $('recover-email').value = $('login-email').value.trim();
  clearRecoverFields();
  $('recover-error').hidden = true;
  $('recover-success').hidden = true;
  $('recover-btn').disabled = false;
  show('screen-recover');
  $('recover-code').focus();
}

function leaveRecover() {
  clearRecoverFields();
  $('login-error').hidden = true;
  // Also drop any "Password updated" note from an earlier reset — backing out of
  // a second attempt must not leave a green banner claiming this one succeeded.
  $('login-success').hidden = true;
  show('screen-login');
}

function clearRecoverFields() {
  // Never leave a live code or a typed password sitting in the DOM behind
  // another screen — same reasoning as the sign-out cleanup below.
  $('recover-code').value = '';
  $('recover-password').value = '';
  $('recover-confirm').value = '';
}

// Cosmetic echo of the code's printed shape while it is typed: strip
// separators, upper-case, re-group as XXXX-XXXX. The authoritative parse is
// normalizeResetCode in src/lib/reset-codes.js, which also folds look-alikes
// (O to 0, I to 1, ...) — so a vendor who types what they heard still matches
// even if this preview shows the letter.
function formatResetCodeInput(raw) {
  const bare = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return bare.length > 4 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : bare;
}

function recoverError(msg) {
  const el = $('recover-error');
  el.textContent = msg;
  el.hidden = false;
  $('recover-btn').disabled = false;
}

async function submitRecover() {
  const btn = $('recover-btn');
  $('recover-error').hidden = true;
  $('recover-success').hidden = true;

  const email = $('recover-email').value.trim();
  const code = $('recover-code').value.trim();
  const password = $('recover-password').value;
  const confirm = $('recover-confirm').value;

  // Local checks first so an obvious typo never spends one of the code's five
  // server-side attempts.
  if (!email || !code) return recoverError('Enter your email and the reset code.');
  if (password.length < 8) return recoverError('Password must be at least 8 characters.');
  if (password.length > 72) return recoverError('Password must be 72 characters or fewer.');
  if (password !== confirm) return recoverError('The two passwords don’t match.');

  btn.disabled = true;
  try {
    const res = await fetch('/api/vendor/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, newPassword: password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return recoverError(data.message || 'Couldn’t reset the password. Ask for a new code.');
    }

    const ok = $('recover-success');
    ok.textContent = data.vendorName
      ? `Password updated for ${data.vendorName}.`
      : 'Password updated.';
    ok.hidden = false;

    // Hand them back to the login card with the email already filled in, so the
    // only thing left to do is type the password they just chose.
    const signedInEmail = email;
    clearRecoverFields();
    setTimeout(() => {
      $('login-email').value = signedInEmail;
      $('login-password').value = '';
      $('login-error').hidden = true;
      const note = $('login-success');
      note.textContent = 'Password updated. Sign in with your new password.';
      note.hidden = false;
      show('screen-login');
      $('login-password').focus();
    }, 1200);
  } catch {
    recoverError('No connection. Check the internet and try again.');
  }
}

async function enterApp() {
  const res = await authFetch('/api/vendor/config');
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    await sb.auth.signOut();
    // A vendor toggled off by the operator returns VENDOR_DISABLED with a clear
    // message; anything else falls back to the generic not-linked copy. Show the
    // server's message when we have one so a deactivated vendor knows why.
    $('login-error').textContent = data?.message || 'This account is not linked to a vendor.';
    $('login-error').hidden = false;
    show('screen-login');
    return;
  }
  config = await res.json();
  $('vendor-name').textContent = config.name;
  $('signout-vendor').textContent = config.name;   // Settings → Sign out card
  $('shell').hidden = false;
  $('screen-login').hidden = true;
  syncPunchTab();
  refreshRewards();
  refreshLastActivity();
  enterScan();
}

/* ---------- helpers ---------- */

async function authFetch(path, opts = {}) {
  const { data } = await sb.auth.getSession();
  return fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data?.session?.access_token ?? ''}`,
      // The server enforces the staff PIN on redeem/manage routes; send the
      // session token when we have one (harmless on routes that ignore it).
      ...(pinToken ? { 'X-Vendor-Pin': pinToken } : {}),
      ...(opts.headers || {}),
    },
  });
}

// The PIN session can expire mid-shift; a 401 PIN_REQUIRED from a gated route
// means re-authenticate. Reset the gate and bounce back to the PIN screen.
function handlePinRequired(res, data) {
  if (res.status === 401 && data?.error === 'PIN_REQUIRED') {
    pinUnlocked = false;
    pinToken = null;
    pinValue = '';
    // The response can arrive after the vendor has already moved to an UN-gated
    // tab (AWARD, PUNCH) — a slow gated request from the tab they left. Drop the
    // gate but stay put: replacing a live punch-in display with a PIN pad nobody
    // asked for would strand the counter, and the next gated tab re-prompts
    // anyway now that pinUnlocked is false.
    if (mode === 'award' || mode === 'punch') return true;
    pinTarget = mode;
    renderPinDots();
    $('pin-error').hidden = true;
    show('screen-pin');
    return true;
  }
  return false;
}

function show(id) {
  screens.forEach((s) => ($(s).hidden = s !== id));
  clearTimeout(idleTimeout);
  // If the vendor walks away mid-transaction, fall back to the scan screen
  if (id === 'screen-pad') idleTimeout = setTimeout(() => enterScan(), 60_000);
  if (id === 'screen-redeem-confirm') idleTimeout = setTimeout(() => enterRedeemScan(), 60_000);
  syncScanners();   // camera runs only while its scan screen is the visible one
  syncPunch();      // rotating code refreshes only while the PUNCH screen shows
}

function setTabs(active) {
  $('tab-award').classList.toggle('is-active', active === 'award');
  $('tab-redeem').classList.toggle('is-active', active === 'redeem');
  $('tab-punch').classList.toggle('is-active', active === 'punch');
  $('tab-manage').classList.toggle('is-active', active === 'manage');
  $('tab-deals').classList.toggle('is-active', active === 'deals');
  $('tab-stats').classList.toggle('is-active', active === 'stats');
  $('tab-settings').classList.toggle('is-active', active === 'settings');
}

// Land on the screen for a mode once the PIN gate (if any) is cleared. PUNCH
// is un-gated, but a PIN prompt can still land while it's the active tab — a
// slow gated request from a previous tab answering 401 mid-shift — so it needs
// a branch here or the terminal returns to REDEEM with the PUNCH tab lit.
function enterModeScreen(m) {
  if (m === 'manage') enterManage();
  else if (m === 'deals') enterDeals();
  else if (m === 'stats') enterStats();
  else if (m === 'settings') enterSettings();
  else if (m === 'punch') enterPunch();
  else enterRedeemScan();
}

function switchMode(next) {
  if (mode === next) {
    // Normally a no-op, with one exception: the "Undo last" PIN detour shows
    // the PIN pad without changing `mode`, so the active tab (and the pad's
    // Cancel key, which routes here) must still offer a way off it. Award is
    // un-gated, so bailing back to its scan screen is always safe; PIN-gated
    // tabs stay on the pad so the gate can't be skipped by re-tapping the tab.
    if (next === 'award' && !$('screen-pin').hidden) {
      pinValue = '';
      pinAction = null;
      enterScan();
    }
    return;
  }

  // Leaving Settings with unsaved edits: hold the navigation and ask first, so a
  // vendor can't lose changes by tapping another tab. The guard's buttons decide
  // whether the switch goes through (Save & leave / Discard) or is cancelled.
  if (mode === 'settings' && isSettingsDirty()) {
    pendingMode = next;
    $('settings-guard').hidden = false;
    return;
  }

  proceedSwitchMode(next);
}

function proceedSwitchMode(next) {
  if (mode === next) return;
  pinValue = '';
  pinAction = null;   // a tab switch cancels any deferred PIN action (e.g. undo)

  if (next === 'award') {
    mode = 'award';
    setTabs('award');
    enterScan();
    return;
  }

  // PUNCH is display-only (the rotating code can only give customers punches),
  // so like AWARD it sits outside the PIN gate.
  if (next === 'punch') {
    mode = 'punch';
    setTabs('punch');
    enterPunch();
    return;
  }

  // redeem, manage, deals, and stats are behind the PIN — but only once per
  // page session. pinUnlocked is a plain in-memory flag, so refreshing re-asks.
  if (config.hasPin && !pinUnlocked) {
    mode = next;
    pinTarget = next;
    setTabs(next);
    renderPinDots();
    $('pin-error').hidden = true;
    show('screen-pin');
  } else {
    mode = next;
    setTabs(next);
    enterModeScreen(next);
  }
}

/* ---------- code entry helpers ---------- */

// Earn codes are 6 digits; redeem codes are 4 digits. Normalize as the
// vendor types so the field only ever holds valid characters.
function normalizeEarn(v) {
  return String(v || '').replace(/\D/g, '').slice(0, 6);
}

function normalizeRedeem(v) {
  return String(v || '').replace(/\D/g, '').slice(0, 4);
}

// On-screen number pad next to a code field: digits append, ⌫ deletes the last
// digit, Clear empties. `normalize` caps the length + strips non-digits, so this
// stays in lockstep with what the field would accept from a physical keyboard.
function onCodeKey(e, inputId, normalize) {
  const btn = e.target.closest('button');
  const k = btn?.dataset?.k;
  if (!k) return;
  const input = $(inputId);
  let v = input.value;
  if (k === 'back') v = v.slice(0, -1);
  else if (k === 'clear') v = '';
  else v = v + k;
  input.value = normalize(v);
  // Deliberately don't focus the input: the value is set directly, and focusing
  // would re-surface the device's native keyboard over the on-screen pad.
}

/* ---------- QR camera scanner ----------
   The camera is the primary input on both scan screens; the keypads stay as the
   typed fallback. QR payloads are pure transport for the same codes the server
   already mints:
     WRW:E:123456 → customer earn code     WRW:R:1234 → redemption code
   (bare 6/4-digit payloads are accepted defensively). Decoding is deliberately
   belt-and-braces: the native BarcodeDetector is used where it advertises
   qr_code support, but a jsQR canvas loop joins in if the detector produces
   nothing within a few seconds — some builds exist yet silently never match,
   which is what killed the previous camera scanner here. Where BarcodeDetector
   is missing entirely (iPad Safari) jsQR runs from the start. */

const CAMERA_KEY = 'wrw-terminal-camera';  // preferred camera deviceId (localStorage)
const SCAN_DEBOUNCE_MS = 3000;    // ignore re-reads of the same payload inside this window
                                  // (counted in camera-on time — start() re-arms it)
const SCAN_BANNER_MS = 4000;      // wrong-screen banner auto-dismiss
const JSQR_INTERVAL_MS = 120;     // ~8 decode attempts/sec keeps an iPad responsive
const JSQR_MAX_DIM = 640;         // downscale frames before jsQR for speed
const DETECTOR_GRACE_MS = 3000;   // BarcodeDetector gets this long before jsQR joins in

// Per-screen scanner UI state. `manual` = the vendor chose (or a camera failure
// forced) the keypad; it sticks for the session so a typing-first vendor isn't
// bounced back to the camera after every transaction.
const scanUi = {
  earn: {
    expect: 'earn',
    scanArea: 'earn-scan-area', manualArea: 'earn-manual-area',
    frame: 'earn-qr-frame', status: 'earn-qr-status', cameraMsg: 'earn-camera-msg',
    banner: 'earn-qr-banner', bannerText: 'earn-qr-banner-text', bannerGo: 'earn-qr-banner-go',
    defaultStatus: 'Point the camera at the QR code in the customer’s WeRewards app.',
    manual: false, cameraMsgText: null, scanner: null, bannerTimer: null, statusTimer: null,
  },
  redeem: {
    expect: 'redeem',
    scanArea: 'redeem-scan-area', manualArea: 'redeem-manual-area',
    frame: 'redeem-qr-frame', status: 'redeem-qr-status', cameraMsg: 'redeem-camera-msg',
    banner: 'redeem-qr-banner', bannerText: 'redeem-qr-banner-text', bannerGo: 'redeem-qr-banner-go',
    defaultStatus: 'Point the camera at the customer’s redemption QR code.',
    manual: false, cameraMsgText: null, scanner: null, bannerTimer: null, statusTimer: null,
  },
};

// WRW:E:<6 digits> / WRW:R:<4 digits> / WRW:P:<4 digits> per the shared
// student-app contract; bare digit runs are tolerated in case a QR was
// generated without the prefix. A URL carrying ?punch= is this terminal's own
// rotating punch-in code reflected back at the camera — named so the scanner
// can explain it instead of calling it foreign.
function parseQrPayload(raw) {
  const s = String(raw ?? '').trim();
  let m = /^WRW:E:(\d{6})$/i.exec(s);
  if (m) return { kind: 'earn', code: m[1] };
  m = /^WRW:R:(\d{4})$/i.exec(s);
  if (m) return { kind: 'redeem', code: m[1] };
  // WRW:P: was the punch-card code's own prefix before migration-029 folded
  // both code tables into one. The student app no longer mints it, but a phone
  // running a cached build still might, and the digits now resolve through the
  // same preview endpoint — so accept it rather than calling it foreign.
  m = /^WRW:P:(\d{4})$/i.exec(s);
  if (m) return { kind: 'redeem', code: m[1] };
  if (/[?&]punch=/.test(s)) return { kind: 'punch-url' };
  if (/^\d{6}$/.test(s)) return { kind: 'earn', code: s };
  if (/^\d{4}$/.test(s)) return { kind: 'redeem', code: s };
  return null;
}

function cameraErrorMessage(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access is blocked. Allow it in the browser’s site settings, or enter codes manually.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera found on this device. Enter codes manually.';
  }
  if (name === 'NotReadableError') {
    return 'Another app is using the camera. Close it, or enter codes manually.';
  }
  return 'Couldn’t start the camera. Enter codes manually.';
}

/** One camera + decoder pipeline bound to a <video>. start() is safe to call
 *  repeatedly (no-op while running); stop() always releases every track. */
function createScanner({ videoId, flipId, onPayload, onFail }) {
  const video = $(videoId);
  const flipBtn = $(flipId);
  let stream = null;
  let running = false;
  let paused = false;        // wrong-screen banner up → sightings are ignored
  let session = 0;           // bumped by stop(); stale async work checks it and bails
  let rafId = 0;
  let detectorTimer = null;  // interval driving BarcodeDetector.detect
  let jsqrTimer = null;      // delayed jsQR kick-off while the detector gets its chance
  let jsqrOn = false;
  let canvas = null;
  let ctx2d = null;
  let lastAttempt = 0;
  let devices = [];
  let lastPayload = null;    // decode debounce — survives stop/start on purpose,
  let lastPayloadAt = 0;     // so a re-shown QR isn't instantly resubmitted

  function readStoredCamera() {
    try { return localStorage.getItem(CAMERA_KEY); } catch { return null; }
  }

  async function openStream() {
    const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
    const saved = readStoredCamera();
    if (saved) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: false, video: { ...base, deviceId: { exact: saved } },
        });
      } catch { /* remembered camera unplugged — fall through to the default pick */ }
    }
    return navigator.mediaDevices.getUserMedia({
      audio: false, video: { ...base, facingMode: { ideal: 'environment' } },
    });
  }

  // Resolve true only once the video is actually delivering frames —
  // loadedmetadata alone can fire while videoWidth is still 0, and decoding
  // before real frames arrive was one cause of the old scanner's blindness.
  function waitForFrames(my) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const check = () => {
        if (session !== my) return resolve(false);
        if (video.readyState >= 2 && video.videoWidth > 0) return resolve(true);
        if (Date.now() - t0 > 8000) return resolve(false);
        setTimeout(check, 50);
      };
      video.addEventListener('loadedmetadata', check, { once: true });
      check();
    });
  }

  async function start() {
    if (running) return;
    const my = ++session;
    if (!window.isSecureContext) {
      return onFail('The camera needs a secure (https) connection. Enter codes manually.');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      return onFail('This browser can’t use the camera. Enter codes manually.');
    }
    let s;
    try {
      s = await openStream();
    } catch (err) {
      if (session === my) onFail(cameraErrorMessage(err));
      return;
    }
    if (session !== my) { s.getTracks().forEach((t) => t.stop()); return; }
    stream = s;
    video.srcObject = stream;
    try { await video.play(); } catch { /* autoplay+muted+playsinline: frames still arrive */ }
    const ready = await waitForFrames(my);
    // Cancelled during warm-up (stop(), or a newer start() that bumped the
    // session): release this stream's tracks explicitly — a newer start() may
    // already have overwritten `stream`, which would orphan this one and leave
    // the camera engaged (light on) with no way to release it.
    if (session !== my) { s.getTracks().forEach((t) => t.stop()); return; }
    if (!ready) {
      stop();
      return onFail('The camera started but sent no picture. Enter codes manually.');
    }
    running = true;
    paused = false;
    // The camera was off in between (result flood, tab away), so we couldn't see
    // whether the last QR ever left the frame — restart its debounce window from
    // now. Otherwise a code still held up across a >SCAN_DEBOUNCE_MS gap would
    // be treated as new and instantly re-submitted: a double award on the earn
    // side, or a spurious "CAN'T REDEEM" right after a successful redemption.
    if (lastPayload) lastPayloadAt = Date.now();
    refreshDeviceList();   // async, best-effort — reveals the flip button when >1 camera
    startDecoders(my);
  }

  function stop() {
    session++;             // cancels any in-flight start() and decoder callbacks
    running = false;
    paused = false;
    jsqrOn = false;
    cancelAnimationFrame(rafId);
    clearInterval(detectorTimer);
    clearTimeout(jsqrTimer);
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    video.srcObject = null;
  }

  async function startDecoders(my) {
    let detector = null;
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch { detector = null; }
    }
    if (session !== my) return;
    if (!detector) return startJsqr(my);

    let produced = false;   // has the native detector returned ANY match yet?
    let detBusy = false;    // don't stack detect() calls if one runs long
    detectorTimer = setInterval(async () => {
      if (detBusy || session !== my) return;
      detBusy = true;
      try {
        const codes = await detector.detect(video);
        if (session === my && codes?.length) {
          produced = true;
          if (codes[0].rawValue != null) handlePayload(String(codes[0].rawValue));
        }
      } catch { /* some builds throw forever — the jsQR fallback below covers it */
      } finally { detBusy = false; }
    }, 130);
    // The historical failure mode: BarcodeDetector exists but never matches.
    // If it hasn't produced anything shortly after startup, run jsQR alongside
    // it — whichever decoder hits first wins.
    jsqrTimer = setTimeout(() => { if (session === my && !produced) startJsqr(my); }, DETECTOR_GRACE_MS);
  }

  function startJsqr(my) {
    if (session !== my || jsqrOn) return;
    jsqrOn = true;
    lastAttempt = 0;
    rafId = requestAnimationFrame(jsqrTick);
  }

  // rAF loop throttled by timestamp: decode ~8×/sec, not every frame.
  function jsqrTick(ts) {
    if (!running || !jsqrOn) return;
    rafId = requestAnimationFrame(jsqrTick);
    if (ts - lastAttempt < JSQR_INTERVAL_MS || !video.videoWidth) return;
    lastAttempt = ts;
    const scale = Math.min(1, JSQR_MAX_DIM / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const h = Math.max(1, Math.round(video.videoHeight * scale));
    if (!canvas) {
      canvas = document.createElement('canvas');
      ctx2d = canvas.getContext('2d', { willReadFrequently: true });
    }
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    let img;
    try {
      ctx2d.drawImage(video, 0, 0, w, h);
      img = ctx2d.getImageData(0, 0, w, h);
    } catch { return; }   // a mid-teardown stream can throw on draw/read
    // attemptBoth also reads light-on-dark (inverted) codes — dark-mode phones.
    const hit = typeof jsQR === 'function' ? jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' }) : null;
    if (hit?.data) handlePayload(String(hit.data));
  }

  function handlePayload(raw) {
    if (!running || paused) return;
    // Another request is mid-flight (e.g. an undo fired from this screen): drop
    // the sighting BEFORE the debounce bookkeeping. Recording it here would let
    // every later sighting refresh the debounce window, so a QR first seen while
    // busy would never submit while it stayed in view — this way it goes through
    // on the first sighting after the request settles.
    if (busy) return;
    const now = Date.now();
    if (raw === lastPayload && now - lastPayloadAt < SCAN_DEBOUNCE_MS) {
      lastPayloadAt = now;   // still in view — keep holding the debounce window open
      return;
    }
    lastPayload = raw;
    lastPayloadAt = now;
    onPayload(raw);
  }

  async function refreshDeviceList() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      devices = all.filter((d) => d.kind === 'videoinput' && d.deviceId);
    } catch { devices = []; }
    flipBtn.hidden = devices.length < 2;
  }

  // Cycle to the next camera and remember it for future sessions.
  async function flip() {
    await refreshDeviceList();
    if (devices.length < 2) return;
    const cur = stream?.getVideoTracks?.()[0]?.getSettings?.()?.deviceId;
    const i = devices.findIndex((d) => d.deviceId === cur);
    const next = devices[(i + 1) % devices.length];
    try { localStorage.setItem(CAMERA_KEY, next.deviceId); } catch { /* private mode */ }
    stop();
    start();
  }

  return {
    start, stop, flip,
    setPaused(v) { paused = v; },
    isRunning: () => running,
  };
}

function setupQrScanning() {
  scanUi.earn.scanner = createScanner({
    videoId: 'earn-qr-video', flipId: 'earn-qr-flip',
    onPayload: (raw) => onScanPayload('earn', raw),
    onFail: onCameraFail,
  });
  scanUi.redeem.scanner = createScanner({
    videoId: 'redeem-qr-video', flipId: 'redeem-qr-flip',
    onPayload: (raw) => onScanPayload('redeem', raw),
    onFail: onCameraFail,
  });

  $('earn-qr-flip').addEventListener('click', () => scanUi.earn.scanner.flip());
  $('redeem-qr-flip').addEventListener('click', () => scanUi.redeem.scanner.flip());
  $('earn-manual-btn').addEventListener('click', () => setManualMode('earn', true));
  $('redeem-manual-btn').addEventListener('click', () => setManualMode('redeem', true));
  $('earn-scan-btn').addEventListener('click', () => setManualMode('earn', false));
  $('redeem-scan-btn').addEventListener('click', () => setManualMode('redeem', false));
  // Wrong-screen banner jumps go through switchMode like a tab tap would, so
  // the Redeem PIN gate still applies.
  $('earn-qr-banner-go').addEventListener('click', () => { hideScanBanner('earn'); switchMode('redeem'); });
  $('redeem-qr-banner-go').addEventListener('click', () => { hideScanBanner('redeem'); switchMode('award'); });
  $('earn-qr-banner-close').addEventListener('click', () => hideScanBanner('earn'));
  $('redeem-qr-banner-close').addEventListener('click', () => hideScanBanner('redeem'));

  // Kiosk hygiene: never leave the camera running while the tab is backgrounded.
  // Same for the punch loop — no point refreshing a code nobody can see (and a
  // backgrounded timer would fall behind anyway; syncPunch restarts it cleanly).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { scanUi.earn.scanner.stop(); scanUi.redeem.scanner.stop(); stopPunchLoop(); }
    else { syncScanners(); syncPunch(); }
  });
}

function activeScanKey() {
  if (!$('screen-scan').hidden) return 'earn';
  if (!$('screen-redeem-scan').hidden) return 'redeem';
  return null;
}

// Reconcile both scan screens with reality: camera on only for the visible scan
// screen in scanner mode; keypad shown when the vendor (or a camera failure)
// picked manual entry. Runs on every screen change + visibility change.
function syncScanners() {
  if (!scanUi.earn.scanner) return;   // boot hasn't wired the scanners yet
  const active = activeScanKey();
  ['earn', 'redeem'].forEach((key) => {
    const ui = scanUi[key];
    $(ui.scanArea).hidden = ui.manual;
    $(ui.manualArea).hidden = !ui.manual;
    const msgEl = $(ui.cameraMsg);
    msgEl.textContent = ui.cameraMsgText || '';
    msgEl.hidden = !ui.cameraMsgText;
    if (active === key && !ui.manual && !document.hidden) {
      if (!ui.scanner.isRunning()) {
        $(ui.frame).classList.remove('is-hit');
        $(ui.status).textContent = ui.defaultStatus;
        $(ui.status).classList.remove('is-error');
      }
      ui.scanner.start();
    } else {
      ui.scanner.stop();
    }
    if (active !== key) hideScanBanner(key);
  });
}

// A decoded QR payload from one of the scan screens.
function onScanPayload(key, raw) {
  const ui = scanUi[key];
  const parsed = parseQrPayload(raw);
  if (!parsed) return flashScanStatus(key, 'Not a WeRewards code');
  // The rotating punch-in code pointed back at the terminal's own camera:
  // harmless, so just say what it is and keep scanning.
  if (parsed.kind === 'punch-url') {
    return flashScanStatus(key, 'That’s the punch-in code: customers scan it with their phones');
  }
  if (parsed.kind !== ui.expect) return showScanBanner(key, parsed.kind);

  // (Sightings during a mid-flight request never reach here — the scanner's
  // handlePayload drops them before its debounce bookkeeping.)

  // Right code for this screen: stop + flash, then feed the exact same submit
  // path the keypad uses so preview/confirm behavior is identical.
  ui.scanner.stop();
  $(ui.frame).classList.add('is-hit');
  if (key === 'earn') {
    $('earn-code-input').value = parsed.code;
    submitEarnCode();
  } else {
    $('redeem-code-input').value = parsed.code;
    submitRedeemCode();
  }
}

// Right QR, wrong screen: pause decoding, tell the vendor where it belongs, and
// offer a one-tap jump to the other tab.
function showScanBanner(key, kind) {
  const ui = scanUi[key];
  ui.scanner.setPaused(true);
  $(ui.bannerText).textContent = kind === 'redeem'
    ? 'That’s a redemption code, use the Redeem screen'
    : kind === 'punch'
      ? 'That’s a punch-card reward, use the Redeem screen'
      : 'That’s a customer earn code, use the Award screen';
  $(ui.bannerGo).textContent = kind === 'redeem' || kind === 'punch' ? 'Open Redeem' : 'Open Award';
  $(ui.banner).hidden = false;
  clearTimeout(ui.bannerTimer);
  ui.bannerTimer = setTimeout(() => hideScanBanner(key), SCAN_BANNER_MS);
}

function hideScanBanner(key) {
  const ui = scanUi[key];
  clearTimeout(ui.bannerTimer);
  ui.bannerTimer = null;
  $(ui.banner).hidden = true;
  ui.scanner?.setPaused(false);   // resume decoding
}

// Transient "that QR isn't ours" note under the viewfinder; scanning continues.
// Repeat sightings of the same payload are already throttled by the scanner's
// debounce, so this doesn't flicker while a foreign QR sits in view.
function flashScanStatus(key, msg) {
  const ui = scanUi[key];
  const el = $(ui.status);
  el.textContent = msg;
  el.classList.add('is-error');
  clearTimeout(ui.statusTimer);
  ui.statusTimer = setTimeout(() => {
    el.textContent = ui.defaultStatus;
    el.classList.remove('is-error');
  }, 2500);
}

// Toggle a scan screen between camera and keypad. The choice sticks for the
// session; "Scan QR code instead" doubles as the retry after a camera error.
function setManualMode(key, manual) {
  const ui = scanUi[key];
  ui.manual = manual;
  if (!manual) ui.cameraMsgText = null;   // retrying clears the stale error note
  hideScanBanner(key);
  syncScanners();
}

// getUserMedia failed (denied / missing / in use / insecure): reveal the keypad
// on BOTH scan screens — it's one physical camera — with a note saying why.
function onCameraFail(msg) {
  scanUi.earn.manual = true;
  scanUi.redeem.manual = true;
  scanUi.earn.cameraMsgText = msg;
  scanUi.redeem.cameraMsgText = msg;
  syncScanners();
}

/* ---------- AWARD flow: scan → name + balance + $ keypad ---------- */

function enterScan() {
  currentEarnCode = null;
  currentMultiplier = 1;
  show('screen-scan');
  const input = $('earn-code-input');
  input.value = '';
  // Don't auto-focus: on a tablet that pops the native keyboard, and entry now
  // goes through the on-screen digit pad. Tapping the field still works.
}

async function submitEarnCode() {
  if (busy) return;
  const code = normalizeEarn($('earn-code-input').value);
  if (code.length !== 6) {
    return flood('error', 'ENTER 6 DIGITS', 'The customer’s code is 6 numbers.', enterScan);
  }
  busy = true;
  try {
    const res = await authFetch('/api/vendor/scan', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) return flood('error', 'CODE EXPIRED', data.message || 'Ask the customer to refresh their code.', enterScan);
    currentEarnCode = code;
    currentMultiplier = data.multiplier ?? 1;
    $('customer-name').textContent = data.name;
    $('customer-balance').textContent = data.balance;
    $('customer-tier').textContent = `${currentMultiplier}x`;
    $('customer-tier').classList.toggle('is-boosted', currentMultiplier > 1);
    padValue = '';
    renderQuickAwards();
    setupExactEntry();
    renderPad();
    show('screen-pad');
  } catch {
    flood('error', 'NO CONNECTION', 'Check the internet and try again.', enterScan);
  } finally {
    busy = false;
  }
}

function onAmountKey(e) {
  const k = e.target.dataset?.k;
  if (!k) return;
  if (k === 'back') padValue = padValue.slice(0, -1);
  else if (k === '.') { if (!padValue.includes('.')) padValue = (padValue || '0') + '.'; }
  else {
    const next = padValue + k;
    const [, dec] = next.split('.');
    // $200 hard per-award ceiling — matches MAX_AWARD_DOLLARS in src/routes/vendor.js.
    if ((dec?.length ?? 0) <= 2 && Number(next) <= 200) padValue = next;
  }
  renderPad();
}

function renderPad() {
  const amt = Number(padValue || 0);
  const base = Math.floor(amt * config.pointsPerDollar);
  $('pad-amount').textContent = amt.toFixed(2);
  $('pad-points').textContent = Math.floor(base * currentMultiplier); // match server flooring
  $('pad-mult').hidden = currentMultiplier <= 1;
  $('pad-mult').textContent = currentMultiplier > 1 ? `(${base} × ${currentMultiplier}x member)` : '';
  $('pad-award').disabled = amt <= 0;
}

// Fixed dollar amount for a quick-award button. Tolerates a legacy {min,max}
// range row (pre-migration-012) by falling back to its midpoint.
function tierAmount(t) {
  if (t?.amount != null) return Number(t.amount);
  if (t?.min != null && t?.max != null) return (Number(t.min) + Number(t.max)) / 2;
  return NaN;
}

// A dollar amount rendered without trailing ".00" but with cents when needed.
const fmtAmount = (n) => (n % 1 ? n.toFixed(2) : String(n));

/** Render the vendor's tap-to-award quick buttons above the keypad. */
function renderQuickAwards() {
  const wrap = $('quick-awards');
  const tiers = Array.isArray(config.tiers) ? config.tiers : [];
  wrap.innerHTML = '';
  const usable = tiers.filter((t) => tierAmount(t) > 0);
  wrap.hidden = usable.length === 0;
  usable.forEach((t) => {
    const amt = tierAmount(t);
    const pts = Math.floor(Math.floor(amt * config.pointsPerDollar) * currentMultiplier); // match server flooring
    const b = document.createElement('button');
    b.className = 'quick-award';
    b.dataset.amt = amt;
    b.innerHTML =
      `<span class="qa-label">${escapeHtml(t.label)}</span>` +
      `<span class="qa-amt">$${fmtAmount(amt)}</span>` +
      `<span class="qa-pts">+${pts} pts</span>`;
    wrap.appendChild(b);
  });
}

// Show/hide the exact-amount keypad per the vendor's setting. If there are no
// quick buttons, the keypad is always shown so awarding is still possible.
function setupExactEntry() {
  const hasQuick = !$('quick-awards').hidden;
  const exactOn = config.allowExactEntry !== false || !hasQuick;
  $('exact-entry').hidden = !exactOn;
  $('pad-award').hidden = !exactOn;
}

function onQuickAward(e) {
  const btn = e.target.closest('.quick-award');
  if (!btn) return;
  awardAmount(Number(btn.dataset.amt));
}

/** Award `dollarAmount` to the scanned customer (used by both the keypad and the
 *  quick-award buttons). The server computes points from its own ratio + tier. */
async function awardAmount(dollarAmount) {
  if (busy || !currentEarnCode) return;
  const amt = Number(dollarAmount);
  if (!(amt > 0)) return;
  busy = true;

  // Reuse the same idempotency token only for a PROMPT retry of the identical
  // award (same customer + amount) after a network failure — so the server can
  // dedupe a hidden success. Outside that short window, or for any other award,
  // start fresh so a genuine repeat purchase is never silently deduped.
  const key = `${currentEarnCode}:${amt}`;
  const now = Date.now();
  if (!pendingAward || pendingAward.key !== key || now - pendingAward.at > 120_000) {
    pendingAward = { key, token: crypto.randomUUID(), at: now };
  }
  const requestId = pendingAward.token;

  try {
    const res = await authFetch('/api/vendor/award', {
      method: 'POST',
      body: JSON.stringify({ code: currentEarnCode, exactAmount: amt, requestId }),
    });
    // Got a definitive response — this attempt is resolved, so don't reuse the
    // token (only an unanswered network failure warrants a retry).
    pendingAward = null;
    const data = await res.json();
    if (!res.ok) {
      return flood('error', 'DIDN\u2019T GO THROUGH', data.message, enterScan);
    }
    const detail = data.bonusPoints > 0
      ? `${data.customerName} · ${data.basePoints} base + ${data.bonusPoints} tier bonus (${data.multiplier}x) · new balance ${data.newBalance}`
      : `${data.customerName} · new balance ${data.newBalance}`;
    flood('success', `+${data.awarded} PTS`, detail, () => {
      refreshLastActivity();
      enterScan();
    });
  } catch {
    // Network failure: the server MAY have processed it. Keep pendingAward and
    // refresh its window so a prompt re-tap of the same award reuses the token
    // and the server dedupes it.
    if (pendingAward && pendingAward.key === key) pendingAward.at = Date.now();
    flood('error', 'NO CONNECTION', 'Check the internet and try again.', enterScan);
  } finally {
    busy = false;
  }
}

/* ---------- REDEEM flow: enter 4-digit code → confirm → deduct ---------- */

function renderPinDots() {
  [...$('pin-dots').children].forEach((dot, i) => dot.classList.toggle('filled', i < pinValue.length));
}

async function onPinKey(e) {
  const k = e.target.dataset?.k;
  if (!k) return;
  if (k === 'cancel') return switchMode('award');
  if (k === 'back') pinValue = pinValue.slice(0, -1);
  else if (pinValue.length < 4) pinValue += k;
  renderPinDots();

  if (pinValue.length === 4) {
    const res = await authFetch('/api/vendor/verify-pin', {
      method: 'POST',
      body: JSON.stringify({ pin: pinValue }),
    });
    const data = await res.json().catch(() => ({}));
    pinValue = '';
    renderPinDots();
    if (res.ok) {
      pinUnlocked = true;       // stays unlocked until the page is refreshed
      pinToken = data.token ?? null; // server session token for gated requests
      if (pinAction) {
        // Deferred action (e.g. undo from a scan screen): the detour never
        // changed `mode`, so land back on that mode's screen first — otherwise
        // the action's result flood would close over a stranded, empty PIN pad.
        const fn = pinAction;
        pinAction = null;
        if (mode === 'award') enterScan();
        else enterModeScreen(mode);
        fn();
      } else {
        enterModeScreen(pinTarget);
      }
    } else {
      // Show the lockout message when the vendor is temporarily locked out
      // (too many wrong PINs), otherwise the plain "incorrect PIN" hint.
      $('pin-error').textContent = data.error === 'PIN_LOCKED'
        ? (data.message || 'Too many incorrect PINs. Wait a few minutes and try again.')
        : 'Incorrect PIN, try again.';
      $('pin-error').hidden = false;
    }
  }
}

function enterRedeemScan() {
  pendingRedeemCode = null;
  pendingRedeemKind = 'reward';
  show('screen-redeem-scan');
  const input = $('redeem-code-input');
  input.value = '';
  // Don't auto-focus: on a tablet that pops the native keyboard, and entry now
  // goes through the on-screen digit pad. Tapping the field still works.
}

/** 4-digit code entered → preview (nothing deducted yet) → "is this the user?" */
async function submitRedeemCode() {
  if (busy) return;
  const code = normalizeRedeem($('redeem-code-input').value);
  if (code.length !== 4) {
    return flood('error', 'ENTER 4 DIGITS', 'The redemption code is 4 numbers.', enterRedeemScan);
  }
  busy = true;
  try {
    const res = await authFetch('/api/vendor/redeem-preview', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (handlePinRequired(res, data)) return;
    if (!res.ok) {
      return flood('error', 'CAN\u2019T REDEEM', data.message || 'Code expired or already used.', enterRedeemScan);
    }
    // One code table since migration-029: the row itself says which currency it
    // spends, so there is no try-one-then-the-other dance any more.
    showRedeemConfirm(code, data);
  } catch {
    flood('error', 'NO CONNECTION', 'Check the internet and try again.', enterRedeemScan);
  } finally {
    busy = false;
  }
}

// One confirm screen, two currencies. A punch redemption hides the points chip
// (nothing is deducted) and names the FORFEIT: redeeming zeroes the counter
// whatever the reward costs, so staff see it before they commit.
function showRedeemConfirm(code, data) {
  pendingRedeemCode = code;
  pendingRedeemKind = data.paidWith === 'visits' ? 'punch' : 'reward';
  $('redeem-name').textContent = data.name;
  $('redeem-item').textContent = data.rewardTitle;
  $('redeem-confirm').disabled = false;

  const chip = document.querySelector('#screen-redeem-confirm .balance-chip');
  if (pendingRedeemKind === 'punch') {
    chip.hidden = true;
    $('redeem-emoji').textContent = '\u{1F39F}\u{FE0F}';
    const need = data.visitsCharged ?? 0;
    const have = data.visitsBalance ?? 0;
    $('redeem-cost').textContent = have > need
      ? `${need} visits needed · uses all ${have} visits`
      : `${need} visits will be used`;
    $('redeem-confirm').textContent = 'Confirm and use visits';
    show('screen-redeem-confirm');
    return;
  }

  $('redeem-balance').textContent = data.balance;
  chip.hidden = false;
  $('redeem-emoji').textContent = data.emoji || '🎁';
  $('redeem-item').textContent = data.rewardTitle;
  $('redeem-cost').textContent = `${data.cost} pts will be deducted`;
  $('redeem-confirm').textContent = 'Confirm and deduct points';
  $('redeem-confirm').disabled = false;
  show('screen-redeem-confirm');
}

/* showPunchRedeemConfirm and submitPunchRedeemCode are gone: migration-029
   folded punch codes into redeem_codes, so /redeem-preview resolves every code
   and reports its currency. There is no second endpoint left to fall back to. */

async function confirmRedeem() {
  if (busy || !pendingRedeemCode) return;
  const isPunch = pendingRedeemKind === 'punch';
  busy = true;
  $('redeem-confirm').disabled = true;
  try {
    const res = await authFetch('/api/vendor/redeem', {
      method: 'POST',
      body: JSON.stringify({ code: pendingRedeemCode }),
    });
    const data = await res.json();
    if (handlePinRequired(res, data)) return;
    if (!res.ok) {
      return flood('error', 'CAN\u2019T REDEEM', data.message || 'Code expired or already used.', enterRedeemScan);
    }
    // Both branches refresh last-activity now. The old punch path deliberately
    // did NOT, which is exactly why punch redemptions had no Undo. migration-029
    // makes them reversible (reverse_transaction adds the forfeited punches
    // back), so the affordance has to appear for them too.
    const sub = isPunch
      ? `Visits used · ${data.visitsLeft ?? 0} left`
      : `Points deducted · balance now ${data.newBalance}`;
    flood('success', `GIVE: ${data.rewardTitle}`, sub, () => {
      refreshLastActivity();
      enterRedeemScan();
    }, 3500);
  } catch {
    flood('error', 'NO CONNECTION', 'Check the internet and try again.', enterRedeemScan);
  } finally {
    busy = false;
    pendingRedeemCode = null;
    pendingRedeemKind = 'reward';
  }
}

/* ---------- PUNCH (rotating punch-in code) ----------
   The PUNCH tab shows a QR of a server-signed URL that changes every 30
   seconds (see src/lib/punch.js). Students scan it with the app's scanner or a
   plain phone camera — the URL deep-links into the student app, which claims
   the punch. The terminal only ever DISPLAYS codes here; nothing on this
   screen mutates anything, which is why the tab sits outside the PIN gate. */

/** Paint `payload` as a crisp QR (Byte mode — it's a URL, so the alphanumeric
 *  alphabet doesn't cover it). Same integer-pixel discipline as the student
 *  app's drawQr: whole device pixels per module, hard-coded dark-on-white. */
function drawPunchQr(canvas, payload, targetCss) {
  const qr = qrcode(0, 'M');           // 0 = smallest version that fits
  qr.addData(payload);                 // default Byte mode handles URLs
  qr.make();

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

let punchLoopTimer = null;   // 250ms tick: countdown bar + refresh-on-expiry
let punchExpiresAt = 0;      // when the displayed code's 30s slot ends (ms epoch)
let punchWindowMs = 30_000;
let punchFetching = false;
let punchHasQr = false;      // something is drawn (Reconnecting… vs Can't load)

function enterPunch() {
  show('screen-punch');      // show() runs syncPunch()
}

// Show/hide the PUNCH tab per the vendor's setting, and never leave the mode
// pointing at a tab that just disappeared.
function syncPunchTab() {
  const on = Boolean(config?.punchEnabled);
  $('tab-punch').hidden = !on;
  if (!on && mode === 'punch') proceedSwitchMode('award');
}

// The rotating code refreshes only while its screen is actually visible —
// called from show() and the visibilitychange handler, like syncScanners().
function syncPunch() {
  const visible = !$('screen-punch').hidden && !document.hidden && Boolean(config?.punchEnabled);
  if (visible) startPunchLoop();
  else stopPunchLoop();
}

function startPunchLoop() {
  if (punchLoopTimer) return;
  punchExpiresAt = 0;                       // force an immediate fetch
  punchLoopTimer = setInterval(punchTick, 250);
  punchTick();
}

function stopPunchLoop() {
  clearInterval(punchLoopTimer);
  punchLoopTimer = null;
}

function punchTick() {
  const left = punchExpiresAt - Date.now();
  if (left <= 0) { fetchPunchToken(); return; }
  const frac = Math.max(0, Math.min(1, left / punchWindowMs));
  $('punch-timer-fill').style.width = `${frac * 100}%`;
}

async function fetchPunchToken() {
  if (punchFetching) return;
  punchFetching = true;
  try {
    const res = await authFetch('/api/vendor/punch-token');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Turned off (this terminal's Settings, another terminal, or the
      // operator) since the tab was opened: put the tab away and move on.
      if (data.error === 'PUNCH_DISABLED' && config) {
        config.punchEnabled = false;
        stopPunchLoop();
        // Leave kiosk mode first: the stage is about to be hidden, and on
        // platforms with the real Fullscreen API a hidden fullscreen element
        // leaves the terminal showing a blank top layer that looks dead.
        if (document.body.classList.contains('punch-fs')) exitPunchFullscreen();
        syncPunchTab();
        return;
      }
      throw new Error('punch token fetch failed');
    }
    drawPunchQr($('punch-qr'), data.url, punchQrSize());
    punchHasQr = true;
    $('punch-qr-cover').hidden = true;
    punchWindowMs = (data.windowSeconds ?? 30) * 1000;
    punchExpiresAt = Date.now() + Math.max(1, data.expiresIn ?? 30) * 1000;
    // No vendor-level card since migration-029: punches are a currency, and
    // each reward carries its own punch price on the ITEMS tab.
    $('punch-reward-line').textContent = 'Customers scan this once a night to collect a visit';
  } catch {
    // The shown code is stale (or absent): cover it so nobody scans a dead
    // code, and retry shortly. Recovers by itself when the connection does.
    $('punch-qr-cover').hidden = false;
    $('punch-qr-cover-text').textContent = punchHasQr
      ? 'Reconnecting…'
      : 'Can’t load the code. Check the connection.';
    $('punch-timer-fill').style.width = '0%';
    punchExpiresAt = Date.now() + 2000;
  } finally {
    punchFetching = false;
  }
}

// How big to draw the QR: as much of the screen as fits after the copy above
// and below it, bounded so tablets don't balloon and phones stay scannable.
//
// Measure the height-CONSTRAINED box, never .punch-stage in normal layout —
// the stage is content-sized, and the canvas is part of that content, so
// measuring it would feed each size into the next and the QR would creep
// bigger every 30 seconds (and stay fullscreen-sized after exiting kiosk).
function punchQrSize() {
  const box = document.body.classList.contains('punch-fs')
    ? $('punch-stage')     // kiosk: fixed inset:0, so it IS the viewport
    : $('screen-punch');   // normal: flex:1 of #main, independent of the canvas
  const w = box.clientWidth || window.innerWidth;
  const h = box.clientHeight || window.innerHeight;
  return Math.max(200, Math.min(560, Math.min(w - 64, h - 300)));
}

/* Fullscreen: CSS kiosk mode (fixed, fills the viewport) plus the real
   Fullscreen API where the platform has it (iPhone Safari doesn't, for
   non-video elements — the CSS layer is the one that always works). */
function enterPunchFullscreen() {
  document.body.classList.add('punch-fs');
  $('punch-exit-fs').hidden = false;
  const stage = $('punch-stage');
  try { stage.requestFullscreen?.()?.catch?.(() => {}); } catch { /* unsupported */ }
  punchExpiresAt = 0;   // redraw at the new size on the next tick
}

function exitPunchFullscreen() {
  document.body.classList.remove('punch-fs');
  $('punch-exit-fs').hidden = true;
  if (document.fullscreenElement) {
    try { document.exitFullscreen?.()?.catch?.(() => {}); } catch { /* already out */ }
  }
  punchExpiresAt = 0;   // redraw at the normal size
}

/* ---------- ITEMS (manage rewards) ---------- */

async function refreshRewards() {
  try {
    const res = await authFetch('/api/vendor/rewards');
    if (res.ok) rewards = await res.json();
  } catch { /* keep previous list */ }
}

function enterManage() {
  show('screen-manage');
  renderRewardList();
}

function renderRewardList() {
  const list = $('reward-list');
  list.innerHTML = '';
  if (!rewards.length) {
    list.innerHTML = `<p class="reward-list-empty">No items yet, add your first one.</p>`;
    return;
  }
  rewards.forEach((r) => {
    const row = document.createElement('div');
    row.className = `reward-row${r.active ? '' : ' is-off'}`;

    const info = document.createElement('button');
    info.className = 'reward-info';
    // Either price may be absent, so build the line from what exists rather
    // than interpolating a null into "null pts · about $NaN of purchases".
    const bits = [];
    if (r.cost_in_points != null) {
      bits.push(`${r.cost_in_points} pts · about $${(r.cost_in_points / config.pointsPerDollar).toFixed(2)} of purchases`);
    }
    if (r.cost_in_visits != null) bits.push(`${r.cost_in_visits} visits`);
    info.innerHTML = `
      <span class="reward-emoji">${escapeHtml(r.emoji || '🎁')}</span><span class="redeem-title">${escapeHtml(r.title)}</span>
      <span class="redeem-cost">${escapeHtml(bits.join(' · '))}</span>`;
    info.addEventListener('click', () => openRewardForm(r));

    const toggle = document.createElement('button');
    toggle.className = `reward-toggle${r.active ? ' is-on' : ''}`;
    toggle.textContent = r.active ? 'ON' : 'OFF';
    toggle.addEventListener('click', () => toggleReward(r));

    row.append(info, toggle);
    list.appendChild(row);
  });
}

async function toggleReward(reward) {
  const res = await authFetch(`/api/vendor/rewards/${reward.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ active: !reward.active }),
  });
  if (res.ok) {
    await refreshRewards();
    renderRewardList();
    return;
  }
  const data = await res.json().catch(() => ({}));
  handlePinRequired(res, data); // expired PIN session → back to the PIN screen
}

function openRewardForm(reward) {
  editingRewardId = reward?.id ?? null;
  // Remembered so saveReward can tell a RAISE from a cut and warn accordingly.
  editingVisitsWas = reward?.cost_in_visits ?? null;
  $('reward-form-title').textContent = reward ? 'Edit item' : 'Add item';
  $('reward-title').value = reward?.title ?? '';
  $('reward-cost').value = reward?.cost_in_points ?? '';
  $('reward-visits').value = reward?.cost_in_visits ?? '';
  // A punch price is meaningless while punches are switched off for this spot.
  $('reward-visits-label').hidden = !config.punchEnabled;
  setSelectedEmoji(reward?.emoji || '🎁');
  $('reward-form-error').hidden = true;
  updateRewardHint();
  $('reward-cost').oninput = updateRewardHint;
  $('reward-form').hidden = false;
  $('reward-title').focus();
}

function onEmojiPick(e) {
  const em = e.target.dataset?.e;
  if (em) setSelectedEmoji(em);
}

function setSelectedEmoji(em) {
  selectedEmoji = em;
  [...$('emoji-grid').children].forEach((b) => b.classList.toggle('selected', b.dataset.e === em));
}

function updateRewardHint() {
  const cost = Number($('reward-cost').value);
  $('reward-form-hint').textContent =
    cost > 0
      ? `At ${config.pointsPerDollar} pts per $1, a customer earns this after about $${(cost / config.pointsPerDollar).toFixed(0)} of purchases.`
      : '';
}

function closeRewardForm() {
  $('reward-form').hidden = true;
  editingRewardId = null;
  editingVisitsWas = null;
  rewardRaiseArmed = false;
}

async function saveReward() {
  const title = $('reward-title').value.trim();
  // Blank means "not sold in this currency" and must reach the server as null,
  // not as Number('') === 0, which would trip the positive-price validator.
  const rawCost = $('reward-cost').value.trim();
  const rawVisits = $('reward-visits').value.trim();
  const cost = rawCost === '' ? null : Number(rawCost);
  const visits = rawVisits === '' ? null : Number(rawVisits);
  $('reward-form-error').hidden = true;

  // Raising a punch price silently pushes the item out of reach for anyone who
  // had just enough. Punches take weeks to collect, so warn once and let them
  // through on a second tap. Lowering, clearing, or setting a first price never
  // prompts, and neither does creating a new item.
  if (editingRewardId && visits != null && editingVisitsWas != null && visits > editingVisitsWas && !rewardRaiseArmed) {
    try {
      const q = `from=${editingVisitsWas}&to=${visits}`;
      const ires = await authFetch(`/api/vendor/visit-impact?${q}`);
      const idata = await ires.json().catch(() => ({}));
      if (ires.ok && (idata.affected ?? 0) > 0) {
        rewardRaiseArmed = true;
        const who = idata.affected === 1 ? '1 customer' : `${idata.affected} customers`;
        $('reward-form-error').textContent =
          `${who} can afford this right now and will lose access. Tap Save again to go ahead.`;
        $('reward-form-error').hidden = false;
        return;
      }
    } catch { /* the warning is advisory - never block a save on it */ }
  }

  const res = await authFetch(
    editingRewardId ? `/api/vendor/rewards/${editingRewardId}` : '/api/vendor/rewards',
    {
      method: editingRewardId ? 'PATCH' : 'POST',
      body: JSON.stringify({ title, costInPoints: cost, costInVisits: visits, emoji: selectedEmoji }),
    }
  );
  const data = await res.json();
  if (handlePinRequired(res, data)) { closeRewardForm(); return; }
  if (!res.ok) {
    $('reward-form-error').textContent = data.message || 'Couldn\u2019t save the item.';
    $('reward-form-error').hidden = false;
    return;
  }
  closeRewardForm();
  await refreshRewards();
  renderRewardList();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ---------- flood + activity strip ---------- */

function flood(kind, big, small, after, ms) {
  const el = $('flood');
  const duration = ms ?? (kind === 'success' ? 2500 : 4000);
  el.className = `flood ${kind}`;
  $('flood-icon').textContent = kind === 'success' ? '\u2713' : '\u2715';
  $('flood-big').textContent = big;
  $('flood-small').textContent = small || '';
  // Announce the result to screen readers (the flood is display:none when hidden,
  // so it can't be the live region itself).
  $('a11y-status').textContent = small ? `${big}. ${small}` : big;

  el.hidden = false;
  void el.offsetWidth;                 // reflow so the fade-in transition runs
  el.classList.add('is-visible');

  // Smoothly deplete the timer bar over the auto-close duration.
  const fill = $('flood-progress-fill');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  void fill.offsetWidth;               // reflow to lock in the 100% start
  fill.style.transition = `width ${duration}ms linear`;
  fill.style.width = '0%';

  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    after?.();                         // update the screen behind the overlay first
    el.classList.remove('is-visible'); // clean fade-out (300ms, see CSS)
    setTimeout(() => {
      el.hidden = true;
      $('flood-close').onclick = null;
      el.onclick = null;
    }, 320);
  };
  const timer = setTimeout(done, duration);
  $('flood-close').onclick = (e) => { e.stopPropagation(); done(); }; // X = close now
  el.onclick = done;                   // tapping the screen also dismisses early
}

async function refreshLastActivity() {
  try {
    const res = await authFetch('/api/vendor/recent');
    if (!res.ok) return;
    const [last] = await res.json();
    lastActivity = null;
    if (!last) {
      $('last-activity').textContent = 'No activity yet today.';
    } else {
      const who = last.profiles?.name ?? 'Customer';
      const isReversal = last.reverses != null;        // this row is itself an undo
      // An inbound community transfer (migration-027) is the STUDENT's move, not
      // this vendor's transaction — undoing it here would evaporate their points
      // (the server refuses too: CANNOT_REVERSE_TRANSFER). Shown, but never undoable.
      const isTransfer = last.type === 'community_transfer';
      const createdAt = new Date(last.created_at).getTime();
      const withinWindow = Date.now() - createdAt < UNDO_WINDOW_MS;
      const undoable = !isReversal && !isTransfer && last.reversed_by == null && withinWindow;
      lastActivity = { id: last.id, type: last.type, undoable, createdAt };
      $('last-activity').textContent = isReversal
        ? `Last: undo · ${who}`
        : isTransfer
          ? `Last: ${who} moved in +${last.points} community pts`
          : last.type === 'earn'
            ? `Last: ${who} +${last.points} pts`
            : `Last: ${who} redeemed ${last.rewards?.title ?? 'a reward'}`;
    }
    undoLastArmed = false;
    scheduleUndoExpiry();
    renderUndoLast();
  } catch { /* non-critical */ }
}

// Auto-hide "Undo last" the instant its 1-minute window runs out, even if the
// cashier leaves the scan screen open and nothing else refreshes.
function scheduleUndoExpiry() {
  clearTimeout(undoExpiryTimer);
  if (!lastActivity?.undoable) return;
  const remaining = lastActivity.createdAt + UNDO_WINDOW_MS - Date.now();
  undoExpiryTimer = setTimeout(() => {
    if (lastActivity) lastActivity.undoable = false;
    undoLastArmed = false;
    renderUndoLast();
  }, Math.max(0, remaining));
}

// Show/hide + label the "Undo last" buttons on both scan screens.
function renderUndoLast() {
  const canUndo = Boolean(lastActivity?.undoable);
  ['undo-last-award', 'undo-last-redeem'].forEach((id) => {
    const btn = $(id);
    if (!btn) return;
    btn.hidden = !canUndo;
    btn.textContent = undoLastArmed ? 'Tap again to undo' : 'Undo last';
    btn.classList.toggle('is-armed', undoLastArmed);
  });
}

// Two-tap confirm, then reverse the most recent transaction.
function onUndoLastTap() {
  if (!lastActivity?.undoable) return;
  if (!undoLastArmed) {
    undoLastArmed = true;
    clearTimeout(undoLastTimer);
    undoLastTimer = setTimeout(() => { undoLastArmed = false; renderUndoLast(); }, 4000);
    renderUndoLast();
    return;
  }
  clearTimeout(undoLastTimer);
  undoLastArmed = false;
  renderUndoLast();
  requestUndoLast();
}

// Reverse is PIN-gated but the award/redeem scan screens are not, so if the PIN
// isn't unlocked yet, detour through the PIN pad and finish the undo after.
function requestUndoLast() {
  const tx = lastActivity;
  if (!tx?.id || !tx.undoable) return;
  const run = () => performReverse(tx.id, null);
  if (config.hasPin && !pinUnlocked) {
    pinAction = run;
    pinValue = '';
    renderPinDots();
    $('pin-error').hidden = true;
    show('screen-pin');
    return;
  }
  run();
}

/* ---------- DEALS (campaigns to this vendor's own customers) ----------
   The vendor writes the words and picks the audience. WeRewards owns WHO is on
   the list (the terminal only ever sees a count, never a student) and WHEN it
   lands. Tapping Send queues; it does not send. That few-minute hold is the
   whole reason a student whose favourite four spots all post a Friday deal gets
   one notification listing four spots rather than four notifications. */

let dealAudience = 'top';
let dealHours = 72;
let dealSendArmed = false;      // two-tap confirm, like Undo last
let dealArmTimer = null;
let dealReachTimer = null;
let dealQuota = null;
// Idempotency, same contract as an award retry: one token per composed message,
// so a Send that fails at the network layer can be repeated without fanning out
// to a hundred students twice.
let dealToken = null;
// The rendered history, kept so the two-tap "Take down" can re-render its own
// armed state without another round trip.
let dealHistory = [];
let dealDownArmed = null;       // campaign id currently armed for take-down
let dealDownTimer = null;

function enterDeals() {
  show('screen-deals');
  disarmDealSend();
  disarmDealDown(true);
  loadCampaigns();
  refreshReach();
}

async function loadCampaigns() {
  try {
    const res = await authFetch('/api/vendor/campaigns');
    const data = await res.json().catch(() => ({}));
    if (handlePinRequired(res, data)) return;
    if (!res.ok) return;
    dealQuota = data.quota;
    renderDealQuota();
    renderDealNote(data.delivery);
    renderDealHistory(data.campaigns || []);
  } catch { /* keep the prior render */ }
}

function renderDealQuota() {
  const q = dealQuota;
  if (!q) return;
  $('deals-quota').textContent = q.left === 1
    ? '1 send left this week'
    : `${q.left} sends left this week`;
  $('deals-quota').classList.toggle('is-spent', q.left === 0);
  $('deal-send').disabled = q.left === 0;
}

function renderDealNote(d) {
  if (!d) return;
  const hour = (h) => {
    const am = h < 12 || h === 24;
    const twelve = h % 12 === 0 ? 12 : h % 12;
    return `${twelve}${am ? 'am' : 'pm'}`;
  };
  // Said plainly, because a vendor who thinks Send is instant will tap it twice.
  $('deal-note').textContent =
    `Goes out within about ${d.holdMinutes} minutes, never between ${hour(d.quietStart)} and ${hour(d.quietEnd)}. `
    + 'If other spots send around the same time, students get one notification listing all of them, so nobody gets buried.';
}

function onDealInput() {
  $('deal-title-count').textContent = `${$('deal-title').value.length}/60`;
  $('deal-body-count').textContent = `${$('deal-body').value.length}/140`;
  // Editing after arming means they changed their mind about the wording.
  disarmDealSend();
  $('deal-error').hidden = true;
  $('deal-success').hidden = true;
}

function onAudiencePick(e) {
  const btn = e.target.closest('.deal-chip');
  if (!btn) return;
  dealAudience = btn.dataset.audience;
  [...$('deal-audience').children].forEach((b) => b.classList.toggle('is-active', b === btn));
  disarmDealSend();
  refreshReach();
}

function onDurationPick(e) {
  const btn = e.target.closest('.deal-chip');
  if (!btn) return;
  dealHours = Number(btn.dataset.hours);
  [...$('deal-duration').children].forEach((b) => b.classList.toggle('is-active', b === btn));
  disarmDealSend();
}

// Debounced: switching audience chips quickly shouldn't fire three counts.
function refreshReach() {
  clearTimeout(dealReachTimer);
  $('deal-reach').textContent = 'Checking…';
  dealReachTimer = setTimeout(async () => {
    try {
      const res = await authFetch(`/api/vendor/campaigns/reach?audience=${dealAudience}`);
      const data = await res.json().catch(() => ({}));
      if (handlePinRequired(res, data)) return;
      if (!res.ok) { $('deal-reach').textContent = ''; return; }
      const n = data.reach ?? 0;
      $('deal-reach').textContent = n === 0
        ? 'Nobody matches this yet. Award some points first.'
        : `Reaches ${n} ${n === 1 ? 'student' : 'students'}`;
    } catch { $('deal-reach').textContent = ''; }
  }, 250);
}

// First tap arms, second sends. It reaches a hundred people and there is no
// recall, so it gets the same guard as Undo last and a punch-price raise.
function onDealSendTap() {
  if (busy) return;
  const title = $('deal-title').value.trim();
  const body = $('deal-body').value.trim();
  if (!title || !body) {
    dealError('Write a headline and a message first.');
    return;
  }
  if (!dealSendArmed) {
    dealSendArmed = true;
    dealToken = dealToken || `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    $('deal-send').textContent = 'Tap again to send';
    $('deal-send').classList.add('is-armed');
    clearTimeout(dealArmTimer);
    dealArmTimer = setTimeout(disarmDealSend, 5000);
    return;
  }
  sendDeal(title, body);
}

function disarmDealSend() {
  dealSendArmed = false;
  clearTimeout(dealArmTimer);
  $('deal-send').textContent = 'Send deal';
  $('deal-send').classList.remove('is-armed');
}

function dealError(msg) {
  $('deal-error').textContent = msg;
  $('deal-error').hidden = false;
  $('deal-success').hidden = true;
  disarmDealSend();
}

async function sendDeal(title, body) {
  busy = true;
  $('deal-send').disabled = true;
  try {
    const res = await authFetch('/api/vendor/campaigns', {
      method: 'POST',
      body: JSON.stringify({
        title, body, kind: 'deal', audience: dealAudience,
        durationHours: dealHours, requestId: dealToken,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (handlePinRequired(res, data)) return;
    if (!res.ok) {
      dealError(data?.message || 'Could not send that. Try again in a moment.');
      return;
    }
    $('deal-title').value = '';
    $('deal-body').value = '';
    onDealInput();                      // resets the counters (and clears both notes)
    $('deal-success').textContent = data.queued === 0
      ? 'Nobody matched that audience, so nothing went out.'
      : `Queued for ${data.queued} ${data.queued === 1 ? 'student' : 'students'}. `
        + `Lands within about ${data.holdMinutes} minutes.`;
    $('deal-success').hidden = false;
    dealToken = null;                   // a fresh message gets a fresh token
    loadCampaigns();
  } catch {
    // Network drop: the send may or may not have landed, so KEEP the token.
    // Re-tapping replays the same idempotency key and the server returns the
    // original campaign instead of blasting the list a second time.
    dealError('No connection. Tap send again when you are back online.');
  } finally {
    busy = false;
    $('deal-send').disabled = dealQuota ? dealQuota.left === 0 : false;
    disarmDealSend();
  }
}

// Entities rather than literal punctuation: this file mixes real unicode with
// \uXXXX escapes and the separator is not worth the ambiguity.
const DOT = ' &middot; ';

function dealRowState(c) {
  if (c.status === 'cancelled') return { live: false, label: `${DOT}taken down` };
  if (new Date(c.expires_at) <= new Date()) return { live: false, label: `${DOT}ended` };
  return { live: true, label: `${DOT}live` };
}

function renderDealHistory(list) {
  dealHistory = list;
  const box = $('deal-history');
  if (!list.length) {
    box.innerHTML = '<p class="manage-note">Nothing sent yet.</p>';
    return;
  }
  box.innerHTML = list.map((c) => {
    const when = new Date(c.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const { live, label } = dealRowState(c);
    const armed = dealDownArmed === c.id;
    return `
      <div class="deal-row${live ? '' : ' is-over'}" data-id="${c.id}">
        <div class="deal-row-top">
          <div class="deal-row-main">
            <p class="deal-row-title">${escapeHtml(c.title)}</p>
            <p class="deal-row-body">${escapeHtml(c.body)}</p>
          </div>
          <div class="deal-row-stats">
            <span class="deal-stat"><b>${c.queued_count}</b> targeted</span>
            <span class="deal-stat"><b>${c.sent_count}</b> notified</span>
            <span class="deal-stat"><b>${c.opened_count}</b> opened</span>
            <span class="deal-when">${when}${label}</span>
          </div>
        </div>
        ${live ? `
        <div class="deal-row-actions">
          <button class="deal-act" type="button" data-act="edit">Edit</button>
          <button class="deal-act deal-act-danger${armed ? ' is-armed' : ''}" type="button" data-act="down">${armed ? 'Tap again to take down' : 'Take down'}</button>
        </div>
        <p class="field-error deal-row-error" hidden></p>
        <div class="deal-edit" hidden>
          <label class="deal-field">
            <span class="deal-label">Headline</span>
            <input class="deal-edit-title" type="text" maxlength="60" value="${escapeHtml(c.title)}" />
          </label>
          <label class="deal-field">
            <span class="deal-label">Message</span>
            <textarea class="deal-edit-body" maxlength="140" rows="3">${escapeHtml(c.body)}</textarea>
          </label>
          <p class="deals-note">Changes show in the app straight away. A notification that already went out keeps the old wording, and editing does not notify anyone again or use a send.</p>
          <p class="field-error deal-edit-error" hidden></p>
          <div class="deal-row-actions">
            <button class="deal-act deal-act-go" type="button" data-act="save">Save</button>
            <button class="deal-act" type="button" data-act="cancel">Cancel</button>
          </div>
        </div>` : ''}
      </div>`;
  }).join('');
}

/* Edit / take down. Delegated from the list container, so a re-render never
   leaves a stale listener behind. */
function onDealHistoryTap(e) {
  const btn = e.target.closest('.deal-act');
  if (!btn) return;
  const row = btn.closest('.deal-row');
  if (!row?.dataset.id) return;
  const id = row.dataset.id;
  switch (btn.dataset.act) {
    case 'edit':   openDealEdit(row); break;
    case 'cancel': closeDealEdit(row); break;
    case 'save':   void saveDealEdit(row, id); break;
    case 'down':   void onTakeDownTap(row, id); break;
    default:       break;
  }
}

function openDealEdit(row) {
  disarmDealDown(true);
  row.querySelector('.deal-edit').hidden = false;
  row.querySelector('.deal-row-actions').hidden = true;
  row.querySelector('.deal-edit-title').focus();
}

function closeDealEdit(row) {
  const editor = row.querySelector('.deal-edit');
  if (!editor) return;
  editor.hidden = true;
  row.querySelector('.deal-row-actions').hidden = false;
  const err = row.querySelector('.deal-edit-error');
  if (err) err.hidden = true;
}

async function saveDealEdit(row, id) {
  const title = row.querySelector('.deal-edit-title').value.trim();
  const body = row.querySelector('.deal-edit-body').value.trim();
  const err = row.querySelector('.deal-edit-error');
  const showErr = (msg) => { err.textContent = msg; err.hidden = false; };
  if (!title || !body) {
    showErr('Write a headline and a message.');
    return;
  }
  const buttons = [...row.querySelectorAll('.deal-act')];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const res = await authFetch(`/api/vendor/campaigns/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, body }),
    });
    const data = await res.json().catch(() => ({}));
    if (handlePinRequired(res, data)) return;
    if (!res.ok) {
      showErr(data?.message || 'Could not save that. Try again in a moment.');
      return;
    }
    await loadCampaigns();          // re-renders the row, closing the editor
  } catch {
    showErr('No connection. Try again when you are back online.');
  } finally {
    // The row may already be gone (re-render); guard against the detached node.
    buttons.forEach((b) => { b.disabled = false; });
  }
}

// Two-tap, same as Send: taking a deal down pulls it out of every student's app
// at once, and the students who were already notified cannot be un-notified.
//
// Failures report INTO THE ROW, not through dealError(): #deal-error lives in
// the composer at the top of the screen, a whole card above the history, so a
// vendor who is looking at this row would never see it.
async function onTakeDownTap(row, id) {
  const err = row.querySelector('.deal-row-error');
  const showErr = (msg) => { if (err) { err.textContent = msg; err.hidden = false; } };
  if (err) err.hidden = true;

  if (dealDownArmed !== id) {
    dealDownArmed = id;
    clearTimeout(dealDownTimer);
    dealDownTimer = setTimeout(() => disarmDealDown(), 5000);
    renderDealHistory(dealHistory);
    return;
  }
  disarmDealDown(true);
  // The row is only re-rendered on success, so put the label back by hand —
  // otherwise a failed take-down leaves a button still reading "Tap again".
  const btn = row.querySelector('.deal-act-danger');
  if (btn) { btn.classList.remove('is-armed'); btn.textContent = 'Take down'; }

  try {
    const res = await authFetch(`/api/vendor/campaigns/${id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (handlePinRequired(res, data)) return;
    if (!res.ok) {
      showErr(data?.message || 'Could not take that down. Try again in a moment.');
      return;
    }
    await loadCampaigns();
  } catch {
    showErr('No connection. Try again when you are back online.');
  }
}

function disarmDealDown(silent) {
  const was = dealDownArmed;
  dealDownArmed = null;
  clearTimeout(dealDownTimer);
  if (was && !silent) renderDealHistory(dealHistory);
}

/* ---------- STATS (analytics) ---------- */

function enterStats() {
  show('screen-stats');
  loadAnalytics();
}

async function loadAnalytics() {
  try {
    const res = await authFetch('/api/vendor/analytics');
    const data = await res.json().catch(() => ({}));
    if (handlePinRequired(res, data)) return;
    if (res.ok) renderAnalytics(data);   // keep the prior render on a transient failure
  } catch { /* keep the prior render */ }
}

const money = (n) => '$' + (Number(n) || 0).toFixed(2);
const num = (n) => (Number(n) || 0).toLocaleString();

function renderAnalytics(d) {
  $('st-revenue').textContent = money(d.today?.revenue);
  $('st-awarded').textContent = num(d.today?.earnPoints);
  $('st-redemptions').textContent = num(d.today?.redemptions);
  $('st-customers').textContent = num(d.today?.customers);

  buildChart(d.daily ?? []);
  fillSummary('stats-7', d.last7 ?? {});
  fillSummary('stats-30', d.last30 ?? {});
  renderTopRewards(d.topRewards ?? []);
  loadRecent();
}

/* ---------- STATS: recent activity + undo (reverse a transaction) ---------- */

let recentItems = [];
let undoArmedId = null;      // txn id whose Undo button is armed for a confirming 2nd tap
let undoArmTimer = null;

async function loadRecent() {
  try {
    const res = await authFetch('/api/vendor/recent');
    const data = await res.json().catch(() => ({}));
    if (handlePinRequired(res, data)) return;
    if (res.ok) { recentItems = Array.isArray(data) ? data : []; renderRecent(); }
  } catch { /* keep the prior render */ }
}

function renderRecent() {
  const wrap = $('recent-list');
  if (!recentItems.length) {
    wrap.innerHTML = `<p class="stats-empty">No activity yet.</p>`;
    return;
  }
  wrap.innerHTML = '';
  recentItems.forEach((tx) => {
    const earn = tx.type === 'earn';
    // Inbound community transfer (migration-027): the student moved their own
    // cross-vendor points into this shop. The vendor should SEE it — it explains
    // a balance they didn't award — but labeled honestly, and never undoable
    // (that would evaporate the student's points; the server refuses too).
    const transfer = tx.type === 'community_transfer';
    const who = tx.profiles?.name ?? 'Customer';
    const isReversal = tx.reverses != null;         // this row is itself an undo
    const alreadyVoided = tx.reversed_by != null;   // this row was already undone
    const time = new Date(tx.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    // Signed points: earns are +, redeems and corrections carry their own sign.
    // A punch redemption moves 0 points, so it reports what it actually spent.
    const paidVisits = tx.paid_with === 'visits';
    const spent = Math.abs(tx.visits_spent ?? 0);
    const amount = paidVisits
      ? `${tx.visits_spent < 0 ? '+' : '-'}${spent} ${spent === 1 ? 'visit' : 'visits'}`
      : `${tx.points > 0 ? `+${tx.points}` : `${tx.points}`} pts`;
    const what = transfer
      ? `Community points in · ${who}`
      : earn
        ? (isReversal ? `Correction · ${who}` : `Award · ${who}`)
        : (isReversal ? `Refund · ${who}` : `Redeem · ${who}${tx.rewards?.title ? ` · ${tx.rewards.title}` : ''}`);

    const row = document.createElement('div');
    row.className = `recent-row${alreadyVoided ? ' is-voided' : ''}`;

    const info = document.createElement('div');
    info.className = 'recent-info';
    info.innerHTML = `<span class="recent-what">${escapeHtml(what)}</span><span class="recent-meta">${escapeHtml(amount)} · ${escapeHtml(time)}</span>`;
    row.appendChild(info);

    // Undoable = a real award/redeem, not voided, not itself a correction, not
    // an inbound transfer, and still inside the 1-minute window (the server
    // enforces the window — and the transfer rule — too).
    const inWindow = Date.now() - new Date(tx.created_at).getTime() < UNDO_WINDOW_MS;
    if (!isReversal && !alreadyVoided && !transfer && inWindow) {
      const btn = document.createElement('button');
      btn.className = 'recent-undo';
      btn.textContent = undoArmedId === tx.id ? 'Tap again to undo' : 'Undo';
      if (undoArmedId === tx.id) btn.classList.add('is-armed');
      btn.addEventListener('click', () => onUndoTap(tx.id));
      row.appendChild(btn);
    } else if (isReversal || alreadyVoided || transfer) {
      const tag = document.createElement('span');
      tag.className = 'recent-tag';
      tag.textContent = alreadyVoided ? 'Undone' : transfer ? 'Moved in' : (earn ? 'Correction' : 'Refund');
      row.appendChild(tag);
    }
    // else: a real award/redeem past the 1-minute window — just history, no undo.
    wrap.appendChild(row);
  });
}

// Two-tap confirm: first tap arms the button, a second tap within 4s commits.
function onUndoTap(txId) {
  if (undoArmedId !== txId) {
    undoArmedId = txId;
    clearTimeout(undoArmTimer);
    undoArmTimer = setTimeout(() => { undoArmedId = null; renderRecent(); }, 4000);
    renderRecent();
    return;
  }
  clearTimeout(undoArmTimer);
  undoArmedId = null;
  performReverse(txId, () => loadAnalytics());   // re-renders stats + recent list
}

/** Reverse a transaction. `after` runs (alongside a scan-strip refresh) once the
 *  result flood closes — the STATS list passes loadAnalytics; "Undo last" passes
 *  nothing (it just refreshes the scan strip). */
async function performReverse(txId, after) {
  if (busy) return;
  busy = true;
  const refresh = () => { refreshLastActivity(); after?.(); };
  try {
    const res = await authFetch('/api/vendor/reverse', {
      method: 'POST',
      body: JSON.stringify({ transactionId: txId }),
    });
    const data = await res.json().catch(() => ({}));
    if (handlePinRequired(res, data)) return;
    if (!res.ok) {
      return flood('error', 'COULDN’T UNDO', data.message || 'That entry can’t be undone.', refresh);
    }
    // A punch redemption moves no points at all, so "points refunded" would be
    // a lie and "Balance now N" would name a number that never changed.
    if (data.paidWith === 'visits') {
      const n = data.restoredVisits ?? 0;
      flood('success', 'UNDONE', `${n} ${n === 1 ? 'visit' : 'visits'} put back`, refresh);
    } else {
      const back = data.type === 'redeem' ? 'points refunded' : 'points removed';
      flood('success', 'UNDONE', `Balance now ${data.newBalance} · ${back}`, refresh);
    }
  } catch {
    flood('error', 'NO CONNECTION', 'Check the internet and try again.', refresh);
  } finally {
    busy = false;
  }
}

// Single-series bar chart: revenue per day, baseline-anchored, thin marks with
// rounded tops, 2px gaps. No per-bar labels (a couple of date ticks instead).
function buildChart(daily) {
  const wrap = $('stats-chart');
  wrap.innerHTML = '';
  const max = Math.max(1, ...daily.map((x) => Number(x.revenue) || 0));
  $('chart-max').textContent = daily.length ? `peak ${money(max)}` : '';

  const mid = Math.floor((daily.length - 1) / 2);
  daily.forEach((x, i) => {
    const rev = Number(x.revenue) || 0;
    const h = Math.round((rev / max) * 100);
    const showTick = i === 0 || i === daily.length - 1 || i === mid;
    const col = document.createElement('div');
    col.className = 'chart-col';
    col.innerHTML = `
      <span class="chart-bar-wrap"><span class="chart-bar${rev > 0 ? '' : ' zero'}" style="height:${h}%"></span></span>
      <span class="chart-tick">${showTick ? tickLabel(x.date) : ''}</span>`;
    col.querySelector('.chart-bar').title = `${x.date}: ${money(rev)} · ${num(x.awards)} awards`;
    wrap.appendChild(col);
  });
}

function fillSummary(id, b) {
  const rows = [
    ['Revenue', money(b.revenue)],
    ['Points awarded', num(b.earnPoints)],
    ['Redemptions', num(b.redemptions)],
    ['Customers', num(b.customers)],
  ];
  // Only when it's happened — most vendors never see a transfer, and a
  // permanent 0 row would just beg the question the onboarding already answers.
  if (b.movedInPoints > 0) rows.push(['Community pts in', num(b.movedInPoints)]);
  if (b.returningCustomers != null) rows.push(['Returning', num(b.returningCustomers)]);
  $(id).innerHTML = rows
    .map(([k, v]) => `<li><span>${k}</span><strong>${v}</strong></li>`)
    .join('');
}

function renderTopRewards(list) {
  const wrap = $('stats-top');
  if (!list.length) {
    wrap.innerHTML = `<p class="stats-empty">No redemptions in the last 30 days.</p>`;
    return;
  }
  const max = Math.max(...list.map((r) => r.count));
  wrap.innerHTML = list
    .map((r) => `
      <div class="top-row">
        <span class="top-title">${escapeHtml(r.title)}</span>
        <span class="top-bar-wrap"><span class="top-bar" style="width:${Math.round((r.count / max) * 100)}%"></span></span>
        <span class="top-count">${num(r.count)}</span>
      </div>`)
    .join('');
}

// 'YYYY-MM-DD' -> 'M/D'
function tickLabel(iso) {
  const [, m, d] = String(iso).split('-');
  return `${Number(m)}/${Number(d)}`;
}

/* ---------- SETTINGS (self-service economics) ---------- */

let loadedSettings = null;   // last-loaded server state, for the Reset button

function enterSettings() {
  show('screen-settings');
  loadSettings();
}

/* ---- unsaved-changes guard ----
   The form is captured field-by-field, keyed to match each card's data-card
   attribute, and compared against a baseline taken whenever the form matches the
   server (load / Reset / Save). Any difference means there are unsaved edits,
   which the leave-guard blocks on; per-key differences highlight each card. */

function settingsSnapshot() {
  return {
    ratio: $('set-ratio').value.trim(),
    exact: switchOn($('set-exact')),
    tiers: collectTiers(),
    address: $('set-address').value.trim(),
    pin: $('set-pin').value.trim(),
    logo: logoValue,
    // Just the switch since migration-029: the card's target and reward are
    // gone, replaced by a per-reward punch price on the ITEMS tab. The key stays
    // `punch` to keep matching data-card="punch" on the settings card.
    punch: { enabled: switchOn($('set-punch')) },
  };
}

// Deep-equal by value for a single card's slice of the snapshot.
const sameField = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function isSettingsDirty() {
  // Baseline is null until Settings has been rendered once — nothing to guard yet.
  return settingsBaseline !== null && !sameField(settingsSnapshot(), settingsBaseline);
}

// Mark the current form state as "saved" (the new baseline) and refresh the cue.
function resetSettingsBaseline() {
  settingsBaseline = settingsSnapshot();
  refreshSettingsDirty();
}

// Show/hide the "Unsaved changes" note, the Save ring, and the SETTINGS tab dot,
// and give an amber border to each specific card that holds an unsaved edit.
function refreshSettingsDirty() {
  const snap = settingsSnapshot();
  const base = settingsBaseline;
  const dirty = base !== null && !sameField(snap, base);
  $('settings-dirty').hidden = !dirty;
  $('settings-save').classList.toggle('is-dirty', dirty);
  $('tab-settings').classList.toggle('is-dirty', dirty);
  document.querySelectorAll('#screen-settings .stats-card[data-card]').forEach((card) => {
    const key = card.dataset.card;
    const edited = base !== null && !sameField(snap[key], base[key]);
    card.classList.toggle('is-edited', edited);
  });
}

function closeSettingsGuard() {
  $('settings-guard').hidden = true;
  pendingMode = null;   // "Keep editing" — cancel the pending tab switch
}

// Discard: revert every field to the last-loaded server state, then leave.
function guardDiscardAndLeave() {
  const target = pendingMode;
  $('settings-guard').hidden = true;
  pendingMode = null;
  renderSettings(loadedSettings);   // reverts fields + re-baselines to clean
  if (target) proceedSwitchMode(target);
}

// Save & leave: persist, then navigate once the save succeeds. A failed save
// keeps the vendor on Settings (with the error shown) rather than losing edits.
async function guardSaveAndLeave() {
  const target = pendingMode;
  $('settings-guard').hidden = true;
  pendingMode = null;
  await saveSettings(target);
}

async function loadSettings() {
  try {
    const res = await authFetch('/api/vendor/settings');
    const data = await res.json().catch(() => ({}));
    if (handlePinRequired(res, data)) return;
    if (res.ok) { loadedSettings = data; renderSettings(data); }
  } catch { /* keep whatever's on screen */ }
}

function renderSettings(s) {
  if (!s) return;
  $('set-ratio').value = s.pointsPerDollar ?? '';
  setSwitch($('set-exact'), s.allowExactEntry !== false);
  setSwitch($('set-punch'), s.punchEnabled === true);
  $('set-address').value = s.address ?? '';
  logoValue = s.logo ?? null;
  logoChanged = false;
  setLogoPreview(logoValue);
  $('set-pin').value = '';
  // The password card is independent of the batched save — clear its fields and
  // any lingering message whenever Settings (re)renders.
  $('set-pw-new').value = '';
  $('set-pw-confirm').value = '';
  $('set-pw-msg').hidden = true;
  $('settings-error').hidden = true;
  renderTierEditor(s.tiers ?? []);
  updateRatioExample();
  resetSettingsBaseline();   // freshly-rendered form matches the server = nothing unsaved
}

/* ---- logo: pick a file, shrink it to a ~128px square data-URL ---- */

const LOGO_MAX_PX = 128;                 // stored icon size
const LOGO_MAX_FILE = 8 * 1024 * 1024;   // reject huge source files up front

function setLogoPreview(dataUrl) {
  const box = $('set-logo-preview');
  box.style.backgroundImage = dataUrl ? `url('${dataUrl}')` : 'none';
  box.classList.toggle('is-empty', !dataUrl);
  $('set-logo-remove').hidden = !dataUrl;
  $('set-logo-error').hidden = true;
  $('set-logo-warn').hidden = true;
}

async function onLogoPick(e) {
  const file = e.target.files?.[0];
  e.target.value = '';                   // let the same file be re-picked later
  if (!file) return;
  if (file.size > LOGO_MAX_FILE) {
    showLogoError('That image is too large. Pick one under 8 MB.');
    return;
  }
  try {
    const { dataUrl, aspect } = await shrinkImage(file, LOGO_MAX_PX);
    logoValue = dataUrl;
    logoChanged = true;
    setLogoPreview(logoValue);
    refreshSettingsDirty();
    // Non-blocking nudge: a clearly non-square image looks small and letterboxed
    // next to the name + points. The logo is still saved as-is.
    if (aspect >= 1.4) {
      $('set-logo-warn').textContent = 'That image isn’t square, so it’ll appear small with empty space on the sides. A square logo looks best.';
      $('set-logo-warn').hidden = false;
    }
  } catch {
    showLogoError('Couldn’t read that image. Try a PNG or JPG, since HEIC and PDF files aren’t supported.');
  }
}

function showLogoError(msg) {
  $('set-logo-error').textContent = msg;
  $('set-logo-error').hidden = false;
}

function removeLogo() {
  logoValue = null;
  logoChanged = true;
  setLogoPreview(null);
  refreshSettingsDirty();
}

// Decode a picked File into something drawable. createImageBitmap is the most
// robust path — it decodes large images and honours EXIF orientation, off the
// main thread — so we try it first and fall back to an <img> where it's missing.
// (Neither can read HEIC or PDF; those surface as a clear error to the vendor.)
async function decodeImage(file) {
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

// Shrink the image to fit maxPx and return a PNG data-URL (keeps transparency)
// plus the source aspect ratio (max/min side) so we can nudge non-square logos.
async function shrinkImage(file, maxPx) {
  const src = await decodeImage(file);
  const aspect = Math.max(src.width, src.height) / Math.min(src.width, src.height);
  const scale = Math.min(1, maxPx / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(src, 0, 0, w, h);
  src.close?.();   // release the ImageBitmap if that's what we got
  return { dataUrl: canvas.toDataURL('image/png'), aspect };
}

function setSwitch(el, on) {
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}
function switchOn(el) {
  return el.getAttribute('aria-checked') === 'true';
}
function toggleSwitch(el) {
  setSwitch(el, !switchOn(el));
}

function updateRatioExample() {
  const r = Number($('set-ratio').value);
  $('set-ratio-eg').textContent = Number.isFinite(r) && r > 0 ? `${Math.floor(10 * r)} pts` : '';
}

/* tier-button editor: a list of {label, min, max} rows */

function renderTierEditor(tiers) {
  const wrap = $('tier-editor');
  wrap.innerHTML = '';
  (tiers.length ? tiers : [{ label: '', amount: '' }]).forEach((t) => addTierRow(t));
}

function addTierRow(t = { label: '', amount: '' }) {
  const wrap = $('tier-editor');
  const row = document.createElement('div');
  row.className = 'tier-row';
  row.innerHTML = `
    <input class="tier-label" type="text" maxlength="40" placeholder="Label (e.g. Meal)" />
    <span class="tier-money">$</span>
    <input class="tier-amount" type="number" inputmode="decimal" min="0" max="200" step="0.5" placeholder="amount" />
    <button class="tier-remove" type="button" aria-label="Remove button">✕</button>`;
  const amt = tierAmount(t);
  row.querySelector('.tier-label').value = t.label ?? '';
  row.querySelector('.tier-amount').value = Number.isFinite(amt) ? amt : '';
  row.querySelector('.tier-remove').addEventListener('click', () => { row.remove(); refreshSettingsDirty(); });
  wrap.appendChild(row);
}

function collectTiers() {
  return [...$('tier-editor').querySelectorAll('.tier-row')]
    .map((row) => ({
      label: row.querySelector('.tier-label').value.trim(),
      amount: row.querySelector('.tier-amount').value.trim(),
    }))
    .filter((t) => t.label !== '' || t.amount !== '') // drop fully-blank rows
    .map((t) => ({ label: t.label, amount: Number(t.amount) }));
}

// `afterTarget` (set by the leave-guard's "Save & leave") is the tab to open once
// the save succeeds; omitted for a plain Save, which stays on Settings.
async function saveSettings(afterTarget) {
  if (busy) return;
  $('settings-error').hidden = true;

  const body = {
    pointsPerDollar: Number($('set-ratio').value),
    allowExactEntry: switchOn($('set-exact')),
    tiers: collectTiers(),
    address: $('set-address').value.trim(),
    punchEnabled: switchOn($('set-punch')),
  };
  if (logoChanged) body.logo = logoValue;   // null clears it; a data-URL sets it
  const pin = $('set-pin').value.trim();
  if (pin) body.pin = pin;

  busy = true;
  $('settings-save').disabled = true;
  try {
    const res = await authFetch('/api/vendor/settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (handlePinRequired(res, data)) return;
    if (!res.ok) {
      $('settings-error').textContent = data.message || 'Couldn’t save settings.';
      $('settings-error').hidden = false;
      return;
    }

    loadedSettings = data;
    // Everything's persisted now — re-baseline so the leave-guard (and the flood's
    // navigation callbacks) see a clean form and don't re-prompt.
    resetSettingsBaseline();
    // Refresh the cached vendor config so the award pad + PIN gating pick up the
    // new ratio / exact-entry / PIN state immediately.
    const cfg = await authFetch('/api/vendor/config');
    if (cfg.ok) config = await cfg.json();
    syncPunchTab();   // the PUNCH tab appears/disappears with the toggle

    if (data.pinChanged) {
      // The server dropped every session (incl. ours). Re-gate so the terminal
      // re-asks for the new PIN before any further sensitive action.
      pinUnlocked = false;
      pinToken = null;
      flood('success', 'SETTINGS SAVED', 'New PIN set. Re-enter it to continue.', () => switchMode('award'));
    } else if (afterTarget) {
      // "Save & leave" — head to the tab the vendor was trying to reach.
      flood('success', 'SETTINGS SAVED', 'Your changes are live.', () => proceedSwitchMode(afterTarget));
    } else {
      flood('success', 'SETTINGS SAVED', 'Your changes are live.', () => renderSettings(loadedSettings));
    }
  } catch {
    $('settings-error').textContent = 'No connection, try again.';
    $('settings-error').hidden = false;
  } finally {
    busy = false;
    $('settings-save').disabled = false;
  }
}

/* ---- change the login password ----
   A logged-in vendor updates their own Supabase auth password directly from the
   browser (sb.auth.updateUser) — no server route, no email/SMTP. Independent of
   the batched settings save above: its own button, its own inline feedback, and
   the session stays valid so the vendor keeps working after changing it. */
async function updatePassword() {
  if (busy) return;
  const pw = $('set-pw-new').value;
  const confirm = $('set-pw-confirm').value;
  // Match the /join application rules (8–72; bcrypt only reads the first 72 bytes).
  if (pw.length < 8 || pw.length > 72) return pwMsg('Password must be 8–72 characters.', false);
  if (pw !== confirm) return pwMsg('The two passwords don’t match.', false);

  busy = true;
  $('set-pw-save').disabled = true;
  try {
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) { pwMsg(error.message || 'Couldn’t update the password, try again.', false); return; }
    $('set-pw-new').value = '';
    $('set-pw-confirm').value = '';
    pwMsg('Password updated. Use it next time you sign in.', true);
  } catch {
    pwMsg('No connection, try again.', false);
  } finally {
    busy = false;
    $('set-pw-save').disabled = false;
  }
}

// Inline feedback for the password card: green on success, red on error.
function pwMsg(text, ok) {
  const el = $('set-pw-msg');
  el.textContent = text;
  el.className = ok ? 'field-success' : 'field-error';
  el.hidden = false;
}

/* ---- sign out ----
   Ends the Supabase session for this device and tears the shell back down to the
   sign-in card. It lives on Settings, which is behind the staff PIN, and always
   confirms first — an accidental sign-out mid-rush means hunting for credentials
   before the next customer can be served. */

function openSignOutConfirm() {
  $('signout-msg').hidden = true;
  // Sign-out isn't a tab switch, so it never reaches the unsaved-changes guard in
  // switchMode(). Warn here instead, since signing out drops those edits.
  $('signout-confirm-note').textContent = isSettingsDirty()
    ? 'You have unsaved settings changes. Signing out discards them. Staff will need the email and password to sign back in.'
    : 'Staff will need the email and password to sign back in on this device.';
  $('signout-confirm').hidden = false;
}

function closeSignOutConfirm() {
  $('signout-confirm').hidden = true;
}

async function signOut() {
  if (busy) return;
  busy = true;
  $('signout-go').disabled = true;
  let signedOut = false;
  try {
    const { error } = await sb.auth.signOut();
    signedOut = !error;
  } catch { /* offline — handled below */ }
  busy = false;
  $('signout-go').disabled = false;
  closeSignOutConfirm();

  // A failed sign-out leaves the session in storage, so the terminal would still
  // be signed in after a refresh. Say so rather than showing a login screen that
  // doesn't mean what it looks like.
  if (!signedOut) {
    $('signout-msg').textContent = 'Couldn’t sign out. Check the connection and try again.';
    $('signout-msg').hidden = false;
    return;
  }
  resetToLogin();
}

// Forget everything about the signed-out vendor and show the sign-in card, so
// the next sign-in on this shared terminal starts clean.
function resetToLogin() {
  config = null;
  rewards = [];
  loadedSettings = null;
  settingsBaseline = null;   // form's gone — nothing left to guard (incl. beforeunload)
  pendingMode = null;
  logoValue = null;
  logoChanged = false;
  // Drop the PIN session: whoever signs in next re-enters the staff PIN.
  pinUnlocked = false;
  pinToken = null;
  pinValue = '';
  pinTarget = null;
  pinAction = null;
  // Clear anything left over from the last transaction.
  currentEarnCode = null;
  currentMultiplier = 1;
  pendingRedeemCode = null;
  pendingRedeemKind = 'reward';
  pendingAward = null;
  padValue = '';
  // Punch tab: stop the rotating code and put the tab away until the next
  // vendor's config says otherwise.
  stopPunchLoop();
  if (document.body.classList.contains('punch-fs')) exitPunchFullscreen();
  punchHasQr = false;
  $('tab-punch').hidden = true;
  lastActivity = null;
  undoLastArmed = false;
  clearTimeout(undoLastTimer);
  clearTimeout(undoExpiryTimer);
  renderUndoLast();
  refreshSettingsDirty();   // clears the tab dot, Save ring and per-card highlights
  mode = 'award';
  setTabs('award');

  // Don't leave the previous vendor's PIN / password keystrokes sitting in the
  // hidden form fields; renderSettings() re-clears them on the next sign-in too.
  $('set-pin').value = '';
  $('set-pw-new').value = '';
  $('set-pw-confirm').value = '';
  $('set-pw-msg').hidden = true;
  $('settings-error').hidden = true;
  $('signout-msg').hidden = true;

  $('login-email').value = '';
  $('login-password').value = '';
  $('login-error').hidden = true;
  $('login-success').hidden = true;
  $('recover-email').value = '';
  clearRecoverFields();
  $('recover-error').hidden = true;
  $('recover-success').hidden = true;
  $('shell').hidden = true;
  show('screen-login');   // also stops the QR cameras, via syncScanners()
}
