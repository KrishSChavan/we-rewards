-- Assertions for migration-068 ($1 = 1 point everywhere). See seed-068.sql for
-- the world and the arithmetic behind every expected number below.
--
-- The through-line: each student is exactly as far from each item as before,
-- points moved in from community points are not shrunk, community balances and
-- history do not move, and a shared purse still splits fairly when a location
-- leaves it.
select set_config('app.points_write', 'server', false);

do $$
declare
  s1   uuid := '00000000-0000-0000-0000-000000006801';
  s2   uuid := '00000000-0000-0000-0000-000000006802';
  s3   uuid := '00000000-0000-0000-0000-000000006803';
  s4   uuid := '00000000-0000-0000-0000-000000006804';
  s5   uuid := '00000000-0000-0000-0000-000000006805';
  ten  uuid := '00000000-0000-0000-0000-0000000068a1';
  one  uuid := '00000000-0000-0000-0000-0000000068a2';
  half uuid := '00000000-0000-0000-0000-0000000068a3';
  p1   uuid := '00000000-0000-0000-0000-0000000068b1';
  p2   uuid := '00000000-0000-0000-0000-0000000068b2';
  pool uuid := '00000000-0000-0000-0000-0000000068f1';
  n    integer;
  bal  integer;
  got  text;
begin
  -- ---------- 1. the rate ----------
  select count(*) into n from public.vendors where points_per_dollar <> 1;
  if n = 0 then raise notice 'PASS rate: every vendor earns 1 point per $1';
  else raise notice 'FAIL rate: % vendor(s) still off 1', n; end if;

  begin
    update public.vendors set points_per_dollar = 10 where id = one;
    raise notice 'FAIL rate: a vendor was moved back to 10 points per $1';
  exception when check_violation then
    raise notice 'PASS rate: the CHECK refuses any rate but 1';
  end;

  insert into public.vendors (id, name, slug) values
    ('00000000-0000-0000-0000-0000000068d1', 'New 068', 'new-068');
  select points_per_dollar::text into got from public.vendors where id = '00000000-0000-0000-0000-0000000068d1';
  if got = '1.00' then raise notice 'PASS rate: a new vendor defaults to 1';
  else raise notice 'FAIL rate: a new vendor got %', got; end if;
  delete from public.vendors where id = '00000000-0000-0000-0000-0000000068d1';

  -- ---------- 2. prices ----------
  select string_agg(title || '=' || coalesce(cost_in_points::text, 'null'), ' ' order by title) into got
  from public.rewards where vendor_id = ten;
  if got = 'Gyro=100 Mint=1 Odd=151 Punch roll=null Sign-up=0' then
    raise notice 'PASS prices: divided by 10, rounded, never below 1; free and visits-only untouched';
  else raise notice 'FAIL prices at TEN: %', got; end if;

  select cost_in_points into n from public.rewards where vendor_id = one;
  if n = 20 then raise notice 'PASS prices: a spot already at 1 keeps its prices';
  else raise notice 'FAIL prices: the 20-point cookie is now %', n; end if;

  select string_agg(title || '=' || cost_in_points, ' ' order by title) into got
  from public.rewards where vendor_id = half;
  if got = 'Catering=100000 Drink=200' then
    raise notice 'PASS prices: a rate below 1 doubles them, capped at 100000';
  else raise notice 'FAIL prices at HALF: %', got; end if;

  select cost_in_points into n from public.rewards where vendor_id = p1;
  if n = 100 then raise notice 'PASS prices: a pooled location is converted too';
  else raise notice 'FAIL prices: the pooled taco is %', n; end if;

  select string_agg(id::text || '=' || review_points, ' ' order by id) into got
  from public.vendors where id in (ten, one, half);
  if got = ten || '=5 ' || one || '=20 ' || half || '=500' then
    raise notice 'PASS review points: divided like a price, capped at 500, rate-1 spot untouched';
  else raise notice 'FAIL review points: %', got; end if;

  -- ---------- 3. a spot's own balances ----------
  select balance into bal from public.point_balances where user_id = s1 and vendor_id = ten;
  if bal = 61 then raise notice 'PASS balance: 50 moved in stays 50, 105 earned becomes 11 (rounded up)';
  else raise notice 'FAIL balance: S1 at TEN is %, wanted 61', bal; end if;

  select balance into bal from public.point_balances where user_id = s2 and vendor_id = ten;
  if bal = 152 then raise notice 'PASS balance: 1512 earned becomes 152 (rounded up)';
  else raise notice 'FAIL balance: S2 at TEN is %, wanted 152', bal; end if;

  select balance into bal from public.point_balances where user_id = s3 and vendor_id = ten;
  if bal = 30 then raise notice 'PASS balance: after spending 20 of 50 moved in, the 30 left is all moved-in';
  else raise notice 'FAIL balance: S3 at TEN is %, wanted 30', bal; end if;

  select balance into bal from public.point_balances where user_id = s1 and vendor_id = one;
  if bal = 84 then raise notice 'PASS balance: a spot already at 1 is untouched';
  else raise notice 'FAIL balance: S1 at ONE is %, wanted 84', bal; end if;

  select balance into bal from public.point_balances where user_id = s1 and vendor_id = half;
  if bal = 14 then raise notice 'PASS balance: a rate below 1 doubles it';
  else raise notice 'FAIL balance: S1 at HALF is %, wanted 14', bal; end if;

  select count(*) into n from public.rate_conversion_068 where user_id = s4 and what = 'point_balance';
  if n = 0 then raise notice 'PASS balance: an empty balance is skipped, not recorded';
  else raise notice 'FAIL balance: S4''s zero was recorded % time(s)', n; end if;

  -- ---------- 4. what does not move ----------
  select balance into bal from public.community_balances where user_id = s1;
  if bal = 50 then raise notice 'PASS community: community balances are not scaled';
  else raise notice 'FAIL community: S1 has %, wanted 50', bal; end if;

  select count(*), sum(points) into n, bal from public.transactions where user_id in (s1, s2, s3, s4, s5);
  if n = 18 and bal = 2431 then raise notice 'PASS history: every transaction keeps the points it was written with';
  else raise notice 'FAIL history: % rows summing %, wanted 18 / 2431', n, bal; end if;

  -- ---------- 5. the shared purse ----------
  select string_agg(user_id::text || '=' || balance, ' ' order by user_id) into got
  from public.pool_balances where pool_id = pool;
  if got = s1 || '=118 ' || s2 || '=6 ' || s3 || '=5 ' || s4 || '=20 ' || s5 || '=55' then
    raise notice 'PASS purse: balances divided, moved-in points kept 1:1';
  else raise notice 'FAIL purse balances: %', got; end if;

  select count(*) into n from public.vendors
  where pool_id = pool and pool_joined_at > now() - interval '1 hour';
  if n = 2 then raise notice 'PASS purse: both memberships restart at the conversion';
  else raise notice 'FAIL purse: % membership(s) restarted, wanted 2', n; end if;

  select string_agg(v.slug || '/' || right(pm.user_id::text, 1) || '=' || pm.amount, ' ' order by v.slug, pm.user_id) into got
  from public.pool_moves pm join public.vendors v on v.id = pm.vendor_id
  where pm.pool_id = pool and pm.kind = 'join' and pm.created_at >= v.pool_joined_at;
  if got = 'chain-068-camp/2=6 chain-068-camp/3=-15 chain-068-camp/4=10 chain-068-down/1=117 chain-068-down/3=20 chain-068-down/4=10 chain-068-down/5=10' then
    raise notice 'PASS purse: one rebased share per location and customer, by pool_leave''s own formula (S5 owes Campus nothing)';
  else raise notice 'FAIL purse shares: %', got; end if;

  select string_agg(v.slug || '=' || s.net, ' ' order by v.slug) into got
  from public.pool_settlement(pool) s join public.vendors v on v.id = s.vendor_id;
  if got = 'chain-068-camp=1 chain-068-down=157' then
    raise notice 'PASS purse: pool_settlement reads the rebased shares';
  else raise notice 'FAIL purse settlement: %', got; end if;

  -- Downtown leaves. S4 earned the same at both, so Downtown takes 10 of their
  -- 20 and Campus keeps 10. Read against the unconverted history it would have
  -- claimed 100, been capped at the whole 20, and left Campus nothing.
  perform public.pool_leave(p1);
  select balance into bal from public.pool_balances where user_id = s4 and pool_id = pool;
  if bal = 10 then raise notice 'PASS purse: a leaving location takes its converted share, not ten times it';
  else raise notice 'FAIL purse: S4 has % left in the purse, wanted 10', bal; end if;

  select string_agg(right(user_id::text, 1) || '=' || balance, ' ' order by user_id) into got
  from public.point_balances where vendor_id = p1;
  if got = '1=117 3=5 4=10 5=10' then raise notice 'PASS purse: Downtown''s customers got their shares back on its books';
  else raise notice 'FAIL purse: Downtown''s books after leaving: %', got; end if;

  -- ---------- 6. the record ----------
  select string_agg(what || '=' || c, ' ' order by what) into got
  from (select what, count(*) as c from public.rate_conversion_068 group by what) x;
  if got = 'point_balance=4 pool_balance=5 pool_share=8 rate=4 review_points=2 reward=6' then
    raise notice 'PASS record: every changed value is in rate_conversion_068';
  else raise notice 'FAIL record: %', got; end if;

  select relrowsecurity::text into got from pg_class where oid = 'public.rate_conversion_068'::regclass;
  if got = 'true' then raise notice 'PASS record: the table holding user ids has RLS on';
  else raise notice 'FAIL record: RLS is %', got; end if;

  -- ---------- 7. the community mint is 50% ----------
  perform public.award_points(s4, one, 9, 9, null);
  select community_points into n from public.transactions
  where user_id = s4 and vendor_id = one and type = 'earn' order by created_at desc limit 1;
  if n = 4 then raise notice 'PASS mint: a $9 earn mints 4 (50%%, rounded down)';
  else raise notice 'FAIL mint: a 9-point earn minted %, wanted 4', n; end if;

  perform public.award_points(s2, one, 121, 121, null);
  select community_points into n from public.transactions
  where user_id = s2 and vendor_id = one and type = 'earn' order by created_at desc limit 1;
  if n = 60 then raise notice 'PASS mint: a 121-point earn mints 60';
  else raise notice 'FAIL mint: a 121-point earn minted %, wanted 60', n; end if;

  perform public.award_points(s2, one, 400, 400, 'tok-068-cap');
  select community_points into n from public.transactions
  where user_id = s2 and vendor_id = one and client_token = 'tok-068-cap';
  if n = 140 then raise notice 'PASS mint: the 200-a-day cap still holds (60 earlier + 140)';
  else raise notice 'FAIL mint: the capped earn minted %, wanted 140', n; end if;

  perform public.award_points(s1, half, 10, 10, null);
  select community_points into n from public.transactions
  where user_id = s1 and vendor_id = half and type = 'earn' order by created_at desc limit 1;
  if n = 0 then raise notice 'PASS mint: an inactive spot still mints nothing';
  else raise notice 'FAIL mint: an inactive spot minted %', n; end if;

  -- ---------- 8. item prices ----------
  update public.rewards set item_price_cents = 499 where vendor_id = one;
  raise notice 'PASS item price: a $4.99 price saves';
  begin
    update public.rewards set item_price_cents = 0 where vendor_id = one;
    raise notice 'FAIL item price: a $0.00 price was accepted';
  exception when check_violation then
    raise notice 'PASS item price: a zero price is refused (leave it empty instead)';
  end;
  begin
    update public.rewards set item_price_cents = 100001 where vendor_id = one;
    raise notice 'FAIL item price: a price over $1,000 was accepted';
  exception when check_violation then
    raise notice 'PASS item price: a price over $1,000 is refused';
  end;
end $$;
