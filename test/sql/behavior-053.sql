-- Assertions for migration-053 (ambassadors).
--
-- Three tables, a view, and no functions, which makes it look like there is
-- nothing to assert. There are six things, and each is a promise made somewhere
-- else in the stack that only this schema can keep:
--
--   * ONE CODE IS ONE CODE. The admin form promises "that code is already
--     Sarah's" rather than a second row nobody notices. That promise rests on
--     the code being stored uppercased and the column being UNIQUE. If the
--     CHECK that forces uppercase ever went, plain UNIQUE would let SARAH7 and
--     sarah7 both exist and the resolver would return whichever it found first.
--
--   * ONE EMAIL IS ONE PERSON, by the same argument and the same pair of rules.
--
--   * ONE ATTRIBUTION PER ACCOUNT, and here the index is the ONLY guard there
--     is. A banner's equivalent has community_grants' UNIQUE (ref_id, kind)
--     behind it; nothing is paid here, so there is no ledger row to fall back
--     on. This is the one assertion in the file with no second line of defence.
--
--   * THE AMBASSADOR IS PAID, ONCE PER RECRUIT, INTO THEIR OWN ACCOUNT. The
--     grant is keyed on ref_id = the NEW STUDENT with kind = 'ambassador', which
--     is what lets one ambassador be paid many times while making a second
--     payout for the same recruit impossible. That is a claim about
--     migration-039's UNIQUE (ref_id, kind) index holding for a kind it has
--     never seen, so it is executed here rather than assumed.
--
--   * THE TWO NAMESPACES REALLY DO OVERLAP. An 8-character ambassador code
--     lowercases into a legal banner code, and the database will happily hold
--     both. That is precisely why ambassadorConflict() in src/routes/admin.js
--     refuses it in Node — this asserts the hazard is real so nobody deletes
--     that guard as redundant.
--
--   * NOTHING REACHES THESE TABLES BUT THE SERVICE KEY. These rows hold a real
--     person's name, email and phone number. migration-037 exists because a
--     default ACL once exposed tables through the anon key, and that mistake
--     recurs on every hosted project.
--
-- NOT covered here, because it is not SQL: the code and cookie normalizers, the
-- resolver's banner-then-ambassador order, and the ten-minute new-account grace
-- window. test/ambassadors.test.js and test/tracked-qr.test.js hold those.

do $$
declare
  s1  uuid := '00000000-0000-0000-0000-000000000531';   -- a recruit
  s2  uuid := '00000000-0000-0000-0000-000000000532';   -- another recruit
  u1  uuid := '00000000-0000-0000-0000-000000000541';   -- Sarah's OWN account
  u2  uuid := '00000000-0000-0000-0000-000000000542';   -- Jordan's OWN account
  a1  uuid;
  a2  uuid;
  n   integer;
  bal integer;
  txt text;
begin
  -- ---------- the tables and the view landed ----------

  select count(*) into n from information_schema.tables
   where table_schema = 'public'
     and table_name in ('ambassadors', 'ambassador_scans', 'ambassador_signups');
  if n = 3 then raise notice 'PASS 053: all three tables exist';
  else raise notice 'FAIL 053: expected 3 tables, found %', n; end if;

  select count(*) into n from information_schema.views
   where table_schema = 'public' and table_name = 'ambassador_overview';
  if n = 1 then raise notice 'PASS 053: ambassador_overview exists';
  else raise notice 'FAIL 053: ambassador_overview is missing'; end if;

  -- user_id is what the admin form resolves from the email. Set explicitly here
  -- because this file is the database's half of the feature, not the route's.
  insert into public.ambassadors (code, name, email, phone, points, user_id, created_by)
  values ('SARAH7', 'Sarah Chen', 'sarah@psu.edu', '814 555 0134', 25, u1, 'ops@example.com')
  returning id into a1;

  insert into public.ambassadors (code, name, email, points, user_id)
  values ('JD01', 'Jordan Diaz', 'jordan@psu.edu', 10, u2)
  returning id into a2;
  raise notice 'PASS 053: an ambassador with no phone is accepted (the field is optional)';

  -- ---------- the code rules ----------

  -- Uppercase is a CHECK, not a convention. Without it, plain UNIQUE stops
  -- being a case-insensitive uniqueness check and the whole "that code is
  -- already taken" promise quietly stops holding.
  begin
    insert into public.ambassadors (code, name, email) values ('lower7', 'L', 'l@psu.edu');
    raise notice 'FAIL 053: a lowercase code was stored (UNIQUE is no longer case-insensitive)';
  exception when check_violation then
    raise notice 'PASS 053: a lowercase code is refused by the column';
  end;

  begin
    insert into public.ambassadors (code, name, email) values ('AB', 'S', 'short@psu.edu');
    raise notice 'FAIL 053: a 2-character code was accepted';
  exception when check_violation then
    raise notice 'PASS 053: a code below 3 characters is refused';
  end;

  begin
    insert into public.ambassadors (code, name, email) values ('ABCDEFGHIJK', 'L', 'long@psu.edu');
    raise notice 'FAIL 053: an 11-character code was accepted';
  exception when check_violation then
    raise notice 'PASS 053: a code above 10 characters is refused';
  end;

  begin
    insert into public.ambassadors (code, name, email) values ('PSU-SARAH', 'H', 'hyphen@psu.edu');
    raise notice 'FAIL 053: a code with a hyphen was accepted';
  exception when check_violation then
    raise notice 'PASS 053: a code with a symbol is refused';
  end;

  -- The two ends of the allowed range, which is where an off-by-one lives.
  insert into public.ambassadors (code, name, email) values ('ABC', 'Min', 'min@psu.edu');
  insert into public.ambassadors (code, name, email) values ('ABCDEFGHIJ', 'Max', 'max@psu.edu');
  raise notice 'PASS 053: exactly 3 and exactly 10 characters are both accepted (boundaries)';

  -- Digits alone. An operator numbering their ambassadors 001, 002 is a real
  -- thing to do and nothing in the column should treat a code as a word.
  insert into public.ambassadors (code, name, email) values ('001', 'Num', 'num@psu.edu');
  raise notice 'PASS 053: a digits-only code is accepted';

  begin
    insert into public.ambassadors (code, name, email) values ('SARAH7', 'Impostor', 'other@psu.edu');
    raise notice 'FAIL 053: a duplicate code was accepted';
  exception when unique_violation then
    raise notice 'PASS 053: a duplicate code is refused';
  end;

  -- ---------- the email rules ----------

  begin
    insert into public.ambassadors (code, name, email) values ('DUPE1', 'Dupe', 'sarah@psu.edu');
    raise notice 'FAIL 053: a duplicate email was accepted';
  exception when unique_violation then
    raise notice 'PASS 053: a duplicate email is refused';
  end;

  begin
    insert into public.ambassadors (code, name, email) values ('UPPER1', 'U', 'Sarah@PSU.edu');
    raise notice 'FAIL 053: a mixed-case email was stored (UNIQUE is no longer case-insensitive)';
  exception when check_violation then
    raise notice 'PASS 053: a mixed-case email is refused by the column';
  end;

  begin
    insert into public.ambassadors (code, name, email) values ('NOAT1', 'N', 'notanemail');
    raise notice 'FAIL 053: an address with no @ was accepted';
  exception when check_violation then
    raise notice 'PASS 053: an address with no @ is refused';
  end;

  -- ---------- a name an operator can read ----------

  begin
    insert into public.ambassadors (code, name, email) values ('BLANK1', '   ', 'blank@psu.edu');
    raise notice 'FAIL 053: a whitespace-only name was accepted';
  exception when check_violation then
    raise notice 'PASS 053: a whitespace-only name is refused';
  end;

  -- ---------- the payout rate ----------

  begin
    insert into public.ambassadors (code, name, email, points) values ('NEG1', 'N', 'neg@psu.edu', -1);
    raise notice 'FAIL 053: a negative payout was accepted';
  exception when check_violation then
    raise notice 'PASS 053: a negative payout is refused';
  end;

  -- 5000 is signup-bonus.js's POINTS_MAX. An ambassador is a sibling of that
  -- deal and of the poster QR, so they must not be able to outbid either.
  begin
    insert into public.ambassadors (code, name, email, points) values ('BIG1', 'B', 'big@psu.edu', 5001);
    raise notice 'FAIL 053: a 5001-point payout was accepted (ceiling missing?)';
  exception when check_violation then
    raise notice 'PASS 053: a payout above 5000 is refused by the column';
  end;

  insert into public.ambassadors (code, name, email, points) values ('ZERO1', 'Z', 'zero@psu.edu', 0);
  raise notice 'PASS 053: a 0-point (measure-only) ambassador is accepted';

  -- ---------- the traffic ----------

  insert into public.ambassador_scans (ambassador_id, visitor_hash, user_agent)
  values (a1, repeat('a', 64), 'Mozilla/5.0 (iPhone)'),
         (a1, repeat('a', 64), 'Mozilla/5.0 (iPhone)'),   -- same phone, twice
         (a1, repeat('b', 64), 'Mozilla/5.0 (Android)'),
         (a1, null, 'Mozilla/5.0 (cookies refused)');

  -- A scan with no visitor_hash is a real and uninteresting case: the browser
  -- refused the cookie. It still counts as a scan, which is why the column is
  -- nullable and why uniques is a count(distinct) that ignores it.
  raise notice 'PASS 053: a scan with no visitor cookie is still recorded';

  -- ---------- the money ----------
  --
  -- This is the evaluator's payout, executed against the real rail rather than
  -- described. p_user_id is the AMBASSADOR (who is paid); p_ref_id is the
  -- RECRUIT (the idempotency key). Getting those two the wrong way round is the
  -- single most likely mistake in this feature and would pay the recruit.
  perform public.grant_community_points(u1, 25, 'ambassador', 'Ambassador signup: SARAH7', null, s1, 'system');
  insert into public.ambassador_signups (ambassador_id, user_id, points) values (a1, s1, 25);

  select balance into bal from public.community_balances where user_id = u1;
  if bal = 25 then raise notice 'PASS 053: the AMBASSADOR is credited, not the recruit';
  else raise notice 'FAIL 053: expected Sarah to hold 25 points, got %', coalesce(bal::text, 'no row'); end if;

  select count(*) into n from public.community_balances where user_id = s1;
  if n = 0 then raise notice 'PASS 053: the recruit is paid nothing by this feature';
  else raise notice 'FAIL 053: the recruit was credited — p_user_id and p_ref_id are swapped'; end if;

  -- ONE PAYOUT PER RECRUIT, EVER. This is migration-039's UNIQUE (ref_id, kind)
  -- index doing its job for a kind it has never seen before, which is exactly
  -- why it is executed here rather than assumed to generalise.
  begin
    perform public.grant_community_points(u1, 25, 'ambassador', 'again', null, s1, 'system');
    raise notice 'FAIL 053: the same recruit paid an ambassador twice';
  exception when others then
    if sqlerrm like '%GRANT_ALREADY_PAID%' then
      raise notice 'PASS 053: a second payout for the same recruit is refused';
    else raise notice 'FAIL 053: unexpected error on the repeat payout: %', sqlerrm; end if;
  end;

  -- ...AND THE SAME RECRUIT CANNOT PAY A DIFFERENT AMBASSADOR EITHER. The key
  -- is (ref_id, kind), so it is the recruit that is spent, not the pairing.
  begin
    perform public.grant_community_points(u2, 10, 'ambassador', 'poaching', null, s1, 'system');
    raise notice 'FAIL 053: one recruit paid two different ambassadors';
  exception when others then
    if sqlerrm like '%GRANT_ALREADY_PAID%' then
      raise notice 'PASS 053: one recruit cannot pay a second ambassador';
    else raise notice 'FAIL 053: unexpected error on the poaching payout: %', sqlerrm; end if;
  end;

  -- AN AMBASSADOR IS PAID AGAIN FOR A DIFFERENT RECRUIT. The other half of the
  -- same index: without this the feature would pay each ambassador once, ever.
  perform public.grant_community_points(u1, 25, 'ambassador', 'Ambassador signup: SARAH7', null, s2, 'system');
  select balance into bal from public.community_balances where user_id = u1;
  if bal = 50 then raise notice 'PASS 053: the same ambassador IS paid again for a different recruit';
  else raise notice 'FAIL 053: expected Sarah to hold 50 after a second recruit, got %', bal; end if;

  -- The poster QR pays on the same rail with a different kind. The two must not
  -- collide: a student recruited by an ambassador can still be worth a banner
  -- award, because (ref_id, kind) differs in the kind.
  perform public.grant_community_points(s1, 5, 'tracked_qr', 'Poster QR', null, s1, 'system');
  raise notice 'PASS 053: an ambassador payout does not block that recruit''s poster-QR award';

  -- ---------- one attribution per account ----------

  begin
    -- The same student credited to a SECOND ambassador. A 0-rate ambassador
    -- writes no grant at all, so the ledger index never sees them and this
    -- index is their only guard.
    insert into public.ambassador_signups (ambassador_id, user_id) values (a2, s1);
    raise notice 'FAIL 053: one student was credited to two ambassadors';
  exception when unique_violation then
    raise notice 'PASS 053: a student cannot be credited to a second ambassador';
  end;

  insert into public.ambassador_signups (ambassador_id, user_id, points) values (a2, s2, 10);
  raise notice 'PASS 053: a different student CAN be credited to a different ambassador';

  -- ---------- what was paid is frozen at payout time ----------
  --
  -- An operator raising the rate next month must not silently rewrite what last
  -- month's recruits were worth. This is the whole reason ambassador_signups
  -- carries its own points column instead of the report reading a.points.
  update public.ambassadors set points = 500 where id = a1;
  select points into n from public.ambassador_signups where ambassador_id = a1 and user_id = s1;
  if n = 25 then raise notice 'PASS 053: raising the rate does not rewrite what past recruits were worth';
  else raise notice 'FAIL 053: a past recruit is now recorded as % points', n; end if;
  update public.ambassadors set points = 25 where id = a1;

  -- ---------- the roll-up the admin list actually reads ----------

  select scans into n from public.ambassador_overview where id = a1;
  if n = 4 then raise notice 'PASS 053: overview counts every scan, cookie or not';
  else raise notice 'FAIL 053: expected 4 scans, got %', n; end if;

  -- Two rows share a visitor_hash and one has none. "People" must be 2, not 4
  -- and not 3 — one phone scanning twice is one person, and a null is nobody.
  select uniques into n from public.ambassador_overview where id = a1;
  if n = 2 then raise notice 'PASS 053: overview counts a returning phone once and ignores null visitors';
  else raise notice 'FAIL 053: expected 2 unique people, got %', n; end if;

  select signups into n from public.ambassador_overview where id = a1;
  if n = 1 then raise notice 'PASS 053: overview counts attributed signups';
  else raise notice 'FAIL 053: expected 1 signup, got %', n; end if;

  select points_awarded into n from public.ambassador_overview where id = a1;
  if n = 25 then raise notice 'PASS 053: overview sums what an ambassador has actually earned';
  else raise notice 'FAIL 053: expected 25 points earned, got %', n; end if;

  -- ---------- has_account is what the row warns on ----------

  select count(*) into n from public.ambassador_overview where id = a1 and has_account;
  if n = 1 then raise notice 'PASS 053: an ambassador with an account reads has_account = true';
  else raise notice 'FAIL 053: has_account is false for an ambassador who has one'; end if;

  -- Deleting the ambassador's OWN student account must not delete the
  -- ambassador: their code is still in someone's bio and their history is still
  -- the operator's data. They just stop earning, which has_account says.
  delete from public.profiles where user_id = u2;
  select count(*) into n from public.ambassadors where id = a2;
  if n = 1 then raise notice 'PASS 053: deleting an ambassador''s own account does not delete the ambassador';
  else raise notice 'FAIL 053: the ambassador row went with their student account (CASCADE instead of SET NULL?)'; end if;

  select count(*) into n from public.ambassador_overview where id = a2 and has_account = false;
  if n = 1 then raise notice 'PASS 053: an ambassador with no account reads has_account = false';
  else raise notice 'FAIL 053: has_account did not go false when the account was deleted'; end if;

  -- And the payout that would have gone to them is refused loudly by the rail
  -- rather than landing somewhere else.
  begin
    perform public.grant_community_points(u2, 10, 'ambassador', 'gone', null, s2, 'system');
    raise notice 'FAIL 053: points were paid to a deleted account';
  exception when others then
    if sqlerrm like '%GRANT_STUDENT_UNKNOWN%' then
      raise notice 'PASS 053: paying an ambassador with no account is refused, not silently misdirected';
    else raise notice 'FAIL 053: unexpected error paying a deleted account: %', sqlerrm; end if;
  end;

  -- An ambassador nobody has scanned must read as zeros, not as a missing row.
  -- The list renders every row, so a null here would print "null scans".
  select scans into n from public.ambassador_overview where id = a2;
  if n = 0 then raise notice 'PASS 053: an unscanned ambassador rolls up as 0, not null';
  else raise notice 'FAIL 053: expected 0 scans for an unscanned ambassador, got %', n; end if;

  -- ---------- turning someone off never hides them ----------
  --
  -- `active` gates the redirect in Node, not the read. The row, its code and
  -- its whole history have to stay visible in /admin, which is what the operator
  -- was promised when the button said "keeps their history".
  update public.ambassadors set active = false where id = a1;
  select count(*) into n from public.ambassador_overview where id = a1 and scans = 4;
  if n = 1 then raise notice 'PASS 053: a switched-off ambassador keeps their row and their history';
  else raise notice 'FAIL 053: switching an ambassador off changed what the list can read'; end if;
  update public.ambassadors set active = true where id = a1;

  -- ---------- the two namespaces on /r/ really can collide ----------
  --
  -- SARAHXYZ is 8 characters, so lowercased it is a legal banner code — and
  -- seed-053 already planted exactly that banner. Both rows coexist happily
  -- here, and the resolver tries banners first, so this ambassador would never
  -- be reached. That is why the refusal lives in Node; this proves the hazard
  -- is real rather than theoretical.
  insert into public.ambassadors (code, name, email) values ('SARAHXYZ', 'Collide', 'collide@psu.edu');
  select count(*) into n from public.tracked_qr_codes where code = 'sarahxyz';
  if n = 1 then
    raise notice 'PASS 053: an ambassador code CAN shadow a banner code — the Node guard is load-bearing';
  else raise notice 'FAIL 053: the seeded banner is missing, so this assertion proved nothing'; end if;

  -- ---------- deleting an ambassador takes their scans, not their students ----------

  delete from public.ambassadors where id = a2;
  select count(*) into n from public.ambassador_signups where ambassador_id = a2;
  if n = 0 then raise notice 'PASS 053: deleting an ambassador cascades their attribution rows away';
  else raise notice 'FAIL 053: % orphaned attribution row(s) survived the delete', n; end if;

  select count(*) into n from public.profiles where user_id = s2;
  if n = 1 then raise notice 'PASS 053: the student they recruited is untouched';
  else raise notice 'FAIL 053: deleting an ambassador deleted a student account'; end if;

  -- ---------- nothing here is reachable with the browser key ----------
  --
  -- These rows hold a real person's name, email and phone number. The anon key
  -- ships to every phone, and migration-037 exists because a default ACL once
  -- exposed tables through it — a mistake that recurs on every hosted project,
  -- so every new object is asserted rather than assumed.
  select count(*) into n
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('ambassadors', 'ambassador_scans', 'ambassador_signups', 'ambassador_overview')
     and grantee in ('anon', 'authenticated');
  if n = 0 then raise notice 'PASS 053: anon and authenticated hold no privilege on any ambassador object';
  else raise notice 'FAIL 053: % browser-key privileges are still granted', n; end if;

  -- RLS on with no policy means service_role (which bypasses it) is the only
  -- way in, even if a grant is added by accident later.
  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relname in ('ambassadors', 'ambassador_scans', 'ambassador_signups')
     and c.relrowsecurity;
  if n = 3 then raise notice 'PASS 053: row level security is enabled on all three tables';
  else raise notice 'FAIL 053: RLS is enabled on only % of 3 tables', n; end if;

  -- The view must not run as its owner, or it becomes a way around the base
  -- tables' RLS. Same trap migration-037 was written to close.
  select c.reloptions::text into txt from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relname = 'ambassador_overview';
  if txt like '%security_invoker=true%' then
    raise notice 'PASS 053: ambassador_overview is security_invoker';
  else raise notice 'FAIL 053: ambassador_overview is not security_invoker (options: %)', txt; end if;
end $$;
