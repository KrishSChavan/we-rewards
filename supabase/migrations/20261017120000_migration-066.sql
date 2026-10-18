-- ============================================================
-- Migration 066 — Spot reviews: students rate a location, in the app, for points.
--
--   A student gives a spot 1-5 stars and an optional comment. Their FIRST review
--   of a location pays that location's `review_points` into the purse they spend
--   there; edits after that pay nothing. Reviews are public (spot card and
--   /spots page), each one either under "First L." or anonymously, the
--   student's choice. After posting, the app offers the spot's own Google review
--   page, if the operator has set one — with NO points attached to it.
--
--   WHY THE POINTS ARE FOR THE IN-APP REVIEW AND NEVER FOR THE GOOGLE ONE.
--   Google's contribution policy lists "reviews or ratings that have been paid
--   for, directly or in kind" as fake engagement and forbids merchants to
--   "offer incentives — such as payment, discounts, free goods and/or services"
--   for reviews. Points ARE free goods. The penalty lands on the VENDOR's Google
--   listing (removed reviews; restricted or suspended profile), not on us. There
--   is also no way to verify a Google review was ever posted: the link opens
--   Google and nothing comes back. So the only paid thing is the review WE hold,
--   and the Google button is shown at every star rating (showing it only to
--   happy reviewers is "review gating", which Google also forbids).
--
--   WHAT THIS FILE ADDS
--   1. vendors.google_review_url — where the "Share on Google too?" button goes.
--      Set by the operator in /admin; the server only accepts Google hosts. Here
--      it is held to https and a length, so a hand edit cannot store a
--      javascript: URL that the app would put in an href.
--   2. vendors.review_points — what a student's FIRST review of this location
--      pays. 0 (the default) means reviews here pay nothing, which is how a
--      vendor opts out of funding them: these are that vendor's points, a claim
--      on their product, and nobody gets them unless the operator sets a number.
--   3. vendor_reviews — one row per (student, location), edits in place.
--   4. vendor_review_stats — the public roll-up (count, average) of the reviews
--      that are not hidden.
--   5. submit_review() — the ONLY writer of a review row's first insert and of
--      the points it pays. Same shape as award_points: announces itself to the
--      migration-025 guard, picks the purse (point_balances, or pool_balances for
--      a location in a pool), credits it, returns the balance as written.
--   6. carry_reviews_through_merge — a BEFORE DELETE trigger on profiles. An
--      account merge (migration-057) deletes the losing profile, and without
--      this the cascade would delete its reviews: they would vanish from the
--      app, and the merged account could review those spots AGAIN and be paid
--      twice for one person at one location. It moves them to the winner.
--
--   WHY A SEPARATE LEDGER AND NOT A NEW transactions.type.
--   transactions is read by 13 server call sites and a dozen SQL functions
--   (campaign audiences, referral settlement, tier scores, revisit bumps, the
--   10% community mint's daily cap, "where has this student been"). Most filter
--   on type = 'earn', some do not, and 'community_transfer' already shows how
--   many places had to learn about a non-purchase credit. A review is not a
--   visit, must not settle a referral, must not move a tier, and must not mint
--   community points. Keeping it OUT of transactions makes all of that true by
--   construction instead of by auditing every reader. vendor_reviews.
--   points_awarded is the ledger: what each review paid, kept on the row.
--
--   ⚠ KNOWN GAP, ACCEPTED: pool_leave() and pool_settlement() (migration-046)
--   attribute a pooled purse to its locations from transactions only, so a
--   review paid at a pooled location is not counted as that location's
--   contribution if it later leaves the pool. The amount is bounded (one
--   review per student per location, ever, at that location's review_points),
--   and fixing it means rewriting pool_leave, a money function, which this
--   feature does not need to risk.
--
--   ERROR STRINGS. server.js's central error map matches by SUBSTRING. Nothing
--   in it contains REVIEW, and the two codes raised here contain no existing key.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-065. Safe to re-run.
--
--   ⚠ DEPLOY ORDER: run this BEFORE the server code. The server tolerates it
--   being absent — review features answer "not available yet", and the
--   catalogue, /admin roster and every existing query are unchanged — but no
--   review can be written until it is here.
-- ============================================================

begin;

-- ALTER on vendors takes a lock on the table every till reads on every request
-- (requireVendor). Fail fast rather than queue behind a forgotten open
-- transaction in another SQL-editor tab — same reason as migration-044.
set lock_timeout = '3s';

-- ---------- 1 + 2. the two vendor settings ----------

alter table public.vendors add column if not exists google_review_url text;
alter table public.vendors add column if not exists review_points integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.vendors'::regclass
                   and conname = 'vendors_google_review_url_shape') then
    alter table public.vendors
      add constraint vendors_google_review_url_shape
      check (google_review_url is null
             or (char_length(google_review_url) <= 500 and google_review_url ~ '^https://'));
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.vendors'::regclass
                   and conname = 'vendors_review_points_range') then
    alter table public.vendors
      add constraint vendors_review_points_range
      check (review_points between 0 and 500);
  end if;
end $$;

comment on column public.vendors.google_review_url is
  'Where the app''s "Share on Google too?" button goes after a student reviews '
  'this location. Set in /admin, Google hosts only (server-side). No points are '
  'ever tied to it. See migration-066.';
comment on column public.vendors.review_points is
  'Points a student''s FIRST in-app review of this location pays, into the purse '
  'they spend here. 0 = reviews here pay nothing. See migration-066.';

-- ---------- 3. vendor_reviews ----------

create table if not exists public.vendor_reviews (
  id             uuid primary key default gen_random_uuid(),
  -- CASCADE, unlike receipt_claims' SET NULL. A review is published content
  -- under the student's name; deleting the account must take it down. The
  -- once-per-location rule needs no surviving row: a new account is a new
  -- user_id either way.
  user_id        uuid not null references public.profiles (user_id) on delete cascade,
  vendor_id      uuid not null references public.vendors (id) on delete cascade,
  rating         smallint not null check (rating between 1 and 5),
  body           text check (body is null or char_length(body) between 1 and 500),
  -- "Krish C.", computed by the server from the profile at every write, or
  -- NULL when the student chose to post anonymously. A snapshot rather than a
  -- join so the public page shows exactly what the student was shown.
  author_name    text check (author_name is null or char_length(author_name) <= 40),
  -- How the server knew they had been there when the review was FIRST written:
  -- 'visit'  — an earn, redeem or punch-card visit at this location in the last
  --            24 hours;
  -- 'onsite' — their phone placed them at the location.
  source         text not null check (source in ('visit', 'onsite')),
  -- What this review paid, ever. Set once, by submit_review, on the insert.
  points_awarded integer not null default 0 check (points_awarded >= 0),
  -- Operator moderation. Hiding is for CONTENT (abuse, spam, off-topic,
  -- personal information, not a genuine visit) — never because a review is
  -- negative: suppressing negative reviews is what the FTC's 2024 review rule
  -- (16 CFR 465.7) prohibits. A hidden review keeps its points.
  hidden_at      timestamptz,
  hidden_by      text,
  hidden_reason  text check (hidden_reason is null
                            or hidden_reason in ('abuse', 'spam', 'off_topic', 'personal_info', 'not_genuine')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint vendor_reviews_hidden_pair check ((hidden_at is null) = (hidden_reason is null))
);

comment on table public.vendor_reviews is
  'One in-app review per (student, location); edits update in place. The first '
  'insert is written by submit_review(), which also pays vendors.review_points. '
  'See migration-066.';

-- THE once-per-location rule, and what submit_review's insert races on.
create unique index if not exists idx_vendor_reviews_once
  on public.vendor_reviews (user_id, vendor_id);
-- The public list for one spot, newest first.
create index if not exists idx_vendor_reviews_vendor_time
  on public.vendor_reviews (vendor_id, created_at desc) where hidden_at is null;
-- The operator's moderation list, newest first across every spot.
create index if not exists idx_vendor_reviews_time
  on public.vendor_reviews (created_at desc);

-- Server-only, like every table since migration-037: RLS on with no policies,
-- and the default privileges Supabase grants at CREATE TABLE taken back.
alter table public.vendor_reviews enable row level security;
revoke all on table public.vendor_reviews from anon, authenticated;
grant select, insert, update, delete on table public.vendor_reviews to service_role;

-- ---------- 4. vendor_review_stats ----------

create or replace view public.vendor_review_stats
with (security_invoker = true) as
select r.vendor_id,
       count(*)::integer                     as review_count,
       round(avg(r.rating)::numeric, 1)      as avg_rating
  from public.vendor_reviews r
 where r.hidden_at is null
 group by r.vendor_id;

comment on view public.vendor_review_stats is
  'Public per-location review roll-up: count and average (1 dp) of reviews that '
  'are not hidden. Locations with no reviews have no row. See migration-066.';

grant select on public.vendor_review_stats to service_role;
revoke all privileges on public.vendor_review_stats from anon, authenticated;

-- ---------- 5. submit_review ----------

create or replace function public.submit_review(
  p_user_id     uuid,
  p_vendor_id   uuid,
  p_rating      integer,
  p_body        text,
  p_author_name text,
  p_source      text
)
returns table (review_id uuid, created boolean, points_awarded integer, new_balance integer)
language plpgsql security definer set search_path = public
as $$
declare
  v_pool   uuid;
  v_active boolean;
  v_points integer;
  v_id     uuid;
  v_bal    integer;   -- the balance AS WRITTEN; null when nothing was paid
begin
  -- Announce a legitimate points write to the migration-025 guard triggers
  -- (point_balances, and pool_balances since 044). Transaction-local.
  perform set_config('app.points_write', 'server', true);

  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'REVIEW_RATING_INVALID';
  end if;

  -- Which purse, what a first review pays, and whether the spot is open — read
  -- under the same share lock award_points takes, so a concurrent pool_join or
  -- deactivation cannot change the answer halfway through this call.
  select v.pool_id, v.active, v.review_points
    into v_pool, v_active, v_points
  from vendors v where v.id = p_vendor_id for share;

  if not found or not coalesce(v_active, false) then
    raise exception 'REVIEW_SPOT_UNAVAILABLE';
  end if;

  -- FIRST INSERT WINS. Two submits racing for the same (student, location):
  -- the second blocks on the unique index until the first commits, then does
  -- nothing here and falls through to the edit branch. So exactly one of them
  -- can ever reach the credit below.
  insert into vendor_reviews (user_id, vendor_id, rating, body, author_name, source)
  values (p_user_id, p_vendor_id, p_rating, p_body, p_author_name, p_source)
  on conflict (user_id, vendor_id) do nothing
  returning id into v_id;

  if v_id is null then
    -- An edit. Pays nothing, keeps source/points/created_at, and deliberately
    -- leaves a hidden review hidden: otherwise editing would be an unhide.
    update vendor_reviews r
       set rating = p_rating, body = p_body, author_name = p_author_name, updated_at = now()
     where r.user_id = p_user_id and r.vendor_id = p_vendor_id
    returning r.id into v_id;
    return query select v_id, false, 0, null::integer;
    return;
  end if;

  if coalesce(v_points, 0) > 0 then
    if v_pool is null then
      insert into point_balances (user_id, vendor_id, balance)
      values (p_user_id, p_vendor_id, v_points)
      on conflict (user_id, vendor_id)
      do update set balance = point_balances.balance + v_points, updated_at = now()
      returning balance into v_bal;
    else
      insert into pool_balances (user_id, pool_id, balance)
      values (p_user_id, v_pool, v_points)
      on conflict (user_id, pool_id)
      do update set balance = pool_balances.balance + v_points, updated_at = now()
      returning balance into v_bal;
    end if;

    update vendor_reviews r set points_awarded = v_points where r.id = v_id;
  end if;

  return query select v_id, true, coalesce(v_points, 0), v_bal;
end;
$$;

comment on function public.submit_review(uuid, uuid, integer, text, text, text) is
  'Writes or edits a student''s review of one location. The first review pays '
  'vendors.review_points into that location''s purse (pool-aware); edits pay '
  'nothing. Presence (visit/onsite) is checked by the server before calling. '
  'See migration-066.';

revoke execute on function public.submit_review(uuid, uuid, integer, text, text, text) from public, anon, authenticated;
grant  execute on function public.submit_review(uuid, uuid, integer, text, text, text) to service_role;

-- ---------- 6. carry_reviews_through_merge ----------
-- merge_student_accounts (migration-057) writes its account_merges row BEFORE
-- it deletes the losing profile, inside the same transaction, so this trigger
-- can see which account the loser became. Every other profile delete (account
-- deletion, the unconsented-signup prune) has no such row and falls straight
-- through to the cascade, which is what deleting an account must do.
--
-- Where both accounts reviewed the same spot the winner's review stands and the
-- loser's goes with the account: both were paid at the time, as two accounts,
-- and the unique index allows only one. Everywhere else the loser's review
-- becomes the winner's — signature, text, points paid and all — so the
-- once-per-location rule keeps holding for the person, not just the account.
-- A trigger rather than a re-creation of merge_student_accounts because that
-- function moves money in a dozen tables; this feature should not take on the
-- risk of rewriting it to add one more.
create or replace function public.carry_reviews_through_merge()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_winner uuid;
begin
  select m.winner_id into v_winner
    from account_merges m
   where m.loser_id = old.user_id
   order by m.created_at desc
   limit 1;
  if v_winner is null then
    return old;
  end if;
  update vendor_reviews r
     set user_id = v_winner
   where r.user_id = old.user_id
     and not exists (select 1 from vendor_reviews w
                      where w.user_id = v_winner and w.vendor_id = r.vendor_id);
  return old;
end;
$$;

comment on function public.carry_reviews_through_merge() is
  'BEFORE DELETE on profiles: when the profile is the loser of an account '
  'merge, move its reviews to the winner (except spots the winner already '
  'reviewed). See migration-066.';

revoke execute on function public.carry_reviews_through_merge() from public, anon, authenticated;

drop trigger if exists trg_carry_reviews_through_merge on public.profiles;
create trigger trg_carry_reviews_through_merge
  before delete on public.profiles
  for each row execute function public.carry_reviews_through_merge();

notify pgrst, 'reload schema';

commit;
