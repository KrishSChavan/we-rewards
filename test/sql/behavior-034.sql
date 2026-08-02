-- Runtime behaviour of migration-033 (refund a push that reached nobody) and
-- migration-034 (a cancelled campaign only refunds its send if it never pushed).
-- Each check raises PASS or FAIL as a notice; grep the output for FAIL.
--
-- Pairs with seed-032.sql:
--   powershell -File test/sql/run.ps1 -Migration migration-034.sql `
--              -Seed seed-032.sql -Behavior behavior-034.sql
--
-- The headline assertion is D: taking down a deal that ALREADY notified people
-- must not hand the send back. If it did, "send, take down, send again" would be
-- an unlimited notification tap and the per-vendor weekly cap — the cheapest
-- storm defence migration-032 has — would be decorative.
--
-- Every create_campaign call below passes p_weekly_sends => 1 so the cap is
-- reached in a single send and the refund rule is the only thing under test.

do $$
declare
  v1  uuid := '11111111-1111-1111-1111-111111111111';
  u1  uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  c1  uuid;
  c2  uuid;
  c3  uuid;
  n   integer;
  b   uuid;
  ts  timestamptz;
begin
  -- ---------- A. the first send is accepted and targets the seeded audience ----------
  select campaign_id, queued into c1, n
  from create_campaign(v1, null, 'One', 'Body one', 'deal', 'top', 100, null, 0, 24, 1);
  if c1 is not null and n = 5 then
    raise notice 'PASS A: first send accepted, queued to the 5 seeded regulars';
  else
    raise notice 'FAIL A: expected a campaign queued to 5, got id=% queued=%', c1, n;
  end if;

  -- ---------- B. that spends the whole weekly cap ----------
  begin
    perform create_campaign(v1, null, 'Two', 'Body two', 'deal', 'top', 100, null, 0, 24, 1);
    raise notice 'FAIL B: a second send was accepted with the weekly cap at 1';
  exception when others then
    if sqlerrm = 'CAMPAIGN_QUOTA' then
      raise notice 'PASS B: second send refused (CAMPAIGN_QUOTA)';
    else
      raise notice 'FAIL B: expected CAMPAIGN_QUOTA, got %', sqlerrm;
    end if;
  end;

  -- ---------- C. taking a deal down does NOT refund the send ----------
  -- Even with sent_count = 0 (no notification ever went out), the campaign was
  -- delivered the moment its campaign_recipients rows were written — that IS
  -- the in-app deals list. Refunding on sent_count = 0 would make "send, let it
  -- run, take it down, send again" an unlimited in-app fan-out, because
  -- sent_count is 0 for every campaign whenever push is unconfigured.
  update vendor_campaigns set status = 'cancelled', expires_at = now() where id = c1;
  begin
    perform create_campaign(v1, null, 'Three', 'Body three', 'deal', 'top', 100, null, 0, 24, 1);
    raise notice 'FAIL C: taking a campaign down refunded the send';
  exception when others then
    if sqlerrm = 'CAMPAIGN_QUOTA' then
      raise notice 'PASS C: a taken-down campaign still counts against the weekly cap';
    else
      raise notice 'FAIL C: expected CAMPAIGN_QUOTA, got %', sqlerrm;
    end if;
  end;

  -- ---------- D. ...and that holds for one that pushed, too ----------
  update vendor_campaigns set sent_count = 3 where id = c1;
  begin
    perform create_campaign(v1, null, 'Four', 'Body four', 'deal', 'top', 100, null, 0, 24, 1);
    raise notice 'FAIL D: a delivered, taken-down campaign refunded the send';
  exception when others then
    if sqlerrm = 'CAMPAIGN_QUOTA' then
      raise notice 'PASS D: a delivered campaign stays spent after being taken down';
    else
      raise notice 'FAIL D: expected CAMPAIGN_QUOTA, got %', sqlerrm;
    end if;
  end;

  -- The cap has to be raised for the rest of the file, since nothing refunds.
  -- Everything below passes p_weekly_sends => 99.

  -- ---------- E. expires_at = now() stops an unclaimed push ----------
  -- The takedown route writes exactly this, and it is the whole mechanism: the
  -- driving scan in claim_campaign_pushes joins on c.expires_at > now().
  insert into push_subscriptions (user_id, endpoint, p256dh, auth, role)
  values (u1, 'https://push.example/u1-034', 'k', 'a', 'student')
  on conflict do nothing;

  select campaign_id into c3
  from create_campaign(v1, null, 'Five', 'Body five', 'deal', 'top', 100, null, 0, 24, 99);
  update campaign_recipients set deliver_after = now() - interval '1 minute' where campaign_id = c3;
  update vendor_campaigns set expires_at = now() where id = c3;

  select count(*) into n
  from claim_campaign_pushes(40, '{}'::uuid[], 0, 99, 99, 0, 4, 0, 0, 'UTC');
  if n = 0 then
    raise notice 'PASS E: a taken-down campaign is never claimed for delivery';
  else
    raise notice 'FAIL E: expected 0 claims for an expired campaign, got %', n;
  end if;

  -- ---------- F. migration-033: a send that reached NOBODY refunds the quota ----------
  -- Set up a student mid-delivery: one recipient claimed into a batch, and the
  -- throttle state the claim would have spent.
  update vendor_campaigns set expires_at = now() + interval '1 day' where id = c3;
  b := gen_random_uuid();
  update campaign_recipients
     set status = 'sending', push_batch = b, claimed_at = now()
   where campaign_id = c3 and user_id = u1;

  insert into student_notify_state (user_id, push_opt_in, last_push_at, day_count, week_count)
  values (u1, true, now(), 1, 1)
  on conflict (user_id) do update
    set last_push_at = now(), day_count = 1, week_count = 1;

  perform finish_campaign_batch(b, false, true);

  select day_count, last_push_at into n, ts
  from student_notify_state where user_id = u1;
  if n = 0 and ts is null then
    raise notice 'PASS F: a zero-delivery batch refunds the day count and clears the cooldown';
  else
    raise notice 'FAIL F: expected day_count=0 and last_push_at=null, got %, %', n, ts;
  end if;

  select count(*) into n
  from campaign_recipients where campaign_id = c3 and status = 'queued';
  if n = 1 then
    raise notice 'PASS F2: the recipient went back to the queue for a later retry';
  else
    raise notice 'FAIL F2: expected the recipient requeued, got % queued rows', n;
  end if;

  -- ---------- G. a failure WITHOUT the refund flag still spends ----------
  -- Partial delivery (some devices took it) must not hand the quota back.
  update campaign_recipients
     set status = 'sending', push_batch = b, claimed_at = now()
   where campaign_id = c3 and user_id = u1;
  update student_notify_state
     set last_push_at = now(), day_count = 1, week_count = 1
   where user_id = u1;

  perform finish_campaign_batch(b, false, false);

  select day_count, last_push_at into n, ts
  from student_notify_state where user_id = u1;
  if n = 1 and ts is not null then
    raise notice 'PASS G: a failure without the refund flag leaves the quota spent';
  else
    raise notice 'FAIL G: expected day_count=1 and a cooldown, got %, %', n, ts;
  end if;
end;
$$;
