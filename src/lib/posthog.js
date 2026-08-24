// Product analytics forwarding to PostHog.
//
// Modelled on src/lib/email.js and src/lib/push.js, and for the same reasons:
//
//   • FULLY OPTIONAL. With no POSTHOG_API_KEY the module is an inert no-op, so a
//     local checkout with no keys runs unchanged and nothing on a request path
//     depends on analytics being configured.
//   • NEVER THROWS. Every entry point resolves. A student redeeming points must
//     not see an error because an analytics vendor had a bad minute.
//   • BEST-EFFORT, AND SAID OUT LOUD. Events can be dropped (see MAX_QUEUE and
//     the 4xx branch in flush). client_events remains the system of record;
//     PostHog is a mirror of it, never the primary copy.
//
// ---- Why raw fetch and not posthog-node ----
// The same call this repo already makes to Resend and to Google: one POST with a
// token and a JSON body. That is the standing convention here (see the header of
// src/lib/email.js). Concretely, `npm i posthog-node` also wanted to downgrade
// three packages we already depend on — body-parser, socket.io-parser and
// brace-expansion — which is a real risk to take on for an optional mirror of a
// table we already write.
//
// ---- Why a queue and not a POST per event ----
// capture() is called from inside request handlers (/api/client-event). A
// synchronous round-trip to PostHog there would put a third-party network hop on
// a path a student is waiting on. Events are enqueued in memory and flushed in
// batches, so capture() costs an array push. The cost of that choice is that a
// hard crash loses whatever is queued — acceptable for a mirror, and the reason
// flushPostHog() is wired into the SIGTERM path in server.js, which is the one
// shutdown we actually get told about.
//
// ---- Anonymous events ----
// PostHog requires a distinct_id on every event. Signed-in events use the
// Supabase user id. Pre-login events (pwa_launched, most of the install funnel)
// have nobody to attribute to, and this deployment sends NO client-side anon id
// because the browser bundles are deliberately untouched by this integration.
// They are therefore sent with $process_person_profile: false, which records the
// event without creating or updating a person. That keeps PostHog's person count
// honest — the alternative, bucketing every anonymous visitor under one shared
// id, would invent a single hyperactive "user" and quietly corrupt every
// person-based metric in the project.
//
// The cost: anonymous events cannot be stitched into a per-device funnel, so
// install_eligible -> install_prompt_shown -> install_accepted is queryable as
// COUNTS but not as a true PostHog funnel. Fixing that properly means the client
// minting a stable anonymous id and posting it with the event, which is a
// public/ change (and a service-worker cache bump per app) that this
// server-side-only integration deliberately does not make.

const API_KEY = process.env.POSTHOG_API_KEY ?? '';

// Default to US cloud, the region posthog.com signups land in. Trailing slashes
// are stripped so POSTHOG_HOST=https://eu.i.posthog.com/ doesn't build a //batch/.
const HOST = (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');

/** Mirrors emailEnabled: one boolean the rest of the app can branch on. */
export const posthogEnabled = Boolean(API_KEY);

export const batchUrl = () => `${HOST}/batch/`;

// PostHog truncates distinct_id at 200 characters server-side. Doing it here too
// means the id we send is the id we logged, so a truncated value can't quietly
// become a second person.
const DISTINCT_ID_MAX = 200;

const FLUSH_AT = 20;              // events queued before an eager flush
const FLUSH_INTERVAL_MS = 10_000; // ...or this long since the last one
const TIMEOUT_MS = 5_000;
// A ceiling, not a target. If PostHog is unreachable for an hour, this is what
// stops a best-effort mirror from becoming an out-of-memory incident. Oldest
// events are dropped first: in a funnel the recent ones are the ones being
// looked at.
const MAX_QUEUE = 1_000;

let queue = [];
let timer = null;
let dropped = 0;
let warned = false;

/**
 * Shape one of our events into PostHog's wire format. Pure and exported so the
 * payload can be asserted in tests without a key, a network, or a queue — the
 * same reason the rollups in src/lib/analytics.js live apart from their routes.
 *
 * distinct_id is set BOTH at the top level and inside properties. PostHog's
 * ingestion accepts either, different client libraries send different ones, and
 * the published docs render the batch example in a lazily-loaded block this
 * repo's fetcher could not read. Setting both is unambiguous under either
 * reading and costs one short string.
 *
 * @param {object} e                  the same shape logEvent() takes
 * @param {string} [nowIso]           injectable clock, for deterministic tests
 */
export function toPostHogEvent(e, nowIso) {
  const anonymous = !e?.userId;
  const distinctId = String(anonymous ? `anon:${e?.source ?? 'unknown'}` : e.userId)
    .slice(0, DISTINCT_ID_MAX);

  const properties = {
    distinct_id: distinctId,
    source: e?.source ?? null,
    // `trigger` is only meaningful on install_prompt_shown; null elsewhere
    // rather than absent, so the column exists on every event in a query.
    trigger: e?.trigger ?? null,
    $current_url: e?.path ?? null,
    // PostHog parses this into browser / OS / device properties for events that
    // did not come from posthog-js. Without it every server-sent event shows up
    // with no device breakdown at all.
    $raw_user_agent: e?.userAgent ?? null,
    $lib: 'werewards-server',
    // Caller-supplied extras go here, not last: they are the reason the event
    // was sent, but a stray props.$process_person_profile must not be able to
    // start minting junk people out of anonymous traffic.
    ...(e?.props && typeof e.props === 'object' ? e.props : null),
    // These two are re-pinned AFTER the spread, and that ordering is the whole
    // point: /api/client-event is unauthenticated and takes a caller-supplied
    // `props` object, so without this a forged post could set
    // props.distinct_id to a real user's uuid and hang an invented event off
    // their profile, or flip $process_person_profile to mint junk people out of
    // anonymous traffic. Everything else in props is caller data and stays
    // caller data.
    distinct_id: distinctId,
    // Anonymous events are recorded without creating or updating a person. See
    // the "Anonymous events" note in this file's header for why.
    $process_person_profile: !anonymous,
  };

  return {
    event: String(e?.event ?? 'unknown'),
    distinct_id: distinctId,
    properties,
    timestamp: nowIso ?? new Date().toISOString(),
  };
}

/**
 * Enqueue one event. Synchronous by design — see the header. Safe to call when
 * PostHog is unconfigured, in which case it does nothing at all.
 * @returns {boolean} whether the event was queued (false = disabled or dropped)
 */
export function capture(e) {
  if (!posthogEnabled) return false;
  try {
    queue.push(toPostHogEvent(e));
    if (queue.length > MAX_QUEUE) {
      // Drop oldest. Counted so the loss is reported rather than silent.
      dropped += queue.length - MAX_QUEUE;
      queue = queue.slice(-MAX_QUEUE);
      if (!warned) {
        warned = true;
        console.error(`posthog: queue over ${MAX_QUEUE}, dropping oldest events (is POSTHOG_HOST reachable?)`);
      }
    }
    if (queue.length >= FLUSH_AT) {
      void flushPostHog();
    } else if (!timer) {
      // unref'd: an idle analytics timer must never be the reason a test run or
      // a one-shot script refuses to exit.
      timer = setTimeout(() => { timer = null; void flushPostHog(); }, FLUSH_INTERVAL_MS);
      timer.unref?.();
    }
    return true;
  } catch {
    return false;   // analytics is best-effort — never let it break the caller
  }
}

/**
 * Send whatever is queued. Never throws, never rejects.
 *
 * Retry policy mirrors the pruning instinct in src/lib/push.js — keep what might
 * still land, drop what provably won't:
 *   • network error / timeout / 429 / 5xx  -> transient. Re-queue at the FRONT
 *     (these are the oldest events) and let the next flush try again.
 *   • 4xx                                  -> our fault. A bad project key or a
 *     malformed payload will fail identically forever, so the batch is dropped
 *     and the reason is logged ONCE. This is the failure mode check-posthog.js
 *     exists to catch before it reaches production.
 *
 * @returns {Promise<{ok:boolean, sent:number, reason?:string, status?:number}>}
 */
export async function flushPostHog() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!posthogEnabled) return { ok: false, sent: 0, reason: 'disabled' };
  if (queue.length === 0) return { ok: true, sent: 0 };

  const batch = queue;
  queue = [];

  let res;
  try {
    res = await fetch(batchUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: API_KEY, batch }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout rejects with TimeoutError; DNS/TLS/socket land here.
    requeue(batch);
    return { ok: false, sent: 0, reason: err?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }

  if (res.ok) return { ok: true, sent: batch.length };

  if (res.status === 429 || res.status >= 500) {
    requeue(batch);
    return { ok: false, sent: 0, reason: 'retry', status: res.status };
  }

  dropped += batch.length;
  if (!warned) {
    warned = true;
    console.error(
      `posthog: rejected the batch with HTTP ${res.status} — dropping ${batch.length} event(s). `
      + 'Run `npm run check:posthog` to see why; a bad project key fails exactly like this, forever.'
    );
  }
  return { ok: false, sent: 0, reason: 'http', status: res.status };
}

/** Put a failed batch back at the front, oldest-first, respecting MAX_QUEUE. */
function requeue(batch) {
  queue = batch.concat(queue);
  if (queue.length > MAX_QUEUE) {
    dropped += queue.length - MAX_QUEUE;
    queue = queue.slice(-MAX_QUEUE);
  }
}

/** Queue depth + cumulative drops, for check-posthog.js and for tests. */
export const posthogStats = () => ({ queued: queue.length, dropped });

/** Test-only: drop queued state so one test can't leak events into the next. */
export function _resetPostHog() {
  if (timer) { clearTimeout(timer); timer = null; }
  queue = [];
  dropped = 0;
  warned = false;
}
