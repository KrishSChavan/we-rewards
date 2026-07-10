/* PSU Eats Rewards — student app
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

const $ = (id) => document.getElementById(id);

/* ---------- boot ---------- */

(async function boot() {
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
  // bottom nav: slide between Home / History / Account
  $('tabbar').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (btn) setTab(Number(btn.dataset.tab));
  });
  $('vendor-carousel').addEventListener('click', onVendorTap);
  $('tier-info-btn').addEventListener('click', openTierInfo);
  $('tier-info-close').addEventListener('click', closeTierInfo);
  // click on the backdrop (but not the card) closes the popover
  $('tier-info').addEventListener('click', (e) => { if (e.target === $('tier-info')) closeTierInfo(); });
  $('back-btn').addEventListener('click', backToHome);
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
  }
  loadVendors();
  loadTier();
  startMyCode();
  connectSocket();
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

function renderVendors() {
  const wrap = $('vendor-carousel');
  wrap.innerHTML = '';
  wrap.classList.toggle('single', allVendors.length === 1);   // lone vendor → full width
  $('vendors-empty').hidden = allVendors.length > 0;

  allVendors.forEach((v) => {
    const card = document.createElement('button');
    card.className = 'vendor-card';
    card.dataset.id = v.vendorId;
    card.innerHTML = `
      <span class="vc-name">${escapeHtml(v.name)}</span>
      <span class="vc-points"><span class="vc-num">${v.balance ?? 0}</span><small>pts</small></span>`;
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
  if (card) openVendor(card.dataset.id);
}

function openVendor(vendorId) {
  const v = allVendors.find((x) => String(x.vendorId) === String(vendorId));
  if (!v) return;
  vendor = v;
  balanceReady = false;                       // paint the number instantly, no ticker
  $('pb-vendor').textContent = v.name.toUpperCase();
  renderItems();
  applyBalance(v.balance ?? 0);
  $('home').hidden = true;
  $('vendor').hidden = false;
  $('tab-home').scrollTop = 0;                // scroll the tab page, not the window
}

function backToHome() {
  vendor = null;
  balanceReady = false;
  $('vendor').hidden = true;
  $('home').hidden = false;
  loadVendors();                              // refresh card balances on the way back
  $('tab-home').scrollTop = 0;
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
