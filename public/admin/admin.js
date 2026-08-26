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
let incentives = [];    // operator-created deals (the Incentives tab)
let referrals = [];     // newest referrals, both sides named
let grants = [];        // the community-point payout ledger
let errors = [];        // the page(s) of the error log pulled so far
// Rows the server has for the three lists it pages, which is not the same as the
// number of rows loaded — that gap is what "Show more (N left)" counts.
let errorsTotal = 0;
let referralsTotal = 0;
let grantsTotal = 0;
// One filter-and-page header per list, built in wireLists() once the shell is in
// the DOM. Null until then: nothing renders before boot has run.
let vendorTools = null;
let appTools = null;
let errorTools = null;
let refTools = null;
let grantTools = null;
let poster = null;      // the published scan-here QR file, or null
let pendingPoster = null; // a file chosen but not published yet
let vapidKey = null;    // server's public VAPID key; null = push disabled
let pushEndpoint = null;
let pushInitDone = false;
const PUSH_DISMISS_KEY = 'wr-admin-push-prompt-dismissed'; // set once "Not now" is tapped

// Mutually exclusive views under one topbar; `hidden` is the source of truth
// (same convention as the #login/#dash panels). Driven off one list so adding a
// tab is adding its name here plus the matching #tab-/#view- ids in the markup.
// Up here rather than beside setView() because crashContext() reads it to say
// which view was open, and boot() can file a report while this file is still
// evaluating — declared below the boot IIFE it would be in its temporal dead
// zone at that moment, and the throw is swallowed, so the report would quietly
// arrive missing the context it exists for.
const VIEWS = ['dashboard', 'applications', 'incentives', 'poster', 'pools', 'students'];

const $ = (id) => document.getElementById(id);

/* ---------- boot ---------- */

// The globals boot() dereferences without asking first, and the <script> at the
// foot of index.html that defines each. supabase-js is the only one: this app
// vendors nothing else.
const BOOT_SCRIPTS = { supabase: '/admin/supabase.js' };

// #login and every #view-* section ship `hidden`, so a boot that dies before
// render() leaves this page blank with nothing to read. Put the sign-in card
// back carrying the reason.
function bootFailed(message) {
  const el = $('login-error');
  el.textContent = message;
  el.hidden = false;
  $('login').hidden = false;
}

(async function boot() {
  // Before the first line that could throw. This used to sit ~80 lines down,
  // after the whole wiring block, which meant a boot that died on the
  // createClient below reported NOTHING: the listeners that would have filed it
  // were installed by code the throw had already skipped.
  installErrorReporter();

  // Each <script> on the page is its own fetch, and any one of them can go
  // missing: a dropped connection, a 5xx from the dyno, a crawler's renderer
  // deciding it has fetched enough for one page. The global is then simply
  // absent, and the first line below that touches it throws a TypeError naming
  // admin.js and never naming the file that actually went missing.
  const missing = Object.entries(BOOT_SCRIPTS).filter(([g]) => !window[g]).map(([, file]) => file);
  if (missing.length) {
    reportClientError(`boot aborted: ${missing.join(', ')} did not load`);
    bootFailed('Couldn’t load the dashboard. Check the connection and reload this page.');
    return;
  }

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
  $('tab-incentives').addEventListener('click', () => setView('incentives'));
  $('tab-poster').addEventListener('click', openPoster);
  $('qr-new-form').addEventListener('submit', createQr);
  $('qr-export').addEventListener('click', () => exportQrAll($('qr-export')));
  $('tab-pools').addEventListener('click', openPools);
  $('tot-errors-card').addEventListener('click', jumpToErrors);
  $('tot-students-card').addEventListener('click', openStudents);
  $('students-back').addEventListener('click', () => setView('dashboard'));
  $('student-q').addEventListener('input', onStudentSearch);
  $('student-q-clear').addEventListener('click', clearStudentSearch);
  $('students-more').addEventListener('click', () => loadStudents());
  $('student-detail-close').addEventListener('click', closeStudentDetail);
  $('student-modal').addEventListener('click', (e) => {
    if (e.target === $('student-modal')) closeStudentDetail();   // backdrop only, not the card
  });
  $('inc-form').addEventListener('submit', saveIncentive);
  $('inc-toggle').addEventListener('click', toggleIncentive);
  $('inc-delete').addEventListener('click', deleteIncentive);
  $('sb-form').addEventListener('submit', saveSignup);
  $('sb-toggle').addEventListener('click', toggleSignup);
  $('sb-delete').addEventListener('click', deleteSignupIncentive);
  $('ref-settle-btn').addEventListener('click', settleReferrals);
  $('grant-form').addEventListener('submit', giveGrant);
  $('push-btn').addEventListener('click', handlePushButton);
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
  $('vendor-location-save').addEventListener('click', saveVendorLocationLabel);
  $('vendor-contact-save').addEventListener('click', saveVendorContact);
  $('vendor-ratio-save').addEventListener('click', saveVendorRatio);
  $('vendor-sells-save').addEventListener('click', saveVendorSells);
  $('vendor-logo-pick').addEventListener('click', () => $('vendor-logo-file').click());
  $('vendor-logo-file').addEventListener('change', onVendorLogoPick);
  $('vendor-logo-clear').addEventListener('click', () => stageVendorLogo(null, 'Removed. Save to apply.'));
  $('vendor-logo-save').addEventListener('click', saveVendorLogo);
  // Delegated: both grids are rebuilt from scratch on every open, so a listener
  // bound to the checkboxes themselves would have to be rebound each time.
  $('vendor-edit-cuisine').addEventListener('change', (e) => syncCuisineCap(e.currentTarget));
  $('nv-cuisine').addEventListener('change', (e) => syncCuisineCap(e.currentTarget));
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
    if (!$('student-modal').hidden) closeStudentDetail();
  });
  $('poster-pick').addEventListener('click', () => $('poster-file').click());
  $('poster-file').addEventListener('change', onPosterPick);
  $('poster-upload').addEventListener('click', publishPoster);
  $('poster-cancel').addEventListener('click', () => { pendingPoster = null; renderPoster(); });
  $('poster-download').addEventListener('click', downloadPoster);
  $('poster-remove').addEventListener('click', removePoster);
  $('pool-new-form').addEventListener('submit', createPool);
  document.querySelectorAll('.err-filter').forEach((b) =>
    b.addEventListener('click', () => setErrorSource(b.dataset.src)));
  wireLists();   // the five filter/paging headers, before anything renders

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
    await Promise.all([
      loadVendors(), loadErrors(), loadApplications(),
      loadIncentives(), loadReferrals(), loadGrants(), loadPoster(),
      // Only if the operator has actually opened the roster: a page of students
      // is two extra queries, and boot shouldn't pay for a screen nobody is on.
      students.length ? loadStudents({ reset: true }) : null,
      // Same bargain for the pools screen, which is three queries of its own:
      // it loads when the tab is first opened, and only refreshes here after
      // that. Refreshing it matters because a join changes the vendor roster
      // loading beside it.
      poolsLoaded ? loadPools() : null,
      // And the same for the trackable QR codes, for a third reason: the ↻
      // button is what this card's own load-failure message tells the operator
      // to press, so it has to be reachable from here or that sentence is a lie.
      qrLoaded ? loadQrCodes() : null,
      // Unauthenticated and tiny, but it belongs to a dialog only an admin can
      // open, so it rides along here rather than firing on the sign-in screen.
      loadCuisineVocab(),
    ]);
    initPush();   // best-effort, runs once — after admin access is confirmed
  }
}

/* ---------- view tabs ---------- */

// VIEWS is declared with the module state at the top of this file, not here —
// see the note there.

function setView(view) {
  const target = VIEWS.includes(view) ? view : 'dashboard';
  VIEWS.forEach((v) => {
    $(`view-${v}`).hidden = v !== target;
    // `students` is opened from a tile, not the tab row, so it has no tab to
    // light up: every tab sits inactive while it is on screen, and its own Back
    // button is the way out.
    $(`tab-${v}`)?.classList.toggle('is-active', v === target);
  });
}

// "Errors · 24h" tile → the error log. The tile is the alert; this is the detail,
// so the two are one tap apart. Focus moves as well as the scroll, otherwise a
// keyboard or screen-reader operator is left back up at the tile. scroll-margin-top
// on #errors-card is what keeps the card head out from under the sticky topbar.
function jumpToErrors() {
  setView('dashboard');           // the tile lives on the dashboard, but be safe
  const card = $('errors-card');
  // behavior:'smooth' overrides any CSS scroll-behavior, so reduced-motion has to
  // be checked here rather than left to a media query.
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  card.focus({ preventScroll: true });
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
// `counts`, not `errors`: the module-level `errors` is the log's loaded rows,
// and this takes the server's count block, which is a different thing entirely.
function renderErrorCard(counts) {
  const err24 = counts?.last24h ?? 0;
  $('tot-errors').textContent = num(err24);
  $('tot-errors-card').classList.toggle('is-alert', err24 > 0);
  $('tot-errors-sub').textContent = `${num(counts?.total)} all-time`;
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

/* ---------- shared list tools: filter, count, paging ----------

   Five operator lists — vendors, applications, the error log, referrals and the
   payout ledger — used to render every row they were handed, with no way to find
   one and no way to reach past the newest page. This is the header they now
   share: a text filter, a count that says what it is counting, and, on the three
   logs the server pages, a Show more. Each list keeps its own row renderer, so
   nothing about a row has changed; only the chrome around it is shared.

   The filter searches what the browser has LOADED. For vendors and applications
   that is the whole table (both routes return everything), so it is exact. For
   the three logs it is the pages pulled so far, which is why their count names
   the loaded set and Show more sits directly underneath: the operator can always
   widen what is being searched, and is never told "no match" when the truthful
   answer is "not in the part I have". Searching those server-side instead would
   be more than a query parameter, because the names being searched on referrals
   and payouts live in profiles, not in either table. */

const LIST_DEBOUNCE = 200;   // ms of quiet after a keystroke before re-filtering

// "3 of 50" beats "3": the second number is what tells the operator whether a
// miss means "not here" or "not here yet".
function listCountText({ shown, loaded, total, filtered }) {
  const partial = total > loaded;
  if (filtered) return `${num(shown)} of ${num(loaded)}${partial ? ` loaded · ${num(total)} total` : ''}`;
  return partial ? `${num(loaded)} of ${num(total)}` : `${num(loaded)} shown`;
}

// Rows arriving from a later page, added to the ones already held.
//
// These logs are ordered newest first and paged by offset, so a row written
// between two requests shifts the window and the next page can open with a row
// that is already on screen. Dropping the repeat on arrival matters most in the
// error log, where a row rendered twice would also be counted twice and read as
// "×2" — one failure reported as two. (The mirror case, rows deleted between
// pages, skips a row instead; that needs cursor paging, which these lists don't
// have and, at one operator watching one log, don't yet need.)
function appendPage(current, incoming) {
  const seen = new Set(current.map((r) => r.id));
  return current.concat((incoming ?? []).filter((r) => !seen.has(r.id)));
}

// A list's own error line: shown when a page fails to load, hidden again by the
// render that follows the next success.
function showListError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
}

/**
 * Wire one list's header and hand back the handle its renderers call.
 *
 * cfg:
 *   key         id prefix — <key>-q, <key>-q-clear, <key>-count, <key>-more
 *   listId      the row container
 *   noun        singular, for the "no match" line ("No vendor matches…")
 *   rows()      every row loaded, in display order
 *   text(row)   that row as one searchable string
 *   paint(rows) the list's own renderer, given the rows that survived the filter
 *   empty()     HTML for "nothing here at all" (author-written, hence innerHTML)
 *   count()     optional: the unfiltered count text, where a list has a better
 *               one than "N shown" (vendors' on/off split, the apps queue)
 *   total()     optional: how many rows the server has, when it pages
 *   loadMore()  optional: fetch the next page; resolves falsy if it failed
 */
function listTools(cfg) {
  const input = $(`${cfg.key}-q`);
  const clearBtn = $(`${cfg.key}-q-clear`);
  const countEl = $(`${cfg.key}-count`);
  const moreBtn = cfg.loadMore ? $(`${cfg.key}-more`) : null;
  const wrap = $(cfg.listId);
  let query = '';
  let timer = null;
  let busy = false;

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const next = input.value.trim();
      if (next === query) return;   // a trailing space is not a new search
      query = next;
      clearBtn.hidden = !query;
      tools.paint();
    }, LIST_DEBOUNCE);
  });

  clearBtn.addEventListener('click', () => {
    clearTimeout(timer);            // a pending keystroke must not re-apply itself
    input.value = '';
    clearBtn.hidden = true;
    query = '';
    tools.paint();
    input.focus();
  });

  if (moreBtn) {
    moreBtn.addEventListener('click', async () => {
      if (busy) return;             // one page in flight at a time
      busy = true;
      moreBtn.disabled = true;
      const label = moreBtn.textContent;
      moreBtn.textContent = 'Loading…';
      try {
        await cfg.loadMore();       // repaints through the list's own render fn
      } finally {
        busy = false;
        moreBtn.disabled = false;
        // A successful page has already relabelled the button with the new
        // remainder; only a failed one is still sitting on "Loading…".
        if (moreBtn.textContent === 'Loading…') moreBtn.textContent = label;
      }
    });
  }

  const tools = {
    // Every term has to appear somewhere in the row, so "casey paid" narrows the
    // result the way an operator expects rather than widening it.
    visible() {
      const rows = cfg.rows();
      if (!query) return rows;
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      return rows.filter((row) => {
        const hay = cfg.text(row).toLowerCase();
        return terms.every((term) => hay.includes(term));
      });
    },

    // The whole list: rows through the list's own renderer, then the count and
    // the pager. Every render* function ends here.
    paint() {
      const loaded = cfg.rows();
      const shown = tools.visible();
      if (shown.length) {
        cfg.paint(shown);
      } else if (!loaded.length) {
        // Nothing loaded is nothing to search: the list's own empty state is the
        // honest line even with a term still in the box (the operator has just
        // cleared the log, say), and "no match in 0 rows" would not be.
        wrap.innerHTML = cfg.empty();
      } else {
        wrap.innerHTML = '';
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = tools.total() > loaded.length
          ? `No ${cfg.noun} matches that search in the ${num(loaded.length)} loaded. Show more to look further back.`
          : `No ${cfg.noun} matches that search.`;
        wrap.appendChild(p);
      }
      tools.refresh(shown.length);
    },

    total() { return cfg.total ? cfg.total() : cfg.rows().length; },

    // Count and pager only. For callers that have already changed the DOM
    // themselves (a dismissed error, an accepted application) and must not have
    // the list repainted out from under the row they just removed.
    refresh(shownCount) {
      const loaded = cfg.rows().length;
      const total = tools.total();
      const shown = shownCount == null ? tools.visible().length : shownCount;
      if (!loaded) countEl.textContent = '';
      else if (!query && cfg.count) countEl.textContent = cfg.count();
      else countEl.textContent = listCountText({ shown, loaded, total, filtered: !!query });

      if (moreBtn) {
        const left = Math.max(0, total - loaded);
        moreBtn.hidden = left <= 0;
        moreBtn.textContent = `Show more (${num(left)} left)`;
      }
    },
  };

  return tools;
}

/** The five headers, built once the shell is in the DOM (see boot). */
function wireLists() {
  vendorTools = listTools({
    key: 'vendors',
    listId: 'vendor-list',
    noun: 'vendor',
    rows: () => vendors,
    // Contact details are searchable too (migration-049), and this is not a
    // nicety: the operator's own lookup usually starts from an inbound call or
    // a reply to a reset email, so the thing they have in hand is the number or
    // the address, not the shop's name. It already works this way on the
    // applications list below — a vendor stopping being searchable by phone the
    // moment they were accepted was part of the same gap 049 closes.
    text: (v) => [
      v.name, v.slug, v.address, v.location_label, v.contact_name, v.phone,
      ...(v.staff ?? []).map((s) => s.email),
    ].filter(Boolean).join(' '),
    paint: paintVendorRows,
    empty: () => '<p class="muted">No vendors yet.</p>',
    count: vendorCountText,
  });

  appTools = listTools({
    key: 'apps',
    listId: 'app-list',
    noun: 'application',
    rows: () => applications,
    // Every location is searchable, not just the first: an operator looking up
    // "Campus" must find the chain that named a Campus branch on page two of
    // its application (migration-043).
    text: (a) => [
      a.business_name, a.contact_name, a.email, a.phone, a.address, a.location_label, a.message,
      ...(Array.isArray(a.locations) ? a.locations : []).flatMap((l) => [l.name, l.locationLabel, l.address]),
    ].filter(Boolean).join(' '),
    paint: paintApplicationRows,
    empty: () => '<p class="muted">No pending applications. Share <strong>/join</strong> with prospective vendors.</p>',
    count: () => (applications.length ? `${applications.length} pending` : ''),
  });

  errorTools = listTools({
    key: 'errors',
    listId: 'error-list',
    noun: 'error',
    rows: () => errors,
    // What an operator types is the message they can see, the path, the source
    // badge, or the person who hit it — so all four are searchable, plus the
    // plain-language action the row shows in place of the raw path.
    text: (e) => [e.source, e.message, e.method, e.path, e.status, e.actor?.email, describeAction(e)]
      .filter(Boolean).join(' '),
    paint: paintErrorRows,
    empty: () => `<p class="muted">No errors logged${errorSource ? ` for “${escapeHtml(errorSource)}”` : ''}. 🎉</p>`,
    total: () => errorsTotal,
    loadMore: () => loadErrors({ append: true }),
  });

  refTools = listTools({
    key: 'ref',
    listId: 'referral-list',
    noun: 'referral',
    rows: () => referrals,
    // Both the stored status and the word the badge shows for it: an operator
    // hunting the unpaid ones types "waiting", which is not a value in the data.
    text: (r) => [r.referrer, r.friend, r.code, r.status, (REFERRAL_STATUS[r.status] ?? [])[0]]
      .filter(Boolean).join(' '),
    paint: paintReferralRows,
    empty: () => `<p class="muted">No referrals yet. They appear here as soon as a student uses someone's invite link.</p>`,
    total: () => referralsTotal,
    loadMore: () => loadReferrals({ append: true }),
  });

  grantTools = listTools({
    key: 'grants',
    listId: 'grant-list',
    noun: 'payout',
    rows: () => grants,
    // grantedBy is searched as the row shows it: an automatic payout is stored
    // as "system" and displayed as "automatic", and either should find it.
    text: (g) => [
      g.student, GRANT_KINDS[g.kind] ?? g.kind, g.reason,
      g.grantedBy === 'system' ? 'system automatic' : g.grantedBy,
    ].filter(Boolean).join(' '),
    paint: paintGrantRows,
    empty: () => '<p class="muted">Nothing paid out yet.</p>',
    total: () => grantsTotal,
    loadMore: () => loadGrants({ append: true }),
  });
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

/* How to reach this location, on the roster row itself (migration-049).

   Both halves are here because they answer the same question from opposite
   ends. The PHONE is a column on the vendors row, carried over from the
   application at accept. The EMAIL is the login behind it, which lives in
   auth.users and arrives on `v.staff` from the definer RPC — it is also the
   address a reset code is mailed to, so seeing it next to the Reset password
   button is what tells the operator where that code is about to go.

   Real links, not text. The operator reading this roster is usually reading it
   BECAUSE they need to contact somebody, and on a phone a tel: link is the
   difference between a tap and copying nine digits by eye.

   A MISSING PHONE IS SHOWN, not hidden. Every vendor onboarded before 049 has
   a blank one — the number was destroyed with their application row and cannot
   be recovered — so those forty gaps have to be re-collected by hand through
   the Edit dialog. A row that quietly renders nothing is a row nobody ever
   fixes; a visible "no phone" is a to-do list. */
function vendorContactHtml(v) {
  const bits = [];

  if (v.phone) {
    // The href is the same string, so escapeHtml covers both the attribute (it
    // escapes " and ') and the text. PHONE_RE already bounds what can be stored
    // to digits and () + . - , none of which need URL encoding in a tel:.
    bits.push(`<a class="vendor-contact-link" href="tel:${escapeHtml(v.phone)}">${escapeHtml(v.phone)}</a>`);
  } else {
    bits.push('<span class="vendor-contact-missing">no phone</span>');
  }

  // Every login, not just the first: a multi-location owner can have several,
  // and the roster is where the operator picks which one to chase.
  (v.staff ?? []).forEach((s) => {
    if (!s?.email) return;
    bits.push(`<a class="vendor-contact-link" href="mailto:${escapeHtml(s.email)}">${escapeHtml(s.email)}</a>`);
  });

  // staffUnavailable means the lookup failed, which is NOT the same as "no
  // login" — the same distinction the Reset password button is careful about.
  // Saying so beats rendering an empty space that reads as "no email".
  if (v.staffUnavailable) bits.push('<span class="vendor-contact-missing">login unknown</span>');

  return `<span class="vendor-contact">${bits.join('<span class="vendor-contact-sep"> · </span>')}</span>`;
}

// One row's name + contact + meta line, shared by renderVendors and the Edit
// modal's saves (which repaint it in place so the roster shows the new value).
const vendorInfoHtml = (v) =>
  `<span class="vendor-name">${escapeHtml(v.name)}</span>` +
  // Which branch this row is, when one login runs several (migration-043).
  // Without it two locations of a chain are the same name twice, told apart
  // only by a slug suffix nobody can read as a place.
  (v.location_label ? `<span class="vendor-loc">${escapeHtml(v.location_label)}</span>` : '') +
  // Above the slug line on purpose. The slug and the earn rate are what the
  // row IS; the phone and email are what the operator came here to do
  // something with, so they sit closer to the name.
  vendorContactHtml(v) +
  `<span class="vendor-meta">${escapeHtml(v.slug)} · ${num(v.points_per_dollar)} pts/$</span>`;

function renderVendors() {
  $('vendor-error').hidden = true;
  vendorTools.paint();
}

// Rows only. The count, the empty state and the filter belong to the shared list
// tools, which hand this the vendors that survived the filter.
function paintVendorRows(list) {
  const wrap = $('vendor-list');
  wrap.innerHTML = '';
  list.forEach((v) => {
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
    vendorTools.refresh();
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
    // that leaves nothing on screen, re-render for the empty (or "no match")
    // state; otherwise leave the surviving rows exactly as they are.
    vendors = vendors.filter((x) => x.id !== v.id);
    row.remove();
    if (!vendorTools.visible().length) renderVendors();
    else vendorTools.refresh();
  } catch {
    showVendorError();
    btn.disabled = false;
  }
}

/* ---------- vendor password reset ----------
   The OPERATOR OVERRIDE for a locked-out vendor. Vendors sign in with a password
   rather than Google, so Supabase's own recovery email isn't available to them.
   Since migration-047 the everyday path is self-serve — the terminal's "Email me
   a code" button — and this dialog stays for the vendor who has lost the mailbox
   too. A code minted here is emailed AND shown, so the operator can still read it
   down the phone. The vendor spends it at the terminal's "Forgot password?" form
   (POST /api/vendor/recover).

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
      $('reset-sub').textContent = `A one-time code for ${logins[0].email}, good for 30 minutes. We email it there, and show it here so you can read it out.`;
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
  // Whether the email actually went is the one thing the operator cannot see for
  // themselves, and it decides what they do next: hang up, or read eight
  // characters down the phone. `emailed` is false for a send that failed AND for
  // a deployment with no mail configured, so say which — "it didn't send" and
  // "this install never sends" call for different reactions.
  const mail = data.emailed
    ? `We’ve emailed it to ${data.email}. Read it out too if they’re on the phone.`
    : data.emailConfigured
      ? `The email did NOT send. Read this code out to them.`
      : `Email isn’t set up on this deployment, so read this code out to them.`;
  $('reset-sub').textContent = `The vendor signs in as ${data.email}. They enter that address and this code at the terminal’s “Forgot password?” screen. ${mail}`;
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

/* ---------- cuisine tags + price tier (migration-042) ----------
   Two surfaces need the same checkbox grid — the Edit dialog and the Add-vendor
   form — so the grid is built by one function against whichever container it is
   handed. The vocabulary comes from /api/cuisines rather than being duplicated
   here: it is the same list src/lib/cuisines.js validates writes against, so a
   grid built from anything else could offer a tag the server then drops.

   Loaded once at boot and cached. On failure the grids stay empty and the price
   selects still work — an operator can always set a price, and cuisine can be
   filled in after a reload. */

let cuisineVocab = [];
let cuisineMax = 3;

async function loadCuisineVocab() {
  try {
    const res = await fetch('/api/cuisines');
    if (!res.ok) return;
    const body = await res.json();
    if (Array.isArray(body?.cuisines)) cuisineVocab = body.cuisines;
    if (Number.isInteger(body?.max) && body.max > 0) cuisineMax = body.max;
  } catch { /* leave the grids empty — see above */ }
}

/**
 * Display name for a stored tag.
 *
 * Falls back to the slug itself when the vocab hasn't loaded (or has since
 * dropped the tag) — a row reading "bubble-tea" is worse than "Bubble tea" and
 * fine next to a blank.
 */
function cuisineLabel(value) {
  return cuisineVocab.find((c) => c.value === value)?.label ?? value;
}

/** Ticked values in one grid, in the vocabulary's order. */
function pickedCuisine(container) {
  return [...container.querySelectorAll('input:checked')].map((el) => el.value);
}

// At the cap, disable what ISN'T ticked. The alternative — accepting the tick
// and dropping it on save — hides the limit until after the operator has
// committed to a choice, and looks like the server losing data.
function syncCuisineCap(container) {
  const atCap = pickedCuisine(container).length >= cuisineMax;
  container.querySelectorAll('input').forEach((el) => {
    el.disabled = atCap && !el.checked;
    el.closest('.tag-opt')?.classList.toggle('is-disabled', el.disabled);
  });
}

/** (Re)build a grid, ticking `selected`. Safe to call before the vocab lands. */
function buildCuisineGrid(container, selected) {
  const on = new Set(Array.isArray(selected) ? selected : []);
  container.innerHTML = '';
  cuisineVocab.forEach((c) => {
    const label = document.createElement('label');
    label.className = 'tag-opt';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = c.value;
    input.checked = on.has(c.value);
    const span = document.createElement('span');
    span.textContent = c.label;      // response text → textContent, never innerHTML
    label.append(input, span);
    container.append(label);
  });
  syncCuisineCap(container);
}

// One save for both controls — they answer the same question about the shop.
async function saveVendorSells() {
  if (!editVendor) return;
  const btn = $('vendor-sells-save');
  const note = $('vendor-sells-note');
  btn.disabled = true;
  setNote(note, 'Saving…', null);
  try {
    const res = await authFetch(`/api/admin/vendors/${editVendor.v.id}`, {
      method: 'PATCH',
      // priceLevel is sent as null (not omitted) when the select is blank —
      // that is how the operator CLEARS a price back to untagged, and the route
      // distinguishes the two.
      body: JSON.stringify({
        cuisine: pickedCuisine($('vendor-edit-cuisine')),
        priceLevel: $('vendor-edit-price').value || null,
      }),
    });
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setNote(note, data.message || 'Couldn’t save.', 'err'); btn.disabled = false; return; }
    Object.assign(editVendor.v, data);        // keep the in-memory roster in sync
    // Repaint from what came BACK, not from what was sent: the server drops
    // unknown tags and clamps the list, so the grid should show what is now
    // stored rather than what was asked for.
    buildCuisineGrid($('vendor-edit-cuisine'), editVendor.v.cuisine);
    $('vendor-edit-price').value = editVendor.v.price_level ?? '';
    setNote(note, 'Saved', 'ok');
    btn.disabled = false;
  } catch {
    setNote(note, 'No connection.', 'err');
    btn.disabled = false;
  }
}

/* ---------- the vendor's logo, operator-side ----------
   The vendor has this control too, in their own terminal Settings, and the
   server takes the same value from both (src/lib/logo.js). This exists because
   most vendors never open Settings: a logo emailed or handed over at onboarding
   otherwise has no way into the app.

   Staged, not saved on pick. The file picker sets `editLogo` and lights the
   Save button; nothing reaches the server until it is pressed. That matches the
   three sections above it, and it means Remove is undoable by closing the
   dialog rather than by finding the original file again. `staged` is a separate
   flag from `value` because null is a real staged value — it is what a Remove
   stages — and `value === null` alone cannot tell "cleared" from "untouched".

   Reuses shrinkImage / LOGO_MAX_PX / LOGO_MAX_FILE from the Add-vendor form
   below: same 128px pipeline, same 8 MB source cap, one implementation. */

let editLogo = { value: null, staged: false };

// Called on every open, BEFORE the fetch: the dialog is reused, so without this
// the previous vendor's artwork is what the operator sees for as long as the
// request takes.
function resetVendorLogoSection(v) {
  editLogo = { value: null, staged: false };
  // The staged-pick highlight is a CLASS on a reused element, so it outlives the
  // close that discarded the pick — the next vendor would open with someone
  // else's artwork ringed as if it were waiting to be saved.
  $('vendor-logo-preview').classList.remove('is-pending');
  paintVendorLogo(null, v.has_logo ? 'loading' : 'none');
  setNote($('vendor-logo-note'), '', null);
  $('vendor-logo-save').disabled = true;
}

// `state` is what the preview should SAY when there is no image to show:
// 'loading' while the fetch is out, 'none' for a vendor with no artwork.
function paintVendorLogo(dataUrl, state) {
  const box = $('vendor-logo-preview');
  box.style.backgroundImage = dataUrl ? `url('${dataUrl}')` : 'none';
  box.classList.toggle('is-empty', !dataUrl);
  // The preview is the only report of what this vendor currently has, so its
  // accessible name has to carry the state rather than being decorative.
  box.setAttribute('aria-label', dataUrl ? 'Current logo' : (state === 'loading' ? 'Logo: loading' : 'No logo'));
  // Remove is for taking artwork away; with nothing there it would be a button
  // that does nothing to a vendor who has nothing.
  $('vendor-logo-clear').hidden = !dataUrl;
}

async function loadVendorLogo(vendorId) {
  try {
    const res = await authFetch(`/api/admin/vendors/${vendorId}/logo`);
    if (res.status === 403) return denyAccess();
    // The dialog may have been closed, or reopened on a DIFFERENT vendor, while
    // this was in flight. Painting either way would show one vendor's artwork
    // over another's name.
    if (!editVendor || editVendor.v.id !== vendorId) return;
    if (!res.ok) { setNote($('vendor-logo-note'), 'Couldn’t load the current logo.', 'err'); return; }
    const data = await res.json().catch(() => ({}));
    // A pick made while the fetch was out wins: the operator's intent is newer
    // than the server's answer.
    if (editLogo.staged) return;
    paintVendorLogo(data.logo || null, 'none');
  } catch {
    if (editVendor && editVendor.v.id === vendorId) {
      setNote($('vendor-logo-note'), 'Couldn’t load the current logo.', 'err');
    }
  }
}

function stageVendorLogo(dataUrl, message) {
  editLogo = { value: dataUrl, staged: true };
  paintVendorLogo(dataUrl, 'none');
  $('vendor-logo-preview').classList.toggle('is-pending', true);
  setNote($('vendor-logo-note'), message, null);
  $('vendor-logo-save').disabled = false;
}

async function onVendorLogoPick(e) {
  const file = e.target.files?.[0];
  e.target.value = '';                   // let the same file be re-picked later
  if (!file) return;
  if (file.size > LOGO_MAX_FILE) {
    setNote($('vendor-logo-note'), 'That image is too large. Pick one under 8 MB.', 'err');
    return;
  }
  try {
    const { dataUrl } = await shrinkImage(file, LOGO_MAX_PX);
    stageVendorLogo(dataUrl, 'Not saved yet.');
  } catch {
    setNote($('vendor-logo-note'), 'Couldn’t read that image. Try a PNG or JPG, since HEIC and PDF files aren’t supported.', 'err');
  }
}

async function saveVendorLogo() {
  if (!editVendor || !editLogo.staged) return;
  const btn = $('vendor-logo-save');
  const note = $('vendor-logo-note');
  const sent = editLogo.value;
  btn.disabled = true;
  setNote(note, 'Saving…', null);
  try {
    const res = await authFetch(`/api/admin/vendors/${editVendor.v.id}`, {
      method: 'PATCH',
      // null CLEARS the logo — the route reads the KEY's presence, not its
      // value, so this has to be sent rather than omitted.
      body: JSON.stringify({ logo: sent }),
    });
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setNote(note, data.message || 'Couldn’t save.', 'err'); btn.disabled = false; return; }
    Object.assign(editVendor.v, data);        // keep the in-memory roster in sync (incl. has_logo)
    editLogo = { value: null, staged: false };
    $('vendor-logo-preview').classList.toggle('is-pending', false);
    paintVendorLogo(sent, 'none');
    setNote(note, sent ? 'Saved' : 'Logo removed', 'ok');
  } catch {
    setNote(note, 'No connection.', 'err');
    btn.disabled = false;
  }
}

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
  $('vendor-edit-location').value = v.location_label ?? '';
  setNote($('vendor-location-note'), '', null);
  // Straight off the roster row — GET /admin/vendors selects both since
  // migration-049, so opening this dialog to fill in a missing number costs no
  // extra request.
  $('vendor-edit-contact').value = v.contact_name ?? '';
  $('vendor-edit-phone').value = v.phone ?? '';
  setNote($('vendor-contact-note'), '', null);
  $('vendor-edit-ratio').value = Number(v.points_per_dollar);
  setNote($('vendor-ratio-note'), '', null);
  // Straight off the roster row — GET /admin/vendors already selects both, so
  // opening the dialog costs no extra request.
  buildCuisineGrid($('vendor-edit-cuisine'), v.cuisine);
  $('vendor-edit-price').value = v.price_level ?? '';
  setNote($('vendor-sells-note'), '', null);
  $('vendor-edit-error').hidden = true;
  $('vendor-reward-list').innerHTML = '';
  showRewardsMsg('Loading items…');
  resetVendorLogoSection(v);
  $('vendor-modal').hidden = false;
  $('vendor-edit-ratio').focus();
  loadVendorRewards(v.id);
  // Only when the roster says there is artwork to fetch. has_logo rides along on
  // GET /admin/vendors precisely so this dialog can skip the request for the
  // majority of vendors, who have no logo at all.
  if (v.has_logo) loadVendorLogo(v.id);
}

function closeVendorModal() {
  $('vendor-modal').hidden = true;
  editVendor = null;
  editLogo = { value: null, staged: false };
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

// Set (or clear) which BRANCH a vendor row is, for a login that runs several
// (migration-043). Same shape as saveVendorName above; '' clears the label back
// to unlabelled, which is where a single-location vendor stays.
async function saveVendorLocationLabel() {
  if (!editVendor) return;
  const btn = $('vendor-location-save');
  const note = $('vendor-location-note');
  const locationLabel = $('vendor-edit-location').value.trim();

  btn.disabled = true;
  setNote(note, 'Saving…', null);
  try {
    const res = await authFetch(`/api/admin/vendors/${editVendor.v.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ locationLabel }),
    });
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setNote(note, data.message || 'Couldn’t save.', 'err'); btn.disabled = false; return; }
    Object.assign(editVendor.v, data);                             // keep the in-memory roster in sync
    editVendor.infoEl.innerHTML = vendorInfoHtml(editVendor.v);    // roster row shows the new label
    $('vendor-edit-location').value = editVendor.v.location_label ?? '';
    setNote(note, 'Saved', 'ok');
    btn.disabled = false;
  } catch {
    setNote(note, 'No connection.', 'err');
    btn.disabled = false;
  }
}

// Set (or clear) who the operator phones about this location (migration-049).
// One save for both fields — see the dialog markup for why.
//
// This is the function that fills the gap 049 leaves behind: every vendor
// accepted before it has a blank phone, the application row it came from is
// long deleted, and there is no backfill. They are re-collected one at a time,
// here, which is why the roster renders a missing number as a visible "no
// phone" rather than an empty space.
async function saveVendorContact() {
  if (!editVendor) return;
  const btn = $('vendor-contact-save');
  const note = $('vendor-contact-note');
  const contactName = $('vendor-edit-contact').value.trim();
  const phone = $('vendor-edit-phone').value.trim();

  btn.disabled = true;
  setNote(note, 'Saving…', null);
  try {
    // Both keys, always. '' is a real value on this endpoint (it clears the
    // field), which is what lets a wrong number be removed rather than only
    // overwritten.
    const res = await authFetch(`/api/admin/vendors/${editVendor.v.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ contactName, phone }),
    });
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setNote(note, data.message || 'Couldn’t save.', 'err'); btn.disabled = false; return; }
    Object.assign(editVendor.v, data);                             // keep the in-memory roster in sync
    editVendor.infoEl.innerHTML = vendorInfoHtml(editVendor.v);    // roster row shows the new contact
    $('vendor-edit-contact').value = editVendor.v.contact_name ?? '';
    $('vendor-edit-phone').value = editVendor.v.phone ?? '';
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
  // Rebuilt per open rather than once at boot: the vocab may not have landed
  // the first time the dashboard painted, and this is the cheap way to be right
  // either way.
  buildCuisineGrid($('nv-cuisine'), []);
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
  // Optional, but checked when given (migration-049) — the same shape /join
  // enforces and the same one validNewVendor re-checks server-side. Catching it
  // here saves a round trip on a form the operator has otherwise finished.
  const phone = $('nv-phone').value.trim();
  if (phone && !/^[\d\s()+.-]{7,20}$/.test(phone)) return 'Enter a valid phone number, or leave it blank.';
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
        // Blank for the single-location vendor, which is nearly all of them.
        locationLabel: $('nv-location').value.trim(),
        // Optional on this door (migration-049) — a vendor added at a demo can
        // have their number filled in from the roster afterwards.
        contactName: $('nv-contact').value.trim(),
        phone: $('nv-phone').value.trim(),
        logo: newVendorLogo,
        cuisine: pickedCuisine($('nv-cuisine')),
        priceLevel: $('nv-price').value || null,
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

// The red bubble on the Applications tab: pending count, hidden at zero. Always
// the whole queue, never the filtered view — the badge is what tells the operator
// there is work waiting on a tab they are not looking at. The count beside the
// card title is the shared list tools' job.
function updateAppsBadge() {
  const badge = $('apps-badge');
  badge.textContent = applications.length > 99 ? '99+' : String(applications.length);
  badge.hidden = applications.length === 0;
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
  $('apps-error').hidden = true;
  appTools.paint();
}

// Rows only — see paintVendorRows for why the chrome isn't here.
function paintApplicationRows(list) {
  const wrap = $('app-list');
  wrap.innerHTML = '';
  list.forEach((a) => {
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
    // What they said they sell (migration-042). Shown because it is part of
    // deciding — "Coffee · $" tells the operator what this place IS faster than
    // the business name usually does. Accepting copies both onto the vendor.
    const sells = [
      (a.cuisine ?? []).map(cuisineLabel).join(', '),
      a.price_level ? '$'.repeat(a.price_level) : '',
    ].filter(Boolean).join(' · ');
    if (sells) {
      const el = document.createElement('span');
      el.className = 'app-meta';
      el.textContent = sells;
      info.appendChild(el);
    }

    const when = document.createElement('span');
    when.className = 'app-when';
    when.textContent = new Date(a.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

    top.append(logo, info, when);
    row.appendChild(top);

    // Every location this ONE application asks for (migration-043). Accepting
    // creates a vendors row for each, all linked to the same login, so the
    // operator has to be able to see what they are agreeing to before they
    // click. Location one is the row's own columns; the rest ride in `locations`.
    const extra = Array.isArray(a.locations) ? a.locations : [];
    if (extra.length) {
      const box = document.createElement('div');
      box.className = 'app-locations';
      const head = document.createElement('span');
      head.className = 'app-meta';
      head.textContent = `${extra.length + 1} locations, one sign-in:`;
      box.appendChild(head);
      [{ name: a.business_name, locationLabel: a.location_label, address: a.address }, ...extra]
        .forEach((l, i) => {
          const line = document.createElement('span');
          line.className = 'app-location';
          // textContent, and every part optional: only `name` is required of a
          // location, and this is applicant-typed text either way.
          const bits = [l.locationLabel, l.name, l.address].filter(Boolean);
          line.textContent = `${i + 1}. ${bits.join(' · ')}`;
          box.appendChild(line);
        });
      row.appendChild(box);
    }

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
  // Repaint only when nothing is left on screen. Rebuilding the list would tear
  // out the Accept/Reject buttons of a neighbouring row mid-decision.
  if (!appTools.visible().length) renderApplications();
  else appTools.refresh();
}

// Accept = onboard now: the server creates the login (from the password chosen
// when applying), the vendor row, and the staff link, then deletes the application.
async function acceptApplication(a, row, accept, reject, err) {
  // One application can name several locations (migration-043), and accepting
  // it creates one vendor per location. Say how many before the click, not after.
  const count = (Array.isArray(a.locations) ? a.locations.length : 0) + 1;
  if (!confirm(
    count > 1
      ? `Accept “${a.business_name}”?\n\nThis creates ${count} vendors, one per location, all sharing the login from their application. Each keeps its own points, items, deals and stats, and their terminal gets a switcher to move between them.`
      : `Accept “${a.business_name}”?\n\nThis creates the vendor immediately, so they can sign in to the terminal right away with the email and password from their application.`
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

/* ---------- points pools (migration-044/046) ----------
   One owner, several locations, one customer purse: earn at any member and
   spend at any other. Operator-only, and there is no vendor-facing equivalent
   anywhere on purpose — a terminal cannot prove which locations belong to one
   owner, and one shop's four-digit staff PIN is not consent to move every
   sibling's customer balances. The owner asks; this screen is where it happens.
   See the note above the routes in src/routes/admin.js.

   THE CONFIRMS ARE THE FEATURE, not decoration around it. Every other
   destructive control in this dashboard can be summarised honestly in a clause
   ("this deletes the vendor and can't be undone"), and neither of these can:
   adding a location looks like grouping some shops and is actually emptying
   every customer balance it holds into a purse its siblings can spend from,
   and removing one looks like undoing that but is a contribution split that
   lands somewhere new. So each confirm says what happens to the money before
   the click, and each result line quotes the server's own count of what it
   just moved. That line is the only receipt an operator gets for a transfer
   nothing on this page can reverse.

   Deliberately NOT on the shared list tools above. Those exist for logs and
   rosters that run to hundreds of rows and get searched; a deployment has a
   handful of pools, all of which have to be on screen at once, and a filter
   that could hide one would make the add-location picker's omissions (a
   location already in somebody else's pool) unreadable. */

let pools = [];           // every pool, with its members and what its purse holds
let poolsLoaded = false;  // false until the first open pays for the load
// Fetched settlement rows, keyed by pool id. Presence here IS "this pool's
// table is open", which is what lets a repaint put back what was on screen.
// loadPools() empties it: any reload means the numbers under those tables have
// moved, and a quietly stale settlement figure on the screen an owner's
// per-location stats get reconciled from is worse than a panel to reopen.
const poolSettlements = new Map();

// Loaded on first open rather than at boot: three queries for a screen most
// sessions never touch. Same trade the student roster makes, and loadAll()
// keeps it fresh from then on.
function openPools() {
  setView('pools');
  if (!poolsLoaded) loadPools();
}

async function loadPools() {
  const err = $('pools-error');
  err.hidden = true;
  try {
    const res = await authFetch('/api/admin/pools');
    if (res.status === 403) return denyAccess();
    if (!res.ok) throw new Error(`pools ${res.status}`);
    pools = await res.json();
    poolsLoaded = true;
    poolSettlements.clear();
    renderPools();
  } catch {
    err.textContent = 'Couldn’t load the pools. Check your connection and try again.';
    err.hidden = false;
  }
}

// After anything that moved points. The vendor roster is reloaded alongside the
// pools because the add-location picker is built out of it: a location that has
// just joined must not still be on offer in the pool row underneath.
async function refreshPools() {
  await Promise.all([loadPools(), loadVendors()]);
}

// The outcome line sits above the list rather than in the row that changed,
// because every change repaints that list: a note pinned to the row that just
// joined would be destroyed by the reload that proves it joined.
function poolOk(text) {
  const el = $('pools-ok');
  el.textContent = text;
  el.hidden = false;
}

function poolRowError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

// "300 points moved for 12 customers", in the server's own numbers and never a
// figure this file worked out for itself. A call that found nothing to move (a
// double-tapped button, which the RPCs treat as a no-op rather than an error)
// says so instead of reporting a confident zero.
function poolMoveText(d, verb) {
  const points = Number(d?.pointsMoved) || 0;
  const customers = Number(d?.customers) || 0;
  if (!points && !customers) return 'nothing to move';
  return `${num(points)} point${points === 1 ? '' : 's'} ${verb} for ` +
    `${num(customers)} customer${customers === 1 ? '' : 's'}`;
}

// Which shop a row is about, in the words the operator uses on the phone to the
// owner. Two locations of a chain are the same name twice without the label.
const poolVendorLabel = (v) => (v?.location_label ? `${v.name} (${v.location_label})` : (v?.name ?? 'that location'));

function renderPools() {
  $('pools-error').hidden = true;
  $('pools-count').textContent = pools.length
    ? `${num(pools.length)} pool${pools.length === 1 ? '' : 's'}`
    : '';

  const wrap = $('pool-list');
  wrap.innerHTML = '';
  if (!pools.length) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.textContent = 'No pools yet. Create one below, then add the owner’s locations to it.';
    wrap.appendChild(none);
    return;
  }
  pools.forEach((pool) => wrap.appendChild(buildPoolRow(pool)));
}

// Pool labels, vendor names and location labels are all typed by people, so the
// whole row is built with DOM APIs and textContent. Same rule, same reason, as
// paintVendorRows and paintApplicationRows.
function buildPoolRow(pool) {
  const members = Array.isArray(pool.members) ? pool.members : [];
  const held = pool.held ?? { points: 0, customers: 0 };
  const points = Number(held.points) || 0;
  const customers = Number(held.customers) || 0;

  const row = document.createElement('div');
  row.className = 'pool-row';

  const info = document.createElement('div');
  info.className = 'pool-info';
  const name = document.createElement('span');
  name.className = 'pool-name';
  name.textContent = pool.label;
  const meta = document.createElement('span');
  meta.className = 'pool-meta';
  // The purse leads because it decides what the operator may do next: a pool
  // holding nothing can be retired, one holding points cannot until its
  // locations are out, and the customer count is the size of the promise.
  meta.textContent =
    `${num(points)} point${points === 1 ? '' : 's'} across ` +
    `${num(customers)} customer${customers === 1 ? '' : 's'} · ` +
    `${num(members.length)} location${members.length === 1 ? '' : 's'}`;
  info.append(name, meta);

  // One error line per pool, because every button that can fail here belongs to
  // one pool and the operator's eye is already in this row. The view-level
  // #pools-error is for a failed load, which belongs to no row at all.
  const err = document.createElement('span');
  err.className = 'pool-error';
  err.hidden = true;

  const addBtn = document.createElement('button');
  addBtn.className = 'pool-btn';
  addBtn.type = 'button';
  addBtn.textContent = 'Add location';
  addBtn.setAttribute('aria-label', `Add a location to ${pool.label}`);

  const settleBtn = document.createElement('button');
  settleBtn.className = 'pool-btn';
  settleBtn.type = 'button';
  settleBtn.setAttribute('aria-expanded', 'false');

  const delBtn = document.createElement('button');
  delBtn.className = 'pool-btn-danger';
  delBtn.type = 'button';
  delBtn.textContent = 'Delete pool';
  delBtn.setAttribute('aria-label', `Delete the ${pool.label} pool`);
  delBtn.addEventListener('click', () => deletePool(pool, delBtn, err));

  const actions = document.createElement('div');
  actions.className = 'pool-actions';
  actions.append(addBtn, settleBtn, delBtn);

  const head = document.createElement('div');
  head.className = 'pool-head';
  head.append(info, actions);
  row.append(head, err);

  const list = document.createElement('div');
  list.className = 'pool-members';
  if (!members.length) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.textContent = 'No locations in it yet. An empty pool holds nothing and changes nothing.';
    list.appendChild(none);
  } else {
    members.forEach((m) => list.appendChild(buildPoolMemberRow(pool, m, err)));
  }
  row.appendChild(list);

  // The picker is built with the row but FILLED when it is opened: the roster
  // is reloaded after every change, and an option for a location that has since
  // joined somewhere else is an offer the server could only refuse.
  const picker = document.createElement('div');
  picker.className = 'pool-picker';
  picker.hidden = true;
  const select = document.createElement('select');
  select.className = 'nv-input pool-select';
  select.setAttribute('aria-label', `Location to add to ${pool.label}`);
  const go = document.createElement('button');
  go.className = 'pool-btn';
  go.type = 'button';
  go.textContent = 'Add';
  const cancel = document.createElement('button');
  cancel.className = 'pool-btn';
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const hint = document.createElement('span');
  hint.className = 'pool-picker-hint';
  picker.append(select, go, cancel, hint);
  row.appendChild(picker);

  addBtn.addEventListener('click', () => {
    if (!picker.hidden) { picker.hidden = true; return; }
    const eligible = fillPoolPicker(select);
    hint.textContent = eligible
      ? 'Only locations that are not already in a pool are listed. Adding one empties its customer balances into this purse.'
      : 'Every location is already in a pool, so there is nothing to add.';
    select.hidden = !eligible;
    go.hidden = !eligible;
    picker.hidden = false;
    if (eligible) select.focus();
  });
  cancel.addEventListener('click', () => { picker.hidden = true; addBtn.focus(); });
  go.addEventListener('click', () => addPoolMember(pool, select.value, go, err));

  const panel = document.createElement('div');
  panel.className = 'pool-settle';
  panel.hidden = true;
  // The pool id, so the toggle can point at the panel it opens: aria-expanded
  // alone says 'expanded what?' when a screen reader meets the fourth of these
  // on one screen.
  panel.id = `pool-settle-${pool.id}`;
  settleBtn.setAttribute('aria-controls', panel.id);
  row.appendChild(panel);
  settleBtn.addEventListener('click', () => togglePoolSettlement(pool, panel, settleBtn, err));
  paintPoolSettlement(pool, panel, settleBtn);   // sets the button's own label too

  return row;
}

function buildPoolMemberRow(pool, m, err) {
  const row = document.createElement('div');
  row.className = 'pool-member';
  if (!m.active) row.classList.add('is-off');

  const info = document.createElement('div');
  info.className = 'pool-member-info';
  const name = document.createElement('span');
  name.className = 'vendor-name';
  name.textContent = m.name;
  info.appendChild(name);
  if (m.location_label) {
    const loc = document.createElement('span');
    loc.className = 'vendor-loc';
    loc.textContent = m.location_label;
    info.appendChild(loc);
  }
  const meta = document.createElement('span');
  meta.className = 'vendor-meta';
  // The rate is here because it is the precondition a join fails on, and
  // "switched off" because an off member is still IN the pool: its customers'
  // points sit in the purse and stay spendable at its siblings, which is not
  // what off means anywhere else in this dashboard. The join date is what every
  // settlement number below is windowed on.
  meta.textContent = [
    `${num(m.points_per_dollar)} pts/$`,
    m.pool_joined_at
      ? `joined ${new Date(m.pool_joined_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
      : null,
    m.active ? null : 'switched off',
  ].filter(Boolean).join(' · ');
  info.appendChild(meta);

  const remove = document.createElement('button');
  remove.className = 'pool-btn-danger';
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.setAttribute('aria-label', `Remove ${m.name} from the ${pool.label} pool`);
  remove.addEventListener('click', () => removePoolMember(pool, m, remove, err));

  row.append(info, remove);
  return row;
}

// The roster this page already holds, minus everyone who is in a pool (this one
// or anybody else's). Not a second fetch: /api/admin/vendors carries pool_id for
// exactly this, and refetching here would race the reload that runs after every
// membership change.
function fillPoolPicker(select) {
  select.innerHTML = '';
  const free = vendors
    .filter((v) => !v.pool_id)
    .sort((a, b) => poolVendorLabel(a).localeCompare(poolVendorLabel(b)));
  free.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.id;
    // The rate rides along because it is what a join fails on: reading "5 pts/$"
    // against a pool of 20s here is quicker than reading POOL_RATE_MISMATCH
    // afterwards, and it is the same fix either way.
    opt.textContent = [
      poolVendorLabel(v),
      `${num(v.points_per_dollar)} pts/$`,
      v.active ? null : 'off',
    ].filter(Boolean).join(' · ');
    select.appendChild(opt);
  });
  return free.length;
}

async function addPoolMember(pool, vendorId, btn, err) {
  const v = vendors.find((x) => x.id === vendorId);
  if (!v) { poolRowError(err, 'Pick a location to add.'); return; }
  const label = poolVendorLabel(v);

  // Everything the button cannot say: whose money moves, where it goes, and
  // that taking the location back out is a different operation, not an undo.
  if (!confirm(
    `Add “${label}” to the “${pool.label}” pool?\n\n` +
    `Every customer balance at this location is emptied into the shared purse the moment you confirm. ` +
    `Those points stop being this shop’s points: they can be spent at any other location in the pool, ` +
    `and this shop starts honouring points earned at all of them. This moves real money between businesses.\n\n` +
    `Taking it out again later returns only what its own trading funded, which is not the same as putting this back.`
  )) return;

  err.hidden = true;
  $('pools-ok').hidden = true;
  btn.disabled = true;
  try {
    const res = await authFetch(`/api/admin/pools/${pool.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ vendorId }),
    });
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // The server's line, never one of ours. POOL_PIN_MISSING and
      // POOL_RATE_MISMATCH each name the exact thing to go and fix first, and
      // anything written here could only lose that.
      poolRowError(err, data.message || 'Couldn’t add that location.');
      return;
    }
    poolOk(`${label} joined ${pool.label}: ${poolMoveText(data, 'moved')}.`);
    await refreshPools();
  } catch {
    poolRowError(err, 'No connection, try again.');
  } finally {
    btn.disabled = false;
  }
}

async function removePoolMember(pool, m, btn, err) {
  const label = poolVendorLabel(m);
  const last = (Array.isArray(pool.members) ? pool.members.length : 0) <= 1;

  if (!confirm(
    `Remove “${label}” from the “${pool.label}” pool?\n\n` +
    (last
      ? `It is the last location in the pool, so it takes the whole remaining purse back with it. ` +
        `Anything left behind would sit where no customer could ever spend it.`
      : `It takes back only what its own trading funded, which is what its customers earned there ` +
        `less what they spent there, since it joined. Everything the other locations funded stays ` +
        `in the pool with them.`) +
    `\n\nPoints are conserved either way, but this does not put the balances back the way they were before it joined.`
  )) return;

  err.hidden = true;
  $('pools-ok').hidden = true;
  btn.disabled = true;
  try {
    const res = await authFetch(`/api/admin/pools/${pool.id}/members/${m.id}`, { method: 'DELETE' });
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      poolRowError(err, data.message || 'Couldn’t remove that location.');
      return;
    }
    poolOk(`${label} left ${pool.label}: ${poolMoveText(data, 'moved back')}.`);
    await refreshPools();
  } catch {
    poolRowError(err, 'No connection, try again.');
  } finally {
    btn.disabled = false;
  }
}

// Retiring the name. The button is never hidden or disabled on a pool that
// still has members: the server refuses with POOL_HAS_MEMBERS or
// POOL_NOT_EMPTY, and that answer tells the operator what to do next, which a
// greyed-out button never does.
async function deletePool(pool, btn, err) {
  if (!confirm(
    `Delete the “${pool.label}” pool?\n\n` +
    `Only an empty pool can be deleted, so this removes the name and nothing else. ` +
    `If locations are still in it, take them out first: that is what hands their customers’ points back.`
  )) return;

  err.hidden = true;
  $('pools-ok').hidden = true;
  btn.disabled = true;
  try {
    const res = await authFetch(`/api/admin/pools/${pool.id}`, { method: 'DELETE' });
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      poolRowError(err, data.message || 'Couldn’t delete that pool.');
      return;
    }
    poolOk(`Deleted the ${pool.label} pool. Nothing moved: it was already empty.`);
    await loadPools();
  } catch {
    poolRowError(err, 'No connection, try again.');
  } finally {
    btn.disabled = false;
  }
}

async function createPool(e) {
  e.preventDefault();
  const input = $('pool-new-label');
  const err = $('pool-new-error');
  const label = input.value.trim();
  err.hidden = true;
  if (!label) {
    err.textContent = 'Give the pool a name.';
    err.hidden = false;
    return;
  }

  // The one step here that moves nothing, so it is the one step with no confirm
  // in front of it: an empty pool is a name and a row, and deleting it again
  // costs the operator one click.
  $('pool-new-submit').disabled = true;
  try {
    const res = await authFetch('/api/admin/pools', {
      method: 'POST',
      body: JSON.stringify({ label }),
    });
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      err.textContent = data.message || 'Couldn’t create that pool.';
      err.hidden = false;
      return;
    }
    input.value = '';
    poolOk(`Created the ${data.pool?.label ?? label} pool. It is empty until you add locations to it.`);
    await loadPools();
  } catch {
    err.textContent = 'No connection, try again.';
    err.hidden = false;
  } finally {
    $('pool-new-submit').disabled = false;
  }
}

/* ----- settlement: who funded whom inside one pool -----
   On demand, per pool, because it is a report rather than a control: an
   operator opens it when an owner asks why one location's stats look wrong.
   They look wrong for a real reason — a shop that hands over a coffee bought
   with points earned next door records a redemption with no matching revenue,
   which is correct and reads as broken — and these five columns are what turn
   that back into a number the owner can act on. */

async function togglePoolSettlement(pool, panel, btn, err) {
  if (poolSettlements.has(pool.id)) {
    poolSettlements.delete(pool.id);
    paintPoolSettlement(pool, panel, btn);
    return;
  }
  err.hidden = true;
  btn.disabled = true;
  try {
    const res = await authFetch(`/api/admin/pools/${pool.id}/settlement`);
    if (res.status === 403) return denyAccess();
    const data = await res.json().catch(() => ([]));
    if (!res.ok) {
      poolRowError(err, data?.message || 'Couldn’t work out the settlement for this pool.');
      return;
    }
    poolSettlements.set(pool.id, Array.isArray(data) ? data : []);
    paintPoolSettlement(pool, panel, btn);
  } catch {
    poolRowError(err, 'No connection, try again.');
  } finally {
    btn.disabled = false;
  }
}

function paintPoolSettlement(pool, panel, btn) {
  const rows = poolSettlements.get(pool.id);
  panel.innerHTML = '';
  panel.hidden = !rows;
  btn.textContent = rows ? 'Hide settlement' : 'Settlement';
  btn.setAttribute('aria-expanded', rows ? 'true' : 'false');
  btn.setAttribute('aria-label', `${rows ? 'Hide the settlement for' : 'Settlement for'} ${pool.label}`);
  if (!rows) return;

  const legend = document.createElement('p');
  legend.className = 'muted';
  legend.textContent = 'Minted: points this location put into the purse, its earns plus community points brought in here. '
    + 'Burned: points it paid out. Moved: what it contributed on joining, less anything it has taken back. '
    + 'Everything is counted from the day that location joined.';
  panel.appendChild(legend);

  // The line this table exists for. Anyone can read five columns of numbers;
  // what an owner needs told is which direction the debt runs.
  const note = document.createElement('p');
  note.className = 'muted pool-settle-note';
  note.textContent = 'Net is minted plus moved, less burned. A negative net means this location has given away more than it brought in, so its siblings owe it.';
  panel.appendChild(note);

  if (!rows.length) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.textContent = 'Nothing to settle: there are no locations in this pool.';
    panel.appendChild(none);
    return;
  }

  const table = document.createElement('table');
  table.className = 'pool-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Location', 'Minted', 'Burned', 'Moved', 'Net'].forEach((label, i) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    if (i) th.className = 'is-num';
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  // pool_settlement returns the pool's CURRENT members only, so the name is
  // always one of the rows above; the raw id is the fallback for the seconds
  // between another admin adding a location and this page being reloaded.
  const byId = new Map((Array.isArray(pool.members) ? pool.members : []).map((m) => [m.id, m]));
  const tbody = document.createElement('tbody');
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    const who = document.createElement('td');
    const m = byId.get(r.vendor_id);
    who.textContent = m ? poolVendorLabel(m) : r.vendor_id;
    tr.appendChild(who);
    [r.minted, r.burned, r.moved, r.net].forEach((value, i) => {
      const td = document.createElement('td');
      td.className = 'is-num';
      td.textContent = num(value);
      // Only the net is coloured. Minted and burned are facts about one shop;
      // the net is the single number that says who owes whom, and colouring its
      // neighbours would bury it.
      if (i === 3) td.classList.add(Number(value) < 0 ? 'is-neg' : 'is-pos');
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.append(thead, tbody);

  // Five columns of numbers that have to stay in their columns: the table
  // scrolls sideways inside the row rather than squeezing the names to two
  // characters on a phone.
  const scroller = document.createElement('div');
  scroller.className = 'pool-table-wrap';
  scroller.appendChild(table);
  panel.appendChild(scroller);
}

/* ---------- incentives (migration-039) ----------
   Operator-created deals that pay COMMUNITY points — the cross-vendor pool, so
   the platform funds them rather than a vendor honoring a promise it never
   made. Four panels: the referral program editor, the referrals it has
   produced, a manual grant form, and the payout ledger underneath everything.

   Every list here is built with DOM APIs rather than innerHTML: the rows carry
   student and operator email addresses, which are user-controlled text. Same
   rule as renderVendors and renderApplications. */

// Mirrors REFERRAL_DEFAULTS / SIGNUP_DEFAULTS in src/lib/referrals.js and
// src/lib/signup-bonus.js. Only used to pre-fill an empty form; the server is
// the authority on what a saved program actually holds.
const REFERRAL_DEFAULTS = {
  referrerPoints: 10,
  friendPoints: 10,
  maxPerReferrer: 10,
  signupWindowDays: 14,
};

const SIGNUP_DEFAULTS = { points: 10, domains: ['psu.edu'] };

async function loadIncentives() {
  const res = await authFetch('/api/admin/incentives');
  if (res.status === 403) return denyAccess();
  if (!res.ok) return;
  incentives = await res.json();
  renderIncentives();
}

/* Both ledgers are loaded a page at a time, newest first, and both are appended
   to rather than replaced when the operator asks for more. Each request carries
   a sequence number and a reply that isn't the newest is dropped: "Settle now"
   reloads the referral list from the top, and without the guard a page still in
   flight from a Show more could land afterwards and staple stale rows onto a
   list that has already been rebuilt. Same guard, same reason, as loadStudents. */
const REFERRAL_PAGE = 50;
const GRANT_PAGE = 50;
let referralReqSeq = 0;
let grantReqSeq = 0;

async function loadReferrals({ append = false } = {}) {
  const seq = ++referralReqSeq;
  const offset = append ? referrals.length : 0;
  try {
    const res = await authFetch(`/api/admin/referrals?limit=${REFERRAL_PAGE}&offset=${offset}`);
    if (res.status === 403) { denyAccess(); return false; }
    if (!res.ok) throw new Error(`referrals ${res.status}`);
    const d = await res.json();
    if (seq !== referralReqSeq) return false;         // a newer load already won
    referrals = append ? appendPage(referrals, d.referrals) : (d.referrals ?? []);
    referralsTotal = d.total ?? referrals.length;
    renderReferrals();
    return true;
  } catch {
    if (seq !== referralReqSeq) return false;
    showListError('ref-error', 'Couldn’t load referrals. Check your connection and try again.');
    return false;
  }
}

async function loadGrants({ append = false } = {}) {
  const seq = ++grantReqSeq;
  const offset = append ? grants.length : 0;
  try {
    const res = await authFetch(`/api/admin/grants?limit=${GRANT_PAGE}&offset=${offset}`);
    if (res.status === 403) { denyAccess(); return false; }
    if (!res.ok) throw new Error(`grants ${res.status}`);
    const d = await res.json();
    if (seq !== grantReqSeq) return false;
    grants = append ? appendPage(grants, d.grants) : (d.grants ?? []);
    grantsTotal = d.total ?? grants.length;
    renderGrants();
    return true;
  } catch {
    if (seq !== grantReqSeq) return false;
    showListError('grants-error', 'Couldn’t load the payout log. Check your connection and try again.');
    return false;
  }
}

/** The program panel for a kind shows the ACTIVE one if there is one, else the
    most recently created one — because a program is created switched off, and
    the panel that just saved it has to keep editing it rather than reset to a
    blank form and create a duplicate on the next save. The server orders
    active-first then newest-first, so the first match is the right one. */
function currentIncentive(kind) {
  const of = incentives.filter((i) => i.kind === kind);
  return of.find((i) => i.active) ?? of[0];
}

/** Everything of that kind the panel is NOT currently editing. */
function pastIncentives(kind) {
  const cur = currentIncentive(kind);
  return incentives.filter((i) => i.kind === kind && i.id !== cur?.id);
}

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in LOCAL time, and an
// ISO string from the server is UTC. Shifting by the offset before slicing is
// what keeps a program that starts at 9am local from displaying as 1pm.
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** How much of a program's budget is gone, in words. */
function budgetLine(p) {
  return p.budget_points
    ? `${num(p.spent_points)} of ${num(p.budget_points)} points paid out`
    : `${num(p.spent_points)} points paid out, no budget cap`;
}

/**
 * The chrome every program panel shares: the Running/Off chip, the primary
 * button's verb, and which of turn-on/off and delete are offered.
 *
 * Creating a program does NOT switch it on (see POST /api/admin/incentives), so
 * "Off" is the normal state of a brand new one and the chip has to distinguish
 * it from "Not created" or an operator can't tell whether their save worked.
 */
function paintProgram(prefix, program) {
  const running = !!program?.active;
  const state = $(`${prefix}-state`);
  state.textContent = program ? (running ? 'Running' : 'Off') : 'Not set up';
  state.classList.toggle('is-live', running);

  $(`${prefix}-save`).textContent = program ? 'Save changes' : 'Create program';

  const toggle = $(`${prefix}-toggle`);
  toggle.hidden = !program;
  toggle.textContent = running ? 'Turn off' : 'Turn on';
  toggle.classList.toggle('btn-primary', !running);
  toggle.classList.toggle('btn-ghost', running);

  // A program that has paid points out is the record of why they moved, so it
  // can only be turned off. The server refuses the delete either way; hiding
  // the button means an operator is never offered an action that will fail.
  $(`${prefix}-delete`).hidden = !program || program.spent_points > 0;
}

function renderIncentives() {
  renderReferralPanel();
  renderSignupPanel();
  renderPastIncentives();
}

/* ---------- panel 1: refer a friend ---------- */

function renderReferralPanel() {
  const p = currentIncentive('referral');
  const cfg = { ...REFERRAL_DEFAULTS, ...(p?.config ?? {}) };

  $('inc-name').value = p?.name ?? 'Refer a friend';
  $('inc-referrer-points').value = cfg.referrerPoints;
  $('inc-friend-points').value = cfg.friendPoints;
  $('inc-max-per').value = cfg.maxPerReferrer ?? '';
  $('inc-window').value = cfg.signupWindowDays;
  $('inc-budget').value = p?.budget_points ?? '';
  $('inc-starts').value = toLocalInput(p?.starts_at);
  $('inc-ends').value = toLocalInput(p?.ends_at);

  paintProgram('inc', p);

  const note = $('inc-note');
  if (p) {
    const r = p.referrals ?? {};
    note.textContent = `${budgetLine(p)}. ${num(r.paid ?? 0)} referrals paid, ${num(r.pending ?? 0)} waiting on a first purchase.`;
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

/** The referral form's fields as the API's body shape. Numbers stay strings
    where blank means "unlimited" — the server tells blank from zero, so this
    must not coerce one into the other. */
function incentiveBody() {
  const val = (id) => $(id).value.trim();
  return {
    kind: 'referral',
    name: val('inc-name'),
    budgetPoints: val('inc-budget'),
    startsAt: val('inc-starts'),
    endsAt: val('inc-ends'),
    config: {
      referrerPoints: val('inc-referrer-points'),
      friendPoints: val('inc-friend-points'),
      maxPerReferrer: val('inc-max-per'),
      signupWindowDays: val('inc-window'),
    },
  };
}

/* ---------- panel 2: signup bonus ---------- */

function renderSignupPanel() {
  const p = currentIncentive('signup_domain');
  const cfg = { ...SIGNUP_DEFAULTS, ...(p?.config ?? {}) };

  $('sb-name').value = p?.name ?? 'PSU email signup bonus';
  $('sb-points').value = cfg.points;
  $('sb-domains').value = (cfg.domains ?? []).join(', ');
  $('sb-budget').value = p?.budget_points ?? '';
  $('sb-starts').value = toLocalInput(p?.starts_at);
  $('sb-ends').value = toLocalInput(p?.ends_at);

  paintProgram('sb', p);

  const note = $('sb-note');
  if (p) {
    note.textContent = `${budgetLine(p)}. ${num(p.payouts ?? 0)} students paid.`;
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

function signupBody() {
  const val = (id) => $(id).value.trim();
  return {
    kind: 'signup_domain',
    name: val('sb-name'),
    budgetPoints: val('sb-budget'),
    startsAt: val('sb-starts'),
    endsAt: val('sb-ends'),
    config: { points: val('sb-points'), domains: val('sb-domains') },
  };
}

/* ---------- previous programs (both kinds) ---------- */

function renderPastIncentives() {
  const past = [...pastIncentives('referral'), ...pastIncentives('signup_domain')];
  const wrap = $('inc-past-list');
  $('inc-past').hidden = past.length === 0;
  wrap.innerHTML = '';

  const KIND_LABEL = { referral: 'Refer a friend', signup_domain: 'Signup bonus' };

  past.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'inc-past-row';

    const info = document.createElement('div');
    info.className = 'inc-past-info';
    const name = document.createElement('span');
    name.className = 'inc-past-name';
    name.textContent = p.name;
    const meta = document.createElement('span');
    meta.className = 'app-meta';
    meta.textContent = `${KIND_LABEL[p.kind] ?? p.kind} · ${num(p.spent_points)} points paid · ${num(p.payouts ?? 0)} students`;
    info.append(name, meta);

    const on = document.createElement('button');
    on.className = 'app-accept';
    on.type = 'button';
    on.textContent = 'Turn on';
    on.addEventListener('click', () => patchIncentive(p.id, { active: true }));

    row.append(info, on);

    if (p.spent_points === 0) {
      const del = document.createElement('button');
      del.className = 'app-reject';
      del.type = 'button';
      del.textContent = 'Delete';
      del.addEventListener('click', () => deletePastIncentive(p));
      row.appendChild(del);
    }

    wrap.appendChild(row);
  });
}

/* ---------- saving, switching, deleting ---------- */

function showIncError(prefix, msg) {
  const el = $(`${prefix}-error`);
  el.textContent = msg || 'Couldn’t save that. Check your connection and try again.';
  el.hidden = false;
}

// One save path for both panels: `prefix` picks the form's element ids, `kind`
// picks which program the panel is editing. Creating leaves the program OFF —
// switching it on is the separate, deliberate button beside this one.
async function saveProgram(prefix, kind, body) {
  const p = currentIncentive(kind);
  $(`${prefix}-error`).hidden = true;
  $(`${prefix}-save`).disabled = true;
  try {
    const res = await authFetch(
      p ? `/api/admin/incentives/${p.id}` : '/api/admin/incentives',
      { method: p ? 'PATCH' : 'POST', body: JSON.stringify(body) }
    );
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return showIncError(prefix, out.message);
    await loadIncentives();
  } catch {
    showIncError(prefix, 'No connection, try again.');
  } finally {
    $(`${prefix}-save`).disabled = false;
  }
}

function saveIncentive(e) { e.preventDefault(); saveProgram('inc', 'referral', incentiveBody()); }
function saveSignup(e) { e.preventDefault(); saveProgram('sb', 'signup_domain', signupBody()); }

async function patchIncentive(id, patch, prefix = 'inc') {
  $(`${prefix}-error`).hidden = true;
  try {
    const res = await authFetch(`/api/admin/incentives/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return showIncError(prefix, out.message);
    await loadIncentives();
  } catch {
    showIncError(prefix, 'No connection, try again.');
  }
}

// Turning a program off stops NEW attributions. Referrals already recorded keep
// their snapshotted payout and still settle when the friend buys something —
// which is the honest behavior, and worth saying out loud in the confirm.
function toggleIncentive() {
  const p = currentIncentive('referral');
  if (!p) return;
  if (!p.active) {
    if (!confirm(`Turn on “${p.name}”?\n\nInvite codes start working immediately and points start being paid out.`)) return;
    return patchIncentive(p.id, { active: true });
  }
  const waiting = p.referrals?.pending ?? 0;
  const tail = waiting
    ? `\n\n${waiting} referral${waiting === 1 ? '' : 's'} already recorded will still be paid when those students make their first purchase.`
    : '';
  if (!confirm(`Turn off “${p.name}”?\n\nNo new invite codes will be accepted.${tail}`)) return;
  patchIncentive(p.id, { active: false });
}

function toggleSignup() {
  const p = currentIncentive('signup_domain');
  if (!p) return;
  if (!p.active) {
    const when = p.starts_at ? new Date(p.starts_at).toLocaleString() : 'its start date';
    if (!confirm(`Turn on “${p.name}”?\n\nStudents who sign up with a matching email address after ${when} will be paid automatically.`)) return;
    return patchIncentive(p.id, { active: true }, 'sb');
  }
  if (!confirm(`Turn off “${p.name}”?\n\nNew signups stop being paid. Nobody already paid is affected.`)) return;
  patchIncentive(p.id, { active: false }, 'sb');
}

function deleteCurrent(prefix, kind) {
  const p = currentIncentive(kind);
  if (!p) return;
  if (!confirm(`Delete “${p.name}”?\n\nIt has never paid anything out, so there is nothing to keep. This can’t be undone.`)) return;
  removeIncentive(p.id, prefix);
}

function deleteIncentive() { deleteCurrent('inc', 'referral'); }
function deleteSignupIncentive() { deleteCurrent('sb', 'signup_domain'); }

function deletePastIncentive(p) {
  if (!confirm(`Delete “${p.name}”?\n\nThis can’t be undone.`)) return;
  removeIncentive(p.id);
}

async function removeIncentive(id, prefix = 'inc') {
  $(`${prefix}-error`).hidden = true;
  try {
    const res = await authFetch(`/api/admin/incentives/${id}`, { method: 'DELETE' });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return showIncError(prefix, out.message);
    await loadIncentives();
  } catch {
    showIncError(prefix, 'No connection, try again.');
  }
}

/* ---------- referrals ---------- */

const REFERRAL_STATUS = {
  pending: ['Waiting', 'is-waiting'],
  paid: ['Paid', 'is-paid'],
  void: ['Void', 'is-void'],
};

function renderReferrals() {
  $('ref-error').hidden = true;
  refTools.paint();
}

// Rows only — see paintVendorRows for why the chrome isn't here.
function paintReferralRows(list) {
  const wrap = $('referral-list');
  wrap.innerHTML = '';
  list.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'referral-row';

    const [label, cls] = REFERRAL_STATUS[r.status] ?? ['Unknown', ''];
    const badge = document.createElement('span');
    badge.className = `referral-status ${cls}`;
    badge.textContent = label;

    const info = document.createElement('div');
    info.className = 'referral-info';

    const line = document.createElement('span');
    line.className = 'referral-people';
    // Built as three nodes rather than one string so neither address can be
    // read as markup, and so the arrow can be styled apart from the emails.
    const from = document.createElement('strong');
    from.textContent = r.referrer;
    const arrow = document.createElement('span');
    arrow.className = 'referral-arrow';
    arrow.textContent = ' invited ';
    const to = document.createElement('strong');
    to.textContent = r.friend;
    line.append(from, arrow, to);

    const meta = document.createElement('span');
    meta.className = 'app-meta';
    const bits = [`code ${r.code}`];
    bits.push(r.status === 'paid'
      ? `referrer paid ${num(r.referrerPoints)}`
      : `referrer owed ${num(r.referrerPoints)}`);
    // friendPoints is what they were promised; friendPaid is whether the ledger
    // actually has it. They differ exactly when a budget ran out mid-program.
    if (r.friendPoints > 0) {
      bits.push(r.friendPaid ? `friend paid ${num(r.friendPoints)}` : `friend bonus unpaid`);
    }
    meta.textContent = bits.join(' · ');

    info.append(line, meta);

    const when = document.createElement('span');
    when.className = 'app-when';
    when.textContent = new Date(r.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

    row.append(badge, info, when);
    wrap.appendChild(row);
  });
}

// The worker sweeps on its own timer; this is only so an operator watching the
// screen doesn't have to wait for it. The sweep is idempotent, so a double-tap
// costs a round trip and nothing else.
async function settleReferrals() {
  const btn = $('ref-settle-btn');
  $('ref-error').hidden = true;
  btn.disabled = true;
  btn.textContent = 'Settling…';
  try {
    const res = await authFetch('/api/admin/referrals/settle', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const el = $('ref-error');
      el.textContent = body.message || 'Couldn’t settle right now, try again.';
      el.hidden = false;
      return;
    }
    await Promise.all([loadReferrals(), loadIncentives(), loadGrants()]);
  } catch {
    const el = $('ref-error');
    el.textContent = 'No connection, try again.';
    el.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Settle now';
  }
}

/* ---------- manual grants + the payout ledger ---------- */

async function giveGrant(e) {
  e.preventDefault();
  const email = $('grant-email').value.trim();
  const points = $('grant-points').value.trim();
  const reason = $('grant-reason').value.trim();
  const err = $('grant-error');
  const ok = $('grant-ok');
  err.hidden = true;
  ok.hidden = true;

  if (!email || !points || !reason) {
    err.textContent = 'Fill in the email, the points, and what it is for.';
    err.hidden = false;
    return;
  }
  if (!confirm(`Give ${points} community points to ${email}?\n\nThis is immediate and there is no undo — you would have to work out a correction by hand.`)) return;

  $('grant-submit').disabled = true;
  try {
    const res = await authFetch('/api/admin/grants', {
      method: 'POST',
      body: JSON.stringify({ email, points: Number(points), reason }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      err.textContent = body.message || 'Couldn’t give those points.';
      err.hidden = false;
      return;
    }
    ok.textContent = `Gave ${num(body.points)} points to ${body.student}. Their balance is now ${num(body.newBalance)}.`;
    ok.hidden = false;
    $('grant-email').value = '';
    $('grant-points').value = '';
    $('grant-reason').value = '';
    await loadGrants();
  } catch {
    err.textContent = 'No connection, try again.';
    err.hidden = false;
  } finally {
    $('grant-submit').disabled = false;
  }
}

const GRANT_KINDS = {
  manual: 'By hand',
  referral_friend: 'Referral · friend',
  referral_referrer: 'Referral · referrer',
};

function renderGrants() {
  $('grants-error').hidden = true;
  grantTools.paint();
}

// Rows only — see paintVendorRows for why the chrome isn't here.
function paintGrantRows(list) {
  const wrap = $('grant-list');
  wrap.innerHTML = '';
  list.forEach((g) => {
    const row = document.createElement('div');
    row.className = 'grant-row';

    const pts = document.createElement('span');
    pts.className = 'grant-points';
    pts.textContent = `+${num(g.points)}`;

    const info = document.createElement('div');
    info.className = 'grant-info';
    const who = document.createElement('span');
    who.className = 'grant-student';
    who.textContent = g.student;
    const meta = document.createElement('span');
    meta.className = 'app-meta';
    const bits = [GRANT_KINDS[g.kind] ?? g.kind];
    if (g.reason) bits.push(g.reason);
    bits.push(g.grantedBy === 'system' ? 'automatic' : (g.grantedBy ?? 'unknown'));
    meta.textContent = bits.join(' · ');
    info.append(who, meta);

    const when = document.createElement('span');
    when.className = 'app-when';
    when.textContent = new Date(g.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

    row.append(pts, info, when);
    wrap.appendChild(row);
  });
}

/* ---------- web-push: new-application alerts ---------- */

// Runs once per page load, after admin access is confirmed. If notifications
// are already granted, silently (re-)subscribe — the server upserts, so
// repeating this every load just keeps the subscription fresh. If permission
// was never asked, reveal the 🔔 button: requestPermission() must run from a
// user gesture (Safari enforces this). Every other state stays visible too, so
// an operator can tell whether alerts are active, blocked or unavailable.
async function initPush() {
  if (pushInitDone) return;
  pushInitDone = true;
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return setPushButton('unsupported');
    }
    const res = await authFetch('/api/admin/push/public-key');
    if (!res.ok) throw new Error('The server could not load notification settings.');
    vapidKey = (await res.json())?.publicKey ?? null;
    if (!vapidKey) return setPushButton('unsupported');
    // Only 'default' is actionable: 'granted' silently re-subscribes; 'denied'
    // can't be re-prompted (requestPermission would no-op), so we stay quiet.
    if (Notification.permission === 'granted') {
      await subscribePush();
      setPushButton('active');
    }
    else if (Notification.permission === 'default') {
      setPushButton('enable');
      // Louder one-time nudge — suppressed once the operator has said "Not now".
      let dismissed = false;
      try { dismissed = !!localStorage.getItem(PUSH_DISMISS_KEY); } catch { /* private mode */ }
      if (!dismissed) openPushModal();
    } else {
      setPushButton('blocked');
    }
  } catch (err) {
    showPushFailure(err?.message || 'Alerts could not be connected.');
  }
}

// The prominent popup and the topbar 🔔 button both call this. requestPermission()
// must run from the user gesture, so it's the first thing awaited. Whatever the
// outcome is reflected in the persistent topbar control, so a failed enrollment
// can never look like success.
async function enablePush() {
  $('push-error').hidden = true;
  try {
    if (Notification.permission === 'denied') {
      setPushButton('blocked');
      return showPushFailure('Notifications are blocked for this site. Allow them in your browser or device settings, then retry.', true);
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      setPushButton(perm === 'denied' ? 'blocked' : 'enable');
      closePushModal();
      return;
    }
    await subscribePush();
    setPushButton('active');
    closePushModal();
  } catch (err) {
    showPushFailure(err?.message || 'Alerts could not be connected. Try again.', true);
  }
}

function setPushButton(mode) {
  const btn = $('push-btn');
  btn.dataset.pushMode = mode;
  btn.hidden = false;
  btn.disabled = mode === 'unsupported';
  if (mode === 'active') {
    btn.textContent = '🔔 Test alerts';
    btn.title = 'Send a test notification to this device';
  } else if (mode === 'blocked') {
    btn.textContent = '🔕 Alerts blocked';
    btn.title = 'Notifications are blocked in this browser';
  } else if (mode === 'failed') {
    btn.textContent = '⚠ Fix alerts';
    btn.title = 'Notifications are not connected';
  } else if (mode === 'enable') {
    btn.textContent = '🔔 Turn on alerts';
    btn.title = 'Get application and error notifications';
  } else if (mode === 'unsupported') {
    btn.textContent = '🔕 Alerts unavailable';
    btn.title = 'Push notifications are not available on this device or server';
  }
}

function handlePushButton() {
  const mode = $('push-btn').dataset.pushMode;
  if (mode === 'active') return sendPushTest();
  if (mode === 'blocked') {
    return showPushFailure('Notifications are blocked for this site. Allow them in your browser or device settings, then retry.', true);
  }
  return enablePush();
}

function showPushFailure(message, open = false) {
  setPushButton(Notification.permission === 'denied' ? 'blocked' : 'failed');
  const error = $('push-error');
  error.textContent = message;
  error.hidden = false;
  if (open) openPushModal();
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
  // Register this exact worker instead of relying on navigator.serviceWorker.ready,
  // which can resolve to another registration when the dashboard is opened from
  // an unusual URL. Also recover cleanly after a VAPID key rotation.
  const reg = await navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' });
  const desiredKey = urlBase64ToUint8Array(vapidKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !subscriptionUsesKey(sub, desiredKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: desiredKey,
    });
  }
  const { endpoint, keys } = sub.toJSON();
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error('The browser returned an incomplete push subscription.');
  }
  const res = await authFetch('/api/admin/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint, keys }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.message || 'The server could not save this notification subscription.');
  pushEndpoint = endpoint;
  return endpoint;
}

function subscriptionUsesKey(subscription, desiredKey) {
  const stored = subscription.options?.applicationServerKey;
  if (!stored) return true; // older engines do not expose it; keep their live subscription
  const bytes = new Uint8Array(stored);
  return bytes.length === desiredKey.length && bytes.every((value, i) => value === desiredKey[i]);
}

async function sendPushTest() {
  const btn = $('push-btn');
  btn.disabled = true;
  try {
    const endpoint = pushEndpoint || await subscribePush();
    const res = await authFetch('/api/admin/push/test', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.message || 'The test notification was not delivered.');
    btn.textContent = '✓ Test sent';
    setTimeout(() => setPushButton('active'), 2500);
  } catch (err) {
    await discardBrowserPush();
    showPushFailure(err?.message || 'The test notification was not delivered.', true);
  } finally {
    btn.disabled = false;
  }
}

async function discardBrowserPush() {
  pushEndpoint = null;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/admin/');
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch { /* the next retry still has a chance to replace it */ }
}

// Standard VAPID key decoder: base64url → the Uint8Array PushManager expects.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/* ---------- scan-here QR poster ---------- */
// One file for the whole platform: published here, downloaded by every vendor
// terminal from its Settings tab and printed for the counter. Kept in a private
// Supabase Storage bucket (src/lib/qr-poster.js) — the browser never talks to
// storage directly, both ways go through /api/admin/qr-poster.

const POSTER_MAX_BYTES = 10 * 1024 * 1024;          // keep in sync with src/lib/qr-poster.js
const POSTER_TYPES = /\.(zip|pdf|png|jpe?g|webp)$/i; // …and with its TYPES table

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function posterError(msg) {
  const el = $('poster-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

async function loadPoster() {
  const res = await authFetch('/api/admin/qr-poster');
  if (res.status === 403) return denyAccess();
  if (!res.ok) {
    // Say so rather than leaving the card's default "Nothing published yet" up:
    // that would read as "terminals have no poster", which we don't know.
    posterError('Couldn’t check the published poster. Hit ↻ to try again.');
    return;
  }
  const d = await res.json().catch(() => ({}));
  poster = d.poster ?? null;
  renderPoster();
}

// Three states, one renderer: nothing published, something published, or a file
// chosen and waiting for Publish. The pending state deliberately hides Download
// and Remove — they'd act on the OLD file while the name on screen is the new one.
function renderPoster() {
  const show = (id, on) => { $(id).hidden = !on; };

  if (pendingPoster) {
    $('poster-name').textContent = pendingPoster.name;
    $('poster-meta').textContent = `${fmtBytes(pendingPoster.size)} · not published yet`;
    $('poster-state').textContent = poster ? 'Will replace the live file' : 'Ready to publish';
  } else if (poster) {
    $('poster-name').textContent = poster.name;
    $('poster-meta').textContent = [
      fmtBytes(poster.size),
      poster.updatedAt
        ? `published ${new Date(poster.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : '',
    ].filter(Boolean).join(' · ');
    $('poster-state').textContent = 'Live on every terminal';
  } else {
    $('poster-name').textContent = 'Nothing published yet';
    $('poster-meta').textContent = 'Terminals see no download until you publish a file.';
    $('poster-state').textContent = '';
  }

  $('poster-pick').textContent = poster || pendingPoster ? 'Choose a different file' : 'Choose file';
  show('poster-upload', !!pendingPoster);
  show('poster-cancel', !!pendingPoster);
  show('poster-download', !!poster && !pendingPoster);
  show('poster-remove', !!poster && !pendingPoster);
}

function onPosterPick(e) {
  const file = e.target.files?.[0];
  e.target.value = '';                 // let the same file be re-picked later
  if (!file) return;
  posterError('');
  if (!POSTER_TYPES.test(file.name)) {
    posterError('Use a ZIP, PDF, PNG, JPG or WEBP file.');
    return;
  }
  if (file.size > POSTER_MAX_BYTES) {
    posterError(`That file is too large (${fmtBytes(file.size)}). The limit is 10 MB.`);
    return;
  }
  pendingPoster = file;
  renderPoster();
}

/** File → base64 data URL, which is how the JSON-only API takes binary. */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

async function publishPoster() {
  if (!pendingPoster) return;
  const btn = $('poster-upload');
  btn.disabled = true;
  btn.textContent = 'Publishing…';
  posterError('');
  try {
    const data = await fileToDataUrl(pendingPoster);
    const res = await authFetch('/api/admin/qr-poster', {
      method: 'PUT',
      body: JSON.stringify({ filename: pendingPoster.name, data }),
    });
    if (res.status === 403) return denyAccess();
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      posterError(d.message || 'Couldn’t publish that file. Try again.');
      return;
    }
    poster = d.poster ?? null;
    pendingPoster = null;
    renderPoster();
  } catch {
    posterError('Couldn’t publish that file. Check the connection and try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Publish';
  }
}

// Same bytes a terminal gets, so the operator can check what they published.
// Streamed through the API (the bucket is private), so it needs the auth header
// — which rules out a plain link and makes this a fetch + object URL.
async function downloadPoster() {
  const btn = $('poster-download');
  btn.disabled = true;
  posterError('');
  try {
    const res = await authFetch('/api/admin/qr-poster/file');
    if (res.status === 403) return denyAccess();
    if (!res.ok) {
      posterError('Couldn’t download that file. Try again.');
      return;
    }
    saveBlob(await res.blob(), poster?.name || 'werewards-qr-poster');
  } catch {
    posterError('Couldn’t download that file. Check the connection and try again.');
  } finally {
    btn.disabled = false;
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked late: Safari can still be reading the blob when the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function removePoster() {
  if (!confirm('Remove the QR poster? Terminals will have nothing to download until you publish another one.')) return;
  const btn = $('poster-remove');
  btn.disabled = true;
  posterError('');
  try {
    const res = await authFetch('/api/admin/qr-poster', { method: 'DELETE' });
    if (res.status === 403) return denyAccess();
    if (!res.ok) {
      posterError('Couldn’t remove that file. Try again.');
      return;
    }
    poster = null;
    renderPoster();
  } catch {
    posterError('Couldn’t remove that file. Check the connection and try again.');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- students ---------- */

// The roster behind the Students tile: a drill-in screen, not a tab. Search and
// paging are BOTH server-side — the student an operator is hunting for is
// usually not on the loaded page, so filtering what happens to be in memory
// would answer "no such student" for someone who exists.
const STUDENT_PAGE = 100;
const STUDENT_SEARCH_DEBOUNCE = 250;

let students = [];
let studentsTotal = 0;
let studentQuery = '';
let studentSearchTimer = null;
// Every request carries a sequence number and a reply that isn't the newest is
// dropped. Without it, a slower earlier query can land last and leave the list
// showing results for a term the operator has already finished deleting.
let studentReqSeq = 0;

function openStudents() {
  setView('students');
  if (!students.length && !studentQuery) loadStudents({ reset: true });
  $('student-q').focus();
}

const studentDate = (iso) => (iso
  ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
  : '');
const studentWhen = (iso) => (iso
  ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  : '');

function onStudentSearch() {
  clearTimeout(studentSearchTimer);
  studentSearchTimer = setTimeout(() => {
    const next = $('student-q').value.trim();
    if (next === studentQuery) return;
    studentQuery = next;
    $('student-q-clear').hidden = !studentQuery;
    loadStudents({ reset: true });
  }, STUDENT_SEARCH_DEBOUNCE);
}

function clearStudentSearch() {
  $('student-q').value = '';
  $('student-q-clear').hidden = true;
  studentQuery = '';
  loadStudents({ reset: true });
  $('student-q').focus();
}

async function loadStudents({ reset = false } = {}) {
  const seq = ++studentReqSeq;
  const offset = reset ? 0 : students.length;
  $('students-error').hidden = true;
  $('students-more').disabled = true;
  try {
    const q = studentQuery ? `&q=${encodeURIComponent(studentQuery)}` : '';
    const res = await authFetch(`/api/admin/students?limit=${STUDENT_PAGE}&offset=${offset}${q}`);
    if (res.status === 403) return denyAccess();
    if (!res.ok) throw new Error(`students ${res.status}`);
    const d = await res.json();
    if (seq !== studentReqSeq) return;              // a newer search already won
    students = reset ? (d.students ?? []) : students.concat(d.students ?? []);
    studentsTotal = d.total ?? students.length;
    renderStudents();
  } catch {
    if (seq !== studentReqSeq) return;
    $('students-error').textContent = 'Couldn’t load students. Check your connection and try again.';
    $('students-error').hidden = false;
  } finally {
    $('students-more').disabled = false;
  }
}

// Names and emails are whatever Google handed us, i.e. untrusted text, so every
// row is built with DOM APIs and textContent (same rule as renderApplications).
function renderStudents() {
  const wrap = $('student-list');
  wrap.innerHTML = '';
  $('students-count').textContent = studentQuery
    ? `${num(studentsTotal)} matching`
    : `${num(studentsTotal)} total`;

  if (!students.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = studentQuery ? 'No student matches that search.' : 'No students yet.';
    wrap.appendChild(p);
    $('students-more').hidden = true;
    return;
  }

  students.forEach((s) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'student-row';

    const info = document.createElement('span');
    info.className = 'student-info';
    const name = document.createElement('span');
    name.className = 'student-name';
    name.textContent = s.name || s.email || 'Unnamed student';
    const meta = document.createElement('span');
    meta.className = 'student-meta';
    meta.textContent = s.email || 'No email on file';
    // Everything wordy lives in this column, which is the one allowed to shrink
    // and ellipsize. The right-hand column is a number and nothing else: giving
    // it a text line made the row unshrinkable and overflowed a 360px phone.
    // Community points are a separate pool, so they're named, not summed in.
    const facts = document.createElement('span');
    facts.className = 'student-meta';
    facts.textContent = [
      s.spots ? `${num(s.spots)} spot${s.spots === 1 ? '' : 's'}` : 'no balances',
      s.community ? `${num(s.community)} community` : null,
      `joined ${studentDate(s.createdAt)}`,
    ].filter(Boolean).join(' · ');
    info.append(name, meta, facts);

    const pts = document.createElement('span');
    pts.className = 'student-pts';
    pts.textContent = `${num(s.points)} pts`;

    row.append(info, pts);
    row.addEventListener('click', () => openStudentDetail(s));
    wrap.appendChild(row);
  });

  const left = studentsTotal - students.length;
  $('students-more').hidden = left <= 0;
  $('students-more').textContent = `Show more (${num(left)} left)`;
}

/* ----- one student's card ----- */

function closeStudentDetail() {
  $('student-modal').hidden = true;
}

async function openStudentDetail(s) {
  $('student-detail-title').textContent = s.name || s.email || 'Student';
  $('student-detail-sub').textContent = s.email && s.name ? s.email : '';
  $('student-detail-error').hidden = true;
  $('student-detail-body').innerHTML = '';
  $('student-modal').hidden = false;
  $('student-detail-close').focus();

  try {
    const res = await authFetch(`/api/admin/students/${encodeURIComponent(s.id)}`);
    if (res.status === 403) return denyAccess();
    if (!res.ok) throw new Error(`student ${res.status}`);
    renderStudentDetail(await res.json());
  } catch {
    $('student-detail-error').textContent = 'Couldn’t load this student. Check your connection and try again.';
    $('student-detail-error').hidden = false;
  }
}

// Small builders, local to this dialog: everything below is untrusted text.
const sdEl = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function sdSection(title) {
  const box = sdEl('div', 'sd-section');
  box.appendChild(sdEl('p', 'sd-title', title));
  return box;
}

// label + value pair, the shape used for both the stat grid and the list rows
function sdRow(label, value, cls) {
  const row = sdEl('div', `sd-row${cls ? ` ${cls}` : ''}`);
  row.append(sdEl('span', 'sd-label', label), sdEl('span', 'sd-value', value));
  return row;
}

function renderStudentDetail(d) {
  const body = $('student-detail-body');
  body.innerHTML = '';
  const t = d.totals ?? {};

  $('student-detail-sub').textContent = [
    d.student?.email,
    d.student?.joinedAt ? `joined ${studentDate(d.student.joinedAt)}` : null,
  ].filter(Boolean).join(' · ');

  // headline numbers
  const stats = sdEl('div', 'sd-stats');
  [
    ['Points', num(t.points)],
    ['Community', num(t.community)],
    ['Visits', num(t.visits)],
    ['Spend', money(t.spend)],
    ['Awards', num(t.awards)],
    ['Redemptions', num(t.redemptions)],
  ].forEach(([label, value]) => {
    const cell = sdEl('div', 'sd-stat');
    cell.append(sdEl('span', 'sd-stat-num', value), sdEl('span', 'sd-stat-label', label));
    stats.appendChild(cell);
  });
  body.appendChild(stats);
  if (t.truncated) {
    body.appendChild(sdEl('p', 'muted', 'Lifetime totals cover this student’s most recent 500 transactions.'));
  }

  // per-spot points and visits
  const spots = sdSection('By spot');
  if (!(d.spots ?? []).length) {
    spots.appendChild(sdEl('p', 'muted', 'No points or visits anywhere yet.'));
  } else {
    d.spots.forEach((s) => {
      // A pooled location's points are the CHAIN's points, and the server prints
      // that same figure on every member row on purpose. Say so, or three rows
      // reading "420 pts" look like 1,260 points across three separate piles —
      // on the exact screen an operator opens when a customer is on the phone
      // asking where their points went.
      const parts = [`${num(s.points)} pts${s.shared ? ' shared' : ''}`];
      if (s.visits) parts.push(`${num(s.visits)} visit${s.visits === 1 ? '' : 's'}`);
      const row = sdRow(s.vendor + (s.vendorActive ? '' : ' (off)'), parts.join(' · '));
      if (!s.vendorActive) row.classList.add('is-off');
      if (s.shared) {
        row.classList.add('is-shared');
        // Which purse, so two different chains in one list stay distinguishable.
        row.title = s.poolLabel
          ? `Shared points: one balance across every ${s.poolLabel} spot`
          : 'Shared points: one balance across this owner’s spots';
      }
      spots.appendChild(row);
    });
  }
  body.appendChild(spots);

  // recent activity
  const recent = sdSection('Recent activity');
  if (!(d.recent ?? []).length) {
    recent.appendChild(sdEl('p', 'muted', 'Nothing yet.'));
  } else {
    d.recent.forEach((r) => {
      const what = r.type === 'earn'
        ? `Earned ${num(r.points)} at ${r.vendor ?? 'a spot'}${r.dollarAmount ? ` on ${money(r.dollarAmount)}` : ''}`
        : `Redeemed ${r.reward ? r.reward : `${num(-r.points)} pts`} at ${r.vendor ?? 'a spot'}`;
      recent.appendChild(sdRow(what, studentWhen(r.createdAt), 'sd-row-wrap'));
    });
  }
  body.appendChild(recent);

  // referral position, both directions
  const ref = sdSection('Referrals');
  const by = d.referral?.referredBy;
  ref.appendChild(sdRow('Referred by', by ? `${by.name || 'a student'} (${by.status})` : 'Nobody'));
  const made = d.referral?.made ?? [];
  ref.appendChild(sdRow('Friends referred', made.length ? String(made.length) : 'None'));
  made.slice(0, 10).forEach((m) => {
    ref.appendChild(sdRow(m.name || 'A student', `${m.status} · ${studentDate(m.at)}`, 'sd-row-sub'));
  });
  body.appendChild(ref);

  // account state
  const acct = sdSection('Account');
  const alerts = d.alerts ?? {};
  acct.appendChild(sdRow('Deal alerts',
    alerts.optIn === null ? 'Never set' : alerts.optIn ? 'On' : 'Off'));
  acct.appendChild(sdRow('Devices subscribed', num(alerts.subscriptions)));
  if (alerts.lastPushAt) acct.appendChild(sdRow('Last push', studentWhen(alerts.lastPushAt)));
  acct.appendChild(sdRow('Terms accepted',
    d.terms ? `${d.terms.version} · ${studentDate(d.terms.acceptedAt)}` : 'Not accepted'));
  acct.appendChild(sdRow('User id', d.student?.id ?? '', 'sd-row-id'));
  body.appendChild(acct);
}

/* ---------- error log ---------- */

function setErrorSource(src) {
  errorSource = src || '';
  document.querySelectorAll('.err-filter').forEach((b) =>
    b.classList.toggle('is-active', (b.dataset.src || '') === errorSource));
  loadErrors();   // a different source is a different log: start from its top
}

// One page of the log. 100 rows is what this dashboard has always loaded; what
// is new is that there is now a way to ask for the next 100 rather than being
// silently capped at whatever the newest page happened to hold.
const ERROR_PAGE = 100;
let errorReqSeq = 0;

async function loadErrors({ append = false } = {}) {
  const seq = ++errorReqSeq;
  const offset = append ? errors.length : 0;
  const src = errorSource ? `&source=${encodeURIComponent(errorSource)}` : '';
  try {
    const res = await authFetch(`/api/admin/errors?limit=${ERROR_PAGE}&offset=${offset}${src}`);
    if (res.status === 403) { denyAccess(); return false; }  // safety net; overview already gates
    if (!res.ok) throw new Error(`errors ${res.status}`);
    const d = await res.json();
    // Dropped if the operator switched source (or hit refresh) while this was in
    // flight — otherwise a page of "vendor" errors appends to the "server" list.
    if (seq !== errorReqSeq) return false;
    errors = append ? appendPage(errors, d.errors) : (d.errors ?? []);
    errorsTotal = d.total ?? errors.length;
    renderErrors();
    return true;
  } catch {
    if (seq !== errorReqSeq) return false;
    showListError('errors-error', 'Couldn’t load the error log. Check your connection and try again.');
    return false;
  }
}

/* What a failing request was FOR, in the operator's language. A row that reads
   "POST /api/vendor/redeem" tells you nothing unless you already know the
   codebase; "Terminal · redeeming a reward" is answerable from the dashboard.
   Matched against the path with ids normalised out, longest-specific first
   (/deals/read before /deals, /redeem-preview before /redeem). */
const ERROR_ACTIONS = [
  // student app → /api/me/*
  [/^\/api\/me\/balances/,           'Student app · loading points and rewards'],
  [/^\/api\/me\/consent/,            'Student app · checking terms acceptance'],
  [/^\/api\/me\/accept-terms/,       'Student · accepting the terms'],
  [/^\/api\/me\/decline/,            'Student · declining the terms (account wipe)'],
  [/^\/api\/me\/punch/,              'Student · counting a visit'],
  [/^\/api\/me\/receipt/,            'Student · scanning a receipt for points'],
  [/^\/api\/me\/earn-code/,          'Student · showing their code at the counter'],
  [/^\/api\/me\/redeem-code/,        'Student · starting a reward redemption'],
  [/^\/api\/me\/tier/,               'Student app · loading tier progress'],
  [/^\/api\/me\/community-transfer/, 'Student · moving community points to a spot'],
  [/^\/api\/me\/community/,          'Student app · loading community points'],
  [/^\/api\/me\/referral/,           'Student · invite code (loading or entering one)'],
  [/^\/api\/me\/history/,            'Student app · loading transaction history'],
  [/^\/api\/me\/deals\/(read|open)/, 'Student · opening a deal'],
  [/^\/api\/me\/deals/,              'Student app · loading deals'],
  [/^\/api\/me\/push/,               'Student · push notification subscription'],
  [/^\/api\/me\/notify/,             'Student · notification settings'],
  [/^\/api\/me\/export/,             'Student · exporting their data'],
  [/^\/api\/me\/delete/,             'Student · deleting their account'],
  // vendor terminal → /api/vendor/*
  [/^\/api\/vendor\/recover/,        'Vendor · password recovery (locked out)'],
  [/^\/api\/vendor\/config/,         'Terminal · signing in / loading its setup'],
  [/^\/api\/vendor\/punch-token/,    'Terminal · refreshing the rotating visit code'],
  [/^\/api\/vendor\/scan/,           'Terminal · scanning a customer code'],
  [/^\/api\/vendor\/award/,          'Terminal · awarding points for a purchase'],
  [/^\/api\/vendor\/redeem-preview/, 'Terminal · previewing a redemption'],
  [/^\/api\/vendor\/redeem/,         'Terminal · redeeming a reward'],
  [/^\/api\/vendor\/reverse/,        'Terminal · undoing a transaction'],
  [/^\/api\/vendor\/visit-impact/,   'Terminal · visits analytics'],
  [/^\/api\/vendor\/rewards/,        'Terminal · editing reward items'],
  [/^\/api\/vendor\/verify-pin/,     'Terminal · staff PIN check'],
  [/^\/api\/vendor\/recent/,         'Terminal · loading recent activity'],
  [/^\/api\/vendor\/analytics/,      'Terminal · loading the STATS tab'],
  [/^\/api\/vendor\/campaigns/,      'Terminal · deals (sending or loading)'],
  [/^\/api\/vendor\/settings/,       'Terminal · loading or saving settings'],
  [/^\/api\/vendor\/qr-poster/,      'Terminal · downloading the scan-here QR poster'],
  // operator dashboard → /api/admin/*
  [/^\/api\/admin\/overview/,        'Admin · loading platform stats'],
  [/^\/api\/admin\/vendors\/[^/]+\/rewards/, 'Admin · editing a vendor’s rewards'],
  [/^\/api\/admin\/vendors\/[^/]+\/reset-code/, 'Admin · minting a vendor password-reset code'],
  [/^\/api\/admin\/vendors\/[^/]+\/logo/, 'Admin · loading a vendor’s logo'],
  [/^\/api\/admin\/vendors/,         'Admin · adding, editing or removing a vendor'],
  [/^\/api\/admin\/applications/,    'Admin · vendor applications'],
  [/^\/api\/admin\/incentives/,      'Admin · signup / referral incentives'],
  [/^\/api\/admin\/referrals/,       'Admin · referral payouts'],
  [/^\/api\/admin\/grants/,          'Admin · granting community points'],
  [/^\/api\/admin\/qr-poster/,       'Admin · the scan-here QR poster file'],
  [/^\/api\/admin\/push/,            'Admin · alert notifications'],
  [/^\/api\/admin\/errors/,          'Admin · this error log'],
  // public / shared
  [/^\/api\/apply/,                  'Public /join page · a vendor applying'],
  [/^\/api\/punch/,                  'Phone-camera visit scan (sign-in handoff)'],
  [/^\/api\/vendor-logo/,            'Serving a vendor logo image'],
  [/^\/api\/public-config/,          'App boot · public config'],
  [/^\/api\/client-(error|event)/,   'A client reporting its own crash'],
  [/^\/api\/health/,                 'Uptime health check'],
  // client rows carry a PAGE url, not an API path
  [/^\/terminal/,                    'Vendor terminal app'],
  [/^\/admin/,                       'Operator dashboard'],
  [/^\/scan/,                        'Backup scan screen (older iPads)'],
  [/^\/join/,                        'Public vendor application page'],
  [/^\/legal/,                       'Terms / privacy document'],
  [/^\/(index\.html)?$/,             'Student app'],
];

// uuids and numeric ids collapse to placeholders so one label covers every row.
function normalizeErrPath(path) {
  return String(path || '').split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:n');
}

function describeAction(e) {
  const p = normalizeErrPath(e.path);
  if (!p) return null;
  const hit = ERROR_ACTIONS.find(([re]) => re.test(p));
  return hit ? hit[1] : null;
}

// Rough but useful: which browser on which device. The full UA string is still
// shown underneath, so a wrong guess costs nothing.
function describeDevice(ua) {
  if (!ua) return null;
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /CriOS\//.test(ua) ? 'Chrome (iOS)'
    : /FxiOS\//.test(ua) ? 'Firefox (iOS)'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : null;
  const version = (/(?:Version|Edg|OPR|CriOS|FxiOS|Firefox|Chrome)\/(\d+)/.exec(ua) || [])[1];
  const os =
    /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  const parts = [browser && version ? `${browser} ${version}` : browser, os].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

// "4 minutes ago" reads faster than a timestamp when you're scanning for what
// just broke; the exact time is right next to it.
function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function describeActor(actor) {
  if (!actor) return 'Signed out (or before sign-in)';
  const role = actor.role === 'vendor' ? (actor.vendor ? `vendor · ${actor.vendor}` : 'vendor staff')
    : actor.role === 'admin' ? 'operator'
    : actor.role === 'student' ? 'student'
    : 'unknown account';
  const who = actor.email || actor.name || actor.id;
  return `${who} — ${role}`;
}

/** One <dt>/<dd> pair, skipped entirely when there's nothing to say. */
function fact(label, value, cls) {
  if (!value) return '';
  return `<div class="err-fact${cls ? ` ${cls}` : ''}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function renderErrors() {
  $('errors-error').hidden = true;
  errorTools.paint();
}

// Rows only — see paintVendorRows for why the chrome isn't here.
function paintErrorRows(items) {
  const wrap = $('error-list');
  // How often the same failure appears in what is on screen. One row saying
  // "×14" is the difference between a fluke and something actively broken.
  // Counted over the rows being shown, so the number keeps matching the card's
  // own wording ("×N marks a failure that appears more than once in this view")
  // when a filter is narrowing the view.
  const repeats = new Map();
  items.forEach((e) => {
    const k = `${e.source}|${e.message}`;
    repeats.set(k, (repeats.get(k) ?? 0) + 1);
  });

  wrap.innerHTML = '';
  items.forEach((e) => {
    const when = new Date(e.created_at);
    const shortWhen = when.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const fullWhen = when.toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit',
    });
    const action = describeAction(e);
    const where = [e.method, e.path].filter(Boolean).join(' ');
    const count = repeats.get(`${e.source}|${e.message}`) ?? 1;
    const ctx = e.context && typeof e.context === 'object' ? { ...e.context } : null;
    // Two context fields graduate to their own labelled rows — they answer
    // "where in the app" and "which page" better than a JSON blob does.
    const screen = ctx?.screen || ctx?.tab || ctx?.view || null;
    const referer = ctx?.referer || null;
    if (ctx) { delete ctx.referer; delete ctx.actorEmail; delete ctx.actorId; }

    const row = document.createElement('details');
    row.className = 'err-row';
    row.innerHTML = `
      <summary>
        <span class="err-badge err-${escapeHtml(e.source)}">${escapeHtml(e.source)}</span>
        <span class="err-lines">
          <span class="err-msg">${escapeHtml(e.message)}</span>
          <span class="err-sub">${escapeHtml(action || where || 'unknown request')}${
            e.status ? ` · ${escapeHtml(String(e.status))}` : ''
          }${e.actor?.email ? ` · ${escapeHtml(e.actor.email)}` : ''}</span>
        </span>
        ${count > 1 ? `<span class="err-count" title="${count} of these in the log">×${count}</span>` : ''}
        <span class="err-when" title="${escapeHtml(fullWhen)}">${escapeHtml(shortWhen)}</span>
        <button class="err-del" type="button" title="Delete this error" aria-label="Delete this error">×</button>
      </summary>
      <div class="err-detail">
        <dl class="err-facts">
          ${fact('What broke', e.message, 'err-fact-wide')}
          ${fact('What it was for', action)}
          ${fact('Request', `${where || 'unknown'}${e.status ? ` → ${e.status}` : ''}`)}
          ${fact('Who', describeActor(e.actor))}
          ${fact('Where in the app', screen)}
          ${fact('Page', referer)}
          ${fact('When', `${fullWhen} · ${relTime(e.created_at)}`)}
          ${fact('Device', describeDevice(e.user_agent))}
          ${fact('Seen', count > 1 ? `${count} times in this view` : 'once in this view')}
        </dl>
        ${ctx && Object.keys(ctx).length
          ? `<div class="err-block"><h4>What the request carried</h4><pre>${escapeHtml(JSON.stringify(ctx, null, 2))}</pre></div>`
          : ''}
        ${e.stack ? `<div class="err-block"><h4>Stack</h4><pre>${escapeHtml(e.stack)}</pre></div>` : ''}
        ${e.user_agent ? `<div class="err-block"><h4>User agent</h4><pre>${escapeHtml(e.user_agent)}</pre></div>` : ''}
        <div class="err-actions">
          <button class="err-copy btn-ghost btn-compact" type="button">Copy details</button>
          <span class="err-id">${escapeHtml(e.id)}</span>
        </div>
      </div>`;
    row.querySelector('.err-del').addEventListener('click', (ev) => deleteError(e.id, row, ev));
    row.querySelector('.err-copy').addEventListener('click', (ev) => copyErrorDetail(e, ev));
    wrap.appendChild(row);
  });
}

// Everything about one error as plain text, for pasting into a bug report or a
// message to whoever owns the failing code.
async function copyErrorDetail(e, ev) {
  const btn = ev.currentTarget;
  const text = [
    `[${e.source}] ${e.message}`,
    `What it was for: ${describeAction(e) || 'unknown'}`,
    `Request: ${[e.method, e.path].filter(Boolean).join(' ') || 'unknown'}${e.status ? ` → ${e.status}` : ''}`,
    `Who: ${describeActor(e.actor)}`,
    `When: ${new Date(e.created_at).toISOString()}`,
    `Device: ${describeDevice(e.user_agent) || 'unknown'} — ${e.user_agent || 'no user agent'}`,
    e.context ? `Context: ${JSON.stringify(e.context, null, 2)}` : '',
    e.stack ? `Stack:\n${e.stack}` : '',
    `Log id: ${e.id}`,
  ].filter(Boolean).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Press ⌘/Ctrl+C';
  }
  setTimeout(() => { btn.textContent = 'Copy details'; }, 2000);
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
    // Drop it from the loaded page and the DOM. The row is removed rather than
    // the list repainted so that any other row the operator has expanded stays
    // open; the total comes down with it so "Show more (N left)" stays honest.
    errors = errors.filter((x) => x.id !== id);
    errorsTotal = Math.max(0, errorsTotal - 1);
    row.remove();
    refreshErrorCard();                                 // keep the top tile in sync
    if (errorTools.visible().length) errorTools.refresh();
    // Dismissing the last LOADED row while the log still has rows behind it
    // refills from the top, as this did before it was paged: otherwise the card
    // would read "No errors logged" directly above a live "Show more (N left)".
    // A filter hiding the rest is a different thing, and falls through to the
    // repaint so it can say so.
    else if (!errors.length && errorsTotal > 0) loadErrors();
    else renderErrors();
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

// Which tab was open when the dashboard itself crashed — the same "what was it
// for" the rows above show for everyone else's errors. Never throws.
function crashContext(extra) {
  const ctx = { ...extra };
  try {
    ctx.view = VIEWS.find((v) => !$(`view-${v}`)?.hidden) ?? null;
    ctx.online = navigator.onLine;
  } catch { /* report what we have */ }
  return ctx;
}

// Module scope rather than a closure inside installErrorReporter(), because
// boot() files one of these by hand when it finds a script missing (see there).
//
// Plain fetch, not authFetch: this now runs before boot() has built `sb`, and
// authFetch dereferences it unconditionally. /api/client-error is
// unauthenticated anyway (the token is only ever used to attribute a report to
// a user), so an anonymous post is a slightly thinner row, not a lost one.
async function reportClientError(message, stack, context) {
  let auth = {};
  try {
    const { data } = (await sb?.auth?.getSession?.()) ?? {};
    if (data?.session) auth = { Authorization: `Bearer ${data.session.access_token}` };
  } catch { /* not signed in yet */ }
  fetch('/api/client-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ source: 'admin', message, stack, url: location.pathname, context: crashContext(context) }),
  }).catch(() => {});
}

// An error thrown inside a CROSS-ORIGIN script reaches this handler stripped to
// the bare string "Script error." with line 0, column 0 and no `error` object:
// browsers will not leak another origin's source, and there is no way to opt
// back in from this side. Every script this page loads is same-origin, so one of
// these is never our code — it is a content blocker, an extension, or an in-app
// browser's injected wrapper throwing in its own script. The report would carry
// no message, no file, no line and no stack, which in this very dashboard is a
// row that can only ever be read and closed again, so it is dropped rather than
// filed.
//
// If our own bundles ever move to another origin (a CDN host), their real
// errors would start arriving looking exactly like this — the fix then is
// crossorigin="anonymous" on the tags plus Access-Control-Allow-Origin on the
// responses, NOT loosening the test below.
const isOpaqueCrossOriginError = (e) => /^script error\.?$/i.test(e.message || '') && !e.error;

function installErrorReporter() {
  window.addEventListener('error', (e) => {
    if (isOpaqueCrossOriginError(e)) return;
    reportClientError(e.message || 'error', e.error?.stack, { line: e.lineno, col: e.colno });
  });
  window.addEventListener('unhandledrejection', (e) =>
    reportClientError(String(e.reason?.message || e.reason || 'unhandledrejection'), e.reason?.stack));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ===================== Trackable QR codes (migration-050) =====================
   The operator's half of the poster feature: make a code, print its QR onto a
   banner, read the traffic back. The award itself is decided server-side at
   signup — nothing here can pay anybody, which is why every control below is
   safe to fiddle with except the award amount on a banner already on a wall.

   ⚠ Sibling of the scan-here poster card above and unrelated to it. */

let qrCodes = [];
// Set on the first successful load. Same bargain as poolsLoaded: boot does not
// pay for a tab nobody has opened, but once opened, ↻ refreshes it like
// everything else on screen.
let qrLoaded = false;
// Open detail panels, keyed by code id, holding the fetched series or 'loading'.
// A Map rather than a flag on the node, for the same reason the pool settlement
// panel does it: every mutation repaints the whole list and would destroy it.
const qrOpen = new Map();

function qrError(msg) {
  const el = $('qr-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

function qrOkMsg(msg) {
  const el = $('qr-ok');
  el.textContent = msg || '';
  el.hidden = !msg;
}

/** The URL the printed QR encodes. Built from where the dashboard itself is
 *  served, so staging prints staging links and production prints production
 *  ones, with nothing to configure and nothing to get wrong. */
const qrUrl = (code) => `${location.origin}/r/${code}`;

async function loadQrCodes() {
  try {
    const res = await authFetch('/api/admin/tracked-qr');
    if (res.status === 403) return denyAccess();
    if (!res.ok) {
      qrError('Couldn’t load the QR codes. Hit ↻ to try again.');
      return;
    }
    const d = await res.json().catch(() => ({}));
    qrCodes = d.codes ?? [];
    qrLoaded = true;
    qrError('');
    renderQrCodes();
  } catch {
    qrError('Couldn’t load the QR codes. Check the connection and try again.');
  }
}

function renderQrCodes() {
  const list = $('qr-list');
  list.textContent = '';
  $('qr-count').textContent = qrCodes.length
    ? `${qrCodes.length} code${qrCodes.length === 1 ? '' : 's'}`
    : '';
  $('qr-export').hidden = !qrCodes.length;

  if (!qrCodes.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No codes yet. Make one below, print its QR onto a banner, and the scans show up here.';
    list.appendChild(empty);
    return;
  }
  for (const c of qrCodes) list.appendChild(buildQrRow(c));
}

/** A short, human date. Nulls read as a sentence rather than an empty cell. */
function qrWhen(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} `
    + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function qrStat(value, label) {
  const wrap = document.createElement('span');
  wrap.className = 'qr-stat';
  const n = document.createElement('b');
  n.textContent = String(value ?? 0);
  wrap.appendChild(n);
  wrap.appendChild(document.createTextNode(` ${label}`));
  return wrap;
}

function buildQrRow(c) {
  const row = document.createElement('div');
  row.className = 'qr-row';

  /* ---- line 1: name, the printed URL, and the pause switch ---- */
  const head = document.createElement('div');
  head.className = 'qr-head';

  const name = document.createElement('input');
  name.className = 'nv-input qr-name';
  name.type = 'text';
  name.maxLength = 80;
  name.value = c.name ?? '';
  name.setAttribute('aria-label', 'Name');
  head.appendChild(name);

  const link = document.createElement('span');
  link.className = 'qr-link';
  link.textContent = `/r/${c.code}`;
  link.title = qrUrl(c.code);
  head.appendChild(link);

  const sw = document.createElement('label');
  sw.className = 'qr-switch';
  const active = document.createElement('input');
  active.type = 'checkbox';
  active.checked = !!c.active;
  sw.appendChild(active);
  const swText = document.createElement('span');
  swText.textContent = c.active ? 'Paying' : 'Paused';
  sw.appendChild(swText);
  active.addEventListener('change', () => { swText.textContent = active.checked ? 'Paying' : 'Paused'; });
  head.appendChild(sw);
  row.appendChild(head);

  /* ---- line 2: what it has actually done ---- */
  const stats = document.createElement('div');
  stats.className = 'qr-stats';
  stats.appendChild(qrStat(c.scans, c.scans === 1 ? 'scan' : 'scans'));
  // "people" rather than "unique visitors": one phone scanning twice is one
  // person, and the operator reading this is asking how many people walked
  // past, not how many times a camera fired.
  stats.appendChild(qrStat(c.uniques, 'people'));
  stats.appendChild(qrStat(c.signups, c.signups === 1 ? 'signup' : 'signups'));
  stats.appendChild(qrStat(c.points_awarded, 'points paid'));
  const last = document.createElement('span');
  last.className = 'qr-stat qr-stat-muted';
  last.textContent = `last scan ${qrWhen(c.last_scan)}`;
  stats.appendChild(last);
  row.appendChild(stats);

  /* ---- line 3: the two editable knobs ---- */
  const edit = document.createElement('div');
  edit.className = 'qr-edit';

  const ptsWrap = document.createElement('label');
  ptsWrap.className = 'qr-field';
  const ptsLabel = document.createElement('span');
  ptsLabel.textContent = 'Award';
  ptsWrap.appendChild(ptsLabel);
  const points = document.createElement('input');
  points.className = 'nv-input qr-points';
  points.type = 'number';
  points.min = '0';
  points.max = '5000';
  points.step = '1';
  points.value = String(c.points ?? 0);
  ptsWrap.appendChild(points);
  edit.appendChild(ptsWrap);

  const noteWrap = document.createElement('label');
  noteWrap.className = 'qr-field qr-field-wide';
  const noteLabel = document.createElement('span');
  noteLabel.textContent = 'Note';
  noteWrap.appendChild(noteLabel);
  const note = document.createElement('input');
  note.className = 'nv-input qr-note';
  note.type = 'text';
  note.maxLength = 200;
  note.value = c.note ?? '';
  note.placeholder = 'where it is';
  noteWrap.appendChild(note);
  edit.appendChild(noteWrap);
  row.appendChild(edit);

  const rowError = document.createElement('span');
  rowError.className = 'qr-row-error';
  rowError.hidden = true;
  row.appendChild(rowError);

  const detail = document.createElement('div');
  detail.className = 'qr-detail';
  detail.hidden = !qrOpen.has(c.id);
  row.appendChild(detail);

  /* ---- line 4: the buttons ---- */
  const actions = document.createElement('div');
  actions.className = 'qr-actions';
  const button = (label, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', () => fn(b));
    actions.appendChild(b);
    return b;
  };

  const fields = { name, points, note, active };
  button('Save', 'qr-btn', (b) => saveQr(c, fields, b, rowError));
  button('Copy link', 'qr-btn', (b) => copyQrLink(c, b));
  button('PNG', 'qr-btn', (b) => downloadQrPng(c, b, rowError));
  button('SVG', 'qr-btn', (b) => downloadQrSvg(c, b, rowError));
  button(qrOpen.has(c.id) ? 'Hide traffic' : 'Traffic', 'qr-btn', (b) => toggleQrDetail(c, detail, b, rowError));
  button('Delete', 'qr-btn qr-btn-danger', (b) => deleteQr(c, b, rowError));
  row.appendChild(actions);

  if (qrOpen.has(c.id)) paintQrDetail(detail, qrOpen.get(c.id), c);
  return row;
}

/** Row-local failures go beside the row, not at the top of the card: a repaint
 *  destroys anything pinned inside a row, so the two live in different places
 *  on purpose (same split the pool rows use). */
function qrRowError(el, msg) {
  el.textContent = msg || '';
  el.hidden = !msg;
}

async function saveQr(c, fields, btn, errEl) {
  const name = fields.name.value.trim();
  if (!name) return qrRowError(errEl, 'Give it a name you’ll recognise later.');
  const points = Number(fields.points.value);
  if (!Number.isInteger(points) || points < 0 || points > 5000) {
    return qrRowError(errEl, 'The award must be a whole number from 0 to 5000.');
  }

  // ⚠ THE ONE GENUINELY DANGEROUS EDIT IN THIS CARD. The banner is already
  // printed and screwed to a wall, and community_grants has no reversal path —
  // there is no undo for points this pays out. A raise is therefore confirmed;
  // a cut is not, because the failure mode of a cut is a support ticket rather
  // than money that cannot come back.
  if (points > (c.points ?? 0) && points >= 100) {
    const ok = confirm(
      `Raise “${name}” to ${points} community points per signup?\n\n`
      + 'The banner is already printed, and points paid out cannot be reversed.'
    );
    if (!ok) return;
  }

  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Saving…';
  qrRowError(errEl, '');
  qrOkMsg('');
  try {
    const res = await authFetch(`/api/admin/tracked-qr/${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, points, note: fields.note.value.trim(), active: fields.active.checked }),
    });
    if (res.status === 403) return denyAccess();
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return qrRowError(errEl, body.message || 'Couldn’t save that.');

    // Replace in place rather than reloading the list: a repaint of every row
    // would collapse any traffic panel the operator has open beside this one.
    const i = qrCodes.findIndex((x) => x.id === c.id);
    if (i >= 0 && body.code) qrCodes[i] = body.code;
    renderQrCodes();
    qrOkMsg(`Saved “${name}”.`);
  } catch {
    qrRowError(errEl, 'Couldn’t save that. Check the connection and try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function createQr(e) {
  e.preventDefault();
  const btn = $('qr-new-submit');
  const errEl = $('qr-new-error');
  const name = $('qr-new-name').value.trim();
  const setErr = (m) => { errEl.textContent = m || ''; errEl.hidden = !m; };

  if (!name) return setErr('Give it a name you’ll recognise later, e.g. “HUB east entrance”.');
  const points = Number($('qr-new-points').value || 0);
  if (!Number.isInteger(points) || points < 0 || points > 5000) {
    return setErr('The award must be a whole number from 0 to 5000. 0 tracks traffic and pays nothing.');
  }

  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Creating…';
  setErr('');
  qrOkMsg('');
  try {
    const res = await authFetch('/api/admin/tracked-qr', {
      method: 'POST',
      body: JSON.stringify({ name, points, note: $('qr-new-note').value.trim() }),
    });
    if (res.status === 403) return denyAccess();
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(body.message || 'Couldn’t create that code.');

    qrCodes.unshift(body.code);
    renderQrCodes();
    $('qr-new-name').value = '';
    $('qr-new-note').value = '';
    $('qr-new-points').value = '0';
    qrOkMsg(`Created “${body.code.name}”. Its QR is the PNG or SVG button on its row.`);
  } catch {
    setErr('Couldn’t create that code. Check the connection and try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function deleteQr(c, btn, errEl) {
  // The server refuses a delete once a code has traffic; this only asks first so
  // the refusal isn't the operator's first hint that it might matter.
  const warn = c.scans > 0 || c.signups > 0
    ? `“${c.name}” has ${c.scans} scan${c.scans === 1 ? '' : 's'} and ${c.signups} signup${c.signups === 1 ? '' : 's'}.\n\n`
      + 'Deleting throws that history away, and any banner already on a wall stops working. Pausing keeps both. Delete anyway?'
    : `Delete “${c.name}”? It has never been scanned, so nothing is lost.`;
  if (!confirm(warn)) return;

  btn.disabled = true;
  qrRowError(errEl, '');
  qrOkMsg('');
  try {
    const force = c.scans > 0 || c.signups > 0 ? '?force=1' : '';
    const res = await authFetch(`/api/admin/tracked-qr/${c.id}${force}`, { method: 'DELETE' });
    if (res.status === 403) return denyAccess();
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return qrRowError(errEl, body.message || 'Couldn’t delete that code.');
    }
    qrOpen.delete(c.id);
    qrCodes = qrCodes.filter((x) => x.id !== c.id);
    renderQrCodes();
    qrOkMsg(`Deleted “${c.name}”.`);
  } catch {
    qrRowError(errEl, 'Couldn’t delete that code. Check the connection and try again.');
  } finally {
    btn.disabled = false;
  }
}

async function copyQrLink(c, btn) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(qrUrl(c.code));
    btn.textContent = 'Copied';
  } catch {
    // Clipboard is permission-gated and fails on http:// origins. Falling back
    // to showing the URL beats a button that silently does nothing.
    btn.textContent = qrUrl(c.code);
  }
  setTimeout(() => { btn.textContent = label; }, 1600);
}

/* ---------- the traffic panel ---------- */

async function toggleQrDetail(c, panel, btn, errEl) {
  if (qrOpen.has(c.id)) {
    qrOpen.delete(c.id);
    panel.hidden = true;
    panel.textContent = '';
    btn.textContent = 'Traffic';
    return;
  }
  qrOpen.set(c.id, 'loading');
  panel.hidden = false;
  panel.textContent = 'Loading…';
  btn.textContent = 'Hide traffic';
  btn.disabled = true;
  qrRowError(errEl, '');
  try {
    const res = await authFetch(`/api/admin/tracked-qr/${c.id}/detail?days=30`);
    if (res.status === 403) return denyAccess();
    if (!res.ok) {
      qrOpen.delete(c.id);
      panel.hidden = true;
      btn.textContent = 'Traffic';
      return qrRowError(errEl, 'Couldn’t load the traffic for that code.');
    }
    const detail = await res.json();
    qrOpen.set(c.id, detail);
    paintQrDetail(panel, detail, c);
  } catch {
    qrOpen.delete(c.id);
    panel.hidden = true;
    btn.textContent = 'Traffic';
    qrRowError(errEl, 'Couldn’t load the traffic. Check the connection and try again.');
  } finally {
    btn.disabled = false;
  }
}

/** One bar chart. Bars carry their number as a title, because 30 labels do not
 *  fit on a phone and an unlabelled bar is decoration. */
function qrChart(series, labelOf) {
  // The TRUE peak, reported above the chart. Kept separate from the divisor
  // below: tracked_qr_detail fills every bucket (generate_series), so an
  // unscanned code arrives as 30 rows of zero rather than as an empty array,
  // and a divisor floor leaking into the label made that read "peak 1 in a
  // day" next to a chart correctly showing none.
  const peak = Math.max(0, ...series.map((p) => p.scans ?? 0));
  const max = Math.max(1, peak);
  const chart = document.createElement('div');
  chart.className = 'qr-chart';
  for (const p of series) {
    const col = document.createElement('div');
    col.className = 'qr-bar-col';
    col.title = `${labelOf(p)}: ${p.scans ?? 0} scan${p.scans === 1 ? '' : 's'}`;
    const bar = document.createElement('div');
    bar.className = 'qr-bar';
    // A floor of 2% so a day with one scan is visibly different from a day with
    // none — the difference between "nobody" and "somebody" is the whole point
    // of the chart and it must not round away to a flat line.
    bar.style.height = p.scans ? `${Math.max(2, Math.round((p.scans / max) * 100))}%` : '0';
    if (!p.scans) bar.classList.add('qr-bar-empty');
    col.appendChild(bar);
    chart.appendChild(col);
  }
  return { chart, peak };
}

// Zero is a real answer and says so, rather than being dressed up as a peak.
const peakText = (n, unit) => (n ? `peak ${n} in a${unit === 'hour' ? 'n' : ''} ${unit}` : 'no scans yet');

function paintQrDetail(panel, detail, c) {
  panel.textContent = '';
  if (detail === 'loading') { panel.textContent = 'Loading…'; return; }

  const daily = detail.daily ?? [];
  const hourly = detail.hourly ?? [];

  const mk = (title, hint) => {
    const h = document.createElement('div');
    h.className = 'qr-detail-head';
    const t = document.createElement('strong');
    t.textContent = title;
    h.appendChild(t);
    const s = document.createElement('span');
    s.textContent = hint;
    h.appendChild(s);
    return h;
  };

  const d = qrChart(daily, (p) => p.day);
  panel.appendChild(mk('Last 30 days', peakText(d.peak, 'day')));
  panel.appendChild(d.chart);

  const h = qrChart(hourly, (p) => `${p.hour}:00`);
  panel.appendChild(mk('Time of day', `local time · ${peakText(h.peak, 'hour')}`));
  panel.appendChild(h.chart);

  const foot = document.createElement('div');
  foot.className = 'qr-detail-foot';
  const first = document.createElement('span');
  first.textContent = `first scan ${qrWhen(c.first_scan)}`;
  foot.appendChild(first);
  const csv = document.createElement('button');
  csv.type = 'button';
  csv.className = 'qr-btn';
  csv.textContent = 'Export scans CSV';
  csv.addEventListener('click', () => exportQrScans(c, csv));
  foot.appendChild(csv);
  panel.appendChild(foot);
}

/* ---------- the printable QR ----------
   Drawn here, in this browser, from the vendored qrcode-generator build the
   student and terminal apps already use. Not a third-party QR service, and the
   distinction is not paranoia: pasting a URL that pays out community points
   into someone else's website is handing them a link they can then print.

   BYTE MODE, and deliberately not the denser Alphanumeric one. Uppercasing the
   whole URL would let it encode as Alphanumeric and buy roughly one QR version
   — bigger modules, easier to scan from across a room, which for a banner is
   worth real money. It is still not worth it: this artwork gets printed on
   vinyl, and every scanner app on every phone has to read a screaming-uppercase
   URL correctly for that trade to pay off. The 8-character code is what keeps
   the symbol small instead.

   4-module quiet zone on all sides, because a QR with the margin cropped off is
   the single most common reason a printed one doesn't scan, and whoever lays
   this into the banner artwork will crop to the edge of the image. */
const QR_QUIET = 4;

function makeQr(text) {
  const qr = qrcode(0, 'M');   // 0 = smallest version that fits; M = 15% recovery
  qr.addData(String(text), 'Byte');
  qr.make();
  return qr;
}

/** A PNG about 1240px square: enough to print at ~4 inches without a soft edge. */
function qrPngBlob(text) {
  const qr = makeQr(text);
  const count = qr.getModuleCount();
  const units = count + QR_QUIET * 2;
  const scale = Math.max(4, Math.round(1240 / units));
  const px = units * scale;

  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  // Hard-coded black on white, never the dashboard theme: an inverted or
  // low-contrast QR is a known real-world scan failure, and this one is going
  // to a printer that has no idea what dark mode is.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (qr.isDark(r, c)) ctx.fillRect((c + QR_QUIET) * scale, (r + QR_QUIET) * scale, scale, scale);
    }
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** The same symbol as vector, which is what a print shop actually wants. */
function qrSvgBlob(text) {
  const qr = makeQr(text);
  const count = qr.getModuleCount();
  const units = count + QR_QUIET * 2;
  let rects = '';
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (qr.isDark(r, c)) rects += `<rect x="${c + QR_QUIET}" y="${r + QR_QUIET}" width="1" height="1"/>`;
    }
  }
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${units} ${units}" width="1240" height="1240" shape-rendering="crispEdges">
<rect width="${units}" height="${units}" fill="#ffffff"/>
<g fill="#000000">${rects}</g>
</svg>
`;
  return new Blob([svg], { type: 'image/svg+xml' });
}

// A filename the operator can find again in six months, from a name they typed.
const qrFileName = (c, ext) => {
  const slug = String(c.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `werewards-qr-${slug || 'code'}-${c.code}.${ext}`;
};

async function downloadQrPng(c, btn, errEl) {
  btn.disabled = true;
  qrRowError(errEl, '');
  try {
    const blob = await qrPngBlob(qrUrl(c.code));
    if (!blob) return qrRowError(errEl, 'Couldn’t draw that QR. Try the SVG instead.');
    saveBlob(blob, qrFileName(c, 'png'));
  } catch {
    qrRowError(errEl, 'Couldn’t draw that QR.');
  } finally {
    btn.disabled = false;
  }
}

function downloadQrSvg(c, btn, errEl) {
  try {
    qrRowError(errEl, '');
    saveBlob(qrSvgBlob(qrUrl(c.code)), qrFileName(c, 'svg'));
  } catch {
    qrRowError(errEl, 'Couldn’t draw that QR.');
  }
}

/* ---------- CSV ----------
   Both exports come down as an authenticated fetch and then a blob, not as a
   plain link: every /api/admin call carries a bearer token, and an <a href> has
   nowhere to put one. Same shape as the poster download above. */

async function exportQrAll(btn) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Exporting…';
  qrError('');
  try {
    const res = await authFetch('/api/admin/tracked-qr/export');
    if (res.status === 403) return denyAccess();
    if (!res.ok) return qrError('Couldn’t export that. Try again.');
    saveBlob(await res.blob(), 'werewards-qr-codes.csv');
  } catch {
    qrError('Couldn’t export that. Check the connection and try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function exportQrScans(c, btn) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Exporting…';
  try {
    const res = await authFetch(`/api/admin/tracked-qr/${c.id}/export`);
    if (res.status === 403) return denyAccess();
    if (!res.ok) { btn.textContent = 'Export failed'; return; }
    saveBlob(await res.blob(), `werewards-qr-${c.code}-scans.csv`);
  } catch {
    btn.textContent = 'Export failed';
    return;
  } finally {
    btn.disabled = false;
    // A failure leaves its own word on the button, then puts the label back —
    // otherwise the row keeps saying "Export failed" long after the operator
    // has fixed whatever caused it.
    if (btn.textContent === 'Exporting…') btn.textContent = label;
    else setTimeout(() => { btn.textContent = label; }, 2400);
  }
}

/**
 * The QR poster tab, which now has two very different things on it.
 *
 * Reloads the codes on EVERY open rather than only the first, unlike the pools
 * tab's one-shot flag. The operator comes to this tab specifically to read scan
 * counts, so a cached count from whenever the dashboard happened to boot is the
 * one thing it must never show. It is a single view query.
 */
function openPoster() {
  setView('poster');
  loadQrCodes();
}
