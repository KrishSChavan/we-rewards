-- Assertions for migration-061 (operator broadcasts).
--
-- Two halves, and they fail in opposite directions.
--
-- admin_broadcast_audience decides WHO. Its failure mode is a student too many:
-- a push to somebody the audience said it would not reach. There is no way to
-- notice that in production — the student gets a notification and has no idea
-- they were not supposed to — so every arm of every WHERE clause in that
-- function has a student in seed-061 whose only purpose is to be excluded by it,
-- and most of the blocks below assert the EXACT SET rather than membership. A
-- membership-only assertion passes just as well when the audience returns
-- everybody.
--
-- claim_admin_broadcast_pushes decides WHEN, out of a budget it does not own.
-- student_notify_state is one row per student shared by deal campaigns
-- (032/047), nearby alerts (051), reminders (060) and now this; Privacy Policy
-- section 7.4 says "Two per day is the total number of times WeRewards will
-- interrupt you, whatever the reason", and a broadcast is one of those reasons.
-- So its failure mode is the mirror image: a REFUSAL THAT STILL SPENDS. Nothing
-- is sent, nobody reports it, and the student loses their deal alerts for four
-- hours as well, because all four features gate on one last_push_at. Every
-- refusal below is therefore asserted twice — it refused, AND it wrote nothing.
--
-- CROSS-BLOCK ISOLATION. Unlike the three sibling claims, this one is driven by
-- a QUEUE: admin_broadcast_recipients rows outlive the block that created them,
-- and the driving scan is ordered (broadcast created_at, user_id) with no
-- date window, so a broadcast an earlier block left behind supplies candidates
-- to every block after it. Each claim block therefore opens with
--     update public.admin_broadcasts set status = 'cancelled' where status = 'queued';
-- which is immediately effective (the scan requires b.status = 'queued') and
-- uses the product's own mechanism rather than deleting rows. Then it creates
-- its own broadcast, parks every student with
--     update public.student_notify_state set last_push_at = now();
-- and brings forward only the one or three it is about. Parking by cooldown
-- rather than by deleting state is what behavior-060 does and for the same
-- reason: a student left eligible from an earlier block silently takes a slot
-- and turns these assertions into coincidences.
--
-- Note that now() is the TRANSACTION timestamp and each DO block is one
-- transaction, so `set last_push_at = now()` is exactly inside any cooldown the
-- same block then tests, and `claimed_at = now() - interval '11 minutes'` is
-- exactly outside the ten-minute recovery window. Nothing here races the clock.
--
-- Quiet hours are passed as (0, 0) on every call but the block that tests them,
-- exactly as behavior-047 and behavior-060 do it. The container's clock is
-- whatever time the suite runs at, and the real 22:00-09:00 window would quietly
-- turn most of this file into "claimed nobody, PASS".

-- ============================================================
-- block 1: the 'all' audience, consent, and the limit clamp
-- ============================================================
do $$
declare
  noconsent uuid := '00000000-0000-0000-0000-0000000610ff';   -- signed in, never consented
  s_all     uuid := '00000000-0000-0000-0000-000000061001';
  s_dual    uuid := '00000000-0000-0000-0000-000000061002';   -- is_vendor = true
  got uuid[];
  n   integer;
  m   integer;
  flag boolean;
begin
  -- ---------- fixtures first ----------
  -- Both of these guard assertions that would otherwise pass for the wrong
  -- reason: A3 proves nothing if the non-consenting user has a profile, and A9
  -- proves nothing if the dual-role account is an ordinary student. The
  -- is_vendor flag especially, because migration-035 put a BEFORE INSERT trigger
  -- on profiles that overwrites whatever the seed supplies.
  select count(*) into n from public.profiles where user_id = noconsent;
  select count(*) into m from auth.users  where id      = noconsent;
  if n = 0 and m = 1 then
    raise notice 'PASS A1: fixture — the non-consenting student has an auth row and no profile';
  else raise notice 'FAIL A1: the non-consenting fixture has % profiles and % auth rows, wanted 0 and 1', n, m; end if;

  select is_vendor into flag from public.profiles where user_id = s_dual;
  if flag then raise notice 'PASS A2: fixture — the dual-role account really carries is_vendor = true';
  else raise notice 'FAIL A2: is_vendor is % for the dual-role fixture, so A9 would test an ordinary student', flag; end if;

  -- ---------- 'all' means every student who consented ----------
  select coalesce(array_agg(a.user_id), '{}'::uuid[]), count(*) into got, n
  from public.admin_broadcast_audience(p_audience => 'all') a;
  select count(*) into m from public.profiles;

  if n = m then raise notice 'PASS A3: ''all'' returns exactly one row per profile (% of %)', n, m;
  else raise notice 'FAIL A3: ''all'' returned % rows against % profiles', n, m; end if;

  -- The seed's own headcount, pinned so that a student added to seed-061 without
  -- a matching thought about the exact-set assertions below shows up here rather
  -- than three blocks later as an off-by-one in a count nobody can explain.
  if m = 21 then raise notice 'PASS A4: fixture — the world holds the 21 students seed-061 describes';
  else raise notice 'FAIL A4: % profiles exist, seed-061 describes 21', m; end if;

  -- THE consent gate. migration-022 writes the profiles row at accept-terms, so
  -- an auth user without one is a student who has not agreed to anything. The
  -- join to profiles is the only thing keeping them out, and it is the one line
  -- of this function that is about a promise rather than about a query.
  if not (noconsent = any(got)) then
    raise notice 'PASS A5: a student who signed in and never consented is not in any audience';
  else raise notice 'FAIL A5: the non-consenting student was queued for a broadcast'; end if;

  -- A dual-role account is still a student who earns and redeems. Excluding them
  -- would quietly drop every member of staff who uses the app on their day off,
  -- and they can opt out like anybody else.
  if s_dual = any(got) then
    raise notice 'PASS A6: an is_vendor account is INCLUDED in the student audience';
  else raise notice 'FAIL A6: the dual-role account was excluded from ''all'''; end if;

  if s_all = any(got) then raise notice 'PASS A7: a student with no history at all is still in ''all''';
  else raise notice 'FAIL A7: the history-free student was missing from ''all'''; end if;

  -- ---------- p_limit is a clamp, never a switch ----------
  select count(*) into n from public.admin_broadcast_audience(p_audience => 'all', p_limit => 3) a;
  if n = 3 then raise notice 'PASS A8: p_limit caps the row count';
  else raise notice 'FAIL A8: p_limit => 3 returned % rows', n; end if;

  -- The sharp one. A bare `limit p_limit` with 0 returns NO rows, so a broadcast
  -- built from a form field that arrived as 0 would be created, be marked 'done'
  -- for having matched nobody, and tell the operator it reached zero students --
  -- which looks exactly like a correct empty audience. greatest(coalesce(...), 1)
  -- is what makes 0 mean "one student" instead of "silently nobody".
  select count(*) into n from public.admin_broadcast_audience(p_audience => 'all', p_limit => 0) a;
  if n = 1 then raise notice 'PASS A9: p_limit => 0 clamps up to 1 rather than meaning "nobody"';
  else raise notice 'FAIL A9: p_limit => 0 returned % rows, wanted 1', n; end if;

  -- And negative is clamped rather than fatal: `limit -1` is a hard
  -- 2201W ERROR in Postgres ("LIMIT must not be negative"), which from the route
  -- would be a 500 on a form field nobody validated.
  select count(*) into n from public.admin_broadcast_audience(p_audience => 'all', p_limit => -1) a;
  if n = 1 then raise notice 'PASS A10: a negative p_limit is clamped to 1 rather than raising';
  else raise notice 'FAIL A10: p_limit => -1 returned % rows, wanted 1', n; end if;

  -- HONEST LIMIT, written down rather than overclaimed. This pins that a NULL
  -- limit still returns the student body rather than nobody, which is the
  -- failure that would matter. It cannot tell coalesce(p_limit, 20000) apart from
  -- a bare `limit null`, because `LIMIT NULL` means "no limit" in Postgres and
  -- both therefore return all 21 students here; distinguishing them needs 20001
  -- profiles. The 20000 ceiling is unobservable at this scale for the same
  -- reason, and is left to the catalogue assertion in block 13.
  select count(*) into n from public.admin_broadcast_audience(p_audience => 'all', p_limit => null::integer) a;
  if n = m then raise notice 'PASS A11: a null p_limit falls back to the default rather than returning nobody';
  else raise notice 'FAIL A11: a null p_limit returned % rows against % profiles', n, m; end if;
end $$;

-- ============================================================
-- block 2: the 'vendor' audience — everyone who EARNED here
-- ============================================================
--
-- The distinction this block exists to defend is "paying customer at this spot",
-- not "has been seen at this spot". There are two easy ways to get it wrong and
-- seed-061 has a student for each: widen the type filter and a redeem counts;
-- reach for student_visited_vendor_ids (migration-048) because it is already
-- written and a punch card counts. Both turn a message about a cafe into a
-- message to people who have never bought anything there.
do $$
declare
  v_target uuid := '00000000-0000-0000-0000-0000000610b1';
  v_nearby uuid := '00000000-0000-0000-0000-0000000610b8';   -- nobody has ever been here
  s_earner uuid := '00000000-0000-0000-0000-000000061003';   -- two earns at the target
  s_redeem uuid := '00000000-0000-0000-0000-000000061004';   -- one redeem, nothing else
  s_punch  uuid := '00000000-0000-0000-0000-000000061005';   -- a punch card, no transactions
  s_lapsed uuid := '00000000-0000-0000-0000-000000061006';   -- earned somewhere else
  got uuid[];
  n   integer;
begin
  select coalesce(array_agg(a.user_id), '{}'::uuid[]), count(*) into got, n
  from public.admin_broadcast_audience(p_audience => 'vendor', p_vendor_id => v_target) a;

  if s_earner = any(got) then raise notice 'PASS B1: a student who earned at the spot is in its audience';
  else raise notice 'FAIL B1: the target''s own earner was not in its audience'; end if;

  -- Exactly one, which carries two claims at once: nobody leaked in, AND the
  -- `select distinct` is doing its job. S_EARNER has TWO earn rows at this spot;
  -- without the distinct they are queued twice, the operator is shown a count of
  -- 2 for an audience of 1, and the duplicate recipient row is stopped only by
  -- the primary key -- so queued_count and the queue disagree from then on.
  if n = 1 then raise notice 'PASS B2: exactly one student, so the double earn is deduped and nobody else leaked';
  else raise notice 'FAIL B2: the vendor audience returned % rows, wanted 1 (%)', n, got; end if;

  if not (s_redeem = any(got)) then raise notice 'PASS B3: a student who only ever REDEEMED here is not a customer of it';
  else raise notice 'FAIL B3: a redeem-only student was queued for a vendor broadcast'; end if;

  -- punches = 0 on purpose in the seed (migration-045 assigns rather than
  -- subtracts), so this also catches a `punches > 0` test.
  if not (s_punch = any(got)) then raise notice 'PASS B4: a punch card at the spot does not put a student in its audience';
  else raise notice 'FAIL B4: a punch-card-only student was queued for a vendor broadcast'; end if;

  if not (s_lapsed = any(got)) then raise notice 'PASS B5: an earn at a DIFFERENT spot does not qualify';
  else raise notice 'FAIL B5: the vendor audience is not scoped to its vendor'; end if;

  -- The anonymised earn from migration-011 belongs to nobody: user_id is null
  -- with the row still counted in the vendor's revenue. B2 covers it by count,
  -- and this is the direction that would be fatal rather than merely wrong -- a
  -- null in the audience is an insert into a not-null column, which takes down
  -- every broadcast creation on the platform, for every vendor, at once.
  -- Counted from the function directly rather than hunted for in the aggregated
  -- array, because `null = any(...)` is itself null and an `if` reads that as
  -- false, which would make this assertion pass without looking.
  select count(*) into n
  from public.admin_broadcast_audience(p_audience => 'vendor', p_vendor_id => v_target) a
  where a.user_id is null;
  if n = 0 then raise notice 'PASS B6: an anonymised transaction contributes no null row to the audience';
  else raise notice 'FAIL B6: % null user ids reached the vendor audience', n; end if;

  -- 'vendor' with nothing to scope it to returns NOTHING, not everybody. This is
  -- the one defaulting mistake in the whole function that would be a campus-wide
  -- push dressed up as a message to one cafe's regulars.
  select count(*) into n
  from public.admin_broadcast_audience(p_audience => 'vendor', p_vendor_id => null) a;
  if n = 0 then raise notice 'PASS B7: ''vendor'' with no vendor returns nobody rather than everybody';
  else raise notice 'FAIL B7: a null vendor id returned % students', n; end if;

  select count(*) into n
  from public.admin_broadcast_audience(p_audience => 'vendor', p_vendor_id => v_nearby) a;
  if n = 0 then raise notice 'PASS B8: a spot nobody has earned at has an empty audience';
  else raise notice 'FAIL B8: a spot with no earn rows returned % students', n; end if;
end $$;

-- ============================================================
-- block 3: the 'lapsed' audience — earned once, gone for a month
-- ============================================================
--
-- Two requirements, and both have to be requirements. Drop the earn test and
-- 'lapsed' becomes "everyone who has been quiet", which is every student who
-- signed up yesterday. Drop the 30-day test and it becomes "everyone who has
-- ever bought anything", which is the whole active user base.
do $$
declare
  s_all    uuid := '00000000-0000-0000-0000-000000061001';   -- never earned anything
  s_earner uuid := '00000000-0000-0000-0000-000000061003';   -- earns 60 and 59 days ago
  s_redeem uuid := '00000000-0000-0000-0000-000000061004';   -- a 60-day-old redeem, no earn
  s_lapsed uuid := '00000000-0000-0000-0000-000000061006';   -- one earn, 60 days ago
  s_active uuid := '00000000-0000-0000-0000-000000061007';   -- and one earn 3 days ago
  s_xfer   uuid := '00000000-0000-0000-0000-000000061008';   -- recent community_transfer
  s_ba     uuid := '00000000-0000-0000-0000-000000061013';   -- earned 3 days ago
  got uuid[];
  n   integer;
begin
  select coalesce(array_agg(a.user_id), '{}'::uuid[]), count(*) into got, n
  from public.admin_broadcast_audience(p_audience => 'lapsed') a;

  if s_lapsed = any(got) then raise notice 'PASS C1: a student who earned once and has been gone 60 days is lapsed';
  else raise notice 'FAIL C1: the long-gone earner was not in ''lapsed'''; end if;

  if not (s_active = any(got)) then raise notice 'PASS C2: a student who earned three days ago is not lapsed';
  else raise notice 'FAIL C2: an active student was queued as lapsed'; end if;

  if not (s_all = any(got)) then raise notice 'PASS C3: a student who has never earned is not lapsed, only new';
  else raise notice 'FAIL C3: a student who has never bought anything was queued as lapsed'; end if;

  -- S_REDEEM has a transaction, 60 days old, and no earn. Without the
  -- `exists (type = ''earn'')` arm they look identical to S_LAPSED.
  if not (s_redeem = any(got)) then raise notice 'PASS C4: a redeem is not an earn, so a redeem-only student is not lapsed';
  else raise notice 'FAIL C4: a student with no earn row at all was queued as lapsed'; end if;

  -- THE fixture migration-061 writes its implementation note about. The recency
  -- test is `not exists (ANY row in 30 days)` rather than
  -- `max(created_at) over earns < cutoff`, so a student whose only recent
  -- activity is spending community points inside the app counts as active. Those
  -- two implementations agree about every other student in this seed and
  -- disagree about exactly this one.
  if not (s_xfer = any(got)) then
    raise notice 'PASS C5: a recent community_transfer counts as activity, so the student is not lapsed';
  else raise notice 'FAIL C5: a student who used the app three days ago was queued as lapsed'; end if;

  if not (s_ba = any(got)) then raise notice 'PASS C6: a recent earn at any spot keeps a student out of ''lapsed''';
  else raise notice 'FAIL C6: a student who earned three days ago was queued as lapsed'; end if;

  if n = 2 and s_earner = any(got) then
    raise notice 'PASS C7: exactly the two long-gone earners are lapsed and nobody else';
  else raise notice 'FAIL C7: ''lapsed'' returned % rows (%), wanted 2 (the earner and the lapsed student)', n, got; end if;
end $$;

-- ============================================================
-- block 4: the 'spendable' audience — and the pooled purse
-- ============================================================
--
-- This is the audience the product exists for: the problem is not signups, it is
-- that students who already own enough points never spend them. It is also the
-- audience with the most ways to be wrong, because "can afford something right
-- now" is four separate facts (the reward is priced in points, the reward is
-- live, the vendor is open, the balance covers it) read out of three tables
-- through migration-044's pooled-purse rule.
do $$
declare
  v_pooled uuid := '00000000-0000-0000-0000-0000000610b4';
  pool_061 uuid := '00000000-0000-0000-0000-0000000610d1';
  s_spend  uuid := '00000000-0000-0000-0000-000000061009';   -- 100 against a 100-point reward
  s_short  uuid := '00000000-0000-0000-0000-00000006100a';   -- 99 against the same reward
  s_pool   uuid := '00000000-0000-0000-0000-00000006100b';   -- 0 per-vendor, 120 in the pool
  s_visits uuid := '00000000-0000-0000-0000-00000006100c';   -- rich where nothing is points-priced
  s_shut   uuid := '00000000-0000-0000-0000-00000006100d';   -- rich at a closed spot
  s_off    uuid := '00000000-0000-0000-0000-00000006100e';   -- rich, reward off the menu
  got uuid[];
  n   integer;
  v_vendor_balance integer;
  v_pool_balance   integer;
begin
  -- Fixture guard for D3, and the reason D3 is the assertion worth having. If
  -- the per-vendor row were missing rather than zero, a buggy reader would find
  -- a NULL, and somebody might later "fix" it with a coalesce that accidentally
  -- works. A real row holding a real 0 leaves the bug no way to look right.
  select balance into v_vendor_balance from public.point_balances
   where user_id = s_pool and vendor_id = v_pooled;
  select balance into v_pool_balance   from public.pool_balances
   where user_id = s_pool and pool_id  = pool_061;
  if v_vendor_balance = 0 and v_pool_balance = 120 then
    raise notice 'PASS D1: fixture — the pooled student holds 0 at the vendor and 120 in the pool';
  else raise notice 'FAIL D1: pooled fixture holds % at the vendor and % in the pool, wanted 0 and 120',
    v_vendor_balance, v_pool_balance; end if;

  select coalesce(array_agg(a.user_id), '{}'::uuid[]), count(*) into got, n
  from public.admin_broadcast_audience(p_audience => 'spendable') a;

  -- The boundary, not a comfortable margin: S_SPEND holds exactly the price. `>`
  -- instead of `>=` excludes precisely the student who has just saved up enough,
  -- which is the single best moment to tell them.
  if s_spend = any(got) then raise notice 'PASS D2: a student holding exactly the reward''s price can spend it';
  else raise notice 'FAIL D2: the student at exactly the price was excluded (>= read as >)'; end if;

  if not (s_short = any(got)) then raise notice 'PASS D3: a student one point short cannot spend it';
  else raise notice 'FAIL D3: a student 99 points into a 100-point reward was told to go and redeem'; end if;

  -- THE subtle one, and the reason this assertion is worth more than the rest of
  -- the block put together. S_POOL's money is in the chain's shared purse
  -- (migration-044). A reader that goes straight to point_balances for a pooled
  -- vendor finds their real row holding a real zero and excludes them -- which
  -- silently removes every customer of every pooled chain from this audience,
  -- and pooled chains are the biggest accounts on the platform.
  if s_pool = any(got) then
    raise notice 'PASS D4: points held in a POOL count, so a pooled chain''s customers are not invisible';
  else raise notice 'FAIL D4: the pooled student was excluded — the purse rule read point_balances'; end if;

  -- cost_in_points is nullable since migration-029's dual pricing. A visits-only
  -- reward cannot be bought with points at any balance, and a student sent to buy
  -- it arrives at a counter that wants a punch card.
  if not (s_visits = any(got)) then
    raise notice 'PASS D5: a visits-priced reward is not spendable with points, however rich the student';
  else raise notice 'FAIL D5: a points balance was matched against a visits-priced reward'; end if;

  if not (s_shut = any(got)) then raise notice 'PASS D6: a closed vendor''s rewards are not spendable';
  else raise notice 'FAIL D6: a student was told to go and spend points at a deactivated spot'; end if;

  -- Separate column on a separate table from D6, so it gets its own student: a
  -- live spot whose reward has been taken off the menu.
  if not (s_off = any(got)) then raise notice 'PASS D7: a reward with active = false is not spendable';
  else raise notice 'FAIL D7: an inactive reward was counted as affordable'; end if;

  if n = 2 then raise notice 'PASS D8: exactly the two students who can redeem today are in ''spendable''';
  else raise notice 'FAIL D8: ''spendable'' returned % rows (%), wanted 2', n, got; end if;
end $$;

-- ============================================================
-- block 5: create_admin_broadcast
-- ============================================================
--
-- The operator presses Send once and may be addressing the whole student body,
-- so the two properties that matter most here are that the number they are shown
-- is the number that was QUEUED (not an estimate that moves as students earn and
-- lapse), and that pressing Send twice cannot queue it twice.
do $$
declare
  op1      uuid := '00000000-0000-0000-0000-0000000610a1';
  op2      uuid := '00000000-0000-0000-0000-0000000610a2';
  op3      uuid := '00000000-0000-0000-0000-0000000610a3';   -- used ONLY for the refusals
  v_target uuid := '00000000-0000-0000-0000-0000000610b1';
  v_nearby uuid := '00000000-0000-0000-0000-0000000610b8';   -- an audience of nobody
  v_batch  uuid := '00000000-0000-0000-0000-0000000610b9';   -- an audience of exactly three
  s_earner uuid := '00000000-0000-0000-0000-000000061003';
  bid  uuid;
  bid2 uuid;
  q    integer;
  q2   integer;
  n    integer;
  m    integer;
  v_title  text;
  v_body   text;
  v_url    text;
  v_aud    text;
  v_status text;
  v_vid    uuid;
  v_exp    timestamptz;
begin
  -- ---------- the ordinary case ----------
  select out_id, out_queued into bid, q
  from public.create_admin_broadcast(
    op1, 'Six new spots joined', 'Tap to see who is in.', '/student/#deals',
    'vendor', v_target, 20000, 'tok-061-e1');

  if bid is not null and q = 1 then raise notice 'PASS E1: a vendor broadcast was created and reports one student queued';
  else raise notice 'FAIL E1: create returned id=% queued=%, wanted an id and 1', bid, q; end if;

  select count(*) into n from public.admin_broadcast_recipients
   where broadcast_id = bid and user_id = s_earner and status = 'queued'
     and claimed_at is null and pushed_at is null;
  select count(*) into m from public.admin_broadcast_recipients where broadcast_id = bid;
  if n = 1 and m = 1 then
    raise notice 'PASS E2: the queue holds exactly one recipient row, for the audience member, ready to send';
  else raise notice 'FAIL E2: % matching rows out of % recipients for a one-student audience', n, m; end if;

  select queued_count, sent_count, status, audience, vendor_id, expires_at
    into q2, n, v_status, v_aud, v_vid, v_exp
    from public.admin_broadcasts where id = bid;
  -- queued_count is what the operator is SHOWN. It has to be the size of the
  -- queue that was written, not of an audience recomputed later: the audience
  -- moves as students earn and lapse, so a recount answers a different question
  -- and the operator would have approved a number that never existed.
  if q2 = 1 and n = 0 and v_status = 'queued' and v_aud = 'vendor' and v_vid = v_target then
    raise notice 'PASS E3: queued_count matches the queue, nothing is sent yet, and the vendor is recorded';
  else raise notice 'FAIL E3: queued=% sent=% status=% audience=% vendor=%', q2, n, v_status, v_aud, v_vid; end if;

  -- 48 hours, because an announcement is time-bound by nature: a student whose
  -- cooldown and daily cap kept them out of the queue for a week does not want
  -- last week's news, and without the expiry they would get it the moment a slot
  -- opened.
  if v_exp > now() + interval '47 hours' and v_exp < now() + interval '49 hours' then
    raise notice 'PASS E4: a new broadcast expires in about 48 hours';
  else raise notice 'FAIL E4: expires_at is %, wanted roughly now + 48 hours', v_exp; end if;

  -- ---------- the double-tapped Send ----------
  -- A repeated token returns the FIRST broadcast rather than erroring, so a
  -- retried request is indistinguishable from the original to the caller. The
  -- alternative is not a duplicate notification: it is the student body queued
  -- twice, each copy spending a slot from the shared budget.
  select out_id, out_queued into bid2, q2
  from public.create_admin_broadcast(
    op1, 'Six new spots joined', 'Tap to see who is in.', '/student/#deals',
    'vendor', v_target, 20000, 'tok-061-e1');

  if bid2 = bid and q2 = 1 then raise notice 'PASS E5: the same (operator, token) returns the SAME broadcast and the same count';
  else raise notice 'FAIL E5: a repeated token returned id=% queued=%, wanted % and 1', bid2, q2, bid; end if;

  select count(*) into n from public.admin_broadcast_recipients where broadcast_id = bid;
  select count(*) into m from public.admin_broadcasts where created_by = op1 and client_token = 'tok-061-e1';
  if n = 1 and m = 1 then raise notice 'PASS E6: the retry queued nobody a second time and created no second broadcast';
  else raise notice 'FAIL E6: after a retry there are % recipients and % broadcasts for that token', n, m; end if;

  -- The index is partial on (created_by, client_token), so two operators sending
  -- at once with whatever token their browsers generated must not collide.
  select out_id into bid2
  from public.create_admin_broadcast(
    op2, 'Six new spots joined', 'Tap to see who is in.', null,
    'vendor', v_target, 20000, 'tok-061-e1');
  if bid2 is not null and bid2 <> bid then
    raise notice 'PASS E7: idempotency is per operator, so a second operator reusing a token gets their own broadcast';
  else raise notice 'FAIL E7: a different operator with the same token got id %', bid2; end if;

  -- ---------- what it refuses ----------
  -- Whitespace rather than an empty string in both cases: '' is caught by any
  -- check at all, and '   ' is what a form field actually contains when somebody
  -- tabs through it. btrim is the difference between the two.
  begin
    perform public.create_admin_broadcast(op3, '   ', 'A body.', null, 'all', null, 20000, null);
    raise notice 'FAIL E8: a whitespace-only title was accepted';
  exception when others then
    if sqlerrm = 'TITLE_REQUIRED' then raise notice 'PASS E8: a whitespace-only title raises TITLE_REQUIRED';
    else raise notice 'FAIL E8: expected TITLE_REQUIRED, got %', sqlerrm; end if;
  end;

  begin
    perform public.create_admin_broadcast(op3, 'A title.', '   ', null, 'all', null, 20000, null);
    raise notice 'FAIL E9: a whitespace-only body was accepted';
  exception when others then
    if sqlerrm = 'BODY_REQUIRED' then raise notice 'PASS E9: a whitespace-only body raises BODY_REQUIRED';
    else raise notice 'FAIL E9: expected BODY_REQUIRED, got %', sqlerrm; end if;
  end;

  -- The column has a CHECK on the same four values, so without this test the
  -- function would still refuse -- with a 23514 constraint violation the route
  -- cannot turn into a message. The named exception is what the operator sees.
  begin
    perform public.create_admin_broadcast(op3, 'A title.', 'A body.', null, 'everyone', null, 20000, null);
    raise notice 'FAIL E10: an unknown audience was accepted';
  exception when others then
    if sqlerrm = 'BAD_AUDIENCE' then raise notice 'PASS E10: an unknown audience raises BAD_AUDIENCE';
    else raise notice 'FAIL E10: expected BAD_AUDIENCE, got %', sqlerrm; end if;
  end;

  -- Without this, 'vendor' with no vendor would fall through to an audience
  -- function that returns no rows, the broadcast would be created, marked 'done'
  -- for matching nobody, and the operator would be told their message reached
  -- zero students -- which looks exactly like a cafe with no regulars.
  begin
    perform public.create_admin_broadcast(op3, 'A title.', 'A body.', null, 'vendor', null, 20000, null);
    raise notice 'FAIL E11: a vendor broadcast with no vendor was accepted';
  exception when others then
    if sqlerrm = 'VENDOR_REQUIRED' then raise notice 'PASS E11: ''vendor'' with no vendor raises VENDOR_REQUIRED';
    else raise notice 'FAIL E11: expected VENDOR_REQUIRED, got %', sqlerrm; end if;
  end;

  -- All four validations run before the insert, so none of them can leave a
  -- half-built broadcast behind. op3 exists for nothing else, which is what makes
  -- this countable.
  select count(*) into n from public.admin_broadcasts where created_by = op3;
  if n = 0 then raise notice 'PASS E12: not one of the four refusals left a broadcast row behind';
  else raise notice 'FAIL E12: % broadcast rows survived a refused create', n; end if;

  -- ---------- trimming, and a blank url ----------
  -- A url of '' is not "the home screen", it is a push whose click target is the
  -- empty string; nullif(btrim(...), '') is what turns a form field somebody
  -- tabbed through into the documented "null means home".
  select out_id into bid2
  from public.create_admin_broadcast(
    op1, '  Lost and found  ', '  A grey tote bag is at the desk.  ', '   ',
    'vendor', v_target, 20000, 'tok-061-e13');
  select title, body, url into v_title, v_body, v_url from public.admin_broadcasts where id = bid2;
  if v_title = 'Lost and found' and v_body = 'A grey tote bag is at the desk.' and v_url is null then
    raise notice 'PASS E13: the title and body are trimmed and a blank url becomes null';
  else raise notice 'FAIL E13: stored title=[%] body=[%] url=[%]', v_title, v_body, v_url; end if;

  -- ---------- vendor_id belongs to 'vendor' and nothing else ----------
  -- Otherwise a campus-wide broadcast whose form still had a spot selected is
  -- filed forever as "a message to that spot's customers", and the record of who
  -- we addressed is wrong in the one table that is meant to be the audit trail.
  select out_id, out_queued into bid2, q2
  from public.create_admin_broadcast(
    op1, 'Campus wide', 'Everyone hears this.', null, 'all', v_target, 20000, 'tok-061-e14');
  select audience, vendor_id into v_aud, v_vid from public.admin_broadcasts where id = bid2;
  select count(*) into m from public.profiles;
  if v_aud = 'all' and v_vid is null and q2 = m then
    raise notice 'PASS E14: an ''all'' broadcast records no vendor and queues every student (%)', q2;
  else raise notice 'FAIL E14: audience=% vendor=% queued=% against % profiles', v_aud, v_vid, q2, m; end if;

  -- A null audience is 'all', not a constraint violation: the route may legally
  -- omit the field.
  select out_id, out_queued into bid2, q2
  from public.create_admin_broadcast(
    op1, 'No audience given', 'Defaults to everyone.', null, null, null, 20000, 'tok-061-e15');
  select audience into v_aud from public.admin_broadcasts where id = bid2;
  if v_aud = 'all' and q2 = m then raise notice 'PASS E15: a null audience is coalesced to ''all''';
  else raise notice 'FAIL E15: a null audience stored % and queued %', v_aud, q2; end if;

  -- ---------- an audience of nobody closes immediately ----------
  -- A 'queued' broadcast with no recipients is a row the worker rescans on every
  -- tick for the rest of time, and an operator who cannot tell "nobody matched"
  -- from "still sending".
  select out_id, out_queued into bid2, q2
  from public.create_admin_broadcast(
    op1, 'Nobody here', 'This matches no student.', null, 'vendor', v_nearby, 20000, 'tok-061-e16');
  select status, queued_count into v_status, n from public.admin_broadcasts where id = bid2;
  select count(*) into m from public.admin_broadcast_recipients where broadcast_id = bid2;
  if q2 = 0 and v_status = 'done' and n = 0 and m = 0 then
    raise notice 'PASS E16: an audience matching nobody is closed as ''done'' rather than left queued';
  else raise notice 'FAIL E16: empty audience left queued=% status=% count=% recipients=%', q2, v_status, n, m; end if;

  -- ---------- p_limit reaches the audience ----------
  select out_id, out_queued into bid2, q2
  from public.create_admin_broadcast(
    op1, 'Two of three', 'A capped audience.', null, 'vendor', v_batch, 2, 'tok-061-e17');
  select count(*) into m from public.admin_broadcast_recipients where broadcast_id = bid2;
  if q2 = 2 and m = 2 then raise notice 'PASS E17: p_limit is forwarded to the audience and caps what is queued';
  else raise notice 'FAIL E17: a limit of 2 against three earners queued % and wrote % rows', q2, m; end if;
end $$;

-- ============================================================
-- block 6: a claim, its copy, and what it spends
-- ============================================================
--
-- The grant half of the budget assertion. A claim SPENDS before anything has
-- been delivered, which is the same asymmetry finish_campaign_batch picks
-- deliberately (double-notifying is worse than under-notifying) and the reason
-- finish_admin_broadcast has to be able to refund.
do $$
declare
  op1      uuid := '00000000-0000-0000-0000-0000000610a1';
  s_fresh  uuid := '00000000-0000-0000-0000-000000061012';   -- no notify state row at all
  v_nearby uuid := '00000000-0000-0000-0000-0000000610b8';   -- never visited, never notified
  bid  uuid;
  got  uuid[];
  gotb uuid[];
  v_title text;
  v_body  text;
  v_url   text;
  v_status text;
  v_claimed timestamptz;
  n integer;
  flag boolean;
begin
  -- Retire everything block 5 left queued; see this file's header on why.
  update public.admin_broadcasts set status = 'cancelled' where status = 'queued';

  -- Fixture guard. If S_FRESH already had a notify row, F3 proves nothing and
  -- the parking update below would silence them.
  select count(*) into n from public.student_notify_state where user_id = s_fresh;
  if n = 0 then raise notice 'PASS F1: fixture — the never-notified student starts with no budget row';
  else raise notice 'FAIL F1: S_FRESH already has % notify rows, so the lazy insert is untested', n; end if;

  select out_id into bid
  from public.create_admin_broadcast(
    op1, 'Six new spots joined', 'Tap to see who is in.', '/student/#deals',
    'all', null, 20000, 'tok-061-f');

  -- Park every student who has a budget row. S_FRESH has none, which is exactly
  -- why they are the one this block can isolate.
  update public.student_notify_state set last_push_at = now();

  select coalesce(array_agg(out_user_id), '{}'::uuid[]),
         coalesce(array_agg(out_broadcast_id), '{}'::uuid[]),
         min(out_title), min(out_body), min(out_url)
    into got, gotb, v_title, v_body, v_url
  from public.claim_admin_broadcast_pushes(p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0);

  if coalesce(array_length(got, 1), 0) = 1 and s_fresh = any(got) then
    raise notice 'PASS F2: exactly the one eligible student is claimed and nobody else';
  else raise notice 'FAIL F2: the tick returned %, wanted S_FRESH alone', got; end if;

  select count(*) into n from public.student_notify_state where user_id = s_fresh;
  if n = 1 then raise notice 'PASS F3: the claim created the budget row it needed for a student nothing had notified';
  else raise notice 'FAIL F3: S_FRESH has % notify rows after being claimed, expected 1', n; end if;

  -- A broadcast carries its own words, so the claim returns them and the worker
  -- needs no second read. This is the one place this function differs in SHAPE
  -- from its three siblings rather than only in its rules.
  if v_title = 'Six new spots joined' and v_body = 'Tap to see who is in.'
     and v_url = '/student/#deals'
     and coalesce(array_length(gotb, 1), 0) = 1 and bid = any(gotb) then
    raise notice 'PASS F4: the claim hands back the broadcast''s own title, body, url and id';
  else raise notice 'FAIL F4: claimed copy was title=[%] body=[%] url=[%] broadcast=%', v_title, v_body, v_url, gotb; end if;

  select status, claimed_at into v_status, v_claimed
    from public.admin_broadcast_recipients where broadcast_id = bid and user_id = s_fresh;
  if v_status = 'sending' and v_claimed is not null then
    raise notice 'PASS F5: the claim marks the recipient ''sending'' and stamps claimed_at';
  else raise notice 'FAIL F5: the recipient row is status=% claimed_at=%', v_status, v_claimed; end if;

  -- The load-bearing decision of the whole migration. If this fails, broadcasts
  -- have become a FOURTH parallel two-a-day on top of deals, nearby alerts and
  -- reminders, and Privacy Policy section 7.4's "whatever the reason" is false.
  select count(*) into n from public.student_notify_state
   where user_id = s_fresh
     and day_count = 1 and week_count = 1
     and last_push_at is not null and day_start is not null and week_start is not null;
  if n = 1 then raise notice 'PASS F6: the grant spent a slot from the SHARED budget and stamped both windows';
  else raise notice 'FAIL F6: S_FRESH''s shared counters were not advanced by the grant'; end if;

  -- ...and here is what that costs, measured against another feature. Nearby
  -- Spot holds no transactions, no punch cards and no nearby ledger row for
  -- anybody, so migration-051's once-ever and visited tests cannot be what
  -- decides this call: the only thing that can refuse it is the cooldown the
  -- broadcast just spent.
  select public.claim_nearby_notification(s_fresh, v_nearby, 240, 2, 5, 0, 0, 'UTC') into flag;
  if not flag then
    raise notice 'PASS F7: a broadcast spends the shared cooldown, so a nearby alert behind it is refused';
  else raise notice 'FAIL F7: a nearby alert was granted inside the cooldown a broadcast had just spent'; end if;

  -- One student, one broadcast, once. The recipient row's primary key is both
  -- the queue and the only-once guard, so the budget is reset wide open first:
  -- otherwise the cooldown would refuse this call and the assertion would pass
  -- without the guard existing.
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now()
   where user_id = s_fresh;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_admin_broadcast_pushes(p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0);
  if coalesce(array_length(got, 1), 0) = 0 then
    raise notice 'PASS F8: a student already claimed for this broadcast is not claimed for it again';
  else raise notice 'FAIL F8: a second tick with the budget reopened returned %', got; end if;

  select count(*) into n from public.admin_broadcast_recipients
   where broadcast_id = bid and user_id = s_fresh and status = 'sending';
  if n = 1 then raise notice 'PASS F9: there is still exactly one ''sending'' row for that (broadcast, student)';
  else raise notice 'FAIL F9: % ''sending'' rows exist for one student and one broadcast', n; end if;
end $$;

-- ============================================================
-- block 7: A REFUSAL SPENDS NO QUOTA
-- ============================================================
--
-- THE block of this file. Claiming is what spends, and the budget is shared, so
-- a refusal that still increments a counter does not merely skip one broadcast:
-- it eats a deal alert the student would have had instead, plus four hours of
-- their cooldown, with no error raised anywhere and nothing sent to notice is
-- missing.
--
-- Each refusal is driven by exactly ONE rule with the others left wide open, so
-- "it refused" cannot be true for a second reason. Every counter is snapshotted
-- before the call and compared after, updated_at included: on the refusal path
-- the function must not write to the row AT ALL.
do $$
declare
  op1         uuid := '00000000-0000-0000-0000-0000000610a1';
  s_optout    uuid := '00000000-0000-0000-0000-00000006100f';   -- push_opt_in = false
  s_nopush    uuid := '00000000-0000-0000-0000-000000061010';   -- no endpoint, no notify row
  s_adminpush uuid := '00000000-0000-0000-0000-000000061011';   -- role = 'admin', no notify row
  s_ba        uuid := '00000000-0000-0000-0000-000000061013';
  bid uuid;
  got uuid[];
  before_day     integer;
  before_week    integer;
  before_push    timestamptz;
  before_updated timestamptz;
  after_day      integer;
  after_week     integer;
  after_push     timestamptz;
  after_updated  timestamptz;
  v_status  text;
  v_claimed timestamptz;
  n integer;
  m integer;
begin
  update public.admin_broadcasts set status = 'cancelled' where status = 'queued';
  select out_id into bid
  from public.create_admin_broadcast(
    op1, 'The terminal is down', 'Back by five.', null, 'all', null, 20000, 'tok-061-g');
  update public.student_notify_state set last_push_at = now();

  -- ---------- the weekly cap ----------
  -- week_start is pinned to now() because a window that has already rolled over
  -- is not a cap at all: the rollover zeroes the count before the test can read
  -- it, and the claim would be granted for a reason this block never intended to
  -- allow. Block 8 is where the rollover itself is tested.
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 5, week_start = now()
   where user_id = s_ba;

  -- Snapshotted after the setup update rather than written as literals, so this
  -- holds whether updated_at is maintained by hand or by a trigger.
  select day_count, week_count, last_push_at, updated_at
    into before_day, before_week, before_push, before_updated
    from public.student_notify_state where user_id = s_ba;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_admin_broadcast_pushes(p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0);
  if coalesce(array_length(got, 1), 0) = 0 then
    raise notice 'PASS G1: the weekly cap refuses once week_count has reached it, and nobody else slipped through';
  else raise notice 'FAIL G1: a tick with 5 of 5 weekly slots spent returned %', got; end if;

  select day_count, week_count, last_push_at, updated_at
    into after_day, after_week, after_push, after_updated
    from public.student_notify_state where user_id = s_ba;
  -- `is not distinct from` rather than `=` for the two timestamps: both are
  -- nullable, null = null is null, and an `if` reads that as false -- so written
  -- with plain equality this assertion would report a failure for a function
  -- that correctly left a null stamp alone.
  if after_day = before_day and after_week = before_week
     and after_push is not distinct from before_push
     and after_updated is not distinct from before_updated then
    raise notice 'PASS G2: A REFUSAL SPENDS NO QUOTA — not one counter, stamp or even updated_at moved';
  else
    raise notice 'FAIL G2: the refusal wrote to the row: day %->%, week %->%, last_push_at %->%, updated_at %->%',
      before_day, after_day, before_week, after_week, before_push, after_push, before_updated, after_updated;
  end if;

  -- The queue side of the same assertion, which the three sibling features have
  -- no equivalent of: the recipient row must not be marked 'sending' either. A
  -- refused student whose row moved to 'sending' is silently dropped from this
  -- broadcast forever -- the ten-minute recovery would requeue them, but only
  -- because a worker that never claimed them also never settles them.
  select status, claimed_at into v_status, v_claimed
    from public.admin_broadcast_recipients where broadcast_id = bid and user_id = s_ba;
  if v_status = 'queued' and v_claimed is null then
    raise notice 'PASS G3: a refused recipient stays ''queued'' with no claimed_at';
  else raise notice 'FAIL G3: a refusal left the recipient at status=% claimed_at=%', v_status, v_claimed; end if;

  -- ---------- the daily cap, independently of the weekly one ----------
  update public.student_notify_state
     set last_push_at = null,
         day_count = 2, day_start = now(),
         week_count = 0, week_start = now()
   where user_id = s_ba;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_admin_broadcast_pushes(p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0);
  if coalesce(array_length(got, 1), 0) = 0 then
    raise notice 'PASS G4: the daily cap refuses once day_count has reached it';
  else raise notice 'FAIL G4: a tick with 2 of 2 daily slots spent returned %', got; end if;

  select day_count, week_count, last_push_at into after_day, after_week, after_push
    from public.student_notify_state where user_id = s_ba;
  if after_day = 2 and after_week = 0 and after_push is null then
    raise notice 'PASS G5: the daily-cap refusal spent nothing either';
  else raise notice 'FAIL G5: day=% week=% last_push_at=% after a capped refusal', after_day, after_week, after_push; end if;

  -- ---------- the cooldown the OTHER features wrote ----------
  -- The shared budget has to work in both directions. last_push_at here was set
  -- by a deal alert or a nearby alert rather than by a broadcast, and the
  -- broadcast must still stand down: the student was interrupted ten minutes ago
  -- and does not care which feature did it. This is the direction a parallel
  -- budget would have broken, and it breaks silently.
  update public.student_notify_state
     set last_push_at = now() - interval '10 minutes',
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now()
   where user_id = s_ba;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_admin_broadcast_pushes(p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0);
  if coalesce(array_length(got, 1), 0) = 0 then
    raise notice 'PASS G6: a student pushed ten minutes ago by another feature is not also broadcast to';
  else raise notice 'FAIL G6: a broadcast was granted inside the shared four-hour cooldown'; end if;

  select day_count, week_count into after_day, after_week
    from public.student_notify_state where user_id = s_ba;
  if after_day = 0 and after_week = 0 then
    raise notice 'PASS G7: the cooldown refusal spent nothing, so the other features keep their slot';
  else raise notice 'FAIL G7: a cooldown refusal charged the student day=% week=%', after_day, after_week; end if;

  -- ---------- the student's own switch ----------
  -- S_OPTOUT still holds a live student endpoint in the seed, which should not
  -- happen in production (turning the switch off deletes endpoints) and is seeded
  -- precisely so the claim has to READ the switch rather than infer it from
  -- reachability.
  update public.student_notify_state set last_push_at = now();
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now()
   where user_id = s_optout;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_admin_broadcast_pushes(p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0);
  if coalesce(array_length(got, 1), 0) = 0 then
    raise notice 'PASS G8: push_opt_in = false silences an operator broadcast as well as a deal';
  else raise notice 'FAIL G8: an opted-out student was sent a broadcast: %', got; end if;

  select count(*) into n from public.student_notify_state
   where user_id = s_optout and day_count = 0 and week_count = 0 and last_push_at is null;
  select count(*) into m from public.admin_broadcast_recipients
   where broadcast_id = bid and user_id = s_optout and status = 'queued';
  if n = 1 and m = 1 then
    raise notice 'PASS G9: the opt-out refusal spent no quota and left the recipient queued';
  else raise notice 'FAIL G9: opted-out student has % untouched budget rows and % queued recipient rows', n, m; end if;

  -- ---------- unreachable at all ----------
  -- Both of these students have NO notify row, which is the second half of each
  -- assertion: the claim creates a budget row for every candidate it examines, so
  -- a missing reachability filter shows up twice -- once as a claim that should
  -- not have happened, and once as notify state appearing for somebody who is not
  -- a reachable student.
  update public.student_notify_state set last_push_at = now();

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_admin_broadcast_pushes(p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0);

  if not (s_nopush = any(got)) then
    raise notice 'PASS G10: a student with no push subscription is never claimed';
  else raise notice 'FAIL G10: a student with nothing to deliver to was claimed'; end if;

  -- role = 'admin' is an operator's own browser. migration-032 split the roles so
  -- notifyAdmins and student delivery could never hand each other's notifications
  -- out; without the filter, the operator receives the broadcast they just sent.
  if not (s_adminpush = any(got)) then
    raise notice 'PASS G11: an admin-only subscription is never claimed as a student';
  else raise notice 'FAIL G11: an operator browser was claimed as a student'; end if;

  if coalesce(array_length(got, 1), 0) = 0 then
    raise notice 'PASS G12: with every budget row parked the tick claims nobody at all';
  else raise notice 'FAIL G12: a fully parked world still returned %', got; end if;

  select count(*) into n from public.student_notify_state where user_id in (s_nopush, s_adminpush);
  if n = 0 then
    raise notice 'PASS G13: no budget row was conjured for the unreachable student or the operator browser';
  else raise notice 'FAIL G13: % notify rows exist for students the claim should never have examined', n; end if;

  -- ---------- the control ----------
  -- Without this, every refusal above would read as a pass just as well if the
  -- function were refusing this student for some reason nothing in this block
  -- controls -- or refusing everybody, always.
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now()
   where user_id = s_ba;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_admin_broadcast_pushes(p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0);
  if coalesce(array_length(got, 1), 0) = 1 and s_ba = any(got) then
    raise notice 'PASS G14: with the cooldown and both caps wide open the same student IS claimed';
  else raise notice 'FAIL G14: the control claim returned %, wanted S_BA alone', got; end if;
end $$;

-- ============================================================
-- block 8: a STALE window rolls over instead of carrying
-- ============================================================
--
-- The arithmetic blocks 6 and 7 never reach. Every cap fixture above sets a FRESH
-- window, so the `v_ds is null or v_ds <= now() - interval '24 hours'` arms never
-- execute, and this is the only assertion that tells correct rollover apart from
-- a carry-over. It is also the arithmetic that has to match the three sibling
-- claims exactly: if a broadcast rolls a window the others do not, the student's
-- budget depends on which feature reached them first.
--
-- Capped out on both counters, both windows expired, and nothing else in the way.
-- A working claim zeroes both counts and then spends one, so the student comes
-- back on 1 and 1 -- never on 3 and 6, and never refused.
do $$
declare
  op1     uuid := '00000000-0000-0000-0000-0000000610a1';
  v_batch uuid := '00000000-0000-0000-0000-0000000610b9';
  s_ba    uuid := '00000000-0000-0000-0000-000000061013';
  bid uuid;
  got uuid[];
  n  integer;
  m  integer;
  ds timestamptz;
  ws timestamptz;
begin
  update public.admin_broadcasts set status = 'cancelled' where status = 'queued';
  select out_id into bid
  from public.create_admin_broadcast(
    op1, 'Redeem by Friday', 'Your points are waiting.', null,
    'vendor', v_batch, 20000, 'tok-061-h');
  update public.student_notify_state set last_push_at = now();

  update public.student_notify_state
     set last_push_at = null,
         day_start  = now() - interval '30 hours', day_count  = 2,
         week_start = now() - interval '8 days',   week_count = 5
   where user_id = s_ba;

  select day_count, week_count into n, m from public.student_notify_state where user_id = s_ba;
  if n = 2 and m = 5 then
    raise notice 'PASS H1: fixture — the student is capped out on both counters with both windows expired';
  else raise notice 'FAIL H1: rollover fixture is day=% week=%, wanted 2 and 5', n, m; end if;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_admin_broadcast_pushes(p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0);
  if coalesce(array_length(got, 1), 0) = 1 and s_ba = any(got) then
    raise notice 'PASS H2: a capped student whose windows have both expired is claimed';
  else raise notice 'FAIL H2: a stale window was treated as a live cap, got %', got; end if;

  select day_count, week_count, day_start, week_start into n, m, ds, ws
    from public.student_notify_state where user_id = s_ba;
  if n = 1 and m = 1 then
    raise notice 'PASS H3: both counters rolled over to zero and then spent one, not 3 and 6';
  else raise notice 'FAIL H3: the rollover carried the old counts: day=% week=%', n, m; end if;

  -- Restamping is the other half. A rollover that zeroes the count but leaves
  -- the window where it was rolls over again on the very next tick, which is an
  -- unlimited notification budget rather than two a day.
  if ds > now() - interval '1 minute' and ws > now() - interval '1 minute' then
    raise notice 'PASS H4: both windows were restamped to now by the rollover';
  else raise notice 'FAIL H4: windows not restamped: day_start=% week_start=%', ds, ws; end if;
end $$;

-- ============================================================
-- block 9: quiet hours, both branches, deterministically
-- ============================================================
--
-- The clock is moved by choosing a FIXED-OFFSET ZONE that makes the local hour
-- 23, rather than by hoping the suite runs at the right time. Building the window
-- from the current clock hour instead -- [h, h+1) always contains now, [h+1, h+2)
-- never does -- only enters the midnight-WRAP branch (p_quiet_start >
-- p_quiet_end) when h happens to be 23, which is about 4% of runs; the other 96%
-- test the plain branch twice and report a pass for an arm that never ran.
--
-- Etc/GMT signs are inverted by POSIX convention (Etc/GMT+5 is UTC-5), which is
-- why the sign below looks backwards and is not. The offset is also folded into
-- [-11, 12] rather than taken as a bare 23 - h: the Etc zones only exist from
-- Etc/GMT+12 to Etc/GMT-14, so a bare offset asks for 'Etc/GMT-23' whenever the
-- suite runs between 00:00 and 08:00 UTC and the whole block dies on an
-- invalid-time-zone error instead of asserting anything.
do $$
declare
  op1     uuid := '00000000-0000-0000-0000-0000000610a1';
  v_batch uuid := '00000000-0000-0000-0000-0000000610b9';
  s_ba    uuid := '00000000-0000-0000-0000-000000061013';
  s_bb    uuid := '00000000-0000-0000-0000-000000061014';
  bid  uuid;
  bidx uuid;
  got  uuid[];
  h    integer;
  off  integer;
  tz   text;
  n    integer;
  m    integer;
begin
  update public.admin_broadcasts set status = 'cancelled' where status = 'queued';
  select out_id into bid
  from public.create_admin_broadcast(
    op1, 'Quiet hours hold', 'This one waits for morning.', null,
    'vendor', v_batch, 20000, 'tok-061-i');

  -- The housekeeping canary. A quiet tick is documented as "a read of one clock
  -- and a return", and this already-expired broadcast is what makes that
  -- testable: its recipients must still be 'queued' after the quiet call, because
  -- the clock check sits BEFORE the expiry sweep. That ordering is harmless today
  -- and worth pinning anyway -- the sweep is a WRITE, and a write inside a window
  -- whose whole promise is "nothing happens" is exactly the thing that grows a
  -- second write later.
  select out_id into bidx
  from public.create_admin_broadcast(
    op1, 'Stale news', 'Nobody should ever get this.', null,
    'vendor', v_batch, 20000, 'tok-061-i-expired');
  update public.admin_broadcasts set expires_at = now() - interval '1 minute' where id = bidx;

  update public.student_notify_state set last_push_at = now();
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now()
   where user_id = s_ba;

  h   := extract(hour from (now() at time zone 'UTC'))::integer;
  off := 23 - h;
  if off > 12 then off := off - 24; end if;
  if off = 0 then tz := 'UTC';
  elsif off > 0 then tz := 'Etc/GMT-' || off::text;      -- POSIX sign is inverted
  else tz := 'Etc/GMT+' || abs(off)::text;
  end if;

  -- Fixture guard: if the zone arithmetic is wrong, I1 and I3 both pass for the
  -- wrong reason (the window simply does not contain now) and the wrap branch is
  -- still untested.
  if extract(hour from (now() at time zone tz))::integer = 23 then
    raise notice 'PASS I1: fixture — the local hour in % is 23, so the wrap branch is genuinely entered', tz;
  else raise notice 'FAIL I1: local hour in % is %, wanted 23', tz,
    extract(hour from (now() at time zone tz))::integer; end if;

  -- 23:00-00:00 in that zone is NOW, and start > end, so this is the
  -- midnight-wrap arm.
  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_admin_broadcast_pushes(
    p_max_users => 40, p_quiet_start => 23, p_quiet_end => 0, p_timezone => tz);
  if coalesce(array_length(got, 1), 0) = 0 then
    raise notice 'PASS I2: the midnight-wrap branch refuses inside its window';
  else raise notice 'FAIL I2: a wrapped quiet window claimed %', got; end if;

  select count(*) into n from public.admin_broadcast_recipients
   where broadcast_id = bidx and status = 'queued';
  select count(*) into m from public.admin_broadcast_recipients where broadcast_id = bidx;
  if n = m and m = 3 then
    raise notice 'PASS I3: quiet hours answer before the expiry sweep, so the tick wrote nothing at all';
  else raise notice 'FAIL I3: % of % recipients of an expired broadcast were touched inside quiet hours', m - n, m; end if;

  select count(*) into n from public.student_notify_state
   where user_id = s_ba and day_count = 0 and week_count = 0 and last_push_at is null;
  if n = 1 then raise notice 'PASS I4: a quiet-hours refusal spends nobody''s quota';
  else raise notice 'FAIL I4: a due student had their budget charged by a quiet tick'; end if;

  -- 00:00-01:00 in the same zone is NOT now: same branch, opposite arm. This is
  -- what proves I2 was the window rather than an empty candidate set.
  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_admin_broadcast_pushes(
    p_max_users => 40, p_quiet_start => 0, p_quiet_end => 1, p_timezone => tz);
  if coalesce(array_length(got, 1), 0) = 1 and s_ba = any(got) then
    raise notice 'PASS I5: outside the window the same branch allows the claim';
  else raise notice 'FAIL I5: a non-matching wrapped window still returned %', got; end if;

  -- start = end must mean DISABLED, not a 23-hour window silencing everybody,
  -- and it is checked at local hour 23 -- the one hour I2 has just proved IS
  -- inside a wrapped window, so a mistake here is maximally visible.
  --
  -- HONEST LIMIT, worth writing down rather than overclaiming: this pins the
  -- observable BEHAVIOUR and cannot catch deletion of the
  -- `if p_quiet_start = p_quiet_end then null;` arm itself. For any equal pair
  -- (x, x) the two routes agree -- with the arm gone, `x > x` is false, so
  -- control reaches the plain branch and evaluates `v_hour >= x and v_hour < x`,
  -- which is false for every hour -- so the claim proceeds either way. The arm is
  -- defensive documentation in this implementation; what matters is that an equal
  -- pair never silences anyone, and that is what is checked.
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now()
   where user_id = s_bb;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_admin_broadcast_pushes(
    p_max_users => 40, p_quiet_start => 23, p_quiet_end => 23, p_timezone => tz);
  if s_bb = any(got) then
    raise notice 'PASS I6: start = end disables quiet hours rather than silencing the whole day';
  else raise notice 'FAIL I6: an equal quiet pair was treated as a window and refused the claim'; end if;
end $$;

-- ============================================================
-- block 10: expiry, cancellation, a dead worker, and closing up
-- ============================================================
--
-- All four of these are housekeeping the claim does before it looks at anybody,
-- and all four are invisible when they are wrong. An announcement that sat behind
-- a student's cooldown for two days and then went out is worse than one that
-- never went out; a cancelled broadcast that keeps draining is the operator's
-- "undo" not working; a 'sending' row from a worker that died mid-send is a
-- student permanently skipped; and a finished broadcast left 'queued' is a row
-- the worker rescans forever.
do $$
declare
  op1     uuid := '00000000-0000-0000-0000-0000000610a1';
  v_batch uuid := '00000000-0000-0000-0000-0000000610b9';
  s_ba    uuid := '00000000-0000-0000-0000-000000061013';
  x1 uuid;   -- expired
  x2 uuid;   -- cancelled
  x3 uuid;   -- live, with one row stranded by a dead worker
  got  uuid[];
  gotb uuid[];
  v_status  text;
  v_claimed timestamptz;
  n integer;
  m integer;
begin
  update public.admin_broadcasts set status = 'cancelled' where status = 'queued';

  select out_id into x1 from public.create_admin_broadcast(
    op1, 'Stale news 061', 'Two days too late.', null, 'vendor', v_batch, 20000, 'tok-061-j1');
  select out_id into x2 from public.create_admin_broadcast(
    op1, 'Pulled 061', 'The operator changed their mind.', null, 'vendor', v_batch, 20000, 'tok-061-j2');
  select out_id into x3 from public.create_admin_broadcast(
    op1, 'Live 061', 'This one still goes out.', null, 'vendor', v_batch, 20000, 'tok-061-j3');

  update public.admin_broadcasts set expires_at = now() - interval '1 minute' where id = x1;
  update public.admin_broadcasts set status = 'cancelled' where id = x2;

  -- A worker that claimed a row eleven minutes ago and then died: the dyno was
  -- cycled (Heroku does that daily, and every deploy is one) between the claim
  -- and the send. Eleven rather than ten so the comparison is strictly outside
  -- the window and the assertion cannot turn on a boundary.
  update public.admin_broadcast_recipients
     set status = 'sending', claimed_at = now() - interval '11 minutes'
   where broadcast_id = x3 and user_id = s_ba;

  update public.student_notify_state set last_push_at = now();
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now()
   where user_id = s_ba;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]),
         coalesce(array_agg(out_broadcast_id), '{}'::uuid[])
    into got, gotb
  from public.claim_admin_broadcast_pushes(p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0);

  -- One assertion, three claims: the stranded row came back to the queue (a
  -- 'sending' row is not a candidate, so without the recovery this returns
  -- nothing at all), and neither the expired nor the cancelled broadcast was
  -- drained even though the same student had a queued row in both.
  if coalesce(array_length(got, 1), 0) = 1 and s_ba = any(got) and x3 = any(gotb) then
    raise notice 'PASS J1: a ''sending'' row older than ten minutes is requeued and claimed again, from the LIVE broadcast only';
  else raise notice 'FAIL J1: the tick returned users=% broadcasts=%, wanted S_BA from the live broadcast alone', got, gotb; end if;

  select status, claimed_at into v_status, v_claimed
    from public.admin_broadcast_recipients where broadcast_id = x3 and user_id = s_ba;
  if v_status = 'sending' and v_claimed > now() - interval '1 minute' then
    raise notice 'PASS J2: the reclaimed row carries a FRESH claimed_at, so its ten minutes start again';
  else raise notice 'FAIL J2: the reclaimed row is status=% claimed_at=%', v_status, v_claimed; end if;

  select count(*) into n from public.admin_broadcast_recipients
   where broadcast_id = x1 and status = 'expired';
  select count(*) into m from public.admin_broadcast_recipients where broadcast_id = x1;
  if n = 3 and m = 3 then
    raise notice 'PASS J3: every recipient of an expired broadcast is marked ''expired'' rather than sent late';
  else raise notice 'FAIL J3: % of % recipients of an expired broadcast are ''expired''', n, m; end if;

  select count(*) into n from public.admin_broadcast_recipients
   where broadcast_id = x2 and status = 'expired';
  select count(*) into m from public.admin_broadcast_recipients where broadcast_id = x2;
  if n = 3 and m = 3 then
    raise notice 'PASS J4: cancelling a broadcast takes its whole queue out of circulation';
  else raise notice 'FAIL J4: % of % recipients of a cancelled broadcast are ''expired''', n, m; end if;

  select status into v_status from public.admin_broadcasts where id = x1;
  if v_status = 'done' then
    raise notice 'PASS J5: an expired broadcast with nothing left to send is closed as ''done''';
  else raise notice 'FAIL J5: an expired, fully-swept broadcast is still %', v_status; end if;

  -- The closing update is scoped to status = 'queued' on purpose. A cancelled
  -- broadcast rewritten to 'done' would erase the record of the operator having
  -- pulled it, and 'done' is what the admin screen reads as "this went out".
  select status into v_status from public.admin_broadcasts where id = x2;
  if v_status = 'cancelled' then
    raise notice 'PASS J6: a cancelled broadcast stays ''cancelled'' and is not rewritten as ''done''';
  else raise notice 'FAIL J6: a cancelled broadcast was rewritten to %', v_status; end if;

  select status into v_status from public.admin_broadcasts where id = x3;
  select count(*) into n from public.admin_broadcast_recipients
   where broadcast_id = x3 and status = 'queued';
  if v_status = 'queued' and n = 2 then
    raise notice 'PASS J7: a broadcast with recipients still waiting is left ''queued''';
  else raise notice 'FAIL J7: the live broadcast is % with % still queued, wanted queued and 2', v_status, n; end if;

  -- Now settle everything on the live one and tick again. The two parked students
  -- are settled BY HAND rather than claimed: what is under test here is the
  -- closing update, and claiming them would first need another round of budget
  -- resets that this assertion has no opinion about.
  perform public.finish_admin_broadcast(x3, s_ba, true);
  update public.admin_broadcast_recipients
     set status = 'sent', pushed_at = now()
   where broadcast_id = x3 and status = 'queued';

  perform public.claim_admin_broadcast_pushes(p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0);

  select status into v_status from public.admin_broadcasts where id = x3;
  if v_status = 'done' then
    raise notice 'PASS J8: a broadcast whose recipients are all settled is moved to ''done''';
  else raise notice 'FAIL J8: a fully settled broadcast is still %', v_status; end if;
end $$;

-- ============================================================
-- block 11: the two knobs the worker drives, and the drain order
-- ============================================================
--
-- p_skip_users is how the caller keeps a tick from re-picking a student whose
-- push just failed in this process; p_max_users is the batch size. Both are
-- asserted by WHICH rows survive rather than by the order of the returned array.
--
-- One thing about p_max_users is specific to this function and worth stating,
-- because it decides how the assertion has to be written: the limit is applied to
-- CANDIDATE rows in (broadcast created_at, user_id) order, not to grants. A cap
-- of 2 against twenty-one queued students would therefore say nothing about which
-- two the cap kept. That is why these blocks use the Batch Spot audience -- three
-- students, three recipient rows -- and why seed-061 gives those three ASCENDING
-- uuids, so the expected pair is written down here rather than discovered by
-- running it.
do $$
declare
  op1     uuid := '00000000-0000-0000-0000-0000000610a1';
  v_batch uuid := '00000000-0000-0000-0000-0000000610b9';
  s_ba    uuid := '00000000-0000-0000-0000-000000061013';   -- lowest uuid of the three
  s_bb    uuid := '00000000-0000-0000-0000-000000061014';
  s_bc    uuid := '00000000-0000-0000-0000-000000061015';   -- highest
  y1 uuid;
  y2 uuid;
  z1 uuid;
  z2 uuid;
  got  uuid[];
  gotb uuid[];
begin
  update public.admin_broadcasts set status = 'cancelled' where status = 'queued';
  select out_id into y1 from public.create_admin_broadcast(
    op1, 'Skip test 061', 'A body.', null, 'vendor', v_batch, 20000, 'tok-061-k1');

  update public.student_notify_state set last_push_at = now();
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now()
   where user_id in (s_ba, s_bb, s_bc);

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_admin_broadcast_pushes(
    p_max_users => 40, p_skip_users => array[s_ba], p_quiet_start => 0, p_quiet_end => 0);
  if coalesce(array_length(got, 1), 0) = 2
     and not (s_ba = any(got)) and s_bb = any(got) and s_bc = any(got) then
    raise notice 'PASS K1: p_skip_users drops the named student and nobody else';
  else raise notice 'FAIL K1: with S_BA skipped the tick returned %, wanted S_BB and S_BC', got; end if;

  -- A fresh broadcast, because K1's call left S_BB and S_BC on 'sending' rows and
  -- a student already claimed for a broadcast is not a student the cap kept out.
  -- Y1 is cancelled first: its remaining queued row for S_BA is OLDER than
  -- anything in Y2, so leaving it live would put S_BA at the head of the candidate
  -- list twice and the cap of 2 would spend itself on one student.
  update public.admin_broadcasts set status = 'cancelled' where id = y1;
  select out_id into y2 from public.create_admin_broadcast(
    op1, 'Cap test 061', 'A body.', null, 'vendor', v_batch, 20000, 'tok-061-k2');

  update public.student_notify_state set last_push_at = now();
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now()
   where user_id in (s_ba, s_bb, s_bc);

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_admin_broadcast_pushes(p_max_users => 2, p_quiet_start => 0, p_quiet_end => 0);
  if coalesce(array_length(got, 1), 0) = 2
     and s_ba = any(got) and s_bb = any(got) and not (s_bc = any(got)) then
    raise notice 'PASS K2: p_max_users caps the batch and keeps the two the drain order chose';
  else raise notice 'FAIL K2: a cap of 2 against three eligible students returned %', got; end if;

  -- Two overlapping announcements must drain in the order they were sent rather
  -- than interleaving: a student who is behind both hears the older one first,
  -- and the newer one waits for their next slot. Backdated by an hour rather than
  -- relying on the microseconds between two create calls, so this is an assertion
  -- about the ORDER BY rather than about clock resolution.
  update public.admin_broadcasts set status = 'cancelled' where status = 'queued';
  select out_id into z1 from public.create_admin_broadcast(
    op1, 'Older 061', 'Sent first.', null, 'vendor', v_batch, 20000, 'tok-061-k3a');
  select out_id into z2 from public.create_admin_broadcast(
    op1, 'Newer 061', 'Sent second.', null, 'vendor', v_batch, 20000, 'tok-061-k3b');
  update public.admin_broadcasts set created_at = now() - interval '1 hour' where id = z1;

  update public.student_notify_state set last_push_at = now();
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now()
   where user_id = s_ba;

  select coalesce(array_agg(out_broadcast_id), '{}'::uuid[]) into gotb
  from public.claim_admin_broadcast_pushes(p_max_users => 1, p_quiet_start => 0, p_quiet_end => 0);
  if coalesce(array_length(gotb, 1), 0) = 1 and z1 = any(gotb) then
    raise notice 'PASS K3: the oldest broadcast drains first, so two announcements do not interleave';
  else raise notice 'FAIL K3: a batch of one came from %, wanted the older broadcast %', gotb, z1; end if;
end $$;

-- ============================================================
-- block 12: finish_admin_broadcast
-- ============================================================
--
-- Every claimed row has to come back through here, and the not-delivered path is
-- the one that matters: the claim already spent a cooldown that silences deals,
-- nearby alerts and reminders too, so four hours of a student's silence bought
-- nothing if the send did not land. Delivered is the easy direction; refunding is
-- the one that keeps the shared budget honest.
do $$
declare
  op1      uuid := '00000000-0000-0000-0000-0000000610a1';
  v_batch  uuid := '00000000-0000-0000-0000-0000000610b9';
  v_nearby uuid := '00000000-0000-0000-0000-0000000610b8';
  s_all    uuid := '00000000-0000-0000-0000-000000061001';   -- never in the Batch audience
  s_ba     uuid := '00000000-0000-0000-0000-000000061013';
  s_bb     uuid := '00000000-0000-0000-0000-000000061014';
  bid uuid;
  got uuid[];
  flag boolean;
  v_status  text;
  v_pushed  timestamptz;
  v_claimed timestamptz;
  n integer;
  m integer;
begin
  update public.admin_broadcasts set status = 'cancelled' where status = 'queued';
  select out_id into bid from public.create_admin_broadcast(
    op1, 'Settle test 061', 'A body.', null, 'vendor', v_batch, 20000, 'tok-061-l');

  update public.student_notify_state set last_push_at = now();
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now()
   where user_id in (s_ba, s_bb);

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_admin_broadcast_pushes(p_max_users => 40, p_quiet_start => 0, p_quiet_end => 0);
  if coalesce(array_length(got, 1), 0) = 2 and s_ba = any(got) and s_bb = any(got) then
    raise notice 'PASS L1: fixture — two students are out on ''sending'' rows, ready to be settled';
  else raise notice 'FAIL L1: the setup claim returned %, wanted S_BA and S_BB', got; end if;

  -- ---------- delivered ----------
  select public.finish_admin_broadcast(bid, s_ba, true) into flag;
  if flag then raise notice 'PASS L2: settling a delivered push reports that it reversed a row';
  else raise notice 'FAIL L2: finish_admin_broadcast returned false for a row it had just claimed'; end if;

  select status, pushed_at into v_status, v_pushed
    from public.admin_broadcast_recipients where broadcast_id = bid and user_id = s_ba;
  if v_status = 'sent' and v_pushed is not null then
    raise notice 'PASS L3: delivered marks the recipient ''sent'' and stamps pushed_at';
  else raise notice 'FAIL L3: after a delivered settle the row is status=% pushed_at=%', v_status, v_pushed; end if;

  -- sent_count is what the operator's screen reports against queued_count, so it
  -- is counted at SETTLE time rather than at claim time: a claim whose push then
  -- failed must not show up as delivered.
  select sent_count into n from public.admin_broadcasts where id = bid;
  if n = 1 then raise notice 'PASS L4: a delivered settle increments sent_count';
  else raise notice 'FAIL L4: sent_count is % after one delivered push', n; end if;

  select public.finish_admin_broadcast(bid, s_ba, true) into flag;
  select sent_count into n from public.admin_broadcasts where id = bid;
  if not flag and n = 1 then
    raise notice 'PASS L5: settling the same row twice reports false and does not count it twice';
  else raise notice 'FAIL L5: a repeated delivered settle returned % and left sent_count at %', flag, n; end if;

  -- ---------- not delivered ----------
  select public.finish_admin_broadcast(bid, s_bb, false) into flag;
  if flag then raise notice 'PASS L6: settling a failed push reports that it reversed a row';
  else raise notice 'FAIL L6: a failed-send settle returned false for a ''sending'' row'; end if;

  select status, claimed_at into v_status, v_claimed
    from public.admin_broadcast_recipients where broadcast_id = bid and user_id = s_bb;
  if v_status = 'queued' and v_claimed is null then
    raise notice 'PASS L7: a failed push puts the recipient back on the queue with no claimed_at';
  else raise notice 'FAIL L7: after a failed settle the row is status=% claimed_at=%', v_status, v_claimed; end if;

  select count(*) into n from public.student_notify_state
   where user_id = s_bb and day_count = 0 and week_count = 0 and last_push_at is null;
  if n = 1 then raise notice 'PASS L8: the refund gives back both counters and clears the shared stamp';
  else raise notice 'FAIL L8: a failed send left the student part-charged'; end if;

  -- The cross-feature half, which is the whole reason the refund exists. Nulling
  -- last_push_at rather than backdating it is what hands the slot to the other
  -- three features, and Nearby Spot holds no history for anybody so migration-051
  -- can only be answering about the budget.
  select public.claim_nearby_notification(s_bb, v_nearby, 240, 2, 5, 0, 0, 'UTC') into flag;
  if flag then
    raise notice 'PASS L9: the refund releases the SHARED cooldown, so a nearby alert straight afterwards is allowed';
  else raise notice 'FAIL L9: a nearby alert was still refused after the broadcast was refunded'; end if;

  -- ---------- a row that is not 'sending' ----------
  select public.finish_admin_broadcast(bid, s_bb, false) into flag;
  select day_count, week_count into n, m from public.student_notify_state where user_id = s_bb;
  if not flag and n = 1 and m = 1 then
    raise notice 'PASS L10: settling a row that is back on the queue reports false and refunds nothing';
  else raise notice 'FAIL L10: a second refund returned % and left day=% week=%', flag, n, m; end if;

  -- A pair that was never queued at all. S_ALL is not in the Batch Spot audience,
  -- so there is no row to find.
  select public.finish_admin_broadcast(bid, s_all, true) into flag;
  select sent_count into n from public.admin_broadcasts where id = bid;
  if not flag and n = 1 then
    raise notice 'PASS L11: settling a (broadcast, student) pair that was never queued reports false and counts nothing';
  else raise notice 'FAIL L11: an unknown pair returned % and left sent_count at %', flag, n; end if;

  -- Null arguments. The worker settles whatever it was handed, and a null here is
  -- a bug upstream rather than a reason to write to a row chosen by coincidence.
  select public.finish_admin_broadcast(null, s_ba, true) into flag;
  if not flag then raise notice 'PASS L12: a null broadcast id reports false rather than touching anything';
  else raise notice 'FAIL L12: a null broadcast id returned true'; end if;

  select public.finish_admin_broadcast(bid, null, false) into flag;
  if not flag then raise notice 'PASS L13: a null user id reports false rather than touching anything';
  else raise notice 'FAIL L13: a null user id returned true'; end if;

  -- ---------- the floor ----------
  -- The function's own guard (`if v_rows = 0 then return false`) makes a genuine
  -- double refund impossible through the API, so greatest(count - 1, 0) can only
  -- be reached by a 'sending' row whose student's counters are ALREADY empty --
  -- which is what an operator resetting a student's state, or a day window
  -- rolling over while a send is outstanding, actually looks like. Forced by hand
  -- for exactly that reason, and the mechanism is worth keeping: a refund that
  -- could go negative hands that student unlimited notifications until the window
  -- rolls, which is the failure greatest() exists to prevent.
  update public.student_notify_state
     set day_count = 0, week_count = 0, last_push_at = null
   where user_id = s_bb;
  update public.admin_broadcast_recipients
     set status = 'sending', claimed_at = now()
   where broadcast_id = bid and user_id = s_bb;

  select public.finish_admin_broadcast(bid, s_bb, false) into flag;
  select day_count, week_count into n, m from public.student_notify_state where user_id = s_bb;
  if flag and n = 0 and m = 0 then
    raise notice 'PASS L14: a refund against empty counters floors them at zero rather than going negative';
  else raise notice 'FAIL L14: refunding an empty budget returned % and left day=% week=%', flag, n, m; end if;
end $$;

-- ============================================================
-- block 13: the grants, the definer treatment, and the shipped defaults
-- ============================================================
--
-- Nothing above asserts any of this, and a missing revoke is invisible until the
-- day somebody reaches these with the anon key /api/public-config hands to every
-- browser. All four functions are SECURITY DEFINER over tables with RLS and no
-- policies, which is the right design and also the reason the grant is the whole
-- fence: PUBLIC holds EXECUTE on a new function by DEFAULT in Postgres, so the
-- explicit `revoke ... from public` in migration-061 is load-bearing rather than
-- decorative.
--
-- The claim's signature is the EIGHT argument types the function declares, and it
-- is spelled out as a variable rather than inlined because it is the one thing
-- here that has already been got wrong once: migration-061 shipped its comment,
-- revoke and grant for that function against a NINE-type signature (an extra
-- `integer`, copied from claim_reminder_pushes, which has p_min_interval_hours
-- and this does not). A signature naming no function raises 42883, and inside
-- that file's begin/commit it rolls the WHOLE migration back -- so the symptom was
-- not a missing grant but a feature that did not exist. M1 below is the guard
-- that would have caught it from this side.
do $$
declare
  aud_sig    text := 'text, uuid, integer';
  create_sig text := 'uuid, text, text, text, text, uuid, integer, text';
  claim_sig  text := 'integer, uuid[], integer, integer, integer, integer, integer, text';
  fin_sig    text := 'uuid, uuid, boolean';
  v_args text;
  n integer;
begin
  -- A signature guard, FIRST, because everything after it leans on the strings
  -- above resolving. has_function_privilege and ::regprocedure both RAISE on a
  -- signature that matches nothing, which kills this whole DO block -- so without
  -- this line the only output would be a bare 42883 and a report of zero
  -- assertions for a block that never ran. Notices are flushed per statement, so
  -- the FAIL below is printed before that happens and names the cause.
  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'claim_admin_broadcast_pushes' and p.pronargs = 8;
  if n = 1 then raise notice 'PASS M1: the claim exists exactly once, with the eight arguments the contract names';
  else raise notice 'FAIL M1: % functions named claim_admin_broadcast_pushes take 8 arguments', n; end if;

  -- ---------- audience ----------
  if has_function_privilege('anon', 'public.admin_broadcast_audience(' || aud_sig || ')', 'execute')
  then raise notice 'FAIL M2: anon can execute admin_broadcast_audience';
  else raise notice 'PASS M2: anon cannot execute admin_broadcast_audience'; end if;

  if has_function_privilege('authenticated', 'public.admin_broadcast_audience(' || aud_sig || ')', 'execute')
  then raise notice 'FAIL M3: authenticated can execute admin_broadcast_audience';
  else raise notice 'PASS M3: authenticated cannot execute admin_broadcast_audience'; end if;

  if has_function_privilege('service_role', 'public.admin_broadcast_audience(' || aud_sig || ')', 'execute')
  then raise notice 'PASS M4: service_role can execute admin_broadcast_audience';
  else raise notice 'FAIL M4: service_role cannot execute admin_broadcast_audience'; end if;

  -- ---------- create ----------
  if has_function_privilege('anon', 'public.create_admin_broadcast(' || create_sig || ')', 'execute')
  then raise notice 'FAIL M5: anon can execute create_admin_broadcast';
  else raise notice 'PASS M5: anon cannot execute create_admin_broadcast'; end if;

  if has_function_privilege('authenticated', 'public.create_admin_broadcast(' || create_sig || ')', 'execute')
  then raise notice 'FAIL M6: authenticated can execute create_admin_broadcast';
  else raise notice 'PASS M6: authenticated cannot execute create_admin_broadcast'; end if;

  if has_function_privilege('service_role', 'public.create_admin_broadcast(' || create_sig || ')', 'execute')
  then raise notice 'PASS M7: service_role can execute create_admin_broadcast';
  else raise notice 'FAIL M7: service_role cannot execute create_admin_broadcast'; end if;

  -- ---------- claim ----------
  if has_function_privilege('anon', 'public.claim_admin_broadcast_pushes(' || claim_sig || ')', 'execute')
  then raise notice 'FAIL M8: anon can execute claim_admin_broadcast_pushes';
  else raise notice 'PASS M8: anon cannot execute claim_admin_broadcast_pushes'; end if;

  if has_function_privilege('authenticated', 'public.claim_admin_broadcast_pushes(' || claim_sig || ')', 'execute')
  then raise notice 'FAIL M9: authenticated can execute claim_admin_broadcast_pushes';
  else raise notice 'PASS M9: authenticated cannot execute claim_admin_broadcast_pushes'; end if;

  if has_function_privilege('service_role', 'public.claim_admin_broadcast_pushes(' || claim_sig || ')', 'execute')
  then raise notice 'PASS M10: service_role can execute claim_admin_broadcast_pushes';
  else raise notice 'FAIL M10: service_role cannot execute claim_admin_broadcast_pushes'; end if;

  -- ---------- finish ----------
  if has_function_privilege('anon', 'public.finish_admin_broadcast(' || fin_sig || ')', 'execute')
  then raise notice 'FAIL M11: anon can execute finish_admin_broadcast';
  else raise notice 'PASS M11: anon cannot execute finish_admin_broadcast'; end if;

  if has_function_privilege('authenticated', 'public.finish_admin_broadcast(' || fin_sig || ')', 'execute')
  then raise notice 'FAIL M12: authenticated can execute finish_admin_broadcast';
  else raise notice 'PASS M12: authenticated cannot execute finish_admin_broadcast'; end if;

  if has_function_privilege('service_role', 'public.finish_admin_broadcast(' || fin_sig || ')', 'execute')
  then raise notice 'PASS M13: service_role can execute finish_admin_broadcast';
  else raise notice 'FAIL M13: service_role cannot execute finish_admin_broadcast'; end if;

  -- All four must be SECURITY DEFINER with search_path pinned, or a definer
  -- function resolves unqualified names against the CALLER's path -- which for a
  -- definer function reachable by the API role is how a shadowed `profiles`
  -- becomes a privilege escalation.
  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname in ('admin_broadcast_audience', 'create_admin_broadcast',
                      'claim_admin_broadcast_pushes', 'finish_admin_broadcast')
    and p.prosecdef
    and p.proconfig @> array['search_path=public'];
  if n = 4 then raise notice 'PASS M14: all four functions are SECURITY DEFINER with search_path pinned';
  else raise notice 'FAIL M14: only % of 4 functions are definer-with-search_path', n; end if;

  -- The storm defences, read out of the CATALOGUE rather than inferred from
  -- behaviour, because behaviour here is driven by whatever the caller passes and
  -- every assertion above deliberately passes its own. These five numbers are
  -- what legal/student-privacy-policy.html section 7.4 promises a student and
  -- what test/campaigns.test.js pins on the JS side; this is the SQL half of that
  -- pairing. A default drifting apart from CAMPAIGN_CONFIG gives this feature its
  -- own quota in everything but name.
  --
  -- Each pattern ends at the comma on purpose: '%DEFAULT 2%' would also match
  -- DEFAULT 20 and DEFAULT 240.
  v_args := pg_get_function_arguments(
    ('public.claim_admin_broadcast_pushes(' || claim_sig || ')')::regprocedure);
  if v_args like '%p_cooldown_minutes integer DEFAULT 240,%'
     and v_args like '%p_daily_cap integer DEFAULT 2,%'
     and v_args like '%p_weekly_cap integer DEFAULT 5,%'
     and v_args like '%p_quiet_start integer DEFAULT 22,%'
     and v_args like '%p_quiet_end integer DEFAULT 9,%'
     and v_args like '%p_timezone text DEFAULT ''America/New_York''%' then
    raise notice 'PASS M15: the shipped defaults are the ones the Privacy Policy promises';
  else raise notice 'FAIL M15: a storm-defence default moved: %', v_args; end if;

  if v_args like 'p_max_users integer DEFAULT 40,%' then
    raise notice 'PASS M16: the batch size still ships as 40';
  else raise notice 'FAIL M16: p_max_users is no longer 40: %', v_args; end if;

  -- The audience sanity bound, same treatment. 20000 is far above any plausible
  -- campus student body and far below anything that would strain the insert, and
  -- it is the number that decides what happens when the route forwards a
  -- nonsense limit.
  v_args := pg_get_function_arguments(
    ('public.admin_broadcast_audience(' || aud_sig || ')')::regprocedure);
  if v_args like '%p_audience text DEFAULT ''all''%'
     and v_args like '%p_limit integer DEFAULT 20000%' then
    raise notice 'PASS M17: the audience still defaults to ''all'' with a 20000 sanity bound';
  else raise notice 'FAIL M17: the audience defaults moved: %', v_args; end if;

  -- RLS on, no policies: service_role only, like every other operator table
  -- here. A student's anon key must never be able to read what we are about to
  -- send, let alone who is in an audience.
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public'
    and c.relname in ('admin_broadcasts', 'admin_broadcast_recipients')
    and c.relrowsecurity;
  if n = 2 then raise notice 'PASS M18: row level security is enabled on both new tables';
  else raise notice 'FAIL M18: only % of 2 new tables have RLS enabled', n; end if;

  select count(*) into n from pg_policies
  where schemaname = 'public'
    and tablename in ('admin_broadcasts', 'admin_broadcast_recipients');
  if n = 0 then raise notice 'PASS M19: neither new table carries a policy, so RLS denies by default';
  else raise notice 'FAIL M19: % policies exist on the new tables', n; end if;

  -- The table grants, which the `alter default privileges` in
  -- 20260807162120/20260807045446 are supposed to settle for every table created
  -- afterwards. Asserted rather than assumed: this is the only check that would
  -- notice a future migration handing the API roles a blanket grant.
  if has_table_privilege('anon', 'public.admin_broadcasts', 'select')
     or has_table_privilege('anon', 'public.admin_broadcast_recipients', 'select')
     or has_table_privilege('authenticated', 'public.admin_broadcasts', 'select')
     or has_table_privilege('authenticated', 'public.admin_broadcast_recipients', 'select')
  then raise notice 'FAIL M20: an API role can select from a broadcast table';
  else raise notice 'PASS M20: neither anon nor authenticated can select from either broadcast table'; end if;

  if has_table_privilege('service_role', 'public.admin_broadcasts', 'select')
     and has_table_privilege('service_role', 'public.admin_broadcast_recipients', 'select')
  then raise notice 'PASS M21: service_role can read both broadcast tables, so the admin screen works';
  else raise notice 'FAIL M21: service_role cannot read the broadcast tables'; end if;
end $$;

-- ============================================================
-- block 14: the pre-filter the driving query does not have
--
-- ⚠ THIS BLOCK IS EXPECTED TO FAIL AGAINST migration-061 AS SHIPPED, and it is
-- written this way deliberately rather than omitted or softened: it encodes the
-- contract the two sibling claim functions document as mandatory, and a red line
-- here is more useful than a file that quietly agrees with the bug.
--
-- WHAT THE SIBLINGS SAY. migration-047's claim_campaign_pushes, above its driving
-- query, in these words: "The driving query must select only students who will
-- ACTUALLY produce a bundle. It costs a duplicate of the eligibility rules below,
-- and it is not optional: this is ordered oldest-first and capped at p_max_users,
-- so a student who is picked and then skipped inside the loop still consumes one
-- of those slots. Let blocked students through here and the head of the queue
-- fills with people who cannot be delivered to, every tick, for as long as their
-- cooldown lasts — starving everyone behind them." migration-060's
-- claim_reminder_pushes repeats it and names it as "the same trap migration-047
-- documents".
--
-- WHAT 061 DOES. Its driving query filters on broadcast status, expiry,
-- p_skip_users and the existence of a student endpoint — and on nothing about the
-- budget. push_opt_in, the cooldown and both caps are checked only inside the
-- loop, after the limit has already been spent. migration-061's own header claims
-- "the same shape as claim_reminder_pushes (migration-060)", so this reads as an
-- omission rather than a decision.
--
-- WHY IT IS WORSE HERE THAN FOR THE SIBLINGS. A reminder has no deadline and a
-- campaign is per-vendor and small. A broadcast is campus-wide and expires in 48
-- hours, and its order is fixed — (broadcast created_at, user_id), with no
-- "longest waiting first" to rotate the queue. So the SAME lowest-uuid students
-- sit at the head of a 20,000-row queue every tick; while they are inside a
-- four-hour cooldown or over a daily cap the tick returns nothing at all, and the
-- students behind them are never reached before the broadcast expires. The
-- operator sees queued_count 20000 and sent_count near zero, with no error
-- anywhere.
--
-- THE FIX is to repeat the budget rules in the driving query, exactly as
-- migration-060 does: join student_notify_state, require push_opt_in, require the
-- cooldown to have elapsed, and write the cap tests against the stale-window arms
-- so a capped-out count on an expired window is not a reason to exclude anybody.
-- ============================================================
do $$
declare
  op1     uuid := '00000000-0000-0000-0000-0000000610a1';
  v_batch uuid := '00000000-0000-0000-0000-0000000610b9';
  s_ba    uuid := '00000000-0000-0000-0000-000000061013';   -- lowest uuid: head of the queue
  s_bb    uuid := '00000000-0000-0000-0000-000000061014';
  s_bc    uuid := '00000000-0000-0000-0000-000000061015';   -- highest uuid: behind them
  bid uuid;
  got uuid[];
begin
  update public.admin_broadcasts set status = 'cancelled' where status = 'queued';
  select out_id into bid from public.create_admin_broadcast(
    op1, 'Head of line 061', 'A body.', null, 'vendor', v_batch, 20000, 'tok-061-n');

  -- The two lowest uuids are inside their cooldown; the third is wide open. With
  -- the eligibility rules in the driving query, a cap of 2 selects the only two
  -- deliverable candidates there are -- which is one student -- and S_BC is
  -- claimed. Without them, the cap is spent on the two who cannot be delivered to
  -- and the tick returns nobody, every tick, until their cooldowns clear.
  update public.student_notify_state set last_push_at = now();
  update public.student_notify_state
     set last_push_at = null,
         day_count = 0, day_start = now(),
         week_count = 0, week_start = now()
   where user_id = s_bc;

  -- Fixture guard, because this block's whole meaning depends on it: the scan is
  -- ordered by (broadcast created_at, user_id), so the two students who cannot be
  -- delivered to have to be the two the cap would reach FIRST. If seed-061's three
  -- Batch Spot uuids ever stop ascending, the assertion below starts testing
  -- nothing and would quietly go green.
  if s_ba < s_bb and s_bb < s_bc then
    raise notice 'PASS N1: fixture — the two cooldown-bound students hold the lowest uuids, so they head the queue';
  else raise notice 'FAIL N1: the Batch Spot uuids are not ascending (%, %, %), so the head of the queue is not the parked pair', s_ba, s_bb, s_bc; end if;

  select coalesce(array_agg(out_user_id), '{}'::uuid[]) into got
  from public.claim_admin_broadcast_pushes(p_max_users => 2, p_quiet_start => 0, p_quiet_end => 0);
  if s_bc = any(got) then
    raise notice 'PASS N2: a tick reaches an eligible student behind two who are inside their cooldown';
  else
    raise notice 'FAIL N2: the batch was spent on two refused students at the head of the queue and returned % - the driving query has no budget pre-filter (migration-047/060 document this as not optional)', got;
  end if;
end $$;
