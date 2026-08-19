-- ============================================================
-- Migration 042 — What a spot SELLS, so the Spots tab can filter on it.
--
--   The Spots tab's filter pill has only ever been able to ask questions about
--   the STUDENT's relationship to a spot — saved, been there lately, popular.
--   Every one of those is answered by data the app already collects as a side
--   effect of people using it. "Show me coffee" and "show me somewhere cheap"
--   are questions about the SPOT, and there was nothing on public.vendors that
--   could answer either: name, slug, earn rate, address, logo, and a handful of
--   feature switches, none of which say what the place is.
--
--   Both columns are vendor-declared rather than pulled from Google Places or
--   Yelp. The catalogue is local shops onboarded one at a time through /join,
--   so an enrichment API would buy data that can be typed in faster than the
--   integration can be written — and it would arrive with per-vendor place-ID
--   matching (which fails on exactly the small independents this carries),
--   licence terms restricting how long the values may be cached, and a bill.
--
--   1. vendors.cuisine — up to three tags, e.g. {coffee,bakery}.
--
--      An ARRAY, not a single category, because a place that sells coffee and
--      pastries is genuinely both and a student searching either should find
--      it. Capped at three: past that a vendor has described a menu rather
--      than picked a category, and a row on the Spots tab has no space to
--      render it anyway.
--
--      The VOCABULARY is not enforced here. It lives in src/lib/cuisines.js
--      and is applied on every write path (the /join application and both
--      admin editors), so there is one list to extend rather than one list
--      plus a constraint that has to be migrated in lockstep with it. The
--      student's filter sheet does not read that list at all — it builds its
--      chips from the cuisines the visible spots actually carry, so it can
--      never offer a chip that matches nothing, and a new tag needs no client
--      release to become filterable.
--
--      NOT NULL DEFAULT '{}' rather than nullable: "this vendor declared no
--      cuisine" and "this vendor declared an empty list" are the same fact,
--      and an empty array makes every read site a plain array operation with
--      no null branch. Existing rows land here on backfill, which is correct —
--      they are untagged until someone tags them.
--
--   2. vendors.price_level — 1..4, the familiar $ to $$$$.
--
--      NULLABLE, and null means UNTAGGED, not "cheap". This is the whole
--      reason it is not `not null default 1`: every vendor predating this
--      migration would then claim to be the cheapest option in town, and the
--      price filter would open showing a $ list that is really just the
--      backlog. Untagged spots are excluded from a price-filtered view and say
--      so in the empty state.
--
--      A smallint scale rather than a real dollar figure. The app never sees a
--      menu — it sees the total on a receipt, which is a function of how much
--      that student ordered, not of how expensive the shop is.
--
--   NOTE ON THE OTHER "PRICE": the Spots tab can already rank on cost without
--   any of this — points_per_dollar is on this table and every active reward's
--   points cost is in the /balances payload. This column answers "is eating
--   here expensive", which those cannot.
--
--   ⚠ DEPLOY ORDER: run this BEFORE deploying the server code that selects
--   cuisine / price_level, or /api/me/balances fails on the missing columns.
--   (The reverse order is safe for the DB — nothing here is read until the
--   server asks.)
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-041. Safe to re-run (IF NOT EXISTS, and the constraints are
--   added conditionally).
-- ============================================================

-- ---------- 1. cuisine ----------

alter table public.vendors
  add column if not exists cuisine text[] not null default '{}';

comment on column public.vendors.cuisine is
  'Up to 3 cuisine/category tags, lowercase slugs from the vocabulary in '
  'src/lib/cuisines.js (e.g. {coffee,bakery}). Empty array = untagged, which '
  'is the default for every vendor onboarded before migration-042. Feeds the '
  'Spots tab filter sheet, which builds its chips from the values present '
  'rather than from a hardcoded list.';

-- Cardinality only. The vocabulary is a server concern (see the header): a
-- check constraint listing the tags would have to be migrated every time a new
-- one is added, and the DB is not where that list wants to live.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.vendors'::regclass
      and conname = 'vendors_cuisine_len'
  ) then
    alter table public.vendors
      add constraint vendors_cuisine_len check (cardinality(cuisine) <= 3);
  end if;
end $$;

-- GIN, because every read of this column is a containment test ("spots tagged
-- coffee"), which is exactly what @> wants an index for. Cheap here: the
-- catalogue is small and writes are a vendor editing their own profile, not
-- traffic.
create index if not exists vendors_cuisine_idx
  on public.vendors using gin (cuisine);

-- ---------- 2. price_level ----------

alter table public.vendors
  add column if not exists price_level smallint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.vendors'::regclass
      and conname = 'vendors_price_level_range'
  ) then
    alter table public.vendors
      add constraint vendors_price_level_range
      check (price_level is null or price_level between 1 and 4);
  end if;
end $$;

comment on column public.vendors.price_level is
  'Typical cost of eating here, 1..4 ($ to $$$$). NULL = the vendor has not '
  'said, which is NOT the same as cheap — untagged spots are excluded from a '
  'price-filtered view rather than sorted to the bottom of it. Deliberately '
  'not derived from receipt totals: those measure the order, not the shop.';

-- ---------- 3. …and the same two on a pending application ----------
--
-- The applicant answers both on /join, so the operator accepting them does not
-- have to guess what the shop sells, and a spot is filterable the moment it
-- goes live rather than whenever someone remembers to go back and tag it.
--
-- Deliberately mirrored onto vendor_applications rather than collected after
-- acceptance: this is the one moment the person who actually knows the answer
-- is filling in a form. Carried across by POST /applications/:id/accept and
-- then discarded with the rest of the row.
--
-- No constraints here beyond the column types. An application is an inbox, not
-- a source of truth — both values are re-normalised through
-- src/lib/cuisines.js on the way into public.vendors, which is where they have
-- to be right.
alter table public.vendor_applications
  add column if not exists cuisine text[] not null default '{}';

alter table public.vendor_applications
  add column if not exists price_level smallint;

comment on column public.vendor_applications.cuisine is
  'What the applicant says they sell — copied to vendors.cuisine on accept.';

comment on column public.vendor_applications.price_level is
  'The applicant''s own 1..4 price tier, or NULL if they skipped it. Copied '
  'to vendors.price_level on accept.';
