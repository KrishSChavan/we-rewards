/* WeRewards — operator admin dashboard.
   Google sign-in (must match an ADMIN_EMAILS entry, enforced server-side) →
   platform analytics (/api/admin/overview) + the error log (/api/admin/errors),
   which aggregates server 500s and client-reported crashes from both apps. */

let sb = null;
let errorSource = '';   // '' = all sources; else server|student|vendor|admin
let vendors = [];       // full roster (active + inactive) for the on/off panel

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
  if (ok) await Promise.all([loadVendors(), loadErrors()]);
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
  const err24 = d.errors?.last24h ?? 0;
  $('tot-errors').textContent = num(err24);
  $('tot-errors-card').classList.toggle('is-alert', err24 > 0);
  $('tot-errors-sub').textContent = `${num(d.errors?.total)} all-time`;

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
  el.textContent = 'Couldn’t update that vendor. Check your connection and try again.';
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

    top.append(info, toggle);

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
      </summary>
      <div class="err-detail">
        <p class="err-where">${escapeHtml(where || '—')}${e.status ? ` · ${e.status}` : ''}</p>
        ${details ? `<pre>${escapeHtml(details)}</pre>` : ''}
      </div>`;
    wrap.appendChild(row);
  });
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
