-- Pre-migration world for migration-064 (email reach for reminders and
-- announcements).
--
-- Six students, and every one of them exists to be a different answer to the
-- one question this migration changes: "can we reach this person, and how?"
-- Before migration-064 both claims answered it with a single `exists` on
-- push_subscriptions, so five of these six were simply not candidates.
--
-- THE CAST (what each one exists to prove)
--
--   S_BOTH    endpoint + address            -> out_reach 'both'. The control:
--                                             migration-060 already claimed
--                                             this student and must still.
--   S_EMAIL   NO endpoint + address         -> out_reach 'email'. THE POINT OF
--                                             THE WHOLE MIGRATION. This is the
--                                             student who drifted away, whose
--                                             subscription was never created
--                                             because it can only be created
--                                             from inside the app, and whom the
--                                             reminder built to fetch them back
--                                             could not reach.
--   S_PUSHOFF endpoint + address, but
--             push_opt_in = false           -> out_reach 'email'. Proves
--                                             push_opt_in moved INSIDE the push
--                                             arm. Turning off Deal alerts
--                                             deletes endpoints and used to mean
--                                             unreachable full stop; the email
--                                             switch is independent (047).
--   S_EMAILOFF no endpoint, email_opt_in
--             = false                       -> never claimed. The opt-out has to
--                                             survive a feature that wants to
--                                             use the channel.
--   S_SUPPRESS no endpoint, address on the
--             suppression list              -> never claimed. ANY scope blocks:
--                                             a reminder is marketing, so a
--                                             'marketing' row is enough, and
--                                             claiming here would hand the
--                                             mailer a student it must drop.
--   S_NOMAIL  no endpoint, no address       -> never claimed by either channel.
--                                             The floor: a profile row is not
--                                             by itself a way to reach someone.
--
-- All six get a reward they can afford at one vendor, so the Node-side cascade
-- would land on an emailable tier for every one of them. That is not asserted
-- here (the cascade is pure and lives in test/reminders.test.js); it is set up
-- so that nothing in this file passes because the content happened to be empty.
--
-- No student_notify_state rows for S_BOTH, S_EMAIL, S_SUPPRESS or S_NOMAIL, on
-- purpose: the backfill in claim_reminder_pushes is supposed to create them, and
-- seeding them would hide a backfill that stopped working. The two with a switch
-- turned off need a row to carry the switch.

select set_config('app.points_write', 'server', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000064001', 's-both-064@example.com'),
  ('00000000-0000-0000-0000-000000064002', 's-email-064@example.com'),
  ('00000000-0000-0000-0000-000000064003', 's-pushoff-064@example.com'),
  ('00000000-0000-0000-0000-000000064004', 's-emailoff-064@example.com'),
  ('00000000-0000-0000-0000-000000064005', 's-suppress-064@example.com'),
  ('00000000-0000-0000-0000-000000064006', 's-nomail-064@example.com')
on conflict (id) do nothing;

-- terms_version is deliberately an OLD value for all six. These students have
-- not accepted the current documents, which is exactly the population this
-- release is about -- and the assertions below prove that it makes no difference
-- whatsoever to whether they can be claimed. Nothing in any send path reads it.
insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000064001', 's-both-064@example.com',     'Both 064',      now(), '2026-01-01'),
  ('00000000-0000-0000-0000-000000064002', 's-email-064@example.com',    'Email Only 064', now(), '2026-01-01'),
  ('00000000-0000-0000-0000-000000064003', 's-pushoff-064@example.com',  'Push Off 064',  now(), '2026-01-01'),
  ('00000000-0000-0000-0000-000000064004', 's-emailoff-064@example.com', 'Email Off 064', now(), '2026-01-01'),
  ('00000000-0000-0000-0000-000000064005', 's-suppress-064@example.com', 'Suppressed 064', now(), '2026-01-01'),
  -- The one with nothing. An empty string rather than NULL, because `trim(x) <> ''`
  -- and `x is not null` are different tests and the claim has to pass both.
  ('00000000-0000-0000-0000-000000064006', '',                           'No Mail 064',   now(), '2026-01-01')
on conflict (user_id) do nothing;

-- Endpoints for exactly two of them.
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, role) values
  ('00000000-0000-0000-0000-000000064001', 'https://push.example/s-both-064',    'k', 'a', 'student'),
  ('00000000-0000-0000-0000-000000064003', 'https://push.example/s-pushoff-064', 'k', 'a', 'student')
on conflict (endpoint) do nothing;

-- Only the two students whose switches matter. See the note above on why the
-- other four are left for the backfill to create.
insert into public.student_notify_state (user_id, push_opt_in, email_opt_in) values
  ('00000000-0000-0000-0000-000000064003', false, true),
  ('00000000-0000-0000-0000-000000064004', true,  false)
on conflict (user_id) do update
  set push_opt_in = excluded.push_opt_in, email_opt_in = excluded.email_opt_in;

-- A 'marketing' row, not 'all', because that is the weaker of the two and the
-- one a reminder still has to respect. isSuppressed(addr, {marketing:true}) in
-- src/lib/email.js refuses on either, and the claim's test is `not exists` on
-- the table with no scope filter for exactly that reason.
insert into public.email_suppressions (email, scope, reason) values
  ('s-suppress-064@example.com', 'marketing', 'unsubscribed')
on conflict (email) do update set scope = excluded.scope;
