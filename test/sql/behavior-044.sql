-- Assertions for migration-044 (point pools: the tables, before any behaviour).
--
-- 044 ships no RPC and changes no function body, so there is no earning or
-- spending to assert yet. What IS assertable is the whole reason the shape was
-- chosen, and every one of these would be a real incident if it were wrong:
--
--   1. The guard covers the new money table. A balance table without the 025
--      trigger is a table a leaked service key can rewrite.
--   2. anon holds nothing. Hosted projects grant anon full DML on every new
--      public table by default (pg_default_acl), so "we didn't grant it" is not
--      the same as "it isn't granted".
--   3. Nothing that already existed moved. Every vendor is unpooled, every
--      balance is where it was.
--   4. The FK delete rules, which are the difference between "you must empty a
--      pool before retiring it" and "deleting one branch silently zeroes a
--      chain's customers".
--
-- ORDER MATTERS IN THIS FILE. The guard assertions run FIRST, before anything
-- sets app.points_write, because set_config(..., false) is session-scoped and
-- would make the guard wave through every write for the rest of the file: a
-- test that passes by disabling the thing it is testing.

do $$
declare
  n integer;
begin
  -- ---------- 1. the 025 guard reaches the new tables ----------
  -- No RPC has run in this session, so the transaction-local flag is unset. This
  -- is exactly the shape of a pasted snippet or a leaked service-role key.
  begin
    insert into public.pool_balances (user_id, pool_id, balance)
    values ('00000000-0000-0000-0000-000000000441', gen_random_uuid(), 500);
    raise notice 'FAIL guard: a direct insert into pool_balances was allowed';
  exception when others then
    raise notice 'PASS guard: direct insert into pool_balances is blocked';
  end;

  begin
    insert into public.pool_moves (pool_id, vendor_id, user_id, kind, amount)
    values (gen_random_uuid(), null, null, 'join', 100);
    raise notice 'FAIL guard: a direct insert into pool_moves was allowed';
  exception when others then
    raise notice 'PASS guard: direct insert into pool_moves is blocked';
  end;

  select count(*) into n from pg_trigger
   where tgrelid = 'public.pool_balances'::regclass and not tgisinternal;
  if n = 2 then raise notice 'PASS guard: pool_balances carries both guard triggers';
  else raise notice 'FAIL guard: pool_balances has % triggers, expected 2', n; end if;

  select count(*) into n from pg_trigger
   where tgrelid = 'public.pool_moves'::regclass and not tgisinternal;
  if n = 2 then raise notice 'PASS guard: pool_moves carries both guard triggers';
  else raise notice 'FAIL guard: pool_moves has % triggers, expected 2', n; end if;

  -- ---------- 2. nothing is reachable with the public key ----------
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('point_pools', 'pool_balances', 'pool_moves')
     and grantee in ('anon', 'authenticated', 'PUBLIC');
  if n = 0 then raise notice 'PASS grants: anon/authenticated hold no privilege on the pool tables';
  else raise notice 'FAIL grants: % privilege grant(s) to anon/authenticated survive', n; end if;

  select count(*) into n from pg_tables
   where schemaname = 'public'
     and tablename in ('point_pools', 'pool_balances', 'pool_moves')
     and rowsecurity;
  if n = 3 then raise notice 'PASS grants: RLS is enabled on all three pool tables';
  else raise notice 'FAIL grants: RLS enabled on only % of 3 pool tables', n; end if;
end $$;

do $$
declare
  n   integer;
  bal integer;
  s1     uuid := '00000000-0000-0000-0000-000000000441';
  down   uuid := '00000000-0000-0000-0000-0000000004b1';
  campus uuid := '00000000-0000-0000-0000-0000000004b2';
  solo   uuid := '00000000-0000-0000-0000-0000000004b3';
  pool   uuid;
begin
  -- ---------- 3. the migration is inert ----------
  select count(*) into n from public.vendors where pool_id is not null;
  if n = 0 then raise notice 'PASS inert: every existing vendor is unpooled';
  else raise notice 'FAIL inert: % vendor(s) came out of the migration pooled', n; end if;

  select count(*) into n from public.pool_balances;
  if n = 0 then raise notice 'PASS inert: no shared balances exist yet';
  else raise notice 'FAIL inert: % pool_balances row(s) appeared from nowhere', n; end if;

  -- The pair the JOIN drain will later add to 420. It must still be two rows.
  select balance into bal from public.point_balances where user_id = s1 and vendor_id = down;
  if bal = 300 then raise notice 'PASS inert: the Downtown balance is untouched (300)';
  else raise notice 'FAIL inert: Downtown balance is %, expected 300', bal; end if;

  select balance into bal from public.point_balances where user_id = s1 and vendor_id = campus;
  if bal = 120 then raise notice 'PASS inert: the Campus balance is untouched (120)';
  else raise notice 'FAIL inert: Campus balance is %, expected 120', bal; end if;

  select count(*) into n from pg_indexes
   where tablename = 'point_balances' and indexname = 'idx_point_balances_vendor';
  if n = 1 then raise notice 'PASS inert: point_balances gained the by-vendor index the drain needs';
  else raise notice 'FAIL inert: idx_point_balances_vendor is missing'; end if;

  -- ---------- 4. the shape of a pool ----------
  -- From here on the session holds the write override, so the guard is out of
  -- the way and the CONSTRAINTS are what is under test.
  perform set_config('app.points_write', 'server', false);

  insert into public.point_pools (label) values ('Joes Pizza 044') returning id into pool;

  begin
    insert into public.pool_moves (pool_id, vendor_id, user_id, kind, amount)
    values (pool, down, s1, 'join', 0);
    raise notice 'FAIL moves: a zero-amount move was accepted';
  exception when check_violation then
    raise notice 'PASS moves: a zero-amount move is refused, so pool_leave must skip it';
  end;

  begin
    insert into public.pool_moves (pool_id, vendor_id, user_id, kind, amount)
    values (pool, down, s1, 'merge', 100);
    raise notice 'FAIL moves: an unknown kind was accepted';
  exception when check_violation then
    raise notice 'PASS moves: kind is limited to join/leave';
  end;

  insert into public.pool_balances (user_id, pool_id, balance) values (s1, pool, 420);

  begin
    update public.pool_balances set balance = -1 where user_id = s1 and pool_id = pool;
    raise notice 'FAIL purse: a shared balance went negative';
  exception when check_violation then
    raise notice 'PASS purse: a shared balance cannot go negative';
  end;
end $$;

-- ---------- 5. the delete rules ----------
-- Split into its own block so the pool created above is looked up by label
-- rather than threaded through a variable, and so a failure here cannot be
-- confused with a constraint failure above.
do $$
declare
  n    integer;
  bal  integer;
  s1   uuid := '00000000-0000-0000-0000-000000000441';
  down uuid := '00000000-0000-0000-0000-0000000004b1';
  solo uuid := '00000000-0000-0000-0000-0000000004b3';
  pool uuid;
begin
  perform set_config('app.points_write', 'server', false);
  select id into pool from public.point_pools where label = 'Joes Pizza 044';

  -- A pool holding money cannot be dropped: this is what forces retiring a pool
  -- to be a deliberate, emptying act rather than a DELETE that vanishes a
  -- chain's liability.
  begin
    delete from public.point_pools where id = pool;
    raise notice 'FAIL delete: a pool holding a balance was deleted';
  exception when foreign_key_violation then
    raise notice 'PASS delete: a pool holding a balance cannot be deleted';
  end;

  update public.vendors set pool_id = pool, pool_joined_at = now() where id = down;
  delete from public.pool_balances where user_id = s1 and pool_id = pool;
  begin
    delete from public.point_pools where id = pool;
    raise notice 'FAIL delete: a pool with a member still pointing at it was deleted';
  exception when foreign_key_violation then
    raise notice 'PASS delete: a pool with members cannot be deleted, even when empty';
  end;

  -- THE one that matters most. vendors -> point_balances is ON DELETE CASCADE,
  -- so if the shared purse were reachable from a vendors row, deleting one
  -- branch would silently zero the whole chain. Prove it is not reachable.
  insert into public.pool_balances (user_id, pool_id, balance) values (s1, pool, 420);
  insert into public.pool_moves (pool_id, vendor_id, user_id, kind, amount)
    values (pool, down, s1, 'join', 300);

  begin
    delete from public.vendors where id = solo;   -- an unrelated, unpooled vendor
    raise notice 'PASS delete: an unpooled vendor still deletes normally';
  exception when others then
    raise notice 'FAIL delete: deleting an unpooled vendor raised %', sqlerrm;
  end;

  select count(*) into n from public.pool_balances where pool_id = pool;
  if n = 1 then raise notice 'PASS delete: a vendor delete does not reach the shared purse';
  else raise notice 'FAIL delete: the shared purse lost rows to a vendor delete'; end if;

  -- The audit row outlives the location it describes (SET NULL, per 011/017).
  update public.vendors set pool_id = null, pool_joined_at = null where id = down;
  delete from public.vendors where id = down;
  select count(*) into n from public.pool_moves where pool_id = pool and vendor_id is null;
  if n = 1 then raise notice 'PASS delete: the audit row outlives its location, vendor_id nulled';
  else raise notice 'FAIL delete: expected 1 orphaned move row, found %', n; end if;

  select balance into bal from public.pool_balances where user_id = s1 and pool_id = pool;
  if bal = 420 then raise notice 'PASS delete: customer money survived the location being deleted';
  else raise notice 'FAIL delete: shared balance is % after a member was deleted, expected 420', bal; end if;
end $$;
