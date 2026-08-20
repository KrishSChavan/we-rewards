-- ============================================================
-- Migration 043 — Multi-location vendors: one login, several stores.
--
--   public.vendor_staff has been a join table since the first schema, so one
--   auth user linked to several vendors was always legal, and requireVendor
--   has always been able to resolve it (the X-Vendor-Id header). Two things
--   were missing, and this migration adds the columns for both.
--
--   1. vendors.location_label — which branch this row IS.
--
--      A chain's locations share a business name: "Joe's Pizza" downtown and
--      "Joe's Pizza" on campus are two vendors rows whose `name` is the same
--      string. Every place a human has to TELL THEM APART — the terminal's
--      store switcher, the operator's roster, the reset-password picker —
--      needed something to show, and the only candidate was `address`, which
--      is optional and is a whole street line where a chip has room for a
--      word.
--
--      So: a short vendor-chosen label ("Downtown", "Campus", "Store #2").
--      NULLABLE and unconstrained beyond a length cap, because it is a name
--      for humans, not a key: single-location vendors (nearly all of them)
--      leave it null forever and every read site falls back to the address
--      and then to the plain business name. Nothing keys on it, nothing joins
--      on it, and two locations may legally carry the same one — the switcher
--      shows the address underneath precisely so a vendor who labels both
--      stores "Main" still has something to steer by.
--
--      NOT a chain/group table. Locations stay fully independent vendors:
--      separate balances, items, deals, stats, PIN and earning rate, which is
--      what the existing schema already enforces by keying point_balances on
--      (user_id, vendor_id). A student earning at one location cannot spend at
--      another, and that is the intended product, not a limitation to route
--      around later. If a shared-purse chain is ever wanted, it wants its own
--      table and its own migration, and this column is not in its way.
--
--   2. vendor_applications.location_label + .locations — apply once for N.
--
--      /join collected exactly one business, so a two-location owner had to
--      apply twice: the second submission hit the unique index on lower(email)
--      with a 409 while the first was pending, and only worked once the first
--      had been accepted (which deletes the row). The queue also read as two
--      unrelated businesses that happen to share an inbox.
--
--      `locations` holds locations TWO AND UP as a jsonb array; the existing
--      business_name / address / logo / cuisine / price_level columns stay as
--      location one. That split is deliberate: the unique index, the operator's
--      search, the queue's card title and every existing accept path keep
--      working on the columns they already read, and an application that names
--      one location is byte-for-byte what it was before this migration.
--
--      Shape of each element, all optional but `name` (validated in
--      src/routes/apply.js, which is where it has to be right — an application
--      is an inbox, not a source of truth):
--        { "name": "Joe's Pizza", "locationLabel": "Campus",
--          "address": "…", "cuisine": ["pizza"], "priceLevel": 2,
--          "logo": "data:image/png;base64,…" }
--
--      Accepting one application creates one vendors row per location and
--      links EVERY row to the same login, then discards the application with
--      the rest of the row.
--
--   ⚠ DEPLOY ORDER: run this BEFORE deploying the server code, which selects
--   location_label on /api/vendor/config and locations on the applications
--   queue. (The reverse order is safe for the DB — nothing here is read until
--   the server asks.)
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-042. Safe to re-run (IF NOT EXISTS, and the constraints are
--   added conditionally).
-- ============================================================

-- ---------- 1. vendors.location_label ----------

alter table public.vendors
  add column if not exists location_label text;

comment on column public.vendors.location_label is
  'Short human label for WHICH branch this row is ("Downtown", "Campus"), '
  'shown by the terminal store switcher and the admin roster when one login '
  'runs several locations. NULL for single-location vendors, which is the '
  'default and the common case: readers fall back to address, then to name. '
  'Not a key — no uniqueness, nothing joins on it.';

-- Length only. A label is a chip caption; past ~40 characters it is a sentence
-- and it truncates on the terminal's top bar anyway.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.vendors'::regclass
      and conname = 'vendors_location_label_len'
  ) then
    alter table public.vendors
      add constraint vendors_location_label_len
      check (location_label is null or char_length(location_label) <= 40);
  end if;
end $$;

-- ---------- 2. vendor_applications: location one's label ----------

alter table public.vendor_applications
  add column if not exists location_label text;

comment on column public.vendor_applications.location_label is
  'The applicant''s label for their FIRST location (business_name/address on '
  'this row). Copied to vendors.location_label on accept, then discarded with '
  'the application.';

-- ---------- 3. vendor_applications: locations two and up ----------

alter table public.vendor_applications
  add column if not exists locations jsonb not null default '[]'::jsonb;

comment on column public.vendor_applications.locations is
  'ADDITIONAL locations beyond the first, as a jsonb array of '
  '{name, locationLabel, address, cuisine, priceLevel, logo}. Location one '
  'stays in this row''s own columns, so an application naming a single '
  'business is unchanged by migration-043. Accepting creates one vendors row '
  'per entry, all linked to the same login. Validated in src/routes/apply.js.';

-- An object here would make the accept loop iterate a string's characters, and
-- a null would make it throw. Neither is worth a runtime branch on every read.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.vendor_applications'::regclass
      and conname = 'vendor_applications_locations_array'
  ) then
    alter table public.vendor_applications
      add constraint vendor_applications_locations_array
      check (jsonb_typeof(locations) = 'array');
  end if;
end $$;
