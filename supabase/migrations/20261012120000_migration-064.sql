-- ============================================================
-- Migration 064 — email reach for reminders and announcements.
--
--   THE PROBLEM, and it is a loop. Push is the only channel that can reach a
--   student who is not in the app, and a push subscription can only ever be
--   created FROM INSIDE the app: POST /api/me/push/subscribe sits behind
--   requireConsent, so a student has to open WeRewards, get past the consent
--   modal and grant permission before a single endpoint exists. A student who
--   has drifted away therefore has no endpoint, and the one tool built to bring
--   them back is the one tool that cannot reach them. Reminders and broadcasts
--   both refuse to claim such a student at all (migration-060's "No endpoint, no
--   claim", migration-061's "Reachable at all"), which is correct given push is
--   all they have — and is exactly what this migration changes.
--
--   Email has none of those preconditions. It needs no visit, no permission
--   grant, no service worker, and no platform support, which also makes it the
--   ONLY channel that currently works on the iOS app at all: that build is a
--   Capacitor WKWebView (capacitor.config.json server.url) and WKWebView
--   exposes no PushManager, so every student on the App Store build is in the
--   unreachable set no matter how many times they open it. Native APNs is the
--   real fix there and is not this migration; see docs/apns-plan.md.
--
--   WHAT THIS CHANGES. Both claims learn the reach pattern migration-047 gave
--   claim_campaign_pushes: a p_email_enabled argument, an out_reach column
--   saying 'push' / 'email' / 'both', and a candidate test that passes a student
--   who has one channel or the other rather than demanding push. Nothing about
--   the shared budget moves. An email counts against the same two-per-day and
--   five-per-week as a push, spends the same cooldown, and honours the same
--   quiet hours, because it is the same student_notify_state row being locked
--   and spent — which is what keeps Privacy Policy §7.4's "two per day is the
--   total number of times WeRewards will interrupt you, whatever the reason"
--   true with a second channel in play.
--
--   ⚠ THIS MIGRATION DEPENDS ON 060 AND 061 BEING APPLIED. It replaces two
--   functions those files create. Applied against a database that never got
--   them, the drops are no-ops, the creates succeed, and the features still do
--   nothing because their tables (student_notify_state.reminder_opt_in,
--   admin_broadcasts) are absent — in which case apply 060, 061 and 062 first,
--   in order. Check before pasting:
--       select proname from pg_proc where proname in
--         ('claim_reminder_pushes','claim_admin_broadcast_pushes');
--
--   ⚠ AND IT WIDENS THE REMINDER AUDIENCE SHARPLY, by design. The backfill in
--   (b) below previously seeded student_notify_state only from
--   push_subscriptions, so the candidate set was "students who once turned on
--   alerts". With email reach it seeds from profiles too, which makes every
--   student with a usable address a reminder candidate — reminder_opt_in
--   defaults true, so that is most of them, and the first tick after this is
--   applied will have a far larger queue than any tick before it. The caps are
--   what make that safe rather than a mailshot: 72 hours between reminders per
--   student (p_min_interval_hours), two a day and five a week shared with every
--   other notification, nothing between 10pm and 9am, and p_max_users per tick.
--   Nobody receives more mail than the limits already allowed. But the TOTAL
--   number of messages leaving the system does step up, so watch the Resend
--   dashboard and the notification log for the first few days.
--
--   ⚠ NOT EVERY REMINDER MAY BE EMAILED, and the claim cannot enforce that.
--   migration-060 refused an email fallback on the ground that a reminder "is a
--   nudge, not news, and mailing someone to say nothing has happened is how an
--   account gets marked as spam". That reasoning is right and is kept: the
--   decision just moves to where the words exist. composeReminder in
--   src/lib/reminders.js has five tiers, and only three of them name a concrete
--   fact about this student — afford ("you have 400 pts at X, enough for Y"),
--   close ("just 40 pts to go") and deal ("X has something on"). The other two
--   (discover, and the generic "your points are waiting") say nothing that is
--   true of them specifically, and src/lib/reminders.js will not email those.
--   The tier is computed in Node from balances, rewards and live deals, so SQL
--   cannot know it at claim time; hence defer_reminder_push below.

begin;

-- ---------- 1. hand a claim back without re-queueing it ----------
--
-- The third outcome, and the reason it needs its own function rather than a
-- call to refund_reminder_push (migration-060).
--
-- A refund means WE TRIED AND FAILED: zero endpoints accepted the payload, or
-- the content cascade came up empty. It sets last_reminder_at = null, which
-- means "never reminded", which puts the student straight back at the head of
-- the queue for the next tick. For a delivery failure that is exactly right.
--
-- A DEFER means we reached them fine and chose not to speak: the tier we
-- composed was discover or generic, the student has no push endpoint, and the
-- rule above says those tiers do not go out by email. Refunding that would be a
-- bug with teeth. last_reminder_at = null makes them due immediately, they are
-- ordered oldest-first so they return to the head of the queue, their tier is
-- still generic thirty seconds later, and they are claimed, deferred and
-- refunded again — every tick, forever, spending one of p_max_users slots each
-- time and starving the students behind them. That is precisely the trap
-- migration-060's driving-query comment warns about, reached from a direction
-- that comment did not anticipate.
--
-- So: give back the SHARED budget, because nothing was delivered and a
-- notification the student never received must not silence the next one — but
-- leave last_reminder_at where the claim set it, so this student waits out
-- their 72 hours like anyone who was reminded. They lose one reminder slot they
-- could not have used anyway, and the queue keeps moving.
create or replace function public.defer_reminder_push(p_user_id uuid)
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
  set last_push_at = null,
      -- greatest(...,0) for the reason refund_reminder_push gives: these
      -- counters are also zeroed by the daily/weekly rollover inside the claim,
      -- and a defer arriving just after one must not drive them negative and
      -- hand a student an unlimited allowance.
      day_count    = greatest(s.day_count  - 1, 0),
      week_count   = greatest(s.week_count - 1, 0),
      -- last_reminder_at DELIBERATELY NOT TOUCHED. This is the whole difference
      -- from refund_reminder_push, and the comment above is why.
      updated_at   = now()
  where s.user_id = p_user_id;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

comment on function public.defer_reminder_push(uuid) is
  'Release the shared notification budget for a reminder that was claimed and '
  'deliberately not sent (a tier with no concrete fact in it, which may not go '
  'out by email), while LEAVING last_reminder_at so the student waits out their '
  'cadence gate instead of re-queueing every tick. Not refund_reminder_push: '
  'that one is for a delivery that failed. See migration-064.';

revoke execute on function public.defer_reminder_push(uuid) from public, anon, authenticated;
grant  execute on function public.defer_reminder_push(uuid) to service_role;


-- ---------- 2. reminders, now reachable by email ----------
--
-- Replaced wholesale rather than patched, because the return type changes and
-- Postgres will not `create or replace` across that ("cannot change return type
-- of existing function"). The drop names the OLD nine-type identity; the new one
-- has ten. Both are checked by test/migration-signatures.test.js, which exists
-- because migration-061 shipped the wrong arity here once already.
drop function if exists public.claim_reminder_pushes(integer, uuid[], integer, integer, integer, integer, integer, integer, text);

create or replace function public.claim_reminder_pushes(
  -- Students settled per tick. Small on purpose, like CAMPAIGN_CONFIG's
  -- batchUsers: the queue is ordered by how long each student has been waiting,
  -- so a backlog drains fairly over several ticks instead of being blasted out
  -- in one breath on the day this migration is applied — when EVERY student is
  -- due at once, because last_reminder_at starts null for all of them. That
  -- sentence is truer after migration-064 than it was when it was written: the
  -- backfill in (b) now seeds from profiles as well, so the first tick's queue
  -- is the whole student body rather than the alert-enabled slice of it.
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
  p_timezone           text    default 'America/New_York',
  -- Does the CALLER have a working mailbox? Last, defaulting false, exactly as
  -- claim_campaign_pushes takes it (migration-047). False is the safe default:
  -- it reproduces migration-060's behaviour precisely, so a caller that has not
  -- been taught about email cannot accidentally claim a student it can only
  -- reach by a channel it does not have. src/lib/reminders.js passes
  -- emailEnabled from src/lib/email.js.
  p_email_enabled      boolean default false
)
-- out_reach says which channels were live for this student AT CLAIM TIME, under
-- the lock, so the worker is told what was true when the quota was spent rather
-- than what it can re-derive a round trip later. 'push' / 'email' / 'both',
-- same vocabulary as claim_campaign_pushes.out_reach.
returns table (out_user_id uuid, out_reach text)
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
  v_push_ok    boolean;
  v_email_ok   boolean;
begin
  -- (a) Quiet hours, campus-local, identical in shape to claim_campaign_pushes
  -- and claim_nearby_notification. First, and before the backfill, so a tick
  -- inside the quiet window writes NOTHING at all — it is a read of one clock
  -- and a return. A reminder is the single least urgent notification the app
  -- sends; there is no version of "you have points to spend" that is worth
  -- waking someone at 3am, and unlike a deal it does not even expire.
  --
  -- Quiet hours apply to EMAIL as well, which is a deliberate choice and not an
  -- accident of sharing the function. Mail does not buzz a pocket, so a case
  -- could be made for sending it at 3am — but Privacy Policy §7.4 promises the
  -- window over "all of the above taken together", an email counts against the
  -- same caps, and a 3am timestamp on a marketing email is read as spam by
  -- people and filters alike. Nothing is gained and the promise would be false.
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

  -- THE SECOND SEED, and the point of migration-064. The insert above reaches
  -- only students who once turned alerts on; a student who never did, or who
  -- never came back after the consent modal, has no row and so was never a
  -- candidate for the one message designed to fetch them. Seeding from profiles
  -- closes that, and needs no orphan guard because profiles IS the foreign-key
  -- parent — selecting from it cannot produce a row it does not contain.
  --
  -- Gated on p_email_enabled so a deployment with no mailbox keeps exactly
  -- migration-060's candidate set rather than filling the table with students
  -- it has no way to reach. Inserts nothing after the first tick that runs it.
  if p_email_enabled then
    insert into student_notify_state (user_id)
    select pr.user_id
    from profiles pr
    where pr.email is not null
      and trim(pr.email) <> ''
    on conflict do nothing;
  end if;

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
      and st2.user_id <> all(coalesce(p_skip_users, '{}'::uuid[]))
      -- REACHABLE BY SOMETHING. This replaces migration-060's flat "No
      -- endpoint, no claim", and note that push_opt_in moved INSIDE the push
      -- arm: a student who turned Deal alerts off (which deletes their
      -- endpoints) is unreachable by push and used to be unreachable full stop,
      -- but their email switch is independent — migration-047 settled that —
      -- so they stay a candidate through the second arm. The two arms mirror
      -- v_push_ok / v_email_ok in the loop exactly; where they could disagree
      -- the loop wins, because it holds the lock.
      and (
        (
          st2.push_opt_in = true
          and exists (
            select 1 from push_subscriptions ps
            where ps.user_id = st2.user_id and ps.role = 'student'
          )
        )
        or (
          p_email_enabled
          and st2.email_opt_in = true
          and exists (
            select 1 from profiles pr
            where pr.user_id = st2.user_id
              and pr.email is not null
              and trim(pr.email) <> ''
              -- ANY suppression row blocks, not just scope='all'. A reminder is
              -- marketing, and isSuppressed(addr, {marketing:true}) in
              -- src/lib/email.js treats a 'marketing' row as refusing it — so
              -- the same test is written here rather than a narrower one, which
              -- would claim a student the mailer is then obliged to drop.
              -- Identical to migration-047's test for a deal email.
              and not exists (
                select 1 from email_suppressions es
                where es.email = lower(trim(pr.email))
              )
          )
        )
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
    -- here: between the scan and this lock the student may have turned a switch
    -- off on another device, dropped their last endpoint, had their address
    -- suppressed by a bounce, or been claimed by a deal alert or a nearby alert
    -- that spent the budget we are about to spend. The ONE condition not
    -- re-tested is p_skip_users, which is an argument rather than state and so
    -- cannot have changed underneath us.
    if not st.reminder_opt_in then continue; end if;

    -- Re-derived under the lock, so what the worker is told in out_reach matches
    -- what was true at the moment the quota was spent. Same two expressions as
    -- the driving query's two arms, and the same shape as migration-047's.
    v_push_ok := st.push_opt_in and exists (
      select 1 from push_subscriptions ps
      where ps.user_id = u.uid and ps.role = 'student'
    );
    v_email_ok := p_email_enabled and st.email_opt_in and exists (
      select 1 from profiles pr
      where pr.user_id = u.uid
        and pr.email is not null
        and trim(pr.email) <> ''
        and not exists (
          select 1 from email_suppressions es
          where es.email = lower(trim(pr.email))
        )
    );
    if not (v_push_ok or v_email_ok) then continue; end if;

    if st.last_reminder_at is not null
       and st.last_reminder_at > now() - make_interval(hours => greatest(p_min_interval_hours, 0))
    then
      continue;
    end if;

    -- (d) The shared budget. Same three tests, same rollover arithmetic, same
    -- columns as claim_campaign_pushes and claim_nearby_notification — see
    -- migration-060's header on why the budget is shared rather than parallel.
    --
    -- THE hard guarantee first: whatever any number of vendors, nearby spots and
    -- reminders do, two notifications to one student can never be closer
    -- together than the cooldown. An email spends it exactly as a push does,
    -- which is what Privacy Policy §7.4 promises in so many words.
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
    -- dynos notifying the same student twice. refund_reminder_push is how a
    -- claim that delivered nothing gets undone; defer_reminder_push above is how
    -- one we chose not to send gets undone without re-queueing.
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
    out_reach   := case
                     when v_push_ok and v_email_ok then 'both'
                     when v_push_ok                then 'push'
                     else                               'email'
                   end;
    return next;
  end loop;
end;
$$;

comment on function public.claim_reminder_pushes(integer, uuid[], integer, integer, integer, integer, integer, integer, text, boolean) is
  'Students who may be sent a "come back and spend your points" reminder right '
  'now, longest-waiting first, with out_reach saying whether push, email or '
  'both were live for each at claim time. Spends a slot from the SAME '
  'daily/weekly budget as vendor deal alerts and nearby alerts, at claim time — '
  'so every id returned has already been charged, by either channel — and at '
  'most 2x/week per student (p_min_interval_hours). Email reach added in '
  'migration-064; see migration-060 for the rest.';

revoke execute on function public.claim_reminder_pushes(integer, uuid[], integer, integer, integer, integer, integer, integer, text, boolean) from public, anon, authenticated;
grant  execute on function public.claim_reminder_pushes(integer, uuid[], integer, integer, integer, integer, integer, integer, text, boolean) to service_role;


-- ---------- 3. operator broadcasts, now reachable by email ----------
--
-- Same change, same reasons, and the same drop-then-create for the same
-- Postgres restriction. ⚠ EIGHT argument types in the drop, not nine — see
-- migration-061's note at this exact spot, which records a whole failed
-- application caused by copying claim_reminder_pushes' arity here. The new
-- identity has nine.
drop function if exists public.claim_admin_broadcast_pushes(integer, uuid[], integer, integer, integer, integer, integer, text);

create or replace function public.claim_admin_broadcast_pushes(
  p_max_users        integer default 40,
  p_skip_users       uuid[]  default '{}',
  -- Same knobs, same defaults, same environment variables as CAMPAIGN_CONFIG in
  -- src/lib/campaigns.js, because it is the same budget. src/lib/broadcasts.js
  -- forwards that module's values rather than keeping a copy.
  p_cooldown_minutes integer default 240,
  p_daily_cap        integer default 2,
  p_weekly_cap       integer default 5,
  p_quiet_start      integer default 22,
  p_quiet_end        integer default 9,
  p_timezone         text    default 'America/New_York',
  -- Last and defaulting false, as in claim_campaign_pushes and
  -- claim_reminder_pushes. src/lib/broadcasts.js passes emailEnabled.
  p_email_enabled    boolean default false
)
returns table (
  out_user_id      uuid,
  out_broadcast_id uuid,
  out_title        text,
  out_body         text,
  out_url          text,
  -- 'push' / 'email' / 'both', as true under the lock. Added in migration-064.
  out_reach        text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  st         student_notify_state%rowtype;
  v_hour     integer;
  v_ds       timestamptz;
  v_ws       timestamptz;
  v_rows     integer;
  r          record;
  v_push_ok  boolean;
  v_email_ok boolean;
begin
  -- Quiet hours first, campus-local, identical in shape to all three siblings:
  -- `=` disables, `start > end` wraps midnight. Checked before anything is read
  -- or written, so a quiet tick costs nothing and returns no rows. Applies to
  -- email too, for the reason claim_reminder_pushes gives at the same place.
  v_hour := extract(hour from (now() at time zone p_timezone))::integer;
  if p_quiet_start = p_quiet_end then
    null;
  elsif p_quiet_start > p_quiet_end then
    if v_hour >= p_quiet_start or v_hour < p_quiet_end then return; end if;
  else
    if v_hour >= p_quiet_start and v_hour < p_quiet_end then return; end if;
  end if;

  -- Housekeeping, before the driving scan so an expired broadcast cannot be
  -- claimed by it. An announcement that sat behind a student's cooldown for two
  -- days is stale news, and sending it late is worse than not sending it.
  update admin_broadcast_recipients r2
  set status = 'expired'
  where r2.status in ('queued', 'sending')
    and exists (
      select 1 from admin_broadcasts b
      where b.id = r2.broadcast_id
        and (b.expires_at <= now() or b.status = 'cancelled')
    );

  -- A 'sending' row older than ten minutes is a worker that died between the
  -- claim and the send. Requeued rather than abandoned, the same way
  -- claim_campaign_pushes recovers its own.
  update admin_broadcast_recipients
  set status = 'queued', claimed_at = null
  where status = 'sending' and claimed_at < now() - interval '10 minutes';

  -- Finished broadcasts are closed so the scan below stops looking at them.
  update admin_broadcasts b
  set status = 'done'
  where b.status = 'queued'
    and not exists (
      select 1 from admin_broadcast_recipients r2
      where r2.broadcast_id = b.id and r2.status in ('queued', 'sending')
    );

  for r in
    -- Aliased r2/b: `r` is the record variable above, and plpgsql substitutes
    -- variables into queries before the planner sees them.
    select r2.broadcast_id as bid, r2.user_id as uid,
           b.title as title, b.body as body, b.url as url
    from admin_broadcast_recipients r2
    join admin_broadcasts b on b.id = r2.broadcast_id
    where r2.status = 'queued'
      and b.status = 'queued'
      and b.expires_at > now()
      and r2.user_id <> all(coalesce(p_skip_users, '{}'::uuid[]))
      -- REACHABLE BY SOMETHING. migration-061 required a push endpoint here
      -- ("No endpoint, no claim"), which is what made an announcement unable to
      -- reach the very students an announcement is usually for. Now either
      -- channel qualifies.
      --
      -- coalesce(..., true) on both switches because a student with no
      -- student_notify_state row has never been notified by anything and is
      -- opted in by default — the same reading the `not exists` budget filter
      -- below takes, and the reading the column defaults state.
      and (
        (
          coalesce((select sn.push_opt_in from student_notify_state sn
                     where sn.user_id = r2.user_id), true)
          and exists (
            select 1 from push_subscriptions ps
            where ps.user_id = r2.user_id and ps.role = 'student'
          )
        )
        or (
          p_email_enabled
          and coalesce((select sn.email_opt_in from student_notify_state sn
                         where sn.user_id = r2.user_id), true)
          and exists (
            select 1 from profiles pr
            where pr.user_id = r2.user_id
              and pr.email is not null
              and trim(pr.email) <> ''
              -- Any suppression row blocks: an announcement is marketing. Same
              -- test as migration-047's and claim_reminder_pushes' above.
              and not exists (
                select 1 from email_suppressions es
                where es.email = lower(trim(pr.email))
              )
          )
        )
      )
      -- The shared budget, pre-filtered here as well as re-checked under the lock
      -- below, for the reason migration-047 and migration-060 give: this scan is
      -- capped at p_max_users, so a student it selects and the loop then skips
      -- still spends one of those slots. Without these lines, the students at the
      -- head of the queue (lowest uuids on the oldest broadcast) who are inside
      -- their cooldown or capped out are picked every tick, skipped every tick,
      -- and the broadcast reaches nobody behind them until their windows clear.
      -- NOT EXISTS, so a student with no student_notify_state row yet (never
      -- notified by anything) stays eligible, exactly as the loop treats them.
      -- Same rollover arithmetic as the loop; where the two could ever disagree
      -- the loop wins, so a disagreement costs a slot, never an extra push.
      --
      -- push_opt_in USED TO BE ONE OF THESE ARMS and has moved up into the
      -- reachability test, because it is now a statement about one channel
      -- rather than about whether the student can be reached at all.
      and not exists (
        select 1 from student_notify_state sn
        where sn.user_id = r2.user_id
          and (
            (sn.last_push_at is not null
                and sn.last_push_at > now() - make_interval(mins => greatest(p_cooldown_minutes, 0)))
            or (sn.day_start is not null
                and sn.day_start > now() - interval '24 hours'
                and sn.day_count >= p_daily_cap)
            or (sn.week_start is not null
                and sn.week_start > now() - interval '7 days'
                and sn.week_count >= p_weekly_cap)
          )
      )
    -- Oldest broadcast first, so two overlapping announcements drain in the
    -- order they were sent rather than interleaving.
    order by b.created_at, r2.user_id
    limit greatest(p_max_users, 1)
  loop
    -- Take the student's budget row. SKIP LOCKED, like the campaign worker and
    -- unlike claim_nearby_notification: there are thirty-nine other students in
    -- this batch and another tick along shortly, so a row another worker holds
    -- is somebody else's to deal with.
    insert into student_notify_state (user_id) values (r.uid) on conflict do nothing;
    select * into st from student_notify_state where user_id = r.uid for update skip locked;
    if not found then continue; end if;

    -- Their switches, re-read under the lock — belt and braces over the
    -- reachability test above, for the window between them. Deal alerts is the
    -- push switch and turning it off deletes their endpoints; Deal emails is the
    -- email switch and is independent of it.
    v_push_ok := st.push_opt_in and exists (
      select 1 from push_subscriptions ps
      where ps.user_id = r.uid and ps.role = 'student'
    );
    v_email_ok := p_email_enabled and st.email_opt_in and exists (
      select 1 from profiles pr
      where pr.user_id = r.uid
        and pr.email is not null
        and trim(pr.email) <> ''
        and not exists (
          select 1 from email_suppressions es
          where es.email = lower(trim(pr.email))
        )
    );
    if not (v_push_ok or v_email_ok) then continue; end if;

    -- The shared budget: same three tests, same rollover arithmetic, same
    -- columns as all three siblings.
    if st.last_push_at is not null
       and st.last_push_at > now() - make_interval(mins => greatest(p_cooldown_minutes, 0))
    then
      continue;
    end if;

    v_ds := st.day_start;
    v_ws := st.week_start;
    if v_ds is null or v_ds <= now() - interval '24 hours' then
      v_ds := now(); st.day_count := 0;
    end if;
    if v_ws is null or v_ws <= now() - interval '7 days' then
      v_ws := now(); st.week_count := 0;
    end if;
    if st.day_count >= p_daily_cap or st.week_count >= p_weekly_cap then continue; end if;

    -- Mark the recipient BEFORE spending the budget, and let the WHERE settle any
    -- race the lock did not: if another transaction moved this row off 'queued'
    -- while we waited, row_count is 0 and we spend nothing.
    update admin_broadcast_recipients
    set status = 'sending', claimed_at = now()
    where broadcast_id = r.bid and user_id = r.uid and status = 'queued';
    get diagnostics v_rows = row_count;
    if v_rows = 0 then continue; end if;

    update student_notify_state
    set last_push_at = now(),
        day_start    = v_ds,
        day_count    = st.day_count + 1,
        week_start   = v_ws,
        week_count   = st.week_count + 1,
        updated_at   = now()
    where user_id = r.uid;

    out_user_id      := r.uid;
    out_broadcast_id := r.bid;
    out_title        := r.title;
    out_body         := r.body;
    out_url          := r.url;
    out_reach        := case
                          when v_push_ok and v_email_ok then 'both'
                          when v_push_ok                then 'push'
                          else                               'email'
                        end;
    return next;
  end loop;
end;
$$;

-- ⚠ NINE argument types now (migration-061's eight plus p_email_enabled).
-- Counting matters here: see migration-061's note at this spot for what a wrong
-- arity costs, and test/migration-signatures.test.js for what now checks it.
comment on function public.claim_admin_broadcast_pushes(integer, uuid[], integer, integer, integer, integer, integer, text, boolean) is
  'Students who may be sent a queued operator broadcast right now, oldest '
  'broadcast first, with its copy and out_reach saying whether push, email or '
  'both were live for each at claim time. SPENDS a slot from the SAME shared '
  'budget as deal alerts, nearby alerts and reminders, by either channel. '
  'Email reach added in migration-064; see migration-061 for the rest.';

revoke execute on function public.claim_admin_broadcast_pushes(integer, uuid[], integer, integer, integer, integer, integer, text, boolean) from public, anon, authenticated;
grant  execute on function public.claim_admin_broadcast_pushes(integer, uuid[], integer, integer, integer, integer, integer, text, boolean) to service_role;

-- ---------- 4. who can we actually reach? ----------
--
-- Read-only, and the reason it is here rather than in Node: "how many students
-- have a push endpoint" is a count over a join that PostgREST cannot express
-- (no count(distinct), no anti-join), so the alternative was paging the whole
-- student body into the dyno on every page load. Same posture as
-- bonus_window_report in migration-063 — one function, one round trip, nothing
-- written.
--
-- IT ALSO ANSWERS THE QUESTION THAT PROMPTED ALL OF THIS, which was a
-- reasonable guess and a wrong one: that students were not getting
-- notifications because they had not accepted the new Terms. They were not.
-- Nothing in any send path reads profiles.terms_version — the consent gate is
-- requireConsent on /api/me/* routes and nowhere else, and the only students any
-- audience function excludes are those with NO profile row at all (never
-- consented, migration-022), not those with a stale one. So `consent_stale` is
-- reported here next to the reachability counts to make that visible rather than
-- arguable: a large consent_stale with a large email_reachable is a population
-- this release reaches, today, without anyone accepting anything.
--
-- p_terms_version is an argument because SQL has no business knowing what the
-- current version is; src/lib/terms.js is the single source of truth and the
-- caller passes it. A null or empty argument reports both consent counts as 0
-- rather than guessing.
create or replace function public.student_reachability(p_terms_version text default null)
returns table (
  students          bigint,
  push_reachable    bigint,
  email_reachable    bigint,
  reachable_either  bigint,
  reachable_neither bigint,
  consent_current   bigint,
  consent_stale     bigint,
  stale_and_emailable bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with s as (
    select
      p.user_id,
      p.terms_version,
      -- The same two expressions the claims use, written once. If these ever
      -- drift from claim_reminder_pushes' v_push_ok / v_email_ok the panel
      -- becomes a comforting lie, so they are deliberately verbatim.
      (
        coalesce((select sn.push_opt_in from student_notify_state sn
                   where sn.user_id = p.user_id), true)
        and exists (select 1 from push_subscriptions ps
                     where ps.user_id = p.user_id and ps.role = 'student')
      ) as push_ok,
      (
        coalesce((select sn.email_opt_in from student_notify_state sn
                   where sn.user_id = p.user_id), true)
        and p.email is not null
        and trim(p.email) <> ''
        and not exists (select 1 from email_suppressions es
                         where es.email = lower(trim(p.email)))
      ) as email_ok
    from profiles p
  )
  select
    count(*)                                                        as students,
    count(*) filter (where push_ok)                                 as push_reachable,
    count(*) filter (where email_ok)                                as email_reachable,
    count(*) filter (where push_ok or email_ok)                     as reachable_either,
    count(*) filter (where not push_ok and not email_ok)            as reachable_neither,
    count(*) filter (where p_terms_version is not null
                       and p_terms_version <> ''
                       and terms_version = p_terms_version)         as consent_current,
    count(*) filter (where p_terms_version is not null
                       and p_terms_version <> ''
                       and (terms_version is distinct from p_terms_version)) as consent_stale,
    count(*) filter (where p_terms_version is not null
                       and p_terms_version <> ''
                       and (terms_version is distinct from p_terms_version)
                       and email_ok)                                as stale_and_emailable
  from s;
$$;

comment on function public.student_reachability(text) is
  'One row of counts: how many students push can reach, how many email can '
  'reach, how many neither can, and how many are on a stale consent version '
  '(which does NOT affect delivery — see migration-064). Read-only; the '
  'reachability expressions are verbatim copies of the claims''. Behind the '
  '/admin Notifications tab.';

revoke execute on function public.student_reachability(text) from public, anon, authenticated;
grant  execute on function public.student_reachability(text) to service_role;


commit;
