// Strict UUID shape check. Used to reject a malformed id BEFORE it reaches a
// Postgres `uuid` column, where a bad value throws 22P02 and surfaces as a noisy
// 500 in the error log. The old guard (`/^[0-9a-f-]{36}$/i`) was too loose — it
// accepted 36 dashes and other non-UUID 36-char strings, which still 500'd in
// the query/RPC. This enforces the real 8-4-4-4-12 hex layout.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @returns {boolean} true only for a well-formed UUID string. */
export const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);
