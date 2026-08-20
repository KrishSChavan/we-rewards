-- ============================================================
-- Migration 045 — The RPC bodies learn about pools.
--
--   Migration 044 created the tables and changed nothing. This file teaches the
--   six functions that touch a balance to spend from the right purse:
--
--     vendor.pool_id IS NULL      -> point_balances(user_id, vendor_id)
--     vendor.pool_id IS NOT NULL  -> pool_balances(user_id, pool_id)
--
--   AND IT STILL CHANGES NOTHING, because no pool exists yet. Every function
--   below takes the null branch for every vendor on the platform until an
--   operator calls pool_join (migration 046). That is deliberate: the risky
--   half (rewriting the money functions) ships and bakes on its own, and the
--   half that can move a customer's points is a separate, later, revertible act.
--
--   THE DISCIPLINE IN THIS FILE: each body is the CURRENT body copied forward
--   verbatim, plus exactly three kinds of edit, and nothing else.
--     1. a purse resolution at the top (see FOR SHARE below),
--     2. an if/else around each balance read and each balance write,
--     3. every trailing "read the balance back" replaced by a RETURNING capture.
--   If you are reading a diff of this file against 026/027/029/032 and see a
--   fourth kind of change, it is a bug.
--
--   (3) IS NOT COSMETIC. It is the bug that would have shipped.
--   redeem_by_code ends by re-reading what it just wrote:
--
--       return query select pb.balance, ... from point_balances pb
--       where pb.user_id = c_user and pb.vendor_id = p_vendor_id;
--
--   Today that always finds a row, because you cannot have spent points at a
--   vendor you have no balance row at. Credit a POOL instead and the row need
--   not exist: a customer earning at Downtown and spending at Campus has no
--   point_balances row at Campus at all. The function then returns ZERO ROWS
--   after committing the debit and deleting the code, and src/routes/vendor.js
--   answers `if (!data?.length) throw new Error('CODE_INVALID')` — "that code is
--   expired or invalid", to a cashier, with the customer's points already gone
--   and their code already consumed. award_points has the same shape. Both are
--   replaced by capturing the balance at the moment of the write, which is also
--   simply better: it cannot race a concurrent sibling till between the write
--   and the read.
--
--   FOR SHARE, AND WHY IT IS ONE WORD OF CONCURRENCY.
--   Each function resolves the purse with
--
--       select v.pool_id, ... into v_pool, ... from vendors v
--       where v.id = p_vendor_id for share;
--
--   A share lock on the vendors row, taken before any balance is touched. It
--   costs nothing between sales (share locks do not conflict with each other),
--   and it orders every money path behind the row that decides which purse they
--   mean. pool_join and pool_leave (046) take FOR UPDATE on the same row, so a
--   join can never interleave with a sale at a location it is draining: the
--   drain either sees the sale's committed balance, or waits for it. Without
--   this, an award reading pool_id a microsecond before a join commits would
--   credit a purse the customer is about to be moved out of.
--
--   THE LOCK ORDER, stated once so it can be kept:
--       vendors (share, or exclusive for join/leave) -> the purse -> community_balances.
--   transfer_community_points already took `vendors ... for update` first
--   (migration-027); adding the share lock to award and redeem is what makes
--   every money path in the product agree.
--
--   ⚠ ORDERING FOOTGUN. These functions have been redefined many times, and
--   plain name-order application means the LAST definition wins:
--       award_points              schema.sql, 004, 005, 007, 019, 025, 026, and now 045
--       redeem_by_code            003, 007, 025, 029, and now 045
--       reverse_transaction       010, 025, 026, 029, and now 045
--       create_redeem_code        003, 006, 007, 028, 029, and now 045
--       transfer_community_points 027, and now 045
--       campaign_audience         032, and now 045
--   If you add a migration that touches any of them, it must be built on THIS
--   body, not on the one in the file where you first found the function.
--
--   ⚠ NO DROPS, NO GRANT DANCE. Every signature and return type here is
--   unchanged, so each is a plain `create or replace` and the existing
--   revoke/grant pairs survive. Do NOT add a column to any of these return
--   types to expose the purse: that turns each into drop-and-recreate, which
--   silently drops its grants, and a missed `grant execute` is a 403 at a till.
--   The purse is resolved internally from p_vendor_id and is nobody's business
--   but this file's.
--
--   ⚠ DEPLOY ORDER: after migration 044 (it reads vendors.pool_id and writes
--   pool_balances) and after the step-2 server deploy is live. Safe to re-run.
--   HOW TO APPLY: paste into the Supabase SQL Editor and run.
-- ============================================================

set lock_timeout = '3s';

-- ---------- 1. award_points ----------
-- 026's body verbatim, with the purse branch. Three reads of point_balances
-- become purse reads (the idempotent early return, the credit, the final
-- return), and the final one stops being a read at all.

create or replace function public.award_points(
  p_user_id       uuid,
  p_vendor_id     uuid,
  p_points        integer,
  p_dollar_amount numeric default null,
  p_client_token  text default null
)
returns table (new_balance integer, new_community integer)
language plpgsql security definer set search_path = public
as $$
declare
  -- 10% of the points ACTUALLY awarded — post-multiplier, so a 2x-tier student
  -- earning 300 mints 30, not 15. Rewards what the tier system already rewards.
  c_rate      constant numeric := 0.10;
  -- Anti-abuse: MAX_AWARD_DOLLARS bounds a single award but not a string of
  -- them, and community points are cross-vendor, so a colluding vendor mints
  -- value that leaves their own shop.
  c_daily_cap constant integer := 200;

  visited_before  boolean;
  visited_today   boolean;
  v_vendor_active boolean;
  v_minted_today  integer;
  v_community     integer;
  v_pool          uuid;      -- migration-044: null = this vendor keeps its own purse
  v_bal           integer;   -- the balance AS WRITTEN, never re-read
begin
  -- Announce a legitimate points write to the migration-025 guard triggers.
  -- Transaction-local (third arg true): evaporates when this call's
  -- transaction commits, so it can never leak into another request.
  perform set_config('app.points_write', 'server', true);

  if p_points <= 0 then
    raise exception 'POINTS_INVALID';
  end if;

  -- WHICH PURSE, and the lock that makes the answer stable for this whole
  -- transaction (see the header). v_vendor_active is read here too, moved up
  -- from where 026 read it just before the community mint: it is the same row,
  -- and reading it twice would mean reading it once inside the lock and once
  -- outside, which is exactly the inconsistency this lock exists to remove.
  select v.pool_id, v.active into v_pool, v_vendor_active
  from vendors v where v.id = p_vendor_id for share;

  -- Idempotency: a retry of an already-recorded award (same token, same vendor)
  -- returns the current balances and stops here — BEFORE any side effect
  -- (revisit bump / balance / transaction insert / MINT), so nothing is applied
  -- twice. A retried award cannot double-mint community points.
  --
  -- The scalar subqueries are already coalesced, so this branch has always
  -- returned exactly one row and never had the zero-row bug the final return
  -- had. It still had to learn about pools: for a pooled vendor the
  -- point_balances row is the husk pool_join drained, and answering a retry
  -- with 0 would tell the terminal the customer had been emptied out.
  if p_client_token is not null then
    if exists (
      select 1 from transactions
      where vendor_id = p_vendor_id and client_token = p_client_token
    ) then
      return query
        select case when v_pool is null
                 then coalesce((select pb.balance from point_balances pb
                                where pb.user_id = p_user_id and pb.vendor_id = p_vendor_id), 0)
                 else coalesce((select pl.balance from pool_balances pl
                                where pl.user_id = p_user_id and pl.pool_id = v_pool), 0)
               end,
               coalesce((select cb.balance from community_balances cb
                         where cb.user_id = p_user_id), 0);
      return;
    end if;
  end if;

  -- Revisit check must happen BEFORE this award's transaction is inserted,
  -- so today's earn can't count itself as the "earlier" visit. (migration-005)
  -- Deliberately still per-VENDOR, not per-pool: a revisit is "came back to
  -- this shop", and sharing a purse does not make two shops one place.
  select
    exists (select 1 from transactions t
            where t.user_id = p_user_id and t.vendor_id = p_vendor_id
              and t.type = 'earn' and t.created_at::date < current_date),
    exists (select 1 from transactions t
            where t.user_id = p_user_id and t.vendor_id = p_vendor_id
              and t.type = 'earn' and t.created_at::date = current_date)
  into visited_before, visited_today;

  if visited_before and not visited_today then
    update profiles set revisits = revisits + 1 where user_id = p_user_id;
  end if;

  -- THE CREDIT. Same upsert either way, against whichever purse this location
  -- spends from, and the new balance is captured here rather than read back
  -- afterwards: `returning` cannot miss a row it just wrote, and cannot pick up
  -- a sibling till's sale committed in between.
  if v_pool is null then
    insert into point_balances (user_id, vendor_id, balance)
    values (p_user_id, p_vendor_id, p_points)
    on conflict (user_id, vendor_id)
    do update set balance = point_balances.balance + p_points, updated_at = now()
    returning balance into v_bal;
  else
    insert into pool_balances (user_id, pool_id, balance)
    values (p_user_id, v_pool, p_points)
    on conflict (user_id, pool_id)
    do update set balance = pool_balances.balance + p_points, updated_at = now()
    returning balance into v_bal;
  end if;

  -- ----- the community 10% -----
  -- Derived HERE, from the number this function is already writing. It never
  -- crosses the wire as an input (community-points.md, constraint 3).
  v_community := floor(p_points * c_rate);

  -- An admin-hidden vendor mints nothing. tiers.js already drops txns at
  -- vendors.active = false from the tier math; the mint follows the same rule so
  -- a delisted shop can't keep issuing cross-vendor value. The VENDOR points
  -- still award in full — only the community 10% is withheld. (v_vendor_active
  -- was read under the share lock at the top of this function.)
  if not coalesce(v_vendor_active, false) then
    v_community := 0;
  end if;

  -- Daily cap. Counts earn rows only, and nets out reversals automatically: a
  -- voided award's compensating row carries a negative community_points, which
  -- frees the cap back up. created_at::date matches the revisit logic above
  -- (server timezone), deliberately — one definition of "today" in this function.
  if v_community > 0 then
    select coalesce(sum(t.community_points), 0) into v_minted_today
    from transactions t
    where t.user_id = p_user_id
      and t.type = 'earn'
      and t.created_at::date = current_date;

    v_community := least(v_community, greatest(0, c_daily_cap - v_minted_today));
  end if;

  if v_community > 0 then
    insert into community_balances (user_id, balance, lifetime_earned)
    values (p_user_id, v_community, v_community)
    on conflict (user_id) do update
      set balance         = community_balances.balance + v_community,
          lifetime_earned = community_balances.lifetime_earned + v_community,
          updated_at      = now();
  end if;

  -- The unique index on (vendor_id, client_token) is the hard backstop: a
  -- concurrent duplicate that slips past the exists() check raises here and the
  -- whole atomic call rolls back, so neither the balance bump nor the mint
  -- above ever sticks twice.
  --
  -- vendor_id is STILL the true location, pooled or not. The ledger records
  -- where the sale happened; the purse records whose money it is. Keeping those
  -- two facts separate is what lets pool_settlement (046) answer "which of my
  -- shops funded which" from rows that were being written anyway, and is why
  -- sharing needs no new transactions.type and no analytics change.
  insert into transactions (user_id, vendor_id, type, points, dollar_amount, client_token, community_points)
  values (p_user_id, p_vendor_id, 'earn', p_points, p_dollar_amount, p_client_token, v_community);

  return query
    select v_bal,
           coalesce((select cb.balance from community_balances cb
                     where cb.user_id = p_user_id), 0);
end;
$$;

-- ---------- 2. redeem_by_code ----------
-- 029's body verbatim, with the purse branch. The visits path is untouched
-- except for the balance it reports back (visits are NOT pooled; only the
-- points figure it returns alongside them has to be the right purse).

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
  v_pool   uuid;
begin
  -- Announce a legitimate points write to the migration-025 guard triggers.
  -- Required even on the visits branch: that branch still INSERTs into
  -- transactions, which carries trg_points_guard_row.
  perform set_config('app.points_write', 'server', true);

  -- Which purse, under the share lock, BEFORE the code is consumed. See header.
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
    -- sibling; see the header for what the API did with an empty result.
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

    insert into transactions (user_id, vendor_id, type, points, reward_id, paid_with)
    values (c_user, p_vendor_id, 'redeem', -r_points, c_reward, 'points');

    select coalesce(pc.punches, 0) into v_have
    from punch_cards pc
    where pc.user_id = c_user and pc.vendor_id = p_vendor_id;

    return query select v_bal, r_title, 'points'::text, coalesce(v_have, 0);
  end if;
end;
$$;

-- ---------- 3. reverse_transaction ----------
-- 029's body verbatim, with the purse branch and ONE deliberate behaviour
-- change, which is the only place in this file where a pooled path is not
-- simply the unpooled path pointed at another table.
--
-- THE CLAMP HAS TO GO, FOR POOLED VENDORS ONLY.
-- 029 undoes an award with `greatest(0, balance + comp_points)`. If the points
-- are already gone, it takes back what it can and silently swallows the rest;
-- migration-026 calls that out as the one place ledger invariants can drift,
-- and it is rare today because the earn and the spend must be at the SAME
-- vendor inside sixty seconds. Share a purse and any sibling can drain it in
-- that window, so "rare" becomes "whenever a customer walks next door", and
-- every occurrence is liability quietly written off with nothing to read.
--
-- The pooled path refuses instead: a predicated UPDATE that matches no row when
-- the money is not there, and raises REVERSAL_OVERSPENT. A cashier's undo can
-- now fail for something that is not their fault, which is a real cost, and it
-- is still the better trade — the alternative is an under-recovery the owner
-- never finds out about. Undoing a REDEMPTION (comp_points positive) is
-- unaffected: it only ever adds.
--
-- The unpooled path keeps the clamp byte-for-byte. This migration does not
-- change what happens at a shop that shares nothing.

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
  v_pool      uuid;
begin
  perform set_config('app.points_write', 'server', true);

  -- The purse is resolved from the ORIGINAL row's vendor, not from
  -- p_vendor_id, even though the lookup below proves they are equal: the money
  -- has to go back where it came from, and reading that from `orig` is the
  -- statement of intent.
  select v.pool_id into v_pool from vendors v where v.id = p_vendor_id for share;

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

  if v_pool is null then
    update point_balances
    set balance = greatest(0, balance + comp_points), updated_at = now()
    where user_id = orig.user_id and vendor_id = orig.vendor_id
    returning balance into new_bal;

    if not found then
      insert into point_balances (user_id, vendor_id, balance)
      values (orig.user_id, orig.vendor_id, greatest(0, comp_points))
      returning balance into new_bal;
    end if;
  else
    -- No pre-read and then a write: the predicate IS the check, so there is no
    -- window between deciding and doing, and no unmapped 23514 from the
    -- column's own `balance >= 0`.
    update pool_balances
    set balance = balance + comp_points, updated_at = now()
    where user_id = orig.user_id and pool_id = v_pool
      and balance >= greatest(0, -comp_points)
    returning balance into new_bal;

    if not found then
      -- Nothing matched. Either the purse is short (an undo of an award whose
      -- points have been spent at a sibling) or there is no row at all (an undo
      -- of a redemption for a customer whose purse was emptied to zero and
      -- pruned). Only the first is an error.
      if comp_points < 0 then
        raise exception 'REVERSAL_OVERSPENT';
      end if;
      insert into pool_balances (user_id, pool_id, balance)
      values (orig.user_id, v_pool, comp_points)
      on conflict (user_id, pool_id)
      do update set balance = pool_balances.balance + comp_points, updated_at = now()
      returning balance into new_bal;
    end if;
  end if;

  -- ----- give the visits back -----
  -- ADD BACK, never SET. A punch earned between the redemption and the undo
  -- must survive it: 12 forfeited, 1 earned since, undo -> 13, not 12.
  -- Assignment would silently eat the new punch. Per-vendor, pooled or not:
  -- visits are not shared.
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
  -- zero in the analytics rollup. It carries orig.vendor_id, pooled or not,
  -- which is what keeps src/lib/analytics.js correct with no changes at all.
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

-- ---------- 4. create_redeem_code ----------
-- 029's body verbatim, with ONE rule widened: the "one live code" rule becomes
-- pool-scoped, FOR POINTS CODES ONLY.
--
-- Why it has to widen. The rule exists so a student cannot stand at a counter
-- with two live 4-digit codes and have staff consume the wrong one. Sharing a
-- purse recreates exactly that hazard across locations: mint a 350-point code
-- at Downtown, walk to Campus, mint another, and both are live against ONE
-- 420-point purse. The first redemption succeeds and the second dies at the
-- till with INSUFFICIENT_POINTS, in front of a customer holding what looks like
-- a valid code.
--
-- Why it must stay currency-aware. Visits are NOT pooled — punch_cards is still
-- keyed (user_id, vendor_id) — so a live VISITS code at Downtown is backed by
-- Downtown's own counter and nothing about minting a points code at Campus
-- makes it unsafe. Deleting it would silently cancel a reward the customer had
-- already earned somewhere else.

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
  v_pool    uuid;
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

-- ---------- 5. transfer_community_points ----------
-- 027's body verbatim, with the purse branch on both of its point_balances
-- touches: the idempotent early return and the credit.
--
-- NOTE ON LOCKING. This function already took `vendors ... for update` before
-- crediting, so the credit path needs no new lock: pool_id simply rides along
-- on that same select. The idempotent early return happens BEFORE it and reads
-- pool_id WITHOUT a lock, on purpose — that branch writes nothing, it only
-- reports two balances and stops. Taking a share lock there and then upgrading
-- to the exclusive lock below would be a classic lock upgrade: two concurrent
-- transfers into one vendor could each hold the share and each wait for the
-- other's, which is a deadlock that this function has never had.

create or replace function public.transfer_community_points(
  p_user_id      uuid,
  p_vendor_id    uuid,
  p_amount       integer,
  p_client_token text default null
)
returns table (new_community integer, new_vendor_balance integer)
language plpgsql security definer set search_path = public
as $$
declare
  v_active     boolean;
  v_accepts    boolean;
  v_cap        integer;
  v_in_month   integer;
  v_community  integer;
  v_vendor_bal integer;
  v_pool       uuid;
begin
  -- Announce a legitimate points write to the migration-025 guard triggers.
  -- Transaction-local: evaporates at commit, can never leak into another request.
  perform set_config('app.points_write', 'server', true);

  if p_amount is null or p_amount <= 0 then
    raise exception 'AMOUNT_INVALID';
  end if;

  -- Idempotency, same shape as award_points: a retry of an already-recorded
  -- transfer (same token, same vendor) returns the current balances and stops
  -- HERE, before any side effect. A double-submitted move can't move twice.
  -- The unique index on (vendor_id, client_token) is the concurrent-duplicate
  -- backstop, exactly as it is for awards.
  if p_client_token is not null then
    if exists (
      select 1 from transactions
      where vendor_id = p_vendor_id and client_token = p_client_token
    ) then
      select v.pool_id into v_pool from vendors v where v.id = p_vendor_id;
      return query
        select coalesce((select cb.balance from community_balances cb
                         where cb.user_id = p_user_id), 0),
               case when v_pool is null
                 then coalesce((select pb.balance from point_balances pb
                                where pb.user_id = p_user_id and pb.vendor_id = p_vendor_id), 0)
                 else coalesce((select pl.balance from pool_balances pl
                                where pl.user_id = p_user_id and pl.pool_id = v_pool), 0)
               end;
      return;
    end if;
  end if;

  -- Destination must be a real, active, opted-in vendor — checked here, not
  -- just in the picker, because the client controls the request body. The row
  -- lock also serializes concurrent transfers into the same vendor, so the
  -- monthly-cap read below can't be raced past by two requests that both saw
  -- headroom.
  select v.active, v.accepts_community_points, v.community_monthly_cap, v.pool_id
    into v_active, v_accepts, v_cap, v_pool
  from vendors v
  where v.id = p_vendor_id
  for update;

  if not found or not v_active or not v_accepts then
    raise exception 'VENDOR_INELIGIBLE';
  end if;

  -- Option A's safety valve: gross inbound this calendar month. Transfer rows
  -- can't be reversed (CANNOT_REVERSE_TRANSFER), so a plain sum IS the gross.
  --
  -- Still per-VENDOR under pooling, and that is a known, accepted gap: a
  -- three-location pool has three times the inbound headroom into one purse.
  -- The cap exists to bound one business's exposure to ANOTHER business's
  -- liability, and inside one pool both sides are the same owner's P&L. An
  -- owner-scoped cap is listed as deliberately not built in v1.
  if v_cap is not null then
    select coalesce(sum(t.points), 0) into v_in_month
    from transactions t
    where t.vendor_id = p_vendor_id
      and t.type = 'community_transfer'
      and t.created_at >= date_trunc('month', now());

    if v_in_month + p_amount > v_cap then
      raise exception 'VENDOR_CAP_REACHED';
    end if;
  end if;

  -- Vendor balance FIRST, community second — deliberately matching
  -- award_points' lock order (the purse, then community_balances), so a
  -- transfer into vendor B racing an earn at vendor B can't deadlock. Crediting
  -- before the funds check is safe: if the decrement below finds no row, the
  -- raise rolls this back with everything else.
  if v_pool is null then
    insert into point_balances (user_id, vendor_id, balance)
    values (p_user_id, p_vendor_id, p_amount)
    on conflict (user_id, vendor_id)
    do update set balance = point_balances.balance + p_amount, updated_at = now()
    returning balance into v_vendor_bal;
  else
    -- Moved community points land in the shared purse, so they are spendable at
    -- every location in the pool. The student app says so at the confirm step.
    insert into pool_balances (user_id, pool_id, balance)
    values (p_user_id, v_pool, p_amount)
    on conflict (user_id, pool_id)
    do update set balance = pool_balances.balance + p_amount, updated_at = now()
    returning balance into v_vendor_bal;
  end if;

  -- Atomic decrement, same shape as redeem_by_code's balance guard. A student
  -- with no community_balances row simply doesn't match: INSUFFICIENT_POINTS.
  update community_balances
     set balance = balance - p_amount, updated_at = now()
   where user_id = p_user_id and balance >= p_amount
  returning balance into v_community;

  if not found then
    raise exception 'INSUFFICIENT_POINTS';
  end if;

  -- lifetime_earned is untouched on purpose: it counts minting, not movement.
  insert into transactions (user_id, vendor_id, type, points, client_token, community_points)
  values (p_user_id, p_vendor_id, 'community_transfer', p_amount, p_client_token, -p_amount);

  return query select v_community, v_vendor_bal;
end;
$$;

-- ---------- 6. campaign_audience ----------
-- 032's body verbatim except for the 'close' branch, which is the one audience
-- that asks a question about a BALANCE rather than about transactions.
--
-- WITHOUT THIS, DEALS SILENTLY DIE FOR EVERY CHAIN. 'close' means "nearly able
-- to afford the cheapest reward here", and it reads
-- `point_balances where vendor_id = p_vendor_id`. For a pooled location that
-- row is the husk pool_join drained, so the balance is zero, so the audience is
-- empty, so the campaign sends to nobody — with no error anywhere.
--
-- AND THE TRANSACTION GATE IS NOT OPTIONAL. Point the query at the pool and the
-- opposite failure appears: every customer of every sibling now qualifies at
-- every member, so one customer is picked up three times for three locations of
-- one business. The bundle dedupe is `select distinct on (vendor_id)` and the
-- cooldown is per vendor, so all three survive and land as three near-identical
-- pushes from a shop they may have visited once. Requiring a transaction AT
-- THIS vendor also makes 'close' consistent with 'lapsed' and 'top', which have
-- always been gated that way.

create or replace function public.campaign_audience(
  p_vendor_id uuid,
  p_audience  text default 'top',
  p_limit     integer default 100
)
returns table (user_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_pool  uuid;
begin
  -- No lock: this function is `stable` and writes nothing.
  select v.pool_id into v_pool from vendors v where v.id = p_vendor_id;

  if p_audience = 'lapsed' then
    return query
      select v.uid
      from (
        select t.user_id as uid,
               count(distinct (t.created_at at time zone 'UTC')::date) as visit_days,
               max(t.created_at) as last_seen
        from transactions t
        where t.vendor_id = p_vendor_id
          and t.type = 'earn'
          and t.user_id is not null
          and t.created_at >= now() - interval '180 days'
        group by t.user_id
      ) v
      join profiles p on p.user_id = v.uid
      where v.visit_days >= 2
        and v.last_seen < now() - interval '30 days'
      order by v.visit_days desc, v.last_seen desc
      limit v_limit;

  elsif p_audience = 'close' then
    return query
      with cheapest as (
        select min(r.cost_in_points) as cost
        from rewards r
        where r.vendor_id = p_vendor_id
          and r.active = true
          and r.cost_in_points is not null
      ),
      -- Whichever purse this location spends from, as one relation, so the
      -- audience rule below is written once and cannot drift between a pooled
      -- and an unpooled copy of itself. Exactly one arm can produce rows:
      -- v_pool is either null or it is not, and the other arm's predicate is
      -- then constant-false.
      purse as (
        select b.user_id as uid, b.balance, b.updated_at
        from point_balances b
        where v_pool is null and b.vendor_id = p_vendor_id
        union all
        select pl.user_id as uid, pl.balance, pl.updated_at
        from pool_balances pl
        where v_pool is not null and pl.pool_id = v_pool
      )
      select q.uid
      from purse q
      join profiles p on p.user_id = q.uid
      cross join cheapest c
      where c.cost is not null
        and q.balance >= ceil(c.cost * 0.5)
        and q.balance < c.cost
        -- Has this customer ever actually been HERE? A no-op for an unpooled
        -- vendor (a balance there implies a transaction there), and the whole
        -- difference between one relevant push and three from one owner.
        and exists (
          select 1 from transactions t
          where t.user_id = q.uid and t.vendor_id = p_vendor_id
        )
      order by q.balance desc, q.updated_at desc
      limit v_limit;

  else   -- 'top'
    return query
      select v.uid
      from (
        select t.user_id as uid,
               count(distinct (t.created_at at time zone 'UTC')::date) as visit_days,
               sum(coalesce(t.dollar_amount, 0)) as spend,
               max(t.created_at) as last_seen
        from transactions t
        where t.vendor_id = p_vendor_id
          and t.type = 'earn'
          and t.user_id is not null
          and t.created_at >= now() - interval '90 days'
        group by t.user_id
      ) v
      join profiles p on p.user_id = v.uid
      order by v.visit_days desc, v.spend desc, v.last_seen desc
      limit v_limit;
  end if;
end;
$$;

notify pgrst, 'reload schema';
