-- Runtime behaviour of migration-047: email as a second delivery channel, the
-- suppression list, and self-serve vendor password resets.
-- Each check raises PASS or FAIL as a notice; grep the output for FAIL.
--
-- The headline assertion is C: a student with NO push subscription at all — the
-- iOS majority, invisible to every claim before this migration — is claimed and
-- reported as reachable by email. B is its guard: with no mail transport
-- configured the claim must behave EXACTLY as it did before, because claiming
-- someone the server cannot reach spends their quota on nothing.
--
-- Quiet hours are disabled (0, 0) everywhere except P, for the same reason
-- behavior-032 does it: the container's wall clock is whatever time the suite
-- happens to run, and a real quiet window would silently turn most of this file
-- into "claimed nothing, PASS".

do $$
declare
  e1  uuid := '00000000-0000-0000-0000-000000000471';   -- push + email
  e2  uuid := '00000000-0000-0000-0000-000000000472';   -- email only
  e3  uuid := '00000000-0000-0000-0000-000000000473';   -- email only, then bounced
  e4  uuid := '00000000-0000-0000-0000-000000000474';   -- no push, no email
  own uuid := '00000000-0000-0000-0000-000000000475';   -- the vendor login
  stu uuid := '00000000-0000-0000-0000-000000000476';   -- a student, not staff
  ven uuid := '00000000-0000-0000-0000-0000000004a1';
  c1  uuid := '00000000-0000-0000-0000-0000000004c1';
  n         integer;
  m         integer;
  txt       text;
  b         uuid;
  r1        uuid;
  r2        uuid;
  ts        timestamptz;
  flag      boolean;
  hour_now  integer;
begin
  ---------------------------------------------------------------- helpers
  -- Put the world back the way the seed left it. Both halves matter: the
  -- recipient rows return to the queue, and the throttle state is dropped so the
  -- next claim is not refused by the cooldown the previous one just spent.
  create temp table if not exists claimed (
    out_user_id uuid, out_batch uuid, out_items jsonb, out_reach text
  ) on commit drop;

  -- ---------- A. the migration applied without disturbing the old columns ----------
  select count(*) into n
  from information_schema.columns
  where table_name = 'student_notify_state'
    and column_name in ('push_opt_in', 'email_opt_in', 'last_push_at', 'last_email_at');
  if n = 4 then raise notice 'PASS A: student_notify_state carries both switches and both stamps';
  else raise notice 'FAIL A: expected 4 notify columns, found %', n; end if;

  -- ---------- B. with no mail transport, nothing changes ----------
  -- The regression guard. p_email_enabled defaults false, so a server deployed
  -- before its RESEND key must claim exactly who it claimed before: e1 alone.
  delete from claimed;
  insert into claimed select * from claim_campaign_pushes(
    p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0, p_email_enabled => false
  );
  select count(*) into n from claimed;
  select count(*) into m from claimed where out_user_id = e1;
  if n = 1 and m = 1 then raise notice 'PASS B: email off claims only the student with a push endpoint';
  else raise notice 'FAIL B: expected 1 claim (e1), got % (e1 present: %)', n, m; end if;

  update campaign_recipients set status = 'queued', push_batch = null, claimed_at = null where campaign_id = c1;
  delete from student_notify_state;

  -- ---------- C. the headline: email reaches who push cannot ----------
  delete from claimed;
  insert into claimed select * from claim_campaign_pushes(
    p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0, p_email_enabled => true
  );
  select count(*) into n from claimed;
  select count(*) into m from claimed where out_user_id = e4;
  if n = 3 and m = 0 then raise notice 'PASS C: e1/e2/e3 claimed, and the student with no address at all is still skipped';
  else raise notice 'FAIL C: expected 3 claims and no e4, got % claims (e4 present: %)', n, m; end if;

  -- ---------- D. the claim says WHICH channels are open ----------
  select out_reach into txt from claimed where out_user_id = e1;
  if txt = 'both' then raise notice 'PASS D1: a student with an endpoint AND an address reports reach=both';
  else raise notice 'FAIL D1: expected reach=both for e1, got %', txt; end if;

  select out_reach into txt from claimed where out_user_id = e2;
  if txt = 'email' then raise notice 'PASS D2: a student with only an address reports reach=email';
  else raise notice 'FAIL D2: expected reach=email for e2, got %', txt; end if;

  -- The bundle is composed identically for both channels — the email is the
  -- same deal, not a second, thinner one.
  select out_items -> 0 ->> 'title' into txt from claimed where out_user_id = e2;
  if txt = 'Half price cold brew' then raise notice 'PASS D3: the email-bound bundle carries the same items as a push one';
  else raise notice 'FAIL D3: expected the campaign title in out_items, got %', txt; end if;

  -- ---------- E. settling as email records the channel and the counts ----------
  select out_batch into b from claimed where out_user_id = e2;
  select finish_campaign_batch(b, true, false, 'email') into n;
  select channel into txt from campaign_recipients where campaign_id = c1 and user_id = e2;
  if n = 1 and txt = 'email' then raise notice 'PASS E1: an email settle marks the recipient row channel=email';
  else raise notice 'FAIL E1: settled % rows, channel=%', n, txt; end if;

  select sent_count, emailed_count into n, m from vendor_campaigns where id = c1;
  if n = 1 and m = 1 then raise notice 'PASS E2: sent_count counts every channel, emailed_count only the email half';
  else raise notice 'FAIL E2: expected sent_count=1 emailed_count=1, got %/%', n, m; end if;

  select last_email_at into ts from student_notify_state where user_id = e2;
  if ts is not null then raise notice 'PASS E3: last_email_at is stamped for the student who was mailed';
  else raise notice 'FAIL E3: last_email_at was not stamped'; end if;

  -- ---------- F. settling as push leaves the email counter alone ----------
  select out_batch into b from claimed where out_user_id = e1;
  perform finish_campaign_batch(b, true, false, 'push');
  select sent_count, emailed_count into n, m from vendor_campaigns where id = c1;
  select channel into txt from campaign_recipients where campaign_id = c1 and user_id = e1;
  if n = 2 and m = 1 and txt = 'push' then raise notice 'PASS F: a push settle bumps sent_count only, and records channel=push';
  else raise notice 'FAIL F: expected 2/1/push, got %/%/%', n, m, txt; end if;

  -- ---------- G. nothing delivered still refunds (migration-033 preserved) ----------
  select out_batch into b from claimed where out_user_id = e3;
  perform finish_campaign_batch(b, false, true, 'email');
  select day_count, last_push_at into n, ts from student_notify_state where user_id = e3;
  select count(*) into m from campaign_recipients where campaign_id = c1 and user_id = e3 and status = 'queued';
  if n = 0 and ts is null and m = 1 then raise notice 'PASS G: a batch nothing accepted refunds the quota and requeues, as before';
  else raise notice 'FAIL G: day_count=% last_push_at=% requeued=%', n, ts, m; end if;

  update campaign_recipients set status = 'queued', push_batch = null, claimed_at = null, pushed_at = null, channel = null where campaign_id = c1;
  update vendor_campaigns set sent_count = 0, emailed_count = 0 where id = c1;
  delete from student_notify_state;

  -- ---------- H. a suppressed address stops being claimed ----------
  -- Not merely "stops being sent to". If the claim still picked them, their
  -- quota would be spent every four hours on a message nothing can deliver.
  perform email_suppress('e3-047@example.com', 'bounced', 'all');
  delete from claimed;
  insert into claimed select * from claim_campaign_pushes(
    p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0, p_email_enabled => true
  );
  select count(*) into n from claimed where out_user_id = e3;
  select count(*) into m from claimed;
  if n = 0 and m = 2 then raise notice 'PASS H: a hard-bounced address is dropped from the claim entirely';
  else raise notice 'FAIL H: e3 claimed % times, total claims %', n, m; end if;

  update campaign_recipients set status = 'queued', push_batch = null, claimed_at = null where campaign_id = c1;
  delete from student_notify_state;

  -- ---------- I. the two switches are independent ----------
  -- Turning off deal ALERTS must not silence the email channel: that is what
  -- the two labels in the Account screen promise, and before 047 the claim
  -- treated push_opt_in as a master switch over everything.
  insert into student_notify_state (user_id, push_opt_in, email_opt_in) values (e1, false, true);
  delete from claimed;
  insert into claimed select * from claim_campaign_pushes(
    p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0, p_email_enabled => true
  );
  select out_reach into txt from claimed where out_user_id = e1;
  if txt = 'email' then raise notice 'PASS I1: push off + email on is still claimed, by email only';
  else raise notice 'FAIL I1: expected reach=email for a push-opted-out student, got %', txt; end if;

  update campaign_recipients set status = 'queued', push_batch = null, claimed_at = null where campaign_id = c1;
  delete from student_notify_state;

  insert into student_notify_state (user_id, push_opt_in, email_opt_in) values (e2, true, false);
  delete from claimed;
  insert into claimed select * from claim_campaign_pushes(
    p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0, p_email_enabled => true
  );
  select count(*) into n from claimed where out_user_id = e2;
  if n = 0 then raise notice 'PASS I2: a student who unsubscribed from deal emails and has no endpoint is not claimed';
  else raise notice 'FAIL I2: e2 was claimed % times despite email_opt_in=false', n; end if;

  update campaign_recipients set status = 'queued', push_batch = null, claimed_at = null where campaign_id = c1;
  delete from student_notify_state;

  -- ---------- J. the cooldown covers both channels ----------
  -- Email adds no throttling of its own precisely because it rides this claim.
  delete from claimed;
  insert into claimed select * from claim_campaign_pushes(
    p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0, p_email_enabled => true
  );
  select out_batch into b from claimed where out_user_id = e2;
  perform finish_campaign_batch(b, true, false, 'email');
  -- Requeue the SAME student for a second deal and immediately try again.
  update campaign_recipients set status = 'queued', push_batch = null, claimed_at = null, pushed_at = null
   where campaign_id = c1 and user_id = e2;
  delete from claimed;
  insert into claimed select * from claim_campaign_pushes(
    p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0, p_email_enabled => true
  );
  select count(*) into n from claimed where out_user_id = e2;
  if n = 0 then raise notice 'PASS J: an emailed student is inside the four-hour cooldown like a pushed one';
  else raise notice 'FAIL J: e2 was re-claimed % times inside the cooldown', n; end if;

  update campaign_recipients set status = 'queued', push_batch = null, claimed_at = null, pushed_at = null, channel = null where campaign_id = c1;
  update vendor_campaigns set sent_count = 0, emailed_count = 0 where id = c1;
  delete from student_notify_state;

  -- ---------- K. the suppression list escalates but never downgrades ----------
  perform email_suppress('escalate-047@example.com', 'unsubscribed', 'marketing');
  perform email_suppress('escalate-047@example.com', 'bounced', 'all');
  select scope into txt from email_suppressions where email = 'escalate-047@example.com';
  if txt = 'all' then raise notice 'PASS K1: marketing then all escalates to all';
  else raise notice 'FAIL K1: expected all, got %', txt; end if;

  perform email_suppress('escalate-047@example.com', 'unsubscribed', 'marketing');
  select scope into txt from email_suppressions where email = 'escalate-047@example.com';
  if txt = 'all' then raise notice 'PASS K2: a later unsubscribe cannot downgrade a hard bounce';
  else raise notice 'FAIL K2: a bounce was downgraded to %', txt; end if;

  -- Addresses are folded, so a bounce for Someone@X protects someone@x too.
  perform email_suppress('  MiXeD-047@Example.COM ', 'complained', 'all');
  select count(*) into n from email_suppressions where email = 'mixed-047@example.com';
  if n = 1 then raise notice 'PASS K3: addresses are trimmed and lower-cased on the way in';
  else raise notice 'FAIL K3: expected a folded row, found %', n; end if;

  -- ---------- L. self-serve reset: only a vendor login qualifies ----------
  select count(*) into n from vendor_reset_request('nobody-047@example.com', 'hash', 30, 120);
  if n = 0 then raise notice 'PASS L1: an unknown address returns zero rows (no account enumeration)';
  else raise notice 'FAIL L1: expected zero rows for an unknown address, got %', n; end if;

  select count(*) into n from vendor_reset_request('student-only-047@example.com', 'hash', 30, 120);
  if n = 0 then raise notice 'PASS L2: a student account is not resettable through the vendor form';
  else raise notice 'FAIL L2: a non-staff account minted % rows', n; end if;

  -- ---------- M. a vendor login mints a live code ----------
  select reset_id, reset_vendor_name, reset_throttled
    into r1, txt, flag
    from vendor_reset_request('owner-047@example.com', 'hash-one', 30, 120);
  if r1 is not null and txt = 'Email Cafe' then raise notice 'PASS M1: a vendor login mints a code and names the shop';
  else raise notice 'FAIL M1: id=% vendor=%', r1, txt; end if;

  select count(*) into n from vendor_password_resets
   where id = r1 and used_at is null and expires_at > now() and created_by = 'self-serve';
  if n = 1 then raise notice 'PASS M2: the row is live, unspent, and tagged as self-serve for the audit trail';
  else raise notice 'FAIL M2: expected one live self-serve row, found %', n; end if;

  -- ---------- N. the cooldown protects the live code ----------
  -- The real risk this guards is not mail volume: an unthrottled endpoint lets
  -- anyone who knows the address supersede the vendor's live code on repeat.
  select reset_id, reset_throttled into r2, flag
    from vendor_reset_request('owner-047@example.com', 'hash-two', 30, 120);
  if r2 is null and flag then raise notice 'PASS N1: a second request inside the cooldown is throttled, not minted';
  else raise notice 'FAIL N1: id=% throttled=%', r2, flag; end if;

  select count(*) into n from vendor_password_resets where id = r1 and used_at is null;
  if n = 1 then raise notice 'PASS N2: the throttled request did NOT supersede the code already in flight';
  else raise notice 'FAIL N2: the live code was consumed by a throttled request'; end if;

  -- ---------- O. past the cooldown, a new code supersedes the old ----------
  update vendor_password_resets set created_at = now() - interval '10 minutes' where id = r1;
  select reset_id into r2 from vendor_reset_request('owner-047@example.com', 'hash-three', 30, 120);
  select used_at into ts from vendor_password_resets where id = r1;
  if r2 is not null and r2 <> r1 and ts is not null then
    raise notice 'PASS O: past the cooldown a fresh code is minted and the old one is retired';
  else raise notice 'FAIL O: new=% old_used_at=%', r2, ts; end if;

  -- ---------- P. quiet hours still apply to email ----------
  -- A phone showing mail notifications buzzes at 3am exactly as it does for a
  -- push, so the window is a property of deal messaging, not of one transport.
  update campaign_recipients set status = 'queued', push_batch = null, claimed_at = null where campaign_id = c1;
  delete from student_notify_state;
  hour_now := extract(hour from now() at time zone 'America/New_York')::integer;
  delete from claimed;
  insert into claimed select * from claim_campaign_pushes(
    p_max_users => 40,
    -- A one-hour window around whatever time the container thinks it is.
    p_quiet_start => hour_now, p_quiet_end => (hour_now + 1) % 24,
    p_timezone => 'America/New_York', p_email_enabled => true
  );
  select count(*) into n from claimed;
  if n = 0 then raise notice 'PASS P: quiet hours suppress the email channel too';
  else raise notice 'FAIL P: % students claimed inside quiet hours', n; end if;
end $$;
