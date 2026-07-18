# CI/CD Pipeline Plan — WeRewards

> Reference doc for building the deploy pipeline. Decisions locked: host =
> **Render**, environments = **production only** (staging deferred), DB =
> **Supabase CLI migrations**, git host = **GitHub**.

## Context

WeRewards is live-bound: an Express (Node 24) app on Supabase, serving three
static PWAs, with a `Procfile` but **no host actually wired up yet**. The goal is
to be able to *safely change code once it's live in front of real vendors and
students* — a merge-to-ship pipeline where every change is tested before it
reaches production, the app redeploys automatically, database schema changes are
versioned and deliberate, and a bad deploy can be rolled back in one click.

The repo is **90% of the way there** already: there's a working
[`.github/workflows/ci.yml`](.github/workflows/ci.yml), a health endpoint
(`GET /api/health`, [server.js:180](server.js#L180)), a clean `npm start`, and DB
test suites that self-skip without secrets. The three gaps are: (1) CI pins Node
22 but the app needs 24; (2) nothing deploys the app; (3) database migrations are
hand-run in the Supabase SQL editor and aren't in a versioned, repeatable form —
the single riskiest thing to keep doing once live.

### Pipeline at a glance

```
                 ┌─────────────── Pull Request ───────────────┐
   push branch → │  GitHub Actions CI: npm ci · npm test ·     │  ← branch
                 │  npm audit (advisory)                        │    protection
                 └──────────────────┬──────────────────────────┘    requires
                                    │ merge (only if CI green)       CI green
                                    ▼
                        push to main
                     ┌──────────────┴───────────────┐
                     ▼                               ▼
        Render auto-deploy               GitHub Actions "migrate" job
        npm ci → npm start               `supabase db push`
        health-check /api/health         (manual approval gate)
        → live, or auto-rollback         → applies only NEW migrations
```

App code and DB schema deploy on two tracks that meet at `main`: app deploys are
automatic and health-checked; DB migrations run through a human-approved job so a
schema change against the live pilot DB is always deliberate.

---

## Prerequisites (one-time)

1. **Make it a git repo + push to GitHub.** The local copy has no `.git`.
   `git init`, commit, create a GitHub repo, push. Confirm `.env` is ignored — it
   already is ([.gitignore](.gitignore)).
2. **Render account** connected to the GitHub repo.
3. **A disposable Supabase project for CI DB tests** (never the pilot DB — the
   suites create/delete users). Grab its URL + anon + service-role keys.
4. **A Supabase personal access token** (Account → Access Tokens) + the pilot
   project's **ref** and **db password**, for the migration job.

---

## Part A — Fix & harden CI  (`.github/workflows/ci.yml`, modify)

The existing workflow is good; three edits:

1. **Node 22 → 24** in both jobs (`setup-node` `node-version: 24`) to match
   `package.json` `engines.node: 24.x`. Add a **`.node-version`** file
   (contents: `24`) at repo root so CI, Render, and local `nvm`/`fnm` all agree
   on one source of truth.
2. **Wire the DB suites** by adding the three `TEST_SUPABASE_*` repo secrets
   (from the disposable project) — the `env:` block already passes them through
   ([ci.yml:26-29](.github/workflows/ci.yml#L26)). The disposable DB must have
   `schema.sql` + all migrations applied; the migration job in Part C can double
   as the "prep the CI DB" step, or seed it once by hand.
3. Keep the advisory `audit` job as-is (`continue-on-error: true`).

No build step exists (PWAs are static) — CI stays `npm ci` + `npm test`. Do
**not** add a bundler; there's nothing to bundle.

---

## Part B — App deploy to Render  (`render.yaml`, new)

Use a **Blueprint** so the service config is versioned in-repo, not click-ops.

Create `render.yaml` at repo root defining one web service:
- `runtime: node`, `buildCommand: npm ci`, `startCommand: npm start`
- `healthCheckPath: /api/health` → Render gates each deploy on the new instance
  passing health before cutover, and **auto-rolls-back** a deploy that never goes
  healthy (near-zero-downtime for a single service).
- `autoDeploy: true` on the `main` branch (deploy on every push to main).
- `envVars` with `sync: false` for every secret (set the *values* in the Render
  dashboard, never in the file): `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAILS`, `TRUST_PROXY=1` (Render sits one
  proxy in front — matches the default in [server.js:29](server.js#L29)), and
  `NODE_VERSION=24`.

**Post-deploy config in Supabase/Google** (already documented in the
[README](README.md#L52) — carry it over to the real Render URL): set the Supabase
Auth **Site URL** + **Redirect URLs** to the Render domain, and add that domain
as an authorized origin/redirect in the Google OAuth client. Until this is done,
sign-in redirects break in prod.

**Gating deploys on tests:** Render's native auto-deploy fires on push to `main`.
The gate that keeps a broken change out of prod is **branch protection** (Part D)
— `main` only ever receives already-CI-passed code via merged PRs, so
auto-deploying `main` is safe. (Optional hardening later: turn off Render
auto-deploy and fire a Render **deploy hook** from a post-merge Actions job, for
an explicit "tests-then-deploy" chain. Not needed for the pilot.)

---

## Part C — Database migrations  (the important one)

Today `supabase/schema.sql` + `migration-002…017.sql` are flat files applied by
hand. Convert to the Supabase CLI's versioned layout so schema changes ship the
same disciplined way code does.

### C1. Restructure existing SQL into `supabase/migrations/`
Move each file into `supabase/migrations/` with an **ordered timestamped name**
(the CLI applies lexicographically), preserving current order:
`00000000000000_schema.sql`, `00000000000002_migration-002.sql`, …,
`00000000000017_migration-017.sql`. Keep the SQL content byte-identical — this is
a *rename/reorganize*, not a rewrite.
- Caveat from the README: the local-only `GRANT`s that hosted Supabase does
  automatically must **not** leak into shared migrations (they'd be redundant or
  wrong on cloud). Confirm none of the committed files contain them.

### C2. Baseline the live DB so `db push` doesn't re-run history
The pilot DB **already has all this applied manually**, so we must tell the CLI
"these are done" before the first push, or it will try to re-create existing
objects and fail.
- `supabase link --project-ref <pilot-ref>`
- Mark every existing migration as already-applied in the remote history:
  `supabase migration repair --status applied <version>` for each.
- Verify with `supabase migration list` — local and remote histories should match
  with **nothing pending**. From here on, only *new* files push.
- *Alternative if reconciliation is fiddly:* `supabase db pull` to snapshot the
  current live schema into one baseline migration and retire the old files.
  Recommend the move-and-repair path since the SQL is already authored/reviewed.

### C3. Gated migration job  (`.github/workflows/migrate.yml`, new)
A separate workflow, triggered on push to `main` **but held behind a manual
approval gate** — because auto-running schema changes against a live pilot DB
unattended is the one thing we don't want fully automatic.
- Uses `supabase/setup-cli`, `supabase link`, then `supabase db push`.
- Secrets (GitHub repo secrets): `SUPABASE_ACCESS_TOKEN`,
  `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`.
- **Approval gate:** bind the job to a GitHub **Environment** (e.g. `production`)
  with *Required reviewers = you*. `db push` only runs after you click approve,
  and the job log shows exactly what SQL will run first.
- **Ordering rule (document it):** write migrations **expand-first / backward-
  compatible** (add column/table, backfill, *then* a later deploy uses it; drop
  only after code no longer references it). That way app-deploy and
  migrate-approve can happen in either order without a broken intermediate state,
  and an app rollback never lands on schema it can't handle.

---

## Part D — Safety rails

- **Branch protection on `main`** (GitHub → Settings → Branches): require a PR,
  require the **CI** status check to pass, no direct pushes. This is the core
  mechanism that makes "change code while live" safe — nothing untested reaches
  `main`, and `main` is what Render ships.
- **Dependabot** (`.github/dependabot.yml`, new): weekly npm update PRs; each runs
  through CI. Complements the advisory `npm audit` job.
- **Secrets inventory** (no secret ever committed):
  - *Render dashboard:* `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
    `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAILS`, `TRUST_PROXY`, `NODE_VERSION`.
  - *GitHub Actions secrets:* `TEST_SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY`
    (CI), `SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_REF` /
    `SUPABASE_DB_PASSWORD` (migrate).

---

## Files to create / modify

| File | Action |
|------|--------|
| `.github/workflows/ci.yml` | modify — Node 22→24 |
| `.node-version` | new — `24` |
| `render.yaml` | new — Render Blueprint (web service, health check, env vars) |
| `supabase/migrations/*.sql` | new — existing SQL renamed into ordered timestamped files |
| `.github/workflows/migrate.yml` | new — approval-gated `supabase db push` |
| `.github/dependabot.yml` | new (optional) — weekly npm updates |

No application code changes are required — `/api/health`, `npm start`, and the
`TRUST_PROXY` handling are already deploy-ready.

---

## Verification (end-to-end, once wired)

1. **CI:** open a throwaway PR with a trivial change → confirm the `test` job runs
   on Node 24 and (with `TEST_SUPABASE_*` set) the integration/security suites
   actually run instead of skipping. Break a test on purpose → confirm the PR is
   blocked from merging.
2. **App CD:** merge to `main` → watch Render build (`npm ci`) and deploy → hit
   `https://<render-url>/api/health` and expect `{"ok":true}`; load `/`,
   `/terminal`, `/admin`; do one real Google sign-in to confirm the OAuth
   redirect URLs are right.
3. **Migrations:** add a no-op migration (e.g. a harmless `COMMENT ON TABLE`) →
   push to `main` → confirm the `migrate` job **pauses for approval**, the log
   shows the exact SQL, approve → `supabase migration list` shows it applied and
   nothing pending. Confirm a second run is a no-op (idempotent).
4. **Rollback drill:** in Render, click **Rollback** to the previous deploy →
   confirm the app returns to the prior version and stays healthy.

## Rollback runbook

- **App:** Render dashboard → Deploys → **Rollback** to the last-good deploy
  (previous image is retained). One click, near-instant.
- **DB:** there is no automatic down-migration — recovery is a new forward-fixing
  migration (or Supabase PITR restore for a data disaster). This is *why*
  migrations must be expand/contract and approved by a human.

## Deferred (out of scope for the pilot)

- **Staging environment** — a second Render service + Supabase project on a
  `staging` branch, promoting to prod after verification. The single biggest
  future upgrade for change-safety; `render.yaml` + the workflows are structured
  so adding it later is additive.
- **Per-PR preview environments** (Render `previews`) — needs an ephemeral DB per
  PR; revisit with staging.
- **Multi-instance readiness** — the in-memory rate-limit store + adapter-less
  Socket.IO are single-instance only (already noted in
  [next-steps.md](next-steps.md#L43)); add `rate-limit-redis` + the Socket.IO
  Redis adapter before scaling Render past one instance.
