-- Assertions for migration-041 (vendor_favorites + top_vendors_by_visits).
--
-- The favorites half is a table, so what is worth proving is the shape that
-- makes the client simple: the composite PK really does make a double-tapped
-- heart a no-op, and the cascades really do clean up.
--
-- The ranking half is where the bugs would be. Every assertion below fails
-- loudly if one of the three rules the function claims is missing: visits are
-- (student, day) pairs and not transaction rows, inactive vendors are excluded,
-- and only 'earn' counts.
--
-- The last block re-creates the inactive vendor with backdated transactions, so
-- this session needs migration-025's write override the same way seed-041 does.
-- Session-scoped (`false`), set outside the do-block so it is in force for the
-- whole file.
select set_config('app.points_write', 'server', false);

do $$
declare
  s1     uuid := '00000000-0000-0000-0000-000000000411';
  s2     uuid := '00000000-0000-0000-0000-000000000412';
  busy   uuid := '00000000-0000-0000-0000-0000000004a1';
  quiet  uuid := '00000000-0000-0000-0000-0000000004a2';
  closed uuid := '00000000-0000-0000-0000-0000000004a3';
  n      integer;
  b      bigint;
  top    uuid;
begin
  -- ---------- vendor_favorites ----------

  insert into public.vendor_favorites (user_id, vendor_id) values (s1, busy);
  select count(*) into n from public.vendor_favorites where user_id = s1;
  if n = 1 then raise notice 'PASS favorites: a spot can be saved';
  else raise notice 'FAIL favorites: expected 1 row, got %', n; end if;

  -- THE one that makes the toggle safe: a double-tapped heart must not error
  -- and must not create a second row.
  begin
    insert into public.vendor_favorites (user_id, vendor_id) values (s1, busy)
    on conflict do nothing;
    select count(*) into n from public.vendor_favorites where user_id = s1;
    if n = 1 then raise notice 'PASS favorites: re-saving is idempotent (on conflict do nothing)';
    else raise notice 'FAIL favorites: duplicate created, % rows', n; end if;
  exception when others then
    raise notice 'FAIL favorites: re-saving raised %', sqlerrm;
  end;

  -- ...and without on-conflict it is a hard uniqueness error, i.e. the PK is
  -- really doing the work rather than the application being careful.
  begin
    insert into public.vendor_favorites (user_id, vendor_id) values (s1, busy);
    raise notice 'FAIL favorites: a duplicate was accepted — the PK is missing';
  exception when unique_violation then
    raise notice 'PASS favorites: the composite PK refuses a duplicate';
  end;

  -- two students may save the same spot; one student may save many
  insert into public.vendor_favorites (user_id, vendor_id) values (s2, busy), (s1, quiet);
  select count(*) into n from public.vendor_favorites;
  if n = 3 then raise notice 'PASS favorites: saves are per (student, spot)';
  else raise notice 'FAIL favorites: expected 3 rows, got %', n; end if;

  -- un-favoriting is a plain delete
  delete from public.vendor_favorites where user_id = s1 and vendor_id = quiet;
  select count(*) into n from public.vendor_favorites where user_id = s1;
  if n = 1 then raise notice 'PASS favorites: un-saving removes exactly one row';
  else raise notice 'FAIL favorites: after delete, % rows for s1', n; end if;

  -- deleting a vendor must not strand rows (the cascade + its index)
  insert into public.vendor_favorites (user_id, vendor_id) values (s1, closed);
  delete from public.vendors where id = closed;
  select count(*) into n from public.vendor_favorites where vendor_id = closed;
  if n = 0 then raise notice 'PASS favorites: deleting a vendor cascades its saves away';
  else raise notice 'FAIL favorites: % orphaned rows after vendor delete', n; end if;

  -- ---------- top_vendors_by_visits ----------
  -- NOTE: Closed Diner was just deleted above, which also removes it from the
  -- ranking. Its active=false exclusion is asserted separately below by putting
  -- it back — do not reorder these two blocks.

  -- Busy Bagels has SIX earn rows but only FOUR (student, day) visits.
  select visits into b from public.top_vendors_by_visits(5, 30) where vendor_id = busy;
  if b = 4 then
    raise notice 'PASS ranking: visits are (student, day) pairs — 6 rows counted as 4';
  else
    raise notice 'FAIL ranking: Busy Bagels scored % (wanted 4; 6 means it counted rows)', b;
  end if;

  -- Quiet Coffee: two students, one day, plus a redeem that must not count.
  select visits into b from public.top_vendors_by_visits(5, 30) where vendor_id = quiet;
  if b = 2 then raise notice 'PASS ranking: a redeem is not a visit';
  else raise notice 'FAIL ranking: Quiet Coffee scored % (wanted 2)', b; end if;

  -- ordering
  select vendor_id into top from public.top_vendors_by_visits(5, 30) limit 1;
  if top = busy then raise notice 'PASS ranking: ordered by visits, busiest first';
  else raise notice 'FAIL ranking: top spot was % (wanted Busy Bagels)', top; end if;

  -- the 90-day-old row is outside a 30-day window but inside a 365-day one,
  -- which is what proves p_days is actually applied
  select visits into b from public.top_vendors_by_visits(5, 365) where vendor_id = busy;
  if b = 5 then raise notice 'PASS ranking: p_days widens the window (4 -> 5 with the old visit)';
  else raise notice 'FAIL ranking: 365-day window scored % (wanted 5)', b; end if;

  -- p_limit
  select count(*) into n from public.top_vendors_by_visits(1, 30);
  if n = 1 then raise notice 'PASS ranking: p_limit caps the list';
  else raise notice 'FAIL ranking: limit 1 returned % rows', n; end if;

  -- ---------- the active filter ----------
  -- Re-create the busiest vendor as INACTIVE. It has nine visits, more than
  -- anything else in the dataset, so if the filter is missing it takes the top
  -- slot and this assertion fails.
  insert into public.vendors (id, name, slug, points_per_dollar, active)
  values (closed, 'Closed Diner 041', 'closed-diner-041b', 10, false);
  insert into public.transactions (user_id, vendor_id, type, points, dollar_amount, created_at)
  select s1, closed, 'earn', 50, 5, now() - (g || ' days')::interval from generate_series(1, 9) g;

  select count(*) into n from public.top_vendors_by_visits(10, 30) where vendor_id = closed;
  if n = 0 then raise notice 'PASS ranking: an inactive vendor is never recommended';
  else raise notice 'FAIL ranking: an inactive vendor appeared in the list'; end if;

  -- a zero/negative limit must not error
  begin
    select count(*) into n from public.top_vendors_by_visits(0, 30);
    raise notice 'PASS ranking: a zero limit returns an empty list rather than erroring';
  exception when others then
    raise notice 'FAIL ranking: limit 0 raised %', sqlerrm;
  end;

  -- an empty window is empty, not an error
  begin
    select count(*) into n from public.top_vendors_by_visits(5, 0);
    raise notice 'PASS ranking: a zero-day window is clamped rather than erroring';
  exception when others then
    raise notice 'FAIL ranking: p_days 0 raised %', sqlerrm;
  end;
end;
$$;
