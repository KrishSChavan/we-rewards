-- ============================================================
-- Migration 052 — an applicant names what they are giving away.
--
--   THE GAP THIS CLOSES. onboardVendor (src/routes/admin.js) creates an auth
--   login, one vendors row per location and the vendor_staff links, and stops
--   there. It has never created a single row in public.rewards. So the moment
--   an application is accepted the spot is LIVE in the student app — it appears
--   on the Spots tab, students can scan and earn points at it — and the Rewards
--   list under it says "No rewards yet, check back soon!" (see items-empty in
--   public/student/index.html).
--
--   That is the worst state this product has. A student who earns points with
--   nothing to aim at has been given a number, not a reward, and the vendor is
--   never more engaged than in the ten minutes they spend on /join. Chasing
--   them for their first item afterwards is a second conversation we have to
--   win, and until we win it their spot actively looks broken.
--
--   So /join now asks for one, and this column is where it waits between
--   submitting and being accepted.
--
--   ⚠ IT HOLDS DOLLARS, NOT POINTS, and that is the whole design.
--
--      /join does not ask for points_per_dollar — it has never had a field for
--      it, and the vendors row lands on the table default of 10. An applicant
--      typing "200 points" would therefore be pricing in a currency nobody has
--      explained to them yet, and any later correction to their rate (an
--      operator setting them to 15, or migration-043 inheritance copying a
--      sibling store's 5) would silently re-price every item they named without
--      anyone deciding to.
--
--      The applicant is asked the question they can actually answer instead:
--      HOW MUCH SHOULD A CUSTOMER SPEND WITH YOU TO EARN THIS. The point cost
--      is derived at ACCEPT time, from the rate the vendors row actually ends
--      up with:  cost_in_points = round(spend * points_per_dollar), clamped to
--      the 1..100000 band validPrice already enforces (src/lib/rewards.js).
--      Dollars in, dollars back out: the terminal's ITEMS tab prints the same
--      figure under the points price, so a vendor never has to hold both
--      currencies in their head at once.
--
--   Shape of each element (validated in src/lib/rewards.js — an application is
--   an inbox, not a source of truth):
--     { "title": "Free small coffee", "spend": 25, "emoji": "☕" }
--
--   PER LOCATION, like the contact details in migration-049. One application
--   can open several branches, and every branch gets its own copy of the items:
--   locations are independent vendors with separate balances, items and stats
--   (see migration-043's header), so a shared row is not expressible and would
--   not be wanted — the copies diverge the first time one shop stops doing the
--   cookie. They are created at each location's OWN rate, which is the same
--   rate for every location of one application today but need not stay so.
--
--   DEFAULT '[]' AND NOT REQUIRED HERE. The requirement lives at the door
--   (src/routes/apply.js refuses an application naming no items, and /join
--   cannot submit without one), not in a CHECK. Two reasons: the operator's own
--   "Add vendor" form is the same onboarding with the field optional — the same
--   asymmetry migration-049's phone number has, and for the same reason, that
--   somebody standing at a demo has not written it down yet — and a NOT NULL
--   CHECK on an inbox table turns a support screen into a 500 rather than into
--   a message someone can act on (migration-042's reasoning about cuisine).
--
--   ⚠ DEPLOY ORDER: run this BEFORE deploying the server code, which selects
--   `rewards` on the applications queue and on accept. The reverse order is
--   safe for the DB — nothing here is read until the server asks — but a
--   deployed server would 500 the operator's queue until the column existed.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-051. Idempotent and safe to re-run.
-- ============================================================

-- ---------- 1. the column ----------

alter table public.vendor_applications
  add column if not exists rewards jsonb not null default '[]'::jsonb;

comment on column public.vendor_applications.rewards is
  'The redeemable items the applicant named on /join, as a jsonb array of '
  '{title, spend, emoji}. `spend` is DOLLARS a customer has to spend to earn '
  'the item, not points: /join never asks for points_per_dollar, so the point '
  'cost is derived on accept from the rate each vendors row actually gets '
  '(round(spend * points_per_dollar), clamped to 1..100000). One rewards row '
  'per item PER LOCATION, since locations are independent vendors. Validated '
  'in src/lib/rewards.js; discarded with the rest of the application row when '
  'the accept completes.';

-- An object here would make the accept loop iterate a string's characters and
-- a null would make it throw, exactly as for `locations` in migration-043.
-- Shape beyond "is an array" is Node's job, for the reason in the header.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.vendor_applications'::regclass
      and conname = 'vendor_applications_rewards_array'
  ) then
    alter table public.vendor_applications
      add constraint vendor_applications_rewards_array
      check (jsonb_typeof(rewards) = 'array');
  end if;
end $$;

-- ---------- 2. no backfill ----------
--
-- Deliberately none, and nothing to backfill onto: applications pending when
-- this runs simply carry '[]' and accept the way they always did, creating a
-- vendor with an empty ITEMS tab. That is the pre-052 behaviour, not a
-- regression, and the operator can add the item from the vendor editor in
-- /admin the moment they accept. New applications cannot be submitted without
-- one, so the queue drains into the new behaviour on its own.

-- ---------- 3. no grant changes ----------
--
-- vendor_applications is service-role-only and settled in
-- 20260807045446_grant_service_role_on_public_tables.sql. A new column on an
-- existing table inherits that table's grants, so anon and authenticated still
-- cannot read this table at all, and the column never leaves the server except
-- through requireAdmin (the review queue) or into public.rewards on accept.
