-- ============================================================
-- Migration 024 — PWA install funnel events.
--   Product analytics for the "add to home screen" flow: which trigger fired,
--   how far each visitor got (eligible → shown → accepted), and where they drop
--   off. Posted best-effort from the student PWA to /api/client-event, alongside
--   the existing /api/client-error crash pipe (migration-013).
--
--   Server-only (service role) writes; no RLS policies, so no client can read
--   another user's events — reads go through the admin API (requireAdmin, email
--   allowlist) only. user_id has no foreign key on purpose, matching error_logs:
--   a later account deletion must not erase or block the funnel history.
-- Run in the Supabase SQL Editor after migration-023 (safe to re-run).
-- ============================================================

create table if not exists public.client_events (
  id         uuid primary key default gen_random_uuid(),
  source     text not null check (source in ('student', 'vendor', 'admin')),
  event      text not null,        -- e.g. install_prompt_shown, install_accepted
  trigger    text,                 -- which of the 5 triggers fired (install_prompt_shown only)
  props      jsonb,                -- small structured extra data
  user_id    uuid,                 -- best-effort; no FK so deleting a user keeps the event
  user_agent text,
  path       text,                 -- page URL at the time
  created_at timestamptz not null default now()
);

create index if not exists idx_client_events_created on public.client_events (created_at desc);
create index if not exists idx_client_events_event   on public.client_events (event, created_at desc);

alter table public.client_events enable row level security;
-- no policies: only the server (service role) writes; admins read via the API
