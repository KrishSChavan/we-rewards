// Resend delivery events: POST /api/webhooks/resend.
//
// WHY THIS EXISTS AT ALL. src/lib/push.js prunes a push endpoint the moment a
// push service answers 404/410, because paying forever for a send that can
// never land is worse than not sending. Email has the same problem with worse
// consequences and no synchronous answer: the API accepts a message, and the
// mailbox rejects it seconds later out of band. Without a webhook we would never
// find out, keep mailing dead addresses, and watch the domain's reputation
// decay until the PASSWORD RESETS stop arriving too.
//
// Two events change anything here:
//   email.bounced     — a PERMANENT bounce means the mailbox does not exist.
//                       Suppressed at 'all'. A transient one (full inbox, a
//                       greylisting server) is ignored: that address works, and
//                       suppressing it would lock a real vendor out of recovery.
//   email.complained  — someone pressed "Report spam". Suppressed at 'all' and
//                       never automatically un-suppressed, because a complaint
//                       is the strongest possible statement that we should stop.
//
// Everything else (delivered, opened, clicked, delayed) is acknowledged and
// dropped. We do not need the analytics, and storing per-message open data
// about students is a privacy cost with no matching benefit.
//
// UNAUTHENTICATED but SIGNED. This is a public URL that can suppress an email
// address, so a forged request is a denial-of-service against a vendor's
// recovery. Every request must carry a valid Svix signature; without a
// configured secret the endpoint refuses everything rather than trusting the
// caller.

import { Router } from 'express';
import crypto from 'node:crypto';
import { suppress, maskEmail } from '../lib/email.js';

const router = Router();

const SECRET = process.env.RESEND_WEBHOOK_SECRET || '';

// Svix rejects anything older than five minutes, and so do we: without a
// freshness bound, one captured request can be replayed forever.
const TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Verify a Svix signature (the scheme Resend uses).
 *
 * The signed payload is `${id}.${timestamp}.${body}`, HMAC-SHA256 with the
 * secret's base64 half (everything after the `whsec_` prefix). The header holds
 * one or more space-separated `v1,<base64>` pairs, because Svix supports key
 * rotation by signing with old and new at once — so ANY match is a pass.
 *
 * @param {string} raw  the exact bytes that were signed. Re-serialising a parsed
 *   body would change key order and whitespace and never match.
 */
export function verifySvix(raw, headers, secret = SECRET, now = Date.now()) {
  if (!secret) return { ok: false, reason: 'unconfigured' };

  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signature = headers['svix-signature'];
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' };

  const sentAt = Number(timestamp) * 1000;
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > TOLERANCE_MS) {
    return { ok: false, reason: 'stale' };
  }

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key)
    .update(`${id}.${timestamp}.${raw}`)
    .digest();

  for (const part of String(signature).split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    const got = Buffer.from(value, 'base64');
    // Length-guard first: timingSafeEqual throws rather than returning false
    // when the buffers differ in size.
    if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'bad_signature' };
}

/**
 * Is this bounce permanent?
 *
 * Resend passes the provider's own classification through, and providers do not
 * agree on spelling: SES says `Permanent`, others `hard` or `HardBounce`. Match
 * loosely, and treat anything unrecognised as TRANSIENT — the safe default is
 * to keep an address we are unsure about, since a wrongly suppressed one costs
 * a vendor their password reset.
 */
export function isPermanentBounce(data) {
  const bounce = data?.bounce ?? {};
  const type = String(bounce.type ?? data?.type ?? '').toLowerCase();
  const sub = String(bounce.subType ?? bounce.sub_type ?? '').toLowerCase();
  if (/permanent|hard/.test(type)) return true;
  // SES's "suppressed" sub-type means the address is on the provider's own
  // permanent list, which is as final as a hard bounce.
  return /suppressed|nonexistent|no_?email|invalid/.test(sub);
}

/**
 * Decide what one event means. Pure, so test/email.test.js can cover the whole
 * decision table without a signature or a database.
 *
 * @returns {{suppress: boolean, scope?: string, reason?: string}}
 */
export function classifyEvent(type, data) {
  if (type === 'email.complained') return { suppress: true, scope: 'all', reason: 'complained' };
  if (type === 'email.bounced' && isPermanentBounce(data)) {
    return { suppress: true, scope: 'all', reason: 'bounced' };
  }
  return { suppress: false };
}

/** POST /api/webhooks/resend — mounted with a raw body parser (see server.js). */
router.post('/resend', async (req, res, next) => {
  try {
    // req.body is a Buffer here, not an object: the signature covers the exact
    // bytes Resend sent.
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
    const check = verifySvix(raw, req.headers);
    if (!check.ok) {
      if (check.reason === 'unconfigured') {
        console.warn('[email] webhook received but RESEND_WEBHOOK_SECRET is unset — ignoring');
      }
      // 401 rather than 400: Svix retries a 5xx and gives up on a 4xx, and an
      // unverifiable request should never be retried.
      return res.status(401).json({ error: 'BAD_SIGNATURE' });
    }

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: 'BAD_JSON' });
    }

    const verdict = classifyEvent(event?.type, event?.data);
    if (verdict.suppress) {
      // `to` is an array on every Resend event. One bad address in a batch
      // should suppress that address and no other.
      const recipients = Array.isArray(event?.data?.to)
        ? event.data.to
        : [event?.data?.to].filter(Boolean);
      for (const address of recipients) {
        await suppress(address, verdict.reason, verdict.scope);
        console.warn(`[email] suppressed ${maskEmail(address)} (${verdict.reason})`);
      }
    }

    // Always 200 for a signed event, even one we ignored. A non-2xx puts the
    // event into Svix's retry schedule and, after enough of them, disables the
    // endpoint — losing the bounces that actually matter.
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
