/* WeRewards — operator admin dashboard.
   Google sign-in (must match an ADMIN_EMAILS entry, enforced server-side) →
   platform analytics (/api/admin/overview) + the error log (/api/admin/errors),
   which aggregates server 500s and client-reported crashes from both apps. */

// Tells the boot guard this file parsed and is executing. Keep it the first
// statement. See public/shared/boot-guard.js.
if (window.__wrBooted) window.__wrBooted();

let sb = null;
let errorSource = '';   // '' = all sources; else server|student|vendor|admin
let vendors = [];       // full roster (active + inactive) for the on/off panel
let applications = [];  // pending vendor applications (the Applications tab)
let vapidKey = null;    // server's public VAPID key; null = push disabled
let pushInitDone = false;
const PUSH_DISMISS_KEY = 'wr-admin-push-prompt-dismissed'; // set once "Not now" is tapped

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
  // Popup: "Turn on alerts" runs the SAME enable flow directly on the click so the
  // requestPermission() gesture is preserved; "Not now"/backdrop just dismiss.
  $('push-enable').addEventListener('click', enablePush);
  $('push-dismiss').addEventListener('click', dismissPushModal);
  $('push-modal').addEventListener('click', (e) => {
    if (e.target === $('push-modal')) dismissPushModal();   // backdrop only, not the card
  });
  $('reset-close').addEventListener('click', closeResetModal);
  $('reset-go').addEventListener('click', () => mintResetCode());
  $('reset-copy').addEventListener('click', copyResetCode);
  $('reset-modal').addEventListener('click', (e) => {
    if (e.target === $('reset-modal')) closeResetModal();    // backdrop only, not the card
  });
  $('vendor-edit-close').addEventListener('click', closeVendorModal);
  $('vendor-name-save').addEventListener('click', saveVendorName);
  $('vendor-ratio-save').addEventListener('click', saveVendorRatio);
  $('vendor-reward-add').addEventListener('click', addRewardDraft);
  $('vendor-modal').addEventListener('click', (e) => {
    if (e.target === $('vendor-modal')) closeVendorModal();  // backdrop only, not the card
  });
  $('vendor-add-btn').addEventListener('click', openNewVendorModal);
  $('new-vendor-close').addEventListener('click', closeNewVendorModal);
  $('new-vendor-form').addEventListener('submit', createVendor);
  $('nv-password-show').addEventListener('click', toggleNewVendorPassword);
  $('nv-logo-pick').addEventListener('click', () => $('nv-logo-file').click());
  $('nv-logo-file').addEventListener('change', onNewVendorLogoPick);
  $('nv-logo-remove').addEventListener('click', () => setNewVendorLogo(null));
  $('new-vendor-modal').addEventListener('click', (e) => {
    if (e.target === $('new-vendor-modal')) closeNewVendorModal();  // backdrop only, not the card
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('reset-modal').hidden) closeResetModal();
    if (!$('vendor-modal').hidden) closeVendorModal();
    if (!$('new-vendor-modal').hidden) closeNewVendorModal();
  });
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
    // A sign-out (even from another tab) must not leave any overlay over the
    // login card — closeResetModal also wipes a live reset code out of the DOM,
    // and closeNewVendorModal wipes a half-typed vendor password out of it.
    closePushModal();
    closeResetModal();
    closeVendorModal();
    closeNewVendorModal();
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

// One row's name + meta line, shared by renderVendors and the Edit modal's
// ratio save (which repaints the meta in place so the roster shows the new rate).
const vendorInfoHtml = (v) =>
  `<span class="vendor-name">${escapeHtml(v.name)}</span>` +
  `<span class="vendor-meta">${escapeHtml(v.slug)} · ${num(v.points_per_dollar)} pts/$</span>`;

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
    info.innerHTML = vendorInfoHtml(v);

    // role=switch with the vendor name as its accessible name; aria-checked
    // carries the on/off state (SR reads e.g. "Local Eats, switch, on").
    const toggle = document.createElement('button');
    toggle.className = 'vendor-toggle';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', v.name);
    toggle.innerHTML = `<span class="vt-track"><span class="vt-knob"></span></span><span class="vt-label"></span>`;
    paintVendorRow(row, toggle, v);
    toggle.addEventListener('click', () => toggleVendor(v, toggle, row));

    // Drill into the pricing editor: points-per-dollar + reward items.
    const edit = document.createElement('button');
    edit.className = 'vendor-edit';
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.setAttribute('aria-label', `Edit ${v.name}`);
    edit.addEventListener('click', () => openVendorModal(v, info));

    // Mint a one-time password-reset code to read to the vendor.
    //
    // Hidden only when this vendor genuinely has no login to reset. If the
    // server couldn't resolve the logins at all (staffUnavailable), the button
    // STAYS so the operator can see something is wrong and get a real error,
    // rather than watching the only recovery channel silently disappear.
    const reset = document.createElement('button');
    reset.className = 'vendor-reset';
    reset.type = 'button';
    reset.textContent = 'Reset password';
    reset.setAttribute('aria-label', `Reset password for ${v.name}`);
    reset.hidden = !v.staffUnavailable && !(v.staff && v.staff.length);
    reset.addEventListener('click', () => openResetModal(v));

    // Permanent delete — the irreversible counterpart to the on/off switch.
    const del = document.createElement('button');
    del.className = 'vendor-delete';
    del.type = 'button';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', `Delete ${v.name}`);
    del.addEventListener('click', () => deleteVendor(v, del, row));

    const actions = document.createElement('div');
    actions.className = 'vendor-actions';
    actions.append(toggle, edit, reset, del);

    top.append(info, actions);

    // Address editor: sets the street address shown as a tappable map on the
    // student card. Saving geocodes it server-side; the note shows the result.
    const addr = document.createElement('div');
    addr.className = 'vendor-addr';
    const input = document.createElement('input');
    input.className = 'vendor-addr-input';
    input.type = 'text';
    input.maxLength = 300;
    input.placeholder = 'Street address (optional), shown as a map';
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
    `Turn OFF “${v.name}”?\n\nIts terminal will stop working and it disappears from the student app immediately. Points and history are kept, so you can turn it back on anytime.`
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
    `This removes the vendor and all its data (logo, rewards, point balances, ` +
    `and its login account) and CANNOT be undone. Past transactions are kept ` +
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

/* ---------- vendor password reset ----------
   The whole recovery channel for a locked-out vendor. There is no SMTP in this
   stack and vendors sign in with a password rather than Google, so Supabase's
   own recovery email isn't available to them: instead we mint a one-time code
   here and the operator reads it down the phone. The vendor types it into the
   terminal's "Forgot password?" form (POST /api/vendor/recover).

   The plaintext exists only in this dialog. The server stores a bcrypt hash and
   returns the code exactly once, so closing without reading it out means
   generating another. */

let resetTarget = null;   // { vendor, userId } while the dialog is open

function openResetModal(v) {
  const logins = v.staff ?? [];
  resetTarget = { vendor: v, userId: logins.length === 1 ? logins[0].userId : null };

  $('reset-title').textContent = `Reset password: ${v.name}`;
  $('reset-error').hidden = true;
  $('reset-result').hidden = true;
  $('reset-copy').hidden = true;
  $('reset-code').textContent = '';
  $('reset-expiry').textContent = '';
  $('reset-go').hidden = false;
  $('reset-go').disabled = false;
  $('reset-go').textContent = 'Generate code';

  const pick = $('reset-pick');
  const list = $('reset-pick-list');
  list.innerHTML = '';

  if (logins.length > 1) {
    // A multi-location owner has several staff logins. Never guess which one
    // gets a credential — same stance as the server's LOGIN_AMBIGUOUS guard and
    // requireVendor's VENDOR_AMBIGUOUS.
    pick.hidden = false;
    $('reset-sub').textContent = 'This vendor has more than one login. Pick the one that’s locked out.';
    logins.forEach((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'reset-login';
      b.textContent = s.role ? `${s.email} · ${s.role}` : s.email;
      b.addEventListener('click', () => {
        resetTarget.userId = s.userId;
        list.querySelectorAll('.reset-login').forEach((el) => el.classList.remove('is-picked'));
        b.classList.add('is-picked');
        $('reset-error').hidden = true;
      });
      list.appendChild(b);
    });
  } else {
    pick.hidden = true;
    if (logins.length) {
      $('reset-sub').textContent = `A one-time code for ${logins[0].email}, good for 30 minutes. Read it to them on the phone.`;
    } else if (v.staffUnavailable) {
      // The lookup failed rather than coming back empty. Say so, and let them
      // try anyway: the mint route re-resolves the logins server-side, so a
      // transient failure here doesn't have to block a vendor who is locked out.
      $('reset-sub').textContent = 'Couldn’t load this vendor’s logins. Generating a code may still work, try it.';
    } else {
      $('reset-sub').textContent = 'This vendor has no login to reset.';
      $('reset-go').disabled = true;
    }
  }

  $('reset-modal').hidden = false;
  $('reset-go').focus();
}

function closeResetModal() {
  // Wipe the code out of the DOM on the way out — it's a live credential for
  // another 30 minutes and this dashboard is often left open on a desk.
  $('reset-code').textContent = '';
  $('reset-expiry').textContent = '';
  $('reset-result').hidden = true;
  $('reset-modal').hidden = true;
  resetTarget = null;
}

function resetError(msg) {
  const el = $('reset-error');
  el.textContent = msg;
  el.hidden = false;
}

async function mintResetCode() {
  if (!resetTarget) return;
  const { vendor, userId } = resetTarget;
  const logins = vendor.staff ?? [];

  // staffUnavailable means we never learned the logins, not that there are none,
  // so let the request through and let the server be the authority.
  if (!logins.length && !vendor.staffUnavailable) return resetError('This vendor has no login to reset.');
  if (logins.length > 1 && !userId) return resetError('Pick which login to reset first.');

  $('reset-error').hidden = true;
  $('reset-go').disabled = true;
  try {
    const res = await authFetch(`/api/admin/vendors/${vendor.id}/reset-code`, {
      method: 'POST',
      body: JSON.stringify(userId ? { userId } : {}),
    });
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('reset-go').disabled = false;
      return resetError(data.message || 'Couldn’t generate a code. Try again.');
    }
    showResetCode(data);
  } catch {
    $('reset-go').disabled = false;
    resetError('No connection. Check the internet and try again.');
  }
}

function showResetCode(data) {
  $('reset-pick').hidden = true;
  $('reset-sub').textContent = `The vendor signs in as ${data.email}. They enter that address and this code at the terminal’s “Forgot password?” screen.`;
  $('reset-code').textContent = data.code;
  $('reset-expiry').textContent = data.expiresAt
    ? `Expires ${new Date(data.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · one use · 5 tries`
    : `Expires in ${data.ttlMinutes ?? 30} minutes · one use · 5 tries`;
  $('reset-result').hidden = false;
  $('reset-copy').hidden = false;
  // Re-minting immediately would invalidate the code just read out, so the
  // generate button steps aside once there's a code on screen.
  $('reset-go').hidden = true;
  $('reset-copy').focus();
}

async function copyResetCode() {
  const code = $('reset-code').textContent;
  if (!code) return;
  const btn = $('reset-copy');
  try {
    await navigator.clipboard.writeText(code);
    btn.textContent = 'Copied';
  } catch {
    // Clipboard is blocked on insecure origins and in some embedded webviews;
    // the code is on screen either way, so this is a nicety, not a failure.
    btn.textContent = 'Copy failed, read it off the screen';
  }
  setTimeout(() => { btn.textContent = 'Copy code'; }, 2000);
}

/* ---------- vendor editor (Edit modal) ----------
   Drill-in for one vendor: its display name, the points-per-dollar rate and the
   reward-item catalog. The last two are normally managed from the vendor's own
   terminal, and the server routes (/api/admin/vendors/:id...) reuse the
   terminal's validators, so messages here match what the vendor would see saving
   the same thing. The NAME has no terminal-side editor at all — this is the only
   place it can be changed. */

let editVendor = null;   // { v, infoEl } while the dialog is open

// Paint a small inline status note: 'ok' | 'err' | null (neutral).
function setNote(el, text, kind) {
  el.textContent = text;
  el.classList.toggle('is-ok', kind === 'ok');
  el.classList.toggle('is-err', kind === 'err');
}

function openVendorModal(v, infoEl) {
  editVendor = { v, infoEl };
  $('vendor-edit-title').textContent = `Edit: ${v.name}`;
  $('vendor-edit-name').value = v.name ?? '';
  setNote($('vendor-name-note'), '', null);
  $('vendor-edit-ratio').value = Number(v.points_per_dollar);
  setNote($('vendor-ratio-note'), '', null);
  $('vendor-edit-error').hidden = true;
  $('vendor-reward-list').innerHTML = '';
  showRewardsMsg('Loading items…');
  $('vendor-modal').hidden = false;
  $('vendor-edit-ratio').focus();
  loadVendorRewards(v.id);
}

function closeVendorModal() {
  $('vendor-modal').hidden = true;
  editVendor = null;
}

function showRewardsMsg(text) {
  const el = $('vendor-rewards-msg');
  el.textContent = text || '';
  el.hidden = !text;
}

// Rename the vendor everywhere it appears (student cards and history, terminal
// header, this roster). The slug is NOT regenerated server-side, so the roster's
// meta line keeps showing the original short id — that's deliberate, and the
// hint under the field says so.
async function saveVendorName() {
  if (!editVendor) return;
  const btn = $('vendor-name-save');
  const note = $('vendor-name-note');
  const name = $('vendor-edit-name').value.trim();
  if (!name) { setNote(note, 'Enter a name.', 'err'); return; }

  btn.disabled = true;
  setNote(note, 'Saving…', null);
  try {
    const res = await authFetch(`/api/admin/vendors/${editVendor.v.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setNote(note, data.message || 'Couldn’t save.', 'err'); btn.disabled = false; return; }
    Object.assign(editVendor.v, data);                             // keep the in-memory roster in sync
    editVendor.infoEl.innerHTML = vendorInfoHtml(editVendor.v);    // roster row shows the new name
    $('vendor-edit-name').value = editVendor.v.name;
    $('vendor-edit-title').textContent = `Edit: ${editVendor.v.name}`;
    repaintVendorLabels(editVendor.v, editVendor.infoEl);
    setNote(note, 'Saved', 'ok');
    btn.disabled = false;
  } catch {
    setNote(note, 'No connection.', 'err');
    btn.disabled = false;
  }
}

// The row's buttons and switch carry the vendor name in their accessible names
// ("Delete Local Eats"), so a rename has to reach those too or a screen reader
// keeps announcing the old one. The visible label is repainted by the caller.
function repaintVendorLabels(v, infoEl) {
  const row = infoEl.closest('.vendor-row');
  if (!row) return;
  const label = (sel, text) => {
    const el = row.querySelector(sel);
    if (el) el.setAttribute('aria-label', text);
  };
  label('.vendor-toggle', v.name);
  label('.vendor-edit', `Edit ${v.name}`);
  label('.vendor-reset', `Reset password for ${v.name}`);
  label('.vendor-delete', `Delete ${v.name}`);
}

async function saveVendorRatio() {
  if (!editVendor) return;
  const btn = $('vendor-ratio-save');
  const note = $('vendor-ratio-note');
  btn.disabled = true;
  setNote(note, 'Saving…', null);
  try {
    const res = await authFetch(`/api/admin/vendors/${editVendor.v.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ pointsPerDollar: Number($('vendor-edit-ratio').value) }),
    });
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setNote(note, data.message || 'Couldn’t save.', 'err'); btn.disabled = false; return; }
    Object.assign(editVendor.v, data);           // keep the in-memory roster in sync
    editVendor.infoEl.innerHTML = vendorInfoHtml(editVendor.v);  // roster meta shows the new rate
    $('vendor-edit-ratio').value = Number(editVendor.v.points_per_dollar);
    setNote(note, 'Saved', 'ok');
    btn.disabled = false;
  } catch {
    setNote(note, 'No connection.', 'err');
    btn.disabled = false;
  }
}

async function loadVendorRewards(vendorId) {
  try {
    const res = await authFetch(`/api/admin/vendors/${vendorId}/rewards`);
    if (res.status === 403) return denyAccess();
    if (!res.ok) return showRewardsMsg('Couldn’t load the items. Close and try again.');
    const items = await res.json();
    // The modal may have been closed (or reopened on another vendor) meanwhile.
    if (!editVendor || editVendor.v.id !== vendorId) return;
    showRewardsMsg(items.length ? '' : 'No items yet. Add the first one below.');
    const list = $('vendor-reward-list');
    list.innerHTML = '';
    items.forEach((r) => list.appendChild(buildRewardRow(r)));
  } catch {
    showRewardsMsg('No connection. Close and try again.');
  }
}

function addRewardDraft() {
  showRewardsMsg('');
  const row = buildRewardRow(null);
  $('vendor-reward-list').appendChild(row);
  row.querySelector('.vr-title').focus();
}

// One editable item row. `r` is the rewards row, or null for an unsaved draft
// (Save creates it; Cancel just removes the row). Reward titles are vendor
// text, so everything renders via DOM APIs / value assignment, never innerHTML.
function buildRewardRow(r) {
  const row = document.createElement('div');
  row.className = 'vr-row';

  const emoji = document.createElement('input');
  emoji.className = 'vr-emoji';
  emoji.maxLength = 16;
  emoji.value = r?.emoji ?? '🎁';
  emoji.setAttribute('aria-label', 'Emoji');

  const title = document.createElement('input');
  title.className = 'vr-title';
  title.maxLength = 60;
  title.placeholder = 'Item name';
  title.value = r?.title ?? '';
  title.setAttribute('aria-label', 'Item name');

  const pts = document.createElement('input');
  pts.className = 'vr-pts';
  pts.type = 'number';
  pts.min = '1';
  pts.max = '100000';
  pts.placeholder = 'pts';
  pts.title = 'Point cost (blank: not sold for points)';
  pts.value = r?.cost_in_points ?? '';
  pts.setAttribute('aria-label', 'Point cost');

  const visits = document.createElement('input');
  visits.className = 'vr-visits';
  visits.type = 'number';
  visits.min = '1';
  visits.max = '50';
  visits.placeholder = 'visits';
  visits.title = 'Visit cost (blank: no punch price)';
  visits.value = r?.cost_in_visits ?? '';
  visits.setAttribute('aria-label', 'Visit cost');

  const actions = document.createElement('div');
  actions.className = 'vr-actions';
  const note = document.createElement('span');
  note.className = 'vr-note';
  const save = document.createElement('button');
  save.className = 'vr-save';
  save.type = 'button';
  save.textContent = r ? 'Save' : 'Add item';
  save.addEventListener('click', () => saveReward(r, { emoji, title, pts, visits }, save, note, row));

  if (r) {
    // Same switch chrome as the roster's on/off toggle; saves immediately.
    const toggle = document.createElement('button');
    toggle.className = 'vendor-toggle';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', `${r.title} shown to students`);
    toggle.innerHTML = `<span class="vt-track"><span class="vt-knob"></span></span><span class="vt-label"></span>`;
    paintRewardToggle(toggle, row, r);
    toggle.addEventListener('click', () => toggleReward(r, toggle, row, note));
    actions.append(note, toggle, save);
  } else {
    const cancel = document.createElement('button');
    cancel.className = 'vr-cancel';
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => row.remove());
    actions.append(note, cancel, save);
  }

  row.append(emoji, title, pts, visits, actions);
  return row;
}

function paintRewardToggle(toggle, row, r) {
  toggle.classList.toggle('is-on', r.active);
  toggle.setAttribute('aria-checked', r.active ? 'true' : 'false');
  const label = toggle.querySelector('.vt-label');
  if (label) label.textContent = r.active ? 'ON' : 'OFF';
  row.classList.toggle('is-off', !r.active);
}

async function toggleReward(r, toggle, row, note) {
  if (!editVendor) return;
  toggle.disabled = true;
  setNote(note, '', null);
  try {
    const res = await authFetch(`/api/admin/vendors/${editVendor.v.id}/rewards/${r.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: !r.active }),
    });
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setNote(note, data.message || 'Couldn’t save.', 'err'); toggle.disabled = false; return; }
    Object.assign(r, data);
    paintRewardToggle(toggle, row, r);
    toggle.disabled = false;
  } catch {
    setNote(note, 'No connection.', 'err');
    toggle.disabled = false;
  }
}

async function saveReward(r, fields, save, note, row) {
  if (!editVendor) return;
  // Number inputs report '' for a cleared (or unparseable) value; the server
  // reads '' as "no price in this currency", which is the clearing semantics
  // the hint text promises.
  const body = {
    title: fields.title.value,
    costInPoints: fields.pts.value.trim(),
    costInVisits: fields.visits.value.trim(),
    emoji: fields.emoji.value,
  };
  save.disabled = true;
  setNote(note, 'Saving…', null);
  try {
    const path = r
      ? `/api/admin/vendors/${editVendor.v.id}/rewards/${r.id}`
      : `/api/admin/vendors/${editVendor.v.id}/rewards`;
    const res = await authFetch(path, { method: r ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setNote(note, data.message || 'Couldn’t save.', 'err'); save.disabled = false; return; }
    if (r) {
      Object.assign(r, data);
      setNote(note, 'Saved', 'ok');
      save.disabled = false;
    } else {
      // The created item gets a real row (with the ON/OFF switch) in place of the draft.
      row.replaceWith(buildRewardRow(data));
    }
  } catch {
    setNote(note, 'No connection.', 'err');
    save.disabled = false;
  }
}

/* ---------- add vendor (the /join form, operator side) ----------
   Onboards a vendor without the application queue, for one signed up in person
   or over the phone. POST /api/admin/vendors runs the same server code accepting
   an application does, so what this creates is indistinguishable from an accepted
   /join: the email and password below are a working terminal login immediately.

   The logo goes through the same shrink-to-128px pipeline as /join and the
   terminal's Settings — a copy rather than a shared module, matching how those
   two already carry their own (each app root is built and cached separately). */

let newVendorLogo = null;   // data-URL or null

const LOGO_MAX_PX = 128;                 // stored icon size
const LOGO_MAX_FILE = 8 * 1024 * 1024;   // reject huge source files up front

function openNewVendorModal() {
  closeNewVendorModal();          // always open on a clean, empty form
  $('new-vendor-modal').hidden = false;
  $('nv-name').focus();
}

function closeNewVendorModal() {
  $('new-vendor-modal').hidden = true;
  // reset() also wipes the typed password out of the DOM, which matters here for
  // the same reason it does on the reset dialog: this dashboard sits open on a desk.
  $('new-vendor-form').reset();
  setNewVendorLogo(null);
  setNewVendorPasswordVisible(false);
  $('new-vendor-error').hidden = true;
  $('nv-submit').disabled = false;
  $('nv-submit').textContent = 'Create vendor';
}

function showNewVendorError(msg) {
  const el = $('new-vendor-error');
  el.textContent = msg;
  el.hidden = false;
}

// The operator has to read this password to the vendor, so let them see what
// they typed rather than confirm it blind in a second field.
function toggleNewVendorPassword() {
  setNewVendorPasswordVisible($('nv-password').type === 'password');
}

function setNewVendorPasswordVisible(show) {
  $('nv-password').type = show ? 'text' : 'password';
  $('nv-password-show').textContent = show ? 'Hide' : 'Show';
  $('nv-password-show').setAttribute('aria-pressed', show ? 'true' : 'false');
}

function setNewVendorLogo(dataUrl) {
  newVendorLogo = dataUrl;
  const box = $('nv-logo-preview');
  box.style.backgroundImage = dataUrl ? `url('${dataUrl}')` : 'none';
  box.classList.toggle('is-empty', !dataUrl);
  $('nv-logo-remove').hidden = !dataUrl;
  $('nv-logo-error').hidden = true;
}

function showNewVendorLogoError(msg) {
  $('nv-logo-error').textContent = msg;
  $('nv-logo-error').hidden = false;
}

async function onNewVendorLogoPick(e) {
  const file = e.target.files?.[0];
  e.target.value = '';                   // let the same file be re-picked later
  if (!file) return;
  if (file.size > LOGO_MAX_FILE) {
    showNewVendorLogoError('That image is too large. Pick one under 8 MB.');
    return;
  }
  try {
    const { dataUrl } = await shrinkImage(file, LOGO_MAX_PX);
    setNewVendorLogo(dataUrl);
  } catch {
    showNewVendorLogoError('Couldn’t read that image. Try a PNG or JPG, since HEIC and PDF files aren’t supported.');
  }
}

// Decode a picked File into something drawable. createImageBitmap is the most
// robust path (large images, EXIF orientation, off the main thread); fall back
// to an <img> where it's missing. Neither reads HEIC/PDF — clear error above.
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

// Shrink the image to fit maxPx and return a PNG data-URL (keeps transparency).
async function shrinkImage(file, maxPx) {
  const src = await decodeImage(file);
  const scale = Math.min(1, maxPx / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(src, 0, 0, w, h);
  src.close?.();   // release the ImageBitmap if that's what we got
  return { dataUrl: canvas.toDataURL('image/png') };
}

// Client-side pre-checks mirror the server's rules (validNewVendor) so most
// mistakes are caught before the round-trip; the server re-validates regardless.
function firstNewVendorProblem() {
  if (!$('nv-name').value.trim()) return 'Enter the business name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test($('nv-email').value.trim())) return 'Enter a valid email address.';
  if ($('nv-password').value.length < 8) return 'Password must be at least 8 characters.';
  if ($('nv-password').value.length > 72) return 'Password must be 72 characters or fewer.';
  return null;
}

async function createVendor(e) {
  e.preventDefault();
  $('new-vendor-error').hidden = true;

  const problem = firstNewVendorProblem();
  if (problem) { showNewVendorError(problem); return; }

  const email = $('nv-email').value.trim();
  const btn = $('nv-submit');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const res = await authFetch('/api/admin/vendors', {
      method: 'POST',
      body: JSON.stringify({
        name: $('nv-name').value.trim(),
        email,
        password: $('nv-password').value,
        address: $('nv-address').value.trim(),
        logo: newVendorLogo,
      }),
    });
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showNewVendorError(data.message || 'Couldn’t create that vendor. Try again.');
      btn.disabled = false;
      btn.textContent = 'Create vendor';
      return;
    }
    closeNewVendorModal();
    // Same warning the accept flow gives: the email already had an account, so
    // it was LINKED as the login and the password just typed does not apply.
    if (data?.linkedExisting) {
      alert(
        `${email} already had a WeRewards account, so that account is now this vendor's login. ` +
        `The password you typed was not applied: they sign in with their usual password (or Google). ` +
        `If they need a terminal password, use Reset password on the vendor row.`
      );
    }
    // The new vendor should show up in the roster + totals without a manual refresh.
    loadVendors();
    loadOverview();
  } catch {
    showNewVendorError('No connection, try again.');
    btn.disabled = false;
    btn.textContent = 'Create vendor';
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
    `Accept “${a.business_name}”?\n\nThis creates the vendor immediately, so they can sign in to the terminal right away with the email and password from their application.`
  )) return;

  err.hidden = true;
  accept.disabled = true;
  reject.disabled = true;
  try {
    const res = await authFetch(`/api/admin/applications/${a.id}/accept`, { method: 'POST' });
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 404 = another admin (or a double-click) already handled it — reload the list.
      if (res.status === 404) { removeApplicationRow(a, row); return; }
      err.textContent = data?.message || 'Accept failed, try again.';
      err.hidden = false;
      accept.disabled = false;
      reject.disabled = false;
      return;
    }
    // The email already had a WeRewards account (usually a student), so the
    // server linked it as the vendor login instead of creating a new one.
    // Tell the operator, since "the password from their application" does NOT
    // apply in this case.
    if (data?.linkedExisting) {
      alert(
        `${a.email} already had a WeRewards account, so that account is now this vendor's login. ` +
        `Its password was not changed: they sign in with their usual password (or Google). ` +
        `If they need a terminal password, use Reset password on the vendor row.`
      );
    }
    removeApplicationRow(a, row);
    // The new vendor should show up in the roster + totals without a manual refresh.
    loadVendors();
    loadOverview();
  } catch {
    err.textContent = 'No connection, try again.';
    err.hidden = false;
    accept.disabled = false;
    reject.disabled = false;
  }
}

// Reject = permanent delete of the application (nothing else was ever created).
async function rejectApplication(a, row, accept, reject, err) {
  if (!confirm(
    `Reject the application from “${a.business_name}”?\n\nThis permanently deletes it, including their contact info and chosen password. They can always apply again.`
  )) return;

  err.hidden = true;
  accept.disabled = true;
  reject.disabled = true;
  try {
    const res = await authFetch(`/api/admin/applications/${a.id}`, { method: 'DELETE' });
    if (res.status === 403) return denyAccess();
    if (!res.ok && res.status !== 404) {
      err.textContent = 'Reject failed, try again.';
      err.hidden = false;
      accept.disabled = false;
      reject.disabled = false;
      return;
    }
    removeApplicationRow(a, row);
  } catch {
    err.textContent = 'No connection, try again.';
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
    // Only 'default' is actionable: 'granted' silently re-subscribes; 'denied'
    // can't be re-prompted (requestPermission would no-op), so we stay quiet.
    if (Notification.permission === 'granted') await subscribePush();
    else if (Notification.permission === 'default') {
      $('push-btn').hidden = false;                       // persistent topbar fallback
      // Louder one-time nudge — suppressed once the operator has said "Not now".
      let dismissed = false;
      try { dismissed = !!localStorage.getItem(PUSH_DISMISS_KEY); } catch { /* private mode */ }
      if (!dismissed) openPushModal();
    }
  } catch { /* push is a nice-to-have — never let it break the dashboard */ }
}

// The prominent popup and the topbar 🔔 button both call this. requestPermission()
// must run from the user gesture, so it's the first thing awaited. Whatever the
// outcome, hide the button and close the popup — permission is now decided, so
// neither should linger (and initPush won't re-open the popup: pushInitDone).
async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { $('push-btn').hidden = true; closePushModal(); return; }
    await subscribePush();
    $('push-btn').hidden = true;
    closePushModal();
  } catch { $('push-btn').hidden = true; closePushModal(); }
}

// ----- enable-notifications popup (a louder entry point to enablePush) -----

function openPushModal() {
  $('push-modal').hidden = false;
  $('push-enable').focus();                               // move focus into the dialog
  document.addEventListener('keydown', onPushKeydown);
}

function closePushModal() {
  $('push-modal').hidden = true;
  document.removeEventListener('keydown', onPushKeydown);
}

// Escape dismisses, same as "Not now".
function onPushKeydown(e) { if (e.key === 'Escape') dismissPushModal(); }

// "Not now" / backdrop / Escape: close and remember it so we never auto-nag again.
// Permission is untouched; the topbar 🔔 button remains available forever.
function dismissPushModal() {
  closePushModal();
  try { localStorage.setItem(PUSH_DISMISS_KEY, '1'); } catch { /* private mode — fine */ }
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
        <p class="err-where">${escapeHtml(where || 'unknown')}${e.status ? ` · ${e.status}` : ''}</p>
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
