// Operational alerting for every row that reaches error_logs. Server failures
// and client crashes use the same path, so the operator is notified about the
// exact set of errors visible on /admin instead of only server-error spikes.

import { notifyAdmins } from './push.js';

const SOURCE_LABELS = {
  server: 'Server',
  student: 'Student app',
  vendor: 'Vendor app',
  admin: 'Admin app',
};

/**
 * Build the compact text shown by the OS. Exported separately so its length and
 * source handling can be unit tested without attempting a real push.
 */
export function errorAlertPayload(error = {}) {
  const source = SOURCE_LABELS[error.source] ?? 'App';
  const rawMessage = String(error.message ?? '').trim() || 'Unknown error';
  const message = rawMessage.length > 140 ? `${rawMessage.slice(0, 137)}...` : rawMessage;
  const path = String(error.path ?? '').trim();
  return {
    title: `WeRewards error: ${source}`,
    body: path ? `${message} (${path.slice(0, 100)})` : message,
    url: '/admin/',
  };
}

/* ---------- repeats ----------
   One push per row meant one burst was hundreds of pushes: the 2026-10-19 deal
   broadcast drew 420 identical scanner reports in 65 seconds and paged the
   operator 420 times. The first occurrence of a message still pushes at once;
   the same source + message then stays quiet for an hour. Every row is still
   written to error_logs, so /admin shows the whole burst.

   The window is opened by the push, not slid by each repeat, so an error that
   keeps happening pushes once an hour for as long as it lasts instead of going
   silent. In memory, per process: a restart forgets it, which costs one extra
   push per message and is the right way for this to fail. */
const REPEAT_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED = 1000;

/**
 * Returns `(error, now) => boolean`, true when this error should push.
 * A factory so tests get their own state instead of sharing the live one.
 */
export function createRepeatGate({ windowMs = REPEAT_WINDOW_MS, max = MAX_TRACKED } = {}) {
  const lastPushed = new Map();   // key -> ms of the push that opened its window
  return (error = {}, now = Date.now()) => {
    const key = `${error.source ?? ''}\n${String(error.message ?? '').trim()}`;
    const at = lastPushed.get(key);
    if (at !== undefined && now - at < windowMs) return false;
    // Delete first so the re-set moves the key to the end: Map keeps insertion
    // order, which makes the first key the stalest one when the cap is hit.
    lastPushed.delete(key);
    lastPushed.set(key, now);
    if (lastPushed.size > max) lastPushed.delete(lastPushed.keys().next().value);
    return true;
  };
}

const shouldPush = createRepeatGate();

/** Notify all subscribed operators about one successfully logged error. */
export async function notifyError(error) {
  if (!shouldPush(error)) return 0;
  return notifyAdmins(errorAlertPayload(error));
}
