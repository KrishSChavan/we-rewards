-- ============================================================
-- Migration 053 — Ambassadors.
--
--   A person, not a wall. An operator signs somebody up to spread the app,
--   gives them a short code they picked themselves, and hands them a QR. The
--   code goes in their Instagram bio and on the back of their phone; the
--   operator reads back how many people scanned it and how many of those became
--   students.
--
--   AN AMBASSADOR IS PAID FOR A RECRUIT, INTO THEIR OWN STUDENT ACCOUNT. The
--   operator sets a per-signup rate on the row; when somebody creates an account
--   through that code, the ambassador is credited that many community points.
--   No new SQL moves points: grant_community_points (migration-039) pays every
--   one of these, so the migration-025 write guard, the ledger and the
--   idempotency index all apply here exactly as they do to the referral, the
--   signup bonus and the poster QR.
--
--   ⚠ THE AMBASSADOR MUST ALREADY HAVE AN ACCOUNT, and that is why `user_id`
--   exists. grant_community_points refuses a p_user_id with no profiles row
--   (GRANT_STUDENT_UNKNOWN), so an ambassador with no account is one whose
--   earnings would fail silently at every signup. The admin form therefore
--   resolves the account from the email AT CREATE TIME and refuses if there
--   isn't one. The column is a real FK rather than a repeated email lookup
--   because profiles.email is neither unique nor not-null — it is a copy of the
--   auth address, so matching on it at payout time would be matching on text
--   that nothing in the schema defends.
--
--   THE IDEMPOTENCY KEY IS THE RECRUIT, NOT THE AMBASSADOR. A payout is written
--   with ref_id = the NEW STUDENT and kind = 'ambassador', so 039's
--   UNIQUE (ref_id, kind) index means one ambassador payout per account created,
--   for good. That is the shape that pays an ambassador many times (once per
--   distinct recruit) while making it impossible to pay twice for the same one.
--   Same rail, same guarantee, as the poster QR's kind = 'tracked_qr'.
--
--   NO INCENTIVES ROW, AND THEREFORE NO SHARED BUDGET CEILING — the same
--   trade migration-050 made and for the same reason: incentives carry a
--   one-active-deal-per-kind index, so every ambassador would have had to share
--   one row and one budget. The guards instead are the per-ambassador rate cap
--   below (5000, matching signup-bonus.js's POINTS_MAX) and
--   grant_community_points' own 100000 typo stop. ⚠ THERE IS NO LIFETIME CAP
--   PER AMBASSADOR: a 5000-point rate times a thousand recruits is five million
--   points, and nothing here stops it. If a ceiling is ever wanted, add
--   'ambassador' to the incentives kind CHECK the way 040 did and pass
--   p_incentive_id from the evaluator.
--
--   WHY THIS IS NOT JUST A ROW IN tracked_qr_codes. It nearly is, and the two
--   are close enough that they share a URL rail (see below). They differ in
--   three ways that each cost a column or a rule:
--
--     the code is CHOSEN, not minted. An operator types SARAH7 because the
--     ambassador has to say it out loud. tracked_qr_codes.code is 8 random
--     characters from a deliberately unambiguous alphabet, and the mint loop in
--     src/lib/tracked-qr.js depends on that being true.
--
--     an ambassador is a PERSON, so the row carries a name, an email and a
--     phone number, and the email is unique because it is how the operator
--     tells two people apart.
--
--     a banner is paused when the money should stop but the vinyl is still on a
--     wall. An ambassador is paused when they stop being an ambassador, and
--     then the link should stop working — so `active` here gates the REDIRECT,
--     not a payout. That is the opposite of tracked_qr_codes.active and is the
--     single most important difference to keep straight.
--
--   THEY SHARE /r/<code>, AND THAT IS ON PURPOSE. src/routes/tracked-qr.js
--   tries a banner code first and falls through to an ambassador code. One
--   printed-URL rail means one rate limiter, one no-store header, one service
--   worker exemption and one URIError guard — every one of which was learned
--   the hard way in that file and none of which would be got right twice. The
--   two code shapes cannot be confused by a reader (8 lowercase vs 3-10
--   uppercase) and the resolver tries them in a fixed order, so a code that
--   somehow satisfied both would always resolve to the banner. The guard
--   against that is in Node: creating an ambassador whose code collides with a
--   banner's is refused. The reverse (a minted banner code landing on an
--   existing ambassador's) is 1 in 31^8 and is left to the resolver order.
--
--   PRIVACY, same as migration-050: a scan row holds no IP and no account.
--   visitor_hash is the SHA-256 of a random nonce this server minted into a
--   cookie on the visitor's own device. It counts a returning phone without
--   naming it and is worth nothing to anyone who steals the table.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-052. Safe to re-run.
-- ============================================================

begin;

-- ---------- 1. the people ----------

create table if not exists public.ambassadors (
  id         uuid primary key default gen_random_uuid(),

  -- What travels inside the shared URL: /r/<code>. TYPED BY THE OPERATOR, not
  -- minted, which is why every rule about it lives in a CHECK rather than in a
  -- generator. Stored already-uppercased so plain UNIQUE is a case-insensitive
  -- uniqueness check — the alternative, a unique index on upper(code), would
  -- let two spellings of one code sit in the table and let the WRONG one be
  -- displayed back on the row and printed into a QR.
  code       text not null unique
             check (code = upper(code) and code ~ '^[A-Z0-9]{3,10}$'),

  -- The person. Shown in /admin and nowhere else; students never see any of
  -- these three, only the QR.
  name       text not null check (btrim(name) <> '' and length(name) <= 80),

  -- Unique for the same reason the code is: it is how the operator tells two
  -- ambassadors apart, and the admin form promises a clear "that email is
  -- already an ambassador" rather than a second row nobody notices. Lowercased
  -- on the way in, for the same reason the code is uppercased.
  email      text not null unique
             check (email = lower(email) and length(email) <= 254
                    and position('@' in email) > 1),

  -- Optional, and stored however it was typed. This is dialled by a human, so a
  -- plausible-looking string beats a strict format that rejects the way
  -- somebody actually writes their own number (same reasoning, and the same
  -- cap, as vendors.phone in migration-049).
  phone      text check (phone is null or length(phone) between 7 and 20),

  -- ⚠ NOT THE SAME MEANING AS tracked_qr_codes.active. False here STOPS THE
  -- LINK: /r/<code> redirects home and records nothing, because an ambassador
  -- who has stopped being one should stop recruiting. A banner's flag only ever
  -- gated money, because a banner is bolted to a wall and cannot be recalled;
  -- a person can simply be told they are finished. Their history stays.
  active     boolean not null default true,

  -- WHO GETS PAID. Resolved from `email` by the admin form at create time and
  -- re-resolved whenever the email changes; see the header. ON DELETE SET NULL
  -- rather than CASCADE, deliberately: an ambassador who deletes their student
  -- account has not stopped being an ambassador, their code is still in someone's
  -- bio, and their scan history is still the operator's data. They simply stop
  -- earning, which the admin row says out loud.
  user_id    uuid references public.profiles (user_id) on delete set null,

  -- What one signup through this code pays the ambassador. ZERO IS A REAL
  -- SETTING and the reason this is not `> 0`: an ambassador can be added purely
  -- to measure who they bring in, with no money attached — and the evaluator
  -- skips grant_community_points entirely at 0, because that function refuses
  -- a non-positive amount. The ceiling matches signup-bonus.js's POINTS_MAX
  -- rather than the grant function's 100000 typo stop.
  points     integer not null default 0 check (points >= 0 and points <= 5000),

  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ⚠ FOR A DATABASE THAT ALREADY HAS THE FIRST CUT OF THIS MIGRATION. The
-- create above is `if not exists`, so on a database where the table is already
-- there it does nothing at all — including not adding the two columns. This
-- migration was amended before it had been applied anywhere, but "anywhere" is
-- a claim about the world, not about the schema, and the cost of being wrong is
-- the silent kind: every payout would fail on a missing column. Cheap to make
-- that impossible.
alter table public.ambassadors
  add column if not exists user_id uuid references public.profiles (user_id) on delete set null;
alter table public.ambassadors
  add column if not exists points integer not null default 0;
do $$
begin
  alter table public.ambassadors
    add constraint ambassadors_points_check check (points >= 0 and points <= 5000);
exception when duplicate_object then null;
end $$;

comment on table public.ambassadors is
  'One row per person recruiting for the app. `code` is the public token in '
  '/r/<code>, chosen by the operator rather than minted. Pays nothing — see '
  'migration-053.';
comment on column public.ambassadors.active is
  'False stops the link: /r/<code> redirects home and records no scan. This is '
  'the OPPOSITE of tracked_qr_codes.active, which only ever paused a payout.';
comment on column public.ambassadors.user_id is
  'The student account this ambassador is PAID INTO, resolved from email at '
  'create time. Null means they have no account and cannot earn. See migration-053.';
comment on column public.ambassadors.points is
  'Community points paid to THIS AMBASSADOR for each account created through '
  'their code. 0 means measure them and pay nothing.';

-- The admin list wants to warn when an ambassador has no account to be paid
-- into, and the evaluator looks the row up by code, not by user. Partial, since
-- the null case is the one the list singles out rather than joins on.
create index if not exists idx_ambassadors_user
  on public.ambassadors (user_id) where user_id is not null;

-- Newest first is the only order the admin list asks for.
create index if not exists idx_ambassadors_created
  on public.ambassadors (created_at desc);

-- ---------- 2. the traffic ----------

create table if not exists public.ambassador_scans (
  -- bigserial, not uuid: the only high-volume table here, and nothing outside
  -- the database ever names a scan row.
  id             bigserial primary key,
  ambassador_id  uuid not null references public.ambassadors (id) on delete cascade,
  -- SHA-256 of a nonce this server minted into the visitor's own cookie. Null
  -- when the browser refused the cookie, which is real and uninteresting — the
  -- scan still counts, it just cannot be told apart from another.
  visitor_hash   text,
  -- Truncated by the caller. Kept for one reason: telling a phone camera apart
  -- from the crawler that followed the link out of someone's group chat.
  user_agent     text check (user_agent is null or length(user_agent) <= 500),
  scanned_at     timestamptz not null default now()
);

comment on table public.ambassador_scans is
  'One row per resolution of an ambassador''s /r/<code>. No IP, no account — '
  'see migration-053 on why visitor_hash is a hash of a cookie nonce.';

create index if not exists idx_ambassador_scans_code_time
  on public.ambassador_scans (ambassador_id, scanned_at desc);
create index if not exists idx_ambassador_scans_visitor
  on public.ambassador_scans (ambassador_id, visitor_hash) where visitor_hash is not null;

-- ---------- 3. the conversions ----------

create table if not exists public.ambassador_signups (
  id             uuid primary key default gen_random_uuid(),
  ambassador_id  uuid not null references public.ambassadors (id) on delete cascade,
  user_id        uuid references public.profiles (user_id) on delete set null,
  -- What the ambassador was actually paid for THIS recruit, copied at payout
  -- time rather than read back off ambassadors.points. An operator who raises
  -- the rate next month must not silently rewrite what last month's recruits
  -- were worth. Same reasoning as tracked_qr_signups.points (migration-050).
  --
  -- 0 is both "the rate was 0" and "the payout failed", which the row alone
  -- cannot tell apart. That is deliberate: community_grants is the money's
  -- record, and a failure is logged, so this column is a report and never an
  -- input to one.
  points         integer not null default 0 check (points >= 0),
  created_at     timestamptz not null default now()
);

-- See the note on ambassadors above: `create table if not exists` adds no
-- column to a table that already exists.
alter table public.ambassador_signups
  add column if not exists points integer not null default 0;

comment on table public.ambassador_signups is
  'Which ambassador a new account came through, and what that recruit paid '
  'them. The money itself lives in community_grants (kind = ambassador); this '
  'table answers "who brought them" and "what was it worth". Cascades on '
  'ambassador delete because the ledger, not this, is the durable record.';

-- ONE ATTRIBUTION PER ACCOUNT. Belt and braces with community_grants'
-- UNIQUE (ref_id, kind): that index stops the MONEY moving twice, this one
-- stops a second ambassador claiming credit for the same student when the rate
-- was zero — a 0-point ambassador writes no grant at all, so the ledger index
-- never sees them and this is their only guard.
create unique index if not exists idx_ambassador_signups_once
  on public.ambassador_signups (user_id) where user_id is not null;
create index if not exists idx_ambassador_signups_code
  on public.ambassador_signups (ambassador_id, created_at desc);

-- ---------- 4. server-only ----------
--
-- Nothing here is money, but the table holds a name, an email and a phone
-- number for a real person, so it is fenced exactly as tightly as the tables
-- that are. The anon key reaches every one of these tables by default on a
-- hosted project (migration-037's cause); the revokes below are what stop that.

alter table public.ambassadors        enable row level security;
alter table public.ambassador_scans   enable row level security;
alter table public.ambassador_signups enable row level security;

grant all privileges on public.ambassadors        to service_role;
grant all privileges on public.ambassador_scans   to service_role;
grant all privileges on public.ambassador_signups to service_role;
grant usage, select on sequence public.ambassador_scans_id_seq to service_role;

revoke all privileges on public.ambassadors        from anon, authenticated;
revoke all privileges on public.ambassador_scans   from anon, authenticated;
revoke all privileges on public.ambassador_signups from anon, authenticated;
revoke all privileges on sequence public.ambassador_scans_id_seq from anon, authenticated;

-- ---------- 5. what /admin reads ----------
--
-- PostgREST cannot GROUP BY, so the per-person roll-up lives here rather than
-- being faked by pulling every scan row into Node and counting them there —
-- which works on the day it ships and quietly becomes a whole-table read down
-- the wire once a code has been in someone's bio for a term.
--
-- security_invoker so the view can never become a way around the base tables'
-- RLS. Today only service_role can reach them, but a view running as its owner
-- would silently outlive that. Same trap migration-037 was written to close.
create or replace view public.ambassador_overview
with (security_invoker = true) as
select a.id, a.code, a.name, a.email, a.phone, a.active, a.points, a.user_id,
       a.created_by, a.created_at, a.updated_at,
       -- Whether there is still an account to pay into. A plain `user_id is not
       -- null` and NOT a join to profiles: the FK is ON DELETE SET NULL, so the
       -- column already tells the truth the moment an account goes away, and a
       -- join would only re-derive it more slowly.
       (a.user_id is not null)       as has_account,
       coalesce(s.scans, 0)          as scans,
       coalesce(s.uniques, 0)        as uniques,
       s.first_scan,
       s.last_scan,
       coalesce(g.signups, 0)        as signups,
       -- What they have actually been paid, summed from what each recruit was
       -- worth AT THE TIME rather than signups * a.points — those two disagree
       -- the moment an operator edits the rate, and only this one is true.
       coalesce(g.points_awarded, 0) as points_awarded
  from public.ambassadors a
  left join lateral (
    select count(*)                        as scans,
           count(distinct s2.visitor_hash) as uniques,
           min(s2.scanned_at)              as first_scan,
           max(s2.scanned_at)              as last_scan
      from public.ambassador_scans s2
     where s2.ambassador_id = a.id
  ) s on true
  left join lateral (
    select count(*)                    as signups,
           coalesce(sum(g2.points), 0) as points_awarded
      from public.ambassador_signups g2
     where g2.ambassador_id = a.id
  ) g on true;

comment on view public.ambassador_overview is
  'One row per ambassador with their scan/unique/signup roll-up, what they have '
  'earned, and whether they still have an account to be paid into. See migration-053.';

grant select on public.ambassador_overview to service_role;
revoke all privileges on public.ambassador_overview from anon, authenticated;

commit;
