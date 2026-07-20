import { supabaseAuth, supabaseAdmin } from '../lib/supabase.js';
import { TERMS_VERSION } from '../lib/terms.js';

/**
 * Verifies the Supabase access token from `Authorization: Bearer <jwt>`.
 * Attaches req.user = { id, email }.
 */
export async function requireUser(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'NO_TOKEN', message: 'Sign in required.' });

    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'BAD_TOKEN', message: 'Session expired. Sign in again.' });
    }
    // `name` mirrors what schema.sql's handle_new_user trigger used to read
    // (raw_user_meta_data->>'full_name'); POST /api/me/accept-terms now creates
    // the profile, so it needs the same Google display name the trigger had.
    const meta = data.user.user_metadata ?? {};
    req.user = {
      id: data.user.id,
      email: data.user.email,
      name: meta.full_name ?? meta.name ?? null,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Confirms the student has accepted the CURRENT Terms and Privacy Policy.
 * Attaches req.profile.
 *
 * MOUNT AFTER requireUser — it reads req.user and does not re-verify the token
 * (getUser is a network round-trip to Supabase; doing it twice per request
 * would tax every student call).
 *
 * This is the real consent gate. The sign-in modal is a UI affordance and can be
 * dismissed with devtools; this cannot. Since migration-022 dropped the
 * auto-create trigger, a signed-in user with no profile row is someone who
 * authenticated but never agreed — they get the same 403 as someone whose
 * consent is stale, and the app shows them the modal either way.
 *
 * 403 is deliberately distinct from 401: the token is valid, so the client must
 * NOT sign them out and retry — it must prompt for consent.
 */
/**
 * The consent policy itself, as a pure function so every branch is testable
 * without a database. Returns null when the student may proceed, or the {status,
 * body} to reject with.
 *
 * @param {object|null} profile  the profiles row, or null if none exists
 * @param {string} currentVersion  TERMS_VERSION
 */
export function consentRejection(profile, currentVersion = TERMS_VERSION) {
  // No row at all = signed in via OAuth but never accepted, so no account was
  // ever created (migration-022). Same outcome as a row with a null timestamp.
  if (!profile || !profile.terms_accepted_at) {
    return {
      status: 403,
      body: {
        error: 'CONSENT_REQUIRED',
        message: 'Accept the Terms and Privacy Policy to continue.',
        termsVersion: currentVersion,
      },
    };
  }
  if (profile.terms_version !== currentVersion) {
    return {
      status: 403,
      body: {
        error: 'CONSENT_STALE',
        message: 'Our Terms have changed. Review and accept them to continue.',
        termsVersion: currentVersion,
      },
    };
  }
  return null;
}

export async function requireConsent(req, res, next) {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'NO_TOKEN', message: 'Sign in required.' });
    }
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('user_id, name, email, terms_accepted_at, terms_version')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;

    const rejection = consentRejection(profile, TERMS_VERSION);
    if (rejection) return res.status(rejection.status).json(rejection.body);

    req.profile = profile;
    next();
  } catch (err) {
    next(err);
  }
}

// Operator allowlist for the /admin dashboard. Comma-separated emails in the
// ADMIN_EMAILS env var; matched case-insensitively against the signed-in user.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/**
 * requireUser + confirms the signed-in user is a platform operator (their email
 * is in ADMIN_EMAILS). Gates the /api/admin/* analytics + error-log routes. The
 * gate is server-side: the static /admin page is public, but its data isn't.
 */
export async function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    const email = (req.user?.email || '').toLowerCase();
    if (!email || !ADMIN_EMAILS.includes(email)) {
      return res.status(403).json({ error: 'NOT_ADMIN', message: 'Admin access only.' });
    }
    next();
  });
}

/**
 * requireUser + confirms the user is staff of a vendor.
 * Attaches req.vendor = the vendor row.
 *
 * An account may be staff of more than one vendor (multi-location owners). We
 * resolve deterministically rather than picking an arbitrary row: exactly one
 * link → use it; multiple links → the client must name the vendor via an
 * `X-Vendor-Id` header (validated against membership), else it's ambiguous.
 */
export async function requireVendor(req, res, next) {
  requireUser(req, res, async () => {
    try {
      const { data: staff, error } = await supabaseAdmin
        .from('vendor_staff')
        .select('vendor_id, vendors(*)')
        .eq('user_id', req.user.id);

      if (error) throw error;

      const links = (staff ?? []).filter((s) => s.vendors);
      if (!links.length) {
        return res.status(403).json({ error: 'NOT_VENDOR', message: 'This account is not linked to a vendor.' });
      }

      let chosen;
      if (links.length === 1) {
        chosen = links[0];
      } else {
        const requested = req.headers['x-vendor-id'];
        chosen = requested ? links.find((s) => s.vendor_id === requested) : null;
        if (!chosen) {
          return res.status(400).json({
            error: 'VENDOR_AMBIGUOUS',
            message: 'This account manages multiple vendors — specify which one.',
          });
        }
      }

      // Operator kill-switch: a vendor toggled off in the admin portal is fully
      // cut off. Every /api/vendor/* route runs through here, so a single gate
      // stops the terminal cold — no config, scan, award, redeem, or manage —
      // the same way active=true hides the vendor from students. Data is
      // preserved (balances/rewards untouched), so flipping it back on restores
      // everything.
      if (chosen.vendors.active === false) {
        return res.status(403).json({
          error: 'VENDOR_DISABLED',
          message: 'This vendor has been deactivated. Contact the WeRewards team.',
        });
      }

      req.vendor = chosen.vendors;
      next();
    } catch (err) {
      next(err);
    }
  });
}

// A PIN session also drops after this many minutes of inactivity, so an
// unattended terminal re-asks for the PIN even inside the 8-hour shift window
// (PIN_SESSION_HOURS in routes/vendor.js is the absolute cap; this is idle).
const PIN_IDLE_MINUTES = 30;

/**
 * Gates the sensitive vendor routes (redeem + manage) behind the staff PIN.
 * Must run AFTER requireVendor (needs req.vendor + req.user). Vendors without a
 * PIN configured are not gated. Otherwise the terminal must present the session
 * token minted by POST /verify-pin, sent as the `X-Vendor-Pin` header.
 *
 * A session must be BOTH within its absolute expiry (expires_at) AND used within
 * the last PIN_IDLE_MINUTES; each successful check slides last_used_at forward.
 */
export async function requirePin(req, res, next) {
  try {
    if (!req.vendor?.pin_hash) return next(); // no PIN set for this vendor → not gated

    const token = req.headers['x-vendor-pin'];
    if (!token) {
      return res.status(401).json({ error: 'PIN_REQUIRED', message: 'Enter the staff PIN to continue.' });
    }

    const now = new Date();
    const idleCutoff = new Date(now.getTime() - PIN_IDLE_MINUTES * 60 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
      .from('vendor_pin_sessions')
      .select('token')
      .eq('token', token)
      .eq('vendor_id', req.vendor.id)
      .eq('user_id', req.user.id)
      .gt('expires_at', now.toISOString()) // absolute 8-hour shift cap
      .gt('last_used_at', idleCutoff)       // idle timeout
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(401).json({ error: 'PIN_REQUIRED', message: 'Enter the staff PIN to continue.' });
    }

    // Sliding window: this successful use resets the idle clock. Non-fatal if it
    // fails — the request is already authorized, and a stale last_used_at only
    // risks an early re-prompt, never an over-long session.
    await supabaseAdmin
      .from('vendor_pin_sessions')
      .update({ last_used_at: now.toISOString() })
      .eq('token', token);

    next();
  } catch (err) {
    next(err);
  }
}
