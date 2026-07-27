// Best-effort product analytics into the client_events table (migration-024).
// Mirrors logError(): writing an event must NEVER throw into the request path —
// every failure here is swallowed. The PWA install funnel posts here via
// /api/client-event so the drop-off between eligible → shown → accepted is
// queryable server-side.

import { supabaseAdmin } from './supabase.js';

// Cap field lengths so a bogus/oversized payload can't bloat a row (or the table).
const cap = (s, n) => (s == null ? null : String(s).slice(0, n));

/**
 * @param {object} e
 * @param {'student'|'vendor'|'admin'} e.source
 * @param {string}  e.event      funnel stage, e.g. 'install_prompt_shown'
 * @param {string} [e.trigger]   which trigger fired (install_prompt_shown only)
 * @param {object} [e.props]     small structured extra data
 * @param {string} [e.userId]    best-effort; no FK so deleting a user keeps the event
 * @param {string} [e.userAgent]
 * @param {string} [e.path]      page URL at the time
 */
export async function logEvent(e) {
  try {
    await supabaseAdmin.from('client_events').insert({
      source: e.source,
      event: cap(e.event, 100) || 'unknown',
      trigger: cap(e.trigger, 40),
      props: e.props && typeof e.props === 'object' ? e.props : null,
      user_id: e.userId ?? null,
      user_agent: cap(e.userAgent, 500),
      path: cap(e.path, 500),
    });
  } catch {
    /* analytics is best-effort — never let it break the caller */
  }
}
