-- Assertions for migration-065 (NFC tag traffic).
--
-- The migration is one table, two views and one read-only function, and none
-- of it moves points — so what is asserted here is only what the DATABASE
-- promises the admin card, and each promise fails in a different direction:
--
--   1. THE WINDOWS ARE WINDOWS. taps / 30d / 7d / today each read a different
--      number from the same five rows, "today" being the campus day and not
--      the UTC one. Get one of them wrong and the card still draws, with a
--      figure that is quietly off by a window — the kind of bug nobody reports.
--      Block 1.
--   2. A SPOT NOBODY HAS TAPPED HAS NO ROW. The admin route starts from the
--      vendors table and left-joins the view, so this is the contract that
--      keeps a brand-new spot on the card reading 0 rather than vanishing.
--      Block 1.
--   3. AN UNMATCHED REF IS COUNTED, NOT LOST. 'irvngs' beside 'irvings' is the
--      whole reason the Unmatched list exists; a schema that dropped taps with
--      no vendor would hide exactly the tag the operator needs to rewrite.
--      Block 2.
--   4. THE TWO SERIES AGREE. The daily series and the hourly histogram are
--      drawn side by side, and the window cut on a day boundary is what makes
--      them sum to the same number. An unknown spot gets a full series of
--      zeros rather than an error, because the panel opens before the vendor
--      list has necessarily loaded. Block 3.
--   5. THE HISTORY SURVIVES THE SPOT. on delete set null keeps the rows and
--      moves them to the Unmatched list under the ref the tag still carries,
--      because the tag is still on a wall. Block 4.
--   6. NOTHING HERE IS REACHABLE WITH THE BROWSER KEY. Block 5.
--
-- The taps are written in block 1 rather than seeded: the harness runs the
-- seed BEFORE the migration under test, and nfc_taps does not exist until it
-- has run.
--
-- Clock: now() is the transaction timestamp, fixed for a whole DO block, so
-- the equality on last_tap below is exact rather than racy. The one tap that
-- has to be "today" in the campus zone is pinned to greatest(start of today,
-- two hours ago) so a run just after midnight in State College still passes.

-- ---- block 1: the rows, and the roll-up /admin reads ----
do $$
declare
  va   uuid := '00000000-0000-0000-0000-00000000065a';
  vb   uuid := '00000000-0000-0000-0000-00000000065b';
  s1   uuid := '00000000-0000-0000-0000-000000000651';
  -- Visitor hashes as the server mints them: a web tap hashes a cookie nonce,
  -- an app tap hashes 'u:' || the account id (src/lib/nfc-taps.js).
  h_a  text := repeat('a', 64);   -- one phone, tapped twice today
  h_b  text := repeat('b', 64);   -- a second phone, ten days ago
  h_c  text := repeat('c', 64);   -- a phone from last month
  h_u  text;
  -- Start of today in the campus zone, as a timestamptz.
  day0 timestamptz := (date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York');
  r    record;
  n    integer;
begin
  h_u := encode(sha256(convert_to('u:' || s1::text, 'UTF8')), 'hex');

  -- Vendor A: three web taps from two phones, one app tap yesterday, one tap
  -- forty days ago. Shaped so every window reads a different number:
  --   all time 5, 30 days 4, 7 days 3, today 2; app 1 of the 4; 3 visitors.
  insert into public.nfc_taps (vendor_id, ref, known, source, visitor_hash, user_id, user_agent, tapped_at) values
    (va, 'irvings-065', true, 'web', h_a, null, 'Mozilla/5.0 (iPhone)',         now()),
    (va, 'irvings-065', true, 'web', h_a, null, 'Mozilla/5.0 (iPhone)',         greatest(day0, now() - interval '2 hours')),
    (va, 'irvings-065', true, 'web', h_b, null, 'Mozilla/5.0 (Linux; Android)', now() - interval '10 days'),
    (va, 'irvings-065', true, 'app', h_u, s1,   'WeRewards/3 (iPhone)',         now() - interval '1 day'),
    (va, 'irvings-065', true, 'web', h_c, null, 'Mozilla/5.0 (iPhone)',         now() - interval '40 days');

  -- The bare campus tag, twice (one of them last month), and a tag somebody
  -- wrote with a typo in the slug.
  insert into public.nfc_taps (vendor_id, ref, known, source, visitor_hash, user_id, user_agent, tapped_at) values
    (null, 'generic', false, 'web', repeat('d', 64), null, 'Mozilla/5.0 (iPhone)', now()),
    (null, 'generic', false, 'web', repeat('e', 64), null, 'Mozilla/5.0 (iPhone)', now() - interval '40 days'),
    (null, 'irvngs',  false, 'web', h_a,             null, 'Mozilla/5.0 (iPhone)', now() - interval '3 days');
  raise notice 'PASS rows: 8 taps written (5 on vendor A, 2 generic, 1 unmatched)';

  select * into r from public.nfc_tap_overview where vendor_id = va;
  if not found then
    raise notice 'FAIL overview: no row for vendor A';
    return;
  end if;

  if r.taps = 5 then raise notice 'PASS overview: 5 taps all time';
  else raise notice 'FAIL overview: taps % (wanted 5)', r.taps; end if;

  if r.taps_30d = 4 then raise notice 'PASS overview: 4 taps in 30 days (the 40-day-old one is out)';
  else raise notice 'FAIL overview: taps_30d % (wanted 4)', r.taps_30d; end if;

  if r.taps_7d = 3 then raise notice 'PASS overview: 3 taps in 7 days (the 10-day-old one is out)';
  else raise notice 'FAIL overview: taps_7d % (wanted 3)', r.taps_7d; end if;

  -- The campus day, not the UTC one: the two taps pinned inside today's
  -- New York day count, yesterday's app tap does not.
  if r.taps_today = 2 then raise notice 'PASS overview: 2 taps today, counted in the campus day';
  else raise notice 'FAIL overview: taps_today % (wanted 2)', r.taps_today; end if;

  if r.app_taps_30d = 1 then raise notice 'PASS overview: 1 of the 30-day taps came from the app';
  else raise notice 'FAIL overview: app_taps_30d % (wanted 1)', r.app_taps_30d; end if;

  -- Two phones and one account: the phone that tapped twice is one visitor,
  -- and last month's phone is outside the window.
  if r.uniques_30d = 3 then raise notice 'PASS overview: 3 distinct visitors in 30 days (a repeat phone counts once)';
  else raise notice 'FAIL overview: uniques_30d % (wanted 3)', r.uniques_30d; end if;

  -- Exact, because now() is this transaction's timestamp and the newest row
  -- was written with it.
  if r.last_tap = now() then raise notice 'PASS overview: last_tap is the newest tap';
  else raise notice 'FAIL overview: last_tap % (wanted %)', r.last_tap, now(); end if;

  if r.first_tap = now() - interval '40 days' then raise notice 'PASS overview: first_tap is the oldest tap';
  else raise notice 'FAIL overview: first_tap % (wanted %)', r.first_tap, now() - interval '40 days'; end if;

  -- A spot nobody has tapped has no row. The admin route left-joins from the
  -- vendors table, so this is what keeps it reading 0 rather than vanishing.
  select count(*) into n from public.nfc_tap_overview where vendor_id = vb;
  if n = 0 then raise notice 'PASS overview: a spot with no taps has no row (the route left-joins it to 0)';
  else raise notice 'FAIL overview: vendor B has % rows', n; end if;

  -- And the generic and unmatched taps never leak into the per-spot roll-up.
  select count(*) into n from public.nfc_tap_overview where vendor_id is null;
  if n = 0 then raise notice 'PASS overview: taps with no vendor are not a row in the overview';
  else raise notice 'FAIL overview: % null-vendor rows in the overview', n; end if;
end $$;

-- ---- block 2: the refs that matched nothing ----
do $$
declare
  r record;
  n integer;
begin
  select * into r from public.nfc_tap_unmatched where ref = 'generic';
  if found and r.taps = 2 then raise notice 'PASS unmatched: the generic tag counts 2 taps';
  else raise notice 'FAIL unmatched: generic taps % (wanted 2)', r.taps; end if;

  if found and r.taps_30d = 1 then raise notice 'PASS unmatched: 1 of them in the last 30 days';
  else raise notice 'FAIL unmatched: generic taps_30d % (wanted 1)', r.taps_30d; end if;

  if found and r.last_tap >= now() - interval '1 minute' then raise notice 'PASS unmatched: generic last_tap is the newest';
  else raise notice 'FAIL unmatched: generic last_tap %', r.last_tap; end if;

  -- THE FINDING: a slug typed wrong when the tag was written is shown, with a
  -- count, under exactly what the tag carries.
  select * into r from public.nfc_tap_unmatched where ref = 'irvngs';
  if found and r.taps = 1 then raise notice 'PASS unmatched: the mistyped slug ''irvngs'' is listed with 1 tap';
  else raise notice 'FAIL unmatched: irvngs taps % (wanted 1)', r.taps; end if;

  -- A ref that resolved never appears here, however many times it was tapped.
  select count(*) into n from public.nfc_tap_unmatched where ref = 'irvings-065';
  if n = 0 then raise notice 'PASS unmatched: a matched ref is not in the unmatched list';
  else raise notice 'FAIL unmatched: the matched ref appeared % time(s)', n; end if;

  select count(*) into n from public.nfc_tap_unmatched;
  if n = 2 then raise notice 'PASS unmatched: exactly 2 refs (generic, irvngs)';
  else raise notice 'FAIL unmatched: % refs (wanted 2)', n; end if;
end $$;

-- ---- block 3: the Traffic panel's two series ----
do $$
declare
  va    uuid := '00000000-0000-0000-0000-00000000065a';
  d     jsonb;
  n     integer;
  today text := (now() at time zone 'America/New_York')::date::text;
begin
  d := public.nfc_tap_detail(va, 30);

  if d->>'vendor_id' = va::text and (d->>'days')::int = 30 and d->>'timezone' = 'America/New_York' then
    raise notice 'PASS detail: echoes vendor_id, days 30 and the campus timezone';
  else
    raise notice 'FAIL detail: header was % / % / %', d->>'vendor_id', d->>'days', d->>'timezone';
  end if;

  select jsonb_array_length(d->'daily') into n;
  if n = 30 then raise notice 'PASS detail: the daily series has one bucket per day, gaps included';
  else raise notice 'FAIL detail: daily series had % buckets (wanted 30)', n; end if;

  select jsonb_array_length(d->'hourly') into n;
  if n = 24 then raise notice 'PASS detail: the hour-of-day histogram has all 24 buckets';
  else raise notice 'FAIL detail: hourly series had % buckets (wanted 24)', n; end if;

  select sum((e->>'taps')::int) into n from jsonb_array_elements(d->'daily') e;
  if n = 4 then raise notice 'PASS detail: the daily series accounts for every tap in the window';
  else raise notice 'FAIL detail: daily series summed to % (wanted 4)', n; end if;

  -- The two series are cut on the same day boundary, so they always agree.
  select sum((e->>'taps')::int) into n from jsonb_array_elements(d->'hourly') e;
  if n = 4 then raise notice 'PASS detail: the hourly histogram sums to the same 4';
  else raise notice 'FAIL detail: hourly series summed to % (wanted 4)', n; end if;

  -- Oldest first, today last, and today's bucket holds today's two taps.
  if d->'daily'->29->>'day' = today and (d->'daily'->29->>'taps')::int = 2 then
    raise notice 'PASS detail: the last daily bucket is today (campus day) and reads 2';
  else
    raise notice 'FAIL detail: last bucket is % with % (wanted % with 2)',
      d->'daily'->29->>'day', d->'daily'->29->>'taps', today;
  end if;

  -- A clamped window, so a hand-typed ?days=99999 cannot ask for a series with
  -- a hundred thousand buckets in it, and 0 or null cannot ask for none.
  select jsonb_array_length(public.nfc_tap_detail(va, 99999)->'daily') into n;
  if n = 365 then raise notice 'PASS detail: an absurd day count is clamped to 365';
  else raise notice 'FAIL detail: days=99999 produced % buckets (wanted 365)', n; end if;

  select jsonb_array_length(public.nfc_tap_detail(va, 0)->'daily') into n;
  if n = 1 then raise notice 'PASS detail: days=0 is clamped up to 1';
  else raise notice 'FAIL detail: days=0 produced % buckets (wanted 1)', n; end if;

  select jsonb_array_length(public.nfc_tap_detail(va, null)->'daily') into n;
  if n = 30 then raise notice 'PASS detail: a null day count falls back to 30';
  else raise notice 'FAIL detail: days=null produced % buckets (wanted 30)', n; end if;

  -- Only this spot's taps: the generic and mistyped ones are not counted
  -- against it, and the 40-day-old one is outside the window.
  d := public.nfc_tap_detail(va, 365);
  select sum((e->>'taps')::int) into n from jsonb_array_elements(d->'daily') e;
  if n = 5 then raise notice 'PASS detail: a year-long window reaches the 40-day-old tap and nothing else';
  else raise notice 'FAIL detail: 365-day series summed to % (wanted 5)', n; end if;

  -- An unknown spot is a full series of zeros, never an error: the panel can
  -- open on a vendor id before the list that names it has loaded.
  d := public.nfc_tap_detail('00000000-0000-0000-0000-0000000006ff', 30);
  select sum((e->>'taps')::int) into n from jsonb_array_elements(d->'daily') e;
  if n = 0 and jsonb_array_length(d->'daily') = 30 and jsonb_array_length(d->'hourly') = 24 then
    raise notice 'PASS detail: an unknown vendor id returns 30 zero days and 24 zero hours, not an error';
  else
    raise notice 'FAIL detail: unknown vendor gave sum % over % days', n, jsonb_array_length(d->'daily');
  end if;
end $$;

-- ---- block 4: what the table refuses, and what survives a spot leaving ----
do $$
declare
  va uuid := '00000000-0000-0000-0000-00000000065a';
  vb uuid := '00000000-0000-0000-0000-00000000065b';
  r  record;
  n  integer;
begin
  -- The source is one of exactly two paths. A third would be a new column
  -- in the admin card, not a new value nobody reads.
  begin
    insert into public.nfc_taps (vendor_id, ref, known, source) values (va, 'irvings-065', true, 'sms');
    raise notice 'FAIL schema: an unknown source was accepted';
  exception when check_violation then
    raise notice 'PASS schema: a source other than web/app is refused';
  end;

  -- An empty ref is not a tag; the route writes 'generic' for the bare /t.
  begin
    insert into public.nfc_taps (vendor_id, ref, known, source) values (null, '  ', false, 'web');
    raise notice 'FAIL schema: a blank ref was accepted';
  exception when check_violation then
    raise notice 'PASS schema: a blank ref is refused';
  end;

  -- 64 covers a 60-character slug and a uuid; longer is a probe, not a tag.
  begin
    insert into public.nfc_taps (vendor_id, ref, known, source) values (null, repeat('x', 65), false, 'web');
    raise notice 'FAIL schema: a 65-character ref was accepted';
  exception when check_violation then
    raise notice 'PASS schema: a ref longer than 64 characters is refused';
  end;

  begin
    insert into public.nfc_taps (vendor_id, ref, known, source, user_agent) values (va, 'irvings-065', true, 'web', repeat('u', 501));
    raise notice 'FAIL schema: a 501-character user agent was accepted';
  exception when check_violation then
    raise notice 'PASS schema: a user agent longer than 500 characters is refused (the caller truncates)';
  end;

  -- A tap with no identity is traffic but not a visitor. Written AFTER block
  -- 1 measured the roll-up, so the counts there were not disturbed.
  insert into public.nfc_taps (vendor_id, ref, known, source, visitor_hash) values (va, 'irvings-065', true, 'web', null);
  select * into r from public.nfc_tap_overview where vendor_id = va;
  if r.taps_30d = 5 and r.uniques_30d = 3 then
    raise notice 'PASS schema: a tap with no visitor hash counts as traffic (5) but not as a visitor (still 3)';
  else
    raise notice 'FAIL schema: after a cookie-less tap taps_30d % / uniques_30d % (wanted 5 / 3)', r.taps_30d, r.uniques_30d;
  end if;

  -- ⚠ A SPOT LEAVES, AND ITS TAG IS STILL ON THE WALL. Cascade would erase the
  -- history and hide the taps that keep arriving; set null keeps both, and the
  -- Unmatched list is where the operator finds the tag that needs rewriting.
  insert into public.nfc_taps (vendor_id, ref, known, source, visitor_hash) values (vb, 'untapped-065', true, 'web', repeat('f', 64));
  select count(*) into n from public.nfc_tap_overview where vendor_id = vb;
  if n = 1 then raise notice 'PASS delete: vendor B appears in the overview after its first tap';
  else raise notice 'FAIL delete: vendor B has % overview rows after a tap (wanted 1)', n; end if;

  delete from public.vendors where id = vb;

  select * into r from public.nfc_taps where ref = 'untapped-065';
  if found and r.vendor_id is null and r.known then
    raise notice 'PASS delete: the deleted spot''s tap survives with a null vendor and known still true';
  else
    raise notice 'FAIL delete: the tap did not survive the spot being deleted as expected';
  end if;

  select count(*) into n from public.nfc_tap_overview where vendor_id = vb;
  if n = 0 then raise notice 'PASS delete: the deleted spot has left the overview';
  else raise notice 'FAIL delete: the deleted spot still has % overview rows', n; end if;

  select * into r from public.nfc_tap_unmatched where ref = 'untapped-065';
  if found and r.taps = 1 then
    raise notice 'PASS delete: its tag now shows in the unmatched list under the slug it still carries';
  else
    raise notice 'FAIL delete: the orphaned tap is not in the unmatched list';
  end if;
end $$;

-- ---- block 5: who may touch any of this ----
do $$
declare n integer;
begin
  -- Server-only, exactly like tracked_qr_scans and client_events: RLS on, no
  -- policies, and no privileges for the two roles a browser can reach.
  -- migration-037 exists because a default grant once exposed tables through
  -- the anon key, and that mistake recurs on every hosted project.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'nfc_taps';
  if n = 0 then raise notice 'PASS grants: no RLS policies on nfc_taps (server-only)';
  else raise notice 'FAIL grants: % policies on nfc_taps', n; end if;

  select count(*) into n from pg_class
   where relname = 'nfc_taps' and relrowsecurity;
  if n = 1 then raise notice 'PASS grants: row level security is enabled on nfc_taps';
  else raise notice 'FAIL grants: RLS is not enabled on nfc_taps'; end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('nfc_taps', 'nfc_tap_overview', 'nfc_tap_unmatched')
     and grantee in ('anon', 'authenticated');
  if n = 0 then raise notice 'PASS grants: anon and authenticated hold nothing on the table or either view';
  else raise notice 'FAIL grants: % browser-key privileges on the NFC objects', n; end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'nfc_taps'
     and grantee = 'service_role'
     and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE');
  if n = 4 then raise notice 'PASS grants: service_role can select, insert, update and delete nfc_taps';
  else raise notice 'FAIL grants: service_role holds % of the 4 DML privileges on nfc_taps', n; end if;

  if has_table_privilege('service_role', 'public.nfc_tap_overview', 'select')
     and has_table_privilege('service_role', 'public.nfc_tap_unmatched', 'select') then
    raise notice 'PASS grants: service_role can read both views';
  else raise notice 'FAIL grants: service_role cannot read one of the views'; end if;

  -- bigserial: without usage on the sequence the server's insert fails on
  -- nextval, which is the kind of grant that is only ever noticed in production.
  if has_sequence_privilege('service_role', 'public.nfc_taps_id_seq', 'usage')
     and not has_sequence_privilege('anon', 'public.nfc_taps_id_seq', 'usage') then
    raise notice 'PASS grants: service_role may use the id sequence and anon may not';
  else raise notice 'FAIL grants: the id sequence privileges are wrong'; end if;

  -- The detail function is a read /admin makes; a browser must not be able
  -- to make it directly. Checked by the exact identity the migration grants
  -- on, so a typo in that identity fails here rather than in the SQL editor.
  if not has_function_privilege('anon', 'public.nfc_tap_detail(uuid, integer, text)', 'execute')
     and not has_function_privilege('authenticated', 'public.nfc_tap_detail(uuid, integer, text)', 'execute') then
    raise notice 'PASS grants: nfc_tap_detail is not executable by anon or authenticated';
  else raise notice 'FAIL grants: nfc_tap_detail is reachable from a browser'; end if;

  if has_function_privilege('service_role', 'public.nfc_tap_detail(uuid, integer, text)', 'execute') then
    raise notice 'PASS grants: service_role can execute nfc_tap_detail';
  else raise notice 'FAIL grants: service_role cannot execute nfc_tap_detail'; end if;
end $$;
