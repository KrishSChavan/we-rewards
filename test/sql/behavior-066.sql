-- Assertions for migration-066 (spot reviews).
--
-- What the DATABASE promises, block by block:
--   1. The two vendor settings refuse what the app must never hold: a
--      non-https link, points outside 0..500.
--   2. A FIRST review pays review_points into the purse, ADDED to what is
--      there, and records what it paid.
--   3. An edit pays nothing, keeps the original source and points, and
--      changes only what the student wrote.
--   4. A pooled location's review pays the POOL, never the location's own
--      point_balances row (which pool_join drained).
--   5. A location paying 0 writes the review and touches no balance at all.
--   6. A switched-off or unknown spot refuses, with no row written.
--   7. A rating outside 1..5 refuses.
--   8. Hiding: an edit cannot unhide; the public roll-up leaves hidden reviews
--      out; hidden_at and hidden_reason move together; there is no sentiment
--      reason to hide with.
--   9. The migration-025 guard still blocks a direct balance write.
--  10. Nothing here is reachable with the browser key.
--  11. Deleting the account takes its reviews down.
--
-- Rows for vendor_reviews are written here, not seeded: the harness runs the
-- seed BEFORE the migration, and the table does not exist until it has run.

-- ---- block 1: the settings ----
do $$
begin
  update public.vendors set review_points = 50, google_review_url = 'https://g.page/r/abc/review'
   where id = '00000000-0000-0000-0000-0000000066a1';
  update public.vendors set review_points = 30 where id = '00000000-0000-0000-0000-0000000066a2';
  raise notice 'PASS settings: an https Google link and 50 / 30 points are accepted';

  begin
    update public.vendors set google_review_url = 'javascript:alert(1)' where id = '00000000-0000-0000-0000-0000000066a1';
    raise notice 'FAIL settings: a javascript: link was stored';
  exception when check_violation then
    raise notice 'PASS settings: a non-https link is refused by the CHECK';
  end;

  begin
    update public.vendors set review_points = 501 where id = '00000000-0000-0000-0000-0000000066a1';
    raise notice 'FAIL settings: 501 points per review was stored';
  exception when check_violation then
    raise notice 'PASS settings: more than 500 points per review is refused';
  end;

  begin
    update public.vendors set review_points = -1 where id = '00000000-0000-0000-0000-0000000066a1';
    raise notice 'FAIL settings: negative points per review was stored';
  exception when check_violation then
    raise notice 'PASS settings: negative points per review is refused';
  end;

  if (select review_points from public.vendors where id = '00000000-0000-0000-0000-0000000066a4') = 0 then
    raise notice 'PASS settings: an untouched vendor pays 0 for reviews';
  else
    raise notice 'FAIL settings: review_points default is not 0';
  end if;
end $$;

-- ---- block 2: a first review pays ----
do $$
declare r record; v_bal integer; v_paid integer;
begin
  select * into r from public.submit_review(
    '00000000-0000-0000-0000-000000000661', '00000000-0000-0000-0000-0000000066a1',
    4, 'Good fries', 'Sam O.', 'visit');
  if r.created and r.points_awarded = 50 and r.new_balance = 150 then
    raise notice 'PASS first review: created, paid 50, balance 100 -> 150';
  else
    raise notice 'FAIL first review: created=% paid=% balance=%', r.created, r.points_awarded, r.new_balance;
  end if;

  select balance into v_bal from public.point_balances
   where user_id = '00000000-0000-0000-0000-000000000661' and vendor_id = '00000000-0000-0000-0000-0000000066a1';
  select points_awarded into v_paid from public.vendor_reviews
   where user_id = '00000000-0000-0000-0000-000000000661' and vendor_id = '00000000-0000-0000-0000-0000000066a1';
  if v_bal = 150 and v_paid = 50 then
    raise notice 'PASS first review: the purse and the review row agree on 50';
  else
    raise notice 'FAIL first review: purse=% row paid=%', v_bal, v_paid;
  end if;

  if not exists (select 1 from public.transactions
                  where user_id = '00000000-0000-0000-0000-000000000661') then
    raise notice 'PASS first review: no transactions row (a review is not a visit)';
  else
    raise notice 'FAIL first review: a transactions row was written';
  end if;
end $$;

-- ---- block 3: an edit pays nothing ----
do $$
declare r record; v_bal integer; rv record;
begin
  select * into r from public.submit_review(
    '00000000-0000-0000-0000-000000000661', '00000000-0000-0000-0000-0000000066a1',
    1, 'Changed my mind', null, 'onsite');
  if not r.created and r.points_awarded = 0 and r.new_balance is null then
    raise notice 'PASS edit: not created, paid 0';
  else
    raise notice 'FAIL edit: created=% paid=% balance=%', r.created, r.points_awarded, r.new_balance;
  end if;

  select balance into v_bal from public.point_balances
   where user_id = '00000000-0000-0000-0000-000000000661' and vendor_id = '00000000-0000-0000-0000-0000000066a1';
  select * into rv from public.vendor_reviews
   where user_id = '00000000-0000-0000-0000-000000000661' and vendor_id = '00000000-0000-0000-0000-0000000066a1';
  if v_bal = 150 and rv.rating = 1 and rv.body = 'Changed my mind' and rv.author_name is null
     and rv.source = 'visit' and rv.points_awarded = 50 then
    raise notice 'PASS edit: balance unchanged, text/rating/name changed, source and points kept';
  else
    raise notice 'FAIL edit: balance=% rating=% body=% name=% source=% paid=%',
      v_bal, rv.rating, rv.body, rv.author_name, rv.source, rv.points_awarded;
  end if;

  if (select count(*) from public.vendor_reviews
       where user_id = '00000000-0000-0000-0000-000000000661' and vendor_id = '00000000-0000-0000-0000-0000000066a1') = 1 then
    raise notice 'PASS edit: still exactly one review for that student and spot';
  else
    raise notice 'FAIL edit: more than one review row';
  end if;
end $$;

-- ---- block 4: a pooled location pays the pool ----
do $$
declare r record; v_pool integer; v_own integer;
begin
  select * into r from public.submit_review(
    '00000000-0000-0000-0000-000000000662', '00000000-0000-0000-0000-0000000066a2',
    5, null, 'Sam T.', 'visit');
  select balance into v_pool from public.pool_balances
   where user_id = '00000000-0000-0000-0000-000000000662' and pool_id = '00000000-0000-0000-0000-0000000066f1';
  select balance into v_own from public.point_balances
   where user_id = '00000000-0000-0000-0000-000000000662' and vendor_id = '00000000-0000-0000-0000-0000000066a2';
  if r.created and r.points_awarded = 30 and r.new_balance = 30 and v_pool = 30 and coalesce(v_own, 0) = 0 then
    raise notice 'PASS pool: the review paid 30 into the shared purse, nothing into the location row';
  else
    raise notice 'FAIL pool: created=% paid=% returned=% pool=% own=%', r.created, r.points_awarded, r.new_balance, v_pool, v_own;
  end if;
end $$;

-- ---- block 5: a location paying 0 ----
do $$
declare r record;
begin
  select * into r from public.submit_review(
    '00000000-0000-0000-0000-000000000662', '00000000-0000-0000-0000-0000000066a4',
    3, 'Fine', 'Sam T.', 'onsite');
  if r.created and r.points_awarded = 0 and r.new_balance is null
     and not exists (select 1 from public.point_balances
                      where user_id = '00000000-0000-0000-0000-000000000662'
                        and vendor_id = '00000000-0000-0000-0000-0000000066a4') then
    raise notice 'PASS zero: the review is written and no balance row is touched';
  else
    raise notice 'FAIL zero: created=% paid=% balance=%', r.created, r.points_awarded, r.new_balance;
  end if;
end $$;

-- ---- block 6: a switched-off or unknown spot ----
do $$
begin
  begin
    perform public.submit_review('00000000-0000-0000-0000-000000000662', '00000000-0000-0000-0000-0000000066a5', 5, null, null, 'visit');
    raise notice 'FAIL off: a review was written for a switched-off spot';
  exception when others then
    if sqlerrm like '%REVIEW_SPOT_UNAVAILABLE%' then
      raise notice 'PASS off: a switched-off spot refuses with REVIEW_SPOT_UNAVAILABLE';
    else
      raise notice 'FAIL off: wrong error %', sqlerrm;
    end if;
  end;
  begin
    perform public.submit_review('00000000-0000-0000-0000-000000000662', '00000000-0000-0000-0000-0000000066ff', 5, null, null, 'visit');
    raise notice 'FAIL off: a review was written for an unknown spot';
  exception when others then
    if sqlerrm like '%REVIEW_SPOT_UNAVAILABLE%' then
      raise notice 'PASS off: an unknown spot refuses with REVIEW_SPOT_UNAVAILABLE';
    else
      raise notice 'FAIL off: wrong error %', sqlerrm;
    end if;
  end;
  if not exists (select 1 from public.vendor_reviews where vendor_id in ('00000000-0000-0000-0000-0000000066a5', '00000000-0000-0000-0000-0000000066ff')) then
    raise notice 'PASS off: nothing was written for either';
  else
    raise notice 'FAIL off: a row was written';
  end if;
end $$;

-- ---- block 7: ratings ----
do $$
declare bad integer;
begin
  foreach bad in array array[0, 6, -1] loop
    begin
      perform public.submit_review('00000000-0000-0000-0000-000000000663', '00000000-0000-0000-0000-0000000066a1', bad, null, null, 'visit');
      raise notice 'FAIL rating: % stars was accepted', bad;
    exception when others then
      if sqlerrm like '%REVIEW_RATING_INVALID%' then
        raise notice 'PASS rating: % stars refuses with REVIEW_RATING_INVALID', bad;
      else
        raise notice 'FAIL rating: % stars gave %', bad, sqlerrm;
      end if;
    end;
  end loop;
  begin
    perform public.submit_review('00000000-0000-0000-0000-000000000663', '00000000-0000-0000-0000-0000000066a1', null, null, null, 'visit');
    raise notice 'FAIL rating: a null rating was accepted';
  exception when others then
    if sqlerrm like '%REVIEW_RATING_INVALID%' then
      raise notice 'PASS rating: a null rating refuses';
    else
      raise notice 'FAIL rating: null gave %', sqlerrm;
    end if;
  end;
end $$;

-- ---- block 8: hiding ----
do $$
declare v_hidden timestamptz; s record;
begin
  -- Two more visible reviews of V1, so the roll-up has something to average.
  perform public.submit_review('00000000-0000-0000-0000-000000000662', '00000000-0000-0000-0000-0000000066a1', 5, 'Great', 'Sam T.', 'visit');
  perform public.submit_review('00000000-0000-0000-0000-000000000663', '00000000-0000-0000-0000-0000000066a1', 4, null, null, 'onsite');

  update public.vendor_reviews set hidden_at = now(), hidden_by = 'op@example.com', hidden_reason = 'spam'
   where user_id = '00000000-0000-0000-0000-000000000661' and vendor_id = '00000000-0000-0000-0000-0000000066a1';
  perform public.submit_review('00000000-0000-0000-0000-000000000661', '00000000-0000-0000-0000-0000000066a1', 5, 'Please unhide me', null, 'visit');
  select hidden_at into v_hidden from public.vendor_reviews
   where user_id = '00000000-0000-0000-0000-000000000661' and vendor_id = '00000000-0000-0000-0000-0000000066a1';
  if v_hidden is not null then
    raise notice 'PASS hide: editing a hidden review leaves it hidden';
  else
    raise notice 'FAIL hide: an edit unhid the review';
  end if;

  select * into s from public.vendor_review_stats where vendor_id = '00000000-0000-0000-0000-0000000066a1';
  if s.review_count = 2 and s.avg_rating = 4.5 then
    raise notice 'PASS hide: the public roll-up counts the 2 visible reviews, average 4.5';
  else
    raise notice 'FAIL hide: roll-up count=% avg=%', s.review_count, s.avg_rating;
  end if;

  begin
    update public.vendor_reviews set hidden_at = now(), hidden_reason = null
     where user_id = '00000000-0000-0000-0000-000000000662' and vendor_id = '00000000-0000-0000-0000-0000000066a1';
    raise notice 'FAIL hide: hidden with no reason';
  exception when check_violation then
    raise notice 'PASS hide: a hide needs a reason';
  end;

  begin
    update public.vendor_reviews set hidden_at = now(), hidden_reason = 'negative'
     where user_id = '00000000-0000-0000-0000-000000000662' and vendor_id = '00000000-0000-0000-0000-0000000066a1';
    raise notice 'FAIL hide: hidden for being negative';
  exception when check_violation then
    raise notice 'PASS hide: there is no sentiment reason to hide with';
  end;
end $$;

-- ---- block 9: the points guard still bites outside the function ----
do $$
begin
  begin
    update public.point_balances set balance = 999999
     where user_id = '00000000-0000-0000-0000-000000000661' and vendor_id = '00000000-0000-0000-0000-0000000066a1';
    raise notice 'FAIL guard: a direct balance write went through';
  exception when others then
    raise notice 'PASS guard: a direct balance write is still refused (%)', left(sqlerrm, 60);
  end;
end $$;

-- ---- block 10: nothing reachable with the browser key ----
do $$
begin
  if not has_table_privilege('anon', 'public.vendor_reviews', 'select')
     and not has_table_privilege('authenticated', 'public.vendor_reviews', 'select')
     and not has_table_privilege('authenticated', 'public.vendor_reviews', 'insert')
     and has_table_privilege('service_role', 'public.vendor_reviews', 'select') then
    raise notice 'PASS grants: vendor_reviews is server-only';
  else
    raise notice 'FAIL grants: vendor_reviews is reachable from a browser role';
  end if;
  if not has_table_privilege('anon', 'public.vendor_review_stats', 'select')
     and not has_table_privilege('authenticated', 'public.vendor_review_stats', 'select') then
    raise notice 'PASS grants: vendor_review_stats is server-only';
  else
    raise notice 'FAIL grants: vendor_review_stats is reachable from a browser role';
  end if;
  if not has_function_privilege('anon', 'public.submit_review(uuid, uuid, integer, text, text, text)', 'execute')
     and not has_function_privilege('authenticated', 'public.submit_review(uuid, uuid, integer, text, text, text)', 'execute')
     and has_function_privilege('service_role', 'public.submit_review(uuid, uuid, integer, text, text, text)', 'execute') then
    raise notice 'PASS grants: only the server can call submit_review';
  else
    raise notice 'FAIL grants: submit_review is callable from a browser role';
  end if;
end $$;

-- ---- block 11: deleting the account takes the reviews down ----
do $$
begin
  delete from auth.users where id = '00000000-0000-0000-0000-000000000663';
  if not exists (select 1 from public.vendor_reviews where user_id = '00000000-0000-0000-0000-000000000663') then
    raise notice 'PASS delete: the account''s reviews went with it';
  else
    raise notice 'FAIL delete: a deleted account''s review is still published';
  end if;
end $$;

-- ---- block 12: an account merge carries reviews across ----
-- S2 (reviewed V1, V2, V4) is merged into S1 (reviewed V1). The account_merges
-- row is written before the profile delete, exactly as merge_student_accounts
-- (migration-057) orders them. V1 overlaps, so S2's V1 review goes with the
-- account; V2 and V4 become S1's — and a merged person cannot be paid for V2
-- or V4 again, because the unique index now sees S1 holding them.
do $$
declare r record;
begin
  insert into public.account_merges (winner_id, loser_id, loser_email)
  values ('00000000-0000-0000-0000-000000000661', '00000000-0000-0000-0000-000000000662', 's2-066@example.com');
  delete from auth.users where id = '00000000-0000-0000-0000-000000000662';

  if (select array_agg(vendor_id order by vendor_id) from public.vendor_reviews
       where user_id = '00000000-0000-0000-0000-000000000661')
     = array['00000000-0000-0000-0000-0000000066a1', '00000000-0000-0000-0000-0000000066a2', '00000000-0000-0000-0000-0000000066a4']::uuid[]
     and not exists (select 1 from public.vendor_reviews where user_id = '00000000-0000-0000-0000-000000000662') then
    raise notice 'PASS merge: the loser''s reviews moved to the winner, the overlap went with the account';
  else
    raise notice 'FAIL merge: winner holds % / loser still holds %',
      (select array_agg(vendor_id) from public.vendor_reviews where user_id = '00000000-0000-0000-0000-000000000661'),
      (select count(*) from public.vendor_reviews where user_id = '00000000-0000-0000-0000-000000000662');
  end if;

  if (select rating from public.vendor_reviews
       where user_id = '00000000-0000-0000-0000-000000000661' and vendor_id = '00000000-0000-0000-0000-0000000066a1') = 5 then
    raise notice 'PASS merge: on the overlapping spot the winner''s own review is the one kept';
  else
    raise notice 'FAIL merge: the overlapping review was replaced';
  end if;

  select * into r from public.submit_review(
    '00000000-0000-0000-0000-000000000661', '00000000-0000-0000-0000-0000000066a2',
    2, 'Second go', null, 'visit');
  if not r.created and r.points_awarded = 0 then
    raise notice 'PASS merge: reviewing a carried-over spot again is an edit and pays nothing';
  else
    raise notice 'FAIL merge: a carried-over spot paid again (created=% paid=%)', r.created, r.points_awarded;
  end if;
end $$;
