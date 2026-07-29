-- ============================================================
-- Migration 027 — Community points: the transfer (spend) leg.
--   Step 5 of community-points.md. A student moves community points into ONE
--   vendor's balance; from that moment they are ordinary vendor points and every
--   existing path — the meter, the catalog, the WRW:R: redeem code, the
--   cashier's confirm screen — works unchanged. The cross-vendor freedom is
--   spent at transfer time, not at the counter.
--
--   WHAT THIS FILE DOES
--   1. transactions.type learns 'community_transfer'. The CHECK is inline and
--      unnamed in schema.sql:73, so the auto-generated name can differ between
--      environments — the DO block finds it by definition instead of guessing.
--   2. vendors.accepts_community_points — the opt-OUT flag (default true).
--      Business model is option A of community-points.md: goodwill/reciprocity,
--      every vendor takes inbound transfers unless they ask not to.
--   3. vendors.community_monthly_cap — option A's safety valve. Inbound
--      transfers into a vendor are capped per calendar month (default 5000);
--      NULL means uncapped (an operator decision, never the default).
--   4. transfer_community_points — the one-way move. SECURITY DEFINER, only
--      callable by service_role, same posture as award_points.
--
--   THE LEDGER, EXTENDED (see migration-026's header for the invariants)
--   A transfer writes ONE row: type 'community_transfer', points = +amount
--   (they landed in the vendor balance), community_points = -amount (they left
--   the pool). So sum(community_points) over ALL a student's rows still equals
--   community_balances.balance, and the earn-rows-only sum still equals
--   lifetime_earned — a transfer moves points, it doesn't mint or burn them.
--
--   WHY ONE-WAY (no undo, not by the student and not by the vendor)
--   Transferred points are spendable the instant they land. A reversible
--   transfer means: move 100 in, redeem a 100-point reward, move the 100 back —
--   item AND points. migration-026's reverse_transaction already raises
--   CANNOT_REVERSE_TRANSFER on these rows; this file is what makes such rows
--   exist. The student app's confirm sheet says plainly the move is final.
--
--   ⚠ DEPLOY ORDER: run this BEFORE deploying the server code that calls
--   transfer_community_points / selects accepts_community_points, or those
--   requests fail on the missing function/column. (The reverse order is safe
--   for the DB — nothing here is called until the server asks.)
--
--   ⚠ ORDERING FOOTGUN (the usual one): re-running schema.sql or migrations
--   004/005/010/019/025 restores older function bodies — re-run 026 (and this
--   file) afterwards. This file itself doesn't touch award_points or
--   reverse_transaction; 026's versions stay current.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-026. Safe to re-run.
-- ============================================================

-- ---------- 1. transactions.type: allow 'community_transfer' ----------
-- Find the CHECK by its definition (it's the only check on transactions that
-- names 'earn'), drop it, and re-add it under a stable name. Safe to re-run:
-- the second pass finds the named constraint and recreates it identically.

do $$
declare
  con record;
begin
  for con in
    select conname
    from pg_constraint
    where conrelid = 'public.transactions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%earn%'
  loop
    execute format('alter table public.transactions drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.transactions
  add constraint transactions_type_check
  check (type in ('earn', 'redeem', 'community_transfer'));

-- ---------- 2 + 3. The vendor's side of the bargain ----------

-- Opt-out, not opt-in: option A only works if "move them anywhere" is true, so
-- accepting inbound transfers is the default and declining is the exception.
alter table public.vendors
  add column if not exists accepts_community_points boolean not null default true;

comment on column public.vendors.accepts_community_points is
  'Vendor accepts inbound community-point transfers (community-points.md option '
  'A). Enforced in transfer_community_points, not just hidden in the picker.';

-- The safety valve. 5000/month bounds a vendor''s worst case at a knowable
-- number before any product leaves the shelf. NULL = uncapped — an explicit
-- operator choice for a vendor who wants it, never the default.
alter table public.vendors
  add column if not exists community_monthly_cap integer default 5000
  check (community_monthly_cap >= 0);

comment on column public.vendors.community_monthly_cap is
  'Max community points that may be transferred INTO this vendor per calendar '
  'month. NULL = uncapped. Default 5000.';

-- ---------- 4. transfer_community_points ----------
-- The student picks the amount (it's their balance to move) but nothing else is
-- trusted from the wire: whether they HAVE it is the balance>=amount guard here,
-- and eligibility/cap are re-checked here no matter what the picker showed.

create or replace function public.transfer_community_points(
  p_user_id      uuid,
  p_vendor_id    uuid,
  p_amount       integer,
  p_client_token text default null
)
returns table (new_community integer, new_vendor_balance integer)
language plpgsql security definer set search_path = public
as $$
declare
  v_active     boolean;
  v_accepts    boolean;
  v_cap        integer;
  v_in_month   integer;
  v_community  integer;
  v_vendor_bal integer;
begin
  -- Announce a legitimate points write to the migration-025 guard triggers.
  -- Transaction-local: evaporates at commit, can never leak into another request.
  perform set_config('app.points_write', 'server', true);

  if p_amount is null or p_amount <= 0 then
    raise exception 'AMOUNT_INVALID';
  end if;

  -- Idempotency, same shape as award_points: a retry of an already-recorded
  -- transfer (same token, same vendor) returns the current balances and stops
  -- HERE, before any side effect. A double-submitted move can't move twice.
  -- The unique index on (vendor_id, client_token) is the concurrent-duplicate
  -- backstop, exactly as it is for awards.
  if p_client_token is not null then
    if exists (
      select 1 from transactions
      where vendor_id = p_vendor_id and client_token = p_client_token
    ) then
      return query
        select coalesce((select cb.balance from community_balances cb
                         where cb.user_id = p_user_id), 0),
               coalesce((select pb.balance from point_balances pb
                         where pb.user_id = p_user_id and pb.vendor_id = p_vendor_id), 0);
      return;
    end if;
  end if;

  -- Destination must be a real, active, opted-in vendor — checked here, not
  -- just in the picker, because the client controls the request body. The row
  -- lock also serializes concurrent transfers into the same vendor, so the
  -- monthly-cap read below can't be raced past by two requests that both saw
  -- headroom.
  select v.active, v.accepts_community_points, v.community_monthly_cap
    into v_active, v_accepts, v_cap
  from vendors v
  where v.id = p_vendor_id
  for update;

  if not found or not v_active or not v_accepts then
    raise exception 'VENDOR_INELIGIBLE';
  end if;

  -- Option A's safety valve: gross inbound this calendar month. Transfer rows
  -- can't be reversed (CANNOT_REVERSE_TRANSFER), so a plain sum IS the gross.
  if v_cap is not null then
    select coalesce(sum(t.points), 0) into v_in_month
    from transactions t
    where t.vendor_id = p_vendor_id
      and t.type = 'community_transfer'
      and t.created_at >= date_trunc('month', now());

    if v_in_month + p_amount > v_cap then
      raise exception 'VENDOR_CAP_REACHED';
    end if;
  end if;

  -- Vendor balance FIRST, community second — deliberately matching
  -- award_points' lock order (point_balances, then community_balances), so a
  -- transfer into vendor B racing an earn at vendor B can't deadlock. Crediting
  -- before the funds check is safe: if the decrement below finds no row, the
  -- raise rolls this back with everything else.
  insert into point_balances (user_id, vendor_id, balance)
  values (p_user_id, p_vendor_id, p_amount)
  on conflict (user_id, vendor_id)
  do update set balance = point_balances.balance + p_amount, updated_at = now()
  returning balance into v_vendor_bal;

  -- Atomic decrement, same shape as redeem_by_code's balance guard. A student
  -- with no community_balances row simply doesn't match: INSUFFICIENT_POINTS.
  update community_balances
     set balance = balance - p_amount, updated_at = now()
   where user_id = p_user_id and balance >= p_amount
  returning balance into v_community;

  if not found then
    raise exception 'INSUFFICIENT_POINTS';
  end if;

  -- lifetime_earned is untouched on purpose: it counts minting, not movement.
  insert into transactions (user_id, vendor_id, type, points, client_token, community_points)
  values (p_user_id, p_vendor_id, 'community_transfer', p_amount, p_client_token, -p_amount);

  return query select v_community, v_vendor_bal;
end;
$$;

-- Server-only, like every money RPC: the student calls POST
-- /api/me/community-transfer and the server calls this with the verified
-- user id from the session token — never a client-supplied one.
revoke execute on function public.transfer_community_points(uuid, uuid, integer, text) from public, anon, authenticated;
grant  execute on function public.transfer_community_points(uuid, uuid, integer, text) to service_role;
