// The notification log: one row per push or email we sent, tried to send, or
// decided not to send (migration-062, public.notification_log). /admin reads it
// to answer "did that student actually get anything?", which before this table
// was only answerable from Heroku's console output.
//
// ---- The rules this module exists to keep ----
//
// IT IS AN OBSERVER, NEVER A PARTICIPANT. Every caller is a send path: the
// campaign worker's tick, a vendor submitting an application, a Stripe webhook,
// a vendor's password reset. Logging a send must not be able to fail one, slow
// one, or change what it returns. So logNotification() never throws and never
// rejects, call sites do not await it, and every write carries its own timeout.
// The in-flight set exists only so tests (and a graceful shutdown) can wait for
// the writes that are still on the wire.
//
// IT MUST SHIP BEFORE ITS TABLE DOES. Production carries a backlog of migrations
// the operator has not pasted yet, and this code will reach a dyno before
// migration-062 does. A missing table or column turns logging off for a
// cool-down window, with ONE console line per window naming the migration, then
// tries again. Not "retry every write": on a busy campaign tick that would be a
// failed request per student, all of them pointless.
//
// IT MUST NOT FEED ITSELF. This module deliberately does not import errors.js or
// alerts.js and never calls logError or notifyAdmins. Every error_logs insert
// pushes an alert to the operators (alerts.js), and that push is itself logged
// here. If a failing log write could produce an error_logs row, one broken write
// would page the operators, whose page would be logged, whose log write would
// fail, and so on for as long as the table is unhealthy. Failures here go to
// console.warn, rate-limited, and nowhere else. test/notification-log.test.js
// reads this file's source to hold that line.
//
// IT NEVER STORES A CREDENTIAL. Reset codes and link codes ride in two email
// subjects (email-templates.js); the push endpoint URL plus its keys are enough
// to send that device anything. toRow() whitelists device fields, so a caller
// that hands it a raw subscription row still cannot write the endpoint, and
// redactSecrets() is what email.js runs every subject through.

import { supabaseAdmin } from './supabase.js';

export const NOTIFICATION_KINDS = Object.freeze([
  'deal', 'nearby', 'reminder', 'broadcast', 'admin_alert', 'admin_test',
  'vendor_reset', 'application_received', 'application_accepted',
  'student_link_code', 'other',
]);

const KIND_SET = new Set(NOTIFICATION_KINDS);
const CHANNELS = new Set(['push', 'email']);
const OUTCOMES = new Set(['sent', 'failed', 'refused', 'allowed']);
const RECIPIENT_KINDS = new Set(['student', 'vendor', 'applicant', 'admin', 'other']);
const DELIVERY_STATUSES = new Set(['delivered', 'bounced', 'complained']);

// PostgREST's answers for "that relation/column is not there": the Postgres
// codes when the query reaches the database, the PGRST ones when PostgREST's
// schema cache already knows better.
const MISSING_CODES = new Set(['42P01', 'PGRST205', '42703', 'PGRST204']);

const DISABLE_MS = 5 * 60 * 1000;
const WARN_EVERY_MS = 60 * 1000;
// Generous, because nothing waits on it; finite, because flushNotificationLog()
// runs at shutdown and a hung socket must not hold a dyno past its SIGTERM grace.
const WRITE_TIMEOUT_MS = 8_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const state = { available: null, lastError: null, disabledUntil: null };
let lastWarnAt = 0;
const inflight = new Set();

/* ---------- pure helpers ---------- */

/**
 * Which push service an endpoint belongs to. The host is the only thing about
 * an endpoint that is safe to show: the full URL is a capability.
 */
export function serviceOf(endpoint) {
  try {
    const host = new URL(String(endpoint)).hostname.toLowerCase();
    if (host === 'push.apple.com' || host.endsWith('.push.apple.com')) return 'apple';
    if (host === 'fcm.googleapis.com' || host === 'android.googleapis.com') return 'google';
    if (host === 'mozilla.com' || host.endsWith('.mozilla.com')) return 'mozilla';
    if (host === 'notify.windows.com' || host.endsWith('.notify.windows.com')) return 'microsoft';
    return 'other';
  } catch {
    return 'other';
  }
}

/**
 * "iPhone Safari", "Windows Chrome". A label for a human reading the admin log,
 * not a fingerprint: OS family plus browser brand, nothing versioned.
 *
 * Order matters, because every Chromium UA also says Safari and every Edge UA
 * also says Chrome. And an INSTALLED iOS web app (the only place iOS delivers
 * web push at all) sends a UA with no "Safari/" token, so an Apple OS with
 * AppleWebKit and no other brand is Safari by elimination. iPadOS 13+ asks for
 * desktop sites by default and reports itself as a Mac, which is
 * indistinguishable server-side, so those read "Mac Safari".
 */
export function deviceLabelFromUA(ua) {
  if (typeof ua !== 'string' || !ua.trim()) return null;
  const s = ua;
  let os = null;
  if (/\biPhone\b|\biPod\b/.test(s)) os = 'iPhone';
  else if (/\biPad\b/.test(s)) os = 'iPad';
  else if (/\bAndroid\b/.test(s)) os = 'Android';
  else if (/\bCrOS\b/.test(s)) os = 'ChromeOS';
  else if (/\bWindows\b/.test(s)) os = 'Windows';
  else if (/\bMacintosh\b|\bMac OS X\b/.test(s)) os = 'Mac';
  else if (/\bLinux\b/.test(s)) os = 'Linux';

  let browser = null;
  if (/\bEdg(e|A|iOS)?\//.test(s)) browser = 'Edge';
  else if (/\bSamsungBrowser\//.test(s)) browser = 'Samsung Internet';
  else if (/\bOPR\/|\bOpera\b/.test(s)) browser = 'Opera';
  else if (/\bFxiOS\/|\bFirefox\//.test(s)) browser = 'Firefox';
  else if (/\bCriOS\/|\bChrome\/|\bChromium\//.test(s)) browser = 'Chrome';
  else if (/\bSafari\//.test(s)) browser = 'Safari';
  else if ((os === 'iPhone' || os === 'iPad' || os === 'Mac') && /AppleWebKit\//.test(s)) browser = 'Safari';

  const label = [os, browser].filter(Boolean).join(' ');
  return label ? label.slice(0, 40) : null;
}

function escapeRe(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace each secret, case-insensitively, with '[redacted]'.
 *
 * Separator-tolerant on purpose: a reset code is generated as `K7M2-NP94` and
 * typed back as `K7M2NP94`, and the template is free to print either. A caller
 * passing one spelling must not leak the other, so the match ignores spaces and
 * hyphens between the secret's characters. Secrets shorter than 3 characters
 * (after separators are dropped) are ignored: redacting every "a" in a subject
 * protects nothing.
 */
export function redactSecrets(text, secrets = []) {
  if (text === null || text === undefined) return null;
  let out = String(text);
  for (const raw of Array.isArray(secrets) ? secrets : []) {
    if (raw === null || raw === undefined) continue;
    const chars = [...String(raw).replace(/[\s-]+/g, '')];
    if (chars.length < 3) continue;
    const re = new RegExp(chars.map(escapeRe).join('[\\s-]*'), 'gi');
    out = out.replace(re, '[redacted]');
  }
  return out;
}

function str(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s ? s.slice(0, max) : null;
}

function uuidOrNull(value) {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

// A push service's error body is free to echo the subscription back, and the
// caller's redactSecrets() only catches it copied exactly. So the stored text
// loses every URL (plain or percent-encoded) and every token-shaped run, which
// puts "no endpoint in devices[].error" on the column instead of on the caller.
const ERROR_URL_RE = /https?(?::\/\/|%3A%2F%2F)[^\s"'<>]+/gi;
const ERROR_TOKEN_RE = /[A-Za-z0-9_:%-]{20,}/g;
// Push services name their errors in CamelCase ("UnauthorizedRegistration" is
// 24 characters), and those are the most useful words in the body. A run made
// only of such words is kept; a random token is not shaped like that (no digits,
// no two capitals in a row, no 16-letter lowercase stretch) except by a
// vanishingly rare accident.
const ERROR_WORD_RE = /^[A-Z]?[a-z]{1,15}(?:[A-Z][a-z]{1,15})*$/;

export function redactDeviceError(text) {
  if (text === null || text === undefined) return null;
  return String(text)
    .replace(ERROR_URL_RE, '[redacted]')
    .replace(ERROR_TOKEN_RE, (run) => (run.split(/[_:-]/).every((w) => ERROR_WORD_RE.test(w)) ? run : '[redacted]'));
}

// Only these keys survive into the row, whatever the caller passes, which is
// what makes "the endpoint is never stored" a property of this module rather
// than of every caller remembering.
function cleanDevice(d) {
  const o = d && typeof d === 'object' ? d : {};
  const status = Number.isInteger(o.status) ? o.status : null;
  return {
    subId: o.subId === null || o.subId === undefined ? null : String(o.subId).slice(0, 64),
    service: str(o.service, 20) ?? 'other',
    label: str(o.label, 40),
    ok: o.ok === true,
    status,
    pruned: o.pruned === true,
    // Redacted before the cut, so the cut cannot leave a token too short to match.
    error: str(redactDeviceError(o.error), 120),
  };
}

function cleanRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return {};
  let json;
  try {
    json = JSON.stringify(ref);
  } catch {
    json = null;
  }
  if (json && json.length <= 4000) return JSON.parse(json);
  // Too big (or unserialisable): keep the scalar facts, drop the lists.
  const out = {};
  for (const [k, v] of Object.entries(ref)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
    }
  }
  return out;
}

/** camelCase entry -> snake_case notification_log row. Pure. */
export function toRow(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const devices = Array.isArray(e.devices) ? e.devices.slice(0, 50).map(cleanDevice) : [];
  const tried = Number.isInteger(e.devicesTried) && e.devicesTried >= 0 ? e.devicesTried : devices.length;
  const accepted = Number.isInteger(e.devicesAccepted) && e.devicesAccepted >= 0
    ? e.devicesAccepted
    : devices.filter((d) => d.ok).length;

  const row = {
    channel: e.channel,
    kind: KIND_SET.has(e.kind) ? e.kind : 'other',
    outcome: e.outcome,
    reason: str(e.reason, 60),
    recipient_kind: RECIPIENT_KINDS.has(e.recipientKind) ? e.recipientKind : 'other',
    student_id: uuidOrNull(e.studentId),
    recipient_user_id: uuidOrNull(e.recipientUserId),
    recipient_email: str(e.recipientEmail, 254),
    recipient_label: str(e.recipientLabel, 120),
    vendor_id: uuidOrNull(e.vendorId),
    title: str(e.title, 200),
    body: str(e.body, 1000),
    url: str(e.url, 500),
    template: str(e.template, 60),
    ref: cleanRef(e.ref),
    devices,
    devices_tried: tried,
    devices_accepted: accepted,
    provider_id: str(e.providerId, 200),
    source: e.source === 'backfill' ? 'backfill' : 'live',
    dedupe_key: str(e.dedupeKey, 200),
  };
  if (e.createdAt) {
    const t = new Date(e.createdAt);
    if (!Number.isNaN(t.getTime())) row.created_at = t.toISOString();
  }
  return row;
}

/* ---------- state ---------- */

function isMissing(error) {
  return Boolean(error) && MISSING_CODES.has(String(error.code ?? ''));
}

function disabledNow() {
  return state.disabledUntil !== null && Date.now() < state.disabledUntil;
}

function markMissing(error) {
  // Every write already on the wire when the window opens comes back missing
  // too, and each lands here. Only the first of them opens the window and warns.
  const wasDisabled = disabledNow();
  state.available = false;
  state.lastError = String(error?.message ?? error ?? 'missing').slice(0, 300);
  if (wasDisabled) return;
  state.disabledUntil = Date.now() + DISABLE_MS;
  // One line per window: the window itself is the rate limit.
  console.warn(`[notification-log] notification_log is missing or out of date (apply migration-062): ${state.lastError}. Not logging notifications for ${DISABLE_MS / 60000} minutes.`);
}

function markFailed(error) {
  state.lastError = String(error?.message ?? error ?? 'unknown').slice(0, 300);
  const now = Date.now();
  if (now - lastWarnAt >= WARN_EVERY_MS) {
    lastWarnAt = now;
    console.warn(`[notification-log] write failed: ${state.lastError}`);
  }
}

function markOk() {
  state.available = true;
  state.disabledUntil = null;
}

export function notificationLogState() {
  return { available: state.available, lastError: state.lastError, disabledUntil: state.disabledUntil };
}

/** @internal test seam: forget the cool-down and warning clocks. */
export function _resetNotificationLogForTests() {
  state.available = null;
  state.lastError = null;
  state.disabledUntil = null;
  lastWarnAt = 0;
}

/* ---------- writes ---------- */

function writeRow(row) {
  const table = supabaseAdmin.from('notification_log');
  const q = row.dedupe_key
    ? table.upsert(row, { onConflict: 'dedupe_key', ignoreDuplicates: true })
    : table.insert(row);
  return q.select('id').abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
}

async function write(entry) {
  try {
    if (disabledNow()) return null;
    const row = toRow(entry);
    if (!CHANNELS.has(row.channel) || !OUTCOMES.has(row.outcome)) {
      markFailed(new Error(`refused a row with channel=${row.channel} outcome=${row.outcome}`));
      return null;
    }
    let { data, error } = await writeRow(row);
    // A vendor deleted between the send and this write is a 23503 on vendor_id.
    // The notification still happened, so keep the row and lose only the link.
    // (A student deleted in that gap is the same code on student_id, and that row
    // SHOULD vanish: the cascade exists so their history goes with them.)
    if (error?.code === '23503' && row.vendor_id && /vendor/i.test(`${error.message} ${error.details ?? ''}`)) {
      ({ data, error } = await writeRow({ ...row, vendor_id: null }));
    }
    if (error) {
      if (isMissing(error)) markMissing(error);
      else markFailed(error);
      return null;
    }
    markOk();
    return Array.isArray(data) && data[0]?.id ? String(data[0].id) : null;
  } catch (err) {
    markFailed(err);
    return null;
  }
}

/**
 * Record one notification. Resolves to the new row's id, or null (not logged,
 * a duplicate, or the table is unavailable). Never throws, never rejects; call
 * sites do not await it.
 */
export function logNotification(entry) {
  const p = write(entry);
  inflight.add(p);
  p.finally(() => inflight.delete(p));
  return p;
}

/**
 * Wait for the log writes still on the wire. Tests and shutdown only.
 *
 * With no timeout it waits until none are left, including writes started while
 * it waits (what a test wants). With `timeoutMs` (what shutdown wants) it waits
 * only for the writes already on the wire when it was called, and for no longer
 * than that: a worker tick that is still running at SIGTERM keeps adding writes,
 * and each can take two 8s aborts, so an open-ended wait could outlast the
 * process's own exit backstop. Resolves true when everything it waited for
 * landed, false when it gave up. Never rejects.
 */
export async function flushNotificationLog({ timeoutMs } = {}) {
  if (!Number.isFinite(timeoutMs)) {
    while (inflight.size) {
      await Promise.allSettled([...inflight]);
    }
    return true;
  }
  const snapshot = [...inflight];
  if (!snapshot.length) return true;
  let timer;
  const gaveUp = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.allSettled(snapshot).then(() => true), gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- retention ---------- */

// migration-062 schedules prune_notification_log daily with pg_cron, but on a
// project where pg_cron cannot be created it only raises a NOTICE, and nothing
// would ever delete a row. The Policy promises about 30 days. So the server also
// calls it once a day: the delete is idempotent, and with pg_cron working it
// simply finds nothing left to do.
const PRUNE_FIRST_DELAY_MS = 60 * 1000;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
// No AbortSignal on this one: a big first prune is a long DELETE, and aborting
// the request would not stop the statement anyway.
const MISSING_FUNCTION_CODES = new Set(['PGRST202', '42883']);
let pruneTimer = null;

/**
 * Delete log rows older than `days`. Resolves to the number deleted, or null
 * when it could not run. Never throws. A missing function is migration-062 not
 * being applied yet, which the log writes already warn about, so it is quiet.
 */
export async function pruneNotificationLog(days = 30) {
  try {
    const { data, error } = await supabaseAdmin.rpc('prune_notification_log', { p_days: days });
    if (error) {
      if (!MISSING_FUNCTION_CODES.has(String(error.code ?? '')) && !isMissing(error)) {
        console.warn(`[notification-log] prune failed: ${String(error.message ?? error).slice(0, 300)}`);
      }
      return null;
    }
    const n = Number(data);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    console.warn(`[notification-log] prune failed: ${String(err?.message ?? err).slice(0, 300)}`);
    return null;
  }
}

/**
 * Run the prune about a minute after boot, then daily. Idempotent. The delays
 * are parameters only so a test does not have to wait a minute.
 */
export function startNotificationLogPruner({ firstDelayMs = PRUNE_FIRST_DELAY_MS, everyMs = PRUNE_EVERY_MS } = {}) {
  if (pruneTimer) return;
  const run = () => {
    pruneNotificationLog().then((n) => {
      if (n) console.log(`[notification-log] pruned ${n} row(s) older than 30 days`);
    });
  };
  pruneTimer = setTimeout(() => {
    run();
    pruneTimer = setInterval(run, everyMs);
    pruneTimer.unref?.();
  }, firstDelayMs);
  pruneTimer.unref?.();
}

export function stopNotificationLogPruner() {
  if (!pruneTimer) return;
  // clearTimeout and clearInterval share one id space in Node.
  clearTimeout(pruneTimer);
  pruneTimer = null;
}

// complained > bounced > delivered. Resend does not promise event order, and a
// spam report arriving before a late "delivered" must not be painted over by it.
const OVERWRITABLE = {
  delivered: 'delivery_status.is.null,delivery_status.eq.delivered',
  bounced: 'delivery_status.is.null,delivery_status.in.(delivered,bounced)',
  complained: null,
};

/**
 * Apply a Resend delivery event to the row(s) carrying that message id.
 * Only delivered / bounced / complained: opens and clicks are never stored.
 * Never throws. True when the update was accepted (even if it matched nothing).
 */
export async function recordEmailEvent(providerId, status, at) {
  try {
    if (!DELIVERY_STATUSES.has(status)) return false;
    const id = typeof providerId === 'string' ? providerId.trim().slice(0, 200) : '';
    if (!id) return false;
    if (disabledNow()) return false;
    const t = at ? new Date(at) : null;
    const when = t && !Number.isNaN(t.getTime()) ? t.toISOString() : new Date().toISOString();
    let q = supabaseAdmin
      .from('notification_log')
      .update({ delivery_status: status, delivery_at: when })
      .eq('provider_id', id);
    if (OVERWRITABLE[status]) q = q.or(OVERWRITABLE[status]);
    const { error } = await q.abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
    if (error) {
      if (isMissing(error)) markMissing(error);
      else markFailed(error);
      return false;
    }
    markOk();
    return true;
  } catch (err) {
    markFailed(err);
    return false;
  }
}
