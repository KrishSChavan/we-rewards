-- ============================================================
-- Migration 004 — remove the 15-minute earn rate limit.
-- Vendors can now award points to a customer as often as they like.
-- Run in the Supabase SQL Editor (CREATE OR REPLACE, safe to re-run).
-- ============================================================

create or replace function public.award_points(
  p_user_id       uuid,
  p_vendor_id     uuid,
  p_points        integer,
  p_dollar_amount numeric default null
)
returns table (new_balance integer)
language plpgsql security definer set search_path = public
as $$
begin
  if p_points <= 0 then
    raise exception 'POINTS_INVALID';
  end if;

  insert into point_balances (user_id, vendor_id, balance)
  values (p_user_id, p_vendor_id, p_points)
  on conflict (user_id, vendor_id)
  do update set balance = point_balances.balance + p_points, updated_at = now();

  insert into transactions (user_id, vendor_id, type, points, dollar_amount)
  values (p_user_id, p_vendor_id, 'earn', p_points, p_dollar_amount);

  return query
    select balance from point_balances
    where user_id = p_user_id and vendor_id = p_vendor_id;
end;
$$;
