-- Assertions for migration-063 (the bonus_window incentive kind).
--
-- WHAT THIS FILE IS REALLY PROTECTING. 063 is deliberately thin — one CHECK
-- value, one reporting table and one read-only function — because the feature
-- lives in JavaScript: src/routes/vendor.js multiplies, award_points is not
-- touched, and test/bonus-window.test.js covers the arithmetic. So what is
-- asserted here is only what the DATABASE promises:
--
--   1. the new kind slots into 039's machinery without any of it being rebuilt
--      (one-active-per-kind still per kind, unknown kinds still refused);
--   2. the DOUBLE-COUNT STOP. A terminal that retries an award reuses its
--      token, award_points returns early crediting nothing, and the server
--      cannot tell the retry from the original — idx_bonus_credits_once is the
--      only thing standing between that and a report that says the promotion
--      cost twice what it did. Block 3.
--   3. THE TOTALS SURVIVE DELETION. `on delete set null` on all three foreign
--      keys is what keeps the operator's exposure figure correct after a
--      student closes their account or a spot leaves the platform. The obvious
--      alternative (cascade) would silently rewrite history every time, which
--      is the bug this is written to catch. Block 5.
--   4. the table is server-only, like every other money-adjacent table here.
--
-- ⚠ IT ALSO ASSERTS WHAT THIS TABLE IS NOT. bonus_window_credits does NOT move
-- points: block 2 writes credit rows and then checks that no balance anywhere
-- changed. If someone ever adds a trigger to "keep the balance in step", that
-- is the assertion that should fail — the points are moved by award_points and
-- recorded in `transactions`, and a second writer would mean two sources of
-- truth for one number.
--
-- Clock: now() is the transaction timestamp, fixed for a whole DO block, so the
-- window-bound comparisons below are exact rather than racy.

-- ---- block 1: the new kind, inside 039's machinery ----
do $$
declare
  inc uuid;
begin
  -- the new kind is accepted...
  insert into public.incentives (kind, name, config, active, starts_at, ends_at)
  values ('bonus_window', 'Double points weekend',
          '{"multiplier":2,"maxMultiplier":3}'::jsonb, true,
          now() - interval '1 hour', now() + interval '2 days')
  returning id into inc;
  raise notice 'PASS kind: bonus_window is a valid incentive kind';

  -- ...and an unknown one still is not. 040 asserted this too; it is re-checked
  -- because 063 DROPS AND RECREATES the CHECK, so a fat-fingered rebuild that
  -- widened it would pass every other assertion in this file.
  begin
    insert into public.incentives (kind, name, config) values ('lottery', 'Nope', '{}'::jsonb);
    raise notice 'FAIL kind: an unknown kind was accepted';
  exception when check_violation then
    raise notice 'PASS kind: an unknown kind is still refused by the CHECK';
  end;

  -- the two older kinds still are, which is the other half of a rebuilt CHECK
  insert into public.incentives (kind, name, config, active, starts_at)
  values ('signup_domain', 'Signup 063', '{"points":10,"domains":["psu.edu"]}'::jsonb, true, now());
  insert into public.incentives (kind, name, config, active)
  values ('referral', 'Refer 063', '{}'::jsonb, true);
  raise notice 'PASS kind: referral and signup_domain are still accepted';

  -- one live deal PER KIND: all three can run at once...
  raise notice 'PASS one-per-kind: a window, a signup bonus and a referral are all live together';

  -- ...but not two live windows
  begin
    insert into public.incentives (kind, name, config, active, starts_at, ends_at)
    values ('bonus_window', 'Second window', '{"multiplier":2}'::jsonb, true, now(), now() + interval '1 day');
    raise notice 'FAIL one-per-kind: a second live bonus window was allowed';
  exception when unique_violation then
    raise notice 'PASS one-per-kind: a second live bonus window is refused';
  end;
end $$;

-- ---- block 2: the credit table records, and MOVES NOTHING ----
do $$
declare
  s1  uuid := '00000000-0000-0000-0000-000000000631';
  s2  uuid := '00000000-0000-0000-0000-000000000632';
  va  uuid := '00000000-0000-0000-0000-00000000063a';
  vb  uuid := '00000000-0000-0000-0000-00000000063b';
  inc uuid;
  n   integer;
  m   integer;
begin
  select id into inc from public.incentives where name = 'Double points weekend';

  -- Three boosted awards: S1 at both spots, S2 at one. Shaped so every scalar
  -- in the report below is a different number and none can pass by coincidence.
  insert into public.bonus_window_credits
    (incentive_id, user_id, vendor_id, base_points, bonus_points,
     tier_multiplier, window_multiplier, applied_multiplier, source, client_token)
  values
    (inc, s1, va, 100,  100, 1,   2, 2, 'counter', 'tok-a'),
    (inc, s1, vb, 200,  200, 1,   2, 2, 'counter', 'tok-b'),
    (inc, s2, va,  50,   25, 1.5, 2, 3, 'receipt', null);
  raise notice 'PASS credits: three boosted awards recorded';

  -- ⚠ THE DEFINING ASSERTION. This is a report, not a ledger. Writing to it
  -- must not touch a balance, now or ever — if a trigger is added later to
  -- "keep things in step", this is what catches it.
  select count(*) into n from public.community_balances
   where user_id in (s1, s2) and balance <> 0;
  select count(*) into m from public.point_balances where user_id in (s1, s2);
  if n = 0 and m = 0 then
    raise notice 'PASS credits: logging a credit moved no points anywhere';
  else
    raise notice 'FAIL credits: % community rows and % point_balances rows appeared', n, m;
  end if;

  -- spent_points is a COMMUNITY-point counter and nothing here feeds it. The
  -- admin route relies on this: it reports a window's cost from the RPC below
  -- precisely BECAUSE spent_points stays 0, and it uses `locked` rather than
  -- `spent_points > 0` to decide a window can no longer be deleted.
  select spent_points into n from public.incentives where id = inc;
  if n = 0 then raise notice 'PASS credits: the window''s spent_points is still 0';
  else raise notice 'FAIL credits: spent_points moved to %', n; end if;

  -- a zero or negative bonus is refused: the cap-clamped case writes no row at
  -- all (src/lib/bonus-window.js returns early), and a row claiming no exposure
  -- would make the awards count wrong while adding nothing
  begin
    insert into public.bonus_window_credits
      (incentive_id, user_id, vendor_id, base_points, bonus_points,
       tier_multiplier, window_multiplier, applied_multiplier, source)
    values (inc, s1, va, 100, 0, 2, 2, 2, 'counter');
    raise notice 'FAIL credits: a zero-bonus row was accepted';
  exception when check_violation then
    raise notice 'PASS credits: a zero-bonus row is refused by the CHECK';
  end;
end $$;

-- ---- block 3: the double-count stop ----
do $$
declare
  s1  uuid := '00000000-0000-0000-0000-000000000631';
  va  uuid := '00000000-0000-0000-0000-00000000063a';
  vb  uuid := '00000000-0000-0000-0000-00000000063b';
  inc uuid;
  n   integer;
begin
  select id into inc from public.incentives where name = 'Double points weekend';

  -- ⚠ THE RETRY. The terminal reuses its idempotency token after a network
  -- drop; award_points sees the token, returns the current balances and credits
  -- NOTHING. The server cannot tell that from the original call, so it logs
  -- again — and this index is the only thing that stops the operator's report,
  -- and the bill shown to that vendor, from doubling.
  begin
    insert into public.bonus_window_credits
      (incentive_id, user_id, vendor_id, base_points, bonus_points,
       tier_multiplier, window_multiplier, applied_multiplier, source, client_token)
    values (inc, s1, va, 100, 100, 1, 2, 2, 'counter', 'tok-a');
    raise notice 'FAIL retry: a repeated (vendor, token) was logged twice';
  exception when unique_violation then
    raise notice 'PASS retry: a repeated (vendor, token) is refused';
  end;

  -- The index is per VENDOR, matching transactions' (vendor_id, client_token):
  -- two tills at different spots can mint the same token and neither may block
  -- the other.
  insert into public.bonus_window_credits
    (incentive_id, user_id, vendor_id, base_points, bonus_points,
     tier_multiplier, window_multiplier, applied_multiplier, source, client_token)
  values (inc, s1, vb, 100, 100, 1, 2, 2, 'counter', 'tok-a');
  raise notice 'PASS retry: the same token at a DIFFERENT spot is allowed';

  -- Partial index: the receipt path carries no token, and many untokened rows
  -- must not collide with each other.
  insert into public.bonus_window_credits
    (incentive_id, user_id, vendor_id, base_points, bonus_points,
     tier_multiplier, window_multiplier, applied_multiplier, source, client_token)
  values
    (inc, s1, va, 10, 10, 1, 2, 2, 'receipt', null),
    (inc, s1, va, 10, 10, 1, 2, 2, 'receipt', null);
  raise notice 'PASS retry: untokened rows are unconstrained (partial index)';

  select count(*) into n from public.bonus_window_credits where incentive_id = inc;
  if n = 6 then raise notice 'PASS retry: 6 rows survived (3 + 1 other-spot + 2 untokened)';
  else raise notice 'FAIL retry: % rows (wanted 6)', n; end if;
end $$;

-- ---- block 4: the report ----
do $$
declare
  inc uuid;
  r   jsonb;
  va  uuid := '00000000-0000-0000-0000-00000000063a';
begin
  select id into inc from public.incentives where name = 'Double points weekend';
  r := public.bonus_window_report(inc);

  -- Rows now: (va,100,100) (vb,200,200) (va,50,25) (vb,100,100) (va,10,10) (va,10,10)
  --   awards 6, base 470, bonus 445, students 2
  if (r->>'awards')::int = 6 then raise notice 'PASS report: 6 awards';
  else raise notice 'FAIL report: awards % (wanted 6)', r->>'awards'; end if;

  if (r->>'bonusPoints')::int = 445 then raise notice 'PASS report: 445 bonus points';
  else raise notice 'FAIL report: bonusPoints % (wanted 445)', r->>'bonusPoints'; end if;

  if (r->>'basePoints')::int = 470 then raise notice 'PASS report: 470 base points';
  else raise notice 'FAIL report: basePoints % (wanted 470)', r->>'basePoints'; end if;

  -- distinct students, not rows: S1 appears five times
  if (r->>'students')::int = 2 then raise notice 'PASS report: 2 distinct students';
  else raise notice 'FAIL report: students % (wanted 2)', r->>'students'; end if;

  -- two vendors, ordered by what each gave away: vb 300, va 145
  if jsonb_array_length(r->'vendors') = 2 then raise notice 'PASS report: 2 vendors in the breakdown';
  else raise notice 'FAIL report: % vendors', jsonb_array_length(r->'vendors'); end if;

  if (r->'vendors'->0->>'name') = 'Going Away 063'
     and (r->'vendors'->0->>'bonusPoints')::int = 300 then
    raise notice 'PASS report: the breakdown is ordered by bonus points, biggest first';
  else
    raise notice 'FAIL report: first vendor is % with %',
      r->'vendors'->0->>'name', r->'vendors'->0->>'bonusPoints';
  end if;

  if (r->'vendors'->1->>'bonusPoints')::int = 145 then
    raise notice 'PASS report: the second vendor''s share is 145';
  else
    raise notice 'FAIL report: second vendor % (wanted 145)', r->'vendors'->1->>'bonusPoints';
  end if;

  -- the per-vendor shares add up to the total; a breakdown that does not is
  -- worse than no breakdown
  if (r->'vendors'->0->>'bonusPoints')::int + (r->'vendors'->1->>'bonusPoints')::int
     = (r->>'bonusPoints')::int then
    raise notice 'PASS report: the per-vendor shares sum to the total';
  else
    raise notice 'FAIL report: the breakdown does not sum to the total';
  end if;

  -- an incentive with no credits is zeros and an empty list, never null: the
  -- admin panel reads these straight into a sentence
  r := public.bonus_window_report('00000000-0000-0000-0000-0000000006ff');
  if (r->>'awards')::int = 0 and jsonb_array_length(r->'vendors') = 0 then
    raise notice 'PASS report: an unused window reports zeros and an empty list';
  else raise notice 'FAIL report: unused window gave %', r; end if;
end $$;

-- ---- block 5: the totals survive a deletion ----
do $$
declare
  inc   uuid;
  s2    uuid := '00000000-0000-0000-0000-000000000632';
  vb    uuid := '00000000-0000-0000-0000-00000000063b';
  r     jsonb;
  n     integer;
begin
  select id into inc from public.incentives where name = 'Double points weekend';

  -- ⚠ A SPOT LEAVES. Cascade here would delete its credit rows and silently
  -- drop 300 points off the operator's total — rewriting what a finished
  -- promotion cost, every time a vendor churned. set null keeps the money and
  -- loses only the name.
  delete from public.vendors where id = vb;
  r := public.bonus_window_report(inc);

  if (r->>'bonusPoints')::int = 445 and (r->>'awards')::int = 6 then
    raise notice 'PASS delete: the total is unchanged after a vendor is deleted';
  else
    raise notice 'FAIL delete: total fell to % over % awards', r->>'bonusPoints', r->>'awards';
  end if;

  select count(*) into n from public.bonus_window_credits
   where incentive_id = inc and vendor_id is null;
  if n = 2 then raise notice 'PASS delete: the deleted spot''s 2 rows survived with a null vendor';
  else raise notice 'FAIL delete: % orphaned rows (wanted 2)', n; end if;

  -- and the breakdown still names it as an unknown row rather than hiding it,
  -- so the two halves continue to add up
  if (r->'vendors'->0->>'name') is null
     and (r->'vendors'->0->>'bonusPoints')::int = 300 then
    raise notice 'PASS delete: the orphaned share is still in the breakdown, unnamed';
  else
    raise notice 'FAIL delete: orphaned share is % / %',
      r->'vendors'->0->>'name', r->'vendors'->0->>'bonusPoints';
  end if;

  -- A STUDENT CLOSES THEIR ACCOUNT. The POINTS total must not move, for the
  -- same reason as the vendor above.
  delete from public.profiles where user_id = s2;
  r := public.bonus_window_report(inc);
  if (r->>'bonusPoints')::int = 445 and (r->>'awards')::int = 6 then
    raise notice 'PASS delete: the total is unchanged after a student is deleted';
  else
    raise notice 'FAIL delete: total fell to % over % awards after a student left',
      r->>'bonusPoints', r->>'awards';
  end if;

  -- ⚠ BUT THE STUDENT COUNT DOES MOVE, AND THAT IS ASSERTED RATHER THAN FIXED.
  -- `count(distinct user_id)` skips nulls, so S2's row stops being counted as a
  -- person the moment their account is gone: 2 becomes 1. There is no way
  -- around it — the id IS the only thing that made that row distinct, and it
  -- has been deliberately thrown away (on delete set null, so the money
  -- survives but the identity does not). So `students` means "students who
  -- still have an account", and the figure can only fall over time while
  -- `bonusPoints` and `awards` stay fixed.
  --
  -- This is pinned down here because the alternative reading — that the number
  -- is wrong and someone should go and fix it — would mean either keeping
  -- deleted students' ids (which is the thing privacy forbids) or cascading the
  -- rows away (which would break the two assertions above).
  if (r->>'students')::int = 1 then
    raise notice 'PASS delete: students falls to 1 — it counts accounts that still exist';
  else
    raise notice 'FAIL delete: students now % (wanted 1: count(distinct) skips the null)',
      r->>'students';
  end if;
end $$;

-- ---- block 6: who may touch any of this ----
do $$
declare n integer;
begin
  -- Server-only, exactly like incentives and community_grants: RLS on, no
  -- policies, and no privileges for the two roles a browser can reach.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'bonus_window_credits';
  if n = 0 then raise notice 'PASS grants: no RLS policies (server-only)';
  else raise notice 'FAIL grants: % policies on bonus_window_credits', n; end if;

  select count(*) into n from pg_class
   where relname = 'bonus_window_credits' and relrowsecurity;
  if n = 1 then raise notice 'PASS grants: row level security is enabled';
  else raise notice 'FAIL grants: RLS is not enabled'; end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'bonus_window_credits'
     and grantee in ('anon', 'authenticated');
  if n = 0 then raise notice 'PASS grants: anon and authenticated hold nothing';
  else raise notice 'FAIL grants: % privileges held by anon/authenticated', n; end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'bonus_window_credits'
     and grantee = 'service_role';
  if n > 0 then raise notice 'PASS grants: service_role can read and write it';
  else raise notice 'FAIL grants: service_role holds nothing'; end if;

  -- The report function is a read the dashboard makes; a browser must not be
  -- able to make it directly. (It is STABLE, so it cannot write anyway — but
  -- the whole point of the revoke is not having to rely on that.)
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'bonus_window_report'
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute'));
  if n = 0 then raise notice 'PASS grants: bonus_window_report is not executable by anon/authenticated';
  else raise notice 'FAIL grants: bonus_window_report is reachable from a browser'; end if;
end $$;
