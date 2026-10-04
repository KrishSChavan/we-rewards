-- Assertions for migration-062 (notification log + read-only queue functions).
--
-- Three different kinds of promise, and they fail in different ways.
--
-- THE TABLE is a privacy surface before it is a feature: it records who we
-- messaged and when, so anon/authenticated must hold nothing on it, a student's
-- rows must go with their profile, and the columns that could carry a delivery
-- event we promised never to keep (opens, clicks) must refuse it at the
-- database. Those are asserted as REFUSALS, not as the happy path.
--
-- THE BACKFILL can be wrong by duplication (one row per campaign instead of per
-- notification, or a second copy on re-paste) far more easily than by omission,
-- so every kind is asserted as an EXACT count and the file applies the
-- migration a second time in the middle (block 3) and asserts nothing moved.
--
-- THE QUEUE FUNCTIONS have one failure that matters more than any wrong
-- blocker: WRITING. They mirror claims that expire rows, requeue stuck ones and
-- insert state rows; a screen that refreshes every fifteen seconds and quietly
-- did any of that would change who gets notified. So block 9 re-reads every row
-- a claim would have touched and asserts it is untouched.
--
-- Clock: now() is the transaction timestamp, fixed for a whole DO block, and
-- every queue function defaults p_now to now(), so "next eligible = now()"
-- is an exact comparison. Time-based expectations are computed from the STORED
-- seed values (deliver_after, last_push_at, ...), never from a second now().
-- Quiet hours are (0, 0) - disabled - everywhere except the blocks that test
-- them, which build a one-hour window around the container's current UTC hour
-- so the expected answer is known whatever time the suite runs.

-- ============================================================
-- block 1: the table, its constraints and who may touch it
-- ============================================================
do $$
declare
  n integer;
  ok boolean;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'notification_log'
     and column_name in ('id','created_at','channel','kind','outcome','reason','recipient_kind',
                         'student_id','recipient_user_id','recipient_email','recipient_label',
                         'vendor_id','title','body','url','template','ref','devices',
                         'devices_tried','devices_accepted','provider_id','delivery_status',
                         'delivery_at','source','dedupe_key');
  if n = 25 then raise notice 'PASS T1: notification_log has all 25 contract columns';
  else raise notice 'FAIL T1: notification_log has % of the 25 contract columns', n; end if;

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'push_subscriptions' and column_name = 'device_label';
  if n = 1 then raise notice 'PASS T2: push_subscriptions.device_label exists';
  else raise notice 'FAIL T2: push_subscriptions.device_label missing'; end if;

  -- The upsert the live writers send is `on conflict (dedupe_key)`, which only
  -- matches a plain unique constraint (or a non-partial unique index).
  select count(*) into n
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
   where c.conrelid = 'public.notification_log'::regclass and c.contype = 'u'
     and a.attname = 'dedupe_key' and array_length(c.conkey, 1) = 1;
  if n = 1 then raise notice 'PASS T3: dedupe_key is a plain UNIQUE constraint (PostgREST on_conflict can target it)';
  else raise notice 'FAIL T3: dedupe_key has % single-column unique constraints', n; end if;

  select relrowsecurity into ok from pg_class where oid = 'public.notification_log'::regclass;
  if ok then raise notice 'PASS T4: RLS is enabled on notification_log';
  else raise notice 'FAIL T4: RLS is off on notification_log'; end if;

  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'notification_log';
  if n = 0 then raise notice 'PASS T5: notification_log has no policies (service_role only)';
  else raise notice 'FAIL T5: notification_log has % policies', n; end if;

  if not has_table_privilege('anon', 'public.notification_log', 'select')
     and not has_table_privilege('anon', 'public.notification_log', 'insert')
     and not has_table_privilege('anon', 'public.notification_log', 'update')
     and not has_table_privilege('anon', 'public.notification_log', 'delete')
     and not has_table_privilege('authenticated', 'public.notification_log', 'select')
     and not has_table_privilege('authenticated', 'public.notification_log', 'insert')
     and not has_table_privilege('authenticated', 'public.notification_log', 'update')
     and not has_table_privilege('authenticated', 'public.notification_log', 'delete') then
    raise notice 'PASS T6: anon and authenticated hold no DML on notification_log';
  else raise notice 'FAIL T6: anon or authenticated can touch notification_log'; end if;

  if has_table_privilege('service_role', 'public.notification_log', 'select')
     and has_table_privilege('service_role', 'public.notification_log', 'insert')
     and has_table_privilege('service_role', 'public.notification_log', 'update')
     and has_table_privilege('service_role', 'public.notification_log', 'delete') then
    raise notice 'PASS T7: service_role can select/insert/update/delete';
  else raise notice 'FAIL T7: service_role is missing a privilege on notification_log'; end if;

  -- Refusals. Each in its own subtransaction so one success cannot hide.
  begin
    insert into public.notification_log (channel, kind, outcome, recipient_kind) values ('sms', 'deal', 'sent', 'student');
    raise notice 'FAIL T8: channel ''sms'' was accepted';
  exception when check_violation then raise notice 'PASS T8: channel outside push/email is refused';
  end;
  begin
    insert into public.notification_log (channel, kind, outcome, recipient_kind) values ('push', 'deal', 'delivered', 'student');
    raise notice 'FAIL T9: outcome ''delivered'' was accepted';
  exception when check_violation then raise notice 'PASS T9: outcome outside sent/failed/refused/allowed is refused';
  end;
  begin
    insert into public.notification_log (channel, kind, outcome, recipient_kind) values ('push', 'deal', 'sent', 'robot');
    raise notice 'FAIL T10: recipient_kind ''robot'' was accepted';
  exception when check_violation then raise notice 'PASS T10: unknown recipient_kind is refused';
  end;
  -- THE privacy one: opens and clicks are never stored, and the column itself
  -- will not hold them even if a future webhook change tried.
  begin
    insert into public.notification_log (channel, kind, outcome, recipient_kind, delivery_status)
    values ('email', 'deal', 'sent', 'student', 'opened');
    raise notice 'FAIL T11: delivery_status ''opened'' was accepted';
  exception when check_violation then raise notice 'PASS T11: delivery_status ''opened'' is refused (no open/click tracking)';
  end;
  begin
    insert into public.notification_log (channel, kind, outcome, recipient_kind, source) values ('push', 'deal', 'sent', 'student', 'guess');
    raise notice 'FAIL T12: source ''guess'' was accepted';
  exception when check_violation then raise notice 'PASS T12: source outside live/backfill is refused';
  end;

  -- kind has NO check, deliberately (a new kind must not need a migration).
  -- Inserted and rolled back via a forced exception.
  begin
    insert into public.notification_log (channel, kind, outcome, recipient_kind) values ('push', 'brand_new_kind', 'sent', 'other');
    raise notice 'PASS T13: an unknown kind is accepted by the database (Node validates it)';
    raise exception 'rollback';
  exception when raise_exception then null;
  end;

  -- Defaults the Node writer relies on.
  begin
    insert into public.notification_log (channel, kind, outcome, recipient_kind) values ('push', 'deal', 'refused', 'student')
    returning (ref = '{}'::jsonb and devices = '[]'::jsonb and devices_tried = 0 and devices_accepted = 0
               and source = 'live' and created_at = now()) into ok;
    if ok then raise notice 'PASS T14: ref/devices/counters/source/created_at default as the contract says';
    else raise notice 'FAIL T14: a default is wrong'; end if;
    raise exception 'rollback';
  exception when raise_exception then null;
  end;
end;
$$;

-- ============================================================
-- block 2: the backfill, kind by kind, exact counts
-- ============================================================
do $$
declare
  bfa  uuid := '00000000-0000-0000-0000-000000062013';
  bfb  uuid := '00000000-0000-0000-0000-000000062014';
  bfc  uuid := '00000000-0000-0000-0000-000000062015';
  bcs  uuid := '00000000-0000-0000-0000-000000062016';
  nb   uuid := '00000000-0000-0000-0000-000000062017';
  r    record;
  n    integer;
begin
  select count(*) into n from public.notification_log;
  if n = 8 then raise notice 'PASS B1: the backfill wrote exactly 8 rows (5 deal, 1 broadcast, 2 nearby)';
  else raise notice 'FAIL B1: the backfill wrote % rows, wanted 8', n; end if;

  select count(*) into n from public.notification_log where source <> 'backfill';
  if n = 0 then raise notice 'PASS B2: every imported row is source = backfill';
  else raise notice 'FAIL B2: % imported rows are not marked backfill', n; end if;

  select count(*) into n from public.notification_log where kind = 'deal';
  if n = 5 then raise notice 'PASS B3: 5 deal rows (one per notification, the 40-day-old send excluded)';
  else raise notice 'FAIL B3: % deal rows, wanted 5', n; end if;

  -- BF_A: two campaigns, one batch, ONE row.
  select count(*) into n from public.notification_log where student_id = bfa;
  select * into r from public.notification_log where student_id = bfa;
  if n = 1 and r.title = '2 spots have something on' and r.body is null
     and jsonb_array_length(r.ref -> 'campaignIds') = 2
     and r.ref ->> 'batch' = '00000000-0000-0000-0000-0000000620e5'
     and (r.ref ->> 'imported')::boolean
     and r.dedupe_key = 'deal:00000000-0000-0000-0000-0000000620e5'
     and r.channel = 'push' and r.outcome = 'sent' and r.recipient_kind = 'student'
     and r.vendor_id = '00000000-0000-0000-0000-0000000620b1'      -- the FIRST campaign's vendor
     and r.created_at = (select max(pushed_at) from public.campaign_recipients
                          where push_batch = '00000000-0000-0000-0000-0000000620e5') then
    raise notice 'PASS B4: a two-campaign bundle is ONE row, "2 spots have something on", both ids in ref';
  else raise notice 'FAIL B4: bundle imported as % rows / title % / ref %', n, r.title, r.ref; end if;

  -- BF_B: email fallback.
  select * into r from public.notification_log where student_id = bfb;
  if r.channel = 'email' and r.title = 'Emailed deal 062' and r.body is null
     and r.recipient_email = 'bfb-062@example.com' then
    raise notice 'PASS B5: an email-fallback send imports as channel email, NO body, with the address';
  else raise notice 'FAIL B5: email import is channel % body % email %', r.channel, r.body, r.recipient_email; end if;

  -- BF_C: no push_batch, null channel (pre-047).
  select count(*) into n from public.notification_log where student_id = bfc;
  select * into r from public.notification_log where student_id = bfc;
  if n = 1 and r.channel = 'push' and r.title = 'Unbatched deal 062' and r.body = 'Old style.'
     and r.dedupe_key = 'deal:c:00000000-0000-0000-0000-0000000620c9:' || bfc::text
     and r.ref -> 'batch' = 'null'::jsonb then
    raise notice 'PASS B6: an unbatched send imports once, keyed deal:c:<campaign>:<user>, channel defaulting to push';
  else raise notice 'FAIL B6: unbatched import % rows, key %, channel %', n, r.dedupe_key, r.channel; end if;

  -- Broadcasts: the sent one, not the 40-day one, not any queued one.
  select count(*) into n from public.notification_log where kind = 'broadcast';
  select * into r from public.notification_log where kind = 'broadcast';
  if n = 1 and r.student_id = bcs and r.title = 'Sent broadcast 062' and r.body = 'Delivered yesterday.'
     and r.url = '/?tab=deals' and r.ref ->> 'broadcastId' = '00000000-0000-0000-0000-0000000620d4'
     and r.dedupe_key = 'broadcast:00000000-0000-0000-0000-0000000620d4:' || bcs::text then
    raise notice 'PASS B7: exactly one broadcast row: the sent one inside 30 days, with its copy and key';
  else raise notice 'FAIL B7: % broadcast rows; first is %', n, r; end if;

  -- Nearby: 'allowed', never 'sent'; the 40-day claim excluded.
  select count(*) into n from public.notification_log where kind = 'nearby' and student_id = nb;
  select * into r from public.notification_log where kind = 'nearby' and student_id = nb;
  if n = 1 and r.outcome = 'allowed' and r.title = 'You''re near Main Spot 062'
     and r.url = '/?spot=00000000-0000-0000-0000-0000000620b1'
     and r.ref ->> 'shownBy' = 'device'
     and r.dedupe_key = 'nearby:' || nb::text || ':00000000-0000-0000-0000-0000000620b1' then
    raise notice 'PASS B8: a nearby claim imports as outcome allowed (shown by device), the 40-day one excluded';
  else raise notice 'FAIL B8: % nearby rows for NB; outcome %', n, r.outcome; end if;

  select count(*) into n from public.notification_log where outcome = 'sent' and kind = 'nearby';
  if n = 0 then raise notice 'PASS B9: no nearby row claims to have been "sent"';
  else raise notice 'FAIL B9: % nearby rows say sent', n; end if;

  -- Nothing older than 30 days came in at all.
  select count(*) into n from public.notification_log where created_at < now() - interval '30 days';
  if n = 0 then raise notice 'PASS B10: nothing older than 30 days was imported';
  else raise notice 'FAIL B10: % imported rows are older than 30 days', n; end if;

  -- Queued deals are not "sent" notifications.
  select count(*) into n from public.notification_log
   where ref -> 'campaignIds' ? '00000000-0000-0000-0000-0000000620c1';
  if n = 0 then raise notice 'PASS B11: queued/sending deal rows were not imported';
  else raise notice 'FAIL B11: % rows reference the still-queued campaign', n; end if;
end;
$$;

-- ============================================================
-- block 3: idempotency - apply the whole migration a second time
-- ============================================================
-- Before re-applying, swap BF_B's imported row for what the LIVE email writer
-- leaves behind (a source='live' row carrying ref.batch and NO dedupe_key).
-- That is the one case dedupe_key alone cannot catch, so a re-paste after
-- go-live would import a second copy of every email fallback without the
-- migration's ref->>'batch' guard.
create temp table _n062 as select count(*)::integer as n from public.notification_log;

do $$
begin
  delete from public.notification_log where dedupe_key = 'deal:00000000-0000-0000-0000-0000000620e6';
  insert into public.notification_log (channel, kind, outcome, recipient_kind, student_id, title, ref, source)
  values ('email', 'deal', 'sent', 'student', '00000000-0000-0000-0000-000000062014', 'Emailed deal 062',
          jsonb_build_object('batch', '00000000-0000-0000-0000-0000000620e6', 'fallback', true), 'live');
end;
$$;

\i /tmp/20261003120000_migration-062.sql

do $$
declare
  before integer := (select n from _n062);
  n integer;
  src text;
begin
  select count(*) into n from public.notification_log;
  if n = before then raise notice 'PASS I1: re-applying migration-062 adds no rows (% before, % after)', before, n;
  else raise notice 'FAIL I1: re-applying migration-062 changed the row count from % to %', before, n; end if;

  select count(*), min(source) into n, src from public.notification_log
   where ref ->> 'batch' = '00000000-0000-0000-0000-0000000620e6';
  if n = 1 and src = 'live' then
    raise notice 'PASS I2: a live email-fallback row (no dedupe_key) is not re-imported beside on re-paste';
  else raise notice 'FAIL I2: batch e6 now has % rows (sources %)', n, src; end if;

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'push_subscriptions' and column_name = 'device_label';
  if n = 1 then raise notice 'PASS I3: device_label still exists exactly once after a re-paste';
  else raise notice 'FAIL I3: device_label count %', n; end if;
end;
$$;

-- ============================================================
-- block 4: functions are declared the way the contract requires
-- ============================================================
do $$
declare
  f   text;
  p   record;
  bad text := '';
begin
  foreach f in array array[
    'public.admin_campaign_queue(integer, boolean, integer, integer, integer, integer, integer, integer, text, timestamptz, uuid)',
    'public.admin_broadcast_queue(integer, integer, integer, integer, integer, integer, text, timestamptz, uuid)',
    'public.admin_reminder_queue(integer, integer, integer, integer, integer, integer, integer, text, timestamptz)',
    'public.admin_student_notify_budget(uuid, integer, integer, integer, integer, integer, text, timestamptz)'
  ] loop
    select pr.prosecdef, pr.provolatile, l.lanname, pr.proconfig into p
      from pg_proc pr join pg_language l on l.oid = pr.prolang
     where pr.oid = f::regprocedure;
    -- plpgsql so a body naming a not-yet-applied 060/061 object still CREATES;
    -- STABLE so a write inside raises; definer with a pinned search_path.
    if not (p.prosecdef and p.provolatile = 's' and p.lanname = 'plpgsql'
            and 'search_path=public' = any(p.proconfig)) then
      bad := bad || f || ' ';
    end if;
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')
       or not has_function_privilege('service_role', f, 'execute') then
      bad := bad || f || '(grants) ';
    end if;
  end loop;
  if bad = '' then raise notice 'PASS F1: all four queue functions are plpgsql, STABLE, SECURITY DEFINER, search_path pinned, service_role only';
  else raise notice 'FAIL F1: %', bad; end if;

  if has_function_privilege('anon', 'public.prune_notification_log(integer)', 'execute')
     or has_function_privilege('authenticated', 'public.prune_notification_log(integer)', 'execute')
     or not has_function_privilege('service_role', 'public.prune_notification_log(integer)', 'execute') then
    raise notice 'FAIL F2: prune_notification_log grants are wrong';
  else raise notice 'PASS F2: prune_notification_log is service_role only'; end if;

  if has_function_privilege('anon', 'public.admin_next_outside_quiet(timestamptz, integer, integer, text)', 'execute') then
    raise notice 'FAIL F3: anon can execute admin_next_outside_quiet';
  else raise notice 'PASS F3: admin_next_outside_quiet is not executable by anon'; end if;

  -- The pre-p_user_id overloads must be gone: beside the wider one, a named
  -- call that omits p_user_id matches both and fails as "not unique".
  if to_regprocedure('public.admin_campaign_queue(integer, boolean, integer, integer, integer, integer, integer, integer, text, timestamptz)') is null
     and to_regprocedure('public.admin_broadcast_queue(integer, integer, integer, integer, integer, integer, text, timestamptz)') is null
     and (select count(*) from pg_proc where proname in ('admin_campaign_queue', 'admin_broadcast_queue')
            and pronamespace = 'public'::regnamespace) = 2 then
    raise notice 'PASS F4: exactly one admin_campaign_queue and one admin_broadcast_queue (the narrower overloads are dropped)';
  else raise notice 'FAIL F4: a pre-p_user_id overload of a queue function survives'; end if;
end;
$$;

-- ============================================================
-- block 5: admin_next_outside_quiet, pure
-- ============================================================
do $$
declare t timestamptz;
begin
  t := public.admin_next_outside_quiet('2026-10-03 23:30+00', 22, 9, 'UTC');
  if t = '2026-10-04 09:00+00' then raise notice 'PASS Q1: 23:30 in a 22-9 window -> 09:00 NEXT day';
  else raise notice 'FAIL Q1: got %', t; end if;

  t := public.admin_next_outside_quiet('2026-10-03 03:00+00', 22, 9, 'UTC');
  if t = '2026-10-03 09:00+00' then raise notice 'PASS Q2: 03:00 in a 22-9 window -> 09:00 the SAME day';
  else raise notice 'FAIL Q2: got %', t; end if;

  t := public.admin_next_outside_quiet('2026-10-03 09:00+00', 22, 9, 'UTC');
  if t = '2026-10-03 09:00+00' then raise notice 'PASS Q3: the end hour itself is outside the window (end exclusive, like the claims)';
  else raise notice 'FAIL Q3: got %', t; end if;

  t := public.admin_next_outside_quiet('2026-10-03 22:00+00', 22, 9, 'UTC');
  if t = '2026-10-04 09:00+00' then raise notice 'PASS Q4: the start hour is inside the window (start inclusive)';
  else raise notice 'FAIL Q4: got %', t; end if;

  t := public.admin_next_outside_quiet('2026-10-03 12:34+00', 22, 9, 'UTC');
  if t = '2026-10-03 12:34+00' then raise notice 'PASS Q5: outside the window returns the input unchanged';
  else raise notice 'FAIL Q5: got %', t; end if;

  t := public.admin_next_outside_quiet('2026-10-03 03:00+00', 5, 5, 'UTC');
  if t = '2026-10-03 03:00+00' then raise notice 'PASS Q6: start = end disables quiet hours';
  else raise notice 'FAIL Q6: got %', t; end if;

  t := public.admin_next_outside_quiet('2026-10-03 02:15+00', 1, 5, 'UTC');
  if t = '2026-10-03 05:00+00' then raise notice 'PASS Q7: a non-wrapping window (1-5) ends at 05:00';
  else raise notice 'FAIL Q7: got %', t; end if;

  t := public.admin_next_outside_quiet('2026-10-03 06:00+00', 1, 5, 'UTC');
  if t = '2026-10-03 06:00+00' then raise notice 'PASS Q8: after a non-wrapping window is outside it';
  else raise notice 'FAIL Q8: got %', t; end if;

  -- Campus-local: 02:30Z on Oct 4 is 22:30 EDT on Oct 3, so quiet ends at
  -- 09:00 EDT on Oct 4 = 13:00Z.
  t := public.admin_next_outside_quiet('2026-10-04 02:30+00', 22, 9, 'America/New_York');
  if t = '2026-10-04 13:00+00' then raise notice 'PASS Q9: the window is evaluated in campus time (America/New_York)';
  else raise notice 'FAIL Q9: got %', t; end if;

  if public.admin_next_outside_quiet(null, 22, 9, 'UTC') is null then raise notice 'PASS Q10: null in, null out';
  else raise notice 'FAIL Q10: null input returned a value'; end if;
end;
$$;

-- ============================================================
-- block 6: admin_campaign_queue
-- ============================================================
do $$
declare
  c_main uuid := '00000000-0000-0000-0000-0000000620c1';
  ready  uuid := '00000000-0000-0000-0000-000000062001';
  hold   uuid := '00000000-0000-0000-0000-000000062002';
  cool   uuid := '00000000-0000-0000-0000-000000062003';
  daily  uuid := '00000000-0000-0000-0000-000000062004';
  weekly uuid := '00000000-0000-0000-0000-000000062005';
  stale  uuid := '00000000-0000-0000-0000-000000062006';
  vend   uuid := '00000000-0000-0000-0000-000000062007';
  email  uuid := '00000000-0000-0000-0000-000000062008';
  supp   uuid := '00000000-0000-0000-0000-000000062009';
  optout uuid := '00000000-0000-0000-0000-00000006200a';
  nostat uuid := '00000000-0000-0000-0000-00000006200b';
  sendg  uuid := '00000000-0000-0000-0000-00000006200c';
  stuck  uuid := '00000000-0000-0000-0000-00000006200d';
  exp    uuid := '00000000-0000-0000-0000-00000006200e';
  canc   uuid := '00000000-0000-0000-0000-00000006200f';
  q      record;
  n      integer;
  t      timestamptz;
begin
  create temp table _cq on commit drop as
    select * from public.admin_campaign_queue(p_limit => 1000, p_quiet_start => 0, p_quiet_end => 0);

  select count(*) into n from _cq;
  select total_queued into q from _cq limit 1;
  if n = 15 and q.total_queued = 15 then raise notice 'PASS C1: 15 waiting rows (13 on the live campaign + expired + cancelled), total_queued agrees';
  else raise notice 'FAIL C1: % rows, total_queued %', n, q.total_queued; end if;

  select * into q from _cq limit 1;
  if q.user_id = exp then raise notice 'PASS C2: ordered by campaign created_at (the oldest campaign first)';
  else raise notice 'FAIL C2: first row is user %', q.user_id; end if;

  select max(total_queued) into n from public.admin_campaign_queue(p_limit => 2, p_quiet_start => 0, p_quiet_end => 0);
  if n = 15 and (select count(*) from public.admin_campaign_queue(p_limit => 2, p_quiet_start => 0, p_quiet_end => 0)) = 2 then
    raise notice 'PASS C3: p_limit caps the rows; total_queued is the count BEFORE the limit';
  else raise notice 'FAIL C3: total_queued under a limit is %', n; end if;

  select * into q from _cq where user_id = ready and campaign_id = c_main;
  if q.blockers = '{}'::text[] and q.next_eligible_at = now() and q.has_push and q.title = 'Main deal 062' then
    raise notice 'PASS C4: an eligible student has no blockers and is eligible now';
  else raise notice 'FAIL C4: READY blockers % next %', q.blockers, q.next_eligible_at; end if;

  -- READY heard from OTHER Spot 2h ago; this is MAIN Spot's deal.
  if not ('vendor_cooldown' = any(q.blockers)) then
    raise notice 'PASS C5: a recent send from a DIFFERENT vendor is not a vendor_cooldown';
  else raise notice 'FAIL C5: READY shows vendor_cooldown for another vendor''s send'; end if;

  select * into q from _cq where user_id = hold;
  if q.blockers = '{hold}'::text[]
     and q.next_eligible_at = (select deliver_after from public.campaign_recipients where campaign_id = c_main and user_id = hold) then
    raise notice 'PASS C6: the coalescing window is "hold", released at deliver_after';
  else raise notice 'FAIL C6: HOLD blockers % next %', q.blockers, q.next_eligible_at; end if;

  select * into q from _cq where user_id = cool;
  if q.blockers = '{cooldown}'::text[]
     and q.next_eligible_at = (select last_push_at + interval '240 minutes' from public.student_notify_state where user_id = cool) then
    raise notice 'PASS C7: inside the 240-minute cooldown, released at last_push_at + 240m';
  else raise notice 'FAIL C7: COOL blockers % next %', q.blockers, q.next_eligible_at; end if;

  select * into q from _cq where user_id = daily;
  if q.blockers = '{daily_cap}'::text[]
     and q.next_eligible_at = (select day_start + interval '24 hours' from public.student_notify_state where user_id = daily) then
    raise notice 'PASS C8: two sends today is daily_cap, released when the day window rolls';
  else raise notice 'FAIL C8: DAILY blockers % next %', q.blockers, q.next_eligible_at; end if;

  select * into q from _cq where user_id = weekly;
  if q.blockers = '{weekly_cap}'::text[]
     and q.next_eligible_at = (select week_start + interval '7 days' from public.student_notify_state where user_id = weekly) then
    raise notice 'PASS C9: five this week is weekly_cap (a stale day window is not also a daily_cap)';
  else raise notice 'FAIL C9: WEEKLY blockers % next %', q.blockers, q.next_eligible_at; end if;

  select * into q from _cq where user_id = stale;
  if q.blockers = '{}'::text[] and q.next_eligible_at = now() then
    raise notice 'PASS C10: a capped-out count on a day window that has rolled over blocks nothing (the claim zeroes it)';
  else raise notice 'FAIL C10: STALE blockers % next %', q.blockers, q.next_eligible_at; end if;

  select * into q from _cq where user_id = vend and campaign_id = c_main;
  if q.blockers = '{vendor_cooldown}'::text[]
     and q.next_eligible_at = (select pushed_at + interval '20 hours' from public.campaign_recipients
                                where user_id = vend and status = 'sent') then
    raise notice 'PASS C11: heard from this vendor 2h ago is vendor_cooldown, released 20h after that send';
  else raise notice 'FAIL C11: VENDOR blockers % next %', q.blockers, q.next_eligible_at; end if;

  select * into q from _cq where user_id = email;
  if q.blockers = '{no_device,no_channel}'::text[] and q.next_eligible_at is null
     and not q.has_push and not q.email_reachable then
    raise notice 'PASS C12: no device and email off -> no_device + no_channel, never eligible';
  else raise notice 'FAIL C12: EMAIL blockers % next % push % mail %', q.blockers, q.next_eligible_at, q.has_push, q.email_reachable; end if;

  select * into q from _cq where user_id = optout;
  if q.blockers = '{push_opt_out,no_channel}'::text[] and q.next_eligible_at is null and not q.has_push then
    raise notice 'PASS C13: push switched off (endpoint still present) -> push_opt_out + no_channel, has_push false';
  else raise notice 'FAIL C13: OPTOUT blockers % push %', q.blockers, q.has_push; end if;

  select * into q from _cq where user_id = nostat;
  if q.blockers = '{}'::text[] and q.has_push and q.next_eligible_at = now() then
    raise notice 'PASS C14: no notify-state row reads as the claim''s defaults (switches on, counters empty)';
  else raise notice 'FAIL C14: NOSTATE blockers % push %', q.blockers, q.has_push; end if;

  select * into q from _cq where user_id = sendg;
  if q.blockers = '{sending}'::text[] and q.next_eligible_at is null and q.status = 'sending' and q.claimed_at is not null then
    raise notice 'PASS C15: claimed 2 minutes ago is "sending", alone, with no next time';
  else raise notice 'FAIL C15: SENDING blockers % next %', q.blockers, q.next_eligible_at; end if;

  select * into q from _cq where user_id = stuck;
  if q.blockers = '{stuck}'::text[] and q.next_eligible_at is null then
    raise notice 'PASS C16: claimed 15 minutes ago is "stuck" (past the claim''s 10-minute recovery)';
  else raise notice 'FAIL C16: STUCK blockers %', q.blockers; end if;

  select * into q from _cq where user_id = exp;
  if q.blockers = '{expired}'::text[] and q.next_eligible_at is null then
    raise notice 'PASS C17: a queued row on an expired campaign is "expired" ALONE (its cooldown is not listed)';
  else raise notice 'FAIL C17: EXP blockers %', q.blockers; end if;

  select * into q from _cq where user_id = canc;
  if q.blockers = '{cancelled}'::text[] and q.next_eligible_at is null then
    raise notice 'PASS C18: a vendor-cancelled deal reads "cancelled", not "expired"';
  else raise notice 'FAIL C18: CANC blockers %', q.blockers; end if;

  -- Email on: EMAIL becomes reachable, SUPP does not (suppressed address).
  select * into q from public.admin_campaign_queue(p_limit => 1000, p_email_enabled => true, p_quiet_start => 0, p_quiet_end => 0)
   where user_id = email;
  if q.blockers = '{}'::text[] and q.email_reachable and not q.has_push and q.next_eligible_at = now() then
    raise notice 'PASS C19: with email enabled a device-less student is email_reachable and unblocked';
  else raise notice 'FAIL C19: EMAIL (email on) blockers % mail %', q.blockers, q.email_reachable; end if;

  select * into q from public.admin_campaign_queue(p_limit => 1000, p_email_enabled => true, p_quiet_start => 0, p_quiet_end => 0)
   where user_id = supp;
  if q.blockers = '{no_device,no_channel}'::text[] and not q.email_reachable then
    raise notice 'PASS C20: a suppressed address is not email_reachable even with email on';
  else raise notice 'FAIL C20: SUPP (email on) blockers % mail %', q.blockers, q.email_reachable; end if;

  select * into q from public.admin_campaign_queue(p_limit => 1000, p_email_enabled => true, p_quiet_start => 0, p_quiet_end => 0)
   where user_id = optout;
  if q.blockers = '{push_opt_out,no_channel}'::text[] then
    raise notice 'PASS C21: email on does not reach a student whose email switch is also off';
  else raise notice 'FAIL C21: OPTOUT (email on) blockers %', q.blockers; end if;
end;
$$;

-- ============================================================
-- block 7: quiet hours in the queue (a window around the current UTC hour)
-- ============================================================
do $$
declare
  ready uuid := '00000000-0000-0000-0000-000000062001';
  cool  uuid := '00000000-0000-0000-0000-000000062003';
  h     integer := extract(hour from (now() at time zone 'UTC'))::integer;
  rel   timestamptz;
  h3    integer;
  q     record;
begin
  -- Quiet NOW: [h, h+1).
  select * into q from public.admin_campaign_queue(p_limit => 1000, p_quiet_start => h, p_quiet_end => (h + 1) % 24, p_timezone => 'UTC')
   where user_id = ready and campaign_id = '00000000-0000-0000-0000-0000000620c1';
  if q.blockers = '{quiet_hours}'::text[]
     and q.next_eligible_at = (date_trunc('hour', now() at time zone 'UTC') + interval '1 hour') at time zone 'UTC' then
    raise notice 'PASS H1: inside quiet hours an eligible student is blocked by quiet_hours until the window ends';
  else raise notice 'FAIL H1: READY in quiet blockers % next %', q.blockers, q.next_eligible_at; end if;

  -- Quiet LATER, exactly when COOL's cooldown releases: not blocked by quiet
  -- now, but the release time is pushed past the window.
  select last_push_at + interval '240 minutes' into rel from public.student_notify_state where user_id = cool;
  h3 := extract(hour from (rel at time zone 'UTC'))::integer;
  select * into q from public.admin_campaign_queue(p_limit => 1000, p_quiet_start => h3, p_quiet_end => (h3 + 1) % 24, p_timezone => 'UTC')
   where user_id = cool;
  if q.blockers = '{cooldown}'::text[]
     and q.next_eligible_at = (date_trunc('hour', rel at time zone 'UTC') + interval '1 hour') at time zone 'UTC' then
    raise notice 'PASS H2: a cooldown that releases inside quiet hours is pushed to the end of the window';
  else raise notice 'FAIL H2: COOL next % (release %, window % to %)', q.next_eligible_at, rel, h3, (h3 + 1) % 24; end if;

  select * into q from public.admin_broadcast_queue(p_limit => 1000, p_quiet_start => h, p_quiet_end => (h + 1) % 24, p_timezone => 'UTC')
   where user_id = ready and broadcast_id = '00000000-0000-0000-0000-0000000620d1';
  if q.blockers = '{quiet_hours}'::text[] then raise notice 'PASS H3: broadcasts honour quiet hours too';
  else raise notice 'FAIL H3: broadcast READY in quiet blockers %', q.blockers; end if;

  select * into q from public.admin_reminder_queue(p_limit => 1000, p_quiet_start => h, p_quiet_end => (h + 1) % 24, p_timezone => 'UTC')
   where user_id = ready;
  if q.blockers = '{quiet_hours}'::text[] then raise notice 'PASS H4: reminders honour quiet hours too';
  else raise notice 'FAIL H4: reminder READY in quiet blockers %', q.blockers; end if;

  select * into q from public.admin_student_notify_budget(ready, p_quiet_start => h, p_quiet_end => (h + 1) % 24, p_timezone => 'UTC');
  if q.in_quiet_hours and q.blockers = '{quiet_hours}'::text[]
     and q.quiet_ends_at = (date_trunc('hour', now() at time zone 'UTC') + interval '1 hour') at time zone 'UTC'
     and q.next_eligible_at = q.quiet_ends_at then
    raise notice 'PASS H5: the budget reports quiet hours, when they end, and that next eligible is then';
  else raise notice 'FAIL H5: budget in quiet % ends % blockers %', q.in_quiet_hours, q.quiet_ends_at, q.blockers; end if;

  select * into q from public.admin_student_notify_budget(ready, p_quiet_start => 0, p_quiet_end => 0);
  if not q.in_quiet_hours and q.quiet_ends_at is null then raise notice 'PASS H6: outside quiet hours quiet_ends_at is null';
  else raise notice 'FAIL H6: in_quiet % ends %', q.in_quiet_hours, q.quiet_ends_at; end if;
end;
$$;

-- ============================================================
-- block 8: admin_broadcast_queue and admin_reminder_queue
-- ============================================================
do $$
declare
  d1     uuid := '00000000-0000-0000-0000-0000000620d1';
  d2     uuid := '00000000-0000-0000-0000-0000000620d2';
  d3     uuid := '00000000-0000-0000-0000-0000000620d3';
  ready  uuid := '00000000-0000-0000-0000-000000062001';
  cool   uuid := '00000000-0000-0000-0000-000000062003';
  daily  uuid := '00000000-0000-0000-0000-000000062004';
  email  uuid := '00000000-0000-0000-0000-000000062008';
  optout uuid := '00000000-0000-0000-0000-00000006200a';
  nostat uuid := '00000000-0000-0000-0000-00000006200b';
  sendg  uuid := '00000000-0000-0000-0000-00000006200c';
  stuck  uuid := '00000000-0000-0000-0000-00000006200d';
  remind uuid := '00000000-0000-0000-0000-000000062010';
  remoff uuid := '00000000-0000-0000-0000-000000062011';
  remold uuid := '00000000-0000-0000-0000-000000062012';
  q      record;
  n      integer;
  m      integer;
begin
  create temp table _bq on commit drop as
    select * from public.admin_broadcast_queue(p_limit => 1000, p_quiet_start => 0, p_quiet_end => 0);

  select count(*), max(total_queued) into n, m from _bq;
  if n = 10 and m = 10 then raise notice 'PASS R1: 10 waiting broadcast rows, total_queued agrees';
  else raise notice 'FAIL R1: % broadcast rows, total %', n, m; end if;

  select * into q from _bq limit 1;
  if q.broadcast_id = d2 then raise notice 'PASS R2: oldest broadcast first (the claim''s order)';
  else raise notice 'FAIL R2: first broadcast %', q.broadcast_id; end if;

  select * into q from _bq where broadcast_id = d1 and user_id = ready;
  if q.blockers = '{}'::text[] and q.next_eligible_at = now() and q.title = 'Live broadcast 062' and q.audience = 'all' and q.has_push then
    raise notice 'PASS R3: an eligible broadcast recipient has no blockers, with title and audience';
  else raise notice 'FAIL R3: READY d1 %', q; end if;

  select * into q from _bq where broadcast_id = d2 and user_id = ready;
  if q.blockers = '{expired}'::text[] and q.next_eligible_at is null then raise notice 'PASS R4: an expired broadcast reads "expired"';
  else raise notice 'FAIL R4: d2 blockers %', q.blockers; end if;

  select * into q from _bq where broadcast_id = d3 and user_id = ready;
  if q.blockers = '{cancelled}'::text[] and q.next_eligible_at is null then raise notice 'PASS R5: a cancelled broadcast reads "cancelled"';
  else raise notice 'FAIL R5: d3 blockers %', q.blockers; end if;

  select * into q from _bq where broadcast_id = d1 and user_id = cool;
  if q.blockers = '{cooldown}'::text[]
     and q.next_eligible_at = (select last_push_at + interval '240 minutes' from public.student_notify_state where user_id = cool) then
    raise notice 'PASS R6: the SHARED cooldown blocks a broadcast too';
  else raise notice 'FAIL R6: COOL d1 %', q.blockers; end if;

  select * into q from _bq where broadcast_id = d1 and user_id = daily;
  if q.blockers = '{daily_cap}'::text[] then raise notice 'PASS R7: the shared daily cap blocks a broadcast';
  else raise notice 'FAIL R7: DAILY d1 %', q.blockers; end if;

  select * into q from _bq where broadcast_id = d1 and user_id = email;
  if q.blockers = '{no_device}'::text[] and q.next_eligible_at is null and not q.has_push then
    raise notice 'PASS R8: broadcasts have no email fallback: no device is no_device, never eligible';
  else raise notice 'FAIL R8: EMAIL d1 % %', q.blockers, q.next_eligible_at; end if;

  select * into q from _bq where broadcast_id = d1 and user_id = optout;
  if q.blockers = '{push_opt_out}'::text[] and q.next_eligible_at is null then raise notice 'PASS R9: push switched off is push_opt_out';
  else raise notice 'FAIL R9: OPTOUT d1 %', q.blockers; end if;

  select * into q from _bq where broadcast_id = d1 and user_id = nostat;
  if q.blockers = '{}'::text[] then raise notice 'PASS R10: no state row reads as defaults for broadcasts';
  else raise notice 'FAIL R10: NOSTATE d1 %', q.blockers; end if;

  select * into q from _bq where broadcast_id = d1 and user_id = sendg;
  if q.blockers = '{sending}'::text[] then raise notice 'PASS R11: a broadcast claimed 2 minutes ago is sending';
  else raise notice 'FAIL R11: SENDING d1 %', q.blockers; end if;

  select * into q from _bq where broadcast_id = d1 and user_id = stuck;
  if q.blockers = '{stuck}'::text[] then raise notice 'PASS R12: a broadcast claimed 15 minutes ago is stuck';
  else raise notice 'FAIL R12: STUCK d1 %', q.blockers; end if;

  -- ---------- reminders ----------
  create temp table _rq on commit drop as
    select * from public.admin_reminder_queue(p_limit => 1000, p_quiet_start => 0, p_quiet_end => 0);

  select count(*) into m from public.profiles p
   where exists (select 1 from public.push_subscriptions ps where ps.user_id = p.user_id and ps.role = 'student');
  select count(*) into n from _rq;
  if n = m and n = 16 then
    raise notice 'PASS M1: candidates are exactly profiles with a STUDENT endpoint (16; the orphan and admin endpoints excluded)';
  else raise notice 'FAIL M1: % reminder candidates, % expected', n, m; end if;

  if (select max(total_candidates) from _rq) = 16
     and (select count(*) from public.admin_reminder_queue(p_limit => 3, p_quiet_start => 0, p_quiet_end => 0)) = 3
     and (select max(total_candidates) from public.admin_reminder_queue(p_limit => 3, p_quiet_start => 0, p_quiet_end => 0)) = 16 then
    raise notice 'PASS M2: p_limit caps rows, total_candidates is the count before it';
  else raise notice 'FAIL M2: reminder limit/total wrong'; end if;

  select * into q from _rq where queue_position = 1;
  if q.user_id = ready then raise notice 'PASS M3: position 1 is the lowest user id among the never-reminded (nulls first, then user_id)';
  else raise notice 'FAIL M3: position 1 is %', q.user_id; end if;

  select * into q from _rq where user_id = remold;
  if q.queue_position = 15 and q.blockers = '{}'::text[] and q.next_eligible_at = now() then
    raise notice 'PASS M4: reminded 100h ago is due, and queued behind all 14 never-reminded students';
  else raise notice 'FAIL M4: REMOLD position % blockers %', q.queue_position, q.blockers; end if;

  select * into q from _rq where user_id = remind;
  if q.queue_position = 16 and q.blockers = '{interval}'::text[]
     and q.next_eligible_at = (select last_reminder_at + interval '72 hours' from public.student_notify_state where user_id = remind) then
    raise notice 'PASS M5: reminded 10h ago is "interval", released 72h after, and last in line';
  else raise notice 'FAIL M5: REMIND position % blockers % next %', q.queue_position, q.blockers, q.next_eligible_at; end if;

  select * into q from _rq where user_id = remoff;
  if q.blockers = '{reminder_opt_out}'::text[] and q.next_eligible_at is null then
    raise notice 'PASS M6: reminders switched off is reminder_opt_out, never eligible';
  else raise notice 'FAIL M6: REMOFF %', q.blockers; end if;

  select * into q from _rq where user_id = optout;
  if q.blockers = '{push_opt_out}'::text[] and not q.has_push and q.next_eligible_at is null then
    raise notice 'PASS M7: push switched off is push_opt_out for reminders';
  else raise notice 'FAIL M7: OPTOUT %', q.blockers; end if;

  select * into q from _rq where user_id = nostat;
  if q.blockers = '{}'::text[] and q.last_reminder_at is null and q.has_push then
    raise notice 'PASS M8: a student with no state row is a never-reminded candidate (no row is inserted for them)';
  else raise notice 'FAIL M8: NOSTATE %', q.blockers; end if;

  select * into q from _rq where user_id = cool;
  if q.blockers = '{cooldown}'::text[] then raise notice 'PASS M9: the shared cooldown blocks a reminder';
  else raise notice 'FAIL M9: COOL %', q.blockers; end if;
end;
$$;

-- ============================================================
-- block 9: none of it wrote anything (the claims would have)
-- ============================================================
do $$
declare
  n  integer;
  s  text;
  st_before integer;
begin
  select count(*) into st_before from public.student_notify_state;

  -- Run every function once more, with email on, in this transaction.
  perform * from public.admin_campaign_queue(p_email_enabled => true);
  perform * from public.admin_broadcast_queue();
  perform * from public.admin_reminder_queue();
  perform * from public.admin_student_notify_budget('00000000-0000-0000-0000-00000006200b');

  select count(*) into n from public.student_notify_state;
  if n = st_before and not exists (select 1 from public.student_notify_state where user_id = '00000000-0000-0000-0000-00000006200b') then
    raise notice 'PASS W1: no student_notify_state row was created (the claims insert one; these must not)';
  else raise notice 'FAIL W1: student_notify_state went from % to % rows', st_before, n; end if;

  select status into s from public.campaign_recipients
   where campaign_id = '00000000-0000-0000-0000-0000000620c1' and user_id = '00000000-0000-0000-0000-00000006200d';
  if s = 'sending' then raise notice 'PASS W2: a stuck deal row is still sending (not requeued)';
  else raise notice 'FAIL W2: the stuck deal row is now %', s; end if;

  select status into s from public.campaign_recipients
   where campaign_id = '00000000-0000-0000-0000-0000000620c2' and user_id = '00000000-0000-0000-0000-00000006200e';
  if s = 'queued' then raise notice 'PASS W3: a deal row on an expired campaign is still queued (not expired)';
  else raise notice 'FAIL W3: the expired-campaign row is now %', s; end if;

  select status into s from public.admin_broadcast_recipients
   where broadcast_id = '00000000-0000-0000-0000-0000000620d1' and user_id = '00000000-0000-0000-0000-00000006200d';
  if s = 'sending' then raise notice 'PASS W4: a stuck broadcast row is still sending';
  else raise notice 'FAIL W4: the stuck broadcast row is now %', s; end if;

  select count(*) into n from public.admin_broadcast_recipients
   where broadcast_id in ('00000000-0000-0000-0000-0000000620d2', '00000000-0000-0000-0000-0000000620d3') and status = 'queued';
  if n = 2 then raise notice 'PASS W5: expired/cancelled broadcast rows are still queued (housekeeping did not run)';
  else raise notice 'FAIL W5: % of 2 expired/cancelled broadcast rows still queued', n; end if;

  select count(*) into n from public.student_notify_state
   where user_id = '00000000-0000-0000-0000-000000062001' and last_push_at is null and day_count = 0;
  if n = 1 then raise notice 'PASS W6: an eligible student''s budget was not spent';
  else raise notice 'FAIL W6: READY''s budget changed'; end if;

  -- And the declaration makes it impossible, not just absent: a write inside a
  -- STABLE plpgsql function raises.
  begin
    execute $f$
      create function pg_temp.w062() returns void language plpgsql stable as
      $b$ begin insert into public.notification_log (channel, kind, outcome, recipient_kind) values ('push','deal','sent','other'); end $b$
    $f$;
    perform pg_temp.w062();
    raise notice 'FAIL W7: a STABLE plpgsql function was allowed to write';
  exception when others then
    if sqlerrm ilike '%non-volatile%' then raise notice 'PASS W7: a write inside a STABLE plpgsql function raises (so the queue functions cannot write)';
    else raise notice 'FAIL W7: unexpected error %', sqlerrm; end if;
  end;
end;
$$;

-- ============================================================
-- block 10: admin_student_notify_budget
-- ============================================================
do $$
declare
  cool   uuid := '00000000-0000-0000-0000-000000062003';
  daily  uuid := '00000000-0000-0000-0000-000000062004';
  stale  uuid := '00000000-0000-0000-0000-000000062006';
  email  uuid := '00000000-0000-0000-0000-000000062008';
  optout uuid := '00000000-0000-0000-0000-00000006200a';
  nostat uuid := '00000000-0000-0000-0000-00000006200b';
  remind uuid := '00000000-0000-0000-0000-000000062010';
  remoff uuid := '00000000-0000-0000-0000-000000062011';
  q      record;
  n      integer;
begin
  select * into q from public.admin_student_notify_budget(daily, p_quiet_start => 0, p_quiet_end => 0);
  if q.has_state and q.day_count = 2 and q.week_count = 2
     and q.day_resets_at = (select day_start + interval '24 hours' from public.student_notify_state where user_id = daily)
     and q.blockers = '{daily_cap}'::text[] and q.next_eligible_at = q.day_resets_at and q.devices = 1 then
    raise notice 'PASS G1: capped for the day: counts, reset time, daily_cap, next eligible at the reset';
  else raise notice 'FAIL G1: DAILY budget %', q; end if;

  select * into q from public.admin_student_notify_budget(stale, p_quiet_start => 0, p_quiet_end => 0);
  if q.day_count = 0 and q.day_resets_at is null and q.blockers = '{}'::text[] and q.next_eligible_at = now() then
    raise notice 'PASS G2: day_count is EFFECTIVE: a rolled-over window reads 0, with no reset time';
  else raise notice 'FAIL G2: STALE budget day_count % resets %', q.day_count, q.day_resets_at; end if;

  select * into q from public.admin_student_notify_budget(nostat, p_quiet_start => 0, p_quiet_end => 0);
  if q.user_id = nostat and not q.has_state and q.push_opt_in and q.email_opt_in and q.nearby_opt_in and q.reminder_opt_in
     and q.last_push_at is null and q.day_count = 0 and q.week_count = 0 and q.devices = 2
     and q.blockers = '{}'::text[] and q.next_eligible_at = now() then
    raise notice 'PASS G3: no state row still returns ONE row: has_state false, defaults on, devices counted (2)';
  else raise notice 'FAIL G3: NOSTATE budget %', q; end if;

  select count(*) into n from public.admin_student_notify_budget(nostat);
  if n = 1 then raise notice 'PASS G4: exactly one row for a student with no state';
  else raise notice 'FAIL G4: % rows', n; end if;

  select * into q from public.admin_student_notify_budget(remoff, p_quiet_start => 0, p_quiet_end => 0);
  if not q.nearby_opt_in and not q.reminder_opt_in and q.push_opt_in and q.blockers = '{}'::text[] then
    raise notice 'PASS G5: the 051/060 switches are read (through to_jsonb), and reminders-off does not block general push';
  else raise notice 'FAIL G5: REMOFF nearby % reminder % blockers %', q.nearby_opt_in, q.reminder_opt_in, q.blockers; end if;

  select * into q from public.admin_student_notify_budget(remind, p_quiet_start => 0, p_quiet_end => 0);
  if q.last_reminder_at = (select last_reminder_at from public.student_notify_state where user_id = remind) then
    raise notice 'PASS G6: last_reminder_at comes through';
  else raise notice 'FAIL G6: last_reminder_at %', q.last_reminder_at; end if;

  select * into q from public.admin_student_notify_budget(cool, p_quiet_start => 0, p_quiet_end => 0);
  if q.cooldown_until = (select last_push_at + interval '240 minutes' from public.student_notify_state where user_id = cool)
     and q.blockers = '{cooldown}'::text[] and q.next_eligible_at = q.cooldown_until then
    raise notice 'PASS G7: cooldown_until and the cooldown blocker';
  else raise notice 'FAIL G7: COOL budget cooldown % blockers %', q.cooldown_until, q.blockers; end if;

  select * into q from public.admin_student_notify_budget(email, p_quiet_start => 0, p_quiet_end => 0);
  if q.devices = 0 and q.blockers = '{no_device}'::text[] and q.next_eligible_at is null then
    raise notice 'PASS G8: no device is no_device with no next push time';
  else raise notice 'FAIL G8: EMAIL budget %', q; end if;

  select * into q from public.admin_student_notify_budget(optout, p_quiet_start => 0, p_quiet_end => 0);
  if not q.push_opt_in and not q.email_opt_in and q.blockers = '{push_opt_out}'::text[] and q.next_eligible_at is null then
    raise notice 'PASS G9: push switched off is push_opt_out';
  else raise notice 'FAIL G9: OPTOUT budget %', q.blockers; end if;

  select count(*) into n from public.admin_student_notify_budget(null);
  if n = 0 then raise notice 'PASS G10: a null user id returns no row';
  else raise notice 'FAIL G10: % rows for null', n; end if;
end;
$$;

-- ============================================================
-- block 11: retention, cascade, set-null
-- ============================================================
do $$
declare
  n    integer;
  k    integer;
  doom uuid := '00000000-0000-0000-0000-000000062018';
  vid  uuid := '00000000-0000-0000-0000-0000000620b9';
  lid  uuid;
begin
  insert into public.notification_log (created_at, channel, kind, outcome, recipient_kind, title)
  values (now() - interval '31 days', 'push', 'admin_alert', 'sent', 'admin', 'old 062'),
         (now() - interval '29 days', 'push', 'admin_alert', 'sent', 'admin', 'young 062');

  k := public.prune_notification_log(30);
  select count(*) into n from public.notification_log where title in ('old 062', 'young 062');
  if k = 1 and n = 1 and exists (select 1 from public.notification_log where title = 'young 062') then
    raise notice 'PASS P1: prune(30) deletes the 31-day-old row and keeps the 29-day-old one';
  else raise notice 'FAIL P1: prune deleted %, % of the two remain', k, n; end if;

  -- prune(0) / prune(null) must clamp, not wipe. Rolled back either way.
  begin
    insert into public.notification_log (created_at, channel, kind, outcome, recipient_kind, title)
    values (now() - interval '12 hours', 'push', 'admin_alert', 'sent', 'admin', 'half-day 062');
    perform public.prune_notification_log(0);
    perform public.prune_notification_log(null);
    if exists (select 1 from public.notification_log where title = 'half-day 062') then
      raise notice 'PASS P2: prune(0) and prune(null) clamp to a day / the default instead of deleting everything';
    else raise notice 'FAIL P2: prune(0) or prune(null) deleted a 12-hour-old row'; end if;
    raise exception 'rollback';
  exception when raise_exception then null;
  end;

  -- Cascade: the student's rows go with the profile.
  select count(*) into n from public.notification_log where student_id = doom;
  delete from public.profiles where user_id = doom;
  select count(*) into k from public.notification_log where student_id = doom;
  if n = 1 and k = 0 then raise notice 'PASS P3: deleting a profile deletes that student''s notification rows';
  else raise notice 'FAIL P3: DOOM had % rows, % remain after profile delete', n, k; end if;

  -- Set null: a deleted spot does not delete the record we messaged about it.
  begin
    insert into public.vendors (id, name, slug, active) values (vid, 'Doomed Spot 062', 'doomed-spot-062', true);
    insert into public.notification_log (channel, kind, outcome, recipient_kind, vendor_id, title)
    values ('email', 'vendor_reset', 'sent', 'vendor', vid, 'reset 062') returning id into lid;
    delete from public.vendors where id = vid;
    if exists (select 1 from public.notification_log where id = lid and vendor_id is null) then
      raise notice 'PASS P4: deleting a vendor keeps the log row and nulls vendor_id';
    else raise notice 'FAIL P4: the row was deleted or still names the vendor'; end if;
    raise exception 'rollback';
  exception when raise_exception then null;
  end;

  -- The live writers' upsert shape against the plain unique constraint.
  insert into public.notification_log (channel, kind, outcome, recipient_kind, dedupe_key)
  values ('push', 'nearby', 'allowed', 'student',
          'nearby:00000000-0000-0000-0000-000000062017:00000000-0000-0000-0000-0000000620b1')
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count;
  select count(*) into k from public.notification_log
   where dedupe_key = 'nearby:00000000-0000-0000-0000-000000062017:00000000-0000-0000-0000-0000000620b1';
  if n = 0 and k = 1 then raise notice 'PASS P5: on conflict (dedupe_key) do nothing ignores a repeat of a backfilled key';
  else raise notice 'FAIL P5: inserted %, % rows with that key', n, k; end if;

  -- NULL keys stay distinct: two keyless rows coexist.
  begin
    insert into public.notification_log (channel, kind, outcome, recipient_kind) values ('push', 'deal', 'refused', 'student'), ('push', 'deal', 'refused', 'student');
    raise notice 'PASS P6: rows without a dedupe_key never collide';
    raise exception 'rollback';
  exception
    when unique_violation then raise notice 'FAIL P6: two keyless rows collided';
    when raise_exception then null;
  end;
end;
$$;

-- ============================================================
-- block 12: expiry first, same spot, p_user_id, one terminal blocker
-- ============================================================
-- Its own cast, inserted here and rolled back at the end, so none of it can
-- move a count or a queue position the blocks above pin exactly.
--
--   SOON   cooldown until last_push + 240m (about 3h out). A deal that
--          expires in 1h will expire first; the C_MAIN deal (47h) will not.
--   WEEK   weekly cap with week_start 1 day ago: released in 6 days, past
--          both C_MAIN's 47h expiry and the live broadcast's 40h.
--   QUIET  no gates at all, one deal expiring exactly when a quiet window
--          around the current hour ends: expires first ONLY because the
--          release is pushed past quiet hours.
--   SPOT   three due deals from ONE vendor (and one from C_MAIN's vendor).
--          The claim's per-vendor dedupe sends one per bundle, then the rest
--          wait the vendor cooldown each.
--   T1/T2  'sending' rows on dead campaigns and broadcasts, claimed 15 and 2
--          minutes ago: every two-state combination reads as ONE blocker.
do $$
declare
  soon   uuid := '00000000-0000-0000-0000-000000062030';
  week   uuid := '00000000-0000-0000-0000-000000062031';
  quiet  uuid := '00000000-0000-0000-0000-000000062032';
  spot   uuid := '00000000-0000-0000-0000-000000062033';
  t1     uuid := '00000000-0000-0000-0000-000000062034';
  t2     uuid := '00000000-0000-0000-0000-000000062035';
  ready  uuid := '00000000-0000-0000-0000-000000062001';
  v_same uuid := '00000000-0000-0000-0000-0000000620b4';
  c_main uuid := '00000000-0000-0000-0000-0000000620c1';
  c_exp  uuid := '00000000-0000-0000-0000-0000000620c2';
  c_canc uuid := '00000000-0000-0000-0000-0000000620c3';
  c_soon uuid := '00000000-0000-0000-0000-0000000620f1';
  c_qt   uuid := '00000000-0000-0000-0000-0000000620f2';
  s1     uuid := '00000000-0000-0000-0000-0000000620f3';
  s2     uuid := '00000000-0000-0000-0000-0000000620f4';
  s3     uuid := '00000000-0000-0000-0000-0000000620f5';
  d1     uuid := '00000000-0000-0000-0000-0000000620d1';
  d2     uuid := '00000000-0000-0000-0000-0000000620d2';
  d3     uuid := '00000000-0000-0000-0000-0000000620d3';
  h      integer := extract(hour from (now() at time zone 'UTC'))::integer;
  q_end  timestamptz := (date_trunc('hour', now() at time zone 'UTC') + interval '1 hour') at time zone 'UTC';
  q      record;
  n      integer;
  m      integer;
begin
  begin
    insert into auth.users (id, email) values
      (soon,  'soon-062@example.com'),  (week, 'week-062@example.com'),
      (quiet, 'quiet-062@example.com'), (spot, 'spot-062@example.com'),
      (t1,    't1-062@example.com'),    (t2,   't2-062@example.com');
    insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
      (soon,  'soon-062@example.com',  'Soon 062',  now(), 'v1'),
      (week,  'week-062@example.com',  'Week 062',  now(), 'v1'),
      (quiet, 'quiet-062@example.com', 'Quiet 062', now(), 'v1'),
      (spot,  'spot-062@example.com',  'Spot 062',  now(), 'v1'),
      (t1,    't1-062@example.com',    'T1 062',    now(), 'v1'),
      (t2,    't2-062@example.com',    'T2 062',    now(), 'v1');
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, role) values
      (soon,  'https://push.example/soon-062',  'k', 'a', 'student'),
      (week,  'https://push.example/week-062',  'k', 'a', 'student'),
      (quiet, 'https://push.example/quiet-062', 'k', 'a', 'student'),
      (spot,  'https://push.example/spot-062',  'k', 'a', 'student');
    insert into public.student_notify_state
      (user_id, push_opt_in, email_opt_in, last_push_at, day_start, day_count, week_start, week_count) values
      (soon, true, true, now() - interval '1 hour', null, 0, null,                     0),
      (week, true, true, null,                      null, 0, now() - interval '1 day', 5);

    insert into public.vendors (id, name, slug, active) values (v_same, 'Same Spot 062', 'same-spot-062', true);
    insert into public.vendor_campaigns (id, vendor_id, title, body, kind, status, deliver_after, expires_at, created_at) values
      (c_soon, '00000000-0000-0000-0000-0000000620b2', 'Soon deal 062', 'One hour left.', 'deal', 'queued',
       now() - interval '30 minutes', now() + interval '1 hour', now() - interval '30 minutes'),
      (c_qt, '00000000-0000-0000-0000-0000000620b2', 'Quiet deal 062', 'Ends with the quiet window.', 'deal', 'queued',
       now() - interval '30 minutes', q_end, now() - interval '30 minutes'),
      -- created S1 < S2 < S3, but S2 is due FIRST: deliver_after outranks
      -- created_at, exactly like the claim's per_vendor order.
      (s1, v_same, 'Spot one 062',   'One.',   'deal', 'queued', now() - interval '1 hour',  now() + interval '47 hours', now() - interval '3 hours'),
      (s2, v_same, 'Spot two 062',   'Two.',   'deal', 'queued', now() - interval '2 hours', now() + interval '47 hours', now() - interval '2 hours'),
      (s3, v_same, 'Spot three 062', 'Three.', 'deal', 'queued', now() - interval '1 hour',  now() + interval '47 hours', now() - interval '1 hour');

    insert into public.campaign_recipients (campaign_id, user_id, status, deliver_after, push_batch, claimed_at) values
      (c_soon, soon,  'queued', now() - interval '30 minutes', null, null),
      (c_main, soon,  'queued', now() - interval '1 hour',     null, null),
      (c_main, week,  'queued', now() - interval '1 hour',     null, null),
      (c_qt,   quiet, 'queued', now() - interval '30 minutes', null, null),
      (s1,     spot,  'queued', now() - interval '1 hour',     null, null),
      (s2,     spot,  'queued', now() - interval '2 hours',    null, null),
      (s3,     spot,  'queued', now() - interval '1 hour',     null, null),
      (c_main, spot,  'queued', now() - interval '1 hour',     null, null),
      -- expired + stuck, cancelled + stuck, expired + mid-send.
      (c_exp,  t1, 'sending', now() - interval '50 hours', '00000000-0000-0000-0000-0000000620e7', now() - interval '15 minutes'),
      (c_canc, t1, 'sending', now() - interval '3 hours',  '00000000-0000-0000-0000-0000000620e8', now() - interval '15 minutes'),
      (c_exp,  t2, 'sending', now() - interval '50 hours', '00000000-0000-0000-0000-0000000620e9', now() - interval '2 minutes');

    insert into public.admin_broadcast_recipients (broadcast_id, user_id, status, claimed_at) values
      (d1, soon, 'queued',  null),
      (d1, week, 'queued',  null),
      (d2, t1,   'sending', now() - interval '15 minutes'),
      (d3, t1,   'sending', now() - interval '15 minutes'),
      (d2, t2,   'sending', now() - interval '2 minutes'),
      (d3, t2,   'sending', now() - interval '2 minutes');

    -- ---------- expires first ----------
    create temp table _xq on commit drop as
      select * from public.admin_campaign_queue(p_limit => 1000, p_quiet_start => 0, p_quiet_end => 0);
    create temp table _xb on commit drop as
      select * from public.admin_broadcast_queue(p_limit => 1000, p_quiet_start => 0, p_quiet_end => 0);

    select * into q from _xq where user_id = soon and campaign_id = c_soon;
    if q.blockers = '{cooldown,expires_first}'::text[] and q.next_eligible_at is null then
      raise notice 'PASS X1: a deal whose cooldown outlasts its expiry is expires_first, with no next time';
    else raise notice 'FAIL X1: SOON c_soon blockers % next %', q.blockers, q.next_eligible_at; end if;

    select * into q from _xq where user_id = soon and campaign_id = c_main;
    if q.blockers = '{cooldown}'::text[]
       and q.next_eligible_at = (select last_push_at + interval '240 minutes' from public.student_notify_state where user_id = soon) then
      raise notice 'PASS X2: the same cooldown on a deal that outlives it is plain cooldown, released on time';
    else raise notice 'FAIL X2: SOON c_main blockers % next %', q.blockers, q.next_eligible_at; end if;

    select * into q from _xq where user_id = week and campaign_id = c_main;
    if q.blockers = '{weekly_cap,expires_first}'::text[] and q.next_eligible_at is null then
      raise notice 'PASS X3: a weekly cap that releases after the deal expires is expires_first';
    else raise notice 'FAIL X3: WEEK c_main blockers % next %', q.blockers, q.next_eligible_at; end if;

    select * into q from _xb where user_id = week and broadcast_id = d1;
    if q.blockers = '{weekly_cap,expires_first}'::text[] and q.next_eligible_at is null then
      raise notice 'PASS X4: broadcasts too: weekly cap past the 40h expiry is expires_first, no next time';
    else raise notice 'FAIL X4: WEEK d1 blockers % next %', q.blockers, q.next_eligible_at; end if;

    select * into q from _xb where user_id = soon and broadcast_id = d1;
    if q.blockers = '{cooldown}'::text[] and q.next_eligible_at is not null then
      raise notice 'PASS X5: a broadcast that outlives the cooldown is plain cooldown';
    else raise notice 'FAIL X5: SOON d1 blockers % next %', q.blockers, q.next_eligible_at; end if;

    select * into q from _xq where user_id = quiet;
    if q.blockers = '{}'::text[] and q.next_eligible_at = now() then
      raise notice 'PASS X6: with quiet hours off, the deal ending at the top of the hour is eligible now';
    else raise notice 'FAIL X6: QUIET blockers % next %', q.blockers, q.next_eligible_at; end if;

    select * into q from public.admin_campaign_queue(p_limit => 1000, p_quiet_start => h, p_quiet_end => (h + 1) % 24, p_timezone => 'UTC')
     where user_id = quiet;
    if q.blockers = '{quiet_hours,expires_first}'::text[] and q.next_eligible_at is null then
      raise notice 'PASS X7: expiry is compared AFTER quiet hours: a window ending as the deal expires is expires_first';
    else raise notice 'FAIL X7: QUIET in quiet blockers % next %', q.blockers, q.next_eligible_at; end if;

    -- ---------- same spot ----------
    select * into q from _xq where user_id = spot and campaign_id = s2;
    if q.blockers = '{}'::text[] and q.next_eligible_at = now() then
      raise notice 'PASS S1: the earliest-due deal from a spot rides the next bundle (deliver_after before created_at)';
    else raise notice 'FAIL S1: SPOT s2 blockers % next %', q.blockers, q.next_eligible_at; end if;

    select * into q from _xq where user_id = spot and campaign_id = s1;
    if q.blockers = '{same_spot_queued}'::text[] and q.next_eligible_at = now() + interval '20 hours' then
      raise notice 'PASS S2: the second deal from the same spot is same_spot_queued, one vendor cooldown out';
    else raise notice 'FAIL S2: SPOT s1 blockers % next %', q.blockers, q.next_eligible_at; end if;

    select * into q from _xq where user_id = spot and campaign_id = s3;
    if q.blockers = '{same_spot_queued}'::text[] and q.next_eligible_at = now() + interval '40 hours' then
      raise notice 'PASS S3: the third is two vendor cooldowns out';
    else raise notice 'FAIL S3: SPOT s3 blockers % next %', q.blockers, q.next_eligible_at; end if;

    select * into q from public.admin_campaign_queue(p_limit => 1000, p_vendor_cooldown_hours => 5, p_quiet_start => 0, p_quiet_end => 0)
     where user_id = spot and campaign_id = s3;
    if q.blockers = '{same_spot_queued}'::text[] and q.next_eligible_at = now() + interval '10 hours' then
      raise notice 'PASS S4: the same-spot wait follows p_vendor_cooldown_hours';
    else raise notice 'FAIL S4: SPOT s3 (5h) next %', q.next_eligible_at; end if;

    select * into q from _xq where user_id = spot and campaign_id = c_main;
    if q.blockers = '{}'::text[] and q.next_eligible_at = now() then
      raise notice 'PASS S5: a deal from a DIFFERENT spot is not queued behind them';
    else raise notice 'FAIL S5: SPOT c_main blockers %', q.blockers; end if;

    -- ---------- p_user_id ----------
    select count(*), max(total_queued) into n, m
      from public.admin_campaign_queue(p_limit => 1000, p_quiet_start => 0, p_quiet_end => 0, p_user_id => spot);
    if n = 4 and m = 4
       and not exists (select 1 from public.admin_campaign_queue(p_limit => 1000, p_user_id => spot) where user_id <> spot) then
      raise notice 'PASS U1: p_user_id returns only that student''s 4 rows, and total_queued counts only them';
    else raise notice 'FAIL U1: % rows for SPOT, total_queued %', n, m; end if;

    select count(*), max(total_queued) into n, m
      from public.admin_campaign_queue(p_limit => 1, p_quiet_start => 0, p_quiet_end => 0, p_user_id => spot);
    if n = 1 and m = 4 then
      raise notice 'PASS U2: the student filter applies BEFORE the limit (1 row of a total of 4)';
    else raise notice 'FAIL U2: % rows, total %', n, m; end if;

    select * into q from public.admin_campaign_queue(p_limit => 1000, p_quiet_start => 0, p_quiet_end => 0, p_user_id => spot)
     where campaign_id = s3;
    if q.blockers = '{same_spot_queued}'::text[] and q.next_eligible_at = now() + interval '40 hours' then
      raise notice 'PASS U3: same-spot ranking is unchanged under the student filter';
    else raise notice 'FAIL U3: filtered s3 blockers % next %', q.blockers, q.next_eligible_at; end if;

    select count(*), max(total_queued) into n, m
      from public.admin_broadcast_queue(p_limit => 1000, p_quiet_start => 0, p_quiet_end => 0, p_user_id => ready);
    if n = 3 and m = 3 then
      raise notice 'PASS U4: broadcast p_user_id returns READY''s 3 rows (live, expired, cancelled), total 3';
    else raise notice 'FAIL U4: % broadcast rows for READY, total %', n, m; end if;

    if (select count(*) from public.admin_campaign_queue(p_user_id => '00000000-0000-0000-0000-0000000620ff')) = 0
       and (select count(*) from public.admin_broadcast_queue(p_user_id => '00000000-0000-0000-0000-0000000620ff')) = 0 then
      raise notice 'PASS U5: a student with nothing queued gets no rows from either function';
    else raise notice 'FAIL U5: rows returned for a student with nothing queued'; end if;

    if (select count(*) from public.admin_campaign_queue(p_limit => 5000, p_user_id => null)) = (select count(*) from _xq)
       and (select count(*) from public.admin_broadcast_queue(p_limit => 5000, p_user_id => null)) = (select count(*) from _xb) then
      raise notice 'PASS U6: p_user_id null is the unfiltered queue';
    else raise notice 'FAIL U6: p_user_id null changed the row count'; end if;

    -- ---------- one terminal blocker ----------
    select * into q from _xq where user_id = t1 and campaign_id = c_exp;
    if q.blockers = '{expired}'::text[] and q.next_eligible_at is null then
      raise notice 'PASS T1x: a stuck row on an expired deal reads "expired" alone';
    else raise notice 'FAIL T1x: T1 c_exp blockers %', q.blockers; end if;

    select * into q from _xq where user_id = t1 and campaign_id = c_canc;
    if q.blockers = '{cancelled}'::text[] and q.next_eligible_at is null then
      raise notice 'PASS T2x: a stuck row on a cancelled deal reads "cancelled" alone';
    else raise notice 'FAIL T2x: T1 c_canc blockers %', q.blockers; end if;

    -- The claim lets a row genuinely mid-send on an expired deal complete.
    select * into q from _xq where user_id = t2 and campaign_id = c_exp;
    if q.blockers = '{sending}'::text[] and q.next_eligible_at is null then
      raise notice 'PASS T3x: a row mid-send on an expired deal is "sending" (it still completes)';
    else raise notice 'FAIL T3x: T2 c_exp blockers %', q.blockers; end if;

    select * into q from _xb where user_id = t1 and broadcast_id = d2;
    if q.blockers = '{expired}'::text[] then raise notice 'PASS T4x: broadcast expired + stuck reads "expired" alone';
    else raise notice 'FAIL T4x: T1 d2 blockers %', q.blockers; end if;

    select * into q from _xb where user_id = t1 and broadcast_id = d3;
    if q.blockers = '{cancelled}'::text[] then raise notice 'PASS T5x: broadcast cancelled + stuck reads "cancelled" alone';
    else raise notice 'FAIL T5x: T1 d3 blockers %', q.blockers; end if;

    select * into q from _xb where user_id = t2 and broadcast_id = d2;
    if q.blockers = '{expired}'::text[] then raise notice 'PASS T6x: broadcast expired + sending reads "expired" alone';
    else raise notice 'FAIL T6x: T2 d2 blockers %', q.blockers; end if;

    select * into q from _xb where user_id = t2 and broadcast_id = d3;
    if q.blockers = '{cancelled}'::text[] then raise notice 'PASS T7x: broadcast cancelled + sending reads "cancelled" alone';
    else raise notice 'FAIL T7x: T2 d3 blockers %', q.blockers; end if;

    select count(*) into n from (
      select blockers from _xq union all select blockers from _xb
    ) a where a.blockers && '{expired,cancelled,stuck,sending}'::text[] and cardinality(a.blockers) <> 1;
    if n = 0 then raise notice 'PASS T8x: no terminal row in either queue carries more than one blocker';
    else raise notice 'FAIL T8x: % terminal rows carry several blockers', n; end if;

    raise exception 'rollback';
  exception when raise_exception then null;
  end;
end;
$$;
