-- ============================================================
-- Migration 060 — "come back and spend what you have earned".
--
--   THE PROBLEM. Students sign up, earn on a first visit, and then never
--   redeem. Nothing in the app is wrong when that happens; they simply stop
--   opening it, and points they already own sit there until the student has
--   forgotten they exist. Every other notification in this codebase is
--   triggered by something SOMEONE ELSE did — a vendor composed a deal
--   (migration-032/047), the student walked past a shop (migration-051) — so a
--   student whose vendors are quiet and who stays home hears from WeRewards
--   literally never. This migration is the one notification whose trigger is
--   the absence of a trigger.
--
--   THE CADENCE IS 72 HOURS, which is "roughly twice a week" and is the whole
--   reason p_min_interval_hours exists as a separate knob from the shared
--   cooldown. 240 minutes (the cooldown) is the floor on being interrupted at
--   all; 72 hours is how often THIS feature is allowed to be the reason. Not
--   daily, because a reminder that arrives every day is a reminder that gets
--   the app's notification permission revoked, and browser permission is
--   one-shot — migration-032's header spells out that once a student taps
--   Block, requestPermission() no-ops forever and the deal alerts die with it.
--   A nag is therefore not merely ignorable; it is destructive to the two
--   features that actually have something to say.
--
--   THE BUDGET IS SHARED, NOT PARALLEL. This is the load-bearing decision, and
--   it is the same one migration-051 made for the same reason, so the shape
--   below is deliberately copied rather than reinvented: claim_reminder_pushes
--   reads AND writes student_notify_state.last_push_at / day_start / day_count /
--   week_start / week_count — the very counters claim_campaign_pushes and
--   claim_nearby_notification use. A reminder therefore SPENDS a deal-alert
--   slot, and vice versa.
--
--   Giving this feature its own quota was the obvious alternative and it is
--   wrong twice over:
--
--     • a student's tolerance for being buzzed by WeRewards is ONE number, not
--       one per feature. This is the third feature to want a share of it. A
--       third parallel 2/day would mean six interruptions a day on a product
--       whose own Privacy Policy promises two, and the reminder is the least
--       welcome of the three — it is the only one with no news in it;
--     • legal/student-privacy-policy.html §7.4 does not say "two per day per
--       feature". It says the limits are "limits on all of the above taken
--       together, not per channel and not per feature", and "Two per day is the
--       total number of times WeRewards will interrupt you, whatever the
--       reason". A parallel budget would make that paragraph false, which is a
--       promise broken rather than a knob mistuned.
--
--   The practical consequence, worth stating because it looks like a bug the
--   first time it is observed: a student who is being actively courted by
--   vendors will rarely get a reminder, because the deal alerts keep spending
--   the budget first. That is correct. The reminder exists for the students
--   NOBODY is messaging, and the cooldown it loses to is a message that was
--   more interesting than the one it would have sent.
--
--   WHY THERE IS NO RECIPIENTS TABLE. Campaigns drive from campaign_recipients:
--   rows somebody created, which both name the audience and remember who has
--   already been served. A reminder has no author and no audience worth
--   materialising — the audience is "every student with a live push endpoint",
--   which is a query, not a list. So the queue state collapses to one column,
--   last_reminder_at, and the function's own backfill (section 2, step b) is
--   what makes "every student" reachable: a student no notification feature has
--   ever claimed has no student_notify_state row at all, and a driving query
--   over that table would simply never see them. That backfill is the
--   difference between this feature covering the students it was written for
--   and it covering only the ones vendors had already noticed.
--
--   WHAT THIS FILE DOES NOT KNOW IS WHAT TO SAY. The claim answers "may this
--   student be interrupted by a reminder right now" and nothing else. What the
--   reminder then SAYS is a cascade in Node (src/lib/reminders.js): something
--   specific where there is something specific to say, a plain nudge where
--   there is not, so the push can never fire with an empty message. Keeping
--   that out of SQL is deliberate — copy changes weekly, and copy that lives in
--   a function body can only be changed by hand-applying another migration.
--   The cascade is also why refund_reminder_push exists in the same
--   breath as the claim: claiming SPENDS the budget, so a claim the caller then
--   cannot use — no content, or a push that no endpoint accepted — would
--   silence that student's deal alerts and nearby alerts for four hours in
--   exchange for nothing. That is migration-033's bug, and this is
--   migration-033's fix, pre-applied rather than discovered in a pilot.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-059. Safe to re-run.
-- ============================================================

begin;

-- ---------- 1. the student's fourth switch, and the queue state ----------
--
-- Defaults TRUE, matching push_opt_in, email_opt_in and nearby_opt_in, for the
-- reason migration-047 gives: a student who has never opened the Account screen
-- should be reachable, and the switch exists to STOP that rather than to start
-- it.
--
-- Independent of push_opt_in even though a reminder cannot be delivered without
-- push, because the two answer different questions. "I do not want to be told
-- about deals" and "I do not want to be chased about points I have not spent"
-- are separate opinions, and a student who turns this one off is the student
-- most likely to keep the other one on. The claim requires BOTH to be true, so
-- turning off Deal alerts does silence reminders as a side effect — that is
-- honest rather than sloppy: push_opt_in false means the stored endpoints are
-- GONE, not merely ignored (PATCH /api/me/notify deletes every role='student'
-- row for that account), so there is nothing left to deliver a reminder on.

alter table public.student_notify_state
  add column if not exists reminder_opt_in boolean not null default true;

comment on column public.student_notify_state.reminder_opt_in is
  'The student''s own switch (Account -> Weekly reminders). Independent of '
  'push_opt_in, email_opt_in and nearby_opt_in: wanting no reminders says '
  'nothing about wanting no deals. The claim requires this AND push_opt_in, '
  'since a reminder has no second transport to fall back to. See '
  'migration-060.';

-- THE WHOLE QUEUE, in one column. Unlike last_email_at (migration-047), which
-- is audit only, this one IS the gate: it is simultaneously "when were they
-- last reminded" and "where are they in the queue", because the driving query
-- orders by it ascending with nulls first. Null therefore means "never
-- reminded", which sorts to the very front — the correct place for a student
-- who has been earning quietly since before this feature existed.
--
-- Deliberately NOT a count and not a ledger table. There is no question anyone
-- has ever needed to ask of reminder history beyond "is this student due", and
-- a per-send ledger would be a table that grows forever to answer a question
-- one timestamp already answers. If reminder effectiveness ever needs measuring,
-- that measurement belongs in analytics, not in the hot path of the claim.

alter table public.student_notify_state
  add column if not exists last_reminder_at timestamptz;

comment on column public.student_notify_state.last_reminder_at is
  'When a reminder push was last CLAIMED for this student (not necessarily '
  'delivered — a failed send is refunded by refund_reminder_push, which nulls '
  'this). Both the 72-hour interval gate and the queue order: the claim sorts '
  'candidates by this ascending, nulls first, so a student who has never been '
  'reminded is served before anyone who has. See migration-060.';

-- The queue index. Without it every tick is a sequential scan of
-- student_notify_state plus a sort, which is fine at a few hundred students and
-- is not the shape this table is heading for: it gains a row per student per
-- signup and is read every REMINDER_TICK_SECONDS, forever.
--
-- The column list is NOT negotiable and a plain btree on last_reminder_at will
-- not serve this query. ASC in an index means NULLS LAST, while the claim orders
-- `asc nulls first` -- so the ordering has to be spelled out here to match, or
-- the planner sorts anyway and the index buys nothing. user_id rides along as
-- the tie-break the claim actually uses, which keeps the sort entirely inside
-- the index scan.
create index if not exists idx_student_notify_reminder_queue
  on public.student_notify_state (last_reminder_at asc nulls first, user_id);


-- ---------- 2. who may be reminded, right now ----------
--
-- Returns a set of user ids and nothing else. The caller (src/lib/reminders.js)
-- decides what each of them is told, and the budget is already spent by the
-- time it gets the row — so every id handed back is an obligation to either
-- send something or refund.
--
-- Shape taken from claim_campaign_pushes (migration-047) rather than from
-- claim_nearby_notification, because this is a WORKER claim: many students per
-- tick, driven by a server timer, no request waiting on the answer. The
-- per-student logic inside the loop is claim_nearby_notification's, because the
-- budget arithmetic is the same arithmetic in all three places and any drift
-- between them is a broken promise in §7.4.
--
-- NOTE FOR THE NEXT PERSON TO ADD A PARAMETER: this function is new, so there
-- is no older arity to drop. If a parameter is ever added, `create or replace`
-- alone will leave the current signature in place as a separate overload, and
-- PostgREST resolves rpc() by argument NAMES — the pair then becomes ambiguous
-- at runtime and the feature fails in production only. Drop first, create, then
-- re-grant, exactly as migration-033 and migration-047 had to.

create or replace function public.claim_reminder_pushes(
  -- Students settled per tick. Small on purpose, like CAMPAIGN_CONFIG's
  -- batchUsers: the queue is ordered by how long each student has been waiting,
  -- so a backlog drains fairly over several ticks instead of being blasted out
  -- in one breath on the day this migration is applied — when EVERY student is
  -- due at once, because last_reminder_at starts null for all of them.
  p_max_users          integer default 20,
  -- Students the caller has already decided not to serve this tick. Two kinds,
  -- both supplied by src/lib/reminders.js:
  --
  --   * whoever currently has the app in the foreground (visibleUserIds()) --
  --     the chirp achieves nothing and spending their shared quota on it is
  --     actively harmful. Same exclusion the campaign worker makes.
  --   * whoever a recent tick claimed and then could not reach (recentlyFailed).
  --     This one is load-bearing rather than polite: refund_reminder_push nulls
  --     last_reminder_at to give the budget back, and the queue below is ordered
  --     by that column NULLS FIRST -- so a refund also returns the student to the
  --     head of the queue. For a transient failure that is right; for an endpoint
  --     failing with a code src/lib/push.js does not prune (it deletes only on
  --     401/403/404/410) it is a loop that would hold a slot forever.
  p_skip_users         uuid[]  default '{}',
  -- The 2x/week cadence. Separate from p_cooldown_minutes because they bound
  -- different things: the cooldown is how close together ANY two notifications
  -- may be, this is how often a reminder specifically may be the reason. See
  -- the header.
  p_min_interval_hours integer default 72,
  -- Same knobs, same defaults, same environment variables as CAMPAIGN_CONFIG in
  -- src/lib/campaigns.js — because they are the same budget. src/lib/reminders.js
  -- passes that module's values rather than keeping a third copy, so retuning
  -- the storm defences retunes all three features at once. These five are also
  -- the numbers legal/student-privacy-policy.html §7.4 promises and
  -- test/campaigns.test.js asserts; they do not get changed here.
  p_cooldown_minutes   integer default 240,
  p_daily_cap          integer default 2,
  p_weekly_cap         integer default 5,
  p_quiet_start        integer default 22,
  p_quiet_end          integer default 9,
  p_timezone           text    default 'America/New_York'
)
returns table (out_user_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  u            record;
  st           student_notify_state%rowtype;
  v_hour       integer;
  v_day_start  timestamptz;
  v_week_start timestamptz;
begin
  -- (a) Quiet hours, campus-local, identical in shape to claim_campaign_pushes
  -- and claim_nearby_notification. First, and before the backfill, so a tick
  -- inside the quiet window writes NOTHING at all — it is a read of one clock
  -- and a return. A reminder is the single least urgent notification the app
  -- sends; there is no version of "you have points to spend" that is worth
  -- waking someone at 3am, and unlike a deal it does not even expire.
  v_hour := extract(hour from (now() at time zone p_timezone))::integer;
  if p_quiet_start = p_quiet_end then
    null;                                              -- quiet hours disabled
  elsif p_quiet_start > p_quiet_end then               -- window wraps midnight
    if v_hour >= p_quiet_start or v_hour < p_quiet_end then return; end if;
  else
    if v_hour >= p_quiet_start and v_hour < p_quiet_end then return; end if;
  end if;

  -- (b) Make every student reachable. student_notify_state rows are created
  -- lazily, by whichever notification feature claims a student first — so
  -- before this insert the table holds exactly the students a vendor has
  -- campaigned to or who have walked past somewhere new, and a driving query
  -- over it would quietly exclude everyone else. Those are precisely the
  -- students this feature exists for: the ones nobody is messaging.
  --
  -- Costs one indexed scan per tick (idx_push_subs_user_role) and inserts
  -- nothing after the first, which is the right trade for not needing a
  -- separate backfill script an operator has to remember to run.
  --
  -- THE `exists (profiles)` GUARD IS NOT BELT-AND-BRACES. push_subscriptions
  -- has no foreign key on user_id (the error_logs convention, migration-018)
  -- while student_notify_state.user_id references profiles(user_id) — so an
  -- orphaned student endpoint, which is what a profile deleted outside POST
  -- /api/me/delete leaves behind, would make this single INSERT raise
  -- foreign_key_violation. `on conflict do nothing` does not catch that: it
  -- handles a duplicate key, not a missing parent. One orphan row would
  -- therefore abort the entire function on every tick, forever, and the only
  -- symptom would be that reminders silently stopped.
  insert into student_notify_state (user_id)
  select distinct ps.user_id
  from push_subscriptions ps
  where ps.role = 'student'
    and ps.user_id is not null
    and exists (select 1 from profiles pr where pr.user_id = ps.user_id)
  on conflict do nothing;

  -- (c) The candidates, longest-waiting first.
  --
  -- The driving query repeats every rule the loop re-checks under the lock, and
  -- that duplication is not optional — it is the same trap migration-047
  -- documents. This is ordered oldest-first and capped at p_max_users, so a
  -- student who is selected here and then skipped inside the loop still
  -- consumes one of those slots. Let an ineligible student through and they sit
  -- at the head of the queue (their last_reminder_at is the oldest, which is
  -- exactly why they were picked) spending a slot every tick for as long as
  -- their cooldown lasts, starving everyone behind them. Every `continue`
  -- inside the loop is therefore a race guard, not the fence.
  --
  -- The shared-budget pre-filter below tests the same windows migration-047
  -- tests, written out positively: day_start <= now() - 24h means the counts
  -- are about to be rolled over to zero, so a capped-out count on a stale
  -- window is not a reason to exclude anybody. Where this and the in-loop
  -- arithmetic could ever disagree, the loop wins — it holds the lock — so the
  -- worst a disagreement can cost is one wasted slot, never an extra
  -- notification.
  for u in
    -- Aliased st2, not the obvious st: `st` is the rowtype variable declared
    -- above, and plpgsql substitutes variables into queries BEFORE the planner
    -- sees them, so `st.user_id` here would resolve against that record instead
    -- of this table and the function would fail to run at all.
    select st2.user_id as uid
    from student_notify_state st2
    where st2.reminder_opt_in = true
      and st2.push_opt_in = true
      and st2.user_id <> all(coalesce(p_skip_users, '{}'::uuid[]))
      -- No endpoint, no claim. A reminder has no email fallback (unlike a deal,
      -- migration-047): it is a nudge, not news, and mailing someone to say
      -- nothing has happened is how an account gets marked as spam. So a
      -- student with no live push subscription is simply not a candidate.
      and exists (
        select 1 from push_subscriptions ps
        where ps.user_id = st2.user_id and ps.role = 'student'
      )
      -- Due. Null is "never reminded", which is both due and first in line.
      and (
        st2.last_reminder_at is null
        or st2.last_reminder_at <= now() - make_interval(hours => greatest(p_min_interval_hours, 0))
      )
      -- Not inside the shared cooldown, and not capped out for the day or the
      -- week. Stated positively, and with the `is null` arms spelled out, so
      -- every arm is the same expression the loop's rollover uses: a null or
      -- expired window means the counters are about to be zeroed, which is not
      -- a reason to exclude anybody. Written as `not (... and ...)` instead,
      -- these would be three-valued: a null day_start makes the inner AND null
      -- rather than false, and NOT null is null, which WHERE drops.
      and (
        st2.last_push_at is null
        or st2.last_push_at <= now() - make_interval(mins => greatest(p_cooldown_minutes, 0))
      )
      and (
        st2.day_start is null
        or st2.day_start <= now() - interval '24 hours'
        or st2.day_count < p_daily_cap
      )
      and (
        st2.week_start is null
        or st2.week_start <= now() - interval '7 days'
        or st2.week_count < p_weekly_cap
      )
    order by st2.last_reminder_at asc nulls first, st2.user_id
    -- greatest(), so a caller passing null (or 0) claims one student rather
    -- than every student in the table: `limit null` is no limit at all, and the
    -- one tick that got it would reminder-bomb the entire campus.
    limit greatest(p_max_users, 1)
  loop
    -- FOR UPDATE SKIP LOCKED, not the plain FOR UPDATE claim_nearby_notification
    -- uses, and the difference is worth stating because the two functions are
    -- otherwise the same shape. Nearby is one request about one student, and the
    -- contention it serialises is that student's own two devices deciding they
    -- are near the same shop in the same second — waiting microseconds is
    -- correct there, and skipping would drop a claim nobody will retry. Here
    -- there are twenty other students to get on with and another tick along in
    -- thirty seconds, so a row another worker (a second dyno, or an overlapping
    -- tick) already holds is somebody else's problem: skip it and keep the batch
    -- moving rather than blocking the whole tick on one lock.
    select * into st from student_notify_state
    where user_id = u.uid
    for update skip locked;
    if not found then continue; end if;             -- another worker owns them

    -- Re-checked under the lock, every one of them. The caller's view came from
    -- the driving query's snapshot, which is already stale by the time we are
    -- here: between the scan and this lock the student may have turned the
    -- switch off on another device, dropped their last endpoint, or been claimed
    -- by a deal alert or a nearby alert that spent the budget we are about to
    -- spend. The ONE condition not re-tested is p_skip_users, which is an
    -- argument rather than state and so cannot have changed underneath us.
    if not st.reminder_opt_in then continue; end if;
    if not st.push_opt_in     then continue; end if;

    if st.last_reminder_at is not null
       and st.last_reminder_at > now() - make_interval(hours => greatest(p_min_interval_hours, 0))
    then
      continue;
    end if;

    if not exists (
      select 1 from push_subscriptions ps
      where ps.user_id = u.uid and ps.role = 'student'
    ) then
      continue;
    end if;

    -- (d) The shared budget. Same three tests, same rollover arithmetic, same
    -- columns as claim_campaign_pushes and claim_nearby_notification — see this
    -- migration's header on why the budget is shared rather than parallel.
    --
    -- THE hard guarantee first: whatever any number of vendors, nearby spots and
    -- reminders do, two notifications to one student can never be closer
    -- together than the cooldown.
    if st.last_push_at is not null
       and st.last_push_at > now() - make_interval(mins => greatest(p_cooldown_minutes, 0))
    then
      continue;
    end if;

    v_day_start  := st.day_start;
    v_week_start := st.week_start;
    if v_day_start is null or v_day_start <= now() - interval '24 hours' then
      v_day_start := now(); st.day_count := 0;
    end if;
    if v_week_start is null or v_week_start <= now() - interval '7 days' then
      v_week_start := now(); st.week_count := 0;
    end if;
    if st.day_count >= p_daily_cap or st.week_count >= p_weekly_cap then continue; end if;

    -- (e) Spend it. last_push_at is the SHARED cooldown (so this reminder also
    -- holds off the next deal alert for four hours, which is the entire point of
    -- sharing); last_reminder_at is this feature's own 72-hour gate and its
    -- place in the queue. Both move together, and the day/week counters tick
    -- against the same two per day the Privacy Policy promises.
    --
    -- Spent BEFORE anything is delivered, like both sibling functions, because
    -- that is what makes the claim atomic under this row lock and stops two
    -- dynos notifying the same student twice. refund_reminder_push below is how
    -- a claim that delivered nothing gets undone.
    update student_notify_state
    set last_push_at     = now(),
        last_reminder_at = now(),
        day_start        = v_day_start,
        day_count        = st.day_count + 1,
        week_start       = v_week_start,
        week_count       = st.week_count + 1,
        updated_at       = now()
    where user_id = u.uid;

    out_user_id := u.uid;
    return next;
  end loop;
end;
$$;

comment on function public.claim_reminder_pushes(integer, uuid[], integer, integer, integer, integer, integer, integer, text) is
  'Students who may be sent a "come back and spend your points" reminder right '
  'now, longest-waiting first. Spends a slot from the SAME daily/weekly budget '
  'as vendor deal alerts and nearby alerts, at claim time — so every id '
  'returned must be either sent to or handed to refund_reminder_push. Roughly '
  '2x/week per student (p_min_interval_hours). See migration-060.';

revoke execute on function public.claim_reminder_pushes(integer, uuid[], integer, integer, integer, integer, integer, integer, text) from public, anon, authenticated;
grant  execute on function public.claim_reminder_pushes(integer, uuid[], integer, integer, integer, integer, integer, integer, text) to service_role;


-- ---------- 3. give it back when nothing was delivered ----------
--
-- The mirror of finish_campaign_batch(p_refund => true) (migration-033), for
-- the same bug and with the same arithmetic. The claim spends the student's
-- quota before the worker has spoken to any push service, which is right; what
-- is not right is a claim that then delivers NOTHING still costing four hours
-- of silence across every notification the student does want. Migration-033
-- watched that happen in the pilot — a student with a VAPID-mismatched
-- subscription claimed, charged and notified of nothing, every four hours,
-- forever, with no symptom at all.
--
-- WHY THE DOUBLE-NOTIFY OBJECTION DOES NOT APPLY. A refund is a way to
-- double-notify, which is why migration-032 refused to do it in general. The
-- caller passes a user here only when zero endpoints accepted the payload, or
-- when the content cascade came up empty and nothing was ever composed. There
-- is no maybe-it-landed case to protect against: nothing left the building. A
-- PARTIAL failure (one device accepted, another did not) must NOT be refunded —
-- the student was notified.
--
-- last_reminder_at = null, not "the value it had before", because this function
-- cannot know the old value and does not need to: null means never reminded,
-- which puts the student straight back at the head of the queue for the next
-- tick. That is the correct outcome for someone we tried and failed to reach,
-- and the small inaccuracy it leaves in the audit meaning of the column is
-- documented on the column itself.

create or replace function public.refund_reminder_push(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  if p_user_id is null then return false; end if;

  update student_notify_state s
  -- last_push_at = null is what actually releases the four-hour cooldown, and
  -- it is safe precisely because nothing was delivered: that column exists to
  -- space out notifications the student RECEIVED.
  set last_push_at     = null,
      -- greatest(...,0) because these counters are also zeroed by the
      -- daily/weekly rollover inside the claim functions. A refund arriving
      -- just after a rollover must never drive them negative and hand one
      -- student an unlimited allowance.
      day_count        = greatest(s.day_count  - 1, 0),
      week_count       = greatest(s.week_count - 1, 0),
      last_reminder_at = null,                 -- due again immediately
      updated_at       = now()
  where s.user_id = p_user_id;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

comment on function public.refund_reminder_push(uuid) is
  'Reverses one claim_reminder_pushes claim whose reminder was never delivered '
  '(no endpoint accepted it, or the content cascade had nothing to say): '
  'releases the shared cooldown, decrements the shared day/week counters, and '
  'makes the student due again. Call ONLY when nothing at all was delivered — '
  'a partial success was a notification. Returns whether a row existed. See '
  'migration-060.';

revoke execute on function public.refund_reminder_push(uuid) from public, anon, authenticated;
grant  execute on function public.refund_reminder_push(uuid) to service_role;

commit;
