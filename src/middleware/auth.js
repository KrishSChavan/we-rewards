import { supabaseAdmin } from '../lib/supabase.js';
import { resolveUserFromToken } from '../lib/jwt.js';
import { TERMS_VERSION } from '../lib/terms.js';
import { isTerminalAdmin, chooseAdminVendorId } from '../lib/terminal-admin.js';

/**
 * Reads `Authorization: Bearer <jwt>` and resolves it to a user, attaching
 * req.user = { id, email, name, providers, emailVerified, isAnonymous } — the
 * last three describe how the account authenticates and are only consulted by
 * adminRejection below.
 *
 * Returns null when the request may proceed, or the {status, body} to reject
 * with. Written as a plain function rather than middleware so the gates below
 * can compose it with `await` instead of nesting callbacks — the old nesting
 * passed its own error channel in as the downstream `next`, so an unexpected
 * throw during verification ran the downstream gate with no req.user.
 *
 * The token is checked locally against the project's signing key (see
 * lib/jwt.js); `strict` forces the authoritative GoTrue round-trip instead,
 * which additionally catches a session revoked before its token expired.
 */
async function authenticate(req, { strict = false } = {}) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) {
    return { status: 401, body: { error: 'NO_TOKEN', message: 'Sign in required.' } };
  }

  const user = await resolveUserFromToken(token, { strict });
  if (!user) {
    return { status: 401, body: { error: 'BAD_TOKEN', message: 'Session expired. Sign in again.' } };
  }

  req.user = user;
  return null;
}

/**
 * Verifies the Supabase access token from `Authorization: Bearer <jwt>`.
 * Attaches req.user = { id, email, name }.
 */
export async function requireUser(req, res, next) {
  try {
    const rejection = await authenticate(req);
    if (rejection) return res.status(rejection.status).json(rejection.body);
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
 * (verification already happened once for this request; there is nothing a
 * second check could learn).
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
 * Is this address on the operator allowlist? Not a gate — adminRejection below
 * is the gate, and it checks more than the address. This is for LABELLING a
 * known user (e.g. naming who an error log belongs to), where the only question
 * is whether the address is one of ours.
 */
export const isAdminEmail = (email) =>
  !!email && ADMIN_EMAILS.includes(String(email).toLowerCase());

// Identity providers accepted for /admin. The dashboard offers exactly one way
// in — signInWithOAuth({ provider: 'google' }) in public/admin/admin.js — so a
// real operator session always carries a Google identity.
const ADMIN_PROVIDERS = ['google'];

// One body for every denial. Which check failed is deliberately NOT visible to
// the caller: a distinct code for "right email, wrong provider" would confirm
// that an address is on the allowlist. The reason is logged instead.
//
// Frozen because every denial hands out this same object — a route that mutated
// what it got back would rewrite the constant for every later request.
const NOT_ADMIN_BODY = Object.freeze({ error: 'NOT_ADMIN', message: 'Admin access only.' });

/**
 * @param {string} reason  for the server log, never the response
 * @param {boolean} log    whether it's safe and useful to log — true only once
 *   the email is known to be allowlisted, so no one can write chosen text into
 *   the log by presenting a token for an address of their choosing.
 */
const deny = (reason, log) => ({ status: 403, body: NOT_ADMIN_BODY, reason, log });

/**
 * Decides whether an authenticated user may use /api/admin/*. Returns null to
 * allow, or {status, body, reason} to deny. A pure function so every branch is
 * testable without a token, a network, or an env var.
 *
 * The allowlist alone used to be the whole gate, which made it lean on a setting
 * that lives in the Supabase dashboard rather than in this repo: with
 * `mailer_autoconfirm` on, anyone can sign up through the public GoTrue endpoint
 * with any email that isn't registered yet — including an operator address —
 * and get a confirmed session carrying it. So we also require the account to
 * have reached us through the provider the dashboard actually uses.
 *
 * DENIES ONLY ON A POSITIVE SIGNAL. `providers: []` and `emailVerified: null`
 * both mean "GoTrue didn't tell us", and neither denies. That asymmetry is the
 * point: an email/password account states `['email']` and an unconfirmed one
 * states `false`, so the path this closes is caught by an affirmative answer,
 * while missing data can never lock the operator out of their own dashboard.
 *
 * @param {object|null} user  req.user, as built by lib/jwt.js
 */
export function adminRejection(user, { allowlist = ADMIN_EMAILS, providers = ADMIN_PROVIDERS } = {}) {
  const email = (user?.email || '').toLowerCase();
  if (!email || !allowlist.includes(email)) {
    return deny('email is not on the allowlist', false);
  }

  // Past this point the email matched, so it is one of our own configured
  // values and `log: true` is safe.
  if (user.isAnonymous === true) {
    return deny('anonymous session', true);
  }
  if (user.emailVerified === false) {
    return deny('email address is not confirmed', true);
  }

  const known = Array.isArray(user.providers) ? user.providers : [];
  if (known.length && !known.some((p) => providers.includes(p))) {
    return deny(`signed in via ${known.join('/')}, but /admin requires ${providers.join('/')}`, true);
  }

  return null;
}

/**
 * requireUser + confirms the signed-in user is a platform operator (see
 * adminRejection). Gates the /api/admin/* analytics + error-log routes. The gate
 * is server-side: the static /admin page is public, but its data isn't.
 *
 * Authenticates in `strict` mode — the one gate that still pays for a GoTrue
 * round-trip per request. These routes read every student's activity and the
 * error log, there is exactly one operator hitting them, and strict mode means
 * signing out actually ends the admin session immediately rather than at the
 * token's next expiry. Nowhere near a hot path, so the latency is free. It also
 * means adminRejection sees the authoritative identity data — an access token
 * carries no confirmation timestamp and no `identities[]`.
 */
export async function requireAdmin(req, res, next) {
  try {
    const rejection = await authenticate(req, { strict: true });
    if (rejection) return res.status(rejection.status).json(rejection.body);

    const denial = adminRejection(req.user);
    if (denial) {
      // denial.log is set only for allowlisted addresses, and that's the case
      // worth seeing: either the operator is locked out and needs to know why,
      // or someone reached an operator address by a route the dashboard doesn't
      // offer. A wrong email is just noise, and logging it would let anyone
      // write text of their choosing into the log.
      if (denial.log) console.warn(`[admin] denied ${req.user.email} — ${denial.reason}`);
      return res.status(denial.status).json(denial.body);
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Which vendor a request is about, given this account's staff links and the
 * X-Vendor-Id header. Returns the chosen link, or null when the request hasn't
 * said and there is more than one answer. Pure, so every branch is testable
 * without a database.
 *
 * ONE LINK → that one, header ignored. A single-location vendor's terminal never
 * has to know its own vendor id, which is what keeps every client that predates
 * multi-location working unchanged — and a stale remembered id (the vendor sold
 * a shop, the operator unlinked one) can't lock the survivor out either.
 *
 * SEVERAL LINKS → the header must name one this account actually holds. Never
 * guessed: picking whichever row the database listed first would ring a sale up
 * at the wrong store, and the vendor would have no way to tell.
 */
export function chooseVendorLink(links, requestedId) {
  if (links.length === 1) return links[0];
  if (!requestedId) return null;
  return links.find((s) => s.vendor_id === requestedId) ?? null;
}

/**
 * requireUser + confirms the user is staff of a vendor.
 * Attaches req.vendor = the vendor row.
 *
 * An account may be staff of more than one vendor (multi-location owners, see
 * migration-043). chooseVendorLink above resolves which one; GET
 * /api/vendor/locations is how a client learns what it may name.
 */
export async function requireVendor(req, res, next) {
  try {
    const rejection = await authenticate(req);
    if (rejection) return res.status(rejection.status).json(rejection.body);

    // ---- Operator impersonation (lib/terminal-admin.js) ----
    //
    // BEFORE the vendor_staff lookup, and that ordering is load-bearing rather
    // than tidy. chooseVendorLink below has a "this account runs exactly one
    // shop, so the header is redundant" case; if the operator's account ever
    // acquired a single vendor_staff row — onboarded as a test vendor, linked by
    // mistake — falling through to it would IGNORE X-Vendor-Id entirely and
    // silently ring every sale up at that one shop while the terminal's header
    // named a different business. Branching first means that path cannot be
    // reached by an operator at all.
    if (isTerminalAdmin(req.user.email)) {
      const vendorId = chooseAdminVendorId(req.headers['x-vendor-id']);
      if (!vendorId) {
        // Never guessed. Distinct from VENDOR_AMBIGUOUS because the client's
        // answer is different: a vendor is told to name one of THEIR stores,
        // an operator is told to pick from every store on the platform.
        return res.status(400).json({
          error: 'ADMIN_PICK_VENDOR',
          message: 'Choose which vendor to open from the menu.',
        });
      }

      const { data: vendor, error: vendorErr } = await supabaseAdmin
        .from('vendors')
        .select('*')
        .eq('id', vendorId)
        .maybeSingle();
      if (vendorErr) throw vendorErr;
      if (!vendor) {
        return res.status(404).json({ error: 'VENDOR_NOT_FOUND', message: 'That vendor no longer exists.' });
      }

      // NO active check, unlike the vendor path below. The kill-switch exists to
      // stop a vendor selling; the operator is the one who threw it, and a spot
      // they cannot open is a spot they cannot diagnose or fix. The terminal
      // labels it instead (see paintAdminChrome in public/vendor/terminal.js).
      req.vendor = vendor;
      // Read by requirePin (which the operator does not have to satisfy — they
      // cannot know each shop's bcrypt-hashed PIN) and by the routes that want
      // to say an action was an operator's. Set ONLY here.
      req.terminalAdmin = true;
      return next();
    }

    const { data: staff, error } = await supabaseAdmin
      .from('vendor_staff')
      .select('vendor_id, vendors(*)')
      .eq('user_id', req.user.id);

    if (error) throw error;

    const links = (staff ?? []).filter((s) => s.vendors);
    if (!links.length) {
      return res.status(403).json({ error: 'NOT_VENDOR', message: 'This account is not linked to a vendor.' });
    }

    const chosen = chooseVendorLink(links, req.headers['x-vendor-id']);
    if (!chosen) {
      return res.status(400).json({
        error: 'VENDOR_AMBIGUOUS',
        message: 'This account manages multiple vendors, specify which one.',
      });
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
    // The operator, acting as this vendor (see requireVendor). Not gated, and it
    // could not be: pin_hash is bcrypt, so there is nothing to look the PIN up
    // from, and every route this feature exists to reach — items, settings,
    // deals, redeem — sits behind this gate. Making them TYPE one would be worse
    // than useless: a wrong guess calls record_pin_result, which locks the
    // VENDOR (not the caller) after five failures (migration-020), so five idle
    // taps by an operator would take a real shop's redemptions offline mid-shift.
    if (req.terminalAdmin) return next();

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
