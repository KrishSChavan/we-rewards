-- Assertions for migration-048 (student_visited_vendor_ids).
--
-- The function is four lines of SQL, which is exactly why it is worth testing:
-- every plausible bug in it is a bug of OMISSION, and an omission still applies
-- cleanly, still returns rows, and still looks right in the SQL editor. Each
-- assertion below fails loudly if one rule the header claims is missing:
--
--   'redeem' counts            — a copy of top_vendors_by_visits' 'earn'-only
--                                filter would drop it
--   'community_transfer' does not
--   a punch card counts on EXISTENCE, not punches > 0
--   the result is DISTINCT
--   p_user_id actually scopes the answer
--
-- The last block writes a transaction directly, so this session needs
-- migration-025's write override the same way seed-048 does. Session-scoped
-- (`false`), set outside the do-block so it is in force for the whole file.
select set_config('app.points_write', 'server', false);

do $$
declare
  s1       uuid := '00000000-0000-0000-0000-000000000481';
  s2       uuid := '00000000-0000-0000-0000-000000000482';
  bought   uuid := '00000000-0000-0000-0000-0000000004b1';
  redeemed uuid := '00000000-0000-0000-0000-0000000004b2';
  punched  uuid := '00000000-0000-0000-0000-0000000004b3';
  transfer uuid := '00000000-0000-0000-0000-0000000004b4';
  never    uuid := '00000000-0000-0000-0000-0000000004b5';
  n        integer;
begin
  -- ---------- what counts ----------

  select count(*) into n
  from public.student_visited_vendor_ids(s1) where vendor_id = bought;
  if n = 1 then raise notice 'PASS visited: an earn counts as a visit';
  else raise notice 'FAIL visited: earn vendor returned % times, expected 1', n; end if;

  -- You cannot spend points at a counter you have never stood at.
  select count(*) into n
  from public.student_visited_vendor_ids(s1) where vendor_id = redeemed;
  if n = 1 then raise notice 'PASS visited: a redeem counts as a visit';
  else raise notice 'FAIL visited: redeem-only vendor returned % rows, expected 1', n; end if;

  -- THE one that makes this safe for regulars: the card exists with punches = 0
  -- because they cashed a visits reward in. They have still been there.
  select count(*) into n
  from public.student_visited_vendor_ids(s1) where vendor_id = punched;
  if n = 1 then raise notice 'PASS visited: a punch card with punches = 0 still counts';
  else raise notice 'FAIL visited: spent punch card returned % rows, expected 1 (punches > 0 test?)', n; end if;

  -- ---------- what does not ----------

  select count(*) into n
  from public.student_visited_vendor_ids(s1) where vendor_id = transfer;
  if n = 0 then raise notice 'PASS visited: a community_transfer is not a visit';
  else raise notice 'FAIL visited: transfer-only vendor returned % rows, expected 0', n; end if;

  select count(*) into n
  from public.student_visited_vendor_ids(s1) where vendor_id = never;
  if n = 0 then raise notice 'PASS visited: a spot with no history is not returned';
  else raise notice 'FAIL visited: never-visited vendor returned % rows, expected 0', n; end if;

  -- ---------- shape ----------

  -- Two earns at Bought At, one vendor. Without the dedupe the client would
  -- still work and the row count would still be wrong, so assert it directly.
  select count(*) into n from public.student_visited_vendor_ids(s1);
  if n = 3 then raise notice 'PASS visited: three vendors, deduped (2 earns at one spot collapse)';
  else raise notice 'FAIL visited: expected 3 distinct vendors, got %', n; end if;

  -- p_user_id genuinely scopes it. A function that ignored the argument would
  -- have passed every assertion above.
  select count(*) into n
  from public.student_visited_vendor_ids(s2) where vendor_id = never;
  if n = 1 then raise notice 'PASS visited: the other student HAS been to the never-been spot';
  else raise notice 'FAIL visited: s2 history missing, got % rows', n; end if;

  select count(*) into n from public.student_visited_vendor_ids(s2);
  if n = 1 then raise notice 'PASS visited: one student''s history never leaks into another''s';
  else raise notice 'FAIL visited: s2 returned % vendors, expected 1', n; end if;

  -- A student who has never done anything gets an empty list, not an error —
  -- the newest signup on the platform is the single most common caller.
  select count(*) into n
  from public.student_visited_vendor_ids('00000000-0000-0000-0000-0000000004ff');
  if n = 0 then raise notice 'PASS visited: an unknown student returns an empty list';
  else raise notice 'FAIL visited: unknown student returned % rows', n; end if;

  select count(*) into n from public.student_visited_vendor_ids(null);
  if n = 0 then raise notice 'PASS visited: a null user id returns an empty list, not an error';
  else raise notice 'FAIL visited: null user id returned % rows', n; end if;

  -- ---------- all-time, with no window ----------
  -- The oldest earn at Bought At is 400 days back, well outside every window
  -- in this codebase (tiers = 30 days, recent spots = 7, the ranking = 30). If
  -- a created_at bound ever creeps into this function, the vendor below drops
  -- out and this assertion says so.
  delete from public.transactions
   where user_id = s1 and vendor_id = bought and created_at > now() - interval '30 days';
  select count(*) into n
  from public.student_visited_vendor_ids(s1) where vendor_id = bought;
  if n = 1 then raise notice 'PASS visited: a 400-day-old visit still counts (no window)';
  else raise notice 'FAIL visited: old-only vendor returned % rows, expected 1', n; end if;

  -- ---------- the deactivated case ----------
  -- Unlike top_vendors_by_visits this must NOT filter on vendors.active. It
  -- answers a question about the student's history, and the catalogue the
  -- client applies it to has already dropped inactive spots — filtering here
  -- as well would only mean a re-activated vendor is briefly recommended to
  -- the regulars who never stopped going.
  update public.vendors set active = false where id = bought;
  select count(*) into n
  from public.student_visited_vendor_ids(s1) where vendor_id = bought;
  if n = 1 then raise notice 'PASS visited: history at a deactivated spot is still history';
  else raise notice 'FAIL visited: deactivated vendor returned % rows, expected 1', n; end if;
  update public.vendors set active = true where id = bought;

  -- ---------- the grant ----------
  -- This returns ONE student's history, so unlike top_vendors_by_visits it must
  -- be unreachable with the anon key that /api/public-config hands to every
  -- browser.
  if has_function_privilege('anon', 'public.student_visited_vendor_ids(uuid)', 'execute')
  then raise notice 'FAIL visited: anon can execute student_visited_vendor_ids';
  else raise notice 'PASS visited: anon cannot execute student_visited_vendor_ids';
  end if;

  if has_function_privilege('authenticated', 'public.student_visited_vendor_ids(uuid)', 'execute')
  then raise notice 'FAIL visited: authenticated can execute student_visited_vendor_ids';
  else raise notice 'PASS visited: authenticated cannot execute student_visited_vendor_ids';
  end if;

  if has_function_privilege('service_role', 'public.student_visited_vendor_ids(uuid)', 'execute')
  then raise notice 'PASS visited: service_role can execute student_visited_vendor_ids';
  else raise notice 'FAIL visited: service_role cannot execute student_visited_vendor_ids';
  end if;
end $$;
