-- ============================================================
-- Migration 065 — NFC tag traffic: what /admin reads when a counter tag is tapped.
--
--   THE PROBLEM. A tag stuck to a counter is a physical object nobody can see
--   working. The landing route (src/routes/tap.js, GET /t/<slug>) writes one
--   client_events row per tap, and an iPhone with the App Store app installed
--   never reaches that route at all — iOS hands the Universal Link straight to
--   the app. So today the operator can answer neither "is anyone tapping the
--   tag at Irving's?" nor "did the tag I rewrote last week stop working?", and
--   the taps that DO reach the server sit in a table whose source CHECK is
--   ('student','vendor','admin'), that nothing in /admin reads back per vendor,
--   and that has no index a per-vendor roll-up could use. Same situation
--   migration-050 found itself in with poster scans, same answer.
--
--   WHAT THIS FILE ADDS
--   1. nfc_taps — one row per tap, from either path: 'web' when the landing
--      page was served, 'app' when the iOS app handled the Universal Link
--      itself and reported it afterwards (POST /api/me/nfc-tap). Keyed by the
--      vendor when the ref resolved and NULL when it did not, so a mistyped or
--      stale slug is COUNTED rather than lost. That is the whole point of the
--      Unmatched list in /admin: 'irvngs' sitting beside 'irvings' tells the
--      operator which tag to go and rewrite.
--   2. nfc_tap_overview — the per-vendor roll-up (today / 7 days / 30 days /
--      all time, distinct visitors, app share, first and last tap), grouped in
--      the database for the reason 050 gives: PostgREST cannot GROUP BY, and
--      pulling every tap row into Node to count it there is fine on the day it
--      ships and a whole-table read down the wire once a tag has been on a
--      counter for a term.
--   3. nfc_tap_unmatched — the refs that matched no spot, grouped and counted.
--   4. nfc_tap_detail() — the daily series and hour-of-day histogram behind one
--      spot's Traffic panel, bucketed in the campus timezone exactly as
--      tracked_qr_detail is.
--
--   NO SLUG SCHEMA. The other half of this release lets the operator edit a
--   spot's slug in /admin. vendors.slug has been NOT NULL UNIQUE since the
--   schema baseline, so that needs nothing here; the unique constraint is what
--   the 409 SLUG_TAKEN answer in src/routes/admin.js is written against. Taps
--   are keyed by vendor id and not by slug, which is what lets a spot's history
--   survive a rename and what makes the /t/<uuid> "permanent link" permanent.
--
--   PRIVACY. A tap row holds no IP address. visitor_hash is the SHA-256 of a
--   nonce this server minted into a cookie on the visitor's own phone (web) —
--   the mint-nonce/store-hash shape migration-050 and the punch binding cookie
--   use — or, for an app tap, of 'u:' || the account id, so one column can
--   count a returning phone and a returning account alike. user_id is kept on
--   app taps only and carries no foreign key, exactly like client_events:
--   deleting an account leaves the tap behind, which is a count and a date and
--   not personal data.
--
--   WHAT A ROW IS NOT. Nothing here moves points, and nothing reads this table
--   except /admin. The insert in src/lib/nfc-taps.js is best effort and never
--   throws: a counter tag has to render its page whether or not this table
--   exists, so IF THAT INSERT FAILS, THE COUNT UNDERCOUNTS, and that is the
--   deliberate trade — the same one migration-063 makes for its credits
--   table. The client_events row tap.js has always written is kept alongside,
--   as the generic funnel log; this table is the one the operator reads.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-064. Safe to re-run.
--
--   ⚠ DEPLOY ORDER: run this BEFORE the server code. The server tolerates the
--   table being absent (the NFC tags card in /admin says "Migration 065 not
--   applied" and the landing page renders exactly as before), but every tap
--   between the deploy and the paste is counted only in client_events and
--   never appears here. Nothing in this file is called until the server asks,
--   so the database is safe ahead of the deploy.
-- ============================================================

begin;

-- ---------- 1. the taps ----------

create table if not exists public.nfc_taps (
  -- bigserial, not uuid, like tracked_qr_scans: this is a high-volume table
  -- and nothing outside the database ever names a tap row.
  id           bigserial primary key,
  -- SET NULL, not cascade. A spot that leaves the platform keeps its traffic
  -- history, and because the tag is still physically on a wall its taps keep
  -- arriving: they land in the Unmatched list under the ref the tag carries,
  -- which is exactly where an operator would look for "why is this still
  -- being tapped". Null also for the generic tag and for refs that matched
  -- nothing, which is what the Unmatched view groups by.
  vendor_id    uuid references public.vendors (id) on delete set null,
  -- What the tag carried, as normalizeTapRef left it: a slug, a uuid, or
  -- 'generic' for the bare /t campus tag. Kept even when it matched nothing,
  -- BECAUSE it matched nothing — an unmatched ref is the finding. 64 covers
  -- a 60-character slug and a uuid with room to spare; anything longer is not
  -- a tag, it is a probe, and the route refuses it before the insert.
  ref          text not null check (btrim(ref) <> '' and length(ref) <= 64),
  -- Whether the ref resolved to a live spot AT TAP TIME. Not derivable from
  -- vendor_id later: a spot deleted since reads null there but was known.
  known        boolean not null,
  -- 'web': the landing page was served. 'app': the iOS app opened the spot
  -- itself, straight from the tag, and told the server afterwards. That path
  -- never reaches /t, so without these rows an installed app's taps would be
  -- invisible — and the app share in /admin is the one number that says the
  -- tag is being read by the app rather than by Safari.
  source       text not null check (source in ('web', 'app')),
  -- SHA-256 of a nonce this server minted into the visitor's own cookie (web)
  -- or of 'u:' || user_id (app). Null when neither was available: a tap with
  -- no identity still counts as traffic, it just cannot be told apart from
  -- another, so the distinct-visitor figure skips it rather than inventing
  -- one for it.
  visitor_hash text,
  -- App taps only. No foreign key, exactly like client_events.user_id: a tap
  -- is a count and a date, and deleting the account must not delete it.
  user_id      uuid,
  -- Truncated by the caller. isLikelyBot drops the obvious crawlers before
  -- the insert; this is for telling a phone from the ones it missed.
  user_agent   text check (user_agent is null or length(user_agent) <= 500),
  tapped_at    timestamptz not null default now()
);

comment on table public.nfc_taps is
  'One row per NFC tag tap, from the landing page (source=web) or reported by '
  'the iOS app (source=app). No IP, no account on web taps — see migration-065 '
  'on why visitor_hash is a hash and not an identifier. Best effort: the '
  'insert never blocks the page, so this can undercount.';
comment on column public.nfc_taps.ref is
  'The normalised ref the tag carried: a slug, a uuid, or ''generic''. Kept '
  'for unmatched taps so a mistyped or stale slug shows up in /admin.';
comment on column public.nfc_taps.known is
  'True when the ref resolved to a live spot at tap time. vendor_id can be '
  'nulled later by a delete; this cannot.';

-- ---------- 2. the shapes /admin asks for ----------

-- "This spot, newest first" drives everything on the Traffic panel: the four
-- window counts, the first/last pair, the daily series and the histogram.
create index if not exists idx_nfc_taps_vendor_time
  on public.nfc_taps (vendor_id, tapped_at desc);
-- The CSV export walks the whole table newest first, and the Unmatched list's
-- "last tap" is a max over rows with no vendor, which the index above cannot
-- serve well for a null key.
create index if not exists idx_nfc_taps_time
  on public.nfc_taps (tapped_at desc);
-- What the distinct-visitor count groups within. Partial, because a row with
-- no hash is never a visitor and would only widen the index.
create index if not exists idx_nfc_taps_visitor
  on public.nfc_taps (vendor_id, visitor_hash) where visitor_hash is not null;

-- ---------- 3. server-only, like every other telemetry table ----------

alter table public.nfc_taps enable row level security;
-- RLS on with no policies, and an explicit revoke on top, for the reason
-- migration-062 spells out: the default-privilege fix of 20260807162120 only
-- covers tables created by the role that ran it, and a hosted project's
-- supabase_admin defaults can still hand anon full DML on a new table at
-- CREATE time. RLS with no policies would deny anyway; the revoke is the
-- second lock, for the day someone adds a policy.
revoke all on table public.nfc_taps from anon, authenticated;
grant select, insert, update, delete on table public.nfc_taps to service_role;
-- bigserial: an insert calls nextval, so the server needs the sequence too.
revoke all on sequence public.nfc_taps_id_seq from anon, authenticated;
grant usage, select on sequence public.nfc_taps_id_seq to service_role;

-- ---------- 4. what /admin reads ----------

-- One row per spot that has ever been tapped. A spot with no taps has no row:
-- the admin route starts from the vendors table and left-joins this, so every
-- spot still appears in the card reading 0, and the view stays a pure roll-up
-- of the taps table rather than a second copy of the vendor list.
--
-- Every window is computed against now() at read time, so the view is never
-- stale and never needs a refresh job. count(*) filter (where ...) rather than
-- sum(case ...): it is what the planner expects and what the next reader
-- expects, and it keeps "distinct visitors in the window" expressible without
-- a second scan.
--
-- security_invoker so the view can never become a way around the base table's
-- RLS. Today only service_role can reach either, but a view that ran as its
-- owner would silently outlive that — the trap migration-037 was written to
-- close, and the choice migration-050 and 053 made for the same reason.
create or replace view public.nfc_tap_overview
with (security_invoker = true) as
select t.vendor_id,
       count(*)                                                            as taps,
       count(*) filter (where t.tapped_at >= now() - interval '30 days')   as taps_30d,
       count(*) filter (where t.tapped_at >= now() - interval '7 days')    as taps_7d,
       -- "Today" is the campus day, not the UTC one. At 9pm in State College
       -- UTC has already moved on, and a tag tapped at dinner would otherwise
       -- read as tomorrow's first tap and vanish from today's figure at once.
       -- Same reasoning as tracked_qr_detail's timezone note in 050.
       count(*) filter (where t.tapped_at >= (date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York'))
                                                                           as taps_today,
       count(*) filter (where t.source = 'app' and t.tapped_at >= now() - interval '30 days')
                                                                           as app_taps_30d,
       -- count(distinct) skips nulls, so a tap with no identity is traffic but
       -- not a visitor — see the column comment.
       count(distinct t.visitor_hash) filter (where t.tapped_at >= now() - interval '30 days')
                                                                           as uniques_30d,
       min(t.tapped_at)                                                    as first_tap,
       max(t.tapped_at)                                                    as last_tap
  from public.nfc_taps t
 where t.vendor_id is not null
 group by t.vendor_id;

comment on view public.nfc_tap_overview is
  'Per-spot NFC tap roll-up (all time / 30d / 7d / campus-day today, distinct '
  'visitors and app taps over 30d, first and last tap). Spots with no taps '
  'have no row. See migration-065.';

-- The refs that resolved to no spot, so the operator can see them. 'generic'
-- is the bare campus tag and is expected; anything else is a slug that was
-- mistyped when the tag was written, or one that WAS right until the spot was
-- renamed or left — and because the tag is still on a wall, those keep
-- arriving until someone rewrites it. (A deleted spot's taps land here too,
-- vendor_id having been nulled, under the slug the tag still carries.)
create or replace view public.nfc_tap_unmatched
with (security_invoker = true) as
select t.ref,
       count(*)                                                            as taps,
       count(*) filter (where t.tapped_at >= now() - interval '30 days')   as taps_30d,
       max(t.tapped_at)                                                    as last_tap
  from public.nfc_taps t
 where t.vendor_id is null
 group by t.ref;

comment on view public.nfc_tap_unmatched is
  'NFC taps whose ref matched no spot, grouped by ref. ''generic'' is the bare '
  'campus tag; anything else is a mistyped or stale slug. See migration-065.';

grant select on public.nfc_tap_overview  to service_role;
grant select on public.nfc_tap_unmatched to service_role;
revoke all privileges on public.nfc_tap_overview  from anon, authenticated;
revoke all privileges on public.nfc_tap_unmatched from anon, authenticated;

-- ---------- 5. nfc_tap_detail — one spot's two series, in one round trip ----------

-- The daily series and the hour-of-day histogram behind the Traffic panel,
-- mirroring tracked_qr_detail (migration-050) so the admin client can draw
-- both with the code it already has.
--
-- ⚠ TIMEZONE IS NOT COSMETIC HERE, for the reason 050 gives: taps are stored
-- in UTC and the campus is four or five hours behind it, so bucketing by UTC
-- would push every evening tap into the next day and shift the histogram by a
-- third of a day. The default is the campus zone rather than the server's,
-- because the server's is an accident of hosting.
--
-- The window starts at the BEGINNING OF THE OLDEST DAY in the series, in p_tz,
-- rather than at now() minus N days. That is the one place this departs from
-- 050: cut at now() minus N days, a tap at 7am on the first day of the window
-- falls inside the hourly histogram and outside the daily series, and the two
-- stop summing to the same number. With the cut on the day boundary they
-- always agree, and the operator can check one against the other.
create or replace function public.nfc_tap_detail(
  p_vendor_id uuid,
  p_days      integer default 30,
  p_tz        text    default 'America/New_York'
)
returns jsonb
language sql security definer set search_path = public
stable
as $$
  with bounds as (
    -- Clamped, so a hand-typed ?days=99999 cannot ask for a series with a
    -- hundred thousand buckets in it, and 0 or null cannot ask for none.
    select greatest(1, least(365, coalesce(p_days, 30))) as days
  ),
  since as (
    select ((date_trunc('day', now() at time zone p_tz) - make_interval(days => b.days - 1)) at time zone p_tz) as t0
      from bounds b
  ),
  days as (
    select (date_trunc('day', (now() at time zone p_tz)) - make_interval(days => g))::date as day
      from bounds b, generate_series(0, b.days - 1) as g
  ),
  taps as (
    select (t.tapped_at at time zone p_tz)::date                         as day,
           extract(hour from (t.tapped_at at time zone p_tz))::int        as hour
      from public.nfc_taps t
     where t.vendor_id = p_vendor_id
       and t.tapped_at >= (select t0 from since)
  )
  select jsonb_build_object(
    'vendor_id', p_vendor_id,
    'days',      (select days from bounds),
    'timezone',  p_tz,
    -- Every day in the window, gaps included and reading 0: the chart is drawn
    -- straight from this list, and a missing day would be drawn as a missing
    -- bar, which looks like a broken tag rather than a quiet one.
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'taps', coalesce(n.c, 0)) order by d.day), '[]'::jsonb)
        from days d
        left join (select day, count(*) as c from taps group by day) n on n.day = d.day
    ),
    'hourly', (
      select coalesce(jsonb_agg(jsonb_build_object('hour', h.h, 'taps', coalesce(n.c, 0)) order by h.h), '[]'::jsonb)
        from generate_series(0, 23) as h(h)
        left join (select hour, count(*) as c from taps group by hour) n on n.hour = h.h
    )
  );
$$;

comment on function public.nfc_tap_detail(uuid, integer, text) is
  'The daily series and hour-of-day histogram behind one spot''s NFC Traffic '
  'panel in /admin, bucketed in the campus timezone; p_days clamped to 1..365. '
  'An unknown vendor id returns a full series of zeros, not an error. '
  'See migration-065.';

revoke execute on function public.nfc_tap_detail(uuid, integer, text) from public, anon, authenticated;
grant  execute on function public.nfc_tap_detail(uuid, integer, text) to service_role;

commit;
