-- migration-056 — make create_earn_code safe to run twice at once.
--
-- WHY THIS EXISTS. On 2026-09-12 at 20:07:06Z, POST /api/me/earn-code answered
-- 500 to a student. The Supabase gateway had returned 504 with the plain-text
-- body "Gateway Timeout" for the create_earn_code RPC; postgrest-js cannot
-- parse that as JSON, so it surfaced `{ message: "Gateway Timeout" }`, the route
-- threw it, and the central handler logged a server fault for what was somebody
-- else's outage. src/lib/supabase.js now retries that call — but a retry is only
-- correct if the function can run twice AT ONCE, and this one could not:
--
--   * A 504 means the GATEWAY stopped waiting. Postgres may still be executing
--     the first attempt when the retry arrives 200ms later.
--   * Both attempts then run `select ... where expires_at > now()`, both find no
--     live code, and both insert one. The student now holds TWO live earn codes,
--     and because the select is `limit 1` with no ORDER BY, the 2-minute refresh
--     can hand back either of them — the digits on screen change while the
--     cashier is typing them.
--   * That race is already reachable today without any retry: two fast taps, or
--     a silent token refresh re-entering render() while a refresh is in flight.
--
-- THREE CHANGES, AND THE THIRD IS THE ONE THAT MIGHT HAVE CAUSED THE 504:
--
--   1. pg_advisory_xact_lock(p_user_id) — one student's calls are serialised, so
--      the second caller waits, sees the first one's code, and returns it.
--      Transaction-scoped, so it is released when the RPC's implicit transaction
--      ends; there is nothing to unlock and no path that can leak it.
--
--   2. `order by expires_at desc` on the live-code read — deterministic even if
--      a pair of duplicates from before this migration is still in the table.
--
--   3. The housekeeping DELETE no longer scans the whole table. It used to be
--      `delete from earn_codes where expires_at < now()` on EVERY call: with no
--      index on expires_at that is a sequential scan, and it takes row locks on
--      every other student's expired rows. Two students refreshing at the same
--      moment therefore blocked on each other for no reason, and a service_role
--      connection has NO statement_timeout on Supabase, so a blocked write waits
--      until the gateway gives up — which is exactly a 504 with no Postgres
--      error to show for it. Now: this student's own rows unconditionally, plus a
--      bounded global sweep that SKIPS LOCKED rows, so housekeeping can never be
--      what makes a student wait.
--
-- Nothing about the codes themselves changes: same 6 digits, same TTL, same
-- stability across refreshes, same CODE_SPACE_EXHAUSTED after 500 collisions.

begin;

-- The sweep in (3) reads expires_at for every student. Without this it is a
-- sequential scan of the table on every earn-code refresh in the app.
create index if not exists idx_earn_codes_expires on public.earn_codes (expires_at);

create or replace function public.create_earn_code(p_user_id uuid, p_ttl_seconds integer default 300)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  candidate text;
  attempts  integer := 0;
begin
  -- ONE STUDENT AT A TIME. Keyed on the user id, so two students never wait on
  -- each other; two calls for the SAME student queue, and the loser of the race
  -- finds the winner's code below instead of minting a second one.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  -- This student's own expired rows. Cheap (idx_earn_codes_user), and it can
  -- only ever block another call for this same student, which the lock above
  -- has already serialised.
  delete from earn_codes
  where user_id = p_user_id and expires_at < now();

  -- Everybody else's, bounded and non-blocking. FOR UPDATE SKIP LOCKED is what
  -- makes this unable to stall the caller: a row another session is already
  -- deleting is left for that session instead of being waited on. The limit
  -- keeps the work per call constant no matter how much has piled up.
  delete from earn_codes
  where code in (
    select code from earn_codes
    where expires_at < now()
    order by expires_at
    limit 200
    for update skip locked
  );

  -- Reuse the student's live code so it is stable across the app's ~2-min
  -- refresh. ORDER BY is load-bearing: a pair of duplicates minted before this
  -- migration would otherwise be returned in an arbitrary order, so the code on
  -- screen could alternate between two values.
  select code into candidate
  from earn_codes
  where user_id = p_user_id and expires_at > now()
  order by expires_at desc
  limit 1;
  if candidate is not null then
    update earn_codes
    set expires_at = now() + make_interval(secs => p_ttl_seconds)
    where code = candidate;
    return candidate;
  end if;

  loop
    attempts := attempts + 1;
    candidate := lpad((floor(random() * 1000000))::int::text, 6, '0');
    begin
      insert into earn_codes (code, user_id, expires_at)
      values (candidate, p_user_id, now() + make_interval(secs => p_ttl_seconds));
      return candidate;
    exception when unique_violation then
      if attempts > 500 then raise exception 'CODE_SPACE_EXHAUSTED'; end if;
    end;
  end loop;
end;
$$;

-- Unchanged from migration-014, restated because create-or-replace keeps the old
-- ACL and a future reader should not have to go two files back to see it.
revoke execute on function public.create_earn_code(uuid, integer) from public, anon, authenticated;
grant  execute on function public.create_earn_code(uuid, integer) to service_role;

comment on function public.create_earn_code(uuid, integer) is
  'The 6-digit code a student shows at the counter. Idempotent per student (advisory-locked), so it is safe for src/lib/supabase.js to retry on a gateway error.';

commit;
