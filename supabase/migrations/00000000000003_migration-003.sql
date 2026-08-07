-- ============================================================
-- Migration 003 — replace QR/JWT tokens with short typed codes.
--   Earn:   6-char A–Z0–9 identity code the student shows to earn
--           (always mixes at least one letter and one digit).
--   Redeem: 4-digit 0–9 code the student shows to redeem an item.
-- Both are stored server-side so uniqueness among *live* codes is
-- guaranteed by the primary key. Re-running this file is safe
-- (tables use IF NOT EXISTS; functions use CREATE OR REPLACE).
-- Run in the Supabase SQL Editor.
-- ============================================================

-- ---------- TABLES ----------

create table if not exists public.earn_codes (
  code       text primary key,                       -- 6-char A-Z0-9 (mixed)
  user_id    uuid not null references public.profiles(user_id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_earn_codes_user on public.earn_codes (user_id);

create table if not exists public.redeem_codes (
  code       text primary key,                       -- 4-digit 0-9
  user_id    uuid not null references public.profiles(user_id) on delete cascade,
  vendor_id  uuid not null references public.vendors(id)       on delete cascade,
  reward_id  uuid not null references public.rewards(id)       on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_redeem_codes_user on public.redeem_codes (user_id);

-- Server-only (service role); no policies so clients can't read others' codes.
alter table public.earn_codes   enable row level security;
alter table public.redeem_codes enable row level security;

-- ---------- RPC: CREATE / EXTEND EARN CODE ----------
-- Reuses the student's existing live code (stable across the app's periodic
-- refresh, so a code the vendor is mid-typing stays valid); otherwise mints a
-- new one that is unique across every live earn code.

create or replace function public.create_earn_code(p_user_id uuid, p_ttl_seconds integer default 300)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  chars     text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  candidate text;
  i         integer;
  attempts  integer := 0;
begin
  delete from earn_codes where expires_at < now();          -- housekeeping

  select code into candidate
  from earn_codes
  where user_id = p_user_id and expires_at > now()
  limit 1;
  if candidate is not null then
    update earn_codes
    set expires_at = now() + make_interval(secs => p_ttl_seconds)
    where code = candidate;
    return candidate;
  end if;

  loop
    attempts := attempts + 1;
    candidate := '';
    for i in 1..6 loop
      candidate := candidate || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    end loop;
    -- Guarantee the code mixes letters and digits (no all-letter codes).
    if candidate !~ '[A-Z]' or candidate !~ '[0-9]' then
      if attempts > 50 then raise exception 'CODE_SPACE_EXHAUSTED'; end if;
      continue;
    end if;
    begin
      insert into earn_codes (code, user_id, expires_at)
      values (candidate, p_user_id, now() + make_interval(secs => p_ttl_seconds));
      return candidate;
    exception when unique_violation then
      if attempts > 50 then raise exception 'CODE_SPACE_EXHAUSTED'; end if;
    end;
  end loop;
end;
$$;

-- ---------- RPC: CREATE REDEEM CODE ----------
-- One live code per student (the previous one is dropped) so the small 4-digit
-- space stays clear; unique across every live redeem code.

create or replace function public.create_redeem_code(
  p_user_id uuid, p_vendor_id uuid, p_reward_id uuid, p_ttl_seconds integer default 120
) returns text
language plpgsql security definer set search_path = public
as $$
declare
  candidate text;
  attempts  integer := 0;
begin
  delete from redeem_codes where expires_at < now();        -- housekeeping
  delete from redeem_codes where user_id = p_user_id;       -- one live code per student

  loop
    attempts := attempts + 1;
    candidate := lpad((floor(random() * 10000))::int::text, 4, '0');
    begin
      insert into redeem_codes (code, user_id, vendor_id, reward_id, expires_at)
      values (candidate, p_user_id, p_vendor_id, p_reward_id, now() + make_interval(secs => p_ttl_seconds));
      return candidate;
    exception when unique_violation then
      if attempts > 500 then raise exception 'CODE_SPACE_EXHAUSTED'; end if;
    end;
  end loop;
end;
$$;

-- ---------- RPC: REDEEM BY CODE ----------
-- DELETE ... RETURNING atomically consumes the code (single-use: a double-submit
-- finds no row the second time). Any failure raises and rolls back the whole
-- transaction — including the delete — so the code stays live and reusable.

create or replace function public.redeem_by_code(p_code text, p_vendor_id uuid)
returns table (new_balance integer, reward_title text)
language plpgsql security definer set search_path = public
as $$
declare
  c_user_id   uuid;
  c_reward_id uuid;
  r_cost      integer;
  r_title     text;
begin
  delete from redeem_codes
  where code = p_code and vendor_id = p_vendor_id and expires_at > now()
  returning user_id, reward_id into c_user_id, c_reward_id;

  if c_user_id is null then
    raise exception 'CODE_INVALID';
  end if;

  select cost_in_points, title into r_cost, r_title
  from rewards
  where id = c_reward_id and vendor_id = p_vendor_id and active = true;

  if r_cost is null then
    raise exception 'REWARD_NOT_FOUND';
  end if;

  update point_balances
  set balance = balance - r_cost, updated_at = now()
  where user_id = c_user_id and vendor_id = p_vendor_id and balance >= r_cost;

  if not found then
    raise exception 'INSUFFICIENT_POINTS';
  end if;

  insert into transactions (user_id, vendor_id, type, points, reward_id)
  values (c_user_id, p_vendor_id, 'redeem', -r_cost, c_reward_id);

  return query
    select pb.balance, r_title
    from point_balances pb
    where pb.user_id = c_user_id and pb.vendor_id = p_vendor_id;
end;
$$;
