-- Seed for migration-032 (vendor campaigns). Runs AFTER schema + 002..031, so
-- everything here is written against the current shape of the world.
--
-- The situation it builds is the one the feature exists to survive: FIVE vendors
-- whose best customers are mostly the SAME students. That overlap is not
-- contrived, it is what the tier model produces (breadth is 35% of the linear
-- blend and the whole of the synergy term), and it is the reason a naive send
-- button hands one student five notifications on a Friday.
--
--   u1 "Everywhere"  — a regular at all five vendors. The storm's target.
--   u2 "Twoshop"     — a regular at vendors 1 and 2.
--   u3 "Loyal"       — vendor 1 only, many visits.
--   u4 "Lapsed"      — was a vendor 1 regular, nothing for 100 days.
--   u5 "Nearly"      — vendor 1, holds 30 of the 50 points a coffee costs.
--   u6 "Silent"      — a vendor 1 regular with NO push subscription.
--
-- point_balances/transactions are guarded by migration-025 triggers. Announce
-- ourselves for the whole SESSION (is_local = false) so the seed can write.
select set_config('app.points_write', 'server', false);

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'u1@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'u2@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'u3@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'u4@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000005', 'u5@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000006', 'u6@example.com');

insert into public.profiles (user_id, name, email, terms_accepted_at, terms_version) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Everywhere', 'u1@example.com', now(), '2026-08-01'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Twoshop',    'u2@example.com', now(), '2026-08-01'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Loyal',      'u3@example.com', now(), '2026-08-01'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'Lapsed',     'u4@example.com', now(), '2026-08-01'),
  ('aaaaaaaa-0000-0000-0000-000000000005', 'Nearly',     'u5@example.com', now(), '2026-08-01'),
  ('aaaaaaaa-0000-0000-0000-000000000006', 'Silent',     'u6@example.com', now(), '2026-08-01');

insert into public.vendors (id, name, slug, active) values
  ('11111111-1111-1111-1111-111111111111', 'Blue Bird Cafe', 'blue-bird', true),
  ('22222222-2222-2222-2222-222222222222', 'Taco Stand',     'taco',      true),
  ('33333333-3333-3333-3333-333333333333', 'Noodle Bar',     'noodle',    true),
  ('44444444-4444-4444-4444-444444444444', 'Pizza Place',    'pizza',     true),
  ('55555555-5555-5555-5555-555555555555', 'The Pub',        'pub',       true);

insert into public.rewards (id, vendor_id, title, cost_in_points, emoji, active) values
  ('bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Free coffee', 50, '☕', true);

-- ---------- visit history ----------
-- One earn per DAY per vendor, because campaign_audience() collapses a day into
-- one visit exactly as the tier model does. Splitting a ticket cannot buy a
-- place in the top 100.

-- u1: 10 days at vendor 1, 8 at each of the other four.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at)
select 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
       'earn', 100, 10, now() - make_interval(days => d)
from generate_series(1, 10) d;
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at)
select 'aaaaaaaa-0000-0000-0000-000000000001', v.id, 'earn', 100, 10, now() - make_interval(days => d)
from generate_series(1, 8) d
cross join (values ('22222222-2222-2222-2222-222222222222'::uuid),
                   ('33333333-3333-3333-3333-333333333333'::uuid),
                   ('44444444-4444-4444-4444-444444444444'::uuid),
                   ('55555555-5555-5555-5555-555555555555'::uuid)) v(id);

-- u2: 6 days at vendors 1 and 2.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at)
select 'aaaaaaaa-0000-0000-0000-000000000002', v.id, 'earn', 80, 8, now() - make_interval(days => d)
from generate_series(1, 6) d
cross join (values ('11111111-1111-1111-1111-111111111111'::uuid),
                   ('22222222-2222-2222-2222-222222222222'::uuid)) v(id);

-- u3: 5 days at vendor 1 only.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at)
select 'aaaaaaaa-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
       'earn', 60, 6, now() - make_interval(days => d)
from generate_series(1, 5) d;

-- u4: 4 days at vendor 1, all 100+ days ago. Outside the 90-day 'top' window,
-- inside the 180-day 'lapsed' one — which is exactly the distinction.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at)
select 'aaaaaaaa-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111',
       'earn', 60, 6, now() - make_interval(days => 100 + d)
from generate_series(1, 4) d;

-- u5: 2 days at vendor 1, and 30 of the 50 points a coffee costs.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at)
select 'aaaaaaaa-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111',
       'earn', 15, 3, now() - make_interval(days => d)
from generate_series(1, 2) d;

-- u6: 7 days at vendor 1, but never granted notification permission.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at)
select 'aaaaaaaa-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111',
       'earn', 90, 9, now() - make_interval(days => d)
from generate_series(1, 7) d;

insert into public.point_balances (user_id, vendor_id, balance) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 1000),
  ('aaaaaaaa-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 30),
  -- 45 is also "close" (>= 25, < 50); 60 is past the reward and must NOT be.
  ('aaaaaaaa-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 45),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 60);

-- An existing admin push subscription, to prove the role split keeps operator
-- alerts and student deals apart.
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values
  (null, 'https://push.example/admin-1', 'k', 'a');
