-- Pre-migration world for migration-065 (NFC tag traffic).
--
-- The migration is purely additive (one table, two views, one read-only
-- function), so there is no populated table for it to break. What the seed has
-- to provide is the far end of the one foreign key and the account an app tap
-- names:
--
--   A   the spot whose tag gets tapped. Every roll-up figure in the behavior
--       file is this vendor's.
--   B   a spot nobody has tapped, so "no taps means no row in the view" can be
--       shown rather than assumed — the admin route depends on it, because it
--       starts from the vendors table and left-joins the view.
--   S1  the student whose iPhone app reports a tap it handled itself. nfc_taps
--       .user_id carries no foreign key (like client_events), so the row would
--       insert without this account; it exists so the visitor hash the
--       behavior file derives from the id is derived from a real one.
--
-- The taps themselves are NOT seeded here: the harness runs the seed before
-- the migration under test, and nfc_taps does not exist until it has run.
-- behavior-065.sql writes them in its first block.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000651', 's1-065@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000000651', 's1-065@example.com', 'S1', now(), 'v1');

insert into public.vendors (id, name, slug, points_per_dollar, active) values
  ('00000000-0000-0000-0000-00000000065a', 'Irvings 065',   'irvings-065',   10, true),
  ('00000000-0000-0000-0000-00000000065b', 'Untapped 065',  'untapped-065',  10, true);

-- migration-068 holds every vendor at $1 = 1 point, and converts a seed left on
-- any other rate before these assertions run. So this world earns at 1 too.
update public.vendors set points_per_dollar = 1 where points_per_dollar <> 1;
