-- ============================================================
-- Migration 023 — sweep abandoned sign-ins.
--   Google OAuth writes auth.users before the consent modal can appear, and
--   Supabase owns that step — it can't be deferred. POST /api/me/decline
--   deletes the row when someone explicitly says no, but a student who closes
--   the tab at the modal leaves an auth.users row with no profile behind it.
--   This prunes those on a schedule so abandoned sign-ins don't accumulate.
--
--   ⚠ READ BEFORE RUNNING — this deletes auth users, so the exclusions matter
--   more than the deletion does:
--     • Vendors sign in with email+password and have vendor_staff rows, NOT
--       profiles. Since migration-022 they have no profile at all, so a naive
--       "no profile = abandoned" rule would delete every vendor account.
--       Excluded by the vendor_staff check.
--     • Admins sign in with Google and also have no profile unless they use the
--       student app. There is no table to detect them by, so they must be listed
--       in p_exempt_emails — SEE STEP 2 BELOW. This is the one thing you have to
--       fill in by hand.
--     • Anyone who ever accepted the terms is excluded outright, belt-and-braces.
--     • Only rows older than the grace window (default 24h) are touched, so a
--       student reading the Terms in another tab is never swept mid-decision.
-- Run in the Supabase SQL Editor after migration-022.
-- ============================================================

-- ---------- 1. the prune function ----------
create or replace function public.prune_unconsented_signups(
  p_grace_hours   integer default 24,
  p_exempt_emails text[] default '{}'
)
returns integer
language plpgsql security definer set search_path = public, auth
as $$
declare
  n integer;
  exempt text[] := array(select lower(trim(e)) from unnest(coalesce(p_exempt_emails, '{}')) e where trim(e) <> '');
begin
  delete from auth.users u
  where u.created_at < now() - make_interval(hours => greatest(p_grace_hours, 1))
    -- Never touch a student who completed the consent flow.
    and not exists (select 1 from public.profiles p where p.user_id = u.id)
    -- Never touch a vendor login.
    and not exists (select 1 from public.vendor_staff vs where vs.user_id = u.id)
    -- Never touch anyone with consent on record, even if their profile is gone.
    and not exists (select 1 from public.terms_acceptances ta where ta.user_id = u.id)
    -- Never touch an explicitly exempted address (operators/admins).
    and lower(coalesce(u.email, '')) <> all (exempt);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.prune_unconsented_signups(integer, text[]) from public, anon, authenticated;
grant  execute on function public.prune_unconsented_signups(integer, text[]) to service_role;

-- ---------- 2. ⚠ PUT YOUR ADMIN EMAILS HERE ----------
-- These must match ADMIN_EMAILS in your .env / Heroku config vars. An admin
-- address missing from this list gets its auth user swept 24h after signing in
-- to /admin. (Access is granted by email, so signing in again restores it — but
-- it churns the account and invalidates the session for no reason.)
--
-- Edit BOTH occurrences below: the dry run and the scheduled job.

-- ---------- 3. dry run — see what WOULD be deleted, before scheduling ----------
-- Run this on its own first and read the output. It deletes nothing.
do $$
declare
  exempt text[] := array['krishschavan@gmail.com'];   -- ⚠ your ADMIN_EMAILS
  doomed integer;
  vendors_protected integer;
begin
  select count(*) into doomed
  from auth.users u
  where u.created_at < now() - interval '24 hours'
    and not exists (select 1 from public.profiles p where p.user_id = u.id)
    and not exists (select 1 from public.vendor_staff vs where vs.user_id = u.id)
    and not exists (select 1 from public.terms_acceptances ta where ta.user_id = u.id)
    and lower(coalesce(u.email, '')) <> all (array(select lower(e) from unnest(exempt) e));

  select count(*) into vendors_protected
  from auth.users u
  where exists (select 1 from public.vendor_staff vs where vs.user_id = u.id);

  raise notice 'DRY RUN — % abandoned sign-in(s) would be removed. % vendor account(s) protected by the vendor_staff exclusion.', doomed, vendors_protected;
  raise notice 'If that vendor count looks wrong, STOP and do not schedule the job.';
end;
$$;

-- ---------- 4. daily schedule ----------
-- Same best-effort pg_cron pattern as migration-021: the function always
-- installs; scheduling degrades to a NOTICE if pg_cron isn't enabled.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule(
    'prune-unconsented-signups',
    '43 4 * * *',                      -- daily at 04:43 UTC, after the error-log prune
    $cron$ select public.prune_unconsented_signups(24, array['krishschavan@gmail.com']); $cron$
  );                                   --                                 ⚠ your ADMIN_EMAILS
  raise notice 'Scheduled daily abandoned sign-in sweep (job: prune-unconsented-signups).';
exception when others then
  raise notice 'pg_cron not available (%). Enable it (Dashboard → Database → Extensions), then re-run this DO block.', sqlerrm;
end;
$$;
