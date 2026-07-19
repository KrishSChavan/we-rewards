# Next steps — get-it-ready-for-real-vendors plan

Ordered, actionable work plan. The app is live on **Heroku** and connected to
**Supabase**, so the "wire up a host" work is done. This list is the gap between
"running" and "safe to hand a real vendor a terminal."

**Out of scope this session (deliberately):** database backups / PITR, and
legal (privacy policy, ToS, vendor agreement, points-expiration terms). Revisit
separately.

Work top-down: **Phase 1 (money/fraud)** is the real launch blocker, then vendor
account lifecycle, then Heroku operability, then correctness cleanups, then
polish. Each item notes *what / why / where*.

---

## Phase 1 — Money & fraud safety  ✅ DONE (code) — needs the migrations run

Real vendors = real money. All three items are implemented. **Deploy order
matters: run `migration-019.sql` then `migration-020.sql` in the Supabase SQL
editor BEFORE deploying this code.** migration-019 drops the old 4-arg
`award_points` and creates a 5-arg version (re-applying its EXECUTE grants); the
new server code calls it with the 5th arg, so if the code ships first, awards
fail until the migration runs. Running the migration first is safe for the
still-old code (the new arg defaults to null).

### 1.1 Single-transaction award cap = $200  ✅
Any single award over **$200** is rejected with **"Max award ($200) reached"**.
Hard limit — no daily ceiling, no PIN bypass.
- Server: `src/routes/vendor.js` `/award` (`MAX_AWARD_DOLLARS = 200`).
- Client: terminal keypad capped at $200; quick-button config capped at $200 so
  a saved button can always actually award (`public/vendor/terminal.js`).

### 1.2 Award idempotency  ✅
`transactions.client_token` + a partial unique index on `(vendor_id, client_token)`
(migration-019). `award_points` gained `p_client_token`: a repeat token returns
the current balance and does nothing else — no second transaction, balance bump,
or revisit. The terminal generates a token per award and **reuses it for a prompt
retry of the identical award after a network failure** (2-min window), so a hidden
success can't become a double-award; a genuine repeat purchase is never deduped.
- Migration `supabase/migration-019.sql`; server `/award`; client `awardAmount()`.
- Test: `test/integration/money.test.js` (dedupe on repeated `client_token`).

### 1.3 Per-vendor PIN lockout  ✅
Wrong PINs now lock the **vendor** (not just the IP) after 5 failures for 5 min,
via `vendors.failed_pin_attempts` / `pin_locked_until` + the atomic
`record_pin_result` RPC (migration-020). `verify-pin` refuses while locked
(429 `PIN_LOCKED`), and a correct PIN / PIN change clears the counter.
- Migration `supabase/migration-020.sql`; server `/verify-pin` + settings PATCH;
  terminal shows the lockout message on the PIN screen.
- Test: `test/integration/security.test.js` (5 wrong PINs → 429, correct clears it).

---

## Phase 2 — Vendor account lifecycle

Vendors sign in with the email+password minted at onboarding and can't manage it.

### 2.1 Change-password in the terminal (no email needed)  ✅
A logged-in vendor changes their own password from the Settings tab via
`sb.auth.updateUser({ password })` — no server route, no SMTP. A "Login password"
card (new-password + confirm, 8–72 chars, its own **Update password** button)
sits independent of the batched "Save settings" save; the session stays valid so
the vendor keeps working. Inline green/red feedback.
- **Where:** `public/vendor/index.html` (card), `terminal.js` (`updatePassword()`),
  `terminal.css` (`.field-success`).
- **Note:** if the Supabase project has **"Secure password change"** enabled
  (Auth settings — off by default), `updateUser` requires reauthentication and
  will error; leave it off, or extend the form to collect the current password.
  Purely client-side, so nothing to deploy DB-side.

### 2.2 Forgot-password reset (needs SMTP)  ⬜
A vendor who forgets their password is stuck — reset requires sending an email,
and **Supabase's built-in SMTP is rate-limited and not for production**.
- **Do:** configure a transactional email provider in Supabase → Auth → SMTP
  (Resend / Postmark / SendGrid). Then add a "Forgot password?" link on the
  terminal sign-in that calls `sb.auth.resetPasswordForEmail(...)`, and a
  reset-landing page that calls `updateUser`.
- **Where:** Supabase dashboard (SMTP), terminal sign-in UI. This SMTP config
  also unblocks any future email (vendor invites, etc.).

---

## Phase 3 — Heroku operability  ✅ DONE (code) — a few dashboard steps remain

Code is complete. **You still need to:** (a) run `migration-021.sql` in Supabase
and enable pg_cron (3.3), (b) set up an external uptime monitor (3.2), and
(c) confirm the dyno type (3.2 note). Details below.

### 3.1 Graceful shutdown on SIGTERM  ✅
`server.js` now traps `SIGTERM`/`SIGINT`, drains via `io.close()` (disconnects
sockets + closes the HTTP server once in-flight requests finish), exits 0, and
hard-exits after a 10s backstop. Only wired when run as the real server, not in
tests. *Can't be signal-tested on Windows (no real POSIX signals) — exercises on
the next Heroku deploy.*

### 3.2 Error-spike alerting  ✅ (code) + uptime monitor = your action
- **Done (code):** unexpected server 500s now feed `recordServerError()`
  (`src/lib/alerts.js`); 5+ within 5 min fires a throttled (≤1 per 15 min) web-push
  to subscribed admins, reusing `notifyAdmins`. Silent no-op if push isn't
  configured. Hooked into the central error handler in `server.js`.
- **Your action:** add an external uptime monitor hitting `/api/health`
  (UptimeRobot / BetterStack) — the in-app alert can't fire if the app is down.
- **Dyno note:** a Heroku **Eco** dyno sleeps after 30 min idle (cold start,
  dropped realtime). Use **Basic** or higher for a live vendor product; the
  uptime pinger also helps keep it warm.

### 3.3 error_logs retention  ✅ (migration) — run it + enable pg_cron
- **Done (code):** `migration-021.sql` adds `prune_error_logs(days=90)` and a
  daily pg_cron job (`prune-error-logs`, 04:17 UTC). The function always installs;
  the schedule is best-effort.
- **Your action:** run the migration. If pg_cron isn't enabled it raises a NOTICE
  instead of scheduling — enable pg_cron (Dashboard → Database → Extensions), then
  re-run the migration's final `DO` block. Verify with `select * from cron.job;`.

### 3.4 Node version consistency  ✅
Added `.node-version` (`24`) and pointed both CI jobs at it
(`node-version-file: '.node-version'`), so CI now runs the same major as Heroku
(`engines.node: 24.x`). `TRUST_PROXY` default of 1 is correct for Heroku's single
router — no change unless you add Cloudflare in front.

---

## Phase 4 — Correctness & robustness cleanups  ✅ DONE (code)

All three implemented; no DB migration or dashboard step needed.

### 4.1 Strict UUID guards — clean 4xx instead of 500  ✅
A shared `isUuid()` (`src/lib/ids.js`, strict 8-4-4-4-12 hex) replaces the old
loose `/^[0-9a-f-]{36}$/i` (which accepted 36 dashes and still 500'd). Applied to
every body/param id → uuid-column path: `vendor.js` `/reverse` + `PATCH
/rewards/:id` (previously **unguarded**), all five `admin.js` `:id` routes,
`server.js` `/api/vendor-logo/:id`, and `student.js` `/redeem-code`
(vendorId/rewardId — was masked as a misleading `VENDOR_UNAVAILABLE`).

### 4.2 Analytics truncation detection  ✅
Both endpoints now name the cap (`TX_LIMIT` = 10k vendor / 20k platform) and set a
`truncated` flag on the response + `console.warn` when the row count hits it, so
totals can't silently undercount unnoticed. (Real fix at scale = aggregate in
SQL; still noted as future work — the flag is the signal to do it.)
- **Where:** `src/routes/vendor.js` `/analytics`, `src/routes/admin.js` `/overview`.

### 4.3 Rollup math extracted + unit-tested  ✅
The signed-reversal rollups are now pure functions in `src/lib/analytics.js`
(`rollupVendorAnalytics`, `rollupPlatformOverview`, `dayKey`) — the routes just
fetch + call them. 8 new unit tests (`test/analytics.test.js`) lock in the
netting: a reversed earn → 0 net across every window, redemption counts step by
sign, a fully-reversed reward/vendor drops from the top-lists, returning-customer
day-counting, windowing, and the 14-day series. `npm test` → 32 pass.

---

## Phase 5 — Polish / cleanup

- **README step 6 is stale**  ⬜ — "Add rewards rows in the Supabase table editor."
  Vendors self-serve rewards from the terminal Items screen now
  (`POST /api/vendor/rewards`). Fix the onboarding docs.
- **Branding consistency**  ⬜ — folder `psu-rewards`, product "WeRewards", domain
  `we-rewards.com`, auth keys `psu-*`. Pick one before real vendors see it.
- **Personal email in geocode User-Agent**  ⬜ — `src/lib/geocode.js` hardcodes a
  personal address in the Nominatim `USER_AGENT`; swap for a role address.

---

## Deferred (not now — noted so they're not forgotten)

- **Multi-instance readiness.** In-memory `express-rate-limit` store +
  adapter-less Socket.IO are single-instance only. Before scaling Heroku past one
  dyno, add `rate-limit-redis` + the Socket.IO Redis adapter.
- **Logos in Postgres.** Vendor/application logos are base64 in DB rows (~375KB
  each). Fine for a handful of vendors; move to Supabase Storage before dozens.
- **Structured request logging** (morgan-style access logs) for prod debugging.
- **Cryptographic code RNG.** Earn/redeem codes use Postgres `random()`. Low risk
  given the redeem defenses (single-use, 120s, per-vendor, PIN + rate-limited);
  switch to `gen_random_bytes` only if these codes ever gain more power.
- **Migration discipline.** Schema changes are still hand-run in the Supabase SQL
  editor. Several Phase 1–3 items add migrations — running them by hand against
  the live DB is workable but risky. Consider moving to versioned
  `supabase/migrations/` + `db push` (see `ci-cd-plan.md`, which is Render-worded
  but Supabase-side and host-agnostic).
- **Backups / PITR** — out of scope this session (revisit).
- **Legal:** privacy policy, ToS, vendor agreement, points-expiration policy —
  out of scope this session (the app already offers data export/delete via
  `/api/me/export` + `/api/me/delete`).

---

## ✅ Done (recent security-review pass)

- **DB test suite run for real.** Integration + security suites pass against a
  real Supabase stack (local `supabase start`) — atomic award/redeem/rollback,
  expired codes, void/refund + balance clamp + 1-minute window, and the
  anon/authenticated RPC-denial + PIN-gate regressions. See the README.
- **Supply-chain: SRI on supabase-js.** Both apps (+ /admin) pin an exact
  supabase-js version from jsDelivr with a Subresource Integrity hash. Bump the
  version + hash together on upgrade.
- **CSP `connect-src` scoped.** Dropped the bare `ws:`/`wss:` wildcard — only
  `'self'` + the Supabase origin.
- **`trust proxy` explicit + configurable** via `TRUST_PROXY` (default 1 = one
  PaaS proxy).
- **Operator `/admin` dashboard** (`ADMIN_EMAILS` allow-list): platform
  analytics + a unified error log capturing server 500s and client crashes from
  both apps (`error_logs`, migration-013; `/api/client-error`).

*Previously done (unchanged): migration-007 RPC lockdown, server-side PIN + idle
timeout, rate limiting, helmet, void/refund, vendor self-service settings,
student data export/deletion, tests + CI.*
