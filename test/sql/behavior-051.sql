-- Assertions for migration-051 (claim_nearby_notification).
--
-- The function is a gate, so every assertion below is either "it opened when it
-- should" or "it stayed shut when it should" — plus, for the shut cases, that
-- it stayed shut WITHOUT SPENDING ANYTHING. That second half is the one worth
-- being fussy about: a refusal that still burns the student's daily slot is
-- invisible in production (nothing is shown, so nobody reports it) and silently
-- eats the deal alerts the same budget pays for.
--
-- The quota assertions are why the seed carries three fresh vendors. With one,
-- the once-ever guard refuses every follow-up claim on its own and the cooldown
-- and cap tests all pass without either rule existing.
--
-- Quiet hours are tested against a window computed from the CURRENT hour rather
-- than a literal, because a literal window makes this file pass or fail
-- depending on what time the harness is run at.
do $$
declare
  s1      uuid := '00000000-0000-0000-0000-000000000581';
  s2      uuid := '00000000-0000-0000-0000-000000000582';
  fresh   uuid := '00000000-0000-0000-0000-0000000005b1';
  beento  uuid := '00000000-0000-0000-0000-0000000005b2';
  punched uuid := '00000000-0000-0000-0000-0000000005b3';
  closed  uuid := '00000000-0000-0000-0000-0000000005b4';
  second  uuid := '00000000-0000-0000-0000-0000000005b5';
  third   uuid := '00000000-0000-0000-0000-0000000005b6';
  ok      boolean;
  n       integer;
  h       integer;
begin
  -- ---------- the happy path ----------

  select public.claim_nearby_notification(s1, fresh) into ok;
  if ok then raise notice 'PASS nearby: a fresh, active spot is claimable';
  else raise notice 'FAIL nearby: fresh spot refused, expected granted'; end if;

  select count(*) into n from public.nearby_notifications
  where user_id = s1 and vendor_id = fresh;
  if n = 1 then raise notice 'PASS nearby: the grant wrote its ledger row';
  else raise notice 'FAIL nearby: ledger holds % rows for the granted spot, expected 1', n; end if;

  -- Sharing the budget is the whole point of migration-051 talking to
  -- student_notify_state at all. If this fails, nearby notifications have
  -- quietly become a second, parallel 2-a-day on top of deal alerts.
  select count(*) into n from public.student_notify_state
  where user_id = s1 and day_count = 1 and week_count = 1 and last_push_at is not null;
  if n = 1 then raise notice 'PASS nearby: the grant spent a slot from the SHARED deal-alert budget';
  else raise notice 'FAIL nearby: shared counters not advanced by the grant'; end if;

  -- ---------- once, ever ----------

  select public.claim_nearby_notification(s1, fresh, 0, 99, 99) into ok;
  if not ok then raise notice 'PASS nearby: the same spot is never claimable twice';
  else raise notice 'FAIL nearby: second claim on the same spot was granted'; end if;

  -- ...and the refusal cost nothing. Counters are still on 1 from the grant.
  select count(*) into n from public.student_notify_state
  where user_id = s1 and day_count = 1;
  if n = 1 then raise notice 'PASS nearby: a once-ever refusal spends no quota';
  else raise notice 'FAIL nearby: refused repeat claim still advanced the day count'; end if;
end $$;

-- ---------- who is refused, and at no cost ----------
--
-- Split into its own block so the counters can be reset first: everything above
-- has already spent student one's cooldown, and these assertions are about the
-- eligibility rules, not the budget. Cooldown/caps are handed wide-open values
-- (0, 99, 99) throughout so a refusal here can only be the rule under test.
do $$
declare
  s1      uuid := '00000000-0000-0000-0000-000000000581';
  s2      uuid := '00000000-0000-0000-0000-000000000582';
  beento  uuid := '00000000-0000-0000-0000-0000000005b2';
  punched uuid := '00000000-0000-0000-0000-0000000005b3';
  closed  uuid := '00000000-0000-0000-0000-0000000005b4';
  second  uuid := '00000000-0000-0000-0000-0000000005b5';
  ok      boolean;
  n       integer;
begin
  -- THE premise of the feature. A spot they bought something at two months ago
  -- is not "somewhere you've never been", and the 7-day fallback the app uses
  -- for the Recommended row would have forgotten this purchase entirely.
  select public.claim_nearby_notification(s1, beento, 0, 99, 99) into ok;
  if not ok then raise notice 'PASS nearby: a spot with an old purchase is refused';
  else raise notice 'FAIL nearby: granted for a spot the student has earned at'; end if;

  -- Inherited from student_visited_vendor_ids: a regular who just cashed in a
  -- visits reward has punches = 0 and has still been there.
  select public.claim_nearby_notification(s1, punched, 0, 99, 99) into ok;
  if not ok then raise notice 'PASS nearby: a spent punch card still counts as visited';
  else raise notice 'FAIL nearby: granted for a punch-card spot (punches > 0 test?)'; end if;

  -- The client's catalogue is whatever it cached at last load.
  select public.claim_nearby_notification(s1, closed, 0, 99, 99) into ok;
  if not ok then raise notice 'PASS nearby: a deactivated spot is refused';
  else raise notice 'FAIL nearby: granted for an inactive vendor'; end if;

  -- None of the three refusals may have written a ledger row: doing so would
  -- silently make the spot permanently unnotifiable if it later became eligible
  -- (the student stops going, the vendor reopens).
  select count(*) into n from public.nearby_notifications
  where user_id = s1 and vendor_id in (beento, punched, closed);
  if n = 0 then raise notice 'PASS nearby: refusals write no ledger row';
  else raise notice 'FAIL nearby: % ledger rows written by refused claims', n; end if;

  -- The student's own switch, re-read under the lock rather than trusted from
  -- the caller.
  update public.student_notify_state set nearby_opt_in = false where user_id = s1;
  select public.claim_nearby_notification(s1, second, 0, 99, 99) into ok;
  if not ok then raise notice 'PASS nearby: nearby_opt_in = false refuses the claim';
  else raise notice 'FAIL nearby: granted while the student had the switch off'; end if;
  update public.student_notify_state set nearby_opt_in = true where user_id = s1;

  -- Deal alerts and nearby alerts are separate switches. Turning PUSH off must
  -- not silence this feature, which shows its notification locally and needs no
  -- push subscription at all.
  update public.student_notify_state set push_opt_in = false where user_id = s1;
  select public.claim_nearby_notification(s1, second, 0, 99, 99) into ok;
  if ok then raise notice 'PASS nearby: push_opt_in = false does NOT silence nearby alerts';
  else raise notice 'FAIL nearby: deal-alert opt-out wrongly suppressed a nearby claim'; end if;
  update public.student_notify_state set push_opt_in = true where user_id = s1;

  -- p_user_id actually scopes the ledger: student two has been told nothing.
  select count(*) into n from public.nearby_notifications where user_id = s2;
  if n = 0 then raise notice 'PASS nearby: one student''s ledger does not leak into another''s';
  else raise notice 'FAIL nearby: student two holds % ledger rows, expected 0', n; end if;
end $$;

-- ---------- the shared budget, and quiet hours ----------
--
-- Student TWO is used from here down. Student one's ledger now holds every
-- vendor the earlier blocks granted, and the once-ever guard would refuse those
-- again for the wrong reason — masking a cooldown or cap rule that is not there.
do $$
declare
  s2     uuid := '00000000-0000-0000-0000-000000000582';
  fresh  uuid := '00000000-0000-0000-0000-0000000005b1';
  second uuid := '00000000-0000-0000-0000-0000000005b5';
  third  uuid := '00000000-0000-0000-0000-0000000005b6';
  ok     boolean;
  n      integer;
  h      integer;
begin
  -- A granted claim, then a DIFFERENT spot immediately after. The cooldown is
  -- the hard guarantee migration-032 exists to make: two interruptions can
  -- never be closer together than it, whatever is nearby.
  select public.claim_nearby_notification(s2, fresh, 240, 99, 99) into ok;
  if ok then raise notice 'PASS nearby: student two claimed their first spot';
  else raise notice 'FAIL nearby: student two refused on a clean slate'; end if;

  select public.claim_nearby_notification(s2, second, 240, 99, 99) into ok;
  if not ok then raise notice 'PASS nearby: a second spot inside the cooldown is refused';
  else raise notice 'FAIL nearby: two notifications granted inside the cooldown'; end if;

  -- The cooldown refusal must not have consumed the spot: the student walks
  -- past it again tomorrow and should still be told.
  select count(*) into n from public.nearby_notifications
  where user_id = s2 and vendor_id = second;
  if n = 0 then raise notice 'PASS nearby: a cooldown refusal leaves the spot claimable later';
  else raise notice 'FAIL nearby: cooldown refusal burned the spot permanently'; end if;

  -- Cooldown lifted, daily cap of 1, one already spent. The cap is the next
  -- fence behind it.
  select public.claim_nearby_notification(s2, second, 0, 1, 99) into ok;
  if not ok then raise notice 'PASS nearby: the daily cap refuses once it is reached';
  else raise notice 'FAIL nearby: granted past the daily cap'; end if;

  -- ...and the weekly cap independently of it.
  select public.claim_nearby_notification(s2, second, 0, 99, 1) into ok;
  if not ok then raise notice 'PASS nearby: the weekly cap refuses once it is reached';
  else raise notice 'FAIL nearby: granted past the weekly cap'; end if;

  -- Room under both: the same spot that was just refused is now granted, which
  -- is what proves the refusals above were the caps and not something sticky.
  select public.claim_nearby_notification(s2, second, 0, 99, 99) into ok;
  if ok then raise notice 'PASS nearby: with room under both caps the claim is granted';
  else raise notice 'FAIL nearby: refused with the caps wide open'; end if;

  -- ---------- quiet hours ----------
  -- Built from the current UTC hour so this file does not pass or fail on the
  -- clock. [h, h+1) always contains now; [h+1, h+2) never does.
  h := extract(hour from (now() at time zone 'UTC'))::integer;

  select public.claim_nearby_notification(s2, third, 0, 99, 99, h, (h + 1) % 24, 'UTC') into ok;
  if not ok then raise notice 'PASS nearby: a claim inside quiet hours is refused';
  else raise notice 'FAIL nearby: granted during quiet hours'; end if;

  -- Refused for the night, not forever — the student walks past tomorrow.
  select count(*) into n from public.nearby_notifications
  where user_id = s2 and vendor_id = third;
  if n = 0 then raise notice 'PASS nearby: a quiet-hours refusal leaves the spot claimable later';
  else raise notice 'FAIL nearby: quiet-hours refusal burned the spot permanently'; end if;

  select public.claim_nearby_notification(s2, third, 0, 99, 99, (h + 1) % 24, (h + 2) % 24, 'UTC') into ok;
  if ok then raise notice 'PASS nearby: outside quiet hours the same claim is granted';
  else raise notice 'FAIL nearby: refused outside quiet hours'; end if;

  -- start = end disables quiet hours entirely, matching claim_campaign_pushes.
  select public.claim_nearby_notification(s2, fresh, 0, 99, 99, 0, 0, 'UTC') into ok;
  if not ok then raise notice 'PASS nearby: start = end disables quiet hours (refused here only by once-ever)';
  else raise notice 'FAIL nearby: once-ever guard did not hold with quiet hours disabled'; end if;
end $$;

-- ---------- deleting the account takes the location record with it ----------
--
-- LAST, because it destroys the fixtures. The Privacy Policy says this data goes
-- when the account does, and it is the most sensitive thing the feature stores —
-- a list of places this person was standing next to. Nothing in Node deletes it:
-- POST /api/me/delete removes the auth user (or, for a dual-role account, the
-- profiles row) and relies entirely on the cascade below. A missing FK here
-- would leave that data behind with no error anywhere.
do $$
declare
  s1 uuid := '00000000-0000-0000-0000-000000000581';
  s2 uuid := '00000000-0000-0000-0000-000000000582';
  n  integer;
begin
  select count(*) into n from public.nearby_notifications where user_id = s2;
  if n = 0 then raise notice 'FAIL nearby: fixture missing — the cascade test proves nothing';
  else
    delete from public.profiles where user_id = s2;
    select count(*) into n from public.nearby_notifications where user_id = s2;
    if n = 0 then raise notice 'PASS nearby: deleting the profile deletes the location record';
    else raise notice 'FAIL nearby: % rows survived the account deletion', n; end if;
  end if;

  -- The other student's rows must be untouched by that delete.
  select count(*) into n from public.nearby_notifications where user_id = s1;
  if n > 0 then raise notice 'PASS nearby: one account''s deletion leaves another''s record alone';
  else raise notice 'FAIL nearby: deleting one student cleared another student''s rows'; end if;
end $$;
