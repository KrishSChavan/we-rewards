// Web push, for two populations that share one table and one VAPID keypair:
//   • operators — "a new vendor application arrived" while /admin is closed
//     (migration-018), and the server-error spike alert in alerts.js;
//   • students — vendor deals, delivered by the campaign worker in campaigns.js
//     (migration-032).
//
// Subscriptions live in push_subscriptions, tagged with `role`. The two service
// workers are on different scopes (/admin/sw.js vs /sw.js) so their endpoints
// can never collide, but the role column is what actually keeps a student from
// being handed an operator alert: every read here filters on it.
//
// Fully optional — with no VAPID keys in the env nothing is ever sent, so local
// setups without keys work unchanged. The one thing that still happens is the
// operator-push log row saying push is not configured (see notifyAdmins).
//
// Logging (migration-062, src/lib/notification-log.js): operator pushes are
// logged HERE, because notifyAdmins is the only thing that knows it was an
// operator push. Student pushes are logged by their callers (campaigns.js,
// reminders.js, broadcasts.js), which know who it was for and why;
// sendToSubscriptionsDetailed hands them the per-device results to log.

import webpush from 'web-push';
import { supabaseAdmin } from './supabase.js';
import { logNotification, serviceOf, redactSecrets } from './notification-log.js';

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';

export const pushEnabled = Boolean(PUBLIC_KEY && PRIVATE_KEY);

if (pushEnabled) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    PUBLIC_KEY,
    PRIVATE_KEY
  );
}

/** The key a browser needs to subscribe; null when push is disabled. */
export function getVapidPublicKey() {
  return pushEnabled ? PUBLIC_KEY : null;
}

/**
 * Deliver one payload to a list of subscription rows, and report what happened
 * on each device. A push service answering 404/410 means the subscription is
 * dead (browser unsubscribed / permission revoked) — prune that row so we stop
 * paying for the failed send forever after.
 *
 * Each DeviceResult is safe to store and show: the subscription id, the push
 * service's family, the label captured at subscribe time, and the status code.
 * Never the endpoint, p256dh or auth — the three together are enough to send
 * that device anything, and the endpoint alone identifies it. Even the error
 * text is scrubbed of them, because a push service's response body is free to
 * echo the URL it was asked about.
 *
 * @param {Array<{id?: string, endpoint: string, p256dh: string, auth: string, device_label?: string|null}>} subs
 * @param {object} payload  serialised as JSON for the service worker
 * @returns {Promise<{accepted: number, tried: number, disabled: boolean, devices: Array<object>}>}
 */
export async function sendToSubscriptionsDetailed(subs, payload) {
  if (!pushEnabled) return { accepted: 0, tried: 0, disabled: true, devices: [] };
  if (!subs?.length) return { accepted: 0, tried: 0, disabled: false, devices: [] };
  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(subs.map(async (s) => {
    const device = {
      subId: s?.id === null || s?.id === undefined ? null : String(s.id),
      service: serviceOf(s?.endpoint),
      label: s?.device_label ?? null,
      ok: false,
      status: null,
      pruned: false,
      error: null,
    };
    try {
      const res = await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body
      );
      device.ok = true;
      device.status = Number.isInteger(res?.statusCode) ? res.statusCode : null;
      return device;
    } catch (err) {
      const code = err?.statusCode;
      device.status = Number.isInteger(code) ? code : null;
      device.error = redactSecrets(
        // web-push puts the push service's response body in err.body (a string);
        // anything else there is not worth showing, so fall back to the message.
        String((typeof err?.body === 'string' && err.body.trim()) || err?.message || err || 'send failed'),
        [s?.endpoint, s?.p256dh, s?.auth],
      // Longer than the 120 the log stores: toRow redacts token-shaped runs and
      // THEN cuts, and a cut made here first could leave a fragment too short
      // for it to recognise.
      ).slice(0, 300);
      // Four codes mean this endpoint is permanently unusable, not merely
      // unlucky:
      //   404/410 — the browser dropped it (unsubscribed, permission revoked);
      //   401/403 — it was minted against a DIFFERENT VAPID keypair than the one
      //             we sign with, so every future send is rejected identically.
      // The 401/403 pair matters because claim_campaign_pushes only checks that
      // SOME row exists for the student: keeping a rejected row means the
      // student is claimed, their cooldown and daily cap are spent, and nothing
      // is delivered — forever. Pruning is what lets the client mint a fresh
      // subscription on its next pass.
      if (code === 401 || code === 403 || code === 404 || code === 410) {
        // `pruned` reports what the database said, not what we asked for: the
        // admin log showing "removed" for a row that is still there would send
        // the operator looking in the wrong place.
        try {
          const { error } = await supabaseAdmin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
          device.pruned = !error;
        } catch {
          device.pruned = false;
        }
        console.warn(`[push] dropped dead endpoint (${code}): ${err?.body ?? err?.message ?? ''}`);
      } else {
        // A hiccup (5xx, network, 400 payload problem) is the caller's retry
        // problem, not ours — but it is never silent again.
        console.warn(`[push] send failed (${code ?? 'no status'}): ${err?.body ?? err?.message ?? err}`);
      }
      return device;
    }
  }));
  const devices = results.map((r) => (r.status === 'fulfilled'
    ? r.value
    : { subId: null, service: 'other', label: null, ok: false, status: null, pruned: false, error: 'send failed' }));
  return {
    accepted: devices.filter((d) => d.ok).length,
    tried: devices.length,
    disabled: false,
    devices,
  };
}

/**
 * The integer form. Returns how many endpoints accepted it. Callers that care
 * (the campaign worker) use 0 to mean "this student is unreachable"; callers
 * that don't (operator alerts) ignore it. Kept because every existing caller,
 * and the quota refund in campaigns.js, is written against the number.
 */
export async function sendToSubscriptions(subs, payload) {
  return (await sendToSubscriptionsDetailed(subs, payload)).accepted;
}

// device_label arrived with migration-062, and this code reaches production
// before the operator pastes it. Asking for a column that is not there fails the
// WHOLE read, and studentSubscriptions answering [] on that would make every
// student look unreachable to the campaign worker: their claim is refunded,
// they are emailed instead, and no push goes out to anyone. So a missing column
// costs one retry with the old narrow select, and then the narrow one is used
// for a while. A while, not until the next boot: the operator pasting 062 into a
// running deployment should get labels without a restart (the same 15 minutes
// student.js waits before writing the column again).
const WIDE_SELECT = 'id, user_id, endpoint, p256dh, auth, device_label';
const NARROW_SELECT = 'id, user_id, endpoint, p256dh, auth';
const DEVICE_LABEL_RETRY_MS = 15 * 60 * 1000;
let deviceLabelMissingUntil = 0;

function isMissingColumn(error) {
  return error?.code === '42703' || error?.code === 'PGRST204';
}

/**
 * Read push_subscriptions for one role with the label column if it exists.
 * `narrow` adds the caller's filters; it is applied to both attempts.
 */
async function readSubscriptions(role, narrow) {
  const run = (cols) => narrow(supabaseAdmin.from('push_subscriptions').select(cols).eq('role', role));
  if (Date.now() >= deviceLabelMissingUntil) {
    const first = await run(WIDE_SELECT);
    if (!isMissingColumn(first.error)) return first;
    deviceLabelMissingUntil = Date.now() + DEVICE_LABEL_RETRY_MS;
  }
  return run(NARROW_SELECT);
}

/** Read admin subscriptions with optional ownership/endpoint narrowing. */
async function adminSubscriptionsResult({ userId = null, endpoint = null } = {}) {
  const { data, error } = await readSubscriptions('admin', (query) => {
    let q = query;
    if (userId) q = q.eq('user_id', userId);
    if (endpoint) q = q.eq('endpoint', endpoint);
    return q;
  });
  if (error) {
    console.warn(`[push] could not read admin subscriptions: ${error.message}`);
    return { subs: [], readFailed: true };
  }
  return { subs: data ?? [], readFailed: false };
}

// Every error_logs insert pages the operators (alerts.js), so with push
// unconfigured, or with nobody subscribed, an error storm would write one
// identical "refused" row per error: new load that says nothing after the first.
// Those rows are kept to one per kind and reason per window, in memory (a
// restart costs one extra row). Sent and failed rows are never coalesced, since
// each is a real attempt worth seeing; nor is a row with a ref (a vendor
// application), whose link to that record is the point of the row; nor the
// diagnostic test push, which an operator asked for and cannot storm.
const COALESCE_MS = 5 * 60 * 1000;
const refusedLoggedAt = new Map();

function hasRef(ref) {
  return Boolean(ref) && typeof ref === 'object' && Object.keys(ref).length > 0;
}

function coalescedRecently(key) {
  const now = Date.now();
  const last = refusedLoggedAt.get(key);
  if (last !== undefined && now - last < COALESCE_MS) return true;
  refusedLoggedAt.set(key, now);
  return false;
}

/** @internal test seam: forget which refused operator rows were logged. */
export function _resetAdminPushLogForTests() {
  refusedLoggedAt.clear();
}

/**
 * One log row for an operator push, whichever way it ended.
 *
 * A failed subscription read is logged as failed/send_error rather than as
 * "no devices": the two look identical in the count (0), and the whole point of
 * the log is that an operator who hears nothing can tell "nobody subscribed"
 * from "we could not even look".
 */
function logAdminPush({ kind, ref, payload, userId = null, result, readFailed = false, threw = false, coalesce = false }) {
  let outcome = 'sent';
  let reason = null;
  if (result?.disabled) { outcome = 'refused'; reason = 'push_disabled'; }
  else if (threw || readFailed) { outcome = 'failed'; reason = 'send_error'; }
  else if (!result?.tried) { outcome = 'refused'; reason = 'no_devices'; }
  else if (!result.accepted) { outcome = 'failed'; reason = 'no_device_accepted'; }
  if (coalesce && outcome === 'refused' && !hasRef(ref) && coalescedRecently(`${kind}:${reason}`)) return;
  logNotification({
    channel: 'push',
    kind,
    outcome,
    reason,
    recipientKind: 'admin',
    recipientUserId: userId,
    recipientLabel: 'Admin devices',
    title: payload?.title,
    body: payload?.body,
    url: payload?.url,
    template: payload?.tag ?? null,
    ref,
    devices: result?.devices ?? [],
  });
}

const DISABLED = { accepted: 0, tried: 0, disabled: true, devices: [] };

/**
 * Send a notification to every subscribed admin browser. Best-effort and never
 * throws. The accepted-delivery count lets diagnostic callers distinguish a
 * real delivery attempt from a silent no-op.
 *
 * Logged even when push is unconfigured: prod has run without VAPID keys
 * before, and "refused, push not configured" in the log is the difference
 * between an empty log that looks healthy and one that says what is wrong.
 * Once per five minutes per kind is enough to say it (see COALESCE_MS).
 *
 * @param {{ title: string, body?: string, url?: string, tag?: string }} payload
 * @param {{ kind?: string, ref?: object }} [meta]
 */
export async function notifyAdmins(payload, meta = {}) {
  const kind = meta?.kind ?? 'admin_alert';
  const ref = meta?.ref;
  if (!pushEnabled) {
    logAdminPush({ kind, ref, payload, result: DISABLED, coalesce: true });
    return 0;
  }
  let read = { subs: [], readFailed: false };
  let result = null;
  try {
    read = await adminSubscriptionsResult();
    result = await sendToSubscriptionsDetailed(read.subs, payload);
  } catch (err) {
    console.warn(`[push] admin notification failed: ${err?.message ?? err}`);
    logAdminPush({ kind, ref, payload, result, threw: true });
    return 0;
  }
  logAdminPush({ kind, ref, payload, result, readFailed: read.readFailed, coalesce: true });
  return result.accepted;
}

/** Send a diagnostic alert only to the requesting admin's current browser. */
export async function notifyAdminEndpoint(userId, endpoint, payload) {
  // A half-formed call is a programming error, not a notification, so it is
  // refused before anything (the log included) is touched. Reaching the query
  // with either half missing would silently widen the diagnostic.
  if (!userId || !endpoint) return 0;
  const kind = 'admin_test';
  if (!pushEnabled) {
    logAdminPush({ kind, payload, userId, result: DISABLED });
    return 0;
  }
  let read = { subs: [], readFailed: false };
  let result = null;
  try {
    read = await adminSubscriptionsResult({ userId, endpoint });
    result = await sendToSubscriptionsDetailed(read.subs, payload);
  } catch (err) {
    console.warn(`[push] admin test notification failed: ${err?.message ?? err}`);
    logAdminPush({ kind, payload, userId, result, threw: true });
    return 0;
  }
  logAdminPush({ kind, payload, userId, result, readFailed: read.readFailed });
  return result.accepted;
}

/** Every live student endpoint for one user (all their devices). */
export async function studentSubscriptions(userId) {
  if (!pushEnabled || !userId) return [];
  const { data, error } = await readSubscriptions('student', (q) => q.eq('user_id', userId));
  return error ? [] : (data ?? []);
}
