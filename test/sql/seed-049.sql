-- Pre-migration world for migration-049 (vendors.contact_name / vendors.phone).
--
-- Tiny, and the smallness is the point. The migration adds two nullable columns
-- and two check constraints to a table that ALREADY HAS ROWS IN PRODUCTION, and
-- that is the only interesting thing about it: a constraint written without an
-- `is null` allowance, or a column added `not null` without a default, applies
-- fine to an empty table and fails on a live one. So the seed's whole job is to
-- make the table non-empty before the migration runs, with rows that look like
-- the real roster.
--
-- Three vendors, standing in for the three shapes the roster actually holds:
--
--   c1 "Pre049 Diner"   a plain single-location vendor onboarded long ago.
--   c2 "Pre049 Chain"   two rows, one login — the multi-location case
--   c3 "Pre049 Chain"     (migration-043). The accept path copies ONE contact
--                         onto every location it creates, so the migration has
--                         to leave both rows independently writable rather than
--                         assuming a contact belongs to a login.
--
-- None of them can be given a contact_name or a phone here: the columns do not
-- exist yet. That is exactly the state every existing vendor is in, and it is
-- why behaviour-049 asserts they come out NULL rather than blank — there is
-- nothing to backfill from. Their application rows were deleted at accept
-- (POST /api/admin/applications/:id/accept, last step), which is the bug 049
-- closes and the reason the numbers have to be re-collected by hand.

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000491', 'diner-049@example.com'),
  ('00000000-0000-0000-0000-000000000492', 'chain-049@example.com')
on conflict (id) do nothing;

insert into public.vendors (id, name, slug, active) values
  ('00000000-0000-0000-0000-0000000004c1', 'Pre049 Diner', 'pre049-diner',   true),
  ('00000000-0000-0000-0000-0000000004c2', 'Pre049 Chain', 'pre049-chain',   true),
  ('00000000-0000-0000-0000-0000000004c3', 'Pre049 Chain', 'pre049-chain-2', true);

-- One login, two locations — the migration-043 shape the contact columns have
-- to sit alongside without collapsing into it.
insert into public.vendor_staff (vendor_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-000000000491', 'owner'),
  ('00000000-0000-0000-0000-0000000004c2', '00000000-0000-0000-0000-000000000492', 'owner'),
  ('00000000-0000-0000-0000-0000000004c3', '00000000-0000-0000-0000-000000000492', 'owner');

-- A pending application, untouched by this migration but present so the
-- behaviour file can assert the SHAPE it hands over: vendor_applications keeps
-- its own phone column (migration-018), and 049 copies from it at accept time
-- rather than moving or dropping it. An accept is a Node code path, not a SQL
-- one, so this row is here to prove the source side still exists and still
-- matches the destination's bounds — not to exercise the copy.
insert into public.vendor_applications
  (id, business_name, contact_name, phone, email, password_hash)
values
  ('00000000-0000-0000-0000-0000000004d1', 'Applied 049', 'Sam Applicant',
   '814 555 0134', 'applied-049@example.com', 'x');
