import { supabaseAuth, supabaseAdmin } from '../lib/supabase.js';

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
    req.user = { id: data.user.id, email: data.user.email };
    next();
  } catch (err) {
    next(err);
  }
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
