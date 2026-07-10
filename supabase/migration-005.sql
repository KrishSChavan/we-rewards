-- ============================================================
-- Migration 005 — persist tier scores + lifetime revisit counter.
--   1. profiles.revisits — +1 each time a student comes back to a
--      vendor on a new day after a previous visit (lifetime counter,
--      backfilled from existing transaction history).
--   2. user_scores — snapshot of each student's engagement score so
--      the history-derived score lives in the database, not just in
--      request memory. Upserted by the server on every computation;
--      transactions stays the source of truth.
--   3. award_points now bumps profiles.revisits atomically with the
--      transaction insert.
-- Run in the Supabase SQL Editor (safe to re-run).
-- ============================================================

-- 1. lifetime revisit counter on the student profile
alter table public.profiles
  add column if not exists revisits integer not null default 0;

-- Backfill from existing history: for each user+vendor, every distinct
-- visit-day after the first one counts as one revisit.
with visit_days as (
  select user_id, vendor_id, count(distinct created_at::date) as days
  from public.transactions
  where type = 'earn'
  group by user_id, vendor_id
)
update public.profiles p
set revisits = agg.total
from (
  select user_id, sum(days - 1) as total
  from visit_days
  group by user_id
) agg
where agg.user_id = p.user_id;

-- 2. persisted engagement-score snapshots
create table if not exists public.user_scores (
  user_id          uuid primary key references public.profiles (user_id) on delete cascade,
  score            integer not null default 0,     -- 0–1000
  tier             integer not null default 1,     -- 1 | 2 | 3
  multiplier       integer not null default 1,     -- 1x | 2x | 3x
  breadth          numeric(5,4) not null default 0, -- B component, 0–1
  loyalty          numeric(5,4) not null default 0, -- L component, 0–1
  spend            numeric(5,4) not null default 0, -- S component, 0–1
  distinct_vendors integer not null default 0,
  revisit_vendors  integer not null default 0,     -- vendors revisited within the window
  total_visits     integer not null default 0,     -- capped visit-days in the window
  total_spend      numeric(10,2) not null default 0,
  window_days      integer not null default 30,
  computed_at      timestamptz not null default now()
);

alter table public.user_scores enable row level security;
drop policy if exists "own score" on public.user_scores;
create policy "own score" on public.user_scores for select using (auth.uid() = user_id);
-- no write policies: only the server (service role) writes snapshots

-- 3. award_points: also count a revisit — the first earn of the day at a
--    vendor the student has already visited on an earlier day.
create or replace function public.award_points(
  p_user_id       uuid,
  p_vendor_id     uuid,
  p_points        integer,
  p_dollar_amount numeric default null
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

  -- Revisit check must happen BEFORE this award's transaction is inserted,
  -- so today's earn can't count itself as the "earlier" visit.
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

  insert into transactions (user_id, vendor_id, type, points, dollar_amount)
  values (p_user_id, p_vendor_id, 'earn', p_points, p_dollar_amount);

  return query
    select balance from point_balances
    where user_id = p_user_id and vendor_id = p_vendor_id;
end;
$$;
