// Web-push alerts to the operator: "a new vendor application arrived" while the
// /admin dashboard is closed. Fully optional — with no VAPID keys in the env the
// whole module degrades to a silent no-op, so local setups without keys work
// unchanged. Subscriptions live in push_subscriptions (migration-018), written
// by the admin API when a dashboard enables notifications.

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
 * Send a notification to every subscribed admin browser. Best-effort: callers
 * fire-and-forget, so this never throws. A push service answering 404/410 means
 * the subscription is dead (browser unsubscribed / permission revoked) — prune
 * that row so we stop paying for the failed send on every application.
 *
 * @param {{ title: string, body?: string, url?: string }} payload
 */
export async function notifyAdmins(payload) {
  if (!pushEnabled) return;
  try {
    const { data: subs, error } = await supabaseAdmin
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth');
    if (error || !subs?.length) return;

    await Promise.allSettled(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload)
        );
      } catch (err) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await supabaseAdmin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        }
        // Any other failure (push service hiccup, network) is dropped — the
        // application itself is already saved; the badge still shows it.
      }
    }));
  } catch {
    /* never let a notification failure surface to the caller */
  }
}
