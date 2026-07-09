# PSU Eats Rewards

Per-vendor points rewards for local eateries. Student PWA + vendor terminal, one Express app.

## Architecture

- **`/`** — student PWA (rotating identity QR, balances, redeem)
- **`/terminal`** — vendor terminal web app (scan → award/redeem, big buttons)
- **`/api/me/*`** — student endpoints (Supabase JWT auth)
- **`/api/vendor/*`** — vendor endpoints (Supabase JWT + `vendor_staff` link)
- **Supabase** — auth, Postgres, RLS for client reads; all writes go through
  server-side RPCs (`award_points`, `redeem_by_code`) which are atomic.

**Code security model:** the student shows a 6-char A–Z0–9 identity code
(server-generated, always a letter/digit mix, unique among all live codes,
~5-min TTL, refreshed client-side). Redemption codes are 4 digits, unique
among all live codes, and
single-use — consumed atomically on redeem (`redeem_by_code`) and freed for
reuse afterward, 120s expiry. The server computes points from the vendor's own
config — the terminal never sends a point value.

## Setup

1. Create a Supabase project → SQL Editor → run `supabase/schema.sql`, then
   `supabase/migration-002.sql`, `supabase/migration-003.sql`, and
   `supabase/migration-004.sql` in order.
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

## Build order from here

1. Student PWA: auth → balances screen → identity + redemption short codes
2. Vendor terminal UI: code entry → tier buttons → confirm → auto-return
3. Redeem flow both sides
4. Manifest + service worker (offline shell), then pilot with one vendor
# we-rewards
