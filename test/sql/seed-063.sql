-- Pre-migration world for migration-063 (the bonus window).
--
-- Two students and two vendors, seeded BEFORE the migration so the credit rows
-- the behavior file writes have real foreign keys to point at — and so the
-- `on delete set null` behaviour, which is the whole reason the report keeps
-- adding up after a spot leaves, can be exercised against a vendor that is
-- genuinely deletable rather than one invented mid-assertion.
--
--   S1 earns at both spots (so the per-vendor breakdown has two rows to sort)
--   S2 earns at one (so `count(distinct user_id)` is worth asserting)
--   GOING is the vendor deleted in the behavior file, to prove the total
--     survives the attribution being lost.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000631', 's1-063@example.com'),
  ('00000000-0000-0000-0000-000000000632', 's2-063@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000000631', 's1-063@example.com', 'S1', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000632', 's2-063@example.com', 'S2', now(), 'v1');

insert into public.vendors (id, name, slug, points_per_dollar, active) values
  ('00000000-0000-0000-0000-00000000063a', 'Window Cafe 063',  'window-cafe-063',  10, true),
  ('00000000-0000-0000-0000-00000000063b', 'Going Away 063',   'going-away-063',   10, true);
