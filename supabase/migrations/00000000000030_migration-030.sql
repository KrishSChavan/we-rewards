-- ============================================================
-- Migration 030 — Drop the retired vendor-level punch card columns.
--   The second half of the visits redesign. migration-029 rewrote every
--   function that read vendors.punch_target / punch_reward and moved the
--   pricing onto rewards.cost_in_visits; this file removes the columns those
--   functions no longer touch.
--
--   ⚠ RUN THIS ONLY AFTER THE APPLICATION CODE IS DEPLOYED.
--   src/routes/student.js names both columns inside the SAME PostgREST query
--   that fetches the whole vendor list, and PostgREST 400s the ENTIRE request
--   on an unknown column — so dropping them while an older build is serving
--   takes down the student home screen wholesale, not just the visits section.
--   The correct order is:
--     1. migration-029          (additive; columns stay)
--     2. deploy the app         (nothing selects the columns any more)
--     3. migration-030          (this file)
--   Section 1 below refuses to run if any function body still names them, but
--   nothing in the DB can detect a stale SERVER, so step 2 is on you.
--
--   Safe to re-run (drop ... if exists).
--
--   ⚠ ON RE-RUNNING migration-028 AFTER 029, which the repo's standing ordering
--   footgun warns about: it now FAILS rather than silently restoring an old
--   function body, because its partial index
--       idx_punch_cards_one_open ... where (completed_at is null)
--   names a column 029 dropped. Good — except it fails at that index, which is
--   AFTER the ALTERs that re-add punch_target / punch_reward. So a re-run can
--   leave the columns back while the functions stay correct. If that happens,
--   just run this file again; section 1 will confirm nothing reads them and
--   section 2 will drop them a second time.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-029 and after the deploy.
-- ============================================================

begin;

-- ---------- 1. Refuse if anything in the DB still reads them ----------
--
-- plpgsql is late-bound and NOT dependency-tracked: `alter table ... drop
-- column` happily succeeds while a function body still references the column,
-- and the breakage only surfaces at runtime, on a scan, in front of a customer.
-- Postgres will not catch this, so check the function sources directly.

do $$
declare
  offenders text;
begin
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    into offenders
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language  l on l.oid = p.prolang
  where n.nspname = 'public'
    and l.lanname in ('plpgsql', 'sql')
    and p.prosrc ~ '\mpunch_(target|reward)\M';

  if offenders is not null then
    raise exception
      'migration-030 aborted: these functions still reference punch_target/punch_reward: %',
      offenders
      using hint = 'Re-run migration-029 first, then this file. Re-running an OLDER '
                   'migration (028) restores a body that reads the dropped columns.';
  end if;
end $$;

-- ---------- 2. Drop ----------

alter table public.vendors drop column if exists punch_target;
alter table public.vendors drop column if exists punch_reward;

commit;

-- ---------- 3. Wake PostgREST ----------
-- Its schema cache still advertises the dropped columns until it is told
-- otherwise, and a request naming one 400s in the meantime.
notify pgrst, 'reload schema';

-- ============================================================
-- POST-RUN CHECKS
--
--   -- the columns are gone:
--   select column_name from information_schema.columns
--   where table_name = 'vendors' and column_name like 'punch%';   -- expect punch_enabled only
--
--   -- and the app still works: load the student home screen. If it renders the
--   -- vendor list, the PostgREST cache picked the change up.
--
-- CLEANING UP THE 029 BACKUP
--   migration-029 left punch_cards_pre_029 holding the pre-collapse image of
--   every punch card. It is the ONLY record of who was owed what before the
--   IOUs were converted into visits. Keep it until you are satisfied the
--   balances are right, then:
--       drop table public.punch_cards_pre_029;
-- ============================================================
