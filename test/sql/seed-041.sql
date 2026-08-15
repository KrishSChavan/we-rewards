-- Pre-migration world for migration-041 (saved spots + the Recommended list).
--
-- Three vendors and three students, with earn transactions arranged so the
-- "most visited" ranking has exactly one correct answer and every rule the
-- function claims to apply changes it:
--
--   Busy Bagels   — 2 students × 2 distinct days = 4 visits, but SIX rows.
--                   If the function counted transactions instead of visits it
--                   would score 6 and the day-collapsing rule would be untested.
--   Quiet Coffee  — 2 students × 1 day        = 2 visits
--   Closed Diner  — 3 students × 3 days       = 9 visits, but active = false,
--                   so it must NOT appear. It out-ranks everything, which is
--                   the point: if the active filter is missing, it wins.
--
-- Plus rows that must be ignored:
--   - a 'redeem' at Quiet Coffee (spending points is not a visit)
--   - an 'earn' at Busy Bagels 90 days ago (outside every window under test)
--
-- migration-025 blocks direct DML on `transactions`, so this seed takes the
-- documented override rather than going through award_points: the RPC stamps
-- created_at as now(), and every row here has to land on a chosen day for the
-- (student, day) visit counting to be worth testing at all. `false` makes the
-- setting session-scoped, matching seed.sql and seed-032.sql.
select set_config('app.points_write', 'server', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000411', 's1-041@example.com'),
  ('00000000-0000-0000-0000-000000000412', 's2-041@example.com'),
  ('00000000-0000-0000-0000-000000000413', 's3-041@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000000411', 's1-041@example.com', 'S1', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000412', 's2-041@example.com', 'S2', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000413', 's3-041@example.com', 'S3', now(), 'v1');

insert into public.vendors (id, name, slug, points_per_dollar, active) values
  ('00000000-0000-0000-0000-0000000004a1', 'Busy Bagels 041',  'busy-bagels-041',  10, true),
  ('00000000-0000-0000-0000-0000000004a2', 'Quiet Coffee 041', 'quiet-coffee-041', 10, true),
  ('00000000-0000-0000-0000-0000000004a3', 'Closed Diner 041', 'closed-diner-041', 10, false);

-- Busy Bagels: S1 and S2, each on day-1 and day-2, and S1 buys THREE times on
-- day-1. Six rows, four visits.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at) values
  ('00000000-0000-0000-0000-000000000411', '00000000-0000-0000-0000-0000000004a1', 'earn', 50, 5, now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000411', '00000000-0000-0000-0000-0000000004a1', 'earn', 50, 5, now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000411', '00000000-0000-0000-0000-0000000004a1', 'earn', 50, 5, now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000411', '00000000-0000-0000-0000-0000000004a1', 'earn', 50, 5, now() - interval '2 days'),
  ('00000000-0000-0000-0000-000000000412', '00000000-0000-0000-0000-0000000004a1', 'earn', 50, 5, now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000412', '00000000-0000-0000-0000-0000000004a1', 'earn', 50, 5, now() - interval '2 days');

-- Busy Bagels, long ago — outside every window the tests use.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at) values
  ('00000000-0000-0000-0000-000000000413', '00000000-0000-0000-0000-0000000004a1', 'earn', 50, 5, now() - interval '90 days');

-- Quiet Coffee: two students, one day each = 2 visits. Plus a redeem that must
-- not count.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at) values
  ('00000000-0000-0000-0000-000000000411', '00000000-0000-0000-0000-0000000004a2', 'earn',    30, 3, now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000412', '00000000-0000-0000-0000-0000000004a2', 'earn',    30, 3, now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000413', '00000000-0000-0000-0000-0000000004a2', 'redeem', -30, 0, now() - interval '1 day');

-- Closed Diner: the most-visited spot in the whole dataset, and inactive.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at) values
  ('00000000-0000-0000-0000-000000000411', '00000000-0000-0000-0000-0000000004a3', 'earn', 50, 5, now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000411', '00000000-0000-0000-0000-0000000004a3', 'earn', 50, 5, now() - interval '2 days'),
  ('00000000-0000-0000-0000-000000000411', '00000000-0000-0000-0000-0000000004a3', 'earn', 50, 5, now() - interval '3 days'),
  ('00000000-0000-0000-0000-000000000412', '00000000-0000-0000-0000-0000000004a3', 'earn', 50, 5, now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000412', '00000000-0000-0000-0000-0000000004a3', 'earn', 50, 5, now() - interval '2 days'),
  ('00000000-0000-0000-0000-000000000412', '00000000-0000-0000-0000-0000000004a3', 'earn', 50, 5, now() - interval '3 days'),
  ('00000000-0000-0000-0000-000000000413', '00000000-0000-0000-0000-0000000004a3', 'earn', 50, 5, now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000413', '00000000-0000-0000-0000-0000000004a3', 'earn', 50, 5, now() - interval '2 days'),
  ('00000000-0000-0000-0000-000000000413', '00000000-0000-0000-0000-0000000004a3', 'earn', 50, 5, now() - interval '3 days');
