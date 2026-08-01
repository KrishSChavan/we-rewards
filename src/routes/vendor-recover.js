// Vendor password recovery: POST /api/vendor/recover from the terminal's
// "Forgot password?" form. Unauthenticated by necessity — the whole point is
// that the caller cannot sign in — so it is mounted OUTSIDE src/routes/vendor.js
// (whose router-level requireVendor would 401 every request here) and given its
// own tight limiter in server.js.
//
// What stands between this endpoint and a stolen terminal:
//   1. a code that only exists because the operator minted one by hand in /admin
//      and read it down the phone to someone they recognised,
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
import { normalizeResetCode } from '../lib/reset-codes.js';

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
