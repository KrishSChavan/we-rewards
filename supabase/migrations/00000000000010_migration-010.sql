-- ============================================================
-- Migration 010 — void / refund a transaction.
--   Cashiers fat-finger amounts and redeem the wrong item; today the only fix
--   is editing rows in the dashboard (invisible in the audit trail). This adds
--   an atomic, service-only reversal that writes a COMPENSATING transaction
--   instead of deleting the original, so history stays auditable.
--
--   1. Link columns pairing an original row with its reversal:
--        transactions.reversed_by → the compensating row that voided this one
--        transactions.reverses    → the original row THIS compensating row voids
--   2. reverse_transaction(p_transaction_id, p_vendor_id): in one transaction,
--      verify the row belongs to this vendor, refuse to double-reverse / reverse
--      a reversal / reverse anything older than 1 MINUTE (anti-abuse — a vendor
--      can fix an immediate slip but can't claw points back from a customer
--      later), write the compensating row (negating points AND dollar_amount so
--      analytics sums net to zero), and adjust the balance — clamped at 0 so
--      clawing back already-spent points never goes negative.
--   3. Lock EXECUTE to service_role only (like the other money RPCs).
-- Run in the Supabase SQL Editor after migration-009 (safe to re-run).
-- ============================================================

-- ---------- 1. REVERSAL LINK COLUMNS ----------
alter table public.transactions
  add column if not exists reverses    uuid references public.transactions(id),
  add column if not exists reversed_by uuid references public.transactions(id);

-- ---------- 2. RPC: REVERSE A TRANSACTION ----------
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

  insert into transactions (user_id, vendor_id, type, points, dollar_amount, reward_id, reverses)
  values (orig.user_id, orig.vendor_id, orig.type, comp_points, comp_dollar, orig.reward_id, orig.id)
  returning id into comp_id;

  update transactions set reversed_by = comp_id where id = orig.id;

  return query select orig.user_id, new_bal, orig.type, orig.points;
end;
$$;

-- ---------- 3. EXECUTE LOCKDOWN (service_role only) ----------
revoke execute on function public.reverse_transaction(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.reverse_transaction(uuid, uuid) to service_role;
