// The /admin notification log + queue API (src/routes/admin.js, migration-062).
//
// The routes are driven for real: the exported sub-router is mounted on a
// bare express app (no requireAdmin, which in production is the gate it sits
// behind), and Supabase is answered by patching globalThis.fetch. supabaseAdmin
// resolves fetch per request (retryingFetch's `doFetch = fetch` default), so
// one patch sees every PostgREST read and RPC the route and the libraries it
// calls make, with no module mocking and no database.
//
// What these tests hold is mostly what must NOT happen:
//
//   • A database without migration-062 (or 060/061/047) must answer 200 with
//     `unavailable` naming the missing paste, never a 500, and each queue
//     section must fail on its own.
//   • A page past the end must not 500 (PostgREST answers it with PGRST103).
//   • `/:id` must not swallow `/queue`, `/summary`, `/health`, `/student/:id`.
//   • The reminder preview must never call a claim or refund function.
//   • No response may ever carry a push endpoint URL: it is a capability.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import adminRouter, {
  notificationRoutes, unavailableFor, isMissingObject, quietHoursAt, localMidnight,
  queueRow, anyWorkerDown, notifFilters, notifSummary,
} from '../src/routes/admin.js';
import { setIo } from '../src/lib/realtime.js';
import { deviceLabelFromUA, flushNotificationLog, _resetNotificationLogForTests } from '../src/lib/notification-log.js';

const STUDENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const STUDENT_2 = 'abababab-cdcd-4efe-8aba-cdcdcdcdcdcd';
const VENDOR = 'fafafafa-bcbc-4ded-8efe-abababababab';
const CAMPAIGN = 'cacacaca-dbdb-4ecf-8fab-cdcdcdcdcdcd';
const BROADCAST = 'bebebebe-adad-4cfc-8bab-dedededededf';
const NOTIF = 'dededede-efef-4aba-8cdc-efefefefefef';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/SECRET-CAPABILITY-TOKEN-123';
const WINDOWS_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ---------- a fake PostgREST ---------- */

const realFetch = globalThis.fetch;
let handlers = {};      // 'table' or 'rpc/name' -> (call) => reply
let fallback = null;    // (call) => reply, for anything unlisted
let calls = [];

const missingTable = (path) => ({ status: 404, data: { code: 'PGRST205', message: `Could not find the table 'public.${path}' in the schema cache` } });
const missingFn = (path) => ({ status: 404, data: { code: 'PGRST202', message: `Could not find the function public.${path.slice(4)}` } });
const missingColumn = (col) => ({ status: 400, data: { code: '42703', message: `column ${col} does not exist` } });
const relationMissing = (rel) => ({ status: 400, data: { code: '42P01', message: `relation "${rel}" does not exist` } });

function reply(call, out) {
  const { status = 200, data = [], total } = out ?? {};
  const headers = { 'content-type': 'application/json' };
  if (/count=exact/.test(call.headers.get('prefer') ?? '')) {
    const n = Array.isArray(data) ? data.length : 0;
    const t = total ?? n;
    headers['content-range'] = n ? `${call.offset}-${call.offset + n - 1}/${t}` : `*/${t}`;
  }
  if (call.method === 'HEAD') return new Response(null, { status, headers });
  return new Response(JSON.stringify(data), { status, headers });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname !== 'unit-test-placeholder.invalid') return realFetch(input, init);
  const path = url.pathname.replace(/^\/rest\/v1\//, '');
  const call = {
    method: String(init.method ?? 'GET').toUpperCase(),
    path,
    params: url.searchParams,
    offset: Number(url.searchParams.get('offset') ?? 0),
    headers: new Headers(init.headers),
    body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
  };
  calls.push(call);
  const h = handlers[path] ?? fallback;
  if (h) return reply(call, await h(call));
  return reply(call, path.startsWith('rpc/') ? missingFn(path) : missingTable(path));
};

/* ---------- the app under test ---------- */

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/notifications', notificationRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: 'INTERNAL', message: String(err?.message ?? err) }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/admin/notifications`;
});

after(async () => {
  setIo(null);
  globalThis.fetch = realFetch;
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  handlers = {};
  fallback = null;
  calls = [];
  setIo(null);
});

async function get(path, opts = {}) {
  const res = await realFetch(`${base}${path}`, opts);
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

const callsTo = (path) => calls.filter((c) => c.path === path);

function logRow(over = {}) {
  return {
    id: NOTIF,
    created_at: '2026-10-03T14:00:00.000Z',
    channel: 'push',
    kind: 'deal',
    outcome: 'sent',
    reason: null,
    recipient_kind: 'student',
    student_id: STUDENT,
    recipient_email: null,
    recipient_label: null,
    vendor_id: VENDOR,
    title: 'Sher Halal has something on',
    devices_tried: 2,
    devices_accepted: 1,
    delivery_status: null,
    source: 'live',
    ...over,
  };
}

const profiles = () => [
  { user_id: STUDENT, name: 'Casey Jones', email: 'casey@psu.edu' },
  { user_id: STUDENT_2, name: 'Riley Smith', email: 'riley@psu.edu' },
];

/* ---------- pure helpers ---------- */

describe('unavailableFor', () => {
  test('a missing function always names migration-062', () => {
    for (const code of ['PGRST202', '42883']) {
      assert.equal(unavailableFor({ code }, 'migration-061'), 'migration-062');
    }
  });

  test('a missing table or column names the prerequisite the caller gave', () => {
    for (const code of ['42P01', '42703', 'PGRST204', 'PGRST205']) {
      assert.equal(unavailableFor({ code }, 'migration-060'), 'migration-060');
    }
  });

  test('any other error is NOT reported as a missing migration', () => {
    // Saying "not applied" about a real fault would send the operator off to
    // paste SQL that is already there.
    for (const err of [{ code: '57014' }, { code: 'PGRST103' }, { code: '' }, null, undefined, new Error('boom')]) {
      assert.equal(unavailableFor(err, 'migration-062'), null);
      assert.equal(isMissingObject(err), false);
    }
  });
});

describe('quietHoursAt / localMidnight', () => {
  const cfg = { quietStart: 22, quietEnd: 9, timezone: 'America/New_York' };

  test('late evening is quiet and ends at 09:00 local the next morning', () => {
    // 23:30 EDT on Oct 3 is 03:30Z on Oct 4.
    const q = quietHoursAt(new Date('2026-10-04T03:30:00Z'), cfg);
    assert.equal(q.active, true);
    assert.equal(q.endsAt, '2026-10-04T13:00:00.000Z');
    assert.deepEqual([q.start, q.end, q.timezone], [22, 9, 'America/New_York']);
  });

  test('after midnight it ends the same morning, not the next one', () => {
    const q = quietHoursAt(new Date('2026-10-03T06:00:00Z'), cfg);   // 02:00 EDT
    assert.equal(q.active, true);
    assert.equal(q.endsAt, '2026-10-03T13:00:00.000Z');
  });

  test('midday is not quiet', () => {
    const q = quietHoursAt(new Date('2026-10-03T16:00:00Z'), cfg);
    assert.equal(q.active, false);
    assert.equal(q.endsAt, null);
  });

  test('start === end disables quiet hours, like the claims', () => {
    assert.equal(quietHoursAt(new Date('2026-10-04T03:30:00Z'), { ...cfg, quietStart: 9, quietEnd: 9 }).active, false);
  });

  test('a bad timezone falls back to UTC instead of throwing', () => {
    assert.doesNotThrow(() => quietHoursAt(new Date(), { ...cfg, timezone: 'Not/AZone' }));
    assert.equal(quietHoursAt(new Date(), { ...cfg, timezone: 'Not/AZone' }).timezone, 'UTC');
  });

  test('"today" starts at local midnight, across a DST change too', () => {
    assert.equal(localMidnight(new Date('2026-10-03T15:00:00Z'), 'America/New_York').toISOString(), '2026-10-03T04:00:00.000Z');
    // DST ends 02:00 on Nov 1 2026: that day's midnight is still EDT (UTC-4)...
    assert.equal(localMidnight(new Date('2026-11-01T18:00:00Z'), 'America/New_York').toISOString(), '2026-11-01T04:00:00.000Z');
    // ...and the next day's is EST (UTC-5).
    assert.equal(localMidnight(new Date('2026-11-02T18:00:00Z'), 'America/New_York').toISOString(), '2026-11-02T05:00:00.000Z');
  });
});

describe('notifFilters', () => {
  const now = new Date('2026-10-03T16:00:00Z');

  test('unknown filter values are dropped, not 400ed', () => {
    const f = notifFilters({ channel: 'sms', kind: 'spam', outcome: 'delivered', recipient: 'robot', range: '1y', after: 'yesterday' }, now);
    assert.deepEqual([f.channel, f.kind, f.outcome, f.recipient, f.since, f.after], [null, null, null, null, null, null]);
    assert.equal(f.impossible, false);
  });

  test('a junk student id matches nothing rather than everyone', () => {
    assert.equal(notifFilters({ student: 'not-a-uuid' }, now).impossible, true);
    assert.equal(notifFilters({ student: STUDENT }, now).student, STUDENT);
  });

  test('ranges: today is local midnight, 7d and 30d are rolling', () => {
    assert.equal(notifFilters({ range: 'today' }, now, 'America/New_York').since, '2026-10-03T04:00:00.000Z');
    assert.equal(notifFilters({ range: '7d' }, now).since, '2026-09-26T16:00:00.000Z');
    assert.equal(notifFilters({ range: '30d' }, now).since, '2026-09-03T16:00:00.000Z');
  });

  test('after keeps the cursor verbatim, microseconds included', () => {
    // Re-serialising through Date cut .123456 to .123, and the newest row then
    // counted as "1 new" against its own cursor on every poll.
    for (const s of ['2026-10-03T12:00:00.123456+00:00', '2026-10-03T12:00:00Z', '2026-10-03T08:00:00.5-04:00']) {
      assert.equal(notifFilters({ after: ` ${s} ` }, now).after, s);
    }
  });

  test('after rejects anything that is not a whole, real, zoned instant', () => {
    for (const s of [
      'yesterday', '2026-10-03', '2026-10-03T12:00:00', '2026-10-03T12:00Z', '2026-10-03 12:00:00Z',
      '2026-02-30T12:00:00Z', '2026-13-01T00:00:00Z', '2026-10-03T24:00:00Z', '2026-10-03T12:60:00Z',
      '2026-10-03T12:00:00Z junk', '2026-10-03T12:00:00.1234567890Z', '2026-10-03T12:00:00+16:00', '1791028800123',
    ]) {
      assert.equal(notifFilters({ after: s }, now).after, null, s);
    }
    assert.equal(notifFilters({ after: '2028-02-29T00:00:00Z' }, now).after, '2028-02-29T00:00:00Z', 'a real leap day');
  });

  test('an object smuggled into the query string cannot throw', () => {
    assert.doesNotThrow(() => notifFilters({ channel: { toString: 'x' }, q: { toString: 'x' }, after: { toString: '1' } }, now));
  });
});

describe('queueRow', () => {
  const names = { profiles: new Map([[STUDENT, { name: 'Casey Jones', email: 'casey@psu.edu' }]]), vendors: new Map([[VENDOR, 'Sher Halal']]) };

  test('a backed-off broadcast student gets the blocker and a later next-eligible time', () => {
    const until = '2026-10-03T18:00:00.000Z';
    const r = queueRow('broadcast', {
      broadcast_id: BROADCAST, user_id: STUDENT, status: 'queued', title: 'Hi',
      next_eligible_at: '2026-10-03T16:00:00.000Z', blockers: [],
    }, 0, { names, visible: new Set(), backoff: new Map([[STUDENT, until]]) });
    assert.deepEqual(r.blockers, ['backoff']);
    assert.equal(r.nextEligibleAt, until);
  });

  test('backoff never turns "time cannot fix this" (null) into a time', () => {
    const r = queueRow('reminder', { user_id: STUDENT, queue_position: 3, next_eligible_at: null, blockers: ['reminder_opt_out'] },
      0, { names, visible: new Set(), backoff: new Map([[STUDENT, '2026-10-03T18:00:00.000Z']]) });
    assert.equal(r.nextEligibleAt, null);
    assert.deepEqual(r.blockers, ['reminder_opt_out', 'backoff']);
    assert.equal(r.position, 3);
    assert.equal(r.status, 'due');
  });

  test('deals do not get the backoff blocker (the deal worker keeps no backoff list)', () => {
    const r = queueRow('deal', { campaign_id: CAMPAIGN, user_id: STUDENT, vendor_id: VENDOR, status: 'sending', blockers: ['sending'] },
      4, { names, visible: new Set([STUDENT]), backoff: new Map([[STUDENT, '2026-10-03T18:00:00.000Z']]) });
    assert.deepEqual(r.blockers, ['sending', 'app_open']);
    assert.equal(r.vendorName, 'Sher Halal');
    assert.equal(r.studentEmail, 'casey@psu.edu');
    assert.equal(r.position, 5);
    assert.equal(r.itemId, CAMPAIGN);
  });
});

describe('anyWorkerDown', () => {
  const ok = { configured: true, running: true, rpcMissing: false, lastTickAt: '2026-10-03T16:00:00Z', lastErrorAt: null };

  test('a healthy or unconfigured worker is not down', () => {
    assert.equal(anyWorkerDown([ok, { ...ok, configured: false, running: false }]), false);
  });

  test('not running, a missing claim function, or a newer error than tick: down', () => {
    assert.equal(anyWorkerDown([{ ...ok, running: false }]), true);
    assert.equal(anyWorkerDown([{ ...ok, rpcMissing: true }]), true);
    assert.equal(anyWorkerDown([{ ...ok, lastErrorAt: '2026-10-03T16:01:00Z' }]), true);
    assert.equal(anyWorkerDown([{ ...ok, lastTickAt: null, lastErrorAt: '2026-10-03T16:01:00Z' }]), true);
    assert.equal(anyWorkerDown([{ ...ok, lastErrorAt: '2026-10-03T15:59:00Z' }]), false);
  });
});

test('notifSummary: an email row shows where it actually went, a push row the current profile', () => {
  const names = { profiles: new Map([[STUDENT, { name: 'Casey Jones', email: 'new@psu.edu' }]]), vendors: new Map() };
  assert.equal(notifSummary(logRow({ channel: 'email', recipient_email: 'old@psu.edu' }), names).recipientEmail, 'old@psu.edu');
  assert.equal(notifSummary(logRow(), names).recipientEmail, 'new@psu.edu');
  assert.equal(notifSummary(logRow({ student_id: null, recipient_kind: 'admin', recipient_label: 'Admin devices' }), names).recipientName, 'Admin devices');
});

/* ---------- GET / (the log) ---------- */

describe('GET /notifications', () => {
  test('without migration-062: 200, unavailable, empty page', async () => {
    const { status, body } = await get('?limit=25&offset=50');
    assert.equal(status, 200);
    assert.deepEqual(body, { unavailable: 'migration-062', rows: [], total: 0, offset: 50, limit: 25 });
  });

  test('rows come back newest first with names from ONE profiles and ONE vendors read', async () => {
    handlers.notification_log = () => ({
      data: [logRow(), logRow({ id: '11111111-2222-4333-8444-555555555555', student_id: STUDENT_2 })],
      total: 2,
    });
    handlers.profiles = () => ({ data: profiles() });
    handlers.vendors = () => ({ data: [{ id: VENDOR, name: 'Sher Halal' }] });

    const { status, body } = await get('');
    assert.equal(status, 200);
    assert.equal(body.total, 2);
    assert.equal(body.rows.length, 2);
    assert.equal(body.rows[0].recipientName, 'Casey Jones');
    assert.equal(body.rows[0].recipientEmail, 'casey@psu.edu');
    assert.equal(body.rows[1].recipientName, 'Riley Smith');
    assert.equal(body.rows[0].vendorName, 'Sher Halal');
    assert.equal(body.rows[0].devicesTried, 2);
    assert.equal(callsTo('profiles').length, 1, 'names must not be resolved per row');
    assert.equal(callsTo('vendors').length, 1);
    const log = callsTo('notification_log')[0];
    assert.equal(log.params.get('order'), 'created_at.desc,id.desc');
  });

  test('a page past the end is an empty page with the real total, not a 500', async () => {
    handlers.notification_log = (call) => {
      if (call.method === 'HEAD') return { data: [], total: 7 };
      if (call.offset >= 7) return { status: 416, data: { code: 'PGRST103', message: 'Requested range not satisfiable' } };
      return { data: [logRow()], total: 7 };
    };
    const { status, body } = await get('?offset=500');
    assert.equal(status, 200);
    assert.deepEqual(body, { rows: [], total: 7, offset: 500, limit: 50 });
    assert.ok(callsTo('notification_log').some((c) => c.method === 'HEAD'), 'the total is re-read through pageOf');
  });

  test('filters reach the query; junk ones do not', async () => {
    handlers.notification_log = () => ({ data: [] });
    await get('?channel=email&kind=vendor_reset&outcome=failed&recipient=vendor&range=7d&after=2026-10-03T12:00:00Z');
    const p = callsTo('notification_log')[0].params;
    assert.equal(p.get('channel'), 'eq.email');
    assert.equal(p.get('kind'), 'eq.vendor_reset');
    assert.equal(p.get('outcome'), 'eq.failed');
    assert.equal(p.get('recipient_kind'), 'eq.vendor');
    assert.match(p.getAll('created_at').join(' '), /gte\./);
    assert.ok(p.getAll('created_at').includes('gt.2026-10-03T12:00:00Z'), p.getAll('created_at').join(' '));

    calls = [];
    await get('?channel=sms&kind=nope');
    const q = callsTo('notification_log')[0].params;
    assert.equal(q.get('channel'), null);
    assert.equal(q.get('kind'), null);
  });

  test('the "N new" poll sends the newest row\'s exact created_at, to the microsecond', async () => {
    handlers.notification_log = () => ({ data: [] });
    const since = '2026-10-03T12:00:00.123456+00:00';
    await get(`?limit=1&after=${encodeURIComponent(since)}`);
    assert.deepEqual(callsTo('notification_log')[0].params.getAll('created_at'), [`gt.${since}`]);

    calls = [];
    await get(`?limit=1&after=${encodeURIComponent('2026-02-30T12:00:00Z')}`);
    assert.deepEqual(callsTo('notification_log')[0].params.getAll('created_at'), [], 'a date Postgres would refuse must not reach it');
  });

  test('q searches the row text AND matching students, with the term sanitised', async () => {
    handlers.profiles = (call) => (call.params.get('or') ? { data: [{ user_id: STUDENT }] } : { data: profiles() });
    handlers.notification_log = () => ({ data: [] });
    await get(`?q=${encodeURIComponent('casey,(x)')}`);

    const profileSearch = callsTo('profiles')[0];
    assert.equal(profileSearch.params.get('or'), '(name.ilike.*casey  x*,email.ilike.*casey  x*)');
    assert.equal(profileSearch.params.get('limit'), '200');
    const or = callsTo('notification_log')[0].params.get('or');
    assert.match(or, /recipient_email\.ilike\.\*casey {2}x\*/);
    assert.match(or, /recipient_label\.ilike/);
    assert.match(or, /title\.ilike/);
    assert.match(or, new RegExp(`student_id\\.in\\.\\(${STUDENT}\\)`));
    assert.ok(!or.includes('(x)'), 'the typed parens must not reach the filter grammar');
  });

  test('a junk student filter answers an empty page without reading the log', async () => {
    handlers.notification_log = () => ({ data: [logRow()] });
    const { body } = await get('?student=nope');
    assert.deepEqual(body.rows, []);
    assert.equal(callsTo('notification_log').length, 0);
  });

  test('any other database error is a 500, not "not applied"', async () => {
    handlers.notification_log = () => ({ status: 500, data: { code: '57014', message: 'canceling statement due to statement timeout' } });
    const { status } = await get('');
    assert.equal(status, 500);
  });
});

/* ---------- /summary and /health ---------- */

describe('GET /notifications/summary', () => {
  test('without 062 or 061 it still answers: logAvailable false, broadcasts null', async () => {
    handlers.campaign_recipients = () => ({ data: [{ campaign_id: CAMPAIGN }], total: 12 });
    const { status, body } = await get('/summary');
    assert.equal(status, 200);
    assert.equal(body.logAvailable, false);
    assert.deepEqual(body.today, { sent: 0, failed: 0, refused: 0, allowed: 0 });
    assert.deepEqual(body.queued, { deals: 12, broadcasts: null });
    assert.equal(typeof body.workerDown, 'boolean');
    assert.equal(typeof body.pushConfigured, 'boolean');
    assert.equal(typeof body.emailConfigured, 'boolean');
  });

  test('counts today per outcome by GET (a HEAD would hide a missing table)', async () => {
    const totals = { sent: 9, failed: 2, refused: 4, allowed: 1 };
    handlers.notification_log = (call) => ({ data: [{ id: NOTIF }], total: totals[call.params.get('outcome').slice(3)] });
    handlers.campaign_recipients = () => ({ data: [], total: 0 });
    handlers.admin_broadcast_recipients = () => ({ data: [], total: 3 });
    const { body } = await get('/summary');
    assert.equal(body.logAvailable, true);
    assert.deepEqual(body.today, totals);
    assert.deepEqual(body.queued, { deals: 0, broadcasts: 3 });
    assert.ok(calls.every((c) => c.method === 'GET'));
  });
});

describe('GET /notifications/health', () => {
  test('each probe is true, false (missing) or null (could not tell)', async () => {
    handlers.campaign_recipients = () => ({ data: [] });
    handlers.notification_log = () => ({ data: [] });
    handlers.student_notify_state = () => missingColumn('student_notify_state.last_reminder_at');
    handlers.nearby_notifications = () => ({ status: 500, data: { code: '57014', message: 'timeout' } });
    // admin_broadcasts: unlisted, so the fake says the table is missing.
    const { status, body } = await get('/health');
    assert.equal(status, 200);
    assert.deepEqual(body.migrations, { '047': true, '051': null, '060': false, '061': false, '062': true });
    assert.equal(body.log.available, true);
    for (const w of ['campaigns', 'reminders', 'broadcasts']) {
      assert.equal(typeof body.workers[w].running, 'boolean', `${w} status missing`);
    }
    assert.equal(typeof body.webhook.configured, 'boolean');
    assert.equal(body.visibleStudents, 0);
    assert.ok(body.generatedAt);
  });
});

/* ---------- /queue ---------- */

function queueHandlers() {
  handlers['rpc/admin_campaign_queue'] = () => ({
    data: [{
      campaign_id: CAMPAIGN, user_id: STUDENT, vendor_id: VENDOR, status: 'queued', title: '2 for 1 wraps',
      queued_at: '2026-10-03T15:00:00Z', deliver_after: null, expires_at: '2026-10-05T15:00:00Z', claimed_at: null,
      has_push: true, email_reachable: false, next_eligible_at: '2026-10-03T19:00:00Z', blockers: ['cooldown'], total_queued: 31,
    }],
  });
  handlers['rpc/admin_broadcast_queue'] = () => ({
    data: [{
      broadcast_id: BROADCAST, user_id: STUDENT_2, status: 'queued', title: 'Welcome back', audience: 'all',
      queued_at: '2026-10-03T15:00:00Z', expires_at: '2026-10-04T15:00:00Z', claimed_at: null, has_push: true,
      next_eligible_at: '2026-10-03T16:00:00Z', blockers: [], total_queued: 400,
    }],
  });
  handlers['rpc/admin_reminder_queue'] = () => ({
    data: [{
      user_id: STUDENT, queue_position: 1, last_reminder_at: null, last_push_at: null, has_push: true,
      next_eligible_at: '2026-10-03T16:00:00Z', blockers: [], total_candidates: 88,
    }],
  });
  handlers.profiles = () => ({ data: profiles() });
  handlers.vendors = () => ({ data: [{ id: VENDOR, name: 'Sher Halal' }] });
}

describe('GET /notifications/queue', () => {
  test('three sections, names resolved once, app_open added for a foreground student', async () => {
    queueHandlers();
    // One socket for STUDENT, app in the foreground.
    setIo({ of: () => ({ sockets: new Map([['s1', { data: { userId: STUDENT, visible: true } }]]) }) });

    const { status, body } = await get('/queue');
    assert.equal(status, 200);
    assert.equal(body.deals.available, true);
    assert.equal(body.deals.total, 31);
    assert.equal(body.broadcasts.total, 400);
    assert.equal(body.reminders.total, 88);

    const deal = body.deals.rows[0];
    assert.equal(deal.source, 'deal');
    assert.equal(deal.itemId, CAMPAIGN);
    assert.equal(deal.studentName, 'Casey Jones');
    assert.equal(deal.studentEmail, 'casey@psu.edu');
    assert.equal(deal.vendorName, 'Sher Halal');
    assert.deepEqual(deal.blockers, ['cooldown', 'app_open']);
    assert.deepEqual(body.reminders.rows[0].blockers, ['app_open']);
    assert.deepEqual(body.broadcasts.rows[0].blockers, [], 'a student with no socket is not "app open"');

    assert.equal(callsTo('profiles').length, 1, 'one profiles read for all three sections');
    assert.equal(callsTo('vendors').length, 1);
    assert.equal(typeof body.quietHours.active, 'boolean');

    // The worker's own config reaches the functions.
    const campaignCall = callsTo('rpc/admin_campaign_queue')[0].body;
    assert.equal(typeof campaignCall.p_email_enabled, 'boolean');
    assert.equal(campaignCall.p_cooldown_minutes, 240);
    assert.equal(callsTo('rpc/admin_reminder_queue')[0].body.p_min_interval_hours, 72);
  });

  test('the gate values the blocker copy needs come back as config', async () => {
    queueHandlers();
    const { body } = await get('/queue');
    assert.deepEqual(Object.keys(body.config).sort(), [
      'cooldownMinutes', 'dailyCap', 'minIntervalHours', 'quietEnd', 'quietStart', 'timezone', 'vendorCooldownHours', 'weeklyCap',
    ]);
    assert.equal(body.config.cooldownMinutes, 240);
    assert.equal(body.config.minIntervalHours, 72);
    assert.equal(body.config.vendorCooldownHours, callsTo('rpc/admin_campaign_queue')[0].body.p_vendor_cooldown_hours);
    assert.equal(body.config.timezone, callsTo('rpc/admin_campaign_queue')[0].body.p_timezone);
  });

  test('reminders: 200 fetched, the ones time will release listed first, 50 shown, the rest counted', async () => {
    queueHandlers();
    // 120 never-releasable candidates ahead of 80 releasable ones, the way a
    // staleness ranking lays them out (opted-out students are the stalest).
    const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const cands = Array.from({ length: 200 }, (_, i) => ({
      user_id: id(i + 1), queue_position: i + 1, has_push: i >= 120,
      next_eligible_at: i < 120 ? null : '2026-10-03T16:00:00Z',
      blockers: i < 120 ? ['no_device'] : [], total_candidates: 900,
    }));
    handlers['rpc/admin_reminder_queue'] = () => ({ data: cands });
    handlers.profiles = () => ({ data: [] });

    const { status, body } = await get('/queue');
    assert.equal(status, 200);
    assert.equal(callsTo('rpc/admin_reminder_queue')[0].body.p_limit, 200);
    assert.equal(body.reminders.total, 900);
    assert.equal(body.reminders.blockedForever, 120);
    assert.equal(body.reminders.rows.length, 50);
    assert.deepEqual(body.reminders.rows.map((r) => r.position), Array.from({ length: 50 }, (_, i) => 121 + i));
    assert.ok(body.reminders.rows.every((r) => r.nextEligibleAt));

    // Fewer releasable than a page: they lead, then the blocked by position.
    handlers['rpc/admin_reminder_queue'] = () => ({ data: cands.slice(100, 130).reverse() });
    const { body: b2 } = await get('/queue');
    assert.equal(b2.reminders.blockedForever, 20);
    assert.deepEqual(b2.reminders.rows.map((r) => r.position),
      [...Array.from({ length: 10 }, (_, i) => 121 + i), ...Array.from({ length: 20 }, (_, i) => 101 + i)]);
  });

  test('an unavailable reminder section still carries blockedForever', async () => {
    queueHandlers();
    handlers['rpc/admin_reminder_queue'] = () => missingColumn('st.last_reminder_at');
    const { body } = await get('/queue');
    assert.deepEqual(body.reminders, { available: false, unavailable: 'migration-060', total: 0, blockedForever: 0, rows: [] });
  });

  test('061 missing: broadcasts unavailable ONLY', async () => {
    queueHandlers();
    handlers['rpc/admin_broadcast_queue'] = () => relationMissing('public.admin_broadcast_recipients');
    const { status, body } = await get('/queue');
    assert.equal(status, 200);
    assert.deepEqual(body.broadcasts, { available: false, unavailable: 'migration-061', total: 0, rows: [] });
    assert.equal(body.deals.available, true);
    assert.equal(body.reminders.available, true);
  });

  test('060 missing: reminders unavailable ONLY', async () => {
    queueHandlers();
    handlers['rpc/admin_reminder_queue'] = () => missingColumn('st.last_reminder_at');
    const { body } = await get('/queue');
    assert.equal(body.reminders.unavailable, 'migration-060');
    assert.equal(body.deals.available, true);
    assert.equal(body.broadcasts.available, true);
  });

  test('062 missing: every section says 062, and the request still answers 200', async () => {
    const { status, body } = await get('/queue');
    assert.equal(status, 200);
    for (const s of ['deals', 'broadcasts', 'reminders']) assert.equal(body[s].unavailable, 'migration-062', s);
  });

  test('a real fault in a queue function is a 500, not "not applied"', async () => {
    queueHandlers();
    handlers['rpc/admin_campaign_queue'] = () => ({ status: 500, data: { code: 'P0001', message: 'boom' } });
    const { status } = await get('/queue');
    assert.equal(status, 500);
  });
});

/* ---------- route order and /:id ---------- */

describe('GET /notifications/:id', () => {
  test('a non-uuid and an unknown id are 404 NOT_FOUND', async () => {
    handlers.notification_log = () => ({ data: [] });
    for (const id of ['nope', NOTIF]) {
      const { status, body } = await get(`/${id}`);
      assert.equal(status, 404);
      assert.equal(body.error, 'NOT_FOUND');
    }
  });

  test('the fixed paths are not captured by /:id', async () => {
    // With nothing applied, each fixed path still answers its own 200 shape. Had
    // /:id caught them they would be 404 NOT_FOUND (none is a uuid).
    for (const [path, key] of [['/queue', 'deals'], ['/summary', 'logAvailable'], ['/health', 'migrations']]) {
      const { status, body } = await get(path);
      assert.equal(status, 200, path);
      assert.ok(key in body, `${path} answered by the wrong handler`);
      assert.ok(!('notification' in body), `${path} reached /:id`);
    }
    handlers.profiles = () => ({ data: [] });
    const { status, body } = await get(`/student/${STUDENT}`);
    assert.equal(status, 404);
    assert.equal(body.message, 'Student not found.', '/student/:id must reach its own handler');
    assert.equal(callsTo('notification_log').filter((c) => c.params.get('id')).length, 0);
  });

  test('without 062: 200 unavailable', async () => {
    const { status, body } = await get(`/${NOTIF}`);
    assert.equal(status, 200);
    assert.equal(body.unavailable, 'migration-062');
  });

  test('the detail links its campaigns and never returns an endpoint, even one quoted in an error', async () => {
    handlers.notification_log = () => ({
      data: [logRow({
        body: 'Two-for-one wraps until 9', url: `/?spot=${VENDOR}`, template: 'wr-deals',
        ref: { campaignIds: [CAMPAIGN], batch: 'b', refunded: false },
        devices: [
          { subId: 's1', service: 'google', label: 'Android Chrome', ok: false, status: 410, pruned: true,
            error: `Received unexpected response code 410 from ${ENDPOINT}`, endpoint: ENDPOINT, p256dh: 'KEY', auth: 'AUTH' },
          { subId: 's2', service: 'apple', label: 'iPhone Safari', ok: true, status: 201, pruned: false, error: null },
        ],
        provider_id: null, delivery_at: null, dedupe_key: 'deal:b',
      })],
    });
    handlers.vendor_campaigns = () => ({ data: [{ id: CAMPAIGN, title: '2 for 1 wraps', vendor_id: VENDOR }] });
    handlers.profiles = () => ({ data: profiles() });
    handlers.vendors = () => ({ data: [{ id: VENDOR, name: 'Sher Halal' }] });

    const { status, body, text } = await get(`/${NOTIF}`);
    assert.equal(status, 200);
    const n = body.notification;
    assert.deepEqual(n.linked.campaigns, [{ id: CAMPAIGN, title: '2 for 1 wraps', vendorName: 'Sher Halal' }]);
    assert.equal(n.devices.length, 2);
    assert.deepEqual(Object.keys(n.devices[0]).sort(), ['error', 'label', 'ok', 'pruned', 'service', 'status', 'subId']);
    assert.equal(n.dedupeKey, 'deal:b');
    assert.equal(n.recipientName, 'Casey Jones');
    assert.ok(!text.includes('fcm.googleapis.com'), 'an endpoint URL reached the response');
    assert.ok(!text.includes('SECRET-CAPABILITY'), 'an endpoint token reached the response');
    assert.ok(!text.includes('"p256dh"') && !text.includes('"auth"'));
    assert.equal(callsTo('vendors').length, 1, 'row vendor and campaign vendors share one read');
  });
});

/* ---------- /student/:id ---------- */

describe('GET /notifications/student/:id', () => {
  function studentHandlers() {
    handlers.profiles = () => ({ data: [profiles()[0]] });
    handlers['rpc/admin_student_notify_budget'] = () => ({
      data: [{
        user_id: STUDENT, has_state: true, push_opt_in: true, email_opt_in: false, nearby_opt_in: true, reminder_opt_in: true,
        last_push_at: '2026-10-03T13:00:00Z', last_email_at: null, last_reminder_at: null, day_count: 1, week_count: 3,
        day_resets_at: '2026-10-04T13:00:00Z', week_resets_at: '2026-10-08T13:00:00Z', cooldown_until: '2026-10-03T17:00:00Z',
        in_quiet_hours: false, quiet_ends_at: null, devices: 1, next_eligible_at: '2026-10-03T17:00:00Z', blockers: ['cooldown'],
      }],
    });
    handlers.push_subscriptions = () => ({ data: [{ id: 's1', endpoint: ENDPOINT, created_at: '2026-09-01T00:00:00Z', device_label: 'Android Chrome' }] });
    handlers.notification_log = () => ({ data: [logRow()] });
    handlers.campaign_recipients = () => ({ data: [] });
    handlers.admin_broadcast_recipients = () => ({ data: [] });
    handlers.vendors = () => ({ data: [{ id: VENDOR, name: 'Sher Halal' }] });
  }

  test('budget, devices (service, never the endpoint), recent; nothing queued costs no queue scan', async () => {
    studentHandlers();
    const { status, body, text } = await get(`/student/${STUDENT}`);
    assert.equal(status, 200);
    assert.equal(body.budget.pushOptIn, true);
    assert.equal(body.budget.emailOptIn, false);
    assert.equal(body.budget.dayCount, 1);
    assert.deepEqual(body.budget.blockers, ['cooldown']);
    assert.deepEqual(body.devices, [{ id: 's1', service: 'google', label: 'Android Chrome', createdAt: '2026-09-01T00:00:00Z' }]);
    assert.equal(body.recent.length, 1);
    assert.equal(body.recent[0].recipientName, 'Casey Jones');
    assert.deepEqual(body.queued, []);
    assert.ok(!text.includes('fcm.googleapis.com') && !text.includes('SECRET-CAPABILITY'), 'an endpoint reached the response');
    assert.equal(callsTo('rpc/admin_campaign_queue').length, 0, 'no whole-queue scan when nothing is queued');
  });

  test('queued items for the student come from the queue functions filtered by p_user_id, not a deep scan', async () => {
    // A whole-queue page filtered in JS was cut at PostgREST's max_rows, so a
    // student deep in a big send showed nothing queued.
    studentHandlers();
    handlers.campaign_recipients = () => ({ data: [{ campaign_id: CAMPAIGN }] });
    handlers.admin_broadcast_recipients = () => ({ data: [{ broadcast_id: BROADCAST }] });
    handlers['rpc/admin_campaign_queue'] = () => ({
      data: [
        { campaign_id: CAMPAIGN, user_id: STUDENT, vendor_id: VENDOR, status: 'queued', title: 'Mine', blockers: ['hold'], total_queued: 2 },
        { campaign_id: CAMPAIGN, user_id: STUDENT, vendor_id: VENDOR, status: 'queued', title: 'Mine too', blockers: ['same_spot_queued'], total_queued: 2 },
      ],
    });
    handlers['rpc/admin_broadcast_queue'] = () => ({
      data: [{ broadcast_id: BROADCAST, user_id: STUDENT, status: 'queued', title: 'Hi', blockers: ['expires_first'], next_eligible_at: null, total_queued: 1 }],
    });
    const { body } = await get(`/student/${STUDENT}`);
    for (const fn of ['rpc/admin_campaign_queue', 'rpc/admin_broadcast_queue']) {
      const sent = callsTo(fn)[0].body;
      assert.equal(sent.p_user_id, STUDENT, `${fn} not filtered to the student`);
      assert.ok(sent.p_limit <= 1000, `${fn} asked for ${sent.p_limit} rows, past PostgREST's max_rows`);
    }
    assert.deepEqual(body.queued.map((q) => [q.title, q.position]), [['Mine', 1], ['Mine too', 2], ['Hi', 1]]);
    assert.equal(body.queued[0].vendorName, 'Sher Halal');
    assert.deepEqual(body.queued[1].blockers, ['same_spot_queued'], 'new blocker codes pass through');
    assert.deepEqual(body.queued[2].blockers, ['expires_first']);
    assert.equal(body.queued[2].nextEligibleAt, null);
  });

  test('the student panel carries the same config as the queue', async () => {
    studentHandlers();
    const { body } = await get(`/student/${STUDENT}`);
    assert.equal(body.config.cooldownMinutes, 240);
    assert.equal(body.config.minIntervalHours, 72);
    assert.equal(typeof body.config.vendorCooldownHours, 'number');
  });

  test('pre-062: budget and recent are unavailable, devices still listed without device_label', async () => {
    handlers.profiles = () => ({ data: [profiles()[0]] });
    handlers.push_subscriptions = (call) => (call.params.get('select').includes('device_label')
      ? { status: 400, data: { code: '42703', message: 'column push_subscriptions.device_label does not exist' } }
      : { data: [{ id: 's1', endpoint: ENDPOINT, created_at: '2026-09-01T00:00:00Z' }] });
    const { status, body } = await get(`/student/${STUDENT}`);
    assert.equal(status, 200);
    assert.equal(body.budget, null);
    assert.equal(body.budgetUnavailable, 'migration-062');
    assert.equal(body.recentUnavailable, 'migration-062');
    assert.deepEqual(body.recent, []);
    assert.deepEqual(body.devices, [{ id: 's1', service: 'google', label: null, createdAt: '2026-09-01T00:00:00Z' }]);
  });

  test('a non-uuid or unknown student is 404', async () => {
    handlers.profiles = () => ({ data: [] });
    assert.equal((await get('/student/nope')).status, 404);
    assert.equal((await get(`/student/${STUDENT}`)).status, 404);
  });
});

/* ---------- reminder preview ---------- */

describe('POST /notifications/reminders/preview/:userId', () => {
  test('composes without ever claiming, refunding or writing', async () => {
    handlers.student_notify_state = () => ({ data: [] });
    handlers.profiles = () => ({ data: [profiles()[0]] });
    // Every other read answers empty, the way a quiet database would.
    fallback = (call) => (call.path.startsWith('rpc/') ? { data: [] } : { data: [] });

    const { status, body } = await get(`/reminders/preview/${STUDENT}`, { method: 'POST' });
    assert.equal(status, 200);
    assert.ok('candidate' in body && 'composed' in body);
    assert.equal(body.unavailable, undefined);
    const rpcs = calls.filter((c) => c.path.startsWith('rpc/')).map((c) => c.path);
    assert.ok(!rpcs.some((p) => /claim|refund|finish/.test(p)), `preview called ${rpcs.join(', ')}`);
    const writes = calls.filter((c) => !c.path.startsWith('rpc/') && c.method !== 'GET');
    assert.deepEqual(writes.map((c) => `${c.method} ${c.path}`), [], 'preview wrote to a table');
  });

  test('without 060 it says so and composes nothing', async () => {
    handlers.student_notify_state = () => missingColumn('student_notify_state.last_reminder_at');
    fallback = () => ({ data: [] });
    const { status, body } = await get(`/reminders/preview/${STUDENT}`, { method: 'POST' });
    assert.equal(status, 200);
    assert.deepEqual(body, { unavailable: 'migration-060', candidate: null, composed: null });
    assert.equal(calls.length, 1, 'nothing past the probe ran');
  });

  test('a non-uuid is 404 and touches nothing', async () => {
    const { status } = await get('/reminders/preview/nope', { method: 'POST' });
    assert.equal(status, 404);
    assert.equal(calls.length, 0);
  });
});

/* ---------- admin.js call sites outside the sub-router ---------- */

// These two live on the main admin router, behind requireAdmin, so they are
// driven by calling the route's own handler with a hand-built req/res rather
// than through HTTP.
function handlerFor(method, path) {
  const layer = adminRouter.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `no ${method} ${path} route`);
  return layer.route.stack.at(-1).handle;
}

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

describe('POST /push/subscribe (admin) device label', () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } };
  const req = () => ({ body: sub, user: { id: STUDENT }, get: (h) => (h.toLowerCase() === 'user-agent' ? WINDOWS_CHROME_UA : undefined) });

  test('the label parsed from the user agent is stored with the subscription', async () => {
    handlers.push_subscriptions = () => ({ data: [] });
    const res = fakeRes();
    let failed;
    await handlerFor('post', '/push/subscribe')(req(), res, (e) => { failed = e; });
    assert.equal(failed, undefined);
    assert.deepEqual(res.body, { ok: true });
    const writes = callsTo('push_subscriptions');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.device_label, deviceLabelFromUA(WINDOWS_CHROME_UA));
    assert.ok(writes[0].body.device_label, 'a Windows Chrome UA should produce a label');
    assert.equal(writes[0].body.role, 'admin');
  });

  test('a database without the column gets the old write, and turning alerts on still works', async () => {
    handlers.push_subscriptions = (call) => (call.body && 'device_label' in call.body
      ? { status: 400, data: { code: 'PGRST204', message: "Could not find the 'device_label' column of 'push_subscriptions' in the schema cache" } }
      : { data: [] });
    const res = fakeRes();
    let failed;
    await handlerFor('post', '/push/subscribe')(req(), res, (e) => { failed = e; });
    assert.equal(failed, undefined);
    assert.deepEqual(res.body, { ok: true });
    const writes = callsTo('push_subscriptions');
    assert.equal(writes.length, 2);
    assert.ok(!('device_label' in writes[1].body), 'the retry must drop the column');
  });

  test('any other fault is not retried away, even one that names the column or has the code', async () => {
    const faults = [
      // A real constraint on the column: the retry would hide it.
      { status: 400, data: { code: '23514', message: 'new row for relation "push_subscriptions" violates check constraint "device_label_len"' } },
      // A different missing column: dropping device_label would not help.
      { status: 400, data: { code: 'PGRST204', message: "Could not find the 'role' column of 'push_subscriptions' in the schema cache" } },
    ];
    for (const fault of faults) {
      calls = [];
      handlers.push_subscriptions = () => fault;
      const res = fakeRes();
      let failed;
      await handlerFor('post', '/push/subscribe')(req(), res, (e) => { failed = e; });
      assert.ok(failed, `${fault.data.code} should reach next(err)`);
      assert.equal(callsTo('push_subscriptions').length, 1, `${fault.data.code} was retried without the label`);
    }
  });
});

describe('POST /vendors/:id/reset-code logs the email without the code', () => {
  test('the stored row carries the fixed subject and no trace of the code', async () => {
    _resetNotificationLogForTests();
    const STAFF = 'edededed-fefe-4aba-8bcb-dcdcdcdcdcdc';
    const RESET = 'bcbcbcbc-dede-4fab-8cdc-efefefefefef';
    handlers.vendors = () => ({ data: [{ id: VENDOR, name: 'Sher Halal' }] });
    handlers['rpc/vendor_staff_emails'] = () => ({ data: [{ user_id: STAFF, email: 'owner@sher.test', role: 'owner' }] });
    handlers['rpc/vendor_reset_issue'] = () => ({ data: [{ reset_id: RESET, reset_email: 'owner@sher.test', reset_expires_at: '2026-10-03T17:00:00Z' }] });
    handlers.notification_log = () => ({ status: 201, data: [{ id: NOTIF }] });

    const res = fakeRes();
    let failed;
    await handlerFor('post', '/vendors/:id/reset-code')(
      { params: { id: VENDOR }, body: {}, user: { email: 'op@test' }, protocol: 'https', get: () => 'we-rewards.test' },
      res, (e) => { failed = e; },
    );
    await flushNotificationLog();
    assert.equal(failed, undefined, String(failed?.message ?? ''));
    const code = res.body.code;
    assert.ok(code, 'the route should still hand the operator the code');

    const writes = callsTo('notification_log').filter((c) => c.method === 'POST');
    assert.equal(writes.length, 1, 'exactly one log row per send attempt');
    const row = Array.isArray(writes[0].body) ? writes[0].body[0] : writes[0].body;
    assert.equal(row.kind, 'vendor_reset');
    assert.equal(row.recipient_kind, 'vendor');
    assert.equal(row.vendor_id, VENDOR);
    assert.equal(row.title, 'Your WeRewards reset code (code hidden)');
    assert.equal(row.ref.resetId, RESET);
    assert.equal(row.ref.issuedBy, 'admin');
    const stored = JSON.stringify(row).toUpperCase();
    assert.ok(!stored.includes(code.toUpperCase()), 'the reset code reached the log');
    assert.ok(!stored.includes(code.replace(/-/g, '').toUpperCase()), 'the bare reset code reached the log');
  });
});
