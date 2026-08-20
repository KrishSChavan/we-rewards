/* WeRewards — fallback scanner client (public/scan)
   Built for a counter iPad stuck on iOS 12.5.7, below the iOS 13.4-14.2 floor
   that testing established for /terminal (public/vendor/terminal.js — see the
   comments on JS_TARGET in scripts/build-client.js). Same SCAN-tab feature set
   as the terminal (scan or type a code, award an earn code, PIN-confirm a
   redeem code, undo the last transaction) and the same email+password sign-in,
   but nothing else: no ITEMS, PUNCH, DEALS, STATS or SETTINGS.

   TWO RULES THIS FILE MUST KEEP, OR IT STOPS PARSING ON THE TARGET DEVICE:

   1. NO DESTRUCTURING. Not `const {a} = b`, not `const [a] = b`, not a
      destructured function parameter. scripts/build-client.js lowers this
      file to esbuild's `safari12` target (a real browser version, unlike the
      `es2017` edition target the other three apps use), and esbuild refuses
      that target outright the moment it sees destructuring ("Transforming
      destructuring to the configured target environment is not supported
      yet") — confirmed by probing esbuild directly, not assumed. Everything
      else this file uses (arrow functions, template literals, async/await,
      optional chaining, nullish coalescing, spread, classes) IS lowered
      correctly at this target; destructuring is the one exception.
   2. NO supabase-js. The vendored UMD bundle fails the same safari12 target
      with 209 destructuring errors, so it is never built into this app (see
      SUPABASE_APPS in scripts/build-client.js) and this page's HTML does not
      load it. Auth talks to Supabase's GoTrue REST endpoints directly with
      fetch instead — the exact same email+password grant supabase-js's
      signInWithPassword wraps, so the login method is unchanged, just not
      routed through a library that can't parse here.

   Everything below is deliberately close to the matching function in
   terminal.js so the two stay easy to compare; the diff is almost entirely
   the two rules above plus the trimmed feature set. */

if (window.__wrBooted) window.__wrBooted();

var config = null;             // vendor config from /api/vendor/config
var accountId = null;          // signed-in auth user id - keys the remembered store
var locations = [];            // every store this login runs (GET /api/vendor/locations)
var vendorId = null;           // the store this screen is ringing up for, sent as
                               // X-Vendor-Id on every /api/vendor/* call
var storeSwitching = false;    // a store switch is mid-flight (guards double-taps)
var currentEarnCode = null;    // customer's 6-digit earn code on the award pad
var currentMultiplier = 1;     // scanned customer's tier multiplier (1x/1.5x/2x)
var pendingRedeemCode = null;  // 4-digit redeem code awaiting vendor confirmation
var pendingRedeemKind = 'reward'; // 'reward' (redeem_codes) | 'punch' (visits)
var padValue = '';             // exact-amount entry string
var pinValue = '';
var pinUnlocked = false;       // set once the PIN is entered correctly; memory only
var pinToken = null;           // server-side PIN session token from verify-pin
var pinAction = null;          // callback to run after a successful PIN unlock
var busy = false;              // guards double-taps / double-submits
var idleTimeout = null;
var lastActivity = null;       // most recent transaction (for "Undo last")
var undoLastArmed = false;
var undoLastTimer = null;
var undoExpiryTimer = null;
// Idempotency for awards: reuse one token across a retry of the SAME award
// (customer + amount) so the server can dedupe if a network drop hid a success.
var pendingAward = null;       // { key, token, at }

var UNDO_WINDOW_MS = 60000;

var $ = function (id) { return document.getElementById(id); };

/* ---------- auth: Supabase GoTrue REST, no supabase-js ----------
   Same email+password grant supabase-js's signInWithPassword wraps, called
   directly over fetch. See the file header for why. */

var AUTH_KEY = 'psu-scan-auth';   // separate from the terminal's 'psu-vendor-auth'
var REFRESH_SKEW_MS = 60000;      // refresh this long before actual expiry
var authConfig = null;            // { url, anonKey } from /api/public-config
var session = null;               // { access_token, refresh_token, expires_at }

function loadStoredSession() {
  try {
    var raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function storeSession(next) {
  session = next;
  try {
    if (next) localStorage.setItem(AUTH_KEY, JSON.stringify(next));
    else localStorage.removeItem(AUTH_KEY);
  } catch (e) { /* private mode */ }
}

function authUrl(p) {
  return authConfig.url.replace(/\/+$/, '') + p;
}

function toSession(tokenResponse) {
  var expiresIn = Number(tokenResponse.expires_in) || 3600;
  return {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    expires_at: Date.now() + expiresIn * 1000,
  };
}

async function gotrueRequest(grantType, body) {
  var res = await fetch(authUrl('/auth/v1/token?grant_type=' + grantType), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: authConfig.anonKey },
    body: JSON.stringify(body),
  });
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    var err = new Error(data.error_description || data.msg || 'Sign-in failed.');
    err.code = data.error_code || data.error || null;
    throw err;
  }
  return data;
}

async function signInWithPassword(email, password) {
  var data = await gotrueRequest('password', { email: email, password: password });
  storeSession(toSession(data));
}

async function refreshSession() {
  if (!session || !session.refresh_token) return null;
  try {
    var data = await gotrueRequest('refresh_token', { refresh_token: session.refresh_token });
    storeSession(toSession(data));
    return session;
  } catch (e) {
    storeSession(null);
    return null;
  }
}

/** Valid access token, refreshing first if missing/near expiry. Null if there
 *  is no way to get one (never signed in, or the refresh token died). */
async function getAccessToken() {
  if (!session) session = loadStoredSession();
  if (!session) return null;
  if (session.expires_at - Date.now() < REFRESH_SKEW_MS) {
    var refreshed = await refreshSession();
    if (!refreshed) return null;
  }
  return session.access_token;
}

async function signOutAuth() {
  var token = session ? session.access_token : null;
  storeSession(null);
  if (!token) return;
  try {
    await fetch(authUrl('/auth/v1/logout'), {
      method: 'POST',
      headers: { apikey: authConfig.anonKey, Authorization: 'Bearer ' + token },
    });
  } catch (e) { /* best-effort revoke; local sign-out already happened above */ }
}

/* ---------- client crash reporting ---------- */

function installErrorReporter() {
  function send(message, stack, context) {
    getAccessToken().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      fetch('/api/client-error', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ source: 'vendor', message: message, stack: stack, url: location.pathname, context: context }),
      }).catch(function () {});
    }).catch(function () {});
  }
  window.addEventListener('error', function (e) {
    send(e.message || 'error', e.error ? e.error.stack : null, { line: e.lineno, col: e.colno });
  });
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    send(String((reason && reason.message) || reason || 'unhandledrejection'), reason ? reason.stack : null);
  });
}

var screens = ['screen-login', 'screen-recover', 'screen-scan', 'screen-pad', 'screen-pin', 'screen-redeem-confirm'];

function show(id) {
  screens.forEach(function (s) { $(s).hidden = s !== id; });
  clearTimeout(idleTimeout);
  // If the vendor walks away mid-transaction, fall back to the scan screen.
  if (id === 'screen-pad' || id === 'screen-redeem-confirm') {
    idleTimeout = setTimeout(function () { enterScan(); }, 60000);
  }
  syncScanners();   // camera runs only while its scan screen is the visible one
}

/* ---------- boot ---------- */

(async function boot() {
  installErrorReporter();
  var pub = await (await fetch('/api/public-config')).json();
  authConfig = { url: pub.supabaseUrl, anonKey: pub.supabaseAnonKey };

  wireEvents();
  setupQrScanning();

  var token = await getAccessToken();
  if (token) await enterApp();
  else show('screen-login');

  // Register the PWA service worker (scope /scan/) so the app is installable
  // to a device and its shell works offline. Best-effort.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/scan/sw.js').catch(function () {});
  }
})();

function wireEvents() {
  $('login-btn').addEventListener('click', doSignIn);
  $('login-password').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSignIn(); });
  $('login-forgot').addEventListener('click', enterRecover);
  $('recover-back').addEventListener('click', leaveRecover);
  $('recover-btn').addEventListener('click', submitRecover);
  $('recover-confirm').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitRecover(); });
  $('recover-code').addEventListener('input', function (e) { e.target.value = formatResetCodeInput(e.target.value); });
  // The vendor name doubles as the store switcher for a login that runs several
  // locations; it ships disabled, so this does nothing until paintStoreSwitcher
  // finds a second store.
  $('store-btn').addEventListener('click', toggleStoreMenu);
  $('signout-btn').addEventListener('click', openSignOutConfirm);
  $('signout-cancel').addEventListener('click', closeSignOutConfirm);
  $('signout-go').addEventListener('click', signOut);
  $('pad-cancel').addEventListener('click', function () { enterScan(); });
  $('pad-award').addEventListener('click', function () { awardAmount(Number(padValue)); });
  $('quick-awards').addEventListener('click', onQuickAward);
  $('undo-last').addEventListener('click', onUndoLastTap);
  $('amount-keypad').addEventListener('click', onAmountKey);
  $('pin-keypad').addEventListener('click', onPinKey);
  $('redeem-cancel').addEventListener('click', function () { enterScan(); });
  $('redeem-confirm').addEventListener('click', confirmRedeem);
  $('scan-code-form').addEventListener('submit', function (e) { e.preventDefault(); submitTypedCode(); });
  $('scan-code-input').addEventListener('input', function (e) { e.target.value = normalizeCode(e.target.value); });
  $('scan-keypad').addEventListener('click', function (e) { onCodeKey(e, 'scan-code-input', normalizeCode); });
}

async function doSignIn() {
  var btn = $('login-btn');
  btn.disabled = true;
  $('login-error').hidden = true;
  $('login-success').hidden = true;
  try {
    await signInWithPassword($('login-email').value.trim(), $('login-password').value);
  } catch (e) {
    btn.disabled = false;
    $('login-error').textContent = 'Sign-in failed. Check email and password.';
    $('login-error').hidden = false;
    return;
  }
  btn.disabled = false;
  await enterApp();
}

/* ---------- forgot password ----------
   Out-of-band, same as the terminal: the operator mints a one-time code in
   /admin and reads it down the phone; POST /api/vendor/recover verifies it
   and sets the new password. Already a plain fetch on the server side, so it
   needs nothing rewritten here beyond copying it over. */

function enterRecover() {
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
  $('login-success').hidden = true;
  show('screen-login');
}

function clearRecoverFields() {
  $('recover-code').value = '';
  $('recover-password').value = '';
  $('recover-confirm').value = '';
}

function formatResetCodeInput(raw) {
  var bare = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return bare.length > 4 ? bare.slice(0, 4) + '-' + bare.slice(4) : bare;
}

function recoverError(msg) {
  var el = $('recover-error');
  el.textContent = msg;
  el.hidden = false;
  $('recover-btn').disabled = false;
}

async function submitRecover() {
  var btn = $('recover-btn');
  $('recover-error').hidden = true;
  $('recover-success').hidden = true;

  var email = $('recover-email').value.trim();
  var code = $('recover-code').value.trim();
  var password = $('recover-password').value;
  var confirm = $('recover-confirm').value;

  if (!email || !code) return recoverError('Enter your email and the reset code.');
  if (password.length < 8) return recoverError('Password must be at least 8 characters.');
  if (password.length > 72) return recoverError('Password must be 72 characters or fewer.');
  if (password !== confirm) return recoverError('The two passwords don’t match.');

  btn.disabled = true;
  try {
    var res = await fetch('/api/vendor/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, code: code, newPassword: password }),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      return recoverError(data.message || 'Couldn’t reset the password. Ask for a new code.');
    }

    var ok = $('recover-success');
    ok.textContent = data.vendorName ? ('Password updated for ' + data.vendorName + '.') : 'Password updated.';
    ok.hidden = false;

    var signedInEmail = email;
    clearRecoverFields();
    setTimeout(function () {
      $('login-email').value = signedInEmail;
      $('login-password').value = '';
      $('login-error').hidden = true;
      var note = $('login-success');
      note.textContent = 'Password updated. Sign in with your new password.';
      note.hidden = false;
      show('screen-login');
      $('login-password').focus();
    }, 1200);
  } catch (e) {
    recoverError('No connection. Check the internet and try again.');
  }
}

async function enterApp() {
  accountId = accountFromToken(await getAccessToken());

  // WHICH STORE first, before anything else asks the server for vendor data:
  // every /api/vendor/* call carries the choice as X-Vendor-Id, and a login
  // that runs several stores and names none is answered VENDOR_AMBIGUOUS.
  vendorId = null;
  locations = await fetchLocations();
  vendorId = chooseStore(savedStore());

  if (!(await loadConfig())) return;   // it has already said why, on the login card

  paintStoreSwitcher();
  $('shell').hidden = false;
  $('screen-login').hidden = true;
  refreshLastActivity();
  enterScan();
}

/**
 * Load /config for the current vendorId into `config`. Returns false - having
 * put the sign-in card back up carrying the reason - when this login cannot use
 * this screen at all.
 */
async function loadConfig() {
  var attempt;
  for (attempt = 0; attempt < 2; attempt++) {
    var res = await authFetch('/api/vendor/config');
    if (res.ok) {
      config = await res.json();
      rememberStore();
      return true;
    }
    var data = await res.json().catch(function () { return {}; });

    // The remembered store was switched off, or this login lost access to it,
    // while the app was closed - and there is another one to fall back to. Take
    // it rather than bouncing a vendor who does still have somewhere to sell
    // from. Once only: a second failure is not about which store was picked.
    var alt = null;
    locations.forEach(function (l) { if (!alt && l.active && l.id !== vendorId) alt = l; });
    if (!attempt && alt && (data.error === 'VENDOR_DISABLED' || data.error === 'VENDOR_AMBIGUOUS')) {
      vendorId = alt.id;
      continue;
    }

    // VENDOR_AMBIGUOUS with nothing to fall back to means the store LIST did not
    // load, not that the account is unusable, so the session stays and the
    // message is one the vendor can act on. Every other answer is about the
    // ACCOUNT, and there the session has to end for the sign-in card to be
    // telling the truth.
    if (data.error === 'VENDOR_AMBIGUOUS') {
      $('login-error').textContent = 'Couldn’t load your stores. Check the connection and try again.';
    } else {
      await signOutAuth();
      $('login-error').textContent = (data && data.message) || 'This account is not linked to a vendor.';
    }
    $('login-error').hidden = false;
    $('shell').hidden = true;
    show('screen-login');
    return false;
  }
  return false;
}

/* ---------- store switcher (multi-location logins) ----------

   vendor_staff is a join table, so one login can be staff of several vendors
   (migration-043). The server picks which one a request means from the
   X-Vendor-Id header and answers VENDOR_AMBIGUOUS without it, so this screen
   needs the same switcher the full terminal has, or a chain cannot sign in here
   at all. Kept deliberately close to terminal.js, minus the tabs this app does
   not have. NO DESTRUCTURING anywhere below: this file is lowered to safari12,
   which esbuild refuses to transform destructuring for. */

// Remembered per ACCOUNT and per DEVICE, same as the terminal: the till by the
// Downtown register opens on Downtown, and two vendors sharing an iPad do not
// inherit each other's pick.
function storeKey() {
  return 'wrw-scan-store:' + (accountId || 'anon');
}

function savedStore() {
  try { return localStorage.getItem(storeKey()); } catch (e) { return null; }
}

function rememberStore() {
  if (!vendorId || !accountId) return;
  try { localStorage.setItem(storeKey(), vendorId); } catch (e) { /* private mode */ }
}

/* Who is signed in, read out of the access token's `sub` claim. There is no
   supabase-js here to ask, and the stored session is only the raw tokens.
   Decoded with a regex rather than JSON.parse: a JWT payload is base64url of
   UTF-8 and atob hands back bytes, so a name or email with an accent in it
   would break the parse of a token that is otherwise perfectly good. */
function accountFromToken(token) {
  try {
    var part = String(token || '').split('.')[1];
    if (!part) return null;
    var b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var m = atob(b64).match(/"sub"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

async function fetchLocations() {
  try {
    var res = await authFetch('/api/vendor/locations');
    if (!res.ok) return [];
    var body = await res.json();
    return body && Array.isArray(body.locations) ? body.locations : [];
  } catch (e) {
    // Offline or a 5xx. A single-location login still works from here: the
    // server resolves its one link without being told.
    return [];
  }
}

/** The store to open on: the remembered one while it is still usable, else the
 *  first one this login runs. Null when the list did not load. */
function chooseStore(savedId) {
  var usable = locations.filter(function (l) { return l.active; });
  var saved = null;
  var i;
  for (i = 0; i < usable.length; i++) if (usable[i].id === savedId) saved = usable[i];
  var pick = saved || usable[0] || locations[0] || null;
  return pick ? pick.id : null;
}

// What to call a store on one line. Every location of a chain carries the same
// business name, so the label is what actually identifies it.
function storeTitle(l) {
  return l.locationLabel || l.name;
}

function configTitle() {
  if (!config) return '';
  return config.locationLabel ? config.name + ' · ' + config.locationLabel : config.name;
}

function paintStoreSwitcher() {
  var btn = $('store-btn');
  var many = locations.length > 1;

  $('vendor-name').textContent = configTitle();
  btn.disabled = !many;
  $('store-caret').hidden = !many;
  closeStoreMenu();

  var menu = $('store-menu');
  menu.innerHTML = '';
  if (!many) return;

  locations.forEach(function (l) {
    var current = l.id === vendorId;
    var item = document.createElement('button');
    item.type = 'button';
    item.className = current ? 'store-item is-current' : 'store-item';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(current));
    // Switched off by the operator: listed so its absence is not a mystery, but
    // not selectable (requireVendor would answer VENDOR_DISABLED).
    item.disabled = !l.active;

    var text = document.createElement('span');
    text.className = 'store-item-text';
    var name = document.createElement('span');
    name.className = 'store-item-name';
    name.textContent = storeTitle(l);
    text.appendChild(name);

    // The tiebreak line: two branches may carry the same label, or none, and
    // the address is the one thing that is always different.
    var sub = l.address || (l.locationLabel ? l.name : '');
    if (sub) {
      var s = document.createElement('span');
      s.className = 'store-item-sub';
      s.textContent = sub;
      text.appendChild(s);
    }

    var off = document.createElement('span');
    off.className = 'store-item-off';
    off.textContent = 'OFF';
    off.hidden = l.active;

    var mark = document.createElement('span');
    mark.className = 'store-item-mark';
    mark.textContent = '✓';
    mark.hidden = !current;

    item.appendChild(text);
    item.appendChild(off);
    item.appendChild(mark);
    item.addEventListener('click', function () { requestStoreSwitch(l.id); });
    menu.appendChild(item);
  });
}

function openStoreMenu() {
  if (locations.length < 2) return;
  $('store-menu').hidden = false;
  $('store-btn').setAttribute('aria-expanded', 'true');
  // Capture phase, so a control that stops propagation still dismisses it.
  // Registering from inside the opening click is safe: document's capture
  // listeners for that event have already run by the time this handler does.
  document.addEventListener('click', onStoreOutsideTap, true);
  document.addEventListener('keydown', onStoreMenuKey, true);
}

function closeStoreMenu() {
  $('store-menu').hidden = true;
  $('store-btn').setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', onStoreOutsideTap, true);
  document.removeEventListener('keydown', onStoreMenuKey, true);
}

function toggleStoreMenu() {
  if ($('store-menu').hidden) openStoreMenu();
  else closeStoreMenu();
}

function onStoreOutsideTap(e) {
  if (!$('store-switch').contains(e.target)) closeStoreMenu();
}

function onStoreMenuKey(e) {
  if (e.key === 'Escape') { closeStoreMenu(); $('store-btn').focus(); }
}

function requestStoreSwitch(id) {
  closeStoreMenu();
  if (storeSwitching || busy || id === vendorId) return;
  var target = null;
  locations.forEach(function (l) { if (l.id === id) target = l; });
  if (!target || !target.active) return;
  applyStoreSwitch(id);
}

/** Point the whole screen at another store. */
async function applyStoreSwitch(id) {
  if (storeSwitching) return;
  storeSwitching = true;

  var previousId = vendorId;
  var previousConfig = config;
  vendorId = id;

  // Everything held here is about ONE store: the PIN session, a half-finished
  // award, the undo window. The PIN gate re-arming is the load-bearing part,
  // since pin sessions are keyed (vendor_id, user_id) server-side and the old
  // token is rejected at the new store anyway.
  clearVendorState();

  var res = null;
  var data = {};
  try {
    res = await authFetch('/api/vendor/config');
    data = await res.json().catch(function () { return {}; });
  } catch (e) { /* offline - handled below */ }

  if (!res || !res.ok) {
    // Put the screen back on the store it was working from rather than
    // stranding it between two.
    vendorId = previousId;
    config = previousConfig;
    storeSwitching = false;
    repaintForStore();
    flood('error', 'COULDN’T SWITCH', (data && data.message) || 'Check the connection and try again.');
    return;
  }

  config = data;
  rememberStore();
  storeSwitching = false;
  repaintForStore();
  flood('success', 'STORE CHANGED', 'Now ringing up for ' + configTitle() + '.', null, 1800);
}

function repaintForStore() {
  paintStoreSwitcher();
  refreshLastActivity();
  enterScan();
}

/* ---------- helpers ---------- */

async function authFetch(path, opts) {
  opts = opts || {};
  var token = await getAccessToken();
  var headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') };
  // WHICH STORE this request is about. One login can be staff of several
  // (migration-043) and requireVendor answers VENDOR_AMBIGUOUS rather than
  // guessing. Omitted until a store is chosen, which is also right for the
  // single-location vendor: the server resolves their one link on its own.
  if (vendorId) headers['X-Vendor-Id'] = vendorId;
  if (pinToken) headers['X-Vendor-Pin'] = pinToken;
  if (opts.headers) {
    for (var k in opts.headers) headers[k] = opts.headers[k];
  }
  return fetch(path, { method: opts.method, body: opts.body, headers: headers });
}

/** Run `action` once the staff PIN is satisfied. No PIN configured, or one
 *  already entered this page session, runs it straight away; otherwise the PIN
 *  pad goes up and onPinKey resumes the action on success. This app has only
 *  one screen family (SCAN), so unlike terminal.js there is no other tab to
 *  land on afterward — it always comes back to the scan screen. */
function requirePin(action) {
  if (!config || !config.hasPin || pinUnlocked) { action(); return; }
  pinAction = action;
  pinValue = '';
  renderPinDots();
  $('pin-error').hidden = true;
  show('screen-pin');
}

// The PIN session can expire mid-shift; a 401 PIN_REQUIRED from a gated route
// means re-authenticate. `retry` (optional) is the call to replay once the new
// PIN lands.
function handlePinRequired(res, data, retry) {
  if (res.status === 401 && data && data.error === 'PIN_REQUIRED') {
    pinUnlocked = false;
    pinToken = null;
    pinValue = '';
    if (retry) {
      if (config) config.hasPin = true;
      requirePin(retry);
      return true;
    }
    return true;
  }
  return false;
}

/* ---------- code entry helpers ---------- */

function normalizeCode(v) {
  return String(v || '').replace(/\D/g, '').slice(0, 6);
}

function onCodeKey(e, inputId, normalize) {
  var btn = e.target.closest('button');
  var k = btn && btn.dataset ? btn.dataset.k : null;
  if (!k) return;
  var input = $(inputId);
  var v = input.value;
  if (k === 'back') v = v.slice(0, -1);
  else if (k === 'clear') v = '';
  else v = v + k;
  input.value = normalize(v);
}

/* ---------- QR camera scanner ----------
   Same decode strategy as terminal.js: native BarcodeDetector where it
   advertises qr_code support, jsQR joins in after a grace period (some
   builds exist yet silently never match), and jsQR runs from the start where
   BarcodeDetector is missing entirely (iPad Safari, and this device). */

var CAMERA_KEY = 'wrw-scan-camera';   // preferred camera deviceId (localStorage)
var SCAN_DEBOUNCE_MS = 3000;
var JSQR_INTERVAL_MS = 120;
var JSQR_MAX_DIM = 640;
var DETECTOR_GRACE_MS = 3000;

var DEFAULT_SCAN_STATUS = 'Point the camera at the QR code in the customer’s WeRewards app.';
var scanUi = { manual: false, cameraMsgText: null, scanner: null, statusTimer: null };

/* ---------- the installed-app camera blackout ----------
   Same mechanism as STANDALONE_CAM_COOKIE in public/vendor/terminal.js,
   confirmed working there on real hardware, now that this app is installable
   too. iOS only gave getUserMedia to home-screen web apps in 14.3. Below
   that, `navigator.mediaDevices` is undefined inside the icon's web view and
   present in a Safari tab on the SAME device and the SAME URL. Nothing here
   can recover it directly — there is no legacy alias to fall back on, and the
   API is absent rather than blocked, so it is not a permission we can re-ask
   for. The only lever is to stop launching chrome-less: the page tells the
   server, with a cookie, that THIS install has to give up the standalone
   container; serveShell (server.js) then withholds apple-mobile-web-app-capable
   and the next launch opens in Safari, where the camera works. iOS re-reads
   the tag at launch, so a force-quit is enough; the icon does not have to be
   deleted and re-added. The cookie expires so a device that later takes an
   iOS update re-tests instead of being held in Safari forever. Scoped to
   Path=/scan so it never collides with (or is collided into by) the same
   cookie name terminal.js sets scoped to Path=/terminal. */
var STANDALONE_CAM_COOKIE = 'wr_no_standalone_cam';
var STANDALONE_CAM_DAYS = 180;

function isStandaloneLaunch() {
  if (navigator.standalone === true) return true;
  try { return window.matchMedia('(display-mode: standalone)').matches; } catch (e) { return false; }
}

function setStandaloneCamCookie(on) {
  var age = on ? STANDALONE_CAM_DAYS * 86400 : 0;
  var secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = STANDALONE_CAM_COOKIE + '=' + (on ? '1' : '') + '; Max-Age=' + age + '; Path=/scan; SameSite=Lax' + secure;
}

var STANDALONE_CAM_MSG =
  'This iPad’s iOS is too old to use the camera inside an installed app. '
  + 'Close the app fully (swipe it away in the app switcher) and open it again: '
  + 'it will reopen showing Safari’s address bar, and the scanner will work. '
  + 'Until then, enter codes manually.';

function parseQrPayload(raw) {
  var s = String(raw == null ? '' : raw).trim();
  var m = /^WRW:E:(\d{6})$/i.exec(s);
  if (m) return { kind: 'earn', code: m[1] };
  m = /^WRW:R:(\d{4})$/i.exec(s);
  if (m) return { kind: 'redeem', code: m[1] };
  m = /^WRW:P:(\d{4})$/i.exec(s);
  if (m) return { kind: 'redeem', code: m[1] };
  if (/[?&]punch=/.test(s)) return { kind: 'punch-url' };
  if (/^\d{6}$/.test(s)) return { kind: 'earn', code: s };
  if (/^\d{4}$/.test(s)) return { kind: 'redeem', code: s };
  return null;
}

function cameraErrorMessage(err) {
  var name = err && err.name ? err.name : '';
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
function createScanner(opts) {
  var videoId = opts.videoId;
  var flipId = opts.flipId;
  var onPayload = opts.onPayload;
  var onFail = opts.onFail;
  var video = $(videoId);
  var flipBtn = $(flipId);
  var stream = null;
  var running = false;
  var session = 0;
  var rafId = 0;
  var detectorTimer = null;
  var jsqrTimer = null;
  var jsqrOn = false;
  var canvas = null;
  var ctx2d = null;
  var lastAttempt = 0;
  var devices = [];
  var lastPayload = null;
  var lastPayloadAt = 0;

  function readStoredCamera() {
    try { return localStorage.getItem(CAMERA_KEY); } catch (e) { return null; }
  }

  async function openStream() {
    var base = { width: { ideal: 1280 }, height: { ideal: 720 } };
    var saved = readStoredCamera();
    if (saved) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: false, video: Object.assign({}, base, { deviceId: { exact: saved } }),
        });
      } catch (e) { /* remembered camera unplugged — fall through to the default pick */ }
    }
    return navigator.mediaDevices.getUserMedia({
      audio: false, video: Object.assign({}, base, { facingMode: { ideal: 'environment' } }),
    });
  }

  function waitForFrames(my) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      function check() {
        if (session !== my) return resolve(false);
        if (video.readyState >= 2 && video.videoWidth > 0) return resolve(true);
        if (Date.now() - t0 > 8000) return resolve(false);
        setTimeout(check, 50);
      }
      video.addEventListener('loadedmetadata', check, { once: true });
      check();
    });
  }

  async function start() {
    if (running) return;
    var my = ++session;
    if (!window.isSecureContext) {
      return onFail('The camera needs a secure (https) connection. Enter codes manually.');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // Missing because we are in the pre-14.3 home-screen container, not
      // because this browser has no camera support at all. Say which, and set
      // the flag that gets the next launch out of that container.
      if (isStandaloneLaunch()) {
        setStandaloneCamCookie(true);
        return onFail(STANDALONE_CAM_MSG);
      }
      return onFail('This browser can’t use the camera. Enter codes manually.');
    }
    var s;
    try {
      s = await openStream();
    } catch (err) {
      if (session === my) onFail(cameraErrorMessage(err));
      return;
    }
    if (session !== my) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
    stream = s;
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* autoplay+muted+playsinline: frames still arrive */ }
    var ready = await waitForFrames(my);
    if (session !== my) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
    if (!ready) {
      stop();
      return onFail('The camera started but sent no picture. Enter codes manually.');
    }
    running = true;
    // Frames are arriving from inside the home-screen container, so this device
    // does not need the chrome-less opt-out (it was updated past 14.3, or never
    // needed it). Clear the flag so the icon can go chrome-less again.
    if (isStandaloneLaunch()) setStandaloneCamCookie(false);
    if (lastPayload) lastPayloadAt = Date.now();
    refreshDeviceList();
    startDecoders(my);
  }

  function stop() {
    session++;
    running = false;
    jsqrOn = false;
    cancelAnimationFrame(rafId);
    clearInterval(detectorTimer);
    clearTimeout(jsqrTimer);
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    video.srcObject = null;
  }

  async function startDecoders(my) {
    var detector = null;
    if ('BarcodeDetector' in window) {
      try {
        var formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch (e) { detector = null; }
    }
    if (session !== my) return;
    if (!detector) return startJsqr(my);

    var produced = false;
    var detBusy = false;
    detectorTimer = setInterval(async function () {
      if (detBusy || session !== my) return;
      detBusy = true;
      try {
        var codes = await detector.detect(video);
        if (session === my && codes && codes.length) {
          produced = true;
          if (codes[0].rawValue != null) handlePayload(String(codes[0].rawValue));
        }
      } catch (e) { /* some builds throw forever — the jsQR fallback below covers it */
      } finally { detBusy = false; }
    }, 130);
    jsqrTimer = setTimeout(function () { if (session === my && !produced) startJsqr(my); }, DETECTOR_GRACE_MS);
  }

  function startJsqr(my) {
    if (session !== my || jsqrOn) return;
    jsqrOn = true;
    lastAttempt = 0;
    rafId = requestAnimationFrame(jsqrTick);
  }

  function jsqrTick(ts) {
    if (!running || !jsqrOn) return;
    rafId = requestAnimationFrame(jsqrTick);
    if (ts - lastAttempt < JSQR_INTERVAL_MS || !video.videoWidth) return;
    lastAttempt = ts;
    var scale = Math.min(1, JSQR_MAX_DIM / Math.max(video.videoWidth, video.videoHeight));
    var w = Math.max(1, Math.round(video.videoWidth * scale));
    var h = Math.max(1, Math.round(video.videoHeight * scale));
    if (!canvas) {
      canvas = document.createElement('canvas');
      ctx2d = canvas.getContext('2d', { willReadFrequently: true });
    }
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    var img;
    try {
      ctx2d.drawImage(video, 0, 0, w, h);
      img = ctx2d.getImageData(0, 0, w, h);
    } catch (e) { return; }
    var hit = typeof jsQR === 'function' ? jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' }) : null;
    if (hit && hit.data) handlePayload(String(hit.data));
  }

  function handlePayload(raw) {
    if (!running) return;
    if (busy) return;
    var now = Date.now();
    if (raw === lastPayload && now - lastPayloadAt < SCAN_DEBOUNCE_MS) {
      lastPayloadAt = now;
      return;
    }
    lastPayload = raw;
    lastPayloadAt = now;
    onPayload(raw);
  }

  async function refreshDeviceList() {
    try {
      var all = await navigator.mediaDevices.enumerateDevices();
      devices = all.filter(function (d) { return d.kind === 'videoinput' && d.deviceId; });
    } catch (e) { devices = []; }
    flipBtn.hidden = devices.length < 2;
  }

  async function flip() {
    await refreshDeviceList();
    if (devices.length < 2) return;
    var track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    var cur = track && track.getSettings ? track.getSettings().deviceId : null;
    var i = devices.findIndex(function (d) { return d.deviceId === cur; });
    var next = devices[(i + 1) % devices.length];
    try { localStorage.setItem(CAMERA_KEY, next.deviceId); } catch (e) { /* private mode */ }
    stop();
    start();
  }

  return { start: start, stop: stop, flip: flip, isRunning: function () { return running; } };
}

function setupQrScanning() {
  scanUi.scanner = createScanner({
    videoId: 'scan-qr-video', flipId: 'scan-qr-flip',
    onPayload: onScanPayload,
    onFail: onCameraFail,
  });

  $('scan-qr-flip').addEventListener('click', function () { scanUi.scanner.flip(); });
  $('scan-manual-btn').addEventListener('click', function () { setManualMode(true); });
  $('scan-camera-btn').addEventListener('click', function () { setManualMode(false); });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { scanUi.scanner.stop(); }
    else { syncScanners(); }
  });
}

function syncScanners() {
  if (!scanUi.scanner) return;
  var ui = scanUi;
  $('scan-area').hidden = ui.manual;
  $('scan-manual-area').hidden = !ui.manual;
  var msgEl = $('scan-camera-msg');
  msgEl.textContent = ui.cameraMsgText || '';
  msgEl.hidden = !ui.cameraMsgText;
  if (!$('screen-scan').hidden && !ui.manual && !document.hidden) {
    if (!ui.scanner.isRunning()) {
      $('scan-qr-frame').classList.remove('is-hit');
      $('scan-qr-status').textContent = DEFAULT_SCAN_STATUS;
      $('scan-qr-status').classList.remove('is-error');
    }
    ui.scanner.start();
  } else {
    ui.scanner.stop();
  }
}

function onScanPayload(raw) {
  var parsed = parseQrPayload(raw);
  if (!parsed) return flashScanStatus('Not a WeRewards code');
  if (parsed.kind === 'punch-url') {
    return flashScanStatus('That’s a visit code, not a customer code');
  }
  scanUi.scanner.stop();
  $('scan-qr-frame').classList.add('is-hit');
  if (parsed.kind === 'earn') submitEarnCode(parsed.code);
  else startRedeem(parsed.code);
}

function flashScanStatus(msg) {
  var el = $('scan-qr-status');
  el.textContent = msg;
  el.classList.add('is-error');
  clearTimeout(scanUi.statusTimer);
  scanUi.statusTimer = setTimeout(function () {
    el.textContent = DEFAULT_SCAN_STATUS;
    el.classList.remove('is-error');
  }, 2500);
}

function setManualMode(manual) {
  scanUi.manual = manual;
  if (!manual) scanUi.cameraMsgText = null;
  syncScanners();
}

function onCameraFail(msg) {
  scanUi.manual = true;
  scanUi.cameraMsgText = msg;
  syncScanners();
}

/* ---------- SCAN flow: one screen, both directions ---------- */

function enterScan() {
  currentEarnCode = null;
  currentMultiplier = 1;
  pendingRedeemCode = null;
  pendingRedeemKind = 'reward';
  show('screen-scan');
  $('scan-code-input').value = '';
}

function submitTypedCode() {
  if (busy) return;
  var code = normalizeCode($('scan-code-input').value);
  if (code.length === 6) return submitEarnCode(code);
  if (code.length === 4) return startRedeem(code);
  flood('error', 'CHECK THE CODE', 'Enter the customer’s 6-digit code, or a 4-digit redeem code.', enterScan);
}

function startRedeem(code) {
  requirePin(function () { submitRedeemCode(code); });
}

async function submitEarnCode(code) {
  if (busy) return;
  if (code.length !== 6) {
    return flood('error', 'ENTER 6 DIGITS', 'The customer’s code is 6 numbers.', enterScan);
  }
  busy = true;
  try {
    var res = await authFetch('/api/vendor/scan', {
      method: 'POST',
      body: JSON.stringify({ code: code }),
    });
    var data = await res.json();
    if (!res.ok) return flood('error', 'CODE EXPIRED', data.message || 'Ask the customer to refresh their code.', enterScan);
    currentEarnCode = code;
    currentMultiplier = data.multiplier ?? 1;
    $('customer-name').textContent = data.name;
    $('customer-balance').textContent = data.balance;
    $('customer-tier').textContent = currentMultiplier + 'x';
    $('customer-tier').classList.toggle('is-boosted', currentMultiplier > 1);
    padValue = '';
    renderQuickAwards();
    setupExactEntry();
    renderPad();
    show('screen-pad');
  } catch (e) {
    flood('error', 'NO CONNECTION', 'Check the internet and try again.', enterScan);
  } finally {
    busy = false;
  }
}

function onAmountKey(e) {
  var k = e.target.dataset ? e.target.dataset.k : null;
  if (!k) return;
  if (k === 'back') padValue = padValue.slice(0, -1);
  else if (k === '.') { if (padValue.indexOf('.') === -1) padValue = (padValue || '0') + '.'; }
  else {
    var next = padValue + k;
    var parts = next.split('.');
    var dec = parts[1];
    // $200 hard per-award ceiling — matches MAX_AWARD_DOLLARS in src/routes/vendor.js.
    if ((dec ? dec.length : 0) <= 2 && Number(next) <= 200) padValue = next;
  }
  renderPad();
}

function renderPad() {
  var amt = Number(padValue || 0);
  var base = Math.floor(amt * config.pointsPerDollar);
  $('pad-amount').textContent = amt.toFixed(2);
  $('pad-points').textContent = Math.floor(base * currentMultiplier);
  $('pad-mult').hidden = currentMultiplier <= 1;
  $('pad-mult').textContent = currentMultiplier > 1 ? ('(' + base + ' × ' + currentMultiplier + 'x member)') : '';
  $('pad-award').disabled = amt <= 0;
}

function tierAmount(t) {
  if (t && t.amount != null) return Number(t.amount);
  if (t && t.min != null && t.max != null) return (Number(t.min) + Number(t.max)) / 2;
  return NaN;
}

var fmtAmount = function (n) { return (n % 1 ? n.toFixed(2) : String(n)); };

function renderQuickAwards() {
  var wrap = $('quick-awards');
  var tiers = Array.isArray(config.tiers) ? config.tiers : [];
  wrap.innerHTML = '';
  var usable = tiers.filter(function (t) { return tierAmount(t) > 0; });
  wrap.hidden = usable.length === 0;
  var wrapper = wrap.closest('.pad-shortcut-wrapper');
  if (wrapper) wrapper.classList.toggle('is-empty', usable.length === 0);
  usable.forEach(function (t) {
    var amt = tierAmount(t);
    var pts = Math.floor(Math.floor(amt * config.pointsPerDollar) * currentMultiplier);
    var b = document.createElement('button');
    b.className = 'quick-award';
    b.dataset.amt = amt;
    b.innerHTML =
      '<span class="qa-label">' + escapeHtml(t.label) + '</span>' +
      '<span class="qa-amt">$' + fmtAmount(amt) + '</span>' +
      '<span class="qa-pts">+' + pts + ' pts</span>';
    wrap.appendChild(b);
  });
}

function setupExactEntry() {
  var hasQuick = !$('quick-awards').hidden;
  var exactOn = config.allowExactEntry !== false || !hasQuick;
  $('exact-entry').hidden = !exactOn;
  $('pad-award').hidden = !exactOn;
}

function onQuickAward(e) {
  var btn = e.target.closest('.quick-award');
  if (!btn) return;
  awardAmount(Number(btn.dataset.amt));
}

async function awardAmount(dollarAmount) {
  if (busy || !currentEarnCode) return;
  var amt = Number(dollarAmount);
  if (!(amt > 0)) return;
  busy = true;

  var key = currentEarnCode + ':' + amt;
  var now = Date.now();
  if (!pendingAward || pendingAward.key !== key || now - pendingAward.at > 120000) {
    var token = (crypto.randomUUID ? crypto.randomUUID() : null)
      ?? ('aw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
    pendingAward = { key: key, token: token, at: now };
  }
  var requestId = pendingAward.token;

  try {
    var res = await authFetch('/api/vendor/award', {
      method: 'POST',
      body: JSON.stringify({ code: currentEarnCode, exactAmount: amt, requestId: requestId }),
    });
    pendingAward = null;
    var data = await res.json();
    if (!res.ok) {
      return flood('error', 'DIDN’T GO THROUGH', data.message, enterScan);
    }
    var detail = data.bonusPoints > 0
      ? (data.customerName + ' · ' + data.basePoints + ' base + ' + data.bonusPoints + ' tier bonus (' + data.multiplier + 'x) · new balance ' + data.newBalance)
      : (data.customerName + ' · new balance ' + data.newBalance);
    flood('success', '+' + data.awarded + ' PTS', detail, function () {
      refreshLastActivity();
      enterScan();
    });
  } catch (e) {
    if (pendingAward && pendingAward.key === key) pendingAward.at = Date.now();
    flood('error', 'NO CONNECTION', 'Check the internet and try again.', enterScan);
  } finally {
    busy = false;
  }
}

/* ---------- REDEEM flow: 4-digit code -> PIN -> confirm -> deduct ---------- */

function renderPinDots() {
  Array.prototype.slice.call($('pin-dots').children).forEach(function (dot, i) {
    dot.classList.toggle('filled', i < pinValue.length);
  });
}

async function onPinKey(e) {
  var k = e.target.dataset ? e.target.dataset.k : null;
  if (!k) return;
  if (k === 'cancel') { pinValue = ''; pinAction = null; return enterScan(); }
  if (k === 'back') pinValue = pinValue.slice(0, -1);
  else if (pinValue.length < 4) pinValue += k;
  renderPinDots();

  if (pinValue.length === 4) {
    var res = await authFetch('/api/vendor/verify-pin', {
      method: 'POST',
      body: JSON.stringify({ pin: pinValue }),
    });
    var data = await res.json().catch(function () { return {}; });
    pinValue = '';
    renderPinDots();
    if (res.ok) {
      pinUnlocked = true;
      pinToken = data.token ?? null;
      var fn = pinAction;
      pinAction = null;
      enterScan();
      if (fn) fn();
    } else {
      $('pin-error').textContent = data.error === 'PIN_LOCKED'
        ? (data.message || 'Too many incorrect PINs. Wait a few minutes and try again.')
        : 'Incorrect PIN, try again.';
      $('pin-error').hidden = false;
    }
  }
}

async function submitRedeemCode(code) {
  if (busy) return;
  if (code.length !== 4) {
    return flood('error', 'ENTER 4 DIGITS', 'The redemption code is 4 numbers.', enterScan);
  }
  busy = true;
  try {
    var res = await authFetch('/api/vendor/redeem-preview', {
      method: 'POST',
      body: JSON.stringify({ code: code }),
    });
    var data = await res.json();
    if (handlePinRequired(res, data, function () { submitRedeemCode(code); })) return;
    if (!res.ok) {
      return flood('error', 'CAN’T REDEEM', data.message || 'Code expired or already used.', enterScan);
    }
    showRedeemConfirm(code, data);
  } catch (e) {
    flood('error', 'NO CONNECTION', 'Check the internet and try again.', enterScan);
  } finally {
    busy = false;
  }
}

function showRedeemConfirm(code, data) {
  pendingRedeemCode = code;
  pendingRedeemKind = data.paidWith === 'visits' ? 'punch' : 'reward';
  $('redeem-name').textContent = data.name;
  $('redeem-item').textContent = data.rewardTitle;
  $('redeem-confirm').disabled = false;

  var chip = document.querySelector('#screen-redeem-confirm .balance-chip');
  if (pendingRedeemKind === 'punch') {
    chip.hidden = true;
    $('redeem-emoji').textContent = '\u{1F39F}\u{FE0F}';
    var need = data.visitsCharged ?? 0;
    var have = data.visitsBalance ?? 0;
    $('redeem-cost').textContent = have > need
      ? (need + ' visits needed · uses all ' + have + ' visits')
      : (need + ' visits will be used');
    $('redeem-confirm').textContent = 'Confirm and use visits';
    show('screen-redeem-confirm');
    return;
  }

  $('redeem-balance').textContent = data.balance;
  chip.hidden = false;
  $('redeem-emoji').textContent = data.emoji || '🎁';
  $('redeem-item').textContent = data.rewardTitle;
  $('redeem-cost').textContent = data.cost + ' pts will be deducted';
  $('redeem-confirm').textContent = 'Confirm and deduct points';
  $('redeem-confirm').disabled = false;
  show('screen-redeem-confirm');
}

async function confirmRedeem() {
  if (busy || !pendingRedeemCode) return;
  var code = pendingRedeemCode;
  var isPunch = pendingRedeemKind === 'punch';
  busy = true;
  $('redeem-confirm').disabled = true;
  try {
    var res = await authFetch('/api/vendor/redeem', {
      method: 'POST',
      body: JSON.stringify({ code: code }),
    });
    var data = await res.json();
    if (handlePinRequired(res, data, function () { submitRedeemCode(code); })) return;
    if (!res.ok) {
      return flood('error', 'CAN’T REDEEM', data.message || 'Code expired or already used.', enterScan);
    }
    var sub = isPunch
      ? ('Visits used · ' + (data.visitsLeft ?? 0) + ' left')
      : ('Points deducted · balance now ' + data.newBalance);
    flood('success', 'GIVE: ' + data.rewardTitle, sub, function () {
      refreshLastActivity();
      enterScan();
    }, 3500);
  } catch (e) {
    flood('error', 'NO CONNECTION', 'Check the internet and try again.', enterScan);
  } finally {
    busy = false;
    pendingRedeemCode = null;
    pendingRedeemKind = 'reward';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[c];
  });
}

/* ---------- flood + activity strip ---------- */

function flood(kind, big, small, after, ms) {
  var el = $('flood');
  var duration = ms ?? (kind === 'success' ? 2500 : 4000);
  el.className = 'flood ' + kind;
  $('flood-icon').textContent = kind === 'success' ? '✓' : '✕';
  $('flood-big').textContent = big;
  $('flood-small').textContent = small || '';
  $('a11y-status').textContent = small ? (big + '. ' + small) : big;

  el.hidden = false;
  void el.offsetWidth;
  el.classList.add('is-visible');

  var fill = $('flood-progress-fill');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  void fill.offsetWidth;
  fill.style.transition = 'width ' + duration + 'ms linear';
  fill.style.width = '0%';

  var closed = false;
  var timer;
  var done = function () {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (after) after();
    el.classList.remove('is-visible');
    setTimeout(function () {
      el.hidden = true;
      $('flood-close').onclick = null;
      el.onclick = null;
    }, 320);
  };
  timer = setTimeout(done, duration);
  $('flood-close').onclick = function (e) { e.stopPropagation(); done(); };
  el.onclick = done;
}

async function refreshLastActivity() {
  try {
    var res = await authFetch('/api/vendor/recent');
    if (!res.ok) return;
    var list = await res.json();
    var last = list && list[0];
    lastActivity = null;
    if (!last) {
      $('last-activity').textContent = 'No activity yet today.';
    } else {
      var who = (last.profiles && last.profiles.name) ?? 'Customer';
      var isReversal = last.reverses != null;
      var isTransfer = last.type === 'community_transfer';
      var createdAt = new Date(last.created_at).getTime();
      var withinWindow = Date.now() - createdAt < UNDO_WINDOW_MS;
      var undoable = !isReversal && !isTransfer && last.reversed_by == null && withinWindow;
      lastActivity = { id: last.id, type: last.type, undoable: undoable, createdAt: createdAt };
      $('last-activity').textContent = isReversal
        ? ('Last: undo · ' + who)
        : isTransfer
          ? ('Last: ' + who + ' moved in +' + last.points + ' community pts')
          : last.type === 'earn'
            ? ('Last: ' + who + ' +' + last.points + ' pts')
            : ('Last: ' + who + ' redeemed ' + ((last.rewards && last.rewards.title) ?? 'a reward'));
    }
    undoLastArmed = false;
    scheduleUndoExpiry();
    renderUndoLast();
  } catch (e) { /* non-critical */ }
}

function scheduleUndoExpiry() {
  clearTimeout(undoExpiryTimer);
  if (!lastActivity || !lastActivity.undoable) return;
  var remaining = lastActivity.createdAt + UNDO_WINDOW_MS - Date.now();
  undoExpiryTimer = setTimeout(function () {
    if (lastActivity) lastActivity.undoable = false;
    undoLastArmed = false;
    renderUndoLast();
  }, Math.max(0, remaining));
}

function renderUndoLast() {
  var canUndo = Boolean(lastActivity && lastActivity.undoable);
  var btn = $('undo-last');
  btn.hidden = !canUndo;
  btn.textContent = undoLastArmed ? 'Tap again to undo' : 'Undo last';
  btn.classList.toggle('is-armed', undoLastArmed);
}

function onUndoLastTap() {
  if (!lastActivity || !lastActivity.undoable) return;
  if (!undoLastArmed) {
    undoLastArmed = true;
    clearTimeout(undoLastTimer);
    undoLastTimer = setTimeout(function () { undoLastArmed = false; renderUndoLast(); }, 4000);
    renderUndoLast();
    return;
  }
  clearTimeout(undoLastTimer);
  undoLastArmed = false;
  renderUndoLast();
  requestUndoLast();
}

function requestUndoLast() {
  var tx = lastActivity;
  if (!tx || !tx.id || !tx.undoable) return;
  requirePin(function () { performReverse(tx.id, null); });
}

async function performReverse(txId, after) {
  if (busy) return;
  busy = true;
  var refresh = function () { refreshLastActivity(); if (after) after(); };
  try {
    var res = await authFetch('/api/vendor/reverse', {
      method: 'POST',
      body: JSON.stringify({ transactionId: txId }),
    });
    var data = await res.json().catch(function () { return {}; });
    if (handlePinRequired(res, data)) return;
    if (!res.ok) {
      return flood('error', 'COULDN’T UNDO', data.message || 'That entry can’t be undone.', refresh);
    }
    if (data.paidWith === 'visits') {
      var n = data.restoredVisits ?? 0;
      flood('success', 'UNDONE', n + (n === 1 ? ' visit' : ' visits') + ' put back', refresh);
    } else {
      var back = data.type === 'redeem' ? 'points refunded' : 'points removed';
      flood('success', 'UNDONE', 'Balance now ' + data.newBalance + ' · ' + back, refresh);
    }
  } catch (e) {
    flood('error', 'NO CONNECTION', 'Check the internet and try again.', refresh);
  } finally {
    busy = false;
  }
}

/* ---------- sign out ---------- */

function openSignOutConfirm() {
  $('signout-confirm').hidden = false;
}

function closeSignOutConfirm() {
  $('signout-confirm').hidden = true;
}

async function signOut() {
  if (busy) return;
  busy = true;
  $('signout-go').disabled = true;
  await signOutAuth();
  busy = false;
  $('signout-go').disabled = false;
  closeSignOutConfirm();
  resetToLogin();
}

/**
 * Forget everything this screen knows about ONE store.
 *
 * Shared by signing out (resetToLogin, below) and by switching stores on the
 * same login (applyStoreSwitch). Every field here is per-vendor either way: a
 * PIN session or a half-finished redemption that survived into another store
 * would belong to the wrong one.
 */
function clearVendorState() {
  config = null;
  pinUnlocked = false;
  pinToken = null;
  pinValue = '';
  pinAction = null;
  currentEarnCode = null;
  currentMultiplier = 1;
  pendingRedeemCode = null;
  pendingRedeemKind = 'reward';
  pendingAward = null;
  padValue = '';
  lastActivity = null;
  undoLastArmed = false;
  clearTimeout(undoLastTimer);
  clearTimeout(undoExpiryTimer);
  renderUndoLast();
}

function resetToLogin() {
  clearVendorState();
  // The account and its stores, which outlive any one store. The REMEMBERED
  // store id in localStorage is keyed by account and deliberately survives: it
  // is this device's answer to "which till is this", not a leftover session.
  accountId = null;
  locations = [];
  vendorId = null;
  storeSwitching = false;
  paintStoreSwitcher();   // back to a plain, disabled, empty name

  $('login-email').value = '';
  $('login-password').value = '';
  $('login-error').hidden = true;
  $('login-success').hidden = true;
  $('recover-email').value = '';
  clearRecoverFields();
  $('recover-error').hidden = true;
  $('recover-success').hidden = true;
  $('shell').hidden = true;
  show('screen-login');
}
