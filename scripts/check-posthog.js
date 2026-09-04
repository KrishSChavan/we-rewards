// Verify POSTHOG_API_KEY / POSTHOG_HOST against the live API before trusting
// analytics to it.
//
//   npm run check:posthog          # config, then send one real test event
//   npm run check:posthog -- --dry # config and payload only, send nothing
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
} else {
  ok('POSTHOG_API_KEY is set');
  checkKey();
  checkHost();
  await verifyProjectToken();
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
