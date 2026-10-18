-- Assertions for migration-067 (free items).
--
-- Block 2 is the regression this migration had to fix on its way past: a
-- student with NO purse row redeeming a free item. 045's debit matches zero
-- rows for them and answers INSUFFICIENT_POINTS.
select set_config('app.points_write', 'server', false);

-- ---------- 1. what the schema now accepts, and still refuses ----------
do $$
declare
  v1 uuid := '00000000-0000-0000-0000-0000000067a1';
  ok boolean;
begin
  begin
    insert into public.rewards (id, vendor_id, title, cost_in_points, cost_in_visits, once_per_student)
    values ('00000000-0000-0000-0000-0000000067d1', v1, 'Free water', 0, null, false);
    raise notice 'PASS schema: a 0-point item is accepted';
  exception when others then
    raise notice 'FAIL schema: a 0-point item was refused: %', sqlerrm;
  end;

  begin
    insert into public.rewards (id, vendor_id, title, cost_in_points, cost_in_visits, once_per_student)
    values ('00000000-0000-0000-0000-0000000067d2', v1, 'Welcome cookie', 0, null, true);
    raise notice 'PASS schema: a once-only free item is accepted';
  exception when others then
    raise notice 'FAIL schema: a once-only free item was refused: %', sqlerrm;
  end;

  ok := false;
  begin
    insert into public.rewards (vendor_id, title, cost_in_points) values (v1, 'Negative', -1);
  exception when check_violation then ok := true;
  end;
  if ok then raise notice 'PASS schema: a negative point price is still refused';
  else raise notice 'FAIL schema: a negative point price was accepted'; end if;

  ok := false;
  begin
    insert into public.rewards (vendor_id, title, cost_in_points, cost_in_visits) values (v1, 'Neither', null, null);
  exception when check_violation then ok := true;
  end;
  if ok then raise notice 'PASS schema: an item with no price at all is still refused';
  else raise notice 'FAIL schema: an item with no price was accepted'; end if;

  ok := false;
  begin
    insert into public.rewards (vendor_id, title, cost_in_points, cost_in_visits) values (v1, 'Free or visits', 0, 5);
  exception when check_violation then ok := true;
  end;
  if ok then raise notice 'PASS schema: a free item cannot also carry a visit price';
  else raise notice 'FAIL schema: a free item with a visit price was accepted'; end if;

  ok := false;
  begin
    insert into public.rewards (vendor_id, title, cost_in_points, once_per_student) values (v1, 'Priced once', 50, true);
  exception when check_violation then ok := true;
  end;
  if ok then raise notice 'PASS schema: only a free item can be once-only';
  else raise notice 'FAIL schema: a priced item was allowed to be once-only'; end if;

  ok := false;
  begin
    update public.rewards set cost_in_points = 10 where id = '00000000-0000-0000-0000-0000000067d2';
  exception when check_violation then ok := true;
  end;
  if ok then raise notice 'PASS schema: pricing a once-only item without clearing the flag is refused';
  else raise notice 'FAIL schema: a once-only item was given a price with the flag still set'; end if;

  begin
    insert into public.rewards (vendor_id, title, cost_in_points, cost_in_visits) values (v1, 'Visits only', null, 4);
    insert into public.rewards (vendor_id, title, cost_in_points, cost_in_visits) values (v1, 'Both', 30, 4);
    raise notice 'PASS schema: visits-only and dual-priced items still work';
  exception when others then
    raise notice 'FAIL schema: an existing kind of item was refused: %', sqlerrm;
  end;
end $$;

-- ---------- 2. THE REGRESSION: free item, student with no purse row ----------
do $$
declare
  s1    uuid := '00000000-0000-0000-0000-000000000671';
  v1    uuid := '00000000-0000-0000-0000-0000000067a1';
  water uuid := '00000000-0000-0000-0000-0000000067d1';
  v_code text;
  r      record;
  n      integer;
begin
  select count(*) into n from public.point_balances where user_id = s1;
  if n = 0 then raise notice 'PASS setup: S1 has no purse row anywhere';
  else raise notice 'FAIL setup: S1 has a purse row, the regression cannot be tested'; end if;

  v_code := public.create_redeem_code(s1, v1, water, 'points', 120);
  begin
    select * into r from public.redeem_by_code(v_code, v1);
    if r.new_balance = 0 and r.reward_title = 'Free water' and r.paid_with = 'points' then
      raise notice 'PASS free: S1 redeemed a free item with no purse row, balance 0';
    else
      raise notice 'FAIL free: unexpected result %', r;
    end if;
  exception when others then
    raise notice 'FAIL free: redeeming a free item with no purse row raised %', sqlerrm;
  end;

  select count(*) into n from public.point_balances where user_id = s1;
  if n = 0 then raise notice 'PASS free: no purse row was created';
  else raise notice 'FAIL free: a free redemption created a purse row'; end if;

  select count(*) into n from public.transactions
   where user_id = s1 and reward_id = water and type = 'redeem' and points = 0 and paid_with = 'points';
  if n = 1 then raise notice 'PASS ledger: the free redemption is one 0-point redeem row';
  else raise notice 'FAIL ledger: expected 1 free redeem row, found %', n; end if;

  -- An every-visit free item can be had again.
  v_code := public.create_redeem_code(s1, v1, water, 'points', 120);
  select * into r from public.redeem_by_code(v_code, v1);
  select count(*) into n from public.transactions
   where user_id = s1 and reward_id = water and type = 'redeem';
  if n = 2 then raise notice 'PASS free: an every-visit free item redeems a second time';
  else raise notice 'FAIL free: expected 2 redemptions, found %', n; end if;
end $$;

-- ---------- 3. a free item leaves a real balance alone; priced is unchanged ----------
do $$
declare
  s2     uuid := '00000000-0000-0000-0000-000000000672';
  v1     uuid := '00000000-0000-0000-0000-0000000067a1';
  water  uuid := '00000000-0000-0000-0000-0000000067d1';
  coffee uuid := '00000000-0000-0000-0000-0000000067c1';
  v_code text;
  r      record;
  bal    integer;
begin
  v_code := public.create_redeem_code(s2, v1, water, 'points', 120);
  select * into r from public.redeem_by_code(v_code, v1);
  select balance into bal from public.point_balances where user_id = s2 and vendor_id = v1;
  if r.new_balance = 100 and bal = 100 then raise notice 'PASS free: S2 still holds 100 after a free item';
  else raise notice 'FAIL free: S2 reported %, row holds %, expected 100', r.new_balance, bal; end if;

  v_code := public.create_redeem_code(s2, v1, coffee, 'points', 120);
  select * into r from public.redeem_by_code(v_code, v1);
  if r.new_balance = 50 then raise notice 'PASS priced: a 50-point item still debits 50';
  else raise notice 'FAIL priced: expected 50 left, got %', r.new_balance; end if;
end $$;

-- ---------- 4. once-only: one redemption, then refused ----------
do $$
declare
  s1     uuid := '00000000-0000-0000-0000-000000000671';
  v1     uuid := '00000000-0000-0000-0000-0000000067a1';
  cookie uuid := '00000000-0000-0000-0000-0000000067d2';
  v_code text;
  r      record;
  ok     boolean;
begin
  v_code := public.create_redeem_code(s1, v1, cookie, 'points', 120);
  select * into r from public.redeem_by_code(v_code, v1);
  if r.reward_title = 'Welcome cookie' then raise notice 'PASS once: the first redemption goes through';
  else raise notice 'FAIL once: first redemption returned %', r; end if;

  ok := false;
  begin
    perform public.create_redeem_code(s1, v1, cookie, 'points', 120);
  exception when others then
    ok := sqlerrm = 'ONE_TIME_ITEM_USED';
  end;
  if ok then raise notice 'PASS once: a second code is refused with ONE_TIME_ITEM_USED';
  else raise notice 'FAIL once: a second code was minted (or the wrong error)'; end if;
end $$;

-- ---------- 5. once-only: the race, where two codes got minted ----------
-- Both mints passed create_redeem_code's check before either redeemed. Planted
-- directly, since the second real mint would delete the first code.
do $$
declare
  s2     uuid := '00000000-0000-0000-0000-000000000672';
  v1     uuid := '00000000-0000-0000-0000-0000000067a1';
  cookie uuid := '00000000-0000-0000-0000-0000000067d2';
  r      record;
  ok     boolean;
  n      integer;
begin
  insert into public.redeem_codes (code, user_id, vendor_id, reward_id, paid_with, expires_at) values
    ('6701', s2, v1, cookie, 'points', now() + interval '2 minutes');
  select * into r from public.redeem_by_code('6701', v1);

  insert into public.redeem_codes (code, user_id, vendor_id, reward_id, paid_with, expires_at) values
    ('6702', s2, v1, cookie, 'points', now() + interval '2 minutes');
  ok := false;
  begin
    perform public.redeem_by_code('6702', v1);
  exception when others then
    ok := sqlerrm = 'ONE_TIME_ITEM_USED';
  end;
  if ok then raise notice 'PASS once: the till refuses a second code minted in a race';
  else raise notice 'FAIL once: a second once-only redemption went through at the till'; end if;

  select count(*) into n from public.redeem_codes where code = '6702';
  if n = 1 then raise notice 'PASS once: the refused code was put back by the rollback, as for every refusal';
  else raise notice 'FAIL once: the refused code was consumed'; end if;
  delete from public.redeem_codes where code = '6702';

  select count(*) into n from public.transactions
   where user_id = s2 and reward_id = cookie and type = 'redeem';
  if n = 1 then raise notice 'PASS once: S2 has exactly one cookie on the ledger';
  else raise notice 'FAIL once: S2 has % cookie redemptions', n; end if;
end $$;

-- ---------- 6. once-only: an undo gives the item back ----------
do $$
declare
  s1     uuid := '00000000-0000-0000-0000-000000000671';
  v1     uuid := '00000000-0000-0000-0000-0000000067a1';
  cookie uuid := '00000000-0000-0000-0000-0000000067d2';
  tx     uuid;
  r      record;
  v_code text;
begin
  select id into tx from public.transactions
   where user_id = s1 and reward_id = cookie and type = 'redeem' and reverses is null;
  begin
    select * into r from public.reverse_transaction(tx, v1);
    raise notice 'PASS undo: a free redemption can be undone (balance %)', r.new_balance;
  exception when others then
    raise notice 'FAIL undo: undoing a free redemption raised %', sqlerrm;
  end;

  begin
    v_code := public.create_redeem_code(s1, v1, cookie, 'points', 120);
    perform public.redeem_by_code(v_code, v1);
    raise notice 'PASS undo: after the undo, the once-only item can be had again';
  exception when others then
    raise notice 'FAIL undo: still refused after the undo: %', sqlerrm;
  end;
end $$;

-- ---------- 7. pooled: a free item reports the POOL's balance, and leaves it ----------
do $$
declare
  s3     uuid := '00000000-0000-0000-0000-000000000673';
  down   uuid := '00000000-0000-0000-0000-0000000067a2';
  campus uuid := '00000000-0000-0000-0000-0000000067a3';
  pool   uuid := '00000000-0000-0000-0000-0000000067f1';
  treat  uuid := '00000000-0000-0000-0000-0000000067d3';
  v_code text;
  r      record;
  bal    integer;
  n      integer;
begin
  perform public.award_points(s3, down, 200, 20, null);
  insert into public.rewards (id, vendor_id, title, cost_in_points) values (treat, campus, 'Campus treat', 0);

  v_code := public.create_redeem_code(s3, campus, treat, 'points', 120);
  select * into r from public.redeem_by_code(v_code, campus);
  select balance into bal from public.pool_balances where user_id = s3 and pool_id = pool;
  if r.new_balance = 200 and bal = 200 then raise notice 'PASS pool: a free item shows the shared 200 and leaves it alone';
  else raise notice 'FAIL pool: reported %, pool holds %, expected 200', r.new_balance, bal; end if;

  select count(*) into n from public.point_balances where user_id = s3;
  if n = 0 then raise notice 'PASS pool: no per-location row appeared';
  else raise notice 'FAIL pool: a point_balances row was written for a pooled student'; end if;
end $$;
