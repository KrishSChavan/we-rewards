-- ============================================================
-- Migration 057 — Link a student email to a personal account.
--
--   THE PROBLEM, quoted from src/lib/signup-bonus.js:
--
--     "⚠ THE FLIPSIDE … a student who signs in with a personal Gmail gets
--      nothing, and there is no way for them to fix it after the fact short of
--      deleting the account."
--
--   That is the hole this closes. A student who signed in with a personal
--   address proves they hold a .psu.edu one, and either
--
--     A. LINK  — the address has no account of its own. We record the claim and
--        pay the signup bonus that their personal sign-in missed.
--     B. MERGE — the address already has its own account. Everything that
--        account holds moves into the one they are signed into, and the old one
--        is closed. Points, community points, visit counters and history all land
--        in one place, and the union of the two accounts' visited spots falls
--        out for free (student_visited_vendor_ids reads transactions and
--        punch_cards, both of which get re-pointed here).
--
--   WHAT THIS FILE ADDS
--   1. profiles.linked_email / linked_email_at  — the verified address, shown
--      in Account and used to decide the feature is done.
--   2. community_grants.voided_at               — the clawback marker (see 6).
--   3. student_email_claims  — ONE ROW PER ADDRESS, FOREVER. The bonus fence:
--      an address can be bonused exactly once in the lifetime of the deployment,
--      whoever links it and however many times it is unlinked and relinked.
--      Also what lets a later sign-in with a merged-away address be recognised
--      instead of quietly minting a blank account.
--   4. student_email_codes + issue/begin/consume — the one-time code mailed to
--      the address. Deliberately a copy of migration-031's vendor reset codes,
--      down to the attempt accounting, because that shape has been in
--      production and the failure modes are known.
--   5. account_merges  — the audit row. A merge is irreversible, so the record
--      of what moved is the only thing support can work from afterwards.
--   6. preview_student_merge() / merge_student_accounts() — the dry run the app
--      shows before the confirm, and the merge itself. One transaction, both
--      profiles locked, every money table written through the migration-025
--      guard.
--
--   ⚠ DEPLOY ORDER: run this BEFORE the server code that calls these functions.
--   The reverse order leaves POST /api/me/student-email/* 500ing on a missing
--   function. Nothing here is called until the server asks, so the DB is safe
--   ahead of the deploy.
--
--   ⚠ THE USUAL ORDERING FOOTGUN: this file does NOT touch award_points,
--   grant_community_points or reverse_transaction. Re-running schema.sql or
--   004/005/010/019/025 still restores older bodies of those — re-run 026/045
--   afterwards, as their own headers say. This file stays valid either way.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-056. Safe to re-run.
-- ============================================================

begin;

-- ---------- 1. the address on the profile ----------
-- The linked address is NOT profiles.email. That column holds the identity they
-- sign in with, it is what the admin roster searches, and overwriting it would
-- quietly change which address a deal email goes to. This is a second,
-- verified-by-us fact about the same person, and keeping them apart is what
-- lets Account show both lines honestly: "signed in as X, student email Y".

alter table public.profiles
  add column if not exists linked_email    text,
  add column if not exists linked_email_at timestamptz;

comment on column public.profiles.linked_email is
  'A .psu.edu address this student proved they hold, verified by a mailed code. '
  'Never the sign-in identity — see profiles.email for that. Migration-057.';

-- ---------- 2. the clawback marker ----------
-- grant_community_points has no undo, and community_grants.points is CHECK
-- (points > 0), so a reversal cannot be written as a negative row. It is marked
-- instead: the row stays (the ledger has to keep adding up, same reasoning as
-- migration-039's ON DELETE SET NULL) and the balance is decremented alongside.
-- The UNIQUE (ref_id, kind) index is deliberately NOT relaxed for voided rows —
-- a clawed-back referral must never be payable a second time.

alter table public.community_grants
  add column if not exists voided_at     timestamptz,
  add column if not exists voided_reason text;

comment on column public.community_grants.voided_at is
  'Set when a grant was reversed and the points taken back off the balance. '
  'Today the only writer is merge_student_accounts, unwinding a referral whose '
  'two sides turned out to be one person. Migration-057.';

-- ---------- 3. student_email_claims ----------
--
-- WHY A TABLE AND NOT JUST THE PROFILE COLUMN. profiles.linked_email answers
-- "what is linked right now". This answers "has this address ever been linked,
-- and was it paid" — a different question with a different lifetime, and the
-- one the money depends on. Without it:
--
--   link psu address → collect the bonus → unlink → link it to a second
--   account → collect it again, forever.
--
-- The row therefore OUTLIVES both the link and the account. released_at marks an
-- unlink (the address becomes claimable again) and bonus_points stays put, so
-- the second claim links fine and pays nothing.
--
-- email_norm is the key, not email: see normalizeStudentEmail() in
-- src/lib/student-email.js. A +tag delivers to the same inbox, so without
-- folding it "abc123+1@psu.edu" and "abc123+2@psu.edu" are two bonuses out of
-- one mailbox.

create table if not exists public.student_email_claims (
  email_norm   text primary key,
  -- As verified, for display. The code went to THIS spelling.
  email        text not null,
  -- Who holds it now. SET NULL rather than CASCADE for the reason above: the
  -- row is the fence, and a deleted account must not reopen the bonus.
  user_id      uuid references public.profiles (user_id) on delete set null,
  -- What the link actually paid, so the fence is auditable rather than a flag.
  -- 0 is a real value: linked while no program was live, or after its budget ran
  -- out. Those addresses stay eligible if a program starts later, which is why
  -- the fence tests bonus_points > 0 and not merely "a row exists".
  bonus_points integer not null default 0 check (bonus_points >= 0),
  -- The auth user absorbed by a merge, if this claim was a merge rather than a
  -- plain link. Kept after that account is gone: it is how a later sign-in with
  -- this address is recognised as "already part of someone's account".
  merged_from  uuid,
  verified_at  timestamptz not null default now(),
  released_at  timestamptz
);

comment on table public.student_email_claims is
  'One row per student email address ever verified, kept forever. The '
  'once-per-address bonus fence, and the record that lets a merged-away '
  'address be recognised at a later sign-in. Migration-057.';

-- "Is this address spoken for?" — the read every link attempt starts with.
create index if not exists idx_student_email_claims_live
  on public.student_email_claims (user_id) where released_at is null;

-- ONE linked address per account. A student with two .psu.edu addresses picks
-- one; letting them stack claims would make the bonus fence per-address while
-- the payout stayed per-account, which is the same farm with extra steps.
create unique index if not exists idx_student_email_claims_one_per_user
  on public.student_email_claims (user_id)
  where user_id is not null and released_at is null;

alter table public.student_email_claims enable row level security;
grant all privileges on public.student_email_claims to service_role;
revoke all privileges on public.student_email_claims from anon, authenticated;

-- ---------- 4. student_email_codes ----------
-- migration-031's vendor_password_resets, re-cut for a student linking an
-- address. Same columns, same attempt accounting, same deny-all posture. The
-- differences are both deliberate:
--   • keyed on user_id, not on an address — the code proves a SIGNED-IN student
--     holds an inbox, so the guess is always spent against their own code and
--     there is no address to enumerate.
--   • email_norm rides along so consume() knows what was actually proved, and a
--     student cannot start a code for one address and finish it against another.

create table if not exists public.student_email_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (user_id) on delete cascade,
  email      text not null,
  email_norm text not null,
  code_hash  text not null,
  attempts   integer not null default 0,
  expires_at timestamptz not null,
  -- THE TWO-PHASE BIT. A correct code does not always finish the job: where the
  -- address turns out to have its own account, the student is shown what a
  -- merge would move and asked to confirm, and only then is anything done. So a
  -- code that has been PROVED is marked here and stays live (used_at still
  -- null) until the confirm spends it.
  --
  -- Why not just consume it at verify and trust the client to come back: the
  -- confirm needs to know WHICH account was proved, and handing the client that
  -- id to pass back would make "merge any account into mine" a parameter.
  -- Keeping it in this row means the id never leaves the server.
  verified_at timestamptz,
  used_at    timestamptz,               -- set on success, on burn, or on supersede
  created_at timestamptz not null default now()
);

-- `create table if not exists` above adds nothing on a re-run, so a deployment
-- that applied an earlier cut of this file still gets the column.
alter table public.student_email_codes
  add column if not exists verified_at timestamptz;

-- The only lookup: the live code for one student. Partial on used_at so the
-- index stays small as spent rows pile up.
create index if not exists idx_student_email_codes_live
  on public.student_email_codes (user_id, created_at desc)
  where used_at is null;

alter table public.student_email_codes enable row level security;
grant all privileges on public.student_email_codes to service_role;
revoke all privileges on public.student_email_codes from anon, authenticated;

-- ---------- 4a. issue ----------
-- Node hashes the plaintext and passes the hash. Supersedes anything already
-- outstanding for this student, so exactly one code is live at a time —
-- otherwise a code read off an old email still works after a new one is sent.
--
-- The cooldown is the fence that survives IP rotation (the express-rate-limit
-- cap in server.js does not). Returns zero rows when it is still in force, and
-- the caller renders that as the same "check your email" sentence a real send
-- gets: a student who taps twice should not learn anything from the difference.

create or replace function public.student_email_code_issue(
  p_user_id         uuid,
  p_email           text,
  p_email_norm      text,
  p_code_hash       text,
  p_ttl_minutes     integer default 15,
  p_cooldown_secs   integer default 60
)
returns table (code_id uuid, code_email text, code_expires_at timestamptz)
language plpgsql security definer set search_path = public
as $$
declare
  v_expires timestamptz := now() + make_interval(mins => greatest(coalesce(p_ttl_minutes, 15), 1));
begin
  if p_user_id is null or coalesce(btrim(p_email_norm), '') = '' or coalesce(btrim(p_code_hash), '') = '' then
    raise exception 'LINK_CODE_INVALID';
  end if;

  -- Still cooling down? Say nothing and send nothing.
  if exists (
    select 1 from student_email_codes
     where user_id = p_user_id
       and created_at > now() - make_interval(secs => greatest(coalesce(p_cooldown_secs, 60), 1))
  ) then
    return;
  end if;

  update student_email_codes
     set used_at = now()
   where user_id = p_user_id and used_at is null;

  return query
  insert into public.student_email_codes (user_id, email, email_norm, code_hash, expires_at)
  values (p_user_id, btrim(p_email), lower(btrim(p_email_norm)), p_code_hash, v_expires)
  returning id, email, expires_at;
end;
$$;

-- ---------- 4b. begin a guess ----------
-- Verbatim in shape from vendor_reset_begin (migration-031:137), including the
-- reason the burn lands on attempt cap+1 rather than cap: burning at the cap
-- would kill the code on a last try that is CORRECT.

create or replace function public.student_email_code_begin(
  p_user_id      uuid,
  p_max_attempts integer default 5
)
returns table (
  code_id         uuid,
  code_email      text,
  code_email_norm text,
  code_hash       text,
  code_burned     boolean
)
language sql security definer set search_path = public
as $$
  with target as (
    select c.id
      from public.student_email_codes c
     where c.user_id = p_user_id
       and c.used_at is null
       and c.expires_at > now()
     order by c.created_at desc
     limit 1
  ),
  bumped as (
    update public.student_email_codes c
       set attempts = c.attempts + 1,
           used_at  = case
                        when c.attempts + 1 > greatest(coalesce(p_max_attempts, 5), 1)
                        then now() else c.used_at
                      end
     where c.id = (select id from target)
    returning c.id, c.email, c.email_norm, c.code_hash, c.attempts
  )
  select b.id,
         b.email,
         b.email_norm,
         case when b.attempts > greatest(coalesce(p_max_attempts, 5), 1)
              then null else b.code_hash end,
         b.attempts > greatest(coalesce(p_max_attempts, 5), 1)
    from bumped b;
$$;

-- ---------- 4c. mark proved ----------
-- Called when Node's bcrypt comparison succeeded but the work is not done —
-- the address has its own account and the student has yet to confirm the merge.
-- The code stays live; this only records that it was proved.

create or replace function public.student_email_code_verify(p_id uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare marked uuid;
begin
  update public.student_email_codes
     set verified_at = coalesce(verified_at, now())
   where id = p_id and used_at is null and expires_at > now()
  returning id into marked;
  return marked is not null;
end;
$$;

-- ---------- 4d. the proved-but-unspent code ----------
-- How the confirm step learns WHICH address was proved without the client ever
-- being told, let alone being able to choose. Returns at most one row: issue()
-- supersedes, so a student has one live code at a time.

create or replace function public.student_email_code_pending(p_user_id uuid)
returns table (code_id uuid, code_email text, code_email_norm text)
language sql stable security definer set search_path = public
as $$
  select c.id, c.email, c.email_norm
    from public.student_email_codes c
   where c.user_id = p_user_id
     and c.used_at is null
     and c.verified_at is not null
     and c.expires_at > now()
   order by c.created_at desc
   limit 1;
$$;

-- ---------- 4e. spend ----------
-- Called only after Node has compared the hash. Conditional on used_at still
-- being null so two requests carrying the same correct code race here and
-- exactly one wins.

create or replace function public.student_email_code_consume(p_id uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare claimed uuid;
begin
  update public.student_email_codes
     set used_at = now()
   where id = p_id and used_at is null
  returning id into claimed;
  return claimed is not null;
end;
$$;

-- ---------- 4f. housekeeping ----------
create or replace function public.prune_student_email_codes(p_keep_days integer default 30)
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  delete from public.student_email_codes
   where created_at < now() - make_interval(days => greatest(coalesce(p_keep_days, 30), 1));
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------- 5. account_merges ----------
-- A merge cannot be undone: the two accounts' balances are summed and the
-- second account is gone. This row is therefore the ONLY thing a support
-- conversation six months later has to work from, which is why it stores
-- amounts rather than a boolean, and why nothing in it references the account
-- that was absorbed (it no longer exists to reference).

create table if not exists public.account_merges (
  id                uuid primary key default gen_random_uuid(),
  winner_id         uuid references public.profiles (user_id) on delete set null,
  -- Bare uuid/text, no FK: the row this points at is deleted moments later.
  loser_id          uuid not null,
  loser_email       text,
  points_moved      integer not null default 0,
  community_moved   integer not null default 0,
  punches_moved     integer not null default 0,
  -- Same-night visits the two accounts both recorded, discounted before the
  -- counters were summed. The one number a student might dispute ("I had 12
  -- visits and 9, why do I have 20?"), so it is stored rather than derived.
  duplicate_nights  integer not null default 0,
  spots_gained      integer not null default 0,
  transactions_moved integer not null default 0,
  -- Everything the merge decided NOT to do silently: a voided referral, an
  -- ambassador credit left standing, a clawback that could not be taken in full
  -- because the points were already spent. Read by the operator, never by the
  -- app.
  notes             jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now()
);

comment on table public.account_merges is
  'One row per completed account merge. Irreversible operation, so this is the '
  'record support works from. Migration-057.';

create index if not exists idx_account_merges_winner on public.account_merges (winner_id, created_at desc);

alter table public.account_merges enable row level security;
grant all privileges on public.account_merges to service_role;
revoke all privileges on public.account_merges from anon, authenticated;

-- ---------- 6. preview_student_merge ----------
-- The dry run behind the confirm screen. READ ONLY — it is called on a screen
-- the student may well back out of, and the thing it describes is irreversible,
-- so it must not have a side effect of any kind.
--
-- It deliberately reports what they GAIN, not a merged total: "you'll gain 340
-- points at 5 spots" is checkable against the account they are about to lose,
-- which is the question they are actually asking.

create or replace function public.preview_student_merge(
  p_winner uuid,
  p_loser  uuid
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_points    integer;
  v_community integer;
  v_punches   integer;
  v_txns      integer;
  v_spots     jsonb;
  v_spot_n    integer;
begin
  if p_winner is null or p_loser is null or p_winner = p_loser then
    raise exception 'MERGE_SAME_ACCOUNT';
  end if;

  -- Both purses: a pooled spot spends from pool_balances, so reading
  -- point_balances alone would under-report a chain's customer by exactly the
  -- balance they can actually spend (the same trap GET /api/me/balances
  -- documents at readPurses).
  select coalesce((select sum(balance) from point_balances where user_id = p_loser), 0)
       + coalesce((select sum(balance) from pool_balances  where user_id = p_loser), 0)
    into v_points;

  select coalesce((select balance from community_balances where user_id = p_loser), 0)
    into v_community;

  -- Visits, net of the nights both accounts recorded at the same spot. The
  -- merge discounts those (see 7h) and this has to predict the same number, or
  -- the confirm screen promises visits the merge then declines to hand over.
  select coalesce((select sum(punches) from punch_cards where user_id = p_loser), 0)
       - coalesce((select count(*) from punches l
                    where l.user_id = p_loser
                      and exists (select 1 from punches w
                                   where w.user_id = p_winner
                                     and w.vendor_id = l.vendor_id
                                     and w.business_day = l.business_day)), 0)
    into v_punches;
  v_punches := greatest(v_punches, 0);

  select count(*) into v_txns
    from transactions where user_id = p_loser;

  -- The spots they gain: somewhere the losing account has been that the winning
  -- one has not. Same definition of "been" as student_visited_vendor_ids
  -- (migration-048) so the Recommended row and this sentence cannot disagree.
  with loser_spots as (
    select t.vendor_id from transactions t
      where t.user_id = p_loser and t.type in ('earn', 'redeem')
    union
    select pc.vendor_id from punch_cards pc where pc.user_id = p_loser
  ),
  winner_spots as (
    select t.vendor_id from transactions t
      where t.user_id = p_winner and t.type in ('earn', 'redeem')
    union
    select pc.vendor_id from punch_cards pc where pc.user_id = p_winner
  ),
  gained as (
    select v.name
      from loser_spots ls
      join vendors v on v.id = ls.vendor_id
     where v.active
       and ls.vendor_id not in (select vendor_id from winner_spots)
     order by v.name
  )
  select coalesce(jsonb_agg(g.name), '[]'::jsonb), count(*) into v_spots, v_spot_n from gained g;

  return jsonb_build_object(
    'points',       v_points,
    'community',    v_community,
    'punches',      v_punches,
    'transactions', v_txns,
    'spotsGained',  v_spot_n,
    'spotNames',    v_spots
  );
end;
$$;

-- ---------- 7. merge_student_accounts ----------
--
-- Everything the losing account holds becomes the winning account's, and the
-- losing profile is deleted. ONE TRANSACTION: a half-done merge is money in
-- neither place, so every branch below either commits together or not at all.
--
-- ORDER IS LOad-BEARING and the reason is worth stating once:
--   • The two profiles are locked FIRST, in uuid order. Two merges touching the
--     same pair from two devices then queue instead of deadlocking.
--   • transactions are re-pointed BEFORE the profile is deleted. The FK is
--     ON DELETE SET NULL (migration-011, so a departing student doesn't rewrite
--     a vendor's revenue), which means deleting first would ANONYMISE exactly
--     the history this function exists to move.
--   • punches are moved off the losing card BEFORE that card row is deleted.
--     punches.card_id cascades, so the other order silently destroys the
--     night-by-night record the one-punch-per-night rule is built on.
--   • The profile delete is LAST and does the sweeping: student_notify_state,
--     campaign_recipients, terms_acceptances, live codes and anything else
--     keyed on the losing profile go with it, rather than being enumerated here
--     and drifting out of date the next time a table is added.
--
-- WHAT IT REFUSES: only a merge that cannot mean anything — the same account
-- twice, or an id with no profile. A vendor-staff account is NOT refused; see
-- the dual-role note in the body for why, and what the caller must do about it.

create or replace function public.merge_student_accounts(
  p_winner      uuid,
  p_loser       uuid,
  p_loser_email text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  c_clawback_kind constant text := 'referral_referrer';
  v_notes         jsonb := '[]'::jsonb;
  v_points_moved  integer := 0;
  v_community     integer := 0;
  v_punches       integer := 0;
  v_dupe_nights   integer := 0;
  v_spots_gained  integer := 0;
  v_txns          integer := 0;
  v_life          integer := 0;
  v_loser_vendor  boolean := false;
  v_ref           record;
  v_grant         record;
  v_take          integer;
  v_merge_id      uuid;
begin
  -- Constraint 1 of community-points.md: announce the write before touching a
  -- guarded table (migration-025). Transaction-local, so it evaporates at commit.
  perform set_config('app.points_write', 'server', true);

  if p_winner is null or p_loser is null or p_winner = p_loser then
    raise exception 'MERGE_SAME_ACCOUNT';
  end if;

  -- Lock both, low uuid first. Ordering is what makes two concurrent merges
  -- queue rather than deadlock.
  perform 1 from profiles
   where user_id in (p_winner, p_loser)
   order by user_id
     for update;

  if not exists (select 1 from profiles where user_id = p_winner) then
    raise exception 'MERGE_WINNER_UNKNOWN';
  end if;
  if not exists (select 1 from profiles where user_id = p_loser) then
    raise exception 'MERGE_LOSER_UNKNOWN';
  end if;

  -- ---- the dual-role account ----
  -- A vendor owner who ALSO uses the student app with a second address is a
  -- real and ordinary case — and an early cut of this file refused it outright,
  -- which made the feature useless for exactly the people most likely to try it
  -- first.
  --
  -- The refusal was solving the wrong problem. Deleting the vendor's AUTH USER
  -- would take their terminal login with it; deleting their PROFILE does not.
  -- vendor_staff references auth.users, not profiles (schema.sql), so the
  -- student side can be merged away and the counter still signs in tomorrow.
  -- That is precisely the split POST /api/me/delete has always made for a
  -- dual-role account (migration-035), and this now matches it.
  --
  -- So: merge, and TELL THE CALLER, which skips its auth.admin.deleteUser step.
  -- The flag is returned rather than re-queried so the route cannot disagree
  -- with the transaction that actually moved the data.
  v_loser_vendor := exists (select 1 from vendor_staff where user_id = p_loser);
  if v_loser_vendor then
    v_notes := v_notes || jsonb_build_object(
      'note', 'loser_is_vendor_auth_user_kept', 'loser_id', p_loser);
  end if;

  -- What they gain, measured BEFORE anything moves. Reported back to the app so
  -- the success screen can say the same numbers the preview promised.
  select coalesce((select sum(balance) from point_balances where user_id = p_loser), 0)
       + coalesce((select sum(balance) from pool_balances  where user_id = p_loser), 0)
    into v_points_moved;
  select coalesce((select balance from community_balances where user_id = p_loser), 0)
    into v_community;
  select count(*) into v_txns from transactions where user_id = p_loser;

  with loser_spots as (
    select t.vendor_id from transactions t
      where t.user_id = p_loser and t.type in ('earn', 'redeem')
    union
    select pc.vendor_id from punch_cards pc where pc.user_id = p_loser
  )
  select count(*) into v_spots_gained
    from loser_spots ls
   where ls.vendor_id not in (
     select t.vendor_id from transactions t
       where t.user_id = p_winner and t.type in ('earn', 'redeem')
     union
     select pc.vendor_id from punch_cards pc where pc.user_id = p_winner
   );

  -- ---- 7a. live codes ----
  -- A 6-digit earn code or a 4-digit redeem code belonging to the losing
  -- account may be on a phone screen at a counter RIGHT NOW. They are about to
  -- point at a profile that does not exist, so they go first and they go
  -- explicitly — the profile cascade would reach them anyway, but only after
  -- everything below has already run against a moving target.
  delete from earn_codes   where user_id = p_loser;
  delete from redeem_codes where user_id = p_loser;

  -- ---- 7c. per-vendor purses ----
  -- Sum where both accounts hold a balance at the same spot, move the rest
  -- across. The delete has to sit between the two: the primary key is
  -- (user_id, vendor_id), so re-pointing a row onto a vendor the winner already
  -- has would collide.
  update point_balances w
     set balance    = w.balance + l.balance,
         updated_at = now()
    from point_balances l
   where l.user_id = p_loser
     and w.user_id = p_winner
     and w.vendor_id = l.vendor_id;

  delete from point_balances l
   where l.user_id = p_loser
     and exists (select 1 from point_balances w
                  where w.user_id = p_winner and w.vendor_id = l.vendor_id);

  update point_balances set user_id = p_winner where user_id = p_loser;

  -- ---- 7d. shared purses (migration-044) ----
  update pool_balances w
     set balance    = w.balance + l.balance,
         updated_at = now()
    from pool_balances l
   where l.user_id = p_loser
     and w.user_id = p_winner
     and w.pool_id = l.pool_id;

  delete from pool_balances l
   where l.user_id = p_loser
     and exists (select 1 from pool_balances w
                  where w.user_id = p_winner and w.pool_id = l.pool_id);

  update pool_balances set user_id = p_winner where user_id = p_loser;

  -- The contribution ledger a leaving location's split is computed from. Moved
  -- with the balances it describes, or that arithmetic starts referring to an
  -- account that no longer exists.
  update pool_moves set user_id = p_winner where user_id = p_loser;

  -- ---- 7e. community points ----
  -- balance AND lifetime_earned both add up. lifetime_earned counts minting, and
  -- a merge mints nothing — but it does not BURN anything either, and the two
  -- students' gross totals are now one person's. Dropping the losing side would
  -- make lifetime_earned smaller than the sum of the grants behind it.
  select coalesce(balance, 0), coalesce(lifetime_earned, 0)
    into v_community, v_life
    from community_balances where user_id = p_loser;

  if found then
    insert into community_balances (user_id, balance, lifetime_earned)
    values (p_winner, v_community, v_life)
    on conflict (user_id) do update
      set balance         = community_balances.balance + excluded.balance,
          lifetime_earned = community_balances.lifetime_earned + excluded.lifetime_earned,
          updated_at      = now();

    delete from community_balances where user_id = p_loser;
  else
    v_community := 0;
  end if;

  -- The payout ledger behind those points. UNIQUE (ref_id, kind) is untouched by
  -- a change of user_id, so this never collides.
  update community_grants set user_id = p_winner where user_id = p_loser;

  -- ---- 7f. the ledger ----
  -- Re-pointed wholesale: no unique index on transactions.user_id, and
  -- vendor_id is untouched so no vendor's revenue or analytics move an inch.
  -- This one statement is also what makes the union of visited spots real —
  -- student_visited_vendor_ids reads these rows.
  update transactions set user_id = p_winner where user_id = p_loser;

  -- ---- 7g. the self-referral ----
  -- Two accounts owned by one person, one having "referred" the other. The
  -- referrals table's one-per-friend index cannot see this: two accounts is
  -- precisely the loophole it leaves open, and the merge is the moment it
  -- becomes visible. Void the referral and take back what the referrer was
  -- paid for it.
  --
  -- ONLY the referrer's leg. The friend's payout was for joining and using the
  -- app, which they did; it is the referral fee for introducing yourself that
  -- was never real.
  --
  -- ⚠ RUNS AFTER 7e, AND THAT IS THE POINT. By here the two community balances
  -- are one pot held by p_winner, so the clawback comes out of the combined
  -- total no matter which of the two accounts collected the fee. Doing it
  -- earlier would take it from whichever half happened to be smaller and leave
  -- the rest of the payout standing.
  for v_ref in
    select id, referrer_id from referrals
     where (referrer_id = p_winner and friend_id = p_loser)
        or (referrer_id = p_loser  and friend_id = p_winner)
  loop
    update referrals set status = 'void' where id = v_ref.id;

    for v_grant in
      select id, points, incentive_id from community_grants
       where ref_id = v_ref.id and kind = c_clawback_kind and voided_at is null
    loop
      -- Take back what is still there. A student who has already MOVED those
      -- points into a vendor balance cannot be pushed below zero — the CHECK on
      -- community_balances would abort the whole merge over points that were
      -- legitimately spendable at the time. Claw back the remainder and say so
      -- in the audit rather than failing the operation the student asked for.
      select least(v_grant.points, coalesce((select balance from community_balances
                                              where user_id = p_winner), 0))
        into v_take;

      if v_take > 0 then
        update community_balances
           set balance         = balance - v_take,
               lifetime_earned = greatest(lifetime_earned - v_take, 0),
               updated_at      = now()
         where user_id = p_winner;
      end if;

      update community_grants
         set voided_at = now(),
             voided_reason = 'self-referral unwound by account merge'
       where id = v_grant.id;

      -- Give the budget back, so a voided payout stops counting against a live
      -- program's spend.
      if v_grant.incentive_id is not null then
        update incentives
           set spent_points = greatest(spent_points - v_grant.points, 0)
         where id = v_grant.incentive_id;
      end if;

      v_notes := v_notes || jsonb_build_object(
        'note', 'self_referral_voided',
        'referral_id', v_ref.id,
        'points', v_grant.points,
        'clawed_back', v_take);
    end loop;
  end loop;

  -- ---- 7h. visit counters ----
  --
  -- ⚠ READ migration-029 BEFORE EDITING THIS. A "punch card" has not been a
  -- card since then: punch_cards is UNIQUE (user_id, vendor_id) and carries a
  -- single `punches` count, with no target and no completion — the target,
  -- completed_at and redeemed_at columns are GONE, and so are vendors.punch_
  -- target / punch_reward. migration-045 then made that count spendable
  -- (transactions.paid_with = 'visits' decrements it). So it is a live currency
  -- balance, and merging two of them is a sum.
  --
  -- THE CORRECTION THAT COMES FIRST. idx_punches_once_per_night says one human,
  -- one shop, one night is one visit. Where BOTH accounts were punched at the
  -- same spot on the same night, that is one visit recorded twice and the losing
  -- counter counted it. It has to be discounted before the sum, for two separate
  -- reasons: a merge must not pay for nights that never happened, and the
  -- duplicate punch rows cannot survive the re-point anyway — the index would
  -- reject them.
  select coalesce(sum(d.n), 0) into v_dupe_nights
    from (
      select count(*)::integer as n
        from punches l
       where l.user_id = p_loser
         and exists (select 1 from punches w
                      where w.user_id = p_winner
                        and w.vendor_id = l.vendor_id
                        and w.business_day = l.business_day)
       group by l.vendor_id
    ) d;

  update punch_cards lc
     set punches = greatest(lc.punches - d.n, 0)
    from (
      select l.vendor_id, count(*)::integer as n
        from punches l
       where l.user_id = p_loser
         and exists (select 1 from punches w
                      where w.user_id = p_winner
                        and w.vendor_id = l.vendor_id
                        and w.business_day = l.business_day)
       group by l.vendor_id
    ) d
   where lc.user_id = p_loser and lc.vendor_id = d.vendor_id;

  delete from punches l
   where l.user_id = p_loser
     and exists (select 1 from punches w
                  where w.user_id = p_winner
                    and w.vendor_id = l.vendor_id
                    and w.business_day = l.business_day);

  -- What actually lands, measured after the correction.
  select coalesce(sum(punches), 0) into v_punches from punch_cards where user_id = p_loser;

  -- The night-by-night rows move onto the counter that SURVIVES before the
  -- losing counter is deleted. punches.card_id is NOT NULL and cascades, so the
  -- other order silently destroys the history the once-per-night rule is built
  -- on.
  update punches l
     set user_id = p_winner, card_id = w.id
    from punch_cards w
   where l.user_id = p_loser
     and w.user_id = p_winner
     and w.vendor_id = l.vendor_id;

  -- Sum where both hold a counter at the same spot. Same idiom migration-045
  -- uses to add a visit (punches = punch_cards.punches + excluded.punches),
  -- because it is the same arithmetic.
  update punch_cards w
     set punches = w.punches + l.punches
    from punch_cards l
   where l.user_id = p_loser
     and w.user_id = p_winner
     and w.vendor_id = l.vendor_id;

  -- Then drop the emptied duplicates and move what is left. idx_punch_cards_
  -- one_per_vendor is why the delete has to sit between the sum and the
  -- re-point rather than after it.
  delete from punch_cards l
   where l.user_id = p_loser
     and exists (select 1 from punch_cards w
                  where w.user_id = p_winner and w.vendor_id = l.vendor_id);

  update punch_cards set user_id = p_winner where user_id = p_loser;
  update punches     set user_id = p_winner where user_id = p_loser;

  -- ---- 7i. the rest, deduped ----
  -- Saved spots and nearby-notification marks are both keyed (user_id,
  -- vendor_id); campaign_recipients is (campaign_id, user_id). Drop the losing
  -- row where the winner already has one, then move what is left.
  delete from vendor_favorites l
   where l.user_id = p_loser
     and exists (select 1 from vendor_favorites w
                  where w.user_id = p_winner and w.vendor_id = l.vendor_id);
  update vendor_favorites set user_id = p_winner where user_id = p_loser;

  delete from nearby_notifications l
   where l.user_id = p_loser
     and exists (select 1 from nearby_notifications w
                  where w.user_id = p_winner and w.vendor_id = l.vendor_id);
  update nearby_notifications set user_id = p_winner where user_id = p_loser;

  delete from campaign_recipients l
   where l.user_id = p_loser
     and exists (select 1 from campaign_recipients w
                  where w.campaign_id = l.campaign_id and w.user_id = p_winner);
  update campaign_recipients set user_id = p_winner where user_id = p_loser;

  -- One claim per physical receipt, keyed (vendor_id, receipt_at, total) — not
  -- per student — so this can never collide.
  update receipt_claims set user_id = p_winner where user_id = p_loser;

  -- Push endpoints are unique per browser, not per account: moving them keeps
  -- the student's other device receiving deals instead of orphaning it.
  update push_subscriptions set user_id = p_winner where user_id = p_loser and role = 'student';

  -- The referral the LOSING account received, if the winner never used one.
  -- idx_referrals_one_per_friend allows exactly one, so where the winner
  -- already has theirs the losing row stays put and goes with the profile —
  -- recorded, because it is an attribution quietly disappearing.
  if exists (select 1 from referrals where friend_id = p_loser) then
    if exists (select 1 from referrals where friend_id = p_winner) then
      v_notes := v_notes || jsonb_build_object('note', 'referral_attribution_dropped', 'friend_id', p_loser);
    else
      update referrals set friend_id = p_winner where friend_id = p_loser;
    end if;
  end if;
  update referrals set referrer_id = p_winner where referrer_id = p_loser;

  -- An ambassador who is also merging accounts keeps their code, unless the
  -- winning account already has one — GET /api/me/ambassador reads a single row
  -- and two would break it.
  if exists (select 1 from ambassadors where user_id = p_loser) then
    if exists (select 1 from ambassadors where user_id = p_winner) then
      v_notes := v_notes || jsonb_build_object('note', 'ambassador_row_left_behind', 'loser_id', p_loser);
    else
      update ambassadors set user_id = p_winner where user_id = p_loser;
    end if;
  end if;

  -- Signup credits that PAID SOMEBODY ELSE. Both accounts may have been counted
  -- — to an ambassador, or to a tracked poster — and after this there is one
  -- human where the numbers say two. Left paid on purpose (clawing back from a
  -- third party who did nothing wrong is worse than an inflated count) and
  -- recorded so the operator can see it happening.
  if exists (select 1 from ambassador_signups where user_id = p_loser)
     and exists (select 1 from ambassador_signups where user_id = p_winner) then
    v_notes := v_notes || jsonb_build_object('note', 'ambassador_signup_counted_twice', 'loser_id', p_loser);
  end if;
  if exists (select 1 from tracked_qr_signups where user_id = p_loser)
     and exists (select 1 from tracked_qr_signups where user_id = p_winner) then
    v_notes := v_notes || jsonb_build_object('note', 'tracked_qr_signup_counted_twice', 'loser_id', p_loser);
  end if;

  -- Revisit count feeds the tier score (migration-005). Additive like everything
  -- else; the snapshot itself is recomputed by the server right after this.
  update profiles w
     set revisits = coalesce(w.revisits, 0) + coalesce(l.revisits, 0)
    from profiles l
   where w.user_id = p_winner and l.user_id = p_loser;

  -- A stale snapshot is worse than none: the server recomputes the winner's
  -- immediately after this returns, and until it does, absent reads as tier 1
  -- rather than as a score that silently ignores half their history.
  delete from user_scores where user_id in (p_winner, p_loser);

  -- ---- 7j. the audit row, then the account ----
  insert into account_merges (
    winner_id, loser_id, loser_email, points_moved, community_moved,
    punches_moved, duplicate_nights, spots_gained, transactions_moved, notes)
  values (
    p_winner, p_loser, lower(nullif(btrim(p_loser_email), '')), v_points_moved, v_community,
    v_punches, v_dupe_nights, v_spots_gained, v_txns, v_notes)
  returning id into v_merge_id;

  -- Everything still keyed on the losing profile goes with it: notify state,
  -- terms acceptances, campaign rows we did not move, punch redeem codes.
  -- transactions are already safe — they were re-pointed at 7f, so the
  -- ON DELETE SET NULL that anonymises a departing student finds nothing.
  delete from profiles where user_id = p_loser;

  return jsonb_build_object(
    'mergeId',      v_merge_id,
    'points',       v_points_moved,
    'community',    v_community,
    'punches',      v_punches,
    'duplicateNights', v_dupe_nights,
    'spotsGained',  v_spots_gained,
    'transactions', v_txns,
    -- The route reads this to decide whether to delete the losing AUTH user.
    -- true = a vendor login: the profile is gone, the sign-in must stay, or the
    -- counter cannot sign in tomorrow. Returned from the transaction that did
    -- the work rather than re-queried, so the two cannot disagree.
    'loserIsVendor', v_loser_vendor,
    'notes',        v_notes
  );
end;
$$;

comment on function public.merge_student_accounts(uuid, uuid, text) is
  'Folds one student account into another and deletes the loser. Irreversible; '
  'writes an account_merges row. Service-role only. Migration-057.';

-- ---------- 8. grants ----------
-- Same posture as every other money function in this schema: invisible to anon
-- and authenticated, callable only by the Express API's service key.

revoke execute on function public.student_email_code_issue(uuid, text, text, text, integer, integer) from public, anon, authenticated;
revoke execute on function public.student_email_code_begin(uuid, integer)                            from public, anon, authenticated;
revoke execute on function public.student_email_code_verify(uuid)                                    from public, anon, authenticated;
revoke execute on function public.student_email_code_pending(uuid)                                   from public, anon, authenticated;
revoke execute on function public.student_email_code_consume(uuid)                                   from public, anon, authenticated;
revoke execute on function public.prune_student_email_codes(integer)                                 from public, anon, authenticated;
revoke execute on function public.preview_student_merge(uuid, uuid)                                  from public, anon, authenticated;
revoke execute on function public.merge_student_accounts(uuid, uuid, text)                           from public, anon, authenticated;

grant execute on function public.student_email_code_issue(uuid, text, text, text, integer, integer) to service_role;
grant execute on function public.student_email_code_begin(uuid, integer)                            to service_role;
grant execute on function public.student_email_code_verify(uuid)                                    to service_role;
grant execute on function public.student_email_code_pending(uuid)                                   to service_role;
grant execute on function public.student_email_code_consume(uuid)                                   to service_role;
grant execute on function public.prune_student_email_codes(integer)                                 to service_role;
grant execute on function public.preview_student_merge(uuid, uuid)                                  to service_role;
grant execute on function public.merge_student_accounts(uuid, uuid, text)                           to service_role;

commit;

-- ---------- 9. daily prune ----------
-- Same best-effort pg_cron pattern as migrations 021/023/031: the function
-- always installs, scheduling degrades to a NOTICE where pg_cron is not enabled.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule(
    'prune-student-email-codes',
    '57 4 * * *',                     -- daily at 04:57 UTC, after the other prunes
    $cron$ select public.prune_student_email_codes(30); $cron$
  );
  raise notice 'Scheduled daily student-email-code prune (job: prune-student-email-codes).';
exception when others then
  raise notice 'pg_cron not available (%). Enable it (Dashboard -> Database -> Extensions), then re-run this DO block.', sqlerrm;
end;
$$;

-- ---------- 10. wake PostgREST ----------
notify pgrst, 'reload schema';

-- ============================================================
-- POST-RUN CHECKS
--
--   -- the new tables exist and are locked down (expect true, then 0):
--   select relrowsecurity from pg_class where relname = 'student_email_claims';
--   select count(*) from pg_policies where tablename = 'student_email_claims';
--
--   -- the functions are service_role-only (expect no anon/authenticated):
--   select p.proname, p.proacl from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('merge_student_accounts', 'preview_student_merge',
--                        'student_email_code_issue', 'student_email_code_begin');
--
--   -- a dry run against any two real students changes nothing and prints what
--   -- a merge WOULD move:
--   select public.preview_student_merge('<winner-uuid>', '<loser-uuid>');
--
--   -- after a real link, the fence and the profile agree:
--   select email, user_id, bonus_points, merged_from, released_at
--     from public.student_email_claims order by verified_at desc limit 5;
--   select user_id, email, linked_email, linked_email_at from public.profiles
--    where linked_email is not null order by linked_email_at desc limit 5;
--
--   -- every merge ever, newest first:
--   select created_at, winner_id, loser_email, points_moved, community_moved,
--          duplicate_nights, spots_gained, notes
--     from public.account_merges order by created_at desc limit 20;
-- ============================================================
