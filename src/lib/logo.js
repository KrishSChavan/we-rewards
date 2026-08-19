/**
 * The vendor logo rule, and the one place it is written down.
 *
 * A logo reaches the database by four different doors — the /join application
 * (src/routes/apply.js), the operator's "Add vendor" form and the operator's
 * Edit dialog (src/routes/admin.js), and the vendor's own terminal Settings
 * (src/routes/vendor.js) — and all four run the same client-side
 * shrink-to-128px pipeline, so all four have to accept exactly the same thing.
 *
 * They used to hold three hand-copied pairs of constants under "keep in sync"
 * comments, and the comments were already wrong: the /join door 400'd on
 * `logo: ''` while the admin door read the same value as "clear it". That is
 * the drift this module exists to end, and it is why the caps are exported
 * rather than re-typed at each call site (a test asserting the boundary has to
 * be able to reach the number the route enforces, or it is asserting a fourth
 * copy).
 *
 * WHY THE IMAGE ITSELF IS NOT INSPECTED. The data-URL prefix is checked, the
 * length is checked, and nothing decodes the bytes. A malformed image renders
 * as a broken plate on the operator's own screen the moment they pick it, which
 * is a faster and more honest signal than a server-side decode — and the file
 * never leaves the operator's browser un-resized, so the cap is about the
 * COLUMN, not about trust.
 */

// ~375 KB decoded. Sized so a hand-crafted request can't bloat the row, and so
// the whole body still fits the global express.json limit in server.js (600 kb),
// which is what lets the logo ride on an ordinary JSON route instead of needing
// a parser of its own.
export const LOGO_MAX_CHARS = 500_000;
export const LOGO_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * Coerce whatever a form sent into a storable logo.
 *
 * `null` and `''` both mean NO LOGO — for a create that is "never had one", for
 * an edit that is "take the current one away". The two cases are told apart by
 * the CALLER deciding whether the key was present at all (hasOwnProperty), not
 * here: this function only answers what a given value means.
 *
 * @param {unknown} input a base64 image data-URL, null, or ''.
 * @returns {{ value: string|null } | { error: string }}
 */
export function validLogo(input) {
  if (input == null || input === '') return { value: null };
  if (typeof input !== 'string' || input.length > LOGO_MAX_CHARS || !LOGO_DATA_URL.test(input)) {
    return { error: 'Logo must be a small PNG, JPEG, or WebP image.' };
  }
  return { value: input };
}
