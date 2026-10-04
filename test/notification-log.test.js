// Unit tests for the notification log writer (src/lib/notification-log.js).
//
// The module sits on every send path in the app, so most of what is asserted
// here is what it must NOT do: throw, reject, keep hammering a table that is not
// there, store a credential, or reach the error-alert machinery that would turn
// one failing write into an endless loop of operator pages.
//
// Supabase is stubbed by patching globalThis.fetch: supabase-js reads through
// retryingFetch (src/lib/supabase.js), which resolves `fetch` off the global at
// CALL time, so a patch here sees every request the module makes. Inserts are
// POSTs, which neither retryingFetch nor postgrest-js retries, so a stubbed
// failure is answered in one round trip.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  NOTIFICATION_KINDS, serviceOf, deviceLabelFromUA, redactSecrets, redactDeviceError, toRow,
  logNotification, flushNotificationLog, recordEmailEvent, notificationLogState,
  pruneNotificationLog, startNotificationLogPruner, stopNotificationLogPruner,
  _resetNotificationLogForTests,
} from '../src/lib/notification-log.js';

const UUID = '11111111-2222-4333-8444-555555555555';
const VENDOR = '99999999-8888-4777-8666-555555555555';

/**
 * Run `fn` with Supabase answered by `handler(call)` and console.warn captured.
 * `call` has the method, URL, parsed JSON body and the Prefer header.
 */
async function withSupabase(handler, fn) {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const calls = [];
  const warnings = [];
  console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
  globalThis.fetch = async (input, init = {}) => {
    const call = {
      url: String(input?.url ?? input),
      method: String(init.method ?? 'GET').toUpperCase(),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      rawBody: typeof init.body === 'string' ? init.body : '',
      prefer: new Headers(init.headers ?? {}).get('prefer') ?? '',
    };
    calls.push(call);
    const out = await handler(call);
    if (out instanceof Error) throw out;
    return new Response(out.status === 204 ? null : (out.body ?? '[]'), {
      status: out.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    return await fn({ calls, warnings });
  } finally {
    await flushNotificationLog();
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
}

const ok = (id = 'row-1') => () => ({ status: 201, body: JSON.stringify([{ id }]) });
const missing = (code = 'PGRST205') => () => ({
  status: 404,
  body: JSON.stringify({ code, message: 'Could not find the table public.notification_log in the schema cache' }),
});

const ENTRY = {
  channel: 'push', kind: 'deal', outcome: 'sent', recipientKind: 'student',
  studentId: UUID, title: 'Sher Halal: 2 for 1', body: 'Today only', url: '/?spot=x',
};

beforeEach(() => _resetNotificationLogForTests());

/* ---------- pure helpers ---------- */

test('NOTIFICATION_KINDS is the frozen vocabulary from the contract', () => {
  assert.ok(Object.isFrozen(NOTIFICATION_KINDS));
  assert.deepEqual([...NOTIFICATION_KINDS].sort(), [
    'admin_alert', 'admin_test', 'application_accepted', 'application_received', 'broadcast',
    'deal', 'nearby', 'other', 'reminder', 'student_link_code', 'vendor_reset',
  ]);
});

test('serviceOf names the push service family and never throws', () => {
  assert.equal(serviceOf('https://web.push.apple.com/QGx'), 'apple');
  assert.equal(serviceOf('https://fcm.googleapis.com/fcm/send/abc'), 'google');
  assert.equal(serviceOf('https://android.googleapis.com/gcm/send/abc'), 'google');
  assert.equal(serviceOf('https://updates.push.services.mozilla.com/wpush/v2/x'), 'mozilla');
  assert.equal(serviceOf('https://wns2-by3p.notify.windows.com/w/?token=x'), 'microsoft');
  assert.equal(serviceOf('https://push.test/a'), 'other');
  // A host that merely CONTAINS a service name is not that service.
  assert.equal(serviceOf('https://push.apple.com.evil.test/x'), 'other');
  for (const junk of [null, undefined, '', 'not a url', 42, {}, { toString() { throw new Error('x'); } }]) {
    assert.equal(serviceOf(junk), 'other');
  }
});

test('deviceLabelFromUA reads OS + browser, including the installed iOS app', () => {
  const cases = [
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'iPhone Safari'],
    // An installed home-screen app: no "Safari/" token at all. This is the ONLY
    // place iOS delivers web push, so it is the case that matters most.
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', 'iPhone Safari'],
    ['Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1', 'iPad Safari'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1', 'iPhone Chrome'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36', 'Android Chrome'],
    ['Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0', 'Android Firefox'],
    ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36', 'Android Samsung Internet'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Mac Safari'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Mac Chrome'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Windows Chrome'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0', 'Windows Edge'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0', 'Windows Firefox'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0', 'Linux Firefox'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'ChromeOS Chrome'],
  ];
  for (const [ua, want] of cases) assert.equal(deviceLabelFromUA(ua), want, ua);
  for (const junk of [null, undefined, '', '   ', 42, {}, 'curl/8.4.0']) {
    assert.equal(deviceLabelFromUA(junk), null, String(junk));
  }
  const long = deviceLabelFromUA(`Mozilla/5.0 (Windows NT 10.0) ${'x'.repeat(500)} Chrome/1`);
  assert.ok(long.length <= 40);
});

test('redactSecrets catches every spelling of a code, and nothing shorter than 3', () => {
  assert.equal(redactSecrets('Your WeRewards reset code: K7M2-NP94', ['K7M2NP94']), 'Your WeRewards reset code: [redacted]');
  // The other direction: the caller passed the formatted code, the text has it bare.
  assert.equal(redactSecrets('code k7m2np94 and K7M2 NP94', ['K7M2-NP94']), 'code [redacted] and [redacted]');
  assert.equal(redactSecrets('482913 / 482913', ['482913']), '[redacted] / [redacted]');
  // Regex metacharacters in a secret are literal, not a pattern.
  assert.equal(redactSecrets('a.b+c and axbbc', ['a.b+c']), '[redacted] and axbbc');
  assert.equal(redactSecrets('ab ab', ['ab']), 'ab ab');
  assert.equal(redactSecrets(null, ['x']), null);
  assert.equal(redactSecrets(undefined), null);
  assert.equal(redactSecrets('plain'), 'plain');
  assert.equal(redactSecrets('plain', [null, undefined, '']), 'plain');
});

test('toRow maps, truncates, and whitelists device fields', () => {
  const row = toRow({
    ...ENTRY,
    kind: 'not-a-kind',
    recipientKind: 'martian',
    title: 't'.repeat(500),
    body: 'b'.repeat(5000),
    url: 'u'.repeat(900),
    reason: 'r'.repeat(100),
    recipientLabel: 'l'.repeat(300),
    template: 'p'.repeat(100),
    recipientEmail: `${'e'.repeat(300)}@x.com`,
    vendorId: 'not-a-uuid',
    devices: [
      // A caller that hands over a raw subscription row by mistake.
      { subId: 7, service: 'google', label: 'Android Chrome', ok: true, status: 201,
        endpoint: 'https://fcm.googleapis.com/fcm/send/SECRET-ENDPOINT', p256dh: 'SECRET-P256', auth: 'SECRET-AUTH' },
      { subId: 'x', service: 'apple', ok: false, status: 410, pruned: true, error: 'e '.repeat(200) },
    ],
  });
  assert.equal(row.kind, 'other');
  assert.equal(row.recipient_kind, 'other');
  assert.equal(row.title.length, 200);
  assert.equal(row.body.length, 1000);
  assert.equal(row.url.length, 500);
  assert.equal(row.reason.length, 60);
  assert.equal(row.recipient_label.length, 120);
  assert.equal(row.template.length, 60);
  assert.equal(row.recipient_email.length, 254);
  assert.equal(row.vendor_id, null);
  assert.equal(row.student_id, UUID);
  assert.equal(row.devices_tried, 2);
  assert.equal(row.devices_accepted, 1);
  assert.equal(row.devices[1].error.length, 120);
  assert.equal(row.source, 'live');
  assert.equal(row.dedupe_key, null);
  assert.ok(!('created_at' in row), 'no createdAt means the database default');
  const json = JSON.stringify(row);
  for (const secret of ['SECRET-ENDPOINT', 'SECRET-P256', 'SECRET-AUTH', 'endpoint', 'p256dh']) {
    assert.ok(!json.includes(secret), `${secret} reached the row`);
  }
  assert.deepEqual(Object.keys(row.devices[0]).sort(), ['error', 'label', 'ok', 'pruned', 'service', 'status', 'subId']);
});

test('a device error keeps no URL and no token, however the push service echoed it', () => {
  // The review's own repro: a body quoting only the token, and one quoting the
  // endpoint percent-encoded. redactSecrets (exact-match) lets both through.
  const TOKEN = 'dHIoDxE7Hdg:APA91bH_abc-DEF123';
  const ENDPOINT = `https://fcm.googleapis.com/fcm/send/${TOKEN}`;
  const bare = `token ${TOKEN} not registered`;
  const encoded = `bad subscription ${encodeURIComponent(ENDPOINT)}`;
  assert.equal(redactSecrets(bare, [ENDPOINT]), bare, 'premise: the exact-match scrub misses this');
  assert.equal(redactDeviceError(bare), 'token [redacted] not registered');
  assert.equal(redactDeviceError(encoded), 'bad subscription [redacted]');
  assert.equal(redactDeviceError(`gone: ${ENDPOINT}.`), 'gone: [redacted]');
  // A long lowercase run is a token too, not a word.
  assert.equal(redactDeviceError('id abcdefghijklmnopqrstuvwxyz'), 'id [redacted]');
  // What a push service actually says stays readable, CamelCase error names
  // of 20+ characters included.
  for (const keep of [
    'push subscription has unsubscribed or expired.',
    'Received unexpected response code',
    '<TITLE>UnauthorizedRegistration</TITLE>',
    'error:InvalidRegistration',
    'socket hang up', 'ECONNRESET', '410 Gone',
  ]) assert.equal(redactDeviceError(keep), keep);
  assert.equal(redactDeviceError(null), null);

  // And it is the STORED column that carries it, whatever the caller did, with
  // the redaction done before the 120-character cut.
  const row = toRow({
    ...ENTRY,
    devices: [
      { ok: false, status: 400, error: bare },
      { ok: false, status: 400, error: encoded },
      { ok: false, status: 400, error: `${'x '.repeat(55)}${TOKEN}${TOKEN}` },
    ],
  });
  const json = JSON.stringify(row.devices);
  for (const leak of ['APA91bH', 'dHIoDxE7Hdg', 'fcm%2Fsend', 'https']) {
    assert.ok(!json.includes(leak), `${leak} reached devices[].error: ${json}`);
  }
  assert.equal(row.devices[0].error, 'token [redacted] not registered');
});

test('toRow honours explicit counts, createdAt, source, and caps an oversized ref', () => {
  const row = toRow({
    ...ENTRY,
    devicesTried: 3, devicesAccepted: 0,
    createdAt: '2026-10-01T12:00:00Z', source: 'backfill', dedupeKey: 'deal:abc',
    ref: { campaignIds: Array.from({ length: 400 }, (_, i) => `campaign-${i}-${'x'.repeat(20)}`), batch: 'b1', refunded: true, tier: null },
  });
  assert.equal(row.devices_tried, 3);
  assert.equal(row.devices_accepted, 0);
  assert.equal(row.created_at, '2026-10-01T12:00:00.000Z');
  assert.equal(row.source, 'backfill');
  assert.equal(row.dedupe_key, 'deal:abc');
  assert.deepEqual(row.ref, { batch: 'b1', refunded: true, tier: null });
  // Small refs survive whole; a non-object ref is {}.
  assert.deepEqual(toRow({ ...ENTRY, ref: { campaignIds: ['a'], batch: 'b' } }).ref, { campaignIds: ['a'], batch: 'b' });
  assert.deepEqual(toRow({ ...ENTRY, ref: 'nope' }).ref, {});
  assert.deepEqual(toRow(null).ref, {});
});

/* ---------- writing ---------- */

test('logNotification inserts one row and resolves to its id', async () => {
  await withSupabase(ok('abc'), async ({ calls }) => {
    const id = await logNotification(ENTRY);
    assert.equal(id, 'abc');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/rest\/v1\/notification_log\?/);
    assert.ok(!calls[0].url.includes('on_conflict'), 'a row with no dedupe key must be a plain insert');
    assert.equal(calls[0].body.kind, 'deal');
    assert.equal(calls[0].body.student_id, UUID);
    assert.equal(notificationLogState().available, true);
  });
});

test('a dedupe key turns the write into an ignore-duplicates upsert', async () => {
  await withSupabase(() => ({ status: 201, body: '[]' }), async ({ calls }) => {
    // [] back is what PostgREST says for a skipped duplicate.
    const id = await logNotification({ ...ENTRY, dedupeKey: 'deal:batch-1' });
    assert.equal(id, null);
    assert.match(calls[0].url, /on_conflict=dedupe_key/);
    assert.match(calls[0].prefer, /resolution=ignore-duplicates/);
  });
});

test('a missing table resolves null, warns once, and stops writing for the cool-down', async () => {
  for (const code of ['PGRST205', '42P01', '42703', 'PGRST204']) {
    _resetNotificationLogForTests();
    await withSupabase(missing(code), async ({ calls, warnings }) => {
      const first = await logNotification(ENTRY);
      assert.equal(first, null);
      assert.equal(calls.length, 1);
      // Ten more sends inside the window: no requests, no more warnings.
      const rest = await Promise.all(Array.from({ length: 10 }, () => logNotification(ENTRY)));
      assert.deepEqual(rest, Array(10).fill(null));
      assert.equal(await recordEmailEvent('re_1', 'delivered'), false);
      assert.equal(calls.length, 1, `${code}: the module kept writing to a missing table`);
      assert.equal(warnings.length, 1, `${code}: ${JSON.stringify(warnings)}`);
      assert.match(warnings[0], /migration-062/);
      const s = notificationLogState();
      assert.equal(s.available, false);
      assert.ok(s.disabledUntil > Date.now() + 4 * 60 * 1000);
    });
  }
});

test('after the cool-down the module tries again and recovers', async () => {
  await withSupabase(missing(), async () => { await logNotification(ENTRY); });
  assert.equal(notificationLogState().available, false);
  // Simulate the window expiring without waiting five minutes.
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60 * 1000;
  try {
    await withSupabase(ok('again'), async ({ calls }) => {
      assert.equal(await logNotification(ENTRY), 'again');
      assert.equal(calls.length, 1);
    });
  } finally {
    Date.now = realNow;
  }
  assert.equal(notificationLogState().available, true);
  assert.equal(notificationLogState().disabledUntil, null);
});

test('any other failure is a rate-limited warning, never a throw or a rejection', async () => {
  const boom = () => ({ status: 500, body: JSON.stringify({ code: 'XX000', message: 'internal' }) });
  await withSupabase(boom, async ({ calls, warnings }) => {
    const out = await Promise.all([logNotification(ENTRY), logNotification(ENTRY), logNotification(ENTRY)]);
    assert.deepEqual(out, [null, null, null]);
    // Not a missing table, so every write is still attempted...
    assert.equal(calls.length, 3);
    // ...but the console hears about it once a minute, not once a send.
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.notEqual(notificationLogState().available, false);
  });
  // A transport that rejects outright.
  await withSupabase(() => new Error('ECONNRESET'), async () => {
    assert.equal(await logNotification(ENTRY), null);
  });
});

test('garbage in is refused locally and still never rejects', async () => {
  await withSupabase(ok(), async ({ calls }) => {
    for (const bad of [null, undefined, 42, 'x', {}, { ...ENTRY, channel: 'sms' }, { ...ENTRY, outcome: 'delivered' }]) {
      assert.equal(await logNotification(bad), null);
    }
    assert.equal(calls.length, 0, 'a row the CHECK constraints would refuse was sent anyway');
  });
});

test('a vendor deleted mid-send keeps the row and loses only the link', async () => {
  let n = 0;
  const handler = () => {
    n += 1;
    if (n === 1) {
      return { status: 409, body: JSON.stringify({ code: '23503', message: 'insert or update on table "notification_log" violates foreign key constraint "notification_log_vendor_id_fkey"', details: 'Key (vendor_id)=(x) is not present in table "vendors".' }) };
    }
    return { status: 201, body: JSON.stringify([{ id: 'kept' }]) };
  };
  await withSupabase(handler, async ({ calls }) => {
    assert.equal(await logNotification({ ...ENTRY, vendorId: VENDOR }), 'kept');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.vendor_id, VENDOR);
    assert.equal(calls[1].body.vendor_id, null);
    assert.equal(calls[1].body.student_id, UUID);
  });
});

test('flushNotificationLog waits for writes that are still on the wire', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await withSupabase(async () => { await gate; return { status: 201, body: '[{"id":"late"}]' }; }, async ({ calls }) => {
    let done = false;
    logNotification(ENTRY).then(() => { done = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(done, false);
    setTimeout(release, 20);
    await flushNotificationLog();
    assert.equal(done, true);
    assert.equal(calls.length, 1);
  });
});

test('writes already on the wire when the table turns up missing warn once, not once each', async () => {
  // A burst of error_logs inserts makes alerts.js call notifyAdmins about 20
  // times at once; all 20 inserts are in flight before the first PGRST205 lands.
  let release;
  const gate = new Promise((r) => { release = r; });
  await withSupabase(async () => { await gate; return missing()(); }, async ({ calls, warnings }) => {
    const pending = Array.from({ length: 20 }, () => logNotification(ENTRY));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 20, 'premise: all twenty must be on the wire together');
    release();
    assert.deepEqual(await Promise.all(pending), Array(20).fill(null));
    assert.equal(warnings.filter((w) => w.includes('migration-062')).length, 1, JSON.stringify(warnings));
  });
  // The late failures did not push the window out either.
  assert.ok(notificationLogState().disabledUntil <= Date.now() + 5 * 60 * 1000);
});

test('a bounded flush waits only for the writes already on the wire, and gives up on time', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await withSupabase(async () => { await gate; return { status: 201, body: '[{"id":"x"}]' }; }, async () => {
    logNotification(ENTRY);
    await new Promise((r) => setImmediate(r));
    const t0 = Date.now();
    assert.equal(await flushNotificationLog({ timeoutMs: 60 }), false);
    const ms = Date.now() - t0;
    assert.ok(ms >= 50 && ms < 1000, `gave up after ${ms}ms`);
    // A negative budget (the backstop is already spent) returns at once.
    assert.equal(await flushNotificationLog({ timeoutMs: -5 }), false);
    release();
    assert.equal(await flushNotificationLog({ timeoutMs: 1000 }), true);
    // A write started after the snapshot is not waited for.
    let release2;
    const gate2 = new Promise((r) => { release2 = r; });
    let done = false;
    const flushed = flushNotificationLog({ timeoutMs: 1000 });
    globalThis.fetch = async () => { await gate2; return new Response('[]', { status: 201 }); };
    logNotification(ENTRY).then(() => { done = true; });
    assert.equal(await flushed, true);
    assert.equal(done, false);
    release2();
  });
  assert.equal(await flushNotificationLog({ timeoutMs: 10 }), true, 'nothing in flight is drained at once');
});

/* ---------- retention ---------- */

test('pruneNotificationLog calls the 062 function and returns how many it deleted', async () => {
  await withSupabase(() => ({ status: 200, body: '17' }), async ({ calls, warnings }) => {
    assert.equal(await pruneNotificationLog(), 17);
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/rest\/v1\/rpc\/prune_notification_log$/);
    assert.deepEqual(calls[0].body, { p_days: 30 });
    assert.deepEqual(warnings, []);
  });
});

test('pruneNotificationLog is fail-soft, and quiet when 062 is not applied', async () => {
  for (const code of ['PGRST202', '42883']) {
    const gone = () => ({ status: 404, body: JSON.stringify({ code, message: 'Could not find the function public.prune_notification_log' }) });
    await withSupabase(gone, async ({ warnings }) => {
      assert.equal(await pruneNotificationLog(), null);
      assert.deepEqual(warnings, [], `${code} should be quiet`);
    });
  }
  const boom = () => ({ status: 500, body: JSON.stringify({ code: 'XX000', message: 'internal' }) });
  await withSupabase(boom, async ({ warnings }) => {
    assert.equal(await pruneNotificationLog(), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /prune failed/);
  });
});

test('the pruner runs after its first delay, then on its interval, until stopped', async () => {
  await withSupabase(() => ({ status: 200, body: '0' }), async ({ calls }) => {
    const prunes = () => calls.filter((c) => c.url.includes('/rpc/prune_notification_log')).length;
    startNotificationLogPruner({ firstDelayMs: 30, everyMs: 30 });
    startNotificationLogPruner({ firstDelayMs: 30, everyMs: 30 }); // idempotent
    assert.equal(prunes(), 0, 'it must not run at boot');
    await new Promise((r) => setTimeout(r, 120));
    stopNotificationLogPruner();
    const seen = prunes();
    assert.ok(seen >= 2 && seen <= 4, `ran ${seen} times`);
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(prunes(), seen, 'it kept running after stop');
  });
});

/* ---------- delivery events ---------- */

test('recordEmailEvent updates by provider id, for the three kept statuses only', async () => {
  await withSupabase(() => ({ status: 204, body: '' }), async ({ calls }) => {
    assert.equal(await recordEmailEvent('re_abc', 'delivered', '2026-10-03T10:00:00Z'), true);
    assert.equal(calls[0].method, 'PATCH');
    assert.match(calls[0].url, /\/notification_log\?/);
    assert.match(calls[0].url, /provider_id=eq\.re_abc/);
    assert.deepEqual(calls[0].body, { delivery_status: 'delivered', delivery_at: '2026-10-03T10:00:00.000Z' });
    // A late "delivered" must not paint over a bounce or a complaint.
    assert.match(decodeURIComponent(calls[0].url), /or=\(delivery_status\.is\.null,delivery_status\.eq\.delivered\)/);

    assert.equal(await recordEmailEvent('re_abc', 'complained'), true);
    assert.equal(calls[1].body.delivery_status, 'complained');
    assert.ok(!decodeURIComponent(calls[1].url).includes('or=('), 'a complaint overrides everything');
    assert.ok(Date.parse(calls[1].body.delivery_at) > Date.now() - 60_000, 'no time means now');

    assert.equal(await recordEmailEvent('re_abc', 'bounced', 'not a date'), true);
    assert.ok(Date.parse(calls[2].body.delivery_at) > Date.now() - 60_000);

    const before = calls.length;
    for (const status of ['opened', 'clicked', 'delivery_delayed', 'sent', undefined, null]) {
      assert.equal(await recordEmailEvent('re_abc', status), false, String(status));
    }
    for (const id of [null, undefined, '', '   ', 42, {}]) {
      assert.equal(await recordEmailEvent(id, 'delivered'), false);
    }
    assert.equal(calls.length, before, 'an event we do not keep reached the database');
  });
});

test('recordEmailEvent never throws when the write fails', async () => {
  await withSupabase(missing('42P01'), async () => {
    assert.equal(await recordEmailEvent('re_1', 'bounced'), false);
  });
  _resetNotificationLogForTests();
  await withSupabase(() => new Error('socket hang up'), async () => {
    assert.equal(await recordEmailEvent('re_1', 'bounced'), false);
  });
});

/* ---------- the feedback loop ---------- */

test('the module cannot reach the error-alert machinery', () => {
  // Every error_logs insert pushes an operator alert (alerts.js), and that push
  // is logged by this module. If a failing log write could itself land in
  // error_logs, one broken write would page the operators forever. Read the
  // source, because no runtime test can prove a code path is unreachable.
  const src = fs.readFileSync(path.resolve('src/lib/notification-log.js'), 'utf8');
  const imports = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l) || /\bimport\s*\(/.test(l));
  assert.deepEqual(imports, ["import { supabaseAdmin } from './supabase.js';"]);
  assert.ok(!/\blogError\s*\(/.test(src), 'notification-log.js calls logError');
  assert.ok(!/\bnotifyAdmins\s*\(/.test(src), 'notification-log.js calls notifyAdmins');
  assert.ok(!/\bnotifyError\s*\(/.test(src), 'notification-log.js calls notifyError');
  assert.ok(!/from\s+['"][^'"]*(errors|alerts|push)\.js['"]/.test(src));
});

test('server.js prunes only when run directly, stops on shutdown, and bounds the flush', () => {
  // Read, not run: importing server.js boots the app, and SIGTERM cannot be
  // delivered to a child on Windows, so the wiring is held by its source.
  const src = fs.readFileSync(path.resolve('server.js'), 'utf8');
  const main = src.slice(src.indexOf('if (isMain) {'));
  assert.ok(src.indexOf('if (isMain) {') > 0);
  assert.ok(!src.slice(0, src.indexOf('if (isMain) {')).includes('startNotificationLogPruner()'), 'pruner started on import');
  assert.match(main, /\n\s*startNotificationLogPruner\(\);/);
  const shutdown = main.slice(main.indexOf('const shutdown'));
  assert.match(shutdown, /stopNotificationLogPruner\(\);/);
  // An unbounded flushNotificationLog() here is what let a hung database turn
  // a clean exit into "forced shutdown" (exit 1).
  assert.match(shutdown, /flushNotificationLog\(\{\s*timeoutMs:/);
  assert.ok(!/flushNotificationLog\(\)/.test(shutdown), 'the shutdown flush is unbounded');
});
