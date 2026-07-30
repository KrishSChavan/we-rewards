// Rotating punch-in tokens (migration-028). The terminal's PUNCH tab shows a
// QR of a URL like  https://<origin>/?punch=<vendorId>.<window>.<sig>  where
// `window` is the current 30-second slot and `sig` is an HMAC only this server
// can produce. Rotation is what makes a screenshot near-useless (it dies with
// its slot), and the signature is what makes forgery impossible — the QR
// carries no secret, and nothing about it is trusted until verifyPunchToken()
// recomputes the HMAC here.
//
// The token deliberately encodes vendor + time and NOTHING about the student:
// many students in line scan the same displayed code, and the once-per-night
// unique constraint (punches table) is what stops any one of them re-punching.
import crypto from 'node:crypto';
import { isUuid } from './ids.js';

export const PUNCH_WINDOW_SECONDS = 30;

// Accept the current slot plus this many previous ones. Scanning at second 29
// and submitting at second 31 must not fail, so the real-world validity is
// 30–90s — still far too short to pass a code around, which is the point.
export const PUNCH_GRACE_WINDOWS = 2;

// How long a camera-scan hold (POST /api/punch/hold) stays claimable while the
// student signs in. OAuth + the consent modal comfortably fit in 10 minutes.
export const PUNCH_HOLD_TTL_SECONDS = 600;

const SIG_CHARS = 16; // 64 bits of HMAC — unforgeable online, compact in the QR

// PUNCH_TOKEN_SECRET when set; otherwise derived from the service-role key so
// no new env var is required. Either way it never leaves the server. Computed
// lazily so import order vs dotenv doesn't matter (and tests can set env late).
function secret() {
  return (
    process.env.PUNCH_TOKEN_SECRET ||
    crypto.createHash('sha256').update(`punch:${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''}`).digest('hex')
  );
}

function sign(vendorId, windowIndex) {
  return crypto
    .createHmac('sha256', secret())
    .update(`punch:v1:${vendorId}:${windowIndex}`)
    .digest('hex')
    .slice(0, SIG_CHARS);
}

/** The 30-second slot `nowMs` falls in. */
export function currentWindow(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / PUNCH_WINDOW_SECONDS);
}

/** Seconds until the current slot rolls over (drives the terminal's refresh). */
export function secondsLeftInWindow(nowMs = Date.now()) {
  return PUNCH_WINDOW_SECONDS - (Math.floor(nowMs / 1000) % PUNCH_WINDOW_SECONDS);
}

/** Mint the token the terminal displays for its current (or given) slot. */
export function mintPunchToken(vendorId, windowIndex = currentWindow()) {
  const vid = String(vendorId).toLowerCase();
  return `${vid}.${windowIndex}.${sign(vid, windowIndex)}`;
}

/** The URL encoded into the QR — scannable by a plain phone camera. */
export function punchUrl(origin, token) {
  return `${origin}/?punch=${token}`;
}

/**
 * Verify a token from the wire. Returns { vendorId, windowIndex } when the
 * signature matches AND the slot is fresh (current, ≤ PUNCH_GRACE_WINDOWS old,
 * or ≤ 1 future for clock skew); null for anything else. Constant-time
 * signature compare — this endpoint is reachable unauthenticated via /hold.
 */
export function verifyPunchToken(raw, nowMs = Date.now()) {
  const s = String(raw ?? '').trim();
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,12})\.([0-9a-f]{16})$/i.exec(s);
  if (!m) return null;
  const vendorId = m[1].toLowerCase();
  if (!isUuid(vendorId)) return null;
  const windowIndex = Number(m[2]);
  if (!Number.isSafeInteger(windowIndex)) return null;

  const now = currentWindow(nowMs);
  if (windowIndex > now + 1 || windowIndex < now - PUNCH_GRACE_WINDOWS) return null;

  const given = Buffer.from(m[3].toLowerCase(), 'utf8');
  const expected = Buffer.from(sign(vendorId, windowIndex), 'utf8');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  return { vendorId, windowIndex };
}

/**
 * The timezone whose 6am boundary separates one bar night from the next.
 * punch_in does the actual date math (in local wall-clock space, from the
 * SCANNED slot rather than the claim moment), so this is just the value the
 * server hands it — there is deliberately no second implementation here to
 * drift out of sync with the SQL.
 */
export const punchTimezone = () => process.env.PUNCH_TIMEZONE || 'America/New_York';

/* ---------- hold binding ----------
   A camera-scanned hold is claimed minutes later, so it can't be tied to the
   token's 30-second life. Instead it's tied to the BROWSER: the mint response
   sets an httpOnly nonce cookie and the database stores only its hash, so a
   holdId lifted out of the response body is inert anywhere else. This doesn't
   stop someone at the venue relaying a live code to a friend in real time —
   nothing server-side can — but it does stop a scanned code from being
   bulk-converted into credentials and passed around. */

export const PUNCH_BINDING_COOKIE = 'wrw_punch_hold';

const hashBinding = (nonce) => crypto.createHash('sha256').update(String(nonce)).digest('hex');

/** A fresh binding: the nonce goes to the browser, only the hash is stored. */
export function mintPunchBinding() {
  const nonce = crypto.randomBytes(32).toString('hex');
  return { nonce, hash: hashBinding(nonce) };
}

/** The binding hash for an incoming request, or null when the cookie is absent. */
export function punchBindingHash(req) {
  const raw = req?.headers?.cookie;
  if (!raw) return null;
  // Hand-parsed rather than adding cookie-parser: this is the only cookie the
  // app uses, and the value is hex from mintPunchBinding.
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== PUNCH_BINDING_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return /^[0-9a-f]{16,128}$/i.test(value) ? hashBinding(value) : null;
  }
  return null;
}
