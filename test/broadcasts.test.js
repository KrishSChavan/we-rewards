// Operator broadcasts (src/lib/broadcasts.js).
//
// Thin where the database does the thinking and thick where this module does.
// Every rule about whether a student MAY be interrupted lives in
// claim_admin_broadcast_pushes under a FOR UPDATE SKIP LOCKED row lock
// (migration-061) and belongs in test/sql against a real Postgres. What is left
// on this side is the half that turns one operator-typed message into one
// notification, plus the seam between the two — and that seam carries four
// properties that are easy to break and almost impossible to notice in
// production:
//
//   1. THE SHARED BUDGET, at the JS boundary. student_notify_state is one row
//      per student and it is the storm budget for every notification this
//      product has: vendor deals (migration-032/047), nearby alerts (051),
//      reminders (060) and now this. migration-061's caps only mean anything if
//      the numbers actually forwarded are CAMPAIGN_CONFIG's live values. A
//      second copy of those six numbers would not fail visibly: it would quietly
//      hand broadcasts a quota of their own the first time an operator retuned
//      CAMPAIGN_DAILY_CAP and nothing in here moved with it, and the symptom
//      would be a student hearing from us more often than the Privacy Policy
//      (§7.4) promises in the one sentence most likely to be quoted back at us:
//      "Two per day is the total number of times WeRewards will interrupt you,
//      whatever the reason." Our own announcements are one of the reasons.
//      test/nearby.test.js and test/reminders.test.js pin this for their claims;
//      the same property is pinned here, and then pinned AGAIN under a retune,
//      because only the retune can tell a forward apart from a copy that
//      happens to agree today.
//
//   2. NO CLAIM WITHOUT A TRANSPORT. The claim SPENDS the cooldown and both
//      counts before anything is delivered — it has to, or two workers both get
//      a slot. So a tick that could not possibly deliver must never reach the
//      database: claiming there would silence a student for four hours, deals
//      and reminders included, over a push that was never going to be sent.
//
//   3. EVERY CLAIMED ROW IS SETTLED. This is the property the other three are
//      usually written instead of. A claimed recipient sits at status 'sending'
//      with the student's slot already spent; finish_admin_broadcast is the only
//      thing that either counts it as sent or hands the slot back. A tick that
//      claims and then forgets to settle does not throw, does not log and does
//      not fail any test about configuration — it just leaves one student quiet
//      for four hours and one recipient row stuck until the ten-minute
//      requeue sweep, and it is invisible until somebody reads sent_count.
//
//   4. A BROADCAST IS NOT A DEAL. The collapse tag is what decides whether a
//      broadcast lands next to an unread vendor deal or on top of it. Sharing
//      'wr-deals' would make an announcement silently destroy the message a
//      student would rather have had, with no error anywhere.
//
// WHY HALF OF THIS RUNS IN A CHILD PROCESS. pushEnabled is import-time state in
// src/lib/push.js (VAPID keys are read at module scope), and ESM gives importers
// a read-only binding, so it cannot be flipped in-process — and a cache-busted
// re-import of broadcasts.js would still resolve './push.js' to the instance
// already in the registry. test/push.test.js hit this first and
// test/reminders.test.js narrowed the pattern to one module; runConfigured below
// is that harness again. The alternative was to weaken property 1 to "the params
// object mentions CAMPAIGN_CONFIG somewhere", which is not a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import webpush from 'web-push';
import {
  BROADCAST_CONFIG, composeBroadcast,
  runBroadcastTick, startBroadcastWorker, stopBroadcastWorker,
} from '../src/lib/broadcasts.js';
import { CAMPAIGN_CONFIG } from '../src/lib/campaigns.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

/* The ids the end-to-end tests at the foot of this file drive through the tick.
   Declared up here because the `claimed` fixture below uses them too: one pair of
   ids everywhere means a settlement asserted against the wrong recipient cannot
   look right by coincidence. */
const CLAIMED_USER = '00000000-0000-4000-8000-000000000001';
const CLAIMED_BROADCAST = '00000000-0000-4000-8000-0000000000b1';

/**
 * One row in the shape claim_admin_broadcast_pushes returns it (migration-061,
 * section 5): the claim carries the copy as well as the ids, so the worker needs
 * no second read.
 *
 * The fixture deliberately carries BOTH spellings of the three content fields —
 * the claim's `out_*` columns and the bare names — and sets each pair to the
 * same value. That is not hedging about the contract: the composed OUTPUT is
 * what every assertion below pins, and writing the input twice means a lib that
 * normalises the claim row before composing and a lib that composes the row
 * directly are held to exactly the same output. The end-to-end tick tests at the
 * foot of this file drive the real `out_*` shape through the module's own
 * plumbing, so the wiring is pinned there rather than guessed at here.
 */
const claimed = (over = {}) => {
  const row = {
    out_user_id: CLAIMED_USER,
    out_broadcast_id: CLAIMED_BROADCAST,
    title: 'Six new spots just joined',
    body: 'Four cafes and two sandwich places are giving points from today.',
    url: '/?spots=1',
    ...over,
  };
  return { ...row, out_title: row.title, out_body: row.body, out_url: row.url };
};

/** Swap supabaseAdmin.rpc for the duration of one call and capture its args. */
async function withRpc(impl, fn) {
  const original = supabaseAdmin.rpc;
  const seen = [];
  supabaseAdmin.rpc = async (name, params) => { seen.push({ name, params }); return impl(name, params); };
  try { return { result: await fn(), seen }; }
  finally { supabaseAdmin.rpc = original; }
}

/* ---------- the knobs this feature owns ---------- */

test('the knobs this feature owns ship with the values the owner asked for', () => {
  // 40 students per tick matches CAMPAIGN_CONFIG.batchUsers and the SQL default,
  // and is small on purpose: the claim takes a row lock per student and the
  // sends are sequential, so a tick is a trickle rather than a burst a push
  // service would rate-limit. 30s is how fast the queue drains, not how often a
  // student hears from us — the shared budget decides that, and it is the only
  // thing that does.
  assert.equal(BROADCAST_CONFIG.maxUsers, 40);
  assert.equal(BROADCAST_CONFIG.tickSeconds, 30);
});

test('the throttle is not re-declared here, and that absence is the feature', () => {
  // The single most important assertion in this file. These six belong to
  // CAMPAIGN_CONFIG and must be read from there at call time. A copy in this
  // object would give the house's own announcements a quota of their own, which
  // is the exact storm migration-032 was written to prevent — and this is the
  // one feature where the operator pressing Send is also the person who would
  // have to notice.
  for (const own of ['cooldownMinutes', 'dailyCap', 'weeklyCap', 'quietStart', 'quietEnd', 'timezone']) {
    assert.ok(!(own in BROADCAST_CONFIG),
      `BROADCAST_CONFIG.${own} is a second copy of a shared storm defence — forward CAMPAIGN_CONFIG.${own} instead`);
  }
});

/* ---------- the copy a student actually sees ---------- */

test('a broadcast carries a collapse tag of its own, never the deals one', () => {
  // Same tag = REPLACE, not append (and the service worker sets renotify:false,
  // so the replacement is silent). That is a useful last line of defence against
  // two broadcasts stacking, and a destructive one if the tag is shared: a
  // broadcast tagged 'wr-deals' would silently delete an unread vendor deal from
  // the shade, which is the message the student would rather have had, with
  // nothing logged anywhere. 'wr-reminder' is the same mistake in the other
  // direction. Asserted by name rather than "not equal to the others", so a
  // fourth feature inventing a fifth tag does not quietly pass.
  // By name, and ONLY by name. The two notEqual assertions that used to sit here
  // could never fail: a value equal to 'wr-broadcast' is already unequal to the
  // other two, so they asserted nothing and read as if they were the real check.
  assert.equal(composeBroadcast(claimed()).tag, 'wr-broadcast');
});

test('the operator cannot burst the lengths a notification actually shows', () => {
  // The same discipline composeNotification (campaigns.js) and composeReminder
  // use, for the same reason: the OS truncates both anyway, so the only question
  // is whether the cut is ours and lands on a word. It matters more here than
  // anywhere else, because nothing upstream caps what an operator types into a
  // textarea and a broadcast is the one notification with no vendor-sized
  // sentence to keep it honest.
  const p = composeBroadcast(claimed());
  assert.ok(p.title.length > 0 && p.body.length > 0, 'a usable row composed an empty payload');
  assert.ok(p.title.length <= 60, `title was ${p.title.length} chars`);
  assert.ok(p.body.length <= 140, `body was ${p.body.length} chars`);

  const long = composeBroadcast(claimed({ title: 'Q'.repeat(300), body: 'W'.repeat(900) }));
  assert.ok(long.title.length <= 60, `title was ${long.title.length} chars`);
  assert.ok(long.body.length <= 140, `body was ${long.body.length} chars`);
  // The ellipsis is the visible half of the contract: a hard slice at 140 reads
  // as a sentence that stops mid-word for no reason, and the operator has no way
  // to tell from the compose box that anything was lost.
  assert.ok(long.title.endsWith('…'), `clipped title did not say it was clipped: ${long.title}`);
  assert.ok(long.body.endsWith('…'), `clipped body did not say it was clipped: ${long.body}`);
});

test('a broadcast with nowhere to go still opens the app', () => {
  // url is nullable in admin_broadcasts and null means "the home screen", so the
  // compose has to turn that into something the service worker's notificationclick
  // handler can actually open. An undefined url there is a notification that
  // either does nothing when tapped or opens 'undefined' as a path — and a
  // broadcast nobody can tap is a spent budget.
  assert.equal(composeBroadcast(claimed({ url: null })).url, '/');
  assert.equal(composeBroadcast(claimed({ url: undefined })).url, '/');
  assert.equal(composeBroadcast(claimed({ url: '' })).url, '/');
  // And a url that IS there is passed through untouched: the /admin route is
  // what validates it as a same-origin path (migration-061 says so explicitly,
  // and deliberately does not use a check constraint), so rewriting it here
  // would put two opinions about url shapes in two places.
  assert.equal(composeBroadcast(claimed({ url: '/?deal=abc' })).url, '/?deal=abc');
});

test('no em dash reaches a student (the repo copy rule)', () => {
  // test/campaigns.test.js has the equivalent test for the campaign payloads and
  // test/reminders.test.js for every reminder tier. The rule governs the strings
  // the REPO ships, and a broadcast's words are typed by an operator at run
  // time — so what this pins is that the compose adds no em dash of its own:
  // no ' — WeRewards' suffix on the title, no ' — tap to open' glued to the
  // body. Those are exactly the decorations a later edit reaches for, and they
  // would put an em dash in front of every student at once.
  const p = composeBroadcast(claimed());
  assert.ok(!p.title.includes('—'), `em dash in title: ${p.title}`);
  assert.ok(!p.body.includes('—'), `em dash in body: ${p.body}`);
  // Including on the clipped path, which is where a joiner would hide: the
  // untruncated fixture above would not show one added only when a title is cut.
  const long = composeBroadcast(claimed({ title: 'Q'.repeat(300), body: 'W'.repeat(900) }));
  assert.ok(!long.title.includes('—') && !long.body.includes('—'));
});

test('a row with nothing to say composes nothing rather than a blank chirp', () => {
  // create_admin_broadcast raises TITLE_REQUIRED and BODY_REQUIRED so this
  // cannot come from the compose box, but it can come from a row written before
  // that function existed, or from a claim shape that changed under us. The
  // caller's contract is a payload or null — never a notification with an empty
  // title, which renders as a chirp from an app with nothing in it and is the
  // kind of notification people turn push off over. Push permission is one
  // switch for every feature at once, so this one costs deals and reminders too.
  assert.equal(composeBroadcast(null), null);
  assert.equal(composeBroadcast(undefined), null);
  assert.equal(composeBroadcast({}), null);
  assert.equal(composeBroadcast(claimed({ title: '' })), null);
  assert.equal(composeBroadcast(claimed({ body: '' })), null);
  // Whitespace is the realistic version of blank: btrim in SQL only ran on what
  // create_admin_broadcast was given, and ' ' is not '' to a `!title` check that
  // forgot to trim.
  assert.equal(composeBroadcast(claimed({ title: '   ' })), null);
  assert.equal(composeBroadcast(claimed({ body: '\n\t ' })), null);
});

/* ---------- no claim without a transport ---------- */

test('with push unconfigured the tick claims nothing and sends nothing', () => {
  // The test environment sets no VAPID keys (test/setup.js), which is also the
  // shape of a real deployment that never set them.
  //
  // "Does nothing" has to mean it never reaches the database, not merely that it
  // sends no push. claim_admin_broadcast_pushes SPENDS the shared cooldown and
  // both counts at claim time, so a tick that claimed and then found it had no
  // way to deliver would silence that student for four hours — deals, nearby
  // alerts and reminders included — over an announcement that was never going to
  // be sent. Both halves are asserted at once: the rpc stub catches the claim,
  // and the fetch counter catches every PostgREST read the claim would have led
  // to as well as the send itself.
  return (async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (...args) => { calls++; return realFetch(...args); };
    try {
      const { result, seen } = await withRpc(
        () => { throw new Error('the tick must not reach the database with nothing to deliver with'); },
        () => runBroadcastTick(),
      );
      assert.deepEqual(result, { claimed: 0, delivered: 0, failed: 0 });
      assert.equal(seen.length, 0, 'the tick spent a student’s budget with nothing configured');
      assert.equal(calls, 0, 'the tick talked to the network with nothing configured');
    } finally {
      globalThis.fetch = realFetch;
    }
  })();
});

test('the worker arms no timer when there is nothing to deliver with', () => {
  // Same reasoning one level up: an unconfigured deployment should not carry a
  // timer that wakes every thirty seconds to do nothing. Counting setInterval is
  // safe here precisely because broadcasts.js and its whole dependency graph are
  // already imported at the top of this file, so the refresh timers
  // src/lib/cache.js arms at module scope cannot be mistaken for this worker's
  // own. The companion test further down proves this counter is sensitive rather
  // than vacuous.
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const armed = [];
  globalThis.setInterval = (fn, ms) => { armed.push(ms); return { unref() {} }; };
  globalThis.clearInterval = () => {};
  try {
    startBroadcastWorker();
    // And stopping one that was never started has to stay safe to call, because
    // server.js calls it on every shutdown path regardless.
    stopBroadcastWorker();
    stopBroadcastWorker();
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
  assert.deepEqual(armed, [], 'an unconfigured deployment armed a broadcast loop anyway');
});

/* ---------- the configured half, in a child process ---------- */

const LIB = pathToFileURL(path.resolve('src/lib/broadcasts.js')).href;
const SUPABASE = pathToFileURL(path.resolve('src/lib/supabase.js')).href;
const CAMPAIGNS = pathToFileURL(path.resolve('src/lib/campaigns.js')).href;
const NOTIF_LOG = pathToFileURL(path.resolve('src/lib/notification-log.js')).href;

/**
 * A keypair web-push itself accepts. Generated locally (an ECDH P-256 pair out
 * of node:crypto — no network, no account, no push service), because
 * setVapidDetails validates the length and curve of both keys and would throw on
 * a made-up string. Same reason test/push.test.js and test/reminders.test.js
 * generate one.
 */
const KEYS = webpush.generateVAPIDKeys();

/**
 * Load src/lib/broadcasts.js in a child process with VAPID keys set, the claim
 * RPC scripted and every socket stubbed, then run `body` and print what it
 * returns as JSON.
 *
 * Why a child: see the file header — pushEnabled is import-time state.
 *
 * The rpc stub is installed on the supabaseAdmin OBJECT before broadcasts.js is
 * imported, which works for the same reason withRpc above works: the module
 * reads `supabaseAdmin.rpc` at call time rather than destructuring it at import.
 * The object itself is handed to the body too, so a test can make the client
 * throw the way a real one does.
 *
 * `env` overrides reach the child only, so a test can retune CAMPAIGN_* and
 * watch what the claim is handed without touching this process or any other test
 * file. The Supabase placeholders come from the parent's env, which test/setup.js
 * has already filled in — the parent could not have imported broadcasts.js at
 * all otherwise.
 */
function runConfigured(body, { rows = [], error = null, env = {}, rpcByName = null, delivering = false, logError = null } = {}) {
  const src = `
    // Any socket at all is a failure in most of these tests, but it must be
    // observable rather than a thrown ECONNREFUSED that reads as an unrelated
    // bug. '[]' is also what makes the non-empty claim tests work: it is a valid
    // PostgREST answer meaning "this student has no push endpoints", which is
    // precisely the delivery failure finish_admin_broadcast exists for.
    //
    // notification_log writes (migration-062) are captured into logRows, or
    // answered with a PostgREST error when logError is set.
    const fetches = [];
    const logRows = [];
    const LOG_ERROR = ${JSON.stringify(logError)};
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input?.url ?? input);
      fetches.push({
        url,
        method: String(init.method ?? input?.method ?? 'GET').toUpperCase(),
      });
      if (url.includes('/rest/v1/notification_log')) {
        for (const r of [].concat(init.body ? JSON.parse(init.body) : [])) logRows.push(r);
        if (LOG_ERROR) {
          return new Response(JSON.stringify(LOG_ERROR), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
      }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const { supabaseAdmin } = await import(${JSON.stringify(SUPABASE)});
    const seen = [];
    // rpcByName matters as soon as a test lets the claim return a student. The
    // flat form answers EVERY rpc with the same payload, which would hand
    // finish_admin_broadcast an array where it expects a boolean — so the
    // settlement would report failure and the test would pass for the wrong
    // reason. Named routing lets each function answer as itself; anything
    // unrouted gets an empty list.
    const BY_NAME = ${JSON.stringify(rpcByName)};
    // JSON cannot carry a getter, so a row that must THROW when read is written
    // in the fixture as a sentinel string and built here. This is the only way
    // to exercise the per-row try/catch, whose job is that one row failing to be
    // read costs one send rather than the remainder of the batch.
    const materialise = (d) => (Array.isArray(d)
      ? d.map((r) => (r === '__THROWING_ROW__'
        ? { get out_user_id() { throw new TypeError('unreadable claim row'); } }
        : r))
      : d);
    supabaseAdmin.rpc = async (name, params) => {
      seen.push({ name, params });
      if (BY_NAME) {
        const hit = Object.prototype.hasOwnProperty.call(BY_NAME, name) ? BY_NAME[name] : { data: [], error: null };
        return { data: materialise(hit.data ?? null), error: hit.error ?? null };
      }
      return { data: ${JSON.stringify(rows)}, error: ${JSON.stringify(error)} };
    };

    // The 'delivering' option makes a SUCCESSFUL send constructible, which the
    // fetch stub above cannot: it answers '[]' to everything, so
    // studentSubscriptions always
    // finds zero endpoints and every claim settles as a failure. Without this the
    // delivered branch is unreachable, and 'accepted > 0' in the lib could be
    // replaced by a literal 'true' without a single test noticing.
    //
    // Two stubs, both shapes test/push.test.js already uses: the query chain
    // studentSubscriptions walks (.from().select().eq().eq(), awaited), and
    // webpush.sendNotification replaced on the shared module object BEFORE the
    // tick runs -- push.js imports webpush at module scope but calls the method
    // at call time, so the swap takes effect.
    const sent = [];
    if (${JSON.stringify(delivering)}) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        then: (res) => res({ data: [{ endpoint: 'https://push.test/a', p256dh: 'p', auth: 'a' }], error: null }),
      };
      // The log write still goes through the real client (and so the fetch stub
      // above), so a delivered send's row can be asserted on.
      const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
      supabaseAdmin.from = (table) => (table === 'notification_log' ? realFrom(table) : chain);
      const webpush = (await import('web-push')).default;
      webpush.sendNotification = async (sub, b) => { sent.push({ endpoint: sub.endpoint, body: b }); return { statusCode: 201 }; };
    }

    const { CAMPAIGN_CONFIG } = await import(${JSON.stringify(CAMPAIGNS)});
    const broadcasts = await import(${JSON.stringify(LIB)});

    // Installed AFTER the import, so the periodic refreshes src/lib/cache.js
    // arms at module scope are not counted as this worker's loop.
    const armed = [];
    globalThis.setInterval = (fn, ms) => { armed.push(ms); return { unref() {} }; };
    globalThis.clearInterval = () => {};

    const { flushNotificationLog } = await import(${JSON.stringify(NOTIF_LOG)});
    const flush = () => flushNotificationLog();

    const out = await (${body})({ broadcasts, seen, fetches, armed, CAMPAIGN_CONFIG, supabaseAdmin, sent, logRows, flush, BY_NAME });
    console.log('__RESULT__' + JSON.stringify(out ?? null));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', src], {
    env: {
      ...process.env,
      VAPID_PUBLIC_KEY: KEYS.publicKey,
      VAPID_PRIVATE_KEY: KEYS.privateKey,
      // Set explicitly (to '' for "unset", which is what push.js's `||` fallback
      // reads) so a developer who happens to export one cannot change what is
      // under test.
      VAPID_SUBJECT: '',
      ...env,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `child produced no result. stdout:\n${stdout}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

test('the caps forwarded to the claim are CAMPAIGN_CONFIG’s own, not a second copy', () => {
  const out = runConfigured('async ({ broadcasts, seen, fetches }) => ({ result: await broadcasts.runBroadcastTick(), seen, fetches })');
  assert.deepEqual(out.result, { claimed: 0, delivered: 0, failed: 0 });
  assert.equal(out.seen.length, 1, 'a configured tick made no claim at all');
  assert.equal(out.seen[0].name, 'claim_admin_broadcast_pushes');
  const p = out.seen[0].params;

  // The six shared storm defences, compared against THIS process's
  // CAMPAIGN_CONFIG. Both processes read the same environment, so a developer who
  // has retuned one of these locally still gets a meaningful comparison.
  assert.equal(p.p_cooldown_minutes, CAMPAIGN_CONFIG.cooldownMinutes);
  assert.equal(p.p_daily_cap, CAMPAIGN_CONFIG.dailyCap);
  assert.equal(p.p_weekly_cap, CAMPAIGN_CONFIG.weeklyCap);
  assert.equal(p.p_quiet_start, CAMPAIGN_CONFIG.quietStart);
  assert.equal(p.p_quiet_end, CAMPAIGN_CONFIG.quietEnd);
  assert.equal(p.p_timezone, CAMPAIGN_CONFIG.timezone);

  // And this feature's own one, which is BROADCAST_CONFIG's because how fast the
  // queue drains is nobody else's business.
  assert.equal(p.p_max_users, BROADCAST_CONFIG.maxUsers);

  // p_skip_users has a default in SQL ('{}'), so a tick that passes nothing is
  // legal; a tick that passes something which is not a list of ids is not — that
  // is a 400 from PostgREST and a feature that never delivers anything.
  // Unconditional. This used to be wrapped in `if ('p_skip_users' in p)`, which
  // made it vacuous exactly when it mattered: deleting the forward from the lib
  // removed the key, skipped the assertion, and left the suite green. The lib
  // passes it on every call, so its absence is a failure, not a variant.
  assert.ok(Array.isArray(p.p_skip_users), 'the claim was called without a skip list');

  // A claim that came back empty must stop there rather than going on to read
  // subscriptions for nobody.
  assert.deepEqual(out.fetches, [], 'an empty claim still went on to query the database');
});

test('retuning the campaign caps moves the broadcast claim with them', () => {
  // THE test that tells a forward apart from a copy. The assertion above would
  // pass just as happily against six hard-coded numbers that happen to agree with
  // the defaults today; this one only passes if the values are read from
  // CAMPAIGN_CONFIG. The numbers are deliberately unlike the shipped defaults so
  // no coincidence can satisfy it.
  const out = runConfigured('async ({ broadcasts, seen, CAMPAIGN_CONFIG }) => { await broadcasts.runBroadcastTick(); return { seen, CAMPAIGN_CONFIG }; }', {
    env: {
      CAMPAIGN_COOLDOWN_MINUTES: '91',
      CAMPAIGN_DAILY_CAP: '7',
      CAMPAIGN_WEEKLY_CAP: '11',
      CAMPAIGN_QUIET_START: '1',
      CAMPAIGN_QUIET_END: '5',
      CAMPAIGN_TIMEZONE: 'America/Chicago',
      BROADCAST_MAX_USERS: '3',
    },
  });

  // The retune really did land in the child, so a failure below is a drifted copy
  // in broadcasts.js and not an env var the child never saw.
  assert.equal(out.CAMPAIGN_CONFIG.dailyCap, 7);

  const p = out.seen[0].params;
  assert.equal(p.p_cooldown_minutes, 91);
  assert.equal(p.p_daily_cap, 7);
  assert.equal(p.p_weekly_cap, 11);
  assert.equal(p.p_quiet_start, 1);
  assert.equal(p.p_quiet_end, 5);
  assert.equal(p.p_timezone, 'America/Chicago');
  // This feature's own knob is retunable too, and independently.
  assert.equal(p.p_max_users, 3);
});

test('every knob reads the env var its name implies', () => {
  // The value test at the top of this file pins the numbers but not the names, so
  // a knob wired to the wrong variable is invisible to it. REMINDER_NEAR_POINTS
  // against a key called nearCount is exactly that bug, found exactly this way:
  // an operator who sets the obvious variable and sees nothing change has no way
  // to tell which half is wrong. deepEqual rather than two field checks, because
  // it ALSO pins that this object has no third key — which is the same assertion
  // as "the throttle is not re-declared here", from the other side.
  const out = runConfigured('async ({ broadcasts }) => broadcasts.BROADCAST_CONFIG', {
    env: { BROADCAST_MAX_USERS: '7', BROADCAST_TICK_SECONDS: '90' },
  });
  assert.deepEqual(out, { maxUsers: 7, tickSeconds: 90 });
});

test('a missing migration is a quiet nothing, not a crash', () => {
  // What an unapplied migration-061 actually looks like: PostgREST cannot find the
  // function. The feature has to be silently off rather than taking the tick down,
  // because nothing downstream of it retries — and because this one ships with an
  // /admin tab that is visible whether or not the SQL was ever applied by hand.
  const out = runConfigured('async ({ broadcasts }) => broadcasts.runBroadcastTick()', {
    error: { message: 'Could not find the function public.claim_admin_broadcast_pushes' },
  });
  assert.deepEqual(out, { claimed: 0, delivered: 0, failed: 0 });
});

test('a configured deployment does arm the loop, so the no-op above is not vacuous', () => {
  // The companion to 'the worker arms no timer when there is nothing to deliver
  // with'. Without this, that test would pass against a startBroadcastWorker that
  // was broken in every configuration, which is the usual way a no-op assertion
  // rots. Starting twice must still arm once: a second timer would double every
  // claim, and two timers draining one queue is two students' slots spent per
  // recipient row.
  const out = runConfigured('async ({ broadcasts, armed }) => { broadcasts.startBroadcastWorker(); broadcasts.startBroadcastWorker(); broadcasts.stopBroadcastWorker(); return armed; }');
  assert.equal(out.length, 1, `expected exactly one broadcast loop, got ${out.length}`);
  assert.equal(out[0], BROADCAST_CONFIG.tickSeconds * 1000);
});

test('a mistyped tick interval cannot punch through the 10s floor', () => {
  // This cannot be folded into the test above, and test/reminders.test.js has the
  // scar to prove it: there, `out[0] >= 30_000` sat directly under
  // `out[0] === tickSeconds * 1000`, so with a default of 300 it could never fail
  // and the floor it claimed to pin was untested — deleting the Math.max left the
  // whole file green. Here the default IS 30, so the only input that can tell a
  // floor from an absent floor is a retuned one. A zero is the realistic typo
  // ('0' is what somebody types meaning "as fast as possible"), and it is the one
  // that turns a drain loop into a hot loop against a claim that takes a row lock
  // per student and runs three housekeeping updates before it even scans.
  //
  // TEN seconds, not the reminder worker's thirty, and the number is pinned
  // rather than written as `>= something` because the two are a pair: this
  // feature's intended cadence IS 30s, so a floor at 30 would mean the knob could
  // not be tuned downwards at all, and a floor at 10 is the deliberate room left
  // for that. If startBroadcastWorker's floor moves, this assertion is where the
  // decision gets re-made rather than silently absorbed.
  const out = runConfigured(
    'async ({ broadcasts, armed }) => { broadcasts.startBroadcastWorker(); return armed; }',
    { env: { BROADCAST_TICK_SECONDS: '0' } },
  );
  assert.deepEqual(out, [10_000], 'a 0-second interval was armed as-is');
});

/* ---------- the claim -> compose -> send -> settle loop ----------

   Everything above drives an EMPTY claim, which leaves the most consequential
   path in the module uncovered: what happens to a recipient row whose student's
   slot has already been spent. A tick that claims and never settles passes every
   configuration test in this file, logs nothing, throws nothing, and leaves one
   student silent for four hours with a row stuck at 'sending' until the
   ten-minute requeue sweep picks it up — so these two are the reason
   finish_admin_broadcast exists at all. */

// The claim hands back one recipient; finish answers as itself (a boolean, which
// is what the function returns). The fetch stub answers '[]' to everything, so
// studentSubscriptions finds no endpoints and the send accepts zero — which is
// exactly the shape of the failure this path exists for, and the commonest one
// in the real system: an endpoint is deleted the moment a browser is cleared,
// and the claim's own `exists` check on push_subscriptions can be stale by the
// time the send runs.
const ONE_CLAIMED = {
  rpcByName: {
    claim_admin_broadcast_pushes: {
      data: [{
        out_user_id: CLAIMED_USER,
        out_broadcast_id: CLAIMED_BROADCAST,
        out_title: 'Six new spots just joined',
        out_body: 'Four cafes and two sandwich places are giving points from today.',
        out_url: '/?spots=1',
      }],
    },
    finish_admin_broadcast: { data: true },
  },
};

test('a claimed recipient nobody could be reached for is settled, not left hanging', () => {
  // The claim SPENT this student's cooldown and both counters before anything was
  // sent, and it moved their recipient row to 'sending'. If the send lands nothing
  // and no settlement follows, that student is silenced for four hours — deal
  // alerts, nearby alerts and reminders included — for an announcement that never
  // existed, and the row sits in 'sending' holding their place in the queue.
  // finish_admin_broadcast with p_delivered false is the only thing that both
  // requeues the row and refunds the slot (migration-061, section 6).
  const out = runConfigured(
    'async ({ broadcasts, seen }) => ({ result: await broadcasts.runBroadcastTick(), seen })',
    ONE_CLAIMED,
  );

  assert.deepEqual(
    out.result,
    { claimed: 1, delivered: 0, failed: 1 },
    'the tick did not account for the recipient it claimed and failed to reach',
  );

  const finishes = out.seen.filter((c) => c.name === 'finish_admin_broadcast');
  assert.equal(finishes.length, 1,
    `expected exactly one settlement, saw ${JSON.stringify(out.seen.map((c) => c.name))}`);
  // deepEqual on the whole params object, not three field checks: the names are
  // the contract (migration-061 declares p_broadcast_id, p_user_id, p_delivered)
  // and a fourth argument or a renamed one is a PostgREST 404 that would leave
  // every recipient unsettled while the tick reported success.
  assert.deepEqual(
    finishes[0].params,
    { p_broadcast_id: CLAIMED_BROADCAST, p_user_id: CLAIMED_USER, p_delivered: false },
    'the settlement named the wrong recipient, or claimed a failed send was delivered',
  );
});

test('a claimed recipient whose send throws is still settled exactly once', () => {
  // The other half, and the one a per-student try/catch is for. Above, the send
  // merely found no endpoints; here the Supabase client itself throws on the way
  // to reading them, which is what a dead socket or a client bug looks like from
  // inside the loop (test/nearby.test.js models the same failure as 'a thrown
  // client'). studentSubscriptions does not catch it, so it lands in whatever
  // handler broadcasts.js put around this student's work.
  //
  // The claimed row must still be settled EXACTLY once: zero settlements is the
  // student silenced for four hours by a crash they will never see, and two is a
  // double refund — finish_admin_broadcast's greatest(count - 1, 0) makes that
  // safe arithmetically, but it would also requeue a row that is already queued
  // and quietly resend the announcement.
  const out = runConfigured(`async ({ broadcasts, seen, supabaseAdmin }) => {
    supabaseAdmin.from = () => { throw new Error('socket hang up'); };
    return { result: await broadcasts.runBroadcastTick(), seen };
  }`, ONE_CLAIMED);

  assert.deepEqual(
    out.result,
    { claimed: 1, delivered: 0, failed: 1 },
    'a thrown send was not accounted for as a failed delivery',
  );
  const finishes = out.seen.filter((c) => c.name === 'finish_admin_broadcast');
  assert.equal(finishes.length, 1, `expected exactly one settlement, saw ${finishes.length}`);
  assert.deepEqual(
    finishes[0].params,
    { p_broadcast_id: CLAIMED_BROADCAST, p_user_id: CLAIMED_USER, p_delivered: false },
  );
});

test('a claimed row with no ids is counted, not settled against null', () => {
  // The one row the "every claimed row is settled" invariant cannot hold for,
  // and it is in here so that the exception is a decision rather than a gap.
  // finish_admin_broadcast returns false for a null id either side
  // (migration-061, section 6, first line), so a settle here would be a round
  // trip that cannot work, a false "nothing to settle" line in the log, and a
  // recipient row recovered anyway by the claim's own ten-minute sweep. What
  // must still hold is the arithmetic: claimed === delivered + failed, or the
  // /admin counts the operator reads stop adding up and the first thing anyone
  // will suspect is the queue rather than the tick.
  const out = runConfigured(
    'async ({ broadcasts, seen }) => ({ result: await broadcasts.runBroadcastTick(), seen })',
    {
      rpcByName: {
        claim_admin_broadcast_pushes: {
          data: [{ out_user_id: null, out_broadcast_id: CLAIMED_BROADCAST, out_title: 'T', out_body: 'B', out_url: '/' }],
        },
        finish_admin_broadcast: { data: true },
      },
    },
  );
  assert.deepEqual(out.result, { claimed: 1, delivered: 0, failed: 1 });
  assert.deepEqual(
    out.seen.filter((c) => c.name === 'finish_admin_broadcast'),
    [],
    'a settle was attempted against a null id, which can only ever return false',
  );
});

/* ---------- the delivered path, and a batch with one bad row ----------

   Everything above settles as a FAILURE: the child's fetch stub answers '[]' to
   every query, so studentSubscriptions finds no endpoints and accepted is always
   zero. That left the two halves of the loop's contract uncovered, and both were
   mutation-verified as uncovered before these existed:

     • `accepted > 0` could be replaced with a literal `true` -- every settle
       would claim success -- and all 18 tests stayed green.
     • the per-row try/catch could be deleted outright, and they stayed green
       too, because no batch ever had a second row for a first bad one to harm. */

test('a delivered broadcast is settled as delivered, once, with the right ids', () => {
  const out = runConfigured(`async ({ broadcasts, seen, sent }) => ({
    result: await broadcasts.runBroadcastTick(),
    finishes: seen.filter((c) => c.name === 'finish_admin_broadcast').map((c) => c.params),
    sent,
  })`, { ...ONE_CLAIMED, delivering: true });

  assert.deepEqual(out.result, { claimed: 1, delivered: 1, failed: 0 });
  assert.equal(out.sent.length, 1, 'exactly one push for one claimed recipient');
  assert.equal(out.sent[0].endpoint, 'https://push.test/a');
  // The copy the claim returned, carried through compose to the wire. The claim
  // hands back the words precisely so there is no second read here.
  const payload = JSON.parse(out.sent[0].body);
  assert.equal(payload.title, 'Six new spots just joined');
  assert.equal(payload.tag, 'wr-broadcast');
  assert.equal(payload.url, '/?spots=1');
  // p_delivered TRUE is the half no previous test could reach.
  assert.deepEqual(out.finishes, [{
    p_broadcast_id: CLAIMED_BROADCAST,
    p_user_id: CLAIMED_USER,
    p_delivered: true,
  }]);
});

test('one unreadable row costs one send, not the rest of the batch', () => {
  // The per-row try/catch's whole stated job. The first row's id getter throws,
  // which is the earliest point in the body that CAN throw -- and the reason the
  // reads were moved inside the try. Before that fix this returned
  // {claimed:0,delivered:0,failed:0} with a single rpc call: row two's student
  // had their budget spent by the claim and was never settled at all.
  const GOOD_USER = '00000000-0000-4000-8000-0000000000bb';
  const out = runConfigured(`async ({ broadcasts, seen, sent }) => ({
    result: await broadcasts.runBroadcastTick(),
    finishes: seen.filter((c) => c.name === 'finish_admin_broadcast').map((c) => c.params),
    sent,
  })`, {
    delivering: true,
    rpcByName: {
      claim_admin_broadcast_pushes: {
        data: [
          // Row 1: reading out_user_id throws. JSON cannot express a getter, so
          // the fixture is built in the child by the hook below.
          '__THROWING_ROW__',
          {
            out_user_id: GOOD_USER,
            out_broadcast_id: CLAIMED_BROADCAST,
            out_title: 'Still goes out',
            out_body: 'The second row must be delivered even though the first could not be read.',
            out_url: '/',
          },
        ],
      },
      finish_admin_broadcast: { data: true },
    },
  });

  // Both rows accounted for: claimed === delivered + failed, always.
  assert.equal(out.result.claimed, 2, 'the batch size the claim returned');
  assert.equal(out.result.delivered + out.result.failed, out.result.claimed, 'a row went unaccounted for');
  assert.equal(out.result.delivered, 1, 'the good row should still have been delivered');
  assert.equal(out.result.failed, 1, 'the unreadable row should be counted as failed');
  // The good row was settled. The bad one cannot be (its ids are unreadable), so
  // the claim's ten-minute sweep recovers it -- that is why there is exactly one.
  assert.deepEqual(out.finishes, [{
    p_broadcast_id: CLAIMED_BROADCAST,
    p_user_id: GOOD_USER,
    p_delivered: true,
  }]);
});

test('a student just failed is kept out of the very next claim', () => {
  // THE QUEUE HALF of the failure path, and nothing else covers it. The only
  // assertion on p_skip_users elsewhere is Array.isArray, so replacing the whole
  // forward with a literal `[]` left the suite green -- mutation-verified.
  //
  // It matters more here than in reminders.js because this queue has a stable
  // ORDER. finish_admin_broadcast(false) nulls last_push_at to hand the budget
  // back, and migration-061's claim sorts `order by b.created_at, r2.user_id` --
  // so a student whose endpoint fails with a code push.js does not prune (it
  // deletes only on 401/403/404/410, so a 500, a dropped socket or a malformed
  // p256dh survives) is re-claimed on every single tick. At or above p_max_users
  // such students, they fill every batch for the whole 48-hour expiry window and
  // nobody else in the audience ever hears the broadcast, while the operator
  // watches sent_count sit below queued_count with no error anywhere.
  const out = runConfigured(`async ({ broadcasts, seen }) => {
    const first = await broadcasts.runBroadcastTick();
    const second = await broadcasts.runBroadcastTick();
    return {
      first,
      second,
      skips: seen.filter((c) => c.name === 'claim_admin_broadcast_pushes').map((c) => c.params.p_skip_users),
    };
  }`, ONE_CLAIMED);

  // Both ticks claimed (the fixture answers the same row every time), and both
  // failed to deliver, because without `delivering` there are no endpoints.
  assert.equal(out.first.failed, 1);
  assert.equal(out.skips.length, 2, 'expected one claim per tick');
  assert.deepEqual(out.skips[0], [], 'the first tick had nobody to skip yet');
  assert.deepEqual(
    out.skips[1],
    [CLAIMED_USER],
    'the second tick asked for the same student it had just failed to reach',
  );
});

test('a student who was reached is not carried in the skip list', () => {
  // The other direction: the backoff must be CLEARED on success, or one
  // transient failure would park a perfectly good student for the whole window.
  const out = runConfigured(`async ({ broadcasts, seen }) => {
    await broadcasts.runBroadcastTick();
    await broadcasts.runBroadcastTick();
    return { skips: seen.filter((c) => c.name === 'claim_admin_broadcast_pushes').map((c) => c.params.p_skip_users) };
  }`, { ...ONE_CLAIMED, delivering: true });

  assert.deepEqual(out.skips[0], []);
  assert.deepEqual(out.skips[1], [], 'a delivered student was treated as a failure');
});

/* ---------- the notification log, worker status and backoff (migration-062) ----------

   Contract 3.3: one log row per claimed recipient, written after the settle and
   without changing it. Plus broadcastWorkerStatus() and broadcastBackoff(),
   which /admin reads and which never steer the worker. */

const TICK_AND_LOG = `async ({ broadcasts, seen, logRows, flush }) => {
  const result = await broadcasts.runBroadcastTick();
  await flush();
  return {
    result,
    rows: logRows,
    finishes: seen.filter((c) => c.name === 'finish_admin_broadcast').map((c) => c.params),
  };
}`;

test('a delivered broadcast is logged once, as sent, with the dedupe key the backfill uses', () => {
  const out = runConfigured(TICK_AND_LOG, { ...ONE_CLAIMED, delivering: true });
  assert.deepEqual(out.result, { claimed: 1, delivered: 1, failed: 0 });
  assert.deepEqual(out.finishes, [{ p_broadcast_id: CLAIMED_BROADCAST, p_user_id: CLAIMED_USER, p_delivered: true }]);

  assert.equal(out.rows.length, 1, `expected one log row, got ${JSON.stringify(out.rows)}`);
  const r = out.rows[0];
  assert.equal(r.channel, 'push');
  assert.equal(r.kind, 'broadcast');
  assert.equal(r.outcome, 'sent');
  assert.equal(r.reason, null);
  assert.equal(r.recipient_kind, 'student');
  assert.equal(r.student_id, CLAIMED_USER);
  assert.equal(r.title, 'Six new spots just joined');
  assert.equal(r.url, '/?spots=1');
  assert.equal(r.template, 'wr-broadcast');
  assert.deepEqual(r.ref, { broadcastId: CLAIMED_BROADCAST });
  assert.equal(r.dedupe_key, `broadcast:${CLAIMED_BROADCAST}:${CLAIMED_USER}`);
  assert.equal(r.devices_tried, 1);
  assert.equal(r.devices_accepted, 1);
  assert.ok(!JSON.stringify(r).includes('push.test'), 'the endpoint reached the log row');
});

test('a broadcast nobody could receive is logged as failed and refunded, with no dedupe key', () => {
  const out = runConfigured(TICK_AND_LOG, ONE_CLAIMED);
  assert.deepEqual(out.result, { claimed: 1, delivered: 0, failed: 1 });
  assert.deepEqual(out.finishes, [{ p_broadcast_id: CLAIMED_BROADCAST, p_user_id: CLAIMED_USER, p_delivered: false }]);
  assert.equal(out.rows.length, 1);
  const r = out.rows[0];
  assert.equal(r.outcome, 'failed');
  assert.equal(r.reason, 'no_devices');
  assert.deepEqual(r.ref, { broadcastId: CLAIMED_BROADCAST, refunded: true });
  assert.equal(r.dedupe_key, null);
});

test('refunded reports what finish_admin_broadcast did, not what was asked', () => {
  const out = runConfigured(TICK_AND_LOG, {
    rpcByName: { ...ONE_CLAIMED.rpcByName, finish_admin_broadcast: { data: false } },
  });
  assert.equal(out.rows[0].outcome, 'failed');
  assert.equal(out.rows[0].ref.refunded, false);
});

test('a row with no words is logged as refused, content_empty, and still settled once', () => {
  const out = runConfigured(TICK_AND_LOG, {
    rpcByName: {
      claim_admin_broadcast_pushes: {
        data: [{ out_user_id: CLAIMED_USER, out_broadcast_id: CLAIMED_BROADCAST, out_title: '   ', out_body: 'B', out_url: '/' }],
      },
      finish_admin_broadcast: { data: true },
    },
  });
  assert.deepEqual(out.result, { claimed: 1, delivered: 0, failed: 1 });
  assert.deepEqual(out.finishes, [{ p_broadcast_id: CLAIMED_BROADCAST, p_user_id: CLAIMED_USER, p_delivered: false }]);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].outcome, 'refused');
  assert.equal(out.rows[0].reason, 'content_empty');
  assert.equal(out.rows[0].ref.refunded, true);
});

test('a thrown send is logged as send_error', () => {
  const out = runConfigured(`async ({ broadcasts, supabaseAdmin, logRows, flush }) => {
    const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
    supabaseAdmin.from = (t) => { if (t === 'notification_log') return realFrom(t); throw new Error('socket hang up'); };
    const result = await broadcasts.runBroadcastTick();
    await flush();
    return { result, rows: logRows };
  }`, ONE_CLAIMED);
  assert.deepEqual(out.result, { claimed: 1, delivered: 0, failed: 1 });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].reason, 'send_error');
});

test('a missing notification_log table does not change a single settlement', () => {
  const out = runConfigured(TICK_AND_LOG, {
    ...ONE_CLAIMED,
    delivering: true,
    logError: { code: '42P01', message: 'relation "public.notification_log" does not exist' },
  });
  assert.deepEqual(out.result, { claimed: 1, delivered: 1, failed: 0 });
  assert.deepEqual(out.finishes, [{ p_broadcast_id: CLAIMED_BROADCAST, p_user_id: CLAIMED_USER, p_delivered: true }]);
});

test('worker status records each tick, and rpcMissing follows the claim', () => {
  const out = runConfigured(`async ({ broadcasts, BY_NAME, flush }) => {
    const before = broadcasts.broadcastWorkerStatus();
    const r1 = await broadcasts.runBroadcastTick();
    const afterOk = broadcasts.broadcastWorkerStatus();
    BY_NAME.claim_admin_broadcast_pushes = { data: null, error: { code: '42P01', message: 'relation "public.admin_broadcast_recipients" does not exist' } };
    const r2 = await broadcasts.runBroadcastTick();
    const afterMissing = broadcasts.broadcastWorkerStatus();
    BY_NAME.claim_admin_broadcast_pushes = { data: [] };
    await broadcasts.runBroadcastTick();
    const afterRecovered = broadcasts.broadcastWorkerStatus();
    broadcasts.startBroadcastWorker();
    const armed = broadcasts.broadcastWorkerStatus();
    broadcasts.stopBroadcastWorker();
    await flush();
    return { before, r1, afterOk, r2, afterMissing, afterRecovered, armed };
  }`, ONE_CLAIMED);

  assert.equal(out.before.configured, true);
  assert.equal(out.before.running, false);
  assert.equal(out.before.ticks, 0);
  assert.equal(out.before.intervalSeconds, BROADCAST_CONFIG.tickSeconds);

  assert.equal(out.afterOk.ticks, 1);
  assert.deepEqual(out.afterOk.lastResult, out.r1);
  assert.equal(out.afterOk.rpcMissing, false);

  assert.deepEqual(out.r2, { claimed: 0, delivered: 0, failed: 0 });
  assert.equal(out.afterMissing.rpcMissing, true);
  assert.match(out.afterMissing.lastError, /admin_broadcast_recipients/);
  assert.equal(out.afterMissing.lastTickAt, out.afterOk.lastTickAt, 'a failed tick moved lastTickAt');

  assert.equal(out.afterRecovered.rpcMissing, false);
  assert.equal(out.afterRecovered.ticks, 3);
  assert.equal(out.armed.running, true);
});

test('broadcastBackoff names the student just failed and when they come back', () => {
  const out = runConfigured(`async ({ broadcasts, flush }) => {
    const before = broadcasts.broadcastBackoff();
    const t0 = Date.now();
    await broadcasts.runBroadcastTick();
    await flush();
    return { before, after: broadcasts.broadcastBackoff(), t0 };
  }`, ONE_CLAIMED);
  assert.deepEqual(out.before, []);
  assert.equal(out.after.length, 1);
  assert.equal(out.after[0].userId, CLAIMED_USER);
  const until = Date.parse(out.after[0].until);
  const twoHours = 2 * 60 * 60 * 1000;
  assert.ok(until >= out.t0 + twoHours && until <= out.t0 + twoHours + 60_000, `until ${out.after[0].until} is not two hours out`);
});
