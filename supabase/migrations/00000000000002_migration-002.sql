-- ============================================================
-- Migration 002 — reward emojis + database-backed single-use
-- redemption tokens. Run in the Supabase SQL Editor.
-- ============================================================

-- 1. Vendors pick an emoji per reward item
alter table public.rewards
  add column if not exists emoji text not null default '🎁';

-- 2. Single-use tracking for redemption QR codes.
--    Previously in server memory (lost on restart); now the DB is the
--    authority, and marking a token used is atomic with the deduction.
create table if not exists public.used_redemption_tokens (
  jti     uuid primary key,
  used_at timestamptz not null default now()
);
alter table public.used_redemption_tokens enable row level security;
-- no policies: only the server (service role) touches this table

-- 3. Replace redeem_reward: consume the token + check balance + deduct,
--    all in one transaction. A screenshot replay hits TOKEN_USED; a
--    double-scan race loses the unique-jti insert and fails cleanly.
drop function if exists public.redeem_reward(uuid, uuid, uuid);

create or replace function public.redeem_reward(
  p_user_id   uuid,
  p_vendor_id uuid,
  p_reward_id uuid,
  p_jti       uuid default null
)
returns table (new_balance integer, reward_title text)
language plpgsql security definer set search_path = public
as $$
declare
  r_cost  integer;
  r_title text;
begin
  if p_jti is not null then
    begin
      insert into used_redemption_tokens (jti) values (p_jti);
    exception when unique_violation then
      raise exception 'TOKEN_USED';
    end;
    -- housekeeping: tokens expire in 2 minutes, so anything older is garbage
    delete from used_redemption_tokens where used_at < now() - interval '1 day';
  end if;

  select cost_in_points, title into r_cost, r_title
  from rewards
  where id = p_reward_id and vendor_id = p_vendor_id and active = true;

  if r_cost is null then
    raise exception 'REWARD_NOT_FOUND';
  end if;

  update point_balances
  set balance = balance - r_cost, updated_at = now()
  where user_id = p_user_id
    and vendor_id = p_vendor_id
    and balance >= r_cost;

  if not found then
    raise exception 'INSUFFICIENT_POINTS';
  end if;

  insert into transactions (user_id, vendor_id, type, points, reward_id)
  values (p_user_id, p_vendor_id, 'redeem', -r_cost, p_reward_id);

  return query
    select pb.balance, r_title
    from point_balances pb
    where pb.user_id = p_user_id and pb.vendor_id = p_vendor_id;
end;
$$;
