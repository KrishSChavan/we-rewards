-- Pre-migration world for migration-046 (join, leave, settle).
--
-- Three locations of one chain, all with a PIN and the SAME earning rate (both
-- are join preconditions), a pool with nobody in it yet, and customers holding
-- ordinary per-location balances. Nothing is pooled at seed time: the joining
-- is what the assertions do.
--
--   S1  300 at Downtown, 120 at Campus   — the pair that must become 420.
--   S2   75 at Downtown only             — funded by one location alone, so the
--                                          split has an unambiguous answer.
--   S3   40 at Westgate only             — never funded Downtown or Campus, so
--                                          they must take nothing when either
--                                          leaves.
--
-- A fourth vendor has NO PIN, to prove the precondition bites.
select set_config('app.points_write', 'server', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000461', 's1-046@example.com'),
  ('00000000-0000-0000-0000-000000000462', 's2-046@example.com'),
  ('00000000-0000-0000-0000-000000000463', 's3-046@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000000461', 's1-046@example.com', 'S1 046', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000462', 's2-046@example.com', 'S2 046', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000463', 's3-046@example.com', 'S3 046', now(), 'v1');

insert into public.point_pools (id, label) values
  ('00000000-0000-0000-0000-0000000006f1', 'Joes 046');

insert into public.vendors (id, name, slug, location_label, points_per_dollar, pin_hash, active) values
  ('00000000-0000-0000-0000-0000000006a1', 'Joes 046', 'joes-046-down',   'Downtown', 10, 'bcrypt-stub', true),
  ('00000000-0000-0000-0000-0000000006a2', 'Joes 046', 'joes-046-campus', 'Campus',   10, 'bcrypt-stub', true),
  ('00000000-0000-0000-0000-0000000006a3', 'Joes 046', 'joes-046-west',   'Westgate', 10, 'bcrypt-stub', true),
  ('00000000-0000-0000-0000-0000000006a4', 'No Pin 046', 'joes-046-nopin', 'Airport',  10, null,         true),
  ('00000000-0000-0000-0000-0000000006a5', 'Fast 046',  'joes-046-fast',  'Kiosk',    20, 'bcrypt-stub', true);

insert into public.point_balances (user_id, vendor_id, balance) values
  ('00000000-0000-0000-0000-000000000461', '00000000-0000-0000-0000-0000000006a1', 300),
  ('00000000-0000-0000-0000-000000000461', '00000000-0000-0000-0000-0000000006a2', 120),
  ('00000000-0000-0000-0000-000000000462', '00000000-0000-0000-0000-0000000006a1',  75),
  ('00000000-0000-0000-0000-000000000463', '00000000-0000-0000-0000-0000000006a3',  40);

-- The trading behind those balances, so the contribution split has real rows to
-- read rather than only the join moves.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at) values
  ('00000000-0000-0000-0000-000000000461', '00000000-0000-0000-0000-0000000006a1', 'earn', 300, 30, now() - interval '2 days'),
  ('00000000-0000-0000-0000-000000000461', '00000000-0000-0000-0000-0000000006a2', 'earn', 120, 12, now() - interval '2 days'),
  ('00000000-0000-0000-0000-000000000462', '00000000-0000-0000-0000-0000000006a1', 'earn',  75, 7.5, now() - interval '2 days'),
  ('00000000-0000-0000-0000-000000000463', '00000000-0000-0000-0000-0000000006a3', 'earn',  40, 4, now() - interval '2 days');
