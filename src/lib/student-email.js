// Linking a university email to a personal account (migration-057).
//
// src/lib/signup-bonus.js states the problem this exists to solve, in its own
// header: a student who signs in with a personal Gmail gets no signup bonus and
// "there is no way for them to fix it after the fact short of deleting the
// account". Penn State federates with Google, so the address that qualifies and
// the address they actually tapped at the Google picker are routinely different
// people's-worth of points apart.
//
// TWO OUTCOMES FROM ONE FLOW, and they are not equally dangerous:
//
//   LINK   the address has no account of its own. We record the claim, pay the
//          bonus their sign-in missed, and that is that. Reversible (unlink),
//          though the bonus is not re-payable.
//   MERGE  the address already has its own account. Everything it holds moves
//          into the account they are signed into and it is closed. Permanent.
//
// WHY A MAILED CODE AND NOT A SECOND GOOGLE SIGN-IN. Re-authenticating with the
// university's Google account is stronger proof and costs nothing, but in a PWA
// the OAuth redirect SWAPS the session to that account halfway through — the
// student ends up signed in as the very account we were about to absorb, with
// no way back to the confirm screen. And it is no proof at all for a .psu.edu
// address that is not Google-federated. The code lands in the inbox, which is
// the thing ownership actually means, and the flow survives being finished on a
// different device. Same trade vendor password recovery already made
// (src/lib/reset-codes.js), for the same reason.
//
// WHAT THIS FILE WILL NOT DO. It never tells an unverified caller whether an
// address has an account. POST /start answers identically either way; the fact
// that a merge is coming is disclosed in the EMAIL (which only the inbox owner
// reads) and in the response to /verify (which only a correct code reaches).
// Without that, typing addresses into /start is an account-enumeration oracle
// for the whole university.

import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { supabaseAdmin } from './supabase.js';
import { sendEmail, emailEnabled, maskEmail } from './email.js';
import { studentEmailCode } from './email-templates.js';
import { activeSignupProgram, emailMatchesDomains, SIGNUP_DEFAULTS } from './signup-bonus.js';

export const CODE_LENGTH = 6;
export const CODE_TTL_MINUTES = 15;
export const CODE_MAX_ATTEMPTS = 5;
// Per-account, enforced in SQL so it survives IP rotation — the express
// rate-limit in server.js bounds a network, this bounds an inbox.
export const CODE_COOLDOWN_SECONDS = 60;

// RFC-lengths: 64 for the local part, 254 for the whole thing. Rejecting longer
// here means a typo costs no bcrypt and no API call.
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

// A real bcrypt hash at the cost factor codes are minted with, so the wrong-code
// path spends the same time as the right one. Matches nothing: it is a hash of a
// random string, discarded. Same trick as src/routes/vendor-recover.js.
const DUMMY_HASH = bcrypt.hashSync(String(randomInt(1e12)), 10);

/**
 * Six digits, CSPRNG. Not the dictated alphabet reset-codes.js uses: nobody
 * reads this one down a phone, they read it off a screen and type it into the
 * app — the same job the earn code already does with six digits.
 */
export function generateLinkCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += String(randomInt(10));
  return out;
}

/** Typed input → the canonical six digits, or null. Forgives spaces and dashes. */
export function normalizeLinkCode(input) {
  if (typeof input !== 'string') return null;
  const bare = input.replace(/[^0-9]/g, '');
  return bare.length === CODE_LENGTH ? bare : null;
}

/**
 * Fold a typed address into { email, norm }, or { error }.
 *
 * `email` is what we mail and display — their spelling, lowercased. `norm` is
 * the identity the bonus fence is keyed on, and the ONE transformation it makes
 * is stripping a `+tag`:
 *
 *   abc123+one@psu.edu  and  abc123+two@psu.edu  are one inbox
 *
 * so without folding them, one mailbox collects one bonus per tag it can
 * invent. Dots are deliberately NOT stripped — that is a Gmail-specific rule,
 * and on most mail systems (including a university's) first.last@ and
 * firstlast@ are genuinely two different people.
 *
 * TYPE GATE BEFORE ANY COERCION, exactly as normalizeLinkCode above does it.
 * `raw` is raw JSON off the wire — the POST /student-email/start handler in
 * src/routes/student.js opens with `normalizeStudentEmail(req.body?.email)` and
 * has no shape guard ahead of it — so `{"email":{"toString":1}}` reaches here as
 * an object with an own, NON-CALLABLE `toString` shadowing the real one, and
 * `String(that)` throws "TypeError: Cannot convert object to primitive value".
 * That throw skipped the `if (parsed.error) return 400 BAD_EMAIL` on the very
 * next line and went to next(err); server.js's global handler has no branch for
 * a bare TypeError, so logError wrote an error_logs row and web-pushed an alert
 * to EVERY subscribed operator before answering 500. A malformed request body is
 * a 400, never an incident. Same class of hole as the tracked-qr and
 * /unsubscribe ones (see the coercion note on verifyUnsubscribeToken in
 * src/lib/email.js). A non-string gets the ordinary empty-field refusal, which
 * is also what undefined/null got before this gate existed.
 */
export function normalizeStudentEmail(raw) {
  if (typeof raw !== 'string') return { error: 'Enter your student email address.' };
  const email = raw.trim().toLowerCase();
  if (!email) return { error: 'Enter your student email address.' };
  if (email.length > EMAIL_MAX) return { error: 'That email address is too long.' };
  if (!EMAIL_RE.test(email)) return { error: 'That doesn’t look like an email address.' };

  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const host = email.slice(at + 1);
  if (local.length > 64) return { error: 'That doesn’t look like an email address.' };

  const plus = local.indexOf('+');
  const norm = `${plus >= 0 ? local.slice(0, plus) : local}@${host}`;
  // "+tag@host" folds to "@host", which is not an address.
  if (norm.startsWith('@')) return { error: 'That doesn’t look like an email address.' };

  return { email, norm };
}

/**
 * The domains that count as a student address right now.
 *
 * Read off the live signup program so an operator who adds alumni.psu.edu in
 * /admin changes who this feature appears for, with no release. Falls back to
 * the same default the admin form pre-fills with, so the feature still WORKS
 * (and still merges accounts) in the gaps between programs — only the payout is
 * conditional on a program, never the linking.
 */
export async function linkDomains() {
  try {
    const program = await activeSignupProgram();
    const cfg = { ...SIGNUP_DEFAULTS, ...(program?.config ?? {}) };
    return cfg.domains?.length ? cfg.domains : SIGNUP_DEFAULTS.domains;
  } catch {
    return SIGNUP_DEFAULTS.domains;
  }
}

/** Does this address look like a student one, under the live rules? */
export function isStudentAddress(email, domains) {
  return emailMatchesDomains(email, domains);
}

/**
 * What GET /api/me/student-email answers. Everything the Account screen needs to
 * decide between "offer this", "show what's linked" and "say nothing".
 *
 * `eligible` is false for someone who ALREADY signs in with a student address —
 * they have nothing to gain and the feature would only confuse them — and false
 * when this deployment cannot send mail, because a flow whose first step is
 * "check your email" must not be offered where no email will arrive. Same rule
 * applyEmailConfig() already follows for the deal-emails switch.
 */
export async function studentEmailState(user, profile) {
  const domains = await linkDomains();
  const signedInIsStudent = isStudentAddress(user?.email, domains);

  const linked = profile?.linked_email
    ? { email: profile.linked_email, at: profile.linked_email_at }
    : null;

  let claim = null;
  if (linked) {
    const { data } = await supabaseAdmin
      .from('student_email_claims')
      .select('email, merged_from, bonus_points, verified_at')
      .eq('user_id', user.id)
      .is('released_at', null)
      .maybeSingle();
    claim = data ?? null;
  }

  let program = null;
  try {
    program = await activeSignupProgram();
  } catch {
    program = null;
  }

  return {
    // A linked address stays visible even to someone no longer "eligible", so
    // the screen can never show a fact with no explanation attached.
    eligible: Boolean(emailEnabled) && !signedInIsStudent,
    reason: !emailEnabled ? 'email_off' : signedInIsStudent ? 'already_student' : null,
    domains,
    linked: linked && {
      ...linked,
      // A merged link is permanent; a plain one can be undone. The button the
      // app renders is decided here rather than in the client, so the two can't
      // disagree about what is reversible.
      merged: Boolean(claim?.merged_from),
      canUnlink: !claim?.merged_from,
      bonusPaid: claim?.bonus_points ?? 0,
    },
    // Marketing copy, not the ledger: points only, never budget or spend. Same
    // line publicSignupBonus() draws.
    bonus: program ? { points: { ...SIGNUP_DEFAULTS, ...(program.config ?? {}) }.points } : null,
  };
}

/**
 * Which auth account owns an address, if any. Service-role-only definer lookup
 * (migration-035) because auth.users is not readable by the API roles; returns
 * the id and nothing else.
 *
 * Checked against the address AS TYPED, not the folded one: a `+tag` form is
 * what someone would have signed up with if they signed up with it at all, and
 * folding here would attach a merge to the wrong account.
 */
export async function accountIdForEmail(email) {
  const { data, error } = await supabaseAdmin.rpc('auth_user_id_by_email', { p_email: email });
  if (error) throw error;
  return data ?? null;
}

/**
 * Who currently holds this address, and whether it has ever been paid for.
 * Two different questions off one row — see the table's comment in
 * migration-057 for why the row outlives both the link and the account.
 */
export async function claimFor(norm) {
  const { data, error } = await supabaseAdmin
    .from('student_email_claims')
    .select('email_norm, email, user_id, bonus_points, merged_from, released_at')
    .eq('email_norm', norm)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/**
 * "Is the address I just signed in with already part of somebody's account?"
 *
 * THE CASE THIS EXISTS FOR. A student merges their university account into
 * their personal one; months later they tap the university address at the
 * Google picker out of habit. Google is happy to hand us that identity, a fresh
 * auth user is created, and without this they land in an EMPTY account and
 * conclude their points are gone. It is the single most likely support ticket
 * this whole feature generates, and the fix is to recognise the address rather
 * than to let a blank account be built on top of it.
 *
 * Returns the masked address they should be signing in with instead, or null.
 * Masked, not plain: the caller is an unauthenticated-ish party (they hold that
 * mailbox, not the account), and "g•••y@gmail.com" is enough to jog a memory
 * without handing a stranger someone's address.
 *
 * @returns {Promise<{signInWith: string}|null>}
 */
export async function claimHeldByOther(email, userId) {
  try {
    const { norm } = normalizeStudentEmail(email);
    if (!norm) return null;

    const claim = await claimFor(norm);
    if (!claim || claim.released_at || !claim.user_id || claim.user_id === userId) return null;

    const { data: owner } = await supabaseAdmin
      .from('profiles').select('email').eq('user_id', claim.user_id).maybeSingle();

    return { signInWith: owner?.email ? maskEmail(owner.email) : null };
  } catch {
    // Never blocks consent on its own failure: a student who cannot accept the
    // terms cannot use the app at all, and this is a courtesy.
    return null;
  }
}

// Which sendEmail() failures are ABOUT OUR MAIL PLUMBING, and therefore the
// only ones POST /student-email/start may ever admit to (as 503). Everything
// else answers the uniform 200, because it might be a fact about ONE mailbox.
//
// sendEmail never throws; it returns { ok:false, reason } — and, for reason
// 'http', additionally { status } — where reason is one of disabled |
// invalid_to | empty | suppressed | http | timeout | network (the full shape is
// documented on sendEmail in src/lib/email.js, whose only status-bearing return
// is `return { ok: false, reason: 'http', status: res.status }` on any non-2xx).
//
// ⚠ WHY THIS IS AN ALLOW-LIST OF TRANSPORT REASONS AND NOT A DENY-LIST OF
// ADDRESS ONES. It used to be the other way round — a two-name set
// {suppressed, invalid_to}, with everything else, 'http' included, treated as
// "equally true of every address". That was false, and 'http' is the proof:
//
//   • sendEmail's RECIPIENT_FIELD_RE branch (src/lib/email.js, ~:409 — cited by
//     symbol because that file moves) exists precisely because a 422 NAMING THE
//     RECIPIENT is a fact about the mailbox: it calls
//     suppress(to, 'invalid_address', SCOPE_ALL) on it. That send still returns
//     reason 'http', so 'first..last@psu.edu' (which passes both our own
//     EMAIL_RE and sendEmail's local guard, reaches Resend, and comes back 422)
//     answered 503 while 'first.last@psu.edu' answered 200. The response
//     differed on the address STRING — the enumeration oracle the ⚠ note on the
//     route forbids, handed back by the very split meant to be safe.
//   • With a test-mode Resend key it is starker still: Resend answers 403 "You
//     can only send testing emails to your own email address", so every address
//     but the key owner's got 503 and the key owner's got 200. A perfect oracle
//     for one address, live on any staging deploy.
//
// SO THE SPLIT IS BY STATUS, not by reason alone. A 5xx is the provider being
// down and is true of every address at that instant. A 4xx is Resend's verdict
// on THIS REQUEST — which includes its verdict on this recipient — so it is
// address-dependent until proven otherwise, and 401 (a missing, revoked or
// wrong API key) and 429 (rate limit) are the two proven otherwises: both are
// evaluated against the API KEY, before and irrespective of who the message is
// addressed to, and both are exactly the "silent dead end" this 503 exists to
// surface. Anything else 4xx — 403, 422, a shape error — stays 200.
//
// AND THE DEFAULT LEANS TO 200 (address), which is the reverse of what the old
// comment claimed. An unrecognised reason is not automatically address-
// independent — 'http' was recognised and wasn't — so the two errors are not
// symmetric: a missing 503 costs a student one confusing retry and a line in
// the dyno log, while a wrong 503 tells a caller we have mailed that address
// before, permanently, for any address they care to type. Fail toward 200.
const TRANSPORT_SEND_REASONS = new Set(['disabled', 'empty', 'timeout', 'network']);
const TRANSPORT_HTTP_STATUSES = new Set([401, 429]);

/**
 * 'transport' (may be reported as 503) | 'address' (must answer the uniform
 * 200) for a failed sendEmail() result — pass the whole result, not just the
 * reason, because the status is half the decision.
 *
 * Exported rather than inlined because this two-line function IS the security
 * boundary of POST /student-email/start: it is worth being able to assert the
 * whole (reason, status) table directly, pair by pair, instead of inferring it
 * from a set literal the way the version this replaced had to be read.
 *
 * @param {{reason?: string, status?: number}} sent a failed sendEmail() result
 * @returns {'transport'|'address'}
 */
export function classifySendFailure({ reason, status } = {}) {
  if (TRANSPORT_SEND_REASONS.has(reason)) return 'transport';
  // Only 'http' carries a status; >= 500 is the provider, not the mailbox.
  if (reason === 'http' && Number.isFinite(status)) {
    if (status >= 500 || TRANSPORT_HTTP_STATUSES.has(status)) return 'transport';
  }
  return 'address';
}

/**
 * Mint a code, store its hash, mail it. Returns { ok, sentTo } — and returns
 * ok:true when the per-account cooldown swallowed the send, on purpose: a
 * student who taps twice must not be able to tell "already sent" from "sent",
 * or the response becomes a probe for how often an address is being targeted.
 *
 * `willMerge` only reaches the EMAIL. It is the one place the fact can be
 * disclosed safely, because the only reader is whoever holds the inbox.
 *
 * `sendFailureClass` is 'transport' | 'address' | null, and exists so the route
 * can answer 503 when the PROVIDER is down without learning — or leaking — that
 * a particular mailbox is suppressed or unroutable. classifySendFailure() above
 * draws that line, and draws it toward 'address' for anything Resend could have
 * said about this one recipient. The reason string and the HTTP status both
 * deliberately stay in here: the class is the most the caller is allowed to
 * know. It is absent entirely on the cooldown path, which must keep answering
 * 200.
 */
export async function issueLinkCode({ userId, email, norm, signedInAs, willMerge }) {
  const code = generateLinkCode();
  const codeHash = await bcrypt.hash(code, 10);

  const { data, error } = await supabaseAdmin.rpc('student_email_code_issue', {
    p_user_id: userId,
    p_email: email,
    p_email_norm: norm,
    p_code_hash: codeHash,
    p_ttl_minutes: CODE_TTL_MINUTES,
    p_cooldown_secs: CODE_COOLDOWN_SECONDS,
  });
  if (error) throw error;

  // Zero rows = the cooldown is still running. Nothing was stored, so nothing
  // may be sent: mailing now would deliver a code that cannot be redeemed.
  const row = data?.[0];
  if (!row) return { ok: true, sentTo: maskEmail(email), throttled: true };

  const msg = studentEmailCode({
    code,
    signedInAs,
    ttlMinutes: CODE_TTL_MINUTES,
    willMerge: Boolean(willMerge),
  });

  // Transactional: they asked for this by typing their address, so it goes even
  // to someone who muted deal emails. Never throws — see src/lib/email.js.
  const sent = await sendEmail({
    to: email,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    category: 'transactional',
    // Resend de-dupes on this for 24h, which is what makes a double-tapped
    // button safe. Keyed on the code row, so a genuinely new code always sends.
    idempotencyKey: `student-link-${row.code_id}`,
    tags: ['student-link'],
  });
  if (!sent.ok) {
    console.warn(`[student-email] send failed for ${maskEmail(email)}: ${sent.reason ?? 'unknown'}`);
  }

  return {
    ok: true,
    sentTo: maskEmail(email),
    sent: sent.ok,
    sendFailureClass: sent.ok ? null : classifySendFailure(sent),
  };
}

/**
 * Spend one guess. Mirrors src/routes/vendor-recover.js exactly, including the
 * dummy compare on the no-live-code path: without it, "no code outstanding"
 * returns measurably faster than "wrong code".
 *
 * @returns {{ok: false, burned?: boolean} | {ok: true, id, email, norm}}
 */
export async function checkLinkCode({ userId, code }) {
  const normalized = normalizeLinkCode(code);

  const { data, error } = await supabaseAdmin.rpc('student_email_code_begin', {
    p_user_id: userId,
    p_max_attempts: CODE_MAX_ATTEMPTS,
  });
  if (error) throw error;

  const pending = data?.[0];
  if (!normalized || !pending || pending.code_burned || !pending.code_hash) {
    // NO String() ON `code` HERE. Same hole as normalizeStudentEmail above, and
    // this branch is the one a hostile body lands in: POST /student-email/verify
    // passes `req.body?.code` straight through (src/routes/student.js), so
    // {"code":{"toString":1}} fails normalizeLinkCode, falls in here, and
    // `String(that)` would throw "Cannot convert object to primitive value" —
    // 500 + error_logs row + a push to every operator instead of the 400 BAD_CODE
    // the next line already returns. The dummy compare only needs *a* string to
    // burn the same bcrypt time, so a non-string spends it on ''.
    await bcrypt.compare(typeof code === 'string' ? code : '', DUMMY_HASH);
    return { ok: false, burned: Boolean(pending?.code_burned) };
  }

  const match = await bcrypt.compare(normalized, pending.code_hash);
  if (!match) return { ok: false };

  return {
    ok: true,
    id: pending.code_id,
    email: pending.code_email,
    norm: pending.code_email_norm,
  };
}

/**
 * Pay the bonus a personal sign-in missed, and record the claim either way.
 *
 * THE RULES, in the order they bite:
 *   1. the address has never been paid for — the fence that makes unlink safe;
 *   2. this account has no signup bonus already, INCLUDING one it inherited
 *      from an account it just absorbed (the merge re-points community_grants,
 *      so the address that qualified may already have been paid once);
 *   3. a program is live, in its window, with budget left, and the address
 *      matches its domains.
 *
 * Never throws: the link is the thing that must succeed. A bonus that doesn't
 * pay is a support ticket; a link that fails after the code was spent is a
 * student who has to start over and cannot, because the code is gone.
 *
 * @returns {Promise<number>} points actually paid
 */
export async function payLinkBonus({ userId, email, norm }) {
  try {
    const existing = await claimFor(norm);
    if (existing?.bonus_points > 0) return 0;

    // Already holds a signup bonus — theirs, or one that arrived with a merge.
    const { count, error: gErr } = await supabaseAdmin
      .from('community_grants')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('kind', 'signup_domain')
      .is('voided_at', null);
    if (gErr) throw gErr;
    if (count) return 0;

    const program = await activeSignupProgram();
    if (!program) return 0;

    const cfg = { ...SIGNUP_DEFAULTS, ...(program.config ?? {}) };
    if (!emailMatchesDomains(email, cfg.domains)) return 0;

    // ref_id = the student, kind = signup_domain: the SAME idempotency key
    // maybeAwardSignupBonus uses, so a student cannot collect at signup and
    // again by linking. migration-039's UNIQUE (ref_id, kind) enforces it even
    // if every check above were wrong.
    const { error } = await supabaseAdmin.rpc('grant_community_points', {
      p_user_id: userId,
      p_points: cfg.points,
      p_kind: 'signup_domain',
      p_reason: `Linked student email (${cfg.domains.join(', ')})`,
      p_incentive_id: program.id,
      p_ref_id: userId,
      p_granted_by: 'system',
    });
    if (error) {
      const msg = String(error.message ?? '');
      if (!msg.includes('GRANT_ALREADY_PAID')) {
        console.warn(`[student-email] bonus not paid for ${userId}: ${msg}`);
      }
      return 0;
    }
    return cfg.points;
  } catch (err) {
    console.warn(`[student-email] bonus threw for ${userId}: ${err?.message ?? err}`);
    return 0;
  }
}

/**
 * Write the claim and stamp the profile. One address per account and one
 * account per address are both index-enforced (migration-057); this upsert is
 * what reuses a released row rather than colliding with it.
 */
export async function recordClaim({ userId, email, norm, bonusPoints = 0, mergedFrom = null }) {
  const prior = await claimFor(norm);

  // ⚠ THE FENCE IS THE MAX, NOT THE NEW VALUE. A relink pays 0 (rule 1 in
  // payLinkBonus), so writing bonusPoints straight through would zero the
  // record of the payout the FIRST link made — and the next relink would then
  // see an unpaid address and pay again. That is the exact farm this table
  // exists to stop, reintroduced by an upsert.
  const fence = Math.max(prior?.bonus_points ?? 0, bonusPoints);

  const { error } = await supabaseAdmin
    .from('student_email_claims')
    .upsert({
      email_norm: norm,
      email,
      user_id: userId,
      bonus_points: fence,
      // Likewise: an address merged once stays merged-from, so a later unlink
      // and relink cannot quietly present itself as reversible.
      merged_from: mergedFrom ?? prior?.merged_from ?? null,
      verified_at: new Date().toISOString(),
      released_at: null,
    }, { onConflict: 'email_norm' });
  if (error) throw error;

  const { error: pErr } = await supabaseAdmin
    .from('profiles')
    .update({ linked_email: email, linked_email_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (pErr) throw pErr;
}
