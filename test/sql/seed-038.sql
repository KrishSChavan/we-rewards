-- Pre-migration world for migration-038 (receipt claims): one active vendor at
-- the default 10 pts/$, and three students —
--   S1 exercises the happy path, the rcpt-exclusion, and the daily cap
--   S2 exercises the same-receipt race and the gate errors (age/future/size)
--   S3 exercises the counter double-dip check
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000381', 's1-038@example.com'),
  ('00000000-0000-0000-0000-000000000382', 's2-038@example.com'),
  ('00000000-0000-0000-0000-000000000383', 's3-038@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000000381', 's1-038@example.com', 'S1', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000382', 's2-038@example.com', 'S2', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000383', 's3-038@example.com', 'S3', now(), 'v1');

insert into public.vendors (name, slug, points_per_dollar, active)
values ('Receipt Diner 038', 'receipt-diner-038', 10, true);

-- migration-068 holds every vendor at $1 = 1 point, and converts a seed left on
-- any other rate before these assertions run. So this world earns at 1 too.
update public.vendors set points_per_dollar = 1 where points_per_dollar <> 1;
