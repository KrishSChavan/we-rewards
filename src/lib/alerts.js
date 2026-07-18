// Operational alerting: turn a burst of unexpected server 500s into a push to
// the operator's subscribed devices, so a prod incident doesn't sit unnoticed in
// the /admin error log until someone happens to look.
//
// Best-effort and self-contained: it reuses the same web-push channel as the
// new-application alerts (src/lib/push.js), so with no VAPID keys / no subscribed
// admin it degrades to a silent no-op — exactly like notifyAdmins.
//
// State is in-memory, which is correct for ONE dyno (the pilot). If the app is
// ever scaled to multiple dynos, each tracks its own window; move this to a
// shared store (Redis) at the same time as the rate limiter (see next-steps.md).

import { notifyAdmins } from './push.js';

// Alert when this many server errors land inside the window...
const SPIKE_THRESHOLD = 5;
const SPIKE_WINDOW_MS = 5 * 60 * 1000;   // 5 minutes
// ...but never more than once per cooldown, so one bad deploy can't spam pushes.
const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

let errorTimes = [];   // timestamps of recent server errors, trimmed to the window
let lastAlertAt = 0;

/**
 * Record one unexpected server error (a 500 in the central handler) and fire a
 * throttled push alert if they're spiking. Never throws — call and forget.
 */
export function recordServerError() {
  try {
    const now = Date.now();
    errorTimes.push(now);
    errorTimes = errorTimes.filter((t) => now - t < SPIKE_WINDOW_MS);

    if (errorTimes.length >= SPIKE_THRESHOLD && now - lastAlertAt > ALERT_COOLDOWN_MS) {
      lastAlertAt = now;
      const count = errorTimes.length;
      errorTimes = []; // reset so the same burst doesn't re-alert next error
      notifyAdmins({
        title: 'WeRewards: server errors spiking',
        body: `${count}+ server errors in the last few minutes — check the admin error log.`,
        url: '/admin/',
      }).catch(() => {});
    }
  } catch { /* alerting must never break the request path */ }
}
