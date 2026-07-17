-- ============================================================
-- Migration 017 — hard-delete a vendor (anonymize its transactions).
--   The /admin dashboard can now DELETE a vendor outright, not just flip its
--   `active` kill-switch. Deleting the vendors row cascades away everything
--   vendor-scoped (staff links, point_balances, rewards, redeem_codes,
--   vendor_pin_sessions) and clears the logo, which lives on the row itself.
--
--   transactions, though, referenced vendors(id) AND rewards(id) with the
--   default NO ACTION — and vendor_id was NOT NULL — so the delete would be
--   BLOCKED: by the vendor's own transaction rows (vendor_id) and by any redeem
--   rows pointing at rewards the cascade is trying to remove (reward_id).
--
--   Policy (same as migration-011 for students): ANONYMIZE, not cascade-delete.
--   Keep the transaction rows so nothing silently vanishes from a student's
--   history or the platform totals, but null out the vendor + reward links. We
--   make vendor_id nullable and switch BOTH FKs to ON DELETE SET NULL, so
--   deleting a vendor leaves headless transaction rows — the student app renders
--   those as a generic "Vendor".
-- Run in the Supabase SQL Editor after migration-016 (safe to re-run).
-- ============================================================

-- ---------- vendor link: nullable + SET NULL ----------
alter table public.transactions
  drop constraint if exists transactions_vendor_id_fkey;

alter table public.transactions
  alter column vendor_id drop not null;

alter table public.transactions
  add constraint transactions_vendor_id_fkey
  foreign key (vendor_id) references public.vendors (id) on delete set null;

-- ---------- reward link: SET NULL ----------
-- reward_id is already nullable. Deleting a vendor cascade-deletes its rewards,
-- so this FK must SET NULL too — otherwise a redeem transaction pointing at one
-- of those rewards would block the cascade (and the whole vendor delete).
alter table public.transactions
  drop constraint if exists transactions_reward_id_fkey;

alter table public.transactions
  add constraint transactions_reward_id_fkey
  foreign key (reward_id) references public.rewards (id) on delete set null;
