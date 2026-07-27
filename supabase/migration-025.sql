-- ============================================================
-- Migration 025 — DB-level points lockdown.
--   point_balances and transactions are the money tables. Until now nothing in
--   the DATABASE stopped a write from outside the app's RPCs: the Supabase
--   Studio table editor (which connects as the table owner, so neither RLS nor
--   grants apply), an ad-hoc UPDATE in the SQL editor, or a leaked service-role
--   key could all silently mint, burn, or rewrite points with no audit trail.
--
--   THREAT MODEL: accidental or casual direct edits — an operator "fixing" a
--   balance in the table editor, a pasted snippet run against the wrong
--   project, service-role code that bypasses the RPCs. NOT defended against: a
--   project owner who deliberately disarms the guard (drop the triggers, or
--   set the app.points_write GUC before editing) — the owner can always do
--   that, and no in-database mechanism can stop them. The guard's job is to
--   make points edits impossible through the Studio table editor and casual
--   SQL, and to make any bypass a DELIBERATE, auditable act instead of a
--   two-click table edit.
--
--   DESIGN
--   1. enforce_points_write_guard(): a trigger function that rejects any
--      INSERT/UPDATE/DELETE row (and any TRUNCATE) on the two tables unless
--        a) the transaction-local GUC app.points_write = 'server' — every
--           legitimate RPC sets it as its first statement (set_config(...,
--           true) is transaction-local, so it evaporates at commit and can
--           never leak across PostgREST's per-request transactions), or
--        b) the write is FK-driven (pg_trigger_depth() > 1): referential
--           actions run inside the referenced table's internal RI trigger, so
--           user triggers they fire nest one level deeper than direct DML.
--           This keeps entity deletion working (see the cascade audit below)
--           while direct DML on the two tables — depth 1 — is still blocked.
--   2. BEFORE row triggers + BEFORE TRUNCATE statement triggers on both tables.
--   3. The four legitimate mutators are recreated VERBATIM from their latest
--      versions, each gaining only the set_config() first line:
--        award_points          (latest: migration-019 — keeps client_token
--                               idempotency and the revisit bump)
--        redeem_by_code        (latest: migration-003; 007 only re-granted it)
--        reverse_transaction   (latest: migration-010)
--        prune_unconsented_signups (latest: migration-023 — deletes auth.users;
--                               a profile cascade would cascade-delete
--                               point_balances rows, so it sets the flag too,
--                               belt-and-braces on top of the depth escape)
--   4. Belt-and-braces grants: INSERT/UPDATE/DELETE on both tables revoked from
--      anon, authenticated AND service_role. The server only ever SELECTs these
--      tables directly (verified — every mutation goes through .rpc), and the
--      RPCs are SECURITY DEFINER running as the table owner, so they are
--      unaffected. SELECT grants and the existing RLS select policies are NOT
--      touched — students still read their balances/history through them.
--
--   CASCADE / WRITER AUDIT (why the depth escape exists)
--     • profiles  ON DELETE CASCADE → point_balances (schema.sql). Reached by
--       auth.admin.deleteUser() — POST /api/me/delete and /api/me/decline
--       (src/routes/student.js) — and by prune_unconsented_signups(). GoTrue
--       deletes auth.users in its own connection and cannot set our GUC; the
--       depth escape is what lets student account deletion keep working.
--     • vendors   ON DELETE CASCADE → point_balances, and (migration-017)
--       transactions.vendor_id / reward_id FKs ON DELETE SET NULL → UPDATEs on
--       transactions. Reached by DELETE /api/admin/vendors/:id
--       (src/routes/admin.js), which deletes the vendors row via PostgREST —
--       again no place to set the GUC, so the depth escape carries it.
--     • transactions.user_id FK ON DELETE SET NULL (migration-011) → UPDATE on
--       transactions when a profile dies. Same deletion paths as above.
--     • Historical function bodies in schema.sql / migrations 002/004/005 also
--       wrote these tables, but every one of them is superseded: redeem_reward
--       was dropped in migration-007 and award_points' old 4-arg overload was
--       dropped in migration-019. Nothing to patch.
--     ⚠ Consequence of the trades above: deleting a vendors / profiles /
--       rewards ROW (Studio or SQL) still cascades into the points tables —
--       that is entity deletion, the documented hard-delete semantics, not
--       points falsification, and it cannot be blocked here without breaking
--       the app's own deletion endpoints.
--
--   ⚠ ORDERING FOOTGUN: several older files recreate one of the four guarded
--   functions WITHOUT the guard flag — award_points (schema.sql, 004, 005, 019),
--   redeem_by_code (003), reverse_transaction (010), prune_unconsented_signups
--   (023). If you ever re-run any of them, that function's unflagged body will be
--   rejected by the triggers at runtime (awards/redeems/reversals/the nightly
--   prune start failing with the guard error) — re-run THIS file afterwards to
--   restore the flagged bodies.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-024 (safe to re-run; triggers are drop-and-recreate, functions
--   are create-or-replace). Do not schedule anything — the pg_cron jobs from
--   migrations 021/023 call these functions by name and pick up the new bodies
--   automatically.
-- ============================================================

-- ---------- 1. THE GUARD ----------

create or replace function public.enforce_points_write_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- a) A legitimate RPC announced itself (transaction-local flag).
  if current_setting('app.points_write', true) = 'server' then
    if tg_op = 'DELETE' then
      return old;
    elsif tg_op = 'TRUNCATE' then
      return null;                        -- statement-level: return ignored
    else
      return new;                         -- INSERT / UPDATE
    end if;
  end if;

  -- b) FK-driven write (cascade delete from profiles/vendors, SET NULL from
  --    migrations 011/017): fired from inside a referential-integrity trigger,
  --    so we are nested one level deeper than direct DML would be. TRUNCATE
  --    gets no escape — it is never a legitimate operation on these tables.
  if tg_op <> 'TRUNCATE' and pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then
      return old;
    else
      return new;
    end if;
  end if;

  raise exception 'points are terminal-managed: direct % on % is blocked; use the app RPCs',
    lower(tg_op), tg_table_name
    using hint = 'Balances and transactions only change through the server RPCs '
                 '(award_points, redeem_by_code, reverse_transaction). '
                 'See supabase/migration-025.sql for why and for the deliberate override.';
end;
$$;

-- Trigger functions cannot be called directly, but restate the lockdown anyway.
revoke execute on function public.enforce_points_write_guard() from public, anon, authenticated;

-- ---------- 2. TRIGGERS ON BOTH TABLES ----------

drop trigger if exists trg_points_guard_row on public.point_balances;
create trigger trg_points_guard_row
  before insert or update or delete on public.point_balances
  for each row execute function public.enforce_points_write_guard();

drop trigger if exists trg_points_guard_truncate on public.point_balances;
create trigger trg_points_guard_truncate
  before truncate on public.point_balances
  for each statement execute function public.enforce_points_write_guard();

drop trigger if exists trg_points_guard_row on public.transactions;
create trigger trg_points_guard_row
  before insert or update or delete on public.transactions
  for each row execute function public.enforce_points_write_guard();

drop trigger if exists trg_points_guard_truncate on public.transactions;
create trigger trg_points_guard_truncate
  before truncate on public.transactions
  for each statement execute function public.enforce_points_write_guard();

-- ---------- 3a. award_points — verbatim migration-019 body + guard flag ----------

create or replace function public.award_points(
  p_user_id       uuid,
  p_vendor_id     uuid,
  p_points        integer,
  p_dollar_amount numeric default null,
  p_client_token  text default null
)
returns table (new_balance integer)
language plpgsql security definer set search_path = public
as $$
declare
  visited_before boolean;
  visited_today  boolean;
begin
  -- Announce a legitimate points write to the migration-025 guard triggers.
  -- Transaction-local (third arg true): evaporates when this call's
  -- transaction commits, so it can never leak into another request.
  perform set_config('app.points_write', 'server', true);

  if p_points <= 0 then
    raise exception 'POINTS_INVALID';
  end if;

  -- Idempotency: a retry of an already-recorded award (same token, same vendor)
  -- returns the current balance and stops here — BEFORE any side effect
  -- (revisit bump / balance / transaction insert), so nothing is applied twice.
  if p_client_token is not null then
    if exists (
      select 1 from transactions
      where vendor_id = p_vendor_id and client_token = p_client_token
    ) then
      return query
        select coalesce((select balance from point_balances
                         where user_id = p_user_id and vendor_id = p_vendor_id), 0);
      return;
    end if;
  end if;

  -- Revisit check must happen BEFORE this award's transaction is inserted,
  -- so today's earn can't count itself as the "earlier" visit. (migration-005)
  select
    exists (select 1 from transactions t
            where t.user_id = p_user_id and t.vendor_id = p_vendor_id
              and t.type = 'earn' and t.created_at::date < current_date),
    exists (select 1 from transactions t
            where t.user_id = p_user_id and t.vendor_id = p_vendor_id
              and t.type = 'earn' and t.created_at::date = current_date)
  into visited_before, visited_today;

  if visited_before and not visited_today then
    update profiles set revisits = revisits + 1 where user_id = p_user_id;
  end if;

  insert into point_balances (user_id, vendor_id, balance)
  values (p_user_id, p_vendor_id, p_points)
  on conflict (user_id, vendor_id)
  do update set balance = point_balances.balance + p_points, updated_at = now();

  -- The unique index on (vendor_id, client_token) is the hard backstop: a
  -- concurrent duplicate that slips past the exists() check raises here and the
  -- whole atomic call rolls back, so the balance bump above never sticks twice.
  insert into transactions (user_id, vendor_id, type, points, dollar_amount, client_token)
  values (p_user_id, p_vendor_id, 'earn', p_points, p_dollar_amount, p_client_token);

  return query
    select balance from point_balances
    where user_id = p_user_id and vendor_id = p_vendor_id;
end;
$$;

revoke execute on function public.award_points(uuid, uuid, integer, numeric, text) from public, anon, authenticated;
grant  execute on function public.award_points(uuid, uuid, integer, numeric, text) to service_role;

-- ---------- 3b. redeem_by_code — verbatim migration-003 body + guard flag ----------

create or replace function public.redeem_by_code(p_code text, p_vendor_id uuid)
returns table (new_balance integer, reward_title text)
language plpgsql security definer set search_path = public
as $$
declare
  c_user_id   uuid;
  c_reward_id uuid;
  r_cost      integer;
  r_title     text;
begin
  -- Announce a legitimate points write to the migration-025 guard triggers.
  perform set_config('app.points_write', 'server', true);

  delete from redeem_codes
  where code = p_code and vendor_id = p_vendor_id and expires_at > now()
  returning user_id, reward_id into c_user_id, c_reward_id;

  if c_user_id is null then
    raise exception 'CODE_INVALID';
  end if;

  select cost_in_points, title into r_cost, r_title
  from rewards
  where id = c_reward_id and vendor_id = p_vendor_id and active = true;

  if r_cost is null then
    raise exception 'REWARD_NOT_FOUND';
  end if;

  update point_balances
  set balance = balance - r_cost, updated_at = now()
  where user_id = c_user_id and vendor_id = p_vendor_id and balance >= r_cost;

  if not found then
    raise exception 'INSUFFICIENT_POINTS';
  end if;

  insert into transactions (user_id, vendor_id, type, points, reward_id)
  values (c_user_id, p_vendor_id, 'redeem', -r_cost, c_reward_id);

  return query
    select pb.balance, r_title
    from point_balances pb
    where pb.user_id = c_user_id and pb.vendor_id = p_vendor_id;
end;
$$;

revoke execute on function public.redeem_by_code(text, uuid) from public, anon, authenticated;
grant  execute on function public.redeem_by_code(text, uuid) to service_role;

-- ---------- 3c. reverse_transaction — verbatim migration-010 body + guard flag ----------

create or replace function public.reverse_transaction(
  p_transaction_id uuid,
  p_vendor_id      uuid
)
returns table (affected_user uuid, new_balance integer, reversed_type text, reversed_points integer)
language plpgsql security definer set search_path = public
as $$
declare
  orig        transactions%rowtype;
  comp_points integer;
  comp_dollar numeric;
  comp_id     uuid;
  new_bal     integer;
begin
  -- Announce a legitimate points write to the migration-025 guard triggers.
  perform set_config('app.points_write', 'server', true);

  -- Lock the original row so two concurrent taps can't both pass the
  -- already-reversed check and post two compensating rows.
  select * into orig
  from transactions
  where id = p_transaction_id and vendor_id = p_vendor_id
  for update;

  if orig.id is null then
    raise exception 'TX_NOT_FOUND';
  end if;
  if orig.reverses is not null then
    raise exception 'CANNOT_REVERSE_REVERSAL';   -- a reversal itself can't be reversed
  end if;
  if orig.reversed_by is not null then
    raise exception 'ALREADY_REVERSED';
  end if;
  -- Anti-abuse: undo is only allowed within 1 minute of the transaction, so a
  -- vendor can fix an immediate mistake but can't quietly claw points back from a
  -- customer later. Enforced HERE (not just in the terminal UI) because the vendor
  -- controls the client and could otherwise call this RPC directly.
  if now() - orig.created_at > interval '1 minute' then
    raise exception 'REVERSAL_EXPIRED';
  end if;

  -- Negate every numeric column: an +earn becomes a -correction, a -redeem
  -- refunds the points. Signed sums in the analytics rollup then net to zero.
  comp_points := -orig.points;
  comp_dollar := case when orig.dollar_amount is null then null else -orig.dollar_amount end;

  update point_balances
  set balance = greatest(0, balance + comp_points), updated_at = now()
  where user_id = orig.user_id and vendor_id = orig.vendor_id
  returning balance into new_bal;

  if not found then
    -- No balance row yet (shouldn't happen for a real earn/redeem, but be safe).
    insert into point_balances (user_id, vendor_id, balance)
    values (orig.user_id, orig.vendor_id, greatest(0, comp_points))
    returning balance into new_bal;
  end if;

  insert into transactions (user_id, vendor_id, type, points, dollar_amount, reward_id, reverses)
  values (orig.user_id, orig.vendor_id, orig.type, comp_points, comp_dollar, orig.reward_id, orig.id)
  returning id into comp_id;

  update transactions set reversed_by = comp_id where id = orig.id;

  return query select orig.user_id, new_bal, orig.type, orig.points;
end;
$$;

revoke execute on function public.reverse_transaction(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.reverse_transaction(uuid, uuid) to service_role;

-- ---------- 3d. prune_unconsented_signups — verbatim migration-023 body + guard flag ----------
-- Deletes auth.users rows. A row with a profile would cascade profiles →
-- point_balances (delete) and SET NULL transactions.user_id — in practice its
-- WHERE clause excludes anyone with a profile, but the flag makes the function
-- correct even if that ever changes. The pg_cron job from migration-023 calls
-- this by name and needs no rescheduling.

create or replace function public.prune_unconsented_signups(
  p_grace_hours   integer default 24,
  p_exempt_emails text[] default '{}'
)
returns integer
language plpgsql security definer set search_path = public, auth
as $$
declare
  n integer;
  exempt text[] := array(select lower(trim(e)) from unnest(coalesce(p_exempt_emails, '{}')) e where trim(e) <> '');
begin
  -- Announce a legitimate points write to the migration-025 guard triggers
  -- (cascades from auth.users can reach point_balances / transactions).
  perform set_config('app.points_write', 'server', true);

  delete from auth.users u
  where u.created_at < now() - make_interval(hours => greatest(p_grace_hours, 1))
    -- Never touch a student who completed the consent flow.
    and not exists (select 1 from public.profiles p where p.user_id = u.id)
    -- Never touch a vendor login.
    and not exists (select 1 from public.vendor_staff vs where vs.user_id = u.id)
    -- Never touch anyone with consent on record, even if their profile is gone.
    and not exists (select 1 from public.terms_acceptances ta where ta.user_id = u.id)
    -- Never touch an explicitly exempted address (operators/admins).
    and lower(coalesce(u.email, '')) <> all (exempt);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.prune_unconsented_signups(integer, text[]) from public, anon, authenticated;
grant  execute on function public.prune_unconsented_signups(integer, text[]) to service_role;

-- ---------- 4. BELT-AND-BRACES TABLE GRANTS ----------
-- Even with a service-role key, PostgREST can no longer write these tables
-- directly — only the RPCs can (SECURITY DEFINER, owner-run, so unaffected).
-- SELECT stays: the server reads balances/transactions directly, and students
-- read their own rows through the existing RLS select policies (untouched).
-- FK cascades are also unaffected: referential actions run with the table
-- owner's privileges, not the caller's.

revoke insert, update, delete on public.point_balances from anon, authenticated, service_role;
revoke insert, update, delete on public.transactions   from anon, authenticated, service_role;
