-- ============================================================
-- Migration 050 — Trackable poster QR codes.
--
--   A banner goes up with a QR printed on it. Someone scans it, lands in the
--   app, and if they GO ON TO CREATE AN ACCOUNT they are paid a one-time
--   community points award that the operator set on that banner. The operator
--   sees how many people scanned each banner and how many of those became
--   students.
--
--   Three tables and NO new SQL that moves points. grant_community_points
--   (migration-039) still pays every one of these, so the migration-025 write
--   guard, the ledger and the once-per-account index all apply here exactly as
--   they do to the referral and the signup bonus. A new way to earn should be
--   an evaluator, not a payout rail — the shape migration-040 established.
--
--   THE IDEMPOTENCY KEY IS THE STUDENT, again. A payout is recorded with
--   ref_id = user_id and kind = 'tracked_qr', so 039's UNIQUE (ref_id, kind)
--   index means one poster award per account, ever. That is the whole of the
--   anti-abuse story and it is deliberate: a printed code is photographable and
--   will be texted around, so the defence cannot live in the code being secret.
--   It lives in an account only ever being new once.
--
--   NO INCENTIVES ROW, AND THEREFORE NO SHARED BUDGET CEILING. A poster award
--   could have been incentive kind #3, but incentives carry a
--   one-active-deal-per-kind index, so every banner would have had to share one
--   row and one budget, and an operator would have had to create that deal
--   before any banner could pay at all. The guards instead are the per-banner
--   cap in tracked_qr_codes.points (5000, matching the signup bonus) and
--   grant_community_points' own 100000 typo stop. If a campus-wide ceiling is
--   ever wanted, it is a later migration: add 'tracked_qr' to the incentives
--   kind CHECK the way 040 did and pass p_incentive_id from the evaluator.
--
--   WHY SCANS ARE THEIR OWN TABLE rather than client_events: that table's
--   source CHECK is ('student','vendor','admin') and a poster is none of the
--   three, nothing in the app reads client_events back, and the operator asked
--   for per-banner counts, unique visitors and a 30-day shape. That is a query
--   against an indexed table, not a scan of an event firehose.
--
--   PRIVACY: a scan row holds no IP address and no account. visitor_hash is the
--   SHA-256 of a random nonce this server minted into a cookie on the visitor's
--   own device — it counts a returning phone without naming it, and it is worth
--   nothing to anyone who steals the table. Same mint-nonce/store-hash shape as
--   the punch binding cookie (src/lib/punch.js).
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-049. Safe to re-run.
-- ============================================================

begin;

-- ---------- 1. the codes an operator creates ----------

create table if not exists public.tracked_qr_codes (
  id         uuid primary key default gen_random_uuid(),
  -- What travels inside the printed URL: /r/<code>. Minted in Node against a
  -- deliberately unambiguous alphabet (src/lib/tracked-qr.js) so the one person
  -- who ever has to read it off a banner and type it can. UNIQUE is what the
  -- mint loop retries against, so it is load-bearing, not decoration.
  code       text not null unique,
  -- What the operator calls this banner. Shown in /admin and nowhere else.
  name       text not null check (btrim(name) <> '' and length(name) <= 80),
  -- Optional placement note: "east entrance, above the water fountain".
  note       text check (note is null or length(note) <= 200),
  -- What a signup through this banner pays. ZERO IS A REAL SETTING and the
  -- reason this is not `> 0`: a banner can be put up purely to measure whether
  -- anyone scans it, with no money attached. The ceiling matches
  -- signup-bonus.js's POINTS_MAX rather than the grant function's 100000 typo
  -- stop — a poster is a sibling of that deal, not of an operator's manual grant.
  points     integer not null default 0 check (points >= 0 and points <= 5000),
  -- Paused, not deleted. A banner that is already printed and on a wall keeps
  -- resolving and keeps counting scans when this is false; it just stops paying.
  -- Deleting the row instead would 404 a physical object nobody can recall.
  active     boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tracked_qr_codes is
  'One row per printed banner/poster QR. `code` is the public token in /r/<code>. '
  'See migration-050.';
comment on column public.tracked_qr_codes.points is
  'Community points paid once to a student who SIGNS UP through this banner. '
  '0 means track traffic only and pay nothing.';
comment on column public.tracked_qr_codes.active is
  'False pauses the payout. The URL keeps resolving and keeps counting scans, '
  'because the banner is already on a wall.';

-- ---------- 2. the traffic ----------

create table if not exists public.tracked_qr_scans (
  -- bigserial, not uuid: this is the only high-volume table in the feature and
  -- nothing outside the database ever names a scan row.
  id           bigserial primary key,
  qr_id        uuid not null references public.tracked_qr_codes (id) on delete cascade,
  -- SHA-256 of a nonce this server minted into the visitor's own cookie. Null
  -- when the browser refused the cookie, which is a real and uninteresting
  -- case — the scan still counts, it just cannot be told apart from another.
  visitor_hash text,
  -- Truncated by the caller. Kept for one reason: telling a phone camera apart
  -- from a crawler that followed the link out of someone's messages.
  user_agent   text check (user_agent is null or length(user_agent) <= 500),
  scanned_at   timestamptz not null default now()
);

comment on table public.tracked_qr_scans is
  'One row per resolution of /r/<code>. No IP, no account — see migration-050 '
  'on why visitor_hash is a hash of a cookie nonce and not an identifier.';

-- The two shapes /admin asks for: "this banner, newest first" drives the 30-day
-- chart, the time-of-day histogram and the first/last-scan pair, and it is also
-- what the unique-visitor count groups within.
create index if not exists idx_tracked_qr_scans_code_time
  on public.tracked_qr_scans (qr_id, scanned_at desc);
create index if not exists idx_tracked_qr_scans_visitor
  on public.tracked_qr_scans (qr_id, visitor_hash) where visitor_hash is not null;

-- ---------- 3. the conversions ----------

create table if not exists public.tracked_qr_signups (
  id         uuid primary key default gen_random_uuid(),
  qr_id      uuid not null references public.tracked_qr_codes (id) on delete cascade,
  user_id    uuid references public.profiles (user_id) on delete set null,
  -- What was actually paid, copied at payout time rather than read back off
  -- tracked_qr_codes.points — an operator who edits the banner's award next
  -- month must not silently rewrite what last month's students were given.
  points     integer not null default 0 check (points >= 0),
  created_at timestamptz not null default now()
);

comment on table public.tracked_qr_signups is
  'Which banner a new account came through. The money itself lives in '
  'community_grants (kind = tracked_qr); this table only answers "which poster". '
  'Cascades on poster delete because the ledger, not this, is the durable record.';

-- ONE ATTRIBUTION PER ACCOUNT. Belt and braces with community_grants'
-- UNIQUE (ref_id, kind): that index stops the money moving twice, this one
-- stops a second banner claiming credit for the same student if the payout was
-- zero-points (a track-only banner writes no grant at all, so it has no other
-- guard).
create unique index if not exists idx_tracked_qr_signups_once
  on public.tracked_qr_signups (user_id) where user_id is not null;
create index if not exists idx_tracked_qr_signups_code
  on public.tracked_qr_signups (qr_id, created_at desc);

-- ---------- 4. server-only, like every other money-adjacent table ----------

alter table public.tracked_qr_codes   enable row level security;
alter table public.tracked_qr_scans   enable row level security;
alter table public.tracked_qr_signups enable row level security;

grant all privileges on public.tracked_qr_codes   to service_role;
grant all privileges on public.tracked_qr_scans   to service_role;
grant all privileges on public.tracked_qr_signups to service_role;
grant usage, select on sequence public.tracked_qr_scans_id_seq to service_role;

revoke all privileges on public.tracked_qr_codes   from anon, authenticated;
revoke all privileges on public.tracked_qr_scans   from anon, authenticated;
revoke all privileges on public.tracked_qr_signups from anon, authenticated;
revoke all privileges on sequence public.tracked_qr_scans_id_seq from anon, authenticated;

-- ---------- 5. what /admin reads ----------

-- PostgREST cannot GROUP BY, so the per-banner roll-up lives here rather than
-- being faked by pulling every scan row into Node and counting them there. That
-- alternative works fine on the day it ships and quietly becomes a whole-table
-- read down the wire once a poster has been up for a term.
--
-- security_invoker so the view can never become a way around the base tables'
-- RLS. Today only service_role can reach either, but a view that ran as its
-- owner would silently outlive that — this is the same trap migration-037 was
-- written to close.
create or replace view public.tracked_qr_overview
with (security_invoker = true) as
select c.id, c.code, c.name, c.note, c.points, c.active,
       c.created_by, c.created_at, c.updated_at,
       coalesce(s.scans, 0)          as scans,
       coalesce(s.uniques, 0)        as uniques,
       s.first_scan,
       s.last_scan,
       coalesce(g.signups, 0)        as signups,
       coalesce(g.points_awarded, 0) as points_awarded
  from public.tracked_qr_codes c
  left join lateral (
    select count(*)                        as scans,
           count(distinct s2.visitor_hash) as uniques,
           min(s2.scanned_at)              as first_scan,
           max(s2.scanned_at)              as last_scan
      from public.tracked_qr_scans s2
     where s2.qr_id = c.id
  ) s on true
  left join lateral (
    select count(*)                     as signups,
           coalesce(sum(g2.points), 0)  as points_awarded
      from public.tracked_qr_signups g2
     where g2.qr_id = c.id
  ) g on true;

comment on view public.tracked_qr_overview is
  'One row per tracked QR with its scan/unique/signup roll-up. See migration-050.';

grant select on public.tracked_qr_overview to service_role;
revoke all privileges on public.tracked_qr_overview from anon, authenticated;

-- The two shapes behind one banner's detail panel, in one round trip.
--
-- ⚠ TIMEZONE IS NOT COSMETIC HERE. Scans are stored in UTC, and Penn State is
-- four or five hours behind it depending on the month. Bucketing by UTC would
-- push every evening scan into the next day and put the "when do people scan
-- this poster" histogram out by a third of a day — an operator reading it would
-- conclude the lunch rush happens at breakfast. The default is the campus zone
-- rather than the server's, because the server's is an accident of hosting.
create or replace function public.tracked_qr_detail(
  p_qr_id uuid,
  p_days  integer default 30,
  p_tz    text default 'America/New_York'
)
returns jsonb
language sql stable
as $$
  with bounds as (
    select greatest(1, least(coalesce(p_days, 30), 365)) as days
  ),
  days as (
    select (date_trunc('day', (now() at time zone p_tz)) - make_interval(days => g))::date as day
      from bounds, generate_series(0, (select days from bounds) - 1) as g
  ),
  scans as (
    select (s.scanned_at at time zone p_tz)::date as day,
           extract(hour from (s.scanned_at at time zone p_tz))::int as hour
      from public.tracked_qr_scans s
     where s.qr_id = p_qr_id
       and s.scanned_at >= now() - make_interval(days => (select days from bounds))
  )
  select jsonb_build_object(
    'days', (select days from bounds),
    'timezone', p_tz,
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'scans', coalesce(n.c, 0)) order by d.day), '[]'::jsonb)
        from days d
        left join (select day, count(*) as c from scans group by day) n on n.day = d.day
    ),
    'hourly', (
      select coalesce(jsonb_agg(jsonb_build_object('hour', h.h, 'scans', coalesce(n.c, 0)) order by h.h), '[]'::jsonb)
        from generate_series(0, 23) as h(h)
        left join (select hour, count(*) as c from scans group by hour) n on n.hour = h.h
    )
  );
$$;

comment on function public.tracked_qr_detail(uuid, integer, text) is
  'The 30-day daily series and hour-of-day histogram behind one QR''s detail '
  'panel in /admin, bucketed in the campus timezone. See migration-050.';

revoke execute on function public.tracked_qr_detail(uuid, integer, text) from public, anon, authenticated;
grant  execute on function public.tracked_qr_detail(uuid, integer, text) to service_role;

commit;
