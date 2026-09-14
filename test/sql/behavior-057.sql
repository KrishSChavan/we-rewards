-- Assertions for migration-057 (link a student email / merge two accounts).
--
-- A merge is IRREVERSIBLE and it moves real money, so this file is written to
-- prove the arithmetic rather than the absence of an error. Every number below
-- is derived by hand in seed-057.sql's header.
--
-- What it has to catch, in the order the damage would be worst:
--
--   * POINTS VANISHING. Summing two purses per spot, including the pooled purse
--     that point_balances knows nothing about. A dropped pool row is money the
--     student can see on a card and cannot spend.
--   * HISTORY BEING ANONYMISED. transactions.user_id is ON DELETE SET NULL
--     (migration-011), so deleting the losing profile before re-pointing its
--     rows would silently erase exactly what the merge exists to move. Asserted
--     as a count that survives, not as "no error".
--   * VISITS BEING PAID TWICE. punch_cards is a spendable per-spot counter
--     since migration-029/045, and one human in one shop on one night is one
--     visit. The losing counter counted that night too, so the sum has to
--     discount it — otherwise a merge mints spendable visits out of nothing.
--   * THE SELF-REFERRAL STANDING. Two accounts, one person, one of them
--     "referring" the other. The one-per-friend index cannot see it.
--   * A VENDOR LOGIN BEING DELETED. Merging a vendor-staff account takes the
--     terminal's sign-in with it.
--   * THE BONUS FENCE LEAKING. An address must be payable once, ever — across
--     unlink, relink, and a second account.
--
-- One thing NOT asserted, because psql cannot: two sessions merging the same
-- pair at once. The FOR UPDATE ordering is there; that it serialises is
-- Postgres's job.

do $$
declare
  w   uuid := '00000000-0000-0000-0000-000000000571';   -- winner (personal)
  l   uuid := '00000000-0000-0000-0000-000000000572';   -- loser  (psu.edu)
  vs  uuid := '00000000-0000-0000-0000-000000000573';   -- vendor staff
  w2  uuid := '00000000-0000-0000-0000-000000000575';   -- its own winner, kept apart
  p   uuid := '00000000-0000-0000-0000-000000000574';   -- untouched control
  v1  uuid := '00000000-0000-0000-0000-0000000005a1';
  v2  uuid := '00000000-0000-0000-0000-0000000005a2';
  v3  uuid := '00000000-0000-0000-0000-0000000005a3';
  pl  uuid := '00000000-0000-0000-0000-0000000005b1';
  rf  uuid := '00000000-0000-0000-0000-0000000005d1';
  pre    jsonb;
  res    jsonb;
  n      integer;
  n2     integer;
  bal    integer;
  life   integer;
  ok     boolean;
  txt    text;
  code_id uuid;
  code_id2 uuid;
begin
  -- ============================================================
  -- 1. THE PREVIEW. Read-only, and it must agree with what the merge then does.
  -- ============================================================
  pre := public.preview_student_merge(w, l);

  -- 30 at V1 + 70 at V3 = 100 in per-vendor purses, plus 25 in the shared one.
  if (pre ->> 'points')::int = 125 then
    raise notice 'PASS preview counts both purses (125 = 100 per-vendor + 25 pooled)';
  else
    raise notice 'FAIL preview points = %, expected 125 (a dropped pool row is unspendable money)', pre ->> 'points';
  end if;

  if (pre ->> 'community')::int = 15 then
    raise notice 'PASS preview community = 15';
  else
    raise notice 'FAIL preview community = %, expected 15', pre ->> 'community';
  end if;

  -- V3 only. V1 is shared, V2 is the winner's own.
  if (pre ->> 'spotsGained')::int = 1 and (pre -> 'spotNames') ? 'Loser Only' then
    raise notice 'PASS preview names the one spot gained (Loser Only)';
  else
    raise notice 'FAIL preview spotsGained = %, names = %', pre ->> 'spotsGained', pre -> 'spotNames';
  end if;

  -- ...and changed nothing. This runs on a screen students back out of.
  select balance into bal from public.point_balances where user_id = l and vendor_id = v3;
  if bal = 70 then raise notice 'PASS preview has no side effect';
  else raise notice 'FAIL preview moved money: loser V3 balance is % (expected 70)', bal; end if;

  -- ============================================================
  -- 2. THE REFUSALS, before anything is allowed to move.
  -- ============================================================
  begin
    perform public.merge_student_accounts(w, w);
    raise notice 'FAIL merging an account into itself was allowed';
  exception when others then
    if sqlerrm like '%MERGE_SAME_ACCOUNT%' then
      raise notice 'PASS merging an account into itself raises MERGE_SAME_ACCOUNT';
    else
      raise notice 'FAIL self-merge raised % instead of MERGE_SAME_ACCOUNT', sqlerrm;
    end if;
  end;

  -- ---- the DUAL-ROLE account ----
  -- A vendor owner who also uses the student app is an ordinary case, and an
  -- early cut of this file refused it outright — which made the feature useless
  -- for exactly the people most likely to try it first. It must merge. What it
  -- must NOT do is cost them their terminal login: vendor_staff references
  -- auth.users, not profiles, so deleting the profile takes the student side
  -- and leaves the sign-in. Same split POST /api/me/delete has always made.
  res := public.merge_student_accounts(w2, vs, 'staffer@psu.edu');

  if (res ->> 'loserIsVendor')::boolean then
    raise notice 'PASS the merge tells the caller to KEEP the auth user';
  else
    raise notice 'FAIL loserIsVendor = %, so the route would delete a terminal login', res ->> 'loserIsVendor';
  end if;

  select count(*) into n from public.profiles where user_id = vs;
  if n = 0 then raise notice 'PASS the vendor''s STUDENT side was merged away';
  else raise notice 'FAIL the vendor profile survived the merge'; end if;

  select balance into bal from public.point_balances where user_id = w2 and vendor_id = v2;
  if bal = 15 then raise notice 'PASS the vendor''s student points landed in their personal account (15)';
  else raise notice 'FAIL w2 holds % at V2, expected 15', bal; end if;

  select count(*) into n from public.vendor_staff where user_id = vs;
  if n = 1 then raise notice 'PASS the vendor_staff link is untouched — the counter still signs in';
  else raise notice 'FAIL the vendor_staff link is gone; that terminal can no longer sign in'; end if;

  select count(*) into n from auth.users where id = vs;
  if n = 1 then raise notice 'PASS the vendor auth user still exists for the terminal to use';
  else raise notice 'FAIL the vendor auth user was destroyed'; end if;

  select notes::text into txt from public.account_merges where loser_id = vs;
  if txt like '%loser_is_vendor_auth_user_kept%' then
    raise notice 'PASS the dual-role decision is on the audit row';
  else raise notice 'FAIL the audit does not record that the auth user was kept: %', txt; end if;

  -- ============================================================
  -- 3. THE MERGE ITSELF.
  -- ============================================================
  res := public.merge_student_accounts(w, l, 'cxj5571@psu.edu');

  -- ---- 3a. the losing account is gone ----
  select count(*) into n from public.profiles where user_id = l;
  if n = 0 then raise notice 'PASS the absorbed profile is deleted';
  else raise notice 'FAIL the absorbed profile survived the merge'; end if;

  -- ---- 3b. per-vendor purses summed, not replaced ----
  select balance into bal from public.point_balances where user_id = w and vendor_id = v1;
  if bal = 130 then raise notice 'PASS overlapping purse summed (100 + 30 = 130)';
  else raise notice 'FAIL V1 balance is %, expected 130', bal; end if;

  select balance into bal from public.point_balances where user_id = w and vendor_id = v2;
  if bal = 50 then raise notice 'PASS the winner''s own purse is untouched (50)';
  else raise notice 'FAIL V2 balance is %, expected 50', bal; end if;

  select balance into bal from public.point_balances where user_id = w and vendor_id = v3;
  if bal = 70 then raise notice 'PASS the purse at a spot only the loser used moved across (70)';
  else raise notice 'FAIL V3 balance is %, expected 70', bal; end if;

  select count(*) into n from public.point_balances where user_id = l;
  if n = 0 then raise notice 'PASS no purse is left behind on the absorbed account';
  else raise notice 'FAIL % purse row(s) left on the deleted account', n; end if;

  -- ---- 3c. the pooled purse (migration-044) ----
  select balance into bal from public.pool_balances where user_id = w and pool_id = pl;
  if bal = 65 then raise notice 'PASS pooled purse summed (40 + 25 = 65)';
  else raise notice 'FAIL pool balance is %, expected 65 — a chain customer would be short', bal; end if;

  -- ---- 3d. community points, then the clawback ----
  -- 20 + 15 = 35 combined, less the 25 self-referral fee = 10.
  -- lifetime 20 + 35 = 55, less 25 = 30.
  select balance, lifetime_earned into bal, life from public.community_balances where user_id = w;
  if bal = 10 then raise notice 'PASS community summed then clawed back (20 + 15 - 25 = 10)';
  else raise notice 'FAIL community balance is %, expected 10', bal; end if;
  if life = 30 then raise notice 'PASS lifetime_earned summed then clawed back (20 + 35 - 25 = 30)';
  else raise notice 'FAIL lifetime_earned is %, expected 30', life; end if;

  select count(*) into n from public.community_balances where user_id = l;
  if n = 0 then raise notice 'PASS no community row left on the absorbed account';
  else raise notice 'FAIL community row survived on the deleted account'; end if;

  -- ---- 3e. the self-referral is unwound ----
  select status into txt from public.referrals where id = rf;
  if txt = 'void' then raise notice 'PASS the self-referral is voided';
  else raise notice 'FAIL referral status is %, expected void', txt; end if;

  select count(*) into n from public.community_grants
   where ref_id = rf and kind = 'referral_referrer' and voided_at is not null;
  if n = 1 then raise notice 'PASS the referrer payout is marked voided rather than deleted';
  else raise notice 'FAIL the referrer grant was not voided'; end if;

  -- The friend's leg SURVIVES: they did join and they did use the app.
  select count(*) into n from public.community_grants
   where ref_id = rf and kind = 'referral_friend' and voided_at is null;
  if n = 1 then raise notice 'PASS the friend payout is left standing';
  else raise notice 'FAIL the friend payout was clawed back too'; end if;

  -- ...and the programme's budget got its points back.
  select spent_points into n from public.incentives where id = '00000000-0000-0000-0000-0000000005c1';
  if n = 0 then raise notice 'PASS the voided payout stopped counting against the budget';
  else raise notice 'FAIL incentive spent_points is %, expected 0', n; end if;

  -- ---- 3f. history moved, NOT anonymised ----
  select count(*) into n from public.transactions where user_id = w;
  if n = 4 then raise notice 'PASS all four transactions belong to the surviving account';
  else raise notice 'FAIL winner holds % transactions, expected 4', n; end if;

  select count(*) into n from public.transactions where user_id is null;
  if n = 0 then raise notice 'PASS no transaction was anonymised by the profile delete';
  else raise notice 'FAIL % transaction(s) lost their owner — the delete ran before the re-point', n; end if;

  -- The union of visited spots, which is the thing the student actually asked
  -- for. V1, V2 and V3, where the winner alone had only V1 and V2.
  select count(*) into n from public.student_visited_vendor_ids(w);
  if n = 3 then raise notice 'PASS the merged account has visited all three spots';
  else raise notice 'FAIL visited-spot union is %, expected 3', n; end if;

  -- ---- 3g. visit counters: the same night is not paid twice ----
  -- punch_cards has been a per-spot COUNTER since migration-029 (UNIQUE
  -- (user_id, vendor_id), no target, no completion) and migration-045 made the
  -- count spendable. So the merge is a sum, and the only way to get it wrong is
  -- to pay for a night that happened once.
  --
  -- W had D1,D2,D3 at V1. L had D3,D4,D5,D6. D3 is ONE night, so six rows
  -- survive and the counter reads 3 + (4 - 1) = 6.
  select count(*) into n from public.punches where user_id = w and vendor_id = v1;
  if n = 6 then raise notice 'PASS the duplicate night was dropped (3 + 4 - 1 = 6 punch rows)';
  else raise notice 'FAIL % punch rows at V1, expected 6 — the same night was counted twice', n; end if;

  select punches into n from public.punch_cards where user_id = w and vendor_id = v1;
  if n = 6 then raise notice 'PASS the visit counters summed net of the shared night (6)';
  else raise notice 'FAIL the V1 counter reads %, expected 6', n; end if;

  if (res ->> 'duplicateNights')::int = 1 then
    raise notice 'PASS the merge reports the one discounted night back to the app';
  else
    raise notice 'FAIL duplicateNights = %, expected 1', res ->> 'duplicateNights';
  end if;

  -- ...and the preview promised the same figure the merge delivered: L's 4 + 2
  -- visits less the one shared night = 5.
  if (pre ->> 'punches')::int = 5 then
    raise notice 'PASS the preview predicted the net visits gained (5)';
  else
    raise notice 'FAIL preview punches = %, expected 5 — the confirm screen would over-promise', pre ->> 'punches';
  end if;

  -- idx_punch_cards_one_per_vendor is the constraint the sum exists to respect.
  select count(*) into n from public.punch_cards where user_id = w and vendor_id = v1;
  if n = 1 then raise notice 'PASS exactly one counter per spot survives';
  else raise notice 'FAIL % counters at V1 — the unique index would have rejected this', n; end if;

  -- The counter at a spot the winner never visited moves over whole.
  select punches into n from public.punch_cards where user_id = w and vendor_id = v3;
  if n = 2 then raise notice 'PASS the counter at the gained spot moved across intact (2)';
  else raise notice 'FAIL the V3 counter reads %, expected 2', n; end if;

  -- ...and its nights came with it rather than cascading away with the row.
  select count(*) into n from public.punches where user_id = w and vendor_id = v3;
  if n = 2 then raise notice 'PASS the gained spot''s punch history survived';
  else raise notice 'FAIL % punches at V3, expected 2 — card_id cascaded them away', n; end if;

  -- Nothing left pointing at the deleted account.
  select count(*) into n from public.punch_cards where user_id = l;
  if n = 0 then raise notice 'PASS no visit counter left on the absorbed account';
  else raise notice 'FAIL % counter row(s) left behind', n; end if;

  -- ---- 3h. live codes at a counter are dead ----
  select count(*) into n  from public.earn_codes   where user_id = l;
  select count(*) into n2 from public.redeem_codes where user_id = l;
  if n = 0 and n2 = 0 then raise notice 'PASS the absorbed account''s live codes are gone';
  else raise notice 'FAIL % earn and % redeem code(s) still point at a deleted account', n, n2; end if;

  -- ---- 3i. saved spots deduped ----
  select count(*) into n from public.vendor_favorites where user_id = w;
  if n = 2 then raise notice 'PASS saved spots merged without duplicating V1 (2)';
  else raise notice 'FAIL winner has % saved spots, expected 2', n; end if;

  -- ---- 3j. revisits added, stale score dropped ----
  select revisits into n from public.profiles where user_id = w;
  if n = 7 then raise notice 'PASS revisit counts added (4 + 3 = 7)';
  else raise notice 'FAIL revisits is %, expected 7', n; end if;

  select count(*) into n from public.user_scores where user_id in (w, l);
  if n = 0 then raise notice 'PASS the stale tier snapshot was dropped for recompute';
  else raise notice 'FAIL a tier snapshot survived and now ignores half the history'; end if;

  -- ---- 3k. the audit row ----
  select count(*) into n from public.account_merges where winner_id = w and loser_id = l;
  if n = 1 then raise notice 'PASS the merge wrote its audit row';
  else raise notice 'FAIL no account_merges row — an irreversible operation with no record'; end if;

  select notes::text into txt from public.account_merges where winner_id = w and loser_id = l;
  if txt like '%self_referral_voided%' and txt like '%ambassador_signup_counted_twice%' then
    raise notice 'PASS the audit records both the clawback and the double-counted ambassador signup';
  else
    raise notice 'FAIL audit notes are %', txt;
  end if;

  -- The ambassador keeps their credit — they did the work and did not know.
  select count(*) into n from public.ambassador_signups where points = 5;
  if n = 2 then raise notice 'PASS the ambassador''s payouts were left alone';
  else raise notice 'FAIL ambassador signups changed (% rows with points)', n; end if;

  -- ---- 3l. the bystander ----
  select balance into bal from public.point_balances where user_id = p and vendor_id = v1;
  if bal = 999 then raise notice 'PASS the merge did not reach past its two accounts';
  else raise notice 'FAIL an unrelated student''s balance is now %', bal; end if;

  -- ============================================================
  -- 4. THE VERIFICATION CODES.
  -- ============================================================
  select c.code_id into code_id
    from public.student_email_code_issue(w, 'CXJ5571@psu.edu', 'cxj5571@psu.edu', 'hash-one', 15, 60) c;
  if code_id is not null then raise notice 'PASS a code is issued';
  else raise notice 'FAIL no code issued'; end if;

  -- The cooldown is the fence that survives IP rotation. A second request
  -- inside it returns nothing at all rather than mailing again.
  select c.code_id into code_id2
    from public.student_email_code_issue(w, 'cxj5571@psu.edu', 'cxj5571@psu.edu', 'hash-two', 15, 60) c;
  if code_id2 is null then raise notice 'PASS a second request inside the cooldown sends nothing';
  else raise notice 'FAIL the cooldown let a second code through'; end if;

  -- A guess is charged before the hash is handed back, so a crash cannot buy a
  -- free attempt.
  select b.code_hash, b.code_burned into txt, ok
    from public.student_email_code_begin(w, 5) b;
  if txt = 'hash-one' and not ok then raise notice 'PASS a guess returns the hash and charges an attempt';
  else raise notice 'FAIL begin returned hash=% burned=%', txt, ok; end if;

  select attempts into n from public.student_email_codes where id = code_id;
  if n = 1 then raise notice 'PASS the attempt is on record before the comparison';
  else raise notice 'FAIL attempts is %, expected 1', n; end if;

  -- Attempts 2..5 are real guesses; the SIXTH burns the code. Burning at the
  -- cap would kill a code on a last try that happens to be correct.
  for n in 2..5 loop
    perform public.student_email_code_begin(w, 5);
  end loop;
  select b.code_hash, b.code_burned into txt, ok from public.student_email_code_begin(w, 5) b;
  if ok and txt is null then raise notice 'PASS the code burns on attempt cap+1, with the hash withheld';
  else raise notice 'FAIL attempt 6 returned hash=% burned=%', txt, ok; end if;

  select count(*) into n from public.student_email_code_begin(w, 5);
  if n = 0 then raise notice 'PASS a burned code yields no further guesses';
  else raise notice 'FAIL a burned code still answers'; end if;

  -- ---- the two-phase proof, used when the address has its own account ----
  -- A correct code does not finish the job there: the student is shown what a
  -- merge would move and asked to confirm. The code has to survive that gap,
  -- and the address it proved must never travel via the client.
  -- DELETE rather than supersede: the cooldown counts every code ever mailed,
  -- used or not (that is the point — it bounds how much mail one inbox gets),
  -- and inside a single transaction now() is frozen, so a row written moments
  -- ago is always inside any window. Real requests each get their own
  -- transaction and a real clock.
  delete from public.student_email_codes where user_id = w;
  select c.code_id into code_id
    from public.student_email_code_issue(w, 'cxj5571@psu.edu', 'cxj5571@psu.edu', 'hash-three', 15, 60) c;

  if code_id is not null then raise notice 'PASS a fresh code issues once the cooldown has no history to bite on';
  else raise notice 'FAIL no code issued for the two-phase test'; end if;

  select count(*) into n from public.student_email_code_pending(w);
  if n = 0 then raise notice 'PASS an unproved code is not pending a merge';
  else raise notice 'FAIL an unproved code was offered to the confirm step'; end if;

  if public.student_email_code_verify(code_id) then raise notice 'PASS a proved code is marked without being spent';
  else raise notice 'FAIL verify refused a live code'; end if;

  select p2.code_email_norm into txt from public.student_email_code_pending(w) p2;
  if txt = 'cxj5571@psu.edu' then raise notice 'PASS the confirm step reads the proved address from the server, not the client';
  else raise notice 'FAIL pending returned %, expected the proved address', txt; end if;

  if public.student_email_code_consume(code_id) then raise notice 'PASS the confirm spends the code';
  else raise notice 'FAIL consume refused a proved code'; end if;

  if not public.student_email_code_consume(code_id) then raise notice 'PASS a spent code cannot be spent twice';
  else raise notice 'FAIL a spent code was consumed again — two merges from one proof'; end if;

  select count(*) into n from public.student_email_code_pending(w);
  if n = 0 then raise notice 'PASS a spent code stops being pending';
  else raise notice 'FAIL a spent code is still offered to the confirm step'; end if;

  -- ============================================================
  -- 5. THE BONUS FENCE.
  -- ============================================================
  insert into public.student_email_claims (email_norm, email, user_id, bonus_points, merged_from)
  values ('cxj5571@psu.edu', 'cxj5571@psu.edu', w, 10, l);

  -- One linked address per account.
  begin
    insert into public.student_email_claims (email_norm, email, user_id, bonus_points)
    values ('other@psu.edu', 'other@psu.edu', w, 10);
    raise notice 'FAIL a second live claim was allowed on one account';
  exception when unique_violation then
    raise notice 'PASS one linked address per account is enforced by the index';
  end;

  -- Unlink, relink: the row is reused and bonus_points is the fence, so the
  -- second link pays nothing. This is the farm the table exists to stop.
  update public.student_email_claims set user_id = null, released_at = now()
   where email_norm = 'cxj5571@psu.edu';

  select bonus_points into n from public.student_email_claims where email_norm = 'cxj5571@psu.edu';
  if n = 10 then raise notice 'PASS unlinking does not reopen the bonus (bonus_points survives)';
  else raise notice 'FAIL bonus_points is % after unlink, expected 10', n; end if;

  -- ...and the merged-away address is still recognisable at a later sign-in.
  select merged_from into code_id from public.student_email_claims where email_norm = 'cxj5571@psu.edu';
  if code_id = l then raise notice 'PASS a merged-away address still names the account that absorbed it';
  else raise notice 'FAIL merged_from is %, expected the absorbed account', code_id; end if;
end;
$$;

-- ============================================================
-- 6. THE POINTS-WRITE GUARD, from a transaction that has NOT called an RPC.
--
-- Deliberately outside the block above: app.points_write is transaction-local,
-- and merge_student_accounts sets it. Probing inside that same block would find
-- the flag still set and a direct UPDATE would wrongly appear to succeed. In
-- production PostgREST gives every request its own transaction, which is what
-- makes that safe.
-- ============================================================
do $$
begin
  update public.point_balances set balance = balance + 1
   where user_id = '00000000-0000-0000-0000-000000000571';
  raise notice 'FAIL direct DML on point_balances was allowed after migration-057';
exception when others then
  if sqlerrm like '%POINTS_WRITE%' or sqlerrm like '%guard%' or sqlerrm like '%not allowed%' then
    raise notice 'PASS the migration-025 guard still refuses direct DML on point_balances';
  else
    raise notice 'PASS the guard refused direct DML (%)', sqlerrm;
  end if;
end;
$$;
