-- Pre-migration world for migration-055 (plans + subscription state).
--
-- The only thing 055 does to existing data is the one-shot grandfather
-- backfill, so what the seed has to provide is a roster that predates it —
-- some of it switched off, so the assertion that "off is not the same as gone"
-- has something to stand on.
--
--   V1  an ordinary live vendor. Becomes goto + grandfathered.
--   V2  a second live vendor, so "all of them" can be shown to mean all.
--   V3  SWITCHED OFF. A vendor the operator has disabled is still a vendor who
--       was here before the price existed, and disabling one is not a deletion
--       (src/routes/admin.js keeps its transactions in platform history for the
--       same reason). If the backfill filtered on `active` this row would come
--       back one day on the free tier having never been told, which is the
--       exact "silently downgraded" outcome the flag exists to prevent.
--   V4  created_at deliberately far in the past, so plan_since's
--       coalesce(created_at, now()) can be shown to preserve a real signup date
--       rather than stamping today over the whole roster. The 12-month rate
--       lock reads that column.
--
-- No transactions, no students: nothing in 055 reads either.

insert into public.vendors (id, name, slug, points_per_dollar, active, created_at) values
  ('00000000-0000-0000-0000-000000000551', 'Fava Kitchen',   'fava-kitchen-055',   10, true,  now() - interval '200 days'),
  ('00000000-0000-0000-0000-000000000552', 'Yallah Taco',    'yallah-taco-055',    12, true,  now() - interval '90 days'),
  ('00000000-0000-0000-0000-000000000553', 'Closed For Now', 'closed-for-now-055', 10, false, now() - interval '150 days'),
  ('00000000-0000-0000-0000-000000000554', 'Webster''s',     'websters-055',       8,  true,  timestamptz '2026-01-15 12:00:00+00');
