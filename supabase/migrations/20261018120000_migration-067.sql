-- ============================================================
-- Migration 067 — Free items: a reward can cost 0 points.
--
--   A vendor can now price an item at 0 points. Every screen shows it as "Free",
--   and when they set it the terminal asks one more question: can a student
--   redeem it every visit, or only once?
--
--   WHAT THIS FILE DOES
--   1. rewards.cost_in_points may be 0. The original inline
--      `check (cost_in_points > 0)` from schema.sql:63 is dropped (found by its
--      definition, not by a guessed name; see below) and replaced by a NAMED
--      `cost_in_points is null or cost_in_points >= 0`.
--   2. rewards_has_a_price is rewritten so a 0-point price counts as a price.
--      Before, `coalesce(cost_in_points, 0) > 0` read 0 exactly like NULL ("not
--      sold for points") and would refuse a free item that has no visit price.
--   3. rewards.once_per_student, default false. Only a free item may set it
--      (rewards_once_only_when_free): on a priced item the price already limits
--      how often a student can have it.
--   4. rewards_free_has_no_visit_price. A free item with a visit price would
--      put a "Redeem with visits" button beside a free one, and that button
--      burns ALL of a student's visits (migration-029 resets the counter to 0)
--      for something they could have had for nothing.
--   5. create_redeem_code refuses a once-only item the student has already
--      had (ONE_TIME_ITEM_USED), so the app can say so before the counter.
--   6. redeem_by_code: the same refusal, under a lock, as the authority; and a
--      0-point item NO LONGER TOUCHES THE PURSE. See section 6 for why that is a
--      bug fix and not an optimisation.
--
--   "ALREADY HAD IT" means a redeem row for this student and this reward that
--   was not undone: `reverses is null and reversed_by is null`. An undo inside
--   the one-minute window therefore gives the item back, the same way it gives
--   points back.
--
--   DEPLOY ORDER: run THIS FILE FIRST, then deploy the server. The server is
--   built to survive the other order: no request names once_per_student in a
--   column list (the item routes read `*`, and only a free item ever writes
--   it), and the student home screen reads it in a helper that falls back to
--   "no once-only items" on any error. What does NOT work until this has run
--   is saving a free item: the old CHECK refuses the row and the vendor sees a
--   generic error.
--
--   ⚠ ORDERING FOOTGUN, the usual one (migration-045's header has the list):
--   redeem_by_code and create_redeem_code were last defined in 045, and these
--   bodies are 045's copied forward. Re-running 045 or anything older restores
--   a body that debits a 0-point purse and knows nothing about once-only items;
--   re-run THIS file afterwards. Every section is idempotent.
--
--   NO SIGNATURE CHANGES, so both functions are plain `create or replace` and
--   keep their existing grants (045's header explains why that matters).
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after 066.
-- ============================================================

begin;

-- ---------- 1. a 0-point price is allowed ----------
--
-- The inline check is unnamed, so Postgres generated its name. migration-029
-- left it alone rather than drop it by a guessed name (a guess that matches
-- locally and misses in production aborts the whole transaction). Matching on
-- the DEFINITION instead is safe in both places: any check on rewards whose
-- text says `cost_in_points > 0` and nothing about visits is that one.

do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.rewards'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ~ 'cost_in_points\s*>\s*0'
      and pg_get_constraintdef(con.oid) !~ 'cost_in_visits'
  loop
    execute format('alter table public.rewards drop constraint %I', c.conname);
    raise notice 'migration-067: dropped %', c.conname;
  end loop;
end $$;

alter table public.rewards drop constraint if exists rewards_points_not_negative;
alter table public.rewards
  add constraint rewards_points_not_negative
  check (cost_in_points is null or cost_in_points >= 0);

-- ---------- 2. 0 points is a price, NULL is not ----------
-- cost_in_visits keeps rewards_visits_positive (migration-029), so a visit
-- price is still 1 or more and "is not null" here means a real visit price.

alter table public.rewards drop constraint if exists rewards_has_a_price;
alter table public.rewards
  add constraint rewards_has_a_price
  check (cost_in_points is not null or cost_in_visits is not null);

-- ---------- 3. once per student ----------

alter table public.rewards
  add column if not exists once_per_student boolean not null default false;

comment on column public.rewards.once_per_student is
  'A FREE item (cost_in_points = 0) that each student can redeem once. An undone '
  'redemption does not count. Enforced by create_redeem_code and redeem_by_code '
  '(migration-067); only a free item may set it.';

alter table public.rewards drop constraint if exists rewards_once_only_when_free;
alter table public.rewards
  add constraint rewards_once_only_when_free
  check (not once_per_student or cost_in_points = 0);

-- ---------- 4. a free item has no visit price ----------

alter table public.rewards drop constraint if exists rewards_free_has_no_visit_price;
alter table public.rewards
  add constraint rewards_free_has_no_visit_price
  check (cost_in_points is distinct from 0 or cost_in_visits is null);

-- ---------- 5. create_redeem_code ----------
-- 045's body verbatim, plus the once-only refusal after the price checks. It is
-- the friendly early answer, not the guarantee: two mints racing can both pass
-- it, which is why redeem_by_code checks again under a lock.

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
  r_once    boolean;
  v_have    integer;
  v_pool    uuid;
begin
  if p_paid_with not in ('points', 'visits') then
    raise exception 'BAD_CURRENCY';
  end if;

  select cost_in_points, cost_in_visits, once_per_student into r_points, r_visits, r_once
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

  -- Once-only free item (migration-067): refuse before a code exists, so the
  -- student hears it in the app rather than from the cashier.
  if r_once and exists (
    select 1 from transactions t
    where t.user_id = p_user_id and t.reward_id = p_reward_id and t.type = 'redeem'
      and t.reverses is null and t.reversed_by is null
  ) then
    raise exception 'ONE_TIME_ITEM_USED';
  end if;

  select v.pool_id into v_pool from vendors v where v.id = p_vendor_id;

  delete from redeem_codes where expires_at < now();       -- housekeeping
  -- ONE live code per (student, vendor) across BOTH currencies. Tapping the
  -- other button replaces the code instead of leaving two live 4-digit codes at
  -- one counter, where staff could consume the currency the student didn't mean.
  delete from redeem_codes where user_id = p_user_id and vendor_id = p_vendor_id;

  -- ... and one live POINTS code per (student, pool), because every location in
  -- a pool spends the same purse. Scoped to points and to the siblings, so a
  -- visits code anywhere, and any code at an unrelated vendor, is left alone.
  if v_pool is not null and p_paid_with = 'points' then
    delete from redeem_codes rc
    where rc.user_id = p_user_id
      and rc.paid_with = 'points'
      and rc.vendor_id in (select v.id from vendors v where v.pool_id = v_pool);
  end if;

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

-- ---------- 6. redeem_by_code ----------
-- 045's body verbatim, plus two edits.
--
-- (a) THE ONCE-ONLY CHECK, under a transaction-scoped advisory lock on
--     (student, reward). create_redeem_code's check is not enough on its own:
--     two mints racing can each see "never redeemed" and each insert a code
--     (each one's delete of the other's code cannot see an uncommitted row).
--     The lock makes the second redemption wait for the first to commit, and
--     READ COMMITTED gives the check that follows a fresh snapshot, so it sees
--     the first redemption's row. Raised after the code's delete..returning, so
--     the code is put back by the rollback, as with every other refusal here.
--
-- (b) A 0-POINT ITEM SKIPS THE DEBIT. Not just tidiness: the debit is
--     `update ... where ... and balance >= r_points`, and a student who has
--     never earned at this spot HAS NO PURSE ROW. Zero rows match, `not found`
--     is true, and a free item answers INSUFFICIENT_POINTS to the one student a
--     free item is most likely for. The balance is read instead, from the same
--     purse the debit would have used, so the terminal shows the right number.

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
  r_once   boolean;
  v_have   integer;
  v_bal    integer;
  v_pool   uuid;
begin
  -- Announce a legitimate points write to the migration-025 guard triggers.
  -- Required even on the visits branch: that branch still INSERTs into
  -- transactions, which carries trg_points_guard_row.
  perform set_config('app.points_write', 'server', true);

  -- Which purse, under the share lock, BEFORE the code is consumed. See 045's header.
  select v.pool_id into v_pool from vendors v where v.id = p_vendor_id for share;

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

  -- The reward is still re-read AT THIS VENDOR. Pooling shares the money, not
  -- the menu: a code minted for a sibling names a reward this location does not
  -- sell, and must not be redeemable here. (The code filter above already
  -- refuses it; this is the second fence.)
  select rw.cost_in_points, rw.title, rw.once_per_student into r_points, r_title, r_once
  from rewards rw
  where rw.id = c_reward and rw.vendor_id = p_vendor_id and rw.active = true;

  if not found then
    raise exception 'REWARD_NOT_FOUND';
  end if;

  -- (a) Once-only free item. Checked before either branch, so a visits code
  -- minted before the vendor made the item free cannot slip past it.
  if r_once then
    perform pg_advisory_xact_lock(hashtextextended('redeem-once:' || c_user::text || ':' || c_reward::text, 0));
    if exists (
      select 1 from transactions t
      where t.user_id = c_user and t.reward_id = c_reward and t.type = 'redeem'
        and t.reverses is null and t.reversed_by is null
    ) then
      raise exception 'ONE_TIME_ITEM_USED';
    end if;
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

    -- A visits redemption spends no points, but the terminal still shows the
    -- points balance beside the result, and for a pooled location that is the
    -- pool's. Reading point_balances here would print 0 next to a purse holding
    -- hundreds. Both arms coalesce, so the "no row anywhere" case is 0 and the
    -- single-row return is unconditional.
    if v_pool is null then
      select pb.balance into v_bal from point_balances pb
      where pb.user_id = c_user and pb.vendor_id = p_vendor_id;
    else
      select pl.balance into v_bal from pool_balances pl
      where pl.user_id = c_user and pl.pool_id = v_pool;
    end if;

    return query select coalesce(v_bal, 0), r_title, 'visits'::text, 0;
  else
    if r_points is null then
      raise exception 'REWARD_NOT_POINTS_PRICED';
    end if;

    if r_points = 0 then
      -- (b) Free: read the purse, never write it. A missing row is a balance
      -- of 0, exactly as on the visits branch above.
      if v_pool is null then
        select pb.balance into v_bal from point_balances pb
        where pb.user_id = c_user and pb.vendor_id = p_vendor_id;
      else
        select pl.balance into v_bal from pool_balances pl
        where pl.user_id = c_user and pl.pool_id = v_pool;
      end if;
      v_bal := coalesce(v_bal, 0);
    else
      -- THE DEBIT, and the entire double-spend story. Two tills of one pool
      -- redeeming for one customer converge on ONE row: Postgres takes a row
      -- lock, the second UPDATE re-evaluates `balance >= r_points` against the
      -- newly committed version under READ COMMITTED, updates zero rows, and the
      -- whole transaction — INCLUDING the delete of the redeem code above — rolls
      -- back, so the second customer's code stays live. Identical mechanism to
      -- the one two terminals of a single shop have always relied on.
      --
      -- `returning ... into v_bal` replaces 029's trailing re-read of
      -- point_balances. That read returned ZERO ROWS for a customer with no row
      -- at this vendor, which under pooling is an ordinary first visit to a
      -- sibling; see 045's header for what the API did with an empty result.
      if v_pool is null then
        update point_balances
        set balance = balance - r_points, updated_at = now()
        where user_id = c_user and vendor_id = p_vendor_id and balance >= r_points
        returning balance into v_bal;
      else
        update pool_balances
        set balance = balance - r_points, updated_at = now()
        where user_id = c_user and pool_id = v_pool and balance >= r_points
        returning balance into v_bal;
      end if;

      if not found then
        raise exception 'INSUFFICIENT_POINTS';
      end if;
    end if;

    insert into transactions (user_id, vendor_id, type, points, reward_id, paid_with)
    values (c_user, p_vendor_id, 'redeem', -r_points, c_reward, 'points');

    select coalesce(pc.punches, 0) into v_have
    from punch_cards pc
    where pc.user_id = c_user and pc.vendor_id = p_vendor_id;

    return query select v_bal, r_title, 'points'::text, coalesce(v_have, 0);
  end if;
end;
$$;

revoke execute on function public.redeem_by_code(text, uuid) from public, anon, authenticated;
grant  execute on function public.redeem_by_code(text, uuid) to service_role;

notify pgrst, 'reload schema';

commit;

-- ============================================================
-- POST-RUN CHECKS (run these by hand, they are not part of the transaction)
--
--   -- the old inline check is gone and the new ones are in place:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.rewards'::regclass and contype = 'c' order by 1;
--   -- expect rewards_free_has_no_visit_price, rewards_has_a_price,
--   -- rewards_once_only_when_free, rewards_points_not_negative,
--   -- rewards_visits_positive, and NO rewards_cost_in_points_check
--
--   -- nothing existing changed meaning:
--   select count(*) from rewards where once_per_student;          -- expect 0
--   select count(*) from rewards where cost_in_points = 0;        -- expect 0
-- ============================================================
