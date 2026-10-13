-- Assertions for migration-064 (email reach for reminders and announcements).
--
-- Five things, and they fail in different directions.
--
--   1. THE SAFE DEFAULT. p_email_enabled defaults false and must then reproduce
--      migration-060 exactly. Failure here is a deployment with no Resend key
--      claiming students it cannot possibly mail, spending a slot and a defer on
--      every one of them, every tick.
--
--   2. THE WIDENING. With email enabled, a student with NO endpoint is a
--      candidate and comes back as out_reach 'email'. Failure here is the whole
--      migration doing nothing, silently -- which is exactly how it would look
--      in production, because the queue would simply stay as small as it was.
--
--   3. THE OPT-OUTS STILL HOLD. email_opt_in false, a suppressed address and no
--      address at all each keep a student out. Failure here is the worst defect
--      this file can catch: mail to somebody who asked us not to, which nobody
--      reports and which costs the sending domain its reputation -- the same
--      domain every password reset goes out on.
--
--   4. DEFER IS NOT REFUND. defer_reminder_push gives the budget back and LEAVES
--      last_reminder_at; refund_reminder_push nulls it. Getting these the same
--      way round is a loop: the queue is ordered `last_reminder_at nulls first`,
--      so a refunded student returns to the head of it, composes the same
--      un-emailable tier thirty seconds later, and is claimed and refunded again
--      forever, starving everyone behind them.
--
--   5. THE BUDGET IS STILL SHARED. An email claim spends last_push_at and both
--      counters exactly as a push claim does. Privacy Policy section 7.4 says
--      "an email counts against them exactly as a push notification does", and
--      this is the only place that sentence is enforced.
--
-- Quiet hours are passed as (0, 0) on every call, exactly as behavior-047,
-- behavior-060 and behavior-061 do it: the container's clock is whatever time
-- the suite runs at, and the real 22:00-09:00 window would quietly turn this
-- whole file into "claimed nobody, PASS".
--
-- Each block parks every student with `last_push_at = now()` and then brings
-- forward only the ones it is about. now() is the TRANSACTION timestamp and each
-- DO block is one transaction, so a parked student is exactly inside any
-- cooldown the claim tests. Parking rather than deleting state is what
-- behavior-060 and behavior-061 do, and for the same reason: a student left
-- eligible from an earlier block silently takes a slot and turns these
-- assertions into coincidences.

-- ============================================================
-- block 1: the safe default -- email off reproduces migration-060
-- ============================================================
do $$
declare
  s_both    uuid := '00000000-0000-0000-0000-000000064001';
  s_email   uuid := '00000000-0000-0000-0000-000000064002';
  got uuid[];
begin
  -- Fixture guard first. If the seed gave the email-only student an endpoint,
  -- every assertion in this file passes for the wrong reason.
  if not exists (select 1 from public.push_subscriptions
                 where user_id = s_email and role = 'student')
  then raise notice 'PASS A1: fixture -- the email-only student has no push endpoint';
  else raise notice 'FAIL A1: the email-only student has an endpoint, so nothing below tests email reach'; end if;

  if exists (select 1 from public.push_subscriptions where user_id = s_both and role = 'student')
  then raise notice 'PASS A2: fixture -- the control student does have an endpoint';
  else raise notice 'FAIL A2: the control student has no endpoint, so block 1 cannot tell a default from a bug'; end if;

  -- Park everybody, then open the gate for nobody in particular: the claim's own
  -- backfill decides who is a candidate.
  update public.student_notify_state set last_push_at = now();

  -- Unpark the two this block is about.
  insert into public.student_notify_state (user_id) values (s_both), (s_email)
  on conflict (user_id) do nothing;
  update public.student_notify_state
  set last_push_at = null, last_reminder_at = null, day_count = 0, week_count = 0
  where user_id in (s_both, s_email);

  select coalesce(array_agg(r.out_user_id order by r.out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(
    p_max_users => 50, p_quiet_start => 0, p_quiet_end => 0
    -- p_email_enabled DELIBERATELY NOT PASSED. Its default is the thing under test.
  ) r;

  if s_both = any(got) then raise notice 'PASS A3: with email off, a student with an endpoint is still claimed';
  else raise notice 'FAIL A3: the default broke migration-060 -- a push-reachable student was not claimed'; end if;

  if not (s_email = any(got)) then
    raise notice 'PASS A4: with email off, a student with no endpoint is NOT claimed';
  else raise notice 'FAIL A4: p_email_enabled defaults open -- a deployment with no mailbox claimed a student it cannot reach'; end if;
end $$;

-- ============================================================
-- block 2: the widening, and what out_reach says
-- ============================================================
do $$
declare
  s_both    uuid := '00000000-0000-0000-0000-000000064001';
  s_email   uuid := '00000000-0000-0000-0000-000000064002';
  s_pushoff uuid := '00000000-0000-0000-0000-000000064003';
  reach_both    text;
  reach_email   text;
  reach_pushoff text;
begin
  update public.student_notify_state set last_push_at = now();
  insert into public.student_notify_state (user_id) values (s_both), (s_email), (s_pushoff)
  on conflict (user_id) do nothing;
  update public.student_notify_state
  set last_push_at = null, last_reminder_at = null, day_count = 0, week_count = 0
  where user_id in (s_both, s_email, s_pushoff);

  create temp table t_reach on commit drop as
  select r.out_user_id, r.out_reach
  from public.claim_reminder_pushes(
    p_max_users => 50, p_quiet_start => 0, p_quiet_end => 0, p_email_enabled => true
  ) r;

  select out_reach into reach_both    from t_reach where out_user_id = s_both;
  select out_reach into reach_email   from t_reach where out_user_id = s_email;
  select out_reach into reach_pushoff from t_reach where out_user_id = s_pushoff;

  -- THE ASSERTION THIS MIGRATION EXISTS FOR.
  if reach_email = 'email' then
    raise notice 'PASS B1: a student with no device is claimed, and told to be reached by email';
  else raise notice 'FAIL B1: the email-only student came back as % -- the widening did not happen', coalesce(reach_email, 'not claimed'); end if;

  if reach_both = 'both' then raise notice 'PASS B2: a student with a device and an address is reachable by both';
  else raise notice 'FAIL B2: the control student came back as %, wanted both', coalesce(reach_both, 'not claimed'); end if;

  -- push_opt_in moved inside the push arm. Turning off Deal alerts stops push
  -- and nothing else; the email switch is independent (migration-047 settled
  -- that, and Privacy Policy section 7.4 says so in the switch list).
  if reach_pushoff = 'email' then
    raise notice 'PASS B3: a student who turned Deal alerts off is still reachable by email';
  else raise notice 'FAIL B3: the Deal-alerts-off student came back as %, wanted email', coalesce(reach_pushoff, 'not claimed'); end if;
end $$;

-- ============================================================
-- block 3: the opt-outs, and the floor
-- ============================================================
do $$
declare
  s_emailoff uuid := '00000000-0000-0000-0000-000000064004';
  s_suppress uuid := '00000000-0000-0000-0000-000000064005';
  s_nomail   uuid := '00000000-0000-0000-0000-000000064006';
  got uuid[];
  before_state record;
begin
  -- Fixture guards: each of these three assertions is worthless if the seed did
  -- not actually set the thing up.
  if exists (select 1 from public.email_suppressions where email = 's-suppress-064@example.com')
  then raise notice 'PASS C1: fixture -- the suppressed address really is on the list';
  else raise notice 'FAIL C1: no suppression row, so C5 proves nothing'; end if;

  if exists (select 1 from public.student_notify_state where user_id = s_emailoff and email_opt_in = false)
  then raise notice 'PASS C2: fixture -- the opted-out student really has email_opt_in false';
  else raise notice 'FAIL C2: email_opt_in is not false, so C4 proves nothing'; end if;

  if coalesce(trim((select email from public.profiles where user_id = s_nomail)), '') = ''
  then raise notice 'PASS C3: fixture -- the no-address student really has no usable address';
  else raise notice 'FAIL C3: the no-address student has an address, so C6 proves nothing'; end if;

  update public.student_notify_state set last_push_at = now();
  insert into public.student_notify_state (user_id) values (s_emailoff), (s_suppress), (s_nomail)
  on conflict (user_id) do nothing;
  update public.student_notify_state
  set last_push_at = null, last_reminder_at = null, day_count = 0, week_count = 0
  where user_id in (s_emailoff, s_suppress, s_nomail);

  select coalesce(array_agg(r.out_user_id order by r.out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(
    p_max_users => 50, p_quiet_start => 0, p_quiet_end => 0, p_email_enabled => true
  ) r;

  if not (s_emailoff = any(got)) then raise notice 'PASS C4: Email alerts off keeps a student out of the claim';
  else raise notice 'FAIL C4: a student who turned email off was claimed for an email'; end if;

  if not (s_suppress = any(got)) then raise notice 'PASS C5: a suppressed address (marketing scope) keeps a student out';
  else raise notice 'FAIL C5: a student on the suppression list was claimed -- this is mail to somebody who asked us not to'; end if;

  if not (s_nomail = any(got)) then raise notice 'PASS C6: a profile with no address is not reachable by anything';
  else raise notice 'FAIL C6: a student with no address and no device was claimed'; end if;

  -- A REFUSAL THAT STILL SPENDS is the mirror-image defect: nothing is sent,
  -- nobody notices, and the student loses their deal alerts for four hours too
  -- because all four features gate on one last_push_at. So each refusal above is
  -- asserted twice: it refused, AND it wrote nothing.
  select last_push_at, day_count, week_count into before_state
  from public.student_notify_state where user_id = s_suppress;
  if before_state.last_push_at is null and before_state.day_count = 0 then
    raise notice 'PASS C7: a refused student''s shared budget was not spent';
  else raise notice 'FAIL C7: refusing the suppressed student still spent their budget (last_push_at %, day_count %)',
    before_state.last_push_at, before_state.day_count; end if;
end $$;

-- ============================================================
-- block 4: an email claim spends the shared budget like a push
-- ============================================================
do $$
declare
  s_email uuid := '00000000-0000-0000-0000-000000064002';
  st record;
  n integer;
begin
  update public.student_notify_state set last_push_at = now();
  insert into public.student_notify_state (user_id) values (s_email) on conflict (user_id) do nothing;
  update public.student_notify_state
  set last_push_at = null, last_reminder_at = null, day_count = 0, week_count = 0,
      day_start = null, week_start = null
  where user_id = s_email;

  select count(*) into n from public.claim_reminder_pushes(
    p_max_users => 50, p_quiet_start => 0, p_quiet_end => 0, p_email_enabled => true
  ) r where r.out_user_id = s_email;

  if n = 1 then raise notice 'PASS D1: the email-only student was claimed once';
  else raise notice 'FAIL D1: the email-only student was claimed % times', n; end if;

  select * into st from public.student_notify_state where user_id = s_email;

  -- Privacy Policy section 7.4: "an email counts against them exactly as a push
  -- notification does". This is the only place that is enforced.
  if st.last_push_at is not null then raise notice 'PASS D2: the claim spent the SHARED cooldown for an email';
  else raise notice 'FAIL D2: an email claim did not spend last_push_at, so it is free of the shared budget'; end if;

  if st.day_count = 1 and st.week_count = 1 then raise notice 'PASS D3: an email claim ticked both counters';
  else raise notice 'FAIL D3: counters are day % week % after one email claim, wanted 1 and 1', st.day_count, st.week_count; end if;

  if st.last_reminder_at is not null then raise notice 'PASS D4: the claim set the cadence gate';
  else raise notice 'FAIL D4: last_reminder_at is null after a claim, so this student is due again immediately'; end if;

  -- And the cooldown actually holds against an immediate second claim.
  select count(*) into n from public.claim_reminder_pushes(
    p_max_users => 50, p_quiet_start => 0, p_quiet_end => 0, p_email_enabled => true
  ) r where r.out_user_id = s_email;
  if n = 0 then raise notice 'PASS D5: a second claim in the same window returns nothing';
  else raise notice 'FAIL D5: the same student was claimed again immediately (% rows)', n; end if;
end $$;

-- ============================================================
-- block 5: defer is not refund
-- ============================================================
do $$
declare
  s_email uuid := '00000000-0000-0000-0000-000000064002';
  ok boolean;
  st record;
begin
  -- Start from a spent claim, which is the only state either function is ever
  -- called in.
  insert into public.student_notify_state (user_id) values (s_email) on conflict (user_id) do nothing;
  update public.student_notify_state
  set last_push_at = now(), last_reminder_at = now(),
      day_start = now(), day_count = 1, week_start = now(), week_count = 1
  where user_id = s_email;

  select public.defer_reminder_push(s_email) into ok;
  select * into st from public.student_notify_state where user_id = s_email;

  if ok then raise notice 'PASS E1: defer_reminder_push reported it changed a row';
  else raise notice 'FAIL E1: defer_reminder_push returned false for a student that exists'; end if;

  if st.last_push_at is null then raise notice 'PASS E2: a defer released the shared cooldown';
  else raise notice 'FAIL E2: a defer left last_push_at set, so a reminder nobody received silences the next deal'; end if;

  if st.day_count = 0 and st.week_count = 0 then raise notice 'PASS E3: a defer gave both counters back';
  else raise notice 'FAIL E3: counters are day % week % after a defer, wanted 0 and 0', st.day_count, st.week_count; end if;

  -- THE DIFFERENCE. This is the single assertion that separates the two
  -- functions, and getting it wrong is an infinite claim loop, not a cosmetic
  -- bug: the queue is ordered `last_reminder_at asc nulls first`.
  if st.last_reminder_at is not null then
    raise notice 'PASS E4: a defer LEFT the cadence gate, so the student waits their turn';
  else raise notice 'FAIL E4: a defer nulled last_reminder_at -- this student returns to the head of the queue every tick, forever'; end if;

  -- And the student really is not claimable again straight away.
  if not exists (
    select 1 from public.claim_reminder_pushes(
      p_max_users => 50, p_quiet_start => 0, p_quiet_end => 0, p_email_enabled => true
    ) r where r.out_user_id = s_email
  ) then raise notice 'PASS E5: a deferred student is not re-claimed on the next tick';
  else raise notice 'FAIL E5: the deferred student was claimed again immediately'; end if;

  -- The contrast, spelled out: refund DOES re-queue, and that is correct for it.
  update public.student_notify_state
  set last_push_at = now(), last_reminder_at = now(), day_count = 1, week_count = 1
  where user_id = s_email;
  perform public.refund_reminder_push(s_email);
  select * into st from public.student_notify_state where user_id = s_email;
  if st.last_reminder_at is null then
    raise notice 'PASS E6: refund_reminder_push still nulls the gate, which is what makes a failure retry';
  else raise notice 'FAIL E6: refund no longer re-queues, so a transport failure is now a 72-hour silence'; end if;

  select public.defer_reminder_push(null) into ok;
  if ok = false then raise notice 'PASS E7: a null student id is refused rather than updating every row';
  else raise notice 'FAIL E7: defer_reminder_push(null) returned %, which means it matched rows', ok; end if;
end $$;

-- ============================================================
-- block 6: the reachability report
-- ============================================================
do $$
declare
  r record;
  n integer;
begin
  select * into r from public.student_reachability('2026-10-12');

  select count(*) into n from public.profiles;
  if r.students = n then raise notice 'PASS F1: the report counts one row per profile (%)', n;
  else raise notice 'FAIL F1: the report says % students against % profiles', r.students, n; end if;

  if r.reachable_either = r.students - r.reachable_neither then
    raise notice 'PASS F2: either and neither partition the student body';
  else raise notice 'FAIL F2: either % + neither % does not make % students', r.reachable_either, r.reachable_neither, r.students; end if;

  if r.consent_current + r.consent_stale = r.students then
    raise notice 'PASS F3: current and stale consent partition the student body';
  else raise notice 'FAIL F3: current % + stale % does not make % students', r.consent_current, r.consent_stale, r.students; end if;

  -- THE NUMBER THE PANEL IS FOR. Every seed student is on an old terms_version,
  -- and four of the six are email-reachable (both, email-only, push-off, and
  -- nothing else) -- so a nonzero answer here is the proof that stale consent
  -- and reachability are unrelated, which is the thing the operator needs to
  -- see rather than be told.
  if r.stale_and_emailable > 0 then
    raise notice 'PASS F4: % students on old Terms are reachable by email right now', r.stale_and_emailable;
  else raise notice 'FAIL F4: stale_and_emailable is 0, though every seed student is on an old version with an address'; end if;

  -- A null version must not guess.
  select * into r from public.student_reachability(null);
  if r.consent_current = 0 and r.consent_stale = 0 then
    raise notice 'PASS F5: with no version supplied the consent counts are 0, not a guess';
  else raise notice 'FAIL F5: a null version produced current % stale %', r.consent_current, r.consent_stale; end if;
end $$;
