-- ============================================================
-- Migration 063 — Incentive kind #3: the bonus window ("double points weekend").
--
--   "Between Friday 5pm and Sunday midnight, everything earned at every spot is
--   worth 2x." One new value in the incentives.kind CHECK, one reporting table,
--   and NO change to any function that moves points. That last part is the whole
--   shape of this file and the reason it is small.
--
--   ⚠ THIS KIND PAYS VENDOR POINTS, NOT COMMUNITY POINTS, AND THAT BREAKS THE
--   RULE MIGRATION-039 WAS BUILT AROUND. 039's header says it plainly: community
--   points are "the only balance the PLATFORM can hand out without a vendor
--   giving away product for a promise they never made." A bonus window does
--   exactly the thing that sentence rules out — it scales the balance a student
--   spends at a shop, at EVERY ACTIVE SHOP, with no vendor opt-in anywhere. The
--   extra points are a claim on that vendor's product, created by the operator.
--   That was chosen deliberately (it is the promotion students actually
--   recognise), and it is written here rather than softened because the next
--   person to read this file needs to know the guard rails are thin:
--
--     · the window is created SWITCHED OFF, like every incentive (039's POST),
--       so going live is always a second deliberate act;
--     · BOTH DATES ARE REQUIRED (enforced in src/routes/admin.js, not here) —
--       an unbounded 2x across the whole platform is the catastrophic
--       misconfiguration and it must not be reachable by leaving a field blank;
--     · config.maxMultiplier caps the COMBINED multiplier, so a tier-3 student
--       on a 2x weekend cannot earn 4x;
--     · bonus_window_credits, below, is what lets the operator answer "what did
--       this cost you?" when a vendor asks — which they will.
--
--   If vendors push back, per-vendor opt-in is a later migration: a join table
--   on (incentive_id, vendor_id) and one extra condition in the evaluator.
--   Nothing here forecloses it.
--
--   WHY NO FUNCTION CHANGES. award_points takes p_points ALREADY MULTIPLIED —
--   src/routes/vendor.js computes floor(basePoints * tierMultiplier) and hands
--   it over, and claim_receipt does the same through the same helper. A bonus
--   window is therefore a change to one multiplication in JavaScript, in two
--   places, and award_points is not touched at all. That matters: 045's header
--   spells out how carefully the money functions have to be rewritten, and this
--   feature does not need to earn that risk. The 10% community mint inside
--   award_points scales along with it for free, exactly as it already does for
--   a tier multiplier ("post-multiplier, so a 2x-tier student earning 300 mints
--   30, not 15").
--
--   WHY budget_points IS REFUSED FOR THIS KIND (in the admin route). incentives
--   .budget_points and .spent_points are a COMMUNITY-POINT rail: only
--   grant_community_points moves spent_points, and nothing in a bonus window
--   calls it. An operator who typed a budget here would be shown a cap that
--   could never fire and a spend of 0 forever, which is worse than no field at
--   all. The exposure number they actually want comes from the table below.
--
--   WHAT THIS FILE ADDS
--   1. 'bonus_window' in the incentives.kind CHECK — the 040 pattern, down to
--      looking the inline constraint's generated name up rather than assuming it.
--   2. bonus_window_credits — one row per boosted award: who, where, how much
--      extra, and under which multipliers. A REPORT, NOT A LEDGER (see below).
--   3. bonus_window_report() — the totals and the per-vendor breakdown, summed
--      in the database so the dashboard cannot truncate them.
--
--   ⚠ bonus_window_credits IS NOT A MONEY TABLE, and the distinction is load
--   bearing. The points it describes were already moved, atomically, by
--   award_points, and `transactions` is their record. This table is written
--   AFTERWARDS and BEST EFFORT by src/lib/bonus-window.js, because the
--   alternative is a cashier's award failing for the sake of a reporting row —
--   and 039's header is unambiguous that "nothing a cashier does can ever fail
--   because of this file." The consequence, stated so nobody is surprised by it:
--   IF THAT INSERT FAILS, THE REPORT UNDERCOUNTS. It is deliberately not the
--   number anything reconciles against. `transactions` is.
--
--   There is still a unique index on it, because the thing it is protecting
--   against is not a lost write but a DOUBLE count: a terminal that retries an
--   award reuses its client_token, award_points returns early without crediting
--   anything, and the retry is indistinguishable from the original to the server.
--   The index below is what stops the retry logging a second row and reporting
--   twice the exposure. Same (vendor_id, client_token) shape migration-019 put
--   on transactions, for the same reason.
--
--   THE ANNOUNCEMENT NEEDS NO SCHEMA, which is why there is none here for it.
--   A live window announces itself to every student once, and that rides
--   migration-061's broadcast rail unchanged: src/lib/bonus-window.js calls
--   create_admin_broadcast with a fixed created_by and a client_token derived
--   from the window's id, and 061's UNIQUE (created_by, client_token) — plus its
--   choice to RETURN the first broadcast for a repeated token rather than raise
--   — is already exactly the exactly-once primitive a timer running on every
--   dyno forever requires. So this file adds no "announced_at" column, and there
--   is no flag anywhere that could fall out of step with whether a push was
--   really sent. ⚠ It does mean 063 now depends on 061 having been applied; the
--   announce tick logs and returns rather than throwing if it has not.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-039 (and 061, for the announcement). Safe to re-run.
--
--   ⚠ DEPLOY ORDER: run this BEFORE the server code. The reverse order leaves
--   the Incentives tab 500ing on a missing function, and an operator who
--   creates a window before the CHECK accepts 'bonus_window' gets a constraint
--   violation with a message no operator should be shown. Nothing here is
--   called until the server asks, so the database is safe ahead of the deploy.
-- ============================================================

begin;

-- ---------- 1. the new kind ----------
-- The CHECK is inline in migration-039's create table, so Postgres named it,
-- and migration-040 already replaced it once. Look the name up rather than
-- assuming either generated name: an inline constraint's name is not part of
-- the contract, and a hard-coded DROP would fail on any database where it
-- differs. Same defensive shape 040 used.

do $$
declare con record;
begin
  for con in
    select c.conname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'incentives'
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%kind%'
  loop
    execute format('alter table public.incentives drop constraint %I', con.conname);
  end loop;
end;
$$;

alter table public.incentives
  add constraint incentives_kind_check
  check (kind in ('referral', 'signup_domain', 'bonus_window'));

-- ---------- 2. bonus_window_credits — the exposure report ----------

create table if not exists public.bonus_window_credits (
  id             uuid primary key default gen_random_uuid(),
  -- SET NULL, not cascade, for the same reason community_grants uses it: the
  -- operator's total exposure has to keep adding up even after the program row
  -- or the account is gone. A row with no incentive and no user is an amount
  -- and a date, which is not personal data.
  incentive_id   uuid references public.incentives (id) on delete set null,
  user_id        uuid references public.profiles (user_id) on delete set null,
  -- SET NULL again, and the same call admin_broadcasts.vendor_id makes:
  -- deleting a spot must not delete the record of what a promotion cost it.
  -- The report labels an orphaned row rather than dropping it, so the TOTAL
  -- stays right even when the attribution is lost.
  vendor_id      uuid references public.vendors (id) on delete set null,
  -- What the award would have been at the vendor's own rate, before any
  -- multiplier: floor(dollars * points_per_dollar).
  base_points    integer not null check (base_points > 0),
  -- The extra points this window is responsible for — awarded minus what the
  -- student's tier alone would have paid. Rows where that is zero (the cap
  -- clamped the product back down to the tier's own multiplier) are not
  -- written at all, which is what the CHECK says.
  bonus_points   integer not null check (bonus_points > 0),
  -- Both multipliers as applied, snapshotted. An operator editing the window
  -- tomorrow must not rewrite what today's rows say happened, the same reason
  -- referrals snapshots its payout (039) and punch_cards its target (028).
  -- numeric(4,2) holds every value src/lib/bonus-window.js can produce.
  tier_multiplier   numeric(4,2) not null check (tier_multiplier >= 1),
  window_multiplier numeric(4,2) not null check (window_multiplier >= 1),
  applied_multiplier numeric(4,2) not null check (applied_multiplier >= 1),
  -- Which earn path: 'counter' (a terminal award) or 'receipt' (a claimed paper
  -- receipt). Free text rather than a CHECK, the same call community_grants.kind
  -- makes: a new earn path should not need a migration to be reportable.
  source         text not null,
  -- The terminal's idempotency token, carried through so a retried award cannot
  -- be counted twice. Null for paths that have none; see the partial index.
  client_token   text,
  created_at     timestamptz not null default now()
);

comment on table public.bonus_window_credits is
  'Per-award record of what a bonus_window incentive added, for operator and '
  'per-vendor reporting. NOT a money table and NOT authoritative: the points '
  'were moved by award_points and are recorded in transactions. Written best '
  'effort, so this can undercount. See migration-063.';

comment on column public.bonus_window_credits.bonus_points is
  'Awarded points minus what the student''s tier multiplier alone would have '
  'paid. This is the operator''s true marginal exposure, not the whole award.';

-- THE double-count stop. A terminal that retries an award reuses its token;
-- award_points returns early and credits nothing, but the server cannot tell a
-- retry from an original, so without this the report would count the exposure
-- twice. Partial, so the receipt path (which has no token) is unconstrained.
-- First insert wins, the same shape as transactions' (vendor_id, client_token).
create unique index if not exists idx_bonus_credits_once
  on public.bonus_window_credits (vendor_id, client_token)
  where client_token is not null;

-- The report's two access patterns: everything for one program, and one
-- vendor's slice of it.
create index if not exists idx_bonus_credits_incentive
  on public.bonus_window_credits (incentive_id, created_at desc);
create index if not exists idx_bonus_credits_vendor
  on public.bonus_window_credits (vendor_id, created_at desc);

alter table public.bonus_window_credits enable row level security;
-- RLS on with no policies: server-only, like incentives and community_grants.
-- Nothing reaches this table except the Express API with the service key.
grant all privileges on public.bonus_window_credits to service_role;
revoke all privileges on public.bonus_window_credits from anon, authenticated;

-- ---------- 3. bonus_window_report ----------
-- One round trip for the whole Incentives panel: the totals, plus the vendors
-- that gave the most away.
--
-- WHY A FUNCTION AND NOT A POSTGREST READ. supabase/config.toml sets
-- max_rows = 1000, so pulling the credit rows and summing them in JavaScript
-- would silently stop at a thousand and the exposure figure would freeze there
-- and get quietly more wrong with every award — the exact bug the header of
-- GET /api/admin/incentives describes having already shipped once on this tab.
-- A sum computed in the database cannot truncate.
--
-- Returns jsonb rather than a row set because the panel needs scalars AND a
-- list, and one shape beats two queries that could disagree about the window
-- they were taken in.

create or replace function public.bonus_window_report(p_incentive_id uuid)
returns jsonb
language sql security definer set search_path = public
stable
as $$
  with totals as (
    select
      count(*)                      as awards,
      coalesce(sum(base_points), 0) as base_points,
      coalesce(sum(bonus_points), 0) as bonus_points,
      count(distinct user_id)       as students,
      max(created_at)               as last_award_at
    from bonus_window_credits
    where incentive_id = p_incentive_id
  ),
  -- Capped at 50: a campus with 200 vendors would otherwise put 200 rows in
  -- every poll of the Incentives tab for a panel that shows a short table. The
  -- TOTALS above are over everything, so the number that matters is never the
  -- truncated one — only the breakdown is, and the caller says so on screen.
  per_vendor as (
    select
      c.vendor_id,
      -- Null when the spot has been deleted (on delete set null). Labelled by
      -- the caller rather than here; the point is that the row survives so the
      -- breakdown still adds up towards the total.
      max(v.name)                     as vendor_name,
      count(*)                        as awards,
      coalesce(sum(c.bonus_points), 0) as bonus_points
    from bonus_window_credits c
    left join vendors v on v.id = c.vendor_id
    where c.incentive_id = p_incentive_id
    group by c.vendor_id
    order by coalesce(sum(c.bonus_points), 0) desc
    limit 50
  )
  select jsonb_build_object(
    'awards',        (select awards from totals),
    'basePoints',    (select base_points from totals),
    'bonusPoints',   (select bonus_points from totals),
    -- ⚠ "STUDENTS WHO STILL HAVE AN ACCOUNT", not students ever paid.
    -- count(distinct user_id) skips nulls, and user_id is nulled when an
    -- account is deleted (on delete set null, above) — so this figure can only
    -- fall over time while bonusPoints and awards stay fixed. That is the
    -- unavoidable cost of not keeping a deleted student's id: the id is the
    -- only thing that made their rows distinct. The two money figures are the
    -- ones to quote at a vendor; this one is a rough reach number.
    'students',      (select students from totals),
    'lastAwardAt',   (select last_award_at from totals),
    'vendorsShown',  (select count(*) from per_vendor),
    -- ORDER BY INSIDE THE AGGREGATE, not just in the CTE. per_vendor's own
    -- ORDER BY is there to decide WHICH fifty rows the LIMIT keeps; the order
    -- jsonb_agg emits them in is a separate question, and a plain
    -- `jsonb_agg(...) from per_vendor` is only incidentally sorted — nothing in
    -- the SQL standard or in Postgres promises an aggregate sees a subquery's
    -- rows in that subquery's order, and a parallel or re-planned scan is free
    -- to hand them over in any order at all. The panel draws this list as
    -- "the spots that gave the most away", so it has to be ordered on purpose.
    'vendors',       coalesce((
      select jsonb_agg(jsonb_build_object(
        'vendorId',     vendor_id,
        'name',         vendor_name,
        'awards',       awards,
        'bonusPoints',  bonus_points
      ) order by bonus_points desc, vendor_id)
      from per_vendor
    ), '[]'::jsonb)
  );
$$;

comment on function public.bonus_window_report(uuid) is
  'Totals and per-vendor breakdown for one bonus_window incentive, summed in '
  'the database so the dashboard cannot truncate them. Reads '
  'bonus_window_credits, which is best-effort and can undercount. '
  'See migration-063.';

revoke execute on function public.bonus_window_report(uuid) from public, anon, authenticated;
grant  execute on function public.bonus_window_report(uuid) to service_role;

commit;
