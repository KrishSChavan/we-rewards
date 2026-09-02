// Operator sign-in for the VENDOR TERMINAL — one env-configured email+password
// that can open any vendor's till at /terminal and work it as that vendor.
//
// This is deliberately a THIRD identity, separate from both of the two the app
// already had:
//
//   • A vendor login is a real Supabase account with vendor_staff rows. Its
//     authority is the rows, and it can only ever reach the shops it staffs.
//   • An /admin operator is a Google account on ADMIN_EMAILS. It reads the
//     platform and edits vendor RECORDS, but it has never been able to stand at
//     a till: adminRejection (middleware/auth.js) requires a Google identity,
//     which a terminal password login can never have, and requireVendor derives
//     authority from vendor_staff, which an operator holds none of.
//
// Kept out of ADMIN_EMAILS on purpose. That list is read-mostly and Google-gated;
// folding this into it would silently upgrade every dashboard operator to full
// WRITE access on every vendor's till, and there would be no way to grant one
// without the other. Two settings, two grants.
//
// ---- Why a real Supabase account, and not a token we mint ourselves ----
//
// The terminal is a Supabase client end to end: it signs in with
// signInWithPassword, authFetch re-reads the access token from the session on
// every call, and the server verifies it in lib/jwt.js. A bespoke operator token
// would have to be understood at every one of those points, and it would carry
// no auth.users id — which vendor_pin_sessions.user_id references with a foreign
// key (migration-007). So instead the account is REAL: provisioned from the env
// vars at boot, signed in through the ordinary login card, verified by the
// ordinary token path. Nothing downstream has to learn a new shape.
//
// The consequence worth stating: process.env is the source of truth for the
// password, so ensureTerminalAdmin re-syncs it on EVERY boot. Changing the
// config var and restarting is how you rotate it, and it is also why the
// terminal hides its own "Login password" card for this account — a change made
// there would be silently reverted by the next deploy.

import { isUuid } from './ids.js';

// Below this, refuse to configure at all. This credential is a single static
// secret in front of every shop's till, typed into a login form that is served
// to the whole internet with no authentication (the /terminal shell is public;
// only its DATA is gated). Sign-in goes to Supabase GoTrue rather than to this
// app, so none of the express-rate-limit ceilings in server.js apply to guessing
// it — GoTrue's own limits are the only brake. A short password here is
// therefore worse than no feature at all, and the boot check below says so out
// loud rather than quietly accepting one.
export const MIN_PASSWORD_LENGTH = 16;

// Stamped into the account's app_metadata at creation. Read back by the
// ownership check here, and — the reason it must never be renamed casually —
// matched by name in SQL by prune_unconsented_signups (migration-054), which
// would otherwise delete this account every night at 04:43 UTC.
export const ADMIN_FLAG = 'wr_terminal_admin';

// bcrypt reads the first 72 BYTES and silently ignores the rest, so a longer
// secret is not a stronger one — it just hides how much of it is load-bearing.
// Matches the ceiling the vendor password rules use (routes/apply.js).
export const MAX_PASSWORD_LENGTH = 72;

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * What boot made of the configured account. Three states, and the third is the
 * reason this exists rather than isTerminalAdmin reading the env alone:
 *
 *   null   nobody has asked — no ensureTerminalAdmin ran in this process. The
 *          env is the only evidence there is, so it decides. This is the path
 *          the unit tests and any `import { app }` harness take, and it is why
 *          they can drive the feature without a Supabase.
 *   true   boot provisioned the account and it is OURS.
 *   false  boot refused, or could not finish. NOBODY is the operator.
 *
 * The `false` state closes a hole the account-ownership check would otherwise
 * open. If TERMINAL_ADMIN_EMAIL is pointed at a REAL person's address — a typo,
 * or an operator reaching for the address they already use as a student —
 * ensureTerminalAdmin correctly refuses to reset their password. But refusing
 * leaves that person's own password working, and an env-only isTerminalAdmin
 * would then hand them every vendor's till the moment they signed into
 * /terminal. Declining to provision has to also mean declining to authorise.
 *
 * Set PESSIMISTICALLY, before ensureTerminalAdmin's first `await`, so it lands
 * in the same synchronous tick as server.listen() — there is no window in which
 * a request could be served while the answer is still pending. The cost is that
 * a Supabase hiccup at boot switches the feature off for the life of that dyno
 * rather than guessing; for one credential with write access to every shop on
 * the platform, failing closed is the only defensible default, and the boot line
 * says exactly that so a restart is an obvious remedy.
 */
let bootVerdict = null;

/**
 * Blank the secret out of a string bound for the log. Plain split/join rather
 * than a RegExp, because the password is arbitrary text and building a pattern
 * out of it would either need escaping or blow up on a metacharacter — in the
 * one code path whose whole job is to report that something already went wrong.
 */
export const redact = (message, secret) =>
  (secret ? String(message ?? '').split(secret).join('«password»') : String(message ?? ''));

/** For the boot log and the tests. Not a gate — isTerminalAdmin is the gate. */
export const terminalAdminBootVerdict = () => bootVerdict;

/** Test seam: put the module back to "no boot has run in this process". */
export function resetTerminalAdminBootVerdict() { bootVerdict = null; }

/**
 * The configured operator identity, or null when the feature is switched off.
 *
 * Off is the default and it is a REAL off: with either var unset there is no
 * account, no branch in requireVendor that can fire, and no way to reach the
 * code below. Setting both is the entire switch — there is no separate enable
 * flag to forget, and nothing to un-set on a deployment that never wants this.
 *
 * Pure over its argument so the tests can drive it without touching process.env.
 */
export function terminalAdminConfig(env = process.env) {
  const email = norm(env.TERMINAL_ADMIN_EMAIL);
  const password = String(env.TERMINAL_ADMIN_PASSWORD ?? '');
  if (!email && !password) return null;           // not configured at all

  // Half-configured is a mistake, never a state to run in. Answering null here
  // would look identical to "switched off" and the operator would spend the
  // afternoon wondering why their password doesn't work; the error carries.
  if (!email) return { error: 'TERMINAL_ADMIN_PASSWORD is set but TERMINAL_ADMIN_EMAIL is not.' };
  if (!password) return { error: 'TERMINAL_ADMIN_EMAIL is set but TERMINAL_ADMIN_PASSWORD is not.' };
  if (!email.includes('@')) return { error: 'TERMINAL_ADMIN_EMAIL is not an email address.' };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `TERMINAL_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { error: `TERMINAL_ADMIN_PASSWORD must be ${MAX_PASSWORD_LENGTH} characters or fewer.` };
  }
  return { email, password };
}

/**
 * Is this the operator's terminal login?
 *
 * The one invariant that matters: NEVER true when the feature is unconfigured.
 * A bare `email === process.env.TERMINAL_ADMIN_EMAIL` would answer true for the
 * empty string against an unset var, and the empty string is what an anonymous
 * or address-less session carries — which would hand every till on the platform
 * to anyone holding any token. Hence the explicit config check first, and hence
 * this function rather than an inline comparison at the two call sites.
 *
 * A misconfiguration (see the `error` branch above) is also NOT an admin: a
 * deployment that set a four-character password gets the feature switched off
 * and a boot warning, not a four-character password guarding every shop.
 */
export function isTerminalAdmin(email, env = process.env) {
  // Boot looked and said no — the address is somebody else's, or provisioning
  // never finished. See bootVerdict above; this is not an optimisation, it is
  // what stops a refusal-to-provision becoming a privilege escalation.
  if (bootVerdict === false) return false;
  const cfg = terminalAdminConfig(env);
  if (!cfg || cfg.error) return false;
  const candidate = norm(email);
  return Boolean(candidate) && candidate === cfg.email;
}

/**
 * Which vendor an operator's request is about.
 *
 * chooseVendorLink's counterpart, and deliberately NOT the same function. That
 * one has a "this account runs exactly one shop, so the header is redundant"
 * case, which is right for a vendor and would be a catastrophe here: an
 * operator holds no links, has every vendor available, and a guess would ring a
 * real sale up at a business nobody chose. So the header is the only signal,
 * it is never defaulted, and it is shape-checked before it is allowed near a
 * `uuid` column (an unchecked value throws 22P02 and surfaces as a 500).
 *
 * @returns {string|null} the vendor id to act as, or null to make the caller ask.
 */
export function chooseAdminVendorId(requestedId) {
  return isUuid(requestedId) ? requestedId : null;
}

/**
 * Find-or-create the operator's Supabase account and make its password match
 * the env var. Called once at boot from server.js; safe to call repeatedly.
 *
 * Returns a one-line status for the boot log — this feature fails QUIETLY
 * otherwise (an unprovisioned account just refuses the sign-in, which is
 * indistinguishable from a typo), so boot is the only place its state is
 * visible. Same reason the Resend / PostHog / Gemini lines exist there.
 *
 * Never throws: a Supabase hiccup at boot must not take the dyno down over a
 * feature only the operator uses. The account simply isn't there, sign-in fails,
 * and the log says why.
 */
export async function ensureTerminalAdmin({ supabaseAdmin, env = process.env, adminEmails = [] } = {}) {
  // Closed until proven open, and set here — before the first `await`, so it
  // lands in the same synchronous tick as server.listen() and there is no window
  // where a request is served while the answer is still in flight.
  bootVerdict = false;

  const cfg = terminalAdminConfig(env);
  if (!cfg) {
    return 'Terminal admin: off — set TERMINAL_ADMIN_EMAIL and TERMINAL_ADMIN_PASSWORD to sign into any vendor terminal';
  }
  if (cfg.error) return `Terminal admin: OFF — ${cfg.error}`;

  // A warning, not a refusal: it still works, and refusing would be a surprising
  // place to discover the rule. But it is worth a line, because reusing an
  // /admin address gives that Google account an email+password identity as well,
  // and a dashboard login that could previously only be taken by compromising
  // Google can then be taken by guessing this string instead. A dedicated
  // address costs nothing.
  const clash = adminEmails.map(norm).includes(cfg.email)
    ? '  ⚠  this address is also in ADMIN_EMAILS — use a dedicated one, or a guessed terminal password also opens /admin\n'
    : '';

  try {
    let userId = null;

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: cfg.email,
      password: cfg.password,
      email_confirm: true,
      // The account's own proof that WE made it, and it does two jobs.
      //
      // (1) It is how the ownership check below tells our account from a real
      //     person's. The obvious alternative — "no profile row and no
      //     vendor_staff row, so it must be ours" — is a guess, and it is wrong
      //     for exactly the address most likely to be typed here by mistake: an
      //     /admin operator's Google account has neither either, so the guess
      //     would adopt it and staple a password onto it.
      //
      // (2) It exempts the account from prune_unconsented_signups
      //     (migration-054). That nightly sweep deletes auth.users rows with no
      //     profile, no vendor_staff link and no consent record, which is
      //     precisely the shape of this account — so without the flag the
      //     operator login is created at boot and deleted at 04:43 UTC.
      app_metadata: { [ADMIN_FLAG]: true },
    });

    if (!error) {
      userId = data?.user?.id ?? null;
    } else if (error.code === 'email_exists' || error.status === 422) {
      // Already there — from a previous boot, or because the address belongs to
      // a real person's account. Same definer RPC the vendor onboarding path
      // uses (migration-031): auth.users is not readable by the API roles.
      const { data: existingId, error: lookupErr } = await supabaseAdmin
        .rpc('auth_user_id_by_email', { p_email: cfg.email });
      if (lookupErr) throw lookupErr;
      if (!existingId) throw new Error('account exists but could not be looked up');
      userId = existingId;

      // ---- is this OUR account, or a real person's? ----
      //
      // The next statement overwrites this account's password, and it runs on
      // every boot. On the second and every later boot that is exactly right —
      // the account is the one we made. But a typo'd env var, or an operator
      // reaching for an address that is already a student, a vendor or their own
      // /admin Google login, would point it at a REAL person and quietly reset
      // their password on every deploy.
      //
      // Answered from the flag we stamp at creation, NOT from "has no profile
      // and staffs no vendor": that inference is wrong for an /admin Google
      // account, which has neither, and which is the single most likely address
      // to be typed here by mistake.
      //
      // An error here is NOT a pass. `data: null, error: <anything>` and "this
      // is a stranger's account" must not reach the same branch, or a transient
      // lookup failure resets somebody's password.
      const { data: existing, error: getErr } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (getErr) throw getErr;
      if (existing?.user?.app_metadata?.[ADMIN_FLAG] !== true) {
        return `${clash}Terminal admin: OFF — ${cfg.email} is already someone else's account `
          + '(a student, a vendor login, or an /admin operator). Refusing to reset its password. '
          + 'Use a dedicated address for TERMINAL_ADMIN_EMAIL.';
      }

      // Re-sync on every boot so the config var is genuinely the source of
      // truth. Without this, a rotated env var would leave the OLD password
      // still working and the new one refused — the exact failure that is
      // hardest to diagnose, because both halves look correct in isolation.
      const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        password: cfg.password,
        email_confirm: true,
        // Re-stamped rather than assumed: app_metadata is replaced wholesale by
        // this call, so omitting it here would strip the flag that keeps the
        // account out of the nightly sweep.
        app_metadata: { [ADMIN_FLAG]: true },
      });
      if (pwErr) throw pwErr;
    } else {
      throw error;
    }

    // The account is ours and its password is the env var's. Only now is anyone
    // the operator.
    bootVerdict = true;
    return `${clash}Terminal admin: ${cfg.email} can open ANY vendor terminal at /terminal (user ${userId})`;
  } catch (err) {
    // bootVerdict stays false: we never established that this account is ours,
    // so we do not authorise it. A restart retries.
    //
    // The message is SCRUBBED before it is logged. It comes from GoTrue and none
    // of its errors are known to quote the password back — but this line goes to
    // the log drain, where it is durable and readable by anyone with log access,
    // and "no error we currently know of does that" is not a property worth
    // betting a god-mode credential on.
    return `${clash}Terminal admin: OFF — could not provision ${cfg.email}: ${redact(err.message, cfg.password)} — restart to retry`;
  }
}
