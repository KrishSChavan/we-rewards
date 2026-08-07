-- ============================================================
-- Migration 035 — dual-role accounts: profiles.is_vendor + linking support.
--
--   WHY THIS EXISTS
--   One auth.users row can already wear both hats: vendor staff (a vendor_staff
--   link) and student (a consented profiles row). Nothing stored says which
--   profiles belong to vendor operators, so the apps and the operator have no
--   cheap way to answer "is this account a vendor?" without joining
--   vendor_staff. This adds the flag the product asked for:
--
--   1. profiles.is_vendor boolean — true when the account is ALSO vendor staff.
--      DERIVED, never authoritative: requireVendor keeps trusting vendor_staff
--      (multi-vendor resolution, roles, the active kill-switch). The column is
--      for display/filtering, so it must never drift — hence the triggers.
--
--   2. Triggers keep it in sync from both directions:
--        - vendor_staff insert/delete → recompute the flag on that user's
--          profile (covers admin accept, onboard script, vendor delete
--          cascades — cascaded deletes fire row triggers too).
--        - profiles insert → stamp the flag at creation (covers a vendor
--          signing into the student app and consenting, which is what creates
--          their profiles row; accept-terms doesn't know about vendor_staff).
--
--   3. auth_user_id_by_email() — the accept flow (POST /applications/:id/accept)
--      can now LINK an existing account as the vendor login instead of failing
--      with EMAIL_EXISTS, which is what makes "one email, both apps" reachable
--      from the student side. createUser tells us an email is taken but not
--      whose it is; auth.users isn't readable by the API roles, so this definer
--      lookup returns the id (and only the id). Same access rules as
--      email_has_account (migration-022): service_role only.
--
--   Run in the Supabase SQL Editor after migration-034 (safe to re-run).
-- ============================================================

begin;

-- ---------- 1. the column ----------
alter table public.profiles
  add column if not exists is_vendor boolean not null default false;

comment on column public.profiles.is_vendor is
  'True when this account is also vendor staff (has vendor_staff rows). '
  'Derived and trigger-maintained since migration-035; vendor_staff stays the '
  'authoritative membership record.';

-- ---------- 2. backfill ----------
update public.profiles p
   set is_vendor = true
 where is_vendor = false
   and exists (select 1 from public.vendor_staff vs where vs.user_id = p.user_id);

-- ---------- 3. keep it in sync from vendor_staff ----------
-- AFTER INSERT OR DELETE, per row. UPDATE is omitted on purpose: vendor_staff
-- rows are only ever inserted and deleted (the PK is the whole identity and
-- `role` doesn't affect the flag).
create or replace function public.sync_profile_is_vendor()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid := coalesce(new.user_id, old.user_id);
begin
  update public.profiles
     set is_vendor = exists (select 1 from public.vendor_staff where user_id = v_user)
   where user_id = v_user;
  return null; -- AFTER trigger: return value is ignored
end;
$$;

drop trigger if exists vendor_staff_sync_is_vendor on public.vendor_staff;
create trigger vendor_staff_sync_is_vendor
  after insert or delete on public.vendor_staff
  for each row execute function public.sync_profile_is_vendor();

-- ---------- 4. stamp it at profile creation ----------
-- accept-terms creates the profiles row for a vendor who signs into the student
-- app; it upserts only its own columns, so the flag has to come from here.
create or replace function public.stamp_profile_is_vendor()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.is_vendor := exists (select 1 from public.vendor_staff where user_id = new.user_id);
  return new;
end;
$$;

drop trigger if exists profiles_stamp_is_vendor on public.profiles;
create trigger profiles_stamp_is_vendor
  before insert on public.profiles
  for each row execute function public.stamp_profile_is_vendor();

-- ---------- 5. auth user lookup for the accept flow ----------
-- SECURITY DEFINER because auth.users isn't readable by the API roles; returns
-- only the uuid, never the row. service_role only, same as email_has_account:
-- anon/authenticated must not be able to map emails to account ids.
create or replace function public.auth_user_id_by_email(p_email text)
returns uuid
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_id uuid;
begin
  select id into v_id
    from auth.users
   where lower(email) = lower(trim(p_email))
   limit 1;
  return v_id; -- null when no account has this email
end;
$$;

revoke execute on function public.auth_user_id_by_email(text) from public, anon, authenticated;
grant  execute on function public.auth_user_id_by_email(text) to service_role;

-- ---------- 6. sanity check ----------
do $$
declare
  flagged integer;
begin
  select count(*) into flagged from public.profiles where is_vendor;
  raise notice 'Migration 035 applied. % profile(s) are flagged as vendor accounts.', flagged;
end $$;

commit;
