-- Pre-migration world for migration-060 (the twice-weekly reminder push).
--
-- Eight students, differing ONLY in how they can be reached and in when they
-- were last reminded, because that is the whole input to claim_reminder_pushes.
-- Unlike every other notification in this stack there is NO recipients table
-- behind this feature: nobody queues a reminder, so the candidate set has to be
-- built from push_subscriptions and then filtered by each student's own notify
-- state. Giving every refusal rule a student of its own is what makes a missing
-- check show up as exactly one failing assertion instead of a vague "it claimed
-- more people than it should".
--
--   R1 Never 060      — a student endpoint, and DELIBERATELY NO
--                       student_notify_state ROW AT ALL. This is the fixture for
--                       the backfill: a student who has never been notified by
--                       anything has no row, and without the backfill they are
--                       invisible to the claim forever — which is precisely the
--                       lapsed student the feature was written for. R1 also has
--                       last_reminder_at = null by construction, so they are the
--                       fixture for "nulls sort first" as well.
--   R2 Hour Ago 060   — reminded an hour ago (stamped in the behaviour file).
--                       The minimum interval, which is the only thing making
--                       this "about twice a week" rather than "every four hours
--                       like a deal alert".
--   R3 Stale 060      — reminded 80 hours ago: past the 72-hour interval, so
--                       due. R2 and R3 are a pair; with only one of them an
--                       interval test and "it claimed everybody" look identical.
--   R4 Reminders Off 060 — reminder_opt_in turned off in the behaviour file.
--                       Also carries a QUEUED CAMPAIGN (below) and has never
--                       earned at any vendor, so the same student can prove the
--                       new switch silences reminders WITHOUT silencing deal
--                       alerts or nearby alerts. That independence is the entire
--                       reason the column exists instead of reusing push_opt_in.
--   R5 Push Off 060   — push_opt_in = false, set HERE rather than in the
--                       behaviour file because that column predates this
--                       migration. The master switch: a student who switched
--                       deal alerts off did not ask to be nagged instead, and
--                       there is no endpoint left to deliver on anyway.
--   R6 Admin Only 060 — one subscription, role = 'admin', and no notify row. An
--                       operator's own browser (migration-032 split the roles so
--                       notifyAdmins and campaign delivery could never hand each
--                       other's notifications out). If either the backfill or
--                       the reachability test forgets role = 'student', the
--                       operator's phone starts buzzing with student reminders
--                       — and because R6 has no notify row, the leak also shows
--                       up as a state row appearing out of nowhere.
--   R7 No Endpoint 060 — no push_subscriptions row at all, and a notify row with
--                       everything else wide open. Reachability is therefore the
--                       ONLY rule that can refuse them, so that assertion cannot
--                       pass for a second reason.
--   R8 Capped 060     — the quota fixture. Its counters are set in the behaviour
--                       file, where day_start and week_start can be pinned to
--                       now(): a cap whose window has already rolled over is not
--                       a cap at all, because the rollover zeroes the count
--                       before the test gets to it.
--
-- NOT ONE ROW IN transactions OR punch_cards, for anybody, and that is
-- load-bearing rather than lazy. claim_nearby_notification refuses a spot the
-- student has already been to (migration-051 delegates to
-- student_visited_vendor_ids), and two assertions here lean on a nearby claim
-- being GRANTED; a stray earn row would make them pass or fail for a reason
-- that has nothing to do with migration-060. It also means this seed needs no
-- app.points_write override, unlike seed-051.
--
-- ONE ORPHANED ENDPOINT, deliberately, and it belongs to nobody at all:
-- a role = 'student' subscription whose user_id has no profiles row and no
-- auth.users row either. push_subscriptions.user_id has no foreign key
-- (migration-018: "best-effort, no FK") while student_notify_state.user_id
-- references profiles, so the claim's backfill selects from a table that can
-- hold ids the table it writes to will reject, and `on conflict do nothing`
-- does not catch that — a missing parent is not a duplicate key. That is the
-- state a profile deleted outside POST /api/me/delete leaves behind, and
-- without the exists(profiles) guard in the backfill this single row makes the
-- insert raise foreign_key_violation and abort EVERY reminder claim, for
-- everyone, on every tick, with no symptom except that reminders stopped. It is
-- seeded here so that the guard is tested rather than assumed.
--
-- Every OTHER push_subscriptions row has a profile behind it, so a reachability
-- bug shows up as a wrong claim rather than as an aborted function.
--
-- reminder_opt_in and last_reminder_at are NOT written here: the seed runs
-- BEFORE the migration under test (see test/sql/run.ps1), so neither column
-- exists yet. behavior-060.sql stamps both in its first block, exactly as
-- behavior-051.sql has to do for nearby_opt_in.

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000601', 'r1-060@example.com'),
  ('00000000-0000-0000-0000-000000000602', 'r2-060@example.com'),
  ('00000000-0000-0000-0000-000000000603', 'r3-060@example.com'),
  ('00000000-0000-0000-0000-000000000604', 'r4-060@example.com'),
  ('00000000-0000-0000-0000-000000000605', 'r5-060@example.com'),
  ('00000000-0000-0000-0000-000000000606', 'r6-060@example.com'),
  ('00000000-0000-0000-0000-000000000607', 'r7-060@example.com'),
  ('00000000-0000-0000-0000-000000000608', 'r8-060@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000000601', 'r1-060@example.com', 'Never 060',         now(), 'v1'),
  ('00000000-0000-0000-0000-000000000602', 'r2-060@example.com', 'Hour Ago 060',      now(), 'v1'),
  ('00000000-0000-0000-0000-000000000603', 'r3-060@example.com', 'Stale 060',         now(), 'v1'),
  ('00000000-0000-0000-0000-000000000604', 'r4-060@example.com', 'Reminders Off 060', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000605', 'r5-060@example.com', 'Push Off 060',      now(), 'v1'),
  ('00000000-0000-0000-0000-000000000606', 'r6-060@example.com', 'Admin Only 060',    now(), 'v1'),
  ('00000000-0000-0000-0000-000000000607', 'r7-060@example.com', 'No Endpoint 060',   now(), 'v1'),
  ('00000000-0000-0000-0000-000000000608', 'r8-060@example.com', 'Capped 060',        now(), 'v1');

-- Three vendors, one per feature the shared budget pays for, so no assertion
-- can be contaminated by another feature's ledger row:
--   Reminder Cafe — the nearby spot for the reminder_opt_in independence check
--   Budget Deli   — the nearby spot for the shared-cooldown check
--   Deal Diner    — the campaign's vendor
-- Coordinates are real Penn State ones and are NOT read by anything under test
-- (migration-051 keeps the distance maths on the phone); they are here so the
-- seed describes the world the feature actually runs in.
insert into public.vendors (id, name, slug, points_per_dollar, active, latitude, longitude) values
  ('00000000-0000-0000-0000-0000000006b1', 'Reminder Cafe 060', 'reminder-cafe-060', 10, true, 40.7982, -77.8599),
  ('00000000-0000-0000-0000-0000000006b2', 'Budget Deli 060',   'budget-deli-060',   10, true, 40.7975, -77.8601),
  ('00000000-0000-0000-0000-0000000006b3', 'Deal Diner 060',    'deal-diner-060',    10, true, 40.7968, -77.8612);

-- R6's endpoint is role = 'admin'; everyone else's is role = 'student'. R7 gets
-- nothing. The endpoint text is unique-indexed (migration-018), so these are
-- distinct per student rather than one shared placeholder.
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, role) values
  ('00000000-0000-0000-0000-000000000601', 'https://push.example/r1-060', 'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000000602', 'https://push.example/r2-060', 'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000000603', 'https://push.example/r3-060', 'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000000604', 'https://push.example/r4-060', 'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000000605', 'https://push.example/r5-060', 'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000000606', 'https://push.example/r6-060', 'k', 'a', 'admin'),
  ('00000000-0000-0000-0000-000000000608', 'https://push.example/r8-060', 'k', 'a', 'student'),
  -- The orphan described in the header: a live student endpoint pointing at an
  -- id that exists in no other table. There is no profile and no auth user to
  -- insert for it, which is the whole point.
  ('00000000-0000-0000-0000-0000000006ff', 'https://push.example/orphan-060', 'k', 'a', 'student');

-- R1 and R6 are absent on purpose: R1 is what proves the backfill reaches a
-- student with no state, and R6 is what proves the backfill does not invent a
-- row for a subscription that is not a student's.
insert into public.student_notify_state (user_id, push_opt_in) values
  ('00000000-0000-0000-0000-000000000602', true),
  ('00000000-0000-0000-0000-000000000603', true),
  ('00000000-0000-0000-0000-000000000604', true),
  ('00000000-0000-0000-0000-000000000605', false),
  ('00000000-0000-0000-0000-000000000607', true),
  ('00000000-0000-0000-0000-000000000608', true);

-- One live deal, queued for R4 alone, written straight into campaign_recipients
-- rather than through create_campaign for the reason seed-047 gives: what is
-- under test is whether reminder_opt_in leaks into the DEAL claim, not how an
-- audience is picked, and re-deriving a top-100 here would only add ways for
-- this file to fail for reasons unrelated to 060. The window is long so nothing
-- expires mid-assertion, and deliver_after is already past so the claim does not
-- have to wait for the coalescing hold.
insert into public.vendor_campaigns (id, vendor_id, title, body, kind, deliver_after, expires_at, queued_count) values
  ('00000000-0000-0000-0000-0000000006c1', '00000000-0000-0000-0000-0000000006b3',
   'Two for one wings', 'Tonight only, while they last.', 'deal',
   now() - interval '1 minute', now() + interval '2 days', 1);

insert into public.campaign_recipients (campaign_id, user_id, status, deliver_after) values
  ('00000000-0000-0000-0000-0000000006c1', '00000000-0000-0000-0000-000000000604', 'queued', now() - interval '1 minute');
