// One row per tap of a counter NFC tag (migration-065, public.nfc_taps). This
// is what the "NFC tags" card in /admin reads; src/routes/tap.js writes a row
// for every landing page it serves and POST /api/me/nfc-tap writes one for
// every tag the installed app handled on its own.
//
// WHY A SECOND TABLE BESIDE client_events. tap.js already logs an 'nfc_tap'
// event there (mirrored to PostHog) and keeps doing so: that is the generic
// funnel log, and it stays the system of record for "what did visitors do".
// But nothing reads client_events back, and nothing usefully could. PostgREST
// caps a read at max_rows = 1000 (supabase/config.toml), so a JS-side sum over
// event rows silently freezes at a thousand taps, which is the exact failure
// GET /api/admin/incentives had before its counts moved into the database. So
// taps get a table of their own with the columns an operator asks about (which
// spot, which tag, which phone, when), counted by views rather than in Node.
// The rows are keyed by VENDOR ID, not by the slug the tag carried: an operator
// renaming a slug in /admin keeps every tap that spot ever had, and a tag
// written with the vendor's uuid is not affected by the rename at all.
//
// THE COOKIE. A returning phone has to count as ONE visitor, not a new one per
// tap: with a fresh nonce every time, uniques would equal taps and the column
// would be a lie that looks like data (src/lib/tracked-qr.js learned this for
// posters). Only the SHA-256 of the nonce is ever stored, so the table names
// nobody and is worthless to anyone who steals it. The cookie is scoped to
// Path=/t because it never rides on anything else: no other route reads it,
// so no other request should carry it, and it never reaches the API. Cookie
// paths match by segment, so a Path=/t cookie does not travel to /terminal
// either, and the vendor terminal's own cookie jar is untouched by taps.
//
// WHY APP TAPS EXIST. An installed iOS app claims /t/* as a Universal Link
// (the apple-app-site-association file server.js serves), so its tap NEVER
// reaches the landing page and would never be counted here. Left like that the
// spots with the most installed customers would show the FEWEST taps, which is
// the opposite of the truth. The app reports the tag it handled to
// POST /api/me/nfc-tap instead, which lands a row with source = 'app' and a
// visitor hash derived from the account id rather than from a cookie (the app
// shares no cookie jar with Safari, so a cookie could not join the two).
//
// BEST EFFORT, ALWAYS. The person is holding a phone at a counter; a telemetry
// write must never slow the page down or fail it. recordNfcTap never throws
// and never rejects, and every write carries its own timeout.

import crypto from 'node:crypto';
import { supabaseAdmin } from './supabase.js';
import { isUuid } from './ids.js';

/* ---------- the catalogue wait ----------
   Shared by the landing page and the app's report, because both resolve the
   tag's ref against the catalogue before they count it. */

/**
 * How long a tap waits for the catalogue. Measured during an outage: with the
 * database unreachable each read spends about 8 s in the Supabase client's
 * transport retries before it fails, and src/lib/cache.js does not memoise a
 * failure, so EVERY tap paid that as a blank Safari page. Two seconds is longer
 * than a healthy read (the catalogue is cached in-process after the first) and
 * short enough that a student never wonders whether the tag worked; past it the
 * ref goes through to the app, which resolves a slug itself once its vendor
 * list loads.
 */
export const CATALOGUE_WAIT_MS = 2000;

/** The read, or a rejection after `ms`. The timer is cleared either way, so a
 *  settled request never keeps the process alive (the tests care). */
export function withTimeout(promise, ms) {
  let timer;
  const cutoff = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('CATALOGUE_TIMEOUT')), ms);
  });
  return Promise.race([Promise.resolve(promise), cutoff]).finally(() => clearTimeout(timer));
}

/* ---------- the visitor cookie ---------- */

export const NFC_TAP_COOKIE = 'wrw_tap';
export const NFC_TAP_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Only this path, see the header. Every write of the cookie must use the same
// options, or a later clear would not match it.
export const NFC_TAP_COOKIE_PATH = '/t';

const NONCE_RE = /^[0-9a-f]{32}$/;

/** The nonce out of our cookie on a raw request, or null. Hand-parsed: the app has no cookie-parser. */
export function readTapCookie(req) {
  const raw = req?.headers?.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== NFC_TAP_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return NONCE_RE.test(value) ? value : null;
  }
  return null;
}

/** The cookie options every write of this cookie must use. */
export function tapCookieOptions() {
  return {
    httpOnly: true,
    // Lax, like the poster cookie: a tap is a top-level navigation from the
    // phone's NFC reader, which Strict would treat as cross-site and drop.
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: NFC_TAP_COOKIE_MAX_AGE_MS,
    path: NFC_TAP_COOKIE_PATH,
  };
}

/**
 * The visitor nonce for this request: the one the phone already carries, or a
 * fresh one, set on the response. Call it BEFORE the body goes out: Set-Cookie
 * is a header, and a header after res.send is silently lost.
 *
 * A phone that already has a valid cookie is not given a new one, so the
 * nonce stays what it was and a second tap is the SAME visitor. A malformed
 * cookie (a different app's leftovers, a hand-edited value) is replaced.
 */
export function tapVisitorNonce(req, res) {
  const existing = readTapCookie(req);
  if (existing) return existing;
  const nonce = crypto.randomBytes(16).toString('hex');
  try {
    res.cookie(NFC_TAP_COOKIE, nonce, tapCookieOptions());
  } catch { /* headers already sent: the tap still counts, as a one-off visitor */ }
  return nonce;
}

/** What gets stored for a visitor: the digest, never the nonce or the account id. */
export const hashVisitor = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/* ---------- the write ---------- */

// PostgREST's answers for "that table is not there": the Postgres code when the
// insert reaches the database, PGRST205 when PostgREST's schema cache already
// knows better. Either one means migration-065 has not been pasted yet.
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);
const MISSING_WARN_EVERY_MS = 5 * 60 * 1000;
const FAILED_WARN_EVERY_MS = 60 * 1000;
// Generous, because nothing waits on it; finite, because a hung socket must not
// hold a request (the app's report awaits this) or a dyno past its exit grace.
const WRITE_TIMEOUT_MS = 8_000;

let missingWarnedAt = 0;
let failedWarnedAt = 0;

const cap = (s, n) => (s == null ? null : String(s).slice(0, n) || null);

/** @internal test seam: forget the warning clocks. */
export function _resetNfcTapsForTests() {
  missingWarnedAt = 0;
  failedWarnedAt = 0;
}

/**
 * Count one tap. Resolves true when the row landed, false otherwise; never
 * throws, never rejects, so a caller can `void` it or await it as it likes.
 *
 * The code ships before its table does (production carries a backlog of
 * migrations the operator pastes by hand), so a missing table is expected for
 * a while and is reported ONCE per five minutes, naming the paste, rather than
 * once per tap. The write is still attempted every time: taps are rare enough
 * that a failed round trip costs nothing, and attempting means the paste takes
 * effect on the very next tap with no cool-down to wait out.
 *
 * @param {object} t
 * @param {string} t.ref           what the tag carried, normalised: a slug, a uuid, or 'generic'
 * @param {string|null} t.vendorId the spot it resolved to, or null
 * @param {boolean} t.known        whether it resolved at all
 * @param {'web'|'app'} t.source   'web' = the landing page was served; 'app' = the app reported a Universal Link
 * @param {string|null} t.visitorHash  hashVisitor() of the cookie nonce, or of 'u:' + user id for the app
 * @param {string} [t.userId]      app taps only
 * @param {string} [t.userAgent]
 */
export async function recordNfcTap({ ref, vendorId, known, source, visitorHash, userId, userAgent } = {}) {
  try {
    const row = {
      vendor_id: isUuid(vendorId) ? vendorId : null,
      // 64 is the column's CHECK and also normalizeTapRef's ceiling, so this cut
      // only ever fires on a caller that bypassed it.
      ref: cap(ref, 64) ?? 'generic',
      known: known === true,
      source: source === 'app' ? 'app' : 'web',
      visitor_hash: typeof visitorHash === 'string' && visitorHash ? visitorHash.slice(0, 64) : null,
      user_id: isUuid(userId) ? userId : null,
      user_agent: cap(userAgent, 500),
    };

    let { error } = await insertRow(row);
    // A vendor deleted between the catalogue lookup (cached, so possibly a
    // minute stale) and this write is a 23503 on vendor_id. The tap still
    // happened, so keep the row and lose only the link.
    if (error?.code === '23503' && row.vendor_id) {
      ({ error } = await insertRow({ ...row, vendor_id: null }));
    }
    if (!error) return true;

    const now = Date.now();
    if (MISSING_TABLE_CODES.has(String(error.code ?? ''))) {
      if (now - missingWarnedAt >= MISSING_WARN_EVERY_MS) {
        missingWarnedAt = now;
        console.warn(`[nfc-tap] nfc_taps is missing (apply migration-065): ${String(error.message ?? '').slice(0, 200)}. Taps are not being counted.`);
      }
    } else if (now - failedWarnedAt >= FAILED_WARN_EVERY_MS) {
      failedWarnedAt = now;
      console.warn(`[nfc-tap] tap not recorded for ${row.ref}: ${String(error.message ?? error).slice(0, 200)}`);
    }
    return false;
  } catch (err) {
    const now = Date.now();
    if (now - failedWarnedAt >= FAILED_WARN_EVERY_MS) {
      failedWarnedAt = now;
      console.warn(`[nfc-tap] tap not recorded: ${err?.message ?? err}`);
    }
    return false;
  }
}

function insertRow(row) {
  return supabaseAdmin
    .from('nfc_taps')
    .insert(row)
    .abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
}
