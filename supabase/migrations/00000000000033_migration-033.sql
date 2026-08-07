-- ============================================================
-- Migration 033 — refund a student's push quota when NOTHING was delivered.
--
--   WHY THIS EXISTS
--   claim_campaign_pushes() spends the student's quota at claim time, before
--   the worker has spoken to any push service: last_push_at = now(),
--   day_count + 1, week_count + 1 (migration-032, section 7). That ordering is
--   correct — it is what makes the claim atomic under the row lock and stops
--   two dynos double-notifying the same student.
--
--   finish_campaign_batch(p_ok => false) then returns the recipient rows to the
--   queue but leaves that spend in place. Migration-032 justified the asymmetry
--   like this: a refund is a way to double-notify, and "the only common cause of
--   total failure is every endpoint being dead — in which case the 404/410 prune
--   in src/lib/push.js removes them and the student stops being claimed at all."
--
--   That assumption had a hole. A subscription minted against a DIFFERENT VAPID
--   keypair is answered 403, not 404/410, so the old prune kept the row. The
--   student therefore stayed claimable, was claimed, spent 4 hours of cooldown
--   and one of two daily sends, and received nothing — every four hours,
--   forever, silently. Observed in the pilot: one student, two campaigns queued,
--   zero notifications, day_count = 1 with both recipient rows back at 'queued'.
--
--   src/lib/push.js now prunes 401/403 as well, which closes the hole at source.
--   This migration fixes the consequence: a failure that delivered to NOBODY
--   should not cost the student anything.
--
--   WHY THE DOUBLE-NOTIFY ARGUMENT DOES NOT APPLY HERE
--   The refund is gated on p_refund, and the worker passes it only when
--   accepted === 0 — meaning not one endpoint returned 2xx. There is no
--   maybe-it-landed case to protect against: nothing left the building. A
--   PARTIAL failure (some devices accepted, others did not) still settles ok
--   and still spends, which is right — the student was notified.
--
--   Idempotent and safe to re-run.
-- ============================================================

-- The new signature adds a defaulted third parameter. `create or replace` alone
-- would leave the two-argument version in place as a separate overload, and
-- PostgREST resolves rpc() by argument names — an ambiguous pair would start
-- failing at runtime. Drop the old one first, then re-grant (dropping a function
-- drops its grants with it).
drop function if exists public.finish_campaign_batch(uuid, boolean);

create or replace function public.finish_campaign_batch(
  p_batch  uuid,
  p_ok     boolean default true,
  -- Set only when ZERO endpoints accepted the payload. See the header.
  p_refund boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n       integer;
  v_users uuid[];
begin
  if p_ok then
    update campaign_recipients
    set status = 'sent', pushed_at = now()
    where push_batch = p_batch and status = 'sending';
    get diagnostics n = row_count;

    update vendor_campaigns c
    set sent_count = c.sent_count + s.n
    from (
      select campaign_id, count(*)::integer as n
      from campaign_recipients
      where push_batch = p_batch and status = 'sent'
      group by campaign_id
    ) s
    where c.id = s.campaign_id;
  else
    -- Capture whose rows these were on the way past: after the update the batch
    -- id is gone, so there is no second chance to find them.
    with cleared as (
      update campaign_recipients
      set status = 'queued', push_batch = null, claimed_at = null
      where push_batch = p_batch and status = 'sending'
      returning user_id
    )
    select count(*)::integer, coalesce(array_agg(distinct user_id), '{}'::uuid[])
      into n, v_users
    from cleared;

    if p_refund and array_length(v_users, 1) is not null then
      -- greatest(...,0) because the counters are also reset by the daily/weekly
      -- rollover in claim_campaign_pushes; a refund must never drive them
      -- negative and hand a student unlimited sends.
      --
      -- last_push_at = null is what actually releases the 4-hour cooldown. It is
      -- safe precisely because nothing was delivered: the value exists to space
      -- out notifications the student RECEIVED.
      update student_notify_state s
      set day_count    = greatest(s.day_count  - 1, 0),
          week_count   = greatest(s.week_count - 1, 0),
          last_push_at = null,
          updated_at   = now()
      where s.user_id = any(v_users);
    end if;
  end if;
  return n;
end;
$$;

-- migration-007 convention: service_role only.
revoke execute on function public.finish_campaign_batch(uuid, boolean, boolean) from public, anon, authenticated;
grant  execute on function public.finish_campaign_batch(uuid, boolean, boolean) to service_role;
