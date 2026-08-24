-- Pre-migration world for migration-048 (student_visited_vendor_ids).
--
-- The function answers ONE question — "has this student ever been here?" — and
-- every vendor below exists to make a different way of getting that question
-- wrong show up as a failing assertion. One student, five vendors:
--
--   Bought At    — a plain 'earn'. The ordinary case.
--   Redeemed At  — a 'redeem' and nothing else. You cannot spend points at a
--                  counter you have never stood at, so this must count. If the
--                  function copied top_vendors_by_visits' 'earn'-only filter
--                  (which is right for a POPULARITY ranking and wrong here),
--                  this vendor is what catches it.
--   Punched At   — a scanned visit and nothing else, with the visit counter
--                  already spent back down to ZERO by a visits-priced reward
--                  (migration-045 assigns punches = 0, never subtracts). A
--                  `punches > 0` test forgets this student's regular haunt
--                  precisely because they are a regular — the single nastiest
--                  bug available here, so it gets its own vendor.
--   Transfer To  — a 'community_transfer' and nothing else. Moving pooled
--                  points happens inside the app, not at a counter, so it is
--                  NOT a visit — the same exclusion top_vendors_by_visits
--                  makes (migration-041).
--   Never Been   — no history at all. The control: if it ever comes back, the
--                  filter is not filtering.
--
-- A SECOND student with history at Never Been keeps the p_user_id argument
-- honest: a function that ignored it, or leaked across users, would return
-- Never Been for student one and pass every other assertion in this file.
--
-- migration-025 blocks direct DML on `transactions`, so this seed takes the
-- documented override rather than going through award_points: the RPC decides
-- its own type and vendor, and half the rows here exist to be types it would
-- never write. `false` makes the setting session-scoped, matching seed-041.
select set_config('app.points_write', 'server', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000481', 's1-048@example.com'),
  ('00000000-0000-0000-0000-000000000482', 's2-048@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000000481', 's1-048@example.com', 'S1-048', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000482', 's2-048@example.com', 'S2-048', now(), 'v1');

insert into public.vendors (id, name, slug, points_per_dollar, active) values
  ('00000000-0000-0000-0000-0000000004b1', 'Bought At 048',   'bought-at-048',   10, true),
  ('00000000-0000-0000-0000-0000000004b2', 'Redeemed At 048', 'redeemed-at-048', 10, true),
  ('00000000-0000-0000-0000-0000000004b3', 'Punched At 048',  'punched-at-048',  10, true),
  ('00000000-0000-0000-0000-0000000004b4', 'Transfer To 048', 'transfer-to-048', 10, true),
  ('00000000-0000-0000-0000-0000000004b5', 'Never Been 048',  'never-been-048',  10, true);

-- Bought At: two earns, deliberately more than one row. The function must
-- return the vendor ONCE — a missing DISTINCT would double it up here.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at) values
  ('00000000-0000-0000-0000-000000000481', '00000000-0000-0000-0000-0000000004b1', 'earn', 50, 5, now() - interval '400 days'),
  ('00000000-0000-0000-0000-000000000481', '00000000-0000-0000-0000-0000000004b1', 'earn', 50, 5, now() - interval '2 days');

-- Redeemed At: a redemption and nothing else.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at) values
  ('00000000-0000-0000-0000-000000000481', '00000000-0000-0000-0000-0000000004b2', 'redeem', -30, 0, now() - interval '3 days');

-- Transfer To: an in-app pool move and nothing else. Must NOT count.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at) values
  ('00000000-0000-0000-0000-000000000481', '00000000-0000-0000-0000-0000000004b4', 'community_transfer', 25, 0, now() - interval '4 days');

-- Punched At: a card that exists with the counter spent back to zero. This is
-- what a regular looks like the moment after they cash in a visits reward.
insert into public.punch_cards (user_id, vendor_id, punches) values
  ('00000000-0000-0000-0000-000000000481', '00000000-0000-0000-0000-0000000004b3', 0);

-- The other student, at the one vendor student one has never been to.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at) values
  ('00000000-0000-0000-0000-000000000482', '00000000-0000-0000-0000-0000000004b5', 'earn', 50, 5, now() - interval '1 day');
