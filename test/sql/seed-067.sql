-- Pre-migration world for migration-067 (free items).
--
--   V1  Solo spot with one ordinary priced item (Coffee, 50 pts).
--       S2 holds 100 here; S1 has NEVER earned here and has no purse row,
--       which is the student a free item is most likely for, and the one the
--       old debit would have refused.
--   V2  Pooled with V3 (one purse). S3's money lives in the pool and S3 has no
--       point_balances row at either location.
--   V3  Pooled with V2.
--
-- No free item is seeded: before 067 the schema refuses one. The behaviour
-- file creates them after the migration has run.
begin;
select set_config('app.points_write', 'server', true);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000671', 's1-067@example.com'),
  ('00000000-0000-0000-0000-000000000672', 's2-067@example.com'),
  ('00000000-0000-0000-0000-000000000673', 's3-067@example.com');

insert into public.profiles (user_id, email, name) values
  ('00000000-0000-0000-0000-000000000671', 's1-067@example.com', 'Sam One'),
  ('00000000-0000-0000-0000-000000000672', 's2-067@example.com', 'Sam Two'),
  ('00000000-0000-0000-0000-000000000673', 's3-067@example.com', 'Sam Three')
on conflict (user_id) do nothing;

insert into public.point_pools (id, label) values
  ('00000000-0000-0000-0000-0000000067f1', 'Joes 067');

insert into public.vendors (id, name, slug, location_label, points_per_dollar, pin_hash, active) values
  ('00000000-0000-0000-0000-0000000067a1', 'Solo 067', 'solo-067',        null,       10, 'bcrypt-stub', true),
  ('00000000-0000-0000-0000-0000000067a2', 'Joes 067', 'joes-067-down',   'Downtown', 10, 'bcrypt-stub', true),
  ('00000000-0000-0000-0000-0000000067a3', 'Joes 067', 'joes-067-campus', 'Campus',   10, 'bcrypt-stub', true);

insert into public.rewards (id, vendor_id, title, cost_in_points, cost_in_visits, active) values
  ('00000000-0000-0000-0000-0000000067c1', '00000000-0000-0000-0000-0000000067a1', 'Coffee', 50, null, true);

insert into public.point_balances (user_id, vendor_id, balance) values
  ('00000000-0000-0000-0000-000000000672', '00000000-0000-0000-0000-0000000067a1', 100);
commit;

-- The pool is made the supported way, through pool_join (migration-046).
select * from public.pool_join('00000000-0000-0000-0000-0000000067f1', '00000000-0000-0000-0000-0000000067a2');
select * from public.pool_join('00000000-0000-0000-0000-0000000067f1', '00000000-0000-0000-0000-0000000067a3');

-- migration-068 holds every vendor at $1 = 1 point, and converts a seed left on
-- any other rate before these assertions run. So this world earns at 1 too.
update public.vendors set points_per_dollar = 1 where points_per_dollar <> 1;
