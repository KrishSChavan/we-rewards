// Best-effort error logging into the error_logs table (migration-013) so the
// operator /admin dashboard can surface failures from the server and both
// clients. Writing a log must NEVER throw into the request path or the
// error handler — every failure here is swallowed.

import { supabaseAdmin } from './supabase.js';
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

/**
 * What the failing request was FOR, as a small structured blob for the operator
 * dashboard: the query string and body fields that shaped it (redacted per
 * SECRET_KEY above), who was making it, and which page they were on. The
 * message + stack say what broke; this says what it was doing at the time.
 *
 * Returns null rather than an empty object so a bare GET doesn't write `{}`.
 */
export function requestContext(req) {
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
  if (req.vendor?.name) ctx.vendor = cap(req.vendor.name, 120);
  if (req.vendor?.id) ctx.vendorId = req.vendor.id;

  // The page the call came from — the difference between "the terminal's SCAN
  // tab did this" and "someone hit the API by hand".
  const referer = req.headers?.referer || req.headers?.referrer;
  if (referer) ctx.referer = cap(referer, 300);

  return Object.keys(ctx).length ? ctx : null;
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
