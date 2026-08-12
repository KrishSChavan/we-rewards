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

/** Notify all subscribed operators about one successfully logged error. */
export async function notifyError(error) {
  return notifyAdmins(errorAlertPayload(error));
}
