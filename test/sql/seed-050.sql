-- Pre-migration world for migration-050 (trackable poster QR codes).
--
-- The migration is purely additive — three new tables — so unlike 049 there is
-- no populated table for it to break. What the seed has to provide instead is
-- the far end of the two foreign keys and the payout it has to prove:
-- tracked_qr_signups.user_id references profiles, and the once-per-account
-- assertion needs real students to pay.
--
--   S1  scans a banner and signs up. Gets paid, once, ever.
--   S2  a second account, so "once per account" can be shown to be per ACCOUNT
--       and not per banner or per server.
--
-- Seeded before the migration only because that is the harness's order; nothing
-- here depends on being pre-migration.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000501', 's1-050@example.com'),
  ('00000000-0000-0000-0000-000000000502', 's2-050@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000000501', 's1-050@example.com', 'S1', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000502', 's2-050@example.com', 'S2', now(), 'v1');
