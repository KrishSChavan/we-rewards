# WeRewards

Per-vendor points rewards for local eateries. Student PWA + vendor terminal, one Express app.

## Architecture

- **`/`** — student PWA (rotating identity code, balances, redeem)
- **`/terminal`** — vendor terminal web app (one SCAN tab: the code's own shape
  routes it to award or redeem, big buttons, stats)
- **`/admin`** — operator dashboard (platform analytics + error log + vendor
  applications; `ADMIN_EMAILS`-gated)
- **`/join`** — public vendor application page; applications land in the admin
  dashboard's Applications tab for accept/reject
- **`/api/me/*`** — student endpoints (Supabase JWT auth)
- **`/api/vendor/*`** — vendor endpoints (Supabase JWT + `vendor_staff` link)
- **`/api/admin/*`** — operator endpoints (Supabase JWT + `ADMIN_EMAILS` allow-list)
- **`/api/apply`** — public vendor-application submit (unauthenticated, tightly
  rate-limited)
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
  On top of the per-IP limit, wrong PINs also lock the vendor **per-vendor**
  after 5 failures (migration-020), so an attacker can't rotate IPs to keep guessing.
- **Award limits.** A single award is hard-capped at **$200** server-side (no
  daily cap, no PIN bypass), and awards are **idempotent** on a client token
  (migration-019) so a retried award after a dropped response can't double-award.
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
   `supabase/migration-002.sql` through `supabase/migration-021.sql` in order.
   (migration-007 locks down the RPCs and adds the PIN-session table — required;
   migration-010 adds the void/refund RPC; migration-011 lets account deletion
   anonymize a student's transactions instead of being blocked by them;
   migration-012 switches the quick-amount buttons to a fixed dollar amount;
   migration-013 adds the `error_logs` table behind the `/admin` dashboard;
   migration-014 switches earn codes to 6 numeric digits;
   migration-015 adds the vendor address + geocoded lat/lng for the map card;
   migration-016 adds the vendor logo column;
   migration-017 lets an admin hard-delete a vendor by anonymizing its
   transactions instead of being blocked by them;
   migration-018 adds `vendor_applications` (the public `/join` queue) and
   `push_subscriptions` (admin web-push alerts);
   migration-019 adds award idempotency (`transactions.client_token`) so a
   retried award can't double-award — replaces `award_points` with a 5-arg
   version, so re-run the migration-007 grants it carries;
   migration-020 adds the per-vendor staff-PIN lockout
   (`vendors.failed_pin_attempts` / `pin_locked_until` + `record_pin_result`);
   migration-021 adds error-log retention (`prune_error_logs` + a daily pg_cron
   job) — if pg_cron isn't enabled it just raises a NOTICE, so enable pg_cron and
   re-run its final `DO` block to schedule the daily prune.)
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
5. Onboard your first vendor — either point them at the public `/join` page
   and accept the application from the `/admin` **Applications** tab, or run
   the CLI directly:
   ```
   npm run onboard -- --name "Local Eats" --slug local-eats \
     --email owner@example.com --password TempPass123! --ratio 10 --pin 4321
   ```
6. Add that vendor's rewards rows in the Supabase table editor
   (`rewards`: vendor_id, title, cost_in_points).
7. (Optional) Web-push alerts for new vendor applications and logged errors: run
   `npx web-push generate-vapid-keys`, put the keys in `.env`
   (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`), then click
   **🔔 Turn on alerts** in the `/admin` topbar and allow notifications. Once
   connected, that control becomes **🔔 Test alerts** for an end-to-end check.
   With no keys set, the dashboard reports alerts unavailable and everything
   else works.
8. (Recommended) Receipt forgery checking: get a key at
   [aistudio.google.com/apikey](https://aistudio.google.com/apikey), put it in
   `.env` as `GEMINI_API_KEY`, then verify it before you rely on it:
   ```
   npm run check:gemini                 # key + model + endpoint round trip
   npm run check:gemini -- receipt.jpg  # ...and read an actual receipt photo
   ```
   See **Receipt scanning** below for what this does and doesn't change.
9. (Optional) Product analytics: create a project at
   [posthog.com](https://posthog.com), copy the **Project API Key** (`phc_…`)
   from Settings → Project into `.env` as `POSTHOG_API_KEY`, and set
   `POSTHOG_HOST=https://eu.i.posthog.com` if the project is on EU. Then:
   ```
   npm run check:posthog          # config, then send one real test event
   npm run check:posthog -- --dry # config and payload only, send nothing
   ```
   With no key set, `client_events` still records everything and nothing else
   changes. See **Product analytics (PostHog)** below.

## Point math

- Ratio: `points_per_dollar` per vendor (e.g., 10).
- Quick-amount buttons (shown once the terminal's SCAN tab resolves a customer)
  award `floor(amount × ratio)`
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

## Recommended spots (migration-048)

Home's carousel has two modes. **Recent spots** is anywhere the student has been
in the last seven days; **Recommended** is the fallback when there is nothing
recent, which is every new signup and anyone back from a break — and it is what
the heading's menu switches to on demand.

Recommended answers *"where should I go next"*, so it is built from three rules,
and the first one is the reason the rest exist:

1. **Nowhere they have already been.** Everywhere the student has ever bought,
   redeemed, or scanned a visit is out before anything is picked. Handing a
   regular the five spots they visit most, under a heading that promises
   something new, is the failure mode this exists to avoid.
2. **The visit ranking leads.** What is left is ordered by
   `top_vendors_by_visits()` — distinct `(student, day)` pairs over 30 days, so a
   regular who buys coffee three times on Tuesday contributes one visit, not
   three. The server caches a pool of the top 25 (`RECOMMENDED_LIMIT`) rather
   than exactly five, because a student who has been to four of the top five
   would otherwise be left with a row of one.
3. **Newer spots trickle in.** Up to two of the five cards are reserved for spots
   that would not otherwise make the row, won by a per-spot dice whose odds
   **halve every 14 days** and reach zero at 60. A place that opened today is
   certain; one from last month is a long shot. Winners take the 2nd and 4th
   cards, so the row still opens on a proven spot.

The dice is `hash01(student, spot, day)`, not `Math.random()`. Three consequences,
all deliberate: the row cannot reshuffle between socket pushes while a student is
looking at it; different students see different newcomers on the same morning, so
a new spot is spread across the student body rather than spiked at it; and the
draw is redone at midnight, so a spot that missed today gets another go tomorrow.

**Five is a hard cap and the row is allowed to be shorter.** A student with two
spots left untried sees two — padding it with places they already go would undo
rule 1. Only when they have visited *everything* does it fall back to the plain
ranking, because a row of nothing is worse than a re-run of the classics.

The Spots tab's **Top** filter is deliberately *not* this list. It is the same
ranking for everybody, a student's own regulars included — a fact about the town
rather than advice to one person.

`student_visited_vendor_ids()` is a SQL function rather than a query in Node for
one specific reason: "ever been" is the only all-time per-student read in the app,
and `config.toml` caps PostgREST at `max_rows = 1000`. An unpaginated all-time
pull over `transactions` truncates there silently, and a heavy student's oldest
spots would read back as never-visited and be recommended to them forever. It
unions `transactions` (`earn`/`redeem`; a `community_transfer` happens in-app, not
at a counter) with `punch_cards` **existence** — not `punches > 0`, because
redeeming a visits-priced reward assigns that counter back to zero.

Without the migration applied the endpoint still answers: `visited` falls back to
the punch cards and recent transactions already in hand, which under-claims, so
the worst case is recommending somewhere they last went months ago.

## Receipt scanning

`POST /api/me/receipt` takes a photo of a paper receipt and awards the same
points a counter award would. Everything the claim depends on — which vendor,
how much, when — is decided **server-side**; nothing the client sends is
trusted, or the endpoint would be a points printer for anyone with `curl`.

Two readers, tried in order:

| | Reader | Reads text | Detects forgery |
|---|---|---|---|
| 1 | **Gemini** (`src/lib/gemini-receipt.js`), when `GEMINI_API_KEY` is set | ✅ structured fields + a transcription | ✅ |
| 2 | **tesseract** (`src/lib/ocr.js`), in-process wasm | ✅ transcription only | ❌ |

Reader 2 runs **only** when reader 1 couldn't be reached at all: no key, quota
exhausted (`429`), timeout, network error, or a response that didn't parse.
Those all resolve to `null`, which is the route's cue to fall through.

A **forgery verdict is not a failure** and is never retried through tesseract —
that would launder the rejection, since tesseract cannot tell a photographed
receipt from a photographed screen and would simply pay out. It rejects with
`RECEIPT_NOT_GENUINE`, and only above a confidence threshold
(`RECEIPT_FAKE_MIN_CONFIDENCE`, 0.7): real receipts are creased, faded, and
badly lit, and calling an honest student a forger is the worse error.

Field by field, the route takes Gemini's structured value and falls back to
regexing its transcription (`src/lib/receipt.js`) for anything it left null — so
a model that reads four fields and fluffs the fifth still lands the claim.
**The vendor is the exception**: Gemini's `vendor_name` is only ever a hint fed
into `matchVendor()` against the active-vendor table, so a hallucinated or
attacker-planted name can fail to match but can never mint a match.

Two failure modes worth knowing about, because both are otherwise invisible:

- **A bad key or model id fails silently.** Receipts keep scanning via
  tesseract; the only thing lost is the forgery check. Run
  `npm run check:gemini` to confirm the round trip, and watch the boot log line
  that names the active reader.
- **Exhausted quota would cost every upload the full timeout** before falling
  back, so a `429` opens a 5-minute circuit breaker and later scans skip
  straight to tesseract. Breaker transitions log `[gemini] pausing…` — never the
  image or the text.

The whole request is budgeted under Heroku's 30s H12 cutoff
(`RECEIPT_DEADLINE_MS`): whatever the AI pass doesn't spend is handed to
tesseract as its job timeout, so a slow AI call plus a fallback still answers.

Privacy: the photo is held in memory for one request and never written to disk,
the DB, or a log. With a key set it is POSTed to Google for that request —
disclosed in Privacy Policy §2.10 and §4.

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
award/redeem, and the **SCAN** tab carries a quick **Undo last** button
(two-tap, PIN-gated) for fixing a mistake mid-shift. Undo is only allowed within
**1 minute** of the transaction — enforced in the RPC, not just the UI — so a
vendor can fix an immediate slip but can't quietly claw points back from a customer
later. Analytics sums are signed, so a voided transaction nets back out.

## Vendor self-service settings

`GET`/`PATCH /api/vendor/settings` (PIN-gated) let a vendor tune their own
economics from the terminal's **SETTINGS** tab: points-per-dollar (bounded), the
exact-entry toggle, the quick-amount buttons (label + fixed dollar amount each),
and the staff PIN. The quick-amount buttons render as tap-to-award buttons on the
award pad the SCAN tab opens. A PIN change is re-hashed with bcrypt and **invalidates every
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

> The allow-list is not the whole gate. `requireAdmin` also requires the account
> to carry a **Google identity** and a **confirmed email**, because the public
> GoTrue signup endpoint will otherwise hand a confirmed session to anyone who
> registers an operator address that doesn't exist yet — which would turn the
> Supabase `mailer_autoconfirm` dashboard setting into a load-bearing security
> control. Both checks deny only on a *positive* signal (`providers: ['email']`,
> `emailVerified: false`); missing identity data is treated as unknown and
> allowed, so the gate cannot lock you out of your own dashboard. Denials for an
> allow-listed address are logged as `[admin] denied <email> — <reason>`; that
> line is how you'd diagnose one. See `adminRejection` in
> `src/middleware/auth.js` and `test/admin-gate.test.js`.

- `GET /api/admin/overview` — platform analytics: lifetime totals (vendors,
  students, transactions), today / 7-day / 30-day activity (awards, redemptions,
  points, revenue, active + new customers), a 14-day revenue series, and top
  vendors by revenue.
- `GET /api/admin/vendors` + `PATCH /api/admin/vendors/:id` — the vendor control
  panel: flip a vendor's `active` kill-switch (off = hidden from students and its
  terminal blocked, but all data kept, so it's reversible), set its street
  address, rename it, retune its rate, tag what it sells, or replace its `logo`
  (the same base64 data-URL the vendor's own terminal Settings writes — validated
  once for all four doors in `src/lib/logo.js`; `null` clears it, and `has_logo`
  is a generated column so it follows automatically). `GET
  /api/admin/vendors/:id/logo` reads the current artwork back for the editor —
  the public `/api/vendor-logo/:id` can't be used for that, since it withholds
  the image for an inactive vendor and is cached for an hour.
  `DELETE /api/admin/vendors/:id` **hard-deletes** a vendor — cascades
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
  `error_logs` (migration-013), server-only writes, no client read path. Read a
  page at a time (`?source=&limit=&offset=`, newest first) and answered as
  `{ errors, total, offset, limit }`, where `total` counts the log under the same
  `source` filter — the same envelope `/students`, `/referrals` and `/grants`
  return, so the dashboard can say how much it is not showing.
- `GET/POST /api/admin/ambassadors` + `PATCH`/`DELETE /api/admin/ambassadors/:id`
  — the **Ambassadors** tab (migration-053): people recruiting for the app, each
  with a code they chose, a QR to hand out, and a community-points rate paid to
  them per signup. A 409 on a duplicate code, a duplicate email, or an email with
  **no student account behind it** carries a `field` so the dialog can put its red
  text under the offending input; a delete on a code with traffic is refused
  unless `?force=1`. See "Ambassadors" below.

## Nearby spot alerts (migration-051)

A student walking past somewhere they have never earned at gets one
notification about it. Lives in **Account → Notifications → Nearby spots**, a
third switch beside Deal alerts and Deal emails, on by default.

### The web cannot do background geolocation, and this does not pretend to

There is no API for this on any platform. `navigator.geolocation` does not exist
in a service worker, the Geofencing API was withdrawn from Chrome in 2018 and
shipped nowhere else, and Periodic Background Sync cannot read a position even
where it runs. **The only moment a proximity test is possible is while the page
is open**, so that is when this runs, and the switch's own description says so.
Do not "fix" this later by reaching for a background API; there isn't one.

### The phone decides where; the server decides whether

`GET /api/me/balances` already ships every vendor's `latitude`/`longitude` and a
per-vendor `visited` flag (migration-048), so the distance maths needs no server
round trip and **no coordinates ever leave the device**. The client watches
position while the app is foregrounded, requires a **150m radius held for 30
seconds** (both tunable via `NEARBY_RADIUS_METERS` / `NEARBY_DWELL_SECONDS` and
served through `/api/public-config`), throws away any fix accurate to worse than
100m, and uses a wider exit radius so boundary jitter cannot reset the timer.

It then asks `POST /api/me/nearby/claim { vendorId }` — **a spot id and nothing
else** — and shows the notification itself via `registration.showNotification()`.
Nothing is pushed, so this works with no VAPID keys and on browsers with no web
push at all.

⚠ **The quota is SHARED with deal alerts, not parallel.**
`claim_nearby_notification` reads and writes the same
`student_notify_state.last_push_at / day_count / week_count` that
`claim_campaign_pushes` does, so a nearby alert spends a deal-alert slot and vice
versa. Two per day is the total number of times WeRewards interrupts a student,
whatever the reason. A second independent budget would have doubled the real
rate at exactly the moment the app started buzzing people in the street — and
the Block that follows takes the deal alerts down with it, since they share one
permission.

⚠ **Once per spot, ever.** `nearby_notifications`' primary key
`(user_id, vendor_id)` is the guard, and rows are **not** pruned when the student
later earns there — that is what stops the app introducing someone to the same
shop twice. A refused claim writes no row, so cooldown and quiet-hours refusals
leave the spot claimable tomorrow.

⚠ **Two permissions, not one.** Geolocation says where they are; notifications
are what let anything be shown. The enable path asks for notifications *first*,
because that is the one needing a user gesture (`askNotificationPermission`).

⚠ **Apply migration-048 first.** The claim delegates the "have they been here"
question to `student_visited_vendor_ids()`. Without it migration-051 does not
compile — a deliberate hard failure, because the app's silent fallback for that
function is a 7-day window, and interrupting someone to recommend the place they
had lunch at last month is the whole failure this feature must not have.

### Turning it off, and turning it back on

The switch writes itself **off** when the device says location is denied or
unavailable during the initial ask, and when a student revokes the permission
later (watched via `navigator.permissions`). A *timeout* deliberately does not
turn it off — a student in a basement must not silently lose a feature they
never touched.

A browser that has recorded a denial cannot be re-prompted; `getCurrentPosition`
fails instantly or never calls back. So touching the switch in that state opens
**#nearby-help**, a sheet of per-device instructions (installed iOS app, iOS
Safari, installed Android app, Android Chrome, desktop) for finding the setting.

## Trackable QR codes (migration-050)

Banners and posters get their own QR codes, so the operator can see which
placements people actually scan — and pay community points to the ones that
bring in accounts. Lives in **/admin → QR poster**, in its own card beneath the
scan-here poster uploader. The two are unrelated: that one is a single artwork
file every vendor terminal downloads, this one is a list of individually tracked
codes.

Each code carries a name, an optional placement note, a community-points award,
and a pause switch. The QR encodes `https://<origin>/r/<code>`, downloadable as
a print-ready **PNG or SVG** rendered in the browser from the vendored
`qrcode-generator` build — a third-party QR service would mean handing someone
else a link that pays out points.

### The award is attached to signing up, not to scanning

A printed code is photographable. The first student to scan a banner can text
the link to everyone they know, and nothing server-side can tell that apart from
a crowd standing in front of the poster. So the award is attached to the one
thing that cannot be shared: **creating an account**.

A scan alone never pays. When a new account is created after a scan, the payout
goes through `grant_community_points()` (migration-039) with
`ref_id = user_id, kind = 'tracked_qr'`, so 039's `unique (ref_id, kind)` index
makes it **once per account, ever** — the same shape as the signup bonus. There
is no new SQL that moves points, and therefore no new way to move them wrongly.

⚠ **The ten-minute window is load-bearing.** `POST /api/me/accept-terms` is not
"a new account"; every existing student re-POSTs it whenever `TERMS_VERSION` is
bumped. `maybeAwardTrackedQr` therefore requires `profiles.created_at` to be
essentially *now* — created by the very upsert calling it. Without that check, a
terms revision would pay the whole campus for posters they were never recruited
by. `src/lib/signup-bonus.js` solves the same problem with its program's date
window; a banner has none, so the test here is tighter.

⚠ **No incentives row, so no shared budget ceiling.** A poster award could have
been incentive kind #3, but `idx_incentives_one_active_per_kind` means every
banner would share one row and one budget, and an operator would have had to
create that deal before any banner could pay. The guards instead are the
per-banner cap (5000, matching the signup bonus) and `grant_community_points`'
own 100000 typo stop. To add a campus-wide cap later: widen
`incentives_kind_check` the way migration-040 did, and pass `p_incentive_id`.

### How a scan is counted

`GET /r/<code>` counts the scan, sets an httpOnly `SameSite=Lax` cookie, and
302s to `/?qr=<code>`. Three things it has to get right:

- **302, never 301**, and `Cache-Control: no-store`. Cloudflare fronts the dyno,
  and a cached redirect would make every later scan invisible.
- **The service worker is told to skip it** (`public/student/sw.js`). It
  intercepts every same-origin GET, so an installed PWA would otherwise serve a
  cached copy and never reach the server — and `Cache.put` rejects on the
  opaqueredirect a navigation fetch produces.
- **Link previews are not people.** iMessage, Slack, Discord and WhatsApp all
  fetch a pasted URL to build a preview card. Those user-agents are filtered out
  before a row is written, or the banners that got shared most would look like
  the ones that performed best.

Attribution rides on *both* the cookie and a `localStorage` stash of `?qr=`,
because a browser that refuses one usually accepts the other. Neither is
trusted — the server decides what is owed, and the once-per-account index caps
it however many codes a client sends.

Scan rows hold **no IP address and no account**: `visitor_hash` is the SHA-256
of a nonce this server minted into the visitor's own cookie, which counts a
returning phone without naming it. That is what the "people" column counts, as
opposed to raw scans.

### What the operator sees

Per code: scans, unique people, signups, points paid, first and last scan, a
30-day bar chart and a time-of-day histogram (bucketed in the **campus**
timezone — UTC would put the lunch rush at breakfast). Both a summary CSV and a
per-code raw scan log export.

Deleting a code that has traffic is refused — pausing keeps the history and the
banner on the wall keeps resolving. `active = false` stops the payout only;
scans still count, because the poster is still up.

## Ambassadors (migration-053)

People, rather than walls. An operator adds someone in **/admin → Ambassadors**
with their name, email, an optional phone number, and a **short code they chose
themselves** (3-10 letters or numbers, unique, stored uppercase). The row hands
back a code to copy and a QR to show, and reads back how many people scanned it
and how many of those signed up.

### The ambassador is paid, into their own account

Each row carries a **community points per signup** rate. When somebody creates an
account through that code, the ambassador is credited that many points — through
`grant_community_points()` (migration-039), so no new SQL moves points and the
migration-025 write guard, the ledger and the idempotency index all apply
unchanged. `0` is a real setting: measure somebody and pay them nothing.

⚠ **Which is why they must already have an account.** `grant_community_points`
raises `GRANT_STUDENT_UNKNOWN` for a user with no `profiles` row, and the
evaluator swallows that — it has to, since a payout may never cost a student
their consent. So an ambassador created against an address nobody has signed up
with would recruit people, show signups climbing, and never be paid, with the
only trace a line on stderr. The admin form therefore resolves the account from
the email **at create time** and refuses if there isn't one, with the message
under the email box. `ambassadors.user_id` pins the resolved account; it is a
real FK rather than a repeated email lookup because `profiles.email` is neither
unique nor `not null`.

Changing an ambassador's email **re-resolves the payee** — the stored `user_id`
belonged to the old address, and leaving it would keep paying the previous
person from an edit that looks cosmetic. The check is against the row's current
email, not merely "was an email sent", so an ambassador whose student account
has since been deleted can still be renamed or switched off.

**The idempotency key is the recruit, not the ambassador.** The grant is written
with `ref_id = the new student` and `kind = 'ambassador'`, so 039's
`unique (ref_id, kind)` index means one ambassador payout per account created,
ever. That is what pays one ambassador a hundred times (once per distinct
recruit) while making a second payout for the same recruit impossible. A recruit
can still separately be worth a poster award, because the `kind` differs.

⚠ **No incentives row, so no shared budget ceiling, and no lifetime cap.** Same
trade migration-050 made: incentives carry a one-active-deal-per-kind index, so
every ambassador would have shared one row and one budget. The guards are the
per-ambassador rate cap (5000, matching the signup bonus) and
`grant_community_points`' own 100000 typo stop. **A 5000-point rate times a
thousand recruits is five million points and nothing stops it** — raising a rate
to 100 or more is confirmed in the dialog for that reason, since
`community_grants` has no reversal path. To add a real ceiling: widen
`incentives_kind_check` the way 040 did and pass `p_incentive_id`.

If an ambassador later deletes their student account, `user_id` goes null
(`on delete set null`), their code keeps working, and their row shows a red
**No account** tag — flagged only when they have a non-zero rate, since a 0-rate
ambassador with no account has nothing going wrong. Re-saving the row re-links
them once they have signed up again.

### It shares the `/r/` rail with the printed banners

The QR encodes the same `https://<origin>/r/<code>` a poster does.
`src/routes/tracked-qr.js` tries a **banner** code first and falls through to an
**ambassador** one. One printed-URL rail means one rate limiter, one `no-store`
header, one service-worker exemption and one `URIError` guard — each of which was
learned the hard way in that file and none of which would be got right twice. The
redirect hands back the same `?qr=` parameter either way, because the client never
interprets the code: it stashes it and posts it to `accept-terms`, where two
evaluators each ignore what is not theirs. `public/student/app.js` needed no change.

⚠ **The second arm widened what `/r/` will look up.** A banner code is 8
characters of a restricted alphabet, so almost every junk path was refused by a
regex and cost nothing. An ambassador code is *any* 3-10 alphanumerics, so
`/r/hello` now costs one indexed lookup. That is inherent — a code that short
cannot be ruled out without asking — and the controls are the lookup being a
unique-index hit and the 600-per-quarter-hour-per-IP limiter in `server.js`. It
also means a test probe that used to touch no database may now touch one; see the
note atop `test/tracked-qr.test.js`, where exactly that happened and turned a
4ms test into a 31-second one.

### Three rules that do NOT carry over from the banners

| | Trackable QR (050) | Ambassador (053) |
|---|---|---|
| the code | 8 random characters, minted | 3-10, **typed by the operator** |
| `active = false` | pauses the **payout**; the URL keeps resolving and counting | stops the **link**; `/r/` redirects home and records nothing |
| identity | a name only | name + **unique** email + optional phone |
| who gets paid | the **new student** who signed up | the **ambassador**, into their own account |
| `kind` | `tracked_qr` | `ambassador` |

The middle row is the one to keep straight. A banner is bolted to a wall and
cannot be recalled, so pausing it could only ever mean "stop paying". A person
can simply be told they are finished, so turning them off stops their link —
and keeps their history, which is what the button promises.

⚠ **The two code namespaces can collide, and the guard is in Node.** An
8-character ambassador code lowercases into a legal banner code (`SARAHXYZ` →
`sarahxyz`), and the database will hold both happily. Because the resolver tries
banners first, such an ambassador would never be reached — so
`ambassadorConflict()` in `src/routes/admin.js` refuses the create. Only that
direction is guarded: a *minted* banner code landing on an existing ambassador's
is 1 in 31⁸. `behavior-053.sql` asserts the hazard is real so nobody deletes the
guard as redundant.

### Uniqueness is a promise the schema keeps

The dialog promises "SARAH7 is already Sarah Chen's code" and "that email is
already an ambassador", with the red text under the offending input rather than
at the top — the API sends a `field` with each 409 for exactly that. That rests
on two column CHECKs: `code = upper(code)` and `email = lower(email)`. Without
them, plain `UNIQUE` stops being a case-insensitive check and `SARAH7`/`sarah7`
become two rows the resolver picks between arbitrarily.

One attribution per account is a unique index on `ambassador_signups.user_id`,
belt and braces with the ledger index above — that one stops the money moving
twice, this one stops a second ambassador claiming a recruit when the rate was
**zero**, since a 0-rate ambassador writes no grant for the ledger index to see.
`ambassador_signups.points` records what each recruit was worth **at the time**,
so raising the rate never rewrites what past recruits earned.

The same ten-minute new-account window as the banners applies, for the same
reason: `accept-terms` is re-POSTed by every existing student on a
`TERMS_VERSION` bump. Now that money is involved there is also a **self-signup
guard** — an ambassador who deletes their account and signs up again through
their own code is a genuinely new account inside that window, and without the
check that would be a renewable payout.

## Vendor deals (campaigns)

The terminal's **DEALS** tab lets a vendor write an offer and send it to their
own customers. Students get it as a web-push notification and, always, as an
entry in the app's Deals list. Migration-032; delivery worker in
`src/lib/campaigns.js`.

**The problem this is shaped around.** A vendor's top 100 is not a private
audience. The tier model pays for breadth (`scoreProfile`'s synergy term is
`cbrt(B·L·S)`, so a one-spot student scores near zero), which means the students
who rank top-100 anywhere rank top-100 nearly everywhere. Five vendors posting a
Friday deal do not reach five separate groups — they reach the same core, and the
network's most valuable students get five notifications in a minute. Browser
permission is one-shot: after `Block`, `requestPermission()` no-ops forever. A
storm doesn't annoy the best users, it deletes them from the channel.

So vendors never send. They **enqueue**, and a worker decides what each student
receives:

| Fence | Default | Override |
| --- | --- | --- |
| Coalescing hold before release | 5 min | `CAMPAIGN_COALESCE_MINUTES` |
| Minimum gap between notifications | 4 h | `CAMPAIGN_COOLDOWN_MINUTES` |
| Per student per day / week | 2 / 5 | `CAMPAIGN_DAILY_CAP`, `CAMPAIGN_WEEKLY_CAP` |
| Same vendor to same student | 20 h | `CAMPAIGN_VENDOR_COOLDOWN_HOURS` |
| Vendors named in one digest | 4 | `CAMPAIGN_BUNDLE_MAX` |
| Quiet hours (campus-local) | 22:00–09:00 | `CAMPAIGN_QUIET_START/_END`, `CAMPAIGN_TIMEZONE` |
| Sends per vendor per week | 2 | `CAMPAIGN_VENDOR_WEEKLY_SENDS` |

The cooldown is the hard guarantee — whatever any number of vendors do, two
notifications to one student can never land closer together than it, enforced
under a `FOR UPDATE SKIP LOCKED` row lock in `claim_campaign_pushes()`. The hold
is what keeps that guarantee from being a silent tax on vendors 2..5: everything
due for a student travels in one claim, and two or more render as a single digest
("3 spots have something on") that opens the in-app list. A student with the app
in the foreground is skipped entirely — the socket already told them, so their
quota isn't spent on it.

Suppression never loses a message. `campaign_recipients` is written in full at
creation time and is what the Deals list reads, so a throttled, blocked, or
undeliverable notification only removes the interruption.

Vendors see counts, never students: the audience (`top` / `lapsed` / `close`) is
expanded server-side by `campaign_audience()`. Students opt out under **Account →
Notifications**, one switch per channel; the Privacy Policy §7.4 states the caps
above, so moving those defaults means moving that document (a unit test asserts
the pair).

Set the same `VAPID_*` keys as the admin alerts to enable push. With no keys the
worker never starts, campaigns still queue, and every deal still shows in-app.

### Email as the second channel (migration-047)

Web push does not exist on iOS outside an installed PWA, so before this the
largest single group of students could not be reached at all — `claim_campaign_pushes()`
skipped anyone without an endpoint, by design, and that is most of them.

Email now fills that gap, and **only** that gap. Push is tried first wherever it
is available; the email goes only if no endpoint accepted, so no student is told
twice about one deal. The claim reports which channels are open for each student
in `out_reach` (`push` / `email` / `both`), decided under the same row lock that
spends the quota.

The important consequence is that **email adds no throttling of its own**. It
rides the same claim, so every fence in the table above already applies to it:
the four-hour cooldown, the daily and weekly caps, the per-vendor fence, the
coalescing hold, and quiet hours. There is nothing new to tune and nothing that
can drift out of step with push.

`push_opt_in` and `email_opt_in` are **independent** — turning off *Deal alerts*
means no push, not silence — and every deal email carries RFC 8058 one-click
unsubscribe, handled at `/unsubscribe`.

## Email (Resend)

`src/lib/email.js` is the only mail transport, modelled on `src/lib/push.js`:
optional, never throws, and a silent no-op with no `RESEND_API_KEY`. Templates
are pure functions in `src/lib/email-templates.js`.

| When | Template | Class |
| --- | --- | --- |
| A `/join` application lands | `applicationReceived` | transactional |
| The operator accepts it | `applicationAccepted` | transactional |
| A reset code is minted (either door) | `vendorResetCode` | transactional |
| A deal could not be pushed | `dealDigest` | marketing |

**Transactional vs marketing is load-bearing, not a label.** Marketing is sent
only to a live opt-in, always carries `List-Unsubscribe`, and is refused for any
suppressed address. Transactional ignores a marketing opt-out entirely, because
"stop telling me my password changed" is not an option we offer.

**The suppression list** (`email_suppressions`) is the counterpart of the
404/410 endpoint prune in `push.js`. Resend's webhook posts to
`/api/webhooks/resend` (Svix-signed; unsigned requests are refused, since a
forged bounce could suppress a vendor's login and break their recovery). A
permanent bounce or a spam complaint suppresses at `all` and stops the student
being *claimed* at all — not merely stops the send, or their quota would be
spent every four hours on a message nothing can deliver. Transient bounces are
ignored: guessing wrong there locks a real vendor out of password recovery.

Run `npm run check:resend` before trusting any of it, and
`npm run check:resend -- you@example.com` to send one of each template to a real
inbox. A misconfigured key fails invisibly — nothing 500s, and four things just
quietly stop happening.

## Product analytics (PostHog)

`src/lib/posthog.js` mirrors the `client_events` table (migration-024) out to
PostHog. Modelled on `src/lib/email.js`: optional, never throws, and a silent
no-op with no `POSTHOG_API_KEY`. `client_events` stays the system of record —
PostHog is a copy, and losing it loses nothing.

`logEvent()` calls `capture()`, which is a synchronous enqueue. Events are
batched (20, or every 10s) and POSTed to `{POSTHOG_HOST}/batch/`, so no
third-party network hop ever lands on a path a student is waiting on. The queue
is flushed on SIGTERM, which is the shutdown Heroku announces on every deploy.

**This is server-side only.** No `posthog-js` runs in the browser, which is a
deliberate choice, not an omission — the CSP stays `script-src 'self'`, the
es2017 / safari12 bundle floor is untouched, and no service-worker cache needs
bumping. Two consequences worth knowing before you go looking for them:

- **No autocapture, session replay, or feature flags.** Those need the browser
  SDK. Adding it is a `public/` change (plus a `sw.js` `CACHE` bump per app),
  and `/scan` almost certainly cannot run it at all — it targets `safari12`,
  which already could not parse supabase-js.
- **Pre-login events have no person.** `pwa_launched` and most of the install
  funnel fire before sign-in, and this deployment sends no client-side anon id,
  so they go with `$process_person_profile: false`. They are queryable as counts
  and breakdowns but cannot be stitched into a true PostHog funnel. Signed-in
  events carry the Supabase user id and behave normally. Bucketing anonymous
  traffic under one shared id would have bought a funnel at the cost of
  inventing a single hyperactive "user" and corrupting every person metric in
  the project, which is not a trade worth making.

Failures split the way `push.js` prunes endpoints — keep what might still land,
drop what provably won't. A 5xx / 429 / network error re-queues; a 4xx is
dropped and logged once, because a bad project key fails identically forever.
A 1000-event ceiling keeps an unreachable vendor from becoming an OOM.

Verify before trusting it:

```bash
npm run check:posthog          # config, then send one real test event
npm run check:posthog -- --dry # config and payload only, send nothing
```

Region matters: a US key posted to the EU host is rejected and vice versa.
`POSTHOG_HOST` defaults to `https://us.i.posthog.com`; EU projects must set
`https://eu.i.posthog.com` explicitly.

## Vendor password recovery

Vendors sign in with a password rather than Google, so Supabase's own recovery
email never reaches them. Two doors mint the same kind of code (30 minutes, five
guesses, single use, `vendor_password_resets`):

- **Self-serve** — the terminal's *Forgot password?* screen has **Email me a
  code**, which posts to `/api/vendor/recover/request`. The everyday path.
- **Operator** — `/admin` mints one and shows it, and it is now also emailed.
  This stays because it is the only thing that works for a vendor who has lost
  the mailbox as well as the password.

The self-serve endpoint answers an identical `200` for every outcome — unknown
address, a student account at that address, still inside the cooldown, mail API
down — because a public endpoint that distinguishes them is a directory of which
addresses are vendor logins. The per-login cooldown is not mainly an
anti-mailbomb measure: minting supersedes any outstanding code, so without it
anyone who knows a vendor's address could invalidate their live code on repeat.

## Tests

`node:test`, no extra runtime deps. `npm test` runs everything; `npm run test:unit`
is the always-on, DB-free subset.

### Migration tests (Docker, no local Supabase)

`test/sql/run.ps1` builds a throwaway `postgres:16` from `schema.sql` + every
migration in order, seeds a realistic pre-migration world, applies the migration
under test, and asserts its runtime behaviour. Docker is on the **PowerShell**
PATH, not Git Bash.

`npm run test:sql` runs it on either laptop — it goes through
`scripts/run-ps.mjs`, which picks `pwsh` on macOS and `pwsh`-or-`powershell` on
Windows (see "Two laptops" in `mds/staging-setup.md`). To call it directly:

```powershell
powershell -File test/sql/run.ps1                        # migration-029 (the default pair)
powershell -File test/sql/run.ps1 -Migration migration-032.sql `
           -Seed seed-032.sql -Behavior behavior-032.sql # vendor campaigns
powershell -File test/sql/run.ps1 -Migration migration-050.sql `
           -Seed seed-050.sql -Behavior behavior-050.sql # trackable QR codes
powershell -File test/sql/run.ps1 -Migration migration-051.sql `
           -Seed seed-051.sql -Behavior behavior-051.sql # nearby spot alerts
powershell -File test/sql/run.ps1 -Migration migration-053.sql `
           -Seed seed-053.sql -Behavior behavior-053.sql # ambassadors
```

Each migration brings its own `-Seed` / `-Behavior` pair, because a seed written
for one migration is dismantled by later ones (030 drops the columns 029's seed
writes). `behavior-032.sql` stages the five-vendors-one-student storm and asserts
the student receives exactly one bundle.

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
