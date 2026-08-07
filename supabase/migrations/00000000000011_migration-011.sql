-- ============================================================
-- Migration 011 — anonymize a student's transactions on account deletion.
--   "Delete my account" (POST /api/me/delete) removes the auth user, which
--   cascades to profiles → point_balances / earn_codes / redeem_codes /
--   user_scores. transactions, however, referenced profiles(user_id) with the
--   default NO ACTION and a NOT NULL column, so the profile delete would be
--   BLOCKED by the student's transaction rows and deleteUser() would fail.
--
--   Policy (chosen): ANONYMIZE, not cascade-delete. Keep the transaction rows so
--   a vendor's revenue/analytics totals don't silently drop, but null out the
--   student link. We make user_id nullable and switch the FK to ON DELETE SET
--   NULL, so deleting the profile leaves headless (anonymous) transaction rows.
-- Run in the Supabase SQL Editor after migration-010 (safe to re-run).
-- ============================================================

alter table public.transactions
  drop constraint if exists transactions_user_id_fkey;

alter table public.transactions
  alter column user_id drop not null;

alter table public.transactions
  add constraint transactions_user_id_fkey
  foreign key (user_id) references public.profiles (user_id) on delete set null;
