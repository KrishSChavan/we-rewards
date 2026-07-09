-- ============================================================
-- PSU Eats Rewards — Supabase Schema (MVP: per-vendor points)
-- Run this in the Supabase SQL Editor on a fresh project.
-- ============================================================

-- ---------- TABLES ----------

-- Student profile (1:1 with auth.users, auto-created by trigger below)
create table public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  name       text,
  email      text,
  created_at timestamptz not null default now()
);

create table public.vendors (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  slug              text not null unique,           -- e.g. 'yallah-taco'
  points_per_dollar numeric(6,2) not null default 10,
  -- Tier buttons shown on the terminal. Points are derived at award time:
  -- floor(midpoint(min,max) * points_per_dollar)
  tiers             jsonb not null default '[
    {"label": "Snack",    "min": 1,  "max": 5},
    {"label": "Small",    "min": 5,  "max": 10},
    {"label": "Meal",     "min": 10, "max": 15},
    {"label": "Big order","min": 15, "max": 25}
  ]'::jsonb,
  allow_exact_entry boolean not null default true,
  pin_hash          text,                            -- bcrypt hash, gates redeem mode
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);

-- Links an auth user (the vendor's login) to a vendor row.
-- Lets one owner run multiple locations later.
create table public.vendor_staff (
  vendor_id uuid not null references public.vendors (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  role      text not null default 'owner',
  primary key (vendor_id, user_id)
);

-- Per-vendor balances — keyed on (user, vendor) so a shared/cross-vendor
-- pool later is just a new row type, not a schema migration.
create table public.point_balances (
  user_id    uuid not null references public.profiles (user_id) on delete cascade,
  vendor_id  uuid not null references public.vendors (id) on delete cascade,
  balance    integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, vendor_id)
);

create table public.rewards (
  id             uuid primary key default gen_random_uuid(),
  vendor_id      uuid not null references public.vendors (id) on delete cascade,
  title          text not null,                     -- 'Free drink'
  cost_in_points integer not null check (cost_in_points > 0),
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- Audit log + future analytics product.
create table public.transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (user_id),
  vendor_id     uuid not null references public.vendors (id),
  type          text not null check (type in ('earn', 'redeem')),
  points        integer not null,                   -- positive earn, negative redeem
  dollar_amount numeric(8,2),                       -- exact entry or tier midpoint; null ok
  reward_id     uuid references public.rewards (id),
  created_at    timestamptz not null default now()
);

create index idx_tx_user_vendor_time on public.transactions (user_id, vendor_id, created_at desc);
create index idx_tx_vendor_time      on public.transactions (vendor_id, created_at desc);

-- ---------- AUTO-CREATE PROFILE ON SIGNUP ----------

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (user_id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- RPC: ATOMIC AWARD ----------
-- Called by the server with the service role after verifying the customer's code.

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

-- ---------- RPC: ATOMIC REDEEM ----------
-- Balance check + deduction in one transaction; a double-scan can't double-redeem
-- because the second call fails the balance check (or the token is already used server-side).

create or replace function public.redeem_reward(
  p_user_id   uuid,
  p_vendor_id uuid,
  p_reward_id uuid
)
returns table (new_balance integer, reward_title text)
language plpgsql security definer set search_path = public
as $$
declare
  r_cost  integer;
  r_title text;
begin
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

-- ---------- ROW LEVEL SECURITY ----------
-- The Express server uses the service role key (bypasses RLS) for awards/redeems.
-- RLS protects direct client reads via supabase-js.

alter table public.profiles       enable row level security;
alter table public.vendors        enable row level security;
alter table public.vendor_staff   enable row level security;
alter table public.point_balances enable row level security;
alter table public.rewards        enable row level security;
alter table public.transactions   enable row level security;

-- Students: read/update own profile
create policy "own profile read"   on public.profiles for select using (auth.uid() = user_id);
create policy "own profile update" on public.profiles for update using (auth.uid() = user_id);

-- Anyone signed in can browse active vendors + their rewards (the student app needs this)
create policy "vendors readable" on public.vendors for select using (active = true);
create policy "rewards readable" on public.rewards for select using (active = true);

-- Students: read own balances and own transaction history
create policy "own balances" on public.point_balances for select using (auth.uid() = user_id);
create policy "own transactions" on public.transactions for select using (auth.uid() = user_id);

-- Vendor staff: see own staff links
create policy "own staff links" on public.vendor_staff for select using (auth.uid() = user_id);

-- Vendor staff: see their vendor's transactions (terminal history / analytics)
create policy "vendor sees own transactions" on public.transactions for select using (
  exists (
    select 1 from public.vendor_staff vs
    where vs.vendor_id = transactions.vendor_id and vs.user_id = auth.uid()
  )
);

-- No insert/update/delete policies on balances, transactions, rewards, vendors:
-- all writes go through the server (service role) or the Supabase dashboard for now.
