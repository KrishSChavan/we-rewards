-- ============================================================
-- Migration 039 — Incentives: operator-created deals that pay community points.
--
--   The admin dashboard grows an INCENTIVES tab. Everything it can create pays
--   out in the SAME currency: community points (migration-026), the cross-vendor
--   pool a student can already move into any vendor's balance (migration-027).
--   That choice is the whole design. Community points are the only balance in
--   WeRewards that isn't keyed to a vendor, so they are the only balance the
--   PLATFORM can hand out without a vendor giving away product for a promise
--   they never made.
--
--   WHAT THIS FILE DOES
--   1. incentives — one row per operator-created deal. `kind` is the engine
--      ('referral' today; signup bonuses and scavenger hunts are later kinds),
--      `config` is the per-kind knobs as JSON, validated server-side. A partial
--      unique index enforces AT MOST ONE ACTIVE INCENTIVE PER KIND, which kills
--      a whole class of "which deal applied?" bugs before it exists.
--   2. community_grants — the payout ledger. Every community point this system
--      hands out lands here first, with who/why/how-much/which-deal.
--   3. grant_community_points() — the ONLY way to write those points. Sets the
--      migration-025 write guard, checks the incentive's budget, writes the
--      ledger row, then credits community_balances. Everything else in this
--      file (and every future incentive kind) goes through it.
--   4. referrals + profiles.referral_code — the first engine. One row per
--      referred student, UNIQUE on friend_id: a student can be referred once,
--      ever, and no later deal can change that.
--   5. settle_referrals() — the sweeper. Pays the referrer once their friend
--      has actually earned points somewhere. Runs on a timer OUT OF BAND, never
--      on the award path (see WHY A SWEEPER below).
--
--   WHY A SWEEPER, NOT A TRIGGER ON transactions
--   Paying the referrer the instant their friend's first purchase lands is
--   tempting, and it is a trap. A trigger (or an inline call in
--   /api/vendor/award) puts referral logic inside the transaction a cashier is
--   waiting on: a bug in the payout, an exhausted budget, a lock wait, and the
--   AWARD fails. A student standing at a counter would be told their points
--   didn't go through because of a referral bug. So qualification is a poll:
--   settle_referrals() finds pending referrals whose friend now has an 'earn'
--   row and pays them. Worst case the referrer waits a minute. Nothing a
--   cashier does can ever fail because of this file.
--
--   ERROR STRINGS — every code raised here was checked against server.js's
--   central error map, which matches by SUBSTRING. Note in particular that
--   REFERRAL_BAD_CODE is deliberately NOT called REFERRAL_CODE_INVALID: the map
--   already holds CODE_INVALID, which is a substring of it, so the student would
--   have been shown "Ask the customer to refresh their code" instead. Nothing
--   below contains, or is contained by, an existing key.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run. Safe to re-run.
-- ============================================================

begin;

-- ---------- 1. incentives ----------

create table if not exists public.incentives (
  id            uuid primary key default gen_random_uuid(),
  -- The engine that evaluates this deal. Adding a kind means adding a CHECK
  -- value here AND an evaluator; an unknown kind must never silently pay.
  kind          text not null check (kind in ('referral')),
  name          text not null,
  active        boolean not null default true,
  starts_at     timestamptz,
  ends_at       timestamptz,
  -- Total community points this deal may EVER pay. null = unlimited, which is
  -- a deliberate choice an operator has to make rather than a default they get
  -- by accident (the admin form defaults it to a number).
  budget_points integer check (budget_points > 0),
  spent_points  integer not null default 0 check (spent_points >= 0),
  -- Per-kind knobs, validated in src/routes/admin.js, never here. Keeping the
  -- shape out of the schema is what lets kind #2 and #3 ship without a
  -- migration for every field they need.
  config        jsonb not null default '{}'::jsonb,
  created_by    text,
  created_at    timestamptz not null default now()
);

comment on table public.incentives is
  'Operator-created deals that pay community points. One row per deal; `kind` '
  'selects the engine and `config` holds its knobs. See migration-039.';

-- AT MOST ONE ACTIVE DEAL PER KIND. Without this, two live referral programs
-- means every attribution has to pick one, every report has to sum across them,
-- and a student can argue they were promised the better of the two. Deactivate
-- the old one to launch a new one.
create unique index if not exists idx_incentives_one_active_per_kind
  on public.incentives (kind) where active;

alter table public.incentives enable row level security;
-- RLS on with no policies: server-only, like earn_codes and receipt_claims.
-- Nothing reaches this table except the Express API with the service key.
grant all privileges on public.incentives to service_role;
revoke all privileges on public.incentives from anon, authenticated;

-- ---------- 2. community_grants — the payout ledger ----------

create table if not exists public.community_grants (
  id           uuid primary key default gen_random_uuid(),
  -- SET NULL, not cascade: a deleted account takes its balance with it, but the
  -- ledger has to keep adding up or an incentive's budget accounting silently
  -- rewrites itself every time someone leaves. A row with no user attached is
  -- an amount and a reason, which is not personal data. Same reasoning as
  -- receipt_claims (migration-038).
  user_id      uuid references public.profiles (user_id) on delete set null,
  points       integer not null check (points > 0),
  -- Free text rather than a CHECK: a new incentive kind invents its own labels,
  -- and a CHECK here would mean a migration for every one of them. The values
  -- in use today are 'manual', 'referral_referrer' and 'referral_friend'.
  kind         text not null,
  reason       text,
  incentive_id uuid references public.incentives (id) on delete set null,
  -- The thing being paid for (a referrals.id today). Paired with `kind` it is
  -- the idempotency key — see the unique index below.
  ref_id       uuid,
  granted_by   text,                                   -- admin email, or 'system'
  created_at   timestamptz not null default now()
);

comment on table public.community_grants is
  'Every community point handed out by an incentive or an operator. Written '
  'only by grant_community_points(). See migration-039.';

-- THE double-payment stop. A referral can pay its referrer exactly once and its
-- friend exactly once, whatever the sweeper does under a race or a retry. This
-- is the same first-insert-wins shape as receipt_claims' once-per-receipt index.
create unique index if not exists idx_community_grants_once
  on public.community_grants (ref_id, kind) where ref_id is not null;

create index if not exists idx_community_grants_user on public.community_grants (user_id, created_at desc);
create index if not exists idx_community_grants_time on public.community_grants (created_at desc);

alter table public.community_grants enable row level security;
grant all privileges on public.community_grants to service_role;
revoke all privileges on public.community_grants from anon, authenticated;

-- ---------- 3. grant_community_points — the only way to pay ----------
-- SECURITY DEFINER and service_role-only, exactly like every other function
-- that touches a money table. Constraint 1 of community-points.md applies: the
-- migration-025 guard triggers cover community_balances, so this must announce
-- itself with the transaction-local GUC before it writes anything.

create or replace function public.grant_community_points(
  p_user_id      uuid,
  p_points       integer,
  p_kind         text,
  p_reason       text default null,
  p_incentive_id uuid default null,
  p_ref_id       uuid default null,
  p_granted_by   text default null
)
returns table (new_balance integer, grant_id uuid)
language plpgsql security definer set search_path = public
as $$
declare
  -- A ceiling on a single grant. Not a business rule — a typo stop. An operator
  -- meaning 500 who types 50000 should be told no, not fund a student's year.
  c_max_grant constant integer := 100000;
  v_balance   integer;
  v_grant     uuid;
begin
  perform set_config('app.points_write', 'server', true);   -- constraint 1

  if p_points is null or p_points <= 0 or p_points > c_max_grant then
    raise exception 'GRANT_POINTS_INVALID';
  end if;

  if p_kind is null or btrim(p_kind) = '' then
    raise exception 'GRANT_POINTS_INVALID';
  end if;

  -- The student must exist. community_balances.user_id references profiles, so
  -- the insert below would fail anyway; this turns an FK violation into a code
  -- the API can map to a sentence an operator understands.
  if not exists (select 1 from profiles where user_id = p_user_id) then
    raise exception 'GRANT_STUDENT_UNKNOWN';
  end if;

  -- Idempotency, checked up front so the caller gets a clean code. The unique
  -- index is what actually guarantees it under a race; this is the friendly path.
  if p_ref_id is not null and exists (
    select 1 from community_grants where ref_id = p_ref_id and kind = p_kind
  ) then
    raise exception 'GRANT_ALREADY_PAID';
  end if;

  -- Budget. The UPDATE is the check: the WHERE clause refuses to move
  -- spent_points past budget_points, so two concurrent payouts cannot both
  -- squeeze under the last of the budget. A deal with a null budget always
  -- matches and simply accumulates spend for the report.
  if p_incentive_id is not null then
    update incentives
       set spent_points = spent_points + p_points
     where id = p_incentive_id
       and (budget_points is null or spent_points + p_points <= budget_points);
    if not found then
      raise exception 'GRANT_BUDGET_EXHAUSTED';
    end if;
  end if;

  -- Ledger first, balance second. If anything below fails the whole call rolls
  -- back together, so the two can never disagree; writing the ledger first just
  -- means a stack trace points at the money that was about to move.
  begin
    insert into community_grants (user_id, points, kind, reason, incentive_id, ref_id, granted_by)
    values (p_user_id, p_points, p_kind, nullif(btrim(p_reason), ''), p_incentive_id, p_ref_id, p_granted_by)
    returning id into v_grant;
  exception when unique_violation then
    -- Lost the race against a concurrent identical payout. The winner already
    -- credited the student; this call must not credit them again.
    raise exception 'GRANT_ALREADY_PAID';
  end;

  insert into community_balances (user_id, balance, lifetime_earned)
  values (p_user_id, p_points, p_points)
  on conflict (user_id) do update
    set balance         = community_balances.balance + p_points,
        lifetime_earned = community_balances.lifetime_earned + p_points,
        updated_at      = now()
  returning balance into v_balance;

  return query select v_balance, v_grant;
end;
$$;

comment on function public.grant_community_points(uuid, integer, text, text, uuid, uuid, text) is
  'Credits community points from an incentive or an operator, through the '
  'migration-025 write guard. lifetime_earned rises with balance: a grant IS '
  'points the student was given, which is the question that column answers.';

revoke execute on function public.grant_community_points(uuid, integer, text, text, uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.grant_community_points(uuid, integer, text, text, uuid, uuid, text) to service_role;

-- ---------- 4. referral codes on the profile ----------

alter table public.profiles
  add column if not exists referral_code text;

comment on column public.profiles.referral_code is
  'This student''s own share code, assigned once on signup and immutable '
  'thereafter (see pin_referral_code). Ambiguity-free alphabet: no I, L, O, 0 or 1.';

create unique index if not exists idx_profiles_referral_code
  on public.profiles (referral_code) where referral_code is not null;

-- Six characters from a 31-letter alphabet is ~887 million codes, which is
-- enough that the retry loop below effectively never runs twice, and short
-- enough to read down a phone. The excluded characters are the ones people
-- mistype off a poster.
create or replace function public.generate_referral_code()
returns text
language plpgsql
set search_path = public
as $$
declare
  c_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
  i      integer;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(c_alphabet, 1 + floor(random() * length(c_alphabet))::integer, 1);
    end loop;
    -- Inside one transaction this sees codes assigned by earlier statements, so
    -- the backfill below cannot collide with itself.
    exit when not exists (select 1 from profiles where referral_code = v_code);
  end loop;
  return v_code;
end;
$$;

-- Every new student gets a code at signup, so the share card never has to ask
-- for one and there is no "generate my code" button to fail.
create or replace function public.assign_referral_code()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.referral_code is null then
    new.referral_code := public.generate_referral_code();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_referral_code_assign on public.profiles;
create trigger trg_profiles_referral_code_assign
  before insert on public.profiles
  for each row execute function public.assign_referral_code();

-- A code is assigned once and never changes. This matters because students can
-- UPDATE their own profiles row directly through PostgREST ("own profile
-- update", schema.sql:188) — without this, one student could retarget a code
-- already printed on a flyer, or blank their own and break every link they have
-- already shared. Silently pinning rather than raising keeps an unrelated
-- profile update (a name change) working.
create or replace function public.pin_referral_code()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if old.referral_code is not null and new.referral_code is distinct from old.referral_code then
    new.referral_code := old.referral_code;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_referral_code_pin on public.profiles;
create trigger trg_profiles_referral_code_pin
  before update on public.profiles
  for each row execute function public.pin_referral_code();

-- Backfill, one row at a time so each generated code is visible to the next
-- row's uniqueness check.
do $$
declare r record;
begin
  for r in select user_id from public.profiles where referral_code is null loop
    update public.profiles set referral_code = public.generate_referral_code()
     where user_id = r.user_id;
  end loop;
end;
$$;

-- ---------- 5. referrals ----------

create table if not exists public.referrals (
  id              uuid primary key default gen_random_uuid(),
  referrer_id     uuid not null references public.profiles (user_id) on delete cascade,
  friend_id       uuid not null references public.profiles (user_id) on delete cascade,
  incentive_id    uuid references public.incentives (id) on delete set null,
  code            text not null,                       -- the code as used, for the audit trail
  status          text not null default 'pending' check (status in ('pending', 'paid', 'void')),
  -- SNAPSHOTTED at attribution, exactly like punch_cards.target (migration-028):
  -- an operator lowering the payout tomorrow must not rewrite what a student was
  -- promised today.
  friend_points   integer not null default 0 check (friend_points >= 0),
  referrer_points integer not null default 0 check (referrer_points >= 0),
  qualified_at    timestamptz,                         -- friend's first earn was seen
  paid_at         timestamptz,
  created_at      timestamptz not null default now()
);

comment on table public.referrals is
  'One row per referred student. status pending -> paid when the friend first '
  'earns points anywhere (settle_referrals). See migration-039.';

comment on column public.referrals.qualified_at is
  'When the friend''s first earn was observed. Set even if the payout was '
  'refused (exhausted budget), so a waiting referral is visible in /admin '
  'instead of looking like it never qualified.';

-- A student can be referred ONCE, ever. This is the anti-fraud rule that does
-- the most work: it is enforced by the database, so no API path, no retry and
-- no future incentive kind can produce a second attribution for one account.
create unique index if not exists idx_referrals_one_per_friend
  on public.referrals (friend_id);

create index if not exists idx_referrals_referrer on public.referrals (referrer_id, created_at desc);
create index if not exists idx_referrals_pending  on public.referrals (created_at) where status = 'pending';

alter table public.referrals enable row level security;
grant all privileges on public.referrals to service_role;
revoke all privileges on public.referrals from anon, authenticated;

-- ---------- 6. settle_referrals — the sweeper ----------
-- Called on a timer by src/lib/referrals.js. Finds pending referrals whose
-- friend has now earned points anywhere and pays the referrer. See WHY A
-- SWEEPER at the top of this file.

create or replace function public.settle_referrals(p_limit integer default 50)
returns table (settled integer, skipped integer)
language plpgsql security definer set search_path = public
as $$
declare
  r         record;
  v_settled integer := 0;
  v_skipped integer := 0;
begin
  for r in
    select rf.id, rf.referrer_id, rf.incentive_id, rf.referrer_points
      from referrals rf
     where rf.status = 'pending'
       -- "Made a purchase" = has an earn row. Deliberately ANY vendor and any
       -- earn path (counter award, receipt claim), because the thing being
       -- rewarded is a student who actually started using WeRewards.
       and exists (
         select 1 from transactions t
          where t.user_id = rf.friend_id and t.type = 'earn' and t.points > 0
       )
     order by rf.created_at
     limit greatest(1, least(coalesce(p_limit, 50), 500))
     -- skip locked: two overlapping ticks (or two dynos) share the queue
     -- instead of one waiting on the other's locks.
     for update of rf skip locked
  loop
    begin
      if r.referrer_points > 0 then
        perform grant_community_points(
          r.referrer_id, r.referrer_points, 'referral_referrer',
          'Referral bonus', r.incentive_id, r.id, 'system'
        );
      end if;

      update referrals
         set status       = 'paid',
             qualified_at = coalesce(qualified_at, now()),
             paid_at      = now()
       where id = r.id;

      v_settled := v_settled + 1;
    exception when others then
      -- One referral must never stall the batch. The commonest reason to land
      -- here is GRANT_BUDGET_EXHAUSTED, which is a state an operator can fix by
      -- raising the budget — so stamp qualified_at (the row rolled back to the
      -- savepoint, so this UPDATE is the only survivor) and leave it pending for
      -- the next tick to retry.
      update referrals set qualified_at = coalesce(qualified_at, now()) where id = r.id;
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return query select v_settled, v_skipped;
end;
$$;

revoke execute on function public.settle_referrals(integer) from public, anon, authenticated;
grant  execute on function public.settle_referrals(integer) to service_role;

-- ---------- 7. settle_friend_bonuses — the other half of the sweep ----------
-- A friend's signup bonus is paid inline at attribution so it lands while they
-- are still looking at the screen. When that is refused — an exhausted budget is
-- the realistic reason — the referral is still recorded, and this is what pays
-- the bonus once an operator raises the budget.
--
-- The `not exists` is load-bearing, not a nicety. Doing this filter in the
-- application instead (fetch the oldest N referrals, drop the ones already
-- paid) STARVES: once N old paid referrals exist, the window is full of them
-- and a newer owed bonus is never reached. Filtering in the query means the
-- limit window only ever contains rows that are genuinely owed.

create or replace function public.settle_friend_bonuses(p_limit integer default 50)
returns table (paid integer, skipped integer)
language plpgsql security definer set search_path = public
as $$
declare
  r        record;
  v_paid   integer := 0;
  v_skipped integer := 0;
begin
  for r in
    select rf.id, rf.friend_id, rf.friend_points, rf.incentive_id
      from referrals rf
     where rf.status <> 'void'
       and rf.friend_points > 0
       -- The ledger is the source of truth for "was this paid", not a flag on
       -- the referral row: one fewer piece of state to keep in step with the
       -- money, and grant_community_points' unique index enforces the same rule.
       and not exists (
         select 1 from community_grants g
          where g.ref_id = rf.id and g.kind = 'referral_friend'
       )
     order by rf.created_at
     limit greatest(1, least(coalesce(p_limit, 50), 500))
     for update of rf skip locked
  loop
    begin
      perform grant_community_points(
        r.friend_id, r.friend_points, 'referral_friend',
        'Referral signup bonus', r.incentive_id, r.id, 'system'
      );
      v_paid := v_paid + 1;
    exception when others then
      -- Still no budget. Left owed; the next tick tries again, and the query
      -- above will keep finding it because nothing was written.
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return query select v_paid, v_skipped;
end;
$$;

revoke execute on function public.settle_friend_bonuses(integer) from public, anon, authenticated;
grant  execute on function public.settle_friend_bonuses(integer) to service_role;

commit;
