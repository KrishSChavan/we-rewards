-- ============================================================
-- Migration 015 — vendor address + geocoded coordinates.
--   Vendors get a street address (settable at onboarding and editable in the
--   terminal Settings tab). When saved, the server geocodes it once (Nominatim)
--   and stores latitude/longitude so the student app can render a small OSM map
--   thumbnail on each vendor card that opens the device's maps app on tap.
--   All three columns are nullable — a vendor with no address (or a geocode
--   miss) simply shows no map.
-- Run in the Supabase SQL Editor after migration-014 (safe to re-run).
-- ============================================================

alter table public.vendors
  add column if not exists address   text,
  add column if not exists latitude  double precision,
  add column if not exists longitude double precision;
