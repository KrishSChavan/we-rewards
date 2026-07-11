/* WeRewards — vendor terminal client
   Tabs:  AWARD  → type customer's 6-char code → name + balance + $ keypad → award
          REDEEM → PIN → type 4-digit redeem code → confirm (name + points + item) → deduct
          ITEMS  → PIN → manage rewards (add / edit / on-off)
*/

let sb = null;             // supabase client
let config = null;         // vendor config from /api/vendor/config
let rewards = [];          // vendor's rewards from /api/vendor/rewards
let mode = 'award';        // 'award' | 'redeem' | 'manage'
let pinTarget = null;      // where the PIN gate leads on success
let currentEarnCode = null;    // customer's 6-char earn code on the award pad
let currentMultiplier = 1;     // scanned customer's tier multiplier (1x/1.5x/2x)
let pendingRedeemCode = null;  // 4-digit redeem code awaiting vendor confirmation
let padValue = '';         // exact-amount entry string
let pinValue = '';
let pinUnlocked = false;   // set once the PIN is entered correctly; lives in
                           // memory only, so a page refresh always re-asks
let pinToken = null;       // server-side PIN session token from verify-pin, sent
                           // as X-Vendor-Pin on redeem/manage requests
let selectedEmoji = '🎁';  // emoji picked in the item form
let busy = false;          // guards double-taps / double-submits
let idleTimeout = null;
let editingRewardId = null;

const $ = (id) => document.getElementById(id);
const screens = [
  'screen-login', 'screen-scan', 'screen-pad',
  'screen-pin', 'screen-redeem-scan', 'screen-redeem-confirm', 'screen-manage', 'screen-stats',
];

/* ---------- boot ---------- */

(async function boot() {
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
  $('stats-refresh').addEventListener('click', () => loadAnalytics());
  $('pad-cancel').addEventListener('click', () => enterScan());
  $('pad-award').addEventListener('click', awardExact);
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
}

// Land on the screen for a PIN-gated mode once it's unlocked.
function enterModeScreen(m) {
  if (m === 'manage') enterManage();
  else if (m === 'stats') enterStats();
  else enterRedeemScan();
}

function switchMode(next) {
  if (mode === next) return;
  pinValue = '';

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

// Earn codes are 6-char A–Z0–9; redeem codes are 4 digits. Normalize as the
// vendor types so the field only ever holds valid characters.
function normalizeEarn(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
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
    return flood('error', 'ENTER 6 CHARACTERS', 'The customer’s code is 6 letters/numbers.', enterScan);
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

async function awardExact() {
  if (busy || !currentEarnCode) return;
  busy = true;
  try {
    const res = await authFetch('/api/vendor/award', {
      method: 'POST',
      body: JSON.stringify({ code: currentEarnCode, exactAmount: Number(padValue) }),
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
      enterModeScreen(pinTarget);
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
    if (!last) return ($('last-activity').textContent = 'No activity yet today.');
    const who = last.profiles?.name ?? 'Customer';
    $('last-activity').textContent =
      last.type === 'earn'
        ? `Last: ${who} +${last.points} pts`
        : `Last: ${who} redeemed ${last.rewards?.title ?? 'a reward'}`;
  } catch { /* non-critical */ }
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
