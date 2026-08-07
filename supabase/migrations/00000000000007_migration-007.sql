-- ============================================================
-- Migration 007 — security hardening.
--   1. Lock down the service-only RPCs so ONLY the server (service_role)
--      can call them. Without this, PostgREST exposes them to any signed-in
--      user, who could call award_points() from the browser and mint points.
--   2. Drop the dead single-use-token flow (redeem_reward + used_redemption_tokens),
--      replaced by redeem_by_code back in migration-003.
--   3. Add vendor_pin_sessions so the staff PIN is enforced SERVER-side, not
--      just in the terminal UI.
-- Run in the Supabase SQL Editor after migration-006 (safe to re-run).
-- ============================================================

-- ---------- 1. RPC EXECUTE LOCKDOWN ----------
-- These are SECURITY DEFINER functions the Express server calls with the
-- service role. Revoke from every client-reachable role; after a blanket
-- revoke, service_role needs the grant back explicitly to keep working.

revoke execute on function public.award_points(uuid, uuid, integer, numeric) from public, anon, authenticated;
grant  execute on function public.award_points(uuid, uuid, integer, numeric) to service_role;

revoke execute on function public.create_earn_code(uuid, integer) from public, anon, authenticated;
grant  execute on function public.create_earn_code(uuid, integer) to service_role;

revoke execute on function public.create_redeem_code(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant  execute on function public.create_redeem_code(uuid, uuid, uuid, integer) to service_role;

revoke execute on function public.redeem_by_code(text, uuid) from public, anon, authenticated;
grant  execute on function public.redeem_by_code(text, uuid) to service_role;

-- ---------- 2. DROP THE DEAD SINGLE-USE-TOKEN FLOW ----------
-- redeem_by_code (migration-003) superseded these; they were still present and
-- publicly executable. Drop both redeem_reward signatures + the token table.

drop function if exists public.redeem_reward(uuid, uuid, uuid, uuid);
drop function if exists public.redeem_reward(uuid, uuid, uuid);
drop table    if exists public.used_redemption_tokens;

-- ---------- 3. SERVER-SIDE STAFF PIN SESSIONS ----------
-- The terminal's PIN gate lived only in browser memory, so redeem/manage API
-- routes were unprotected. verify-pin now mints a session token here; the
-- server checks it on the sensitive routes (see requirePin middleware).
-- Server-only (service role); no policies so clients can't read/forge tokens.

create table if not exists public.vendor_pin_sessions (
  token      uuid primary key,
  vendor_id  uuid not null references public.vendors(id)  on delete cascade,
  user_id    uuid not null references auth.users(id)      on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_pin_sessions_vendor on public.vendor_pin_sessions (vendor_id);

alter table public.vendor_pin_sessions enable row level security;
-- no policies: only the server (service role) reads/writes PIN sessions
