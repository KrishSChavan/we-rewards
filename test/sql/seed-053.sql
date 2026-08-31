-- Pre-migration world for migration-053 (ambassadors).
--
-- The migration is purely additive — three new tables and a view — so there is
-- no populated table for it to break. What the seed has to provide is both ends
-- of the money: the ambassadors' OWN accounts (ambassadors.user_id, which is
-- who gets paid) and the recruits whose signups do the paying.
--
--   A1, A2  the ambassadors' own student accounts. An ambassador with no
--           account cannot be paid at all — grant_community_points raises
--           GRANT_STUDENT_UNKNOWN — which is the whole reason the admin form
--           refuses to create one, and the reason these two exist here.
--   S1      a recruit. Credited to one ambassador, and pays them, once ever.
--   S2      a second recruit, so "once per account" can be shown to be per
--           RECRUIT rather than per ambassador or per server.
--
-- ALSO one printed banner, which is not incidental. Ambassadors share the /r/
-- rail with migration-050's codes, and the admin form refuses an ambassador
-- code that collides with a banner's. behavior-053.sql asserts that the two
-- namespaces really can overlap at the database level — which is exactly why
-- that Node-side guard has to exist.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000531', 's1-053@example.com'),
  ('00000000-0000-0000-0000-000000000532', 's2-053@example.com'),
  -- The ambassadors' own accounts. Their profiles.email is what the admin form
  -- resolves ambassadors.user_id from, so these addresses have to be the ones
  -- behaviour-053 creates the ambassadors with.
  ('00000000-0000-0000-0000-000000000541', 'sarah@psu.edu'),
  ('00000000-0000-0000-0000-000000000542', 'jordan@psu.edu');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000000531', 's1-053@example.com', 'S1', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000532', 's2-053@example.com', 'S2', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000541', 'sarah@psu.edu', 'Sarah Chen', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000542', 'jordan@psu.edu', 'Jordan Diaz', now(), 'v1');

-- Lowercase and exactly 8 characters, the shape src/lib/tracked-qr.js mints.
-- Uppercased it is SARAHXYZ, a perfectly legal ambassador code.
insert into public.tracked_qr_codes (code, name, points)
values ('sarahxyz', 'HUB east entrance banner', 0);
