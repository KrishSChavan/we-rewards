-- Pre-migration world for migration-039 (incentives + referrals).
--
-- Four students seeded BEFORE the migration, so the referral-code backfill has
-- real rows to fill and the uniqueness of what it generates is worth asserting:
--   R  refers everyone, and is the one who gets paid
--   F1 is referred and then makes a purchase (the happy path)
--   F2 is referred and never purchases (stays pending forever)
--   F3 is referred against an exhausted budget (qualifies, isn't paid)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000391', 'r-039@example.com'),
  ('00000000-0000-0000-0000-000000000392', 'f1-039@example.com'),
  ('00000000-0000-0000-0000-000000000393', 'f2-039@example.com'),
  ('00000000-0000-0000-0000-000000000394', 'f3-039@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000000391', 'r-039@example.com',  'R',  now(), 'v1'),
  ('00000000-0000-0000-0000-000000000392', 'f1-039@example.com', 'F1', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000393', 'f2-039@example.com', 'F2', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000394', 'f3-039@example.com', 'F3', now(), 'v1');

insert into public.vendors (name, slug, points_per_dollar, active)
values ('Incentive Cafe 039', 'incentive-cafe-039', 10, true);
