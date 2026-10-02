-- Pre-migration world for migration-061 (operator broadcasts).
--
-- Twenty-one students, and the reason there are that many is that this
-- migration has TWO halves with almost nothing in common, and each half needs a
-- fixture per rule.
--
-- The first half is admin_broadcast_audience, which is four different queries
-- over four different tables wearing one function's name: 'all' reads profiles,
-- 'vendor' reads transactions, 'lapsed' reads transactions with a date window,
-- and 'spendable' reads rewards + point_balances + pool_balances through the
-- pooled-purse rule from migration-044. An audience that returns one student too
-- many is the worst defect this feature can have — it is a push to somebody we
-- told it would not reach them — and the only way to see that as ONE failing
-- assertion rather than a vague "the count is wrong" is to give every arm of
-- every WHERE clause a student whose entire purpose is to be excluded by it.
--
-- The second half is claim_admin_broadcast_pushes, which is the same shape as
-- claim_reminder_pushes (migration-060) and claim_campaign_pushes (047), so its
-- fixtures are the same ones those files use: reachability, the opt-out switch,
-- and the shared storm budget.
--
-- THE AUDIENCE CAST (what each one exists to prove)
--
--   S_ALL       All Only 061        — a profile, a student endpoint, and nothing
--                                     else at all. In 'all' and in no other
--                                     audience, which also makes them the
--                                     "never earned" exclusion for 'lapsed':
--                                     `exists (earn)` has to be a requirement
--                                     rather than decoration, or 'lapsed' is
--                                     just "everyone who has been quiet",
--                                     which includes every student who signed
--                                     up yesterday and has not bought anything.
--   S_DUAL      Dual Role 061       — is_vendor = true, via a real vendor_staff
--                                     row (see below). migration-061 says
--                                     out loud that dual-role accounts
--                                     (migration-035) are INCLUDED: a vendor who
--                                     uses the student app on their day off is
--                                     still a student. Without this fixture
--                                     somebody "tidies up" by excluding staff
--                                     and nothing goes red.
--   S_EARNER    Target Earner 061   — TWO 'earn' rows at Target Spot, both 60
--                                     days old. Two rather than one so the
--                                     `select distinct` is under test: without
--                                     it this student is queued twice, the
--                                     operator is shown an inflated count, and
--                                     the second recipient row is only stopped
--                                     by the primary key (which means the count
--                                     and the queue disagree). The 60 days also
--                                     makes them the positive 'lapsed' fixture.
--   S_REDEEM    Target Redeemer 061 — a 'redeem' at Target Spot and NOTHING
--                                     else. The 'vendor' audience is "everyone
--                                     who ever EARNED here", not "everyone who
--                                     ever transacted here", and a redeem is the
--                                     easiest row to let through by widening
--                                     the type filter. Also the fixture for
--                                     'lapsed' requiring an EARN: this student
--                                     has a transaction, 60 days old, and still
--                                     must not be lapsed.
--   S_PUNCH     Target Punch 061    — a punch_cards row at Target Spot, no
--                                     transactions anywhere. This is what
--                                     catches a 'vendor' audience built from
--                                     student_visited_vendor_ids (migration-048)
--                                     instead of from transactions: that
--                                     function unions punch cards in, so the
--                                     easy reuse quietly turns "paying
--                                     customers here" into "anyone who ever
--                                     stood here".
--   S_LAPSED    Lapsed 061          — one 'earn' at Other Spot, 60 days old. In
--                                     'lapsed'. NOT in Target Spot's 'vendor'
--                                     audience, which is what proves that
--                                     audience is scoped to the vendor at all.
--   S_ACTIVE    Active 061          — an 'earn' 60 days old AND an 'earn' three
--                                     days ago. Has earned, so the first arm of
--                                     'lapsed' passes; the recency arm is the
--                                     only thing that can exclude them. Without
--                                     this student, dropping the 30-day window
--                                     entirely leaves every assertion green.
--   S_XFER      Transfer Only 061   — an 'earn' 60 days old and a
--                                     'community_transfer' three days ago.
--                                     migration-061 writes down why 'lapsed'
--                                     uses `not exists (any row in 30 days)`
--                                     rather than `max(created_at) < cutoff`
--                                     over earns: a student spending community
--                                     points inside the app is using WeRewards
--                                     and must not be nagged as if they had
--                                     left. This is the only fixture that tells
--                                     those two implementations apart.
--   S_SPEND     Spendable 061       — 100 points at Points Spot, where the
--                                     reward costs EXACTLY 100. The boundary on
--                                     purpose: `>=` and `>` differ by precisely
--                                     this student, and "can afford it" means
--                                     they can walk in today.
--   S_SHORT     Short 061           — 99 points at the same spot for the same
--                                     100-point reward. One point short, so the
--                                     comparison is under test rather than the
--                                     existence of a balance row.
--   S_POOL      Pool Spendable 061  — THE subtle one. Their money is in a
--                                     POOL (migration-044): pool_balances holds
--                                     120 for the pool Pooled Spot belongs to,
--                                     and their point_balances row AT that
--                                     vendor holds 0. A reader that goes
--                                     straight to point_balances finds a real
--                                     row with a real zero in it and excludes
--                                     them — no null, no missing row, nothing
--                                     to hint that it looked in the wrong purse.
--                                     Every student of a pooled chain is invisible
--                                     to that bug, and pooled chains are the
--                                     biggest accounts on the platform.
--   S_VISITS    Visits Rich 061     — 9999 points at Visits Spot, whose only
--                                     reward is priced in VISITS
--                                     (cost_in_points null, migration-029's dual
--                                     pricing). Points cannot buy it at any
--                                     balance, so `cost_in_points is not null`
--                                     is load-bearing: without it this student
--                                     is told to go and spend points on a punch
--                                     card.
--   S_SHUT      Shut Spot Rich 061  — 9999 points at a vendor with
--                                     active = false. A closed spot's rewards
--                                     are not spendable by anybody, and the
--                                     student would be sent to a locked door.
--   S_OFF       Off Menu Rich 061   — 9999 points at an active vendor whose
--                                     reward has active = false. The vendor
--                                     filter and the reward filter are separate
--                                     columns on separate tables, so they get
--                                     separate students.
--
-- THE CLAIM CAST (the same five rules all three sibling features have)
--
--   S_OPTOUT    Push Off 061        — push_opt_in = false, set HERE because that
--                                     column predates this migration, AND still
--                                     holding a live student endpoint. The app
--                                     deletes endpoints when the switch goes
--                                     off, so this combination should not exist
--                                     in production — which is exactly why it is
--                                     seeded. The claim must not infer the
--                                     switch from the endpoint; it has to read
--                                     the switch.
--   S_NOPUSH    No Endpoint 061     — no push_subscriptions row and NO notify
--                                     state row either. Reachability is the only
--                                     rule that can refuse them, so that
--                                     assertion cannot pass for a second
--                                     reason — and because they have no notify
--                                     row, a reachability leak also shows up as
--                                     a state row appearing out of nowhere.
--   S_ADMINPUSH Admin Only 061      — one subscription, role = 'admin', and no
--                                     notify row. An operator's own browser.
--                                     migration-032 split the roles so
--                                     notifyAdmins and student delivery could
--                                     never hand each other's notifications
--                                     out; if the claim forgets role =
--                                     'student', the operator's phone receives
--                                     the broadcast they just sent.
--   S_FRESH     Never Notified 061  — a student endpoint and DELIBERATELY NO
--                                     student_notify_state ROW. The claim
--                                     creates the budget row it needs as it goes
--                                     (`insert ... on conflict do nothing`), and
--                                     a student nothing has ever notified is the
--                                     only fixture that exercises it. Note the
--                                     difference from seed-060: that file needs
--                                     an ORPHANED ENDPOINT because
--                                     claim_reminder_pushes backfills from
--                                     push_subscriptions, which has no FK on
--                                     user_id. This claim's insert reads
--                                     admin_broadcast_recipients, whose user_id
--                                     DOES reference profiles, so an orphan is
--                                     unreachable here and no orphan is seeded.
--   S_BA/BB/BC  Batch A/B/C 061     — three students who earned at Batch Spot
--                                     THREE DAYS AGO, which keeps them out of
--                                     'lapsed' and out of every audience
--                                     assertion above. They exist because the
--                                     budget, batching and housekeeping blocks
--                                     need an audience of a known, small,
--                                     controllable size: 'all' queues all
--                                     twenty-one students, and p_max_users is
--                                     applied to CANDIDATE rows in
--                                     (broadcast created_at, user_id) order
--                                     rather than to grants, so a cap of 2
--                                     against twenty-one candidates says nothing
--                                     about which students the cap kept. Their
--                                     uuids are deliberately ASCENDING (…13,
--                                     …14, …15) so the pair a cap of 2 keeps is
--                                     written down in the behaviour file rather
--                                     than discovered by running it.
--
-- ONE AUTH USER WITH NO PROFILE (…0610ff). Signed in, never accepted the terms,
-- so migration-022 never wrote them a profiles row. The 'all' audience joins
-- profiles for exactly this reason and migration-061 says so: consent is the
-- thing we do not have from them. They have no endpoint either, so a leak here
-- could not even be delivered — the assertion is about what we are willing to
-- put in a queue, not about what would arrive.
--
-- ONE ANONYMISED TRANSACTION. An 'earn' at Target Spot with user_id NULL, which
-- is what migration-011 leaves behind when a student deletes their account:
-- transactions.user_id became nullable with ON DELETE SET NULL so a vendor's
-- revenue totals would not drop. The 'vendor' audience carries an explicit
-- `t.user_id is not null` on top of its join to profiles, and this row is what
-- makes that guard tested rather than assumed — a rewrite that drops the join
-- and keeps only `select distinct t.user_id from transactions` would queue a
-- recipient row for NULL and fail on the not-null column, taking down every
-- broadcast creation on the platform.
--
-- NO nearby_notifications ROWS AND NO HISTORY AT NEARBY SPOT, for anybody. Two
-- assertions in the behaviour file turn on claim_nearby_notification being
-- refused and then granted for the same (student, spot) pair, which is how the
-- SHARED budget is proved to work in both directions. migration-051 refuses a
-- spot the student has already been to and refuses one it has already been told
-- about, so Nearby Spot 061 holds no transactions and no punch cards at all; if
-- it did, those two assertions would pass and fail for reasons that have nothing
-- to do with this migration.
--
-- migration-025 blocks direct DML on transactions and point_balances and
-- migration-044 extends the same fence to pool_balances, so this takes the
-- documented override, session-scoped (`false`) exactly as seed-044 and
-- seed-051 do.
select set_config('app.points_write', 'server', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000061001', 's-all-061@example.com'),
  ('00000000-0000-0000-0000-000000061002', 's-dual-061@example.com'),
  ('00000000-0000-0000-0000-000000061003', 's-earner-061@example.com'),
  ('00000000-0000-0000-0000-000000061004', 's-redeem-061@example.com'),
  ('00000000-0000-0000-0000-000000061005', 's-punch-061@example.com'),
  ('00000000-0000-0000-0000-000000061006', 's-lapsed-061@example.com'),
  ('00000000-0000-0000-0000-000000061007', 's-active-061@example.com'),
  ('00000000-0000-0000-0000-000000061008', 's-xfer-061@example.com'),
  ('00000000-0000-0000-0000-000000061009', 's-spend-061@example.com'),
  ('00000000-0000-0000-0000-00000006100a', 's-short-061@example.com'),
  ('00000000-0000-0000-0000-00000006100b', 's-pool-061@example.com'),
  ('00000000-0000-0000-0000-00000006100c', 's-visits-061@example.com'),
  ('00000000-0000-0000-0000-00000006100d', 's-shut-061@example.com'),
  ('00000000-0000-0000-0000-00000006100e', 's-off-061@example.com'),
  ('00000000-0000-0000-0000-00000006100f', 's-optout-061@example.com'),
  ('00000000-0000-0000-0000-000000061010', 's-nopush-061@example.com'),
  ('00000000-0000-0000-0000-000000061011', 's-adminpush-061@example.com'),
  ('00000000-0000-0000-0000-000000061012', 's-fresh-061@example.com'),
  ('00000000-0000-0000-0000-000000061013', 's-ba-061@example.com'),
  ('00000000-0000-0000-0000-000000061014', 's-bb-061@example.com'),
  ('00000000-0000-0000-0000-000000061015', 's-bc-061@example.com'),
  -- The one who signed in and never consented. No profiles row follows.
  ('00000000-0000-0000-0000-0000000610ff', 's-noconsent-061@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000061001', 's-all-061@example.com',       'All Only 061',        now(), 'v1'),
  ('00000000-0000-0000-0000-000000061002', 's-dual-061@example.com',      'Dual Role 061',       now(), 'v1'),
  ('00000000-0000-0000-0000-000000061003', 's-earner-061@example.com',    'Target Earner 061',   now(), 'v1'),
  ('00000000-0000-0000-0000-000000061004', 's-redeem-061@example.com',    'Target Redeemer 061', now(), 'v1'),
  ('00000000-0000-0000-0000-000000061005', 's-punch-061@example.com',     'Target Punch 061',    now(), 'v1'),
  ('00000000-0000-0000-0000-000000061006', 's-lapsed-061@example.com',    'Lapsed 061',          now(), 'v1'),
  ('00000000-0000-0000-0000-000000061007', 's-active-061@example.com',    'Active 061',          now(), 'v1'),
  ('00000000-0000-0000-0000-000000061008', 's-xfer-061@example.com',      'Transfer Only 061',   now(), 'v1'),
  ('00000000-0000-0000-0000-000000061009', 's-spend-061@example.com',     'Spendable 061',       now(), 'v1'),
  ('00000000-0000-0000-0000-00000006100a', 's-short-061@example.com',     'Short 061',           now(), 'v1'),
  ('00000000-0000-0000-0000-00000006100b', 's-pool-061@example.com',      'Pool Spendable 061',  now(), 'v1'),
  ('00000000-0000-0000-0000-00000006100c', 's-visits-061@example.com',    'Visits Rich 061',     now(), 'v1'),
  ('00000000-0000-0000-0000-00000006100d', 's-shut-061@example.com',      'Shut Spot Rich 061',  now(), 'v1'),
  ('00000000-0000-0000-0000-00000006100e', 's-off-061@example.com',       'Off Menu Rich 061',   now(), 'v1'),
  ('00000000-0000-0000-0000-00000006100f', 's-optout-061@example.com',    'Push Off 061',        now(), 'v1'),
  ('00000000-0000-0000-0000-000000061010', 's-nopush-061@example.com',    'No Endpoint 061',     now(), 'v1'),
  ('00000000-0000-0000-0000-000000061011', 's-adminpush-061@example.com', 'Admin Only 061',      now(), 'v1'),
  ('00000000-0000-0000-0000-000000061012', 's-fresh-061@example.com',     'Never Notified 061',  now(), 'v1'),
  ('00000000-0000-0000-0000-000000061013', 's-ba-061@example.com',        'Batch A 061',         now(), 'v1'),
  ('00000000-0000-0000-0000-000000061014', 's-bb-061@example.com',        'Batch B 061',         now(), 'v1'),
  ('00000000-0000-0000-0000-000000061015', 's-bc-061@example.com',        'Batch C 061',         now(), 'v1');

-- The pool has to exist before the vendor that points at it: vendors.pool_id is
-- a real FK (migration-044) with ON DELETE RESTRICT.
insert into public.point_pools (id, label) values
  ('00000000-0000-0000-0000-0000000610d1', 'Pool 061');

-- Nine vendors, one per rule the audiences can get wrong. Coordinates are real
-- Penn State ones and are NOT read by anything under test (migration-051 keeps
-- the distance maths on the phone); they are here so the seed describes the
-- world the feature actually runs in.
insert into public.vendors (id, name, slug, points_per_dollar, active, pool_id, pool_joined_at, latitude, longitude) values
  -- The 'vendor' audience target. Unpooled, so its rewards are priced against
  -- point_balances.
  ('00000000-0000-0000-0000-0000000610b1', 'Target Spot 061',  'target-spot-061',  10, true,  null, null, 40.7982, -77.8599),
  -- Somewhere else entirely, so "earned at the target" can be told apart from
  -- "earned anywhere". Also where the lapsed/active/transfer rows live.
  ('00000000-0000-0000-0000-0000000610b2', 'Other Spot 061',   'other-spot-061',   10, true,  null, null, 40.7975, -77.8601),
  -- Points-priced and affordable: the 'spendable' happy path.
  ('00000000-0000-0000-0000-0000000610b3', 'Points Spot 061',  'points-spot-061',  10, true,  null, null, 40.7968, -77.8612),
  -- Pooled. Its customers' money lives in pool_balances, NOT in point_balances.
  ('00000000-0000-0000-0000-0000000610b4', 'Pooled Spot 061',  'pooled-spot-061',  10, true,
     '00000000-0000-0000-0000-0000000610d1', now() - interval '30 days', 40.7990, -77.8580),
  -- Visits-priced only: no amount of points buys anything here.
  ('00000000-0000-0000-0000-0000000610b5', 'Visits Spot 061',  'visits-spot-061',  10, true,  null, null, 40.7955, -77.8630),
  -- Shut. Its reward is active; the vendor is not.
  ('00000000-0000-0000-0000-0000000610b6', 'Shut Spot 061',    'shut-spot-061',    10, false, null, null, 40.7940, -77.8650),
  -- Open, but the reward has been taken off the menu.
  ('00000000-0000-0000-0000-0000000610b7', 'Off Menu Spot 061','off-menu-spot-061',10, true,  null, null, 40.7930, -77.8660),
  -- No rewards, no transactions, no punch cards, nobody. Two jobs: it is the
  -- "audience matching nobody" vendor for create_admin_broadcast, and it is the
  -- spot the shared-budget assertions probe with claim_nearby_notification.
  ('00000000-0000-0000-0000-0000000610b8', 'Nearby Spot 061',  'nearby-spot-061',  10, true,  null, null, 40.7920, -77.8670),
  -- Exactly three earners, recent, for the batching and housekeeping blocks.
  ('00000000-0000-0000-0000-0000000610b9', 'Batch Spot 061',   'batch-spot-061',   10, true,  null, null, 40.7910, -77.8680);

-- S_DUAL's is_vendor flag CANNOT be written by the profiles insert above:
-- migration-035 put a BEFORE INSERT trigger on profiles
-- (stamp_profile_is_vendor) that overwrites whatever is supplied with
-- `exists (select 1 from vendor_staff where user_id = new.user_id)`. Passing
-- is_vendor => true in the insert would therefore be silently stamped back to
-- false, and the "dual-role accounts are included" assertion would be testing an
-- ordinary student. The real fixture is the real thing: a vendor_staff row, which
-- the AFTER INSERT trigger on that table (sync_profile_is_vendor) then reflects
-- into profiles.is_vendor.
insert into public.vendor_staff (vendor_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000610b2', '00000000-0000-0000-0000-000000061002', 'owner');

-- Five rewards. Four of them exist to be filtered out.
insert into public.rewards (id, vendor_id, title, cost_in_points, cost_in_visits, active) values
  -- Costs exactly what S_SPEND holds, so `>=` and `>` disagree about them.
  ('00000000-0000-0000-0000-0000000610c1', '00000000-0000-0000-0000-0000000610b3',
   'Free drink 061', 100, null, true),
  -- Same price at the pooled spot, so the only difference between S_SPEND and
  -- S_POOL is WHICH PURSE their points are in.
  ('00000000-0000-0000-0000-0000000610c2', '00000000-0000-0000-0000-0000000610b4',
   'Free slice 061', 100, null, true),
  -- Priced in visits, which migration-029 made possible by letting
  -- cost_in_points go null. Points cannot buy it.
  ('00000000-0000-0000-0000-0000000610c3', '00000000-0000-0000-0000-0000000610b5',
   'Tenth coffee 061', null, 5, true),
  -- A live reward at a dead vendor.
  ('00000000-0000-0000-0000-0000000610c4', '00000000-0000-0000-0000-0000000610b6',
   'Free cookie 061', 10, null, true),
  -- A dead reward at a live vendor.
  ('00000000-0000-0000-0000-0000000610c5', '00000000-0000-0000-0000-0000000610b7',
   'Free bagel 061', 10, null, false);

-- The ledger. Ages are chosen to be unambiguous against a 30-day window: 60 days
-- is past it by a month, 3 days is inside it by a month.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, community_points, created_at) values
  -- S_EARNER: two earns at the target, so `select distinct` is under test.
  ('00000000-0000-0000-0000-000000061003', '00000000-0000-0000-0000-0000000610b1', 'earn',    50,   5,  0, now() - interval '60 days'),
  ('00000000-0000-0000-0000-000000061003', '00000000-0000-0000-0000-0000000610b1', 'earn',    70,   7,  0, now() - interval '59 days'),
  -- S_REDEEM: a redeem at the target and nothing else. Points are negative on a
  -- redeem, which is the convention the schema's own comment records.
  ('00000000-0000-0000-0000-000000061004', '00000000-0000-0000-0000-0000000610b1', 'redeem', -100, null, 0, now() - interval '60 days'),
  -- S_LAPSED: earned somewhere else, long ago, and has not been back.
  ('00000000-0000-0000-0000-000000061006', '00000000-0000-0000-0000-0000000610b2', 'earn',    40,   4,  0, now() - interval '60 days'),
  -- S_ACTIVE: the same old earn, plus one three days ago. Has earned; is not gone.
  ('00000000-0000-0000-0000-000000061007', '00000000-0000-0000-0000-0000000610b2', 'earn',    40,   4,  0, now() - interval '60 days'),
  ('00000000-0000-0000-0000-000000061007', '00000000-0000-0000-0000-0000000610b2', 'earn',    30,   3,  0, now() - interval '3 days'),
  -- S_XFER: an old earn, and the only recent row is a community transfer. Shape
  -- copied from migration-027: points positive, community_points negative.
  ('00000000-0000-0000-0000-000000061008', '00000000-0000-0000-0000-0000000610b2', 'earn',    40,   4,  0, now() - interval '60 days'),
  ('00000000-0000-0000-0000-000000061008', '00000000-0000-0000-0000-0000000610b2', 'community_transfer', 50, null, -50, now() - interval '3 days'),
  -- S_BA / S_BB / S_BC: recent earns at Batch Spot. Recent on purpose, so they
  -- are active rather than lapsed and cannot drift into an audience assertion.
  ('00000000-0000-0000-0000-000000061013', '00000000-0000-0000-0000-0000000610b9', 'earn',    20,   2,  0, now() - interval '3 days'),
  ('00000000-0000-0000-0000-000000061014', '00000000-0000-0000-0000-0000000610b9', 'earn',    20,   2,  0, now() - interval '3 days'),
  ('00000000-0000-0000-0000-000000061015', '00000000-0000-0000-0000-0000000610b9', 'earn',    20,   2,  0, now() - interval '3 days'),
  -- The anonymised row from migration-011: a real earn at the target whose
  -- student has deleted their account. It is in the vendor's revenue totals and
  -- it belongs to nobody.
  (null,                                   '00000000-0000-0000-0000-0000000610b1', 'earn',    60,   6,  0, now() - interval '90 days');

-- S_PUNCH has stood at the target counter and never paid points for anything.
-- punches = 0 is deliberate (migration-045 assigns rather than subtracts, so a
-- regular who has just cashed in a visits reward sits at zero): a `punches > 0`
-- test would miss them, and this is the fixture seed-048 and seed-051 both carry
-- for the same reason.
insert into public.punch_cards (user_id, vendor_id, punches) values
  ('00000000-0000-0000-0000-000000061005', '00000000-0000-0000-0000-0000000610b1', 0);

-- The purses. S_SPEND is exactly at the price, S_SHORT is one point under it,
-- and the three "rich" students hold far more than enough at spots whose rewards
-- are unreachable for three different reasons.
insert into public.point_balances (user_id, vendor_id, balance) values
  ('00000000-0000-0000-0000-000000061009', '00000000-0000-0000-0000-0000000610b3',  100),
  ('00000000-0000-0000-0000-00000006100a', '00000000-0000-0000-0000-0000000610b3',   99),
  -- S_POOL's per-vendor row at the POOLED spot, holding zero. This row is the
  -- whole point: it is a real row with a real number in it, so an implementation
  -- that reads point_balances for a pooled vendor gets 0 rather than a null and
  -- excludes the student with no sign that it looked in the wrong purse.
  ('00000000-0000-0000-0000-00000006100b', '00000000-0000-0000-0000-0000000610b4',    0),
  ('00000000-0000-0000-0000-00000006100c', '00000000-0000-0000-0000-0000000610b5', 9999),
  ('00000000-0000-0000-0000-00000006100d', '00000000-0000-0000-0000-0000000610b6', 9999),
  ('00000000-0000-0000-0000-00000006100e', '00000000-0000-0000-0000-0000000610b7', 9999);

-- ...and where S_POOL's money actually is: the chain's shared purse, comfortably
-- above the 100-point reward at Pooled Spot.
insert into public.pool_balances (user_id, pool_id, balance) values
  ('00000000-0000-0000-0000-00000006100b', '00000000-0000-0000-0000-0000000610d1', 120);

-- Endpoints. S_ADMINPUSH's is role = 'admin'; everyone else's is 'student';
-- S_NOPUSH gets nothing. endpoint is unique-indexed (migration-018), so these
-- are distinct per student rather than one shared placeholder.
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, role) values
  ('00000000-0000-0000-0000-000000061001', 'https://push.example/s-all-061',       'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000061002', 'https://push.example/s-dual-061',      'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000061003', 'https://push.example/s-earner-061',    'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000061004', 'https://push.example/s-redeem-061',    'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000061005', 'https://push.example/s-punch-061',     'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000061006', 'https://push.example/s-lapsed-061',    'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000061007', 'https://push.example/s-active-061',    'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000061008', 'https://push.example/s-xfer-061',      'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000061009', 'https://push.example/s-spend-061',     'k', 'a', 'student'),
  ('00000000-0000-0000-0000-00000006100a', 'https://push.example/s-short-061',     'k', 'a', 'student'),
  ('00000000-0000-0000-0000-00000006100b', 'https://push.example/s-pool-061',      'k', 'a', 'student'),
  ('00000000-0000-0000-0000-00000006100c', 'https://push.example/s-visits-061',    'k', 'a', 'student'),
  ('00000000-0000-0000-0000-00000006100d', 'https://push.example/s-shut-061',      'k', 'a', 'student'),
  ('00000000-0000-0000-0000-00000006100e', 'https://push.example/s-off-061',       'k', 'a', 'student'),
  -- A live student endpoint belonging to somebody whose switch is OFF. The app
  -- deletes endpoints when the switch flips, so this pair should not exist; it is
  -- here so that the claim is forced to read the switch rather than infer it.
  ('00000000-0000-0000-0000-00000006100f', 'https://push.example/s-optout-061',    'k', 'a', 'student'),
  -- The operator's own browser.
  ('00000000-0000-0000-0000-000000061011', 'https://push.example/s-adminpush-061', 'k', 'a', 'admin'),
  ('00000000-0000-0000-0000-000000061012', 'https://push.example/s-fresh-061',     'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000061013', 'https://push.example/s-ba-061',        'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000061014', 'https://push.example/s-bb-061',        'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000061015', 'https://push.example/s-bc-061',        'k', 'a', 'student');

-- Notify state for everybody EXCEPT S_NOPUSH, S_ADMINPUSH and S_FRESH, whose
-- absence is the fixture in each case:
--   S_FRESH     proves the claim creates the budget row it needs,
--   S_ADMINPUSH proves it does not create one for an operator's browser,
--   S_NOPUSH    proves it does not create one for a student it cannot reach.
--
-- Everything else is left at its defaults (all counters zero, every stamp null),
-- so every student starts the behaviour file wide open and each block narrows
-- only the one it is about. push_opt_in is written explicitly for all of them
-- rather than relied on, because it is the one column whose default being wrong
-- would silence the whole feature invisibly.
insert into public.student_notify_state (user_id, push_opt_in) values
  ('00000000-0000-0000-0000-000000061001', true),
  ('00000000-0000-0000-0000-000000061002', true),
  ('00000000-0000-0000-0000-000000061003', true),
  ('00000000-0000-0000-0000-000000061004', true),
  ('00000000-0000-0000-0000-000000061005', true),
  ('00000000-0000-0000-0000-000000061006', true),
  ('00000000-0000-0000-0000-000000061007', true),
  ('00000000-0000-0000-0000-000000061008', true),
  ('00000000-0000-0000-0000-000000061009', true),
  ('00000000-0000-0000-0000-00000006100a', true),
  ('00000000-0000-0000-0000-00000006100b', true),
  ('00000000-0000-0000-0000-00000006100c', true),
  ('00000000-0000-0000-0000-00000006100d', true),
  ('00000000-0000-0000-0000-00000006100e', true),
  -- The master switch, off. Set here rather than in the behaviour file because
  -- push_opt_in predates this migration and the seed can therefore write it.
  ('00000000-0000-0000-0000-00000006100f', false),
  ('00000000-0000-0000-0000-000000061013', true),
  ('00000000-0000-0000-0000-000000061014', true),
  ('00000000-0000-0000-0000-000000061015', true);
