-- Pre-migration world for migration-056 (create_earn_code made re-runnable).
--
-- What 056 has to survive is a table that already contains every shape the old
-- function could leave behind, because the first thing it does is housekeeping:
--
--   S1  a student with ONE live code. The stable-code path.
--   S2  a student with TWO live codes — the duplicate pair the old function
--       could mint when two calls raced (and exactly what a retried POST would
--       have produced). 056 must pick one DETERMINISTICALLY rather than
--       alternating, so S2's two rows have different expiries on purpose.
--   S3  a student whose only code has EXPIRED. Must be cleaned and replaced,
--       not reused.
--   S4  a student who is never seen again, holding an expired row. Nothing in
--       056 runs on their behalf, so they are how the bounded global sweep is
--       shown to still collect other people's litter.

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000561', 's1@psu.edu'),
  ('00000000-0000-0000-0000-000000000562', 's2@psu.edu'),
  ('00000000-0000-0000-0000-000000000563', 's3@psu.edu'),
  ('00000000-0000-0000-0000-000000000564', 's4@psu.edu');

insert into public.profiles (user_id, name, email) values
  ('00000000-0000-0000-0000-000000000561', 'One Code',   's1@psu.edu'),
  ('00000000-0000-0000-0000-000000000562', 'Two Codes',  's2@psu.edu'),
  ('00000000-0000-0000-0000-000000000563', 'Expired',    's3@psu.edu'),
  ('00000000-0000-0000-0000-000000000564', 'Never Back', 's4@psu.edu');

insert into public.earn_codes (code, user_id, expires_at) values
  ('100001', '00000000-0000-0000-0000-000000000561', now() + interval '200 seconds'),
  -- The duplicate pair. 100003 expires LATER, so it is the one a deterministic
  -- `order by expires_at desc` must return.
  ('100002', '00000000-0000-0000-0000-000000000562', now() + interval '100 seconds'),
  ('100003', '00000000-0000-0000-0000-000000000562', now() + interval '250 seconds'),
  ('100004', '00000000-0000-0000-0000-000000000563', now() - interval '10 seconds'),
  ('100005', '00000000-0000-0000-0000-000000000564', now() - interval '1 hour');
