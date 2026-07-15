-- ============================================================
-- Migration 014 — earn codes: 6 NUMERIC digits (was: 6-char A–Z0–9).
--   The identity code the student shows to earn points is now six digits
--   (000000–999999, zero-padded) instead of a letter/digit mix. Easier to
--   read aloud and key in on the vendor terminal. Still unique among all live
--   codes and reuses the student's live code across the app's periodic refresh.
--   Backend validation (/^[0-9]{6}$/) and the terminal keypad are updated to
--   match.
-- Run in the Supabase SQL Editor after migration-013 (safe to re-run).
-- ============================================================

create or replace function public.create_earn_code(p_user_id uuid, p_ttl_seconds integer default 300)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  candidate text;
  attempts  integer := 0;
begin
  delete from earn_codes where expires_at < now();          -- housekeeping

  -- reuse the student's live code so it's stable across the app's ~2-min refresh
  select code into candidate
  from earn_codes
  where user_id = p_user_id and expires_at > now()
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

revoke execute on function public.create_earn_code(uuid, integer) from public, anon, authenticated;
grant  execute on function public.create_earn_code(uuid, integer) to service_role;
