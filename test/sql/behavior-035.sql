-- Assertions for migration-035 (is_vendor column, triggers, email lookup).
do $$
declare
  a uuid := '00000000-0000-0000-0000-00000000000a';
  b uuid := '00000000-0000-0000-0000-00000000000b';
  c uuid := '00000000-0000-0000-0000-00000000000c';
  d uuid := '00000000-0000-0000-0000-00000000000d';
  v1 uuid;
  got uuid;
  flag boolean;
begin
  select id into v1 from public.vendors where slug = 'testvendor-035';

  -- 1. backfill flagged the dual account and left the student-only one alone
  select coalesce(is_vendor, false) into flag from public.profiles where user_id = c;
  if flag then raise notice 'PASS backfill: dual account flagged';
  else raise notice 'FAIL backfill: dual account not flagged'; end if;

  select coalesce(is_vendor, false) into flag from public.profiles where user_id = b;
  if not flag then raise notice 'PASS backfill: student-only account not flagged';
  else raise notice 'FAIL backfill: student-only account wrongly flagged'; end if;

  -- 2. inserting a staff link flips the flag on
  insert into public.vendor_staff (vendor_id, user_id, role) values (v1, b, 'owner');
  select coalesce(is_vendor, false) into flag from public.profiles where user_id = b;
  if flag then raise notice 'PASS trigger: staff insert sets is_vendor';
  else raise notice 'FAIL trigger: staff insert did not set is_vendor'; end if;

  -- 3. deleting the link flips it back off
  delete from public.vendor_staff where vendor_id = v1 and user_id = b;
  select coalesce(is_vendor, false) into flag from public.profiles where user_id = b;
  if not flag then raise notice 'PASS trigger: staff delete clears is_vendor';
  else raise notice 'FAIL trigger: staff delete left is_vendor set'; end if;

  -- 4. a profile created for an existing vendor is stamped at insert
  --    (a vendor signing into the student app and accepting the terms)
  insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version)
  values (a, 'vendor-only@example.com', 'A', now(), 'v1');
  select coalesce(is_vendor, false) into flag from public.profiles where user_id = a;
  if flag then raise notice 'PASS trigger: new profile for vendor staff stamped is_vendor';
  else raise notice 'FAIL trigger: new profile for vendor staff not stamped'; end if;

  -- 5. an accept-terms style upsert (re-consent) must not clobber the flag
  insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version)
  values (d, 'dual2@example.com', 'D2', now(), 'v2')
  on conflict (user_id) do update
    set email = excluded.email, name = excluded.name,
        terms_accepted_at = excluded.terms_accepted_at,
        terms_version = excluded.terms_version;
  select coalesce(is_vendor, false) into flag from public.profiles where user_id = d;
  if flag then raise notice 'PASS upsert: re-consent keeps is_vendor';
  else raise notice 'FAIL upsert: re-consent cleared is_vendor'; end if;

  -- 6. auth_user_id_by_email: case-insensitive, trimmed, null for unknown
  select public.auth_user_id_by_email('  DUAL@Example.COM  ') into got;
  if got = c then raise notice 'PASS lookup: case-insensitive + trimmed match';
  else raise notice 'FAIL lookup: expected %, got %', c, got; end if;

  select public.auth_user_id_by_email('nobody@example.com') into got;
  if got is null then raise notice 'PASS lookup: unknown email returns null';
  else raise notice 'FAIL lookup: unknown email returned %', got; end if;

  -- 7. deleting the vendor cascades the links away and clears every flag
  delete from public.vendors where id = v1;
  select bool_or(is_vendor) into flag from public.profiles where user_id in (a, c, d);
  if not coalesce(flag, false) then raise notice 'PASS cascade: vendor delete cleared is_vendor on all staff profiles';
  else raise notice 'FAIL cascade: vendor delete left is_vendor set somewhere'; end if;
end $$;
