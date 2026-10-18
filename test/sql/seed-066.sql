-- Pre-migration world for migration-066 (spot reviews).
--
--   V1  Solo spot. S1 already holds 100 here, so a paid review must ADD to it.
--   V2  Pooled with V3 (one purse). A review here must pay the POOL, not V2.
--   V3  Pooled with V2.
--   V4  Solo spot that will pay nothing for reviews (review_points stays 0).
--   V5  Switched off: no review may be written or paid.
--
-- Balances are written inside one transaction with the guard flag set
-- TRANSACTION-LOCALLY (third argument true), never session-wide: block 9 of
-- the behaviour file proves the migration-025 guard still bites, which would
-- prove nothing on a session that had left the flag on.
begin;
select set_config('app.points_write', 'server', true);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000661', 's1-066@example.com'),
  ('00000000-0000-0000-0000-000000000662', 's2-066@example.com'),
  ('00000000-0000-0000-0000-000000000663', 's3-066@example.com');

insert into public.profiles (user_id, email, name) values
  ('00000000-0000-0000-0000-000000000661', 's1-066@example.com', 'Sam One'),
  ('00000000-0000-0000-0000-000000000662', 's2-066@example.com', 'Sam Two'),
  ('00000000-0000-0000-0000-000000000663', 's3-066@example.com', 'Sam Three')
on conflict (user_id) do nothing;

insert into public.point_pools (id, label) values
  ('00000000-0000-0000-0000-0000000066f1', 'Joes 066');

insert into public.vendors (id, name, slug, location_label, points_per_dollar, pin_hash, active) values
  ('00000000-0000-0000-0000-0000000066a1', 'Solo 066',  'solo-066',        null,       10, 'bcrypt-stub', true),
  ('00000000-0000-0000-0000-0000000066a2', 'Joes 066',  'joes-066-down',   'Downtown', 10, 'bcrypt-stub', true),
  ('00000000-0000-0000-0000-0000000066a3', 'Joes 066',  'joes-066-campus', 'Campus',   10, 'bcrypt-stub', true),
  ('00000000-0000-0000-0000-0000000066a4', 'Free 066',  'free-066',        null,       10, 'bcrypt-stub', true),
  ('00000000-0000-0000-0000-0000000066a5', 'Off 066',   'off-066',         null,       10, 'bcrypt-stub', false);

insert into public.point_balances (user_id, vendor_id, balance) values
  ('00000000-0000-0000-0000-000000000661', '00000000-0000-0000-0000-0000000066a1', 100);
commit;

-- The pool is made the supported way, through pool_join (migration-046).
select * from public.pool_join('00000000-0000-0000-0000-0000000066f1', '00000000-0000-0000-0000-0000000066a2');
select * from public.pool_join('00000000-0000-0000-0000-0000000066f1', '00000000-0000-0000-0000-0000000066a3');

-- migration-068 holds every vendor at $1 = 1 point, and converts a seed left on
-- any other rate before these assertions run. So this world earns at 1 too.
update public.vendors set points_per_dollar = 1 where points_per_dollar <> 1;
