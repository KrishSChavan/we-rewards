-- ============================================================
-- Migration 020 — per-vendor staff-PIN brute-force lockout.
--   The 4-digit staff PIN (10k combos) was only protected by a per-IP rate
--   limit (pinLimiter in server.js). A signed-in staffer could rotate IPs to
--   keep guessing. This adds a lockout that lives on the vendor row, so it's
--   enforced per VENDOR regardless of source IP.
--
--   1. vendors.failed_pin_attempts + vendors.pin_locked_until.
--   2. record_pin_result(vendor, success) — atomic: on failure it bumps the
--      counter and, at the threshold, sets a lock window and resets the counter;
--      on success it clears both. Atomic so concurrent guesses can't race the
--      read-modify-write. Service-role only (called by the server after the
--      bcrypt compare — bcrypt stays in Node).
-- Run in the Supabase SQL Editor after migration-019 (safe to re-run).
-- ============================================================

alter table public.vendors
  add column if not exists failed_pin_attempts integer not null default 0,
  add column if not exists pin_locked_until     timestamptz;

create or replace function public.record_pin_result(
  p_vendor_id    uuid,
  p_success      boolean,
  p_max_attempts integer default 5,
  p_lock_minutes integer default 5
)
returns table (locked_until timestamptz, attempts integer)
language plpgsql security definer set search_path = public
as $$
declare
  v_attempts integer;
  v_locked   timestamptz;
begin
  if p_success then
    update vendors set failed_pin_attempts = 0, pin_locked_until = null
    where id = p_vendor_id;
    return query select null::timestamptz, 0;
    return;
  end if;

  -- Failure: bump the counter atomically. At the threshold, start a lock window
  -- and reset the counter so the next burst starts fresh after the lock ends.
  update vendors
  set failed_pin_attempts = failed_pin_attempts + 1
  where id = p_vendor_id
  returning failed_pin_attempts into v_attempts;

  if v_attempts >= p_max_attempts then
    update vendors
    set pin_locked_until = now() + make_interval(mins => p_lock_minutes),
        failed_pin_attempts = 0
    where id = p_vendor_id
    returning pin_locked_until into v_locked;
  end if;

  return query select v_locked, coalesce(v_attempts, 0);
end;
$$;

-- Server-only, like the other service RPCs (migration-007).
revoke execute on function public.record_pin_result(uuid, boolean, integer, integer) from public, anon, authenticated;
grant  execute on function public.record_pin_result(uuid, boolean, integer, integer) to service_role;
