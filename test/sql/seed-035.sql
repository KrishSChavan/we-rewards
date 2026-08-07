-- Pre-migration world for migration-035: one vendor, four auth users covering
-- every role mix the triggers must handle.
--   A vendor-only  (staff link, no profile)  -> later gains a profile (stamp test)
--   B student-only (profile, no staff link)  -> later gains/loses a staff link
--   C dual         (staff link + profile)    -> backfill must flag it
--   D dual         (staff link + profile)    -> upsert must not clobber the flag
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'vendor-only@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'student-only@example.com'),
  ('00000000-0000-0000-0000-00000000000c', 'dual@example.com'),
  ('00000000-0000-0000-0000-00000000000d', 'dual2@example.com');

insert into public.vendors (name, slug) values ('Test Vendor 035', 'testvendor-035');

insert into public.vendor_staff (vendor_id, user_id, role)
select v.id, u.uid, 'owner'
from public.vendors v,
     (values ('00000000-0000-0000-0000-00000000000a'::uuid),
             ('00000000-0000-0000-0000-00000000000c'::uuid),
             ('00000000-0000-0000-0000-00000000000d'::uuid)) as u(uid)
where v.slug = 'testvendor-035';

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-00000000000b', 'student-only@example.com', 'B', now(), 'v1'),
  ('00000000-0000-0000-0000-00000000000c', 'dual@example.com',         'C', now(), 'v1'),
  ('00000000-0000-0000-0000-00000000000d', 'dual2@example.com',        'D', now(), 'v1');
