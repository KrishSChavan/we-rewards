-- Pre-migration world for migration-047 (email as a second delivery channel).
--
-- Deliberately small, and it writes campaign_recipients DIRECTLY rather than
-- going through create_campaign. What is under test is the CLAIM's reachability
-- rule, not audience selection — migration-032's own seed already covers how a
-- top-100 is built, and re-deriving one here would only add ways for this file
-- to fail for reasons that have nothing to do with email.
--
-- Four students, one queued deal each, differing only in how they can be
-- reached. The whole migration is a statement about this table:
--
--   e1 "Pushable"   push endpoint + email     — the case that already worked
--   e2 "Mailonly"   NO endpoint, has email    — THE new case. Every iOS student
--                                               who never installed the PWA is
--                                               this row, and before 047 the
--                                               claim skipped them forever.
--   e3 "Bounced"    NO endpoint, has email    — becomes suppressed in the
--                                               behaviour file, which cannot
--                                               happen here: the suppression
--                                               table does not exist yet.
--   e4 "Unreachable" NO endpoint, NO email    — must still be skipped, or the
--                                               head of the queue silently
--                                               fills with people nothing can
--                                               reach (migration-032's lesson).
--
-- A fifth user is a VENDOR login, for the self-serve reset assertions, plus a
-- sixth that is a student only — proving the terminal's recovery form cannot be
-- used to reset an account that does not run a shop.

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000471', 'e1-047@example.com'),
  ('00000000-0000-0000-0000-000000000472', 'e2-047@example.com'),
  ('00000000-0000-0000-0000-000000000473', 'e3-047@example.com'),
  ('00000000-0000-0000-0000-000000000474', 'e4-047@example.com'),
  ('00000000-0000-0000-0000-000000000475', 'owner-047@example.com'),
  ('00000000-0000-0000-0000-000000000476', 'student-only-047@example.com');

-- e4 has NO email on the profile. That is not a contrivance: a profile row is
-- created by trigger from auth.users, and an anonymous / not-yet-confirmed
-- signup can reach this table without one.
insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000000471', 'e1-047@example.com', 'Pushable',    now(), 'v1'),
  ('00000000-0000-0000-0000-000000000472', 'e2-047@example.com', 'Mailonly',    now(), 'v1'),
  ('00000000-0000-0000-0000-000000000473', 'e3-047@example.com', 'Bounced',     now(), 'v1'),
  ('00000000-0000-0000-0000-000000000474', null,                 'Unreachable', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000476', 'student-only-047@example.com', 'Student Only', now(), 'v1');

insert into public.vendors (id, name, slug, active, pin_hash) values
  ('00000000-0000-0000-0000-0000000004a1', 'Email Cafe', 'email-cafe-047', true, 'x');

-- The vendor login the self-serve reset has to find by address alone.
insert into public.vendor_staff (vendor_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-000000000475', 'owner');

-- Only e1 ever granted notification permission.
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, role) values
  ('00000000-0000-0000-0000-000000000471', 'https://push.example/e1-047', 'k', 'a', 'student');

-- One live campaign, due now, with a long window so nothing here expires
-- mid-assertion.
insert into public.vendor_campaigns (id, vendor_id, title, body, kind, deliver_after, expires_at, queued_count) values
  ('00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-0000000004a1',
   'Half price cold brew', 'Today only, until we run out.', 'deal',
   now() - interval '1 minute', now() + interval '2 days', 4);

insert into public.campaign_recipients (campaign_id, user_id, status, deliver_after) values
  ('00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-000000000471', 'queued', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-000000000472', 'queued', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-000000000473', 'queued', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-000000000474', 'queued', now() - interval '1 minute');
