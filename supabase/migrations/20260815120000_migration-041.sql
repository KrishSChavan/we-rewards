-- ============================================================
-- Migration 041 — Saved spots, and the "most visited" list that stands in
--                 for them before a student has any.
--
--   TWO THINGS, BOTH IN SERVICE OF THE NEW SPOTS TAB.
--
--   1. public.vendor_favorites — the heart on each row of the all-spots list.
--
--      Keyed (user_id, vendor_id) as the PRIMARY KEY rather than a surrogate
--      id, for the same three reasons point_balances is (schema.sql): the
--      pair IS the identity, so a duplicate favorite is impossible by
--      construction rather than by application care; `insert ... on conflict
--      do nothing` makes the toggle idempotent, which matters because a heart
--      is exactly the control a student double-taps; and the leading column
--      makes "everything this student saved" an index prefix scan, which is
--      how it is read on every home load.
--
--      No `active` column and no soft delete: un-favoriting is a DELETE. There
--      is nothing to audit here and nothing downstream reads a tombstone.
--
--   2. public.top_vendors_by_visits() — the Recommended fallback.
--
--      A student who has just signed up has no recent spots, so the Home
--      carousel would open empty on the one screen that has to make the app
--      look alive. It shows the five most-visited spots instead, labelled
--      Recommended.
--
--      VISITS, NOT TRANSACTIONS. The count is distinct (student, day) pairs,
--      not row count, so a regular who buys coffee three times on Tuesday
--      contributes one visit and not three. That is the same anti-farming
--      definition of a visit that the tier engine already uses
--      (src/lib/tiers.js), and without it the list would rank vendors by
--      transaction volume — which is a different question, and one a single
--      heavy user can answer on their own.
--
--      It is a function rather than a view or a client-side rollup because
--      PostgREST cannot express GROUP BY, and pulling every transaction into
--      Node to count them there is precisely the shape this codebase is trying
--      to get away from. STABLE + read-only, so it is safe to call often; the
--      result is global rather than per-student, so the server caches it
--      (src/lib/cache.js) and this runs a handful of times an hour at most.
--
--   RLS: enabled with NO POLICIES on the new table, matching every other table
--   here — the browser never touches a table directly (there is not one
--   .from() in public/), and every row the app reads or writes goes through
--   Express under service_role, which bypasses RLS.
--
--   THE REVOKE IS NOT OPTIONAL. Hosted Supabase projects carry default ACLs
--   that grant every DML privilege on each NEW table in `public` to anon and
--   authenticated, applied at CREATE TABLE time. Migration 037 revoked the
--   existing grants and reset the default privileges for tables created by
--   `postgres`, but a table created under any other role still arrives
--   pre-granted — so this migration revokes explicitly rather than assuming.
--   The anon key is public (GET /api/public-config serves it to every browser).
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-040. Safe to re-run.
-- ============================================================

begin;

-- ---------- 1. Saved spots ----------

create table if not exists public.vendor_favorites (
  user_id    uuid not null references public.profiles (user_id) on delete cascade,
  vendor_id  uuid not null references public.vendors (id)       on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, vendor_id)
);

comment on table public.vendor_favorites is
  'Spots a student saved with the heart on the Spots tab. PK is the pair, so the toggle is idempotent and un-favoriting is a plain DELETE.';

-- Deleting a vendor cascades into this table by vendor_id, and without an index
-- the referential-integrity trigger degrades into a sequential scan — the same
-- reasoning as idx_punches_vendor in migration-028. The primary key covers the
-- user_id direction already.
create index if not exists idx_vendor_favorites_vendor
  on public.vendor_favorites (vendor_id);

alter table public.vendor_favorites enable row level security;
-- no policies: only the server (service role) reads/writes

revoke all privileges on table public.vendor_favorites from anon, authenticated;
grant select, insert, delete on table public.vendor_favorites to service_role;

-- ---------- 2. The Recommended fallback ----------

create or replace function public.top_vendors_by_visits(
  p_limit integer default 5,
  p_days  integer default 30
)
returns table (vendor_id uuid, visits bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.vendor_id,
    -- A visit is a (student, day) pair, not a transaction. See the header.
    count(distinct (t.user_id, (t.created_at at time zone 'UTC')::date)) as visits
  from public.transactions t
  join public.vendors v on v.id = t.vendor_id
  where t.created_at >= now() - make_interval(days => greatest(p_days, 1))
    -- 'earn' only. A 'redeem' is someone spending points they already had, and
    -- 'community_transfer' happens inside the app rather than at a counter —
    -- neither is evidence that this spot is worth recommending to a stranger.
    and t.type = 'earn'
    -- A deactivated vendor must never be recommended; it isn't in the students'
    -- catalogue either, so it would render as a card pointing at nothing.
    and v.active
  group by t.vendor_id
  -- vendor_id breaks ties deterministically, so the list doesn't reshuffle
  -- between calls for vendors sitting on equal counts.
  order by visits desc, t.vendor_id
  limit greatest(p_limit, 0);
$$;

comment on function public.top_vendors_by_visits(integer, integer) is
  'Most-visited active vendors over the last p_days, counting distinct (student, day) visits. Feeds the Recommended row shown to students with no recent activity.';

-- security definer + a pinned search_path, so the function reads transactions
-- regardless of the caller's RLS — it returns aggregate counts, never a row
-- that identifies a student. Execute is service_role only: nothing in the
-- browser may call it, since vendor-level visit counts are not public data.
revoke all on function public.top_vendors_by_visits(integer, integer) from public, anon, authenticated;
grant execute on function public.top_vendors_by_visits(integer, integer) to service_role;

commit;
