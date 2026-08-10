-- Assertions for migration-040 (the signup_domain incentive kind).
--
-- Small on purpose: 040 is one CHECK constraint. What is worth proving is that
-- the new kind slots into migration-039's machinery without any of it being
-- rebuilt — the one-active-per-kind index, the budget, and above all the
-- once-per-student idempotency that stops a TERMS_VERSION bump paying the whole
-- campus twice.

do $$
declare
  s1  uuid := '00000000-0000-0000-0000-000000000391';
  s2  uuid := '00000000-0000-0000-0000-000000000392';
  inc uuid;
  ref uuid;
  n   integer;
begin
  -- the new kind is accepted...
  insert into public.incentives (kind, name, config, active, starts_at)
  values ('signup_domain', 'PSU signup', '{"points":10,"domains":["psu.edu"]}'::jsonb, true, now())
  returning id into inc;
  raise notice 'PASS kind: signup_domain is a valid incentive kind';

  -- ...and an unknown one still is not
  begin
    insert into public.incentives (kind, name, config) values ('lottery', 'Nope', '{}'::jsonb);
    raise notice 'FAIL kind: an unknown kind was accepted';
  exception when check_violation then
    raise notice 'PASS kind: an unknown kind is still refused by the CHECK';
  end;

  -- a referral program can run AT THE SAME TIME: the index is per kind, so the
  -- two deals never compete for the one live slot
  insert into public.incentives (kind, name, config, active)
  values ('referral', 'Refer 040', '{}'::jsonb, true);
  raise notice 'PASS one-per-kind: a referral and a signup program can both be live';

  -- but two live signup programs cannot
  begin
    insert into public.incentives (kind, name, config, active, starts_at)
    values ('signup_domain', 'Second signup', '{}'::jsonb, true, now());
    raise notice 'FAIL one-per-kind: a second live signup program was allowed';
  exception when unique_violation then
    raise notice 'PASS one-per-kind: a second live signup program is refused';
  end;

  -- the payout rail from 039 works unchanged for this kind
  perform public.grant_community_points(s1, 10, 'signup_domain', 'Signup bonus (psu.edu)', inc, s1, 'system');
  select balance into n from public.community_balances where user_id = s1;
  if n = 10 then raise notice 'PASS payout: the signup bonus credited 10';
  else raise notice 'FAIL payout: balance % (wanted 10)', n; end if;

  -- THE important one: ref_id = the student, so a second attempt (a terms
  -- re-acceptance, a retry, a double-submit) cannot pay again.
  begin
    perform public.grant_community_points(s1, 10, 'signup_domain', 'Signup bonus (psu.edu)', inc, s1, 'system');
    raise notice 'FAIL payout: the same student was paid the signup bonus twice';
  exception when others then
    if sqlerrm like '%GRANT_ALREADY_PAID%' then
      raise notice 'PASS payout: a second signup bonus for one student is refused';
    else
      raise notice 'FAIL payout: second attempt gave %', sqlerrm;
    end if;
  end;
  select balance into n from public.community_balances where user_id = s1;
  if n = 10 then raise notice 'PASS payout: the refused repeat moved no points';
  else raise notice 'FAIL payout: balance % after a refused repeat', n; end if;

  -- a DIFFERENT student is unaffected by that block
  perform public.grant_community_points(s2, 10, 'signup_domain', 'Signup bonus (psu.edu)', inc, s2, 'system');
  select balance into n from public.community_balances where user_id = s2;
  if n = 10 then raise notice 'PASS payout: a different student is still paid';
  else raise notice 'FAIL payout: second student balance % (wanted 10)', n; end if;

  -- a referral bonus for the SAME student is a different kind, so it is a
  -- separate payout and must not be blocked by the signup one
  select id into ref from public.incentives where name = 'Refer 040';
  perform public.grant_community_points(s1, 10, 'referral_friend', 'Referral', ref, s1, 'system');
  select balance into n from public.community_balances where user_id = s1;
  if n = 20 then raise notice 'PASS payout: a signup bonus and a referral bonus stack';
  else raise notice 'FAIL payout: balance % (wanted 20)', n; end if;

  -- and the budget still fences this kind
  update public.incentives set budget_points = spent_points where id = inc;
  begin
    perform public.grant_community_points(
      '00000000-0000-0000-0000-000000000393', 10, 'signup_domain', 'x', inc,
      '00000000-0000-0000-0000-000000000393', 'system');
    raise notice 'FAIL budget: a signup bonus past the budget was paid';
  exception when others then
    if sqlerrm like '%GRANT_BUDGET_EXHAUSTED%' then
      raise notice 'PASS budget: the signup bonus stops at its budget';
    else
      raise notice 'FAIL budget: gave %', sqlerrm;
    end if;
  end;
end $$;
