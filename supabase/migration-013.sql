-- ============================================================
-- Migration 013 — error logging for the operator /admin dashboard.
--   A single place to see failures across the whole platform: unexpected
--   server 500s AND client-side errors from the student PWA and vendor
--   terminal (posted to /api/client-error). The /admin page reads these.
--
--   Server-only (service role) writes; no RLS policies, so no client can read
--   another user's errors — the admin API (requireAdmin, email allowlist) is
--   the only read path. user_id is stored WITHOUT a foreign key on purpose so a
--   later account deletion doesn't erase or block the error history.
-- Run in the Supabase SQL Editor after migration-012 (safe to re-run).
-- ============================================================

create table if not exists public.error_logs (
  id         uuid primary key default gen_random_uuid(),
  source     text not null check (source in ('server', 'student', 'vendor', 'admin')),
  message    text not null,
  stack      text,
  path       text,        -- request path (server) or page URL (client)
  method     text,        -- HTTP method (server errors)
  status     integer,     -- HTTP status (server errors)
  user_id    uuid,        -- best-effort; no FK so deleting a user keeps the log
  user_agent text,
  context    jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_error_logs_created on public.error_logs (created_at desc);
create index if not exists idx_error_logs_source  on public.error_logs (source, created_at desc);

alter table public.error_logs enable row level security;
-- no policies: only the server (service role) writes; admins read via the API
