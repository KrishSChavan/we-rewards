// Best-effort error logging into the error_logs table (migration-013) so the
// operator /admin dashboard can surface failures from the server and both
// clients. Writing a log must NEVER throw into the request path or the
// error handler — every failure here is swallowed.

import { supabaseAdmin } from './supabase.js';
import { lookupVendor } from './cache.js';
import { notifyError } from './alerts.js';

// Cap field lengths so a giant stack/context can't bloat a row (or the table).
const cap = (s, n) => (s == null ? null : String(s).slice(0, n));

// Field names whose VALUES must never reach a log row. error_logs is read in
// /admin, kept indefinitely and never redacted afterwards, so anything that is a
// credential (password, PIN), a single-use secret (earn/redeem code, reset code,
// bearer token) or a bulk blob (logo, receipt photo) is replaced by a marker.
// Matched loosely on the key name — a false positive costs one redacted value,
// a false negative writes a live secret into a table nobody will ever re-audit.
const SECRET_KEY = /pass|pin\b|token|secret|key|code|auth|logo|image|photo|receipt|signature/i;

// A logged value is a hint about what the request was doing, not a copy of the
// payload — so scalars are kept (capped), and anything structured is reduced to
// a type marker rather than serialised.
const REDACTED = '[redacted]';
const VALUE_MAX = 200;
const FIELD_MAX = 25;

function redactValue(key, value) {
  if (SECRET_KEY.test(key)) return REDACTED;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return `[array · ${value.length}]`;
  if (typeof value === 'object') return `[object · ${Object.keys(value).length} fields]`;
  const s = String(value);
  return s.length > VALUE_MAX ? `${s.slice(0, VALUE_MAX)}…` : s;
}

/** Shallow, redacted copy of a query/body object — or null when there's nothing. */
function redactFields(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const keys = Object.keys(obj);
  if (!keys.length) return null;
  const out = {};
  for (const k of keys.slice(0, FIELD_MAX)) out[k] = redactValue(k, obj[k]);
  if (keys.length > FIELD_MAX) out['…'] = `${keys.length - FIELD_MAX} more fields`;
  return out;
}

/* ---------- which vendor ----------
   "Which spot was this?" is the first question the operator asks about almost
   every failure, and for most routes the answer was sitting in the request
   unread. requestContext only ever recorded req.vendor, which requireVendor sets
   — so the vendor-side terminal was named and nothing else was. A student
   redeeming at a counter, an operator editing a spot, a public /spots page, a
   logo that won't load: all of those carry a vendor, and all of them logged it as
   an anonymous uuid inside the body blob at best.

   WHERE THE ID CAN BE. Three places, in descending order of trust:

     1. req.vendor — the full row, already resolved. Authoritative, includes
        inactive vendors, and the only source that needs no lookup.
     2. A body or query field named for a vendor. Explicit enough to trust even
        when the name can't be resolved.
     3. THE URL. Not req.params: Express RESTORES req.params as each router
        unwinds, so by the time an error reaches the central handler it is `{}`
        (measured — /api/vendor/:vendorId/thing arrives with no params at all).
        req.originalUrl survives intact, so the path is scanned instead.

   A segment in VENDOR_SEGMENTS means the NEXT segment is a vendor, which is what
   makes /spots/:slug and /api/vendor-logo/:id readable. Any other uuid in the
   path is only believed if the catalogue confirms it is a vendor — a reward id, a
   transaction id and a user id all look identical otherwise, and a mislabelled
   vendor is worse than an unlabelled one. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Body/query keys that mean "this is a vendor". Matched case-insensitively. */
const VENDOR_FIELDS = new Set(['vendorid', 'vendor_id', 'vendorslug', 'vendor_slug', 'spotid', 'spot_id']);

/** Path segments after which the next segment names a vendor. */
const VENDOR_SEGMENTS = new Set(['spots', 'vendor-logo', 'vendors']);

/** Is this value worth even trying to resolve? */
const plausible = (v) => typeof v === 'string' && v.length > 0 && v.length <= 100;

/**
 * Candidate vendor ids/slugs from one request, best first, each flagged with
 * whether the request SAID it was a vendor (`named`) or we are guessing from a
 * bare uuid in the path (which only counts if the catalogue agrees).
 */
function vendorCandidates(req) {
  const out = [];
  for (const source of [req.body, req.query]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [k, v] of Object.entries(source)) {
      if (VENDOR_FIELDS.has(k.toLowerCase()) && plausible(v)) out.push({ value: v, named: true });
    }
  }

  const path = String(req.originalUrl ?? req.url ?? '').split('?')[0];
  const segments = path.split('/').filter(Boolean);
  segments.forEach((seg, i) => {
    const decoded = (() => {
      try { return decodeURIComponent(seg); } catch { return seg; }   // a mangled %-escape is not a vendor
    })();
    if (!plausible(decoded)) return;
    if (VENDOR_SEGMENTS.has(segments[i - 1]?.toLowerCase())) out.push({ value: decoded, named: true });
    else if (UUID.test(decoded)) out.push({ value: decoded, named: false });
  });
  return out;
}

/**
 * The vendor this request was about: `{ name, id, slug }`, any of which may be
 * null. Returns null when the request mentions no vendor at all.
 *
 * @param {object} req
 * @param {(idOrSlug: string) => ({id: string, name: string|null}|null)} [lookup]
 *        injected for tests — defaults to the in-memory catalogue index.
 */
export function vendorFromRequest(req, lookup = lookupVendor) {
  if (!req) return null;

  // 1. Already resolved by requireVendor. Covers every /api/vendor/* route and,
  //    unlike the catalogue, covers a deactivated vendor too.
  if (req.vendor?.id || req.vendor?.name) {
    return { name: req.vendor.name ?? null, id: req.vendor.id ?? null, slug: null };
  }

  const candidates = vendorCandidates(req);
  // 2. Anything the catalogue can put a NAME to wins, wherever it came from.
  for (const c of candidates) {
    const hit = lookup(c.value);
    if (hit) return { name: hit.name, id: hit.id, slug: UUID.test(c.value) ? null : c.value };
  }
  // 3. Otherwise report what the request said, unresolved — an id the operator
  //    can paste into /admin beats no vendor at all. Guesses are dropped here.
  for (const c of candidates) {
    if (!c.named) continue;
    return UUID.test(c.value)
      ? { name: null, id: c.value, slug: null }
      : { name: null, id: null, slug: c.value };
  }
  return null;
}

/**
 * What the failing request was FOR, as a small structured blob for the operator
 * dashboard: the query string and body fields that shaped it (redacted per
 * SECRET_KEY above), who was making it, WHICH VENDOR it was about, and which
 * page they were on. The message + stack say what broke; this says what it was
 * doing at the time.
 *
 * Returns null rather than an empty object so a bare GET doesn't write `{}`.
 *
 * @param {object} req
 * @param {Function} [lookup] vendor id/slug -> row. A test seam; the default is
 *        the in-memory catalogue index, which never touches the database.
 */
export function requestContext(req, lookup = lookupVendor) {
  if (!req) return null;
  const ctx = {};

  const query = redactFields(req.query);
  if (query) ctx.query = query;

  // req.body is only populated for parsed JSON bodies; a 415'd or unparsed body
  // is simply absent, which is the honest thing to record.
  const body = redactFields(req.body);
  if (body) ctx.body = body;

  if (req.user?.email) ctx.actorEmail = cap(req.user.email, 254);
  if (req.user?.id) ctx.actorId = req.user.id;

  // Never lets a lookup break the log row: an unnamed vendor is a worse error
  // report, a throw here is no error report at all.
  let vendor = null;
  try {
    vendor = vendorFromRequest(req, lookup);
  } catch { /* best-effort attribution */ }
  if (vendor?.name) ctx.vendor = cap(vendor.name, 120);
  if (vendor?.id) ctx.vendorId = vendor.id;
  if (vendor?.slug) ctx.vendorSlug = cap(vendor.slug, 120);

  // The page the call came from — the difference between "the terminal's SCAN
  // tab did this" and "someone hit the API by hand".
  const referer = req.headers?.referer || req.headers?.referrer;
  if (referer) ctx.referer = cap(referer, 300);

  return Object.keys(ctx).length ? ctx : null;
}

/* ---------- crawlers ----------
   Search crawlers run the client apps for real, and the apps break on them in
   ways no person will ever see. Googlebot's renderer drops subresources it
   decides it doesn't need for indexing, so /supabase.js simply isn't there when
   the student app's boot() reaches window.supabase, and every crawl of the
   landing page files the same TypeError. Nothing in that report is a bug anyone
   can fix, and a recurring row nobody can close is what teaches an operator to
   stop reading the error log.

   Only crawlers that EXECUTE JAVASCRIPT can reach /api/client-error at all, so
   this is an explicit list of those rather than a loose /bot/ pattern — that
   one matches the CUBOT phones too, and silently dropping a real student's
   crash report is a far more expensive mistake than missing a crawler. Add
   names here as they turn up in the log. */
const CRAWLER_UA = /googlebot|google-inspectiontool|google web preview|storebot-google|bingbot|applebot|duckduckbot|yandex(bot|mobilebot)|petalbot|bytespider|baiduspider|ahrefsbot|semrushbot|headlesschrome|chrome-lighthouse|lighthouse|pagespeed/i;

/** True for a user agent that identifies itself as a JS-executing crawler. */
export function isCrawler(userAgent) {
  return CRAWLER_UA.test(String(userAgent || ''));
}

/**
 * @param {object} e
 * @param {'server'|'student'|'vendor'|'admin'} e.source
 * @param {string}  e.message
 * @param {string} [e.stack]
 * @param {string} [e.path]    request path (server) or page URL (client)
 * @param {string} [e.method]  HTTP method (server)
 * @param {number} [e.status]  HTTP status (server)
 * @param {string} [e.userId]
 * @param {string} [e.userAgent]
 * @param {object} [e.context] small structured extra data
 */
export async function logError(e) {
  try {
    const { error } = await supabaseAdmin.from('error_logs').insert({
      source: e.source,
      message: cap(e.message, 2000) || 'Unknown error',
      stack: cap(e.stack, 8000),
      path: cap(e.path, 500),
      method: cap(e.method, 10),
      status: e.status ?? null,
      user_id: e.userId ?? null,
      user_agent: cap(e.userAgent, 500),
      context: e.context && typeof e.context === 'object' ? e.context : null,
    });
    if (error) {
      console.warn(`[errors] could not save error log: ${error.message}`);
      return false;
    }

    // Notify only after the insert succeeds, so each alert maps to a row the
    // operator can open in /admin. notifyError is itself best-effort.
    await notifyError(e);
    return true;
  } catch (err) {
    console.warn(`[errors] could not save error log: ${err?.message ?? err}`);
    /* logging is best-effort — never let it break the caller */
    return false;
  }
}
