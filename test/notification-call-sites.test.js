// The notification log's student-route and transactional-email call sites
// (migration-062): src/routes/student.js (nearby claims, push subscribe, the
// data export), src/routes/vendor-recover.js, src/routes/apply.js and
// src/lib/student-email.js.
//
// What these tests hold is mostly what must NOT happen:
//
//   • A reset code or link code must never reach notification_log, in any
//     column. Both ride in the real email subject, so the call sites pass a
//     fixed logSubject and the code as a secret.
//   • A refused nearby claim must not be logged at all (it would be a second
//     record of where a student walked), and an allowed one is 'allowed', never
//     'sent'.
//   • A database without migration-062 must keep working: subscribe falls back
//     to the pre-062 write, the export still downloads, nothing throws.
//
// Supabase is stubbed by patching globalThis.fetch (see the header of
// test/notification-log.test.js for why that sees every request), and
// supabaseAdmin.rpc is swapped directly where a function call is involved, the
// way test/nearby.test.js does it. Email and push are both unconfigured in the
// test env, so sendEmail / notifyAdmins make no network call of their own and
// the only request on the wire is the log write itself, which they still make
// on the 'disabled' path.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { emailEnabled } from '../src/lib/email.js';
import { pushEnabled } from '../src/lib/push.js';
import {
  logNotification, flushNotificationLog, _resetNotificationLogForTests,
} from '../src/lib/notification-log.js';
import studentRouter, {
  claimNearbyAndLog, logNearbyAllowed, upsertStudentPushSubscription,
  _resetDeviceLabelProbeForTests, exportNotificationRows,
} from '../src/routes/student.js';
import { mailSelfServeResetCode } from '../src/routes/vendor-recover.js';
import { announceApplication } from '../src/routes/apply.js';
import { issueLinkCode } from '../src/lib/student-email.js';

// Ids with no run of digits in them, so "no six digits in a row anywhere in
// the row" is a meaningful test for a six-digit link code.
const STUDENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const VENDOR = 'fafafafa-bcbc-4ded-8efe-abababababab';
const CODE_ROW = 'cacacaca-dbdb-4ecf-8fab-cdcdcdcdcdcd';
const RESET_ROW = 'bebebebe-adad-4cfc-8bab-dedededededf';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/**
 * Run `fn` with Supabase answered by `handler(call)` and console.warn captured.
 * Every write the code under test started is flushed before the stub comes off.
 */
async function withSupabase(handler, fn) {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const calls = [];
  const warnings = [];
  console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
  globalThis.fetch = async (input, init = {}) => {
    const rawBody = typeof init.body === 'string' ? init.body : '';
    const call = {
      url: decodeURIComponent(String(input?.url ?? input)),
      method: String(init.method ?? 'GET').toUpperCase(),
      body: rawBody ? JSON.parse(rawBody) : null,
      rawBody,
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

/** Swap supabaseAdmin.rpc for the duration of `fn`, capturing every call. */
async function withRpc(impl, fn) {
  const original = supabaseAdmin.rpc;
  const seen = [];
  supabaseAdmin.rpc = async (name, params) => { seen.push({ name, params }); return impl(name, params); };
  try { return await fn(seen); } finally { supabaseAdmin.rpc = original; }
}

const isLog = (c) => /\/rest\/v1\/notification_log\b/.test(c.url);
const logWrites = (calls) => calls.filter((c) => isLog(c) && c.method === 'POST');
const rowOf = (call) => (Array.isArray(call.body) ? call.body[0] : call.body);
const created = () => ({ status: 201, body: JSON.stringify([{ id: 'log-1' }]) });

/** Answer log writes with 201, everything else per `rest`. */
const logOk = (rest = () => ({ status: 200, body: '[]' })) => (c) => (isLog(c) ? created() : rest(c));

beforeEach(() => {
  _resetNotificationLogForTests();
  _resetDeviceLabelProbeForTests();
});

test('the test env sends nothing for real', () => {
  // Every test below relies on this: the log write is the only request.
  assert.equal(emailEnabled, false);
  assert.equal(pushEnabled, false);
});

/* ---------- the link code (src/lib/student-email.js) ---------- */

test('a student link-code email is logged with its context and WITHOUT the code', async () => {
  await withRpc(async (name) => {
    assert.equal(name, 'student_email_code_issue');
    return { data: [{ code_id: CODE_ROW }], error: null };
  }, async () => {
    await withSupabase(logOk(), async ({ calls }) => {
      const out = await issueLinkCode({
        userId: STUDENT, email: 'someone@school.edu', norm: 'someone@school.edu', signedInAs: 'me@gmail.com',
      });
      assert.equal(out.ok, true);
      await flushNotificationLog();
      const writes = logWrites(calls);
      assert.equal(writes.length, 1, 'exactly one log row per send');
      const row = rowOf(writes[0]);
      assert.equal(row.channel, 'email');
      assert.equal(row.kind, 'student_link_code');
      assert.equal(row.recipient_kind, 'student');
      assert.equal(row.student_id, STUDENT);
      assert.equal(row.recipient_email, 'someone@school.edu');
      assert.equal(row.title, 'Your WeRewards link code (code hidden)');
      assert.equal(row.ref.codeId, CODE_ROW);
      assert.equal(row.ref.idempotencyKey, `student-link-${CODE_ROW}`);
      // The code is six random digits we never see here (only its bcrypt hash
      // reaches the stubbed RPC), and every id in this test is digit-free, so
      // ANY six-digit run in the serialised row would be the code.
      assert.doesNotMatch(writes[0].rawBody, /\d{6}/, 'the link code reached the log row');
      for (const k of ['html', 'text', 'headers', 'unsubscribe_url']) {
        assert.ok(!(k in row), `${k} must never be logged`);
      }
    });
  });
});

test('a throttled link-code request sends nothing and logs nothing', async () => {
  await withRpc(async () => ({ data: [], error: null }), async () => {
    await withSupabase(logOk(), async ({ calls }) => {
      const out = await issueLinkCode({ userId: STUDENT, email: 'a@school.edu', norm: 'a@school.edu' });
      assert.equal(out.throttled, true);
      await flushNotificationLog();
      assert.equal(logWrites(calls).length, 0);
    });
  });
});

/* ---------- the self-serve reset code (src/routes/vendor-recover.js) ---------- */

test('a self-serve reset email is logged as vendor_reset WITHOUT the code, in any spelling', async () => {
  await withSupabase(logOk(), async ({ calls }) => {
    const sent = await mailSelfServeResetCode({
      row: { reset_id: RESET_ROW, reset_email: 'owner@sherhalal.test', reset_vendor_name: 'Sher Halal' },
      code: 'K7M2-NP94',
      terminalUrl: 'https://example.test/terminal/',
    });
    assert.equal(sent.ok, false);
    assert.equal(sent.reason, 'disabled');
    await flushNotificationLog();
    const writes = logWrites(calls);
    assert.equal(writes.length, 1);
    const row = rowOf(writes[0]);
    assert.equal(row.channel, 'email');
    assert.equal(row.kind, 'vendor_reset');
    assert.equal(row.recipient_kind, 'vendor');
    assert.equal(row.outcome, 'refused');
    assert.equal(row.reason, 'disabled');
    assert.equal(row.recipient_email, 'owner@sherhalal.test');
    assert.equal(row.recipient_label, 'Sher Halal');
    assert.equal(row.title, 'Your WeRewards reset code (code hidden)');
    assert.deepEqual(
      { resetId: row.ref.resetId, issuedBy: row.ref.issuedBy },
      { resetId: RESET_ROW, issuedBy: 'self-serve' },
    );
    // Generated as K7M2-NP94, typed back as K7M2NP94: neither half, and
    // neither spelling, may appear anywhere in what was written.
    for (const needle of ['K7M2', 'NP94', 'K7M2NP94', 'K7M2-NP94']) {
      assert.ok(!writes[0].rawBody.toUpperCase().includes(needle), `the reset code (${needle}) reached the log row`);
    }
  });
});

/* ---------- the application receipt (src/routes/apply.js) ---------- */

test('an application logs the applicant email and the operator push, both linked to the application', async () => {
  await withSupabase(logOk(), async ({ calls }) => {
    await announceApplication({
      id: RESET_ROW,
      fields: { business_name: 'Sher Halal', contact_name: 'Sam', email: 'Sam@SherHalal.test', locations: [] },
    });
    await flushNotificationLog();
    const rows = logWrites(calls).map(rowOf);
    assert.equal(rows.length, 2);
    const email = rows.find((r) => r.channel === 'email');
    const push = rows.find((r) => r.channel === 'push');
    assert.equal(email.kind, 'application_received');
    assert.equal(email.recipient_kind, 'applicant');
    assert.equal(email.recipient_label, 'Sher Halal');
    assert.equal(email.recipient_email, 'sam@sherhalal.test');
    assert.equal(email.ref.applicationId, RESET_ROW);
    assert.equal(email.template, 'application-received');
    assert.equal(push.kind, 'admin_alert');
    assert.equal(push.recipient_kind, 'admin');
    assert.equal(push.ref.applicationId, RESET_ROW);
    assert.equal(push.outcome, 'refused');
    assert.equal(push.reason, 'push_disabled');
  });
});

/* ---------- nearby claims (src/routes/student.js) ---------- */

const vendorsAnswer = (c) => (/\/rest\/v1\/vendors\b/.test(c.url)
  ? { status: 200, body: JSON.stringify([{ name: 'Sher Halal' }]) }
  : { status: 200, body: '[]' });

test('an allowed nearby claim is logged as allowed (never sent), deduped like the backfill', async () => {
  await withRpc(async () => ({ data: true, error: null }), async () => {
    await withSupabase(logOk(vendorsAnswer), async ({ calls }) => {
      const { allowed, logged } = await claimNearbyAndLog(STUDENT, VENDOR);
      assert.equal(allowed, true);
      await logged;
      await flushNotificationLog();
      const writes = logWrites(calls);
      assert.equal(writes.length, 1);
      const row = rowOf(writes[0]);
      assert.deepEqual(
        {
          channel: row.channel, kind: row.kind, outcome: row.outcome, recipient_kind: row.recipient_kind,
          student_id: row.student_id, vendor_id: row.vendor_id, title: row.title, url: row.url,
          ref: row.ref, dedupe_key: row.dedupe_key,
        },
        {
          channel: 'push', kind: 'nearby', outcome: 'allowed', recipient_kind: 'student',
          student_id: STUDENT, vendor_id: VENDOR, title: "You're near Sher Halal", url: `/?spot=${VENDOR}`,
          ref: { shownBy: 'device' }, dedupe_key: `nearby:${STUDENT}:${VENDOR}`,
        },
      );
      assert.match(writes[0].url, /on_conflict=dedupe_key/);
      assert.match(writes[0].prefer, /resolution=ignore-duplicates/);
    });
  });
});

test('a REFUSED nearby claim writes nothing and reads nothing', async () => {
  for (const answer of [{ data: false, error: null }, { data: null, error: { message: 'missing' } }]) {
    await withRpc(async () => answer, async () => {
      await withSupabase(logOk(vendorsAnswer), async ({ calls }) => {
        const { allowed, logged } = await claimNearbyAndLog(STUDENT, VENDOR);
        assert.equal(allowed, false);
        assert.equal(logged, null);
        await flushNotificationLog();
        assert.equal(calls.length, 0, 'a refusal must not touch notification_log or vendors');
      });
    });
  }
});

test('a vendor read that fails still logs the allowed claim, without a made-up title', async () => {
  // A 4xx rather than a thrown socket error: GETs are retried on network
  // errors (retryingFetch), which only makes this test slow, not different.
  // The thrown case is covered by the never-rejects test below.
  const denied = () => ({ status: 401, body: JSON.stringify({ code: '42501', message: 'permission denied' }) });
  await withSupabase(logOk(denied), async ({ calls }) => {
    await logNearbyAllowed(STUDENT, VENDOR);
    await flushNotificationLog();
    const writes = logWrites(calls);
    assert.equal(writes.length, 1);
    assert.equal(rowOf(writes[0]).title, null);
    assert.equal(rowOf(writes[0]).outcome, 'allowed');
  });
});

test('with the log table known missing, an allowed claim skips the vendors read too', async () => {
  await withSupabase((c) => (isLog(c)
    ? { status: 404, body: JSON.stringify({ code: 'PGRST205', message: 'Could not find the table public.notification_log' }) }
    : vendorsAnswer(c)), async ({ calls }) => {
    await logNotification({ channel: 'push', kind: 'other', outcome: 'sent', recipientKind: 'other' });
    const before = calls.length;
    await logNearbyAllowed(STUDENT, VENDOR);
    await flushNotificationLog();
    assert.equal(calls.length, before, 'no request while the log is in its cool-down window');
  });
});

test('logNearbyAllowed never rejects, whatever the database does', async () => {
  await withSupabase(() => new Error('down'), async () => {
    await assert.doesNotReject(logNearbyAllowed(STUDENT, VENDOR));
  });
});

/* ---------- push subscribe (src/routes/student.js) ---------- */

const SUB = { endpoint: 'https://web.push.apple.com/QGx', p256dh: 'p'.repeat(20), auth: 'a'.repeat(10), userId: STUDENT };
const isSubs = (c) => /\/rest\/v1\/push_subscriptions\b/.test(c.url);

test('subscribe stores a device label parsed from the user agent', async () => {
  await withSupabase(() => ({ status: 201, body: '' }), async ({ calls }) => {
    const { error } = await upsertStudentPushSubscription({ ...SUB, userAgent: IPHONE_UA });
    assert.equal(error, null);
    assert.equal(calls.length, 1);
    assert.ok(isSubs(calls[0]));
    assert.equal(rowOf(calls[0]).device_label, 'iPhone Safari');
    assert.equal(rowOf(calls[0]).role, 'student');
    assert.match(calls[0].url, /on_conflict=endpoint/);
  });
});

test('a pre-062 database (no device_label column) still gets the subscription', async () => {
  const missingColumn = {
    status: 400,
    body: JSON.stringify({ code: 'PGRST204', message: "Could not find the 'device_label' column of 'push_subscriptions' in the schema cache" }),
  };
  await withSupabase((c) => (rowOf(c) && 'device_label' in rowOf(c) ? missingColumn : { status: 201, body: '' }), async ({ calls, warnings }) => {
    const { error } = await upsertStudentPushSubscription({ ...SUB, userAgent: IPHONE_UA });
    assert.equal(error, null, 'the retry without device_label must succeed');
    assert.equal(calls.length, 2);
    assert.equal(rowOf(calls[0]).device_label, 'iPhone Safari');
    assert.ok(!('device_label' in rowOf(calls[1])), 'the retry must not ask for the missing column again');
    assert.equal(rowOf(calls[1]).endpoint, SUB.endpoint);
    assert.ok(warnings.some((w) => /migration-062/.test(w)));

    // And for a while it stops asking, so a pre-062 database is not charged a
    // failed write on every page load.
    const again = await upsertStudentPushSubscription({ ...SUB, userAgent: IPHONE_UA });
    assert.equal(again.error, null);
    assert.equal(calls.length, 3);
    assert.ok(!('device_label' in rowOf(calls[2])));
  });
});

test('the same retry covers the Postgres code (42703)', async () => {
  await withSupabase((c) => (rowOf(c) && 'device_label' in rowOf(c)
    ? { status: 400, body: JSON.stringify({ code: '42703', message: 'column "device_label" of relation "push_subscriptions" does not exist' }) }
    : { status: 201, body: '' }), async ({ calls }) => {
    const { error } = await upsertStudentPushSubscription({ ...SUB, userAgent: IPHONE_UA });
    assert.equal(error, null);
    assert.equal(calls.length, 2);
  });
});

test('any OTHER subscribe error is returned, not retried away', async () => {
  await withSupabase(() => ({ status: 409, body: JSON.stringify({ code: '23505', message: 'duplicate key' }) }), async ({ calls }) => {
    const { error } = await upsertStudentPushSubscription({ ...SUB, userAgent: IPHONE_UA });
    assert.equal(error?.code, '23505');
    assert.equal(calls.length, 1);
  });
});

test('an error that only MENTIONS device_label is returned, not retried away', async () => {
  // A constraint failure on the column is a real error, and a missing-column
  // code naming a different column is not the one we know how to work around.
  const answers = [
    { code: '23514', message: 'new row for relation "push_subscriptions" violates check constraint "push_subscriptions_device_label_check"' },
    { code: '42703', message: 'column "role" of relation "push_subscriptions" does not exist' },
  ];
  for (const body of answers) {
    _resetDeviceLabelProbeForTests();
    await withSupabase(() => ({ status: 400, body: JSON.stringify(body) }), async ({ calls, warnings }) => {
      const { error } = await upsertStudentPushSubscription({ ...SUB, userAgent: IPHONE_UA });
      assert.equal(error?.code, body.code);
      assert.equal(calls.length, 1, `${body.code} must not trigger the label-less retry`);
      assert.ok(!warnings.some((w) => /migration-062/.test(w)));
    });
  }
});

test('no recognisable user agent leaves the label out, so an existing label is not nulled', async () => {
  await withSupabase(() => ({ status: 201, body: '' }), async ({ calls }) => {
    for (const userAgent of [undefined, '', 'curl/8.4.0']) {
      await upsertStudentPushSubscription({ ...SUB, userAgent });
    }
    assert.equal(calls.length, 3);
    for (const c of calls) assert.ok(!('device_label' in rowOf(c)));
  });
});

/* ---------- the data export (src/routes/student.js) ---------- */

const LOG_ROW = {
  created_at: '2026-10-03T12:00:00.000Z', channel: 'push', kind: 'deal', outcome: 'failed',
  reason: 'no_device_accepted', title: 'Sher Halal: 2 for 1', body: 'Today only', url: '/?spot=x',
  recipient_email: null, delivery_status: null,
  devices: [
    { subId: 'sub-1', service: 'apple', label: 'iPhone Safari', ok: false, status: 410, pruned: true, error: 'Gone' },
    { subId: 'sub-2', service: 'fcm', label: null, ok: true, status: 201, pruned: false, error: null },
  ],
};
const LOG_ENTRY = {
  createdAt: '2026-10-03T12:00:00.000Z', channel: 'push', kind: 'deal', outcome: 'failed',
  reason: 'no_device_accepted', title: 'Sher Halal: 2 for 1', body: 'Today only', url: '/?spot=x',
  recipientEmail: null, deliveryStatus: null,
  devices: [
    { label: 'iPhone Safari', service: 'apple', ok: false, status: 410 },
    { label: null, service: 'fcm', ok: true, status: 201 },
  ],
};

test('the export lists the student\'s own notification rows, with reason, address and devices but no pipeline ids', async () => {
  const email = {
    ...LOG_ROW, channel: 'email', kind: 'student_link', outcome: 'refused', reason: 'suppressed',
    recipient_email: 'second@school.edu', devices: [],
  };
  await withSupabase(() => ({ status: 200, body: JSON.stringify([LOG_ROW, email]) }), async ({ calls }) => {
    const out = await exportNotificationRows(STUDENT);
    assert.deepEqual(out, [LOG_ENTRY, {
      ...LOG_ENTRY, channel: 'email', kind: 'student_link', outcome: 'refused', reason: 'suppressed',
      recipientEmail: 'second@school.edu', devices: [],
    }]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, new RegExp(`student_id=eq\\.${STUDENT}`));
    const select = /select=([^&]*)/.exec(calls[0].url)[1].split(',');
    for (const col of ['reason', 'recipient_email', 'devices']) assert.ok(select.includes(col), `${col} is exported`);
    for (const col of ['provider_id', 'dedupe_key', 'ref']) assert.ok(!select.includes(col), `${col} must not be exported`);
    const text = JSON.stringify(out);
    for (const leak of ['sub-1', 'sub-2', 'subId', 'Gone', 'pruned']) assert.ok(!text.includes(leak), `${leak} leaked`);
  });
});

test('the export section is an empty list when the table is missing or the read fails', async () => {
  const answers = [
    () => ({ status: 404, body: JSON.stringify({ code: 'PGRST205', message: 'Could not find the table public.notification_log' }) }),
    () => ({ status: 400, body: JSON.stringify({ code: '42P01', message: 'relation "public.notification_log" does not exist' }) }),
    () => new Error('network down'),
  ];
  for (const answer of answers) {
    await withSupabase(answer, async () => {
      const out = await exportNotificationRows(STUDENT);
      assert.deepEqual(out, []);
    });
  }
});

/**
 * Run GET /api/me/export's handler directly (no server.js, no requireUser),
 * with Supabase answered by `handler`. Resolves to the JSON body it sent.
 */
async function runExport(handler) {
  const layer = studentRouter.stack.find((l) => l.route?.path === '/export' && l.route.methods.get);
  assert.ok(layer, 'GET /export is registered');
  const route = layer.route.stack.at(-1).handle;
  return withSupabase(handler, () => new Promise((resolve, reject) => {
    const res = {
      setHeader() {},
      status() { return res; },
      json: resolve,
    };
    const req = { user: { id: STUDENT, email: 'me@school.edu' } };
    Promise.resolve(route(req, res, (err) => reject(err ?? new Error('next() without an error')))).catch(reject);
  }));
}

const NOTIFY_STATE = {
  push_opt_in: false, email_opt_in: true, nearby_opt_in: true, reminder_opt_in: false,
  last_push_at: '2026-10-01T10:00:00.000Z', last_email_at: null, last_reminder_at: null,
};

test('the download keeps `notifications` as the switches it always was, and adds notificationLog', async () => {
  const body = await runExport((c) => {
    if (/\/rest\/v1\/notification_log\b/.test(c.url)) return { status: 200, body: JSON.stringify([LOG_ROW]) };
    if (/\/rest\/v1\/student_notify_state\b/.test(c.url)) return { status: 200, body: JSON.stringify(NOTIFY_STATE) };
    return { status: 200, body: '[]' };
  });
  assert.deepEqual(body.notifications, NOTIFY_STATE);
  assert.deepEqual(body.notificationLog, [LOG_ENTRY]);
  assert.ok(!('notificationSettings' in body));
});

test('without migration-062 the download still works: same `notifications`, empty notificationLog', async () => {
  const body = await runExport((c) => {
    if (/\/rest\/v1\/notification_log\b/.test(c.url)) {
      return { status: 404, body: JSON.stringify({ code: 'PGRST205', message: 'Could not find the table public.notification_log' }) };
    }
    return { status: 200, body: '[]' };
  });
  // No state row: the defaults this key has always had.
  assert.deepEqual(body.notifications, {
    push_opt_in: true, email_opt_in: true, nearby_opt_in: true, reminder_opt_in: true,
    last_push_at: null, last_email_at: null, last_reminder_at: null,
  });
  assert.deepEqual(body.notificationLog, []);
  assert.ok(!('notificationSettings' in body));
});
