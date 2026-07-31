-- ============================================================
-- Migration 029 — Visits become a second per-vendor currency.
--   Retires the vendor-level punch card ("10 punches = a free coffee") and
--   replaces it with per-reward visit pricing. A student accumulates VISITS at
--   a vendor (same punch-in flow as 028, untouched); every reward may be priced
--   in points, in visits, or both. Redeeming with visits resets that student's
--   visit counter to ZERO regardless of the reward's price.
--
--   WHAT THIS FILE DOES
--   1. rewards.cost_in_points becomes NULLABLE and rewards.cost_in_visits is
--      added. A CHECK enforces that at least one is set and positive — neither
--      individually is required, both together are allowed.
--   2. transactions gains paid_with + visits_spent. A visits redemption is
--      type='redeem', points=0, paid_with='visits', visits_spent=<pre-burn
--      count>. That snapshot is the ONLY record of what was forfeited: under
--      reset-to-zero the reward's price does not tell you what the student
--      lost, so undo cannot reimburse without it.
--   3. redeem_codes gains paid_with + visits_charged, and punch_redeem_codes is
--      DROPPED. 028 split the tables only because redeem_codes.reward_id is NOT
--      NULL and a punch reward was vendor free-text rather than a catalog row;
--      a visits redemption now targets a real reward, so that reason is gone.
--      One table means the 4-digit primary key makes cross-type collisions
--      structurally impossible, and the terminal's guess-and-fallback (try the
--      reward preview, fall back to punch on CODE_INVALID) is deleted rather
--      than patched.
--   4. punch_cards collapses to ONE visit counter per (student, vendor).
--   5. punch_in becomes a plain counter increment. The rotating token, the
--      hold/binding handoff, the 6am business-day boundary and the
--      once-per-night unique index are all UNCHANGED.
--   6. create_redeem_code / redeem_by_code / reverse_transaction become
--      currency-aware.
--
--   ⚠⚠ THIS FILE IS ONE-SHOT. It is NOT safe to re-run.
--   Unlike 025-028 it mutates data: it collapses duplicate punch_cards rows and
--   credits outstanding completed cards. A second run would re-credit visits.
--   The data step is guarded on the existence of punch_cards_pre_029 and will
--   SKIP itself (with a notice) if that backup table is already there. Keep the
--   backup until migration-030 is confirmed; it is the only recovery path.
--
--   ⚠ DEPLOY ORDER, and this one is not optional:
--   Run this file, THEN deploy the server/client that stop selecting
--   vendors.punch_target / punch_reward, THEN run migration-030 to drop those
--   two columns. They cannot be dropped here. src/routes/student.js:140 names
--   them inside the SAME PostgREST query that fetches the whole vendor list,
--   and PostgREST 400s the entire request on an unknown column — dropping early
--   takes down the student home screen wholesale, not just the punch section.
--   plpgsql is late-bound and NOT dependency-tracked, so this file rewrites
--   every function body that reads those columns first.
--
--   ⚠ ORDERING FOOTGUN, the usual one: re-running migration-003, 006, 025, 026
--   or 028 restores an older body of create_redeem_code, redeem_by_code or
--   reverse_transaction. Re-run THIS file afterwards (the function sections are
--   CREATE OR REPLACE and safe on their own; only the section 4 data step is
--   one-shot, and it self-skips).
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-028.
-- ============================================================

begin;

-- ---------- 1. rewards: points, visits, or both ----------

alter table public.rewards alter column cost_in_points drop not null;

alter table public.rewards
  add column if not exists cost_in_visits integer;

comment on column public.rewards.cost_in_points is
  'Point price, or NULL when this reward cannot be bought with points. '
  'Nullable since migration-029; rewards_has_a_price guarantees at least one '
  'of cost_in_points / cost_in_visits is set.';

comment on column public.rewards.cost_in_visits is
  'Visit price, or NULL when this reward cannot be bought with visits. Read '
  'LIVE at mint time and snapshotted onto the code row, so a vendor editing '
  'the price mid-flight never changes what a live code charges.';

-- The original inline `check (cost_in_points > 0)` from schema.sql:63 is left
-- ALONE on purpose. A CHECK that evaluates to NULL counts as satisfied, so it
-- stays correct once the column is nullable — and it is unnamed, so its
-- generated name differs between environments and dropping it by guessed name
-- would succeed locally and fail in production (the trap migration-027:55-68
-- already had to work around).

alter table public.rewards drop constraint if exists rewards_visits_positive;
alter table public.rewards
  add constraint rewards_visits_positive
  check (cost_in_visits is null or cost_in_visits > 0);

alter table public.rewards drop constraint if exists rewards_has_a_price;
alter table public.rewards
  add constraint rewards_has_a_price
  check (coalesce(cost_in_points, 0) > 0 or coalesce(cost_in_visits, 0) > 0);

-- vendors cascades into rewards but rewards never got the cascade-path index
-- that migration-028:137-139 added for the punch tables.
create index if not exists idx_rewards_vendor on public.rewards (vendor_id);

-- ---------- 2. transactions: which currency paid ----------

alter table public.transactions
  add column if not exists paid_with text not null default 'points';

alter table public.transactions
  add column if not exists visits_spent integer;

alter table public.transactions drop constraint if exists transactions_paid_with;
alter table public.transactions
  add constraint transactions_paid_with check (paid_with in ('points', 'visits'));

comment on column public.transactions.visits_spent is
  'For paid_with=''visits'': the visit count IMMEDIATELY BEFORE the burn zeroed '
  'it. reverse_transaction adds this back. Not derivable from the reward price '
  '- redeeming a 5-visit reward with 12 banked forfeits all 12.';

-- transactions.type is untouched: a visits redemption is still 'redeem', so
-- transactions_type_check (migration-027:70-72) needs no change.

-- ---------- 3. one code table ----------

alter table public.redeem_codes
  add column if not exists paid_with text not null default 'points';

alter table public.redeem_codes
  add column if not exists visits_charged integer;

alter table public.redeem_codes drop constraint if exists redeem_codes_paid_with;
alter table public.redeem_codes
  add constraint redeem_codes_paid_with check (paid_with in ('points', 'visits'));

-- A visits code must carry the price it was minted at; a points code must not.
alter table public.redeem_codes drop constraint if exists redeem_codes_visits_charged;
alter table public.redeem_codes
  add constraint redeem_codes_visits_charged check (
    (paid_with = 'visits' and visits_charged > 0) or
    (paid_with = 'points' and visits_charged is null));

-- Dropped BEFORE the punch_cards collapse: its card_id FK is ON DELETE CASCADE,
-- so leaving it in place would let the collapse silently eat live counter codes.
drop table if exists public.punch_redeem_codes;

-- ---------- 4. punch_cards -> one visit counter per (student, vendor) ----------
--
-- ONE-SHOT. Guarded on the backup table so a re-run cannot re-credit visits.
--
-- Order is load-bearing. idx_punch_cards_one_open is PARTIAL on
-- `completed_at is null`, and Postgres silently drops any index whose column is
-- dropped. punch_in's concurrency safety is built entirely on that index
-- (insert -> exception when unique_violation -> re-select the winner), so
-- dropping the column before the full unique index exists lets two concurrent
-- first-punches both insert and fork the student's count with no error.
-- A plain unique (user_id, vendor_id) also cannot be built on today's data:
-- completed cards deliberately pile up, so duplicates already exist.
-- Back up, collapse, index, THEN drop.

do $$
begin
  if to_regclass('public.punch_cards_pre_029') is not null then
    raise notice 'migration-029: punch_cards_pre_029 already exists - skipping the one-shot data migration.';
    return;
  end if;

  create table public.punch_cards_pre_029 as select * from public.punch_cards;

  -- Survivor = oldest row per (student, vendor).
  create table public._029_survivors as
    select distinct on (user_id, vendor_id) id, user_id, vendor_id
    from public.punch_cards
    order by user_id, vendor_id, created_at;

  -- New visit total. A completed-but-unredeemed card is an outstanding IOU:
  -- the student filled it and never walked in. Nothing else records "owed a
  -- free cover", so once completed_at is gone that debt is unrecoverable -
  -- credit `target` visits and the IOU becomes spendable currency instead.
  -- An already-redeemed card contributes nothing.
  create table public._029_totals as
    select user_id, vendor_id,
           sum(case
                 when completed_at is not null and redeemed_at is null then target
                 when completed_at is not null                         then 0
                 else punches
               end)::int as visits
    from public.punch_cards
    group by user_id, vendor_id;

  -- Repoint the audit rows BEFORE deleting losers. punches.card_id is
  -- ON DELETE CASCADE and those rows carry idx_punches_once_per_night, which is
  -- the same-night replay stop - cascading them away would let a student
  -- re-scan a token they already spent.
  update public.punches p
  set card_id = s.id
  from public.punch_cards old
  join public._029_survivors s
    on s.user_id = old.user_id and s.vendor_id = old.vendor_id
  where p.card_id = old.id and old.id <> s.id;

  delete from public.punch_cards pc
  where not exists (select 1 from public._029_survivors s where s.id = pc.id);

  update public.punch_cards pc
  set punches = t.visits
  from public._029_totals t
  where pc.user_id = t.user_id and pc.vendor_id = t.vendor_id;

  drop table public._029_survivors;
  drop table public._029_totals;
end $$;

drop index if exists public.idx_punch_cards_one_open;

create unique index if not exists idx_punch_cards_one_per_vendor
  on public.punch_cards (user_id, vendor_id);

-- Only now, with the full unique index in place, retire the card columns.
-- `target` goes too: its source (vendors.punch_target) is dropped in 030, and
-- it is NOT NULL with no default, so any later insert would abort.
alter table public.punch_cards drop column if exists completed_at;
alter table public.punch_cards drop column if exists redeemed_at;
alter table public.punch_cards drop column if exists target;

comment on column public.punch_cards.punches is
  'The student''s VISIT COUNT at this vendor. Reset to 0 by a visits '
  'redemption, restored by an undo. Never decremented, never row-deleted.';

-- ---------- 5. punch_in: plain counter increment ----------
--
-- Everything above the counter is IDENTICAL to migration-028: the hold claim
-- and binding check, the DST-correct 6am business-day derivation, the
-- active/enabled re-check, and the once-per-night insert whose unique violation
-- IS the product rule. Only the card/target/completion tail is replaced.
--
-- The argument list is unchanged but the RETURN TYPE is not, and CREATE OR
-- REPLACE cannot change a return type - drop first. 028 already learned the
-- adjacent lesson the hard way: a non-matching signature sits ALONGSIDE the old
-- one as a live, still-granted, unbound overload with none of today's checks.

drop function if exists public.punch_in(uuid, uuid, bigint, uuid, text, text);

create or replace function public.punch_in(
  p_user_id      uuid,
  p_vendor_id    uuid,
  p_token_window bigint,
  p_hold_id      uuid default null,
  p_binding_hash text default null,
  p_timezone     text default 'America/New_York'
)
returns table (
  new_punches integer,
  vendor_id   uuid       -- authoritative: a hold claim derives it, not the caller
)
language plpgsql security definer set search_path = public
as $$
declare
  v_vendor  uuid   := p_vendor_id;
  v_window  bigint := p_token_window;
  v_day     date;
  v_active  boolean;
  v_enabled boolean;
  c_id      uuid;
  c_visits  integer;
  v_constraint text;
begin
  if p_hold_id is not null then
    delete from punch_holds ph
    where ph.id = p_hold_id
      and ph.expires_at > now()
      and ph.binding_hash is not distinct from p_binding_hash
    returning ph.vendor_id, ph.token_window into v_vendor, v_window;

    if v_vendor is null then
      raise exception 'HOLD_INVALID';
    end if;
  end if;

  if v_vendor is null or v_window is null then
    raise exception 'PUNCH_INVALID';
  end if;

  v_day := ((to_timestamp(v_window * 30) at time zone p_timezone) - interval '6 hours')::date;

  select v.active, v.punch_enabled
    into v_active, v_enabled
  from vendors v
  where v.id = v_vendor;

  if not found or not v_active or not v_enabled then
    raise exception 'PUNCH_DISABLED';
  end if;

  -- One counter row per (student, vendor), created on first punch. Same
  -- find-or-create shape migration-028 used: the full unique index makes the
  -- concurrent-create race safe because the loser re-selects the winner's row.
  --
  -- Deliberately NOT `on conflict (user_id, vendor_id) do nothing`: `vendor_id`
  -- is one of this function's OUT parameters, and an ON CONFLICT inference
  -- clause resolves it as the variable, failing with "column reference
  -- vendor_id is ambiguous" at runtime.
  select pc.id into c_id
  from punch_cards pc
  where pc.user_id = p_user_id and pc.vendor_id = v_vendor
  for update;

  if not found then
    begin
      insert into punch_cards (user_id, vendor_id, punches)
      values (p_user_id, v_vendor, 0)
      returning punch_cards.id into c_id;
    exception when unique_violation then
      select pc.id into c_id
      from punch_cards pc
      where pc.user_id = p_user_id and pc.vendor_id = v_vendor
      for update;
      if not found then
        raise exception 'PUNCH_CARD_RACE';
      end if;
    end;
  end if;

  -- The product rule + replay stop, enforced by the unique index. The
  -- diagnostics check keeps a DIFFERENT unique violation (a genuine bug) from
  -- being mislabelled as a normal "come back tomorrow" refusal.
  begin
    insert into punches (user_id, vendor_id, card_id, business_day, token_window)
    values (p_user_id, v_vendor, c_id, v_day, v_window);
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is null or v_constraint = 'idx_punches_once_per_night' then
      raise exception 'ALREADY_PUNCHED';
    end if;
    raise;
  end;

  update punch_cards pc
  set punches = pc.punches + 1
  where pc.id = c_id
  returning pc.punches into c_visits;

  return query select c_visits, v_vendor;
end;
$$;

revoke execute on function public.punch_in(uuid, uuid, bigint, uuid, text, text) from public, anon, authenticated;
grant  execute on function public.punch_in(uuid, uuid, bigint, uuid, text, text) to service_role;

-- ---------- 6. create_redeem_code: currency-aware, re-verifies visits ----------
--
-- The signature gains p_paid_with, which makes it a NEW function rather than a
-- replacement - drop the 4-arg version or it stays live and still granted.
--
-- MINTING NEVER SPENDS. Codes have a 120s TTL and are routinely never shown;
-- resetting the counter here would silently eat a student's banked visits when
-- they walk away. Verification happens here, the reset happens at the counter.

drop function if exists public.create_redeem_code(uuid, uuid, uuid, integer);

create or replace function public.create_redeem_code(
  p_user_id     uuid,
  p_vendor_id   uuid,
  p_reward_id   uuid,
  p_paid_with   text default 'points',
  p_ttl_seconds integer default 120
) returns text
language plpgsql security definer set search_path = public
as $$
declare
  candidate text;
  attempts  integer := 0;
  r_points  integer;
  r_visits  integer;
  v_have    integer;
begin
  if p_paid_with not in ('points', 'visits') then
    raise exception 'BAD_CURRENCY';
  end if;

  select cost_in_points, cost_in_visits into r_points, r_visits
  from rewards
  where id = p_reward_id and vendor_id = p_vendor_id and active = true;

  -- Existence and price are SEPARATE questions now. The old body used a NULL
  -- cost as a proxy for "row missing", which stops working the moment
  -- cost_in_points is nullable.
  if not found then
    raise exception 'REWARD_NOT_FOUND';
  end if;

  if p_paid_with = 'visits' then
    if r_visits is null then
      raise exception 'REWARD_NOT_VISITS_PRICED';
    end if;
    -- The DB is the authority on affordability, never the client.
    select coalesce(pc.punches, 0) into v_have
    from punch_cards pc
    where pc.user_id = p_user_id and pc.vendor_id = p_vendor_id;

    if coalesce(v_have, 0) < r_visits then
      raise exception 'INSUFFICIENT_VISITS';
    end if;
  else
    if r_points is null then
      raise exception 'REWARD_NOT_POINTS_PRICED';
    end if;
  end if;

  delete from redeem_codes where expires_at < now();       -- housekeeping
  -- ONE live code per (student, vendor) across BOTH currencies. Tapping the
  -- other button replaces the code instead of leaving two live 4-digit codes at
  -- one counter, where staff could consume the currency the student didn't mean.
  delete from redeem_codes where user_id = p_user_id and vendor_id = p_vendor_id;

  loop
    attempts := attempts + 1;
    candidate := lpad((floor(random() * 10000))::int::text, 4, '0');
    begin
      insert into redeem_codes (code, user_id, vendor_id, reward_id, paid_with,
                                visits_charged, expires_at)
      values (candidate, p_user_id, p_vendor_id, p_reward_id, p_paid_with,
              case when p_paid_with = 'visits' then r_visits else null end,
              now() + make_interval(secs => p_ttl_seconds));
      return candidate;
    exception when unique_violation then
      if attempts > 500 then raise exception 'CODE_SPACE_EXHAUSTED'; end if;
    end;
  end loop;
end;
$$;

revoke execute on function public.create_redeem_code(uuid, uuid, uuid, text, integer) from public, anon, authenticated;
grant  execute on function public.create_redeem_code(uuid, uuid, uuid, text, integer) to service_role;

-- ---------- 7. redeem_by_code: branches on currency ----------
--
-- Return type changes, so drop first.

drop function if exists public.redeem_by_code(text, uuid);

create or replace function public.redeem_by_code(p_code text, p_vendor_id uuid)
returns table (
  new_balance  integer,
  reward_title text,
  paid_with    text,
  visits_left  integer
)
language plpgsql security definer set search_path = public
as $$
declare
  c_user   uuid;
  c_reward uuid;
  c_paid   text;
  c_visits integer;
  r_points integer;
  r_title  text;
  v_have   integer;
  v_bal    integer;
begin
  -- Announce a legitimate points write to the migration-025 guard triggers.
  -- Required even on the visits branch: that branch still INSERTs into
  -- transactions, which carries trg_points_guard_row.
  perform set_config('app.points_write', 'server', true);

  -- Every column here is table-qualified on purpose: `paid_with` is ALSO the
  -- name of one of this function's OUT parameters (RETURNS TABLE columns become
  -- plpgsql variables), so a bare reference is ambiguous and fails at runtime.
  delete from redeem_codes rc
  where rc.code = p_code and rc.vendor_id = p_vendor_id and rc.expires_at > now()
  returning rc.user_id, rc.reward_id, rc.paid_with, rc.visits_charged
  into c_user, c_reward, c_paid, c_visits;

  if c_user is null then
    raise exception 'CODE_INVALID';
  end if;

  select cost_in_points, title into r_points, r_title
  from rewards
  where id = c_reward and vendor_id = p_vendor_id and active = true;

  if not found then
    raise exception 'REWARD_NOT_FOUND';
  end if;

  if c_paid = 'visits' then
    -- Lock the counter, compare against the SNAPSHOT taken at mint, then
    -- ASSIGN. Without the lock, a burn racing a punch_in (or two terminals
    -- resolving one code) can each read the pre-reset count.
    select pc.punches into v_have
    from punch_cards pc
    where pc.user_id = c_user and pc.vendor_id = p_vendor_id
    for update;

    if coalesce(v_have, 0) < c_visits then
      -- Raised AFTER the delete..returning, so the code deletion rolls back
      -- with it and a failed burn does not eat the student's code.
      raise exception 'INSUFFICIENT_VISITS';
    end if;

    update punch_cards
    set punches = 0                       -- assignment, never subtraction
    where user_id = c_user and vendor_id = p_vendor_id;

    insert into transactions (user_id, vendor_id, type, points, reward_id, paid_with, visits_spent)
    values (c_user, p_vendor_id, 'redeem', 0, c_reward, 'visits', v_have);

    select pb.balance into v_bal
    from point_balances pb
    where pb.user_id = c_user and pb.vendor_id = p_vendor_id;

    return query select coalesce(v_bal, 0), r_title, 'visits'::text, 0;
  else
    if r_points is null then
      raise exception 'REWARD_NOT_POINTS_PRICED';
    end if;

    update point_balances
    set balance = balance - r_points, updated_at = now()
    where user_id = c_user and vendor_id = p_vendor_id and balance >= r_points;

    if not found then
      raise exception 'INSUFFICIENT_POINTS';
    end if;

    insert into transactions (user_id, vendor_id, type, points, reward_id, paid_with)
    values (c_user, p_vendor_id, 'redeem', -r_points, c_reward, 'points');

    select coalesce(pc.punches, 0) into v_have
    from punch_cards pc
    where pc.user_id = c_user and pc.vendor_id = p_vendor_id;

    return query
      select pb.balance, r_title, 'points'::text, coalesce(v_have, 0)
      from point_balances pb
      where pb.user_id = c_user and pb.vendor_id = p_vendor_id;
  end if;
end;
$$;

revoke execute on function public.redeem_by_code(text, uuid) from public, anon, authenticated;
grant  execute on function public.redeem_by_code(text, uuid) to service_role;

-- ---------- 8. reverse_transaction: reimburse BOTH currencies ----------
--
-- migration-026's body verbatim, plus the visits branch. Return type gains
-- paid_with + restored_visits so the terminal can say "visits restored"
-- instead of "points refunded" - so, drop first.

drop function if exists public.reverse_transaction(uuid, uuid);

create or replace function public.reverse_transaction(
  p_transaction_id uuid,
  p_vendor_id      uuid
)
returns table (
  affected_user   uuid,
  new_balance     integer,
  reversed_type   text,
  reversed_points integer,
  paid_with       text,
  restored_visits integer
)
language plpgsql security definer set search_path = public
as $$
declare
  orig        transactions%rowtype;
  comp_points integer;
  comp_dollar numeric;
  comp_id     uuid;
  new_bal     integer;
  v_restored  integer := 0;
begin
  perform set_config('app.points_write', 'server', true);

  select * into orig
  from transactions
  where id = p_transaction_id and vendor_id = p_vendor_id
  for update;

  if orig.id is null then
    raise exception 'TX_NOT_FOUND';
  end if;
  if orig.reverses is not null then
    raise exception 'CANNOT_REVERSE_REVERSAL';
  end if;
  if orig.reversed_by is not null then
    raise exception 'ALREADY_REVERSED';
  end if;
  if orig.type = 'community_transfer' then
    raise exception 'CANNOT_REVERSE_TRANSFER';
  end if;
  if now() - orig.created_at > interval '1 minute' then
    raise exception 'REVERSAL_EXPIRED';
  end if;

  comp_points := -orig.points;
  comp_dollar := case when orig.dollar_amount is null then null else -orig.dollar_amount end;

  update point_balances
  set balance = greatest(0, balance + comp_points), updated_at = now()
  where user_id = orig.user_id and vendor_id = orig.vendor_id
  returning balance into new_bal;

  if not found then
    insert into point_balances (user_id, vendor_id, balance)
    values (orig.user_id, orig.vendor_id, greatest(0, comp_points))
    returning balance into new_bal;
  end if;

  -- ----- give the visits back -----
  -- ADD BACK, never SET. A punch earned between the redemption and the undo
  -- must survive it: 12 forfeited, 1 earned since, undo -> 13, not 12.
  -- Assignment would silently eat the new punch.
  if orig.paid_with = 'visits' and coalesce(orig.visits_spent, 0) > 0 then
    v_restored := orig.visits_spent;
    update punch_cards
    set punches = punches + v_restored
    where user_id = orig.user_id and vendor_id = orig.vendor_id;

    if not found then
      insert into punch_cards (user_id, vendor_id, punches)
      values (orig.user_id, orig.vendor_id, v_restored)
      on conflict (user_id, vendor_id)
      do update set punches = punch_cards.punches + excluded.punches;
    end if;
  end if;

  if orig.community_points <> 0 then
    update community_balances
    set balance         = greatest(0, balance - orig.community_points),
        lifetime_earned = greatest(0, lifetime_earned - orig.community_points),
        updated_at      = now()
    where user_id = orig.user_id;
  end if;

  -- The compensating row negates visits_spent too, so signed sums still net to
  -- zero in the analytics rollup.
  insert into transactions (user_id, vendor_id, type, points, dollar_amount, reward_id,
                            reverses, community_points, paid_with, visits_spent)
  values (orig.user_id, orig.vendor_id, orig.type, comp_points, comp_dollar, orig.reward_id,
          orig.id, -orig.community_points, orig.paid_with,
          case when orig.visits_spent is null then null else -orig.visits_spent end)
  returning id into comp_id;

  update transactions set reversed_by = comp_id where id = orig.id;

  return query select orig.user_id, new_bal, orig.type, orig.points, orig.paid_with, v_restored;
end;
$$;

revoke execute on function public.reverse_transaction(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.reverse_transaction(uuid, uuid) to service_role;

-- ---------- 9. retire the card-era RPCs ----------
--
-- Their tables and columns are gone; leaving the functions live would leave
-- service_role holding callable, still-granted entry points that reference
-- dropped columns and fail at runtime rather than at migration time.

drop function if exists public.create_punch_redeem_code(uuid, uuid, integer);
drop function if exists public.redeem_punch_card(text, uuid);

commit;

-- ============================================================
-- POST-RUN CHECKS (run these by hand, they are not part of the transaction)
--
--   -- exactly one counter row per (student, vendor):
--   select user_id, vendor_id, count(*) from punch_cards
--   group by 1, 2 having count(*) > 1;                  -- expect 0 rows
--
--   -- the unique index actually built:
--   select indexname from pg_indexes
--   where tablename = 'punch_cards' and indexname = 'idx_punch_cards_one_per_vendor';
--
--   -- every reward still has a price:
--   select count(*) from rewards
--   where coalesce(cost_in_points, 0) <= 0 and coalesce(cost_in_visits, 0) <= 0;   -- expect 0
--
--   -- outstanding cards were credited, not lost (compare against the backup):
--   select (select sum(case when completed_at is not null and redeemed_at is null
--                           then target else punches end) from punch_cards_pre_029) as before,
--          (select sum(punches) from punch_cards) as after;                        -- expect equal
--
-- RECOVERY, if this file aborted midway:
--   the whole thing is one transaction, so a failure rolls everything back
--   EXCEPT nothing - there is no partial state to clean up. If it COMMITTED and
--   you need to undo it, punch_cards_pre_029 holds the pre-image.
-- ============================================================
