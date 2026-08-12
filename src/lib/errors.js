// Best-effort error logging into the error_logs table (migration-013) so the
// operator /admin dashboard can surface failures from the server and both
// clients. Writing a log must NEVER throw into the request path or the
// error handler — every failure here is swallowed.

import { supabaseAdmin } from './supabase.js';
import { notifyError } from './alerts.js';

// Cap field lengths so a giant stack/context can't bloat a row (or the table).
const cap = (s, n) => (s == null ? null : String(s).slice(0, n));

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
