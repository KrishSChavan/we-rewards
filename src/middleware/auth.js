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
 */
export async function requireVendor(req, res, next) {
  requireUser(req, res, async () => {
    try {
      const { data: staff, error } = await supabaseAdmin
        .from('vendor_staff')
        .select('vendor_id, vendors(*)')
        .eq('user_id', req.user.id)
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      if (!staff?.vendors) {
        return res.status(403).json({ error: 'NOT_VENDOR', message: 'This account is not linked to a vendor.' });
      }
      req.vendor = staff.vendors;
      next();
    } catch (err) {
      next(err);
    }
  });
}
