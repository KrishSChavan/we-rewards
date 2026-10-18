-- ============================================================
-- Migration 068 — One earning rate everywhere: $1 = 1 point.
--
--   Until now every vendor picked its own points_per_dollar (0.5 to 1000, most
--   at the table default of 10), so "150 points" meant $15 of lunch at one spot
--   and $150 at the next. Students could not compare spots or tell how close
--   they were to anything. From here on the rate is 1 for every vendor, held by
--   a CHECK, and an item's point price is what tells a student what it takes.
--
--   WHAT THIS FILE DOES
--   1. rewards.item_price_cents — what the item sells for, optional. The ITEMS
--      form now asks for it and suggests 4x as the point price (buy four, the
--      fifth is free; src/lib/rewards.js suggestedItemPoints). Informational:
--      nothing here prices anything from it.
--   2. The one-time conversion, for every vendor whose rate is not already 1.
--      Each balance and price at that spot is divided by its old rate, so a
--      student 80 of the way to a 150-point item is 8 of the way to a 15-point
--      one: the same progress, and the same cost to the vendor.
--        - rewards.cost_in_points   round(cost / rate), never below 1. A free
--                                   item (0) stays free; a visits-only item
--                                   (null) is untouched.
--        - vendors.review_points    round(points / rate), 0 stays 0 (066).
--        - point_balances,          the points EARNED there are divided and
--          pool_balances            rounded UP, in the student's favour. Points
--                                   a student MOVED in from community points
--                                   (transactions.type 'community_transfer') stay
--                                   1:1: community points are not being scaled
--                                   (owner's decision, 2026-10-18), so dividing
--                                   them here would leave a student who moved
--                                   50 worse off than one who kept them.
--        - shared purses            rebased, see below.
--        - vendors.points_per_dollar  set to 1.
--      Every old and new value lands in rate_conversion_068, so the change can
--      be read back, or undone by hand, from one table.
--   3. points_per_dollar defaults to 1 and a CHECK holds it there. The vendor
--      Settings field, the operator's field and the onboard script's --ratio are
--      gone; the CHECK is what stops anything that still tries.
--   4. award_points mints 50% of every earn into community points, up from 10%
--      (owner's decision, 2026-10-18). At $1 = 1 point, 10% rounded down would
--      mint nothing on any purchase under $10, which is most of them.
--
--   WHAT IT DELIBERATELY LEAVES ALONE
--   - transactions. History keeps the numbers it was written with: a $15 lunch
--     from last month still reads +150 (owner's decision, 2026-10-18). Undo
--     reaches back one minute (reverse_transaction, 045), so an old-scale row
--     undone against a converted balance would take ten times too much back.
--     The conversion therefore REFUSES to run while any spot it would convert
--     has a transaction less than a minute old (RATE_CONVERSION_TOO_SOON), and
--     holds those spots' rows locked until it commits, so none can appear.
--   - community points: community_balances, incentive amounts (the signup bonus,
--     referrals, ambassadors) and the 200-a-day mint cap.
--   - visits, punch cards, the quick-amount buttons (they are dollar amounts).
--
--   SHARED PURSES (migration-044/046). pool_leave and pool_settlement work out
--   each location's share from its pool_moves 'join' rows plus its transactions
--   since vendors.pool_joined_at. Those rows keep their old numbers, so left as
--   they are a location leaving a converted purse would take back ten times its
--   share. Instead each member's share is computed once, here, with the same
--   formula pool_leave uses, converted the same way as a balance (moved-in
--   points 1:1 up to what the share still holds, the rest / rate), written as
--   ONE 'join' row per (location, customer) at now(), and pool_joined_at moves
--   to now(). From then on both functions read that row plus new, $1 = 1
--   trading, and need no change. What the operator's pool view shows changes
--   with it: "joined" carries the conversion date, and pool_settlement's
--   minted / burned restart at 0 with each location's converted net in "moved"
--   (negative for a location whose customers spent more there than they earned).
--
--   ⚠ DEPLOY ORDER: apply this BEFORE deploying the server that ships with it.
--   The old server keeps working on the new database (it reads the rate per
--   request, and 1 is a rate it accepts). The new server on the OLD database
--   does not: it would suggest 4x prices at spots still earning 10 points per $1.
--
--   ⚠ APPLY WHILE THE TILLS ARE QUIET. A sale the server priced at the old rate
--   a moment before this commits lands on a converted balance at ten times its
--   new value. The DO block locks the vendors it converts, so a sale queues
--   behind it rather than splitting it, but it cannot reprice one already sent.
--
--   PREVIEW FIRST (read-only; run on its own before applying):
--     select v.name, v.location_label, v.points_per_dollar as rate,
--            r.title, r.cost_in_points as now,
--            greatest(1, round(r.cost_in_points / v.points_per_dollar)) as after
--     from vendors v join rewards r on r.vendor_id = v.id
--     where v.points_per_dollar <> 1 and r.cost_in_points > 0
--     order by v.name, r.cost_in_points;
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-066 (it converts vendors.review_points) and migration-067. One
--   transaction: if anything fails, nothing has changed, including the 50%
--   mint. RATE_CONVERSION_TOO_SOON or a lock timeout just means a till was busy;
--   wait a minute and run it again. Safe to re-run after it succeeds: the
--   conversion only touches vendors whose rate is not 1, and then there are none.
-- ============================================================

begin;

set local lock_timeout = '3s';

-- ---------- 1. rewards.item_price_cents ----------
-- Cents, so a $4.99 coffee is stored exactly. 1 cent to $1,000: the same top
-- as /join's price box, and 4x of it is still well inside cost_in_points' cap.

alter table public.rewards add column if not exists item_price_cents integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rewards_item_price_range') then
    alter table public.rewards add constraint rewards_item_price_range
      check (item_price_cents is null or item_price_cents between 1 and 100000);
  end if;
end $$;

comment on column public.rewards.item_price_cents is
  'What the item sells for, in cents, as the vendor entered it (migration-068). '
  'Optional and informational: the ITEMS form suggests cost_in_points = 4 x the '
  'whole-dollar price, and the vendor can set any point price they like.';

-- ---------- 2. the record of the conversion ----------
-- One row per value changed. Holds user ids, so it gets the same treatment as
-- every other server-only table: RLS on, no policies, no client grants.

create table if not exists public.rate_conversion_068 (
  id           bigint generated always as identity primary key,
  what         text    not null check (what in ('rate', 'reward', 'review_points',
                                                 'point_balance', 'pool_balance', 'pool_share')),
  vendor_id    uuid,
  pool_id      uuid,
  user_id      uuid,
  reward_id    uuid,
  old_rate     numeric(6,2) not null,
  old_value    numeric not null,
  new_value    numeric not null,
  moved_in     integer,          -- balances only: the community points kept 1:1
  converted_at timestamptz not null default now()
);

alter table public.rate_conversion_068 enable row level security;
revoke all on public.rate_conversion_068 from public, anon, authenticated;

comment on table public.rate_conversion_068 is
  'Every value migration-068 changed when it moved vendors to $1 = 1 point: the '
  'old rate, the old value and the new one. Read it to see what moved, or to undo '
  'the conversion by hand.';

-- ---------- 3. the conversion ----------

do $$
declare
  v         record;
  r         record;
  v_pool    record;
  v_moved   integer;
  v_new     integer;
  v_rate    numeric;
  n_vendors integer := 0;
begin
  -- The 025 guard triggers on point_balances, pool_balances and pool_moves.
  -- Transaction-local, like every RPC that writes them.
  perform set_config('app.points_write', 'server', true);

  -- Lock every vendor about to change. award_points takes these rows FOR SHARE,
  -- so a sale at one of them waits for this block to commit instead of landing
  -- between a balance being divided and the rate being changed. In id order,
  -- like pool_join, so the two cannot deadlock.
  perform 1 from vendors where points_per_dollar <> 1 order by id for update;

  -- Nothing at those spots in the last minute, the window reverse_transaction
  -- allows (045). An undo of an older-scale sale against a converted balance
  -- would take back ten times the points. clock_timestamp, not now(): the lock
  -- above may have waited. Rows written after the lock cannot exist until this
  -- transaction ends, so checking once here is enough.
  if exists (
    -- `sv`, not `v`: v is this block's loop record, and PL/pgSQL would read
    -- v.points_per_dollar as that variable.
    select 1 from transactions t join vendors sv on sv.id = t.vendor_id
    where sv.points_per_dollar <> 1
      and t.created_at > clock_timestamp() - interval '65 seconds'
  ) then
    raise exception 'RATE_CONVERSION_TOO_SOON: a spot being converted had a sale, redemption or undo in the last minute. Wait a minute and run this again.';
  end if;

  -- A shared purse has ONE balance per customer, so its members must have had
  -- one rate for "divide by the old rate" to mean anything. pool_join refuses
  -- a mismatch and every rate change has been copied to the siblings, so this
  -- should never fire; if it does, stop rather than guess which rate was right.
  for v_pool in
    select pool_id from vendors where pool_id is not null
    group by pool_id having count(distinct points_per_dollar) > 1
  loop
    raise exception 'RATE_CONVERSION_MIXED_POOL: pool % has members on different rates; give them one rate, then re-run.', v_pool.pool_id;
  end loop;

  -- ----- shared purses first: read the history before anything moves -----
  for v_pool in
    select v2.pool_id, max(v2.points_per_dollar) as rate
    from vendors v2
    where v2.pool_id is not null and v2.points_per_dollar <> 1
    group by v2.pool_id
  loop
    v_rate := v_pool.rate;

    -- Each member's share, per customer, by pool_leave's own formula: its
    -- 'join' moves plus its earn / redeem / community_transfer rows, both since
    -- it joined. Split into the moved-in part (kept 1:1) and the rest (/ rate).
    -- A deleted account's rows (user_id set null, migration-011) get a share
    -- too: pool_leave can never pay it to anyone, but pool_settlement counted
    -- those points as minted, and the null-user row keeps its totals whole.
    -- Moved-in points stay 1:1 only up to what the share still holds, as for
    -- a balance below: a customer who moved 50 in, earned 100 and spent 150
    -- there funded nothing, and their share must stay 0, not become 45.
    for r in
      with members as (
        select id, pool_joined_at from vendors where pool_id = v_pool.pool_id
      ),
      parts as (
        select m.id as vendor_id, pm.user_id, 0 as moved, pm.amount as other
        from members m join pool_moves pm
          on pm.vendor_id = m.id and pm.pool_id = v_pool.pool_id
         and pm.kind = 'join' and pm.created_at >= m.pool_joined_at
        union all
        select m.id, t.user_id,
               case when t.type = 'community_transfer' then t.points else 0 end,
               case when t.type = 'community_transfer' then 0 else t.points end
        from members m join transactions t
          on t.vendor_id = m.id and t.created_at >= m.pool_joined_at
         and t.type in ('earn', 'redeem', 'community_transfer')
      )
      select vendor_id, user_id, sum(moved + other)::integer as total, sum(moved)::integer as moved
      from parts group by vendor_id, user_id
    loop
      v_moved := least(greatest(0, r.total), greatest(0, r.moved));
      v_new   := v_moved + round((r.total - v_moved) / v_rate)::integer;
      insert into rate_conversion_068 (what, vendor_id, pool_id, user_id, old_rate, old_value, new_value, moved_in)
      values ('pool_share', r.vendor_id, v_pool.pool_id, r.user_id, v_rate, r.total, v_new, v_moved);
    end loop;

    -- The purse itself. Moved-in = what this customer moved into any member
    -- since that member joined, capped at the balance: if they have since
    -- spent, the points spent are taken to be the earned ones, which is the
    -- reading that leaves them better off and can never mint.
    for r in
      select pl.user_id, pl.balance,
             coalesce((select sum(t.points) from transactions t
                       join vendors m on m.id = t.vendor_id
                       where m.pool_id = v_pool.pool_id
                         and t.user_id = pl.user_id
                         and t.type = 'community_transfer'
                         and t.created_at >= m.pool_joined_at), 0)::integer as transferred
      from pool_balances pl
      where pl.pool_id = v_pool.pool_id and pl.balance > 0
      for update of pl
    loop
      v_moved := least(r.balance, greatest(0, r.transferred));
      v_new   := v_moved + ceil((r.balance - v_moved) / v_rate)::integer;
      update pool_balances set balance = v_new, updated_at = now()
      where user_id = r.user_id and pool_id = v_pool.pool_id;
      insert into rate_conversion_068 (what, pool_id, user_id, old_rate, old_value, new_value, moved_in)
      values ('pool_balance', v_pool.pool_id, r.user_id, v_rate, r.balance, v_new, v_moved);
    end loop;

    -- Rebase: one 'join' row per (member, customer) carrying the converted
    -- share, and the membership window restarted at the same instant, so
    -- pool_leave and pool_settlement read exactly that row and what follows.
    -- pool_moves.amount refuses 0, and a share of 0 needs no row: it is what a
    -- missing row already means.
    update vendors set pool_joined_at = now() where pool_id = v_pool.pool_id;

    insert into pool_moves (pool_id, vendor_id, user_id, kind, amount)
    select c.pool_id, c.vendor_id, c.user_id, 'join', c.new_value::integer
    from rate_conversion_068 c
    where c.what = 'pool_share' and c.pool_id = v_pool.pool_id
      and c.converted_at = now() and c.new_value <> 0;
  end loop;

  -- ----- every vendor off 1: balances, prices, review points, the rate -----
  for v in
    select id, points_per_dollar as rate from vendors where points_per_dollar <> 1
  loop
    n_vendors := n_vendors + 1;

    -- Its own purse. For a pooled vendor this is the husk pool_join drained,
    -- normally empty, but converted all the same if it is not.
    for r in
      select pb.user_id, pb.balance,
             coalesce((select sum(t.points) from transactions t
                       where t.vendor_id = v.id and t.user_id = pb.user_id
                         and t.type = 'community_transfer'), 0)::integer as transferred
      from point_balances pb
      where pb.vendor_id = v.id and pb.balance > 0
      for update of pb
    loop
      v_moved := least(r.balance, greatest(0, r.transferred));
      v_new   := v_moved + ceil((r.balance - v_moved) / v.rate)::integer;
      update point_balances set balance = v_new, updated_at = now()
      where user_id = r.user_id and vendor_id = v.id;
      insert into rate_conversion_068 (what, vendor_id, user_id, old_rate, old_value, new_value, moved_in)
      values ('point_balance', v.id, r.user_id, v.rate, r.balance, v_new, v_moved);
    end loop;

    -- Prices. least() only matters below a rate of 1, where dividing raises.
    for r in
      select id, cost_in_points from rewards
      where vendor_id = v.id and cost_in_points > 0
    loop
      v_new := greatest(1, least(100000, round(r.cost_in_points / v.rate)))::integer;
      update rewards set cost_in_points = v_new where id = r.id;
      insert into rate_conversion_068 (what, vendor_id, reward_id, old_rate, old_value, new_value)
      values ('reward', v.id, r.id, v.rate, r.cost_in_points, v_new);
    end loop;

    -- What a review pays here (066), capped by its own 0..500 CHECK.
    for r in
      select review_points from vendors where id = v.id and review_points > 0
    loop
      v_new := greatest(1, least(500, round(r.review_points / v.rate)))::integer;
      update vendors set review_points = v_new where id = v.id;
      insert into rate_conversion_068 (what, vendor_id, old_rate, old_value, new_value)
      values ('review_points', v.id, v.rate, r.review_points, v_new);
    end loop;

    update vendors set points_per_dollar = 1 where id = v.id;
    insert into rate_conversion_068 (what, vendor_id, old_rate, old_value, new_value)
    values ('rate', v.id, v.rate, v.rate, 1);
  end loop;

  raise notice 'migration-068: % vendor(s) moved to $1 = 1 point', n_vendors;
end $$;

-- ---------- 4. hold it there ----------

alter table public.vendors alter column points_per_dollar set default 1;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'vendors_points_per_dollar_is_one') then
    alter table public.vendors add constraint vendors_points_per_dollar_is_one
      check (points_per_dollar = 1);
  end if;
end $$;

comment on column public.vendors.points_per_dollar is
  'Points per $1 spent. 1 at every vendor since migration-068, held by '
  'vendors_points_per_dollar_is_one. Kept as a column because every earn path '
  'reads it; the CHECK is what makes it a constant.';

-- ---------- 5. award_points: the community mint goes to 50% ----------
-- 045's body verbatim except c_rate and the comments that name it. Same
-- signature and return type, so create-or-replace keeps the EXECUTE grants.
-- ⚠ Same ordering footgun as 026 and 045: re-running any older file that
-- defines award_points restores a 10% body. Re-run this file afterwards.

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
  -- 50% of the points ACTUALLY awarded (10% until migration-068) — post-
  -- multiplier, so a 2x-tier student earning 30 mints 15, not 7. Rewards what
  -- the tier system already rewards.
  c_rate      constant numeric := 0.50;
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

  -- ----- the community 50% -----
  -- Derived HERE, from the number this function is already writing. It never
  -- crosses the wire as an input (community-points.md, constraint 3).
  v_community := floor(p_points * c_rate);

  -- An admin-hidden vendor mints nothing. tiers.js already drops txns at
  -- vendors.active = false from the tier math; the mint follows the same rule so
  -- a delisted shop can't keep issuing cross-vendor value. The VENDOR points
  -- still award in full — only the community 50% is withheld. (v_vendor_active
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

notify pgrst, 'reload schema';

commit;
