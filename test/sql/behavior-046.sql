-- Assertions for migration-046 (join, leave, settle).
--
-- This is the file that has to be right, because these are the only functions
-- in the feature that move a customer's EXISTING points. The through-line of
-- every assertion below is conservation: after any join, leave, or sequence of
-- them, the same number of points exists, and it is somewhere the customer can
-- actually spend it.
select set_config('app.points_write', 'server', false);

do $$
declare
  s1    uuid := '00000000-0000-0000-0000-000000000461';
  s2    uuid := '00000000-0000-0000-0000-000000000462';
  down  uuid := '00000000-0000-0000-0000-0000000006a1';
  camp  uuid := '00000000-0000-0000-0000-0000000006a2';
  nopin uuid := '00000000-0000-0000-0000-0000000006a4';
  fast  uuid := '00000000-0000-0000-0000-0000000006a5';
  pool  uuid := '00000000-0000-0000-0000-0000000006f1';
  r     record;
  n     integer;
  bal   integer;
begin
  -- ---------- 1. the preconditions ----------
  begin
    perform public.pool_join(pool, nopin);
    raise notice 'FAIL precondition: a PIN-less location was allowed to join';
  exception when others then
    if sqlerrm like '%POOL_PIN_MISSING%' then
      raise notice 'PASS precondition: a location with no staff PIN cannot join';
    else raise notice 'FAIL precondition: expected POOL_PIN_MISSING, got %', sqlerrm; end if;
  end;

  -- ---------- 2. the first join ----------
  select * into r from public.pool_join(pool, down);
  if r.customers = 2 and r.points_moved = 375 then
    raise notice 'PASS join: Downtown moved 2 customers and 375 points into the purse';
  else raise notice 'FAIL join: moved % customers / % points, expected 2 / 375', r.customers, r.points_moved; end if;

  select balance into bal from public.pool_balances where user_id = s1 and pool_id = pool;
  if bal = 300 then raise notice 'PASS join: S1 holds 300 in the purse';
  else raise notice 'FAIL join: S1 purse is %, expected 300', bal; end if;

  select balance into bal from public.point_balances where user_id = s1 and vendor_id = down;
  if bal = 0 then raise notice 'PASS join: the drained row is zeroed, not deleted';
  else raise notice 'FAIL join: Downtown row is % after the drain', bal; end if;

  -- ---------- 3. rate parity ----------
  -- The kiosk earns at 20 to Downtown's 10. Sharing a purse across those two
  -- means one systematically funds the other.
  begin
    perform public.pool_join(pool, fast);
    raise notice 'FAIL parity: a location on a different earning rate joined';
  exception when others then
    if sqlerrm like '%POOL_RATE_MISMATCH%' then
      raise notice 'PASS parity: a mismatched earning rate is refused';
    else raise notice 'FAIL parity: expected POOL_RATE_MISMATCH, got %', sqlerrm; end if;
  end;

  -- ---------- 4. the second join, and the number the owner cares about ------
  select * into r from public.pool_join(pool, camp);
  select balance into bal from public.pool_balances where user_id = s1 and pool_id = pool;
  if bal = 420 then raise notice 'PASS join: 300 at Downtown + 120 at Campus = one purse of 420';
  else raise notice 'FAIL join: the purse is %, expected 420', bal; end if;

  -- Conservation, stated as its own assertion because it is the whole promise.
  select coalesce(sum(pb.balance), 0) + coalesce((select sum(pl.balance) from pool_balances pl), 0)
    into n from point_balances pb;
  if n = 535 then raise notice 'PASS join: every point still exists (535 across both tables)';
  else raise notice 'FAIL join: total points are % after joining, expected 535', n; end if;

  -- ---------- 5. a repeat join is a no-op, not an error ----------
  select * into r from public.pool_join(pool, camp);
  if r.customers = 0 and r.points_moved = 0 then
    raise notice 'PASS join: joining a pool a location is already in does nothing';
  else raise notice 'FAIL join: a repeat join moved % points', r.points_moved; end if;
end $$;

do $$
declare
  s1   uuid := '00000000-0000-0000-0000-000000000461';
  s2   uuid := '00000000-0000-0000-0000-000000000462';
  s3   uuid := '00000000-0000-0000-0000-000000000463';
  down uuid := '00000000-0000-0000-0000-0000000006a1';
  camp uuid := '00000000-0000-0000-0000-0000000006a2';
  pool uuid := '00000000-0000-0000-0000-0000000006f1';
  r    record;
  n    integer;
  bal  integer;
begin
  -- ---------- 6. leaving: the contribution split ----------
  -- State: the purse holds 420 for S1 (300 from Downtown, 120 from Campus) and
  -- 75 for S2 (all from Downtown). Campus leaves. It funded 120 of S1's money
  -- and none of S2's, so it takes exactly 120, and takes nothing for S2.
  select * into r from public.pool_leave(camp);
  if r.customers = 1 and r.points_moved = 120 then
    raise notice 'PASS leave: Campus took back exactly what it funded (1 customer, 120)';
  else raise notice 'FAIL leave: took % customers / % points, expected 1 / 120', r.customers, r.points_moved; end if;

  select balance into bal from public.point_balances where user_id = s1 and vendor_id = camp;
  if bal = 120 then raise notice 'PASS leave: S1 has 120 back at Campus';
  else raise notice 'FAIL leave: S1 has % at Campus, expected 120', bal; end if;

  select balance into bal from public.pool_balances where user_id = s1 and pool_id = pool;
  if bal = 300 then raise notice 'PASS leave: the purse kept the 300 Downtown funded';
  else raise notice 'FAIL leave: purse is %, expected 300', bal; end if;

  select coalesce(balance, 0) into bal from public.point_balances where user_id = s2 and vendor_id = camp;
  if coalesce(bal, 0) = 0 then raise notice 'PASS leave: a customer Campus never funded got nothing from it';
  else raise notice 'FAIL leave: S2 was handed % at a location that never funded them', bal; end if;

  select count(*) into n from public.pool_moves
   where pool_id = pool and vendor_id = camp and user_id = s2;
  if n = 0 then raise notice 'PASS leave: no zero-amount audit row was written';
  else raise notice 'FAIL leave: a zero move row exists for a customer taking nothing'; end if;

  select coalesce(sum(pb.balance), 0) + coalesce((select sum(pl.balance) from pool_balances pl), 0)
    into n from point_balances pb;
  if n = 535 then raise notice 'PASS leave: conservation holds, still 535 points';
  else raise notice 'FAIL leave: total points are % after a leave, expected 535', n; end if;

  -- ---------- 7. rejoin composes ----------
  -- The case an unwindowed contribution sum gets wrong: Campus rejoins with its
  -- 120, and its FIRST membership's +120 join row is still sitting in
  -- pool_moves. If the sum ignored pool_joined_at it would now read 240 and let
  -- Campus withdraw twice what it funded.
  perform public.pool_join(pool, camp);
  select balance into bal from public.pool_balances where user_id = s1 and pool_id = pool;
  if bal = 420 then raise notice 'PASS rejoin: the purse is back to 420';
  else raise notice 'FAIL rejoin: purse is %, expected 420', bal; end if;

  select * into r from public.pool_leave(camp);
  if r.points_moved = 120 then
    raise notice 'PASS rejoin: leaving again takes 120, not the 240 an unwindowed sum would give';
  else raise notice 'FAIL rejoin: took % on the second leave, expected 120', r.points_moved; end if;

  select coalesce(sum(pb.balance), 0) + coalesce((select sum(pl.balance) from pool_balances pl), 0)
    into n from point_balances pb;
  if n = 535 then raise notice 'PASS rejoin: conservation still holds after join/leave/join/leave';
  else raise notice 'FAIL rejoin: total points are %, expected 535', n; end if;
end $$;

do $$
declare
  s1   uuid := '00000000-0000-0000-0000-000000000461';
  s2   uuid := '00000000-0000-0000-0000-000000000462';
  down uuid := '00000000-0000-0000-0000-0000000006a1';
  west uuid := '00000000-0000-0000-0000-0000000006a3';
  pool uuid := '00000000-0000-0000-0000-0000000006f1';
  r    record;
  n    integer;
  bal  integer;
  tot  integer;
begin
  -- ---------- 8. the settlement report ----------
  -- Downtown is the only member now, holding S1's 300 and S2's 75. Its `moved`
  -- is +375 from the join; it has minted nothing since (its earns predate
  -- pool_joined_at) and burned nothing.
  select * into r from public.pool_settlement(pool) where vendor_id = down;
  if r.moved = 375 then raise notice 'PASS settle: Downtown is credited with the 375 it contributed';
  else raise notice 'FAIL settle: moved is %, expected 375', r.moved; end if;
  -- Sign convention, and it is easy to get backwards: a shop with a POSITIVE
  -- net took cash and issued points that its siblings have not yet had to hand
  -- anything over for, so it OWES them. A shop with a negative net gave away
  -- the free coffee that someone else sold the points for, and is OWED.
  if r.net = 375 then raise notice 'PASS settle: Downtown funded the purse, so its net is positive and it owes the others';
  else raise notice 'FAIL settle: net is %, expected 375', r.net; end if;
  -- The bigint trap: sum() over an integer column is bigint, and a RETURNS
  -- TABLE of integer raises unless every column is cast. Getting here at all
  -- proves the casts are present.
  raise notice 'PASS settle: the function returns without a result-type error';

  -- ---------- 9. the LAST member out takes the remainder ----------
  -- Downtown funded 375 of the 375 left, so the split and the last-member rule
  -- agree here; what is being proved is that nothing is stranded either way.
  select * into r from public.pool_leave(down);
  select coalesce(sum(pl.balance), 0) into n from public.pool_balances pl where pl.pool_id = pool;
  if n = 0 then raise notice 'PASS last: the purse is empty after the final member leaves';
  else raise notice 'FAIL last: % points are stranded in a pool with no members', n; end if;

  select balance into bal from public.point_balances where user_id = s1 and vendor_id = down;
  if bal = 300 then raise notice 'PASS last: S1 has their 300 back at Downtown';
  else raise notice 'FAIL last: S1 has % at Downtown, expected 300', bal; end if;

  select coalesce(sum(pb.balance), 0) into tot from public.point_balances pb;
  if tot = 535 then raise notice 'PASS last: all 535 points are back in per-location purses';
  else raise notice 'FAIL last: % points exist after the pool emptied, expected 535', tot; end if;

  -- ---------- 10. retiring the pool ----------
  perform public.pool_delete(pool);
  select count(*) into n from public.point_pools where id = pool;
  if n = 0 then raise notice 'PASS delete: an empty, memberless pool can be retired';
  else raise notice 'FAIL delete: the pool survived pool_delete'; end if;

  -- And the guard that makes that the only order: a pool with a member cannot
  -- be deleted, which is what stops a DELETE vanishing live liability.
  insert into public.point_pools (id, label) values (pool, 'Joes 046');
  perform public.pool_join(pool, west);
  begin
    perform public.pool_delete(pool);
    raise notice 'FAIL delete: a pool with a member was deleted';
  exception when others then
    if sqlerrm like '%POOL_HAS_MEMBERS%' then
      raise notice 'PASS delete: a pool with members cannot be retired';
    else raise notice 'FAIL delete: expected POOL_HAS_MEMBERS, got %', sqlerrm; end if;
  end;

  -- ---------- 11. leaving a pool you are not in ----------
  perform public.pool_leave(west);
  select * into r from public.pool_leave(west);
  if r.customers = 0 and r.points_moved = 0 then
    raise notice 'PASS leave: leaving a pool you are not in does nothing';
  else raise notice 'FAIL leave: a second leave moved % points', r.points_moved; end if;

  select coalesce(sum(pb.balance), 0) + coalesce((select sum(pl.balance) from pool_balances pl), 0)
    into n from point_balances pb;
  if n = 535 then raise notice 'PASS final: 535 points in, 535 points out, across every operation';
  else raise notice 'FAIL final: total points are %, expected 535', n; end if;
end $$;
