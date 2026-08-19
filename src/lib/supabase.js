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
 * ------------------------------------------------------------------------- */

/** Cloudflare/proxy statuses that mean "the origin was never reached". */
const RETRYABLE_STATUS = new Set([
  502, 503, 504,                                    // standard gateway errors
  520, 521, 522, 523, 524, 525, 526, 527, 530,      // Cloudflare's origin range (1018 → 530)
]);

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);

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
  const retryable = IDEMPOTENT_METHODS.has(method);

  let res;
  try {
    res = await doFetch(input, init);
  } catch (err) {
    // The origin was unreachable (DNS, reset connection, refused socket). Never
    // reached Postgres, so a GET is safe to repeat.
    if (!retryable || init?.signal?.aborted) throw err;
    console.warn(`[supabase] ${method} failed at the transport (${err?.message ?? err}) — retrying once`);
    await sleep(RETRY_DELAY_MS);
    return doFetch(input, init);
  }

  if (!retryable || !RETRYABLE_STATUS.has(res.status) || init?.signal?.aborted) return res;

  console.warn(`[supabase] ${method} got HTTP ${res.status} from the gateway — retrying once`);
  await sleep(RETRY_DELAY_MS);
  const retried = await doFetch(input, init);
  // If the retry is no better, hand back the RETRY's response rather than the
  // first — same status either way, and the second body is the current truth
  // about what the gateway is saying.
  return retried;
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
