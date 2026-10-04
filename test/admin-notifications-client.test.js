// The Notifications tab in public/admin/admin.js: the operator's log of every
// push and email, and the view of what is still queued (migration-062).
//
// THREE THINGS HERE HAVE NO OTHER SAFETY NET.
//
//   THE COPY IS THE FEATURE. The API speaks in codes (no_device_accepted,
//   vendor_cooldown, 'allowed'); this screen is where they become sentences an
//   operator acts on. 'allowed' in particular must read "Allowed, shown by
//   device" and never anything that sounds like "delivered": nearby alerts are
//   shown by the student's own phone and the server never learns the result.
//
//   EVERY ROW IS UNTRUSTED. Push titles are vendor-written, names and emails
//   come from Google, and the rows are built as HTML strings. One missed
//   escapeHtml is script injection into the one dashboard that can see every
//   student's email address.
//
//   THE TIMERS MUST STOP. This is the only auto-refresh in the admin app. A
//   dashboard left open in a hidden tab, on another view, or signed out must
//   not keep polling the API.
//
// SLICED AND EVALUATED, following test/ambassador-client.test.js: admin.js is a
// browser script, not a module, so nothing in test/ can import from it. The
// landmarks are deliberately brittle: if either moves, this throws rather than
// quietly testing nothing. It reads public/, not .build/, because the source is
// what a person edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ADMIN = fileURLToPath(new URL('../public/admin/admin.js', import.meta.url));
const src = readFileSync(ADMIN, 'utf8');
const from = src.indexOf('/* ---------- notifications (migration-062) ----------');
const to = src.indexOf('/* ---------- broadcast: one operator message to students (migration-061) ----------');
assert.ok(from > 0 && to > from, 'notifications block landmarks moved in public/admin/admin.js: re-anchor this test');
const slice = src.slice(from, to);

// The REAL escapeHtml, not a copy: the escaping assertions below are only worth
// anything if they run against the function the page actually uses.
const escFrom = src.indexOf('function escapeHtml(s) {');
assert.ok(escFrom > 0, 'escapeHtml moved in public/admin/admin.js: re-anchor this test');
const escapeSrc = src.slice(escFrom, src.indexOf('\n}', escFrom) + 2);

const NOW = Date.parse('2026-10-03T15:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const ahead = (ms) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function fakeNode(id) {
  const cls = new Set();
  return {
    id,
    hidden: true,
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    dataset: {},
    children: [],
    className: '',
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)),
      contains: (c) => cls.has(c),
    },
    focus() {},
    addEventListener() {},
    querySelectorAll: () => [],
    appendChild(child) { this.children.push(child); },
  };
}

/**
 * A fresh sandbox per test. `routes` maps a path (no query string) to
 * `{ status, body }`, an Error (the offline case), or is a function of
 * (url, opts). Timers are recorded, never run, so a test decides when a tick
 * happens.
 */
function sandbox({ routes = {}, visible = true, escape = escapeSrc } = {}) {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, fakeNode(id));
    return nodes.get(id);
  };
  $('dash').hidden = false;
  const calls = { fetches: [], intervals: [], cleared: [], denied: 0, students: [], views: [] };
  let nextTimer = 1;
  const document = {
    visibilityState: visible ? 'visible' : 'hidden',
    addEventListener() {},
    createElement: (tag) => fakeNode(tag),
  };
  const deps = {
    $,
    document,
    authFetch: async (url, opts = {}) => {
      calls.fetches.push({ url, method: opts.method || 'GET' });
      const path = url.split('?')[0];
      const r = await (typeof routes === 'function' ? routes(url, opts) : routes[path]);
      if (r instanceof Error) throw r;
      const { status = 200, body = {} } = r || { status: 500 };
      return { status, ok: status >= 200 && status < 300, json: async () => body };
    },
    denyAccess: async () => { calls.denied += 1; },
    setView: (v) => {
      calls.views.push(v);
      ['notifications', 'dashboard'].forEach((name) => { $(`view-${name}`).hidden = name !== v; });
    },
    setInterval: (fn, ms) => {
      const id = nextTimer++;
      calls.intervals.push({ id, fn, ms });
      return id;
    },
    clearInterval: (id) => { calls.cleared.push(id); },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    num: (n) => (Number(n) || 0).toLocaleString('en-US'),
    appendPage: (current, incoming) => {
      const seen = new Set(current.map((r) => r.id));
      return current.concat((incoming ?? []).filter((r) => !seen.has(r.id)));
    },
    openStudentDetail: (s) => { calls.students.push(s); },
  };

  // eslint-disable-next-line no-new-func
  const api = new Function('deps', `
    let { $, document, authFetch, denyAccess, setView, setInterval, clearInterval,
          setTimeout, clearTimeout, num, appendPage, openStudentDetail } = deps;
    ${escape}
    ${slice}
    return {
      notifOutcomeText, notifReasonText, notifBlockerText, notifUnavailableText, notifRel,
      notifNextText, notifRowHtml, notifHealthHtml, notifQueueSectionHtml, notifDetailHtml,
      notifStudentHtml, notifStudentCardHtml, notifLogQuery, syncNotifTimers, stopNotifTimers,
      notifFastTick, pollNewNotifications, openNotifications, loadNotifLog, loadNotifQueue,
      loadNotifSummary, setNotifFilter, closeNotifDetail, openNotifDetail, onNotifTap,
      loadStudentNotifSection, cancelStudentNotifSection,
      setLoaded: (v) => { notifLoaded = v; },
      setSub: (v) => { notifSub = v; },
      state: () => ({ notifLogSince, notifLogUnavailable, notifRows, notifFilter }),
    };
  `)(deps);

  const live = () => calls.intervals.filter((t) => !calls.cleared.includes(t.id));
  return { api, calls, node: $, document, live };
}

/* ---------- copy ---------- */

test("'allowed' reads as allowed and shown by the device, never as delivered", () => {
  const { api } = sandbox();
  assert.equal(api.notifOutcomeText('allowed'), 'Allowed, shown by device');
  assert.doesNotMatch(api.notifOutcomeText('allowed'), /deliver/i);
});

test('outcomes carry their reason in words', () => {
  const { api } = sandbox();
  assert.equal(api.notifOutcomeText('sent'), 'Sent');
  assert.equal(api.notifOutcomeText('sent', null), 'Sent');
  assert.equal(api.notifOutcomeText('refused', 'no_devices'), 'Refused: No devices');
  assert.equal(api.notifOutcomeText('failed', 'no_device_accepted'), 'Failed: No device accepted it');
  assert.equal(api.notifOutcomeText('refused', 'suppressed'), 'Refused: Address suppressed');
  // A code this build has never heard of is shown as itself, not swallowed.
  assert.equal(api.notifOutcomeText('failed', 'brand_new_code'), 'Failed: brand_new_code');
});

test('every reason code in the contract has its sentence', () => {
  const { api } = sandbox();
  const expected = {
    push_disabled: 'Push not configured',
    no_devices: 'No devices',
    no_device_accepted: 'No device accepted it',
    send_error: 'Send error',
    content_empty: 'Nothing to say',
    disabled: 'Email not configured',
    invalid_to: 'Invalid address',
    empty: 'Empty message',
    suppressed: 'Address suppressed',
    no_email_address: 'No email on file',
    http: 'Email provider rejected it',
    timeout: 'Email provider timed out',
    network: 'Network error',
  };
  for (const [code, words] of Object.entries(expected)) assert.equal(api.notifReasonText(code), words, code);
  assert.equal(api.notifReasonText(null), '');
});

test('every blocker code, including the two Node adds, has its chip text', () => {
  const { api } = sandbox();
  const expected = {
    quiet_hours: 'Quiet hours',
    hold: 'Bundling window',
    cooldown: '4h cooldown',
    daily_cap: 'Daily cap reached',
    weekly_cap: 'Weekly cap reached',
    vendor_cooldown: 'Same spot in last 20h',
    no_channel: 'No device or email',
    no_device: 'No device',
    push_opt_out: 'Alerts off',
    reminder_opt_out: 'Reminders off',
    interval: 'Reminded in last 72h',
    expired: 'Expired, clears next tick',
    cancelled: 'Cancelled',
    sending: 'Sending now',
    stuck: 'Stuck sending over 10 min',
    app_open: 'App open now',
    backoff: 'Backing off after a failed send',
    expires_first: 'Expires before it can send',
    same_spot_queued: 'Another deal from this spot goes first',
  };
  for (const [code, words] of Object.entries(expected)) assert.equal(api.notifBlockerText(code), words, code);
});

test("the limits in blocker copy come from the server's config, not hard-coded numbers", () => {
  const { api } = sandbox();
  const config = { cooldownMinutes: 180, dailyCap: 2, weeklyCap: 6, vendorCooldownHours: 12, minIntervalHours: 48, quietStart: 22, quietEnd: 9, timezone: 'America/New_York' };
  assert.equal(api.notifBlockerText('cooldown', config), '3h cooldown');
  assert.equal(api.notifBlockerText('vendor_cooldown', config), 'Same spot in last 12h');
  assert.equal(api.notifBlockerText('interval', config), 'Reminded in last 48h');
  // Not a whole hour: minutes, never "1.5h".
  assert.equal(api.notifBlockerText('cooldown', { cooldownMinutes: 90 }), '90 min cooldown');
  assert.equal(api.notifBlockerText('vendor_cooldown', { vendorCooldownHours: 0.5 }), 'Same spot in last 30 min');
  // A reply without config, or with junk in it, falls back to the defaults.
  assert.equal(api.notifBlockerText('cooldown', {}), '4h cooldown');
  assert.equal(api.notifBlockerText('cooldown', { cooldownMinutes: 'abc' }), '4h cooldown');
  assert.equal(api.notifBlockerText('interval', { minIntervalHours: 0 }), 'Reminded in last 72h');
  assert.equal(api.notifBlockerText('quiet_hours', config), 'Quiet hours', 'codes without a number ignore config');

  // And the renderers actually hand it through.
  const row = { source: 'deal', studentId: 's1', studentName: 'Ana', title: 'Half off', status: 'queued', blockers: ['cooldown', 'vendor_cooldown', 'same_spot_queued'], nextEligibleAt: ahead(HOUR) };
  const q = api.notifQueueSectionHtml('Deals', { available: true, total: 1, rows: [row] }, NOW, { config: { cooldownMinutes: 90, vendorCooldownHours: 12 } });
  assert.match(q, /90 min cooldown/);
  assert.match(q, /Same spot in last 12h/);
  assert.match(q, /Another deal from this spot goes first/);
  const st = api.notifStudentHtml({ id: 's1', name: 'Ana', email: 'a@x.edu' },
    { config: { cooldownMinutes: 300, minIntervalHours: 24 }, budget: { blockers: ['cooldown'] }, devices: [], queued: [{ ...row, blockers: ['interval'] }], recent: [] }, NOW);
  assert.match(st, /5h cooldown/, 'the allowance card');
  assert.match(st, /Reminded in last 24h/, 'the student\'s own queued rows');
});

test("'expires first' is a red chip and next eligible says it never goes", () => {
  const { api } = sandbox();
  assert.equal(api.notifNextText({ nextEligibleAt: null, blockers: ['quiet_hours', 'expires_first'] }, NOW), 'Never, expires first');
  const html = api.notifQueueSectionHtml('Broadcasts', { available: true, total: 1, rows: [{ source: 'broadcast', studentId: 's1', title: 'Hi', status: 'queued', blockers: ['expires_first'], nextEligibleAt: null }] }, NOW);
  assert.match(html, /is-bad">Expires before it can send/);
  assert.match(html, /Never, expires first/);
});

test('reminders that can never go on their own are counted, so the order makes sense', () => {
  const { api } = sandbox();
  const rows = [{ source: 'reminder', studentId: 'u1', status: 'due', blockers: [], nextEligibleAt: ago(MIN), position: 3 }];
  const html = api.notifQueueSectionHtml('Reminders due next', { available: true, total: 40, blockedForever: 7, rows }, NOW);
  assert.match(html, /7 of the students checked cannot be reminded on their own/);
  const none = api.notifQueueSectionHtml('Reminders due next', { available: true, total: 1, blockedForever: 0, rows }, NOW);
  assert.doesNotMatch(none, /cannot be reminded/);
});

test('an unavailable section names its migration', () => {
  const { api } = sandbox();
  assert.equal(api.notifUnavailableText('migration-062'), 'Migration 062 not applied');
  assert.equal(api.notifUnavailableText('migration-061'), 'Migration 061 not applied');
  assert.equal(api.notifUnavailableText('migration-060'), 'Migration 060 not applied');
  assert.equal(api.notifUnavailableText(undefined), 'Not available on this database yet');
});

test('the block has no em dash anywhere', () => {
  // Comments are exempt from the copy rule, but telling a comment from a
  // string by regex is unreliable, so the whole block is held to it.
  assert.ok(!slice.includes('—'), 'em dash in the notifications block of admin.js');
});

/* ---------- relative time ---------- */

test('relative time reads naturally in both directions', () => {
  const { api } = sandbox();
  assert.equal(api.notifRel(ago(10_000), NOW), 'just now');
  assert.equal(api.notifRel(ago(5 * MIN), NOW), '5m ago');
  assert.equal(api.notifRel(ago(2 * HOUR + 15 * MIN), NOW), '2h 15m ago');
  assert.equal(api.notifRel(ago(3 * HOUR), NOW), '3h ago');
  assert.equal(api.notifRel(ago(3 * 24 * HOUR), NOW), '3d ago');
  assert.equal(api.notifRel(ahead(4 * HOUR), NOW), 'in 4h');
  assert.equal(api.notifRel(ahead(20_000), NOW), 'in under a minute');
  assert.equal(api.notifRel(null, NOW), '');
  assert.equal(api.notifRel('not a date', NOW), '', 'never "NaN ago"');
});

test('next eligible separates "now" from "time alone will not fix it"', () => {
  const { api } = sandbox();
  assert.equal(api.notifNextText({ nextEligibleAt: null, blockers: [] }, NOW), 'Now');
  assert.equal(api.notifNextText({ nextEligibleAt: null, blockers: ['push_opt_out'] }, NOW), 'Not on its own');
  assert.equal(api.notifNextText({ nextEligibleAt: null, blockers: ['sending'] }, NOW), 'Sending now');
  assert.equal(api.notifNextText({ nextEligibleAt: ago(MIN), blockers: [] }, NOW), 'Now, next tick');
  assert.equal(api.notifNextText({ nextEligibleAt: ahead(2 * HOUR), blockers: ['quiet_hours'] }, NOW), 'in 2h');
});

/* ---------- escaping ---------- */

const HOSTILE = {
  id: 'a"b<c',
  createdAt: ago(5 * MIN),
  channel: 'push',
  kind: 'deal',
  outcome: '"><img src=x>',
  reason: '<b>why</b>',
  recipientKind: 'student',
  studentId: 's1"><script>',
  recipientName: '<script>alert(1)</script>',
  recipientEmail: 'x@y.com"><img src=x onerror=alert(2)>',
  vendorName: 'Tom & Jerry <Cafe>',
  title: '<img src=x onerror=alert(3)>',
  devicesTried: 3,
  devicesAccepted: 2,
  deliveryStatus: null,
  source: 'live',
};

function assertInert(html) {
  assert.doesNotMatch(html, /<script/i, 'a raw <script> reached the markup');
  assert.doesNotMatch(html, /<img/i, 'a raw <img> reached the markup');
  assert.doesNotMatch(html, /<b>why/, 'a raw tag in the reason reached the markup');
}

test('a log row escapes every untrusted string, attributes included', () => {
  const { api } = sandbox();
  const html = api.notifRowHtml(HOSTILE, NOW);
  assertInert(html);
  assert.match(html, /&lt;img src=x onerror=alert\(3\)&gt;/, 'the title should be shown, escaped');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'the name should be shown, escaped');
  assert.match(html, /Tom &amp; Jerry &lt;Cafe&gt;/);
  assert.match(html, /data-id="a&quot;b&lt;c"/, 'the id attribute cannot break out of its quotes');
  // The outcome becomes a CLASS NAME, so it is whitelisted, not escaped.
  assert.match(html, /class="notif-outcome is-unknown"/);
  assert.match(html, /2\/3 devices/);
  assert.match(html, /5m ago/);
});

test('the escaping assertion has teeth: with escapeHtml disabled the same row is live markup', () => {
  // Proves the test above would fail if a call site skipped escaping.
  const { api } = sandbox({ escape: 'const escapeHtml = (s) => String(s);' });
  const html = api.notifRowHtml(HOSTILE, NOW);
  assert.throws(() => assertInert(html));
});

test('the popup, health strip, queue and student views escape too', () => {
  const { api } = sandbox();
  assertInert(api.notifDetailHtml({
    ...HOSTILE,
    body: '<img src=x>',
    url: '/?x="><script>',
    template: '<script>',
    devices: [{ subId: '1', service: '<img>', label: '<script>', ok: false, status: 410, pruned: false, error: '<img src=x>' }],
    ref: { tier: '<script>', vendorName: '<img src=x>', rewardTitle: '<script>' },
    linked: { campaigns: [{ id: 'c', title: '<img src=x>', vendorName: '<script>' }], broadcast: { id: 'b', title: '<script>', audience: '<img>', status: '<b>why</b>' } },
    providerId: '<script>',
    dedupeKey: '<img src=x>',
  }, NOW));
  assertInert(api.notifHealthHtml({
    push: { configured: true }, email: { configured: false }, webhook: { configured: false }, log: { available: true },
    workers: { campaigns: { configured: true, running: true, lastTickAt: ago(MIN), lastErrorAt: ago(10_000), lastError: '<script>boom</script>' } },
    migrations: { '061': false },
  }, NOW));
  const row = {
    source: 'deal', itemId: 'c1', studentId: 's"1', studentName: '<script>', studentEmail: '<img src=x>',
    title: '<img src=x>', vendorName: '<script>', status: '<b>why</b>', blockers: ['<img src=x>'], nextEligibleAt: null,
  };
  assertInert(api.notifQueueSectionHtml('Deals', { available: true, total: 1, rows: [row] }, NOW));
  assertInert(api.notifStudentHtml(
    { id: 's1', name: '<script>', email: '<img src=x>' },
    { budget: { blockers: ['<script>'] }, devices: [{ id: 'd', service: 'apple', label: '<img src=x>' }], queued: [row], recent: [HOSTILE] },
    NOW,
  ));
});

test('the health strip shows the worker error as text, not only in a tooltip', () => {
  const { api } = sandbox();
  const html = api.notifHealthHtml({
    push: { configured: true }, email: { configured: true }, webhook: { configured: true }, log: { available: false },
    workers: {
      campaigns: { configured: true, running: true, lastTickAt: ago(5 * MIN), lastErrorAt: ago(MIN), lastError: 'claim failed' },
      reminders: { configured: true, running: true, lastTickAt: ago(2 * MIN), lastErrorAt: ago(HOUR), lastError: 'old news' },
      broadcasts: { configured: true, running: true, rpcMissing: true, lastError: 'function missing' },
    },
    migrations: { '047': true, '060': false, '061': null, '062': false },
    visibleStudents: 2,
  }, NOW);
  assert.match(html, /Deals worker error 1m ago/);
  assert.match(html, /notif-werr">Deals worker: claim failed</);
  assert.match(html, /Reminders worker, ticked 2m ago/, 'an error older than the last tick is history, not a fault');
  assert.doesNotMatch(html, /old news<\/p>/);
  assert.match(html, /Broadcast worker: database function missing/);
  assert.match(html, /Log not recording/);
  assert.match(html, /Migration 060 not applied/);
  assert.match(html, /Migration 062 not applied/);
  assert.doesNotMatch(html, /Migration 061 not applied/, 'an unknown probe (null) is not reported as missing');
  assert.doesNotMatch(html, /Migration 047 not applied/);
});

test('a log table that reads fine but is not being written to is red, not "Log recording"', () => {
  const { api } = sandbox();
  const base = { push: { configured: true }, email: { configured: true }, webhook: { configured: true }, workers: {}, migrations: {} };
  const failing = api.notifHealthHtml({ ...base, log: { available: true, writing: false, lastError: 'column "devices" does not exist' } }, NOW);
  assert.match(failing, /is-bad"[^>]*>Log writes failing</);
  assert.match(failing, /column &quot;devices&quot; does not exist/);
  assert.doesNotMatch(failing, /Log recording/);
  // writing null (no write attempted since boot) is not a fault.
  const fresh = api.notifHealthHtml({ ...base, log: { available: true, writing: null, lastError: null } }, NOW);
  assert.match(fresh, /Log recording/);
  assert.doesNotMatch(fresh, /Log writes failing/);
});

test('a backfilled row is marked imported and an email row shows its delivery report', () => {
  const { api } = sandbox();
  const html = api.notifRowHtml({
    id: 'e1', createdAt: ago(HOUR), channel: 'email', kind: 'vendor_reset', outcome: 'sent', recipientKind: 'vendor',
    recipientName: 'Sher Halal', recipientEmail: 'owner@example.com', title: 'Your WeRewards reset code (code hidden)',
    devicesTried: 0, devicesAccepted: 0, deliveryStatus: 'bounced', source: 'backfill',
  }, NOW);
  assert.match(html, /notif-imported">imported</);
  assert.match(html, /Bounced/);
  assert.match(html, /Reset code/);
  assert.doesNotMatch(html, /devices/, 'an email row has no device count');
});

test('the popup warns that a backfilled row\'s text was rebuilt, and a live row does not', () => {
  const { api } = sandbox();
  const base = { id: 'd1', createdAt: ago(HOUR), channel: 'push', kind: 'deal', outcome: 'sent', recipientKind: 'student', title: 'Half off', body: 'Today only' };
  const imported = api.notifDetailHtml({ ...base, source: 'backfill' }, NOW);
  assert.match(imported, /rebuilt from the original deal or broadcast and may differ from what was actually shown/);
  const email = api.notifDetailHtml({ ...base, channel: 'email', source: 'backfill' }, NOW);
  assert.match(email, /rebuilt from the original deal or broadcast/, 'an imported email\'s "subject" is the deal title');
  const live = api.notifDetailHtml({ ...base, source: 'live' }, NOW);
  assert.doesNotMatch(live, /rebuilt/);
});

/* ---------- filters and the log ---------- */

test('the log query carries every filter and the "after" cursor', () => {
  const { api } = sandbox();
  const q = new URLSearchParams(api.notifLogQuery(
    { offset: 50, limit: 1, after: '2026-10-03T14:00:00.000Z' },
    { channel: 'email', outcome: 'failed', kind: 'deal', range: 'today', q: 'sher' },
  ));
  assert.equal(q.get('offset'), '50');
  assert.equal(q.get('limit'), '1');
  assert.equal(q.get('channel'), 'email');
  assert.equal(q.get('outcome'), 'failed');
  assert.equal(q.get('kind'), 'deal');
  assert.equal(q.get('range'), 'today');
  assert.equal(q.get('q'), 'sher');
  assert.equal(q.get('after'), '2026-10-03T14:00:00.000Z');
  const bare = new URLSearchParams(api.notifLogQuery({}, { channel: '', outcome: '', kind: '', range: '7d', q: '' }));
  assert.equal(bare.get('channel'), null, 'an "All" chip sends no filter');
  assert.equal(bare.get('after'), null);
});

test('migration-062 missing: the log shows a banner, no error, and the poll stays quiet', async () => {
  const { api, node, calls } = sandbox({
    routes: { '/api/admin/notifications': { body: { unavailable: 'migration-062', rows: [], total: 0, offset: 0, limit: 50 } } },
  });
  node('view-notifications').hidden = false;
  await api.loadNotifLog({ reset: true });
  assert.equal(node('notif-log-banner').hidden, false);
  assert.match(node('notif-log-banner').textContent, /^Migration 062 not applied\./);
  assert.equal(node('notif-log-error').hidden, true, 'a missing table is not a failure');
  const before = calls.fetches.length;
  await api.pollNewNotifications();
  assert.equal(calls.fetches.length, before, 'polling a log that cannot exist would be noise');
});

test('a 403 from any panel goes to denyAccess, not an error line', async () => {
  const { api, node, calls } = sandbox({ routes: { '/api/admin/notifications': { status: 403 } } });
  await api.loadNotifLog({ reset: true });
  assert.equal(calls.denied, 1);
  assert.equal(node('notif-log-error').hidden, true);
});

test('the "N new" poll counts rows newer than the top of the list and never touches the list', async () => {
  const rows = [{ id: 'n2', createdAt: ago(MIN) }, { id: 'n1', createdAt: ago(2 * MIN) }];
  let answer = { rows, total: 2 };
  const { api, node, calls } = sandbox({ routes: () => ({ body: answer }) });
  node('view-notifications').hidden = false;
  await api.loadNotifLog({ reset: true });
  assert.equal(api.state().notifLogSince, rows[0].createdAt);
  const listBefore = node('notif-log-list').innerHTML;

  answer = { rows: [{ id: 'n3' }], total: 3 };
  await api.pollNewNotifications();
  const last = new URLSearchParams(calls.fetches.at(-1).url.split('?')[1]);
  assert.equal(last.get('after'), rows[0].createdAt);
  assert.equal(last.get('limit'), '1');
  // A class, not [hidden]: the button is always laid out in the card head, so
  // showing it cannot push the list down (admin.css hides it with visibility).
  assert.equal(node('notif-new').classList.contains('is-live'), true);
  assert.equal(node('notif-new').textContent, '3 new, show');
  assert.equal(node('notif-log-list').innerHTML, listBefore, 'rows must not shift under the reader');

  await api.loadNotifLog({ reset: true });
  assert.equal(node('notif-new').classList.contains('is-live'), false, 'showing the new rows puts the button away');
});

test('the "N new" button sits in the card head and is never display-toggled', () => {
  const html = readFileSync(fileURLToPath(new URL('../public/admin/index.html', import.meta.url)), 'utf8');
  const panel = html.slice(html.indexOf('id="notif-log-panel"'), html.indexOf('id="notif-log-list"'));
  const head = panel.slice(panel.indexOf('class="card-head"'), panel.indexOf('id="notif-log-banner"'));
  assert.match(head, /<button id="notif-new"[^>]*>/, 'the button belongs beside the count, above nothing that can move');
  assert.doesNotMatch(head.match(/<button id="notif-new"[^>]*>/)[0], /\shidden[\s>]/, '[hidden] is display:none, which reflows the head');
  const css = readFileSync(fileURLToPath(new URL('../public/admin/admin.css', import.meta.url)), 'utf8');
  assert.match(css, /\.notif-new:not\(\.is-live\)\s*\{\s*visibility:\s*hidden;/);
  assert.doesNotMatch(slice, /notif-new'\)\.hidden/, 'admin.js must not toggle [hidden] on it any more');
});

test('a superseded "Show more" does not re-enable the button while the newer load is in flight', async () => {
  const gates = [];
  const { api, node } = sandbox({
    routes: () => new Promise((r) => gates.push(r)),
  });
  const first = api.loadNotifLog();                 // Show more
  assert.equal(node('notif-log-more').disabled, true);
  const second = api.loadNotifLog({ reset: true });  // a filter change overtakes it
  gates[0]({ body: { rows: [{ id: 'old' }], total: 9 } });
  await first;
  assert.equal(node('notif-log-more').disabled, true, 'the stale reply must leave the newer request in charge of the button');
  gates[1]({ body: { rows: [{ id: 'new' }], total: 9 } });
  await second;
  assert.equal(node('notif-log-more').disabled, false);
  assert.deepEqual(api.state().notifRows.map((r) => r.id), ['new']);
});

/* ---------- queue ---------- */

test('each queue section fails on its own: 061 missing blanks only the broadcasts', async () => {
  const { api, node } = sandbox({
    routes: {
      '/api/admin/notifications/queue': {
        body: {
          generatedAt: new Date(NOW).toISOString(),
          quietHours: { active: true, endsAt: ahead(3 * HOUR), start: 22, end: 9, timezone: 'America/New_York' },
          deals: { available: true, total: 1, rows: [{ source: 'deal', studentId: 's1', studentName: 'Ana', title: 'Half off', status: 'queued', blockers: ['quiet_hours'], nextEligibleAt: ahead(3 * HOUR) }] },
          broadcasts: { available: false, unavailable: 'migration-061', total: 0, rows: [] },
          reminders: { available: false, unavailable: 'migration-060', total: 0, rows: [] },
        },
      },
    },
  });
  await api.loadNotifQueue();
  assert.equal(node('notif-queue-error').hidden, true);
  assert.match(node('notif-queue-deals').innerHTML, /Half off/);
  assert.match(node('notif-queue-deals').innerHTML, /Quiet hours/);
  assert.match(node('notif-queue-broadcasts').innerHTML, /Migration 061 not applied/);
  assert.match(node('notif-queue-reminders').innerHTML, /Migration 060 not applied/);
  assert.equal(node('notif-quiet').hidden, false);
});

test('reminder Preview only POSTs to the preview route and shows what would be sent', async () => {
  const queue = {
    generatedAt: new Date(NOW).toISOString(),
    quietHours: { active: false },
    deals: { available: true, total: 0, rows: [] },
    broadcasts: { available: true, total: 0, rows: [] },
    reminders: { available: true, total: 1, rows: [{ source: 'reminder', studentId: 'u1', studentName: 'Ana', status: 'due', blockers: [], nextEligibleAt: null, position: 1 }] },
  };
  const { api, node, calls } = sandbox({
    routes: (url) => (url.startsWith('/api/admin/notifications/reminders/preview/')
      ? { body: { candidate: { kind: 'spendable' }, composed: { title: 'You can redeem <now>', body: 'Free taco' } } }
      : { body: queue }),
  });
  await api.loadNotifQueue();
  const tap = { target: { closest: (sel) => (sel === '.notif-preview-btn' ? { dataset: { user: 'u1' } } : null) } };
  api.onNotifTap(tap);
  await new Promise((r) => setImmediate(r));
  const posts = calls.fetches.filter((f) => f.method !== 'GET');
  assert.deepEqual(posts, [{ url: '/api/admin/notifications/reminders/preview/u1', method: 'POST' }]);
  assert.ok(!calls.fetches.some((f) => /claim|refund|send/i.test(f.url)), 'a preview must never reach a claim or send path');
  assert.match(node('notif-queue-reminders').innerHTML, /You can redeem &lt;now&gt;/);
});

/* ---------- timers ---------- */

test('no timer runs while the Notifications view is not on screen', () => {
  const { api, node, live } = sandbox();
  node('view-notifications').hidden = true;
  api.syncNotifTimers();
  assert.equal(live().length, 0);
});

test('timers start with the view, never duplicate, and stop when the page is hidden', () => {
  const { api, node, document, live, calls } = sandbox();
  node('view-notifications').hidden = false;
  api.syncNotifTimers();
  assert.deepEqual(live().map((t) => t.ms).sort((a, b) => a - b), [15000, 30000]);
  api.syncNotifTimers();
  assert.equal(live().length, 2, 'a second sync must not stack a second pair of intervals');

  document.visibilityState = 'hidden';
  api.syncNotifTimers({ catchUp: true });
  assert.equal(live().length, 0, 'a hidden page polls nothing');
  assert.equal(calls.cleared.length, 2);
});

test('coming back to a visible page restarts the timers and refreshes at once', async () => {
  const { api, node, document, live, calls } = sandbox({
    routes: { '/api/admin/notifications/health': { body: { push: { configured: true } } } },
    visible: false,
  });
  node('view-notifications').hidden = false;
  api.setLoaded(true);
  api.syncNotifTimers();
  assert.equal(live().length, 0);

  document.visibilityState = 'visible';
  api.syncNotifTimers({ catchUp: true });
  assert.equal(live().length, 2);
  await new Promise((r) => setImmediate(r));
  assert.ok(calls.fetches.some((f) => f.url === '/api/admin/notifications/health'), 'the catch-up refresh should run');
});

test('leaving the view (or signing out) stops both timers', () => {
  const { api, node, live } = sandbox();
  node('view-notifications').hidden = false;
  api.syncNotifTimers();
  assert.equal(live().length, 2);
  node('view-notifications').hidden = true;
  api.syncNotifTimers();
  assert.equal(live().length, 0);

  node('view-notifications').hidden = false;
  api.syncNotifTimers();
  api.stopNotifTimers();        // render(null)'s call
  assert.equal(live().length, 0);
});

test('a tick that fires after the page went hidden fetches nothing and puts the timers away', async () => {
  const { api, node, document, live, calls } = sandbox({ routes: () => ({ body: {} }) });
  node('view-notifications').hidden = false;
  api.setLoaded(true);
  api.syncNotifTimers();
  document.visibilityState = 'hidden';
  await api.notifFastTick();
  await api.pollNewNotifications();
  assert.equal(calls.fetches.length, 0);
  assert.equal(live().length, 0);
});

test('a tick inside render()\'s brief hidden-dashboard window skips, and keeps the timers', async () => {
  const { api, node, live, calls } = sandbox({ routes: () => ({ body: {} }) });
  node('view-notifications').hidden = false;
  api.setLoaded(true);
  api.syncNotifTimers();
  node('dash').hidden = true;                 // render(session), access check in flight
  await api.notifFastTick();
  assert.equal(calls.fetches.length, 0, 'nothing is fetched while the dashboard is down');
  assert.equal(live().length, 2, 'stopping here left the tab stale once the dashboard came back');
  node('dash').hidden = false;                // loadOverview revealed it
  await api.notifFastTick();
  assert.ok(calls.fetches.some((f) => f.url === '/api/admin/notifications/health'));
});

test('showing the dashboard again restarts the auto-refresh', () => {
  const overview = src.slice(src.indexOf('async function loadOverview() {'), src.indexOf('const money ='));
  assert.match(overview, /\$\('dash'\)\.hidden = false;[\s\S]*syncNotifTimers\(\);/,
    'after render(null) stopped the timers, a sign-in from another tab must start them again');
});

test('an hourly token refresh does not hide the dashboard or reload its lists', () => {
  const fnSrc = src.slice(src.indexOf('function onAuthEvent(event, session) {'), src.indexOf('// Panels are mutually exclusive'));
  assert.ok(fnSrc.length > 0, 'onAuthEvent moved: re-anchor this test');
  assert.match(src, /sb\.auth\.onAuthStateChange\(onAuthEvent\);/, 'boot must route auth events through the guard');
  const run = (event, dashHidden) => {
    const renders = [];
    const dash = { hidden: dashHidden };
    // eslint-disable-next-line no-new-func
    const onAuthEvent = new Function('$', 'render', `${fnSrc}; return onAuthEvent;`)(() => dash, (s) => renders.push(s));
    onAuthEvent(event, { user: { email: 'a@x' } });
    return renders.length;
  };
  assert.equal(run('TOKEN_REFRESHED', false), 0, 'same session, new token: nothing to redo');
  assert.equal(run('TOKEN_REFRESHED', true), 1, 'before the dashboard is up it still goes through');
  for (const e of ['SIGNED_IN', 'SIGNED_OUT', 'INITIAL_SESSION', 'USER_UPDATED']) {
    assert.equal(run(e, false), 1, `${e} behaves exactly as before`);
  }
});

test('a signed-out dashboard polls nothing even if the view flag is stale', () => {
  const { api, node, live } = sandbox();
  node('view-notifications').hidden = false;
  node('dash').hidden = true;
  api.syncNotifTimers();
  assert.equal(live().length, 0);
});

test('the wiring outside the block: setView syncs, sign-out stops, Escape closes', () => {
  const setView = src.slice(src.indexOf('function setView(view) {'), src.indexOf('function jumpToErrors'));
  assert.match(setView, /syncNotifTimers\(\);/);
  const render = src.slice(src.indexOf('function render(session) {'), src.indexOf('async function denyAccess'));
  const signedOut = render.slice(0, render.indexOf("$('login').hidden = true;"));
  assert.match(signedOut, /stopNotifTimers\(\);/);
  assert.match(signedOut, /closeNotifDetail\(\);/);
  const escape = src.slice(src.indexOf("if (e.key !== 'Escape') return;"), src.indexOf("$('poster-pick')"));
  assert.match(escape, /notif-modal[\s\S]*closeNotifDetail\(\)[\s\S]*else if \(!\$\('student-modal'\)\.hidden\) closeStudentDetail\(\)/,
    'the popup sits over the student card, so Escape must peel it first and alone');
  assert.match(src.slice(src.indexOf('const VIEWS'), src.indexOf('const VIEWS') + 200), /'notifications'/);
});

/* ---------- dashboard tile and the student card ---------- */

test('the dashboard tile shows today and the queue, and hides itself on failure', async () => {
  const ok = sandbox({
    routes: { '/api/admin/notifications/summary': { body: { logAvailable: true, today: { sent: 12, failed: 1, refused: 4, allowed: 3 }, queued: { deals: 2, broadcasts: 5 }, workerDown: true } } },
  });
  await ok.api.loadNotifSummary();
  assert.equal(ok.node('notif-tile').hidden, false);
  assert.equal(ok.node('notif-tile-text').textContent, '12 sent, 1 failed, 7 queued');
  assert.equal(ok.node('notif-tile-dot').hidden, false, 'a down worker lights the dot');

  const down = sandbox({ routes: { '/api/admin/notifications/summary': new Error('offline') } });
  down.node('notif-tile').hidden = false;
  await down.api.loadNotifSummary();
  assert.equal(down.node('notif-tile').hidden, true, 'a failed read hides the tile rather than showing zeros');
});

test('the student card section is dropped if the operator moved on to another student', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { api, node } = sandbox({
    routes: (url) => (url.includes('/student/') ? gate.then(() => ({ body: { budget: null, recent: [] } })) : { body: {} }),
  });
  node('student-modal').hidden = false;
  const pending = api.loadStudentNotifSection('s1').catch(() => {});
  api.cancelStudentNotifSection();          // openStudentDetail for somebody else
  release();
  await pending;
  assert.equal(node('student-detail-body').children.length, 0, 'A\'s history must not land in B\'s card');
});
