-- ============================================================
-- Migration 037 — take table privileges away from anon and authenticated.
--
--   WHY THIS EXISTS
--   Hosted Supabase projects carry default ACLs, set by supabase_admin and by
--   postgres, that grant `arwdDxtm` — every DML privilege — on each new table
--   in `public` to anon, authenticated and service_role. They apply at CREATE
--   TABLE time, so a project built from these migrations hands the public anon
--   key full DML on all 24 tables before any grant of ours runs. The preceding
--   grants migration could not prevent this: it grants, and nothing revokes.
--
--   The anon key is not a secret. GET /api/public-config serves it to every
--   browser. So these grants make RLS the only thing between the open internet
--   and the data, and that gate is uneven:
--
--     - public.punch_cards_pre_029 has RLS DISABLED and no policies. It is the
--       one-shot snapshot migration 029 took before rewriting punch card state.
--       With the default grant it is world-readable AND world-writable.
--     - public.vendors has a permissive read policy, so anon can select every
--       column — including pin_hash, a bcrypt digest of a 4-digit terminal PIN.
--       10,000 candidates is a seconds-long offline crack.
--     - The remaining tables have RLS on with restrictive or no policies, so
--       they currently deny. They stay one careless policy away from exposure.
--
--   WHY REVOKING IS SAFE
--   Nothing in the browser reads a table. There is not one .from() or .rpc()
--   call anywhere in public/, and no realtime subscription; all three
--   front-ends build a supabase-js client purely for auth. Server side,
--   supabaseAuth (the anon client) is used only for auth.getUser(). Every row
--   the application touches goes through Express under service_role, which
--   keeps its privileges here and bypasses RLS regardless.
--
--   The one thing this migration cannot see is a consumer outside this repo
--   holding the anon key. If one exists, it loses table access when this runs.
--
--   Auth, Storage and Realtime are untouched — they live in their own schemas.
-- ============================================================

-- 1. Withdraw everything anon and authenticated currently hold in `public`.
revoke all privileges on all tables    in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;

-- 2. Stop the next table from arriving pre-granted. This only rewrites the
--    default privileges owned by the role executing the migration (postgres,
--    which creates every table in supabase/migrations). Objects created by
--    supabase_admin — i.e. through the dashboard — still inherit its defaults,
--    so a table added by hand needs its own revoke.
alter default privileges in schema public revoke all privileges on tables    from anon, authenticated;
alter default privileges in schema public revoke all privileges on sequences from anon, authenticated;

-- 3. Defence in depth for the snapshot table: even with grants gone, RLS off is
--    the wrong resting state for a table holding real punch-card rows. Nothing
--    reads it through the Data API; service_role bypasses RLS and is unaffected.
do $$
begin
  if to_regclass('public.punch_cards_pre_029') is not null then
    execute 'alter table public.punch_cards_pre_029 enable row level security';
    raise notice 'Migration 037: RLS enabled on punch_cards_pre_029.';
  else
    raise notice 'Migration 037: punch_cards_pre_029 absent here, nothing to secure.';
  end if;
end $$;

-- 4. Prove the intended end state rather than assuming it.
do $$
declare
  anon_readable  int;
  svc_unreadable int;
  rls_off        int;
begin
  select count(*) into anon_readable
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and (has_table_privilege('anon', c.oid, 'SELECT')
      or has_table_privilege('authenticated', c.oid, 'SELECT'));

  select count(*) into svc_unreadable
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and not has_table_privilege('service_role', c.oid, 'SELECT');

  select count(*) into rls_off
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  if anon_readable > 0 then
    raise exception 'Migration 037: % table(s) still reachable by anon/authenticated', anon_readable;
  end if;

  if svc_unreadable > 0 then
    raise exception 'Migration 037: % table(s) no longer readable by service_role — the app would break', svc_unreadable;
  end if;

  raise notice 'Migration 037 applied. anon/authenticated hold nothing in public; service_role intact; % table(s) without RLS.', rls_off;
end $$;
