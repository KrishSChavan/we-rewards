-- ============================================================
-- Migration 019 — award idempotency (stop double-awards on retry).
--   The award path had no idempotency key: if the network dropped AFTER
--   award_points committed but before the terminal got the response, a retry
--   re-ran the award and added the points twice. Redeem is naturally single-use
--   (the code is consumed); award was not.
--
--   1. transactions.client_token + a partial unique index on
--      (vendor_id, client_token) — one award per token, per vendor.
--   2. award_points gains p_client_token (default null). A call whose token was
--      already recorded returns the CURRENT balance and does nothing else — no
--      second transaction, no second balance bump, no second revisit. The unique
--      index is the hard backstop even under a concurrent double-submit (the
--      loser's whole atomic call aborts, so points can never double).
--
--   Preserves everything migration-005 put in award_points (the atomic
--   profiles.revisits bump). Replaces the 4-arg award_points with a 5-arg
--   version and re-applies the migration-007 EXECUTE lockdown to the new
--   signature. Run in the Supabase SQL Editor after migration-018 (safe to re-run).
-- ============================================================

-- ---------- 1. client_token column + partial unique index ----------
alter table public.transactions
  add column if not exists client_token text;

-- One award per (vendor, client_token). Partial so the countless tokenless rows
-- (legacy awards, redeems, reversals) are all exempt and never collide.
create unique index if not exists uq_tx_client_token
  on public.transactions (vendor_id, client_token)
  where client_token is not null;

-- ---------- 2. idempotent award_points ----------
-- Drop the old 4-arg overload so a un-locked-down copy can't linger alongside
-- the new 5-arg function (Postgres treats different arg lists as separate funcs).
drop function if exists public.award_points(uuid, uuid, integer, numeric);

create or replace function public.award_points(
  p_user_id       uuid,
  p_vendor_id     uuid,
  p_points        integer,
  p_dollar_amount numeric default null,
  p_client_token  text default null
)
returns table (new_balance integer)
language plpgsql security definer set search_path = public
as $$
declare
  visited_before boolean;
  visited_today  boolean;
begin
  if p_points <= 0 then
    raise exception 'POINTS_INVALID';
  end if;

  -- Idempotency: a retry of an already-recorded award (same token, same vendor)
  -- returns the current balance and stops here — BEFORE any side effect
  -- (revisit bump / balance / transaction insert), so nothing is applied twice.
  if p_client_token is not null then
    if exists (
      select 1 from transactions
      where vendor_id = p_vendor_id and client_token = p_client_token
    ) then
      return query
        select coalesce((select balance from point_balances
                         where user_id = p_user_id and vendor_id = p_vendor_id), 0);
      return;
    end if;
  end if;

  -- Revisit check must happen BEFORE this award's transaction is inserted,
  -- so today's earn can't count itself as the "earlier" visit. (migration-005)
  select
    exists (select 1 from transactions t
            where t.user_id = p_user_id and t.vendor_id = p_vendor_id
              and t.type = 'earn' and t.created_at::date < current_date),
    exists (select 1 from transactions t
            where t.user_id = p_user_id and t.vendor_id = p_vendor_id
              and t.type = 'earn' and t.created_at::date = current_date)
  into visited_before, visited_today;

  if visited_before and not visited_today then
    update profiles set revisits = revisits + 1 where user_id = p_user_id;
  end if;

  insert into point_balances (user_id, vendor_id, balance)
  values (p_user_id, p_vendor_id, p_points)
  on conflict (user_id, vendor_id)
  do update set balance = point_balances.balance + p_points, updated_at = now();

  -- The unique index on (vendor_id, client_token) is the hard backstop: a
  -- concurrent duplicate that slips past the exists() check raises here and the
  -- whole atomic call rolls back, so the balance bump above never sticks twice.
  insert into transactions (user_id, vendor_id, type, points, dollar_amount, client_token)
  values (p_user_id, p_vendor_id, 'earn', p_points, p_dollar_amount, p_client_token);

  return query
    select balance from point_balances
    where user_id = p_user_id and vendor_id = p_vendor_id;
end;
$$;

-- Re-apply the migration-007 lockdown to the NEW signature: only the server's
-- service_role may execute it; no client-reachable role can.
revoke execute on function public.award_points(uuid, uuid, integer, numeric, text) from public, anon, authenticated;
grant  execute on function public.award_points(uuid, uuid, integer, numeric, text) to service_role;
