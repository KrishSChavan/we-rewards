-- ============================================================
-- Migration 008 — idle timeout for staff PIN sessions.
--   Adds last_used_at so a PIN session also drops after a period of
--   INACTIVITY, not just at the 8-hour absolute cap (expires_at). The server
--   (requirePin middleware) rejects any session idle past PIN_IDLE_MINUTES and
--   refreshes last_used_at on each successful PIN-gated request — a sliding
--   window, so an unattended terminal re-asks for the PIN even mid-shift.
-- Run in the Supabase SQL Editor after migration-007 (safe to re-run).
-- ============================================================

alter table public.vendor_pin_sessions
  add column if not exists last_used_at timestamptz not null default now();
