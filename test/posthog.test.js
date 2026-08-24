// Unit tests for the PostHog forwarder (src/lib/posthog.js).
//
// No POSTHOG_API_KEY is set in the test environment, so `posthogEnabled` is
// false and capture() short-circuits before touching a queue — which is itself
// the first thing worth asserting: a checkout with no keys must never reach out,
// and must never throw at a caller who is on a request path.
//
// What is covered here is the logic that has no second chance to be right:
//   • $process_person_profile, which decides whether an anonymous visitor mints
//     a person in PostHog. Getting it wrong corrupts every person-based metric
//     in the project, and does so silently and irreversibly.
//   • the retry split — a 5xx must be kept and a 4xx must be dropped. Retrying a
//     rejected payload forever is how a best-effort mirror becomes an outage.
//   • the queue ceiling, which is the only thing standing between an unreachable
//     analytics vendor and an out-of-memory dyno.
//
// The queue/flush half needs the module loaded WITH a key, and `posthogEnabled`
// is read at import time. Rather than set a key globally (which would have every
// other test in the suite quietly enqueueing events, and an unref'd timer trying
// to post them to the real us.i.posthog.com), those cases run in a child process
// with the env set and globalThis.fetch stubbed. See runWithKey below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  posthogEnabled, capture, flushPostHog, toPostHogEvent, batchUrl,
} from '../src/lib/posthog.js';

const LIB = pathToFileURL(path.resolve('src/lib/posthog.js')).href;

/**
 * Load src/lib/posthog.js in a child process with POSTHOG_API_KEY set and fetch
 * replaced by a stub, then run `body` and print whatever it returns as JSON.
 * The stub records every request and answers with `status`.
 */
function runWithKey(body, { status = 200, host = 'https://ph.test' } = {}) {
  const src = `
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), ct: init.headers['Content-Type'] });
      if (${status} === 0) throw Object.assign(new Error('boom'), { name: 'TypeError' });
      return { ok: ${status} >= 200 && ${status} < 300, status: ${status} };
    };
    const ph = await import(${JSON.stringify(LIB)});
    const out = await (${body})(ph, calls);
    console.log('__RESULT__' + JSON.stringify(out));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', src], {
    env: { ...process.env, POSTHOG_API_KEY: 'phc_test', POSTHOG_HOST: host },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `child produced no result. stdout:\n${stdout}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

/* ---------- the config gate ---------- */

test('with no key configured the forwarder is off and never reaches the network', async () => {
  assert.equal(posthogEnabled, false, 'the test env must not carry a real POSTHOG_API_KEY');
  // Synchronous and false, rather than throwing or queueing: every caller is
  // mid-request, and none may fail because analytics is unconfigured.
  assert.equal(capture({ source: 'student', event: 'pwa_launched' }), false);
  assert.deepEqual(await flushPostHog(), { ok: false, sent: 0, reason: 'disabled' });
});

test('the host defaults to US cloud and tolerates a trailing slash', () => {
  assert.equal(batchUrl(), 'https://us.i.posthog.com/batch/');
  const withSlash = runWithKey('async (ph) => ph.batchUrl()', { host: 'https://eu.i.posthog.com/' });
  assert.equal(withSlash, 'https://eu.i.posthog.com/batch/', 'a trailing slash must not produce //batch/');
});

/* ---------- the payload ---------- */

test('a signed-in event is attributed to the user and processes a person', () => {
  const e = toPostHogEvent({
    source: 'student', event: 'install_accepted', userId: 'user-123',
    path: '/', userAgent: 'UA', props: { a: 1 },
  }, '2026-01-01T00:00:00.000Z');

  assert.equal(e.event, 'install_accepted');
  assert.equal(e.distinct_id, 'user-123');
  // Both placements. PostHog accepts either and different libraries send
  // different ones; sending both is unambiguous under either reading.
  assert.equal(e.properties.distinct_id, 'user-123');
  assert.equal(e.properties.$process_person_profile, true);
  assert.equal(e.properties.source, 'student');
  assert.equal(e.properties.$current_url, '/');
  assert.equal(e.properties.$raw_user_agent, 'UA', 'without this PostHog shows no device breakdown at all');
  assert.equal(e.properties.a, 1, 'caller props must survive');
  assert.equal(e.timestamp, '2026-01-01T00:00:00.000Z');
});

test('an anonymous event is recorded WITHOUT minting a person', () => {
  const e = toPostHogEvent({ source: 'student', event: 'pwa_launched' }, '2026-01-01T00:00:00.000Z');
  assert.equal(e.distinct_id, 'anon:student');
  // The whole point. Bucketing every signed-out visitor under one shared id
  // would invent a single hyperactive "user" and corrupt person counts, so the
  // event is sent with person processing off instead.
  assert.equal(e.properties.$process_person_profile, false);
});

test('caller props cannot switch person processing back on', () => {
  // A props key is attacker-ish only in the loosest sense — but /api/client-event
  // accepts a caller-supplied `props` object, so this is reachable from outside.
  const e = toPostHogEvent({
    source: 'student', event: 'pwa_launched',
    props: { $process_person_profile: true, distinct_id: 'somebody-else' },
  });
  assert.equal(e.properties.$process_person_profile, false, 'props must not be able to mint junk people');
  assert.equal(e.distinct_id, 'anon:student', 'the top-level id is ours, not the caller\'s');
  // The one inside properties matters just as much: PostHog will read either,
  // so leaving this overridable would let an unauthenticated post hang an
  // invented event off a real student's profile.
  assert.equal(e.properties.distinct_id, 'anon:student', 'props must not be able to re-attribute the event');
});

test('distinct_id is truncated to PostHog\'s 200-character limit', () => {
  const long = 'u'.repeat(500);
  const e = toPostHogEvent({ source: 'student', event: 'x', userId: long });
  // PostHog truncates server-side anyway. Doing it here means the id we send is
  // the id we logged, so a long value cannot quietly become a second person.
  assert.equal(e.distinct_id.length, 200);
  assert.equal(e.properties.distinct_id.length, 200);
});

test('a missing event name degrades rather than throwing', () => {
  const e = toPostHogEvent({});
  assert.equal(e.event, 'unknown');
  assert.equal(e.distinct_id, 'anon:unknown');
});

/* ---------- the queue and the wire ---------- */

test('events are batched into one POST with api_key at the top level', () => {
  const out = runWithKey(`async (ph, calls) => {
    ph.capture({ source: 'student', event: 'a', userId: 'u1' });
    ph.capture({ source: 'vendor',  event: 'b' });
    const res = await ph.flushPostHog();
    return { res, calls };
  }`);

  assert.deepEqual(out.res, { ok: true, sent: 2 });
  assert.equal(out.calls.length, 1, 'two events must cost ONE request, not two');
  assert.equal(out.calls[0].url, 'https://ph.test/batch/');
  assert.equal(out.calls[0].ct, 'application/json');
  assert.equal(out.calls[0].body.api_key, 'phc_test', 'the key rides at the top level, not per-event');
  assert.equal(out.calls[0].body.batch.length, 2);
  assert.deepEqual(out.calls[0].body.batch.map((e) => e.event), ['a', 'b'], 'order must be preserved');
});

test('a full batch flushes eagerly instead of waiting for the timer', () => {
  const out = runWithKey(`async (ph, calls) => {
    for (let i = 0; i < 20; i++) ph.capture({ source: 'student', event: 'e' + i });
    await new Promise((r) => setTimeout(r, 50));   // let the eager flush land
    return { requests: calls.length, sent: calls[0] ? calls[0].body.batch.length : 0 };
  }`);
  assert.equal(out.requests, 1, '20 queued events should not sit waiting on a 10s timer');
  assert.equal(out.sent, 20);
});

test('a 5xx is retried — the events are kept, not thrown away', () => {
  const out = runWithKey(`async (ph, calls) => {
    ph.capture({ source: 'student', event: 'keep-me' });
    const first = await ph.flushPostHog();
    const after = ph.posthogStats();
    return { first, after, calls };
  }`, { status: 503 });

  assert.equal(out.first.ok, false);
  assert.equal(out.first.reason, 'retry');
  assert.equal(out.first.status, 503);
  assert.equal(out.after.queued, 1, 'a transient failure must not lose the event');
  assert.equal(out.after.dropped, 0);
});

test('a 4xx is dropped — a rejected payload will fail identically forever', () => {
  const out = runWithKey(`async (ph, calls) => {
    ph.capture({ source: 'student', event: 'doomed' });
    const first = await ph.flushPostHog();
    const after = ph.posthogStats();
    const second = await ph.flushPostHog();
    return { first, after, second, requests: calls.length };
  }`, { status: 401 });

  assert.equal(out.first.reason, 'http');
  assert.equal(out.first.status, 401);
  // The whole point of the split: a bad project key must not turn into an
  // infinite retry loop against an endpoint that will never accept it.
  assert.equal(out.after.queued, 0, 'a 4xx batch must be dropped, not retried');
  assert.equal(out.after.dropped, 1, 'and the loss must be counted, not silent');
  assert.equal(out.second.sent, 0);
  assert.equal(out.requests, 1, 'the second flush must not re-send a rejected batch');
});

test('a network failure re-queues rather than losing the batch', () => {
  const out = runWithKey(`async (ph) => {
    ph.capture({ source: 'student', event: 'offline' });
    const res = await ph.flushPostHog();
    return { res, after: ph.posthogStats() };
  }`, { status: 0 });

  assert.equal(out.res.ok, false);
  assert.equal(out.res.reason, 'network');
  assert.equal(out.after.queued, 1);
});

test('an unreachable PostHog cannot grow the queue without bound', () => {
  const out = runWithKey(`async (ph) => {
    // Every flush fails, so every batch comes back. 1300 events against a
    // 1000-event ceiling must end bounded, with the loss counted.
    for (let i = 0; i < 1300; i++) {
      ph.capture({ source: 'student', event: 'e' + i });
      if (i % 100 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    await new Promise((r) => setTimeout(r, 100));
    await ph.flushPostHog().catch(() => {});
    return ph.posthogStats();
  }`, { status: 0 });

  assert.ok(out.queued <= 1000, `queue must stay under the ceiling, saw ${out.queued}`);
  assert.ok(out.dropped > 0, 'events shed to stay under the ceiling must be counted');
  assert.equal(out.queued + out.dropped >= 1300 - 1000, true);
});
