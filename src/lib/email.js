// Outbound email via Resend — the stack's first and only mail transport.
//
// Modelled deliberately on src/lib/push.js, because the two solve the same
// problem for different channels and every lesson push taught us applies here:
//
//   • FULLY OPTIONAL. With no RESEND_API_KEY the whole module degrades to a
//     silent no-op, so a local checkout with no keys runs unchanged and nothing
//     on a request path fails because mail is unconfigured.
//   • NEVER THROWS. Every send resolves to { ok, ... }. A vendor application
//     must not 500 because a mail API had a bad minute — the row is already
//     written, and the operator's push alert already fired.
//   • DEAD ADDRESSES ARE PRUNED. push.js drops an endpoint on 404/410/401/403
//     because paying for a send that can never land is worse than not sending.
//     The email equivalent is the suppression list: a hard bounce or a spam
//     complaint (delivered by Resend's webhook, src/routes/webhooks.js) writes
//     a row here and every later send to that address is refused locally,
//     without a network call.
//
// ---- Why raw fetch and not the `resend` SDK ----
// Same call this repo already makes to Google (src/lib/gemini-receipt.js): one
// POST with a bearer token and a JSON body. The SDK adds a dependency, a
// release cadence, and its own error taxonomy to wrap in ours anyway.
//
// ---- The two classes of mail, and why they are not the same ----
// TRANSACTIONAL  — a password reset code, "your application was accepted".
//   The recipient asked for it by doing something. It is sent even to someone
//   who unsubscribed from marketing, and it carries no unsubscribe footer,
//   because "stop telling me my password changed" is not an option we offer.
// MARKETING      — deal emails to students.
//   Sent only to a live opt-in, always carries List-Unsubscribe (both the
//   mailto and the one-click POST form — Gmail and Yahoo require them of bulk
//   senders, and their absence is by itself a spam-folder signal), and is
//   refused for any address on the suppression list at any scope.
//
// The distinction lives in `category`, and getting it wrong is a real harm in
// one direction (marketing to someone who opted out) and a broken product in
// the other (swallowing a reset code because they muted deals). It is therefore
// a required-by-convention argument with a transactional default: the safe
// failure is sending a password reset, not sending an advert.

import crypto from 'node:crypto';
import { supabaseAdmin } from './supabase.js';

const API_URL = 'https://api.resend.com/emails';

const API_KEY = process.env.RESEND_API_KEY || '';
// Resend requires a verified domain. `WeRewards <hello@we-rewards.com>` — the
// display name matters more than it looks: a bare address in the From line is
// one of the cheapest spam signals there is.
const FROM = process.env.EMAIL_FROM || '';
// Where a vendor's reply goes. Optional, and worth setting: a transactional
// address that bounces replies teaches people the sender is a robot they cannot
// reach, which is exactly when they reach for "report spam" instead.
const REPLY_TO = process.env.EMAIL_REPLY_TO || '';
// Public origin for links inside an email. Unlike the QR-poster code this has
// NO request to fall back on — the campaign worker sends from a timer — so an
// unset APP_ORIGIN is a real misconfiguration, warned about at boot.
const ORIGIN = (process.env.APP_ORIGIN || '').replace(/\/+$/, '');

// Tighter than Gemini's because nothing is waiting on the answer: every caller
// here either already responded or is a background worker. A slow mail API
// should cost one queued email, not a held request.
const TIMEOUT_MS = Number(process.env.EMAIL_TIMEOUT_MS) || 10_000;

/** Config gate. Both halves are needed — a key with no From address cannot send. */
export const emailEnabled = Boolean(API_KEY && FROM);

if (emailEnabled && !ORIGIN) {
  console.warn('[email] APP_ORIGIN is unset — links in outgoing mail will be relative and will not work. Set it.');
}

/** The verified From line, or null when mail is off. Used by scripts/check-resend.js. */
export function emailFrom() {
  return emailEnabled ? FROM : null;
}

/**
 * Absolute URL for a path, for use inside an email.
 *
 * `req` is accepted so a request-path caller (an application confirmation) can
 * reuse the origin the browser actually reached us on, exactly as vendor.js does
 * for QR links. Background callers pass nothing and get APP_ORIGIN.
 */
export function emailUrl(pathname = '/', req = null) {
  const base = ORIGIN || (req ? `${req.protocol}://${req.get('host')}` : '');
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${p}`;
}

/**
 * `k****n@gmail.com`. Server logs are read by people debugging deliverability,
 * who need to tell two recipients apart without the log itself becoming a
 * mailing list — the same reason gemini-receipt.js may not log a receipt.
 */
export function maskEmail(address) {
  const s = String(address ?? '');
  const at = s.indexOf('@');
  if (at < 1) return '(invalid)';
  const user = s.slice(0, at);
  const domain = s.slice(at);
  if (user.length <= 2) return `${user[0]}*${domain}`;
  return `${user[0]}${'*'.repeat(Math.min(user.length - 2, 5))}${user[user.length - 1]}${domain}`;
}

/* ---------- the suppression list ---------- */

// 'all'       — the address is dead or its owner reported us. Nothing goes to
//               it again, transactional included: a hard bounce means there is
//               no mailbox, and continuing to send to one is precisely what
//               burns a sending domain's reputation.
// 'marketing' — no deals, but transactional mail still lands. Written when a
//               student uses one-click unsubscribe from a mail client, which is
//               a statement about adverts, not about their account.
const SCOPE_ALL = 'all';

/**
 * Is this address refused, for this class of mail?
 *
 * One indexed primary-key lookup per send. Deliberately not cached: the whole
 * point of the list is that a complaint stops the NEXT send, and a five-minute
 * cache would mean five more minutes of mailing someone who just told a mail
 * provider we are spam. Volume here is hundreds a day, not millions.
 *
 * A failed lookup returns false — send anyway. The alternative (fail closed)
 * would let one database hiccup silently mute every password reset in the
 * system, which is a far worse outcome than one email to a stale address.
 */
export async function isSuppressed(address, { marketing = false } = {}) {
  const email = String(address ?? '').trim().toLowerCase();
  if (!email) return false;
  const { data, error } = await supabaseAdmin
    .from('email_suppressions')
    .select('scope')
    .eq('email', email)
    .maybeSingle();
  if (error) {
    console.warn(`[email] suppression lookup failed for ${maskEmail(email)}: ${error.message}`);
    return false;
  }
  if (!data) return false;
  return data.scope === SCOPE_ALL || marketing;
}

/**
 * Add an address to the list. Idempotent, and ESCALATING: a row already at
 * 'all' is never downgraded to 'marketing' by a later unsubscribe, because a
 * bounce is a fact about the mailbox and an unsubscribe is a preference — the
 * fact wins.
 */
export async function suppress(address, reason, scope = SCOPE_ALL) {
  const email = String(address ?? '').trim().toLowerCase();
  if (!email) return false;
  const { error } = await supabaseAdmin.rpc('email_suppress', {
    p_email: email,
    p_reason: String(reason ?? 'unknown').slice(0, 80),
    p_scope: scope === SCOPE_ALL ? SCOPE_ALL : 'marketing',
  });
  if (error) {
    console.warn(`[email] could not suppress ${maskEmail(email)}: ${error.message}`);
    return false;
  }
  return true;
}

/* ---------- one-click unsubscribe ---------- */

// HMAC over the user id, so an unsubscribe link needs no table, survives a
// restart, and cannot be walked from one student to the next by editing a uuid
// in the URL. Rotating the secret invalidates every outstanding link, which is
// the intended lever if one is ever abused.
//
// Falls back to the service-role key because that value is already required,
// already secret, and already fatal to leak — a deployment cannot accidentally
// end up with an *empty* signing key this way, which is the failure that would
// make every token forgeable.
const UNSUB_SECRET = process.env.EMAIL_UNSUB_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/** Stable per-student token. Same input, same token, forever. */
export function unsubscribeToken(userId) {
  return crypto.createHmac('sha256', UNSUB_SECRET)
    .update(`unsub:${userId}`)
    .digest('base64url')
    .slice(0, 32);
}

/** Constant-time check. Length-guarded first: timingSafeEqual throws on a mismatch. */
export function verifyUnsubscribeToken(userId, token) {
  const expected = unsubscribeToken(userId);
  const got = String(token ?? '');
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

/** The link that goes in a deal email's footer and its List-Unsubscribe header. */
export function unsubscribeUrl(userId) {
  return emailUrl(`/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(userId)}`);
}

/* ---------- the send ---------- */

/**
 * Send one email. Never throws; resolves to { ok, id } or { ok, reason }.
 *
 * @param {object}  msg
 * @param {string}  msg.to        recipient address
 * @param {string}  msg.subject
 * @param {string}  msg.html
 * @param {string}  msg.text      plain-text alternative. NOT optional in
 *   practice: a multipart message with no text part is scored as spam by
 *   basically every filter, so templates always produce both.
 * @param {'transactional'|'marketing'} [msg.category]
 * @param {string}  [msg.unsubscribeUrl]  marketing only; adds List-Unsubscribe
 * @param {string}  [msg.idempotencyKey]  Resend de-dupes on this for 24h, which
 *   is what makes a retried accept (or a double-clicked button) safe to send.
 * @param {string[]} [msg.tags]   Resend tag values for its own dashboard
 * @returns {Promise<{ok: boolean, id?: string, reason?: string, status?: number}>}
 */
export async function sendEmail(msg) {
  const to = String(msg?.to ?? '').trim().toLowerCase();
  const marketing = msg?.category === 'marketing';

  if (!emailEnabled) return { ok: false, reason: 'disabled' };
  // A local guard, not a validator: Resend rejects a malformed address anyway,
  // but doing it here means a typo'd row costs no API call and no rate budget.
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, reason: 'invalid_to' };
  if (!msg?.subject || !msg?.html) return { ok: false, reason: 'empty' };

  if (await isSuppressed(to, { marketing })) {
    return { ok: false, reason: 'suppressed' };
  }

  const headers = { ...(msg.headers ?? {}) };
  if (marketing && msg.unsubscribeUrl) {
    // Both forms, because they do different jobs. The mailto is the fallback
    // every client has understood for twenty years; List-Unsubscribe-Post is
    // what turns Gmail's header into a one-tap "Unsubscribe" button that never
    // opens our page — and its absence is what makes people press "Report spam"
    // to achieve the same thing.
    headers['List-Unsubscribe'] = `<${msg.unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const body = {
    from: FROM,
    to: [to],
    subject: msg.subject,
    html: msg.html,
    text: msg.text ?? '',
  };
  if (REPLY_TO) body.reply_to = REPLY_TO;
  if (Object.keys(headers).length) body.headers = headers;
  if (msg.tags?.length) {
    // Resend's tag values are restricted to ASCII letters, digits, _ and -.
    body.tags = msg.tags.slice(0, 5).map((t) => ({
      name: 'category',
      value: String(t).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60),
    }));
  }

  const reqHeaders = {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (msg.idempotencyKey) reqHeaders['Idempotency-Key'] = String(msg.idempotencyKey).slice(0, 256);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // 422 on a send is almost always the address itself (Resend validates
      // syntax and known-invalid domains before accepting). Suppress it: the
      // student typed it wrong at signup and it will never work, and retrying
      // it forever is how a domain's bounce rate climbs.
      if (res.status === 422 && /invalid|not.*valid/i.test(detail)) {
        await suppress(to, 'invalid_address', SCOPE_ALL);
      }
      console.warn(`[email] send failed (${res.status}) to ${maskEmail(to)}: ${detail.slice(0, 300)}`);
      return { ok: false, reason: 'http', status: res.status };
    }

    const data = await res.json().catch(() => ({}));
    return { ok: true, id: data?.id ?? null };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? 'timeout' : 'network';
    console.warn(`[email] send ${reason} to ${maskEmail(to)}: ${err?.message ?? err}`);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
