/* WeRewards — operator admin dashboard.
   Google sign-in (must match an ADMIN_EMAILS entry, enforced server-side) →
   platform analytics (/api/admin/overview) + the error log (/api/admin/errors),
   which aggregates server 500s and client-reported crashes from both apps. */

let sb = null;
let errorSource = '';   // '' = all sources; else server|student|vendor|admin
let vendors = [];       // full roster (active + inactive) for the on/off panel
let applications = [];  // pending vendor applications (the Applications tab)
let vapidKey = null;    // server's public VAPID key; null = push disabled
let pushInitDone = false;

const $ = (id) => document.getElementById(id);

/* ---------- boot ---------- */

(async function boot() {
  const pub = await (await fetch('/api/public-config')).json();
  // Distinct storage key so signing into the admin dash never collides with a
  // student or vendor session on the same device.
  sb = window.supabase.createClient(pub.supabaseUrl, pub.supabaseAnonKey, {
    auth: { storageKey: 'psu-admin-auth' },
  });

  $('login-btn').addEventListener('click', signIn);
  $('signout-btn').addEventListener('click', signOut);
  $('refresh-btn').addEventListener('click', loadAll);
  $('clear-errors-btn').addEventListener('click', clearErrors);
  $('tab-dashboard').addEventListener('click', () => setView('dashboard'));
  $('tab-applications').addEventListener('click', () => setView('applications'));
  $('push-btn').addEventListener('click', enablePush);
  document.querySelectorAll('.err-filter').forEach((b) =>
    b.addEventListener('click', () => setErrorSource(b.dataset.src)));

  installErrorReporter();

  sb.auth.onAuthStateChange((_e, session) => render(session));
  const { data } = await sb.auth.getSession();
  render(data?.session ?? null);

  // Register the PWA service worker (scope /admin/) so the dashboard is
  // installable to a home screen and its shell works offline. Best-effort.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/admin/sw.js').catch(() => {});
  }
})();

async function signIn() {
  $('login-error').hidden = true;
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + '/admin',
      // Always show Google's account chooser so someone bounced for using the
      // wrong email can pick a different one instead of being re-logged silently.
      queryParams: { prompt: 'select_account' },
    },
  });
  if (error) {
    $('login-error').textContent = 'Couldn’t start sign-in. Try again.';
    $('login-error').hidden = false;
  }
}

async function signOut() {
  await sb.auth.signOut();
  render(null);
}

// Panels are mutually exclusive: exactly one of #login / #dash is ever visible.
// Being signed in is NOT proof of admin access — that's decided server-side — so
// we keep the dashboard hidden until /api/admin/overview returns 200. A
// non-approved account is bounced back to the login screen by denyAccess().
function render(session) {
  if (!session) {
    $('dash').hidden = true;
    $('login').hidden = false;
    return;
  }
  $('login').hidden = true;
  $('dash').hidden = true; // stays hidden until the server confirms admin access
  $('admin-email').textContent = session.user?.email ?? '';
  loadAll();
}

// Valid Google login, but the email isn't on the server's ADMIN_EMAILS list.
// Sign them out and return to the login screen with a clear red message —
// no separate "denied" card. The gate itself is server-side (requireAdmin); this
// is only the UI reaction to the 403.
async function denyAccess() {
  await sb.auth.signOut();
  $('dash').hidden = true;
  $('login').hidden = false;
  const el = $('login-error');
  el.textContent = 'This email isn’t approved for admin access. Try another account.';
  el.hidden = false;
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

/* ---------- data load ---------- */

async function loadAll() {
  // Overview is the access check: only load the rest once it confirms admin.
  const ok = await loadOverview();
  if (ok) {
    await Promise.all([loadVendors(), loadErrors(), loadApplications()]);
    initPush();   // best-effort, runs once — after admin access is confirmed
  }
}

/* ---------- view tabs ---------- */

// Two mutually exclusive views under one topbar; `hidden` is the source of
// truth (same convention as the #login/#dash panels).
function setView(view) {
  const apps = view === 'applications';
  $('view-dashboard').hidden = apps;
  $('view-applications').hidden = !apps;
  $('tab-dashboard').classList.toggle('is-active', !apps);
  $('tab-applications').classList.toggle('is-active', apps);
}

async function loadOverview() {
  const res = await authFetch('/api/admin/overview');
  if (res.status === 403) { await denyAccess(); return false; }
  if (!res.ok) return false;
  $('dash').hidden = false; // confirmed admin → reveal the dashboard
  renderOverview(await res.json());
  return true;
}

const money = (n) => '$' + (Number(n) || 0).toFixed(2);
const num = (n) => (Number(n) || 0).toLocaleString();

function renderOverview(d) {
  // top-line lifetime totals
  $('tot-vendors').textContent = num(d.totals?.vendors);
  $('tot-students').textContent = num(d.totals?.students);
  $('tot-transactions').textContent = num(d.totals?.transactions);
  renderErrorCard(d.errors ?? {});

  // today
  $('td-revenue').textContent = money(d.today?.revenue);
  $('td-awards').textContent = num(d.today?.awards);
  $('td-redemptions').textContent = num(d.today?.redemptions);
  $('td-customers').textContent = num(d.today?.activeStudents);

  buildChart(d.daily ?? []);
  fillWindow('win-7', d.last7 ?? {});
  fillWindow('win-30', d.last30 ?? {});
  renderTopVendors(d.topVendors ?? []);
}

// The top "Errors · 24h" tile: 24h count, all-time subtotal, and a red alert
// border when there's anything in the last 24h. Split out so a log deletion can
// refresh just this tile (via refreshErrorCard) without rebuilding the dashboard.
function renderErrorCard(errors) {
  const err24 = errors?.last24h ?? 0;
  $('tot-errors').textContent = num(err24);
  $('tot-errors-card').classList.toggle('is-alert', err24 > 0);
  $('tot-errors-sub').textContent = `${num(errors?.total)} all-time`;
}

// Re-pull the error counts after a delete so the top tile stays in sync with the
// log below it. Overview is the source of truth for the counts (server-side
// count queries); we render only its `errors` block and leave the rest untouched.
async function refreshErrorCard() {
  try {
    const res = await authFetch('/api/admin/overview');
    if (!res.ok) return;
    const d = await res.json();
    renderErrorCard(d.errors ?? {});
  } catch { /* non-fatal — the tile just keeps its last value until next refresh */ }
}

function fillWindow(id, b) {
  const rows = [
    ['Revenue', money(b.revenue)],
    ['Points awarded', num(b.pointsAwarded)],
    ['Points redeemed', num(b.pointsRedeemed)],
    ['Awards', num(b.awards)],
    ['Redemptions', num(b.redemptions)],
    ['Active students', num(b.activeStudents)],
    ['New students', num(b.newStudents)],
  ];
  if (b.newVendors != null) rows.push(['New vendors', num(b.newVendors)]);
  $(id).innerHTML = rows.map(([k, v]) => `<li><span>${k}</span><strong>${v}</strong></li>`).join('');
}

function renderTopVendors(list) {
  const wrap = $('top-vendors');
  if (!list.length) {
    wrap.innerHTML = `<p class="muted">No revenue in the last 30 days.</p>`;
    return;
  }
  const max = Math.max(...list.map((v) => v.revenue), 1);
  wrap.innerHTML = list.map((v) => `
    <div class="topv-row">
      <span class="topv-name">${escapeHtml(v.name)}</span>
      <span class="topv-bar-wrap"><span class="topv-bar" style="width:${Math.round((v.revenue / max) * 100)}%"></span></span>
      <span class="topv-val">${money(v.revenue)}</span>
    </div>`).join('');
}

/* ---------- vendor on/off control ---------- */

async function loadVendors() {
  const res = await authFetch('/api/admin/vendors');
  if (res.status === 403) return denyAccess(); // safety net; overview already gates
  if (!res.ok) return;
  vendors = await res.json();
  renderVendors();
}

function vendorCountText() {
  const live = vendors.filter((v) => v.active).length;
  return `${live} on · ${vendors.length - live} off`;
}

// Apply a vendor's on/off state to its existing row + toggle. Updating in place
// (rather than rebuilding the list) keeps keyboard focus on the switch the
// operator just activated and lets the aria-checked change be announced there.
function paintVendorRow(row, toggle, v) {
  toggle.classList.toggle('is-on', v.active);
  toggle.setAttribute('aria-checked', v.active ? 'true' : 'false');
  const label = toggle.querySelector('.vt-label');
  if (label) label.textContent = v.active ? 'ON' : 'OFF';
  row.classList.toggle('is-off', !v.active);
}

function showVendorError() {
  const el = $('vendor-error');
  el.textContent = 'Couldn’t complete that action. Check your connection and try again.';
  el.hidden = false;
}

function renderVendors() {
  const wrap = $('vendor-list');
  const countEl = $('vendors-count');
  $('vendor-error').hidden = true;
  if (!vendors.length) {
    countEl.textContent = '';
    wrap.innerHTML = `<p class="muted">No vendors yet.</p>`;
    return;
  }
  countEl.textContent = vendorCountText();

  wrap.innerHTML = '';
  vendors.forEach((v) => {
    const row = document.createElement('div');
    row.className = 'vendor-row';

    const top = document.createElement('div');
    top.className = 'vendor-top';

    const info = document.createElement('div');
    info.className = 'vendor-info';
    info.innerHTML =
      `<span class="vendor-name">${escapeHtml(v.name)}</span>` +
      `<span class="vendor-meta">${escapeHtml(v.slug)} · ${num(v.points_per_dollar)} pts/$</span>`;

    // role=switch with the vendor name as its accessible name; aria-checked
    // carries the on/off state (SR reads e.g. "Local Eats, switch, on").
    const toggle = document.createElement('button');
    toggle.className = 'vendor-toggle';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', v.name);
    toggle.innerHTML = `<span class="vt-track"><span class="vt-knob"></span></span><span class="vt-label"></span>`;
    paintVendorRow(row, toggle, v);
    toggle.addEventListener('click', () => toggleVendor(v, toggle, row));

    // Permanent delete — the irreversible counterpart to the on/off switch.
    const del = document.createElement('button');
    del.className = 'vendor-delete';
    del.type = 'button';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', `Delete ${v.name}`);
    del.addEventListener('click', () => deleteVendor(v, del, row));

    const actions = document.createElement('div');
    actions.className = 'vendor-actions';
    actions.append(toggle, del);

    top.append(info, actions);

    // Address editor: sets the street address shown as a tappable map on the
    // student card. Saving geocodes it server-side; the note shows the result.
    const addr = document.createElement('div');
    addr.className = 'vendor-addr';
    const input = document.createElement('input');
    input.className = 'vendor-addr-input';
    input.type = 'text';
    input.maxLength = 300;
    input.placeholder = 'Street address (optional) — shown as a map';
    input.value = v.address || '';
    const save = document.createElement('button');
    save.className = 'vendor-addr-save';
    save.type = 'button';
    save.textContent = 'Save';
    const note = document.createElement('span');
    note.className = 'vendor-addr-note';
    setAddrNote(note, v);
    save.addEventListener('click', () => saveVendorAddress(v, input, save, note));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveVendorAddress(v, input, save, note); });
    addr.append(input, save, note);

    row.append(top, addr);
    wrap.appendChild(row);
  });
}

// Reflect whether the saved address resolved to map coordinates.
function setAddrNote(note, v) {
  note.classList.remove('is-err', 'is-ok');
  if (!v.address) { note.textContent = ''; return; }
  if (v.latitude != null && v.longitude != null) {
    note.textContent = '📍 on map';
    note.classList.add('is-ok');
  } else {
    note.textContent = "couldn’t locate";
    note.classList.add('is-err');
  }
}

async function saveVendorAddress(v, input, save, note) {
  const address = input.value.trim();
  save.disabled = true;
  note.classList.remove('is-err', 'is-ok');
  note.textContent = 'Saving…';
  try {
    const res = await authFetch(`/api/admin/vendors/${v.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ address }),
    });
    if (res.status === 403) return denyAccess();
    if (!res.ok) {
      note.textContent = 'Save failed';
      note.classList.add('is-err');
      save.disabled = false;
      return;
    }
    const updated = await res.json();
    Object.assign(v, updated);   // keep the in-memory roster in sync
    input.value = v.address || '';
    setAddrNote(note, v);
    save.disabled = false;
  } catch {
    note.textContent = 'No connection';
    note.classList.add('is-err');
    save.disabled = false;
  }
}

async function toggleVendor(v, toggle, row) {
  const turningOff = v.active;
  // Turning a vendor off is disruptive (it cuts the live terminal off and hides
  // the vendor from students), so confirm that direction. Turning back on is
  // harmless, so it's one tap. Nothing is destroyed either way.
  if (turningOff && !confirm(
    `Turn OFF “${v.name}”?\n\nIts terminal will stop working and it disappears from the student app immediately. Points and history are kept — you can turn it back on anytime.`
  )) return;

  $('vendor-error').hidden = true;
  toggle.disabled = true;
  try {
    const res = await authFetch(`/api/admin/vendors/${v.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: !v.active }),
    });
    if (res.status === 403) return denyAccess();
    if (!res.ok) { showVendorError(); toggle.disabled = false; return; }
    const updated = await res.json();
    // `v` is the live array element, so mutating it updates our in-memory roster
    // too. Repaint just this row and refresh the count — focus stays on the switch.
    Object.assign(v, updated);
    paintVendorRow(row, toggle, v);
    $('vendors-count').textContent = vendorCountText();
    toggle.disabled = false;
  } catch {
    showVendorError();
    toggle.disabled = false;
  }
}

// Permanently delete a vendor. Unlike the toggle (reversible, non-destructive),
// this wipes the vendor and everything it owns and CANNOT be undone — so it's
// gated behind an explicit confirm that spells out what's removed vs. kept.
async function deleteVendor(v, btn, row) {
  if (!confirm(
    `Permanently DELETE “${v.name}”?\n\n` +
    `This removes the vendor and all its data — logo, rewards, point balances, ` +
    `and its login account — and CANNOT be undone. Past transactions are kept ` +
    `but show as “Vendor” in student history.\n\n` +
    `To just take it offline instead, use the ON/OFF switch.`
  )) return;

  $('vendor-error').hidden = true;
  btn.disabled = true;
  try {
    const res = await authFetch(`/api/admin/vendors/${v.id}`, { method: 'DELETE' });
    if (res.status === 403) return denyAccess();
    if (!res.ok) { showVendorError(); btn.disabled = false; return; }
    // Drop it from the in-memory roster and the DOM, then refresh the count. If
    // that was the last vendor, re-render to show the "No vendors yet." state.
    vendors = vendors.filter((x) => x.id !== v.id);
    row.remove();
    if (!vendors.length) renderVendors();
    else $('vendors-count').textContent = vendorCountText();
  } catch {
    showVendorError();
    btn.disabled = false;
  }
}

// Single-series revenue bars for the last 14 days (mirrors the vendor terminal).
function buildChart(daily) {
  const wrap = $('chart');
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
    col.innerHTML =
      `<span class="chart-bar-wrap"><span class="chart-bar${rev > 0 ? '' : ' zero'}" style="height:${h}%"></span></span>` +
      `<span class="chart-tick">${showTick ? tickLabel(x.date) : ''}</span>`;
    col.querySelector('.chart-bar').title = `${x.date}: ${money(rev)} · ${num(x.awards)} awards`;
    wrap.appendChild(col);
  });
}

const tickLabel = (iso) => { const [, m, d] = String(iso).split('-'); return `${Number(m)}/${Number(d)}`; };

/* ---------- vendor applications ---------- */

async function loadApplications() {
  const res = await authFetch('/api/admin/applications');
  if (res.status === 403) return denyAccess(); // safety net; overview already gates
  if (!res.ok) return;
  applications = await res.json();
  renderApplications();
}

// The red bubble on the Applications tab: pending count, hidden at zero.
function updateAppsBadge() {
  const badge = $('apps-badge');
  badge.textContent = applications.length > 99 ? '99+' : String(applications.length);
  badge.hidden = applications.length === 0;
  $('apps-count').textContent = applications.length
    ? `${applications.length} pending` : '';
}

function showAppsError(msg) {
  const el = $('apps-error');
  el.textContent = msg || 'Couldn’t complete that action. Check your connection and try again.';
  el.hidden = false;
}

// Applicant fields are untrusted text → built with DOM APIs / textContent only
// (same rule as renderVendors). The logo is server-validated, but the data:image
// check here keeps a bad row from ever becoming a live URL.
function renderApplications() {
  updateAppsBadge();
  const wrap = $('app-list');
  $('apps-error').hidden = true;
  wrap.innerHTML = '';
  if (!applications.length) {
    wrap.innerHTML = `<p class="muted">No pending applications. Share <strong>/join</strong> with prospective vendors.</p>`;
    return;
  }

  applications.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'app-row';

    const top = document.createElement('div');
    top.className = 'app-top';

    let logo;
    if (a.logo && /^data:image\//.test(a.logo)) {
      logo = document.createElement('img');
      logo.className = 'app-logo';
      logo.alt = '';
      logo.src = a.logo;
    } else {
      logo = document.createElement('span');
      logo.className = 'app-logo is-empty';
      logo.textContent = (a.business_name || '?').charAt(0).toUpperCase();
    }

    const info = document.createElement('div');
    info.className = 'app-info';
    const name = document.createElement('span');
    name.className = 'app-name';
    name.textContent = a.business_name;
    const contact = document.createElement('span');
    contact.className = 'app-meta';
    contact.textContent = `${a.contact_name} · ${a.phone}`;
    const email = document.createElement('span');
    email.className = 'app-meta';
    const mail = document.createElement('a');
    mail.href = `mailto:${a.email}`;
    mail.textContent = a.email;
    email.appendChild(mail);
    info.append(name, contact, email);
    if (a.address) {
      const addr = document.createElement('span');
      addr.className = 'app-meta';
      addr.textContent = a.address;
      info.appendChild(addr);
    }

    const when = document.createElement('span');
    when.className = 'app-when';
    when.textContent = new Date(a.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

    top.append(logo, info, when);
    row.appendChild(top);

    if (a.message) {
      const msg = document.createElement('p');
      msg.className = 'app-message';
      msg.textContent = a.message;
      row.appendChild(msg);
    }

    const actions = document.createElement('div');
    actions.className = 'app-actions';
    const err = document.createElement('span');
    err.className = 'app-error';
    err.hidden = true;
    const accept = document.createElement('button');
    accept.className = 'app-accept';
    accept.type = 'button';
    accept.textContent = 'Accept';
    accept.setAttribute('aria-label', `Accept ${a.business_name}`);
    const reject = document.createElement('button');
    reject.className = 'app-reject';
    reject.type = 'button';
    reject.textContent = 'Reject';
    reject.setAttribute('aria-label', `Reject ${a.business_name}`);
    accept.addEventListener('click', () => acceptApplication(a, row, accept, reject, err));
    reject.addEventListener('click', () => rejectApplication(a, row, accept, reject, err));
    actions.append(err, accept, reject);
    row.appendChild(actions);

    wrap.appendChild(row);
  });
}

// Drop one application from the in-memory list + DOM, keeping badge/count and
// the empty state in sync.
function removeApplicationRow(a, row) {
  applications = applications.filter((x) => x.id !== a.id);
  row.remove();
  updateAppsBadge();
  if (!applications.length) renderApplications();
}

// Accept = onboard now: the server creates the login (from the password chosen
// when applying), the vendor row, and the staff link, then deletes the application.
async function acceptApplication(a, row, accept, reject, err) {
  if (!confirm(
    `Accept “${a.business_name}”?\n\nThis creates the vendor immediately — they can sign in to the terminal right away with the email and password from their application.`
  )) return;

  err.hidden = true;
  accept.disabled = true;
  reject.disabled = true;
  try {
    const res = await authFetch(`/api/admin/applications/${a.id}/accept`, { method: 'POST' });
    if (res.status === 403) return denyAccess();
    if (!res.ok) {
      let msg = 'Accept failed — try again.';
      try { msg = (await res.json())?.message || msg; } catch { /* keep generic */ }
      // 404 = another admin (or a double-click) already handled it — reload the list.
      if (res.status === 404) { removeApplicationRow(a, row); return; }
      err.textContent = msg;
      err.hidden = false;
      accept.disabled = false;
      reject.disabled = false;
      return;
    }
    removeApplicationRow(a, row);
    // The new vendor should show up in the roster + totals without a manual refresh.
    loadVendors();
    loadOverview();
  } catch {
    err.textContent = 'No connection — try again.';
    err.hidden = false;
    accept.disabled = false;
    reject.disabled = false;
  }
}

// Reject = permanent delete of the application (nothing else was ever created).
async function rejectApplication(a, row, accept, reject, err) {
  if (!confirm(
    `Reject the application from “${a.business_name}”?\n\nThis permanently deletes it — including their contact info and chosen password. They can always apply again.`
  )) return;

  err.hidden = true;
  accept.disabled = true;
  reject.disabled = true;
  try {
    const res = await authFetch(`/api/admin/applications/${a.id}`, { method: 'DELETE' });
    if (res.status === 403) return denyAccess();
    if (!res.ok && res.status !== 404) {
      err.textContent = 'Reject failed — try again.';
      err.hidden = false;
      accept.disabled = false;
      reject.disabled = false;
      return;
    }
    removeApplicationRow(a, row);
  } catch {
    err.textContent = 'No connection — try again.';
    err.hidden = false;
    accept.disabled = false;
    reject.disabled = false;
  }
}

/* ---------- web-push: new-application alerts ---------- */

// Runs once per page load, after admin access is confirmed. If notifications
// are already granted, silently (re-)subscribe — the server upserts, so
// repeating this every load just keeps the subscription fresh. If permission
// was never asked, reveal the 🔔 button: requestPermission() must run from a
// user gesture (Safari enforces this). If denied, stay out of the way.
async function initPush() {
  if (pushInitDone) return;
  pushInitDone = true;
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    const res = await authFetch('/api/admin/push/public-key');
    if (!res.ok) return;
    vapidKey = (await res.json())?.publicKey ?? null;
    if (!vapidKey) return;   // server has no VAPID keys → push disabled
    if (Notification.permission === 'granted') await subscribePush();
    else if (Notification.permission === 'default') $('push-btn').hidden = false;
  } catch { /* push is a nice-to-have — never let it break the dashboard */ }
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { $('push-btn').hidden = true; return; }
    await subscribePush();
    $('push-btn').hidden = true;
  } catch { $('push-btn').hidden = true; }
}

async function subscribePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey),
  });
  const { endpoint, keys } = sub.toJSON();
  await authFetch('/api/admin/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint, keys }),
  });
}

// Standard VAPID key decoder: base64url → the Uint8Array PushManager expects.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/* ---------- error log ---------- */

function setErrorSource(src) {
  errorSource = src || '';
  document.querySelectorAll('.err-filter').forEach((b) =>
    b.classList.toggle('is-active', (b.dataset.src || '') === errorSource));
  loadErrors();
}

async function loadErrors() {
  const q = errorSource ? `?source=${encodeURIComponent(errorSource)}&limit=100` : '?limit=100';
  const res = await authFetch('/api/admin/errors' + q);
  if (res.status === 403) return denyAccess(); // safety net; overview already gates
  if (!res.ok) return;
  renderErrors(await res.json());
}

function renderErrors(items) {
  const wrap = $('error-list');
  if (!items.length) {
    wrap.innerHTML = `<p class="muted">No errors logged${errorSource ? ` for “${errorSource}”` : ''}. 🎉</p>`;
    return;
  }
  wrap.innerHTML = '';
  items.forEach((e) => {
    const when = new Date(e.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const where = e.method ? `${e.method} ${e.path ?? ''}` : (e.path ?? '');
    const details = [
      e.stack ? `STACK\n${e.stack}` : '',
      e.user_id ? `user: ${e.user_id}` : '',
      e.user_agent ? `ua: ${e.user_agent}` : '',
      e.context ? `context: ${JSON.stringify(e.context)}` : '',
    ].filter(Boolean).join('\n\n');

    const row = document.createElement('details');
    row.className = 'err-row';
    row.innerHTML = `
      <summary>
        <span class="err-badge err-${escapeHtml(e.source)}">${escapeHtml(e.source)}</span>
        <span class="err-msg">${escapeHtml(e.message)}</span>
        <span class="err-when">${escapeHtml(when)}</span>
        <button class="err-del" type="button" title="Delete this error" aria-label="Delete this error">×</button>
      </summary>
      <div class="err-detail">
        <p class="err-where">${escapeHtml(where || '—')}${e.status ? ` · ${e.status}` : ''}</p>
        ${details ? `<pre>${escapeHtml(details)}</pre>` : ''}
      </div>`;
    row.querySelector('.err-del').addEventListener('click', (ev) => deleteError(e.id, row, ev));
    wrap.appendChild(row);
  });
}

// Permanently delete one error_logs row. The X lives inside <summary>, so we
// stop the click from toggling the row open/closed. On success we just drop the
// row from the DOM (and repaint the empty state if it was the last one).
async function deleteError(id, row, ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    const res = await authFetch(`/api/admin/errors/${id}`, { method: 'DELETE' });
    if (res.status === 403) return denyAccess();
    if (!res.ok) { btn.disabled = false; return; }
    row.remove();
    refreshErrorCard();                                 // keep the top tile in sync
    if (!$('error-list').children.length) loadErrors(); // re-fetch → "No errors" state
  } catch {
    btn.disabled = false;
  }
}

// Bulk-clear the log. Respects the active source filter: with a filter on, it
// clears just that source (what you're looking at); with "All" selected, it
// wipes the whole log. Confirmed first — unlike the single-row ×, this is bulk.
async function clearErrors() {
  const scope = errorSource ? `all “${errorSource}” errors` : 'ALL errors';
  if (!confirm(`Permanently delete ${scope} from the log? This can’t be undone.`)) return;

  const btn = $('clear-errors-btn');
  btn.disabled = true;
  try {
    const q = errorSource ? `?source=${encodeURIComponent(errorSource)}` : '';
    const res = await authFetch('/api/admin/errors' + q, { method: 'DELETE' });
    if (res.status === 403) return denyAccess();
    if (res.ok) {
      await loadErrors();   // repaint the (now empty) list
      refreshErrorCard();   // keep the top tile in sync
    }
  } finally {
    btn.disabled = false;
  }
}

/* ---------- report this page's own errors ---------- */

function installErrorReporter() {
  const send = (message, stack, context) => {
    authFetch('/api/client-error', {
      method: 'POST',
      body: JSON.stringify({ source: 'admin', message, stack, url: location.pathname, context }),
    }).catch(() => {});
  };
  window.addEventListener('error', (e) =>
    send(e.message || 'error', e.error?.stack, { line: e.lineno, col: e.colno }));
  window.addEventListener('unhandledrejection', (e) =>
    send(String(e.reason?.message || e.reason || 'unhandledrejection'), e.reason?.stack));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
