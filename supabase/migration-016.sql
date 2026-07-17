-- ============================================================
-- Migration 016 — vendor logo.
--   Vendors can upload a small logo/icon in the terminal Settings tab. It's
--   resized client-side to a ~128px square and stored here as a base64
--   data-URL (image/png|jpeg|webp). The student app shows it next to the
--   vendor's name; it's served through a cacheable /api/vendor-logo/:id
--   endpoint so the frequently-refreshed balances payload stays lean.
--   Nullable — a vendor with no logo simply shows none.
-- Run in the Supabase SQL Editor after migration-015 (safe to re-run).
-- ============================================================

alter table public.vendors
  add column if not exists logo text;

-- Generated flag so the student /balances query can tell whether a vendor has a
-- logo WITHOUT selecting the (large) base64 itself — the card just points its
-- <img> at /api/vendor-logo/:id when this is true.
alter table public.vendors
  add column if not exists has_logo boolean generated always as (logo is not null) stored;
