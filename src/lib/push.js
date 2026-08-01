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
// Fully optional — with no VAPID keys in the env the whole module degrades to a
// silent no-op, so local setups without keys work unchanged.

import webpush from 'web-push';
import { supabaseAdmin } from './supabase.js';

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
 * Deliver one payload to a list of subscription rows. A push service answering
 * 404/410 means the subscription is dead (browser unsubscribed / permission
 * revoked) — prune that row so we stop paying for the failed send forever after.
 *
 * Returns how many endpoints accepted it. Callers that care (the campaign
 * worker) use 0 to mean "this student is unreachable"; callers that don't
 * (operator alerts) ignore it.
 *
 * @param {Array<{endpoint: string, p256dh: string, auth: string}>} subs
 * @param {object} payload  serialised as JSON for the service worker
 */
export async function sendToSubscriptions(subs, payload) {
  if (!pushEnabled || !subs?.length) return 0;
  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body
      );
      return true;
    } catch (err) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await supabaseAdmin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      }
      // Any other failure (push service hiccup, network) is dropped by the
      // caller's own retry policy, not here.
      return false;
    }
  }));
  return results.filter((r) => r.status === 'fulfilled' && r.value).length;
}

/**
 * Send a notification to every subscribed admin browser. Best-effort: callers
 * fire-and-forget, so this never throws.
 *
 * @param {{ title: string, body?: string, url?: string }} payload
 */
export async function notifyAdmins(payload) {
  if (!pushEnabled) return;
  try {
    const { data: subs, error } = await supabaseAdmin
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      // Students subscribe to this same table (migration-032). Without this
      // filter every one of them would receive "new vendor application".
      .eq('role', 'admin');
    if (error || !subs?.length) return;
    await sendToSubscriptions(subs, payload);
  } catch {
    /* never let a notification failure surface to the caller */
  }
}

/** Every live student endpoint for one user (all their devices). */
export async function studentSubscriptions(userId) {
  if (!pushEnabled || !userId) return [];
  const { data, error } = await supabaseAdmin
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_id', userId)
    .eq('role', 'student');
  return error ? [] : (data ?? []);
}
