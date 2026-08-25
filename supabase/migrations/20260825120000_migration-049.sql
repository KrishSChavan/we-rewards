-- ============================================================
-- Migration 049 — a vendor's contact details survive acceptance.
--
--   THE BUG THIS CLOSES. /join has always asked an applicant for a contact name
--   and a phone number, and migration-018 stored both on vendor_applications.
--   The vendors table has never had anywhere to put them, so
--   POST /api/admin/applications/:id/accept never carried them across — and the
--   last step of that handler DELETES the application row. The phone number was
--   therefore collected on a public form, shown to the operator exactly once in
--   the review queue, and destroyed at the moment the vendor became real.
--
--   That is the wrong way round. The contact NAME and the free-text `message`
--   genuinely are review-time artifacts: they exist to help the operator decide,
--   and once the decision is made they have done their job. The PHONE NUMBER is
--   the opposite. It is the channel the entire operator-dictated recovery flow
--   in migration-031 is built on — the operator recognising a voice is a
--   stronger gate than a mailbox, and since migration-047 made the mailbox the
--   everyday path, dictation is specifically what is left for a vendor who has
--   lost the mailbox too. Losing the number at acceptance means the one vendor
--   who most needs to be phoned is the one there is no number for.
--
--   The contact name comes along because it costs one column and it is what
--   makes the number usable: "call 814-555-0134" is a worse instruction than
--   "call Sam on 814-555-0134", and the operator making that call is reading a
--   roster of forty rows.
--
--   PER LOCATION, like address, not per login. One application can open several
--   branches (migration-043), and the accept path copies the applicant's single
--   contact onto every row it creates — on day one one person really is the
--   contact for all of them. Keeping the columns on vendors rather than on the
--   login is what lets that stop being true later: a chain that puts a manager
--   in each store can be corrected branch by branch from /admin, which a
--   login-level column could not express. It also matches how `address` already
--   behaves, so there is one rule for "facts about this storefront" rather than
--   two.
--
--   NO BACKFILL IS POSSIBLE, and that is worth stating plainly rather than
--   leaving someone to discover it. Every vendor accepted before this migration
--   had their application row deleted outright, so the number is genuinely gone
--   rather than merely unreferenced — there is no table left to read it out of.
--   Both columns therefore start NULL for the whole existing roster and are
--   filled in by hand through PATCH /api/admin/vendors/:id, which is why the
--   operator's edit dialog grows the two fields in the same change. The admin
--   roster renders a missing phone as a visible gap for the same reason: the
--   work of re-collecting forty numbers only happens if the screen keeps asking.
--
--   Idempotent and safe to re-run.
-- ============================================================

-- ---------- 1. the two columns ----------

alter table public.vendors
  add column if not exists contact_name text;

alter table public.vendors
  add column if not exists phone text;

comment on column public.vendors.contact_name is
  'The person to ask for at this location. Copied from vendor_applications on '
  'accept (migration-049), typed by the operator for a vendor added by hand, '
  'and editable per location afterwards. NULL for every vendor onboarded before '
  'migration-049, whose application row — and with it this value — was already '
  'deleted. Operator-facing only: never sent to a student or a terminal.';

comment on column public.vendors.phone is
  'How the operator reaches this location by voice. Load-bearing rather than '
  'decorative: dictating a reset code down the phone (migration-031) is the '
  'only recovery path left for a vendor who has lost the mailbox as well as the '
  'password, and until migration-049 this number was destroyed at acceptance. '
  'Stored as typed (digits, spaces and () + . - only), never normalised to E.164 '
  '— it is dialled by a human, not by software. NULL for the pre-049 roster. '
  'Operator-facing only.';

-- ---------- 2. length bounds ----------
--
-- Bounds only, and the SAME bounds src/routes/apply.js applies at the public
-- door, because /join and the operator's "Add vendor" form onboard through one
-- code path and must not drift into accepting different things. Shape is
-- validated in Node (PHONE_RE) rather than here for the reason migration-042
-- gives about cuisine tags: a constraint that rejects turns a support screen
-- into a 500, while a validator that refuses turns it into a message someone
-- can act on. These exist to stop a pasted essay reaching the column at all.
--
-- Conditional adds, in the migration-043 style, so re-running is a no-op.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.vendors'::regclass
      and conname = 'vendors_contact_name_len'
  ) then
    alter table public.vendors
      add constraint vendors_contact_name_len
      check (contact_name is null or char_length(contact_name) <= 80);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.vendors'::regclass
      and conname = 'vendors_phone_len'
  ) then
    alter table public.vendors
      add constraint vendors_phone_len
      check (phone is null or char_length(phone) <= 20);
  end if;
end $$;

-- ---------- 3. no grant changes ----------
--
-- Deliberately none. Both columns land on a table whose privileges were settled
-- in 20260807045446_grant_service_role_on_public_tables.sql, and a new column on
-- an existing table inherits that table's grants — so anon and authenticated
-- still cannot read vendors directly, and these two never leave the server
-- except through requireAdmin (src/middleware/auth.js).
--
-- Which matters here more than it usually would: every OTHER column on this
-- table is public by intent — name, address, logo and price level are rendered
-- on a student's card. contact_name and phone are the first columns on vendors
-- that are not, and the student catalogue reads (src/lib/cache.js,
-- src/routes/student.js) name their columns explicitly rather than select('*'),
-- so neither can be picked up by an existing query by accident.
