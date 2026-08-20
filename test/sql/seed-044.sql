-- Pre-migration world for migration-044 (point pools).
--
-- 044 is additive and INERT: it creates three tables and one nullable column and
-- touches nothing that exists. So what this seed is for is proving that claim.
-- It builds the world 044 has to leave alone:
--
--   Joe's Downtown / Joe's Campus — two locations, ONE owner login, the shape
--                                  migration-043 made possible and the exact
--                                  shape a pool will later be built from.
--   Solo Salads                   — a single-location vendor, i.e. nearly every
--                                  vendor on the platform. It must come out of
--                                  044 with pool_id null and its balances
--                                  untouched, having paid nothing for a feature
--                                  it will never use.
--
-- Balances are deliberately different at each location for the same student
-- (300 at Downtown, 120 at Campus), because that is the pair the JOIN drain will
-- later have to add up to exactly 420 — and 044 must leave them apart.
--
-- migration-025 blocks direct DML on point_balances, so this seed takes the
-- documented override. `false` makes the setting session-scoped, matching
-- seed.sql / seed-032.sql / seed-041.sql.
select set_config('app.points_write', 'server', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000441', 's1-044@example.com'),
  ('00000000-0000-0000-0000-000000000442', 's2-044@example.com'),
  ('00000000-0000-0000-0000-0000000004f1', 'owner-044@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000000441', 's1-044@example.com', 'S1 044', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000442', 's2-044@example.com', 'S2 044', now(), 'v1');

-- location_label lands here because 043 is applied before this seed runs; the
-- pair is what a pooled chain looks like.
insert into public.vendors (id, name, slug, location_label, points_per_dollar, active) values
  ('00000000-0000-0000-0000-0000000004b1', 'Joe''s Pizza 044', 'joes-044',      'Downtown', 10, true),
  ('00000000-0000-0000-0000-0000000004b2', 'Joe''s Pizza 044', 'joes-044-2',    'Campus',   10, true),
  ('00000000-0000-0000-0000-0000000004b3', 'Solo Salads 044',  'solo-044',      null,        8, true);

-- One login, two locations: the multi-location owner from migration-043.
insert into public.vendor_staff (vendor_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000004f1', 'owner'),
  ('00000000-0000-0000-0000-0000000004b2', '00000000-0000-0000-0000-0000000004f1', 'owner');

insert into public.point_balances (user_id, vendor_id, balance) values
  ('00000000-0000-0000-0000-000000000441', '00000000-0000-0000-0000-0000000004b1', 300),
  ('00000000-0000-0000-0000-000000000441', '00000000-0000-0000-0000-0000000004b2', 120),
  ('00000000-0000-0000-0000-000000000442', '00000000-0000-0000-0000-0000000004b1',  75),
  ('00000000-0000-0000-0000-000000000442', '00000000-0000-0000-0000-0000000004b3',  40);

insert into public.transactions (user_id, vendor_id, type, points, dollar_amount) values
  ('00000000-0000-0000-0000-000000000441', '00000000-0000-0000-0000-0000000004b1', 'earn', 300, 30),
  ('00000000-0000-0000-0000-000000000441', '00000000-0000-0000-0000-0000000004b2', 'earn', 120, 12),
  ('00000000-0000-0000-0000-000000000442', '00000000-0000-0000-0000-0000000004b1', 'earn',  75, 7.5),
  ('00000000-0000-0000-0000-000000000442', '00000000-0000-0000-0000-0000000004b3', 'earn',  40, 5);
