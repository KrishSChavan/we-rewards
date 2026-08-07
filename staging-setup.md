# Staging setup runbook

The code is done and sits on the `staging` branch. What follows is account work
across three dashboards. Do it in order — each step unblocks the next. Roughly
45 minutes end to end.

**The one rule:** the staging Heroku app must never hold production Supabase
credentials. It would write real points to real students, and its campaign worker
would push real notifications to their phones. Everything else in here is
recoverable; that isn't.

Nothing you do before step 10 can affect production.

---

## Step 0 — Commit and push the `staging` branch

Heroku can only auto-deploy a branch that exists on GitHub, so this comes first.

```powershell
cd "c:\Users\krish\Downloads\psu-rewards (1)\psu-rewards"
git add -A
git commit -m "staging environment: APP_ENV test-app identity + CLI migrations layout"
git push -u origin staging
```

**Why this is safe:** production auto-deploys from `main`, and `main` is not
being touched. Pushing a new branch triggers CI (which is what you want) and no
deploy.

**Check:** GitHub → branch dropdown shows `staging`. The Actions tab shows a CI
run for it, and it goes green.

---

## Step 1 — Create the staging Supabase project

Supabase dashboard → **New project**.

- Organization: same one as production.
- Name: `werewards-staging`
- Database password: generate one and **save it now** — step 2 needs it and the
  dashboard won't show it again.
- Region: same as production (keeps latency behaviour comparable).
- Plan: Free.

Wait for provisioning (~2 minutes).

Now collect four values. Keep them in a scratch note; you'll paste them in
steps 2, 3 and 4.

| Value | Where |
|---|---|
| Project URL | Settings → API → Project URL |
| `anon` key | Settings → API → Project API keys |
| `service_role` key | Settings → API → Project API keys (click *Reveal*) |
| Project ref | Settings → General → Reference ID (also the `xxxx` in `xxxx.supabase.co`) |

> The `service_role` key bypasses row-level security entirely. It belongs only in
> a Heroku config var and your local `.env` — never in the browser, never in a
> commit.

---

## Step 2 — Build the schema from the migrations

This replays all 34 files in `supabase/migrations/` against the empty database.

```powershell
cd "c:\Users\krish\Downloads\psu-rewards (1)\psu-rewards"
npx supabase login          # opens a browser, authorises the CLI once
npx supabase link --project-ref <staging-ref>
```

`link` will prompt for the database password from step 1. It may also report
differences between the remote settings and `supabase/config.toml` — that's
informational, not an error.

**Confirm you are pointed at staging before you push anything:**

```powershell
npx supabase projects list
```

The linked project is marked with a ● in the leftmost column. It must be
`werewards-staging`. This matters more than it looks — the link is sticky (stored
in the gitignored `supabase/.temp/`), so whichever project you linked last is the
one `db push` will hit, today or in three weeks. Right now the CLI is linked to
nothing, so this first link is a clean slate.

Then:

```powershell
npx supabase db push
```

It lists the migrations it's about to apply and asks for confirmation. Expect all
34, `00000000000001_schema.sql` through `00000000000034_migration-034.sql`.

### What can go wrong here, and what it means

**A migration fails.** This has never been run as a sequence before — the 34
files were applied to production one at a time, by hand, over months. A failure
means the recorded history doesn't reproduce the database you're actually
running. That's worth knowing. Fix the migration file and re-run; don't hand-patch
staging, or you'll have built a second database that the migrations can't
reproduce either.

**`pg_cron not available` notices.** Expected and harmless. Migrations 021, 023,
031 and 032 schedule cleanup jobs inside `DO` blocks that degrade to a NOTICE
when the extension is off. The functions still install; only the schedules are
skipped. Staging doesn't need retention jobs. To enable them anyway: Database →
Extensions → enable `pg_cron`, then re-run those `DO` blocks.

**Everything pushes, but the app later says permission denied on every query.**
`schema.sql` grants nothing at table level — it was written when hosted Supabase
auto-exposed new `public` tables, and that default has since flipped. Fix it as a
*new migration* granting `anon`, `authenticated` and `service_role` on the
tables, so production gets the same treatment if it's ever rebuilt.

**Check:** Table Editor shows `vendors`, `profiles`, `transactions`,
`point_balances`, `campaigns` and the rest. All empty.

---

## Step 3 — Wire up sign-in

Two dashboards. Google needs to know the new Supabase project exists; Supabase
needs to know the new app origin exists.

### 3a. Google Cloud Console

APIs & Services → Credentials → your existing **OAuth 2.0 Client ID** (the one
production uses — do *not* create a second one).

Under **Authorized redirect URIs**, click *Add URI*:

```
https://<staging-ref>.supabase.co/auth/v1/callback
```

Save. Existing production URIs stay exactly as they are.

### 3b. Staging Supabase → Authentication → Sign In / Providers → Google

Enable it, and paste the **same** Client ID and Client Secret production uses.
(Get them from the same Google credential page if you don't have them to hand.)

### 3c. Staging Supabase → Authentication → URL Configuration

- **Site URL:** `https://we-rewards-staging.herokuapp.com`
- **Redirect URLs** — add both:
  - `https://we-rewards-staging.herokuapp.com/**`
  - `http://localhost:3000/**`

The `/**` wildcard matters: the admin dashboard returns to `/admin`, not the root.

No code change is needed — sign-in already sends `window.location.origin`
([app.js:373](public/student/app.js#L373)), which is why the same build works on
both origins.

---

## Step 4 — Create the staging Heroku app

### 4a. The app

Heroku dashboard → **New → Create new app**.

- Name: `we-rewards-staging` (this becomes the URL — if it's taken, pick another
  and use it consistently everywhere below, including step 3c)
- Region: same as production.

### 4b. Eco dyno

Account **Billing** → subscribe to **Eco dynos** ($5/month, a pool of 1000
dyno-hours shared across every Eco app on the account). Then the app's
**Resources** tab → change the `web` dyno to **Eco**.

Eco dynos sleep after 30 minutes idle and take a few seconds to wake on the next
request. That's fine for a test app, and it's why the pool lasts.

### 4c. Config vars — do this BEFORE the first deploy

Settings → **Reveal Config Vars**. The app throws at startup if the three
Supabase variables are missing, so deploying first just gives you a crashed dyno
and a confusing log.

| Key | Value |
|---|---|
| `SUPABASE_URL` | staging Project URL (step 1) |
| `SUPABASE_ANON_KEY` | staging anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | staging service_role key |
| `APP_ENV` | `staging` |
| `APP_ORIGIN` | `https://we-rewards-staging.herokuapp.com` |
| `ADMIN_EMAILS` | your Google address |
| `TRUST_PROXY` | `1` |
| `VAPID_PUBLIC_KEY` | `BOQTL9PzIZZr_0NnNmryRt7JQ-BPqzY5gztnTxJJYpK03u0AqQf-3pW2b4uxi-VYKDDMkCyVCDuabzGbHzcYN9c` |
| `VAPID_PRIVATE_KEY` | `vv5xgaIrrhHkoYD4jChCRj4ToMpdwdOfm3PCO9iNbic` |
| `VAPID_SUBJECT` | `mailto:` + your email |

I generated that VAPID pair for this purpose; it has never been used anywhere. If
you'd rather mint your own: `npx web-push generate-vapid-keys`.

Three of these are worth understanding rather than just pasting:

- **`APP_ENV=staging`** is the whole switch. It's what gives you the `TEST`-named
  home-screen icon, the crimson theme, and the self-busting service-worker cache.
  Without it the staging app is a pixel-identical copy of production and you
  won't be able to tell the two icons apart on your phone.
- **`TRUST_PROXY=1`, not 2.** This is the count of proxies in front of the app.
  Staging has one (the Heroku router); production has two (Cloudflare, then
  Heroku). Set it to 2 here and the app trusts a client-supplied
  `X-Forwarded-For`, which lets anyone spoof their IP and walk straight through
  every rate limiter. **While you're in the dashboard, check production's
  value — it should be `2`.** If it isn't, production's rate limits are keyed
  wrong today and that's worth fixing separately.
- **Fresh VAPID keys.** Push subscriptions are minted against a specific keypair.
  Sharing production's would let a staging bug reach a real student's phone, and
  would let each environment prune the other's subscriptions as dead.

### 4d. Connect GitHub and deploy

**Deploy** tab → Deployment method → **GitHub** → authorise if prompted → search
for `we-rewards` → **Connect**.

- Under *Automatic deploys*, choose branch **`staging`** → **Enable Automatic
  Deploys**. Leave "wait for CI to pass" off here if you like — staging is where
  you want to see broken things.
- Under *Manual deploy*, choose `staging` → **Deploy Branch** to trigger the
  first build now.

Watch the build log. It runs `npm ci` on Node 24 (from `.node-version`) and starts
`node server.js` from the `Procfile`.

**Check:** `https://we-rewards-staging.herokuapp.com/api/health` returns
`{"ok":true}`.

---

## Step 5 — Smoke-test staging in a desktop browser

Before touching your phone, confirm the environment is correctly wired:

1. Open `https://we-rewards-staging.herokuapp.com/` — the tab title should read
   **TEST · WeRewards · eat local, earn free food**. If it says plain
   `WeRewards`, `APP_ENV` isn't set.
2. Open `https://we-rewards-staging.herokuapp.com/manifest.json` — `"name"`
   should be `"TEST WeRewards"` and `"theme_color"` `"#b3261e"`.
3. Sign in with Google. If it errors, the redirect URLs in step 3c don't match
   the app's actual origin.
4. **The isolation check that matters:** the app should be empty — no vendors, no
   points, no history. If you see real production data, stop and re-check
   `SUPABASE_URL` in the Heroku config vars. That is the failure this whole
   environment exists to prevent.
5. Load `https://we-rewards.com/` in another tab and confirm it looks and behaves
   exactly as it did before.

---

## Step 6 — Install the test PWA on your phone

Visit `https://we-rewards-staging.herokuapp.com/` on the phone → Add to Home
Screen.

**Check:** you now have two icons. The new one is labelled **TEST WeRewards**;
the original is untouched, still signed in, still holding its own cache and
session. They're different origins, so they share nothing — separate service
worker, separate storage, separate push subscription.

Then prove the deploy loop works, because everything else depends on trusting it:

1. Change something obvious — a heading in `public/student/index.html`.
2. `git commit` and `git push` on `staging`.
3. Wait for the Heroku build (~1 min), then reopen the installed TEST app.

The change should appear **without you touching any `CACHE` constant in
`sw.js`**. That's `serveTestSw()` stamping the app's content hash onto the cache
name, so each deploy invalidates its own cache. If the change *doesn't* appear,
stop and work out why — a test environment that serves you the previous deploy's
code is worse than none, because you'll draw confident conclusions from it.

(On production the manual `CACHE` bump rule still applies, unchanged.)

---

## Step 7 — Repoint local dev

Back up the production keys first, then swap them out:

```powershell
cd "c:\Users\krish\Downloads\psu-rewards (1)\psu-rewards"
Copy-Item .env .env.prod-backup
```

`.gitignore` covers `.env.*`, so the backup is never committed.

Now edit `.env`: replace `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` with the staging values, replace the VAPID pair with
the staging pair, and add:

```
APP_ENV=staging
```

Restart `npm run dev`. Your local app now runs against staging, and
`http://localhost:3000` shows the `TEST ·` title too.

To debug a genuine production issue, copy `.env.prod-backup` back over `.env`
temporarily. Making that a deliberate act — rather than the default state — is
the entire point.

---

## Step 8 — Seed something to look at

With the staging keys live in `.env`:

```powershell
npm run onboard -- --name "Test Cafe" --slug test-cafe `
  --email you+test@example.com --password TempPass123! --ratio 10 --pin 4321
```

Then add two or three `rewards` rows in the staging Table Editor (`vendor_id`,
`title`, `cost_in_points`) so the student app has something to render.

Sign into `https://we-rewards-staging.herokuapp.com/terminal` with that email and
password to check the vendor side works.

---

## Step 9 — Switch on the database-backed test suites

The integration and security suites have been silently skipping in CI for want of
credentials. Point them at staging.

GitHub repo → Settings → Secrets and variables → **Actions** → New repository
secret, three times:

- `TEST_SUPABASE_URL` → staging Project URL
- `TEST_SUPABASE_ANON_KEY` → staging anon key
- `TEST_SUPABASE_SERVICE_ROLE_KEY` → staging service_role key

`ci.yml` already passes these through ([ci.yml:26-29](.github/workflows/ci.yml#L26)),
so no workflow change is needed.

Sharing the project with CI is safe: each test provisions its own vendor and
student and tears them down in an `after()` hook
([helpers.js:11-12](test/integration/helpers.js#L11)).

**Check:** push any commit and watch the Actions log — the integration tests
should now report real results instead of skipping.

---

## Step 10 — Harden the production deploy

*This is the first step that touches production. It is one checkbox.*

Production Heroku app → **Deploy** tab → Automatic deploys → tick **"Wait for CI
to pass before deploy"**.

CI already runs on every push to `main`; right now it runs *alongside* the deploy
rather than gating it, so a red build still ships. This makes `main`'s green
check a precondition.

**Check:** deliberately break a test on a throwaway branch, PR it to `main`, and
confirm the merge is blocked from deploying. Then delete the branch.

---

## Step 11 — Teach the CLI about production's history

Production's database was built by hand, so the CLI has no record of what's
applied. Left alone, a future `db push` there would try to recreate all 34
migrations and fail. Tell it the history is already in place.

**Re-link first — you are currently linked to staging:**

```powershell
npx supabase link --project-ref <PRODUCTION-ref>
npx supabase projects list        # confirm the ● is on production before continuing
```

Then mark all 34 versions as applied in one loop:

```powershell
foreach ($n in 1..34) {
  npx supabase migration repair --status applied ('{0:D14}' -f $n)
}
npx supabase migration list
```

**Check:** `migration list` shows local and remote columns matching on all 34
rows, with nothing pending. `repair` only writes to the migration bookkeeping
table — it does not run any SQL against your schema.

When you're done, **re-link to staging** so the next `db push` doesn't surprise
you:

```powershell
npx supabase link --project-ref <staging-ref>
```

---

## The loop from here on

```
commit to staging ─► push ─► Heroku builds ─► test on your phone
                                                     │
                                            merge staging → main
                                                     │
                                    CI passes ─► production deploys
```

```powershell
# ship a tested change to production
git checkout main
git merge staging
git push            # production deploys once CI is green
git checkout staging
```

**A database change:**

1. Write `supabase/migrations/<14-digit-timestamp>_what_it_does.sql`. Use a real
   timestamp (`npx supabase migration new what_it_does` generates the name) —
   only the historical 34 use the zero-padded counter.
2. Confirm the CLI is linked to **staging**, then `npx supabase db push`.
3. Exercise it on the staging app.
4. Re-link to **production** and `db push` there, in the same release as the code
   that needs it.
5. Re-link back to staging.

Keep migrations expand-first: add and backfill in one release, drop in a later
one. That way rolling the app back never lands on schema it can't read — there is
no down-migration, only a new forward fix.

## What staging deliberately doesn't reproduce

Production sits behind Cloudflare; staging doesn't. CDN caching behaviour is
production-only — that's what the `?v=<content-hash>` asset stamping in
`server.js` exists to handle, and it can only be truly confirmed in production.
