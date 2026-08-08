-- Assertions for migration-038 (receipt_claims + claim_receipt).
--
-- Two do-blocks, deliberately. app.points_write is transaction-local and each
-- bare statement here is its own transaction, so the FIRST block probes the
-- migration-025 guard from a transaction that has never called an RPC (calling
-- one first would leave the flag set and fake a pass). The second block only
-- ever writes through the RPCs, as production does.

-- ---- block 1: the points guard still holds for a non-RPC transaction ----
do $$
declare
  v uuid;
  s1 uuid := '00000000-0000-0000-0000-000000000381';
begin
  select id into v from public.vendors where slug = 'receipt-diner-038';
  begin
    insert into public.point_balances (user_id, vendor_id, balance) values (s1, v, 999);
    raise notice 'FAIL guard: direct point_balances insert was allowed';
  exception when others then
    raise notice 'PASS guard: direct point_balances insert still blocked';
  end;
end $$;

-- ---- block 2: claim_receipt behavior ----
do $$
declare
  c_tz constant text := 'America/New_York';
  s1 uuid := '00000000-0000-0000-0000-000000000381';
  s2 uuid := '00000000-0000-0000-0000-000000000382';
  s3 uuid := '00000000-0000-0000-0000-000000000383';
  v uuid;
  now_local timestamp;
  v_claim uuid; v_bal integer; v_comm integer;
  n integer;
begin
  select id into v from public.vendors where slug = 'receipt-diner-038';
  now_local := (now() at time zone c_tz)::timestamp;

  -- 1. happy path: 12.19 receipt from an hour ago → claim row + earn txn
  --    with the rcpt- token + balance + 10% community mint, all in one call.
  select cr.claim_id, cr.new_balance, cr.new_community into v_claim, v_bal, v_comm
  from public.claim_receipt(s1, v, now_local - interval '1 hour', c_tz, 12.19, 121) cr;

  if v_claim is not null and v_bal = 121 then
    raise notice 'PASS happy path: claim accepted, balance 121';
  else
    raise notice 'FAIL happy path: claim %, balance % (wanted 121)', v_claim, v_bal;
  end if;

  if v_comm = 12 then raise notice 'PASS happy path: community mint 12 (10%% of 121)';
  else raise notice 'FAIL happy path: community mint % (wanted 12)', v_comm; end if;

  select count(*) into n from public.transactions
  where user_id = s1 and vendor_id = v and type = 'earn'
    and dollar_amount = 12.19 and client_token like 'rcpt-%';
  if n = 1 then raise notice 'PASS happy path: earn transaction carries the rcpt- token';
  else raise notice 'FAIL happy path: % rcpt- transactions (wanted 1)', n; end if;

  -- 2. the race: a DIFFERENT user scanning the SAME receipt loses cleanly.
  begin
    perform 1 from public.claim_receipt(s2, v, now_local - interval '1 hour', c_tz, 12.19, 121);
    raise notice 'FAIL same receipt: second claimant was accepted';
  exception when others then
    if sqlerrm like '%RECEIPT_CLAIMED%' then
      raise notice 'PASS same receipt: second claimant got RECEIPT_CLAIMED';
    else
      raise notice 'FAIL same receipt: got % (wanted RECEIPT_CLAIMED)', sqlerrm;
    end if;
  end;

  -- 3. counter double-dip: the terminal already awarded S3 exactly 10.50
  --    (created_at = now()), so a receipt printed "just now" for 10.50 is that
  --    same purchase.
  perform 1 from public.award_points(s3, v, 105, 10.50, 'termtok-behavior038');
  begin
    perform 1 from public.claim_receipt(s3, v, now_local, c_tz, 10.50, 105);
    raise notice 'FAIL double-dip: counter-awarded purchase was claimable';
  exception when others then
    if sqlerrm like '%RECEIPT_ALREADY_EARNED%' then
      raise notice 'PASS double-dip: counter award within 5 min → RECEIPT_ALREADY_EARNED';
    else
      raise notice 'FAIL double-dip: got % (wanted RECEIPT_ALREADY_EARNED)', sqlerrm;
    end if;
  end;

  -- 4. same amount but printed 20 min before the counter award → different
  --    purchase, claim goes through.
  select cr.new_balance into v_bal
  from public.claim_receipt(s3, v, now_local - interval '20 minutes', c_tz, 10.50, 105) cr;
  if v_bal = 210 then raise notice 'PASS window: same amount outside ±5 min claims fine';
  else raise notice 'FAIL window: balance % (wanted 210)', v_bal; end if;

  -- 5. rcpt-exclusion: S1's own claim from step 1 wrote an earn txn for 12.19
  --    at now(). A second, genuinely different receipt for the same 12.19
  --    printed "just now" must NOT trip the double-dip check.
  begin
    perform 1 from public.claim_receipt(s1, v, now_local, c_tz, 12.19, 121);
    raise notice 'PASS rcpt-exclusion: identical-total second receipt accepted';
  exception when others then
    raise notice 'FAIL rcpt-exclusion: got %', sqlerrm;
  end;

  -- 6. daily cap: claims 3 and 4 for S1 today.
  perform 1 from public.claim_receipt(s1, v, now_local - interval '2 hours', c_tz, 5.00, 50);
  begin
    perform 1 from public.claim_receipt(s1, v, now_local - interval '3 hours', c_tz, 6.00, 60);
    raise notice 'FAIL daily cap: fourth claim today was accepted';
  exception when others then
    if sqlerrm like '%RECEIPT_DAILY_LIMIT%' then
      raise notice 'PASS daily cap: fourth claim today → RECEIPT_DAILY_LIMIT';
    else
      raise notice 'FAIL daily cap: got % (wanted RECEIPT_DAILY_LIMIT)', sqlerrm;
    end if;
  end;

  -- 7. freshness gates and the size ceiling.
  begin
    perform 1 from public.claim_receipt(s2, v, now_local - interval '8 days', c_tz, 9.00, 90);
    raise notice 'FAIL too old: 8-day-old receipt was accepted';
  exception when others then
    if sqlerrm like '%RECEIPT_TOO_OLD%' then raise notice 'PASS too old: 8-day-old receipt rejected';
    else raise notice 'FAIL too old: got %', sqlerrm; end if;
  end;

  begin
    perform 1 from public.claim_receipt(s2, v, now_local + interval '2 hours', c_tz, 9.00, 90);
    raise notice 'FAIL future: future-dated receipt was accepted';
  exception when others then
    if sqlerrm like '%RECEIPT_IN_FUTURE%' then raise notice 'PASS future: future-dated receipt rejected';
    else raise notice 'FAIL future: got %', sqlerrm; end if;
  end;

  begin
    perform 1 from public.claim_receipt(s2, v, now_local - interval '1 hour', c_tz, 250.00, 2500);
    raise notice 'FAIL ceiling: $250 receipt was accepted';
  exception when others then
    if sqlerrm like '%RECEIPT_TOTAL_TOO_LARGE%' then raise notice 'PASS ceiling: $250 receipt rejected';
    else raise notice 'FAIL ceiling: got %', sqlerrm; end if;
  end;

  begin
    perform 1 from public.claim_receipt(s2, v, now_local - interval '1 hour', c_tz, 9.00, 0);
    raise notice 'FAIL zero points: accepted';
  exception when others then
    if sqlerrm like '%RECEIPT_TOTAL_MISSING%' then raise notice 'PASS zero points: rejected as RECEIPT_TOTAL_MISSING';
    else raise notice 'FAIL zero points: got %', sqlerrm; end if;
  end;

  -- 8. the ledger holds exactly the accepted claims: S1×3, S3×1.
  select count(*) into n from public.receipt_claims where user_id = s1;
  if n = 3 then raise notice 'PASS ledger: S1 has exactly 3 claims';
  else raise notice 'FAIL ledger: S1 has % claims (wanted 3)', n; end if;

  select count(*) into n from public.receipt_claims;
  if n = 4 then raise notice 'PASS ledger: 4 claims total, failures left no rows';
  else raise notice 'FAIL ledger: % claims total (wanted 4)', n; end if;
end $$;
