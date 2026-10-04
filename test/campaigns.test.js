// Unit tests for the pure half of vendor campaign delivery (src/lib/campaigns.js).
// No database and no push service: composeNotification() is fed the bundles the
// claim RPC produces and its output is the payload a student's phone renders.
//
// The throttle itself (cooldowns, caps, quiet hours, the per-vendor fence) lives
// in SQL and is verified against a real Postgres in test/sql/behavior-032.sql.
// What matters HERE is the other half of the anti-storm design: once several
// vendors have been coalesced into one notification, that notification has to
// actually name all of them. A bundle that silently renders as only the first
// vendor would look identical to the throttle eating the other four.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import webpush from 'web-push';
import {
  composeNotification, CAMPAIGN_CONFIG, CAMPAIGN_DURATIONS,
  runCampaignTick, startCampaignWorker, stopCampaignWorker,
  campaignWorkerStatus,
} from '../src/lib/campaigns.js';

const item = (vendor, over = {}) => ({
  campaignId: `c-${vendor}`,
  vendorId: `v-${vendor}`,
  vendor,
  title: `${vendor} deal`,
  body: 'Show your code at the counter.',
  kind: 'deal',
  hasLogo: false,
  ...over,
});

test('an empty bundle produces nothing to send', () => {
  assert.equal(composeNotification([]), null);
  assert.equal(composeNotification(null), null);
  assert.equal(composeNotification([null, undefined]), null);
});

test('a single campaign is delivered in the vendor’s own words', () => {
  const p = composeNotification([item('Blue Bird')]);
  assert.equal(p.title, 'Blue Bird deal');
  // The vendor is named in the body, because the title is the vendor's headline
  // and a notification with no attribution reads as spam.
  assert.ok(p.body.startsWith('Blue Bird: '));
  assert.equal(p.count, 1);
  // Deep link straight to that deal, not the generic list.
  assert.equal(p.url, '/?deal=c-Blue Bird');
});

test('a single campaign uses the vendor logo as the icon when there is one', () => {
  assert.equal(composeNotification([item('Taco', { hasLogo: true })]).icon, '/api/vendor-logo/v-Taco');
  assert.equal(composeNotification([item('Taco')]).icon, undefined);
});

test('two campaigns become one notification that names both', () => {
  const p = composeNotification([item('Blue Bird'), item('Taco')]);
  assert.equal(p.count, 2);
  assert.match(p.title, /^2 spots/);
  assert.ok(p.body.includes('Blue Bird'));
  assert.ok(p.body.includes('Taco'));
  assert.equal(p.url, '/?deals=1');
});

test('three campaigns list all three', () => {
  const p = composeNotification([item('A'), item('B'), item('C')]);
  assert.ok(p.body.includes('A') && p.body.includes('B') && p.body.includes('C'));
  assert.equal(p.count, 3);
});

test('past three, the extras are counted rather than dropped silently', () => {
  const p = composeNotification([item('Alpha'), item('Bravo'), item('Charlie'), item('Delta')]);
  assert.equal(p.count, 4);
  assert.ok(p.body.includes('Alpha') && p.body.includes('Bravo') && p.body.includes('Charlie'));
  // Delta is not named, but the student is told it exists.
  assert.ok(p.body.includes('1 more'), `expected an "and 1 more" tail, got: ${p.body}`);
});

test('every payload carries the collapse tag, so nothing can stack in the shade', () => {
  // The last line of defence: same tag = replace, not append. If the server-side
  // throttle were ever bypassed, the phone still shows one WeRewards entry.
  for (const n of [1, 2, 5]) {
    const p = composeNotification(Array.from({ length: n }, (_, i) => item(`V${i}`)));
    assert.equal(p.tag, 'wr-deals');
  }
});

test('bodies are clipped to a length a notification actually shows', () => {
  const long = composeNotification([item('Cafe', { body: 'x'.repeat(400) })]);
  assert.ok(long.body.length <= 140, `body was ${long.body.length} chars`);
  assert.ok(long.body.endsWith('…'));

  const manyNames = composeNotification(
    ['Aaaaaaaaaaaaaaaaaaaa', 'Bbbbbbbbbbbbbbbbbbbb', 'Cccccccccccccccccccc'].map((v) => item(v))
  );
  assert.ok(manyNames.body.length <= 140);
});

test('titles are clipped too', () => {
  const p = composeNotification([item('Cafe', { title: 'y'.repeat(200) })]);
  assert.ok(p.title.length <= 60, `title was ${p.title.length} chars`);
});

test('no em dashes reach a student (the repo copy rule)', () => {
  const one = composeNotification([item('Cafe')]);
  const many = composeNotification([item('A'), item('B'), item('C'), item('D')]);
  for (const p of [one, many]) {
    assert.ok(!p.title.includes('—'), `em dash in title: ${p.title}`);
    assert.ok(!p.body.includes('—'), `em dash in body: ${p.body}`);
  }
});

test('the shipped defaults are the ones the Privacy Policy promises', () => {
  // §7.4 states two per day, five per week, four hours apart, quiet 10pm-9am.
  // If any of these move, that document has to move with them.
  assert.equal(CAMPAIGN_CONFIG.dailyCap, 2);
  assert.equal(CAMPAIGN_CONFIG.weeklyCap, 5);
  assert.equal(CAMPAIGN_CONFIG.cooldownMinutes, 240);
  assert.equal(CAMPAIGN_CONFIG.quietStart, 22);
  assert.equal(CAMPAIGN_CONFIG.quietEnd, 9);
  // And the coalescing hold has to be non-zero, or there is no window in which
  // a second vendor's deal can join the first one's notification.
  assert.ok(CAMPAIGN_CONFIG.coalesceMinutes > 0);
  assert.ok(CAMPAIGN_CONFIG.bundleMax >= 2);
});

test('the durations the terminal offers are the ones the server accepts', () => {
  assert.deepEqual(CAMPAIGN_DURATIONS, [24, 72, 168]);
  assert.ok(CAMPAIGN_DURATIONS.includes(CAMPAIGN_CONFIG.defaultDurationHours)
    || CAMPAIGN_CONFIG.defaultDurationHours === 48);
});

test('with neither transport configured the tick does nothing at all', async () => {
  // The test environment sets no VAPID keys and no RESEND_API_KEY, so this is
  // the shape of a checkout — or a deployment — that has turned email off by
  // simply never setting it.
  //
  // "Does nothing" has to mean it never reaches the database, not merely that it
  // sends no mail. claim_campaign_pushes SPENDS a student's cooldown and daily
  // cap at claim time (migration-032, section 7), so a tick that claimed and
  // then found it had no way to deliver would silence that student for four
  // hours over a message that was never going to be sent. Any fetch here is a
  // failure, which is what the patched global proves.
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...args) => { calls++; return realFetch(...args); };
  try {
    const result = await runCampaignTick();
    assert.deepEqual(result, { claimed: 0, delivered: 0, emailed: 0 });
    assert.equal(calls, 0, 'the tick talked to the network with nothing configured');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the worker refuses to start when there is nothing to deliver with', () => {
  // Same reasoning one level up: an unconfigured deployment should not carry a
  // timer that wakes every 30 seconds to do nothing. startCampaignWorker is a
  // no-op, and stopCampaignWorker after it must stay safe to call regardless.
  startCampaignWorker();
  stopCampaignWorker();
});

test('an unconfigured deployment reports itself as not configured, and counts no ticks', async () => {
  // The /admin health strip reads this. "Not configured" is a different
  // message from "configured but stopped", and an unconfigured tick (which
  // returns before the claim) is not work the strip should count.
  await runCampaignTick();
  const s = campaignWorkerStatus();
  assert.equal(s.configured, false);
  assert.equal(s.running, false);
  assert.equal(s.ticks, 0);
  assert.equal(s.rpcMissing, false);
  assert.equal(s.intervalSeconds, Math.max(CAMPAIGN_CONFIG.tickSeconds, 5));
  for (const k of ['lastTickAt', 'lastTickMs', 'lastResult', 'lastError', 'lastErrorAt']) {
    assert.equal(s[k], null, `${k} should start null`);
  }
});

/* ---------- the configured tick, in a child process ----------

   pushEnabled and emailEnabled are import-time state (push.js and email.js read
   their keys at module scope), so the configured half runs in a child, the same
   way test/reminders.test.js and test/broadcasts.test.js do it. Every socket is
   stubbed: PostgREST by URL, Resend by host, and webpush.sendNotification on the
   shared module object. What these pin is the notification log (migration-062,
   contract 3.1): one honest row per claimed bundle, written WITHOUT changing a
   single thing the settle is told. */

const LIB = pathToFileURL(path.resolve('src/lib/campaigns.js')).href;
const SUPABASE = pathToFileURL(path.resolve('src/lib/supabase.js')).href;
const NOTIF_LOG = pathToFileURL(path.resolve('src/lib/notification-log.js')).href;
const KEYS = webpush.generateVAPIDKeys();

const U = '00000000-0000-4000-8000-0000000000a1';
const V = '00000000-0000-4000-8000-0000000000f1';
const C = '00000000-0000-4000-8000-0000000000c1';
const B = '00000000-0000-4000-8000-0000000000b1';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/ENDPOINT-CAPABILITY-abc123';
const P256DH = 'P256DH-SECRET-VALUE-xyz';
const AUTH = 'AUTH-SECRET-VALUE-qrs';
const SUB = { id: '00000000-0000-4000-8000-00000000005a', user_id: U, endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH, device_label: 'Android Chrome' };

const batch = (over = {}) => ({
  out_user_id: U,
  out_batch: B,
  out_reach: 'push',
  out_items: [{ campaignId: C, vendorId: V, vendor: 'Blue Bird', title: 'Half price bagels', body: 'Today only.', kind: 'deal', hasLogo: false }],
  ...over,
});

/**
 * @param {string} body  async ({ campaigns, seen, logRows, logPosts, fetches, sent, flush, BY_NAME }) => any
 * @param {object} opts
 *   rpcByName   name -> { data, error } (mutable from the body via BY_NAME)
 *   subs        push_subscriptions rows the student read returns
 *   pushStatus  status code webpush answers (2xx accepts, anything else rejects)
 *   profile     the profiles row emailBundle reads, or null
 *   logError    a PostgREST error body to answer notification_log writes with
 *   email       configure Resend too
 */
function runConfigured(body, { rpcByName = {}, subs = [], pushStatus = 201, profile = null, logError = null, email = false } = {}) {
  const src = `
    const fetches = [];
    const logPosts = [];
    const logRows = [];
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input?.url ?? input);
      const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
      fetches.push({ url, method });
      if (url.includes('api.resend.com')) return json({ id: 're_test_1' });
      if (url.includes('/rest/v1/notification_log')) {
        logPosts.push({ url, method });
        const parsed = init.body ? JSON.parse(init.body) : null;
        for (const r of [].concat(parsed ?? [])) logRows.push(r);
        const LOG_ERROR = ${JSON.stringify(logError)};
        if (LOG_ERROR) return json(LOG_ERROR, 404);
        return json([{ id: '00000000-0000-4000-8000-0000000000d1' }], 201);
      }
      if (url.includes('/rest/v1/push_subscriptions')) {
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return json(${JSON.stringify(subs)});
      }
      if (url.includes('/rest/v1/profiles')) {
        const P = ${JSON.stringify(profile)};
        return json(P ? [P] : []);
      }
      return json([]);
    };

    const { supabaseAdmin } = await import(${JSON.stringify(SUPABASE)});
    const seen = [];
    const BY_NAME = ${JSON.stringify(rpcByName)};
    supabaseAdmin.rpc = async (name, params) => {
      seen.push({ name, params });
      const hit = Object.prototype.hasOwnProperty.call(BY_NAME, name) ? BY_NAME[name] : { data: [], error: null };
      return { data: hit.data ?? null, error: hit.error ?? null };
    };

    const sent = [];
    const webpush = (await import('web-push')).default;
    const PUSH_STATUS = ${JSON.stringify(pushStatus)};
    webpush.sendNotification = async (sub, b) => {
      sent.push({ endpoint: sub.endpoint, body: b });
      if (PUSH_STATUS >= 200 && PUSH_STATUS < 300) return { statusCode: PUSH_STATUS };
      const err = new Error('push service said no');
      err.statusCode = PUSH_STATUS;
      err.body = 'rejected ' + sub.endpoint;
      throw err;
    };

    const campaigns = await import(${JSON.stringify(LIB)});
    const { flushNotificationLog } = await import(${JSON.stringify(NOTIF_LOG)});
    const flush = () => flushNotificationLog();

    const out = await (${body})({ campaigns, seen, logRows, logPosts, fetches, sent, flush, BY_NAME });
    console.log('__RESULT__' + JSON.stringify(out ?? null));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', src], {
    env: {
      ...process.env,
      VAPID_PUBLIC_KEY: KEYS.publicKey,
      VAPID_PRIVATE_KEY: KEYS.privateKey,
      VAPID_SUBJECT: '',
      RESEND_API_KEY: email ? 're_unit_test_key' : '',
      EMAIL_FROM: email ? 'WeRewards <hello@example.test>' : '',
      APP_ORIGIN: 'https://app.example.test',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `child produced no result. stdout:\n${stdout}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

/** Run one tick and hand back everything a log assertion needs. */
const TICK = `async ({ campaigns, seen, logRows, logPosts, sent, flush }) => {
  const result = await campaigns.runCampaignTick();
  await flush();
  return {
    result,
    rows: logRows,
    logPosts,
    sent: sent.length,
    finishes: seen.filter((c) => c.name === 'finish_campaign_batch').map((c) => c.params),
  };
}`;

const claimOf = (...batches) => ({ claim_campaign_pushes: { data: batches } });

test('a delivered deal push is logged once, as sent, with its devices and dedupe key', () => {
  const out = runConfigured(TICK, { rpcByName: claimOf(batch()), subs: [SUB] });

  assert.deepEqual(out.result, { claimed: 1, delivered: 1, emailed: 0 });
  // The settle is exactly what it was before logging existed.
  assert.deepEqual(out.finishes, [{ p_batch: B, p_ok: true, p_refund: false, p_channel: 'push' }]);

  assert.equal(out.rows.length, 1, `expected one log row, got ${JSON.stringify(out.rows)}`);
  const r = out.rows[0];
  assert.equal(r.channel, 'push');
  assert.equal(r.kind, 'deal');
  assert.equal(r.outcome, 'sent');
  assert.equal(r.reason, null);
  assert.equal(r.recipient_kind, 'student');
  assert.equal(r.student_id, U);
  assert.equal(r.vendor_id, V);
  assert.equal(r.title, 'Half price bagels');
  assert.equal(r.url, `/?deal=${C}`);
  assert.equal(r.template, 'wr-deals');
  assert.deepEqual(r.ref, { campaignIds: [C], batch: B, reach: 'push', refunded: false });
  assert.equal(r.dedupe_key, `deal:${B}`);
  assert.equal(r.devices_tried, 1);
  assert.equal(r.devices_accepted, 1);
  assert.deepEqual(r.devices, [{ subId: SUB.id, service: 'google', label: 'Android Chrome', ok: true, status: 201, pruned: false, error: null }]);
  // The dedupe key is only useful if the write is an upsert on it.
  assert.match(out.logPosts[0].url, /on_conflict=dedupe_key/);

  // NEVER the endpoint or its keys: together they can send that device anything.
  const raw = JSON.stringify(out.rows);
  for (const secret of [ENDPOINT, 'ENDPOINT-CAPABILITY', P256DH, AUTH]) {
    assert.ok(!raw.includes(secret), `the log row carries ${secret}`);
  }
});

test('a push no device took is logged as failed and refunded, with no dedupe key', () => {
  const out = runConfigured(TICK, { rpcByName: claimOf(batch()), subs: [SUB], pushStatus: 500 });

  assert.deepEqual(out.result, { claimed: 1, delivered: 0, emailed: 0 });
  assert.deepEqual(out.finishes, [{ p_batch: B, p_ok: false, p_refund: true, p_channel: 'push' }]);

  assert.equal(out.rows.length, 1);
  const r = out.rows[0];
  assert.equal(r.outcome, 'failed');
  assert.equal(r.reason, 'no_device_accepted');
  assert.equal(r.ref.refunded, true);
  // A failed attempt is never deduped: the requeued retry belongs in the log too.
  assert.equal(r.dedupe_key, null);
  assert.equal(r.devices_tried, 1);
  assert.equal(r.devices_accepted, 0);
  assert.equal(r.devices[0].status, 500);
  assert.equal(r.devices[0].pruned, false);
  // The push service echoed the endpoint in its error body; it is scrubbed.
  assert.ok(!JSON.stringify(r).includes('ENDPOINT-CAPABILITY'), 'the endpoint leaked through device.error');
  assert.doesNotMatch(out.logPosts[0].url, /on_conflict/, 'a failed row was written as an upsert');
});

test('a settle that fails every signature is logged as NOT refunded', () => {
  // finish_campaign_batch rejects all three signatures, so the batch stays in
  // 'sending' with the quota spent. The row must say what happened, not what
  // the worker asked for; the settle walk-back and the tick result are unchanged.
  const out = runConfigured(TICK, {
    rpcByName: {
      ...claimOf(batch()),
      finish_campaign_batch: { error: { code: 'XX000', message: 'database is down' } },
    },
    subs: [SUB],
    pushStatus: 500,
  });

  assert.deepEqual(out.result, { claimed: 1, delivered: 0, emailed: 0 });
  assert.deepEqual(out.finishes, [
    { p_batch: B, p_ok: false, p_refund: true, p_channel: 'push' },
    { p_batch: B, p_ok: false, p_refund: true },
    { p_batch: B, p_ok: false },
  ]);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].outcome, 'failed');
  assert.equal(out.rows[0].ref.refunded, false);
});

test('a dead endpoint that falls back to email logs both halves honestly', () => {
  // Push answers 410 (pruned), the email lands. The push row is FAILED but not
  // refunded (the batch was delivered, by email), and the email row carries the
  // fallback flag and the provider id the webhook will later update.
  const out = runConfigured(TICK, {
    rpcByName: claimOf(batch({ out_reach: 'both' })),
    subs: [SUB],
    pushStatus: 410,
    profile: { email: 'Student@Example.edu', name: 'Sam Student' },
    email: true,
  });

  assert.deepEqual(out.result, { claimed: 1, delivered: 1, emailed: 1 });
  assert.deepEqual(out.finishes, [{ p_batch: B, p_ok: true, p_refund: false, p_channel: 'email' }]);

  const push = out.rows.find((r) => r.channel === 'push');
  const mail = out.rows.find((r) => r.channel === 'email');
  assert.equal(out.rows.length, 2, `expected a push row and an email row, got ${JSON.stringify(out.rows)}`);

  assert.equal(push.outcome, 'failed');
  assert.equal(push.reason, 'no_device_accepted');
  assert.equal(push.ref.refunded, false, 'the batch was delivered by email, so nothing was refunded');
  assert.equal(push.devices[0].status, 410);
  assert.equal(push.devices[0].pruned, true);

  assert.equal(mail.kind, 'deal');
  assert.equal(mail.outcome, 'sent');
  assert.equal(mail.recipient_kind, 'student');
  assert.equal(mail.student_id, U);
  assert.equal(mail.vendor_id, V);
  assert.equal(mail.recipient_label, 'Sam Student');
  assert.equal(mail.recipient_email, 'student@example.edu');
  assert.equal(mail.provider_id, 're_test_1');
  assert.equal(mail.body, null);
  assert.equal(mail.ref.fallback, true);
  assert.deepEqual(mail.ref.campaignIds, [C]);
  assert.equal(mail.ref.batch, B);
  // Never the email body or the unsubscribe link (a permanent per-student token).
  const raw = JSON.stringify(mail);
  assert.ok(!/unsubscribe/i.test(raw), `the email row carries an unsubscribe link: ${raw}`);
  assert.ok(!raw.includes('<'), 'the email row carries html');
});

test('a bundle with nothing in it is logged as refused, content_empty', () => {
  const out = runConfigured(TICK, { rpcByName: claimOf(batch({ out_items: [] })), subs: [SUB] });
  assert.deepEqual(out.result, { claimed: 1, delivered: 0, emailed: 0 });
  // Unchanged settle: no refund for an empty bundle, exactly as before.
  assert.deepEqual(out.finishes, [{ p_batch: B, p_ok: false, p_refund: false, p_channel: 'push' }]);
  assert.equal(out.sent, 0);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].outcome, 'refused');
  assert.equal(out.rows[0].reason, 'content_empty');
  assert.deepEqual(out.rows[0].ref, { campaignIds: [], batch: B });
});

test('a student whose endpoint vanished after the claim is logged as refused, no_devices', () => {
  const out = runConfigured(TICK, { rpcByName: claimOf(batch()), subs: [] });
  assert.deepEqual(out.result, { claimed: 1, delivered: 0, emailed: 0 });
  assert.deepEqual(out.finishes, [{ p_batch: B, p_ok: false, p_refund: true, p_channel: 'push' }]);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].channel, 'push');
  assert.equal(out.rows[0].outcome, 'refused');
  assert.equal(out.rows[0].reason, 'no_devices');
  assert.equal(out.rows[0].ref.refunded, true);
  // What we would have said is still worth showing the operator.
  assert.equal(out.rows[0].title, 'Half price bagels');
});

test('an email fallback with no address on file is logged as an email refusal, not a push one', () => {
  const out = runConfigured(TICK, {
    rpcByName: claimOf(batch({ out_reach: 'email' })),
    profile: { email: null, name: 'No Mail' },
    email: true,
  });
  assert.deepEqual(out.result, { claimed: 1, delivered: 0, emailed: 0 });
  assert.equal(out.rows.length, 1, `expected exactly one row, got ${JSON.stringify(out.rows)}`);
  const r = out.rows[0];
  assert.equal(r.channel, 'email');
  assert.equal(r.kind, 'deal');
  assert.equal(r.outcome, 'refused');
  assert.equal(r.reason, 'no_email_address');
  assert.equal(r.student_id, U);
  assert.equal(r.ref.fallback, true);
});

test('a missing notification_log table changes nothing about the tick, and stops trying', () => {
  // migration-062 not applied: the first write answers 42P01, the log goes
  // quiet for its cool-down window, and the next tick does not even try. Each
  // tick's result and settle are exactly what they would have been with no
  // logging at all.
  const out = runConfigured(`async ({ campaigns, seen, logPosts, flush }) => {
    const first = await campaigns.runCampaignTick();
    await flush();
    const postsAfterFirst = logPosts.length;
    const second = await campaigns.runCampaignTick();
    await flush();
    return {
      first, second, postsAfterFirst, postsAfterSecond: logPosts.length,
      finishes: seen.filter((c) => c.name === 'finish_campaign_batch').map((c) => c.params),
    };
  }`, {
    rpcByName: claimOf(batch()),
    subs: [SUB],
    logError: { code: '42P01', message: 'relation "public.notification_log" does not exist' },
  });
  assert.deepEqual(out.first, { claimed: 1, delivered: 1, emailed: 0 });
  assert.deepEqual(out.second, { claimed: 1, delivered: 1, emailed: 0 });
  assert.deepEqual(out.finishes, [
    { p_batch: B, p_ok: true, p_refund: false, p_channel: 'push' },
    { p_batch: B, p_ok: true, p_refund: false, p_channel: 'push' },
  ]);
  assert.equal(out.postsAfterFirst, 1, 'the first tick should have tried once');
  assert.equal(out.postsAfterSecond, 1, 'the second tick wrote again inside the cool-down window');
});

test('worker status records a tick, and rpcMissing follows the claim', () => {
  const out = runConfigured(`async ({ campaigns, BY_NAME, flush }) => {
    const before = campaigns.campaignWorkerStatus();
    const r1 = await campaigns.runCampaignTick();
    const afterOk = campaigns.campaignWorkerStatus();

    // migration-032's claim missing outright: both the 047 call and the legacy
    // retry answer PGRST202, so the tick throws (as it always has).
    BY_NAME.claim_campaign_pushes = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.claim_campaign_pushes' } };
    let threw = false;
    try { await campaigns.runCampaignTick(); } catch { threw = true; }
    const afterMissing = campaigns.campaignWorkerStatus();

    BY_NAME.claim_campaign_pushes = { data: [] };
    await campaigns.runCampaignTick();
    const afterRecovered = campaigns.campaignWorkerStatus();
    await flush();
    return { before, r1, afterOk, threw, afterMissing, afterRecovered };
  }`, { rpcByName: claimOf(batch()), subs: [SUB] });

  assert.equal(out.before.configured, true);
  assert.equal(out.before.running, false, 'nothing armed the loop in this child');
  assert.equal(out.before.ticks, 0);

  assert.equal(out.afterOk.ticks, 1);
  assert.ok(out.afterOk.lastTickAt && !Number.isNaN(Date.parse(out.afterOk.lastTickAt)));
  assert.equal(typeof out.afterOk.lastTickMs, 'number');
  assert.deepEqual(out.afterOk.lastResult, out.r1);
  assert.equal(out.afterOk.lastError, null);
  assert.equal(out.afterOk.rpcMissing, false);

  assert.equal(out.threw, true, 'a failed claim must still throw out of runCampaignTick');
  assert.equal(out.afterMissing.ticks, 2);
  assert.equal(out.afterMissing.rpcMissing, true);
  assert.match(out.afterMissing.lastError, /claim_campaign_pushes/);
  assert.ok(Date.parse(out.afterMissing.lastErrorAt) >= Date.parse(out.afterOk.lastTickAt));
  // The last GOOD tick is still the first one: a failure does not move it.
  assert.equal(out.afterMissing.lastTickAt, out.afterOk.lastTickAt);

  assert.equal(out.afterRecovered.rpcMissing, false, 'a successful claim clears rpcMissing');
  assert.equal(out.afterRecovered.ticks, 3);
});

test('a non-missing claim error is a tick error but not rpcMissing', () => {
  const out = runConfigured(`async ({ campaigns }) => {
    try { await campaigns.runCampaignTick(); } catch {}
    return campaigns.campaignWorkerStatus();
  }`, { rpcByName: { claim_campaign_pushes: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } } });
  assert.equal(out.rpcMissing, false);
  assert.match(out.lastError, /statement timeout/);
  assert.equal(out.lastTickAt, null);
});
