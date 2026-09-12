import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url || !serviceKey || !anonKey) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY in .env');
}

/* ---------------------------------------------------------------------------
 * RETRY ONCE, AT THE TRANSPORT, FOR IDEMPOTENT REQUESTS ONLY.
 *
 * Supabase sits behind Cloudflare, and Cloudflare occasionally cannot reach the
 * origin for a moment — it answers with an HTML error page (1018 "Could not
 * find host", served as HTTP 530) instead of anything supabase-js can parse.
 * The client surfaces that as an error whose message is the whole page, and the
 * caller 500s. That is what happened to /api/me/balances on staging at
 * 2026-08-19T14:09:29Z: a single request, no recurrence, both hosts healthy
 * before and after.
 *
 * WHY THE CACHE DID NOT COVER IT. src/lib/cache.js already stale-serves the
 * vendor catalogue for 120s past its TTL precisely so a blip is not a 500. But
 * /api/me/balances is a Promise.all of seven reads and five of them are
 * per-student (point_balances, punch_cards, vendor_favorites, transactions,
 * punches). Those are deliberately uncached — balances move on every award and
 * the socket layer keeps them live — so they had nothing to fall back on, and
 * Promise.all fails on the first rejection.
 *
 * WHY HERE AND NOT AT THE CALL SITE. One wrapper covers every read in the app,
 * including the ones added later, instead of each route remembering. It also
 * sits below supabase-js's error handling, so a retried request that succeeds
 * is indistinguishable from one that worked first time — no caller changes.
 *
 * WHAT IT WILL NOT RETRY, and why each exclusion matters:
 *   • Anything but GET/HEAD. A POST that reached Postgres and whose RESPONSE
 *     was lost is indistinguishable from one that never arrived, so retrying it
 *     double-writes. In a points app that is awarding somebody twice. The
 *     idempotency guards that do exist (transactions.client_token, migration-019)
 *     cover some paths, not all — so this stays on the side that cannot corrupt.
 *   • HTTP 500 and every 4xx. A PostgREST 500 is a deterministic query failure
 *     (a bad column, a constraint) and a retry just fails again a beat later.
 *     Only the gateway range — where the request provably never reached
 *     Postgres — is retried.
 *   • An aborted request. The caller has already given up.
 *
 * THE ONE EXCEPTION: A NAMED RPC THAT CANNOT DOUBLE-WRITE.
 * "Anything but GET/HEAD" cost a student their earn code on 2026-09-12 at
 * 20:07:06Z. A PostgREST RPC is an HTTP POST, so the gateway 504 that
 * create_earn_code caught was excluded from the retry above, surfaced as an
 * error whose message was the response body ("Gateway Timeout"), and 500'd —
 * for a call that mints nothing and moves no points. Note that PostgREST mounts
 * EVERY RPC as a POST, so this exclusion never distinguished a write from a
 * read; it only ever saw the verb. So a POST may be retried if, and only if, it
 * is an RPC named in READ_ONLY_RPCS or IDEMPOTENT_WRITE_RPCS below.
 *
 * The bar for the second of those lists is not "it feels safe". It is: running
 * this function TWICE CONCURRENTLY, against the same arguments, must leave the
 * database in the same state as running it once, and must return the same
 * answer. Not "probably" — a 504 means the gateway stopped waiting, NOT that
 * Postgres stopped working, so the first attempt may well still be executing
 * when the retry's statements run. Anything less than a per-caller lock inside
 * the function is a race, and the proof for each entry belongs beside it.
 * ------------------------------------------------------------------------- */

/** Cloudflare/proxy statuses that mean "the origin was never reached". */
const RETRYABLE_STATUS = new Set([
  502, 503, 504,                                    // standard gateway errors
  520, 521, 522, 523, 524, 525, 526, 527, 530,      // Cloudflare's origin range (1018 → 530)
]);

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);

/**
 * RPCs THAT CANNOT WRITE AT ALL, because they are declared `stable` in SQL.
 *
 * This is the one entry in this file backed by something stronger than a careful
 * reading: PostgreSQL REFUSES to execute an INSERT/UPDATE/DELETE inside a
 * non-volatile function ("is not allowed in a non-volatile function"), so a
 * `stable` RPC is a read by enforcement, not by convention. Retrying a read is
 * exactly as safe as retrying a GET — which is what each of these would be if
 * PostgREST didn't mount every RPC as a POST.
 *
 * Each name here must still be declared `stable` (or `immutable`) in the
 * migration that last defined it. test/supabase-retry.test.js re-reads the SQL
 * and fails if one of them is redefined as volatile, because the day somebody
 * adds a write to one of these, this file's proof evaporates silently.
 */
export const READ_ONLY_RPCS = new Set([
  'campaign_audience',            // migration-045 — who a deal would go to
  'pool_settlement',              // migration-046 — what leaving a pool would pay out
  'student_visited_vendor_ids',   // migration-048 — on the hottest read in the app
  'top_vendors_by_visits',        // migration-041 — the Recommended ranking
]);

/**
 * RPCs that DO write, but whose second run cannot do damage, each with the
 * reason it is safe.
 *
 * ONE LINE OF PROOF PER ENTRY, OR IT DOES NOT GO IN. Read the function, not its
 * name: "create_*" sounds like it mints something new every call, and the only
 * reason this one does not is the body of the function.
 *
 *   create_earn_code — returns the student's LIVE code if they have one and only
 *     mints when they do not, so a second run hands back the first run's code
 *     and re-extends its TTL. Nothing is awarded, nothing is spent, and no code
 *     is consumed. Serialised per student by pg_advisory_xact_lock
 *     (migration-056), which is what makes that true for two runs AT ONCE
 *     rather than only for two runs in sequence — without it both attempts can
 *     miss the live-code check together and insert two codes for one student,
 *     which is how the displayed code starts flipping between two values
 *     between refreshes.
 */
export const IDEMPOTENT_WRITE_RPCS = new Set(['create_earn_code']);

const IDEMPOTENT_RPCS = new Set([...READ_ONLY_RPCS, ...IDEMPOTENT_WRITE_RPCS]);

/** PostgREST mounts RPCs at /rest/v1/rpc/<name>. Query string ignored. */
const RPC_PATH = /\/rest\/v1\/rpc\/([^/?#]+)(?:[?#]|$)/;

/**
 * The RPC this request calls, or null when it isn't an RPC call at all.
 * Takes the URL as a string so it works for both call shapes supabase-js uses.
 */
function rpcNameOf(input) {
  const url = String(input?.url ?? input ?? '');
  const m = RPC_PATH.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * PostgREST's own errors are JSON with a `code`; a gateway's are an HTML page or
 * a line of text. Callers throw whichever they get, so without this the operator
 * reads "Gateway Timeout" in the error log — two words that name neither the
 * upstream that failed nor the call that failed — and every route has to treat
 * somebody else's outage as its own 500. Normalising here, at the only place
 * that can still see the HTTP status, gives the whole app one field to branch
 * on: error.code === 'UPSTREAM_GATEWAY'.
 */
export const UPSTREAM_GATEWAY = 'UPSTREAM_GATEWAY';

/** Does this body parse as the JSON PostgREST would have sent? */
function isJsonBody(body) {
  const s = String(body ?? '').trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrite an unrecoverable gateway response into the PostgREST error shape,
 * leaving a real PostgREST error (or anything that parses as JSON) untouched.
 *
 * `retried` says whether the blip had already been given a second chance, which
 * is the difference between one unlucky request and an upstream that is down.
 */
async function asPostgrestError(res, input, method, retried) {
  if (!res || !RETRYABLE_STATUS.has(res.status)) return res;
  // An injected fetch (see the test seam) need not be a whole Response. Nothing
  // below works without a readable body, so such a response passes through.
  if (typeof res.text !== 'function') return res;

  let body = '';
  try {
    body = await res.text();
  } catch { /* nothing to read — fall through with the empty string */ }

  // Rebuilt with ONLY a content-type, deliberately. The body has already been
  // read (and transparently decompressed), so carrying the original headers over
  // would re-attach a content-length and possibly a content-encoding that no
  // longer describe it. Nothing downstream reads a header off an error response:
  // postgrest-js only looks at content-range, and only when the response is ok.
  const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };
  if (isJsonBody(body)) {
    return new Response(body, { status: res.status, statusText: res.statusText, headers: JSON_TYPE });
  }

  // The QUERY STRING IS DROPPED ON PURPOSE. PostgREST filters live there, and
  // they carry values this must never write into a log the operator exports —
  // `earn_codes?code=eq.482913` is a live code, and the message field has none
  // of the redaction requestContext applies to context (see src/lib/errors.js).
  const path = String(input?.url ?? input ?? '').split('?')[0].replace(/^https?:\/\/[^/]+/, '');
  return new Response(JSON.stringify({
    code: UPSTREAM_GATEWAY,
    message: `Database gateway error (HTTP ${res.status}) on ${method} ${path}`,
    details: body ? String(body).slice(0, 500) : '',
    hint: retried
      ? 'Retried once and it failed again, so this is an upstream outage rather than a blip.'
      : 'Not retried — see IDEMPOTENT_METHODS/IDEMPOTENT_RPCS in src/lib/supabase.js.',
  }), { status: res.status, statusText: res.statusText, headers: JSON_TYPE });
}

/** Long enough for a blip to clear, short enough that nobody waits on it. */
const RETRY_DELAY_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch, with one retry for transport-level failures on idempotent requests.
 *
 * Deliberately NOT a general retry loop: a second attempt covers the blip this
 * exists for, and anything still failing after it is an outage that more
 * attempts would only make slower to report.
 *
 * @internal exported as a test seam — see test/supabase-retry.test.js.
 */
export async function retryingFetch(input, init = {}, doFetch = fetch) {
  // A Request object carries its own method; supabase-js passes a string URL
  // plus init, but handle both rather than assume.
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
  const rpc = method === 'POST' ? rpcNameOf(input) : null;
  const retryable = IDEMPOTENT_METHODS.has(method) || (rpc !== null && IDEMPOTENT_RPCS.has(rpc));
  // What the log line should call this, so a retry of a write is never mistaken
  // for the blanket "GETs are retried" rule when somebody reads the dyno log.
  const what = rpc ? `POST rpc/${rpc}` : method;

  let res;
  try {
    res = await doFetch(input, init);
  } catch (err) {
    // The origin was unreachable (DNS, reset connection, refused socket). Never
    // reached Postgres, so a GET is safe to repeat.
    if (!retryable || init?.signal?.aborted) throw err;
    console.warn(`[supabase] ${what} failed at the transport (${err?.message ?? err}) — retrying once`);
    await sleep(RETRY_DELAY_MS);
    return asPostgrestError(await doFetch(input, init), input, method, true);
  }

  if (!RETRYABLE_STATUS.has(res.status) || !retryable || init?.signal?.aborted) {
    return asPostgrestError(res, input, method, false);
  }

  console.warn(`[supabase] ${what} got HTTP ${res.status} from the gateway — retrying once`);
  await sleep(RETRY_DELAY_MS);
  const retried = await doFetch(input, init);
  // If the retry is no better, hand back the RETRY's response rather than the
  // first — same status either way, and the second body is the current truth
  // about what the gateway is saying.
  return asPostgrestError(retried, input, method, true);
}

// Server-side client. Bypasses RLS — never expose this key to the browser.
export const supabaseAdmin = createClient(url, serviceKey, {
  auth: { persistSession: false },
  global: { fetch: retryingFetch },
});

// Used only to verify user JWTs sent from the browser.
export const supabaseAuth = createClient(url, anonKey, {
  auth: { persistSession: false },
  global: { fetch: retryingFetch },
});
