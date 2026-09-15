-- Assertions for migration-058 (the referrer is paid at signup).
--
-- One sweep, asserted from every angle, because that is the shape of the risk:
-- settle_referrals processes the whole pending set in one loop with a per-row
-- savepoint, so the interesting failures are a row that stalls the batch and a
-- row that gets paid when it should not.

-- ---- block 1: the world really has no purchases in it ----
-- If this fails, every assertion below is testing the old gate by accident.
do $$
declare n integer;
begin
  select count(*) into n from public.transactions where type = 'earn';
  if n = 0 then raise notice 'PASS setup: not one earn row exists, so nothing here can qualify the old way';
  else raise notice 'FAIL setup: % earn rows exist — the purchase gate is not being tested', n; end if;
end $$;

-- ---- block 2: one sweep, four outcomes ----
do $$
declare
  r    uuid := '00000000-0000-0000-0000-000000000581';
  f1   uuid := '00000000-0000-0000-0000-000000000582';
  f2   uuid := '00000000-0000-0000-0000-000000000583';
  f3   uuid := '00000000-0000-0000-0000-000000000584';
  f4   uuid := '00000000-0000-0000-0000-000000000585';
  v_settled integer; v_skipped integer;
  v_before integer; v_after integer;
  v_status text; v_qualified timestamptz; v_paid timestamptz;
  n integer;
begin
  -- 100 already, from F2's torn-pair grant in the seed.
  select coalesce(balance, 0) into v_before from public.community_balances where user_id = r;

  select s.settled, s.skipped into v_settled, v_skipped from public.settle_referrals(50) s;

  -- F1 paid + F2 healed = 2 settled. F3 refused = 1 skipped. F4 void = not seen.
  if v_settled = 2 and v_skipped = 1 then
    raise notice 'PASS settle: one sweep settled 2 and skipped 1 with no purchases anywhere';
  else
    raise notice 'FAIL settle: settled % skipped % (wanted 2/1)', v_settled, v_skipped;
  end if;

  -- THE CHANGE ITSELF. Under 039 this row could not be paid at all.
  select status, qualified_at, paid_at into v_status, v_qualified, v_paid
    from public.referrals where friend_id = f1;
  if v_status = 'paid' and v_qualified is not null and v_paid is not null then
    raise notice 'PASS instant: an un-purchased referral is paid and fully stamped';
  else
    raise notice 'FAIL instant: status % qualified % paid %', v_status, v_qualified, v_paid;
  end if;

  -- THE HEALED TEAR. Paid once in the seed, marked here, never paid twice.
  select status, paid_at into v_status, v_paid from public.referrals where friend_id = f2;
  if v_status = 'paid' and v_paid is not null then
    raise notice 'PASS heal: a referral whose grant landed without its status update is marked paid';
  else
    raise notice 'FAIL heal: status % paid_at % (a torn pair is still stuck)', v_status, v_paid;
  end if;

  select count(*) into n from public.community_grants
   where kind = 'referral_referrer' and ref_id = (select id from public.referrals where friend_id = f2);
  if n = 1 then raise notice 'PASS heal: healing wrote no second grant';
  else raise notice 'FAIL heal: % grants for one referral', n; end if;

  -- The budget still refuses, and still leaves the row retryable.
  select status, qualified_at into v_status, v_qualified from public.referrals where friend_id = f3;
  if v_status = 'pending' and v_qualified is not null then
    raise notice 'PASS budget: an over-budget referral stays pending and is stamped for the next tick';
  else
    raise notice 'FAIL budget: status % qualified %', v_status, v_qualified;
  end if;

  select count(*) into n from public.community_grants
   where kind = 'referral_referrer' and ref_id = (select id from public.referrals where friend_id = f3);
  if n = 0 then raise notice 'PASS budget: the refused referral moved no points';
  else raise notice 'FAIL budget: % grants written past an exhausted budget', n; end if;

  -- migration-057's reversal outranks this. A void row is not a pending one.
  select status, paid_at into v_status, v_paid from public.referrals where friend_id = f4;
  if v_status = 'void' and v_paid is null then
    raise notice 'PASS void: a voided referral was left alone';
  else
    raise notice 'FAIL void: status % paid_at % — a merge reversal was undone', v_status, v_paid;
  end if;

  -- Exactly one new payout reached R: F1's 100. F2's was already in the balance
  -- before the sweep, which is the whole reason the heal must not re-grant.
  select coalesce(balance, 0) into v_after from public.community_balances where user_id = r;
  if v_after = v_before + 100 then
    raise notice 'PASS settle: the referrer gained exactly one payout (% -> %)', v_before, v_after;
  else
    raise notice 'FAIL settle: referrer % -> % (wanted +100)', v_before, v_after;
  end if;
end $$;

-- ---- block 3: the sweep is still idempotent ----
-- The old handler stalled forever on ALREADY_PAID; the new one marks the row.
-- A second sweep must therefore find nothing left but the over-budget one, and
-- must not pay anybody twice for having been healed.
do $$
declare
  r uuid := '00000000-0000-0000-0000-000000000581';
  v_settled integer; v_skipped integer;
  v_before integer; v_after integer;
begin
  select coalesce(balance, 0) into v_before from public.community_balances where user_id = r;
  select s.settled, s.skipped into v_settled, v_skipped from public.settle_referrals(50) s;
  select coalesce(balance, 0) into v_after from public.community_balances where user_id = r;

  if v_settled = 0 and v_skipped = 1 and v_after = v_before then
    raise notice 'PASS idempotent: a second sweep pays nobody and still only has the broke one to retry';
  else
    raise notice 'FAIL idempotent: settled % skipped % balance % -> %', v_settled, v_skipped, v_before, v_after;
  end if;
end $$;

-- ---- block 4: raising the budget releases the held referral ----
-- The behaviour the admin copy now promises in as many words ("Raise it and
-- they settle by themselves within 45 seconds").
do $$
declare
  r uuid := '00000000-0000-0000-0000-000000000581';
  v_settled integer;
  v_status text;
  v_before integer; v_after integer;
begin
  update public.incentives set budget_points = 5000 where name = 'Broke program 058';

  select coalesce(balance, 0) into v_before from public.community_balances where user_id = r;
  select s.settled into v_settled from public.settle_referrals(50) s;
  select coalesce(balance, 0) into v_after from public.community_balances where user_id = r;
  select status into v_status from public.referrals
   where friend_id = '00000000-0000-0000-0000-000000000584';

  if v_settled = 1 and v_status = 'paid' and v_after = v_before + 500 then
    raise notice 'PASS retry: raising the budget paid the held referral on the next sweep';
  else
    raise notice 'FAIL retry: settled % status % balance % -> %', v_settled, v_status, v_before, v_after;
  end if;
end $$;
