-- ============================================================
-- Migration 006 — redemption codes: one live code per student
-- PER VENDOR (was: one per student globally). Starting a
-- redemption at vendor B no longer cancels a pending code at
-- vendor A. Codes stay globally unique (primary key) and remain
-- bound to one vendor + reward, resolving to the same student.
-- Run in the Supabase SQL Editor (safe to re-run).
-- ============================================================

create or replace function public.create_redeem_code(
  p_user_id uuid, p_vendor_id uuid, p_reward_id uuid, p_ttl_seconds integer default 120
) returns text
language plpgsql security definer set search_path = public
as $$
declare
  candidate text;
  attempts  integer := 0;
begin
  delete from redeem_codes where expires_at < now();        -- housekeeping
  -- one live code per student PER VENDOR: re-tapping Redeem at the same spot
  -- replaces that spot's code, but codes pending at other vendors survive
  delete from redeem_codes where user_id = p_user_id and vendor_id = p_vendor_id;

  loop
    attempts := attempts + 1;
    candidate := lpad((floor(random() * 10000))::int::text, 4, '0');
    begin
      insert into redeem_codes (code, user_id, vendor_id, reward_id, expires_at)
      values (candidate, p_user_id, p_vendor_id, p_reward_id, now() + make_interval(secs => p_ttl_seconds));
      return candidate;
    exception when unique_violation then
      if attempts > 500 then raise exception 'CODE_SPACE_EXHAUSTED'; end if;
    end;
  end loop;
end;
$$;
