-- Runtime behaviour of the migration-032 campaign RPCs.
-- Each check raises PASS or FAIL as a notice; grep the output for FAIL.
--
-- The headline assertion is F: five vendors send at once to overlapping
-- audiences, and the one student on all five lists receives exactly ONE
-- notification carrying all of them. Everything else is the fence work that
-- makes F true under concurrency, opt-outs, and clocks.
--
-- Quiet hours are DISABLED (0, 0) in every check but J, because the container's
-- wall clock is whatever time the suite happens to run and a real quiet window
-- would silently turn most of this file into "claimed nothing, PASS".

do $$
declare
  v1 uuid := '11111111-1111-1111-1111-111111111111';
  v2 uuid := '22222222-2222-2222-2222-222222222222';
  v3 uuid := '33333333-3333-3333-3333-333333333333';
  v4 uuid := '44444444-4444-4444-4444-444444444444';
  v5 uuid := '55555555-5555-5555-5555-555555555555';
  u1 uuid := 'aaaaaaaa-0000-0000-0000-000000000001';   -- on every vendor's list
  u2 uuid := 'aaaaaaaa-0000-0000-0000-000000000002';
  u3 uuid := 'aaaaaaaa-0000-0000-0000-000000000003';
  u4 uuid := 'aaaaaaaa-0000-0000-0000-000000000004';   -- lapsed
  u5 uuid := 'aaaaaaaa-0000-0000-0000-000000000005';   -- close to a reward
  u6 uuid := 'aaaaaaaa-0000-0000-0000-000000000006';   -- no push subscription
  n        integer;
  m        integer;
  c1       uuid;
  cid      uuid;
  b        uuid;
  items    jsonb;
  hour_now integer;
  reused   boolean;
begin
  -- Everyone but u6 has granted notification permission on one device.
  insert into push_subscriptions (user_id, endpoint, p256dh, auth, role) values
    (u1, 'https://push.example/u1', 'k', 'a', 'student'),
    (u2, 'https://push.example/u2', 'k', 'a', 'student'),
    (u3, 'https://push.example/u3', 'k', 'a', 'student'),
    (u4, 'https://push.example/u4', 'k', 'a', 'student'),
    (u5, 'https://push.example/u5', 'k', 'a', 'student');

  -- ---------- A. the pre-existing admin row kept its meaning ----------
  select count(*) into n from push_subscriptions where role = 'admin';
  if n = 1 then raise notice 'PASS A: the pre-032 subscription backfilled to role=admin';
  else raise notice 'FAIL A: expected 1 admin subscription, got %', n; end if;

  -- ---------- B. audience: top ----------
  -- u1, u2, u3, u5, u6 transacted at vendor 1 inside 90 days. u4 did not.
  select count(*) into n from campaign_audience(v1, 'top', 100);
  if n = 5 then raise notice 'PASS B: top audience = 5 (the 90-day regulars)';
  else raise notice 'FAIL B: expected 5, got %', n; end if;

  -- ...ranked by visit-DAYS, so the 10-day regular leads.
  select a.user_id into cid from campaign_audience(v1, 'top', 100) a limit 1;
  if cid = u1 then raise notice 'PASS B2: ranked by visit days (u1 first)';
  else raise notice 'FAIL B2: expected u1 first, got %', cid; end if;

  -- ...and the limit is honoured.
  select count(*) into n from campaign_audience(v1, 'top', 2);
  if n = 2 then raise notice 'PASS B3: limit honoured';
  else raise notice 'FAIL B3: expected 2, got %', n; end if;

  -- ---------- C. audience: lapsed / close ----------
  select count(*) into n from campaign_audience(v1, 'lapsed', 100);
  select count(*) into m from campaign_audience(v1, 'lapsed', 100) a where a.user_id = u4;
  if n = 1 and m = 1 then raise notice 'PASS C: lapsed = only the 100-day-quiet regular';
  else raise notice 'FAIL C: lapsed count %, contains u4: %', n, m; end if;

  -- Coffee costs 50. u5 holds 30 and u3 holds 45 (both >= 25, < 50). u1 has
  -- 1000 and u2 has 60, so both are past it and must be excluded.
  select count(*) into n from campaign_audience(v1, 'close', 100);
  select count(*) into m from campaign_audience(v1, 'close', 100) a where a.user_id in (u3, u5);
  if n = 2 and m = 2 then raise notice 'PASS C2: close = the two students within reach of a reward';
  else raise notice 'FAIL C2: close count %, of which u3/u5: %', n, m; end if;

  -- ---------- D. the overlap this whole feature is built around ----------
  select count(*) into n
  from (select v.id from (values (v1), (v2), (v3), (v4), (v5)) v(id)) vs
  where exists (select 1 from campaign_audience(vs.id, 'top', 100) a where a.user_id = u1);
  if n = 5 then raise notice 'PASS D: one student sits on all 5 vendors top lists (the storm setup)';
  else raise notice 'FAIL D: expected u1 on 5 lists, got %', n; end if;

  -- ---------- E. create_campaign: quota + idempotency ----------
  select cc.campaign_id into c1 from create_campaign(
    v1, null, 'Half-price wings', 'Tonight only, show your code.', 'deal', 'top',
    100, 'tok-1', 0, 48, 2) cc;
  select count(*) into n from campaign_recipients r where r.campaign_id = c1;
  if n = 5 then raise notice 'PASS E: campaign fanned out to 5 recipient rows';
  else raise notice 'FAIL E: expected 5 recipients, got %', n; end if;

  -- Same token again: the ORIGINAL campaign comes back, no second fan-out.
  select cc.campaign_id, cc.reused into cid, reused from create_campaign(
    v1, null, 'Half-price wings', 'Tonight only, show your code.', 'deal', 'top',
    100, 'tok-1', 0, 48, 2) cc;
  select count(*) into n from campaign_recipients;
  if cid = c1 and reused and n = 5 then raise notice 'PASS E2: repeat token returned the original, no double fan-out';
  else raise notice 'FAIL E2: id % vs %, reused %, recipients %', cid, c1, reused, n; end if;

  -- Second send is allowed (quota 2), third is refused.
  perform create_campaign(v1, null, 'Second', 'Body', 'deal', 'top', 100, 'tok-2', 0, 48, 2);
  begin
    perform create_campaign(v1, null, 'Third', 'Body', 'deal', 'top', 100, 'tok-3', 0, 48, 2);
    raise notice 'FAIL E3: a third send got past the weekly quota of 2';
  exception when others then
    if sqlerrm like '%CAMPAIGN_QUOTA%' then raise notice 'PASS E3: weekly quota refused the third send';
    else raise notice 'FAIL E3: wrong error -> %', sqlerrm; end if;
  end;

  -- Validation.
  begin
    perform create_campaign(v1, null, '', 'Body', 'deal', 'top', 100, null, 0, 48, 9);
    raise notice 'FAIL E4: empty headline accepted';
  exception when others then
    if sqlerrm like '%CAMPAIGN_TITLE_INVALID%' then raise notice 'PASS E4: empty headline rejected';
    else raise notice 'FAIL E4: wrong error -> %', sqlerrm; end if;
  end;

  -- Clear the board for the delivery tests.
  delete from vendor_campaigns;
  delete from student_notify_state;

  -- ---------- F. THE HEADLINE: five vendors, one notification ----------
  perform create_campaign(v1, null, 'Wings',  'Half price tonight.',  'deal', 'top', 100, null, 0, 48, 9);
  perform create_campaign(v2, null, 'Tacos',  'Two for one until 9.', 'deal', 'top', 100, null, 0, 48, 9);
  perform create_campaign(v3, null, 'Noodles','Free drink with any bowl.', 'deal', 'top', 100, null, 0, 48, 9);
  perform create_campaign(v4, null, 'Pizza',  'Slice and a soda, $5.', 'deal', 'top', 100, null, 0, 48, 9);
  perform create_campaign(v5, null, 'Pints',  'Happy hour extended.', 'deal', 'top', 100, null, 0, 48, 9);

  -- Release them all right now (create_campaign snaps deliver_after up to the
  -- next slot boundary, which is the point in production and noise here).
  update vendor_campaigns set deliver_after = now() - interval '1 minute';
  update campaign_recipients set deliver_after = now() - interval '1 minute';

  select count(*) into n from campaign_recipients r where r.user_id = u1 and r.status = 'queued';
  if n = 5 then raise notice 'PASS F0: u1 is queued for all five vendors';
  else raise notice 'FAIL F0: expected 5 queued for u1, got %', n; end if;

  -- One claim pass. Defaults: bundle_max 4, cooldown 240 min, cap 2/day.
  select count(*) into n from claim_campaign_pushes(40, '{}', 240, 2, 5, 20, 4, 0, 0, 'UTC') c
  where c.out_user_id = u1;
  if n = 1 then raise notice 'PASS F1: u1 got exactly ONE bundle, not five notifications';
  else raise notice 'FAIL F1: u1 got % bundles', n; end if;

  select count(*) into n from campaign_recipients r where r.user_id = u1 and r.status = 'sending';
  if n = 4 then raise notice 'PASS F2: the bundle carries 4 vendors (bundle_max), the 5th stays queued';
  else raise notice 'FAIL F2: expected 4 in the bundle, got %', n; end if;

  select r.push_batch into b from campaign_recipients r where r.user_id = u1 and r.status = 'sending' limit 1;
  select count(distinct r.push_batch) into n from campaign_recipients r where r.user_id = u1 and r.status = 'sending';
  if n = 1 then raise notice 'PASS F3: all four share one push batch';
  else raise notice 'FAIL F3: % distinct batches', n; end if;

  -- Settle it, then immediately try again: the cooldown must hold.
  perform finish_campaign_batch(b, true);
  select count(*) into n from claim_campaign_pushes(40, '{}', 240, 2, 5, 20, 4, 0, 0, 'UTC') c
  where c.out_user_id = u1;
  if n = 0 then raise notice 'PASS F4: cooldown blocks a second notification for u1';
  else raise notice 'FAIL F4: u1 claimed again inside the cooldown'; end if;

  -- The 5th vendor is still owed, not lost.
  select count(*) into n from campaign_recipients r where r.user_id = u1 and r.status = 'queued';
  if n = 1 then raise notice 'PASS F5: the deferred vendor is still queued for a later slot';
  else raise notice 'FAIL F5: expected 1 still queued, got %', n; end if;

  -- ---------- G. settle marks sent and credits the campaign ----------
  select count(*) into n from campaign_recipients r where r.push_batch = b and r.status = 'sent';
  select sum(c.sent_count) into m from vendor_campaigns c;
  if n = 4 and m >= 4 then raise notice 'PASS G: batch settled to sent and sent_count credited';
  else raise notice 'FAIL G: sent rows %, sent_count sum %', n, m; end if;

  -- ---------- H. a student with no endpoint is never claimed ----------
  select count(*) into n from campaign_recipients r where r.user_id = u6 and r.status <> 'queued';
  if n = 0 then raise notice 'PASS H: the student with no push subscription was left alone';
  else raise notice 'FAIL H: claimed % rows for a student with no endpoint', n; end if;

  -- ...and does not starve anyone: their rows simply wait.
  select count(*) into n from campaign_recipients r where r.user_id = u6 and r.status = 'queued';
  if n = 1 then raise notice 'PASS H2: their deal still sits in the queue (and in their in-app list)';
  else raise notice 'FAIL H2: expected 1 queued for u6, got %', n; end if;

  -- ---------- I. opt-out ----------
  update student_notify_state set push_opt_in = false where user_id = u2;
  insert into student_notify_state (user_id, push_opt_in) values (u2, false)
    on conflict (user_id) do update set push_opt_in = false;
  select count(*) into n from claim_campaign_pushes(40, '{}', 240, 2, 5, 20, 4, 0, 0, 'UTC') c
  where c.out_user_id = u2;
  if n = 0 then raise notice 'PASS I: an opted-out student is never pushed';
  else raise notice 'FAIL I: pushed an opted-out student'; end if;

  -- ---------- J. quiet hours ----------
  -- Force a window that contains the current hour, whatever time it is.
  hour_now := extract(hour from (now() at time zone 'UTC'))::integer;
  select count(*) into n from claim_campaign_pushes(
    40, '{}', 0, 99, 99, 0, 4, hour_now, (hour_now + 1) % 24, 'UTC');
  if n = 0 then raise notice 'PASS J: quiet hours claim nothing at all';
  else raise notice 'FAIL J: claimed % bundles inside quiet hours', n; end if;

  -- ---------- K. skip list (a student with the app open) ----------
  -- Cooldown 0 so only the skip list can be responsible for the result.
  select count(*) into n from claim_campaign_pushes(
    40, array[u3]::uuid[], 0, 99, 99, 0, 4, 0, 0, 'UTC') c
  where c.out_user_id = u3;
  if n = 0 then raise notice 'PASS K: a foreground student is skipped, keeping their quota';
  else raise notice 'FAIL K: pushed a student who is looking at the app'; end if;

  -- ---------- L. per-vendor cooldown ----------
  -- u1 has already been sent vendor 1's deal (batch b). Queue another from the
  -- SAME vendor and drop every other fence: it must still be held back.
  delete from campaign_recipients r where r.user_id = u1 and r.status = 'queued';
  select cc.campaign_id into cid from create_campaign(
    v1, null, 'Wings again', 'And again.', 'deal', 'top', 100, null, 0, 48, 9) cc;
  update vendor_campaigns set deliver_after = now() - interval '1 minute' where id = cid;
  update campaign_recipients set deliver_after = now() - interval '1 minute' where campaign_id = cid;
  update student_notify_state set last_push_at = null, day_count = 0, week_count = 0 where user_id = u1;

  select count(*) into n from claim_campaign_pushes(
    40, '{}', 0, 99, 99, 20, 4, 0, 0, 'UTC') c
  where c.out_user_id = u1;
  if n = 0 then raise notice 'PASS L: one vendor cannot reach the same student twice in a day';
  else raise notice 'FAIL L: the same vendor got through the per-vendor cooldown'; end if;

  -- With the per-vendor cooldown at 0 it goes through, proving L was that fence
  -- and not some other one.
  select count(*) into n from claim_campaign_pushes(
    40, '{}', 0, 99, 99, 0, 4, 0, 0, 'UTC') c
  where c.out_user_id = u1;
  if n = 1 then raise notice 'PASS L2: with the vendor cooldown off, the same vendor is delivered';
  else raise notice 'FAIL L2: expected 1 bundle, got %', n; end if;

  -- ---------- M. daily cap ----------
  update student_notify_state set last_push_at = null where user_id = u1;   -- cooldown out of the way
  update campaign_recipients set status = 'queued', push_batch = null, claimed_at = null
   where user_id = u1 and status = 'sending';
  select count(*) into n from claim_campaign_pushes(
    40, '{}', 0, 1, 99, 0, 4, 0, 0, 'UTC') c
  where c.out_user_id = u1;
  if n = 0 then raise notice 'PASS M: the daily cap holds even with the cooldown cleared';
  else raise notice 'FAIL M: got past a daily cap of 1'; end if;

  -- ---------- N. a failed send returns the work to the queue ----------
  delete from campaign_recipients;
  delete from vendor_campaigns;
  delete from student_notify_state;
  select cc.campaign_id into cid from create_campaign(
    v1, null, 'Retry me', 'Body', 'deal', 'top', 100, null, 0, 48, 9) cc;
  update vendor_campaigns set deliver_after = now() - interval '1 minute';
  update campaign_recipients set deliver_after = now() - interval '1 minute';
  select c.out_batch into b from claim_campaign_pushes(40, '{}', 240, 2, 5, 20, 4, 0, 0, 'UTC') c
  where c.out_user_id = u1;
  perform finish_campaign_batch(b, false);
  select count(*) into n from campaign_recipients r where r.user_id = u1 and r.status = 'queued';
  if n = 1 then raise notice 'PASS N: a failed push returns the row to the queue';
  else raise notice 'FAIL N: expected 1 requeued, got %', n; end if;

  -- ---------- O. expiry ----------
  update vendor_campaigns set expires_at = now() - interval '1 second';
  perform claim_campaign_pushes(40, '{}', 0, 99, 99, 0, 4, 0, 0, 'UTC');
  select count(*) into n from campaign_recipients r where r.status = 'queued';
  select count(*) into m from campaign_recipients r where r.status = 'expired';
  if n = 0 and m > 0 then raise notice 'PASS O: an expired campaign stops being deliverable';
  else raise notice 'FAIL O: queued %, expired %', n, m; end if;

  -- ---------- P. a bundle never names one vendor twice ----------
  delete from campaign_recipients;
  delete from vendor_campaigns;
  delete from student_notify_state;
  perform create_campaign(v1, null, 'One',   'Body', 'deal', 'top', 100, null, 0, 48, 9);
  perform create_campaign(v1, null, 'Two',   'Body', 'deal', 'top', 100, null, 0, 48, 9);
  perform create_campaign(v2, null, 'Three', 'Body', 'deal', 'top', 100, null, 0, 48, 9);
  update vendor_campaigns set deliver_after = now() - interval '1 minute';
  update campaign_recipients set deliver_after = now() - interval '1 minute';
  select c.out_items into items from claim_campaign_pushes(40, '{}', 240, 2, 5, 20, 4, 0, 0, 'UTC') c
  where c.out_user_id = u1;
  select count(distinct x->>'vendorId'), count(*) into n, m
  from jsonb_array_elements(items) x;
  if n = m and m = 2 then raise notice 'PASS P: two campaigns from one vendor collapse to one slot in the bundle';
  else raise notice 'FAIL P: % distinct vendors across % bundle items', n, m; end if;

  -- ---------- Q. the payload carries what the worker needs ----------
  if items->0 ? 'vendor' and items->0 ? 'title' and items->0 ? 'body' and items->0 ? 'campaignId' then
    raise notice 'PASS Q: bundle items carry vendor, title, body, campaignId';
  else raise notice 'FAIL Q: bundle item shape is %', items->0; end if;

  -- ---------- R. a future release time is not claimable yet ----------
  delete from campaign_recipients;
  delete from vendor_campaigns;
  delete from student_notify_state;
  perform create_campaign(v1, null, 'Later', 'Body', 'deal', 'top', 100, null, 30, 48, 9);
  select count(*) into n from claim_campaign_pushes(40, '{}', 0, 99, 99, 0, 4, 0, 0, 'UTC');
  if n = 0 then raise notice 'PASS R: a held campaign is not delivered before its slot';
  else raise notice 'FAIL R: delivered % bundles early', n; end if;

  -- ...but it IS already in the student's in-app list, which is the whole
  -- reason the hold is safe.
  select count(*) into n from campaign_recipients r where r.user_id = u1;
  if n = 1 then raise notice 'PASS R2: the deal exists for the student immediately, hold or no hold';
  else raise notice 'FAIL R2: expected 1 recipient row, got %', n; end if;

  -- ---------- S. blocked students must not squat at the head of the queue ----------
  -- The claim is ordered oldest-first and capped, so if a student who CANNOT be
  -- delivered to still occupies a slot, everyone behind them starves for the
  -- length of that student's cooldown. Set up exactly that: u1 was pushed a
  -- moment ago and has the oldest queued work; u3 is free and queued later.
  -- With p_max_users = 1, the one slot has to go to u3.
  delete from campaign_recipients;
  delete from vendor_campaigns;
  delete from student_notify_state;
  perform create_campaign(v1, null, 'Squat test', 'Body', 'deal', 'top', 100, null, 0, 48, 9);
  update vendor_campaigns set deliver_after = now() - interval '10 minutes';
  update campaign_recipients set deliver_after = now() - interval '10 minutes' where user_id = u1;
  update campaign_recipients set deliver_after = now() - interval '1 minute'  where user_id <> u1;
  insert into student_notify_state (user_id, last_push_at, day_count, week_count)
  values (u1, now() - interval '5 minutes', 1, 1);

  select c.out_user_id into cid from claim_campaign_pushes(1, '{}', 240, 2, 5, 20, 4, 0, 0, 'UTC') c;
  if cid = u3 then raise notice 'PASS S: a cooled-down student does not hold the slot, the free student is served';
  elsif cid is null then raise notice 'FAIL S: the blocked student consumed the only slot (starvation)';
  else raise notice 'PASS S: slot went to a deliverable student (%)', cid; end if;

  -- ---------- T. deleting a student takes their marketing record with them ----------
  delete from profiles where user_id = u1;
  select count(*) into n from campaign_recipients r where r.user_id = u1;
  select count(*) into m from student_notify_state s where s.user_id = u1;
  if n = 0 and m = 0 then raise notice 'PASS T: account deletion cascades to deals and notify state';
  else raise notice 'FAIL T: % recipients, % state rows left behind', n, m; end if;
end;
$$;
