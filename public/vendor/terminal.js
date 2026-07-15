/* WeRewards — vendor terminal client
   Tabs:  AWARD  → type customer's 6-digit code → name + balance + $ keypad → award
          REDEEM → PIN → type 4-digit redeem code → confirm (name + points + item) → deduct
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
let lastActivity = null;   // most recent transaction (for the "Undo last" button)
let undoLastArmed = false; // two-tap confirm state for "Undo last"
let undoLastTimer = null;
let undoExpiryTimer = null; // hides "Undo last" when the 1-min window elapses

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
  'screen-login', 'screen-scan', 'screen-pad',
  'screen-pin', 'screen-redeem-scan', 'screen-redeem-confirm', 'screen-manage', 'screen-stats',
  'screen-settings',
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
  $('tab-award').addEventListener('click', () => switchMode('award'));
  $('tab-redeem').addEventListener('click', () => switchMode('redeem'));
  $('tab-manage').addEventListener('click', () => switchMode('manage'));
  $('tab-stats').addEventListener('click', () => switchMode('stats'));
  $('tab-settings').addEventListener('click', () => switchMode('settings'));
  $('stats-refresh').addEventListener('click', () => loadAnalytics());
  $('settings-save').addEventListener('click', saveSettings);
  $('settings-reset').addEventListener('click', () => renderSettings(loadedSettings));
  $('tier-add').addEventListener('click', () => addTierRow());
  $('set-ratio').addEventListener('input', updateRatioExample);
  $('set-exact').addEventListener('click', () => toggleSwitch($('set-exact')));
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

async function enterApp() {
  const res = await authFetch('/api/vendor/config');
  if (!res.ok) {
    await sb.auth.signOut();
    $('login-error').textContent = 'This account is not linked to a vendor.';
    $('login-error').hidden = false;
    show('screen-login');
    return;
  }
  config = await res.json();
  $('vendor-name').textContent = config.name;
  $('shell').hidden = false;
  $('screen-login').hidden = true;
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
    // gated fetches only fire from redeem/manage/stats, so `mode` is the target
    pinTarget = mode === 'award' ? 'redeem' : mode;
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
}

function setTabs(active) {
  $('tab-award').classList.toggle('is-active', active === 'award');
  $('tab-redeem').classList.toggle('is-active', active === 'redeem');
  $('tab-manage').classList.toggle('is-active', active === 'manage');
  $('tab-stats').classList.toggle('is-active', active === 'stats');
  $('tab-settings').classList.toggle('is-active', active === 'settings');
}

// Land on the screen for a PIN-gated mode once it's unlocked.
function enterModeScreen(m) {
  if (m === 'manage') enterManage();
  else if (m === 'stats') enterStats();
  else if (m === 'settings') enterSettings();
  else enterRedeemScan();
}

function switchMode(next) {
  if (mode === next) return;
  pinValue = '';
  pinAction = null;   // a tab switch cancels any deferred PIN action (e.g. undo)

  if (next === 'award') {
    mode = 'award';
    setTabs('award');
    enterScan();
    return;
  }

  // redeem, manage, and stats are behind the PIN — but only once per page
  // session. pinUnlocked is a plain in-memory flag, so refreshing re-asks.
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

/* ---------- AWARD flow: scan → name + balance + $ keypad ---------- */

function enterScan() {
  currentEarnCode = null;
  currentMultiplier = 1;
  show('screen-scan');
  const input = $('earn-code-input');
  input.value = '';
  input.focus();
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
    if ((dec?.length ?? 0) <= 2 && Number(next) <= 500) padValue = next;
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
  try {
    const res = await authFetch('/api/vendor/award', {
      method: 'POST',
      body: JSON.stringify({ code: currentEarnCode, exactAmount: amt }),
    });
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
      if (pinAction) { const fn = pinAction; pinAction = null; fn(); } // deferred action (e.g. undo)
      else enterModeScreen(pinTarget);
    } else {
      $('pin-error').hidden = false;
    }
  }
}

function enterRedeemScan() {
  pendingRedeemCode = null;
  show('screen-redeem-scan');
  const input = $('redeem-code-input');
  input.value = '';
  input.focus();
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
    pendingRedeemCode = code;
    $('redeem-name').textContent = data.name;
    $('redeem-balance').textContent = data.balance;
    $('redeem-emoji').textContent = data.emoji || '🎁';
    $('redeem-item').textContent = data.rewardTitle;
    $('redeem-cost').textContent = `${data.cost} pts will be deducted`;
    $('redeem-confirm').disabled = false;
    show('screen-redeem-confirm');
  } catch {
    flood('error', 'NO CONNECTION', 'Check the internet and try again.', enterRedeemScan);
  } finally {
    busy = false;
  }
}

async function confirmRedeem() {
  if (busy || !pendingRedeemCode) return;
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
    flood('success', `GIVE: ${data.rewardTitle}`, `Points deducted · balance now ${data.newBalance}`, () => {
      refreshLastActivity();
      enterRedeemScan();
    }, 3500);
  } catch {
    flood('error', 'NO CONNECTION', 'Check the internet and try again.', enterRedeemScan);
  } finally {
    busy = false;
    pendingRedeemCode = null;
  }
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
    list.innerHTML = `<p class="reward-list-empty">No items yet — add your first one.</p>`;
    return;
  }
  rewards.forEach((r) => {
    const row = document.createElement('div');
    row.className = `reward-row${r.active ? '' : ' is-off'}`;

    const info = document.createElement('button');
    info.className = 'reward-info';
    info.innerHTML = `
      <span class="reward-emoji">${escapeHtml(r.emoji || '🎁')}</span><span class="redeem-title">${escapeHtml(r.title)}</span>
      <span class="redeem-cost">${r.cost_in_points} pts · about $${(r.cost_in_points / config.pointsPerDollar).toFixed(2)} of purchases</span>`;
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
  $('reward-form-title').textContent = reward ? 'Edit item' : 'Add item';
  $('reward-title').value = reward?.title ?? '';
  $('reward-cost').value = reward?.cost_in_points ?? '';
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
}

async function saveReward() {
  const title = $('reward-title').value.trim();
  const cost = Number($('reward-cost').value);
  $('reward-form-error').hidden = true;

  const res = await authFetch(
    editingRewardId ? `/api/vendor/rewards/${editingRewardId}` : '/api/vendor/rewards',
    {
      method: editingRewardId ? 'PATCH' : 'POST',
      body: JSON.stringify({ title, costInPoints: cost, emoji: selectedEmoji }),
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
      const createdAt = new Date(last.created_at).getTime();
      const withinWindow = Date.now() - createdAt < UNDO_WINDOW_MS;
      const undoable = !isReversal && last.reversed_by == null && withinWindow;
      lastActivity = { id: last.id, type: last.type, undoable, createdAt };
      $('last-activity').textContent = isReversal
        ? `Last: undo · ${who}`
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
    const who = tx.profiles?.name ?? 'Customer';
    const isReversal = tx.reverses != null;         // this row is itself an undo
    const alreadyVoided = tx.reversed_by != null;   // this row was already undone
    const time = new Date(tx.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    // Signed points: earns are +, redeems and corrections carry their own sign.
    const pts = tx.points > 0 ? `+${tx.points}` : `${tx.points}`;
    const what = earn
      ? (isReversal ? `Correction · ${who}` : `Award · ${who}`)
      : (isReversal ? `Refund · ${who}` : `Redeem · ${who}${tx.rewards?.title ? ` · ${tx.rewards.title}` : ''}`);

    const row = document.createElement('div');
    row.className = `recent-row${alreadyVoided ? ' is-voided' : ''}`;

    const info = document.createElement('div');
    info.className = 'recent-info';
    info.innerHTML = `<span class="recent-what">${escapeHtml(what)}</span><span class="recent-meta">${escapeHtml(pts)} pts · ${escapeHtml(time)}</span>`;
    row.appendChild(info);

    // Undoable = a real award/redeem, not voided, not itself a correction, and
    // still inside the 1-minute window (the server enforces the window too).
    const inWindow = Date.now() - new Date(tx.created_at).getTime() < UNDO_WINDOW_MS;
    if (!isReversal && !alreadyVoided && inWindow) {
      const btn = document.createElement('button');
      btn.className = 'recent-undo';
      btn.textContent = undoArmedId === tx.id ? 'Tap again to undo' : 'Undo';
      if (undoArmedId === tx.id) btn.classList.add('is-armed');
      btn.addEventListener('click', () => onUndoTap(tx.id));
      row.appendChild(btn);
    } else if (isReversal || alreadyVoided) {
      const tag = document.createElement('span');
      tag.className = 'recent-tag';
      tag.textContent = alreadyVoided ? 'Undone' : (earn ? 'Correction' : 'Refund');
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
    const back = data.type === 'redeem' ? 'points refunded' : 'points removed';
    flood('success', 'UNDONE', `Balance now ${data.newBalance} · ${back}`, refresh);
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
  $('set-pin').value = '';
  $('settings-error').hidden = true;
  renderTierEditor(s.tiers ?? []);
  updateRatioExample();
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
  $('set-ratio-eg').textContent = Number.isFinite(r) && r > 0 ? `${Math.floor(10 * r)} pts` : '—';
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
    <input class="tier-amount" type="number" inputmode="decimal" min="0" step="0.5" placeholder="amount" />
    <button class="tier-remove" type="button" aria-label="Remove button">✕</button>`;
  const amt = tierAmount(t);
  row.querySelector('.tier-label').value = t.label ?? '';
  row.querySelector('.tier-amount').value = Number.isFinite(amt) ? amt : '';
  row.querySelector('.tier-remove').addEventListener('click', () => row.remove());
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

async function saveSettings() {
  if (busy) return;
  $('settings-error').hidden = true;

  const body = {
    pointsPerDollar: Number($('set-ratio').value),
    allowExactEntry: switchOn($('set-exact')),
    tiers: collectTiers(),
  };
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
    // Refresh the cached vendor config so the award pad + PIN gating pick up the
    // new ratio / exact-entry / PIN state immediately.
    const cfg = await authFetch('/api/vendor/config');
    if (cfg.ok) config = await cfg.json();

    if (data.pinChanged) {
      // The server dropped every session (incl. ours). Re-gate so the terminal
      // re-asks for the new PIN before any further sensitive action.
      pinUnlocked = false;
      pinToken = null;
      flood('success', 'SETTINGS SAVED', 'New PIN set — re-enter it to continue.', () => switchMode('award'));
    } else {
      flood('success', 'SETTINGS SAVED', 'Your changes are live.', () => renderSettings(loadedSettings));
    }
  } catch {
    $('settings-error').textContent = 'No connection — try again.';
    $('settings-error').hidden = false;
  } finally {
    busy = false;
    $('settings-save').disabled = false;
  }
}
