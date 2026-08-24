// Vendor password recovery: POST /api/vendor/recover from the terminal's
// "Forgot password?" form. Unauthenticated by necessity — the whole point is
// that the caller cannot sign in — so it is mounted OUTSIDE src/routes/vendor.js
// (whose router-level requireVendor would 401 every request here) and given its
// own tight limiter in server.js.
//
// TWO DOORS MINT A CODE (migration-047), and this file holds one of them:
//   • POST /request, below — self-serve. The vendor types their address and the
//     code is mailed to it. No operator involved. This is the everyday path.
//   • POST /api/admin/vendors/:id/reset-code — the operator mints one by hand
//     and reads it down the phone. Still here, because it is the only thing
//     that works for a vendor who has lost the mailbox as well as the password.
// Both land in the same table and are spent by the same endpoint below.
//
// What stands between this endpoint and a stolen terminal:
//   1. a code that exists only because someone proved control of the vendor's
//      registered mailbox, or because the operator recognised a voice,
//   2. a 30-minute expiry (migration-031),
//   3. a 5-guess cap charged ATOMICALLY inside vendor_reset_begin, so rotating
//      IPs past the per-IP limiter still can't buy extra guesses,
//   4. 29^8 codes, which makes guessing the least attractive option by far.
//
// Every failure — unknown address, no live code, expired, burned, wrong code,
// lost race — returns the SAME 400. The endpoint is public, so distinguishing
// them would turn it into an oracle for which addresses are vendor logins.

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '../lib/supabase.js';
import { generateResetCode, normalizeResetCode } from '../lib/reset-codes.js';
import { sendEmail, emailUrl, emailEnabled, maskEmail } from '../lib/email.js';
import { vendorResetCode } from '../lib/email-templates.js';

const router = Router();

// Keep in sync with src/routes/apply.js — the same account, the same rules, and
// bcrypt only reads the first 72 bytes (refuse longer rather than silently
// truncating, which would make the stored password shorter than what was typed).
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;
const EMAIL_MAX = 254;

// Guesses allowed per issued code. One attempt past this consumes the code
// outright inside the RPC.
const MAX_ATTEMPTS = 5;

// A real bcrypt hash at the same cost factor the admin route mints with (10), so
// comparing against it costs what a genuine comparison costs. Used to level the
// response time on the "no live code" branch — see below. It is not a secret and
// matches nothing: it's bcrypt of a random string, discarded.
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

// The single response for every way this can fail. Deliberately vague.
const INVALID = {
  error: 'RESET_INVALID',
  message: 'That code isn’t valid, has expired, or has already been used. Ask for a new one.',
};

/**
 * The request-shape policy, as a pure function so every branch is testable
 * without a database (same approach as consentRejection in middleware/auth.js).
 *
 * Returns { rejection: {status, body} } to refuse, or the cleaned
 * { email, code, newPassword } to proceed with.
 *
 * Note which failures are specific and which are vague. Password rules ARE
 * reported precisely: they leak nothing about whether an account or a code
 * exists, and a vendor retyping blind against "invalid" — which could mean six
 * different things — is a bad time on a busy counter. Everything touching the
 * code or the address collapses into INVALID.
 */
export function validateRecoverInput(body) {
  const b = body ?? {};
  const email = String(b.email ?? '').trim().toLowerCase();
  const newPassword = typeof b.newPassword === 'string' ? b.newPassword : '';

  if (newPassword.length < PASSWORD_MIN) {
    return {
      rejection: {
        status: 400,
        body: { error: 'BAD_PASSWORD', message: `Password must be at least ${PASSWORD_MIN} characters.` },
      },
    };
  }
  if (newPassword.length > PASSWORD_MAX) {
    return {
      rejection: {
        status: 400,
        body: { error: 'BAD_PASSWORD', message: `Password must be ${PASSWORD_MAX} characters or fewer.` },
      },
    };
  }

  // A malformed code can't match anything in the code space, so it isn't a guess
  // and isn't charged against the cap — otherwise a vendor whose keyboard slipped
  // in a stray character would burn one of only five real attempts.
  const code = normalizeResetCode(b.code);
  if (!email || email.length > EMAIL_MAX || !code) {
    return { rejection: { status: 400, body: INVALID } };
  }

  return { email, code, newPassword };
}

// How long a self-serve code lives, and how long before the same login may ask
// for another. Kept in sync with RESET_TTL_MINUTES in src/routes/admin.js: one
// code, one lifetime, whichever door minted it.
const SELF_TTL_MINUTES = 30;
// The cooldown is NOT mainly about mailbombing. vendor_reset_request supersedes
// any outstanding code, so without it anyone who knows a vendor's address can
// invalidate that vendor's live code on repeat and keep them locked out of their
// own recovery. Two minutes is long enough to make that useless and short
// enough that a vendor who lost the first mail to a spam folder can retry.
const SELF_COOLDOWN_SECONDS = 120;

/**
 * POST /api/vendor/recover/request  { email }
 *
 * Self-serve half of recovery (migration-047): mint a code and mail it, with no
 * operator in the loop. The operator-minted path in /admin stays for the vendor
 * who has lost the mailbox too.
 *
 * ALWAYS ANSWERS 200 with the same body. Unknown address, a student account at
 * that address, a vendor still inside the cooldown, a mail API having a bad
 * minute: identical. This endpoint is public and unauthenticated, so any
 * observable difference between those cases turns it into a directory of which
 * addresses are vendor logins. Same rule the verify endpoint below follows for
 * the same reason; the operator gets the real story in the server log.
 */
router.post('/request', async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();

    // The uniform answer. Built once so no branch can accidentally differ.
    const ACCEPTED = {
      ok: true,
      message: 'If that email runs a spot on WeRewards, a reset code is on its way. It lasts 30 minutes.',
    };

    if (!email || email.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.json(ACCEPTED);
    }
    // With no mail transport there is no self-serve channel at all, and minting
    // a code nobody can read would only supersede one the operator just read
    // down the phone. Answer identically and mint nothing.
    if (!emailEnabled) {
      console.warn('[recover] self-serve request but email is not configured — set RESEND_API_KEY / EMAIL_FROM');
      return res.json(ACCEPTED);
    }

    const code = generateResetCode();
    const codeHash = await bcrypt.hash(normalizeResetCode(code), 10);

    const { data, error } = await supabaseAdmin.rpc('vendor_reset_request', {
      p_email: email,
      p_code_hash: codeHash,
      p_ttl_minutes: SELF_TTL_MINUTES,
      p_cooldown_seconds: SELF_COOLDOWN_SECONDS,
    });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    // Zero rows: not a vendor login. One row with reset_throttled: a vendor, but
    // one who asked moments ago and already has a live code in their inbox.
    // Neither sends mail, and neither is visible to the caller.
    if (!row || row.reset_throttled || !row.reset_id) {
      if (row?.reset_throttled) console.log(`[recover] self-serve throttled for ${maskEmail(email)}`);
      return res.json(ACCEPTED);
    }

    const mail = vendorResetCode({
      businessName: row.reset_vendor_name,
      code,
      ttlMinutes: SELF_TTL_MINUTES,
      terminalUrl: emailUrl('/vendor/', req),
      // Changes the copy to name the request and add the "wasn't you?" line —
      // the operator-minted version is answering a phone call the vendor made,
      // this one may be arriving unasked.
      selfServe: true,
    });
    const sent = await sendEmail({
      to: row.reset_email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      category: 'transactional',
      // Per RESET ROW, not per address: every request that gets this far minted
      // a NEW code, and de-duplicating two of them would mail the first code in
      // answer to the second request.
      idempotencyKey: `reset:${row.reset_id}`,
      tags: ['vendor-reset'],
    });
    if (!sent.ok) {
      // The code is live and the caller has been told it is coming. Nothing can
      // be done for them in this response without leaking whether they exist, so
      // the log is where this has to be visible.
      console.error(`[recover] could not mail self-serve code to ${maskEmail(row.reset_email)}: ${sent.reason}`);
    }
    return res.json(ACCEPTED);
  } catch (err) {
    next(err);
  }
});

/** POST /api/vendor/recover  { email, code, newPassword } */
router.post('/', async (req, res, next) => {
  try {
    const parsed = validateRecoverInput(req.body);
    if (parsed.rejection) {
      return res.status(parsed.rejection.status).json(parsed.rejection.body);
    }
    const { email, code, newPassword } = parsed;

    // Charges an attempt and hands back the hash in one statement. Zero rows =
    // no live code for that address (unknown, expired, or already spent).
    const { data: begun, error: beginErr } = await supabaseAdmin.rpc('vendor_reset_begin', {
      p_email: email,
      p_max_attempts: MAX_ATTEMPTS,
    });
    if (beginErr) throw beginErr;

    const pending = Array.isArray(begun) ? begun[0] : begun;
    if (!pending || pending.reset_burned || !pending.reset_code_hash) {
      // Burn a comparable amount of time before answering. Without this, the
      // only branch that runs bcrypt is the one where a live code exists, and
      // the response-time difference tells an unauthenticated caller "a reset is
      // currently outstanding for this address" — re-opening, as a timing
      // channel, exactly the disclosure the uniform INVALID body closes.
      await bcrypt.compare(code, DUMMY_HASH);
      return res.status(400).json(INVALID);
    }

    const ok = await bcrypt.compare(code, pending.reset_code_hash);
    if (!ok) return res.status(400).json(INVALID);

    // Spend the code BEFORE changing the password, and only proceed if this
    // request is the one that claimed it. Doing it in this order means a failure
    // in the step below costs the vendor another phone call, whereas the reverse
    // order would leave a known-good code live after a successful reset if the
    // consume call were the one to fail.
    const { data: claimed, error: consumeErr } = await supabaseAdmin.rpc('vendor_reset_consume', {
      p_id: pending.reset_id,
    });
    if (consumeErr) throw consumeErr;
    if (!claimed) return res.status(400).json(INVALID);

    const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(pending.reset_user_id, {
      password: newPassword,
    });
    if (pwErr) {
      // The code is already spent, so tell them plainly to get another rather
      // than letting them retype into a dead code.
      console.error('vendor recover updateUserById failed:', pwErr.message);
      return res.status(500).json({
        error: 'RESET_FAILED',
        message: 'Couldn’t set the new password. Ask for a new code and try again.',
      });
    }

    // Anyone holding a PIN session for this login is holding it on a device the
    // vendor may have just lost access to — that is often exactly why they are
    // resetting. Drop them so the next redeem/manage action re-asks for the PIN.
    // Non-fatal: the password is already changed, and a stale session expires on
    // its own within the shift.
    //
    // Read the error off the result rather than catching a rejection: a
    // supabase-js query builder RESOLVES with { data, error } and only rejects on
    // a transport failure, so a rejection handler here would silently swallow
    // every database-level failure it looks like it is reporting.
    const { error: pinErr } = await supabaseAdmin
      .from('vendor_pin_sessions')
      .delete()
      .eq('user_id', pending.reset_user_id);
    if (pinErr) console.error('vendor recover pin-session cleanup failed:', pinErr.message);

    // Safe to name the vendor now: they proved possession of the code.
    const { data: vendor } = await supabaseAdmin
      .from('vendors')
      .select('name')
      .eq('id', pending.reset_vendor_id)
      .maybeSingle();

    res.json({ ok: true, vendorName: vendor?.name ?? null });
  } catch (err) {
    next(err);
  }
});

export default router;
