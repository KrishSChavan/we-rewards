-- ============================================================
-- Migration 046 — Joining and leaving a pool: the operations that move money.
--
--   044 made the tables. 045 taught the RPCs to read the right purse. Both were
--   inert, because no pool had any members. THIS file is where sharing actually
--   turns on, and it is the only part of the feature that MOVES a customer's
--   existing points. Everything here is written to be reversible and auditable
--   for exactly that reason.
--
--   pool_join      — a location starts sharing. Its customers' balances are
--                    drained into the pool, one pool_moves row each.
--   pool_leave     — a location stops. It takes back what its own trading
--                    funded, by the contribution split described below.
--   pool_delete    — retire an empty pool.
--   pool_settlement— who funded whom, as a report over rows already written.
--
--   THE CONTRIBUTION SPLIT, which is the hard part.
--
--   When a location leaves, its customers' money is sitting in a purse that
--   several shops fed. Three things could happen to it, and two of them are
--   wrong:
--     - zero the leaver's customers: confiscating money a customer watched
--       themselves earn. Indefensible.
--     - let every customer keep their whole pooled balance at the leaver AND in
--       the pool: doubles outstanding liability at the exact moment an owner is
--       trying to reduce it.
--     - give the leaver back what ITS OWN trading put in, and leave the rest.
--       Points are conserved exactly, nobody is confiscated, and every term is
--       computable from rows we already write. This is what we do.
--
--       contribution(u, L) = sum of pool_moves.amount for (u, L)
--                          + sum of transactions.points for (u, L)
--                            over types earn / redeem / community_transfer
--       ...BOTH TERMS WINDOWED to created_at >= L.pool_joined_at, and the
--       window is why leave-then-rejoin composes. Without it, a location that
--       left with 50 and rejoined would still carry its FIRST membership's
--       +300 join row in the sum while the trading that consumed it fell
--       outside the transactions window, and it could withdraw 300 it never
--       funded. pool_joined_at is reset on every join precisely to be this
--       window.
--
--       share(u) = least(greatest(0, contribution(u, L)), pool_balance(u))
--       Clamped at both ends: a location that took more out of the purse than
--       it put in withdraws nothing (not a negative), and no location can take
--       more than the purse actually holds.
--
--   THE LAST MEMBER IS A SPECIAL CASE, and not an optional one. If the split
--   ran for the final member, anything its siblings funded would stay in a pool
--   with nobody left to spend it at: invisible to the customer and unreachable
--   forever. The last member out takes the whole remaining balance.
--
--   ONE KNOWN IMPRECISION, stated rather than hidden. The contribution window
--   compares transactions.created_at against pool_joined_at, and created_at is
--   the transaction's START time. A sale that began before pool_join started
--   but only committed after it can therefore write to the POOL (it re-reads
--   the vendors row after pool_join releases it) while carrying a timestamp
--   that puts it outside the window. That sale is then missing from the
--   contribution sum: a redemption in that window makes the location look like
--   it funded slightly more than it did, an earn slightly less. Points are NOT
--   lost either way — the clamp keeps the purse whole and the last member out
--   sweeps the remainder — so this is misattribution between one owner's own
--   shops, bounded by the length of a single drain, and it self-corrects the
--   next time the location leaves. Fixing it properly means recording on the
--   transactions row WHICH purse it hit, which is a column and a migration for
--   an error that is smaller than the rounding on a coffee.
--
--   LOCK ORDER, matching 045: vendors -> the purse -> everything else. Every
--   vendors row this touches is locked FOR UPDATE in ONE statement ordered by
--   id, so two concurrent joins against one pool cannot deadlock by taking the
--   same rows in different orders. 045's award_points and redeem_by_code take
--   FOR SHARE on the same row, which is what makes a sale and a drain mutually
--   exclusive: the drain either sees a committed sale or waits for it, and can
--   never read a balance of 300 and zero it after it has become 800.
--
--   ⚠ THESE FUNCTIONS ARE OPERATOR-ONLY. They are reachable exclusively from
--   /api/admin/* behind requireAdmin. Turning sharing on merges customer
--   balances across what may be separate legal entities, and the vendor side
--   cannot prove a location is theirs; a staff PIN is one location's four
--   digits authorising an irreversible operation on all of them. There is
--   deliberately NO vendor-facing route and no terminal control.
--
--   ⚠ DEPLOY ORDER: after 045. Safe to re-run.
--   HOW TO APPLY: paste into the Supabase SQL Editor and run.
-- ============================================================

set lock_timeout = '3s';

-- ---------- 1. pool_join ----------
-- Membership and the drain in ONE transaction. Splitting them was the single
-- worst failure mode available here: a location routed at a pool that does not
-- yet hold its customers' money would answer every scan with a zero balance,
-- at a counter, for as long as the second step took to arrive.

create or replace function public.pool_join(p_pool_id uuid, p_vendor_id uuid)
returns table (customers integer, points_moved integer)
language plpgsql security definer set search_path = public
as $$
declare
  r            record;
  v_rate       numeric;
  v_joiner_seen boolean := false;
  n_customers  integer := 0;
  -- bigint, then cast at return: the running total crosses every customer in
  -- one drain, so it would overflow int4 long before any single balance could.
  n_points     bigint  := 0;
begin
  -- The drain writes point_balances, pool_balances and pool_moves, all of which
  -- carry the migration-025 guard triggers.
  perform set_config('app.points_write', 'server', true);

  -- LOCK THE POOL ITSELF, FIRST. The pool row is the thing every membership
  -- change contends on, and it is the ONLY lock that serialises them: locking
  -- vendors rows does not, because two joins name two different vendors and two
  -- leaves leave two different ones, so they take disjoint locks and each reads
  -- a membership set the other is about to change. That window is not
  -- theoretical. Two vendors joining an EMPTY pool at once would each see zero
  -- existing members, each skip the rate-parity check below, and commit a pool
  -- whose members charge different rates. Two members leaving at once would
  -- each see the other as staying, each take only its own contribution, and
  -- leave the remainder in a pool with nobody in it: unreachable money, a zero
  -- balance on every customer card, and a pool that pool_delete then refuses to
  -- retire forever.
  --
  -- LOCK ORDER, and it must be kept: point_pools -> vendors -> the balances.
  -- 045's award/redeem/reverse take FOR SHARE on the vendors row and never
  -- touch point_pools, so they can never hold half of what this needs.
  perform 1 from point_pools where id = p_pool_id for update;
  if not found then
    raise exception 'POOL_NOT_FOUND';
  end if;

  -- EVERY vendors row this call cares about, locked in one statement, ordered
  -- by id. One statement and one order is what makes two concurrent joins
  -- against the same pool safe: they queue instead of each holding half of what
  -- the other wants. Ordering by anything non-deterministic here would be a
  -- deadlock waiting for a busy Friday.
  for r in
    select v.id, v.pin_hash, v.points_per_dollar, v.pool_id
    from vendors v
    where v.id = p_vendor_id or v.pool_id = p_pool_id
    order by v.id
    for update
  loop
    if r.id = p_vendor_id then
      v_joiner_seen := true;
      if r.pool_id = p_pool_id then
        -- Already a member. A double-tapped button is a no-op, not an error:
        -- the operator's intent is satisfied and raising here would send them
        -- looking for a problem that does not exist.
        return query select 0, 0;
        return;
      end if;
      if r.pool_id is not null then
        raise exception 'POOL_MEMBER_HAS_POOL';
      end if;
      v_rate := r.points_per_dollar;
    end if;

    -- Every member, joiner included, must have a staff PIN. requirePin waves
    -- through any vendor whose pin_hash is null, and PINs are deliberately not
    -- copied between locations at onboarding, so a PIN-less member would be an
    -- ungated door onto a PIN-protected sibling's liability: walk into the
    -- shop with no PIN, redeem the whole chain's purse.
    if r.pin_hash is null then
      raise exception 'POOL_PIN_MISSING';
    end if;
  end loop;

  if not v_joiner_seen then
    raise exception 'VENDOR_NOT_FOUND';
  end if;

  -- Rate parity, checked against the rows just locked. Earning at 20 points a
  -- dollar and spending against a menu priced for 5 means one location is
  -- systematically funding the other out of a purse they share. The lock is
  -- what makes this hold: nothing can retune a member between this check and
  -- the drain below.
  for r in
    select v.points_per_dollar from vendors v where v.pool_id = p_pool_id
  loop
    if r.points_per_dollar <> v_rate then
      raise exception 'POOL_RATE_MISMATCH';
    end if;
  end loop;

  update vendors set pool_id = p_pool_id, pool_joined_at = now() where id = p_vendor_id;

  -- THE DRAIN. Ordered by user_id and locked, so it cannot interleave with
  -- itself, and every row it moves is recorded in pool_moves before the balance
  -- changes — that audit row is the only thing that can later say what this
  -- location contributed, and pool_leave's arithmetic is built on it.
  --
  -- balance > 0 only: a zero row is nothing to move, and pool_moves refuses a
  -- zero amount by construction (migration-044).
  for r in
    select pb.user_id, pb.balance
    from point_balances pb
    where pb.vendor_id = p_vendor_id and pb.balance > 0
    order by pb.user_id
    for update
  loop
    insert into pool_moves (pool_id, vendor_id, user_id, kind, amount)
    values (p_pool_id, p_vendor_id, r.user_id, 'join', r.balance);

    insert into pool_balances (user_id, pool_id, balance)
    values (r.user_id, p_pool_id, r.balance)
    on conflict (user_id, pool_id)
    do update set balance = pool_balances.balance + excluded.balance, updated_at = now();

    -- Zeroed, not deleted: the row is the record that this customer once had a
    -- balance here, pool_leave writes back into it, and every reader in the app
    -- already treats a pooled vendor's own row as superseded.
    update point_balances set balance = 0, updated_at = now()
    where user_id = r.user_id and vendor_id = p_vendor_id;

    n_customers := n_customers + 1;
    n_points := n_points + r.balance;
  end loop;

  return query select n_customers, n_points::integer;
end;
$$;

-- ---------- 2. pool_leave ----------
-- One location at a time, and the split described in the header.

create or replace function public.pool_leave(p_vendor_id uuid)
returns table (customers integer, points_moved integer)
language plpgsql security definer set search_path = public
as $$
declare
  r            record;
  v_pool       uuid;
  v_joined_at  timestamptz;
  v_last       boolean;
  v_share      integer;
  v_contrib    integer;
  n_customers  integer := 0;
  n_points     bigint  := 0;   -- see pool_join
begin
  perform set_config('app.points_write', 'server', true);

  -- An unlocked peek, for one purpose only: learning WHICH pool to lock. The
  -- authoritative read is the second one, under both locks.
  select v.pool_id into v_pool from vendors v where v.id = p_vendor_id;

  if not found then
    raise exception 'VENDOR_NOT_FOUND';
  end if;
  if v_pool is null then
    -- Not in a pool. A no-op for the same reason a repeated join is.
    return query select 0, 0;
    return;
  end if;

  -- The pool first, then the vendor: same order as pool_join, so a join and a
  -- leave on one pool queue instead of deadlocking. See pool_join's comment for
  -- why locking only the vendors row is not enough, and what it costs.
  perform 1 from point_pools where id = v_pool for update;

  select v.pool_id, v.pool_joined_at into v_pool, v_joined_at
  from vendors v where v.id = p_vendor_id for update;

  -- Re-read under the locks: another leave may have committed between the peek
  -- and the lock, and it is that transaction's answer that is now true.
  if v_pool is null then
    return query select 0, 0;
    return;
  end if;

  -- Is anyone left to spend the remainder? Correct only because the POOL row is
  -- held: a concurrent leave of the other last member is queued behind it and
  -- will read this transaction's committed result, rather than both of them
  -- seeing each other as staying and stranding the remainder between them.
  select not exists (
    select 1 from vendors v where v.pool_id = v_pool and v.id <> p_vendor_id
  ) into v_last;

  for r in
    select pl.user_id, pl.balance
    from pool_balances pl
    where pl.pool_id = v_pool and pl.balance > 0
    order by pl.user_id
    for update
  loop
    if v_last then
      -- Nobody left to spend it at. Anything still here would be invisible to
      -- the customer and unreachable forever, so the last member out carries
      -- the whole purse back to its own books.
      v_share := r.balance;
    else
      -- What THIS location's own trading put in, over its CURRENT membership.
      -- Both terms are windowed on pool_joined_at; see the header for the
      -- leave-then-rejoin case that proves why the pool_moves term needs it too.
      --
      -- AND ONLY 'join' ROWS. A membership's contribution from moves is the
      -- drain that started it; a 'leave' row describes the END of a membership
      -- and can never belong to the current one. Without the kind filter, a
      -- leave and a rejoin that land in the SAME transaction share a timestamp
      -- with the new pool_joined_at, so the old -120 and the new +120 both fall
      -- inside the window, cancel, and the location walks away with nothing it
      -- had just put back in. That is not hypothetical: any future "move this
      -- location to another pool" that does leave-then-join atomically hits it
      -- every single time.
      select coalesce(sum(pm.amount), 0) into v_contrib
      from pool_moves pm
      where pm.pool_id = v_pool
        and pm.vendor_id = p_vendor_id
        and pm.user_id = r.user_id
        and pm.kind = 'join'
        and pm.created_at >= v_joined_at;

      select v_contrib + coalesce(sum(t.points), 0) into v_contrib
      from transactions t
      where t.user_id = r.user_id
        and t.vendor_id = p_vendor_id
        and t.type in ('earn', 'redeem', 'community_transfer')
        and t.created_at >= v_joined_at;

      -- Clamped at both ends: never negative (a location that took more out
      -- than it put in withdraws nothing), never more than the purse holds.
      v_share := least(greatest(0, v_contrib), r.balance);
    end if;

    -- SKIPPED, not written as a zero. pool_moves.amount carries a `<> 0` check
    -- (migration-044) precisely so this decision has to be made on purpose: a
    -- customer this location never funded takes nothing from it, and that fact
    -- needs no audit row.
    if v_share > 0 then
      update pool_balances
      set balance = balance - v_share, updated_at = now()
      where user_id = r.user_id and pool_id = v_pool;

      insert into point_balances (user_id, vendor_id, balance)
      values (r.user_id, p_vendor_id, v_share)
      on conflict (user_id, vendor_id)
      do update set balance = point_balances.balance + excluded.balance, updated_at = now();

      insert into pool_moves (pool_id, vendor_id, user_id, kind, amount)
      values (v_pool, p_vendor_id, r.user_id, 'leave', -v_share);

      n_customers := n_customers + 1;
      n_points := n_points + v_share;
    end if;
  end loop;

  update vendors set pool_id = null, pool_joined_at = null where id = p_vendor_id;

  return query select n_customers, n_points::integer;
end;
$$;

-- ---------- 3. pool_delete ----------
-- Retire a pool. Refuses while anything is left in it or pointing at it, which
-- makes "empty it first" the only way, and pool_leave the only way to empty it.
-- That is also the teardown path for the DB-backed tests: leave every member
-- (the last one takes the remaining balance back to its own books), then
-- delete. A plain DELETE on pool_balances is blocked by the 025 guard, and
-- supabase-js returns the rejection as a value rather than throwing, so a test
-- that tried it would silently leak rows into the next run.

create or replace function public.pool_delete(p_pool_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform set_config('app.points_write', 'server', true);

  -- Same lock, same order, for the same reason: without it a join could commit
  -- between this check and the delete below, and point_pools would vanish from
  -- under a member that had just been pointed at it.
  perform 1 from point_pools where id = p_pool_id for update;
  if not found then
    return;   -- already gone; deleting twice is not an error
  end if;

  if exists (select 1 from vendors v where v.pool_id = p_pool_id) then
    raise exception 'POOL_HAS_MEMBERS';
  end if;

  if exists (select 1 from pool_balances pl where pl.pool_id = p_pool_id and pl.balance <> 0) then
    raise exception 'POOL_NOT_EMPTY';
  end if;

  delete from pool_balances where pool_id = p_pool_id;   -- zero rows only, by the check above
  delete from pool_moves    where pool_id = p_pool_id;
  delete from point_pools   where id = p_pool_id;
end;
$$;

-- ---------- 4. pool_settlement ----------
-- Who funded whom, per member, as a GROUP BY over rows that were already being
-- written. This is why sharing needs no new transactions.type and no change to
-- src/lib/analytics.js: the ledger already records WHERE every earn and every
-- redemption happened, and the purse records whose money it was.
--
-- It exists because per-location analytics are otherwise honest but baffling: a
-- shop that hands over a coffee bought with points earned next door shows a
-- redemption with no matching revenue, which is CORRECT and looks broken.
--
--   minted  points this location put INTO the purse: its earns, plus community
--           points customers moved in here. Not "minted" in the community sense
--           (the shop did not create those), but from the purse's point of view
--           it is the same event: value arrived here and the chain now owes it.
--   burned  points this location paid OUT of the purse: its redemptions, as a
--           positive number.
--   moved   what it contributed on joining (+) and took back on leaving (-).
--   net     minted + moved - burned. NEGATIVE means this shop has given away
--           more than it brought in, and its siblings owe it.
--
-- Every column is cast to integer explicitly: sum() over an integer column
-- returns bigint in Postgres, and a RETURNS TABLE declaring integer would raise
-- "structure of query does not match function result type" on the first call.
-- Nothing overflows an integer here that would not already have overflowed the
-- balance columns these numbers come from.
--
-- Windowed on each member's own pool_joined_at, so trading a location did
-- before it joined belongs to that location and not to the pool.

create or replace function public.pool_settlement(p_pool_id uuid)
returns table (
  vendor_id uuid,
  minted    integer,
  burned    integer,
  moved     integer,
  net       integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
    select v.id,
           coalesce(t.minted, 0)::integer,
           coalesce(t.burned, 0)::integer,
           coalesce(m.moved, 0)::integer,
           (coalesce(t.minted, 0) + coalesce(m.moved, 0) - coalesce(t.burned, 0))::integer
    from vendors v
    left join lateral (
      select sum(x.points) filter (where x.type in ('earn', 'community_transfer')) as minted,
             -sum(x.points) filter (where x.type = 'redeem')                       as burned
      from transactions x
      where x.vendor_id = v.id
        and x.created_at >= coalesce(v.pool_joined_at, '-infinity'::timestamptz)
    ) t on true
    left join lateral (
      -- 'join' only, exactly as pool_leave's contribution sum does, and for the
      -- same reason: a 'leave' row ends a membership and can never belong to
      -- the current one, but a leave and a rejoin inside ONE transaction share
      -- a timestamp with the new pool_joined_at, so the window alone would let
      -- the old -N cancel the new +N and report a member as having contributed
      -- nothing.
      select sum(pm.amount) as moved
      from pool_moves pm
      where pm.vendor_id = v.id and pm.pool_id = p_pool_id
        and pm.kind = 'join'
        and pm.created_at >= coalesce(v.pool_joined_at, '-infinity'::timestamptz)
    ) m on true
    where v.pool_id = p_pool_id
    order by v.pool_joined_at, v.id;
end;
$$;

-- ---------- 5. GRANTS ----------
-- Operator-only, through the server's service_role. Matching every other money
-- function: nothing here is reachable with the public anon key.
revoke execute on function public.pool_join(uuid, uuid)   from public, anon, authenticated;
revoke execute on function public.pool_leave(uuid)        from public, anon, authenticated;
revoke execute on function public.pool_delete(uuid)       from public, anon, authenticated;
revoke execute on function public.pool_settlement(uuid)   from public, anon, authenticated;
grant  execute on function public.pool_join(uuid, uuid)   to service_role;
grant  execute on function public.pool_leave(uuid)        to service_role;
grant  execute on function public.pool_delete(uuid)       to service_role;
grant  execute on function public.pool_settlement(uuid)   to service_role;

notify pgrst, 'reload schema';
