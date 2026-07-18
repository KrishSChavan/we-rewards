-- ============================================================
-- Migration 021 — error_logs retention.
--   error_logs takes unauthenticated writes (POST /api/client-error, rate-
--   limited) and grows unbounded — unlike earn_codes/redeem_codes/pin_sessions,
--   which self-clean. This adds a prune function and a daily pg_cron job to drop
--   rows older than the retention window (default 90 days).
--
--   The function always installs. The pg_cron scheduling is wrapped so the
--   migration still succeeds if pg_cron isn't enabled on the project — it just
--   raises a NOTICE telling you to enable it (Dashboard → Database → Extensions →
--   pg_cron) and re-run this block, or run prune_error_logs() manually.
-- Run in the Supabase SQL Editor after migration-020 (safe to re-run).
-- ============================================================

-- ---------- prune function ----------
-- SECURITY DEFINER + service_role-only, matching the other server-side RPCs
-- (migration-007). Returns the number of rows removed.
create or replace function public.prune_error_logs(p_days integer default 90)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  n integer;
begin
  delete from error_logs
  where created_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.prune_error_logs(integer) from public, anon, authenticated;
grant  execute on function public.prune_error_logs(integer) to service_role;

-- ---------- daily schedule (best-effort) ----------
do $$
begin
  create extension if not exists pg_cron;
  -- Name-based schedule upserts on modern pg_cron, so re-running is idempotent.
  perform cron.schedule(
    'prune-error-logs',
    '17 4 * * *',                       -- daily at 04:17 UTC, off-peak
    $cron$ select public.prune_error_logs(90); $cron$
  );
  raise notice 'Scheduled daily error_logs prune (job: prune-error-logs).';
exception when others then
  raise notice 'pg_cron not available (%). Enable it (Dashboard → Database → Extensions), then re-run this DO block, or call prune_error_logs() on a schedule yourself.', sqlerrm;
end;
$$;
