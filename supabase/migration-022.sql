-- ============================================================
-- Migration 022 — terms acceptance gate.
--   Until now, schema.sql's on_auth_user_created trigger created a profile the
--   instant Google OAuth inserted into auth.users. That made it impossible to
--   gate account creation on consent: the row existed before any client code
--   could run. This migration removes that trigger, so the profile — the actual
--   app-level account — is created by POST /api/me/accept-terms instead, only
--   after the student agrees to the Terms and Privacy Policy.
--
--   A student who signs in and declines leaves nothing behind but the
--   auth.users row Supabase creates during OAuth (which /decline deletes), and
--   no profile, balance, or transaction ever exists for them.
--
--   Also adds an append-only acceptance log. profiles.terms_accepted_at is the
--   fast "may this user act?" check; terms_acceptances is the evidence trail
--   that survives re-acceptance after a terms revision.
-- Run in the Supabase SQL Editor after migration-021 (safe to re-run).
-- ============================================================

-- ---------- 1. consent columns on profiles ----------
alter table public.profiles
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version     text;

comment on column public.profiles.terms_accepted_at is
  'When this student accepted the Terms + Privacy Policy. NULL = not yet consented; the API refuses student endpoints until set.';
comment on column public.profiles.terms_version is
  'Which document version was accepted. Compared against TERMS_VERSION in src/lib/terms.js; a mismatch re-prompts.';

-- ---------- 2. append-only acceptance log ----------
-- One row per acceptance event, never updated or deleted while the account
-- lives. user_id has ON DELETE CASCADE: if the student deletes their account we
-- are not entitled to keep the record, and the account is gone anyway.
create table if not exists public.terms_acceptances (
  id            bigserial primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  terms_version text not null,
  accepted_at   timestamptz not null default now(),
  -- Evidence fields. Best-effort: null when the proxy doesn't supply them.
  ip            text,
  user_agent    text
);

create index if not exists idx_terms_acceptances_user
  on public.terms_acceptances (user_id, accepted_at desc);

alter table public.terms_acceptances enable row level security;
-- No policies: the table is written and read only by the server's service role,
-- which bypasses RLS. anon/authenticated get nothing, matching error_logs.
revoke all on public.terms_acceptances from anon, authenticated;

-- ---------- 3. stop auto-creating profiles ----------
-- This is the change that makes the consent gate real. The function is dropped
-- alongside the trigger so a future reader doesn't find an orphan and wonder
-- whether it still runs.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

-- ---------- 4. email_has_account() ----------
-- Consequence of dropping the trigger: POST /api/apply used to detect a
-- duplicate signup by looking for a profiles row with that email, on the
-- assumption that "every auth user gets a profiles row." Vendors and admins no
-- longer get one, so that check would miss existing accounts and queue an
-- application that fails later at createUser — exactly what it exists to
-- prevent. This asks auth.users directly instead.
--
-- SECURITY DEFINER because auth.users isn't readable by the API roles; returns
-- only a boolean, never the row, so it can't be used to enumerate accounts.
create or replace function public.email_has_account(p_email text)
returns boolean
language plpgsql security definer set search_path = public, auth
as $$
begin
  return exists (
    select 1 from auth.users
    where lower(email) = lower(trim(p_email))
  );
end;
$$;

revoke execute on function public.email_has_account(text) from public, anon, authenticated;
grant  execute on function public.email_has_account(text) to service_role;

-- ---------- 5. existing profiles ----------
-- Pre-migration profiles were created by the old trigger and never consented.
-- They keep terms_accepted_at = NULL, so the API treats them as unconsented and
-- the app prompts them on next sign-in. No backfill: stamping consent nobody
-- gave would defeat the point of the log above.

-- ---------- 6. sanity check ----------
do $$
declare
  unconsented integer;
begin
  select count(*) into unconsented from public.profiles where terms_accepted_at is null;
  if unconsented > 0 then
    raise notice 'Migration 022 applied. % existing profile(s) have no consent on record and will be prompted at next sign-in.', unconsented;
  else
    raise notice 'Migration 022 applied. No existing profiles needed prompting.';
  end if;
end;
$$;
