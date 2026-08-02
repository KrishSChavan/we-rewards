-- ============================================================
-- Migration 034 — taking a campaign down does not refund the vendor's send.
--
--   WHY THIS EXISTS
--   Vendors can now take a live deal down (DELETE /api/vendor/campaigns/:id),
--   which marks the campaign 'cancelled'. Both quota counters — the display in
--   src/routes/vendor.js and the enforcement here — counted
--   `status <> 'cancelled'`, which was harmless while nothing ever wrote that
--   status and becomes a hole the moment something does: cancelling gave the
--   send back, so "send, let it run, take it down, send again" would be an
--   unlimited fan-out against a 2-per-week cap.
--
--   The tempting narrower rule — refund only when sent_count = 0, i.e. when no
--   notification went out — does NOT work, and the reason is the shape of this
--   feature rather than an oversight. A campaign is delivered the moment
--   create_campaign writes its campaign_recipients rows: that IS the student's
--   in-app deals list, and migration-032 is explicit that the list is never
--   throttled ("suppressing a notification removes an interruption, never a
--   message"). sent_count counts only the push half. It stays 0 when VAPID is
--   unconfigured, and in a small pilot it stays 0 most of the time regardless.
--   So sent_count = 0 does not mean "nobody got this" — it usually means
--   "everybody got it quietly", which is precisely the case a refund must not
--   cover.
--
--   The typo that would otherwise argue for a refund is covered by
--   PATCH /api/vendor/campaigns/:id, which rewrites a live deal for free.
--   Fixing the words never needs a takedown.
--
--   So: every campaign created in the rolling week counts, whatever its status.
--   Only the two quota subqueries change. Everything else in create_campaign is
--   byte-identical to migration-032; the signature is unchanged, so this is a
--   plain create-or-replace with no drop and no PostgREST overload ambiguity.
--
--   Run in the Supabase SQL Editor after migration-033 (safe to re-run).
-- ============================================================

begin;

create or replace function public.create_campaign(
  p_vendor_id        uuid,
  p_created_by       uuid,
  p_title            text,
  p_body             text,
  p_kind             text     default 'deal',
  p_audience         text     default 'top',
  p_limit            integer  default 100,
  p_client_token     text     default null,
  p_coalesce_minutes integer  default 5,
  p_duration_hours   integer  default 48,
  p_weekly_sends     integer  default 2
)
returns table (campaign_id uuid, queued integer, sends_left integer, reused boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title    text := btrim(coalesce(p_title, ''));
  v_body     text := btrim(coalesce(p_body, ''));
  v_kind     text := coalesce(p_kind, 'deal');
  v_aud      text := coalesce(p_audience, 'top');
  v_hold     integer := least(greatest(coalesce(p_coalesce_minutes, 5), 0), 120);
  v_hours    integer := least(greatest(coalesce(p_duration_hours, 48), 1), 336);
  v_id       uuid;
  v_used     integer;
  v_deliver  timestamptz;
  v_slot     integer;
  v_queued   integer;
begin
  if v_title = '' or length(v_title) > 60 then
    raise exception 'CAMPAIGN_TITLE_INVALID';
  end if;
  if v_body = '' or length(v_body) > 140 then
    raise exception 'CAMPAIGN_BODY_INVALID';
  end if;
  if v_kind not in ('deal', 'event', 'notice') then
    raise exception 'CAMPAIGN_KIND_INVALID';
  end if;
  if v_aud not in ('top', 'lapsed', 'close') then
    raise exception 'CAMPAIGN_AUDIENCE_INVALID';
  end if;

  -- Serialize this vendor's sends against each other.
  perform 1 from vendors where id = p_vendor_id for update;
  if not found then
    raise exception 'VENDOR_UNAVAILABLE';
  end if;

  -- A retried send finds its own earlier campaign and reports it unchanged.
  if p_client_token is not null then
    select id into v_id
    from vendor_campaigns
    where vendor_id = p_vendor_id and client_token = p_client_token;
    if found then
      return query
        select c.id,
               c.queued_count,
               greatest(0, p_weekly_sends - (
                 select count(*)::integer from vendor_campaigns c2
                 where c2.vendor_id = p_vendor_id
                   -- CHANGED (034): the `and c2.status <> 'cancelled'` that was
                   -- here is gone. A taken-down campaign still counts.
                   and c2.created_at >= now() - interval '7 days')),
               true
        from vendor_campaigns c where c.id = v_id;
      return;
    end if;
  end if;

  select count(*)::integer into v_used
  from vendor_campaigns
  where vendor_id = p_vendor_id
    -- CHANGED (034): the `and status <> 'cancelled'` that was here is gone.
    -- A taken-down campaign still counts. See the header.
    and created_at >= now() - interval '7 days';

  if v_used >= greatest(p_weekly_sends, 0) then
    raise exception 'CAMPAIGN_QUOTA';
  end if;

  -- Snap the release time UP to the next multiple of the hold window. Two
  -- vendors composing a Friday deal a minute apart land in the SAME slot and
  -- therefore in the same student's same bundle, instead of one arriving just
  -- early enough to spend the cooldown alone.
  v_slot := greatest(v_hold, 1) * 60;
  v_deliver := to_timestamp(
    ceil(extract(epoch from (now() + make_interval(mins => v_hold))) / v_slot) * v_slot
  );

  insert into vendor_campaigns (
    vendor_id, created_by, title, body, kind, audience, audience_size,
    client_token, deliver_after, expires_at
  )
  values (
    p_vendor_id, p_created_by, v_title, v_body, v_kind, v_aud,
    least(greatest(coalesce(p_limit, 100), 1), 100),
    p_client_token, v_deliver, now() + make_interval(hours => v_hours)
  )
  returning id into v_id;

  insert into campaign_recipients (campaign_id, user_id, deliver_after)
  select v_id, a.user_id, v_deliver
  from campaign_audience(p_vendor_id, v_aud, p_limit) a;
  get diagnostics v_queued = row_count;

  update vendor_campaigns set queued_count = v_queued where id = v_id;

  return query select v_id, v_queued, greatest(0, p_weekly_sends - (v_used + 1)), false;
end;
$$;

-- migration-007 convention: service_role only. (create-or-replace preserves the
-- existing grants, but re-stating them keeps this file runnable on its own.)
revoke execute on function public.create_campaign(uuid, uuid, text, text, text, text, integer, text, integer, integer, integer) from public, anon, authenticated;
grant  execute on function public.create_campaign(uuid, uuid, text, text, text, text, integer, text, integer, integer, integer) to service_role;

commit;
