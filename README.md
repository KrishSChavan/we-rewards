# WeRewards

Per-vendor points rewards for local eateries. Student PWA + vendor terminal, one Express app.

## Architecture

- **`/`** — student PWA (rotating identity code, balances, redeem)
- **`/terminal`** — vendor terminal web app (enter code → award/redeem, big buttons, stats)
- **`/api/me/*`** — student endpoints (Supabase JWT auth)
- **`/api/vendor/*`** — vendor endpoints (Supabase JWT + `vendor_staff` link)
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

**Code security model:** the student shows a 6-char A–Z0–9 identity code
(server-generated, always a letter/digit mix, unique among all live codes,
~5-min TTL, refreshed client-side). Redemption codes are 4 digits, unique
among all live codes, and
single-use — consumed atomically on redeem (`redeem_by_code`) and freed for
reuse afterward, 120s expiry. The server computes points from the vendor's own
config — the terminal never sends a point value.

## Setup

1. Create a Supabase project → SQL Editor → run `supabase/schema.sql`, then
   `supabase/migration-002.sql` through `supabase/migration-007.sql` in order.
   (migration-007 locks down the RPCs and adds the PIN-session table — required.)
2. Enable Google sign-in (for students):
   - Google Cloud Console → create an OAuth 2.0 Client ID (Web application)
   - Authorized redirect URI: `https://YOUR_PROJECT.supabase.co/auth/v1/callback`
   - Supabase → Authentication → Providers → Google → paste Client ID + Secret
   - Supabase → Authentication → URL Configuration → set Site URL to where the app runs
     (`http://localhost:3000` in dev) — OAuth redirects go there
3. `cp .env.example .env` and fill in the keys.
4. `npm install && npm run dev`
5. Onboard your first vendor:
   ```
   npm run onboard -- --name "Yallah Taco" --slug yallah-taco \
     --email owner@example.com --password TempPass123! --ratio 10 --pin 4321
   ```
6. Add that vendor's rewards rows in the Supabase table editor
   (`rewards`: vendor_id, title, cost_in_points).

## Point math

- Ratio: `points_per_dollar` per vendor (e.g., 10).
- Tier buttons award `floor(midpoint(min, max) × ratio)` — derived at request
  time, so changing the ratio updates every button automatically.
- Exact entry awards `floor(amount × ratio)`. Always floor, never round up.
- The base award is then multiplied by the customer's **tier multiplier**
  (1x / 2x / 3x, see below).

## Engagement tiers (earn multipliers)

`src/lib/tiers.js` scores each student's last 30 days of earn transactions
0–1000 from three balanced parts — breadth (% of vendors visited), depth
(vendors they revisit + visit frequency), and spend (capped volume +
meal-sized tickets). A linear blend keeps a floor for one-dimensional
customers; a geometric blend only pays out when all three are strong, so
looping through vendors beats whaling one. Anti-farming: visits count once
per vendor per day, and each visit credits at most $30 of spend.

- Score < 350 → **1x** (the vendor's own ratio)
- 350–699 → **2x**
- 700+ → **3x**

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

## What's next

Tracked in [`next-steps.md`](next-steps.md): automated tests + CI, a void/refund
flow, vendor self-service settings, and student data export/deletion.
