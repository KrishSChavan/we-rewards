# WeRewards

Per-vendor points rewards for local eateries. Student PWA + vendor terminal, one Express app.

## Architecture

- **`/`** — student PWA (rotating identity code, balances, redeem)
- **`/terminal`** — vendor terminal web app (enter code → award/redeem, big buttons, stats)
- **`/admin`** — operator dashboard (platform analytics + error log; `ADMIN_EMAILS`-gated)
- **`/api/me/*`** — student endpoints (Supabase JWT auth)
- **`/api/vendor/*`** — vendor endpoints (Supabase JWT + `vendor_staff` link)
- **`/api/admin/*`** — operator endpoints (Supabase JWT + `ADMIN_EMAILS` allow-list)
- **Supabase** — auth, Postgres, RLS for client reads; all writes go through
  server-side RPCs (`award_points`, `redeem_by_code`) which are atomic.

## Security model (server-enforced)

- **Service-only RPCs.** `award_points`, `create_earn_code`, `create_redeem_code`,
  and `redeem_by_code` are `SECURITY DEFINER` and have `EXECUTE` **revoked** from
  `anon`/`authenticated` (migration-007) — only the server's `service_role` key
  can call them, so a signed-in client can't mint points directly.
- **Staff PIN, server-side.** Redeem + item management require a PIN. `verify-pin`
  mints a session token stored in `vendor_pin_sessions`; the server checks it
  (`X-Vendor-Pin` header) on those routes — the gate is not just UI.
- **Rate limiting + headers.** `express-rate-limit` caps brute-force surfaces
  (the 4-digit PIN especially); `helmet` sets a strict CSP + security headers.
- **Keys.** The browser only ever gets the public anon/publishable key (RLS
  protects reads). The `service_role`/secret key is server-only — never shipped.

**Code security model:** the student shows a 6-digit identity code
(server-generated, unique among all live codes,
~5-min TTL, refreshed client-side). Redemption codes are 4 digits, unique
among all live codes, and
single-use — consumed atomically on redeem (`redeem_by_code`) and freed for
reuse afterward, 120s expiry. The server computes points from the vendor's own
config — the terminal never sends a point value.

## Setup

1. Create a Supabase project → SQL Editor → run `supabase/schema.sql`, then
   `supabase/migration-002.sql` through `supabase/migration-017.sql` in order.
   (migration-007 locks down the RPCs and adds the PIN-session table — required;
   migration-010 adds the void/refund RPC; migration-011 lets account deletion
   anonymize a student's transactions instead of being blocked by them;
   migration-012 switches the quick-amount buttons to a fixed dollar amount;
   migration-013 adds the `error_logs` table behind the `/admin` dashboard;
   migration-014 switches earn codes to 6 numeric digits;
   migration-015 adds the vendor address + geocoded lat/lng for the map card;
   migration-016 adds the vendor logo column;
   migration-017 lets an admin hard-delete a vendor by anonymizing its
   transactions instead of being blocked by them.)
2. Enable Google sign-in (for students):
   - Google Cloud Console → create an OAuth 2.0 Client ID (Web application)
   - Authorized redirect URI: `https://YOUR_PROJECT.supabase.co/auth/v1/callback`
   - Supabase → Authentication → Providers → Google → paste Client ID + Secret
   - Supabase → Authentication → URL Configuration → set Site URL to where the app runs
     (`https://we-rewards.com` in prod, `http://localhost:3000` in dev) — OAuth
     redirects go there
3. `cp .env.example .env` and fill in the keys. Set `ADMIN_EMAILS` to the
   Google account(s) allowed into the `/admin` dashboard, and add these to
   Supabase → Authentication → URL Configuration → Redirect URLs so sign-in
   returns to the right place:
   `https://we-rewards.com/**`, `http://localhost:3000/**`.
4. `npm install && npm run dev`
5. Onboard your first vendor:
   ```
   npm run onboard -- --name "Local Eats" --slug local-eats \
     --email owner@example.com --password TempPass123! --ratio 10 --pin 4321
   ```
6. Add that vendor's rewards rows in the Supabase table editor
   (`rewards`: vendor_id, title, cost_in_points).

## Point math

- Ratio: `points_per_dollar` per vendor (e.g., 10).
- Quick-amount buttons (the terminal's AWARD screen) award `floor(amount × ratio)`
  from a fixed dollar `amount` per button (edited in SETTINGS) — derived at request
  time, so changing the ratio updates every button automatically.
- Exact entry awards `floor(amount × ratio)`. Always floor, never round up.
- The base award is then multiplied by the customer's **tier multiplier**
  (1x / 1.5x / 2x, see below) and floored to whole points.

## Engagement tiers (earn multipliers)

`src/lib/tiers.js` scores each student's last 30 days of earn transactions
0–1000 from three balanced parts — breadth (% of vendors visited), depth
(vendors they revisit + visit frequency), and spend (capped volume +
meal-sized tickets). A linear blend keeps a floor for one-dimensional
customers; a geometric blend only pays out when all three are strong, so
looping through vendors beats whaling one. Anti-farming: visits count once
per vendor per day, and each visit credits at most $30 of spend.

- Score < 350 → **1x** (the vendor's own ratio)
- 350–699 → **1.5x**
- 700+ → **2x**

The score is computed live per request (no cron): the home screen shows it as
the tier bar (`GET /api/me/tier`), the terminal shows the customer's
multiplier on scan, and `/api/vendor/award` applies it server-side
(`base × multiplier`, tier computed before the purchase lands so a
transaction can't bump its own multiplier). Cutoffs and targets are
constants at the top of `src/lib/tiers.js` — recalibrate them once real
distribution data exists.

All source data lives in the `transactions` table (what happened, dollar
amount, points, the student, the vendor, the date). Each computed score is
also snapshotted to `user_scores` (score, tier, multiplier, B/L/S
components, visit + spend aggregates) so analytics can read scores straight
from the DB. `profiles.revisits` is a lifetime counter: +1 the first time a
student earns at a vendor on a new day after a previous visit — incremented
inside `award_points` atomically, backfilled by migration-005.

## Vendor analytics

`GET /api/vendor/analytics` (PIN-gated) aggregates the vendor's last 30 days of
transactions server-side into today / 7-day / 30-day totals (points awarded &
redeemed, revenue, redemptions, unique + returning customers), a 14-day daily
series, and top redeemed rewards. The terminal's **STATS** tab renders it. It's
computed from `transactions` (the source of truth), not the `user_scores` cache.

## Void / refund

Cashiers fat-finger amounts and redeem the wrong item. `POST /api/vendor/reverse`
(PIN-gated) calls the atomic `reverse_transaction` RPC (migration-010): it writes
a **compensating** transaction that negates the original's points and dollar
amount — never deletes — adjusts the balance (clamped at 0, so clawing back
already-spent points can't go negative), and refuses to double-reverse or reverse
a reversal. The original and its correction are linked (`reversed_by` / `reverses`).
The terminal's **STATS → Recent activity** list has a two-tap **Undo** on each real
award/redeem, and the AWARD/REDEEM scan screens carry a quick **Undo last** button
(two-tap, PIN-gated) for fixing a mistake mid-shift. Undo is only allowed within
**1 minute** of the transaction — enforced in the RPC, not just the UI — so a
vendor can fix an immediate slip but can't quietly claw points back from a customer
later. Analytics sums are signed, so a voided transaction nets back out.

## Vendor self-service settings

`GET`/`PATCH /api/vendor/settings` (PIN-gated) let a vendor tune their own
economics from the terminal's **SETTINGS** tab: points-per-dollar (bounded), the
exact-entry toggle, the quick-amount buttons (label + fixed dollar amount each),
and the staff PIN. The quick-amount buttons render as tap-to-award buttons on the
AWARD screen. A PIN change is re-hashed with bcrypt and **invalidates every
existing PIN session** for that vendor, so the terminal re-asks for the new PIN.

## Student data export + deletion

Privacy baseline in the student app's **Account** tab:
- `GET /api/me/export` — the student's profile, balances, full transaction
  history, and latest score snapshot, as a JSON download.
- `POST /api/me/delete` — deletes the auth user. `on delete cascade` removes the
  profile, balances, live codes, and score; transaction rows are **kept but
  anonymized** (`user_id → null`, migration-011) so vendors' revenue totals don't
  silently change.

## Operator admin dashboard

`/admin` is a separate, operator-only page (Google sign-in; the account's email
must be in the `ADMIN_EMAILS` env allow-list — enforced server-side by
`requireAdmin`, so the static page is public but its data is not):

- `GET /api/admin/overview` — platform analytics: lifetime totals (vendors,
  students, transactions), today / 7-day / 30-day activity (awards, redemptions,
  points, revenue, active + new customers), a 14-day revenue series, and top
  vendors by revenue.
- `GET /api/admin/vendors` + `PATCH /api/admin/vendors/:id` — the vendor control
  panel: flip a vendor's `active` kill-switch (off = hidden from students and its
  terminal blocked, but all data kept, so it's reversible) or set its street
  address. `DELETE /api/admin/vendors/:id` **hard-deletes** a vendor — cascades
  away its rewards / balances / staff links and clears the logo, while
  transactions are kept but anonymized (`vendor_id → null`, migration-017) so a
  student's history renders the gone vendor as a generic "Vendor". It also
  removes each linked login account, but only one left staffing no other vendor
  (a multi-location owner keeps theirs). Irreversible, unlike the toggle.
- `GET /api/admin/errors` — the unified **error log**: unexpected server 500s
  (captured in the central error handler) plus client-side crashes from the
  student PWA and vendor terminal, which post uncaught errors +
  unhandled rejections to `POST /api/client-error` (unauthenticated,
  size-capped, rate-limited). Rows carry a `source` (`server` / `student` /
  `vendor` / `admin`), message, stack, path, and best-effort user id. Stored in
  `error_logs` (migration-013), server-only writes, no client read path.

## Tests

`node:test`, no extra runtime deps. `npm test` runs everything; `npm run test:unit`
is the always-on, DB-free subset.

### Running the DB tests locally

The integration + security suites need a real Supabase stack and are **opt-in**
(they skip unless `TEST_SUPABASE_URL` is set). Never point them at your pilot DB —
they create and delete users/vendors. With Docker running:

```bash
npx supabase init                 # once — creates supabase/config.toml
npx supabase start                # boots local Postgres + auth + REST; prints keys
```

Apply the schema + every migration to the local DB (they aren't in the CLI's
`migrations/` layout, so pipe them in order), then run the suite against the URL
+ keys `supabase start` printed:

```bash
# schema first, then migration-002 … migration-013, e.g. via:
#   docker exec -i supabase_db_<project> psql -U postgres -d postgres < supabase/schema.sql
# (local-only: also GRANT table privileges to anon/authenticated/service_role,
#  which hosted Supabase does automatically)

TEST_SUPABASE_URL=http://127.0.0.1:54321 \
TEST_SUPABASE_ANON_KEY=<local anon key> \
TEST_SUPABASE_SERVICE_ROLE_KEY=<local service_role key> \
npm run test:integration
```

- **Unit** (`test/*.test.js`) — the pure engagement-scoring math and its
  anti-farming caps (`scoreProfile`), and the `requirePin` gate's no-DB branches.
- **Integration + security** (`test/integration/*.test.js`) — the atomic money
  RPCs (award, single-use redeem, insufficient-balance rollback, expired code,
  void/refund) and the security regressions (anon/authenticated can't execute the
  money RPCs; a PIN route with no `X-Vendor-Pin` returns `PIN_REQUIRED`). These
  are **opt-in**: they skip unless `TEST_SUPABASE_URL` (+ `TEST_SUPABASE_ANON_KEY`,
  `TEST_SUPABASE_SERVICE_ROLE_KEY`) point at a **disposable** project with the
  schema + migrations applied — never your pilot DB. CI runs the unit tests on
  every push/PR (`.github/workflows/ci.yml`); wire the `TEST_SUPABASE_*` secrets
  to run the DB suite there too.

## What's next

The four items previously tracked in [`next-steps.md`](next-steps.md) — tests + CI,
void/refund, vendor self-service settings, and student data export/deletion — are
all implemented (see the sections above).
