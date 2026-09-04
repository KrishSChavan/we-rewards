-- Assertions for migration-045 (the RPC bodies learn about pools).
--
-- The first block is the regression test for the bug this migration exists to
-- avoid, and it is deliberately first: a customer redeeming at a sibling they
-- have never earned at must get a RESULT ROW back, not an empty set. With 029's
-- trailing re-read of point_balances, this is the call that debits the purse,
-- deletes the code, and then hands the API nothing, which it reports to the
-- cashier as "that code is expired or invalid".
--
-- Everything after it proves the rest of the purse rule, and that an unpooled
-- vendor is untouched.
select set_config('app.points_write', 'server', false);

do $$
declare
  s1     uuid := '00000000-0000-0000-0000-000000000451';
  down   uuid := '00000000-0000-0000-0000-0000000005a1';
  campus uuid := '00000000-0000-0000-0000-0000000005a2';
  pool   uuid := '00000000-0000-0000-0000-0000000005f1';
  coffee uuid := '00000000-0000-0000-0000-0000000005c2';
  v_code  text;
  r      record;
  n      integer;
  bal    integer;
begin
  -- ---------- 1. THE REGRESSION: redeem at a sibling, with no local row ------
  select count(*) into n from public.point_balances
   where user_id = s1 and vendor_id = campus;
  if n = 0 then raise notice 'PASS setup: S1 has no point_balances row at Campus, as intended';
  else raise notice 'FAIL setup: S1 has a Campus row, the regression cannot be tested'; end if;

  v_code := public.create_redeem_code(s1, campus, coffee, 'points', 120);

  select * into r from public.redeem_by_code(v_code, campus);
  if r is null or r.new_balance is null then
    raise notice 'FAIL redeem: redeeming at a sibling returned NO ROW (the 029 bug is live)';
  else
    raise notice 'PASS redeem: redeeming at a sibling returns a row, balance %', r.new_balance;
  end if;
  if r.new_balance = 200 then raise notice 'PASS redeem: 500 - 300 came out of the SHARED purse';
  else raise notice 'FAIL redeem: expected 200 back, got %', r.new_balance; end if;
  if r.reward_title = 'Campus Coffee' then raise notice 'PASS redeem: the sibling sold its OWN item';
  else raise notice 'FAIL redeem: wrong reward title %', r.reward_title; end if;

  select balance into bal from public.pool_balances where user_id = s1 and pool_id = pool;
  if bal = 200 then raise notice 'PASS redeem: the pool row itself is 200';
  else raise notice 'FAIL redeem: pool row is %, expected 200', bal; end if;

  -- The ledger still records WHERE, even though the money was the chain's.
  select count(*) into n from public.transactions
   where user_id = s1 and vendor_id = campus and type = 'redeem' and points = -300;
  if n = 1 then raise notice 'PASS ledger: the redeem row carries Campus, not the pool';
  else raise notice 'FAIL ledger: expected 1 Campus redeem row, found %', n; end if;

  select count(*) into n from public.point_balances where user_id = s1 and vendor_id = campus;
  if n = 0 then raise notice 'PASS ledger: no stray per-vendor row was created at Campus';
  else raise notice 'FAIL ledger: a point_balances row appeared at Campus'; end if;

  -- ---------- 2. earning at one location, spendable at the other ----------
  perform public.award_points(s1, down, 100, 10, null);
  select balance into bal from public.pool_balances where user_id = s1 and pool_id = pool;
  if bal = 300 then raise notice 'PASS award: earning at Downtown credited the shared purse (300)';
  else raise notice 'FAIL award: pool is % after a 100 award, expected 300', bal; end if;

  select count(*) into n from public.point_balances where user_id = s1 and vendor_id = down;
  if n = 0 then raise notice 'PASS award: nothing was written to the location''s own purse';
  else raise notice 'FAIL award: award_points wrote a point_balances row for a pooled vendor'; end if;

  select count(*) into n from public.transactions
   where user_id = s1 and vendor_id = down and type = 'earn' and points = 100;
  if n = 1 then raise notice 'PASS award: the earn row carries the earning location';
  else raise notice 'FAIL award: expected 1 Downtown earn row, found %', n; end if;
end $$;

do $$
declare
  s1     uuid := '00000000-0000-0000-0000-000000000451';
  s2     uuid := '00000000-0000-0000-0000-000000000452';
  down   uuid := '00000000-0000-0000-0000-0000000005a1';
  campus uuid := '00000000-0000-0000-0000-0000000005a2';
  solo   uuid := '00000000-0000-0000-0000-0000000005a3';
  pool   uuid := '00000000-0000-0000-0000-0000000005f1';
  bagel  uuid := '00000000-0000-0000-0000-0000000005c1';
  coffee uuid := '00000000-0000-0000-0000-0000000005c2';
  drink  uuid := '00000000-0000-0000-0000-0000000005c3';
  salad  uuid := '00000000-0000-0000-0000-0000000005c4';
  v_code  text;
  v_code2 text;
  r      record;
  n      integer;
  bal    integer;
begin
  -- ---------- 3. a short purse refuses, and does not eat the code ----------
  -- The purse holds 300. A 350-point item at Downtown must fail, and the
  -- rollback has to take the code deletion with it, or the customer is left
  -- holding a dead code and no reward.
  v_code := public.create_redeem_code(s1, down, bagel, 'points', 120);
  begin
    perform public.redeem_by_code(v_code, down);
    raise notice 'FAIL short: a 350 redemption succeeded against a 300 purse';
  exception when others then
    if sqlerrm like '%INSUFFICIENT_POINTS%' then
      raise notice 'PASS short: a redemption bigger than the shared purse is refused';
    else
      raise notice 'FAIL short: expected INSUFFICIENT_POINTS, got %', sqlerrm;
    end if;
  end;
  select count(*) into n from public.redeem_codes rc where rc.code = v_code;
  if n = 1 then raise notice 'PASS short: the refused code is still live after the rollback';
  else raise notice 'FAIL short: the code was consumed by a failed redemption'; end if;
  select balance into bal from public.pool_balances where user_id = s1 and pool_id = pool;
  if bal = 300 then raise notice 'PASS short: the purse is untouched at 300';
  else raise notice 'FAIL short: purse is % after a refused redemption', bal; end if;

  -- ---------- 4. one live POINTS code per pool, per currency ----------
  -- The Downtown code above is still live. Minting a POINTS code at Campus must
  -- kill it: both draw on one purse, and two live codes at two tills is exactly
  -- the hazard the single-code rule exists to prevent.
  v_code2 := public.create_redeem_code(s1, campus, coffee, 'points', 120);
  select count(*) into n from public.redeem_codes rc where rc.code = v_code;
  if n = 0 then raise notice 'PASS codes: minting at a sibling retired the pool''s other points code';
  else raise notice 'FAIL codes: two live points codes exist across one purse'; end if;

  -- ... but a VISITS code is backed by that location's own counter, which is
  -- not shared, so it must survive a points code minted next door.
  v_code := public.create_redeem_code(s1, campus, drink, 'visits', 120);
  v_code2 := public.create_redeem_code(s1, down, bagel, 'points', 120);
  select count(*) into n from public.redeem_codes rc where rc.code = v_code;
  if n = 1 then raise notice 'PASS codes: a visits code survives a points code at a sibling';
  else raise notice 'FAIL codes: minting a points code cancelled a visits code'; end if;

  -- ---------- 5. the visits branch reports the POOLED points balance ----------
  -- A visits redemption spends no points, but the terminal prints the points
  -- balance beside it. Reading point_balances would print 0 for a customer
  -- whose money is all in the pool.
  select * into r from public.redeem_by_code(v_code, campus);
  if r.paid_with = 'visits' then raise notice 'PASS visits: the visits branch still runs';
  else raise notice 'FAIL visits: paid_with came back %', r.paid_with; end if;
  if r.new_balance = 300 then raise notice 'PASS visits: it reported the pooled 300, not 0';
  else raise notice 'FAIL visits: reported balance %, expected the pooled 300', r.new_balance; end if;
  select punches into n from public.punch_cards where user_id = s1 and vendor_id = campus;
  if n = 0 then raise notice 'PASS visits: the counter reset, and stayed per-location';
  else raise notice 'FAIL visits: punches are % after a burn', n; end if;

  -- ---------- 6. the unpooled control is untouched ----------
  v_code := public.create_redeem_code(s2, solo, salad, 'points', 120);
  select * into r from public.redeem_by_code(v_code, solo);
  if r.new_balance = 200 then raise notice 'PASS control: an unpooled redemption behaves exactly as before';
  else raise notice 'FAIL control: unpooled balance came back %, expected 200', r.new_balance; end if;
  select balance into bal from public.point_balances where user_id = s2 and vendor_id = solo;
  if bal = 200 then raise notice 'PASS control: it moved the vendor''s own row, not a pool';
  else raise notice 'FAIL control: point_balances is %, expected 200', bal; end if;
  perform public.award_points(s2, solo, 50, 5, null);
  select balance into bal from public.point_balances where user_id = s2 and vendor_id = solo;
  if bal = 250 then raise notice 'PASS control: an unpooled award still credits point_balances';
  else raise notice 'FAIL control: unpooled award left %, expected 250', bal; end if;
end $$;

do $$
declare
  s1     uuid := '00000000-0000-0000-0000-000000000451';
  s3     uuid := '00000000-0000-0000-0000-000000000453';
  down   uuid := '00000000-0000-0000-0000-0000000005a1';
  campus uuid := '00000000-0000-0000-0000-0000000005a2';
  pool   uuid := '00000000-0000-0000-0000-0000000005f1';
  coffee uuid := '00000000-0000-0000-0000-0000000005c2';
  tx     uuid;
  v_code  text;
  r      record;
  n      integer;
  bal    integer;
begin
  -- ---------- 7. undo, when the points are still there ----------
  perform public.award_points(s1, down, 60, 6, null);
  select id into tx from public.transactions
   where user_id = s1 and vendor_id = down and type = 'earn' and points = 60
   order by created_at desc limit 1;

  select * into r from public.reverse_transaction(tx, down);
  if r.new_balance = 300 then raise notice 'PASS undo: an award undone at a pooled location takes the points back out of the purse';
  else raise notice 'FAIL undo: purse came back %, expected 300', r.new_balance; end if;

  -- ---------- 8. undo, when a sibling already spent them ----------
  -- THE case the clamp used to hide. Award 100 at Downtown, spend it all at
  -- Campus, then try to undo the award: the money is gone, and taking back
  -- "what we can" would silently write off the difference. It must refuse.
  perform public.award_points(s1, down, 100, 10, null);
  select id into tx from public.transactions
   where user_id = s1 and vendor_id = down and type = 'earn' and points = 100
   order by created_at desc limit 1;

  select balance into bal from public.pool_balances where user_id = s1 and pool_id = pool;
  -- Drain the purse at the SIBLING, the way a customer walking next door would.
  update public.pool_balances set balance = 50 where user_id = s1 and pool_id = pool;

  begin
    perform public.reverse_transaction(tx, down);
    raise notice 'FAIL overspent: an undo silently clamped instead of refusing';
  exception when others then
    if sqlerrm like '%REVERSAL_OVERSPENT%' then
      raise notice 'PASS overspent: an undo whose points are already spent is refused';
    else
      raise notice 'FAIL overspent: expected REVERSAL_OVERSPENT, got %', sqlerrm;
    end if;
  end;

  select reversed_by into tx from public.transactions where id = tx;
  if tx is null then raise notice 'PASS overspent: the original transaction is NOT marked reversed';
  else raise notice 'FAIL overspent: the transaction was marked reversed by a failed undo'; end if;

  select balance into bal from public.pool_balances where user_id = s1 and pool_id = pool;
  if bal = 50 then raise notice 'PASS overspent: the purse was left exactly as it was';
  else raise notice 'FAIL overspent: purse is % after a refused undo, expected 50', bal; end if;

  -- Undoing a REDEMPTION only ever adds, so it is unaffected by the new guard.
  update public.pool_balances set balance = 400 where user_id = s1 and pool_id = pool;
  v_code := public.create_redeem_code(s1, campus, coffee, 'points', 120);
  perform public.redeem_by_code(v_code, campus);
  select id into tx from public.transactions
   where user_id = s1 and vendor_id = campus and type = 'redeem' and points = -300
   order by created_at desc limit 1;
  select * into r from public.reverse_transaction(tx, campus);
  if r.new_balance = 400 then raise notice 'PASS undo: undoing a redemption puts the points back in the purse';
  else raise notice 'FAIL undo: purse came back % after undoing a redemption, expected 400', r.new_balance; end if;

  -- ---------- 8b. undo expires after one minute ----------
  -- THE ONLY PLACE THIS RULE IS ACTUALLY TESTED. The JS suite cannot reach it:
  -- ageing a row means a direct UPDATE on `transactions`, and migration-025's
  -- guard refuses any that does not announce itself with app.points_write —
  -- which PostgREST has no way to set. test/integration/money.test.js used to
  -- try anyway, ignore the refusal, and assert against a row that was still
  -- fresh. Here the GUC is set at the top of this file, so the row can be aged
  -- honestly.
  --
  -- It matters because the window is the whole anti-abuse story for undo: a
  -- cashier can void their own mistake, and cannot quietly claw a customer's
  -- points back an hour after they walked out.
  update public.pool_balances set balance = 400 where user_id = s1 and pool_id = pool;
  perform public.award_points(s1, down, 30, 3, null);
  select id into tx from public.transactions
   where user_id = s1 and vendor_id = down and type = 'earn' and points = 30
   order by created_at desc limit 1;

  update public.transactions set created_at = now() - interval '2 minutes' where id = tx;

  begin
    perform public.reverse_transaction(tx, down);
    raise notice 'FAIL expiry: a two-minute-old transaction was still undoable';
  exception when others then
    if sqlerrm like '%REVERSAL_EXPIRED%' then
      raise notice 'PASS expiry: an undo past the one-minute window is refused';
    else
      raise notice 'FAIL expiry: expected REVERSAL_EXPIRED, got %', sqlerrm;
    end if;
  end;

  select reversed_by into tx from public.transactions where id = tx;
  if tx is null then raise notice 'PASS expiry: the expired transaction is NOT marked reversed';
  else raise notice 'FAIL expiry: an expired undo still marked the row reversed'; end if;

  -- ---------- 9. the 'close' audience finds pooled customers, once ----------
  -- Campus sells a 300-point coffee, so 'close' wants 150 <= balance < 300.
  update public.pool_balances set balance = 200 where user_id = s1 and pool_id = pool;
  select count(*) into n from public.campaign_audience(campus, 'close', 100) a where a.user_id = s1;
  if n = 1 then raise notice 'PASS audience: a pooled customer who has been here is in range';
  else raise notice 'FAIL audience: the pooled customer was not found (deals would send to nobody)'; end if;

  -- S3 holds 200 in the same purse and is in the same range, but has never
  -- transacted at Campus. Without the gate, every sibling's customers become
  -- every member's audience and one person gets three pushes for one business.
  select count(*) into n from public.campaign_audience(campus, 'close', 100) a where a.user_id = s3;
  if n = 0 then raise notice 'PASS audience: a pooled customer who has never been HERE is excluded';
  else raise notice 'FAIL audience: a customer with no history at this location was targeted'; end if;
end $$;
