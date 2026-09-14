-- Pre-migration world for migration-057 (link a student email / merge accounts).
--
-- Built to make every branch of merge_student_accounts reachable, and to make
-- the arithmetic checkable by hand. Two accounts owned by one person:
--
--   W  the PERSONAL account they are signed into. Survives.
--   L  the .psu.edu account. Absorbed and deleted.
--
-- and two bystanders:
--
--   VS a .psu.edu account that is ALSO vendor staff — merging it must be
--      refused outright, because deleting it takes a terminal login with it.
--   P  an untouched control, to prove a merge does not reach past its two ids.
--
-- THE OVERLAPS, which is where the bugs live:
--   V1  both hold a balance AND a visit counter, and they were punched on the
--       SAME NIGHT (D3) — idx_punches_once_per_night would reject the duplicate,
--       and the losing counter counted it, so the sum has to discount it first.
--   V2  winner only.               V3  loser only — the spot they GAIN.
--   V4  pooled: both hold a pool balance, which point_balances knows nothing of.
--   V5  VS's shop.
--
-- ...plus a self-referral: W "referred" L and was paid 25 community points for
-- it, which the merge has to unwind.
--
-- The numbers, so the assertions are arithmetic and not vibes:
--   points   W: V1 100, V2 50            L: V1 30, V3 70        → moves 100
--   pool     W: 40                       L: 25                  → moves  25
--   community W: 20 (life 20)            L: 15 (life 35)        → 35 / life 55
--            then the 25 clawback        → 10 / life 30
--   visits   W: V1 3 (D1,D2,D3)          L: V1 4 (D3,D4,D5,D6), V3 2
--            D3 is ONE night on two accounts → L's counter 4→3
--            → V1 becomes 3 + 3 = 6, V3 moves across at 2.
--
-- NOTE ON THE MODEL. punch_cards stopped being a card at migration-029: it is
-- UNIQUE (user_id, vendor_id) with a bare `punches` count, and migration-045
-- made that count spendable. There is no target and no completion, so the seed
-- carries neither — writing one would fail against the live schema.

select set_config('app.points_write', 'server', false);

-- ---------- people ----------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000571', 'casey.personal@gmail.com'),
  ('00000000-0000-0000-0000-000000000572', 'cxj5571@psu.edu'),
  ('00000000-0000-0000-0000-000000000573', 'staffer@psu.edu'),
  ('00000000-0000-0000-0000-000000000574', 'bystander@gmail.com');

insert into public.profiles (user_id, email, name, terms_accepted_at, terms_version, revisits) values
  ('00000000-0000-0000-0000-000000000571', 'casey.personal@gmail.com', 'Casey Personal', now(), 'v1', 4),
  ('00000000-0000-0000-0000-000000000572', 'cxj5571@psu.edu',          'Casey Student',  now(), 'v1', 3),
  ('00000000-0000-0000-0000-000000000573', 'staffer@psu.edu',          'Sam Staff',      now(), 'v1', 0),
  ('00000000-0000-0000-0000-000000000574', 'bystander@gmail.com',      'Bystander',      now(), 'v1', 9);

-- ---------- spots ----------
insert into public.point_pools (id, label) values
  ('00000000-0000-0000-0000-0000000005b1', 'Casey Chain');

insert into public.vendors (id, name, slug, points_per_dollar, punch_enabled, pool_id) values
  ('00000000-0000-0000-0000-0000000005a1', 'Overlap Cafe', 'overlap-cafe-057', 10, true, null),
  ('00000000-0000-0000-0000-0000000005a2', 'Winner Only',  'winner-only-057',  10, true, null),
  ('00000000-0000-0000-0000-0000000005a3', 'Loser Only',   'loser-only-057',   10, true, null),
  ('00000000-0000-0000-0000-0000000005a4', 'Pooled Spot',  'pooled-spot-057',  10, false, '00000000-0000-0000-0000-0000000005b1'),
  ('00000000-0000-0000-0000-0000000005a5', 'Staff Shop',   'staff-shop-057',   10, false, null);

-- VS is vendor staff. This is the whole reason MERGE_LOSER_IS_VENDOR exists.
insert into public.vendor_staff (vendor_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000005a5', '00000000-0000-0000-0000-000000000573', 'owner');

-- ---------- purses ----------
insert into public.point_balances (user_id, vendor_id, balance) values
  ('00000000-0000-0000-0000-000000000571', '00000000-0000-0000-0000-0000000005a1', 100),
  ('00000000-0000-0000-0000-000000000571', '00000000-0000-0000-0000-0000000005a2',  50),
  ('00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005a1',  30),
  ('00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005a3',  70),
  -- The control's balance. Nothing in a merge of W and L may touch it.
  ('00000000-0000-0000-0000-000000000574', '00000000-0000-0000-0000-0000000005a1', 999);

insert into public.pool_balances (user_id, pool_id, balance) values
  ('00000000-0000-0000-0000-000000000571', '00000000-0000-0000-0000-0000000005b1', 40),
  ('00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005b1', 25);

insert into public.community_balances (user_id, balance, lifetime_earned) values
  ('00000000-0000-0000-0000-000000000571', 20, 20),
  ('00000000-0000-0000-0000-000000000572', 15, 35);

-- ---------- history ----------
-- V3 appears ONLY here and on L's visit counter, which is what makes it the
-- spot the winner gains.
insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, community_points) values
  ('00000000-0000-0000-0000-000000000571', '00000000-0000-0000-0000-0000000005a1', 'earn', 100, 10.00, 10),
  ('00000000-0000-0000-0000-000000000571', '00000000-0000-0000-0000-0000000005a2', 'earn',  50,  5.00, 10),
  ('00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005a1', 'earn',  30,  3.00,  5),
  ('00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005a3', 'earn',  70,  7.00, 10);

-- ---------- visit counters ----------
insert into public.punch_cards (id, user_id, vendor_id, punches) values
  ('00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-000000000571', '00000000-0000-0000-0000-0000000005a1', 3),
  ('00000000-0000-0000-0000-0000000005e2', '00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005a1', 4),
  ('00000000-0000-0000-0000-0000000005e3', '00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005a3', 2);

-- D3 (2026-09-03) is on BOTH cards: one human, one shop, one night.
insert into public.punches (user_id, vendor_id, card_id, business_day, token_window) values
  ('00000000-0000-0000-0000-000000000571', '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005e1', date '2026-09-01', 1),
  ('00000000-0000-0000-0000-000000000571', '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005e1', date '2026-09-02', 2),
  ('00000000-0000-0000-0000-000000000571', '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005e1', date '2026-09-03', 3),
  ('00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005e2', date '2026-09-03', 4),
  ('00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005e2', date '2026-09-04', 5),
  ('00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005e2', date '2026-09-05', 6),
  ('00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005e2', date '2026-09-06', 7),
  ('00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005a3', '00000000-0000-0000-0000-0000000005e3', date '2026-09-02', 8),
  ('00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005a3', '00000000-0000-0000-0000-0000000005e3', date '2026-09-05', 9);

-- ---------- saved spots (one duplicate, one unique) ----------
insert into public.vendor_favorites (user_id, vendor_id) values
  ('00000000-0000-0000-0000-000000000571', '00000000-0000-0000-0000-0000000005a1'),
  ('00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005a1'),
  ('00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005a3');

-- ---------- the self-referral ----------
-- W invited L, L bought something, W was paid 25. Entirely legitimate-looking
-- until the two accounts turn out to be one person.
insert into public.incentives (id, kind, name, config, active, budget_points, spent_points, created_by) values
  ('00000000-0000-0000-0000-0000000005c1', 'referral', 'Bring a friend',
   '{"friendPoints":10,"referrerPoints":25}'::jsonb, true, 1000, 25, 'ops@example.com');

insert into public.referrals (id, referrer_id, friend_id, incentive_id, code, status, friend_points, referrer_points, qualified_at, paid_at) values
  ('00000000-0000-0000-0000-0000000005d1',
   '00000000-0000-0000-0000-000000000571', '00000000-0000-0000-0000-000000000572',
   '00000000-0000-0000-0000-0000000005c1', 'CASEY7', 'paid', 10, 25, now(), now());

insert into public.community_grants (user_id, points, kind, reason, incentive_id, ref_id, granted_by) values
  ('00000000-0000-0000-0000-000000000571', 25, 'referral_referrer', 'Friend joined',
   '00000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005d1', 'system'),
  ('00000000-0000-0000-0000-000000000572', 10, 'referral_friend', 'Joined via a friend',
   '00000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005d1', 'system');

-- ---------- an ambassador who counted them both ----------
-- Nobody clawed back here, by design: the ambassador did the work and did not
-- know these were one person. The merge records it instead of hiding it.
insert into public.ambassadors (id, code, name, email, points, active) values
  ('00000000-0000-0000-0000-0000000005f1', 'AMB057', 'Ambassador Ann', 'ann-057@psu.edu', 5, true);

insert into public.ambassador_signups (ambassador_id, user_id, points) values
  ('00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-000000000571', 5),
  ('00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-000000000572', 5);

-- ---------- live codes at a counter ----------
-- Both belong to the account about to disappear. They must be gone the moment
-- the merge commits, not left pointing at nothing.
insert into public.rewards (id, vendor_id, title, cost_in_points) values
  ('00000000-0000-0000-0000-0000000005f9', '00000000-0000-0000-0000-0000000005a1', 'Free coffee', 100);

insert into public.earn_codes (code, user_id, expires_at) values
  ('570001', '00000000-0000-0000-0000-000000000572', now() + interval '120 seconds');
insert into public.redeem_codes (code, user_id, vendor_id, reward_id, expires_at) values
  ('5702', '00000000-0000-0000-0000-000000000572', '00000000-0000-0000-0000-0000000005a1',
   '00000000-0000-0000-0000-0000000005f9', now() + interval '120 seconds');
