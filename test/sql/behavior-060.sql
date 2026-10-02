-- Assertions for migration-060 (the twice-weekly reminder push).
--
-- Two things are under test and they pull in opposite directions. The feature
-- has to REACH students nothing else reaches — there is no recipients table
-- behind a reminder, so the candidate set is built from push_subscriptions and
-- the claim has to create the notify rows it needs as it goes — while spending
-- the SAME budget as deal alerts and nearby alerts rather than a budget of its
-- own. So every assertion below is either "it claimed who it should" or "it
-- refused, AND THE REFUSAL COST NOTHING".
--
-- That second half is the one worth being fussy about, for the reason
-- behavior-051.sql gives: a refusal that still burns a slot is invisible in
-- production (nothing is sent, so nobody reports it), and the student it
-- quietly silences loses their deal alerts with it, because all three features
-- gate on one last_push_at.
--
-- Quiet hours are passed as (0, 0) — disabled — on every call but the block
-- that tests them, exactly as behavior-047.sql does it. The container's clock
-- is whatever time the suite happens to run at, and the real 22:00-09:00 window
-- would silently turn most of this file into "claimed nobody, PASS".
--
-- Nothing here depends on the ORDER of the uuids inside a returned array.
-- array_agg over a set-returning function does preserve the order the rows
-- arrive in, but leaning on that would make an ordering regression look like a
-- flake, so the two claims about ordering (nulls sort first, and p_max_users
-- keeps the longest-waiting) are asserted by WHO is present and absent at a
-- given p_max_users instead.

-- ---------- block 1: the new columns, the backfill, and who is due ----------
do $$
declare
  r1  uuid := '00000000-0000-0000-0000-000000000601';   -- never reminded, no state row at all
  r2  uuid := '00000000-0000-0000-0000-000000000602';   -- reminded an hour ago
  r3  uuid := '00000000-0000-0000-0000-000000000603';   -- reminded 80 hours ago
  r4  uuid := '00000000-0000-0000-0000-000000000604';   -- reminders switched off, later
  r5  uuid := '00000000-0000-0000-0000-000000000605';   -- push_opt_in = false
  r6  uuid := '00000000-0000-0000-0000-000000000606';   -- admin endpoint only, no state row
  r7  uuid := '00000000-0000-0000-0000-000000000607';   -- no endpoint at all
  r8  uuid := '00000000-0000-0000-0000-000000000608';   -- the quota fixture
  orp uuid := '00000000-0000-0000-0000-0000000006ff';   -- a student endpoint with no profile
  got uuid[];
  n   integer;
  m   integer;
begin
  -- The reminder history the seed could not write: both columns arrive with the
  -- migration, which runs AFTER the seed (test/sql/run.ps1), so this is the same
  -- compromise behavior-051.sql makes for nearby_opt_in.
  --
  -- The values are chosen to be unambiguous against a 72-hour interval: 1 hour
  -- is inside it by a mile, 80 hours is past it by a mile, and 200 hours is far
  -- enough back that R4 sorts ahead of R3 and the candidate ORDER is decided by
  -- the data rather than by whichever uuid happens to be smaller.
  update public.student_notify_state set last_reminder_at = now() - interval '1 hour'    where user_id = r2;
  update public.student_notify_state set last_reminder_at = now() - interval '80 hours'  where user_id = r3;
  update public.student_notify_state set last_reminder_at = now() - interval '200 hours' where user_id in (r4, r5, r7);

  -- R8 is PARKED inside the interval for this block. It is the quota fixture and
  -- block 2 owns it; left due here it would be picked up, refused on its caps,
  -- and consume one of the p_max_users slots the assertions below count.
  update public.student_notify_state set last_reminder_at = now() where user_id = r8;

  select count(*) into n
  from information_schema.columns
  where table_name = 'student_notify_state'
    and column_name in ('reminder_opt_in', 'last_reminder_at');
  if n = 2 then raise notice 'PASS A1: student_notify_state carries the reminder switch and the reminder stamp';
  else raise notice 'FAIL A1: expected 2 reminder columns on student_notify_state, found %', n; end if;

  -- `not null default true` has to mean "a student who has never opened the
  -- Account screen is reachable", and that includes every row that already
  -- existed when the column was added. Defaulting to false would silence the
  -- feature for exactly the lapsed students it was written for, and silence it
  -- invisibly: nothing is sent, so nothing is reported.
  select count(*) into n from public.student_notify_state where not reminder_opt_in;
  select count(*) into m from public.student_notify_state;
  if n = 0 and m > 0 then raise notice 'PASS A2: the new switch came up ON for every row that predates the migration';
  else raise notice 'FAIL A2: % of % pre-existing rows have reminders off', n, m; end if;

  -- Fixture guard. If either of these students already has a notify row, the
  -- backfill assertions below prove nothing at all.
  select count(*) into n from public.student_notify_state where user_id in (r1, r6);
  if n = 0 then raise notice 'PASS A3: fixture — the never-notified student and the admin start with no notify state';
  else raise notice 'FAIL A3: % notify rows already exist for R1/R6, so the backfill is untested', n; end if;

  -- THE headline. R1 has no state row, no history, and the lowest sort key
  -- there is, so a working claim has to CREATE their row before it can see them
  -- and then pick them ahead of everybody else. A batch of one is what makes
  -- that an ordering assertion rather than a membership one.
  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(p_max_users => 1, p_quiet_start => 0, p_quiet_end => 0);
  if coalesce(array_length(got, 1), 0) = 1 and r1 = any(got) then
    raise notice 'PASS B1: the student who has never been reminded is claimed, and claimed first';
  else raise notice 'FAIL B1: a batch of one returned %, wanted R1 alone', got; end if;

  select count(*) into n from public.student_notify_state where user_id = r1;
  if n = 1 then raise notice 'PASS B2: the backfill reached a student who had no notify state row';
  else raise notice 'FAIL B2: R1 has % notify rows after being claimed, expected 1', n; end if;

  -- The orphan. push_subscriptions has no foreign key on user_id while
  -- student_notify_state.user_id references profiles, so the backfill reads a
  -- table that can hold ids the table it writes to will reject — and `on
  -- conflict do nothing` does NOT catch that, because a missing parent is not a
  -- duplicate key. Without an exists(profiles) guard this one seeded row makes
  -- that INSERT raise foreign_key_violation and abort the whole function, on
  -- every tick, forever, with no symptom except that reminders stopped.
  --
  -- Note what actually asserts that: B1 passing at all. The claim has already
  -- run by the time this count is read, so a missing guard shows up as a psql
  -- ERROR and a dead DO block rather than as a FAIL line (run.ps1 greps for
  -- both). The count below catches the other direction — a guard that lets the
  -- row through and then writes notify state for an id that is nobody.
  select count(*) into n from public.student_notify_state where user_id = orp;
  if n = 0 then raise notice 'PASS B3: an orphaned student endpoint is skipped by the backfill, not fatal to it';
  else raise notice 'FAIL B3: the backfill wrote notify state for an endpoint with no profile'; end if;

  -- Sharing the budget is the load-bearing decision of the whole migration, so
  -- it is asserted on the very first grant. last_push_at is the column deal
  -- alerts and nearby alerts gate on, and a reminder has to move it. If this
  -- fails, reminders have become a third parallel 2-a-day on top of the other
  -- two and the real interruption rate has tripled with nothing to show it.
  select count(*) into n from public.student_notify_state
  where user_id = r1
    and day_count = 1 and week_count = 1
    and last_push_at is not null and last_reminder_at is not null;
  if n = 1 then raise notice 'PASS B4: the grant spent a slot from the SHARED notification budget and stamped the reminder';
  else raise notice 'FAIL B4: R1 shared counters or reminder stamp were not advanced by the grant'; end if;

  -- One wide call, six assertions. R1 is now inside their own interval, so the
  -- only candidates left are R3 (80h) and R4 (200h); everyone else is refused by
  -- a rule of their own, which is what the next four checks are about.
  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(p_max_users => 20, p_quiet_start => 0, p_quiet_end => 0);

  if r3 = any(got) then raise notice 'PASS B5: a student last reminded 80 hours ago is due again';
  else raise notice 'FAIL B5: R3 was not claimed 80 hours past a 72-hour interval'; end if;

  if not (r2 = any(got)) then raise notice 'PASS B6: a student reminded an hour ago is inside the minimum interval';
  else raise notice 'FAIL B6: R2 was reminded twice within an hour'; end if;

  if not (r5 = any(got)) then raise notice 'PASS B7: push_opt_in = false silences reminders as well as deals';
  else raise notice 'FAIL B7: R5 was reminded with push notifications switched off'; end if;

  -- role = 'admin' is not a student endpoint. Without this filter an operator's
  -- own browser starts receiving student reminders, which is the mix-up
  -- migration-032 split the roles to prevent.
  if not (r6 = any(got)) then raise notice 'PASS B8: an admin-only subscription is never claimed as a student';
  else raise notice 'FAIL B8: an operator browser was claimed as a student'; end if;

  if not (r7 = any(got)) then raise notice 'PASS B9: a student with no push subscription is never claimed';
  else raise notice 'FAIL B9: R7 was claimed with nothing to deliver to'; end if;

  if coalesce(array_length(got, 1), 0) = 2 then
    raise notice 'PASS B10: exactly the two due students were claimed and nobody else';
  else raise notice 'FAIL B10: the wide batch returned % rows, wanted 2 (R3 and R4)', coalesce(array_length(got, 1), 0); end if;

  -- The admin's row must not have been conjured either. The backfill is the one
  -- place in this function that WRITES to a table it did not read from, so a
  -- missing role filter there is worse than a missing one in the candidate
  -- query: it leaves state rows behind for ids that are not students at all.
  select count(*) into n from public.student_notify_state where user_id = r6;
  if n = 0 then raise notice 'PASS B11: the backfill is scoped to student endpoints and left the admin alone';
  else raise notice 'FAIL B11: the backfill created a notify row for an admin-only subscription'; end if;
end $$;

-- ---------- block 2: a refusal spends nothing ----------
--
-- THE assertion of this file. Claiming is what SPENDS the budget and the budget
-- is shared, so a refusal that still increments a counter does not merely skip
-- one reminder: it eats a deal alert the student would have had instead, plus
-- four hours of their cooldown, with no error raised anywhere.
--
-- Each refusal below is driven by exactly ONE rule with the other two left wide
-- open, so "it refused" cannot be true for a second reason. Every counter is
-- snapshotted before the call and compared after, updated_at included: on the
-- refusal path the function must not write to the row AT ALL.
do $$
declare
  r8  uuid := '00000000-0000-0000-0000-000000000608';
  got uuid[];
  before_day     integer;
  before_week    integer;
  before_push    timestamptz;
  before_rem     timestamptz;
  before_updated timestamptz;
  after_day      integer;
  after_week     integer;
  after_push     timestamptz;
  after_rem      timestamptz;
  after_updated  timestamptz;
begin
  -- Park everybody, then bring forward only the student this block is about.
  -- With one shared candidate query and a p_max_users limit, a student left due
  -- from an earlier block quietly takes a slot and turns these assertions into
  -- coincidences.
  update public.student_notify_state set last_reminder_at = now();

  -- ---- the weekly cap ----
  -- week_start is pinned to now() because a window that has already rolled over
  -- is not a cap: the rollover zeroes the count before the test can read it, and
  -- the claim would be granted for a reason this block never intended to allow.
  update public.student_notify_state
     set last_reminder_at = now() - interval '200 hours',
         last_push_at     = null,
         day_count = 0, day_start = now(),
         week_count = 5, week_start = now()
   where user_id = r8;

  -- Snapshotted AFTER the setup update rather than written as literals, so this
  -- holds whether or not updated_at is maintained by hand or by a trigger.
  select day_count, week_count, last_push_at, last_reminder_at, updated_at
    into before_day, before_week, before_push, before_rem, before_updated
    from public.student_notify_state where user_id = r8;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(p_max_users => 20, p_quiet_start => 0, p_quiet_end => 0);
  if not (r8 = any(got)) then raise notice 'PASS C1: the weekly cap refuses once week_count has reached it';
  else raise notice 'FAIL C1: R8 was claimed with 5 of 5 weekly slots already spent'; end if;

  select day_count, week_count, last_push_at, last_reminder_at, updated_at
    into after_day, after_week, after_push, after_rem, after_updated
    from public.student_notify_state where user_id = r8;
  -- `is not distinct from` rather than `=` throughout: every one of these three
  -- is nullable, and null = null is null, which an `if` reads as false. Written
  -- with plain equality this assertion would report a failure for a function
  -- that correctly left a null stamp alone.
  if after_day = before_day and after_week = before_week
     and after_push is not distinct from before_push
     and after_rem is not distinct from before_rem
     and after_updated is not distinct from before_updated then
    raise notice 'PASS C2: A REFUSAL SPENDS NO QUOTA — not one counter, stamp or even updated_at moved';
  else
    raise notice 'FAIL C2: the refusal wrote to the row: day %->%, week %->%, last_push_at %->%, last_reminder_at %->%, updated_at %->%',
      before_day, after_day, before_week, after_week,
      before_push, after_push, before_rem, after_rem, before_updated, after_updated;
  end if;

  -- ---- the daily cap, independently of the weekly one ----
  update public.student_notify_state
     set day_count = 2, day_start = now(),
         week_count = 0, week_start = now(),
         last_push_at = null,
         last_reminder_at = now() - interval '200 hours'
   where user_id = r8;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(p_max_users => 20, p_quiet_start => 0, p_quiet_end => 0);
  if not (r8 = any(got)) then raise notice 'PASS C3: the daily cap refuses once day_count has reached it';
  else raise notice 'FAIL C3: R8 was claimed with 2 of 2 daily slots already spent'; end if;

  select day_count, week_count, last_push_at into after_day, after_week, after_push
    from public.student_notify_state where user_id = r8;
  if after_day = 2 and after_week = 0 and after_push is null then
    raise notice 'PASS C4: the daily-cap refusal spent nothing either';
  else raise notice 'FAIL C4: day=% week=% last_push_at=% after a capped refusal', after_day, after_week, after_push; end if;

  -- ---- the cooldown the OTHER features wrote ----
  -- The shared budget has to work in both directions. last_push_at here was set
  -- by a deal alert or a nearby alert rather than by a reminder, and the reminder
  -- must still stand down: the student was interrupted ten minutes ago and does
  -- not care which feature did it. This is the direction a parallel budget would
  -- have broken, and it breaks silently — the reminder simply arrives too soon.
  update public.student_notify_state
     set last_push_at = now() - interval '10 minutes',
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now(),
         last_reminder_at = now() - interval '200 hours'
   where user_id = r8;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(p_max_users => 20, p_quiet_start => 0, p_quiet_end => 0);
  if not (r8 = any(got)) then
    raise notice 'PASS C5: a student pushed ten minutes ago by another feature is not also reminded';
  else raise notice 'FAIL C5: a reminder was granted inside the shared four-hour cooldown'; end if;

  -- Room under everything, same student, same interval: the claim is granted.
  -- Without this the four refusals above would pass just as well if the function
  -- were refusing R8 for some reason nothing in this block controls.
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now(),
         last_reminder_at = now() - interval '200 hours'
   where user_id = r8;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(p_max_users => 20, p_quiet_start => 0, p_quiet_end => 0);
  if r8 = any(got) then raise notice 'PASS C6: with room under the cooldown and both caps the same student is claimed';
  else raise notice 'FAIL C6: R8 refused with the whole budget wide open'; end if;
end $$;

-- ---------- block 3: reminder_opt_in silences reminders and nothing else ----------
--
-- The mirror image of behavior-051.sql's push_opt_in assertion, and the property
-- that justifies a third column instead of reusing push_opt_in. A student who
-- does not want to be nagged back into the app may well still want to hear that
-- their usual coffee shop is doing half price today: those are different
-- questions, the Account screen offers them as different switches, and this
-- block is what stops the new one quietly becoming a master switch.
do $$
declare
  r4   uuid := '00000000-0000-0000-0000-000000000604';
  v1   uuid := '00000000-0000-0000-0000-0000000006b1';   -- Reminder Cafe, never visited
  got  uuid[];
  flag boolean;
  n    integer;
begin
  update public.student_notify_state set last_reminder_at = now();
  update public.student_notify_state
     set reminder_opt_in = false,
         last_reminder_at = now() - interval '200 hours',
         last_push_at     = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now()
   where user_id = r4;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(p_max_users => 20, p_quiet_start => 0, p_quiet_end => 0);
  if not (r4 = any(got)) then raise notice 'PASS D1: reminder_opt_in = false refuses the reminder';
  else raise notice 'FAIL D1: R4 was reminded with the reminder switch off'; end if;

  select count(*) into n from public.student_notify_state
  where user_id = r4 and day_count = 0 and week_count = 0 and last_push_at is null;
  if n = 1 then raise notice 'PASS D2: the opt-out refusal spent no quota';
  else raise notice 'FAIL D2: an opted-out student had their shared budget charged'; end if;

  -- DEAL ALERTS still reach them. R4 carries a queued campaign from the seed, so
  -- this is the real claim_campaign_pushes answering rather than a proxy for it.
  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_campaign_pushes(p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0);
  if r4 = any(got) then raise notice 'PASS D3: turning reminders off does NOT silence deal alerts';
  else raise notice 'FAIL D3: the reminder switch suppressed a vendor campaign'; end if;

  -- That deal claim just spent R4's cooldown, so hand it back before asking the
  -- third feature. Nothing about the budget is being proved here, only that the
  -- reminder switch is not a master switch, and leaving the cooldown in place
  -- would make the nearby claim below refuse for the wrong reason and read as a
  -- pass of the opposite assertion.
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now()
   where user_id = r4;

  -- NEARBY ALERTS still reach them too. Reminder Cafe is a spot R4 has never
  -- earned at and has never been told about (this seed holds no transactions and
  -- no nearby ledger rows), so migration-051's once-ever and visited tests cannot
  -- be what decides this call. Real CAMPAIGN_CONFIG numbers rather than the wide
  -- open 0/99/99 of behavior-051, because the point is that the student is still
  -- reachable under the budget they actually have.
  select public.claim_nearby_notification(r4, v1, 240, 2, 5, 0, 0, 'UTC') into flag;
  if flag then raise notice 'PASS D4: turning reminders off does NOT silence nearby alerts';
  else raise notice 'FAIL D4: the reminder switch suppressed a nearby alert'; end if;

  -- Back on, so a -Keep container is left in a state that still describes the
  -- seed's world rather than this one block's.
  update public.student_notify_state set reminder_opt_in = true where user_id = r4;
end $$;

-- ---------- block 4: quiet hours answer before anything else happens ----------
--
-- Driven from the CURRENT hour rather than a literal: [h, h+1) always contains
-- now and [h+1, h+2) never does, so this file does not pass or fail depending on
-- what time the harness was started at. UTC for the same reason — the
-- container's idea of campus time is not the thing under test.
--
-- "Returns no rows" is the weaker half. The sharper assertion is about ORDER:
-- the quiet-hours check sits BEFORE the backfill, so a 3am tick must not even
-- create state rows. That is harmless today and still worth pinning, because
-- the backfill is a WRITE, and a write inside a window whose whole promise is
-- "nothing happens" is exactly the thing that grows a second write later.
do $$
declare
  r1  uuid := '00000000-0000-0000-0000-000000000601';
  r2  uuid := '00000000-0000-0000-0000-000000000602';
  r3  uuid := '00000000-0000-0000-0000-000000000603';
  got uuid[];
  n   integer;
  h   integer;
begin
  update public.student_notify_state set last_reminder_at = now();
  update public.student_notify_state
     set last_reminder_at = now() - interval '200 hours',
         last_push_at     = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now()
   where user_id in (r2, r3);

  -- R1's row goes, so the backfill has something to recreate and E2 has
  -- something to look for. The last call in this block brings it back.
  delete from public.student_notify_state where user_id = r1;

  h := extract(hour from (now() at time zone 'UTC'))::integer;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(
    p_max_users => 20, p_quiet_start => h, p_quiet_end => (h + 1) % 24, p_timezone => 'UTC'
  );
  if coalesce(array_length(got, 1), 0) = 0 then
    raise notice 'PASS E1: a tick inside quiet hours returns no rows at all';
  else raise notice 'FAIL E1: % students claimed inside quiet hours', coalesce(array_length(got, 1), 0); end if;

  select count(*) into n from public.student_notify_state where user_id = r1;
  if n = 0 then raise notice 'PASS E2: quiet hours answer before the backfill, so the tick wrote nothing';
  else raise notice 'FAIL E2: a quiet-hours tick still backfilled a notify row'; end if;

  select count(*) into n from public.student_notify_state
  where user_id in (r2, r3) and day_count = 0 and week_count = 0 and last_push_at is null;
  if n = 2 then raise notice 'PASS E3: a quiet-hours refusal spends nobody''s quota';
  else raise notice 'FAIL E3: % of 2 due students still have an untouched budget', n; end if;

  -- Outside the window the identical call goes through, which is what proves E1
  -- was the window and not an empty candidate set. R1 comes back with it: the
  -- backfill runs now that the function gets past the clock.
  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(
    p_max_users => 20, p_quiet_start => (h + 1) % 24, p_quiet_end => (h + 2) % 24, p_timezone => 'UTC'
  );
  if coalesce(array_length(got, 1), 0) = 3 and r1 = any(got) and r2 = any(got) and r3 = any(got) then
    raise notice 'PASS E4: outside quiet hours the same tick claims all three due students';
  else raise notice 'FAIL E4: outside quiet hours the tick returned %, wanted R1, R2 and R3', got; end if;
end $$;

-- ---------- block 5: the two knobs the worker drives ----------
--
-- p_skip_users is how the caller keeps a tick from re-picking a student whose
-- push just failed in this process, and p_max_users is the batch size. Both are
-- asserted by presence and absence rather than by array order: with three
-- students due and a cap of two, the two that come back have to be the two that
-- have waited longest, and that is a claim about WHICH rows the limit kept, not
-- about the order they arrived in.
do $$
declare
  r1  uuid := '00000000-0000-0000-0000-000000000601';
  r2  uuid := '00000000-0000-0000-0000-000000000602';
  r3  uuid := '00000000-0000-0000-0000-000000000603';
  got uuid[];
begin
  update public.student_notify_state set last_reminder_at = now();

  -- Three due, in a deliberate order: R1 has waited longest, R3 the least. The
  -- stagger is what makes the p_max_users assertion an ordering one as well.
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now(),
         last_reminder_at = now() - make_interval(hours =>
           case user_id when r1 then 300 when r2 then 200 else 100 end)
   where user_id in (r1, r2, r3);

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(
    p_max_users => 20, p_skip_users => array[r1], p_quiet_start => 0, p_quiet_end => 0
  );
  if coalesce(array_length(got, 1), 0) = 2 and not (r1 = any(got)) and r2 = any(got) and r3 = any(got) then
    raise notice 'PASS F1: p_skip_users drops the named student and nobody else';
  else raise notice 'FAIL F1: with R1 skipped the tick returned %, wanted R2 and R3', got; end if;

  -- The same three stamps again: F1's call spent R2 and R3, and a student inside
  -- their own cooldown is not a student the cap kept out.
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now(),
         last_reminder_at = now() - make_interval(hours =>
           case user_id when r1 then 300 when r2 then 200 else 100 end)
   where user_id in (r1, r2, r3);

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(p_max_users => 2, p_quiet_start => 0, p_quiet_end => 0);
  if coalesce(array_length(got, 1), 0) = 2 and r1 = any(got) and r2 = any(got) and not (r3 = any(got)) then
    raise notice 'PASS F2: p_max_users caps the batch and keeps the two who have waited longest';
  else raise notice 'FAIL F2: a cap of 2 against 3 due students returned %', got; end if;
end $$;

-- ---------- block 6: what a grant spends, and giving it back ----------
--
-- The grant and the refund are one assertion read in both directions. A claim
-- SPENDS the shared budget before anything has been delivered, which is the
-- right asymmetry and the one finish_campaign_batch picks deliberately
-- (double-notifying is worse than under-notifying) — and it is exactly why
-- refund_reminder_push has to exist. A claim whose push then fails has silenced
-- that student for four hours, across all three features, in exchange for
-- nothing at all, and nulling last_reminder_at is the half that also stops them
-- being parked for another 72 hours over a reminder they never received.
do $$
declare
  r2   uuid := '00000000-0000-0000-0000-000000000602';
  r6   uuid := '00000000-0000-0000-0000-000000000606';   -- has no notify row, ever
  v2   uuid := '00000000-0000-0000-0000-0000000006b2';   -- Budget Deli, never visited
  got  uuid[];
  flag boolean;
  n    integer;
  m    integer;
  ts   timestamptz;
  rem  timestamptz;
begin
  update public.student_notify_state set last_reminder_at = now();
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now(),
         last_reminder_at = now() - interval '200 hours'
   where user_id = r2;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(p_max_users => 20, p_quiet_start => 0, p_quiet_end => 0);
  if coalesce(array_length(got, 1), 0) = 1 and r2 = any(got) then
    raise notice 'PASS G1: the one due student is claimed';
  else raise notice 'FAIL G1: expected R2 alone, got %', got; end if;

  select day_count, week_count, last_push_at, last_reminder_at into n, m, ts, rem
    from public.student_notify_state where user_id = r2;
  if n = 1 and m = 1 and ts is not null and rem is not null then
    raise notice 'PASS G2: the grant moved day_count, week_count, last_push_at and last_reminder_at together';
  else raise notice 'FAIL G2: after a grant day=% week=% last_push_at=% last_reminder_at=%', n, m, ts, rem; end if;

  -- The cross-feature consequence, which is the whole case for one budget: a
  -- reminder at 4pm means no nearby alert at 4.05pm. Budget Deli is a spot R2
  -- has never earned at and has never been told about, so migration-051 can only
  -- be refusing on the cooldown this reminder just spent.
  select public.claim_nearby_notification(r2, v2, 240, 2, 5, 0, 0, 'UTC') into flag;
  if not flag then raise notice 'PASS G3: a reminder spends the shared cooldown, so a nearby alert behind it is refused';
  else raise notice 'FAIL G3: a nearby alert was granted inside the cooldown a reminder had just spent'; end if;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(p_max_users => 20, p_quiet_start => 0, p_quiet_end => 0);
  if not (r2 = any(got)) then raise notice 'PASS G4: a student just reminded is not reminded again';
  else raise notice 'FAIL G4: R2 was reminded twice in a row'; end if;

  select public.refund_reminder_push(r2) into flag;
  if flag then raise notice 'PASS G5: the refund reports that it reversed a row';
  else raise notice 'FAIL G5: refund_reminder_push returned false for a student it had just charged'; end if;

  select count(*) into n from public.student_notify_state
  where user_id = r2 and day_count = 0 and week_count = 0
    and last_push_at is null and last_reminder_at is null;
  if n = 1 then raise notice 'PASS G6: the refund gives back both counters and clears both stamps';
  else raise notice 'FAIL G6: the refund left R2 part-charged'; end if;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(p_max_users => 20, p_quiet_start => 0, p_quiet_end => 0);
  if r2 = any(got) then raise notice 'PASS G7: a refunded student is due again immediately, not in 72 hours';
  else raise notice 'FAIL G7: a failed send parked R2 for the whole minimum interval'; end if;

  -- G7's grant spent the cooldown again, so refund again. The other features
  -- getting their slot back is the point of nulling last_push_at rather than
  -- backdating it, and a refund being safe to repeat is the point of the
  -- greatest(count - 1, 0) that migration-033 documents.
  perform public.refund_reminder_push(r2);
  select public.claim_nearby_notification(r2, v2, 240, 2, 5, 0, 0, 'UTC') into flag;
  if flag then raise notice 'PASS G8: the refund releases the SHARED cooldown, so the other features get the slot back';
  else raise notice 'FAIL G8: a nearby alert was still refused after the reminder was refunded'; end if;

  -- Nothing to reverse is not an error, and must not invent a row: the worker
  -- refunds on a failed send without first checking whether the student it was
  -- handed still has state at all.
  select public.refund_reminder_push(r6) into flag;
  select count(*) into n from public.student_notify_state where user_id = r6;
  if not flag and n = 0 then raise notice 'PASS G9: refunding a student with no notify state reports false and writes nothing';
  else raise notice 'FAIL G9: refund on a missing row returned % and left % rows', flag, n; end if;

  -- The counters are now on 1 from G8's nearby grant. Two refunds against one
  -- charge must floor at zero: a refund that could go negative would hand that
  -- student unlimited notifications until the window rolled over, which is the
  -- exact failure greatest() exists to prevent.
  perform public.refund_reminder_push(r2);
  perform public.refund_reminder_push(r2);
  select day_count, week_count into n, m from public.student_notify_state where user_id = r2;
  if n = 0 and m = 0 then raise notice 'PASS G10: a repeated refund floors the counters at zero rather than going negative';
  else raise notice 'FAIL G10: a double refund drove the counters to day=% week=%', n, m; end if;
end $$;


-- ============================================================
-- Block 7: the three properties the blocks above never reach.
--
-- Each of these was found by an adversarial read of blocks 1-6 rather than by a
-- failure, and each is a named failure mode the file claimed to cover:
--
--   H  the privilege treatment of two SECURITY DEFINER functions. Nothing
--      anywhere asserted it, and a missing revoke is invisible until the day
--      somebody reaches these with the anon key every browser already holds.
--   I  the day/week ROLLOVER. Blocks 1-6 only ever set a FRESH window, so the
--      stale-window arms of the arithmetic never executed: every cap fixture was
--      excluded by the driving query's pre-filter before the in-loop check could
--      run. This is the one assertion that tells correct rollover apart from a
--      carry-over, and it is the arithmetic that has to match the two sibling
--      claim functions exactly.
--   J  quiet hours. E1 built its window from the current clock hour, so it only
--      entered the midnight-WRAP branch when that hour happened to be 23 --
--      roughly 4% of runs. And every other call passed (0, 0), which proves
--      nothing about `start = end` meaning "disabled": 0 >= 0 and 0 < 0 is false
--      in the plain branch too, so deleting the disabled arm entirely left all
--      40 assertions green.
-- ============================================================
do $$
declare
  r1 uuid := '00000000-0000-4000-9000-0000000000a1';
  v1 uuid;
  got uuid[];
  n integer; m integer;
  ds timestamptz; ws timestamptz;
  h integer;
  off integer;
  tz text;
  sig text := 'integer, uuid[], integer, integer, integer, integer, integer, integer, text';
begin
  select id into v1 from public.vendors where active = true limit 1;

  -- ---------- H: the functions are service_role only ----------
  if has_function_privilege('anon', 'public.claim_reminder_pushes(' || sig || ')', 'execute')
  then raise notice 'FAIL H1: anon can execute claim_reminder_pushes';
  else raise notice 'PASS H1: anon cannot execute claim_reminder_pushes'; end if;

  if has_function_privilege('authenticated', 'public.claim_reminder_pushes(' || sig || ')', 'execute')
  then raise notice 'FAIL H2: authenticated can execute claim_reminder_pushes';
  else raise notice 'PASS H2: authenticated cannot execute claim_reminder_pushes'; end if;

  if has_function_privilege('service_role', 'public.claim_reminder_pushes(' || sig || ')', 'execute')
  then raise notice 'PASS H3: service_role can execute claim_reminder_pushes';
  else raise notice 'FAIL H3: service_role cannot execute claim_reminder_pushes'; end if;

  if has_function_privilege('anon', 'public.refund_reminder_push(uuid)', 'execute')
  then raise notice 'FAIL H4: anon can execute refund_reminder_push';
  else raise notice 'PASS H4: anon cannot execute refund_reminder_push'; end if;

  if has_function_privilege('authenticated', 'public.refund_reminder_push(uuid)', 'execute')
  then raise notice 'FAIL H5: authenticated can execute refund_reminder_push';
  else raise notice 'PASS H5: authenticated cannot execute refund_reminder_push'; end if;

  if has_function_privilege('service_role', 'public.refund_reminder_push(uuid)', 'execute')
  then raise notice 'PASS H6: service_role can execute refund_reminder_push';
  else raise notice 'FAIL H6: service_role cannot execute refund_reminder_push'; end if;

  -- Both must be SECURITY DEFINER with search_path pinned, or a definer function
  -- resolves unqualified names against the caller's path.
  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname in ('claim_reminder_pushes', 'refund_reminder_push')
    and p.prosecdef
    and p.proconfig @> array['search_path=public'];
  if n = 2 then raise notice 'PASS H7: both functions are SECURITY DEFINER with search_path pinned';
  else raise notice 'FAIL H7: only % of 2 functions are definer-with-search_path', n; end if;

  -- The defaults the Privacy Policy section 7.4 promises, read out of the
  -- catalogue rather than inferred from behaviour. test/campaigns.test.js pins
  -- the same numbers on the JS side; this is the SQL half of that pairing.
  if pg_get_function_arguments(('public.claim_reminder_pushes(' || sig || ')')::regprocedure)
       like '%p_cooldown_minutes integer DEFAULT 240%'
     and pg_get_function_arguments(('public.claim_reminder_pushes(' || sig || ')')::regprocedure)
       like '%p_daily_cap integer DEFAULT 2%'
     and pg_get_function_arguments(('public.claim_reminder_pushes(' || sig || ')')::regprocedure)
       like '%p_weekly_cap integer DEFAULT 5%'
     and pg_get_function_arguments(('public.claim_reminder_pushes(' || sig || ')')::regprocedure)
       like '%p_quiet_start integer DEFAULT 22%'
     and pg_get_function_arguments(('public.claim_reminder_pushes(' || sig || ')')::regprocedure)
       like '%p_quiet_end integer DEFAULT 9%'
     and pg_get_function_arguments(('public.claim_reminder_pushes(' || sig || ')')::regprocedure)
       like '%p_min_interval_hours integer DEFAULT 72%'
  then raise notice 'PASS H8: the shipped defaults are the ones the Privacy Policy promises';
  else raise notice 'FAIL H8: a default moved: %', pg_get_function_arguments(('public.claim_reminder_pushes(' || sig || ')')::regprocedure); end if;

  -- ---------- I: a STALE window rolls over instead of carrying ----------
  -- Capped out on both counters, but both windows are expired, and due. The
  -- pre-filter must let this through on the stale-window arms and the in-loop
  -- arithmetic must then ZERO both counts before spending one -- so the student
  -- is claimed and comes back on 1 and 1, never on 3 and 6.
  insert into public.student_notify_state
    (user_id, push_opt_in, reminder_opt_in, last_push_at, last_reminder_at,
     day_start, day_count, week_start, week_count)
  values
    (r1, true, true, null, now() - interval '200 hours',
     now() - interval '30 hours', 2, now() - interval '8 days', 5)
  on conflict (user_id) do update set
    push_opt_in = true, reminder_opt_in = true, last_push_at = null,
    last_reminder_at = now() - interval '200 hours',
    day_start = now() - interval '30 hours', day_count = 2,
    week_start = now() - interval '8 days', week_count = 5;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, role)
  values (r1, 'https://push.example/rollover', 'p', 'a', 'student')
  on conflict (endpoint) do nothing;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(p_max_users => 50, p_quiet_start => 0, p_quiet_end => 0);
  if r1 = any(got) then raise notice 'PASS I1: a capped student whose windows have both expired is claimed';
  else raise notice 'FAIL I1: a stale window was treated as a live cap'; end if;

  select day_count, week_count, day_start, week_start into n, m, ds, ws
  from public.student_notify_state where user_id = r1;
  if n = 1 and m = 1 then raise notice 'PASS I2: both counters rolled over to zero and then spent one, not 3 and 6';
  else raise notice 'FAIL I2: rollover carried the old counts: day=% week=%', n, m; end if;
  if ds > now() - interval '1 minute' and ws > now() - interval '1 minute'
  then raise notice 'PASS I3: both windows were restamped to now by the rollover';
  else raise notice 'FAIL I3: windows not restamped: day_start=% week_start=%', ds, ws; end if;

  -- ---------- J: quiet hours, both branches, deterministically ----------
  -- The clock is moved by choosing a FIXED-OFFSET ZONE that makes the local hour
  -- 23, rather than by hoping the test runs at the right time. Etc/GMT signs are
  -- inverted by POSIX convention (Etc/GMT+5 is UTC-5), which is why the sign
  -- below looks backwards and is not.
  h := extract(hour from (now() at time zone 'UTC'))::integer;
  off := 23 - h;
  if off = 0 then tz := 'UTC';
  elsif off > 0 then tz := 'Etc/GMT-' || off::text;
  else tz := 'Etc/GMT+' || abs(off)::text;
  end if;

  perform public.refund_reminder_push(r1);   -- make r1 due again

  -- 23:00-00:00 in that zone is NOW, and it is the wrap branch (start > end).
  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(p_max_users => 50, p_quiet_start => 23, p_quiet_end => 0, p_timezone => tz);
  if array_length(got, 1) is null
  then raise notice 'PASS J1: the midnight-wrap branch refuses inside its window (local hour 23 in %)', tz;
  else raise notice 'FAIL J1: a wrapped quiet window claimed % students', array_length(got, 1); end if;

  -- 00:00-01:00 in the same zone is NOT now, same branch, opposite arm.
  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(p_max_users => 50, p_quiet_start => 0, p_quiet_end => 1, p_timezone => tz);
  if r1 = any(got)
  then raise notice 'PASS J2: outside the window the same branch allows the claim';
  else raise notice 'FAIL J2: a non-matching quiet window still refused'; end if;

  perform public.refund_reminder_push(r1);

  -- start = end must mean DISABLED, not a 23-hour window silencing everybody.
  --
  -- HONEST LIMIT, worth writing down rather than overclaiming: this assertion
  -- pins the observable BEHAVIOUR, and it cannot catch deletion of the
  -- `if p_quiet_start = p_quiet_end then null;` arm itself. For any equal pair
  -- (h, h) the two routes agree -- with the arm gone, `h > h` is false, so
  -- control reaches the plain branch and evaluates `v_hour >= h and v_hour < h`,
  -- which is false for every hour -- so the claim proceeds either way. The arm is
  -- therefore defensive documentation in this implementation, and what matters
  -- is that an equal pair never silences anyone. That is what is checked here,
  -- at the one hour where a mistake would be most visible (local 23, the same
  -- hour J1 just proved IS inside a wrapped window).
  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_reminder_pushes(p_max_users => 50, p_quiet_start => 23, p_quiet_end => 23, p_timezone => tz);
  if r1 = any(got)
  then raise notice 'PASS J3: start = end disables quiet hours rather than silencing the whole day';
  else raise notice 'FAIL J3: an equal quiet pair was treated as a window and refused the claim'; end if;
end $$;
