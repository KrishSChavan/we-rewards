-- migration-054 — keep the operator's terminal account out of the nightly sweep
--
-- Setting TERMINAL_ADMIN_EMAIL / TERMINAL_ADMIN_PASSWORD provisions a Supabase
-- account at boot (src/lib/terminal-admin.js) that can open any vendor's till at
-- /terminal. That account is deliberately shaped like nothing else in the app:
-- it is not a student, so it has no `profiles` row and no `terms_acceptances`
-- row, and it staffs no vendor, so it has no `vendor_staff` row.
--
-- Which is, exactly, the shape prune_unconsented_signups deletes. Left alone,
-- the operator login would be created at every boot and swept at 04:43 UTC the
-- following night — sign-in working on the day you set it up and failing the
-- next morning, with nothing in the app to explain why.
--
-- Fixed by teaching the sweep one more "never touch": an account carrying
-- app_metadata.wr_terminal_admin = true. Matched on the FLAG rather than on the
-- address, so nothing here has to be kept in step with a config var, the
-- credential can be rotated or re-pointed freely, and a deployment that never
-- sets those vars is completely unaffected (no account carries the flag, and
-- the added condition is true for every row).
--
-- Verbatim the migration-025 §3d body plus that one condition. The pg_cron job
-- from migration-023 calls this by name and needs no rescheduling; the existing
-- p_exempt_emails argument is untouched and still holds the /admin addresses.

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
  -- Announce a legitimate points write to the migration-025 guard triggers
  -- (cascades from auth.users can reach point_balances / transactions).
  perform set_config('app.points_write', 'server', true);

  delete from auth.users u
  where u.created_at < now() - make_interval(hours => greatest(p_grace_hours, 1))
    -- Never touch a student who completed the consent flow.
    and not exists (select 1 from public.profiles p where p.user_id = u.id)
    -- Never touch a vendor login.
    and not exists (select 1 from public.vendor_staff vs where vs.user_id = u.id)
    -- Never touch anyone with consent on record, even if their profile is gone.
    and not exists (select 1 from public.terms_acceptances ta where ta.user_id = u.id)
    -- Never touch an explicitly exempted address (operators/admins).
    and lower(coalesce(u.email, '')) <> all (exempt)
    -- Never touch the operator's terminal account (migration-054). The flag is
    -- stamped by ensureTerminalAdmin in src/lib/terminal-admin.js; ADMIN_FLAG
    -- there and this string are one name and must be changed together.
    and coalesce(u.raw_app_meta_data ->> 'wr_terminal_admin', '') <> 'true';
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.prune_unconsented_signups(integer, text[]) from public, anon, authenticated;
grant  execute on function public.prune_unconsented_signups(integer, text[]) to service_role;
