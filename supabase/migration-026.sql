-- ============================================================
-- Migration 026 — Community points: storage + minting.
--   Steps 1 and 2 of community-points.md. Adds the cross-vendor pool and makes
--   every earn mint 10% of the awarded points into it, on top of (never out of)
--   the vendor's own balance.
--
--   WHAT THIS FILE DOES
--   1. community_balances — one row per student, NOT keyed to a vendor. That is
--      the whole idea: it is the only balance in the system a vendor doesn't own.
--   2. transactions.community_points — the 10% minted by a given earn, recorded
--      on the earn's OWN row. This is load-bearing, not a convenience: it makes
--      the mint inherit client_token idempotency and reverse_transaction's
--      unwind for free, and keeps the ledger reconstructible. A second table
--      would mean re-implementing both.
--   3. The migration-025 guard triggers, extended to community_balances. It is a
--      money table too, and 025's whole point is that money tables are not
--      editable from the Studio table editor.
--   4. award_points — mints the 10%, with a daily cap and an inactive-vendor
--      rule baked in from the start.
--   5. reverse_transaction — unwinds the mint when an earn is voided.
--
--   LEDGER INVARIANTS (assert these in tests, they are the whole contract)
--     • sum(community_points) over a student's 'earn' rows = lifetime_earned
--     • sum(community_points) over ALL their rows          = balance
--       (a transfer, migration-027, writes a negative into the same column)
--   Both hold except where a reversal clamps at 0 — see the note on the clamp
--   below. That is the same trade the vendor balance has made since 010.
--
--   ⚠ WHY award_points IS DROPPED AND RECREATED, NOT REPLACED
--   Its return type grows a second column (new_community), and Postgres refuses
--   to change a function's return type via create-or-replace. The drop means the
--   EXECUTE grants go with it, so they are re-applied below. Migration-019 did
--   the same dance when it added p_client_token. If you edit this function again
--   later and forget the grants, every award fails with a permission error.
--
--   ⚠ ORDERING FOOTGUN (inherited from 025, and now worse)
--   award_points and reverse_transaction are recreated here. Re-running
--   schema.sql or migrations 004/005/010/019/025 afterwards restores an OLDER
--   body — one that either lacks the app.points_write guard flag (awards start
--   failing outright) or silently stops minting community points (much quieter,
--   much worse). If you re-run any of those, re-run THIS file afterwards.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-025. Safe to re-run.
-- ============================================================

-- ---------- 1. STORAGE ----------

-- The pool. user_id is the primary key — one row per student, no vendor column.
-- ON DELETE CASCADE matches point_balances so account deletion can't orphan a
-- balance (and so the 025 depth-escape carries the cascade through the guard).
create table if not exists public.community_balances (
  user_id         uuid primary key references public.profiles (user_id) on delete cascade,
  balance         integer not null default 0 check (balance >= 0),
  lifetime_earned integer not null default 0 check (lifetime_earned >= 0),
  updated_at      timestamptz not null default now()
);

comment on table public.community_balances is
  'Cross-vendor points pool, one row per student. Written only by award_points '
  '(mint), reverse_transaction (unwind) and transfer_community_points '
  '(migration-027). See community-points.md.';

-- lifetime_earned counts MINTING only. A transfer out (027) decrements balance
-- and leaves this alone; a voided earn decrements both. It answers "how much has
-- this student been given", which a spend shouldn't change and an undo should.
comment on column public.community_balances.lifetime_earned is
  'Gross community points ever minted for this student, net of reversals. '
  'Transfers out do NOT decrement it.';

-- The 10% minted by this transaction. Positive on an earn, negative on the
-- compensating row of a reversal, and negative on a transfer (027).
alter table public.transactions
  add column if not exists community_points integer not null default 0;

comment on column public.transactions.community_points is
  'Community points minted (+) or moved (-) by this row. sum() over all of a '
  'user''s rows = community_balances.balance.';

-- ---------- 2. THE 025 GUARD, EXTENDED ----------
-- Same trigger function, same reasoning: no direct DML from the table editor,
-- a leaked service-role key, or a pasted snippet. Only the RPCs (which set the
-- transaction-local app.points_write GUC) may write this table.

drop trigger if exists trg_points_guard_row on public.community_balances;
create trigger trg_points_guard_row
  before insert or update or delete on public.community_balances
  for each row execute function public.enforce_points_write_guard();

drop trigger if exists trg_points_guard_truncate on public.community_balances;
create trigger trg_points_guard_truncate
  before truncate on public.community_balances
  for each statement execute function public.enforce_points_write_guard();

-- ---------- 3. RLS + GRANTS ----------

alter table public.community_balances enable row level security;

-- Mirrors "own balances" on point_balances (schema.sql:195).
drop policy if exists "own community balance" on public.community_balances;
create policy "own community balance" on public.community_balances
  for select using (auth.uid() = user_id);

-- Belt-and-braces, same as 025: even a service-role key cannot write this table
-- through PostgREST. The RPCs are SECURITY DEFINER and run as the owner, so they
-- are unaffected. SELECT stays — the server reads the balance directly in
-- GET /api/me/community, and students read their own row through the policy.
grant  select                   on public.community_balances to anon, authenticated, service_role;
revoke insert, update, delete   on public.community_balances from anon, authenticated, service_role;

-- ---------- 4. award_points — 025 body + the 10% mint ----------
-- Verbatim from migration-025 (which was verbatim from 019) except for the
-- community block and the second return column. Everything load-bearing is
-- preserved: the guard flag first, the client_token early return BEFORE any
-- side effect, and the revisit bump BEFORE this award's own row is inserted.

drop function if exists public.award_points(uuid, uuid, integer, numeric, text);

create or replace function public.award_points(
  p_user_id       uuid,
  p_vendor_id     uuid,
  p_points        integer,
  p_dollar_amount numeric default null,
  p_client_token  text default null
)
returns table (new_balance integer, new_community integer)
language plpgsql security definer set search_path = public
as $$
declare
  -- 10% of the points ACTUALLY awarded — post-multiplier, so a 2x-tier student
  -- earning 300 mints 30, not 15. Rewards what the tier system already rewards.
  c_rate      constant numeric := 0.10;
  -- Anti-abuse: MAX_AWARD_DOLLARS bounds a single award but not a string of
  -- them, and community points are cross-vendor, so a colluding vendor mints
  -- value that leaves their own shop. Built in now rather than retrofitted —
  -- every later edit to this function costs another drop-and-recreate.
  c_daily_cap constant integer := 200;

  visited_before  boolean;
  visited_today   boolean;
  v_vendor_active boolean;
  v_minted_today  integer;
  v_community     integer;
begin
  -- Announce a legitimate points write to the migration-025 guard triggers.
  -- Transaction-local (third arg true): evaporates when this call's
  -- transaction commits, so it can never leak into another request.
  perform set_config('app.points_write', 'server', true);

  if p_points <= 0 then
    raise exception 'POINTS_INVALID';
  end if;

  -- Idempotency: a retry of an already-recorded award (same token, same vendor)
  -- returns the current balances and stops here — BEFORE any side effect
  -- (revisit bump / balance / transaction insert / MINT), so nothing is applied
  -- twice. A retried award cannot double-mint community points.
  if p_client_token is not null then
    if exists (
      select 1 from transactions
      where vendor_id = p_vendor_id and client_token = p_client_token
    ) then
      return query
        select coalesce((select pb.balance from point_balances pb
                         where pb.user_id = p_user_id and pb.vendor_id = p_vendor_id), 0),
               coalesce((select cb.balance from community_balances cb
                         where cb.user_id = p_user_id), 0);
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

  -- ----- the community 10% -----
  -- Derived HERE, from the number this function is already writing. It never
  -- crosses the wire as an input (community-points.md, constraint 3).
  v_community := floor(p_points * c_rate);

  -- An admin-hidden vendor mints nothing. tiers.js already drops txns at
  -- vendors.active = false from the tier math; the mint follows the same rule so
  -- a delisted shop can't keep issuing cross-vendor value. The VENDOR points
  -- still award in full — only the community 10% is withheld.
  select v.active into v_vendor_active from vendors v where v.id = p_vendor_id;
  if not coalesce(v_vendor_active, false) then
    v_community := 0;
  end if;

  -- Daily cap. Counts earn rows only, and nets out reversals automatically: a
  -- voided award's compensating row carries a negative community_points, which
  -- frees the cap back up. created_at::date matches the revisit logic above
  -- (server timezone), deliberately — one definition of "today" in this function.
  if v_community > 0 then
    select coalesce(sum(t.community_points), 0) into v_minted_today
    from transactions t
    where t.user_id = p_user_id
      and t.type = 'earn'
      and t.created_at::date = current_date;

    v_community := least(v_community, greatest(0, c_daily_cap - v_minted_today));
  end if;

  if v_community > 0 then
    insert into community_balances (user_id, balance, lifetime_earned)
    values (p_user_id, v_community, v_community)
    on conflict (user_id) do update
      set balance         = community_balances.balance + v_community,
          lifetime_earned = community_balances.lifetime_earned + v_community,
          updated_at      = now();
  end if;

  -- The unique index on (vendor_id, client_token) is the hard backstop: a
  -- concurrent duplicate that slips past the exists() check raises here and the
  -- whole atomic call rolls back, so neither the balance bump nor the mint
  -- above ever sticks twice.
  insert into transactions (user_id, vendor_id, type, points, dollar_amount, client_token, community_points)
  values (p_user_id, p_vendor_id, 'earn', p_points, p_dollar_amount, p_client_token, v_community);

  return query
    select pb.balance,
           coalesce((select cb.balance from community_balances cb
                     where cb.user_id = p_user_id), 0)
    from point_balances pb
    where pb.user_id = p_user_id and pb.vendor_id = p_vendor_id;
end;
$$;

-- Re-applied because the drop above took them with it. See the header warning.
revoke execute on function public.award_points(uuid, uuid, integer, numeric, text) from public, anon, authenticated;
grant  execute on function public.award_points(uuid, uuid, integer, numeric, text) to service_role;

-- ---------- 5. reverse_transaction — 025 body + the community unwind ----------
-- Signature is UNCHANGED, deliberately: create-or-replace still works, and the
-- undo push (emitBalance without a `community` field) makes the student app fall
-- back to loadCommunity() on its own — public/student/app.js:1171 already does
-- this. No client change needed for undo.

create or replace function public.reverse_transaction(
  p_transaction_id uuid,
  p_vendor_id      uuid
)
returns table (affected_user uuid, new_balance integer, reversed_type text, reversed_points integer)
language plpgsql security definer set search_path = public
as $$
declare
  orig        transactions%rowtype;
  comp_points integer;
  comp_dollar numeric;
  comp_id     uuid;
  new_bal     integer;
begin
  -- Announce a legitimate points write to the migration-025 guard triggers.
  perform set_config('app.points_write', 'server', true);

  -- Lock the original row so two concurrent taps can't both pass the
  -- already-reversed check and post two compensating rows.
  select * into orig
  from transactions
  where id = p_transaction_id and vendor_id = p_vendor_id
  for update;

  if orig.id is null then
    raise exception 'TX_NOT_FOUND';
  end if;
  if orig.reverses is not null then
    raise exception 'CANNOT_REVERSE_REVERSAL';   -- a reversal itself can't be reversed
  end if;
  if orig.reversed_by is not null then
    raise exception 'ALREADY_REVERSED';
  end if;
  -- Forward-compatible with migration-027: a community transfer carries the
  -- DESTINATION vendor's id, so it shows up in GET /api/vendor/recent (which
  -- filters on vendor_id alone) and the terminal would offer to undo it. Undoing
  -- it here would negate point_balances without returning anything to
  -- community_balances — the student's points would simply evaporate. A student's
  -- transfer is not the vendor's to reverse. No such rows exist until 027 adds
  -- the type; this guard is here so 027 doesn't have to rewrite the function.
  if orig.type = 'community_transfer' then
    raise exception 'CANNOT_REVERSE_TRANSFER';
  end if;
  -- Anti-abuse: undo is only allowed within 1 minute of the transaction, so a
  -- vendor can fix an immediate mistake but can't quietly claw points back from a
  -- customer later. Enforced HERE (not just in the terminal UI) because the vendor
  -- controls the client and could otherwise call this RPC directly.
  if now() - orig.created_at > interval '1 minute' then
    raise exception 'REVERSAL_EXPIRED';
  end if;

  -- Negate every numeric column: an +earn becomes a -correction, a -redeem
  -- refunds the points. Signed sums in the analytics rollup then net to zero.
  comp_points := -orig.points;
  comp_dollar := case when orig.dollar_amount is null then null else -orig.dollar_amount end;

  update point_balances
  set balance = greatest(0, balance + comp_points), updated_at = now()
  where user_id = orig.user_id and vendor_id = orig.vendor_id
  returning balance into new_bal;

  if not found then
    -- No balance row yet (shouldn't happen for a real earn/redeem, but be safe).
    insert into point_balances (user_id, vendor_id, balance)
    values (orig.user_id, orig.vendor_id, greatest(0, comp_points))
    returning balance into new_bal;
  end if;

  -- ----- unwind the community mint -----
  -- Non-negotiable: without this, "award, undo, repeat" is an infinite
  -- community-point printer. Both columns move — a voided earn was never really
  -- earned, so lifetime_earned must forget it too.
  --
  -- CLAMP: a student can earn 15 community points, transfer them away, and only
  -- THEN have the vendor void the earn — which would drive the balance negative.
  -- greatest(0, ...) is the same trade point_balances has made since
  -- migration-010, and it is the one place the ledger invariants in the header
  -- can drift. The 1-minute reversal window makes it vanishingly rare.
  if orig.community_points <> 0 then
    update community_balances
    set balance         = greatest(0, balance - orig.community_points),
        lifetime_earned = greatest(0, lifetime_earned - orig.community_points),
        updated_at      = now()
    where user_id = orig.user_id;
  end if;

  insert into transactions (user_id, vendor_id, type, points, dollar_amount, reward_id, reverses, community_points)
  values (orig.user_id, orig.vendor_id, orig.type, comp_points, comp_dollar, orig.reward_id, orig.id, -orig.community_points)
  returning id into comp_id;

  update transactions set reversed_by = comp_id where id = orig.id;

  return query select orig.user_id, new_bal, orig.type, orig.points;
end;
$$;

revoke execute on function public.reverse_transaction(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.reverse_transaction(uuid, uuid) to service_role;
