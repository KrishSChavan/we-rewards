-- Pre-migration world for migration-062 (notification log + read-only queue).
--
-- Two jobs, and the fixtures split along them.
--
-- THE BACKFILL CAST. migration-062 imports the last 30 days of what the
-- database already knows. Each fixture is one rule of that import:
--
--   BF_A  two campaigns from two vendors in ONE push_batch, 2 days ago. One
--         notification, so ONE log row, titled "2 spots have something on".
--         An import that wrote one row per campaign would show the operator a
--         student who was pushed twice in the same second.
--   BF_B  one campaign, delivered by the EMAIL fallback, 3 days ago. channel
--         must come from campaign_recipients.channel, body must be null (the
--         log never holds an email body), recipient_email filled.
--   BF_C  a sent row with NO push_batch (pre-batching data), 5 days ago, keyed
--         'deal:c:<campaign>:<user>' - plus a second sent row 40 days old that
--         must NOT be imported.
--   BC_S  a sent broadcast recipient 1 day ago (imported) and one 40 days ago
--         (not), plus a QUEUED broadcast recipient elsewhere (not imported).
--   NB    a nearby claim 1 day ago ('allowed') and one 40 days ago (not).
--   DOOM  a nearby claim 1 day ago, so DOOM has a backfilled row - then the
--         behaviour file deletes DOOM's profile and the row must go with it.
--
-- THE QUEUE CAST. One queued row each on one live campaign (C_MAIN), differing
-- only in the single gate each is about, so every blocker assertion can say
-- "exactly this array" rather than "contains":
--
--   READY    eligible now. Also holds a SENT row from a DIFFERENT vendor 2h
--            ago, the negative for vendor_cooldown (which is per vendor).
--   HOLD     deliver_after 30 minutes from now (the coalescing window).
--   COOL     last_push_at 1h ago (240-minute cooldown).
--   DAILY    2 sends today (day_start 2h ago).
--   WEEKLY   5 sends this week, but a STALE day window, so weekly_cap alone.
--            The week started 6 days ago, so it rolls in 24h, inside C_MAIN's
--            47h expiry. A more recent start rolls after the deal expires and
--            reads expires_first instead (behavior block 12's WEEK).
--   STALE    day_count 5 on a day_start 25h ago: rolled over, not capped.
--   VENDOR   a SENT row from C_MAIN's own vendor 2h ago (vendor_cooldown).
--   EMAIL    no endpoint, has an email: no_channel unless email is enabled.
--   SUPP     no endpoint, SUPPRESSED email: no_channel either way.
--   OPTOUT   push_opt_in false (and email_opt_in false), endpoint still there.
--   NOSTATE  endpoint and NO student_notify_state row. The claims insert one;
--            the queue functions must not.
--   SENDING  claimed 2 minutes ago.
--   STUCK    claimed 15 minutes ago (the claims requeue past 10). Must still be
--            'sending' after every queue function has run.
--   EXP      queued on an EXPIRED campaign. Must still be 'queued' afterwards
--            (the claim would flip it to 'expired').
--   CANC     queued on a CANCELLED campaign (status cancelled, expires_at
--            moved to now, exactly what the vendor route does).
--
-- Reminders and the budget reuse most of these plus three of their own:
-- REMIND (reminded 10h ago), REMOFF (reminder and nearby switches off) and
-- REMOLD (reminded 100h ago: due, but behind every never-reminded student).
--
-- Every timestamp is relative to now(): the backfill runs at migration time
-- against a 30-day window, and 2/3/5/40 days are unambiguous against it.

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000062001', 'ready-062@example.com'),
  ('00000000-0000-0000-0000-000000062002', 'hold-062@example.com'),
  ('00000000-0000-0000-0000-000000062003', 'cool-062@example.com'),
  ('00000000-0000-0000-0000-000000062004', 'daily-062@example.com'),
  ('00000000-0000-0000-0000-000000062005', 'weekly-062@example.com'),
  ('00000000-0000-0000-0000-000000062006', 'stale-062@example.com'),
  ('00000000-0000-0000-0000-000000062007', 'vendor-062@example.com'),
  ('00000000-0000-0000-0000-000000062008', 'email-062@example.com'),
  ('00000000-0000-0000-0000-000000062009', 'supp-062@example.com'),
  ('00000000-0000-0000-0000-00000006200a', 'optout-062@example.com'),
  ('00000000-0000-0000-0000-00000006200b', 'nostate-062@example.com'),
  ('00000000-0000-0000-0000-00000006200c', 'sending-062@example.com'),
  ('00000000-0000-0000-0000-00000006200d', 'stuck-062@example.com'),
  ('00000000-0000-0000-0000-00000006200e', 'exp-062@example.com'),
  ('00000000-0000-0000-0000-00000006200f', 'canc-062@example.com'),
  ('00000000-0000-0000-0000-000000062010', 'remind-062@example.com'),
  ('00000000-0000-0000-0000-000000062011', 'remoff-062@example.com'),
  ('00000000-0000-0000-0000-000000062012', 'remold-062@example.com'),
  ('00000000-0000-0000-0000-000000062013', 'bfa-062@example.com'),
  ('00000000-0000-0000-0000-000000062014', 'bfb-062@example.com'),
  ('00000000-0000-0000-0000-000000062015', 'bfc-062@example.com'),
  ('00000000-0000-0000-0000-000000062016', 'bcs-062@example.com'),
  ('00000000-0000-0000-0000-000000062017', 'nb-062@example.com'),
  ('00000000-0000-0000-0000-000000062018', 'doom-062@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000062001', 'ready-062@example.com',   'Ready 062',    now(), 'v1'),
  ('00000000-0000-0000-0000-000000062002', 'hold-062@example.com',    'Hold 062',     now(), 'v1'),
  ('00000000-0000-0000-0000-000000062003', 'cool-062@example.com',    'Cool 062',     now(), 'v1'),
  ('00000000-0000-0000-0000-000000062004', 'daily-062@example.com',   'Daily 062',    now(), 'v1'),
  ('00000000-0000-0000-0000-000000062005', 'weekly-062@example.com',  'Weekly 062',   now(), 'v1'),
  ('00000000-0000-0000-0000-000000062006', 'stale-062@example.com',   'Stale 062',    now(), 'v1'),
  ('00000000-0000-0000-0000-000000062007', 'vendor-062@example.com',  'Vendor 062',   now(), 'v1'),
  ('00000000-0000-0000-0000-000000062008', 'email-062@example.com',   'Email 062',    now(), 'v1'),
  ('00000000-0000-0000-0000-000000062009', 'supp-062@example.com',    'Supp 062',     now(), 'v1'),
  ('00000000-0000-0000-0000-00000006200a', 'optout-062@example.com',  'Optout 062',   now(), 'v1'),
  ('00000000-0000-0000-0000-00000006200b', 'nostate-062@example.com', 'Nostate 062',  now(), 'v1'),
  ('00000000-0000-0000-0000-00000006200c', 'sending-062@example.com', 'Sending 062',  now(), 'v1'),
  ('00000000-0000-0000-0000-00000006200d', 'stuck-062@example.com',   'Stuck 062',    now(), 'v1'),
  ('00000000-0000-0000-0000-00000006200e', 'exp-062@example.com',     'Exp 062',      now(), 'v1'),
  ('00000000-0000-0000-0000-00000006200f', 'canc-062@example.com',    'Canc 062',     now(), 'v1'),
  ('00000000-0000-0000-0000-000000062010', 'remind-062@example.com',  'Remind 062',   now(), 'v1'),
  ('00000000-0000-0000-0000-000000062011', 'remoff-062@example.com',  'Remoff 062',   now(), 'v1'),
  ('00000000-0000-0000-0000-000000062012', 'remold-062@example.com',  'Remold 062',   now(), 'v1'),
  ('00000000-0000-0000-0000-000000062013', 'bfa-062@example.com',     'Backfill A 062', now(), 'v1'),
  ('00000000-0000-0000-0000-000000062014', 'bfb-062@example.com',     'Backfill B 062', now(), 'v1'),
  ('00000000-0000-0000-0000-000000062015', 'bfc-062@example.com',     'Backfill C 062', now(), 'v1'),
  ('00000000-0000-0000-0000-000000062016', 'bcs-062@example.com',     'Bcast Sent 062', now(), 'v1'),
  ('00000000-0000-0000-0000-000000062017', 'nb-062@example.com',      'Nearby 062',   now(), 'v1'),
  ('00000000-0000-0000-0000-000000062018', 'doom-062@example.com',    'Doomed 062',   now(), 'v1');

insert into public.vendors (id, name, slug, active) values
  ('00000000-0000-0000-0000-0000000620b1', 'Main Spot 062',   'main-spot-062',   true),
  ('00000000-0000-0000-0000-0000000620b2', 'Other Spot 062',  'other-spot-062',  true),
  ('00000000-0000-0000-0000-0000000620b3', 'Cancel Spot 062', 'cancel-spot-062', true);

-- Campaigns. created_at is spread out so the queue's (created_at, user_id)
-- order is fixed rather than a tie.
insert into public.vendor_campaigns (id, vendor_id, title, body, kind, status, deliver_after, expires_at, created_at) values
  -- THE live campaign every queue fixture waits on.
  ('00000000-0000-0000-0000-0000000620c1', '00000000-0000-0000-0000-0000000620b1',
   'Main deal 062', 'Half off at Main.', 'deal', 'queued',
   now() - interval '1 hour', now() + interval '47 hours', now() - interval '1 hour'),
  -- Expired two hours ago and never housekept (no claim has run since).
  ('00000000-0000-0000-0000-0000000620c2', '00000000-0000-0000-0000-0000000620b2',
   'Expired deal 062', 'Too late.', 'deal', 'queued',
   now() - interval '50 hours', now() - interval '2 hours', now() - interval '50 hours'),
  -- Cancelled the way src/routes/vendor.js cancels: status AND expires_at.
  ('00000000-0000-0000-0000-0000000620c3', '00000000-0000-0000-0000-0000000620b3',
   'Cancelled deal 062', 'Never mind.', 'deal', 'cancelled',
   now() - interval '3 hours', now() - interval '1 minute', now() - interval '3 hours'),
  -- Sent 2h ago from Main (VENDOR's per-vendor cooldown) and from Other (READY's
  -- negative).
  ('00000000-0000-0000-0000-0000000620c4', '00000000-0000-0000-0000-0000000620b1',
   'Earlier Main deal 062', 'Earlier.', 'deal', 'done',
   now() - interval '3 hours', now() + interval '45 hours', now() - interval '3 hours'),
  ('00000000-0000-0000-0000-0000000620c5', '00000000-0000-0000-0000-0000000620b2',
   'Earlier Other deal 062', 'Earlier too.', 'deal', 'done',
   now() - interval '3 hours', now() + interval '45 hours', now() - interval '3 hours' + interval '1 second'),
  -- BF_A's bundle: two vendors, one notification.
  ('00000000-0000-0000-0000-0000000620c6', '00000000-0000-0000-0000-0000000620b1',
   'Bundle one 062', 'First of two.', 'deal', 'done',
   now() - interval '49 hours', now() - interval '1 hour', now() - interval '49 hours'),
  ('00000000-0000-0000-0000-0000000620c7', '00000000-0000-0000-0000-0000000620b2',
   'Bundle two 062', 'Second of two.', 'deal', 'done',
   now() - interval '49 hours', now() - interval '1 hour', now() - interval '49 hours' + interval '1 second'),
  -- BF_B's email fallback.
  ('00000000-0000-0000-0000-0000000620c8', '00000000-0000-0000-0000-0000000620b3',
   'Emailed deal 062', 'This body must not reach the log.', 'deal', 'done',
   now() - interval '73 hours', now() - interval '25 hours', now() - interval '73 hours'),
  -- BF_C: one pre-batching send inside the window, one outside it.
  ('00000000-0000-0000-0000-0000000620c9', '00000000-0000-0000-0000-0000000620b1',
   'Unbatched deal 062', 'Old style.', 'deal', 'done',
   now() - interval '121 hours', now() - interval '73 hours', now() - interval '121 hours'),
  ('00000000-0000-0000-0000-0000000620ca', '00000000-0000-0000-0000-0000000620b1',
   'Ancient deal 062', 'Forty days ago.', 'deal', 'done',
   now() - interval '41 days', now() - interval '39 days', now() - interval '41 days');

insert into public.campaign_recipients (campaign_id, user_id, status, deliver_after, push_batch, claimed_at, pushed_at, channel) values
  -- The queue cast, all on C_MAIN.
  ('00000000-0000-0000-0000-0000000620c1', '00000000-0000-0000-0000-000000062001', 'queued',  now() - interval '1 hour',     null, null, null, null),
  ('00000000-0000-0000-0000-0000000620c1', '00000000-0000-0000-0000-000000062002', 'queued',  now() + interval '30 minutes', null, null, null, null),
  ('00000000-0000-0000-0000-0000000620c1', '00000000-0000-0000-0000-000000062003', 'queued',  now() - interval '1 hour',     null, null, null, null),
  ('00000000-0000-0000-0000-0000000620c1', '00000000-0000-0000-0000-000000062004', 'queued',  now() - interval '1 hour',     null, null, null, null),
  ('00000000-0000-0000-0000-0000000620c1', '00000000-0000-0000-0000-000000062005', 'queued',  now() - interval '1 hour',     null, null, null, null),
  ('00000000-0000-0000-0000-0000000620c1', '00000000-0000-0000-0000-000000062006', 'queued',  now() - interval '1 hour',     null, null, null, null),
  ('00000000-0000-0000-0000-0000000620c1', '00000000-0000-0000-0000-000000062007', 'queued',  now() - interval '1 hour',     null, null, null, null),
  ('00000000-0000-0000-0000-0000000620c1', '00000000-0000-0000-0000-000000062008', 'queued',  now() - interval '1 hour',     null, null, null, null),
  ('00000000-0000-0000-0000-0000000620c1', '00000000-0000-0000-0000-000000062009', 'queued',  now() - interval '1 hour',     null, null, null, null),
  ('00000000-0000-0000-0000-0000000620c1', '00000000-0000-0000-0000-00000006200a', 'queued',  now() - interval '1 hour',     null, null, null, null),
  ('00000000-0000-0000-0000-0000000620c1', '00000000-0000-0000-0000-00000006200b', 'queued',  now() - interval '1 hour',     null, null, null, null),
  ('00000000-0000-0000-0000-0000000620c1', '00000000-0000-0000-0000-00000006200c', 'sending', now() - interval '1 hour',
     '00000000-0000-0000-0000-0000000620e1', now() - interval '2 minutes', null, null),
  ('00000000-0000-0000-0000-0000000620c1', '00000000-0000-0000-0000-00000006200d', 'sending', now() - interval '1 hour',
     '00000000-0000-0000-0000-0000000620e2', now() - interval '15 minutes', null, null),
  -- EXP and CANC.
  ('00000000-0000-0000-0000-0000000620c2', '00000000-0000-0000-0000-00000006200e', 'queued',  now() - interval '50 hours',    null, null, null, null),
  ('00000000-0000-0000-0000-0000000620c3', '00000000-0000-0000-0000-00000006200f', 'queued',  now() - interval '3 hours',     null, null, null, null),
  -- VENDOR heard from Main 2h ago; READY heard from Other 2h ago.
  ('00000000-0000-0000-0000-0000000620c4', '00000000-0000-0000-0000-000000062007', 'sent',    now() - interval '3 hours',
     '00000000-0000-0000-0000-0000000620e3', now() - interval '2 hours', now() - interval '2 hours', 'push'),
  ('00000000-0000-0000-0000-0000000620c5', '00000000-0000-0000-0000-000000062001', 'sent',    now() - interval '3 hours',
     '00000000-0000-0000-0000-0000000620e4', now() - interval '2 hours', now() - interval '2 hours', 'push'),
  -- BF_A: one batch, two campaigns, pushed a second apart.
  ('00000000-0000-0000-0000-0000000620c6', '00000000-0000-0000-0000-000000062013', 'sent',    now() - interval '49 hours',
     '00000000-0000-0000-0000-0000000620e5', now() - interval '48 hours', now() - interval '48 hours', 'push'),
  ('00000000-0000-0000-0000-0000000620c7', '00000000-0000-0000-0000-000000062013', 'sent',    now() - interval '49 hours',
     '00000000-0000-0000-0000-0000000620e5', now() - interval '48 hours', now() - interval '48 hours' + interval '1 second', 'push'),
  -- BF_B: email.
  ('00000000-0000-0000-0000-0000000620c8', '00000000-0000-0000-0000-000000062014', 'sent',    now() - interval '73 hours',
     '00000000-0000-0000-0000-0000000620e6', now() - interval '72 hours', now() - interval '72 hours', 'email'),
  -- BF_C: no batch (pre-033 data), channel null (pre-047 data). Plus the
  -- 40-day-old one that stays out.
  ('00000000-0000-0000-0000-0000000620c9', '00000000-0000-0000-0000-000000062015', 'sent',    now() - interval '121 hours',
     null, null, now() - interval '120 hours', null),
  ('00000000-0000-0000-0000-0000000620ca', '00000000-0000-0000-0000-000000062015', 'sent',    now() - interval '41 days',
     null, null, now() - interval '40 days', null);

-- Endpoints: everyone in the queue cast except EMAIL and SUPP (who have no
-- device), plus the reminder trio. One ADMIN endpoint and one ORPHAN endpoint
-- (a user id with no profile) that the reminder candidate set must not count.
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, role) values
  ('00000000-0000-0000-0000-000000062001', 'https://push.example/ready-062',   'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000062002', 'https://push.example/hold-062',    'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000062003', 'https://push.example/cool-062',    'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000062004', 'https://push.example/daily-062',   'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000062005', 'https://push.example/weekly-062',  'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000062006', 'https://push.example/stale-062',   'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000062007', 'https://push.example/vendor-062',  'k', 'a', 'student'),
  ('00000000-0000-0000-0000-00000006200a', 'https://push.example/optout-062',  'k', 'a', 'student'),
  ('00000000-0000-0000-0000-00000006200b', 'https://push.example/nostate-062', 'k', 'a', 'student'),
  -- NOSTATE has TWO devices, so the budget's device count is a count.
  ('00000000-0000-0000-0000-00000006200b', 'https://push.example/nostate2-062','k', 'a', 'student'),
  ('00000000-0000-0000-0000-00000006200c', 'https://push.example/sending-062', 'k', 'a', 'student'),
  ('00000000-0000-0000-0000-00000006200d', 'https://push.example/stuck-062',   'k', 'a', 'student'),
  ('00000000-0000-0000-0000-00000006200e', 'https://push.example/exp-062',     'k', 'a', 'student'),
  ('00000000-0000-0000-0000-00000006200f', 'https://push.example/canc-062',    'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000062010', 'https://push.example/remind-062',  'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000062011', 'https://push.example/remoff-062',  'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000062012', 'https://push.example/remold-062',  'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000062018', 'https://push.example/admin-062',   'k', 'a', 'admin'),
  ('00000000-0000-0000-0000-0000000620ff', 'https://push.example/orphan-062',  'k', 'a', 'student');

-- SUPP's address is dead.
insert into public.email_suppressions (email, scope, reason) values
  ('supp-062@example.com', 'all', 'bounced');

-- Notify state. Everybody in the queue cast except NOSTATE starts wide open,
-- and each row below narrows only the gate it is about. Written in full rather
-- than relying on column defaults, so a changed default cannot quietly move a
-- fixture.
insert into public.student_notify_state
  (user_id, push_opt_in, email_opt_in, last_push_at, day_start, day_count, week_start, week_count) values
  ('00000000-0000-0000-0000-000000062001', true,  true,  null,                        null,                         0, null,                       0),
  ('00000000-0000-0000-0000-000000062002', true,  true,  null,                        null,                         0, null,                       0),
  ('00000000-0000-0000-0000-000000062003', true,  true,  now() - interval '1 hour',   null,                         0, null,                       0),
  ('00000000-0000-0000-0000-000000062004', true,  true,  null,                        now() - interval '2 hours',   2, now() - interval '2 hours', 2),
  ('00000000-0000-0000-0000-000000062005', true,  true,  null,                        now() - interval '30 hours',  1, now() - interval '6 days',  5),
  ('00000000-0000-0000-0000-000000062006', true,  true,  null,                        now() - interval '25 hours',  5, null,                       0),
  ('00000000-0000-0000-0000-000000062007', true,  true,  null,                        null,                         0, null,                       0),
  ('00000000-0000-0000-0000-000000062008', true,  true,  null,                        null,                         0, null,                       0),
  ('00000000-0000-0000-0000-000000062009', true,  true,  null,                        null,                         0, null,                       0),
  ('00000000-0000-0000-0000-00000006200a', false, false, null,                        null,                         0, null,                       0),
  ('00000000-0000-0000-0000-00000006200c', true,  true,  now() - interval '2 minutes', now() - interval '2 minutes', 1, now() - interval '2 minutes', 1),
  ('00000000-0000-0000-0000-00000006200d', true,  true,  now() - interval '15 minutes', now() - interval '15 minutes', 1, now() - interval '15 minutes', 1),
  ('00000000-0000-0000-0000-00000006200e', true,  true,  now() - interval '1 hour',   null,                         0, null,                       0),
  ('00000000-0000-0000-0000-00000006200f', true,  true,  null,                        null,                         0, null,                       0),
  ('00000000-0000-0000-0000-000000062010', true,  true,  null,                        null,                         0, null,                       0),
  ('00000000-0000-0000-0000-000000062011', true,  true,  null,                        null,                         0, null,                       0),
  ('00000000-0000-0000-0000-000000062012', true,  true,  null,                        null,                         0, null,                       0);

-- The 051/060 switches and the reminder clock, which predate 062 and so can be
-- written here.
update public.student_notify_state set last_reminder_at = now() - interval '10 hours'
 where user_id = '00000000-0000-0000-0000-000000062010';
update public.student_notify_state set reminder_opt_in = false, nearby_opt_in = false
 where user_id = '00000000-0000-0000-0000-000000062011';
update public.student_notify_state set last_reminder_at = now() - interval '100 hours'
 where user_id = '00000000-0000-0000-0000-000000062012';

-- Broadcasts. created_at spread so the claim order is fixed.
insert into public.admin_broadcasts (id, title, body, url, audience, status, expires_at, created_at) values
  ('00000000-0000-0000-0000-0000000620d1', 'Live broadcast 062', 'Still going.', '/?tab=spots', 'all', 'queued',
   now() + interval '40 hours', now() - interval '8 hours'),
  ('00000000-0000-0000-0000-0000000620d2', 'Expired broadcast 062', 'Too late.', null, 'all', 'queued',
   now() - interval '1 hour', now() - interval '49 hours'),
  ('00000000-0000-0000-0000-0000000620d3', 'Cancelled broadcast 062', 'Never mind.', null, 'all', 'cancelled',
   now() + interval '40 hours', now() - interval '7 hours'),
  ('00000000-0000-0000-0000-0000000620d4', 'Sent broadcast 062', 'Delivered yesterday.', '/?tab=deals', 'lapsed', 'done',
   now() - interval '1 hour', now() - interval '25 hours'),
  ('00000000-0000-0000-0000-0000000620d5', 'Ancient broadcast 062', 'Forty days ago.', null, 'all', 'done',
   now() - interval '38 days', now() - interval '40 days');

insert into public.admin_broadcast_recipients (broadcast_id, user_id, status, claimed_at, pushed_at) values
  ('00000000-0000-0000-0000-0000000620d1', '00000000-0000-0000-0000-000000062001', 'queued',  null, null),
  ('00000000-0000-0000-0000-0000000620d1', '00000000-0000-0000-0000-000000062003', 'queued',  null, null),
  ('00000000-0000-0000-0000-0000000620d1', '00000000-0000-0000-0000-000000062004', 'queued',  null, null),
  ('00000000-0000-0000-0000-0000000620d1', '00000000-0000-0000-0000-000000062008', 'queued',  null, null),
  ('00000000-0000-0000-0000-0000000620d1', '00000000-0000-0000-0000-00000006200a', 'queued',  null, null),
  ('00000000-0000-0000-0000-0000000620d1', '00000000-0000-0000-0000-00000006200b', 'queued',  null, null),
  ('00000000-0000-0000-0000-0000000620d1', '00000000-0000-0000-0000-00000006200c', 'sending', now() - interval '2 minutes', null),
  ('00000000-0000-0000-0000-0000000620d1', '00000000-0000-0000-0000-00000006200d', 'sending', now() - interval '15 minutes', null),
  ('00000000-0000-0000-0000-0000000620d2', '00000000-0000-0000-0000-000000062001', 'queued',  null, null),
  ('00000000-0000-0000-0000-0000000620d3', '00000000-0000-0000-0000-000000062001', 'queued',  null, null),
  ('00000000-0000-0000-0000-0000000620d4', '00000000-0000-0000-0000-000000062016', 'sent',    now() - interval '24 hours', now() - interval '24 hours'),
  ('00000000-0000-0000-0000-0000000620d5', '00000000-0000-0000-0000-000000062016', 'sent',    now() - interval '40 days', now() - interval '40 days');

-- Nearby claims: two inside the window, one outside.
insert into public.nearby_notifications (user_id, vendor_id, notified_at) values
  ('00000000-0000-0000-0000-000000062017', '00000000-0000-0000-0000-0000000620b1', now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000062017', '00000000-0000-0000-0000-0000000620b2', now() - interval '40 days'),
  ('00000000-0000-0000-0000-000000062018', '00000000-0000-0000-0000-0000000620b2', now() - interval '1 day');
