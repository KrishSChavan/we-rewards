// Local verification of Supabase access tokens.
//
// WHY: every authenticated request used to call `supabaseAuth.auth.getUser(token)`,
// which is a network round-trip to GoTrue purely to check a signature. At 100+
// students on one NAT'd campus Wi-Fi IP that piles onto GoTrue's per-IP limits —
// and it surfaces as "random sign-in failures", which is miserable to diagnose.
// A Supabase access token is a signed JWT, so we can check it here in microseconds.
//
// TWO SIGNING MODES, because Supabase is mid-migration and this project straddles it:
//
//   * asymmetric (ES256/RS256) — the current default. Tokens carry a `kid` and are
//     verified against the project's published JWKS. Nothing secret is involved,
//     so this needs no new config var. Local, staging and production all publish
//     an ES256 key today.
//   * legacy HS256 — tokens signed with the project's shared JWT secret. Verified
//     only if SUPABASE_JWT_SECRET is set (Supabase dashboard → Settings → API →
//     JWT Secret). Without it, HS256 tokens fall through to GoTrue as before.
//
// The token's own header picks the branch, and each branch is pinned to its own
// algorithm family — the shared secret can never be used to check an asymmetric
// token and vice versa, so there is no "alg confusion" opening here.
//
// WHAT NEVER GETS ACCEPTED: the anon and service_role API keys are themselves
// HS256 JWTs signed with the very same project secret, and they are public /
// server-held rather than user-issued. Four independent fences below reject them
// (issuer, audience, `role`, `sub`) so no one can present an API key as a user.
//
// TRADE-OFF: a locally-verified token cannot be revoked before it expires (≤1h).
// A user who signs out keeps a working token for the remainder of its life — but
// it still only does what that account could already do. Routes that want instant
// revocation ask for it explicitly (see `strict` below; /api/admin/* uses it).
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader, errors as joseErrors } from 'jose';
import { supabaseAuth } from './supabase.js';

// GoTrue stamps both of these on every user access token, and on nothing else.
const AUDIENCE = 'authenticated';
const ROLE = 'authenticated';

// Signature algorithms we accept from the JWKS branch. Deliberately excludes
// HS256 (handled separately, with a different key) and `none`.
const ASYMMETRIC_ALGS = ['ES256', 'ES384', 'ES512', 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'EdDSA', 'Ed25519'];

// Clock skew we tolerate on exp/iat, in seconds. Heroku and Supabase are both
// NTP-synced; this is only here so a second of drift isn't a 401.
const CLOCK_TOLERANCE = 5;

// jose error codes that mean "we could not obtain key material", as opposed to
// "this token is bad". Only these are allowed to fall back to GoTrue — a real
// signature failure must 401 immediately, or an attacker could turn a flood of
// junk tokens into a flood of outbound GoTrue calls.
const NO_KEY_MATERIAL = new Set([
  'ERR_JWKS_NO_MATCHING_KEY',      // key rotated and our cache hasn't caught up
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JWKS_TIMEOUT',
  'ERR_JWKS_INVALID',
]);

const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ISSUER = `${baseUrl}/auth/v1`;

/**
 * Sanity-checks a candidate JWT secret against material we already hold.
 *
 * The anon key is itself an HS256 JWT signed with the project's JWT secret, so a
 * mistyped SUPABASE_JWT_SECRET is detectable at boot instead of at 2am when every
 * HS256 token starts 401ing. Returns true/false when the check is possible, or
 * null when it isn't (a project on the newer `sb_publishable_…` keys has no
 * legacy JWT to check against — then we simply trust what's configured).
 */
export function secretMatchesAnonKey(secret, anonKey = process.env.SUPABASE_ANON_KEY || '') {
  const parts = anonKey.split('.');
  if (parts.length !== 3) return null;
  let header;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header?.alg !== 'HS256') return null;

  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Resolve the HS256 secret once, at import, and drop it if it demonstrably
// belongs to a different project. Dropping it is the safe failure: HS256 tokens
// then take the GoTrue path they took before this file existed.
const rawSecret = (process.env.SUPABASE_JWT_SECRET || '').trim();
let hsSecret = null;
if (rawSecret) {
  if (secretMatchesAnonKey(rawSecret) === false) {
    console.warn(
      '[auth] SUPABASE_JWT_SECRET does not match this project\'s anon key — ignoring it. ' +
      'Copy it from Supabase → Settings → API → JWT Secret. HS256 tokens will be verified by GoTrue instead.'
    );
  } else {
    hsSecret = new TextEncoder().encode(rawSecret);
  }
}

// Lazily fetched and cached by jose: no request is made until the first
// asymmetric token arrives, the key set is cached for 10 minutes, and an unknown
// `kid` (i.e. Supabase rotated the signing key) triggers a re-fetch with a
// cooldown. While that re-fetch is pending we fall back to GoTrue, so a rotation
// is invisible to students rather than an outage.
const remoteJwks = baseUrl ? createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`)) : null;

/** The `req.user` shape, built from verified JWT claims. */
function userFromPayload(payload) {
  // `name` mirrors what schema.sql's handle_new_user trigger used to read
  // (raw_user_meta_data->>'full_name'); POST /api/me/accept-terms now creates the
  // profile, so it needs the same Google display name the trigger had.
  const meta = payload.user_metadata ?? {};
  return {
    id: payload.sub,
    email: payload.email ?? null,
    name: meta.full_name ?? meta.name ?? null,
  };
}

/** Same shape, from a GoTrue user object (the fallback path). */
export function userFromGoTrue(user) {
  const meta = user.user_metadata ?? {};
  return {
    id: user.id,
    email: user.email ?? null,
    name: meta.full_name ?? meta.name ?? null,
  };
}

const ok = (payload) => ({ ok: true, user: userFromPayload(payload), payload });
const reject = (reason) => ({ ok: false, fallback: false, reason });
const undecidable = (reason) => ({ ok: false, fallback: true, reason });

/**
 * Builds a verifier. Exported as a factory so tests can supply their own issuer,
 * key set and secret without touching the environment or the network.
 *
 * Returns `{ ok: true, user, payload }` on success; `{ ok: false, fallback }`
 * otherwise, where `fallback: true` means "we could not check this token, ask
 * GoTrue" and `fallback: false` means "this token is invalid, 401 it".
 */
export function createTokenVerifier({ issuer, jwks = null, secret = null }) {
  return async function verifyAccessToken(token) {
    if (typeof token !== 'string' || !token) return reject('NO_TOKEN');

    let header;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      return reject('MALFORMED');
    }

    // Pick the key AND the permitted algorithm list together. Because the two
    // branches never share a key, a token cannot talk its way from one into the
    // other by setting `alg` — `alg: none` and anything unrecognised land here.
    let key;
    let algorithms;
    if (header.alg === 'HS256') {
      if (!secret) return undecidable('NO_HS256_SECRET');
      key = secret;
      algorithms = ['HS256'];
    } else if (ASYMMETRIC_ALGS.includes(header.alg)) {
      if (!jwks) return undecidable('NO_JWKS');
      key = jwks;
      algorithms = ASYMMETRIC_ALGS;
    } else {
      return reject('UNSUPPORTED_ALG');
    }

    let payload;
    try {
      // jwtVerify checks the signature, `exp`/`nbf`, the issuer and the audience.
      ({ payload } = await jwtVerify(token, key, {
        algorithms,
        issuer,
        audience: AUDIENCE,
        clockTolerance: CLOCK_TOLERANCE,
        requiredClaims: ['sub', 'exp'],
      }));
    } catch (err) {
      if (NO_KEY_MATERIAL.has(err?.code)) return undecidable(err.code);
      // A JOSE error with any other code is a bad token. Anything that isn't a
      // JOSE error at all (a network failure reaching the JWKS endpoint, say)
      // means we never got to judge it — hand it to GoTrue, which is
      // authoritative, rather than signing the student out over a blip.
      if (err instanceof joseErrors.JOSEError) return reject(err.code || 'INVALID');
      return undecidable('KEY_FETCH_FAILED');
    }

    // The API-key fences. The anon and service_role keys carry `role: "anon"` /
    // `"service_role"`, no `sub`, no `aud`, and `iss: "supabase"` — so each of
    // these on its own already stops them being replayed as a user token.
    if (payload.role !== ROLE) return reject('NOT_A_USER_TOKEN');
    if (typeof payload.sub !== 'string' || !payload.sub) return reject('NO_SUB');

    return ok(payload);
  };
}

/** The app's verifier, configured from the environment. */
export const verifyAccessToken = createTokenVerifier({
  issuer: ISSUER,
  jwks: remoteJwks,
  secret: hsSecret,
});

// One line, once per process, the first time a token has to go to GoTrue anyway.
// If local verification is silently doing nothing in production this is how you
// find out — without a log line per request.
let fallbackLogged = false;
function noteFallback(reason) {
  if (fallbackLogged) return;
  fallbackLogged = true;
  console.warn(`[auth] falling back to GoTrue getUser (${reason}) — local JWT verification is not covering these tokens`);
}

/**
 * Builds the token → user resolver. A factory for the same reason as the
 * verifier: the property worth testing here is *when the network is touched*,
 * and a test can only assert that by counting calls to an injected getUser.
 */
export function createUserResolver({ verify, getUser, onFallback = () => {} }) {
  return async function resolveUserFromToken(token, { strict = false } = {}) {
    if (!token) return null;

    if (!strict) {
      const result = await verify(token);
      if (result.ok) return result.user;
      // A token we positively judged invalid stops here. It must NOT reach
      // GoTrue: /api/client-error and /api/client-event accept a token while
      // being unauthenticated, so forwarding junk would let anyone use this
      // server to hammer the auth endpoint our own students depend on.
      if (!result.fallback) return null;
      onFallback(result.reason);
    }

    const { data, error } = await getUser(token);
    if (error || !data?.user) return null;
    return userFromGoTrue(data.user);
  };
}

/**
 * Resolves a bearer token to `{ id, email, name }`, or null if it isn't valid.
 *
 * Verifies locally when it can, and only calls GoTrue when it genuinely cannot
 * judge the token (no key material for that algorithm, or the JWKS endpoint was
 * unreachable). An invalid signature never reaches the network.
 *
 * @param {string} token
 * @param {{strict?: boolean}} [opts] strict skips local verification entirely and
 *   asks GoTrue, which also catches a session revoked before its token expired.
 *   Worth the round-trip on rare, high-value routes; not on student traffic.
 */
export const resolveUserFromToken = createUserResolver({
  verify: verifyAccessToken,
  getUser: (token) => supabaseAuth.auth.getUser(token),
  onFallback: noteFallback,
});

/** One-line description of how tokens are being checked, for the boot log. */
export function authVerificationMode() {
  const modes = [];
  if (remoteJwks) modes.push('JWKS (ES256/RS256)');
  if (hsSecret) modes.push('HS256 secret');
  if (!modes.length) return 'GoTrue getUser on every request (no local verification configured)';
  return `${modes.join(' + ')}, GoTrue fallback`;
}
