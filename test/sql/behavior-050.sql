-- Assertions for migration-050 (trackable poster QR codes).
--
-- The migration adds three tables and no functions, which makes it look like
-- there is nothing to assert. There are four things, and every one of them is a
-- promise made somewhere else in the stack that only this schema can keep:
--
--   * ONE AWARD PER ACCOUNT, EVER. The operator was told a printed code being
--     photographed and texted around does not matter, because the defence is
--     that an account is only new once. That defence is migration-039's
--     UNIQUE (ref_id, kind) index, and this file is where it is actually shown
--     to hold for kind = 'tracked_qr' rather than assumed to.
--
--   * A PAUSED BANNER STILL COUNTS. `active` gates the payout in
--     src/lib/tracked-qr.js, not the resolve. A banner already screwed to a wall
--     keeps resolving and keeps recording scans after an operator pauses it,
--     and if the schema quietly refused those rows the traffic numbers would go
--     flat and look like the poster stopped working.
--
--   * ZERO POINTS IS A SETTING, NOT A MISSING VALUE. A track-only banner is a
--     real thing the operator asked for. `points > 0` would have banned it.
--
--   * NOTHING REACHES THESE TABLES BUT THE SERVICE KEY. The anon key is the one
--     shipped to every browser; migration-037 exists because a default grant
--     once exposed tables through it, and that mistake recurs on every hosted
--     project.
--
-- NOT covered here, because it is not SQL: minting a unique code and retrying a
-- collision (src/lib/tracked-qr.js), and the evaluator that decides a signup came
-- through a banner at all. test/tracked-qr.test.js holds both.

do $$
declare
  s1     uuid := '00000000-0000-0000-0000-000000000501';
  s2     uuid := '00000000-0000-0000-0000-000000000502';
  qr_a   uuid;
  qr_b   uuid;
  n      integer;
  bal    integer;
begin
  -- ---------- the tables landed ----------

  select count(*) into n from information_schema.tables
   where table_schema = 'public'
     and table_name in ('tracked_qr_codes', 'tracked_qr_scans', 'tracked_qr_signups');
  if n = 3 then raise notice 'PASS 050: all three tables exist';
  else raise notice 'FAIL 050: expected 3 tables, found %', n; end if;

  insert into public.tracked_qr_codes (code, name, note, points, created_by)
  values ('hub7k2xq', 'HUB east entrance banner', 'above the water fountain', 25, 'ops@example.com')
  returning id into qr_a;

  -- ---------- zero points is allowed, out-of-range is not ----------

  insert into public.tracked_qr_codes (code, name, points)
  values ('track0nl', 'Track-only banner', 0)
  returning id into qr_b;
  raise notice 'PASS 050: a 0-point (track-only) banner is accepted';

  begin
    insert into public.tracked_qr_codes (code, name, points) values ('negpts01', 'Negative', -1);
    raise notice 'FAIL 050: a negative award was accepted';
  exception when check_violation then
    raise notice 'PASS 050: a negative award is refused';
  end;

  -- 5000 is signup-bonus.js's POINTS_MAX. A poster is a sibling of that deal,
  -- so a banner must not be able to pay more than the signup bonus can.
  begin
    insert into public.tracked_qr_codes (code, name, points) values ('bigpts01', 'Too rich', 5001);
    raise notice 'FAIL 050: a 5001-point award was accepted (points ceiling missing?)';
  exception when check_violation then
    raise notice 'PASS 050: an award above 5000 is refused by the column';
  end;

  -- ---------- a banner needs a name an operator can recognise ----------

  begin
    insert into public.tracked_qr_codes (code, name) values ('blank001', '   ');
    raise notice 'FAIL 050: a whitespace-only name was accepted';
  exception when check_violation then
    raise notice 'PASS 050: a whitespace-only name is refused';
  end;

  -- ---------- the code is the URL, so it has to be unique ----------

  begin
    insert into public.tracked_qr_codes (code, name) values ('hub7k2xq', 'Duplicate code');
    raise notice 'FAIL 050: a duplicate code was accepted (the mint loop has nothing to retry against)';
  exception when unique_violation then
    raise notice 'PASS 050: a duplicate code is refused';
  end;

  -- ---------- a paused banner still records traffic ----------

  update public.tracked_qr_codes set active = false where id = qr_b;
  insert into public.tracked_qr_scans (qr_id, visitor_hash, user_agent)
  values (qr_b, repeat('a', 64), 'Mozilla/5.0 (iPhone)');
  select count(*) into n from public.tracked_qr_scans where qr_id = qr_b;
  if n = 1 then raise notice 'PASS 050: a paused banner still records a scan';
  else raise notice 'FAIL 050: expected 1 scan on the paused banner, found %', n; end if;

  -- A refused cookie is a real case and must not lose the scan.
  insert into public.tracked_qr_scans (qr_id, visitor_hash) values (qr_a, null);
  insert into public.tracked_qr_scans (qr_id, visitor_hash) values (qr_a, repeat('b', 64));
  insert into public.tracked_qr_scans (qr_id, visitor_hash) values (qr_a, repeat('b', 64));
  select count(*) into n from public.tracked_qr_scans where qr_id = qr_a;
  if n = 3 then raise notice 'PASS 050: a scan with no visitor cookie is still counted';
  else raise notice 'FAIL 050: expected 3 scans on banner A, found %', n; end if;

  -- Uniques are a COUNT DISTINCT, which is the number /admin shows beside the
  -- raw total. Two scans from one phone are one visitor; the cookie-less scan
  -- is not a visitor at all, because there is nothing to tell it apart by.
  select count(distinct visitor_hash) into n from public.tracked_qr_scans where qr_id = qr_a;
  if n = 1 then raise notice 'PASS 050: two scans from one device count as one unique visitor';
  else raise notice 'FAIL 050: expected 1 unique visitor on banner A, found %', n; end if;

  -- ---------- the payout: once per account, ever ----------

  -- This is the whole anti-abuse story, exercised through the real rail rather
  -- than restated. kind = 'tracked_qr' and ref_id = the student, exactly as
  -- src/lib/tracked-qr.js passes them.
  perform public.grant_community_points(
    p_user_id      => s1,
    p_points       => 25,
    p_kind         => 'tracked_qr',
    p_reason       => 'Poster: HUB east entrance banner',
    p_incentive_id => null,
    p_ref_id       => s1,
    p_granted_by   => 'system'
  );
  insert into public.tracked_qr_signups (qr_id, user_id, points) values (qr_a, s1, 25);

  select balance into bal from public.community_balances where user_id = s1;
  if bal = 25 then raise notice 'PASS 050: the first poster signup is paid 25 points';
  else raise notice 'FAIL 050: expected a balance of 25, found %', bal; end if;

  -- The second attempt is what a shared photo of the banner looks like: same
  -- account, same kind. 039's index refuses it before any money moves.
  begin
    perform public.grant_community_points(
      p_user_id => s1, p_points => 25, p_kind => 'tracked_qr',
      p_reason => 'Poster: replayed', p_incentive_id => null,
      p_ref_id => s1, p_granted_by => 'system'
    );
    raise notice 'FAIL 050: the same account was paid a poster award twice';
  exception when others then
    if sqlerrm like '%GRANT_ALREADY_PAID%' then
      raise notice 'PASS 050: a second poster award to the same account is refused';
    else
      raise notice 'FAIL 050: expected GRANT_ALREADY_PAID, got %', sqlerrm;
    end if;
  end;

  select balance into bal from public.community_balances where user_id = s1;
  if bal = 25 then raise notice 'PASS 050: the refused replay moved no points';
  else raise notice 'FAIL 050: balance drifted to % after a refused replay', bal; end if;

  -- ONE BANNER MAY NOT CLAIM AN ACCOUNT A SECOND ONE ALREADY HAS. A track-only
  -- banner writes no grant, so 039's index is not watching it — this index is.
  begin
    insert into public.tracked_qr_signups (qr_id, user_id, points) values (qr_b, s1, 0);
    raise notice 'FAIL 050: a second banner claimed an account that was already attributed';
  exception when unique_violation then
    raise notice 'PASS 050: an account is attributed to exactly one banner';
  end;

  -- A DIFFERENT account through the SAME banner is the normal case and must work.
  insert into public.tracked_qr_signups (qr_id, user_id, points) values (qr_a, s2, 25);
  select count(*) into n from public.tracked_qr_signups where qr_id = qr_a;
  if n = 2 then raise notice 'PASS 050: one banner attributes many accounts';
  else raise notice 'FAIL 050: expected 2 signups on banner A, found %', n; end if;

  -- ---------- deleting a banner takes its telemetry, not its ledger ----------

  delete from public.tracked_qr_codes where id = qr_b;
  select count(*) into n from public.tracked_qr_scans where qr_id = qr_b;
  if n = 0 then raise notice 'PASS 050: deleting a banner cascades its scans away';
  else raise notice 'FAIL 050: % orphaned scans survived the delete', n; end if;

  -- The money does NOT go with it: community_grants has no FK to a poster, on
  -- purpose. An operator tidying up a mistyped banner must not erase what
  -- students were actually given.
  select count(*) into n from public.community_grants where kind = 'tracked_qr';
  if n = 1 then raise notice 'PASS 050: the payout ledger survives a banner delete';
  else raise notice 'FAIL 050: expected 1 tracked_qr grant to survive, found %', n; end if;
end $$;

-- ---------- the roll-up /admin actually reads ----------
--
-- Separate DO block because the one above ends by deleting a banner, and these
-- assertions are about what the view says once the dust has settled. Banner A
-- ('hub7k2xq') is left holding 3 scans from 1 identifiable device plus one
-- cookie-less scan, and 2 attributed accounts paid 25 each.
do $$
declare
  qr_a  uuid;
  n     integer;
  d     jsonb;
begin
  select id into qr_a from public.tracked_qr_codes where code = 'hub7k2xq';

  select scans into n from public.tracked_qr_overview where id = qr_a;
  if n = 3 then raise notice 'PASS 050: the view counts every scan';
  else raise notice 'FAIL 050: view reported % scans, expected 3', n; end if;

  -- The cookie-less scan is counted as traffic but not as a visitor: there is
  -- nothing to tell it apart by, and inventing an identity for it would make
  -- uniques drift upward every time a browser refused a cookie.
  select uniques into n from public.tracked_qr_overview where id = qr_a;
  if n = 1 then raise notice 'PASS 050: the view counts one unique visitor, ignoring the cookie-less scan';
  else raise notice 'FAIL 050: view reported % uniques, expected 1', n; end if;

  select signups into n from public.tracked_qr_overview where id = qr_a;
  if n = 2 then raise notice 'PASS 050: the view counts both attributed signups';
  else raise notice 'FAIL 050: view reported % signups, expected 2', n; end if;

  select points_awarded into n from public.tracked_qr_overview where id = qr_a;
  if n = 50 then raise notice 'PASS 050: the view sums the points actually paid';
  else raise notice 'FAIL 050: view reported % points awarded, expected 50', n; end if;

  -- A banner nobody has scanned must read 0, not vanish from the list. The
  -- left join lateral is what guarantees that; an inner join would silently
  -- hide every new poster until its first scan.
  insert into public.tracked_qr_codes (code, name) values ('freshqr1', 'Never scanned');
  select scans into n from public.tracked_qr_overview where code = 'freshqr1';
  if n = 0 then raise notice 'PASS 050: an unscanned banner still appears, reading 0';
  else raise notice 'FAIL 050: unscanned banner reported % scans', n; end if;

  -- ---------- the detail panel's two series ----------

  d := public.tracked_qr_detail(qr_a, 30, 'America/New_York');

  select jsonb_array_length(d -> 'daily') into n;
  if n = 30 then raise notice 'PASS 050: the daily series has one bucket per day, gaps included';
  else raise notice 'FAIL 050: daily series had % buckets, expected 30', n; end if;

  select jsonb_array_length(d -> 'hourly') into n;
  if n = 24 then raise notice 'PASS 050: the hour-of-day histogram has all 24 buckets';
  else raise notice 'FAIL 050: hourly series had % buckets, expected 24', n; end if;

  select sum((e ->> 'scans')::int) into n from jsonb_array_elements(d -> 'daily') e;
  if n = 3 then raise notice 'PASS 050: the daily series accounts for every scan in the window';
  else raise notice 'FAIL 050: daily series summed to %, expected 3', n; end if;

  select sum((e ->> 'scans')::int) into n from jsonb_array_elements(d -> 'hourly') e;
  if n = 3 then raise notice 'PASS 050: the hourly histogram accounts for every scan in the window';
  else raise notice 'FAIL 050: hourly series summed to %, expected 3', n; end if;

  -- A clamped window, so a hand-typed ?days=99999 cannot ask for a series with
  -- a hundred thousand buckets in it.
  select jsonb_array_length(public.tracked_qr_detail(qr_a, 99999) -> 'daily') into n;
  if n = 365 then raise notice 'PASS 050: an absurd day count is clamped to 365';
  else raise notice 'FAIL 050: days=99999 produced % buckets, expected 365', n; end if;

  -- ---------- nothing here is reachable with the browser key ----------
  --
  -- The anon key ships to every phone. migration-037 exists because a default
  -- ACL once exposed tables through it, and that mistake recurs on every hosted
  -- project, so every new object gets asserted rather than assumed.
  select count(*) into n
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('tracked_qr_codes', 'tracked_qr_scans', 'tracked_qr_signups', 'tracked_qr_overview')
     and grantee in ('anon', 'authenticated');
  if n = 0 then raise notice 'PASS 050: anon and authenticated hold no privilege on any tracked-QR object';
  else raise notice 'FAIL 050: % browser-key privileges are still granted', n; end if;

  select count(*) into n
    from information_schema.role_routine_grants
   where routine_schema = 'public'
     and routine_name = 'tracked_qr_detail'
     and grantee in ('anon', 'authenticated');
  if n = 0 then raise notice 'PASS 050: anon and authenticated cannot execute tracked_qr_detail';
  else raise notice 'FAIL 050: tracked_qr_detail is executable by % browser role(s)', n; end if;
end $$;
