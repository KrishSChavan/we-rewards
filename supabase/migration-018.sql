-- ============================================================
-- Migration 018 — vendor self-service applications + admin web-push.
--   vendor_applications: requests submitted from the public /join page. They
--   sit here until the operator accepts (onboards the vendor, then deletes the
--   row) or rejects (just deletes the row) — so no status column is needed.
--   push_subscriptions: admin browsers subscribed to "new application" web-push
--   alerts from the /admin dashboard.
--
--   Both tables are server-only (service role): the public /api/apply endpoint
--   inserts applications, the admin API (requireAdmin, email allowlist) is the
--   only read/delete path. No RLS policies, so no client can touch either table
--   directly. push_subscriptions.user_id has no FK on purpose (error_logs
--   convention) — a later account deletion shouldn't block or erase it; stale
--   endpoints are pruned when a push send returns 404/410.
-- Run in the Supabase SQL Editor after migration-017 (safe to re-run).
-- ============================================================

create table if not exists public.vendor_applications (
  id            uuid primary key default gen_random_uuid(),
  business_name text not null,
  contact_name  text not null,
  phone         text not null,
  email         text not null,          -- stored lowercased
  password_hash text not null,          -- bcrypt; forwarded to auth.admin.createUser({ password_hash }) on accept
  address       text,
  logo          text,                   -- optional ~128px base64 data-URL (same caps as vendors.logo)
  message       text,                   -- applicant's note to the operator
  created_at    timestamptz not null default now()
);

-- One pending application per email — a re-submit is a clean 409, not a queue
-- of duplicates for the operator to wade through.
create unique index if not exists idx_vendor_applications_email
  on public.vendor_applications ((lower(email)));

alter table public.vendor_applications enable row level security;
-- no policies: only the server (service role) reads/writes

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid,                      -- admin who subscribed; best-effort, no FK
  endpoint   text not null unique,      -- upsert key; a browser re-subscribing overwrites in place
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
-- no policies: only the server (service role) reads/writes
