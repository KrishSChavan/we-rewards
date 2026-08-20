-- Pre-migration world for migration-045 (the RPC bodies learn about pools).
--
-- Built to make the ONE bug that would have shipped unmissable:
--
--   S1 holds 500 points in a POOL, and has NO point_balances row at Campus at
--   all. That is not an edge case, it is an ordinary first visit to a sibling:
--   they earned at Downtown and walked next door. Redeeming there is what makes
--   029's trailing `select ... from point_balances where vendor_id = <Campus>`
--   return zero rows AFTER committing the debit and deleting the code.
--
-- Also here: an unpooled control vendor (Solo Salads) whose every path must
-- come out of 045 byte-identical, a visits reward at Campus so the visits
-- branch can be checked for the points figure it reports alongside, and S3, who
-- holds pool money but has never transacted at Campus, for the campaign
-- audience gate.
--
-- Balances and transactions are written directly rather than through the RPCs:
-- this seed runs BEFORE 045, so award_points here is still 026's pool-blind
-- body and could not create the world under test. migration-025 blocks direct
-- DML, so this takes the documented override; `false` makes it session-scoped,
-- matching seed.sql / seed-041.sql / seed-044.sql.
select set_config('app.points_write', 'server', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000451', 's1-045@example.com'),
  ('00000000-0000-0000-0000-000000000452', 's2-045@example.com'),
  ('00000000-0000-0000-0000-000000000453', 's3-045@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000000451', 's1-045@example.com', 'S1 045', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000452', 's2-045@example.com', 'S2 045', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000453', 's3-045@example.com', 'S3 045', now(), 'v1');

insert into public.point_pools (id, label) values
  ('00000000-0000-0000-0000-0000000005f1', 'Joes 045');

-- Two locations of one chain, sharing a purse, plus an unpooled control.
insert into public.vendors (id, name, slug, location_label, points_per_dollar, active, pool_id, pool_joined_at) values
  ('00000000-0000-0000-0000-0000000005a1', 'Joes 045', 'joes-045-down', 'Downtown', 10, true,
   '00000000-0000-0000-0000-0000000005f1', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000005a2', 'Joes 045', 'joes-045-campus', 'Campus', 10, true,
   '00000000-0000-0000-0000-0000000005f1', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000005a3', 'Solo 045', 'solo-045', null, 10, true, null, null);

-- The menu is NOT shared: each location prices its own rewards.
insert into public.rewards (id, vendor_id, title, cost_in_points, cost_in_visits, active) values
  ('00000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005a1', 'Downtown Bagel', 350, null, true),
  ('00000000-0000-0000-0000-0000000005c2', '00000000-0000-0000-0000-0000000005a2', 'Campus Coffee',  300, null, true),
  ('00000000-0000-0000-0000-0000000005c3', '00000000-0000-0000-0000-0000000005a2', 'Campus Drink',   null, 5,   true),
  ('00000000-0000-0000-0000-0000000005c4', '00000000-0000-0000-0000-0000000005a3', 'Solo Salad',     300, null, true);

-- S1: 500 in the shared purse, and DELIBERATELY no point_balances row anywhere.
insert into public.pool_balances (user_id, pool_id, balance) values
  ('00000000-0000-0000-0000-000000000451', '00000000-0000-0000-0000-0000000005f1', 500);

-- S3: pool money too, but see the transactions below.
insert into public.pool_balances (user_id, pool_id, balance) values
  ('00000000-0000-0000-0000-000000000453', '00000000-0000-0000-0000-0000000005f1', 200);

-- S2: the control, at the unpooled vendor.
insert into public.point_balances (user_id, vendor_id, balance) values
  ('00000000-0000-0000-0000-000000000452', '00000000-0000-0000-0000-0000000005a3', 500);

-- Visits are NOT pooled: S1's counter belongs to Campus alone.
insert into public.punch_cards (user_id, vendor_id, punches) values
  ('00000000-0000-0000-0000-000000000451', '00000000-0000-0000-0000-0000000005a2', 6);

-- Where each customer has actually been. S1 earned at Downtown only, so at
-- Campus they are a first-time visitor holding chain money. S3 has never
-- transacted at Campus at all, which is what the 'close' audience gate is for.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount) values
  ('00000000-0000-0000-0000-000000000451', '00000000-0000-0000-0000-0000000005a1', 'earn', 500, 50),
  ('00000000-0000-0000-0000-000000000453', '00000000-0000-0000-0000-0000000005a1', 'earn', 200, 20),
  ('00000000-0000-0000-0000-000000000452', '00000000-0000-0000-0000-0000000005a3', 'earn', 500, 50);
