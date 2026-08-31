// Ambassadors (migration-053).
//
// An operator adds a person in /admin, gives them a short code they chose, and
// hands them a QR. The QR points at GET /r/<code> — the SAME rail printed
// banners use — which counts the scan and bounces the visitor into the student
// app. If that visitor goes on to create an account, the signup is attributed
// to the ambassador.
//
// THE AMBASSADOR IS PAID, INTO THEIR OWN STUDENT ACCOUNT. Each row carries a
// per-signup rate, and a recruit creating an account credits the ambassador that
// many community points through grant_community_points (migration-039) — the
// same rail the referral, the signup bonus and the poster QR all use. No new way
// to move points, only a new reason to.
//
// ⚠ WHICH MEANS AN AMBASSADOR NEEDS AN ACCOUNT BEFORE THEY CAN EARN.
// grant_community_points raises GRANT_STUDENT_UNKNOWN for a user with no
// profiles row, so an ambassador without one is a person whose earnings fail
// quietly at every single signup. The admin form refuses to create one, and
// `ambassadors.user_id` is where the resolved account is pinned.
//
// ⚠ SIBLING OF src/lib/tracked-qr.js, AND THE DIFFERENCES MATTER. That file is
// printed banners: 8 random characters, an award at signup, and `active`
// pausing only the money because the vinyl is still on a wall. This file is
// people: a code they typed themselves, no money at all, and `active` stopping
// the LINK, because somebody who has finished being an ambassador should stop
// recruiting. Read migration-053's header before assuming a rule carries over.
//
// The two share the /r/ rail and the ?qr= handoff into the client on purpose —
// see the resolver in src/routes/tracked-qr.js. They do NOT share a cookie: the
// code shapes differ, so one regex could not parse both without being loose
// enough to parse garbage.

import crypto from 'node:crypto';
import { supabaseAdmin } from './supabase.js';
// One bot filter for both features. A crawler that inflates a banner's numbers
// inflates an ambassador's identically, and two denylists drifting apart is how
// one report starts disagreeing with the other.
import { isLikelyBot } from './tracked-qr.js';

export { isLikelyBot };

export const NAME_MAX = 80;
export const EMAIL_MAX = 254;
export const PHONE_MIN = 7;
export const PHONE_MAX = 20;   // same cap as vendors.phone (migration-049)
// Matches signup-bonus.js's POINTS_MAX, tracked-qr.js's, and the column's CHECK.
// An ambassador is a sibling of those deals, so they must not be able to outbid
// one. Deliberately NOT grant_community_points' 100000, which is a typo stop for
// an operator's manual grant, not a rate anybody should be able to set here.
export const POINTS_MAX = 5000;

/* ---------- the code ----------
   CHOSEN, not minted, which is the whole reason this is not a tracked_qr row.
   The operator types something the ambassador can say out loud, so the rules
   are about what survives being said and typed back:

     UPPERCASE, always. Stored uppercased and compared uppercased, so SARAH7 and
     sarah7 are one code and not two. A phone keyboard capitalises the first
     letter of anything typed into a URL bar, and a code that failed for that
     reason would be indistinguishable from a code that never existed.

     LETTERS AND DIGITS ONLY. No dash, no underscore, no space: this string goes
     into a URL that gets read aloud, and every extra symbol is a thing to
     mishear. (An operator who wants PSU-SARAH gets PSUSARAH.)

     3 TO 10. The floor is the operator's own; the ceiling keeps it short enough
     to fit under a QR at a readable size. Both are enforced again by
     migration-053's CHECK, so nothing that bypasses this file can widen them. */
export const CODE_MIN = 3;
export const CODE_MAX = 10;
const CODE_RE = new RegExp(`^[A-Z0-9]{${CODE_MIN},${CODE_MAX}}$`);

/**
 * Fold whatever arrived — a URL segment, a form field, a pasted string — into
 * the canonical code, or null.
 *
 * Case and surrounding space are forgiven, because both are things a keyboard
 * does rather than things a person meant. NOTHING ELSE IS: a stray character is
 * a wrong code, and stripping it would silently resolve a mistyped link to
 * somebody else's ambassador.
 *
 * A NON-STRING IS NOT A CODE, and that guard is load-bearing rather than
 * defensive tidiness. One caller is attributeSignup, whose rawCode can come
 * straight out of a signup request body — and String(true) is "true", which
 * uppercases into TRUE, which satisfies every rule below. Without this line a
 * client posting `{ trackedQr: true }` sends a lookup for a code nobody typed.
 * Same guard, for the same reason, as src/lib/referrals.js.
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  return CODE_RE.test(s) ? s : null;
}

/** Lowercased and trimmed, or null. The column stores this form, so UNIQUE on
 *  it is a case-insensitive uniqueness check (migration-053). */
export function normalizeEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s.length > EMAIL_MAX) return null;
  // Deliberately the same loose shape as everywhere else in this repo: the only
  // real test of an address is sending to it, and a strict pattern rejects
  // valid addresses that people actually have.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/* Permissive on purpose, and the same shape /join and the Add-vendor form use:
   this number gets dialled by a human, so a plausible-looking string beats a
   strict format that rejects the way somebody actually writes their own.

   Exported as a predicate rather than as a normalizer because the phone is
   OPTIONAL, and a normalizer would have to return two different flavours of
   "nothing" — one for "they left it blank" and one for "they typed something
   unusable". Those must not be confused (the first saves, the second is a red
   message under the field), so the caller tests emptiness itself. */
export const PHONE_RE = /^[\d\s()+.-]{7,20}$/;

/** True if `raw` is a phone number we will store. Blank is NOT valid here — the
 *  caller checks for blank first, because blank is allowed and this is not. */
export const isValidPhone = (raw) => PHONE_RE.test(String(raw ?? '').trim());

/* ---------- the visitor cookie ----------
   Exactly the two jobs tracked-qr.js's cookie has, for exactly the same
   reasons: the nonce counts a returning phone as one person, and the code
   survives the sign-in round trip through Google, which loses every query
   parameter on the way.

   A SEPARATE COOKIE FROM wrw_qr, and not a shared one. The code shapes differ
   (8 lowercase vs 3-10 uppercase), so one regex covering both would have to be
   loose enough to accept strings that are neither — and this parser is the only
   thing standing between a hand-crafted Cookie header and a row in the scans
   table. Two tight regexes beat one slack one. It also means a student who
   scanned a banner AND an ambassador's code is credited to both, which is
   correct: they are different programs, and neither pays, so there is no double
   spend to prevent.

   httpOnly so page JS can neither read nor plant it. SameSite=Lax because it
   has to survive the top-level OAuth redirect. */
export const AMBASSADOR_COOKIE = 'wrw_amb';
export const AMBASSADOR_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const hashNonce = (nonce) => crypto.createHash('sha256').update(String(nonce)).digest('hex');

const COOKIE_RE = new RegExp(`^([0-9a-f]{32})\\.([A-Z0-9]{${CODE_MIN},${CODE_MAX}})$`);

/** Read our cookie off a raw request. Hand-parsed: the app has no cookie-parser. */
export function readAmbassadorCookie(req) {
  const raw = req?.headers?.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== AMBASSADOR_COOKIE) continue;
    const m = COOKIE_RE.exec(part.slice(eq + 1).trim());
    if (!m) return null;
    return { nonce: m[1], hash: hashNonce(m[1]), code: m[2] };
  }
  return null;
}

/** The options every write of this cookie must use. Path matters: a clear must match. */
export function ambassadorCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: AMBASSADOR_COOKIE_MAX_AGE_MS,
    path: '/',
  };
}

/* ---------- lookups ---------- */

/**
 * The ambassador behind a code, or null. Reads are by the public code, never by
 * id, and INACTIVE ONES ARE STILL RETURNED — the caller decides what a paused
 * ambassador means, because the two callers disagree: the resolver refuses to
 * record a scan for one, while the admin uniqueness check has to see it or it
 * would hand a retired ambassador's code to somebody new.
 */
export async function findByCode(rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  const { data, error } = await supabaseAdmin
    .from('ambassadors')
    .select('id, code, name, email, phone, active, points, user_id')
    .eq('code', code)
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * The student account behind an email address, or null.
 *
 * This is what "an ambassador must already have an account" is checked with.
 * THROWS on a query failure rather than returning null, and the difference
 * matters: null is used by the caller to refuse the create, and a dropped
 * connection reported as "no such account" would tell an operator their
 * colleague has not signed up when in fact nobody asked.
 *
 * ⚠ profiles.email IS NOT UNIQUE and is nullable — it is a copy of the auth
 * address, and nothing in the schema defends it. auth.users.email is what
 * actually enforces one-account-per-address, so in practice this matches at most
 * one row; limit(1) is here because "in practice" is not a constraint. That
 * looseness is also why the resolved user_id is STORED on the ambassador rather
 * than this lookup being repeated at payout time.
 */
export async function findAccountByEmail(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('user_id, email, name')
    .eq('email', email)
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * Count one resolution of /r/<code> and refresh the visitor's cookie.
 *
 * BEST EFFORT, ALWAYS. The visitor is mid-redirect with a phone in their hand;
 * a telemetry write that fails must not turn a scanned code into an error page.
 * Every path returns rather than throwing.
 *
 * @returns {Promise<{ id: string, code: string, name: string } | null>} the
 *   ambassador, or null if the code is unknown OR PAUSED. Paused is null on
 *   purpose: unlike a banner, a retired ambassador's link should stop working,
 *   and the caller treats "no such code" and "not any more" identically.
 */
export async function recordScan({ req, res, rawCode }) {
  let amb = null;
  try {
    amb = await findByCode(rawCode);
  } catch (err) {
    console.warn(`[ambassadors] lookup failed for ${rawCode}: ${err?.message ?? err}`);
    return null;
  }
  if (!amb || !amb.active) return null;

  // Reuse the nonce this browser already has so a second scan is the SAME
  // visitor. A new nonce every time would make uniques equal total scans, and
  // the column would be a lie that looks like data.
  const existing = readAmbassadorCookie(req);
  const nonce = existing?.nonce ?? crypto.randomBytes(16).toString('hex');
  try {
    res.cookie(AMBASSADOR_COOKIE, `${nonce}.${amb.code}`, ambassadorCookieOptions());
  } catch { /* headers already sent — the scan still counts below */ }

  const ua = req.get?.('user-agent') ?? '';
  if (isLikelyBot(ua)) return amb;

  try {
    const { error } = await supabaseAdmin.from('ambassador_scans').insert({
      ambassador_id: amb.id,
      visitor_hash: hashNonce(nonce),
      user_agent: ua.slice(0, 500) || null,
    });
    if (error) throw error;
  } catch (err) {
    console.warn(`[ambassadors] scan not recorded for ${amb.code}: ${err?.message ?? err}`);
  }
  return amb;
}

/* ---------- attribution ----------
   ⚠ THE GRACE WINDOW IS NOT A DETAIL, IT IS THE FEATURE. Copied wholesale from
   src/lib/tracked-qr.js, and read that file's note before touching it.

   POST /api/me/accept-terms is NOT "a new account was created". Every existing
   student hits it again each time TERMS_VERSION is bumped. A student who
   scanned an ambassador's code last week still has the cookie, so without this
   check the next terms revision would credit half the campus to whoever they
   last scanned — and here that is not even caught by a payout guard, because
   there is no payout. The unique index on user_id would stop the SECOND such
   attribution; nothing but this stops the first one being wrong. */
const NEW_ACCOUNT_GRACE_MS = 10 * 60 * 1000;

/** The ledger label. Free text in community_grants, but paired with ref_id it IS
 *  the idempotency key — see the note above attributeSignup. */
export const GRANT_KIND = 'ambassador';

/**
 * Credit a brand-new account to the ambassador whose code it arrived through,
 * and pay that ambassador their per-signup rate.
 *
 * BEST EFFORT, ALWAYS — consent is what must succeed. Never throws.
 *
 * ⚠ THE IDEMPOTENCY KEY IS THE RECRUIT, NOT THE AMBASSADOR. The grant is
 * written with ref_id = the NEW STUDENT and kind = 'ambassador', so
 * migration-039's UNIQUE (ref_id, kind) index means one ambassador payout per
 * account created, ever. That is what lets one ambassador be paid a hundred
 * times (once per distinct recruit) while making a second payout for the same
 * recruit impossible, however many times this runs.
 *
 * ⚠ PAY FIRST, RECORD SECOND, matching maybeAwardTrackedQr. The attribution row
 * is a report; community_grants is the money. If the report write fails after a
 * successful payout the ledger still holds the truth, whereas recording first
 * and paying second would leave a row claiming an ambassador earned something
 * they were never given.
 *
 * @returns {Promise<{ name: string, code: string, points: number } | null>} who
 *   got the credit and what they were paid, or null when nobody did (no code,
 *   unknown code, paused ambassador, not a new account, self-signup, or already
 *   attributed). `points: 0` is a real answer: a 0-rate ambassador, or one whose
 *   payout failed — the log says which.
 */
export async function attributeSignup({ userId, rawCode, profileCreatedAt }) {
  try {
    if (!normalizeCode(rawCode)) return null;

    // Checked before anything is written, so a terms re-acceptance leaves no
    // trace at all rather than an attribution row that steals credit from the
    // ambassador who earns it later.
    const created = new Date(profileCreatedAt ?? 0).getTime();
    if (!Number.isFinite(created) || Date.now() - created > NEW_ACCOUNT_GRACE_MS) return null;

    const amb = await findByCode(rawCode);
    if (!amb || !amb.active) return null;

    // NO PAYING YOURSELF. Reachable in exactly one way now that money is
    // involved: an ambassador deletes their student account and signs up again
    // through their own code, which is a genuinely new account inside the grace
    // window. Cheap to close, and the alternative is a renewable payout.
    if (amb.user_id && amb.user_id === userId) {
      console.warn(`[ambassadors] ${amb.code} self-signup ignored for ${userId}`);
      return null;
    }

    let paid = 0;
    if (amb.points > 0) {
      if (!amb.user_id) {
        // They had an account when they were created (the admin form insists on
        // it) and no longer do. Their code still works and still recruits; there
        // is simply nowhere to put the money. Logged rather than swallowed,
        // because the operator's row says "no account" for the same reason.
        console.warn(`[ambassadors] ${amb.code} has no account to pay — ${amb.points} points not credited for ${userId}`);
      } else {
        const { error } = await supabaseAdmin.rpc('grant_community_points', {
          p_user_id: amb.user_id,        // the AMBASSADOR is paid
          p_points: amb.points,
          p_kind: GRANT_KIND,
          p_reason: `Ambassador signup: ${amb.code}`,
          // No incentive row, so no budget ceiling — see migration-053's header
          // for why, and for what to change if a campus-wide cap is ever wanted.
          p_incentive_id: null,
          p_ref_id: userId,              // the RECRUIT is the idempotency key
          p_granted_by: 'system',
        });
        if (error) {
          const msg = String(error.message ?? '');
          // Already paid means this recruit has already earned somebody their
          // bonus, or this ran twice. Either way it is the index doing its job,
          // not a fault, and it must not be logged as one.
          if (!msg.includes('GRANT_ALREADY_PAID')) {
            console.warn(`[ambassadors] ${amb.code} not paid for ${userId}: ${msg}`);
          }
        } else {
          paid = amb.points;
        }
      }
    }

    // Which ambassador, and what it was worth. Separate from the money on
    // purpose: a 0-rate ambassador writes no grant at all, so this row is the
    // ONLY record that they recruited anyone, and its unique index on user_id is
    // the only thing stopping a second ambassador claiming the same account.
    const { error } = await supabaseAdmin
      .from('ambassador_signups')
      .insert({ ambassador_id: amb.id, user_id: userId, points: paid });
    if (error) {
      // Already credited — the index doing its job, not a fault. Anything else
      // is worth a line in the log, but never worth failing consent over.
      if (!String(error.message ?? '').includes('duplicate key')) {
        console.warn(`[ambassadors] attribution not recorded for ${userId}: ${error.message}`);
      }
      return null;
    }
    return { name: amb.name, code: amb.code, points: paid };
  } catch (err) {
    console.warn(`[ambassadors] threw for ${userId}: ${err?.message ?? err}`);
    return null;
  }
}
