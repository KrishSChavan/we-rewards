-- Assertions for migration-039 (incentives, community_grants, referrals).
--
-- Block 1 runs FIRST and in its own transaction, on purpose: app.points_write
-- is transaction-local, so probing the migration-025 guard after calling an RPC
-- would test a transaction that has already unlocked the table and fake a pass.
-- Same structure as behavior-038.

-- ---- block 1: the points guard covers the new payout path too ----
do $$
declare r uuid := '00000000-0000-0000-0000-000000000391';
begin
  begin
    insert into public.community_balances (user_id, balance, lifetime_earned)
    values (r, 999, 999);
    raise notice 'FAIL guard: direct community_balances insert was allowed';
  exception when others then
    raise notice 'PASS guard: direct community_balances insert still blocked';
  end;
end $$;

-- ---- block 2: referral codes ----
do $$
declare
  r  uuid := '00000000-0000-0000-0000-000000000391';
  n  integer;
  v_code  text;
  v_after text;
begin
  -- Backfill filled every pre-existing profile...
  select count(*) into n from public.profiles where referral_code is null;
  if n = 0 then raise notice 'PASS codes: backfill left no profile without a code';
  else raise notice 'FAIL codes: % profiles still have no referral code', n; end if;

  -- ...with distinct codes of the documented shape.
  select count(*) into n from public.profiles
   where referral_code !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$';
  if n = 0 then raise notice 'PASS codes: every code is 6 chars of the unambiguous alphabet';
  else raise notice 'FAIL codes: % codes are malformed', n; end if;

  select count(*) - count(distinct referral_code) into n from public.profiles;
  if n = 0 then raise notice 'PASS codes: all backfilled codes are distinct';
  else raise notice 'FAIL codes: % duplicate codes', n; end if;

  -- A NEW student gets one automatically (the insert trigger).
  insert into auth.users (id, email) values
    ('00000000-0000-0000-0000-0000000003a1', 'new-039@example.com');
  insert into public.profiles (user_id, email, name) values
    ('00000000-0000-0000-0000-0000000003a1', 'new-039@example.com', 'NEW');
  select referral_code into v_code from public.profiles
   where user_id = '00000000-0000-0000-0000-0000000003a1';
  if v_code is not null then raise notice 'PASS codes: a new signup is assigned a code on insert';
  else raise notice 'FAIL codes: new signup got no code'; end if;

  -- And it is immutable, because students can UPDATE their own profiles row.
  select referral_code into v_code from public.profiles where user_id = r;
  update public.profiles set referral_code = 'ZZZZZZ' where user_id = r;
  select referral_code into v_after from public.profiles where user_id = r;
  if v_after = v_code then raise notice 'PASS codes: referral_code is pinned against a direct update';
  else raise notice 'FAIL codes: code changed from % to %', v_code, v_after; end if;

  -- A name change on the same row still works (the pin must not block it).
  update public.profiles set name = 'R renamed' where user_id = r;
  select referral_code into v_after from public.profiles where user_id = r;
  if v_after = v_code then raise notice 'PASS codes: an unrelated profile update still succeeds';
  else raise notice 'FAIL codes: unrelated update disturbed the code'; end if;
end $$;

-- ---- block 3: grant_community_points ----
do $$
declare
  r    uuid := '00000000-0000-0000-0000-000000000391';
  f1   uuid := '00000000-0000-0000-0000-000000000392';
  inc  uuid;
  v_bal integer; v_grant uuid; n integer; v_spent integer;
  fake uuid := '00000000-0000-0000-0000-0000000000ff';
  ref  uuid := '00000000-0000-0000-0000-0000000009a1';
begin
  -- happy path
  select g.new_balance, g.grant_id into v_bal, v_grant
    from public.grant_community_points(r, 250, 'manual', 'welcome comp', null, null, 'ops@example.com') g;
  if v_bal = 250 and v_grant is not null then raise notice 'PASS grant: 250 credited, ledger row written';
  else raise notice 'FAIL grant: balance % grant %', v_bal, v_grant; end if;

  -- lifetime_earned rises with balance: a grant IS points the student was given
  select lifetime_earned into n from public.community_balances where user_id = r;
  if n = 250 then raise notice 'PASS grant: lifetime_earned tracks the grant';
  else raise notice 'FAIL grant: lifetime_earned % (wanted 250)', n; end if;

  -- a second grant accumulates rather than replacing
  select g.new_balance into v_bal from public.grant_community_points(r, 50, 'manual', null, null, null, 'ops@example.com') g;
  if v_bal = 300 then raise notice 'PASS grant: a second grant accumulates to 300';
  else raise notice 'FAIL grant: balance % (wanted 300)', v_bal; end if;

  -- rejections
  begin
    perform public.grant_community_points(r, 0, 'manual');
    raise notice 'FAIL grant: zero points was accepted';
  exception when others then
    if sqlerrm like '%GRANT_POINTS_INVALID%' then raise notice 'PASS grant: zero points rejected';
    else raise notice 'FAIL grant: zero points gave %', sqlerrm; end if;
  end;

  begin
    perform public.grant_community_points(r, 100001, 'manual');
    raise notice 'FAIL grant: an absurd grant was accepted';
  exception when others then
    if sqlerrm like '%GRANT_POINTS_INVALID%' then raise notice 'PASS grant: over-ceiling grant rejected (typo stop)';
    else raise notice 'FAIL grant: over-ceiling gave %', sqlerrm; end if;
  end;

  begin
    perform public.grant_community_points(fake, 10, 'manual');
    raise notice 'FAIL grant: unknown student was accepted';
  exception when others then
    if sqlerrm like '%GRANT_STUDENT_UNKNOWN%' then raise notice 'PASS grant: unknown student rejected';
    else raise notice 'FAIL grant: unknown student gave %', sqlerrm; end if;
  end;

  -- idempotency on (ref_id, kind)
  perform public.grant_community_points(f1, 40, 'referral_friend', 'signup bonus', null, ref, 'system');
  begin
    perform public.grant_community_points(f1, 40, 'referral_friend', 'signup bonus', null, ref, 'system');
    raise notice 'FAIL grant: the same ref_id paid twice';
  exception when others then
    if sqlerrm like '%GRANT_ALREADY_PAID%' then raise notice 'PASS grant: a repeat ref_id is refused';
    else raise notice 'FAIL grant: repeat ref_id gave %', sqlerrm; end if;
  end;
  select balance into n from public.community_balances where user_id = f1;
  if n = 40 then raise notice 'PASS grant: the refused repeat moved no points';
  else raise notice 'FAIL grant: balance % after a refused repeat (wanted 40)', n; end if;

  -- the SAME ref_id under a DIFFERENT kind is a different payout and must pass
  perform public.grant_community_points(r, 10, 'referral_referrer', null, null, ref, 'system');
  raise notice 'PASS grant: same ref_id, different kind, is a separate payout';

  -- budget: 100-point deal, 60 then 60
  insert into public.incentives (kind, name, budget_points, config, active)
  values ('referral', 'Budget test', 100, '{}'::jsonb, false)
  returning id into inc;

  perform public.grant_community_points(f1, 60, 'manual', 'first', inc, null, 'ops@example.com');
  begin
    perform public.grant_community_points(f1, 60, 'manual', 'second', inc, null, 'ops@example.com');
    raise notice 'FAIL budget: a grant past the budget was accepted';
  exception when others then
    if sqlerrm like '%GRANT_BUDGET_EXHAUSTED%' then raise notice 'PASS budget: the over-budget grant was refused';
    else raise notice 'FAIL budget: over-budget gave %', sqlerrm; end if;
  end;

  select spent_points into v_spent from public.incentives where id = inc;
  if v_spent = 60 then raise notice 'PASS budget: spent_points stayed at 60 after the refusal';
  else raise notice 'FAIL budget: spent_points % (wanted 60)', v_spent; end if;

  -- a grant that fits exactly is allowed
  perform public.grant_community_points(f1, 40, 'manual', 'exact fit', inc, null, 'ops@example.com');
  select spent_points into v_spent from public.incentives where id = inc;
  if v_spent = 100 then raise notice 'PASS budget: a grant that exactly fills the budget is allowed';
  else raise notice 'FAIL budget: spent_points % (wanted 100)', v_spent; end if;
end $$;

-- ---- block 4: one active incentive per kind ----
do $$
begin
  insert into public.incentives (kind, name, config, active)
  values ('referral', 'Live program', '{"referrerPoints":100}'::jsonb, true);
  begin
    insert into public.incentives (kind, name, config, active)
    values ('referral', 'Second live program', '{}'::jsonb, true);
    raise notice 'FAIL one-per-kind: a second ACTIVE referral program was allowed';
  exception when unique_violation then
    raise notice 'PASS one-per-kind: a second ACTIVE referral program is refused';
  end;

  -- an INACTIVE one alongside it is fine (that is how you draft the next deal)
  insert into public.incentives (kind, name, config, active)
  values ('referral', 'Draft program', '{}'::jsonb, false);
  raise notice 'PASS one-per-kind: an inactive program can coexist';
end $$;

-- ---- block 5: referrals + settle_referrals ----
do $$
declare
  r   uuid := '00000000-0000-0000-0000-000000000391';
  f1  uuid := '00000000-0000-0000-0000-000000000392';
  f2  uuid := '00000000-0000-0000-0000-000000000393';
  f3  uuid := '00000000-0000-0000-0000-000000000394';
  inc uuid;
  poor uuid;
  v_vendor uuid;
  v_ref1 uuid; v_ref2 uuid; v_ref3 uuid;
  v_settled integer; v_skipped integer;
  v_bal_before integer; v_bal_after integer;
  v_status text; v_qualified timestamptz;
  n integer;
begin
  select id into inc from public.incentives where name = 'Live program';
  select id into v_vendor from public.vendors where slug = 'incentive-cafe-039';
  select balance into v_bal_before from public.community_balances where user_id = r;

  insert into public.referrals (referrer_id, friend_id, incentive_id, code, friend_points, referrer_points)
  values (r, f1, inc, 'ABC234', 50, 100) returning id into v_ref1;
  insert into public.referrals (referrer_id, friend_id, incentive_id, code, friend_points, referrer_points)
  values (r, f2, inc, 'ABC234', 50, 100) returning id into v_ref2;

  -- a student can be referred ONCE, ever
  begin
    insert into public.referrals (referrer_id, friend_id, incentive_id, code, friend_points, referrer_points)
    values (r, f1, inc, 'ABC234', 50, 100);
    raise notice 'FAIL referrals: the same friend was referred twice';
  exception when unique_violation then
    raise notice 'PASS referrals: a second referral for the same friend is refused';
  end;

  -- nobody has purchased yet → the sweeper pays nothing
  select s.settled, s.skipped into v_settled, v_skipped from public.settle_referrals(50) s;
  if v_settled = 0 then raise notice 'PASS settle: no purchase, no payout';
  else raise notice 'FAIL settle: settled % with no purchases', v_settled; end if;

  -- F1 earns at a vendor → their referrer qualifies
  perform public.award_points(f1, v_vendor, 120, 12.00, 'tok-039-1');
  select s.settled, s.skipped into v_settled, v_skipped from public.settle_referrals(50) s;
  if v_settled = 1 and v_skipped = 0 then raise notice 'PASS settle: F1''s purchase settled exactly one referral';
  else raise notice 'FAIL settle: settled % skipped % (wanted 1/0)', v_settled, v_skipped; end if;

  select balance into v_bal_after from public.community_balances where user_id = r;
  if v_bal_after = v_bal_before + 100 then raise notice 'PASS settle: the referrer was credited 100';
  else raise notice 'FAIL settle: referrer % -> % (wanted +100)', v_bal_before, v_bal_after; end if;

  select status, qualified_at into v_status, v_qualified from public.referrals where id = v_ref1;
  if v_status = 'paid' and v_qualified is not null then raise notice 'PASS settle: the row is paid and stamped';
  else raise notice 'FAIL settle: status % qualified_at %', v_status, v_qualified; end if;

  -- F2 still hasn't purchased, so their row is untouched
  select status into v_status from public.referrals where id = v_ref2;
  if v_status = 'pending' then raise notice 'PASS settle: the un-purchased referral is still pending';
  else raise notice 'FAIL settle: F2''s referral is %', v_status; end if;

  -- running the sweeper again must not pay twice
  select s.settled into v_settled from public.settle_referrals(50) s;
  select balance into v_bal_after from public.community_balances where user_id = r;
  if v_settled = 0 and v_bal_after = v_bal_before + 100 then
    raise notice 'PASS settle: a second sweep is a no-op (no double payment)';
  else raise notice 'FAIL settle: second sweep settled %, balance %', v_settled, v_bal_after; end if;

  select count(*) into n from public.community_grants
   where ref_id = v_ref1 and kind = 'referral_referrer';
  if n = 1 then raise notice 'PASS settle: exactly one ledger row for the payout';
  else raise notice 'FAIL settle: % ledger rows for one payout', n; end if;

  -- an exhausted budget qualifies the referral but does not pay it, and leaves
  -- it pending so raising the budget lets the next tick through
  insert into public.incentives (kind, name, budget_points, config, active)
  values ('referral', 'Broke program', 10, '{}'::jsonb, false) returning id into poor;
  insert into public.referrals (referrer_id, friend_id, incentive_id, code, friend_points, referrer_points)
  values (r, f3, poor, 'ABC234', 0, 500) returning id into v_ref3;
  perform public.award_points(f3, v_vendor, 50, 5.00, 'tok-039-3');

  select balance into v_bal_before from public.community_balances where user_id = r;
  select s.settled, s.skipped into v_settled, v_skipped from public.settle_referrals(50) s;
  select status, qualified_at into v_status, v_qualified from public.referrals where id = v_ref3;
  select balance into v_bal_after from public.community_balances where user_id = r;

  if v_skipped = 1 and v_status = 'pending' and v_qualified is not null and v_bal_after = v_bal_before then
    raise notice 'PASS settle: an over-budget referral qualifies, stays pending, and pays nothing';
  else
    raise notice 'FAIL settle: skipped % status % qualified % balance % -> %',
      v_skipped, v_status, v_qualified, v_bal_before, v_bal_after;
  end if;

  -- raise the budget and the SAME row goes through on the next tick
  update public.incentives set budget_points = 1000 where id = poor;
  select s.settled into v_settled from public.settle_referrals(50) s;
  select status into v_status from public.referrals where id = v_ref3;
  select balance into v_bal_after from public.community_balances where user_id = r;
  if v_settled = 1 and v_status = 'paid' and v_bal_after = v_bal_before + 500 then
    raise notice 'PASS settle: raising the budget releases the waiting referral';
  else raise notice 'FAIL settle: settled % status % balance %', v_settled, v_status, v_bal_after; end if;
end $$;

-- ---- block 6: settle_friend_bonuses does not starve ----
-- The bug this pins: doing the "already paid?" filter in the application
-- (fetch the oldest N referrals, then drop the paid ones) means a window full
-- of old PAID referrals never reaches a newer OWED one. Here the limit is 2 and
-- the two oldest rows are already paid, so a naive implementation pays nothing.
do $$
declare
  r    uuid := '00000000-0000-0000-0000-000000000391';
  inc  uuid;
  i    integer;
  u    uuid;
  owed uuid;
  v_paid integer;
  n    integer;
begin
  select id into inc from public.incentives where name = 'Live program';

  -- Isolate this block from the ones above: lift every budget (so nothing is
  -- refused for the wrong reason) and drain the bonuses earlier blocks left
  -- owed, so the counts below are only about the rows created here.
  update public.incentives set budget_points = null;
  perform public.settle_friend_bonuses(500);

  -- two OLD referrals whose friend bonus is already paid
  for i in 1..2 loop
    u := ('00000000-0000-0000-0000-0000000004' || lpad(i::text, 2, '0'))::uuid;
    insert into auth.users (id, email) values (u, 'starve' || i || '@example.com');
    insert into public.profiles (user_id, email, name) values (u, 'starve' || i || '@example.com', 'S');
    insert into public.referrals (referrer_id, friend_id, incentive_id, code, friend_points, referrer_points, created_at)
    values (r, u, inc, 'ABC234', 50, 0, now() - interval '10 days')
    returning id into owed;
    perform public.grant_community_points(u, 50, 'referral_friend', 'paid', inc, owed, 'system');
  end loop;

  -- one NEW referral whose bonus was never paid
  u := '00000000-0000-0000-0000-000000000499';
  insert into auth.users (id, email) values (u, 'starve-owed@example.com');
  insert into public.profiles (user_id, email, name) values (u, 'starve-owed@example.com', 'S');
  insert into public.referrals (referrer_id, friend_id, incentive_id, code, friend_points, referrer_points)
  values (r, u, inc, 'ABC234', 50, 0);

  -- a limit of 2 must still find the owed one, because the query excludes the
  -- two paid rows rather than fetching and discarding them
  select s.paid into v_paid from public.settle_friend_bonuses(2) s;
  select balance into n from public.community_balances where user_id = u;
  if v_paid = 1 and n = 50 then
    raise notice 'PASS friend sweep: an owed bonus behind two paid ones is still found';
  else
    raise notice 'FAIL friend sweep: paid % balance % (wanted 1 / 50)', v_paid, n;
  end if;

  -- and it is not paid a second time
  select s.paid into v_paid from public.settle_friend_bonuses(50) s;
  select balance into n from public.community_balances where user_id = u;
  if v_paid = 0 and n = 50 then
    raise notice 'PASS friend sweep: a second pass pays nothing more';
  else
    raise notice 'FAIL friend sweep: second pass paid % balance %', v_paid, n;
  end if;
end $$;

-- ---- block 7: grants survive the student, balances do not ----
do $$
declare
  f2 uuid := '00000000-0000-0000-0000-000000000393';
  n integer;
begin
  perform public.grant_community_points(f2, 25, 'manual', 'about to be deleted', null, null, 'ops@example.com');
  delete from auth.users where id = f2;

  select count(*) into n from public.community_balances where user_id = f2;
  if n = 0 then raise notice 'PASS delete: the balance went with the account';
  else raise notice 'FAIL delete: % balance rows survived', n; end if;

  select count(*) into n from public.community_grants where user_id is null and points = 25;
  if n = 1 then raise notice 'PASS delete: the ledger row survived with no user attached';
  else raise notice 'FAIL delete: % orphaned ledger rows (wanted 1)', n; end if;
end $$;
