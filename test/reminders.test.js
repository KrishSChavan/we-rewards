// The "come back and spend what you already have" reminder (src/lib/reminders.js).
//
// Thin where the database does the thinking and thick where this module does.
// Every rule about whether a student MAY be interrupted lives in
// claim_reminder_pushes under a FOR UPDATE SKIP LOCKED row lock (migration-060)
// and is asserted against a real Postgres in test/sql/behavior-060.sql. What is
// left on this side is the half that decides WHAT a student is told, plus the
// seam between the two — and that seam carries three properties that are easy
// to break and almost impossible to notice in production:
//
//   1. THE SHARED BUDGET, at the JS boundary. student_notify_state is one row
//      per student and it is the storm budget for all three notification
//      features. migration-060's caps only mean anything if the numbers
//      actually forwarded are CAMPAIGN_CONFIG's live values. A second copy of
//      those six numbers would not fail visibly: it would quietly hand
//      reminders a quota of their own the first time an operator retuned
//      CAMPAIGN_DAILY_CAP and nothing in here moved with it, and the symptom
//      would be a student hearing from us twice as often as the Privacy Policy
//      (§7.4) promises. test/nearby.test.js pins this for the nearby claim;
//      the same property is pinned here, and then pinned again under a retune,
//      because only the retune can tell a forward apart from a copy that
//      happens to agree today.
//
//   2. NO CLAIM WITHOUT A TRANSPORT. The claim SPENDS the cooldown and both
//      counts before anything is delivered — it has to, or two workers both get
//      a slot. So a tick that could not possibly deliver must never reach the
//      database: claiming there would silence a student for four hours, deals
//      and nearby alerts included, over a notification that was never going to
//      be sent. test/campaigns.test.js asserts this shape for the campaign
//      worker; this file asserts it for reminders in both directions at once
//      (zero RPCs AND zero sockets).
//
//   3. THE CASCADE ALWAYS HAS SOMETHING TRUE TO SAY. A reminder that fires with
//      nothing in it is the kind of notification people turn off permanently,
//      and push permission is one switch for every feature at once. pickReminder
//      is pure, so the whole ranking can be driven from literals here.
//
// WHY HALF OF THIS RUNS IN A CHILD PROCESS. pushEnabled is import-time state in
// src/lib/push.js (VAPID keys are read at module scope), and ESM gives importers
// a read-only binding, so it cannot be flipped in-process — and a cache-busted
// re-import of reminders.js would still resolve './push.js' to the instance
// already in the registry. test/push.test.js hit this first and the pattern
// below is its runWithKeys, narrowed to this module. The alternative was to
// weaken property 1 to "the params object mentions CAMPAIGN_CONFIG somewhere",
// which is not a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import webpush from 'web-push';
import {
  REMINDER_CONFIG, pickReminder, composeReminder,
  runReminderTick, startReminderWorker, stopReminderWorker,
} from '../src/lib/reminders.js';
import { CAMPAIGN_CONFIG } from '../src/lib/campaigns.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

/** A catalogue vendor in the shape buildContext hands pickReminder. */
const vendor = (name, balance, rewards = []) => ({ vendorId: `v-${name}`, name, balance, rewards });
/** A points reward. cost_in_points null would mean a punch card instead. */
const reward = (title, cost) => ({ title, cost_in_points: cost });
/** One live, unopened deal, as liveDealsFor assembles them. */
const deal = (title, over = {}) => ({ dealId: `d-${title}`, title, vendorName: 'Taco Bar', ...over });

/** Swap supabaseAdmin.rpc for the duration of one call and capture its args. */
async function withRpc(impl, fn) {
  const original = supabaseAdmin.rpc;
  const seen = [];
  supabaseAdmin.rpc = async (name, params) => { seen.push({ name, params }); return impl(name, params); };
  try { return { result: await fn(), seen }; }
  finally { supabaseAdmin.rpc = original; }
}

/* ---------- the knobs this feature owns ---------- */

test('the cadence knobs ship with the values the owner asked for', () => {
  // 72h is "about twice a week" expressed as a floor rather than a schedule, so
  // a student the shared budget kept quiet becomes due again on the next tick
  // instead of losing their turn. The other three are load, not policy.
  assert.equal(REMINDER_CONFIG.minIntervalHours, 72);
  assert.equal(REMINDER_CONFIG.maxUsers, 20);
  assert.equal(REMINDER_CONFIG.tickSeconds, 300);
  assert.equal(REMINDER_CONFIG.nearCount, 25);
});

test('the throttle is not re-declared here, and that absence is the feature', () => {
  // The single most important assertion in this file. These six belong to
  // CAMPAIGN_CONFIG and are read from there at call time. A copy in this object
  // would give reminders a quota of their own, which is the exact storm
  // migration-032 was written to prevent, with the house's own name on it.
  for (const own of ['cooldownMinutes', 'dailyCap', 'weeklyCap', 'quietStart', 'quietEnd', 'timezone']) {
    assert.ok(!(own in REMINDER_CONFIG),
      `REMINDER_CONFIG.${own} is a second copy of a shared storm defence — forward CAMPAIGN_CONFIG.${own} instead`);
  }
});

/* ---------- the cascade: priority ---------- */

test('tier 1 wins: a reward they can already afford beats everything below it', () => {
  // Nothing beats it because it is the only tier where the student has to do
  // nothing but walk in.
  const c = pickReminder({
    vendors: [
      vendor('Nearly', 60, [reward('Free coffee', 80)]),   // tier 2 material
      vendor('Blue Bird', 120, [reward('Free bagel', 80)]),
    ],
    deals: [deal('Half price tacos')],
    unvisited: [{ vendorId: 'v9', name: 'Lemont Cafe' }],
  });
  assert.equal(c.kind, 'afford');
  assert.equal(c.vendorName, 'Blue Bird');
  assert.equal(c.rewardTitle, 'Free bagel');
  // The BALANCE, not the cost: the sentence is about what they are holding.
  assert.equal(c.points, 120);
  assert.equal(c.url, '/?spot=v-Blue%20Bird');
});

test('tier 2 beats a vendor’s deal, because a shortfall is about their own money', () => {
  const c = pickReminder({
    vendors: [vendor('Blue Bird', 60, [reward('Free coffee', 80)])],
    deals: [deal('Half price tacos')],
    unvisited: [{ vendorId: 'v9', name: 'Lemont Cafe' }],
  });
  assert.equal(c.kind, 'close');
  assert.equal(c.shortfall, 20);
  assert.equal(c.points, 60);
  assert.equal(c.vendorName, 'Blue Bird');
});

test('tier 3 beats a spot they have never tried', () => {
  const c = pickReminder({
    deals: [deal('Half price tacos')],
    unvisited: [{ vendorId: 'v9', name: 'Lemont Cafe' }],
  });
  assert.equal(c.kind, 'deal');
  assert.equal(c.dealTitle, 'Half price tacos');
  assert.equal(c.vendorName, 'Taco Bar');
  // The deep link the student app already understands.
  assert.equal(c.url, '/?deal=d-Half%20price%20tacos');
  // A deal with no id still opens the list rather than dropping the tier.
  assert.equal(pickReminder({ deals: [{ title: 'Half price tacos' }] }).url, '/?deals=1');
});

test('tier 4 beats the generic tier, and takes the list’s first entry', () => {
  // unvisitedFor hands these over already ranked by campus visits, so [0] is
  // the most popular place this student has never walked into.
  const c = pickReminder({ unvisited: [{ vendorId: 'v9', name: 'Lemont Cafe' }, { vendorId: 'v8', name: 'Second' }] });
  assert.equal(c.kind, 'discover');
  assert.equal(c.vendorName, 'Lemont Cafe');
  assert.equal(c.url, '/?spot=v9');
});

test('the cascade never returns null, whatever it is handed', () => {
  // Tier 5 is always available, which is the only reason runReminderTick never
  // has to handle "claimed a student's budget and then had nothing to say".
  for (const ctx of [
    undefined, null, {}, { vendors: [], deals: [], unvisited: [] },
    { vendors: null, deals: null, unvisited: null },
    { vendors: [{}], deals: [{}], unvisited: [{}] },
    // A vendor we cannot name, and a balance we cannot read: both must drop out
    // rather than produce a sentence about nobody.
    { vendors: [vendor('', 100, [reward('Free coffee', 10)])] },
    { vendors: [vendor('Blue Bird', Number.NaN, [reward('Free coffee', 10)])] },
  ]) {
    const c = pickReminder(ctx);
    assert.ok(c, `pickReminder returned ${c} for ${JSON.stringify(ctx)}`);
    assert.equal(c.kind, 'generic');
    assert.equal(c.url, '/');
  }
});

test('what is not a points reward never becomes a candidate', () => {
  // cost_in_points null means the reward is bought with VISITS (migration-029):
  // points can never afford it and a points shortfall is meaningless for it.
  // Zero is the same guard for bad data — a zero-cost reward would make every
  // student in the catalogue able to "afford something" and turn this feature
  // into a nightly broadcast about nothing. An inactive reward would send them
  // in for something the counter will refuse.
  for (const r of [
    { title: 'Punch card', cost_in_points: null },
    { title: 'Free', cost_in_points: 0 },
    { title: 'Negative', cost_in_points: -10 },
    { title: 'Switched off', cost_in_points: 10, active: false },
    { title: '', cost_in_points: 10 },
  ]) {
    assert.equal(pickReminder({ vendors: [vendor('Blue Bird', 500, [r])] }).kind, 'generic',
      `${JSON.stringify(r)} was treated as a points reward`);
  }
});

/* ---------- the cascade: ranking inside a tier ---------- */

test('the most expensive affordable reward wins, not the first or the cheapest', () => {
  // Naming the cheapest would undersell a balance they worked for.
  const c = pickReminder({
    vendors: [
      vendor('Cheap Spot', 500, [reward('Small coffee', 10)]),
      vendor('Big Spot', 500, [reward('Mid plate', 100), reward('Whole dinner', 400)]),
    ],
  });
  assert.equal(c.kind, 'afford');
  assert.equal(c.rewardTitle, 'Whole dinner');
  assert.equal(c.vendorName, 'Big Spot');
});

test('the smallest shortfall wins, and only shortfalls inside nearCount qualify', () => {
  const c = pickReminder({ vendors: [vendor('Blue Bird', 50, [reward('Far', 74), reward('Near', 60)])] });
  assert.equal(c.kind, 'close');
  assert.equal(c.rewardTitle, 'Near');
  assert.equal(c.shortfall, 10);

  // The boundary is inclusive: exactly nearCount short still counts as close.
  assert.equal(pickReminder({ vendors: [vendor('B', 50, [reward('Edge', 75)])] }).shortfall, 25);
  // One past it is not "nearly there" and must not be claimed as such.
  assert.equal(pickReminder({ vendors: [vendor('B', 50, [reward('Edge', 76)])] }).kind, 'generic');
  // And the threshold is overridable, so the boundary is a knob and not a
  // constant baked into the ranking.
  assert.equal(pickReminder({ vendors: [vendor('B', 50, [reward('Edge', 76)])], nearCount: 26 }).shortfall, 26);
});

test('equal inputs rank identically on every run', () => {
  // The tie-breaks are code-unit order, deliberately NOT localeCompare, whose
  // answer depends on the ICU data the Node build happens to carry: a tie
  // broken with it can come out one way on a laptop and the other on the dyno.
  // Two spots, same reward, same price is exactly the input a test reaches for,
  // so it is the input that has to be stable.
  const ctx = {
    vendors: [
      vendor('Zed Cafe', 100, [reward('Tie', 50)]),
      vendor('Abe Cafe', 100, [reward('Tie', 50)]),
    ],
  };
  const first = pickReminder(ctx);
  assert.equal(first.vendorName, 'Abe Cafe');
  for (let i = 0; i < 5; i++) assert.deepEqual(pickReminder(ctx), first);

  // The fixture above is stable but it does NOT pin the stated rationale:
  // 'Abe Cafe' beats 'Zed Cafe' under code-unit order AND under localeCompare,
  // so swapping byName for localeCompare left it green. This pair diverges.
  // Code units put 'Zed Cafe' first ('Z' is 0x5A, 'a' is 0x61); localeCompare
  // is case-insensitive at the primary level and puts 'abe cafe' first. Pinning
  // the code-unit answer is what makes the comment above true.
  const caseSplit = {
    vendors: [
      vendor('abe cafe', 100, [reward('Tie', 50)]),
      vendor('Zed Cafe', 100, [reward('Tie', 50)]),
    ],
  };
  assert.equal(
    pickReminder(caseSplit).vendorName,
    'Zed Cafe',
    'ties are being broken by locale collation, which differs with the ICU data a Node build carries',
  );

  // Same reward, same vendor, same price: the reward title is the last resort.
  const sameSpot = { vendors: [vendor('One Cafe', 100, [reward('Zulu', 50), reward('Alpha', 50)])] };
  assert.equal(pickReminder(sameSpot).rewardTitle, 'Alpha');
  assert.deepEqual(pickReminder(sameSpot), pickReminder(sameSpot));
});

test('the deal named is the one expiring soonest', () => {
  // Urgency is the only thing distinguishing two offers we did not write. The
  // dates are compared as epoch ms, not as strings: Postgres returns timestamptz
  // as '…+00:00' while toISOString() produces '…Z', so a lexicographic compare
  // of the two is wrong in a way that only shows up at certain times of day.
  const c = pickReminder({
    deals: [
      deal('Later', { dealId: 'late', expiresAt: '2030-01-02T00:00:00Z' }),
      deal('Sooner', { dealId: 'soon', expiresAt: '2030-01-01T00:00:00+00:00' }),
    ],
  });
  assert.equal(c.dealTitle, 'Sooner');

  // An unparseable date sorts last rather than winning by accident, so one bad
  // row cannot capture the tier.
  assert.equal(pickReminder({
    deals: [deal('Broken', { expiresAt: 'not a date' }), deal('Real', { expiresAt: '2030-06-01T00:00:00Z' })],
  }).dealTitle, 'Real');
});

/* ---------- the copy a student actually sees ---------- */

/** One composed payload per shipped tier, paired with the tier that produced it. */
const EVERY_TIER = [
  ['afford', { vendors: [vendor('Blue Bird', 120, [reward('Free coffee', 80)])] }],
  ['close', { vendors: [vendor('Blue Bird', 60, [reward('Free coffee', 80)])] }],
  ['deal', { deals: [deal('Half price tacos')] }],
  ['discover', { unvisited: [{ vendorId: 'v9', name: 'Lemont Cafe' }] }],
  ['generic', {}],
];

// Built lazily, and the fixtures are checked inside a TEST rather than here.
// At module scope one cascade regression throws during import, and node:test
// then reports "0 pass / 1 fail" with no test names at all — losing the signal
// from every other property in the file at the moment one of them broke.
const everyTier = () => EVERY_TIER.map(([kind, ctx]) => {
  const candidate = pickReminder(ctx);
  return { kind, candidate, payload: composeReminder(candidate) };
});

test('each tier’s fixture still reaches the tier it is named for', () => {
  for (const { kind, candidate } of everyTier()) {
    assert.equal(candidate.kind, kind, `the fixture for ${kind} no longer reaches that tier`);
  }
});

test('every tier carries the reminder’s own collapse tag', () => {
  // Same tag = replace, not append, so nothing can stack in the shade even if
  // the server-side throttle were bypassed. A tag of its OWN rather than
  // 'wr-deals', so a reminder never silently swallows a vendor's live deal,
  // which is the message the student would rather have had.
  for (const { kind, payload } of everyTier()) {
    assert.equal(payload.tag, 'wr-reminder', `tier ${kind} carried the wrong tag`);
  }
});

test('no em dashes reach a student from any tier (the repo copy rule)', () => {
  // test/campaigns.test.js has the equivalent test for the campaign payloads.
  // This is the same rule applied to the copy THIS module owns, which is every
  // title and the fixed words of every body.
  for (const { kind, payload } of everyTier()) {
    assert.ok(!payload.title.includes('—'), `em dash in the ${kind} title: ${payload.title}`);
    assert.ok(!payload.body.includes('—'), `em dash in the ${kind} body: ${payload.body}`);
  }
  // Including the fallback arm, which is what a tier added later without a
  // switch case of its own renders as.
  const future = composeReminder({ kind: 'some-tier-added-later', url: '/' });
  assert.ok(!future.title.includes('—') && !future.body.includes('—'));
});

test('every tier fits the lengths a notification actually shows', () => {
  // The same discipline composeNotification uses in campaigns.js, for the same
  // reason: the OS truncates both anyway, so the only question is whether the
  // cut is ours and lands on a word.
  for (const { kind, payload } of everyTier()) {
    assert.ok(payload.title.length <= 60, `${kind} title was ${payload.title.length} chars`);
    assert.ok(payload.body.length <= 140, `${kind} body was ${payload.body.length} chars`);
    assert.ok(payload.title.length > 0 && payload.body.length > 0, `tier ${kind} composed an empty payload`);
  }

  // And vendor-typed text cannot burst the body, because vendors type reward
  // titles themselves and nothing upstream caps them.
  const long = composeReminder({
    kind: 'close', shortfall: 5, points: 10,
    rewardTitle: 'Q'.repeat(300), vendorName: 'W'.repeat(300), url: '/',
  });
  assert.ok(long.body.length <= 140, `body was ${long.body.length} chars`);
  assert.ok(long.body.endsWith('…'));
});

test('a tier with nothing in it composes nothing rather than a blank chirp', () => {
  assert.equal(composeReminder(null), null);
  assert.equal(composeReminder(undefined), null);
  assert.equal(composeReminder({}), null);
});

test('each tier says something different, so a missed switch case is visible', () => {
  // A tier added later that forgets its own `case` falls through to the generic
  // arm and renders as "There is more on WeRewards" — correct, but silent about
  // the mistake. Distinct titles are what make that visible in one glance.
  const titles = everyTier().map((t) => t.payload.title);
  assert.equal(new Set(titles).size, titles.length, `two tiers share a title: ${titles.join(' / ')}`);
});

/* ---------- no claim without a transport ---------- */

test('with push unconfigured the tick claims nothing and sends nothing', () => {
  // The test environment sets no VAPID keys (test/setup.js), which is also the
  // shape of a real deployment that never set them.
  //
  // "Does nothing" has to mean it never reaches the database, not merely that it
  // sends no push. claim_reminder_pushes SPENDS the shared cooldown and both
  // counts at claim time, so a tick that claimed and then found it had no way to
  // deliver would silence that student for four hours — deals and nearby alerts
  // included — over a message that was never going to be sent. Both halves are
  // asserted at once: the rpc stub catches the claim, and the fetch counter
  // catches every PostgREST read the claim would have led to as well as the send
  // itself.
  return (async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (...args) => { calls++; return realFetch(...args); };
    try {
      const { result, seen } = await withRpc(
        () => { throw new Error('the tick must not reach the database with nothing to deliver with'); },
        () => runReminderTick(),
      );
      assert.deepEqual(result, { claimed: 0, delivered: 0, refunded: 0 });
      assert.equal(seen.length, 0, 'the tick spent a student’s budget with nothing configured');
      assert.equal(calls, 0, 'the tick talked to the network with nothing configured');
    } finally {
      globalThis.fetch = realFetch;
    }
  })();
});

test('the worker arms no timer when there is nothing to deliver with', () => {
  // Same reasoning one level up: an unconfigured deployment should not carry a
  // timer that wakes every five minutes to do nothing. Counting setInterval is
  // safe here precisely because reminders.js and its whole dependency graph are
  // already imported at the top of this file, so the refresh timers src/lib/cache.js
  // arms at module scope cannot be mistaken for this worker's own. The companion
  // test below proves this counter is sensitive rather than vacuous.
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const armed = [];
  globalThis.setInterval = (fn, ms) => { armed.push(ms); return { unref() {} }; };
  globalThis.clearInterval = () => {};
  try {
    startReminderWorker();
    // And stopping one that was never started has to stay safe to call, because
    // server.js calls it on every shutdown path regardless.
    stopReminderWorker();
    stopReminderWorker();
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
  assert.deepEqual(armed, [], 'an unconfigured deployment armed a reminder loop anyway');
});

/* ---------- the configured half, in a child process ---------- */

const LIB = pathToFileURL(path.resolve('src/lib/reminders.js')).href;
const SUPABASE = pathToFileURL(path.resolve('src/lib/supabase.js')).href;
const CAMPAIGNS = pathToFileURL(path.resolve('src/lib/campaigns.js')).href;

/**
 * A keypair web-push itself accepts. Generated locally (an ECDH P-256 pair out
 * of node:crypto — no network, no account, no push service), because
 * setVapidDetails validates the length and curve of both keys and would throw
 * on a made-up string. Same reason test/push.test.js generates one.
 */
const KEYS = webpush.generateVAPIDKeys();

/**
 * Load src/lib/reminders.js in a child process with VAPID keys set, the claim
 * RPC scripted and every socket stubbed, then run `body` and print what it
 * returns as JSON.
 *
 * Why a child: see the file header — pushEnabled is import-time state.
 *
 * The rpc stub is installed on the supabaseAdmin OBJECT before reminders.js is
 * imported, which works for the same reason withRpc above works: the module
 * reads `supabaseAdmin.rpc` at call time rather than destructuring it at import.
 *
 * `env` overrides reach the child only, so a test can retune CAMPAIGN_* and
 * watch what the claim is handed without touching this process or any other
 * test file. The Supabase placeholders come from the parent's env, which
 * test/setup.js has already filled in — the parent could not have imported
 * reminders.js at all otherwise.
 */
function runConfigured(body, { rows = [], error = null, env = {}, rpcByName = null } = {}) {
  const src = `
    // Any socket at all is a failure in these tests, but it must be observable
    // rather than a thrown ECONNREFUSED that reads as an unrelated bug.
    const fetches = [];
    globalThis.fetch = async (input, init = {}) => {
      fetches.push({
        url: String(input?.url ?? input),
        method: String(init.method ?? input?.method ?? 'GET').toUpperCase(),
      });
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const { supabaseAdmin } = await import(${JSON.stringify(SUPABASE)});
    const seen = [];
    // rpcByName matters as soon as a test lets the claim return a student. The
    // flat form answers EVERY rpc with the same payload, which would hand
    // refund_reminder_push an array where it expects true — so refundReminder
    // would report failure and the test would pass for the wrong reason. Named
    // routing lets each function answer as itself; anything unrouted gets an
    // empty list, which is what the reads inside buildContext expect.
    const BY_NAME = ${JSON.stringify(rpcByName)};
    supabaseAdmin.rpc = async (name, params) => {
      seen.push({ name, params });
      if (BY_NAME) {
        const hit = Object.prototype.hasOwnProperty.call(BY_NAME, name) ? BY_NAME[name] : { data: [], error: null };
        return { data: hit.data ?? null, error: hit.error ?? null };
      }
      return { data: ${JSON.stringify(rows)}, error: ${JSON.stringify(error)} };
    };

    const { CAMPAIGN_CONFIG } = await import(${JSON.stringify(CAMPAIGNS)});
    const reminders = await import(${JSON.stringify(LIB)});

    // Installed AFTER the import, so the periodic refreshes src/lib/cache.js
    // arms at module scope are not counted as this worker's loop.
    const armed = [];
    globalThis.setInterval = (fn, ms) => { armed.push(ms); return { unref() {} }; };
    globalThis.clearInterval = () => {};

    const out = await (${body})({ reminders, seen, fetches, armed, CAMPAIGN_CONFIG });
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
  const out = runConfigured('async ({ reminders, seen, fetches }) => ({ result: await reminders.runReminderTick(), seen, fetches })');
  assert.deepEqual(out.result, { claimed: 0, delivered: 0, refunded: 0 });
  assert.equal(out.seen.length, 1, 'a configured tick made no claim at all');
  assert.equal(out.seen[0].name, 'claim_reminder_pushes');
  const p = out.seen[0].params;

  // The six shared storm defences, compared against THIS process's
  // CAMPAIGN_CONFIG. Both processes read the same environment, so a developer
  // who has retuned one of these locally still gets a meaningful comparison.
  assert.equal(p.p_cooldown_minutes, CAMPAIGN_CONFIG.cooldownMinutes);
  assert.equal(p.p_daily_cap, CAMPAIGN_CONFIG.dailyCap);
  assert.equal(p.p_weekly_cap, CAMPAIGN_CONFIG.weeklyCap);
  assert.equal(p.p_quiet_start, CAMPAIGN_CONFIG.quietStart);
  assert.equal(p.p_quiet_end, CAMPAIGN_CONFIG.quietEnd);
  assert.equal(p.p_timezone, CAMPAIGN_CONFIG.timezone);

  // And this feature's own two, which are REMINDER_CONFIG's because they are
  // nobody else's business.
  assert.equal(p.p_max_users, REMINDER_CONFIG.maxUsers);
  assert.equal(p.p_min_interval_hours, REMINDER_CONFIG.minIntervalHours);

  // Students already looking at the app are excluded: the chirp achieves
  // nothing and spending their shared quota to send it is actively harmful.
  // Empty here because no socket server is attached in a child.
  assert.ok(Array.isArray(p.p_skip_users));

  // A claim that came back empty must stop there rather than going on to read
  // catalogues and purses for nobody.
  assert.deepEqual(out.fetches, [], 'an empty claim still went on to query the database');
});

test('retuning the campaign caps moves the reminder claim with them', () => {
  // THE test that tells a forward apart from a copy. The assertion above would
  // pass just as happily against six hard-coded numbers that happen to agree
  // with the defaults today; this one only passes if the values are read from
  // CAMPAIGN_CONFIG. The numbers are deliberately unlike the shipped defaults so
  // no coincidence can satisfy it.
  const out = runConfigured('async ({ reminders, seen, CAMPAIGN_CONFIG }) => { await reminders.runReminderTick(); return { seen, CAMPAIGN_CONFIG }; }', {
    env: {
      CAMPAIGN_COOLDOWN_MINUTES: '91',
      CAMPAIGN_DAILY_CAP: '7',
      CAMPAIGN_WEEKLY_CAP: '11',
      CAMPAIGN_QUIET_START: '1',
      CAMPAIGN_QUIET_END: '5',
      CAMPAIGN_TIMEZONE: 'America/Chicago',
      REMINDER_MIN_INTERVAL_HOURS: '48',
      REMINDER_MAX_USERS: '3',
    },
  });

  // The retune really did land in the child, so a failure below is a drifted
  // copy in reminders.js and not an env var the child never saw.
  assert.equal(out.CAMPAIGN_CONFIG.dailyCap, 7);

  const p = out.seen[0].params;
  assert.equal(p.p_cooldown_minutes, 91);
  assert.equal(p.p_daily_cap, 7);
  assert.equal(p.p_weekly_cap, 11);
  assert.equal(p.p_quiet_start, 1);
  assert.equal(p.p_quiet_end, 5);
  assert.equal(p.p_timezone, 'America/Chicago');
  // This feature's own knobs are retunable too, and independently.
  assert.equal(p.p_min_interval_hours, 48);
  assert.equal(p.p_max_users, 3);
});

test('a missing migration is a quiet nothing, not a crash', () => {
  // What an unapplied migration-060 actually looks like: PostgREST cannot find
  // the function. The feature has to be silently off rather than taking the tick
  // down, because nothing downstream of it retries.
  const out = runConfigured('async ({ reminders }) => reminders.runReminderTick()', {
    error: { message: 'Could not find the function public.claim_reminder_pushes' },
  });
  assert.deepEqual(out, { claimed: 0, delivered: 0, refunded: 0 });
});

test('a configured deployment does arm the loop, so the no-op above is not vacuous', () => {
  // The companion to 'the worker arms no timer when there is nothing to deliver
  // with'. Without this, that test would pass against a startReminderWorker that
  // was broken in every configuration, which is the usual way a no-op assertion
  // rots. Starting twice must still arm once: a second timer would double every
  // claim.
  const out = runConfigured('async ({ reminders, armed }) => { reminders.startReminderWorker(); reminders.startReminderWorker(); reminders.stopReminderWorker(); return armed; }');
  assert.equal(out.length, 1, `expected exactly one reminder loop, got ${out.length}`);
  // Five minutes, and never faster than the 30s floor a mistyped
  // REMINDER_TICK_SECONDS would otherwise punch through.
  assert.equal(out[0], REMINDER_CONFIG.tickSeconds * 1000);
});

test('a mistyped tick interval cannot punch through the 30s floor', () => {
  // The assertion that used to live above this was `out[0] >= 30_000`, directly
  // under `out[0] === tickSeconds * 1000` — which is 300000 by default, so it
  // could never fail and the floor it claimed to pin was untested. Deleting
  // Math.max(..., 30) from startReminderWorker left the whole file green.
  // A zero is the realistic typo, and it is the one that turns a three-day
  // cadence into a hot loop against a claim that takes a row lock per student.
  const out = runConfigured(
    'async ({ reminders, armed }) => { reminders.startReminderWorker(); return armed; }',
    { env: { REMINDER_TICK_SECONDS: '0' } },
  );
  assert.deepEqual(out, [30_000], 'a 0-second interval was armed as-is');
});

/* ---------- the claim -> compose -> send -> refund loop ----------

   Everything above drives an EMPTY claim, which leaves the most consequential
   path in the module uncovered: what happens to a student whose slot has
   already been spent. Both of these were mutation-verified against a sandbox
   copy — before they existed, deleting the refund call site and replacing the
   tick's return value with ZERO each left all 24 tests green. */

const CLAIMED_ID = '00000000-0000-4000-8000-000000000001';

// The claim hands back one student; the refund answers as itself. Everything
// buildContext reaches answers empty, so the cascade lands on its generic tier
// and there are no push endpoints to accept anything — which is exactly the
// shape of the failure this path exists for.
const ONE_CLAIMED = {
  rpcByName: {
    claim_reminder_pushes: { data: [{ out_user_id: CLAIMED_ID }] },
    refund_reminder_push: { data: true },
  },
};

test('a claimed student nobody could be reached for is refunded, not left silenced', () => {
  // The claim SPENT this student's cooldown and both counters before anything
  // was sent. If the send lands nothing and no refund follows, that student is
  // silenced for four hours — deal alerts and nearby alerts included — for a
  // notification that never existed. The refund is the only thing standing
  // between a transport failure and a budget quietly consumed.
  const out = runConfigured(
    'async ({ reminders, seen }) => ({ result: await reminders.runReminderTick(), seen })',
    ONE_CLAIMED,
  );

  assert.deepEqual(
    out.result,
    { claimed: 1, delivered: 0, refunded: 1 },
    'the tick did not account for the student it claimed and failed to reach',
  );

  const refunds = out.seen.filter((c) => c.name === 'refund_reminder_push');
  assert.equal(refunds.length, 1, `expected exactly one refund, saw ${JSON.stringify(out.seen.map((c) => c.name))}`);
  assert.deepEqual(refunds[0].params, { p_user_id: CLAIMED_ID }, 'the refund named the wrong student');
});

test('a student just failed is kept out of the very next claim', () => {
  // THE QUEUE HALF of the same problem, and it is not covered by the refund.
  // refund_reminder_push nulls last_reminder_at to give the budget back, and the
  // claim orders candidates `nulls first` — so a refund also returns that
  // student to the HEAD of the queue. For a transient failure that is right. For
  // an endpoint failing with a code push.js does not prune (it deletes only on
  // 401/403/404/410, so a 500, a dropped socket or a malformed p256dh survives)
  // it is a loop: claimed, failed, refunded, re-claimed on the next tick,
  // forever, holding a slot. migration-060's own p_skip_users comment asks the
  // caller to release it, which is what recentlyFailed does.
  //
  // This also pins the p_skip_users FORWARD itself. The only assertion on that
  // argument used to be Array.isArray, so replacing `visibleUserIds()` with a
  // literal `[]` left the file green; here the second claim has to carry a
  // specific id that could only have come from the first tick's failure.
  const out = runConfigured(`async ({ reminders, seen }) => {
    const first = await reminders.runReminderTick();
    const second = await reminders.runReminderTick();
    return { first, second, claims: seen.filter((c) => c.name === 'claim_reminder_pushes').map((c) => c.params.p_skip_users) };
  }`, ONE_CLAIMED);

  assert.equal(out.claims.length, 2, 'expected two claims, one per tick');
  assert.deepEqual(out.claims[0], [], 'the first tick had nobody to skip yet');
  assert.deepEqual(
    out.claims[1],
    [CLAIMED_ID],
    'the second tick re-claimed the student it had just failed to reach',
  );
});

test('“you are nearly there” is never said to a student with nothing', () => {
  // The cascade's worst failure mode, and it would have hit EVERY new signup.
  // buildContext maps the WHOLE catalogue and purses.of() is 0 for a spot the
  // student has never earned at, so without a balance gate one vendor anywhere
  // on campus with a reward costing <= nearCount makes every zero-balance
  // student a permanent tier-2 candidate. Worse, tier 2 outranks tier 3, so it
  // would suppress a real live deal in order to say it.
  const ctx = {
    vendors: [vendor('Cafe Lemont', 0, [reward('Free cookie', REMINDER_CONFIG.nearCount)])],
    deals: [deal('2 for 1 subs')],
  };
  const candidate = pickReminder(ctx);
  assert.notEqual(candidate.kind, 'close', 'a shortfall was measured against a balance of zero');
  assert.equal(candidate.kind, 'deal', 'the live deal should have won once close was out');

  // One point is a stake; zero is a price list. The boundary is the whole rule.
  const withAPoint = pickReminder({
    vendors: [vendor('Cafe Lemont', 1, [reward('Free cookie', REMINDER_CONFIG.nearCount + 1)])],
    deals: [deal('2 for 1 subs')],
  });
  assert.equal(withAPoint.kind, 'close', 'a student who has actually earned something is nearly there');
});

test('every knob reads the env var its name implies', () => {
  // nearCount read REMINDER_NEAR_POINTS while its three siblings each matched
  // their key, and the value test above pins the number but not the name — so
  // the mismatch was invisible. An operator who sets the obvious variable and
  // sees nothing change has no way to tell which half is wrong.
  const out = runConfigured('async ({ reminders }) => reminders.REMINDER_CONFIG', {
    env: {
      REMINDER_MIN_INTERVAL_HOURS: '48',
      REMINDER_MAX_USERS: '7',
      REMINDER_TICK_SECONDS: '90',
      REMINDER_NEAR_COUNT: '11',
    },
  });
  assert.deepEqual(out, { minIntervalHours: 48, maxUsers: 7, tickSeconds: 90, nearCount: 11 });
});
