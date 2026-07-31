-- Stubs for the Supabase-isms the repo's migrations assume.
-- Roles are cluster-wide, so this has to survive a database recreate.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon;          end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role;  end if;
end $$;

create schema if not exists auth;

-- profiles.user_id references auth.users(id).
-- migration-023 also reads u.created_at and u.email.
create table if not exists auth.users (
  id         uuid primary key,
  email      text,
  created_at timestamptz not null default now()
);

-- Every policy in the repo gates on auth.uid(); a NULL is fine for a DDL-only run.
create or replace function auth.uid() returns uuid
language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

-- migration-021 and friends reference these; harmless if unused.
create extension if not exists pgcrypto;
