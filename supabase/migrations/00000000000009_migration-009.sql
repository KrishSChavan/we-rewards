-- ============================================================
-- Migration 009 — fractional tier multipliers (1x / 1.5x / 2x).
--   The tier ladder changed from 1/2/3 to 1/1.5/2. user_scores.multiplier was
--   integer, which would silently round a stored 1.5 to 2. Widen it to numeric
--   so the analytics snapshot keeps the real value.
--   (point_balances / transactions stay integer — the award path floors
--   basePoints * multiplier to whole points before writing.)
-- Run in the Supabase SQL Editor after migration-008 (safe to re-run).
-- ============================================================

alter table public.user_scores
  alter column multiplier type numeric(3,2),
  alter column multiplier set default 1;
