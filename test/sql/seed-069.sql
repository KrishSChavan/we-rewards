-- Pre-migration world for migration-069 (all-student deal requests).
--
-- Small on purpose. The new code is two functions over one new table, and
-- delivery is the existing campaign claim (migration-047), which has its own
-- exhaustive fixtures in seed-047. What this file needs is just enough of a
-- world to prove three things:
--
--   1. an approval reaches EVERY profile and nobody without one;
--   2. a request never reaches anybody until it is approved;
--   3. once approved, the ordinary claim still applies every opt-out, so the
--      new audience is not a way around Email alerts, Deal alerts or the
--      suppression list.
--
-- THE CAST
--   S_PUSH      a student endpoint and default switches: claimable, by push.
--   S_EMAIL     no endpoint, Email alerts on: claimable, by email.
--   S_OFF       no endpoint, Email alerts OFF: must never be claimed.
--   S_SUPP      no endpoint, Email alerts on, but the address is on the
--               suppression list (a bounce or a spam complaint): must never be
--               claimed.
--   S_STAFF     a vendor_staff login that also has a student profile. Included,
--               the same rule migration-061's 'all' applies.
--   NOCONSENT   an auth.users row and no profile: signed in, never agreed to
--               anything. Must not be in any audience.
--
-- Two vendors: REQ (active, does the asking) and OFFSPOT (switched off, so a
-- request from it, or an approval of one, is refused).

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000069001', 's-push-069@example.com'),
  ('00000000-0000-0000-0000-000000069002', 's-email-069@example.com'),
  ('00000000-0000-0000-0000-000000069003', 's-off-069@example.com'),
  ('00000000-0000-0000-0000-000000069004', 's-supp-069@example.com'),
  ('00000000-0000-0000-0000-000000069005', 's-staff-069@example.com'),
  ('00000000-0000-0000-0000-0000000690ff', 'noconsent-069@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000069001', 's-push-069@example.com',  'Push 069',  now(), 'v1'),
  ('00000000-0000-0000-0000-000000069002', 's-email-069@example.com', 'Email 069', now(), 'v1'),
  ('00000000-0000-0000-0000-000000069003', 's-off-069@example.com',   'Off 069',   now(), 'v1'),
  ('00000000-0000-0000-0000-000000069004', 's-supp-069@example.com',  'Supp 069',  now(), 'v1'),
  ('00000000-0000-0000-0000-000000069005', 's-staff-069@example.com', 'Staff 069', now(), 'v1');

insert into public.vendors (id, name, slug, points_per_dollar, active) values
  ('00000000-0000-0000-0000-0000000690a1', 'Req Spot 069', 'req-spot-069', 1, true),
  ('00000000-0000-0000-0000-0000000690a2', 'Off Spot 069', 'off-spot-069', 1, false);

insert into public.vendor_staff (vendor_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000690a1', '00000000-0000-0000-0000-000000069005', 'owner');

insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, role) values
  ('00000000-0000-0000-0000-000000069001', 'https://push.example/s-push-069', 'k', 'a', 'student');

-- Written out for everyone, switches explicit: the opt-outs are the fixture.
insert into public.student_notify_state (user_id, push_opt_in, email_opt_in) values
  ('00000000-0000-0000-0000-000000069001', true, true),
  ('00000000-0000-0000-0000-000000069002', true, true),
  ('00000000-0000-0000-0000-000000069003', true, false),
  ('00000000-0000-0000-0000-000000069004', true, true),
  ('00000000-0000-0000-0000-000000069005', true, true);

insert into public.email_suppressions (email, scope, reason) values
  ('s-supp-069@example.com', 'all', 'bounce');
