-- ============================================================
-- Migration 028 — Punch cards (the "come back tonight" loop for bars).
--   A vendor's terminal shows a ROTATING QR code (new PUNCH tab; the code is a
--   URL signed by the server, new signature every 30 seconds). A student scans
--   it — in the app, or with their phone camera, which deep-links into the app
--   — and gets ONE punch per vendor per business night. A full card becomes a
--   reward the student redeems at the counter, same choreography as the
--   existing 4-digit reward codes.
--
--   WHAT THIS FILE DOES
--   1. vendors gains punch_enabled / punch_target / punch_reward.
--      punch_enabled defaults FALSE — the feature exists for every vendor but
--      is opt-in per vendor, toggled from the terminal's (PIN-gated) Settings.
--   2. punch_cards — one OPEN card per (student, vendor), enforced by a partial
--      unique index. A card completes when punches reach its target (the
--      target is snapshotted at card creation, so a vendor lowering the bar
--      later never mutates an in-flight card). Completed cards pile up until
--      redeemed; the next punch simply opens a fresh card.
--   3. punches — the audit row per punch. The UNIQUE (user_id, vendor_id,
--      business_day) constraint IS the product rule: one punch per student per
--      vendor per business night (the server computes business_day with a 6am
--      boundary, so a 1am punch belongs to the previous night). It is also the
--      replay stop: the same rotating token — or ANY token from the same night
--      — can never punch the same student twice.
--   4. punch_holds — the camera-scan handoff. A phone-camera scan lands on the
--      site signed OUT; sign-in (OAuth + consent) takes longer than the
--      token's 30-second life, so the server first swaps a LIVE token for a
--      single-use hold (10-minute TTL, consumed inside punch_in's own
--      transaction). A hold is BOUND to the browser that minted it: the server
--      sets an httpOnly nonce cookie and stores only its hash here, so a
--      holdId copied out of one browser is inert in another.
--   5. punch_redeem_codes — 4-digit counter codes for a FULL card, minted and
--      consumed exactly like redeem_codes (delete..returning = single use).
--      Separate table on purpose: redeem_codes.reward_id is NOT NULL and joins
--      rewards; a punch reward is vendor text, not a catalog row. Minting
--      checks BOTH code tables so one vendor can't have a live punch code and
--      a live reward code with the same 4 digits (the terminal's typed-code
--      path would otherwise resolve the wrong one).
--   6. RPCs: punch_in, create_punch_hold, create_punch_redeem_code,
--      redeem_punch_card. All SECURITY DEFINER, service_role-only, same
--      posture as the money RPCs.
--
--   WHAT THE ROTATION DOES AND DOESN'T BUY
--   Rotation + the once-per-night unique mean a code can't be screenshotted for
--   later, can't be re-used by the same student, and can't be farmed in bulk
--   (holds are capped per 30-second slot and bound to one browser). What no
--   server-side scheme can prevent is a person AT the venue relaying a live
--   code to a friend in real time — the same hole as handing someone your
--   paper punch card. The design bounds that to one punch per friend per
--   night, which is the honest ceiling for a displayed-QR system.
--
--   WHAT THIS FILE DOES NOT DO
--   • No writes to point_balances / transactions — punches are not points, so
--     nothing here needs the migration-025 guard flag, and the points ledger
--     invariants are untouched.
--   • No trust in the client: the rotating token is HMAC-signed by the server
--     (src/lib/punch.js) and verified server-side before any RPC is called;
--     the RPCs re-check vendor.active + punch_enabled themselves.
--
--   ⚠ DEPLOY ORDER: run this BEFORE deploying the server code that selects
--   punch_enabled / calls these RPCs, or those requests fail on the missing
--   column/function. (The reverse order is safe for the DB — nothing here is
--   called until the server asks.)
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-027. Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE).
-- ============================================================

-- ---------- 1. The vendor's knobs ----------

-- Off by default: every vendor HAS the feature, no vendor is IN it until they
-- flip the switch on their own terminal (Settings is behind the staff PIN).
alter table public.vendors
  add column if not exists punch_enabled boolean not null default false;

comment on column public.vendors.punch_enabled is
  'Punch cards on/off for this vendor (default off). Toggled from the '
  'terminal''s PIN-gated Settings; gates the PUNCH tab, the rotating token, '
  'and punch_in itself.';

alter table public.vendors
  add column if not exists punch_target integer not null default 10
  check (punch_target between 2 and 50);

comment on column public.vendors.punch_target is
  'Punches needed to fill a card. Snapshotted onto each card at creation, so '
  'changing it only affects cards opened afterwards.';

alter table public.vendors
  add column if not exists punch_reward text not null default 'Free reward';

comment on column public.vendors.punch_reward is
  'What a full card earns, as counter-readable text (e.g. "Free cover"). Read '
  'at redeem time, not snapshotted — the vendor honors their CURRENT offer.';

-- ---------- 2. punch_cards ----------

create table if not exists public.punch_cards (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (user_id) on delete cascade,
  vendor_id    uuid not null references public.vendors (id) on delete cascade,
  punches      integer not null default 0 check (punches >= 0),
  target       integer not null check (target between 2 and 50),
  completed_at timestamptz,
  redeemed_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- ONE open card per (student, vendor). Completed cards fall out of the
-- predicate, so they can accumulate unredeemed while a fresh card fills.
create unique index if not exists idx_punch_cards_one_open
  on public.punch_cards (user_id, vendor_id) where (completed_at is null);

create index if not exists idx_punch_cards_user on public.punch_cards (user_id);

-- ---------- 3. punches ----------

create table if not exists public.punches (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (user_id) on delete cascade,
  vendor_id    uuid not null references public.vendors (id) on delete cascade,
  card_id      uuid not null references public.punch_cards (id) on delete cascade,
  business_day date not null,          -- derived from the scanned slot, 6am boundary
  token_window bigint not null,        -- which 30s token slot was scanned (audit)
  created_at   timestamptz not null default now()
);

-- THE rule: one punch per student per vendor per business night. Doubles as
-- the anti-replay backstop — a re-used token can't beat a uniqueness violation.
create unique index if not exists idx_punches_once_per_night
  on public.punches (user_id, vendor_id, business_day);

-- Cascade paths need their own indexes or entity deletion degrades into
-- sequential scans inside the RI triggers: deleting a student cascades
-- profiles → punch_cards → punches (card_id), and deleting a vendor cascades
-- straight into both tables by vendor_id.
create index if not exists idx_punches_card       on public.punches (card_id);
create index if not exists idx_punches_vendor     on public.punches (vendor_id);
create index if not exists idx_punch_cards_vendor on public.punch_cards (vendor_id);

-- ---------- 4. punch_holds (camera-scan → sign-in handoff) ----------

create table if not exists public.punch_holds (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors (id) on delete cascade,
  token_window bigint not null,
  -- sha256 of an httpOnly nonce cookie the mint response sets. The holdId
  -- alone is inert: claiming needs the cookie too, so a holdId forwarded to
  -- another phone can't be spent there.
  binding_hash text,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);

alter table public.punch_holds add column if not exists binding_hash text;

create index if not exists idx_punch_holds_vendor on public.punch_holds (vendor_id);
create index if not exists idx_punch_holds_window on public.punch_holds (vendor_id, token_window);

-- ---------- 5. punch_redeem_codes (full card → 4-digit counter code) ----------

create table if not exists public.punch_redeem_codes (
  code       text primary key,          -- 4-digit 0-9, unique among LIVE codes
  user_id    uuid not null references public.profiles (user_id) on delete cascade,
  vendor_id  uuid not null references public.vendors (id) on delete cascade,
  card_id    uuid not null references public.punch_cards (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_punch_redeem_codes_user on public.punch_redeem_codes (user_id);

-- ---------- RLS ----------
-- Students may read their own cards/punches (harmless, matches point_balances'
-- posture); holds and codes are server-only like earn_codes — RLS on, no
-- policies, so no client can read them at all.

alter table public.punch_cards        enable row level security;
alter table public.punches            enable row level security;
alter table public.punch_holds        enable row level security;
alter table public.punch_redeem_codes enable row level security;

drop policy if exists "own punch cards" on public.punch_cards;
create policy "own punch cards" on public.punch_cards for select using (auth.uid() = user_id);

drop policy if exists "own punches" on public.punches;
create policy "own punches" on public.punches for select using (auth.uid() = user_id);

-- ---------- RPC: punch_in ----------
-- The single write path for a punch, and the ONLY consumer of a hold. Verifying
-- the rotating token's signature + freshness happened server-side
-- (src/lib/punch.js) BEFORE this is called; this function owns everything the
-- database can enforce: the hold's single use and browser binding, the vendor
-- really having punch cards on, the once-per-night unique, and the card
-- lifecycle (open → fill → complete) — all in ONE transaction.
--
-- Why the hold is consumed HERE rather than in its own RPC: two separate
-- transactions meant a transient failure (PUNCH_CARD_RACE, a statement
-- timeout, a dropped connection) burned the hold permanently, stranding a
-- student who had just spent minutes signing in. Now any failure rolls the
-- hold's deletion back with everything else, so the client's retry works.
--
-- BUSINESS DAY is derived here from the SCANNED SLOT, not from the server
-- clock at claim time — the camera-scan flow deliberately spans a sign-in, so
-- a scan at 5:59am and a claim at 6:05am must both count as the earlier night.
-- Computing it in local wall-clock space (at time zone → subtract 6 hours) is
-- also DST-correct, which shifting an absolute instant by 6 hours is not.
-- The `* 30` matches PUNCH_WINDOW_SECONDS in src/lib/punch.js.

create or replace function public.punch_in(
  p_user_id      uuid,
  p_vendor_id    uuid,
  p_token_window bigint,
  p_hold_id      uuid default null,
  p_binding_hash text default null,
  p_timezone     text default 'America/New_York'
)
returns table (
  new_punches    integer,
  card_target    integer,
  card_completed boolean,
  ready_cards    integer,   -- completed + unredeemed cards after this punch
  reward_text    text,
  vendor_id      uuid       -- authoritative: a hold claim derives it, not the caller
)
language plpgsql security definer set search_path = public
as $$
declare
  v_vendor   uuid := p_vendor_id;
  v_window   bigint := p_token_window;
  v_day      date;
  v_active   boolean;
  v_enabled  boolean;
  v_target   integer;
  v_reward   text;
  c_id       uuid;
  c_punches  integer;
  c_target   integer;
  c_done     timestamptz;
  v_constraint text;
begin
  -- A camera-scan claim: consume the hold IN THIS TRANSACTION and take the
  -- vendor + slot from it, never from the caller's arguments. The binding
  -- check is what makes a forwarded holdId inert — the matching nonce lives in
  -- an httpOnly cookie in the browser that minted it.
  if p_hold_id is not null then
    delete from punch_holds ph
    where ph.id = p_hold_id
      and ph.expires_at > now()
      and ph.binding_hash is not distinct from p_binding_hash
    returning ph.vendor_id, ph.token_window into v_vendor, v_window;

    if v_vendor is null then
      raise exception 'HOLD_INVALID';
    end if;
  end if;

  if v_vendor is null or v_window is null then
    raise exception 'PUNCH_INVALID';
  end if;

  v_day := ((to_timestamp(v_window * 30) at time zone p_timezone) - interval '6 hours')::date;

  -- Re-checked here no matter what the token said: a vendor who toggled the
  -- feature off (or was deactivated) between mint and scan is a clean refusal.
  select v.active, v.punch_enabled, v.punch_target, v.punch_reward
    into v_active, v_enabled, v_target, v_reward
  from vendors v
  where v.id = v_vendor;

  if not found or not v_active or not v_enabled then
    raise exception 'PUNCH_DISABLED';
  end if;

  -- Find (and lock) the open card, or open one. The partial unique index makes
  -- the concurrent-create race safe: the loser re-selects the winner's row.
  select pc.id, pc.punches, pc.target
    into c_id, c_punches, c_target
  from punch_cards pc
  where pc.user_id = p_user_id and pc.vendor_id = v_vendor
    and pc.completed_at is null
  for update;

  if not found then
    begin
      insert into punch_cards (user_id, vendor_id, target)
      values (p_user_id, v_vendor, v_target)
      returning punch_cards.id, punch_cards.punches, punch_cards.target
        into c_id, c_punches, c_target;
    exception when unique_violation then
      select pc.id, pc.punches, pc.target
        into c_id, c_punches, c_target
      from punch_cards pc
      where pc.user_id = p_user_id and pc.vendor_id = v_vendor
        and pc.completed_at is null
      for update;
      if not found then
        -- Shouldn't happen (the winner's card was open a moment ago); bail
        -- loudly rather than punch a phantom card.
        raise exception 'PUNCH_CARD_RACE';
      end if;
    end;
  end if;

  -- The product rule + replay stop, enforced by the unique index — not by
  -- anything the client sent. The diagnostics check keeps a DIFFERENT unique
  -- violation (a genuine bug) from being mislabelled as a normal "come back
  -- tomorrow" refusal.
  begin
    insert into punches (user_id, vendor_id, card_id, business_day, token_window)
    values (p_user_id, v_vendor, c_id, v_day, v_window);
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is null or v_constraint = 'idx_punches_once_per_night' then
      raise exception 'ALREADY_PUNCHED';
    end if;
    raise;
  end;

  update punch_cards pc
  set punches      = pc.punches + 1,
      completed_at = case when pc.punches + 1 >= pc.target then now() else null end
  where pc.id = c_id
  returning pc.punches, pc.target, pc.completed_at
    into c_punches, c_target, c_done;

  return query
    select
      c_punches,
      c_target,
      (c_done is not null),
      (select count(*)::integer from punch_cards pc
       where pc.user_id = p_user_id and pc.vendor_id = v_vendor
         and pc.completed_at is not null and pc.redeemed_at is null),
      v_reward,
      v_vendor;
end;
$$;

-- CREATE OR REPLACE only replaces an EXACT signature match. This file's first
-- revision shipped punch_in(uuid, uuid, date, bigint) — before the hold claim
-- was folded in and business_day moved from the server into SQL — so on any
-- database that already ran that revision, the fixed 6-arg version above
-- would sit ALONGSIDE it rather than replacing it: a live, still-granted,
-- unbound overload with none of today's checks. Drop it explicitly.
drop function if exists public.punch_in(uuid, uuid, date, bigint);
revoke execute on function public.punch_in(uuid, uuid, bigint, uuid, text, text) from public, anon, authenticated;
grant  execute on function public.punch_in(uuid, uuid, bigint, uuid, text, text) to service_role;

-- ---------- RPC: create_punch_hold ----------
-- Swaps a live rotating token (already signature-checked by the server) for a
-- single-use, browser-bound hold the student can sit on while they sign in.
-- Expired rows are swept on every call.
--
-- TWO FENCES, because the endpoint that calls this is UNauthenticated:
--   • per-slot cap — one 30-second token can only ever become HOLD_PER_WINDOW
--     holds, so a scanned code can't be inflated into hundreds of credentials.
--     A real line never produces 25 camera scans inside one 30-second slot.
--   • per-vendor ceiling — enforced by EVICTING the oldest live holds, not by
--     refusing the newest. Refusing made the cap itself the denial vector: a
--     flood could pin a vendor at the ceiling and 503 every genuine scan.
-- The vendor row is locked FOR UPDATE first (migration-027's pattern), so the
-- counts below can't be raced past by two concurrent requests.

create or replace function public.create_punch_hold(
  p_vendor_id    uuid,
  p_token_window bigint,
  p_ttl_seconds  integer default 600,
  p_binding_hash text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  hold_per_window constant integer := 25;
  hold_per_vendor constant integer := 300;
  v_enabled boolean;
  v_active  boolean;
  h_id      uuid;
begin
  -- FOR UPDATE serializes hold creation per vendor: without it the count
  -- checks below are a racy read-then-insert and a parallel burst overshoots.
  select v.active, v.punch_enabled into v_active, v_enabled
  from vendors v where v.id = p_vendor_id
  for update;
  if not found or not v_active or not v_enabled then
    raise exception 'PUNCH_DISABLED';
  end if;

  -- Housekeeping, scoped to this vendor and run AFTER the row lock above —
  -- and never before it. An unscoped sweep across every vendor takes
  -- punch_holds row locks before the vendors row lock, the opposite order
  -- from the eviction DELETE a few lines down; two calls for different
  -- vendors racing those two lock classes in opposite orders is a textbook
  -- Postgres deadlock (40P01), which would surface to an unauthenticated
  -- camera scanner as a bare 500.
  delete from punch_holds where vendor_id = p_vendor_id and expires_at < now();

  if (select count(*) from punch_holds
      where vendor_id = p_vendor_id and token_window = p_token_window) >= hold_per_window then
    raise exception 'HOLD_LIMIT';
  end if;

  -- Make room rather than refuse: the newest scan is the one standing at the
  -- counter, so anything evicted here is the oldest and least likely to matter.
  delete from punch_holds
  where id in (
    select id from punch_holds
    where vendor_id = p_vendor_id
    order by created_at desc
    offset hold_per_vendor - 1
  );

  insert into punch_holds (vendor_id, token_window, expires_at, binding_hash)
  values (
    p_vendor_id,
    p_token_window,
    now() + make_interval(secs => least(greatest(p_ttl_seconds, 60), 900)),
    p_binding_hash
  )
  returning id into h_id;

  return h_id;
end;
$$;

-- The 3-arg version from this file's first revision would keep working as an
-- unbound overload (holds with no binding_hash), so drop it explicitly.
drop function if exists public.create_punch_hold(uuid, bigint, integer);
revoke execute on function public.create_punch_hold(uuid, bigint, integer, text) from public, anon, authenticated;
grant  execute on function public.create_punch_hold(uuid, bigint, integer, text) to service_role;

-- ---------- claim_punch_hold: REMOVED ----------
-- Claiming used to be its own RPC, which meant the hold was consumed and
-- COMMITTED before punch_in ran in a second transaction — so a transient
-- failure (PUNCH_CARD_RACE, a timeout) burned the hold permanently and the
-- student's only recovery was walking back to the terminal. punch_in now
-- consumes the hold itself, inside the same transaction as the punch.
drop function if exists public.claim_punch_hold(uuid);

-- ---------- RPC: create_punch_redeem_code ----------
-- Mints the 4-digit counter code for the student's OLDEST completed,
-- unredeemed card. Same shape as create_redeem_code: one live punch code per
-- (student, vendor) so the 4-digit space stays clear, unique among live codes.
--
-- It also rejects any candidate that collides with a LIVE reward code at this
-- vendor. The two kinds live in different tables, but they share one 4-digit
-- space at the counter: the terminal's typed-code path tries reward codes
-- first, so a collision would silently redeem someone else's reward (their
-- points burned, their item handed to the wrong student) while the punch card
-- stayed full. create_redeem_code gets the symmetric check below.

create or replace function public.create_punch_redeem_code(
  p_user_id     uuid,
  p_vendor_id   uuid,
  p_ttl_seconds integer default 120
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  c_card    uuid;
  candidate text;
  attempts  integer := 0;
begin
  delete from punch_redeem_codes where expires_at < now();   -- housekeeping
  delete from punch_redeem_codes
    where user_id = p_user_id and vendor_id = p_vendor_id;   -- one live code here

  select pc.id into c_card
  from punch_cards pc
  where pc.user_id = p_user_id and pc.vendor_id = p_vendor_id
    and pc.completed_at is not null and pc.redeemed_at is null
  order by pc.completed_at asc
  limit 1;

  if c_card is null then
    raise exception 'PUNCH_CARD_NOT_READY';
  end if;

  loop
    attempts := attempts + 1;
    candidate := lpad((floor(random() * 10000))::int::text, 4, '0');
    -- Lock this exact (vendor, candidate) pair before checking it: a plain
    -- EXISTS against a table this function doesn't own is a check-then-insert
    -- race under READ COMMITTED — two concurrent redemptions could each pass
    -- the other's check before either commits, and both codes land live. The
    -- advisory lock is transaction-scoped (released automatically at commit
    -- or rollback) and only ever contends with another mint racing the SAME
    -- candidate at the SAME vendor, so it costs nothing outside that overlap.
    perform pg_advisory_xact_lock(hashtext(p_vendor_id::text), hashtext(candidate));
    -- Skip anything a reward code is already using at this vendor tonight.
    if exists (
      select 1 from redeem_codes rc
      where rc.code = candidate and rc.vendor_id = p_vendor_id and rc.expires_at > now()
    ) then
      if attempts > 500 then raise exception 'CODE_SPACE_EXHAUSTED'; end if;
      continue;
    end if;
    begin
      insert into punch_redeem_codes (code, user_id, vendor_id, card_id, expires_at)
      values (candidate, p_user_id, p_vendor_id, c_card, now() + make_interval(secs => p_ttl_seconds));
      return candidate;
    exception when unique_violation then
      if attempts > 500 then raise exception 'CODE_SPACE_EXHAUSTED'; end if;
    end;
  end loop;
end;
$$;

revoke execute on function public.create_punch_redeem_code(uuid, uuid, integer) from public, anon, authenticated;
grant  execute on function public.create_punch_redeem_code(uuid, uuid, integer) to service_role;

-- ---------- RPC: redeem_punch_card ----------
-- Consume the code + retire the card in one transaction. A double-submit finds
-- no code the second time; any failure rolls back the delete so the code stays
-- live (mirroring redeem_by_code exactly).

create or replace function public.redeem_punch_card(p_code text, p_vendor_id uuid)
returns table (reward_text text, customer_id uuid, card_target integer)
language plpgsql security definer set search_path = public
as $$
declare
  c_user   uuid;
  c_card   uuid;
  v_reward text;
  v_target integer;
begin
  delete from punch_redeem_codes prc
  where prc.code = p_code and prc.vendor_id = p_vendor_id and prc.expires_at > now()
  returning prc.user_id, prc.card_id into c_user, c_card;

  if c_user is null then
    raise exception 'CODE_INVALID';
  end if;

  update punch_cards pc
  set redeemed_at = now()
  where pc.id = c_card and pc.completed_at is not null and pc.redeemed_at is null
  returning pc.target into v_target;

  if not found then
    -- Card vanished or was already redeemed under a stale code: refuse, and the
    -- rollback un-consumes the code (which is then just as dead — fine).
    raise exception 'CODE_INVALID';
  end if;

  select v.punch_reward into v_reward from vendors v where v.id = p_vendor_id;

  return query select v_reward, c_user, v_target;
end;
$$;

revoke execute on function public.redeem_punch_card(text, uuid) from public, anon, authenticated;
grant  execute on function public.redeem_punch_card(text, uuid) to service_role;

-- ---------- create_redeem_code — the other half of the shared 4-digit space ----------
-- Verbatim migration-006's body (the latest — one live code per student PER
-- VENDOR, not globally), plus the mirror of the check above: a reward code
-- must not collide with a LIVE punch code at the same vendor. Both halves are
-- needed — whichever kind is minted second is the one that must yield.
--
-- ⚠ ORDERING FOOTGUN, the usual one: re-running migration-003 or 006 restores
-- an unguarded body. Re-run THIS file afterwards.

create or replace function public.create_redeem_code(
  p_user_id uuid, p_vendor_id uuid, p_reward_id uuid, p_ttl_seconds integer default 120
) returns text
language plpgsql security definer set search_path = public
as $$
declare
  candidate text;
  attempts  integer := 0;
begin
  delete from redeem_codes where expires_at < now();        -- housekeeping
  -- one live code per student PER VENDOR: re-tapping Redeem at the same spot
  -- replaces that spot's code, but codes pending at other vendors survive
  delete from redeem_codes where user_id = p_user_id and vendor_id = p_vendor_id;

  loop
    attempts := attempts + 1;
    candidate := lpad((floor(random() * 10000))::int::text, 4, '0');
    -- Same advisory-lock reasoning as create_punch_redeem_code's mirror check
    -- — a plain EXISTS across tables is a TOCTOU race between two concurrent
    -- mints without it.
    perform pg_advisory_xact_lock(hashtext(p_vendor_id::text), hashtext(candidate));
    -- Skip anything a punch-card code is already using at this vendor tonight
    -- (see create_punch_redeem_code for why the two spaces must not overlap).
    if exists (
      select 1 from punch_redeem_codes prc
      where prc.code = candidate and prc.vendor_id = p_vendor_id and prc.expires_at > now()
    ) then
      if attempts > 500 then raise exception 'CODE_SPACE_EXHAUSTED'; end if;
      continue;
    end if;
    begin
      insert into redeem_codes (code, user_id, vendor_id, reward_id, expires_at)
      values (candidate, p_user_id, p_vendor_id, p_reward_id, now() + make_interval(secs => p_ttl_seconds));
      return candidate;
    exception when unique_violation then
      if attempts > 500 then raise exception 'CODE_SPACE_EXHAUSTED'; end if;
    end;
  end loop;
end;
$$;

revoke execute on function public.create_redeem_code(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant  execute on function public.create_redeem_code(uuid, uuid, uuid, integer) to service_role;
