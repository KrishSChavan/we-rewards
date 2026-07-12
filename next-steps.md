# Next steps

## Polish / hardening — do later (not yet implemented)

Lower-severity items from the security review. None are exploitable by an
outsider; they're insider-fraud limits and error-handling cleanups. Tackle when
convenient — not blocking for the pilot.

### 1. Award caps (rogue-cashier fraud limit)
`POST /api/vendor/award` isn't PIN-gated (cashiers award all day, by design) and
today accepts up to `$500 × ratio × 2x` in one tap with no per-shift ceiling — a
dishonest cashier could mint points to an accomplice. Add sanity limits:
- a lower per-award dollar cap (e.g. $200, or a vendor-configurable max), and/or
- a per-cashier daily total, and/or
- require the staff PIN for awards above some threshold.
The audit log + Undo already give *detection*; this adds *prevention*.
See `src/routes/vendor.js` (`/award`, the `dollarAmount > 500` check).

### 2. PIN brute-force lockout (per-vendor, not just per-IP)
The 4-digit staff PIN is only protected by a per-IP rate limit
(`pinLimiter`, 15/15 min in `server.js`). An attacker who already has a vendor
login can rotate IPs to keep guessing. Track failed attempts **per vendor** in
the DB and lock PIN entry for a few minutes after N failures, independent of IP.
Optionally allow a 6-digit PIN. Lower priority: the attacker must already be
signed-in staff and the payoff is limited (refunds/settings/analytics).

### 3. Return 400, not 500, on malformed IDs
A few endpoints pass request-body IDs straight into a query on a `uuid` column;
a non-UUID value makes Postgres throw and surfaces as a generic 500 instead of a
clean 400. Not exploitable (Supabase parameterizes — no SQL injection), just
wrong status codes + noisier logs. Add the same UUID-shape guard already used in
`/api/vendor/reverse` (`/^[0-9a-f-]{36}$/i`) before the query.
- `POST /api/vendor/reverse` — regex-passing-but-invalid UUIDs (e.g. 36 dashes)
  reach the RPC and 500.
- Also audit `create_redeem_code` / other body-ID → RPC paths. (Note: the
  `/api/me/redeem-code` reward lookup ignores the query error and returns 404
  `REWARD_NOT_FOUND`, so it's already 4xx — not a 500.)

---

## Operational follow-ups (still open)

- **Multi-instance readiness.** The in-memory `express-rate-limit` store and the
  adapter-less Socket.IO are correct for ONE instance only. Before scaling
  horizontally, swap in a shared rate-limit store (e.g. `rate-limit-redis`) and
  the Socket.IO Redis adapter.
- **Vendor password reset / change-password flow.** Vendors sign in with the
  email+password from the onboard script and have no way to change it in the
  terminal. Add a change-password (and/or reset) flow before handing terminals
  to real vendors.
- **Privacy policy + ToS.** The app collects PII and already offers export/delete
  (`/api/me/export`, `/api/me/delete`); surface a policy before a public launch.

---

## ✅ Done (recent security-review pass)

- **DB test suite run for real.** The integration + security suites now pass
  against a real Supabase stack (local `supabase start`), not just in code —
  atomic award/redeem/rollback, expired codes, void/refund + balance clamp +
  1-minute window, and the anon/authenticated RPC-denial + PIN-gate regressions.
  See "Running the DB tests locally" in the README.
- **Supply-chain: SRI on supabase-js.** Both apps (+ /admin) pin an exact
  supabase-js version from jsDelivr with a Subresource Integrity hash, so a
  tampered CDN build can't run. Bump the version + hash together on upgrade.
- **CSP `connect-src` scoped.** Dropped the bare `ws:`/`wss:` wildcard — only
  `'self'` + the Supabase origin, so injected code can't open a socket to an
  arbitrary host.
- **`trust proxy` made explicit + configurable** via `TRUST_PROXY` (default 1 =
  one PaaS proxy), with a note on when to change it.
- **Operator `/admin` dashboard** (`ADMIN_EMAILS` allow-list): platform
  analytics + a unified error log capturing server 500s and client-side crashes
  from both apps (`error_logs`, migration-013; `/api/client-error`).

*Previously done (unchanged): migration-007 RPC lockdown, server-side PIN +
idle timeout, rate limiting, helmet, void/refund, vendor self-service settings,
student data export/deletion, tests + CI.*
