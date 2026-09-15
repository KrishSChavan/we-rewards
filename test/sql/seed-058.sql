-- Pre-migration world for migration-058 (referrer paid at signup).
--
-- THE POINT OF THIS SEED IS WHAT IT DOES NOT CONTAIN: not one row in
-- transactions, for anybody. Under migration-039's settle_referrals every
-- referral below is unpayable by construction, because the friend never bought
-- anything and that was the whole condition. After 058 all of them are payable
-- except the two that are meant not to be. No vendor is seeded either — a
-- purchase cannot be faked into this world by accident.
--
--   R   the referrer. Every payout below lands on this one balance, so the
--       arithmetic is checkable with a single read.
--   F1  referred, never purchased. The plain case, and the one that changes.
--   F2  referred, never purchased, and THE GRANT IS ALREADY WRITTEN while the
--       referral still says pending — the torn pair a crashed inline payout
--       leaves behind (src/lib/referrals.js pays, then marks, and those are two
--       statements). Under 039 this row was immortal: the retry raised
--       GRANT_ALREADY_PAID, the handler read it as a failure, and the next tick
--       did the same thing forever.
--   F3  referred against an incentive whose budget is already spent. Must still
--       be refused — 058 removes the purchase gate, not the budget.
--   F4  referred, then VOIDED, the way migration-057 voids a referral when a
--       merge proves the two accounts are one person. Must never be paid, and
--       is the reason the payout path is guarded on status rather than blindly
--       stamping 'paid'.

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000581', 'r-058@example.com'),
  ('00000000-0000-0000-0000-000000000582', 'f1-058@example.com'),
  ('00000000-0000-0000-0000-000000000583', 'f2-058@example.com'),
  ('00000000-0000-0000-0000-000000000584', 'f3-058@example.com'),
  ('00000000-0000-0000-0000-000000000585', 'f4-058@example.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-000000000581', 'r-058@example.com',  'R',  now(), 'v1'),
  ('00000000-0000-0000-0000-000000000582', 'f1-058@example.com', 'F1', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000583', 'f2-058@example.com', 'F2', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000584', 'f3-058@example.com', 'F3', now(), 'v1'),
  ('00000000-0000-0000-0000-000000000585', 'f4-058@example.com', 'F4', now(), 'v1');

-- The live program. Unlimited budget, so nothing here can be refused for money
-- reasons and a refusal in the assertions means something real.
insert into public.incentives (kind, name, config, active)
values ('referral', 'Instant program 058', '{"referrerPoints":100,"friendPoints":50}'::jsonb, true);

-- The broke one. Inactive because idx_incentives_one_active_per_kind allows
-- exactly one live referral deal, and `active` is not what the budget check
-- reads anyway — grant_community_points looks at budget_points vs spent_points
-- on whichever incentive the referral names.
insert into public.incentives (kind, name, budget_points, config, active)
values ('referral', 'Broke program 058', 100, '{"referrerPoints":500}'::jsonb, false);

do $$
declare
  r    uuid := '00000000-0000-0000-0000-000000000581';
  f1   uuid := '00000000-0000-0000-0000-000000000582';
  f2   uuid := '00000000-0000-0000-0000-000000000583';
  f3   uuid := '00000000-0000-0000-0000-000000000584';
  f4   uuid := '00000000-0000-0000-0000-000000000585';
  good uuid;
  poor uuid;
  v_ref2 uuid;
begin
  select id into good from public.incentives where name = 'Instant program 058';
  select id into poor from public.incentives where name = 'Broke program 058';

  insert into public.referrals (referrer_id, friend_id, incentive_id, code, friend_points, referrer_points)
  values (r, f1, good, 'AAA234', 50, 100);

  insert into public.referrals (referrer_id, friend_id, incentive_id, code, friend_points, referrer_points)
  values (r, f2, good, 'AAA234', 50, 100) returning id into v_ref2;

  insert into public.referrals (referrer_id, friend_id, incentive_id, code, friend_points, referrer_points)
  values (r, f3, poor, 'AAA234', 50, 500);

  insert into public.referrals (referrer_id, friend_id, incentive_id, code, friend_points, referrer_points, status)
  values (r, f4, good, 'AAA234', 50, 100, 'void');

  -- F2's torn pair: the money moved, the status update did not. Written through
  -- grant_community_points rather than inserted, so the ledger row carries the
  -- real (ref_id, kind) the retry will collide with.
  perform public.grant_community_points(r, 100, 'referral_referrer', 'Referral bonus', good, v_ref2, 'system');

  -- Spend the broke program's entire budget on somebody else, so F3's referral
  -- has a real exhausted budget to hit rather than a contrived one.
  perform public.grant_community_points(f3, 100, 'manual', 'uses up the budget', poor, null, 'ops@example.com');
end $$;
