// Verify POSTHOG_API_KEY / POSTHOG_HOST against the live API before trusting
// analytics to it.
//
//   npm run check:posthog          # config, then send one real test event
//   npm run check:posthog -- --dry # config and payload only, send nothing
//
// It also answers the question that decides whether SESSION REPLAY works, and
// that no amount of reading this repo can settle: whether replay is switched on
// in the PostHog PROJECT. Both halves have to be true — the browser has to ship
// the recorder (POSTHOG_API_KEY here, plus POSTHOG_SESSION_REPLAY not turned
// off) and the project has to accept recordings. Get the second one wrong and
// the app looks perfect from the outside: posthog-js loads, reports itself
// healthy, and records nothing.
//
// Worth running for the same reason scripts/check-resend.js is: a misconfigured
// key fails INVISIBLY. src/lib/posthog.js never throws, nothing 500s, no student
// sees an error — the events simply stop arriving, and you find out weeks later
// when a funnel is empty.
//
// It also pins down the one thing that could not be settled from the docs. The
// published batch example lives in a lazily-loaded block that this repo's
// fetcher could not read, so the wire format in src/lib/posthog.js sends
// distinct_id BOTH at the event top level and inside properties — accepted under
// either reading of the API. This script proves the whole envelope against the
// real endpoint, which is worth more than the doc page would have been.

import 'dotenv/config';
import {
  posthogEnabled, batchUrl, toPostHogEvent, capture, flushPostHog, posthogStats,
  sessionReplayEnabled, posthogUiHost, fetchReplayConfig,
} from '../src/lib/posthog.js';

let failed = false;

function fail(msg, hint) {
  failed = true;
  console.error(`\n  FAIL  ${msg}`);
  if (hint) console.error(`        ${hint}`);
}

function ok(msg) {
  console.log(`  ok    ${msg}`);
}

function warn(msg, hint) {
  console.log(`  warn  ${msg}`);
  if (hint) console.log(`        ${hint}`);
}

/**
 * The two mistakes worth naming separately. A personal API key (phx_/phs_) in
 * place of the project key looks plausible and is rejected forever; and a US key
 * pointed at the EU host (or the reverse) is the single most common PostHog
 * setup failure, because both hosts resolve, both accept the POST shape, and
 * only the project lookup fails.
 */
function checkKey() {
  const key = process.env.POSTHOG_API_KEY ?? '';
  if (/^ph[xs]_/.test(key)) {
    fail('POSTHOG_API_KEY looks like a PERSONAL api key, not a project key',
         'Ingestion needs the "Project API Key" (phc_...) from Settings -> Project, not a phx_/phs_ key.');
    return;
  }
  if (!/^phc_/.test(key)) {
    warn(`POSTHOG_API_KEY does not start with phc_ (it starts "${key.slice(0, 4)}...")`,
         'Project keys are phc_ prefixed. If PostHog has since changed that, ignore this.');
    return;
  }
  ok('POSTHOG_API_KEY looks like a project key');
}

function checkHost() {
  const raw = process.env.POSTHOG_HOST;
  const url = batchUrl();
  if (!raw) {
    warn(`POSTHOG_HOST is unset, defaulting to ${url}`,
         'That is US cloud. An EU project MUST set POSTHOG_HOST=https://eu.i.posthog.com or every event is rejected.');
    return;
  }
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') {
      fail(`POSTHOG_HOST is not https: ${raw}`, 'Ingestion carries a project key; do not send it in the clear.');
      return;
    }
  } catch {
    fail(`POSTHOG_HOST is not a URL: ${raw}`, 'Expected e.g. https://eu.i.posthog.com');
    return;
  }
  if (/app\.posthog\.com/.test(raw)) {
    warn(`POSTHOG_HOST points at ${raw}`,
         'app.posthog.com is the dashboard. The ingestion hosts are us.i.posthog.com / eu.i.posthog.com.');
  }
  ok(`Events will POST to ${url}`);
}

/**
 * Resolve the project token against the region it is configured for.
 *
 * This is the check that actually catches a wrong key or a wrong region, and it
 * has to be a SEPARATE request from the test event below. /batch/ enqueues
 * first and validates the token later, out of band, so it answers
 * 200 {"status":"Ok"} to any phc_-shaped string on either cloud — a fabricated
 * key posted to the wrong region passes it cleanly. Everything behind that 200
 * is then discarded during ingestion, which is the exact invisible failure this
 * script exists to prevent.
 *
 * /decide/ resolves the token synchronously: 200 for a real project on this
 * region, 401 otherwise. On a 401 the counterpart region is probed too, because
 * "the key is fine, the host is wrong" is the most common PostHog setup failure
 * and it is worth naming outright instead of making the reader guess which half
 * is broken.
 */
async function verifyProjectToken() {
  const key = process.env.POSTHOG_API_KEY ?? '';
  const origin = new URL(batchUrl()).origin;

  const resolves = async (host) => {
    try {
      const res = await fetch(`${host}/decide/?v=3`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, distinct_id: 'anon:check-posthog' }),
        signal: AbortSignal.timeout(10_000),
      });
      return res.status;
    } catch {
      return null;   // a network problem, not an answer about the key
    }
  };

  const status = await resolves(origin);
  if (status === 200) {
    ok(`The project key resolves to a real project on ${origin}`);
    return;
  }
  if (status === null) {
    warn(`Could not reach ${origin} to resolve the project key`,
         'Skipping the key/region check — the send below will report the network problem.');
    return;
  }
  if (status !== 401) {
    warn(`Resolving the project key returned HTTP ${status}`,
         'Not a clean yes or no. If the send below succeeds, confirm in PostHog -> Activity.');
    return;
  }

  // 401: this host does not know this key. Say whether the other one does.
  const other = origin.includes('//eu.') ? 'https://us.i.posthog.com' : 'https://eu.i.posthog.com';
  if (await resolves(other) === 200) {
    fail(`The project key is valid, but it belongs to ${other} — not ${origin}`,
         `Set POSTHOG_HOST=${other} in .env and on the deployed app. The wrong region still answers 200 and then drops the events.`);
    return;
  }
  fail(`${origin} rejected the project key (401)`,
       'Neither region recognises it. Re-copy the "Project API Key" from PostHog -> Settings -> Project.');
}

/**
 * Is session replay actually going to produce anything?
 *
 * Two independent switches, and only one of them lives in this repo:
 *
 *   • THIS DEPLOYMENT ships the recorder — POSTHOG_API_KEY set, and
 *     POSTHOG_SESSION_REPLAY not turned off. That is sessionReplayEnabled, and
 *     it is what decides whether server.js stamps the <meta> tags onto the app
 *     shells at all.
 *   • THE PROJECT accepts recordings — a setting in PostHog that nothing here
 *     can see from the outside.
 *
 * The second is read from the remote config posthog-js itself fetches at boot
 * (/array/<token>/config on the assets host). It is the same answer the browser
 * gets, which is what makes it worth asking: "sessionRecording": false there
 * means every student's browser will load the SDK, start up cleanly, report no
 * error anywhere, and record nothing.
 *
 * Also surfaced are the three project settings that silently DISCARD
 * recordings after the fact rather than refusing to make them — a sample rate
 * below 1, a minimum duration, and a URL blocklist. Each one produces the same
 * symptom (a replay list emptier than it should be) and none produces an error.
 */
async function checkSessionReplay() {
  console.log('\nSession replay\n');

  if (!sessionReplayEnabled) {
    warn('This deployment will NOT ship the recorder',
         'POSTHOG_SESSION_REPLAY is set to a falsey value. Unset it to record; the server-side event mirror above is unaffected either way.');
  } else {
    ok('This deployment ships the recorder to /, /terminal and /join');
  }

  // Self-hosted returns one origin (it serves its own /array), cloud returns
  // the ingestion host plus its -assets sibling, which is where the config is.
  // The same call the server makes at boot and the browser makes at init —
  // one implementation, so this script can never check a different URL from
  // the one that actually decides whether recording starts.
  const res = await fetchReplayConfig({ timeoutMs: 10_000 });
  if (!res.ok) {
    if (res.reason === 'http') {
      return warn(`Could not read the project's remote config (HTTP ${res.status})`,
                  'Skipping the project-side replay check. If the key check above passed, this is probably transient.');
    }
    return warn(`Could not reach ${res.host} to read the project's replay setting`,
                'Skipping the project-side check. Note the browser fetches this same URL, so if it is genuinely unreachable, replay will not start there either.');
  }

  const rec = res.sessionRecording;
  if (!rec) {
    return fail('Session replay is switched OFF in the PostHog project',
                `Turn it on at ${posthogUiHost()} -> Settings -> Project -> Session Replay. Until then every browser loads the recorder, reports no error, and records nothing.`);
  }
  ok('Session replay is switched ON in the PostHog project');

  // The settings that drop recordings quietly, after they have been made.
  if (rec.sampleRate != null && Number(rec.sampleRate) < 1) {
    warn(`The project samples replay at ${rec.sampleRate}`,
         `Only ~${Math.round(Number(rec.sampleRate) * 100)}% of sessions are kept. A missing recording is expected, not a bug.`);
  }
  if (rec.minimumDurationMilliseconds) {
    warn(`The project discards sessions shorter than ${rec.minimumDurationMilliseconds}ms`,
         'Short visits — the bounce you most wanted to watch — will not appear.');
  }
  if (Array.isArray(rec.urlBlocklist) && rec.urlBlocklist.length) {
    warn(`The project blocks recording on ${rec.urlBlocklist.length} URL pattern(s)`,
         'Check none of them covers / , /terminal or /join.');
  }
  if (Array.isArray(rec.urlTriggers) && rec.urlTriggers.length) {
    warn(`The project only records after matching ${rec.urlTriggers.length} URL trigger(s)`,
         'Sessions that never hit one are not recorded at all.');
  }
  if (rec.linkedFlag) {
    warn(`Recording is gated on the feature flag "${typeof rec.linkedFlag === 'string' ? rec.linkedFlag : rec.linkedFlag.flag}"`,
         'Only sessions where that flag is enabled get recorded.');
  }

  // What we send with them. Stated rather than assumed, because it is the half
  // a privacy question will be asked about.
  console.log('  ---   masking: all inputs (posthog.init wins over the project setting),');
  console.log('        plus any element carrying data-ph-mask. No request headers, no request bodies.');
  console.log(`  ---   replays land at ${posthogUiHost()}/replay — filter by the person id`);
  console.log('        (the Supabase user id) or by the "app" property: student / vendor / join.');
}

/** Show the exact bytes an event turns into, so a shape problem is visible. */
function showPayload() {
  const sample = toPostHogEvent({
    source: 'student',
    event: 'check_posthog',
    trigger: 'cli',
    props: { note: 'sent by npm run check:posthog' },
    userId: null,
    userAgent: 'check-posthog/1.0',
    path: '/',
  }, '2026-01-01T00:00:00.000Z');
  console.log('\nOne event on the wire (anonymous, so no person profile is created):\n');
  console.log(JSON.stringify({ api_key: 'phc_...', batch: [sample] }, null, 2)
    .split('\n').map((l) => '    ' + l).join('\n'));
}

/**
 * Send one real event through the real code path, so the envelope this repo
 * builds is exercised end to end rather than described.
 *
 * Note what this step can and cannot tell you: /batch/ returns 200 before the
 * token is validated, so a 200 here means "accepted for ingestion", NOT "the key
 * and region are right". verifyProjectToken() above is what establishes that.
 * Both together are the proof; neither is on its own.
 */
async function sendTestEvent() {
  capture({
    source: 'admin',
    event: 'check_posthog',
    trigger: 'cli',
    props: { note: 'sent by npm run check:posthog' },
    // Deliberately anonymous: this must not invent a person in the project, and
    // must not attach itself to a real student's profile.
    userId: null,
    userAgent: 'check-posthog/1.0',
    path: '/scripts/check-posthog.js',
  });

  const res = await flushPostHog();
  if (res.ok && res.sent > 0) {
    ok(`PostHog accepted ${res.sent} event`);
    console.log('\nLook for an event named "check_posthog" in PostHog -> Activity.');
    console.log('Ingestion is not instant; give it up to a minute before concluding it failed.');
    return;
  }

  if (res.reason === 'http' && res.status === 401) {
    return fail('The project key was rejected (401)',
                'Wrong key, or the right key on the wrong region. Check POSTHOG_HOST against the project.');
  }
  if (res.reason === 'http') {
    return fail(`PostHog refused the batch (HTTP ${res.status})`,
                'A 4xx is a payload or key problem, not a blip — it will fail identically forever. The payload above is what was sent.');
  }
  if (res.reason === 'timeout' || res.reason === 'network') {
    const { queued } = posthogStats();
    return fail(`Could not reach ${batchUrl()} (${res.reason})`,
                `The event was re-queued (${queued} pending), which is what the server would do too. Check the host and your network.`);
  }
  fail(`Unexpected result: ${JSON.stringify(res)}`);
}

/* ---------- run ---------- */

console.log('\nPostHog configuration\n');

if (!posthogEnabled) {
  fail('PostHog forwarding is OFF',
       'Set POSTHOG_API_KEY. Without it src/lib/posthog.js is inert — client_events still records everything, but nothing reaches PostHog.');
  console.log('\nTo turn it on:');
  console.log('  1. Create a project at https://posthog.com (or your self-hosted instance).');
  console.log('  2. Settings -> Project -> Project API Key (phc_...).');
  console.log('  3. Put it in .env as POSTHOG_API_KEY, and set POSTHOG_HOST if you are on EU.');
  console.log('  4. Re-run: npm run check:posthog');
  console.log('');
  console.log('That key also turns on SESSION REPLAY in the browser (see');
  console.log('public/shared/analytics.js). Replay additionally has to be enabled in the');
  console.log('PostHog project itself — this script checks that once a key is set.');
} else {
  ok('POSTHOG_API_KEY is set');
  checkKey();
  checkHost();
  await verifyProjectToken();
  await checkSessionReplay();
  showPayload();

  if (process.argv.includes('--dry')) {
    console.log('\n  (--dry: nothing was sent. Drop the flag to post a real test event.)');
  } else {
    console.log('');
    await sendTestEvent();
  }
}

console.log(failed ? '\nFAILED\n' : '\nOK\n');
// Set the code rather than calling process.exit(): exiting while the fetch
// handles are still unwinding trips a libuv assertion on Windows
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"), which prints a
// scary crash after a perfectly good report AND replaces the exit code with 9 —
// so a PASSING check reads as a failing one. Same note, same reason, as
// scripts/check-gemini.js and scripts/check-resend.js.
process.exitCode = failed ? 1 : 0;
