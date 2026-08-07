# Production transfer runbook

Move the production Supabase project off the school account and into the paid
personal org, before the school email is shut down during 2027.

|  | value |
|---|---|
| Project | `kfevnjbtgizcotexjjsp` (production) |
| From | the school-email account's organization |
| To | `zewshqdjfkyhzseabvde` — "MoM", the paid org on krishschavan@gmail.com |
| Mechanism | organization transfer (**not** a dump-and-restore) |
| Expected downtime | none to seconds |
| Code / config changes | **none** |

---

## Read this first: what a transfer is, and why it's cheap

Supabase has two different operations and they are not interchangeable.

- **Project transfer** moves a project "to a different organization *without
  touching the infrastructure*." Same machine, same region, same everything —
  only the billing owner changes.
- **Project migration** is a dump-and-restore into a *brand-new* project. It's
  for changing region or major Postgres version, and it mints a new project ref,
  a new API URL, new `anon` / `service_role` keys and a new JWT secret.

We want the first one. It means all of this survives untouched:

| Survives | Consequence |
|---|---|
| Project ref `kfevnjbtgizcotexjjsp` | Heroku config vars need no edit |
| `https://kfevnjbtgizcotexjjsp.supabase.co` | `SUPABASE_URL` unchanged |
| `anon` + `service_role` keys | `.env.prod-backup` and CI secrets unchanged |
| JWT secret | **students stay signed in** — no forced re-auth |
| `auth.users` + identities | no user migration, no password/identity rebuild |
| Google OAuth callback URL | the redirect URI is ref-based, so it still matches |
| All data | points, transactions, vendors, push subscriptions all stay put |

I checked the codebase against this: the production ref appears in **no tracked
file** — only in the gitignored `.env.prod-backup`. Everything reads
`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` from the
environment ([supabase.js:3-5](src/lib/supabase.js#L3-L5),
[server.js:659](server.js#L659)). So there is genuinely nothing to change
anywhere: not in the repo, not on Heroku, not in Google Cloud, not in GitHub
Actions.

That is the entire argument for doing it this way. A dump-and-restore would
invalidate every student's session, force a Heroku config change, a Google
redirect-URI change and a CI secret rotation, all in the same window.

---

## Correction to the premise

Staging is **not** in the paid org. As of today:

```
scattered-white-panda  ("KrishSChavan's Org", free)
  ├── we-rewards-staging   btjzpvuneuoqcmrmoxwc   ACTIVE    ← staging lives here
  └── MCA-25, yt-music-seacher, meetup, meetup-reboot, fam-sync   (all paused)

zewshqdjfkyhzseabvde   ("MoM", paid)
  └── MoM                  xnduhgagnjwwonzwmyyq   ACTIVE
```

Production is going into **MoM**, the paid org — not into the org staging is in.
That's the right call regardless: production holds real student points and today
runs on the Free plan with no PITR. Staging correctly stays on free, because
there's no reason to pay for it.

Budget note: on Pro, each project beyond the org's included $10 compute credit
bills separately — expect roughly **+$10/month** for a micro instance.

---

## Step 0 — Clear the three blockers

Supabase refuses a transfer if any of these exist. Check them on the
**production project, signed in as the school account**.

| Blocker | Where | Expected |
|---|---|---|
| Active GitHub integration | Project Settings → Integrations | none |
| Log drains | Project Settings → Log Drains | none (Free can't have them) |
| Project-scoped roles | Team/Enterprise only | N/A on Free |

> **Do not touch Heroku's GitHub connection.** The blocker is *Supabase's own*
> GitHub integration — a different thing that syncs migrations from a repo. If
> you disconnect Heroku's, production stops auto-deploying from `main` and you
> won't notice until your next push silently doesn't ship.

Also note the ref exactly as it reads today — `kfevnjbtgizcotexjjsp`. You are
going to compare against it in step 3.

---

## Step 1 — Give the personal account Owner on the source org

The transfer is performed by **one user who is Owner of the source org and at
least a Member of the target org**. Right now no such user exists:
`npx supabase projects list` on this machine is authenticated as the personal
account and doesn't list production at all, which confirms that account has no
access to the school org whatsoever.

Signed in as the **school account**:

> Organization (the one holding production) → **Team** → **Invite member**
> → `krishschavan@gmail.com` → role **Owner** → send.

Then accept the invite from the personal account.

The personal account already owns MoM, so it now satisfies both sides on its
own.

**Do it in this direction, not the reverse.** Inviting the *school* account into
your paid org would also technically work, but this direction has a second
payoff: from this moment you hold Owner access to the school org independently.
If that account is disabled tomorrow, mid-process, you have not lost the
project. That is the risk this whole exercise exists to close, so close it
first.

**Check:** `npx supabase projects list` from this machine now shows
`kfevnjbtgizcotexjjsp` alongside the others.

---

## Step 2 — Take a backup you control

The transfer doesn't rewrite data, so this is insurance, not a prerequisite. Do
it anyway — it is the only ownership operation you will ever run against a
database holding real student point balances, and Free plan has no PITR to fall
back on.

You need the database password. If you don't have it: production project →
Settings → Database → **Reset database password**.

> **Resetting it is safe here, and I verified why rather than assuming.** The app
> never opens a Postgres connection. There is no `pg`, `postgres`, `knex`,
> `drizzle` or `prisma` dependency in `package.json`, and no `DATABASE_URL` or
> `postgresql://` string anywhere in tracked code — the only client is
> `@supabase/supabase-js`, which authenticates with the `service_role` API key
> over HTTPS. Nothing in Heroku or CI holds a connection string to invalidate.

Get the pooler host from the dashboard's **Connect** dialog (Session pooler,
port 5432) rather than guessing the region — direct `db.<ref>.supabase.co`
connections are IPv6-only and this machine has no public IPv6.

```powershell
cd "c:\Users\krish\Downloads\psu-rewards (1)\psu-rewards"
$U = "postgresql://postgres.kfevnjbtgizcotexjjsp:<PASSWORD>@<pooler-host>:5432/postgres"

npx supabase db dump --db-url $U -f ..\prod-pre-transfer-schema.sql
npx supabase db dump --db-url $U --data-only -f ..\prod-pre-transfer-data.sql
npx supabase db dump --db-url $U --role-only -f ..\prod-pre-transfer-roles.sql
```

Written to the parent directory deliberately — outside the repo, so a stray
`git add -A` can't commit a full dump of student data.

**Check:** all three files are non-empty and the data dump contains `COPY public.point_balances`.

---

## Step 3 — Transfer

Signed in as the **personal** account, which is now Owner of both sides:

> Production project → Settings → **General** → scroll to **Transfer project**
> → target organization **MoM** → confirm.

**Before you confirm, read the project ref on the confirmation screen.** It must
still say `kfevnjbtgizcotexjjsp`. Everything in the "what survives" table above
is downstream of that one string. If it shows anything else, stop — that would
mean Supabase is doing a migration rather than a transfer, and Heroku, Google
Cloud, `.env.prod-backup` and the CI secrets would all need updating in the same
window.

The docs only warn about 1–2 minutes of downtime when moving **paid → Free**.
This is Free → paid, so expect none. Billing splits at the moment of transfer:
the school org is charged for usage up to it, MoM for everything after.

---

## Step 4 — Verify

In order, cheapest first:

1. Supabase dashboard → the project now appears under **MoM**, ref unchanged.
2. `https://we-rewards.com/api/health` → `{"ok":true}`.
3. Open `https://we-rewards.com/` in a browser **that was already signed in**.
   You should still be signed in — that's the JWT secret having survived, which
   is the single best proof the transfer preserved the project rather than
   rebuilding it.
4. Sign out and sign back in with Google. This exercises the OAuth callback
   `https://kfevnjbtgizcotexjjsp.supabase.co/auth/v1/callback`, which is
   ref-based and therefore untouched.
5. Confirm real data renders: a vendor list, a point balance, a recent
   transaction.
6. `https://we-rewards.com/api/me/push/public-key` still returns a key (Heroku
   env, unaffected — but it's a free end-to-end check).

If step 3 or 4 fails, nothing about the transfer is at fault by itself — check
the Heroku config vars are still what they were before assuming otherwise.

---

## Step 5 — Now that it's on Pro

- Database → **Backups**: confirm daily backups are running.
- Consider the **PITR** add-on. This is the actual reason to be on a paid org
  with a live app; free gave you nothing here.
- Check the compute instance size and what the org's bill now looks like.

---

## Step 6 — What this does *not* fix

The Supabase project is the easy one. Still on the school account:

- **The Google Cloud project holding OAuth client `376730753263-…`.** This is
  now the sharpest remaining risk. If it dies, every student's sign-in breaks,
  and the credential cannot be recovered — only re-registered, which means
  touching the Supabase Google provider config and every redirect URI. Audit it
  next.
- Heroku, the `we-rewards.com` registrar, and Cloudflare need the same check.
- GitHub is already personal (`KrishSChavan/we-rewards`) — nothing to do.

The school account keeps its own organization; only the project leaves it.

---

## Bonus: this unblocks step 11 of `staging-setup.md`

Step 11 ("teach the CLI about production's history") cannot run today — the CLI
is authenticated as the personal account, which can't see production, so
`supabase link --project-ref kfevnjbtgizcotexjjsp` would fail. After step 1 of
this runbook that link works, and after the transfer it's unambiguously yours.

Once linked, the `1..34` repair loop marks the hand-applied history as applied,
which leaves migrations `035`, `20260807045446_grant_service_role_on_public_tables`
and `20260807162120_revoke_anon_table_privileges` as genuinely pending on
production. Those are a separate release — don't fold them into the transfer
window, or a failure will be ambiguous between the two causes.

Remember to `npx supabase link --project-ref btjzpvuneuoqcmrmoxwc` afterwards.
The link is sticky, and whichever project you linked last is the one the next
`db push` hits.
