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
// have nobody to attribute to, and this module does not read the browser's own
// anonymous id, so they are sent with $process_person_profile: false — recorded
// as events, but creating and updating no person. That keeps PostHog's person
// count honest; the alternative, bucketing every anonymous visitor under one
// shared id, would invent a single hyperactive "user" and quietly corrupt every
// person-based metric in the project.
//
// The cost: anonymous events cannot be stitched into a per-device funnel, so
// install_eligible -> install_prompt_shown -> install_accepted is queryable as
// COUNTS but not as a true PostHog funnel. Closing that gap means posting the
// browser's distinct_id up with the event from /api/client-event, which is now
// possible (posthog-js runs in the page — see below) but is deliberately not
// done here: that endpoint is unauthenticated, so a caller-supplied distinct_id
// is a caller-supplied claim about whose profile an event belongs to.
//
// SIGNED-IN events do stitch, and that is the part that matters for replay:
// public/shared/analytics.js identifies the browser with the same Supabase user
// id this module uses, so a student's server-side events and their session
// recording land on ONE person rather than two.
//
// ---- The browser half ----
// Everything above is a mirror of events we already record. It cannot produce a
// session REPLAY, because a replay is a recording of the DOM and only the
// browser has one. That runs in public/shared/analytics.js, from the vendored
// posthog-js bundle (scripts/build-client.js), configured by the exports at the
// bottom of this file. This module stays the one place that reads POSTHOG_*
// out of the environment.

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

/* ==========================================================================
   Browser-side session replay
   ==========================================================================
   The values public/shared/analytics.js needs, resolved here so that
   POSTHOG_API_KEY and POSTHOG_HOST are read in exactly one file. server.js
   turns posthogClientConfig() into <meta> tags on each app shell and feeds
   posthogConnectOrigins() to the CSP; nothing else reads these variables.

   On putting the project key in the HTML: phc_ keys are WRITE-ONLY ingestion
   tokens, published in the page by PostHog's own install snippet. It is the
   same value this module posts with, and it cannot read anything back out of
   the project. A personal key (phx_/phs_) can — that one must never appear
   here, which is why scripts/check-posthog.js refuses it outright. */

/** The ingestion origin, without a trailing slash. */
export const posthogHost = HOST;

// Off unless a key is configured, and switchable off with a key still in place.
// The env var exists for the case where the server-side event mirror should keep
// running but recording should stop — a privacy request, a noisy quarter, a
// retention limit — without pulling the key out from under it. The FASTER lever
// for an emergency is the project switch in PostHog (Settings -> Replay): it
// takes effect on every device at once, where this needs a redeploy.
const REPLAY_OFF = /^(?:0|false|off|no)$/i;
export const sessionReplayEnabled =
  posthogEnabled && !REPLAY_OFF.test((process.env.POSTHOG_SESSION_REPLAY ?? '').trim());

/**
 * The dashboard origin that matches an ingestion host, so a replay deep link
 * points at the right region's UI. Cloud ingestion is us.i / eu.i and the
 * dashboards are us. / eu. — everything else is assumed self-hosted, where the
 * two are the same origin.
 */
export function posthogUiHost(host = HOST) {
  const m = /^https:\/\/(us|eu)\.i\.posthog\.com$/.exec(host);
  return m ? `https://${m[1]}.posthog.com` : host;
}

/**
 * Origins the BROWSER must be allowed to reach, for the CSP's connect-src.
 * connect-src only: the SDK is served from our own origin and the build we ship
 * is posthog-js's "no-external" variant, which loads no remote script — so
 * script-src stays 'self'.
 *
 * The -assets host is included even though that build should never ask for it.
 * It is where posthog-js fetches remote CONFIG (not code) on some paths, the
 * cost of allowing a connection to a host we already send every event to is
 * nil, and the failure it prevents is the invisible kind: a blocked config
 * fetch that leaves recording quietly never starting.
 */
export function posthogConnectOrigins(host = HOST) {
  if (!host) return [];
  const origins = [host];
  const assets = host.replace(/^(https:\/\/)(us|eu)\.i\.posthog\.com$/, '$1$2-assets.i.posthog.com');
  if (assets !== host) origins.push(assets);
  return origins;
}

/**
 * What an app shell has to be told to start recording, or null when replay is
 * off — in which case server.js stamps no meta tags at all, analytics.js finds
 * no key, and the page runs exactly as it did before any of this existed.
 *
 * @param {string} app  which shell ('student' | 'vendor' | 'join'); rides along
 *                      as a property on every event so the replay list can be
 *                      filtered by app, which is the first thing you want to do
 *                      when three of them report into one project.
 */
export function posthogClientConfig(app) {
  if (!sessionReplayEnabled) return null;
  return { key: API_KEY, host: HOST, uiHost: posthogUiHost(), app };
}

/**
 * Read the project's replay settings, exactly as the browser reads them.
 *
 * THE SECOND SWITCH. Shipping the recorder is necessary and not sufficient:
 * session replay also has to be enabled in the PostHog PROJECT, and that switch
 * lives in someone's browser tab, not in this repo. With it off, every part of
 * this deployment stays healthy — the bundle builds, the SDK loads, the boot log
 * says replay is on — and nothing is ever recorded. Nothing in the app can tell,
 * because "the project said no" is not an error, it is an answer.
 *
 * So we ask. posthog-js fetches this same URL at init to decide what to do; this
 * is that answer, read at boot so the log line above the fold can be honest, and
 * read again by scripts/check-posthog.js before a deploy.
 *
 * Never throws, never rejects. An unreachable PostHog is reported as unknown
 * rather than guessed at in either direction.
 *
 * @returns {Promise<{ok: boolean, host: string, sessionRecording?: object|null,
 *                    reason?: string, status?: number}>}
 */
export async function fetchReplayConfig({ timeoutMs = 5_000 } = {}) {
  if (!posthogEnabled) return { ok: false, host: HOST, reason: 'no-key' };

  // The config lives on the -assets host on cloud, and on the instance itself
  // when self-hosted. posthogConnectOrigins() already encodes that distinction,
  // and reusing it means the CSP and this request can never disagree about
  // which origin is involved.
  const origins = posthogConnectOrigins();
  const host = origins[origins.length - 1];

  try {
    const res = await fetch(`${host}/array/${encodeURIComponent(API_KEY)}/config`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, host, reason: 'http', status: res.status };
    const cfg = await res.json();
    // Absent or false both mean "not recording". PostHog returns the whole
    // sessionRecording object when it is on, so its presence IS the answer.
    return { ok: true, host, sessionRecording: cfg?.sessionRecording ?? null };
  } catch (err) {
    return { ok: false, host, reason: err?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

/**
 * One line for the boot log, telling the truth about BOTH switches.
 *
 * The line this replaces said "Session replay: on" purely because a key was
 * set, which is the same half-answer that makes this feature fail invisibly in
 * the first place. Awaiting a network call before the server listens would be
 * worse than the problem, so server.js calls this after the listener is up and
 * corrects the record.
 */
export async function describeReplayProject() {
  const res = await fetchReplayConfig();
  if (!res.ok) {
    if (res.reason === 'no-key') return null;
    return `Session replay: could not reach ${res.host} to confirm the PROJECT has replay enabled `
      + `(${res.reason}${res.status ? ' ' + res.status : ''}) — run \`npm run check:posthog\``;
  }

  const rec = res.sessionRecording;
  if (!rec) {
    return 'Session replay: the browser is shipping the recorder, but replay is OFF IN THE POSTHOG '
      + 'PROJECT — nothing is being recorded. Settings -> Project -> Session Replay.';
  }

  // On, but with project settings that discard recordings after the fact. Each
  // of these produces "the replay list is emptier than it should be" and no
  // error of any kind, so they are worth naming on every boot rather than
  // leaving to be rediscovered.
  const caveats = [];
  if (rec.sampleRate != null && Number(rec.sampleRate) < 1) {
    caveats.push(`sampled at ${rec.sampleRate}`);
  }
  if (rec.minimumDurationMilliseconds) {
    caveats.push(`sessions under ${rec.minimumDurationMilliseconds}ms dropped`);
  }
  if (Array.isArray(rec.urlBlocklist) && rec.urlBlocklist.length) {
    caveats.push(`${rec.urlBlocklist.length} URL(s) blocked`);
  }
  if (Array.isArray(rec.urlTriggers) && rec.urlTriggers.length) {
    caveats.push(`${rec.urlTriggers.length} URL trigger(s) required`);
  }
  if (rec.linkedFlag) caveats.push('gated on a feature flag');

  return caveats.length
    ? `Session replay: confirmed on in the PostHog project, with caveats — ${caveats.join('; ')}`
    : 'Session replay: confirmed on in the PostHog project';
}
