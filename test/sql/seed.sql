-- Seed the exact situation migration-029 has to survive:
--   * a vendor with punch cards on
--   * a student mid-card (3 punches of 10)
--   * a student holding a COMPLETED, UNREDEEMED card (the user's own case)
--   * a student with a completed card that was already redeemed (must credit 0)
--   * a student with BOTH a completed unredeemed card and a fresh open card,
--     which is the multi-row shape a plain unique index cannot be built on
--   * punches audit rows hanging off the cards that are about to be deleted
--   * a live punch_redeem_code pointing at a card
--   * rewards to price

-- point_balances/transactions are guarded by migration-025 triggers. Announce
-- ourselves for the whole SESSION (is_local = false) so the seed can write.
select set_config('app.points_write', 'server', false);

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'b@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'c@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'd@example.com');

insert into public.vendors (id, name, slug, active, punch_enabled, punch_target, punch_reward)
values ('11111111-1111-1111-1111-111111111111', 'Blue Bird Cafe', 'blue-bird', true, true, 10, 'Free cover');

insert into public.profiles (user_id, name, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Mid Card',   'a@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Full Card',  'b@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Spent Card', 'c@example.com'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'Two Cards',  'd@example.com');

insert into public.rewards (id, vendor_id, title, cost_in_points, emoji, active) values
  ('bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Free coffee', 50,  '☕', true),
  ('bbbbbbbb-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Free meal',   200, '🍔', true);

-- mid-card: 3 of 10
insert into public.punch_cards (id, user_id, vendor_id, punches, target, created_at) values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111', 3, 10, now() - interval '5 days');

-- completed + unredeemed: the outstanding IOU. Must become 10 visits.
insert into public.punch_cards (id, user_id, vendor_id, punches, target, completed_at, created_at) values
  ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111', 10, 10, now() - interval '1 day', now() - interval '9 days');

-- completed + already redeemed: must contribute 0.
insert into public.punch_cards (id, user_id, vendor_id, punches, target, completed_at, redeemed_at, created_at) values
  ('cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111111', 10, 10, now() - interval '3 days', now() - interval '2 days', now() - interval '20 days');

-- two rows for ONE student: completed-unredeemed (10) + a fresh open card (2).
-- Expected total = 12, collapsed onto the OLDER row.
insert into public.punch_cards (id, user_id, vendor_id, punches, target, completed_at, created_at) values
  ('cccccccc-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000004',
   '11111111-1111-1111-1111-111111111111', 10, 10, now() - interval '4 days', now() - interval '30 days');
insert into public.punch_cards (id, user_id, vendor_id, punches, target, created_at) values
  ('cccccccc-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000004',
   '11111111-1111-1111-1111-111111111111', 2, 10, now() - interval '2 days');

-- audit rows on BOTH of that student's cards. The ones on the loser row
-- (…005) must survive the collapse by being repointed, not cascade-deleted.
insert into public.punches (user_id, vendor_id, card_id, business_day, token_window) values
  ('aaaaaaaa-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111',
   'cccccccc-0000-0000-0000-000000000004', date '2026-07-01', 100),
  ('aaaaaaaa-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111',
   'cccccccc-0000-0000-0000-000000000005', date '2026-07-20', 200),
  ('aaaaaaaa-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111',
   'cccccccc-0000-0000-0000-000000000005', date '2026-07-21', 300);

-- a live counter code pointing at a card that is about to be deleted
insert into public.punch_redeem_codes (code, user_id, vendor_id, card_id, expires_at) values
  ('4242', 'aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'cccccccc-0000-0000-0000-000000000002', now() + interval '2 minutes');

insert into public.point_balances (user_id, vendor_id, balance) values
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 120);
