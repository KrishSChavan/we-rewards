-- Assertions for migration-069 (all-student deal requests).
--
-- The failure this feature must never have is a deal reaching the whole student
-- body WITHOUT the operator saying yes, or reaching a student who switched
-- messages off. So the blocks below go in that order: a request alone writes
-- nothing a student can see (block 1), a denial writes nothing either (block 2),
-- an approval writes exactly one campaign to exactly the consenting student body
-- (block 3), and then the ordinary claim still applies every opt-out to it
-- (block 6). Blocks 4 and 5 are the edges: the vendor's weekly quota, and a spot
-- that was switched off.
--
-- Each DO block is one transaction, so now() is fixed inside it.

-- ============================================================
-- block 1: asking writes nothing a student can see
-- ============================================================
do $$
declare
  req       uuid := '00000000-0000-0000-0000-0000000690a1';
  offspot   uuid := '00000000-0000-0000-0000-0000000690a2';
  staff     uuid := '00000000-0000-0000-0000-000000069005';
  noconsent uuid := '00000000-0000-0000-0000-0000000690ff';
  rid  uuid;
  rid2 uuid;
  st   text;
  reused boolean;
  n integer;
  m integer;
begin
  select count(*) into n from public.profiles;
  select count(*) into m from public.profiles where user_id = noconsent;
  if n = 5 and m = 0 then raise notice 'PASS R1: fixture — five profiles, and the non-consenting login has none';
  else raise notice 'FAIL R1: % profiles (want 5), non-consenting login has % (want 0)', n, m; end if;

  begin
    perform * from public.submit_deal_request(req, staff, '   ', 'Body', 'deal', 72, null);
    raise notice 'FAIL R2: a blank headline was accepted';
  exception when others then
    if sqlerrm like '%CAMPAIGN_TITLE_INVALID%' then raise notice 'PASS R2: a blank headline is refused';
    else raise notice 'FAIL R2: wrong error for a blank headline: %', sqlerrm; end if;
  end;

  begin
    perform * from public.submit_deal_request(req, staff, 'Title', repeat('x', 141), 'deal', 72, null);
    raise notice 'FAIL R3: a 141-character message was accepted';
  exception when others then
    if sqlerrm like '%CAMPAIGN_BODY_INVALID%' then raise notice 'PASS R3: a message over 140 characters is refused';
    else raise notice 'FAIL R3: wrong error for a long message: %', sqlerrm; end if;
  end;

  begin
    perform * from public.submit_deal_request(req, staff, 'Title', 'Body', 'deal', 0, null);
    raise notice 'FAIL R4: a zero-hour deal was accepted';
  exception when others then
    if sqlerrm like '%CAMPAIGN_DURATION_INVALID%' then raise notice 'PASS R4: a zero-hour duration is refused';
    else raise notice 'FAIL R4: wrong error for a zero duration: %', sqlerrm; end if;
  end;

  begin
    perform * from public.submit_deal_request(offspot, null, 'Title', 'Body', 'deal', 72, null);
    raise notice 'FAIL R5: a switched-off spot was allowed to ask';
  exception when others then
    if sqlerrm like '%VENDOR_UNAVAILABLE%' then raise notice 'PASS R5: a switched-off spot cannot ask';
    else raise notice 'FAIL R5: wrong error for a switched-off spot: %', sqlerrm; end if;
  end;

  select out_id, out_status, out_reused into rid, st, reused
  from public.submit_deal_request(req, staff, '  Half-price wings  ', 'Tonight only', 'deal', 72, 'tok-069-a');
  if rid is not null and st = 'pending' and not reused then raise notice 'PASS R6: a valid request is queued as pending';
  else raise notice 'FAIL R6: got id=% status=% reused=%', rid, st, reused; end if;

  select count(*) into n from public.vendor_deal_requests where id = rid and title = 'Half-price wings';
  if n = 1 then raise notice 'PASS R7: the headline is stored trimmed';
  else raise notice 'FAIL R7: the stored headline was not trimmed'; end if;

  -- THE property of this block. A request must not touch the campaign tables.
  select count(*) into n from public.vendor_campaigns where vendor_id = req;
  select count(*) into m from public.campaign_recipients;
  if n = 0 and m = 0 then raise notice 'PASS R8: a pending request writes no campaign and no recipient';
  else raise notice 'FAIL R8: a pending request wrote % campaigns and % recipients', n, m; end if;

  begin
    perform * from public.submit_deal_request(req, staff, 'Another', 'Body', 'deal', 72, 'tok-069-b');
    raise notice 'FAIL R9: a second pending request was accepted';
  exception when others then
    if sqlerrm like '%DEAL_REQUEST_PENDING%' then raise notice 'PASS R9: one pending request per vendor';
    else raise notice 'FAIL R9: wrong error for a second request: %', sqlerrm; end if;
  end;

  select out_id, out_reused into rid2, reused
  from public.submit_deal_request(req, staff, 'Half-price wings', 'Tonight only', 'deal', 72, 'tok-069-a');
  if rid2 = rid and reused then raise notice 'PASS R10: a retried token returns the original request';
  else raise notice 'FAIL R10: retry returned % (reused=%), original was %', rid2, reused, rid; end if;

  -- The backstop for anything that skips the function.
  begin
    insert into public.vendor_deal_requests (vendor_id, title, body, duration_hours)
    values (req, 'Direct', 'Body', 72);
    raise notice 'FAIL R11: a second pending row was inserted directly';
  exception when unique_violation then
    raise notice 'PASS R11: the partial unique index refuses a second pending row';
  end;
end;
$$;

-- ============================================================
-- block 2: a denial writes nothing either, and is final
-- ============================================================
do $$
declare
  req   uuid := '00000000-0000-0000-0000-0000000690a1';
  admin uuid := '00000000-0000-0000-0000-0000000690ee';
  rid uuid;
  st  text;
  changed boolean;
  cid uuid;
  note text;
  n integer;
begin
  select id into rid from public.vendor_deal_requests where vendor_id = req and status = 'pending';

  select out_status, out_changed, out_campaign_id into st, changed, cid
  from public.review_deal_request(rid, admin, false, '  Too vague, say what is half price.  ');
  select admin_note into note from public.vendor_deal_requests where id = rid;
  if st = 'denied' and changed and cid is null and note = 'Too vague, say what is half price.' then
    raise notice 'PASS D1: deny records the decision and the trimmed note';
  else raise notice 'FAIL D1: status=% changed=% campaign=% note=%', st, changed, cid, note; end if;

  select count(*) into n from public.vendor_campaigns where vendor_id = req;
  if n = 0 then raise notice 'PASS D2: a denial writes no campaign';
  else raise notice 'FAIL D2: a denial wrote % campaigns', n; end if;

  -- A late Approve click on a request that was already denied.
  select out_status, out_changed into st, changed from public.review_deal_request(rid, admin, true, null);
  select count(*) into n from public.vendor_campaigns where vendor_id = req;
  if st = 'denied' and not changed and n = 0 then
    raise notice 'PASS D3: approving a denied request changes nothing and reports the denial';
  else raise notice 'FAIL D3: status=% changed=% campaigns=%', st, changed, n; end if;

  begin
    perform * from public.review_deal_request(rid, admin, false, repeat('x', 501));
    raise notice 'FAIL D4: a 501-character note was accepted';
  exception when others then
    if sqlerrm like '%NOTE_TOO_LONG%' then raise notice 'PASS D4: a note over 500 characters is refused';
    else raise notice 'FAIL D4: wrong error for a long note: %', sqlerrm; end if;
  end;

  begin
    perform * from public.review_deal_request(rid, admin, null, null);
    raise notice 'FAIL D5: a null decision was accepted';
  exception when others then
    if sqlerrm like '%DECISION_REQUIRED%' then raise notice 'PASS D5: a null decision is refused';
    else raise notice 'FAIL D5: wrong error for a null decision: %', sqlerrm; end if;
  end;

  begin
    perform * from public.review_deal_request(gen_random_uuid(), admin, true, null);
    raise notice 'FAIL D6: an unknown request id was accepted';
  exception when others then
    if sqlerrm like '%DEAL_REQUEST_NOT_FOUND%' then raise notice 'PASS D6: an unknown request id is refused';
    else raise notice 'FAIL D6: wrong error for an unknown id: %', sqlerrm; end if;
  end;
end;
$$;

-- ============================================================
-- block 3: an approval reaches exactly the consenting student body, once
-- ============================================================
do $$
declare
  req       uuid := '00000000-0000-0000-0000-0000000690a1';
  staff     uuid := '00000000-0000-0000-0000-000000069005';
  admin     uuid := '00000000-0000-0000-0000-0000000690ee';
  noconsent uuid := '00000000-0000-0000-0000-0000000690ff';
  rid uuid;
  st  text;
  changed boolean;
  cid uuid;
  cid2 uuid;
  queued integer;
  c record;
  got uuid[];
  want uuid[];
  n integer;
begin
  select out_id into rid
  from public.submit_deal_request(req, staff, 'Free fries with any burger', 'Show your code at the counter.', 'deal', 24, null);

  select out_status, out_changed, out_campaign_id, out_queued into st, changed, cid, queued
  from public.review_deal_request(rid, admin, true, 'Looks good');
  if st = 'approved' and changed and cid is not null then raise notice 'PASS A1: approve returns the new campaign';
  else raise notice 'FAIL A1: status=% changed=% campaign=%', st, changed, cid; end if;

  select * into c from public.vendor_campaigns where id = cid;
  if c.audience = 'all' and c.vendor_id = req and c.created_by = staff
     and c.title = 'Free fries with any burger' and c.body = 'Show your code at the counter.'
     and c.status = 'queued' then
    raise notice 'PASS A2: the campaign is the vendor''s own words, audience ''all'', credited to the requester';
  else raise notice 'FAIL A2: audience=% vendor=% created_by=% title=% status=%', c.audience, c.vendor_id, c.created_by, c.title, c.status; end if;

  -- The clock starts at approval.
  if c.expires_at between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute' then
    raise notice 'PASS A3: the deal runs for its duration from the moment of approval';
  else raise notice 'FAIL A3: expires_at is %, now is %', c.expires_at, now(); end if;

  -- Held for the coalescing slot like any vendor deal, never released instantly.
  if c.deliver_after > now() and c.deliver_after <= now() + interval '10 minutes' then
    raise notice 'PASS A4: delivery is held for the coalescing slot';
  else raise notice 'FAIL A4: deliver_after is %, now is %', c.deliver_after, now(); end if;

  -- EXACT set, not membership: a membership check passes just as well when the
  -- audience is wrong in the other direction.
  select coalesce(array_agg(user_id order by user_id), '{}') into got
  from public.campaign_recipients where campaign_id = cid;
  select coalesce(array_agg(user_id order by user_id), '{}') into want from public.profiles;
  if got = want then raise notice 'PASS A5: one recipient per profile, every profile';
  else raise notice 'FAIL A5: recipients % vs profiles %', got, want; end if;

  if not (noconsent = any(got)) then raise notice 'PASS A6: a login that never consented is not a recipient';
  else raise notice 'FAIL A6: the non-consenting login was queued'; end if;

  if staff = any(got) then raise notice 'PASS A7: a staff login with a student profile is included, as in migration-061';
  else raise notice 'FAIL A7: the dual-role account was left out'; end if;

  select queued_count into n from public.vendor_deal_requests where id = rid;
  if queued = 5 and c.queued_count = 5 and c.audience_size = 5 and n = 5 then
    raise notice 'PASS A8: the count agrees in the result, the campaign and the request';
  else raise notice 'FAIL A8: result=% campaign=%/% request=%', queued, c.queued_count, c.audience_size, n; end if;

  -- Double click.
  select out_status, out_changed, out_campaign_id into st, changed, cid2
  from public.review_deal_request(rid, admin, true, null);
  select count(*) into n from public.vendor_campaigns where vendor_id = req and audience = 'all';
  if st = 'approved' and not changed and cid2 = cid and n = 1 then
    raise notice 'PASS A9: approving twice queues once and returns the same campaign';
  else raise notice 'FAIL A9: status=% changed=% campaign=% (first %) all-campaigns=%', st, changed, cid2, cid, n; end if;

  -- A late Deny on an approved request must not rewrite it.
  select out_status, out_changed into st, changed from public.review_deal_request(rid, admin, false, 'changed my mind');
  select count(*) into n from public.vendor_deal_requests where id = rid and status = 'approved' and admin_note = 'Looks good';
  if st = 'approved' and not changed and n = 1 then
    raise notice 'PASS A10: denying an approved request changes nothing';
  else raise notice 'FAIL A10: status=% changed=% intact=%', st, changed, n; end if;
end;
$$;

-- ============================================================
-- block 4: the vendor's weekly quota ignores the approved deal
-- ============================================================
do $$
declare
  req   uuid := '00000000-0000-0000-0000-0000000690a1';
  staff uuid := '00000000-0000-0000-0000-000000069005';
  left_ integer;
begin
  -- One send a week. The approved all-student deal from block 3 is inside the
  -- rolling week, so a quota that counted it would refuse this.
  select sends_left into left_
  from public.create_campaign(req, staff, 'Own deal', 'For my regulars', 'deal', 'top', 100, null, 5, 48, 1);
  if left_ = 0 then raise notice 'PASS Q1: an approved all-student deal does not use one of the vendor''s sends';
  else raise notice 'FAIL Q1: sends_left after the first own send was %, want 0', left_; end if;

  -- ...but the vendor's own sends still count.
  begin
    perform * from public.create_campaign(req, staff, 'Second', 'Again', 'deal', 'top', 100, null, 5, 48, 1);
    raise notice 'FAIL Q2: a second own send went through a one-a-week quota';
  exception when others then
    if sqlerrm like '%CAMPAIGN_QUOTA%' then raise notice 'PASS Q2: the vendor''s own sends still hit the quota';
    else raise notice 'FAIL Q2: wrong error: %', sqlerrm; end if;
  end;

  -- A vendor cannot reach 'all' by calling create_campaign directly.
  begin
    perform * from public.create_campaign(req, staff, 'Everyone', 'Hi', 'deal', 'all', 100, null, 5, 48, 99);
    raise notice 'FAIL Q3: create_campaign accepted audience ''all''';
  exception when others then
    if sqlerrm like '%CAMPAIGN_AUDIENCE_INVALID%' then raise notice 'PASS Q3: create_campaign still refuses audience ''all''';
    else raise notice 'FAIL Q3: wrong error: %', sqlerrm; end if;
  end;
end;
$$;

-- ============================================================
-- block 5: a spot switched off after asking cannot be approved
-- ============================================================
do $$
declare
  offspot uuid := '00000000-0000-0000-0000-0000000690a2';
  admin   uuid := '00000000-0000-0000-0000-0000000690ee';
  rid uuid;
  st  text;
  n integer;
begin
  -- Inserted directly: submit_deal_request refuses a switched-off spot, so this
  -- is the "switched off between the ask and the answer" case.
  insert into public.vendor_deal_requests (vendor_id, title, body, duration_hours)
  values (offspot, 'Late', 'Body', 72) returning id into rid;

  begin
    perform * from public.review_deal_request(rid, admin, true, null);
    raise notice 'FAIL S1: a switched-off spot''s request was approved';
  exception when others then
    if sqlerrm like '%VENDOR_UNAVAILABLE%' then raise notice 'PASS S1: a switched-off spot''s request cannot be approved';
    else raise notice 'FAIL S1: wrong error: %', sqlerrm; end if;
  end;

  select count(*) into n from public.vendor_campaigns where vendor_id = offspot;
  select status into st from public.vendor_deal_requests where id = rid;
  if n = 0 and st = 'pending' then raise notice 'PASS S2: the refused approval left no campaign and the request pending';
  else raise notice 'FAIL S2: campaigns=% status=%', n, st; end if;

  select out_status into st from public.review_deal_request(rid, admin, false, 'Spot is closed');
  if st = 'denied' then raise notice 'PASS S3: it can still be denied with a note';
  else raise notice 'FAIL S3: status=%', st; end if;
end;
$$;

-- ============================================================
-- block 6: the ordinary claim still applies every opt-out
-- ============================================================
do $$
declare
  s_push  uuid := '00000000-0000-0000-0000-000000069001';
  s_email uuid := '00000000-0000-0000-0000-000000069002';
  s_off   uuid := '00000000-0000-0000-0000-000000069003';
  s_supp  uuid := '00000000-0000-0000-0000-000000069004';
  s_staff uuid := '00000000-0000-0000-0000-000000069005';
  cid uuid;
  got uuid[];
  reach text;
  n integer;
begin
  select id into cid from public.vendor_campaigns where audience = 'all';
  -- Release it now rather than waiting out the hold, and start every budget empty.
  update public.campaign_recipients set deliver_after = now() - interval '1 minute' where campaign_id = cid;
  update public.student_notify_state
  set last_push_at = null, day_start = null, day_count = 0, week_start = null, week_count = 0;

  -- Mail off: push is the only transport, so only the student with an endpoint.
  select coalesce(array_agg(out_user_id order by out_user_id), '{}') into got
  from public.claim_campaign_pushes(p_max_users => 50, p_quiet_start => 0, p_quiet_end => 0, p_email_enabled => false);
  if got = array[s_push] then raise notice 'PASS C1: with email off, only the student with a push endpoint is claimed';
  else raise notice 'FAIL C1: claimed %', got; end if;

  -- Mail on. S_PUSH is now inside the four-hour cooldown from C1, which is the
  -- shared budget working, so this round is the email-only students.
  select coalesce(array_agg(out_user_id order by out_user_id), '{}') into got
  from public.claim_campaign_pushes(p_max_users => 50, p_quiet_start => 0, p_quiet_end => 0, p_email_enabled => true);
  if got = array[s_email, s_staff] then
    raise notice 'PASS C2: with email on, the reachable email students are claimed and the cooled-down one is not';
  else raise notice 'FAIL C2: claimed %, want % and %', got, s_email, s_staff; end if;

  if not (s_off = any(got)) then raise notice 'PASS C3: a student with Email alerts off is never claimed';
  else raise notice 'FAIL C3: the opted-out student was claimed'; end if;

  if not (s_supp = any(got)) then raise notice 'PASS C4: a suppressed address is never claimed';
  else raise notice 'FAIL C4: the suppressed student was claimed'; end if;

  -- Not claimed is not deleted: the deal stays in their in-app list.
  select count(*) into n from public.campaign_recipients
  where campaign_id = cid and user_id in (s_off, s_supp) and status = 'queued';
  if n = 2 then raise notice 'PASS C5: the opted-out students keep the deal in their in-app list';
  else raise notice 'FAIL C5: % of the 2 opted-out rows are still queued', n; end if;
end;
$$;
