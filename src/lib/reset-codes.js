// One-time codes for vendor password recovery (migration-031).
//
// These are read ALOUD — the operator mints one in /admin and says it down the
// phone to a vendor standing at a noisy counter. That single fact drives every
// choice here: the alphabet drops glyphs that sound or look alike, the code is
// grouped into two blocks so it can be dictated in chunks, and normalisation
// forgives the substitutions a listener actually makes.

import { randomInt } from 'node:crypto';

// 29 symbols. Dropped: O/Q (vs 0), I/L (vs 1), S (vs 5), Z (vs 2), B (vs 8).
// 29^8 ~= 5.0e11 combinations against a 5-guess cap and a 30-minute window, so
// the code's strength is never the weak link — the phone call is.
export const RESET_CODE_ALPHABET = '0123456789ACDEFGHJKMNPRTUVWXY';
export const RESET_CODE_LENGTH = 8;

// What a human might type or hear instead of the canonical symbol. Applied
// before validation so "OK7M2NP94" and "0K7M2-0P94" both land on the same code.
const CONFUSIONS = { O: '0', Q: '0', I: '1', L: '1', S: '5', Z: '2', B: '8' };

/**
 * A fresh code, hyphenated for reading: `K7M2-NP94`.
 *
 * randomInt (CSPRNG, rejection-sampled) rather than Math.random — this is a
 * credential. Uniform because 29 does not divide 2^32 evenly and randomInt
 * handles the modulo bias for us.
 */
export function generateResetCode() {
  let out = '';
  for (let i = 0; i < RESET_CODE_LENGTH; i++) {
    out += RESET_CODE_ALPHABET[randomInt(RESET_CODE_ALPHABET.length)];
  }
  return formatResetCode(out);
}

/** Group a bare 8-char code into `XXXX-XXXX`. Anything else is returned as-is. */
export function formatResetCode(code) {
  const bare = String(code ?? '');
  if (bare.length !== RESET_CODE_LENGTH) return bare;
  return `${bare.slice(0, 4)}-${bare.slice(4)}`;
}

/**
 * Typed input → the canonical 8-char form, or null if it can't be one.
 *
 * Strips hyphens/spaces (people re-type the separator, or don't), uppercases,
 * and folds the confusable glyphs. Returns null rather than a partial match so
 * the caller has exactly one shape to hash against — a length or alphabet
 * failure is indistinguishable from a wrong code to the user, by design.
 */
export function normalizeResetCode(input) {
  if (typeof input !== 'string') return null;
  const folded = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[OQILSZB]/g, (ch) => CONFUSIONS[ch]);
  if (folded.length !== RESET_CODE_LENGTH) return null;
  for (const ch of folded) {
    if (!RESET_CODE_ALPHABET.includes(ch)) return null;
  }
  return folded;
}
