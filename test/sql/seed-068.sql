-- Pre-migration world for migration-068 ($1 = 1 point everywhere).
--
-- Three solo spots on three different rates, and a two-location chain sharing a
-- purse at 10 points per $1. Balances are backed by the trading that produced
-- them, because the conversion reads that trading: moved-in community points
-- are found in transactions, and a purse member's share in transactions plus
-- pool_moves.
--
--   TEN   rate 10   S1 155 = 50 moved in + 105 earned      -> 50 + 11 = 61
--                   S2 1512 earned                         -> 152
--                   S3 30  = 50 moved in, 20 spent          -> 30 (spent = earned first)
--                   S4 0                                    -> untouched, no record
--                   review_points 50                        -> 5
--   ONE   rate 1    S1 84, a 20-point cookie                -> all untouched
--   HALF  rate 0.5  S1 7                                    -> 14
--                   review_points 300                       -> 500 (its CHECK's cap)
--   P1+P2 rate 10, one purse, both joined 5 days ago:
--                   S1 273 = 100 moved in at P1 + 173 earned at P1      -> 100 + 18 = 118
--                   S2  60 = a 40-point join drain from P2 + 20 earned at P2 -> 6
--                   S3  50 = 200 earned at P1, 150 spent at P2          -> 5
--                   S4 200 = 100 earned at P1 + 100 earned at P2        -> 20
--                   S5 100 = 50 moved in at P2, 100 earned at P2, 150 spent at
--                            P2, 100 earned at P1                -> 50 + 5 = 55
--                            (spent points are taken to be the earned ones), but
--                            Campus's SHARE of it is 0: S5 took out there all they
--                            put in, so the 50 moved in must not survive as 45.
--   S1 also holds 50 community points, which must not move.
select set_config('app.points_write', 'server', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000006801', 's1-068@example.com'),
  ('00000000-0000-0000-0000-000000006802', 's2-068@example.com'),
  ('00000000-0000-0000-0000-000000006803', 's3-068@example.com'),
  ('00000000-0000-0000-0000-000000006804', 's4-068@example.com'),
  ('00000000-0000-0000-0000-000000006805', 's5-068@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000006801', 's1-068@example.com', 'S1 068', now(), 'v1'),
  ('00000000-0000-0000-0000-000000006802', 's2-068@example.com', 'S2 068', now(), 'v1'),
  ('00000000-0000-0000-0000-000000006803', 's3-068@example.com', 'S3 068', now(), 'v1'),
  ('00000000-0000-0000-0000-000000006804', 's4-068@example.com', 'S4 068', now(), 'v1'),
  ('00000000-0000-0000-0000-000000006805', 's5-068@example.com', 'S5 068', now(), 'v1');

insert into public.point_pools (id, label) values
  ('00000000-0000-0000-0000-0000000068f1', 'Chain 068');

insert into public.vendors (id, name, slug, location_label, points_per_dollar, pin_hash, active, pool_id, pool_joined_at, review_points) values
  ('00000000-0000-0000-0000-0000000068a1', 'Ten 068',   'ten-068',   null,       10,  'bcrypt-stub', true,  null, null, 50),
  ('00000000-0000-0000-0000-0000000068a2', 'One 068',   'one-068',   null,        1,  'bcrypt-stub', true,  null, null, 20),
  ('00000000-0000-0000-0000-0000000068a3', 'Half 068',  'half-068',  null,      0.5,  'bcrypt-stub', false, null, null, 300),
  ('00000000-0000-0000-0000-0000000068b1', 'Chain 068', 'chain-068-down', 'Downtown', 10, 'bcrypt-stub', true,
     '00000000-0000-0000-0000-0000000068f1', now() - interval '5 days', 0),
  ('00000000-0000-0000-0000-0000000068b2', 'Chain 068', 'chain-068-camp', 'Campus',   10, 'bcrypt-stub', true,
     '00000000-0000-0000-0000-0000000068f1', now() - interval '5 days', 0);

insert into public.rewards (id, vendor_id, title, cost_in_points, cost_in_visits, once_per_student) values
  ('00000000-0000-0000-0000-0000000068c1', '00000000-0000-0000-0000-0000000068a1', 'Gyro',      1000, null, false),
  ('00000000-0000-0000-0000-0000000068c2', '00000000-0000-0000-0000-0000000068a1', 'Odd',       1505, null, false),
  ('00000000-0000-0000-0000-0000000068c3', '00000000-0000-0000-0000-0000000068a1', 'Mint',         3, null, false),
  ('00000000-0000-0000-0000-0000000068c4', '00000000-0000-0000-0000-0000000068a1', 'Sign-up',      0, null, true),
  ('00000000-0000-0000-0000-0000000068c5', '00000000-0000-0000-0000-0000000068a1', 'Punch roll', null,    5, false),
  ('00000000-0000-0000-0000-0000000068c6', '00000000-0000-0000-0000-0000000068a2', 'Cookie',      20, null, false),
  ('00000000-0000-0000-0000-0000000068c7', '00000000-0000-0000-0000-0000000068a3', 'Drink',      100, null, false),
  ('00000000-0000-0000-0000-0000000068c8', '00000000-0000-0000-0000-0000000068a3', 'Catering', 60000, null, false),
  ('00000000-0000-0000-0000-0000000068c9', '00000000-0000-0000-0000-0000000068b1', 'Taco',      1000, null, false);

insert into public.point_balances (user_id, vendor_id, balance) values
  ('00000000-0000-0000-0000-000000006801', '00000000-0000-0000-0000-0000000068a1',  155),
  ('00000000-0000-0000-0000-000000006802', '00000000-0000-0000-0000-0000000068a1', 1512),
  ('00000000-0000-0000-0000-000000006803', '00000000-0000-0000-0000-0000000068a1',   30),
  ('00000000-0000-0000-0000-000000006804', '00000000-0000-0000-0000-0000000068a1',    0),
  ('00000000-0000-0000-0000-000000006801', '00000000-0000-0000-0000-0000000068a2',   84),
  ('00000000-0000-0000-0000-000000006801', '00000000-0000-0000-0000-0000000068a3',    7);

insert into public.pool_balances (user_id, pool_id, balance) values
  ('00000000-0000-0000-0000-000000006801', '00000000-0000-0000-0000-0000000068f1', 273),
  ('00000000-0000-0000-0000-000000006802', '00000000-0000-0000-0000-0000000068f1',  60),
  ('00000000-0000-0000-0000-000000006803', '00000000-0000-0000-0000-0000000068f1',  50),
  ('00000000-0000-0000-0000-000000006804', '00000000-0000-0000-0000-0000000068f1', 200),
  ('00000000-0000-0000-0000-000000006805', '00000000-0000-0000-0000-0000000068f1', 100);

insert into public.community_balances (user_id, balance, lifetime_earned) values
  ('00000000-0000-0000-0000-000000006801', 50, 150);

-- P2's join drained S2's 40 Campus points into the purse.
insert into public.pool_moves (pool_id, vendor_id, user_id, kind, amount, created_at) values
  ('00000000-0000-0000-0000-0000000068f1', '00000000-0000-0000-0000-0000000068b2',
   '00000000-0000-0000-0000-000000006802', 'join', 40, now() - interval '5 days');

insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, community_points, created_at) values
  -- TEN
  ('00000000-0000-0000-0000-000000006801', '00000000-0000-0000-0000-0000000068a1', 'community_transfer',   50, null, -50, now() - interval '4 days'),
  ('00000000-0000-0000-0000-000000006801', '00000000-0000-0000-0000-0000000068a1', 'earn',                105, 10.50, 10, now() - interval '3 days'),
  ('00000000-0000-0000-0000-000000006802', '00000000-0000-0000-0000-0000000068a1', 'earn',               1512, 151.20, 151, now() - interval '3 days'),
  ('00000000-0000-0000-0000-000000006803', '00000000-0000-0000-0000-0000000068a1', 'community_transfer',   50, null, -50, now() - interval '4 days'),
  ('00000000-0000-0000-0000-000000006803', '00000000-0000-0000-0000-0000000068a1', 'redeem',              -20, null,   0, now() - interval '2 days'),
  -- ONE and HALF
  ('00000000-0000-0000-0000-000000006801', '00000000-0000-0000-0000-0000000068a2', 'earn',                 84, 84,     8, now() - interval '3 days'),
  ('00000000-0000-0000-0000-000000006801', '00000000-0000-0000-0000-0000000068a3', 'earn',                  7, 14,     0, now() - interval '3 days'),
  -- the purse
  ('00000000-0000-0000-0000-000000006801', '00000000-0000-0000-0000-0000000068b1', 'community_transfer',  100, null, -100, now() - interval '4 days'),
  ('00000000-0000-0000-0000-000000006801', '00000000-0000-0000-0000-0000000068b1', 'earn',                173, 17.30, 17, now() - interval '3 days'),
  ('00000000-0000-0000-0000-000000006802', '00000000-0000-0000-0000-0000000068b2', 'earn',                 20, 2,      2, now() - interval '3 days'),
  ('00000000-0000-0000-0000-000000006803', '00000000-0000-0000-0000-0000000068b1', 'earn',                200, 20,    20, now() - interval '3 days'),
  ('00000000-0000-0000-0000-000000006803', '00000000-0000-0000-0000-0000000068b2', 'redeem',             -150, null,   0, now() - interval '2 days'),
  ('00000000-0000-0000-0000-000000006804', '00000000-0000-0000-0000-0000000068b1', 'earn',                100, 10,    10, now() - interval '3 days'),
  ('00000000-0000-0000-0000-000000006804', '00000000-0000-0000-0000-0000000068b2', 'earn',                100, 10,    10, now() - interval '3 days'),
  ('00000000-0000-0000-0000-000000006805', '00000000-0000-0000-0000-0000000068b2', 'community_transfer',   50, null, -50, now() - interval '4 days'),
  ('00000000-0000-0000-0000-000000006805', '00000000-0000-0000-0000-0000000068b2', 'earn',                100, 10,    10, now() - interval '3 days'),
  ('00000000-0000-0000-0000-000000006805', '00000000-0000-0000-0000-0000000068b2', 'redeem',             -150, null,   0, now() - interval '2 days'),
  ('00000000-0000-0000-0000-000000006805', '00000000-0000-0000-0000-0000000068b1', 'earn',                100, 10,    10, now() - interval '3 days');
