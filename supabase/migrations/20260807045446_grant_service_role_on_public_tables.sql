-- ============================================================
-- Migration 036 — table-level grants, so the migration history can rebuild a
--                 working database.
--
--   WHY THIS EXISTS
--   Replaying migrations 001–035 into an empty project produces a schema the
--   application cannot use. Every query fails with:
--
--       permission denied for table vendors
--
--   ...including queries made with the service_role key. This is not an RLS
--   problem — service_role bypasses RLS — it is a plain GRANT problem.
--   schema.sql creates tables and never grants on them, because when it was
--   written hosted Supabase auto-exposed anything new in `public` to the Data
--   API roles via ALTER DEFAULT PRIVILEGES. That default has since flipped to
--   revoked-unless-granted, and the legacy toggle is removed on 2026-10-30.
--
--   Production is unaffected today: it was built table by table while the old
--   default was in force, so it carries grants nothing in this repo records.
--   That is exactly the problem — the recorded history did not reproduce the
--   running database, and nobody could know until someone replayed it. This
--   migration writes the missing half down, so a rebuild is faithful and so
--   production gets the same treatment if it is ever rebuilt.
--
--   WHY service_role ONLY, AND NOT anon / authenticated
--   The browser never reads a table. public/student/app.js,
--   public/vendor/terminal.js and public/admin/admin.js each construct a
--   supabase-js client, but only ever call auth methods on it — there is not a
--   single .from() or .rpc() in public/, and no realtime subscription. Server
--   side, supabaseAuth (the anon client) is used exclusively for
--   auth.getUser(). Every row the app reads or writes travels through Express
--   under the service_role key.
--
--   So anon and authenticated need no table privileges at all, and granting
--   them "to match production" would copy across an exposure rather than a
--   dependency: with the legacy default, the anon key — which ships to every
--   browser from GET /api/config — can currently read public.vendors straight
--   from PostgREST, pin_hash column included. Rebuilt environments should not
--   inherit that. Closing it on production is a separate, deliberate change:
--   it alters the behaviour of a live system and belongs in its own migration.
--
--   Idempotent, and additive on an environment that already has these grants.
-- ============================================================

-- PostgREST connects as `authenticator` and switches into the caller's role;
-- without USAGE the role cannot see the schema at all.
grant usage on schema public to service_role;

-- The server's identity. Full DML, RLS bypassed — this is what the legacy
-- auto-expose default gave it, and what every Express route assumes.
grant all privileges on all tables    in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute        on all functions in schema public to service_role;

-- Keep the next migration from re-creating this hole. Applies to objects
-- created by the role running migrations (postgres), which is every table in
-- supabase/migrations.
alter default privileges in schema public grant all privileges on tables    to service_role;
alter default privileges in schema public grant all privileges on sequences to service_role;
alter default privileges in schema public grant execute        on functions to service_role;

do $$
declare
  ungranted int;
begin
  select count(*) into ungranted
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not has_table_privilege('service_role', c.oid, 'SELECT');

  if ungranted > 0 then
    raise exception 'Migration 036: % table(s) in public are still unreadable by service_role', ungranted;
  end if;

  raise notice 'Migration 036 applied. service_role can read every table in public.';
end $$;
