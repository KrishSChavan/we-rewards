// Trackable QR codes for printed banners and posters (migration-050).
//
// An operator creates a code in /admin, prints the QR it renders onto a banner,
// and screws the banner to a wall. Scanning it hits GET /r/<code>, which counts
// the scan and bounces the visitor into the student app. If that visitor goes on
// to CREATE AN ACCOUNT, they are paid a one-time community-points award that the
// operator set on that banner.
//
// ⚠ NOT src/lib/qr-poster.js. That file is a different feature with a
// confusingly similar name: the single "scan here" artwork file an operator
// uploads once and every vendor terminal downloads. This file is about
// individually tracked codes. Nothing is shared between them.
//
// WHY THE AWARD IS TIED TO SIGNUP AND NOT TO THE SCAN. A printed code is
// photographable — the first student to scan a banner can text the link to
// everyone they know, and no amount of server-side cleverness can tell that
// apart from a crowd standing in front of the poster. So the award is attached
// to the one thing that cannot be shared: creating an account. It is paid
// through grant_community_points with ref_id = the student and
// kind = 'tracked_qr', which migration-039's UNIQUE (ref_id, kind) index turns
// into once per account, for good, whatever this file does wrong.

import crypto from 'node:crypto';
import { randomInt } from 'node:crypto';
import { supabaseAdmin } from './supabase.js';

export const NAME_MAX = 80;
export const NOTE_MAX = 200;
// Matches signup-bonus.js's POINTS_MAX and the column's CHECK. A banner is a
// sibling of the signup bonus, so it must not be able to outbid it.
export const POINTS_MAX = 5000;

/* ---------- the code in the URL ----------
   31 symbols, lowercase, no 0/1/l/o/i. This is not a secret and nothing is
   gated on guessing it — the award needs a new account, not a valid code. The
   alphabet is chosen because the ONE time a human touches this string is when
   the printed QR won't scan and they type the URL off the banner instead, and
   the length because 31^8 ~= 8.5e11 makes a crawler enumerating codes to
   inflate someone's scan count pointless. */
export const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const CODE_LENGTH = 8;

/** A fresh code. randomInt is rejection-sampled, so the alphabet stays uniform. */
export function mintCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/**
 * Fold whatever arrived in the URL into a code, or null. Case is forgiven
 * because someone typing off a banner will use their phone's auto-capitalised
 * keyboard; nothing else is, because everything else is a wrong code.
 */
export function normalizeCode(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/* ---------- the visitor cookie ----------
   Two jobs in one cookie, because the app has no session for a signed-out
   visitor and adding one for this would be absurd:

     the nonce  counts a returning phone as one unique visitor. Only its SHA-256
                is ever stored, so the scans table is worthless to anyone who
                steals it and holds nothing that names a person.
     the code   is the banner they last scanned, so accept-terms can attribute
                the account even though the sign-in round trip through Google
                loses every query parameter on the way.

   httpOnly so page JS can neither read nor plant it. SameSite=Lax because it
   has to survive exactly the top-level OAuth redirect the punch binding cookie
   already survives (server.js's own note on that cookie).

   LAST TOUCH, not first: scanning a second banner reassigns the credit. That
   matches how the existing ?ref= invite capture behaves (it overwrites
   localStorage on every visit), and matching it matters more than the
   philosophy — two attribution rules in one app is how reports start
   disagreeing. */
export const TRACKED_QR_COOKIE = 'wrw_qr';
export const TRACKED_QR_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const hashNonce = (nonce) => crypto.createHash('sha256').update(String(nonce)).digest('hex');

const COOKIE_RE = /^([0-9a-f]{32})\.([0-9a-z]{8})$/;

/** Read our cookie off a raw request. Hand-parsed: the app has no cookie-parser. */
export function readVisitorCookie(req) {
  const raw = req?.headers?.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== TRACKED_QR_COOKIE) continue;
    const m = COOKIE_RE.exec(part.slice(eq + 1).trim());
    if (!m) return null;
    return { nonce: m[1], hash: hashNonce(m[1]), code: m[2] };
  }
  return null;
}

/** The cookie options every write of this cookie must use. Path matters: a clear must match. */
export function visitorCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: TRACKED_QR_COOKIE_MAX_AGE_MS,
    path: '/',
  };
}

/* ---------- link previews are not people ----------
   A poster URL gets pasted into iMessage, Slack, Discord and GroupMe, and every
   one of those fetches it to build a preview card. unsubscribe.js documents the
   same hazard for its own GET. Counting those would quietly inflate exactly the
   number the operator is trying to read, and the inflation would be largest for
   the banners that got shared most — the opposite of the truth.

   Deliberately a denylist and not an allowlist: a missed crawler costs one
   phantom scan, while an allowlist that misjudges a real phone's user-agent
   costs a real student's scan and there is no way to notice it happened. */
const BOT_RE = /bot|crawler|spider|crawling|preview|facebookexternalhit|slack|twitter|discord|whatsapp|telegram|linkedin|embedly|pinterest|redditbot|applebot|curl|wget|python-requests|headless|lighthouse|monitor|uptime/i;

export const isLikelyBot = (ua) => BOT_RE.test(String(ua ?? ''));

/** The banner behind a code, or null. Reads are by the public code, never by id. */
export async function findByCode(rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  const { data, error } = await supabaseAdmin
    .from('tracked_qr_codes')
    .select('id, code, name, note, points, active')
    .eq('code', code)
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * Count one resolution of /r/<code> and refresh the visitor's cookie.
 *
 * BEST EFFORT, ALWAYS. The visitor is mid-redirect with a phone in their hand;
 * a telemetry write that fails must not turn a scanned poster into an error
 * page. Every path returns rather than throwing.
 *
 * @returns {Promise<{ id: string, name: string } | null>} the banner, or null if
 *   the code is unknown — the caller decides where an unknown code goes.
 */
export async function recordScan({ req, res, rawCode }) {
  let banner = null;
  try {
    banner = await findByCode(rawCode);
  } catch (err) {
    console.warn(`[tracked-qr] lookup failed for ${rawCode}: ${err?.message ?? err}`);
    return null;
  }
  if (!banner) return null;

  // Reuse the nonce this browser already has so a second scan is the SAME
  // visitor. A new nonce every time would make uniques equal total scans and
  // the column would be a lie that looks like data.
  const existing = readVisitorCookie(req);
  const nonce = existing?.nonce ?? crypto.randomBytes(16).toString('hex');
  try {
    res.cookie(TRACKED_QR_COOKIE, `${nonce}.${banner.code}`, visitorCookieOptions());
  } catch { /* headers already sent — the scan still counts below */ }

  const ua = req.get?.('user-agent') ?? '';
  if (isLikelyBot(ua)) return banner;

  try {
    const { error } = await supabaseAdmin.from('tracked_qr_scans').insert({
      qr_id: banner.id,
      visitor_hash: hashNonce(nonce),
      user_agent: ua.slice(0, 500) || null,
    });
    if (error) throw error;
  } catch (err) {
    console.warn(`[tracked-qr] scan not recorded for ${banner.code}: ${err?.message ?? err}`);
  }
  return banner;
}

/* ---------- the payout ----------
   ⚠ THE GRACE WINDOW IS NOT A DETAIL, IT IS THE FEATURE.

   POST /api/me/accept-terms is NOT "a new account was created". It is also hit
   by every existing student, every time TERMS_VERSION is bumped
   (src/lib/terms.js says so in as many words). A student who walked past a
   banner last week still has the cookie, so without this check the next terms
   revision would pay the whole campus for posters they were never recruited by.

   The signup bonus solves the same problem by requiring profiles.created_at to
   fall inside the program's date window. A banner has no window, so the test
   here is tighter and simpler: the profile must have been created essentially
   just now — by the very upsert that is calling us. Ten minutes is slack for a
   slow request and a skewed clock, not a grace period anyone can plan around. */
const NEW_ACCOUNT_GRACE_MS = 10 * 60 * 1000;

/** The ledger label. Free text in community_grants, but paired with ref_id it IS the idempotency key. */
export const GRANT_KIND = 'tracked_qr';

/**
 * Attribute a brand-new account to the banner it came through, and pay that
 * banner's award if it has one.
 *
 * BEST EFFORT, ALWAYS — consent is what must succeed. Never throws.
 *
 * @returns {Promise<{ points: number, name: string } | null>} what was paid, or
 *   null when nothing was (no code, unknown code, paused banner, not a new
 *   account, or already attributed).
 */
export async function maybeAwardTrackedQr({ userId, rawCode, profileCreatedAt }) {
  try {
    if (!normalizeCode(rawCode)) return null;

    // See NEW_ACCOUNT_GRACE_MS. Checked before anything is written, so a terms
    // re-acceptance leaves no trace at all rather than an attribution row that
    // pays nothing but still steals the credit from a banner that earns it later.
    const created = new Date(profileCreatedAt ?? 0).getTime();
    if (!Number.isFinite(created) || Date.now() - created > NEW_ACCOUNT_GRACE_MS) return null;

    const banner = await findByCode(rawCode);
    if (!banner) return null;
    // Paused pays nothing. The banner is still on a wall and still counting
    // scans — `active` was only ever about the money.
    if (!banner.active) return null;

    let paid = 0;
    if (banner.points > 0) {
      const { error } = await supabaseAdmin.rpc('grant_community_points', {
        p_user_id: userId,
        p_points: banner.points,
        p_kind: GRANT_KIND,
        p_reason: `Poster QR: ${banner.name}`,
        // No incentive row, so no budget ceiling — see migration-050's header
        // for why, and for what to change if a campus-wide cap is ever wanted.
        p_incentive_id: null,
        p_ref_id: userId,
        p_granted_by: 'system',
      });
      if (error) {
        const msg = String(error.message ?? '');
        // Already paid means this account was recruited by some other banner,
        // or this ran twice. Either way it is the index doing its job, not a
        // fault, and it must not be logged as one.
        if (!msg.includes('GRANT_ALREADY_PAID')) {
          console.warn(`[tracked-qr] not paid for ${userId}: ${msg}`);
        }
        return null;
      }
      paid = banner.points;
    }

    // Which banner, for the operator's report. Separate from the money on
    // purpose: a 0-point banner writes no grant, so this row is the ONLY record
    // that it recruited anyone, and its unique index on user_id is the only
    // thing stopping a second banner claiming the same account.
    const { error: attrErr } = await supabaseAdmin
      .from('tracked_qr_signups')
      .insert({ qr_id: banner.id, user_id: userId, points: paid });
    if (attrErr && !String(attrErr.message ?? '').includes('duplicate key')) {
      console.warn(`[tracked-qr] attribution not recorded for ${userId}: ${attrErr.message}`);
    }

    return { points: paid, name: banner.name };
  } catch (err) {
    console.warn(`[tracked-qr] threw for ${userId}: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Create a banner, minting a code that is not already taken.
 *
 * The retry loop exists because the code is random and the column is UNIQUE:
 * at 31^8 a collision is vanishingly unlikely, but "vanishingly unlikely" and
 * "cannot happen" differ by exactly one confused operator staring at a 500.
 * Same shape as the slug loop elsewhere in this repo.
 */
export async function createTrackedQr({ name, note, points, createdBy }) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, error } = await supabaseAdmin
      .from('tracked_qr_codes')
      .insert({ code: mintCode(), name, note, points, created_by: createdBy })
      .select('id, code, name, note, points, active, created_at')
      .single();
    if (!error) return data;
    // 23505 on a table whose only unique column is `code`.
    if (error.code !== '23505') throw error;
  }
  throw new Error('TRACKED_QR_CODE_COLLISION');
}
