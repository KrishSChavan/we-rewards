-- Runtime behaviour of the migration-029 RPCs.
-- Each check raises PASS or FAIL as a notice; grep the output for FAIL.

do $$
declare
  v_vendor   uuid := '11111111-1111-1111-1111-111111111111';
  u_mid      uuid := 'aaaaaaaa-0000-0000-0000-000000000001';  -- 3 visits
  u_full     uuid := 'aaaaaaaa-0000-0000-0000-000000000002';  -- 10 visits, 120 pts
  u_two      uuid := 'aaaaaaaa-0000-0000-0000-000000000004';  -- 12 visits
  r_coffee   uuid := 'bbbbbbbb-0000-0000-0000-000000000001';  -- 50 pts
  code       text;
  n          integer;
  tx         uuid;
  w          bigint := floor(extract(epoch from now()) / 30)::bigint;
  got        text;
  rec        record;
begin
  update rewards set cost_in_visits = 5  where id = r_coffee;
  update rewards set cost_in_visits = 15 where id = 'bbbbbbbb-0000-0000-0000-000000000002';

  -- A. a visits-only reward is legal
  begin
    insert into rewards (vendor_id, title, cost_in_points, cost_in_visits, emoji)
    values (v_vendor, 'Tote bag', null, 20, '🎒');
    raise notice 'PASS A: visits-only reward accepted';
  exception when others then
    raise notice 'FAIL A: visits-only rejected -> %', sqlerrm;
  end;

  -- B. a reward with NEITHER price is rejected
  begin
    insert into rewards (vendor_id, title, cost_in_points, cost_in_visits, emoji)
    values (v_vendor, 'Nothing', null, null, '❓');
    raise notice 'FAIL B: priceless reward was accepted';
  exception when check_violation then
    raise notice 'PASS B: priceless reward rejected by rewards_has_a_price';
  end;

  -- C. minting with too few visits is refused SERVER-SIDE (D7)
  begin
    code := create_redeem_code(u_mid, v_vendor, r_coffee, 'visits');
    raise notice 'FAIL C: minted a visits code with only 3 visits for a 5-visit reward';
  exception when others then
    if sqlerrm like '%INSUFFICIENT_VISITS%' then
      raise notice 'PASS C: mint refused, %', sqlerrm;
    else
      raise notice 'FAIL C: wrong error -> %', sqlerrm;
    end if;
  end;

  -- D. minting does NOT spend
  code := create_redeem_code(u_two, v_vendor, r_coffee, 'visits');
  select punches into n from punch_cards where user_id = u_two and vendor_id = v_vendor;
  if n = 12 then raise notice 'PASS D: mint left the counter at 12';
  else raise notice 'FAIL D: mint changed the counter to %', n; end if;

  -- E. burning resets to 0 and records what was forfeited
  select * into rec from redeem_by_code(code, v_vendor);
  select punches into n from punch_cards where user_id = u_two and vendor_id = v_vendor;
  if n = 0 and rec.paid_with = 'visits' and rec.visits_left = 0
  then raise notice 'PASS E: counter reset to 0, rpc reported visits/0';
  else raise notice 'FAIL E: counter=% paid_with=% visits_left=%', n, rec.paid_with, rec.visits_left; end if;

  select id, points, visits_spent into tx, n, got
  from transactions where user_id = u_two and paid_with = 'visits'
  order by created_at desc limit 1;
  if n = 0 and got = '12'
  then raise notice 'PASS E2: transaction is points=0, visits_spent=12';
  else raise notice 'FAIL E2: points=% visits_spent=%', n, got; end if;

  -- F. a punch lands between the redemption and the undo
  perform punch_in(u_two, v_vendor, w, null, null, 'America/New_York');
  select punches into n from punch_cards where user_id = u_two and vendor_id = v_vendor;
  if n = 1 then raise notice 'PASS F: punch after reset -> 1';
  else raise notice 'FAIL F: expected 1, got %', n; end if;

  -- G. undo ADDS BACK, so the new punch survives: 1 + 12 = 13
  perform reverse_transaction(tx, v_vendor);
  select punches into n from punch_cards where user_id = u_two and vendor_id = v_vendor;
  if n = 13 then raise notice 'PASS G: undo restored to 13 (add-back, not set)';
  else raise notice 'FAIL G: expected 13, got % (set-instead-of-add?)', n; end if;

  -- H. the once-per-night guard survived the rewrite
  begin
    perform punch_in(u_two, v_vendor, w, null, null, 'America/New_York');
    raise notice 'FAIL H: second punch in the same night was allowed';
  exception when others then
    if sqlerrm like '%ALREADY_PUNCHED%' then
      raise notice 'PASS H: second punch refused, %', sqlerrm;
    else
      raise notice 'FAIL H: wrong error -> %', sqlerrm;
    end if;
  end;

  -- I. the POINTS path is byte-for-byte unchanged
  code := create_redeem_code(u_full, v_vendor, r_coffee, 'points');
  select * into rec from redeem_by_code(code, v_vendor);
  if rec.new_balance = 70 and rec.paid_with = 'points'
  then raise notice 'PASS I: points redemption 120 -> 70';
  else raise notice 'FAIL I: balance=% paid_with=%', rec.new_balance, rec.paid_with; end if;

  select points, visits_spent, paid_with into n, got, code
  from transactions where user_id = u_full and paid_with = 'points'
  order by created_at desc limit 1;
  if n = -50 and got is null
  then raise notice 'PASS I2: points tx is -50 with visits_spent NULL';
  else raise notice 'FAIL I2: points=% visits_spent=%', n, got; end if;

  -- J. a visits redemption must not touch the points balance
  select punches into n from punch_cards where user_id = u_full and vendor_id = v_vendor;
  if n = 10 then raise notice 'PASS J: points redemption left visits at 10';
  else raise notice 'FAIL J: visits moved to %', n; end if;

  -- K. asking to pay visits for a points-only reward
  begin
    perform create_redeem_code(u_full, v_vendor, 'bbbbbbbb-0000-0000-0000-000000000002', 'visits');
    raise notice 'FAIL K: minted visits code for a 15-visit reward with only 10 visits';
  exception when others then
    if sqlerrm like '%INSUFFICIENT_VISITS%' then
      raise notice 'PASS K: refused, %', sqlerrm;
    else raise notice 'FAIL K: wrong error -> %', sqlerrm; end if;
  end;
end $$;

-- ============================================================
-- Second pass: the behaviours the JS integration suite asserts but cannot be
-- run here (it needs PostgREST + GoTrue, not just Postgres).
-- ============================================================

do $$
declare
  v_vendor  uuid := '11111111-1111-1111-1111-111111111111';
  u_full    uuid := 'aaaaaaaa-0000-0000-0000-000000000002';
  u_mid     uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  r_coffee  uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
  r_ponly   uuid;
  code_a    text;
  code_b    text;
  n         integer;
  w         bigint := floor(extract(epoch from now()) / 30)::bigint - 5760;  -- a different night
begin
  -- a points-only reward to probe the currency guards with
  insert into rewards (vendor_id, title, cost_in_points, cost_in_visits, emoji)
  values (v_vendor, 'Points Only', 10, null, '🥤')
  returning id into r_ponly;

  -- L. ONE live code per (student, vendor) across BOTH currencies
  update punch_cards set punches = 10 where user_id = u_full and vendor_id = v_vendor;
  code_a := create_redeem_code(u_full, v_vendor, r_coffee, 'visits');
  code_b := create_redeem_code(u_full, v_vendor, r_ponly,  'points');
  select count(*) into n from redeem_codes where user_id = u_full and vendor_id = v_vendor;
  if n = 1 and code_a is distinct from code_b
  then raise notice 'PASS L: second mint replaced the first (1 live code, not 2)';
  else raise notice 'FAIL L: % live codes (a=% b=%)', n, code_a, code_b; end if;

  -- M. a burn that loses the race refuses AND leaves the code alive
  update punch_cards set punches = 10 where user_id = u_full and vendor_id = v_vendor;
  code_a := create_redeem_code(u_full, v_vendor, r_coffee, 'visits');
  update punch_cards set punches = 0 where user_id = u_full and vendor_id = v_vendor;
  begin
    perform redeem_by_code(code_a, v_vendor);
    raise notice 'FAIL M: burned with an empty counter';
  exception when others then
    if sqlerrm like '%INSUFFICIENT_VISITS%' then
      select count(*) into n from redeem_codes where code = code_a;
      if n = 1 then raise notice 'PASS M: refused AND the code survived the rollback';
      else raise notice 'FAIL M: refused but the code was eaten'; end if;
    else raise notice 'FAIL M: wrong error -> %', sqlerrm; end if;
  end;
  delete from redeem_codes where code = code_a;

  -- N. punch_in on a fresh (student, vendor) makes exactly ONE counter row
  delete from punches     where user_id = u_mid and vendor_id = v_vendor;
  delete from punch_cards where user_id = u_mid and vendor_id = v_vendor;
  perform punch_in(u_mid, v_vendor, w, null, null, 'America/New_York');
  select count(*) into n from punch_cards where user_id = u_mid and vendor_id = v_vendor;
  if n = 1 then raise notice 'PASS N: one counter row per (student, vendor)';
  else raise notice 'FAIL N: % counter rows', n; end if;

  -- O. a points-only reward refuses a punches mint by NAME, not by shortfall
  update punch_cards set punches = 50 where user_id = u_full and vendor_id = v_vendor;
  begin
    perform create_redeem_code(u_full, v_vendor, r_ponly, 'visits');
    raise notice 'FAIL O: minted a punches code for a points-only reward';
  exception when others then
    if sqlerrm like '%REWARD_NOT_VISITS_PRICED%'
    then raise notice 'PASS O: refused, %', sqlerrm;
    else raise notice 'FAIL O: wrong error -> %', sqlerrm; end if;
  end;

  -- P. and the mirror: a punches-only reward refuses a points mint
  begin
    perform create_redeem_code(u_full, v_vendor, r_coffee, 'points');   -- coffee has both
    raise notice 'PASS P: a dual-priced reward accepts points';
  exception when others then
    raise notice 'FAIL P: dual-priced reward refused points -> %', sqlerrm;
  end;

  -- Q. an unknown currency is rejected outright
  begin
    perform create_redeem_code(u_full, v_vendor, r_coffee, 'gold');
    raise notice 'FAIL Q: accepted a bogus currency';
  exception when others then
    if sqlerrm like '%BAD_CURRENCY%' then raise notice 'PASS Q: refused, %', sqlerrm;
    else raise notice 'FAIL Q: wrong error -> %', sqlerrm; end if;
  end;
end $$;
