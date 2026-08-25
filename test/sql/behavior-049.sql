-- Assertions for migration-049 (vendors.contact_name / vendors.phone).
--
-- The migration is two `add column if not exists` and two conditional check
-- constraints, which is about as small as a migration in this repo gets. What
-- makes it worth asserting is that it lands on a table that ALREADY HAS ROWS,
-- and every way to get that wrong still looks correct in an editor:
--
--   * a column added `not null` with no default fails outright on a live table;
--   * a check written without its `is null` arm rejects every existing row,
--     because every existing row is null here by construction;
--   * a bound that disagrees with src/routes/apply.js (PHONE_RE, 20) turns an
--     operator's typo into a 500 from Postgres instead of a message they can
--     act on — the two doors share one column and must share one rule;
--   * and the whole thing is claimed to be re-runnable, which is only true if
--     the constraint adds are genuinely conditional.
--
-- The last of those is the one that would go unnoticed longest: a second run is
-- how this migration reaches a database it half-applied to.
--
-- NOT covered here, because it is not SQL: the copy itself. Carrying
-- contact_name and phone off vendor_applications and onto every vendors row an
-- accept creates happens in onboardVendor (src/routes/admin.js), and the
-- validators either side of it are held by test/admin-vendors.test.js.

do $$
declare
  diner  uuid := '00000000-0000-0000-0000-0000000004c1';
  chain1 uuid := '00000000-0000-0000-0000-0000000004c2';
  chain2 uuid := '00000000-0000-0000-0000-0000000004c3';
  n      integer;
  txt    text;
begin
  -- ---------- the migration survived a populated table ----------

  select count(*) into n from public.vendors
   where id in (diner, chain1, chain2);
  if n = 3 then raise notice 'PASS 049: every pre-049 vendor survived the migration';
  else raise notice 'FAIL 049: expected 3 seeded vendors, found %', n; end if;

  -- NULL, not ''. The admin roster renders a missing phone as a visible
  -- "no phone" so the pre-049 backlog gets re-collected by hand; an empty
  -- string would render as a filled-in blank and that prompt would never
  -- appear. There is nothing to backfill from — the application rows these
  -- vendors came from were deleted at accept — so null is the honest value.
  select count(*) into n from public.vendors
   where id in (diner, chain1, chain2)
     and contact_name is null and phone is null;
  if n = 3 then raise notice 'PASS 049: existing vendors read back NULL, not blank';
  else raise notice 'FAIL 049: expected 3 null contacts, found %', n; end if;

  -- ---------- the columns are writable, per location ----------

  update public.vendors set contact_name = 'Sam', phone = '814 555 0134'
   where id = diner;
  select phone into txt from public.vendors where id = diner;
  if txt = '814 555 0134' then raise notice 'PASS 049: a contact can be written to an existing vendor';
  else raise notice 'FAIL 049: phone read back as %, expected 814 555 0134', txt; end if;

  -- PER LOCATION, not per login. c2 and c3 share one login (migration-043) and
  -- the accept path gives them the same contact on day one, but a chain that
  -- later puts a manager in each store has to be correctable branch by branch.
  -- If these columns had gone on the login instead, this pair of updates would
  -- be one value fighting itself.
  update public.vendors set contact_name = 'Ana',  phone = '814 555 0201' where id = chain1;
  update public.vendors set contact_name = 'Bilal', phone = '814 555 0202' where id = chain2;
  select count(distinct phone) into n from public.vendors where id in (chain1, chain2);
  if n = 2 then raise notice 'PASS 049: two locations on one login hold different contacts';
  else raise notice 'FAIL 049: expected 2 distinct phones across the chain, found %', n; end if;

  -- ---------- the bounds are installed and match /join ----------

  -- 20 is PHONE_RE's own ceiling in src/routes/apply.js. A column that accepted
  -- more would let the admin door store something the public door could not.
  begin
    update public.vendors set phone = repeat('9', 21) where id = diner;
    raise notice 'FAIL 049: a 21-character phone was accepted (vendors_phone_len missing?)';
  exception when check_violation then
    raise notice 'PASS 049: a 21-character phone is refused by the column';
  end;

  begin
    update public.vendors set contact_name = repeat('x', 81) where id = diner;
    raise notice 'FAIL 049: an 81-character contact name was accepted (vendors_contact_name_len missing?)';
  exception when check_violation then
    raise notice 'PASS 049: an 81-character contact name is refused by the column';
  end;

  -- The boundary the other way, so the constraint is not simply rejecting
  -- everything: exactly at the cap must pass.
  update public.vendors set phone = repeat('9', 20), contact_name = repeat('x', 80)
   where id = diner;
  raise notice 'PASS 049: exactly 20 / 80 characters are accepted (boundary)';

  -- Clearing back to null has to stay possible, or a wrong number could only
  -- ever be overwritten and never removed. This is what PATCH sends when the
  -- operator empties the field.
  update public.vendors set contact_name = null, phone = null where id = diner;
  raise notice 'PASS 049: a contact can be cleared back to NULL';
end $$;

-- ---------- the source side is untouched ----------
--
-- 049 COPIES from vendor_applications at accept time; it does not move or drop
-- anything. If the application's own phone column ever went away, the accept
-- path would silently start writing nulls and the bug this migration closes
-- would quietly reopen with all the new plumbing still in place.
do $$
declare txt text;
begin
  select phone into txt from public.vendor_applications
   where id = '00000000-0000-0000-0000-0000000004d1';
  if txt = '814 555 0134' then raise notice 'PASS 049: vendor_applications.phone still holds the applicant''s number';
  else raise notice 'FAIL 049: application phone read back as %, expected 814 555 0134', txt; end if;
end $$;

-- ---------- re-runnable ----------
--
-- The header claims idempotence, and a second run is how this migration meets a
-- database it half-applied to. Both halves have to be no-ops: `add column if not
-- exists` is, and the constraint adds are only because they are wrapped in an
-- existence check — an unguarded `add constraint` raises 42710 on the second
-- pass and aborts the whole file, taking every later migration with it.
--
-- Re-applying it here rather than trusting the guard: this is the assertion that
-- would otherwise be written as a comment and never checked.
--
-- /tmp is where run.ps1 docker-cp's every migration before applying it, so the
-- file is already in the container under its full prefixed name.
\i /tmp/20260825120000_migration-049.sql

do $$
declare n integer;
begin
  select count(*) into n from pg_constraint
   where conrelid = 'public.vendors'::regclass
     and conname in ('vendors_contact_name_len', 'vendors_phone_len');
  if n = 2 then raise notice 'PASS 049: re-running the migration is a clean no-op';
  else raise notice 'FAIL 049: expected 2 contact constraints after a re-run, found %', n; end if;
end $$;
