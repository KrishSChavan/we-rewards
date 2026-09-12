-- Assertions for migration-056 (create_earn_code safe to run twice).
--
-- The reason this file exists is that the FIX IS A RETRY. src/lib/supabase.js
-- now re-sends POST /rest/v1/rpc/create_earn_code 200ms after a gateway error,
-- and every promise that makes that correct lives in this function:
--
--   * TWO CALLS RETURN THE SAME CODE. If they don't, the retry hands the student
--     a second live code and the digits on screen can change between refreshes
--     while a cashier is typing them.
--   * THE SECOND CALL EXTENDS, NOT MINTS. One live row per student, before and
--     after.
--   * THE PICK IS DETERMINISTIC. A duplicate pair left by a pre-056 race must
--     resolve to ONE code, the longest-lived, every time — not alternate.
--   * THE ADVISORY LOCK IS ACTUALLY TAKEN. This is the whole basis for the retry
--     being safe under concurrency, and it is one line that is easy to lose in a
--     later edit. Asserted directly against pg_locks.
--   * HOUSEKEEPING CANNOT BLOCK. The old blanket DELETE took row locks on every
--     other student's expired rows on every call, with no index to find them by
--     and no statement_timeout on service_role to cut it short. Asserted here as
--     the two things that replaced it: the index exists, and another student's
--     litter is still collected.
--
-- One thing NOT asserted, because psql cannot: two SESSIONS colliding. The lock
-- is proven to be held; that it serialises is Postgres's job, not ours.

do $$
declare
  s1 uuid := '00000000-0000-0000-0000-000000000561';   -- one live code
  s2 uuid := '00000000-0000-0000-0000-000000000562';   -- a duplicate pair
  s3 uuid := '00000000-0000-0000-0000-000000000563';   -- expired only
  s4 uuid := '00000000-0000-0000-0000-000000000564';   -- never comes back
  s5 uuid := '00000000-0000-0000-0000-000000000565';   -- created below
  first_code  text;
  second_code text;
  third_code  text;
  exp_before  timestamptz;
  exp_after   timestamptz;
  n           integer;
begin
  -- == 1. the stable-code promise: call twice, get the same code ==
  first_code  := public.create_earn_code(s1, 300);
  second_code := public.create_earn_code(s1, 300);
  if first_code = '100001' and second_code = '100001' then
    raise notice 'PASS two calls both returned the live code the student already had (%)', first_code;
  else
    raise notice 'FAIL expected 100001 twice, got % then %', first_code, second_code;
  end if;

  -- ...and did not leave a second row behind. THIS is the assertion that makes
  -- the retry in src/lib/supabase.js correct.
  select count(*) into n from public.earn_codes where user_id = s1 and expires_at > now();
  if n = 1 then raise notice 'PASS one live code per student after two calls';
  else raise notice 'FAIL student holds % live codes after two calls', n; end if;

  -- == 2. the second call EXTENDS the TTL rather than minting ==
  select expires_at into exp_before from public.earn_codes where code = '100001';
  perform pg_sleep(0.05);
  third_code := public.create_earn_code(s1, 600);
  select expires_at into exp_after from public.earn_codes where code = '100001';
  if third_code = '100001' and exp_after > exp_before then
    raise notice 'PASS the repeat call re-extended the live code expiry';
  else
    raise notice 'FAIL repeat call returned % and expiry moved % -> %', third_code, exp_before, exp_after;
  end if;

  -- == 3. a duplicate pair resolves deterministically, longest-lived first ==
  -- 100003 outlives 100002 in the seed. Three calls, same answer every time:
  -- without ORDER BY this is whatever order the scan happens to produce.
  if public.create_earn_code(s2, 300) = '100003'
     and public.create_earn_code(s2, 300) = '100003'
     and public.create_earn_code(s2, 300) = '100003' then
    raise notice 'PASS a pre-existing duplicate pair resolves to the same code every call';
  else
    raise notice 'FAIL duplicate pair did not resolve deterministically to 100003';
  end if;

  -- == 4. the advisory lock is held (the basis for retrying a POST) ==
  -- pg_advisory_xact_lock keeps the lock for the life of the transaction, and
  -- this DO block is one transaction, so the calls above must have left it here.
  select count(*) into n from pg_locks
   where locktype = 'advisory' and pid = pg_backend_pid();
  if n > 0 then
    raise notice 'PASS create_earn_code takes a transaction-scoped advisory lock (% held)', n;
  else
    raise notice 'FAIL no advisory lock held - concurrent calls can both mint a code';
  end if;

  -- One lock PER STUDENT, not one global lock: s1 and s2 must not have queued
  -- behind each other.
  select count(distinct (classid, objid, objsubid)) into n from pg_locks
   where locktype = 'advisory' and pid = pg_backend_pid();
  if n >= 2 then
    raise notice 'PASS the lock is keyed per student (% distinct keys held)', n;
  else
    raise notice 'FAIL % distinct advisory key(s) - a single global lock would serialise every student', n;
  end if;

  -- == 5. an expired code is replaced, not reused ==
  first_code := public.create_earn_code(s3, 300);
  if first_code <> '100004' and first_code ~ '^[0-9]{6}$' then
    raise notice 'PASS an expired code was replaced by a fresh 6-digit one (%)', first_code;
  else
    raise notice 'FAIL expired code handling returned %', first_code;
  end if;

  select count(*) into n from public.earn_codes where code = '100004';
  if n = 0 then raise notice 'PASS the student own expired row was cleaned up';
  else raise notice 'FAIL the expired row survived'; end if;

  -- == 6. other people's litter is still collected, without blocking ==
  -- s4 never calls anything. Their hour-old row must have been swept by somebody
  -- else's call - that is what the bounded FOR UPDATE SKIP LOCKED sweep is for.
  select count(*) into n from public.earn_codes where user_id = s4;
  if n = 0 then raise notice 'PASS the global sweep collected an absent student expired row';
  else raise notice 'FAIL % expired row(s) left behind for a student who never returns', n; end if;

  -- == 7. the index behind that sweep exists ==
  select count(*) into n from pg_indexes
   where tablename = 'earn_codes' and indexname = 'idx_earn_codes_expires';
  if n = 1 then raise notice 'PASS idx_earn_codes_expires exists, so the sweep is not a seq scan';
  else raise notice 'FAIL idx_earn_codes_expires is missing'; end if;

  -- == 8. a brand-new student still gets a code ==
  insert into auth.users (id, email) values (s5, 's5@psu.edu');
  insert into public.profiles (user_id, name, email) values (s5, 'Brand New', 's5@psu.edu');
  first_code := public.create_earn_code(s5, 300);
  if first_code ~ '^[0-9]{6}$' then
    raise notice 'PASS a student with no history is minted a 6-digit code (%)', first_code;
  else
    raise notice 'FAIL a new student got %', first_code;
  end if;

  -- == 9. the grant survived create-or-replace ==
  -- Re-stated by the migration, but the failure mode if it were not is that
  -- every earn-code request fails for the service role, i.e. the whole feature.
  if has_function_privilege('service_role', 'public.create_earn_code(uuid, integer)', 'execute')
     and not has_function_privilege('authenticated', 'public.create_earn_code(uuid, integer)', 'execute') then
    raise notice 'PASS execute is service_role only';
  else
    raise notice 'FAIL the function ACL is wrong after create-or-replace';
  end if;
end $$;
