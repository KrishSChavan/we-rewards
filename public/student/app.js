/* PSU Eats Rewards — student app (single-restaurant mode)
   Points bar → your earn code → rewards scroll (placeholders + live vendor
   items) → item detail modal → redemption code modal. */

let sb = null;
let vendor = null;    // the one live restaurant (first from /api/me/balances)
let balance = 0;
let myCodeTimer = null;     // home-screen earn-code refresh loop
let redeemCountdown = null; // redemption-code modal countdown
let selectedItem = null;
let socket = null;          // socket.io connection for live balance pushes
let currentToken = null;    // latest Supabase access token (socket auth)
let balanceReady = false;   // first balance shown yet? (skip the ticker on load)
let tickRaf = 0;            // requestAnimationFrame id for the counting ticker
let toastTimer = null;

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
  $('signout-btn').addEventListener('click', async () => {
    await sb.auth.signOut();
    render(null);
  });
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
  $('landing').hidden = !!session;
  $('app').hidden = !session;
  if (session) {
    loadHome();
    startMyCode();
    connectSocket();
  } else {
    stopMyCode();
    disconnectSocket();
    balanceReady = false;   // re-login should show the balance instantly, no ticker
  }
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

/* ---------- home: points bar + items ---------- */

async function loadHome() {
  try {
    const res = await authFetch('/api/me/balances');
    if (!res.ok) throw new Error();
    const vendors = await res.json();

    // Single-restaurant mode picks one vendor. Stay on the one we're already
    // showing across re-fetches (redeem/close calls loadHome again); on first
    // load prefer a vendor the student actually has points at, so a stray extra
    // active vendor can't strand them on a 0 balance. Multi-vendor = a picker here.
    const prevId = vendor?.vendorId;
    vendor =
      vendors.find((v) => v.vendorId === prevId) ??
      vendors.find((v) => v.balance > 0) ??
      vendors[0] ??
      null;

    $('pb-vendor').textContent = vendor ? vendor.name.toUpperCase() : 'PSU EATS';
    renderItems();
    applyBalance(vendor?.balance ?? 0);   // sets/tickers the number + notifies
  } catch {
    $('items-empty').textContent = 'Couldn’t load rewards. Check your connection and try again.';
    $('items-empty').hidden = false;
  }
}

/* ---------- live balance: socket push + ticker + notification ---------- */

// The server pushes a { vendorId, balance } event the instant a vendor awards
// or redeems, so the meter updates live with no polling. The socket.io client
// is served by our own server at /socket.io/socket.io.js.
function connectSocket() {
  if (!socket) {
    socket = io({ autoConnect: false, auth: (cb) => cb({ token: currentToken }) });
    socket.on('balance', (payload) => {
      if (vendor && payload?.vendorId === vendor.vendorId) applyBalance(payload.balance ?? 0);
    });
    // Catch up on (re)connect in case an update landed while we were offline.
    socket.on('connect', syncBalance);
  }
  if (!socket.connected) socket.connect();
}

function disconnectSocket() {
  if (socket) socket.disconnect();
}

// One-shot balance fetch to re-sync after a (re)connect.
async function syncBalance() {
  if (!vendor) return;
  try {
    const res = await authFetch('/api/me/balances');
    if (!res.ok) return;
    const vendors = await res.json();
    const v = vendors.find((x) => x.vendorId === vendor.vendorId);
    if (v) applyBalance(v.balance ?? 0);
  } catch { /* ignore */ }
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
    loadHome();                        // balance may have changed while open
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
