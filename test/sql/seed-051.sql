-- Pre-migration world for migration-051 (claim_nearby_notification).
--
-- The function is a gate with eight ways to say no, and the seed's whole job is
-- to give each one a vendor of its own so a missing check shows up as exactly
-- one failing assertion rather than a vague "it let something through".
--
--   Fresh 051    — active, no history. The happy path, and the one the
--                  once-ever assertions then re-claim against.
--   Been To 051  — an 'earn' and nothing else. The student has stood at this
--                  counter, so "somewhere you've never been" is false about it.
--                  This is the assertion that fails if the visited check is
--                  dropped or if it is trusted from the client instead.
--   Punched 051  — a scanned visit with the counter spent back to ZERO
--                  (migration-045 assigns, never subtracts). Carried over from
--                  seed-048 deliberately: this vendor is what catches a
--                  `punches > 0` test, and since 051 delegates to
--                  student_visited_vendor_ids it must inherit that protection
--                  rather than re-implement a narrower one.
--   Closed 051   — active = false. A spot the client's cached catalogue still
--                  lists, because the phone has not reloaded since it shut.
--   Second 051   — active, no history. Exists only to be a SECOND eligible
--                  spot, which is the only way to prove the cooldown and the
--                  daily cap actually bite: with one vendor the once-ever guard
--                  would refuse the second claim regardless and every quota
--                  assertion would pass for the wrong reason.
--   Third 051    — the same, for the same reason, one test further on.
--
-- A SECOND student with no history anywhere keeps p_user_id honest: a function
-- that ignored it would hand student two the ledger rows written for student
-- one and still pass everything else here.
--
-- migration-025 blocks direct DML on `transactions`, so this takes the
-- documented override, session-scoped (`false`) exactly as seed-048 does.
select set_config('app.points_write', 'server', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000581', 's1-051@example.com'),
  ('00000000-0000-0000-0000-000000000582', 's2-051@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000000581', 's1-051@example.com', 'S1-051', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000582', 's2-051@example.com', 'S2-051', now(), 'v1');

-- Coordinates are real Penn State ones and are NOT read by the function — the
-- proximity test lives on the phone. They are here so the seed describes the
-- world the feature actually runs in, and so a future migration that does move
-- the distance maths server-side has something to assert against.
insert into public.vendors (id, name, slug, points_per_dollar, active, latitude, longitude) values
  ('00000000-0000-0000-0000-0000000005b1', 'Fresh 051',   'fresh-051',   10, true,  40.7982, -77.8599),
  ('00000000-0000-0000-0000-0000000005b2', 'Been To 051', 'been-to-051', 10, true,  40.7975, -77.8601),
  ('00000000-0000-0000-0000-0000000005b3', 'Punched 051', 'punched-051', 10, true,  40.7968, -77.8612),
  ('00000000-0000-0000-0000-0000000005b4', 'Closed 051',  'closed-051',  10, false, 40.7990, -77.8580),
  ('00000000-0000-0000-0000-0000000005b5', 'Second 051',  'second-051',  10, true,  40.7955, -77.8630),
  ('00000000-0000-0000-0000-0000000005b6', 'Third 051',   'third-051',   10, true,  40.7940, -77.8650);

-- Been To: an ordinary purchase, long enough ago that the 7-day fallback in
-- src/routes/student.js would have forgotten it. The function must not.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at) values
  ('00000000-0000-0000-0000-000000000581', '00000000-0000-0000-0000-0000000005b2', 'earn', 50, 5, now() - interval '60 days');

-- Punched: a regular who has just cashed in a visits-priced reward.
insert into public.punch_cards (user_id, vendor_id, punches) values
  ('00000000-0000-0000-0000-000000000581', '00000000-0000-0000-0000-0000000005b3', 0);
