-- ============================================================
-- Migration 031 — Vendor password recovery, without email.
--   Vendors sign in with email + password (migration-022/023: they have
--   vendor_staff rows, not profiles). There is no SMTP anywhere in this stack,
--   so Supabase's own recovery email is not an option and a locked-out vendor
--   currently has no path back in at all.
--
--   The recovery channel is YOU. The operator mints a one-time code from /admin
--   and reads it to the vendor over the phone; the vendor types it into the
--   terminal's "Forgot password" form and picks a new password. Every vendor was
--   onboarded by hand through POST /api/admin/applications/:id/accept, so
--   "the operator recognises them" is a real trust anchor, not a shortcut.
--
--   The code is stored ONLY as a bcrypt hash — same treatment as vendors.pin_hash
--   and vendor_applications.password_hash. It is displayed once, at mint time,
--   and cannot be recovered afterwards; losing it means minting another.
--
--   WHY THE RPCs BELOW EXIST (rather than doing this from Node with PostgREST):
--   the guess counter has to be atomic. Reading the row, bcrypt-comparing in
--   Node, then writing attempts back is a read-modify-write — parallel requests
--   would all read attempts=0 and blow straight through the cap. Each function
--   here does its state change in ONE statement, so N concurrent guesses
--   increment N times. Same reasoning as record_pin_result in migration-019.
--
--   Safe to re-run (create ... if not exists / create or replace).
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run.
-- ============================================================

begin;

-- ---------- 1. the table ----------
--
-- One row per issued code. Rows are kept after use so the operator can see that
-- a reset happened (and section 6 prunes them on a schedule).
--
-- `email` is denormalised from auth.users at mint time on purpose: the recover
-- endpoint is unauthenticated and must find the pending code from the typed
-- email alone, without being able to read auth.users. It also freezes WHICH
-- address the code was issued for, so changing the login email later can't
-- silently retarget a code that is already in flight.
create table if not exists public.vendor_password_resets (
  id         uuid primary key default gen_random_uuid(),
  vendor_id  uuid not null references public.vendors(id)  on delete cascade,
  user_id    uuid not null references auth.users(id)      on delete cascade,
  email      text not null,
  code_hash  text not null,
  attempts   integer not null default 0,
  expires_at timestamptz not null,
  used_at    timestamptz,               -- set on success, on burn, or on supersede
  created_by text,                       -- admin email that minted it, for the audit trail
  created_at timestamptz not null default now()
);

-- The recover path's only lookup: live codes for one address. Partial on
-- used_at is null so the index stays small as spent rows accumulate.
create index if not exists idx_vendor_resets_live
  on public.vendor_password_resets (email, created_at desc)
  where used_at is null;

create index if not exists idx_vendor_resets_user
  on public.vendor_password_resets (user_id);

-- Deny-all: no policies are defined, so anon/authenticated can read nothing even
-- with a valid JWT. Only the service role (which bypasses RLS) touches this
-- table, and it only ever reaches it through the functions below.
alter table public.vendor_password_resets enable row level security;

-- ---------- 2. issue a code ----------
--
-- Node bcrypts the plaintext and passes the hash; this validates the staff link,
-- resolves the login email, and supersedes any code already outstanding for that
-- login so at most ONE is live at a time. (Two live codes would mean a stale one
-- read out yesterday still works today.)
create or replace function public.vendor_reset_issue(
  p_vendor_id   uuid,
  p_user_id     uuid,
  p_code_hash   text,
  p_ttl_minutes integer default 30,
  p_created_by  text default null
)
returns table (reset_id uuid, reset_email text, reset_expires_at timestamptz)
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_email   text;
  v_expires timestamptz;
begin
  -- The caller is already admin-gated, but bind the code to a real staff link
  -- anyway: this is the function that can hand out a password reset, so it
  -- should not be possible to aim one at an arbitrary auth user.
  if not exists (
    select 1 from public.vendor_staff vs
    where vs.vendor_id = p_vendor_id and vs.user_id = p_user_id
  ) then
    raise exception 'NOT_VENDOR_STAFF'
      using hint = 'That login is not staff of that vendor.';
  end if;

  select u.email into v_email from auth.users u where u.id = p_user_id;
  if v_email is null then
    raise exception 'NO_LOGIN_EMAIL'
      using hint = 'That auth user has no email address.';
  end if;

  v_expires := now() + make_interval(mins => greatest(coalesce(p_ttl_minutes, 30), 1));

  -- Supersede anything still outstanding for this login.
  update public.vendor_password_resets
     set used_at = now()
   where user_id = p_user_id
     and used_at is null;

  return query
  insert into public.vendor_password_resets
    (vendor_id, user_id, email, code_hash, expires_at, created_by)
  values
    (p_vendor_id, p_user_id, lower(trim(v_email)), p_code_hash, v_expires, p_created_by)
  returning id, email, expires_at;
end;
$$;

-- ---------- 3. begin a guess ----------
--
-- Atomically claims the newest live code for an address and charges it one
-- attempt. Returns the hash for Node to compare while the attempt is already on
-- record — so a crash, a timeout, or ten parallel requests can never yield a
-- free guess.
--
-- One attempt PAST the cap consumes the code outright (used_at set, hash
-- withheld). Charging the burn on attempt cap+1 rather than cap is deliberate:
-- burning at cap would kill a code on its last allowed try even when that try is
-- CORRECT — a vendor who fat-fingers four times and then reads it right would be
-- refused. Attempts 1..cap all get a real comparison.
--
-- Returns zero rows when there is no live code for that address, which the
-- caller must render identically to a wrong code (no account enumeration).
create or replace function public.vendor_reset_begin(
  p_email        text,
  p_max_attempts integer default 5
)
returns table (
  reset_id        uuid,
  reset_user_id   uuid,
  reset_vendor_id uuid,
  reset_code_hash text,
  reset_burned    boolean
)
language sql security definer set search_path = public, auth
as $$
  with target as (
    select r.id
      from public.vendor_password_resets r
     where r.email = lower(trim(p_email))
       and r.used_at is null
       and r.expires_at > now()
     order by r.created_at desc
     limit 1
  ),
  bumped as (
    update public.vendor_password_resets r
       set attempts = r.attempts + 1,
           used_at  = case
                        when r.attempts + 1 > greatest(coalesce(p_max_attempts, 5), 1)
                        then now() else r.used_at
                      end
     where r.id = (select id from target)
    returning r.id, r.user_id, r.vendor_id, r.code_hash, r.attempts
  )
  select b.id,
         b.user_id,
         b.vendor_id,
         case when b.attempts > greatest(coalesce(p_max_attempts, 5), 1)
              then null else b.code_hash end,
         b.attempts > greatest(coalesce(p_max_attempts, 5), 1)
    from bumped b;
$$;

-- ---------- 4. spend a code ----------
--
-- Called only after Node has verified the hash. Conditional on used_at still
-- being null, so two requests that both compared the same correct code race here
-- and exactly one wins — the loser gets false and resets nothing.
create or replace function public.vendor_reset_consume(p_id uuid)
returns boolean
language plpgsql security definer set search_path = public, auth
as $$
declare
  claimed uuid;
begin
  update public.vendor_password_resets
     set used_at = now()
   where id = p_id
     and used_at is null
  returning id into claimed;
  return claimed is not null;
end;
$$;

-- ---------- 5. staff emails for the admin roster ----------
--
-- GET /api/admin/vendors renders one row per vendor, but a reset targets a
-- LOGIN, and a vendor can have several (multi-location owners — see requireVendor
-- in src/middleware/auth.js). The dashboard needs the addresses to say which one
-- it is resetting. auth.users isn't readable by the API roles, hence definer.
--
-- Returns emails only for the vendor ids asked for, and is service_role-only, so
-- it can't be used to enumerate accounts.
create or replace function public.vendor_staff_emails(p_vendor_ids uuid[])
returns table (vendor_id uuid, user_id uuid, email text, role text)
language sql security definer set search_path = public, auth
as $$
  select vs.vendor_id, vs.user_id, u.email::text, vs.role
    from public.vendor_staff vs
    join auth.users u on u.id = vs.user_id
   where vs.vendor_id = any(coalesce(p_vendor_ids, '{}'::uuid[]))
   order by vs.vendor_id, vs.role, u.email;
$$;

-- ---------- 6. housekeeping ----------
--
-- Spent and expired codes have no further use; keep a short tail so a reset that
-- just happened is still visible in the table, then drop them.
create or replace function public.prune_vendor_password_resets(p_keep_days integer default 30)
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  delete from public.vendor_password_resets
   where created_at < now() - make_interval(days => greatest(coalesce(p_keep_days, 30), 1));
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------- 7. grants ----------
-- Every one of these is SECURITY DEFINER over auth.users and/or hands out
-- password-reset capability. None is callable by anon or authenticated.
revoke execute on function public.vendor_reset_issue(uuid, uuid, text, integer, text) from public, anon, authenticated;
revoke execute on function public.vendor_reset_begin(text, integer)                   from public, anon, authenticated;
revoke execute on function public.vendor_reset_consume(uuid)                          from public, anon, authenticated;
revoke execute on function public.vendor_staff_emails(uuid[])                         from public, anon, authenticated;
revoke execute on function public.prune_vendor_password_resets(integer)               from public, anon, authenticated;

grant execute on function public.vendor_reset_issue(uuid, uuid, text, integer, text) to service_role;
grant execute on function public.vendor_reset_begin(text, integer)                   to service_role;
grant execute on function public.vendor_reset_consume(uuid)                          to service_role;
grant execute on function public.vendor_staff_emails(uuid[])                         to service_role;
grant execute on function public.prune_vendor_password_resets(integer)               to service_role;

commit;

-- ---------- 8. daily prune ----------
-- Same best-effort pg_cron pattern as migration-021/023: the function always
-- installs; scheduling degrades to a NOTICE if pg_cron isn't enabled.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule(
    'prune-vendor-password-resets',
    '51 4 * * *',                     -- daily at 04:51 UTC, after the other two prunes
    $cron$ select public.prune_vendor_password_resets(30); $cron$
  );
  raise notice 'Scheduled daily vendor password-reset prune (job: prune-vendor-password-resets).';
exception when others then
  raise notice 'pg_cron not available (%). Enable it (Dashboard -> Database -> Extensions), then re-run this DO block.', sqlerrm;
end;
$$;

-- ---------- 9. wake PostgREST ----------
-- The new table and functions stay invisible to the API until the schema cache
-- reloads, and an RPC call naming one 404s in the meantime.
notify pgrst, 'reload schema';

-- ============================================================
-- POST-RUN CHECKS
--
--   -- the table exists and is locked down (expect rowsecurity = true, 0 policies):
--   select relrowsecurity from pg_class where relname = 'vendor_password_resets';
--   select count(*) from pg_policies where tablename = 'vendor_password_resets';
--
--   -- the functions are service_role-only (expect no anon/authenticated grants):
--   select p.proname, p.proacl from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname like 'vendor_reset%';
--
--   -- end to end: in /admin, hit "Reset password" on any vendor, then use the
--   -- code at /terminal -> "Forgot password?". Afterwards the row should show a
--   -- used_at and attempts = 1:
--   select email, attempts, used_at, expires_at, created_by
--   from public.vendor_password_resets order by created_at desc limit 5;
-- ============================================================
