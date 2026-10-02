// Unit tests for the web push transport (src/lib/push.js).
//
// This module had no JavaScript coverage at all until now, which matters more
// than "a file with no tests" usually does, for two reasons.
//
//   1. IT IS THE ONLY WAY OUT. Every notification this app sends over push goes
//      through sendToSubscriptions: operator alerts (src/routes/apply.js,
//      src/routes/stripe-webhook.js, alerts.js) and student deals (the campaign
//      worker in campaigns.js). It is imported from src/routes/student.js, which
//      server.js imports at boot, so a throw at IMPORT time here is not a failed
//      notification, it is a dyno that never serves a request.
//
//   2. ITS RETURN VALUE SPENDS THE SHARED BUDGET. campaigns.js (around line 275)
//      reads the count this module returns and refunds the student's cooldown and
//      daily cap when it is 0 (migration-033). So an over-count -- an endpoint the
//      push service REJECTED being counted as accepted -- skips the refund AND
//      skips the email fallback, which is a student silenced for four hours over
//      a notification that was never delivered. The count is not a statistic; it
//      is the input to the quota decision, and that is why several tests below
//      assert the exact number rather than "more than zero".
//
// The test environment deliberately sets no VAPID keys (see test/setup.js, which
// only fills in Supabase placeholders), so `pushEnabled` is false in THIS process
// and the disabled half of the file is an honest end-to-end assertion of what an
// unconfigured checkout does. The enabled half cannot be: pushEnabled and both
// keys are read at import time, and webpush.setVapidDetails VALIDATES the pair,
// so there is no in-process way to flip the module on without leaving the rest of
// the suite holding a transport that believes it can send. Those cases run in a
// child process with the env set, exactly like runWithKey in test/email.test.js
// and test/posthog.test.js. See runWithKeys below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import webpush from 'web-push';
import {
  pushEnabled, getVapidPublicKey, sendToSubscriptions,
  notifyAdmins, notifyAdminEndpoint, studentSubscriptions,
} from '../src/lib/push.js';

/* ---------- the config gate: what a checkout with no keys does ---------- */

/**
 * Count every way this module could reach the outside world, run `fn`, then put
 * the world back.
 *
 * TWO seams, not one, because push.js has two upstreams and they do not share a
 * transport. web-push sends over node:https (see https.request in
 * web-push/src/web-push-lib.js), so a patched globalThis.fetch would not see a
 * single notification leave; supabase-js reads through retryingFetch, which
 * resolves `fetch` off the global at CALL time (the `doFetch = fetch` default
 * parameter in src/lib/supabase.js) and so is catchable there. Patching only one
 * of the two would let half of a regression through silently.
 *
 * Stubbing works at all because web-push is CommonJS: its module.exports is one
 * plain object, and push.js's own `import webpush from 'web-push'` is that same
 * object, so a property replaced here is the function push.js calls.
 */
async function withNoNetwork(fn) {
  const realSend = webpush.sendNotification;
  const realFetch = globalThis.fetch;
  const touched = [];
  webpush.sendNotification = async (sub) => {
    touched.push(`webpush ${sub?.endpoint}`);
    return { statusCode: 201 };
  };
  globalThis.fetch = async (input, init = {}) => {
    touched.push(`${String(init.method ?? 'GET').toUpperCase()} ${String(input?.url ?? input)}`);
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    return { result: await fn(), touched };
  } finally {
    webpush.sendNotification = realSend;
    globalThis.fetch = realFetch;
  }
}

test('with no VAPID keys the module is off and the browser is told so', () => {
  assert.equal(pushEnabled, false, 'the test env must not carry real VAPID keys');
  // null, not '' and not the empty-string key itself: src/routes/student.js
  // serves this to the PWA, and a falsy-but-present key is what makes a browser
  // call pushManager.subscribe() with garbage instead of skipping the prompt.
  assert.equal(getVapidPublicKey(), null);
});

test('a disabled send is 0 and never touches the push service or the database', async () => {
  // Realistic rows, because the guard has to be the config check and not an
  // accident of empty input: this is a student who IS subscribed on a deployment
  // where push was never configured.
  const subs = [
    { endpoint: 'https://fcm.googleapis.com/fcm/send/aaa', p256dh: 'pub', auth: 'auth' },
    { endpoint: 'https://fcm.googleapis.com/fcm/send/bbb', p256dh: 'pub', auth: 'auth' },
  ];
  const { result, touched } = await withNoNetwork(() => sendToSubscriptions(subs, { title: 'A deal near you' }));
  assert.equal(result, 0);
  assert.deepEqual(touched, [], 'a disabled module talked to the outside world');
});

test('every disabled entry point answers rather than throwing', async () => {
  // All three of these are called from places that cannot tolerate a rejection:
  // notifyAdmins from inside a vendor application being submitted
  // (src/routes/apply.js) and a Stripe webhook, studentSubscriptions from the
  // campaign worker's tick. A throw there is a 500 on a form a real vendor is
  // filling in, or a tick that abandons the students after the one it threw on.
  const { result, touched } = await withNoNetwork(async () => [
    await notifyAdmins({ title: 'WeRewards error: Server', body: 'Boom' }),
    await notifyAdminEndpoint('admin-1', 'https://fcm.googleapis.com/fcm/send/ccc', { title: 'Test' }),
    await studentSubscriptions('student-1'),
  ]);
  assert.deepEqual(result, [0, 0, []]);
  assert.deepEqual(touched, []);
});

test('malformed arguments are refused locally, before any transport', async () => {
  const { result, touched } = await withNoNetwork(async () => [
    await sendToSubscriptions(null, { title: 'x' }),
    await sendToSubscriptions(undefined, null),
    await sendToSubscriptions([], { title: 'x' }),
    await studentSubscriptions(null),
    await studentSubscriptions(undefined),
    await notifyAdminEndpoint(null, null, { title: 'x' }),
  ]);
  assert.deepEqual(result, [0, 0, 0, [], [], 0]);
  assert.deepEqual(touched, []);
});

test('a disabled student read is gated BEFORE the query, not after it', async () => {
  // The task for this file asked for the `role = 'student'` filter to be asserted
  // by stubbing the query builder. In this process that is not what happens: the
  // `!pushEnabled` guard returns [] before supabaseAdmin is touched at all, so
  // there is no query to inspect and no filter arguments to capture. That is the
  // stronger property anyway (an unconfigured deployment costs zero PostgREST
  // requests per campaign tick), so it is what is asserted here. The actual
  // `role=eq.student` filter IS asserted, at the HTTP layer where PostgREST reads
  // it, by the enabled-path test further down.
  const { result, touched } = await withNoNetwork(() => studentSubscriptions('student-1'));
  assert.deepEqual(result, []);
  assert.equal(touched.length, 0, 'the read reached the database despite push being disabled');
});

/* ---------- the enabled path, in a child process ---------- */

const LIB = pathToFileURL(path.resolve('src/lib/push.js')).href;

/**
 * A keypair web-push itself accepts. Generated locally (an ECDH P-256 pair out of
 * node:crypto -- no network, no account, no push service), because
 * setVapidDetails validates the length and curve of both keys and would throw on
 * a made-up string. This is why the enabled half of this file cannot simply
 * export VAPID_PUBLIC_KEY=x and be done.
 */
const KEYS = webpush.generateVAPIDKeys();

/**
 * Load src/lib/push.js in a child process with the VAPID keys set, the push
 * service scripted and supabase-js's transport stubbed, then run `body` and print
 * whatever it returns as JSON.
 *
 * Why a child: see the file header -- pushEnabled is import-time state, and
 * setVapidDetails writes to web-push's own module-level vapidDetails, so flipping
 * it on in-process would outlive the test that did it.
 *
 * The push service is scripted BY ENDPOINT so that a single call can carry a mix
 * of healthy and broken subscriptions, which is the case that actually happens to
 * a student with two phones and one stale permission:
 *   .../dead-<code>  rejects with that HTTP status, as a real WebPushError;
 *   .../boom         drops the connection (an Error with NO statusCode at all,
 *                    which is what a DNS failure or a reset socket looks like).
 * Everything else is accepted.
 *
 * `rows` is the body every Supabase read gets back and `status` its HTTP status,
 * so a test can hand the module subscriptions to deliver to, or a PostgREST
 * error. Every request is recorded with its method and URL, because PostgREST
 * puts filters in the query string -- which makes the URL the only place where
 * "it filtered on role" and "it filtered the DELETE at all" can be observed.
 *
 * VAPID_SUBJECT is always set explicitly (to '' for "unset", which is what
 * push.js's `||` fallback reads) so that a developer who happens to export one
 * cannot change what is under test. The Supabase placeholders come from the
 * parent's env, which test/setup.js has already filled in -- the parent could not
 * have imported push.js at all otherwise.
 */
function runWithKeys(body, {
  rows = '[]',
  status = 200,
  subject = '',
  publicKey = KEYS.publicKey,
  privateKey = KEYS.privateKey,
} = {}) {
  const src = `
    const calls = [];
    const warnings = [];
    console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };

    globalThis.fetch = async (input, init = {}) => {
      calls.push({
        url: String(input?.url ?? input),
        method: String(init.method ?? input?.method ?? 'GET').toUpperCase(),
      });
      return new Response(${JSON.stringify(rows)}, {
        status: ${Number(status)},
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const webpush = (await import('web-push')).default;

    // WRAPPED, not replaced: the real validation still has to run, because "an
    // enabled deployment boots instead of throwing at import" is one of the
    // things under test here.
    const vapid = [];
    const realSetVapidDetails = webpush.setVapidDetails;
    webpush.setVapidDetails = (...a) => { vapid.push(a); return realSetVapidDetails(...a); };

    const sends = [];
    webpush.sendNotification = async (sub, body) => {
      sends.push({ endpoint: sub.endpoint, keys: sub.keys, body });
      const dead = /\\/dead-(\\d+)$/.exec(sub.endpoint);
      if (dead) {
        throw new webpush.WebPushError('push service refused it', Number(dead[1]), {}, 'refused', sub.endpoint);
      }
      if (sub.endpoint.endsWith('/boom')) throw new Error('socket hang up');
      return { statusCode: 201 };
    };

    const push = await import(${JSON.stringify(LIB)});
    const out = await (${body})({ push, calls, warnings, sends, vapid });
    console.log('__RESULT__' + JSON.stringify(out));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', src], {
    env: {
      ...process.env,
      VAPID_PUBLIC_KEY: publicKey,
      VAPID_PRIVATE_KEY: privateKey,
      VAPID_SUBJECT: subject,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `child produced no result. stdout:\n${stdout}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

/** One subscription row in the shape push_subscriptions actually stores. */
const sub = (endpoint, i = 0) => ({ endpoint, p256dh: `pub-${i}`, auth: `auth-${i}` });

test('keys in the env turn the module on and hand the browser the public one', () => {
  const out = runWithKeys('async ({ push, vapid }) => ({ enabled: push.pushEnabled, served: push.getVapidPublicKey(), vapid })');
  assert.equal(out.enabled, true);
  assert.equal(out.served, KEYS.publicKey);
  // The subject fallback is asserted, not glossed over, because setVapidDetails
  // validates it and this call is at module scope: a fallback web-push rejected
  // would turn "VAPID keys configured, VAPID_SUBJECT forgotten" into a throw on
  // the import chain server.js runs at boot -- every route, not just push.
  assert.deepEqual(out.vapid, [['mailto:admin@example.com', KEYS.publicKey, KEYS.privateKey]]);
});

test('a configured send hands web-push the nested key shape it requires', () => {
  const out = runWithKeys(`async ({ push, sends, calls }) => {
    // A payload that counts its own serialisations. toJSON runs once per
    // JSON.stringify, so n is how many times the module turned this object into
    // a string -- 1 if it did so before the loop and shared the result, 2 if it
    // did it per endpoint. The returned shape is the real payload, so every
    // other assertion in this test is unaffected.
    const counter = { n: 0 };
    const payload = {
      title: '2 spots have deals', body: 'Blue Bird, Taco', tag: 'wr-deals',
      toJSON() {
        counter.n += 1;
        return { title: this.title, body: this.body, tag: this.tag };
      },
    };
    const sent = await push.sendToSubscriptions(
      ${JSON.stringify([sub('https://push.test/a', 'a'), sub('https://push.test/b', 'b')])},
      payload,
    );
    return {
      sent,
      sends,
      deletes: calls.filter((c) => c.method === 'DELETE').map((c) => c.url),
      serialisations: counter.n,
    };
  }`);
  assert.equal(out.sent, 2);
  assert.deepEqual(out.sends.map((s) => s.endpoint), ['https://push.test/a', 'https://push.test/b']);
  // p256dh and auth live under `keys`, not on the subscription itself. A flat
  // object is accepted by this stub and by TypeScript-free JavaScript, and is
  // rejected by every real push service as a malformed subscription -- so the
  // nesting is asserted literally, column by column, rather than by shape.
  assert.deepEqual(out.sends[0].keys, { p256dh: 'pub-a', auth: 'auth-a' });
  assert.deepEqual(out.sends[1].keys, { p256dh: 'pub-b', auth: 'auth-b' });
  // Serialised ONCE and shared, so two devices of the same student cannot be
  // handed two different notifications for one claim.
  //
  // Asserted by IDENTITY, not by value. Comparing the strings cannot fail:
  // identical input serialises to identical output, so `new Set(bodies).size`
  // is 1 whether the payload was stringified once outside the map or once per
  // endpoint inside it. Moving JSON.stringify into the subs.map callback -- the
  // exact thing this comment forbids -- left that version of the assertion
  // green. Counting toJSON calls distinguishes the two, because it is invoked
  // once per serialisation regardless of what the result looks like.
  assert.equal(out.serialisations, 1, `payload serialised ${out.serialisations} times for 2 endpoints`);
  assert.equal(new Set(out.sends.map((s) => s.body)).size, 1);
  assert.deepEqual(JSON.parse(out.sends[0].body), { title: '2 spots have deals', body: 'Blue Bird, Taco', tag: 'wr-deals' });
  assert.deepEqual(out.deletes, [], 'a healthy endpoint was pruned');
});

test('401, 403, 404 and 410 all prune the endpoint they came from', () => {
  // The subtlest behaviour in the module, and the reason the 401/403 half of it
  // exists (see the comment in push.js): claim_campaign_pushes only checks that
  // SOME row exists for the student, so a row minted against a different VAPID
  // keypair -- the state every key rotation leaves behind -- keeps that student
  // claimable, spends their cooldown and daily cap on every tick, and delivers
  // nothing, forever. Pruning is what lets the PWA mint a fresh subscription.
  const codes = [401, 403, 404, 410];
  const subs = codes.map((c, i) => sub(`https://push.test/dead-${c}`, i));
  const out = runWithKeys(`async ({ push, calls, warnings }) => ({
    sent: await push.sendToSubscriptions(${JSON.stringify(subs)}, { title: 'A deal near you' }),
    deletes: calls.filter((c) => c.method === 'DELETE').map((c) => c.url),
    warnings,
  })`);
  assert.equal(out.sent, 0, 'a rejected endpoint was counted as a delivery');
  assert.equal(out.deletes.length, codes.length, `expected ${codes.length} deletes, got ${JSON.stringify(out.deletes)}`);
  for (const code of codes) {
    const endpoint = `https://push.test/dead-${code}`;
    assert.ok(
      out.deletes.some((u) => u.includes(encodeURIComponent(endpoint))),
      `HTTP ${code} did not prune its endpoint. deletes: ${JSON.stringify(out.deletes)}`,
    );
    assert.ok(
      out.warnings.some((w) => w.includes(`(${code})`)),
      `HTTP ${code} was pruned without a word in the log: ${JSON.stringify(out.warnings)}`,
    );
  }
  // THE FILTER ITSELF, because PostgREST honours an unfiltered DELETE: if the
  // .eq('endpoint', ...) were ever dropped, one dead phone would delete every
  // push subscription in the app -- students and operators -- and the only
  // symptom would be notifications quietly stopping for everybody.
  for (const url of out.deletes) {
    assert.match(url, /\/push_subscriptions\?endpoint=eq\./, `an unfiltered DELETE: ${url}`);
  }
});

test('a 500 or a dropped connection keeps the row and only logs', () => {
  // The other direction of the same decision. These are our problem or the push
  // service's, not the subscription's: pruning on a 5xx would unsubscribe a whole
  // population during somebody else's outage, and the student would only find out
  // by never hearing from us again.
  const out = runWithKeys(`async ({ push, calls, warnings }) => ({
    sent: await push.sendToSubscriptions(
      ${JSON.stringify([sub('https://push.test/dead-500', 0), sub('https://push.test/boom', 1)])},
      { title: 'A deal near you' },
    ),
    deletes: calls.filter((c) => c.method === 'DELETE').map((c) => c.url),
    warnings,
  })`);
  assert.equal(out.sent, 0);
  assert.deepEqual(out.deletes, [], 'a retryable failure pruned the subscription');
  assert.ok(out.warnings.some((w) => w.includes('(500)')), JSON.stringify(out.warnings));
  // An Error with no statusCode (a reset socket, a DNS failure) must still be
  // reported, and must report that it had no status rather than printing
  // "undefined" at the operator reading the dyno log.
  assert.ok(out.warnings.some((w) => w.includes('no status')), JSON.stringify(out.warnings));
});

test('one dead phone does not cost the student the notification', () => {
  // A student with a laptop and two phones, one of which revoked permission.
  // Promise.allSettled, not Promise.all: the live endpoint still gets the deal,
  // the count is the number that ACCEPTED it (1, so campaigns.js does not refund
  // and does not also email), and the dead row is pruned on the way past.
  const out = runWithKeys(`async ({ push, calls }) => ({
    sent: await push.sendToSubscriptions(
      ${JSON.stringify([sub('https://push.test/live', 0), sub('https://push.test/dead-410', 1), sub('https://push.test/boom', 2)])},
      { title: 'A deal near you' },
    ),
    deletes: calls.filter((c) => c.method === 'DELETE').map((c) => c.url),
  })`);
  assert.equal(out.sent, 1);
  assert.equal(out.deletes.length, 1, `expected only the 410 to be pruned: ${JSON.stringify(out.deletes)}`);
  assert.ok(out.deletes[0].includes(encodeURIComponent('https://push.test/dead-410')));
});

test('an enabled module with nothing to send still makes no attempt', () => {
  // campaigns.js calls sendToSubscriptions with whatever studentSubscriptions
  // returned, including [] for a student who never allowed notifications. 0 has
  // to come back from the guard, with no request made, so the worker's refund
  // path is reached by a cheap local answer rather than a round trip per student.
  const out = runWithKeys(`async ({ push, sends, calls }) => ({
    results: [
      await push.sendToSubscriptions([], { title: 'x' }),
      await push.sendToSubscriptions(null, { title: 'x' }),
      await push.sendToSubscriptions(undefined, undefined),
    ],
    sends: sends.length,
    calls: calls.length,
  })`);
  assert.deepEqual(out.results, [0, 0, 0]);
  assert.equal(out.sends, 0);
  assert.equal(out.calls, 0);
});

/* ---------- the role column, which is what keeps the two populations apart ---------- */

test('a student read is filtered to that student and to role = student', () => {
  // The two service workers are on different scopes (/sw.js vs /admin/sw.js) so
  // their endpoints cannot collide, but nothing about an endpoint says which
  // population it belongs to: the role column is the whole separation. Without
  // this filter the campaign worker would hand a deal to the admin browsers, and
  // without the user_id filter it would hand every student's deal to every
  // student -- a notification naming a vendor they have never visited, from a
  // claim that spent somebody else's quota.
  const rows = [sub('https://push.test/phone', 0), sub('https://push.test/laptop', 1)];
  const out = runWithKeys(`async ({ push, calls }) => ({
    subs: await push.studentSubscriptions('student-77'),
    calls,
  })`, { rows: JSON.stringify(rows) });
  assert.deepEqual(out.subs, rows);
  assert.equal(out.calls.length, 1, `expected exactly one read: ${JSON.stringify(out.calls)}`);
  const url = out.calls[0].url;
  assert.equal(out.calls[0].method, 'GET');
  assert.ok(url.includes('role=eq.student'), `the read was not filtered to students: ${url}`);
  assert.ok(url.includes('user_id=eq.student-77'), `the read was not filtered to one student: ${url}`);
  assert.ok(!url.includes('role=eq.admin'), url);
});

test('an admin broadcast is filtered to role = admin and narrowed no further', () => {
  const rows = [sub('https://push.test/admin-desk', 0)];
  const out = runWithKeys(`async ({ push, calls, sends }) => ({
    delivered: await push.notifyAdmins({ title: 'WeRewards error: Server', body: 'Boom', url: '/admin/' }),
    calls,
    sends,
  })`, { rows: JSON.stringify(rows) });
  // A real count of endpoints that accepted, not a 1 for "we tried". Both
  // notifyAdmins call sites (src/routes/admin.js:1646 and :1691) and
  // src/lib/alerts.js:32 await it and discard the number, so nothing surfaces it
  // to a human today -- it is the signal any future caller would use to tell a
  // real delivery from a silent no-op, and the shape has to be right before one
  // relies on it. (The operator-facing 502 PUSH_NOT_DELIVERED is a different
  // function, notifyAdminEndpoint at src/routes/admin.js:2926; its count is
  // pinned by the single-browser diagnostic test below, where that reason
  // actually applies.)
  assert.equal(out.delivered, 1);
  const url = out.calls[0].url;
  assert.ok(url.includes('role=eq.admin'), url);
  // Every admin device, so neither of the optional narrowings may appear. (The
  // select list contains the word endpoint, hence the =eq. in the assertion.)
  assert.ok(!url.includes('user_id=eq.'), `a broadcast was narrowed to one admin: ${url}`);
  assert.ok(!url.includes('endpoint=eq.'), `a broadcast was narrowed to one browser: ${url}`);
  assert.deepEqual(JSON.parse(out.sends[0].body), { title: 'WeRewards error: Server', body: 'Boom', url: '/admin/' });
});

test('the admin diagnostic send is narrowed to one browser, or not sent at all', () => {
  // "Send me a test push" from /admin. Without the endpoint filter the operator
  // testing their own phone pages every other operator; without the user_id
  // filter an endpoint guessed from another account would be notifiable.
  const out = runWithKeys(`async ({ push, calls }) => ({
    delivered: await push.notifyAdminEndpoint('admin-9', 'https://push.test/this-one', { title: 'Test push' }),
    calls,
  })`, { rows: JSON.stringify([sub('https://push.test/this-one', 0)]) });
  assert.equal(out.delivered, 1);
  const url = out.calls[0].url;
  assert.ok(url.includes('role=eq.admin'), url);
  assert.ok(url.includes('user_id=eq.admin-9'), url);
  assert.ok(url.includes(`endpoint=eq.${encodeURIComponent('https://push.test/this-one')}`), url);

  // And a half-formed request is refused locally. Reaching the query with either
  // half missing is the dangerous shape: adminSubscriptions only applies the
  // filters it is GIVEN, so a null endpoint silently widens the diagnostic into
  // a broadcast rather than failing.
  const guarded = runWithKeys(`async ({ push, calls, sends }) => ({
    results: [
      await push.notifyAdminEndpoint('admin-9', '', { title: 'Test push' }),
      await push.notifyAdminEndpoint('admin-9', null, { title: 'Test push' }),
      await push.notifyAdminEndpoint(null, 'https://push.test/this-one', { title: 'Test push' }),
      await push.notifyAdminEndpoint(undefined, undefined, { title: 'Test push' }),
    ],
    calls: calls.length,
    sends: sends.length,
  })`, { rows: JSON.stringify([sub('https://push.test/this-one', 0)]) });
  assert.deepEqual(guarded.results, [0, 0, 0, 0]);
  assert.equal(guarded.calls, 0, 'a half-formed diagnostic reached the database');
  assert.equal(guarded.sends, 0, 'a half-formed diagnostic reached the push service');
});

/* ---------- the failure direction (test/nearby.test.js property 1) ---------- */

test('a database read that fails reads as unreachable, never as a throw', () => {
  // What an unmigrated or renamed push_subscriptions actually looks like from
  // PostgREST. Both callers are on paths that must survive it: the campaign
  // worker would otherwise abandon every student after the one it threw on
  // (and leave their claims spent, because the claim happens first), and
  // notifyAdmins is awaited inside a vendor application being submitted.
  const err = JSON.stringify({ code: '42P01', message: 'relation "public.push_subscriptions" does not exist' });
  const out = runWithKeys(`async ({ push, sends, warnings }) => ({
    subs: await push.studentSubscriptions('student-77'),
    delivered: await push.notifyAdmins({ title: 'WeRewards error: Server' }),
    sends: sends.length,
    warnings,
  })`, { rows: err, status: 400 });
  assert.deepEqual(out.subs, [], 'a failed read must be no endpoints, not an error object');
  assert.equal(out.delivered, 0);
  assert.equal(out.sends, 0, 'a notification was attempted against a failed read');
  assert.ok(
    out.warnings.some((w) => w.includes('could not read admin subscriptions')),
    `the failed admin read was silent: ${JSON.stringify(out.warnings)}`,
  );
});

test('half-configured keys mean off, not a crash at boot', () => {
  // The state a key rotation passes through: one config var landed, the other
  // not. setVapidDetails throws on a missing key, and push.js sits on the import
  // chain of server.js (server.js -> src/routes/student.js -> src/lib/push.js),
  // so a module that called it anyway would not degrade a feature, it would
  // crash-loop the dyno with no notification ever having been the point.
  for (const half of [{ privateKey: '' }, { publicKey: '' }]) {
    const out = runWithKeys(`async ({ push, vapid, sends, calls }) => ({
      enabled: push.pushEnabled,
      served: push.getVapidPublicKey(),
      sent: await push.sendToSubscriptions(${JSON.stringify([sub('https://push.test/a', 0)])}, { title: 'x' }),
      vapid,
      sends: sends.length,
      calls: calls.length,
    })`, half);
    assert.equal(out.enabled, false, `${JSON.stringify(half)} was treated as configured`);
    assert.equal(out.served, null, 'half a keypair was served to a browser');
    assert.equal(out.sent, 0);
    assert.deepEqual(out.vapid, [], 'setVapidDetails was called with half a keypair');
    assert.equal(out.sends, 0);
    assert.equal(out.calls, 0);
  }
});

/* ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT AND CANNOT COVER, so nobody reads it as more than it
 * is:
 *
 *   • THE WIRE. Every enabled test stubs webpush.sendNotification, so the
 *     payload encryption (ECDH + AES-GCM) and the VAPID JWT are never built and
 *     no request ever leaves. Asserting those would mean a real subscription
 *     from a real browser against a real push service -- there is no offline
 *     equivalent -- and they are web-push's own tested code, not ours. The
 *     keypair above is genuine, so setVapidDetails' validation of the keys and
 *     of the subject fallback IS exercised; nothing beyond that is.
 *
 *   • THAT 401/403 IS WHAT A FOREIGN KEYPAIR ACTUALLY PROVOKES. These tests
 *     assert what push.js does with a status code, not that FCM/Mozilla/Apple
 *     answer with that code. The premise behind pruning on 401/403 came from
 *     production and can only be re-confirmed there.
 *
 *   • THAT THE ROW IS GONE. The prune is asserted at the HTTP layer: method
 *     DELETE, table push_subscriptions, filtered on that endpoint. Whether
 *     Postgres then removes it (service-role key, RLS on the table) is a
 *     database question and belongs with the SQL behaviour tests in test/sql/.
 *
 *   • A TRANSPORT THAT REJECTS, as opposed to PostgREST answering with an error.
 *     Measured rather than assumed: with globalThis.fetch rejecting, both
 *     studentSubscriptions and notifyAdmins still answer [] and 0 and neither
 *     raises -- but supabase-js 2.110 retries a rejected fetch eight times with a
 *     backoff, so each of those two reads takes about 7.8 SECONDS. Asserting it
 *     costs this suite 16 seconds to pin down a quiet refusal that belongs to
 *     supabase-js's retry layer rather than to this module, and the PostgREST
 *     error above already pins the direction this module answers in. Worth
 *     adding back if that backoff ever becomes configurable.
 *
 *   • THE CAPS. Nothing in this module reads or writes student_notify_state;
 *     the cooldown, the daily and weekly caps and quiet hours are decided inside
 *     the claim functions, under a row lock, and are asserted against a real
 *     Postgres (test/sql/behavior-032.sql, behavior-051.sql). What is asserted
 *     here is only the number this module hands BACK to that budget's refund
 *     decision in campaigns.js.
 * ------------------------------------------------------------------------- */
