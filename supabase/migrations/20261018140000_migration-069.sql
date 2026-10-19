-- ============================================================
-- Migration 069 — a vendor asks for a deal to reach EVERY student, and the
-- operator decides.
--
--   WHAT IT IS. Until now a vendor deal could only reach that vendor's own
--   customers (campaign_audience: 'top' / 'lapsed' / 'close', capped at 100),
--   and that cap is a policy rather than a sizing choice: campaign_audience's
--   own comment says "no vendor should be able to address the student body".
--   This keeps that true. A vendor still cannot address the student body; they
--   can ASK, from the terminal, and the operator approves or denies the ask from
--   /admin. Only an approval writes anything a student sees.
--
--   HOW AN APPROVAL IS DELIVERED: AS AN ORDINARY CAMPAIGN. review_deal_request
--   writes one vendor_campaigns row with the new audience 'all' and one
--   campaign_recipients row per profile, which is exactly the shape
--   create_campaign writes for a top-100 deal. Everything downstream already
--   works on that shape and is deliberately NOT touched here:
--     • claim_campaign_pushes (047) never reads `audience`. The shared
--       student_notify_state budget, quiet hours, the four-hour cooldown, the
--       per-vendor cooldown, push_opt_in, email_opt_in and the suppression list
--       all apply to an all-student deal precisely as they apply to any other.
--       Privacy Policy §7.4 promises those limits "whatever the reason"; a deal
--       the operator approved is one of the reasons.
--     • The push-then-email fallback (047) is the same: push first, email only
--       where no device accepted it, never both.
--     • The in-app Deals list (/api/me/deals) lists it immediately, and the
--       vendor's own DEALS history shows it with its counts and Take down.
--
--   THE VENDOR'S WEEKLY QUOTA IGNORES IT. create_campaign counts a vendor's
--   campaigns over a rolling seven days against p_weekly_sends. An approved
--   all-student deal is the operator's send rather than the vendor's, so both
--   quota subqueries below now skip audience = 'all'. Everything else in
--   create_campaign is byte-identical to migration-034, and the signature is
--   unchanged, so this is a plain create-or-replace with no overload risk.
--   src/routes/vendor.js campaignQuota mirrors the same filter; the display and
--   the enforcement must agree or a vendor sees sends they cannot spend.
--
--   ONE PENDING REQUEST PER VENDOR. Enforced twice: under the vendor row lock in
--   submit_deal_request (which answers a sentence), and by a partial unique
--   index (which answers anything that skips the function). A vendor who wants
--   to change their ask withdraws it and asks again.
--
--   A DECISION IS FINAL AND IDEMPOTENT. review_deal_request locks the request
--   row; a second click on Approve, or an Approve racing a Deny, finds it no
--   longer pending and reports what it already is, with out_changed = false.
--   Nothing is queued twice, and the route uses out_changed to send the vendor
--   exactly one decision email.
--
--   The deal's clock starts at APPROVAL, not at the request: a "3 days" deal
--   approved on Thursday runs to Sunday, not to whenever the vendor asked.
--
--   PRIVACY. Unchanged from migration-032: the vendor never learns who is in
--   the audience. Once approved, the terminal shows the same aggregate counts
--   as any deal (targeted, notified, opened), and nothing before that.
--
--   Run in the Supabase SQL Editor after migration-068 (safe to re-run).
-- ============================================================

begin;

-- ---------- 1. a fourth campaign audience ----------
--
-- migration-032 declared the check inline, so Postgres named it
-- <table>_<column>_check. Dropped and re-added so a re-run is a no-op.

alter table public.vendor_campaigns
  drop constraint if exists vendor_campaigns_audience_check;
alter table public.vendor_campaigns
  add constraint vendor_campaigns_audience_check
  check (audience in ('top', 'lapsed', 'close', 'all'));


-- ---------- 2. the request ----------

create table if not exists public.vendor_deal_requests (
  id             uuid primary key default gen_random_uuid(),
  vendor_id      uuid not null references public.vendors (id) on delete cascade,
  -- The vendor_staff login that asked. No FK, the audit-trail convention
  -- vendor_campaigns.created_by and admin_broadcasts.created_by follow; it is
  -- also who the decision email goes to.
  requested_by   uuid,
  title          text not null check (length(btrim(title)) between 1 and 60),
  body           text not null check (length(btrim(body)) between 1 and 140),
  kind           text not null default 'deal' check (kind in ('deal', 'event', 'notice')),
  duration_hours integer not null check (duration_hours between 1 and 336),
  status         text not null default 'pending'
                 check (status in ('pending', 'approved', 'denied', 'withdrawn')),
  -- The operator's reason, shown to the vendor in the terminal and in the email.
  admin_note     text check (admin_note is null or length(admin_note) <= 500),
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  -- set null, not cascade: prune_campaigns deletes a campaign 30 days after it
  -- expires, and the record that a request was approved must outlive that.
  campaign_id    uuid references public.vendor_campaigns (id) on delete set null,
  queued_count   integer,
  -- Idempotency for a request retried after a network drop, the same contract
  -- vendor_campaigns.client_token provides.
  client_token   text,
  created_at     timestamptz not null default now()
);

comment on table public.vendor_deal_requests is
  'A vendor''s request to send one deal to every student (migration-069). '
  'Nothing reaches a student until review_deal_request approves it, which '
  'writes an ordinary vendor_campaigns row with audience = ''all''.';

create unique index if not exists idx_deal_requests_one_pending
  on public.vendor_deal_requests (vendor_id)
  where status = 'pending';

create unique index if not exists idx_deal_requests_token
  on public.vendor_deal_requests (vendor_id, client_token)
  where client_token is not null;

-- The admin queue (pending first, newest first) and the terminal's own list.
create index if not exists idx_deal_requests_status_time
  on public.vendor_deal_requests (status, created_at desc);
create index if not exists idx_deal_requests_vendor_time
  on public.vendor_deal_requests (vendor_id, created_at desc);

alter table public.vendor_deal_requests enable row level security;
-- No policies: service_role only, like every other campaign table.


-- ---------- 3. create_campaign: the quota skips all-student deals ----------

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
  -- Still only the three vendor audiences. 'all' is reachable ONLY through
  -- review_deal_request, never by a vendor calling this directly.
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
                   -- CHANGED (069): an operator-approved all-student deal is
                   -- not one of the vendor's own sends.
                   and c2.audience <> 'all'
                   and c2.created_at >= now() - interval '7 days')),
               true
        from vendor_campaigns c where c.id = v_id;
      return;
    end if;
  end if;

  select count(*)::integer into v_used
  from vendor_campaigns
  where vendor_id = p_vendor_id
    -- CHANGED (069): see the header.
    and audience <> 'all'
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

revoke execute on function public.create_campaign(uuid, uuid, text, text, text, text, integer, text, integer, integer, integer) from public, anon, authenticated;
grant  execute on function public.create_campaign(uuid, uuid, text, text, text, text, integer, text, integer, integer, integer) to service_role;


-- ---------- 4. a vendor asks ----------

create or replace function public.submit_deal_request(
  p_vendor_id      uuid,
  p_requested_by   uuid,
  p_title          text,
  p_body           text,
  p_kind           text    default 'deal',
  p_duration_hours integer default 72,
  p_client_token   text    default null
)
returns table (out_id uuid, out_status text, out_reused boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title  text := btrim(coalesce(p_title, ''));
  v_body   text := btrim(coalesce(p_body, ''));
  v_kind   text := coalesce(p_kind, 'deal');
  v_id     uuid;
  v_status text;
begin
  -- The same limits and the same exception names as create_campaign, so the
  -- route's error mapping is shared.
  if v_title = '' or length(v_title) > 60 then
    raise exception 'CAMPAIGN_TITLE_INVALID';
  end if;
  if v_body = '' or length(v_body) > 140 then
    raise exception 'CAMPAIGN_BODY_INVALID';
  end if;
  if v_kind not in ('deal', 'event', 'notice') then
    raise exception 'CAMPAIGN_KIND_INVALID';
  end if;
  if p_duration_hours is null or p_duration_hours < 1 or p_duration_hours > 336 then
    raise exception 'CAMPAIGN_DURATION_INVALID';
  end if;

  -- Serializes this vendor's requests against each other, and refuses a spot
  -- that has been switched off: its deal would be hidden from every student's
  -- list (/api/me/deals filters vendors.active) while still being pushed.
  perform 1 from vendors where id = p_vendor_id and active for update;
  if not found then
    raise exception 'VENDOR_UNAVAILABLE';
  end if;

  if p_client_token is not null then
    select r.id, r.status into v_id, v_status
    from vendor_deal_requests r
    where r.vendor_id = p_vendor_id and r.client_token = p_client_token;
    if found then
      out_id := v_id; out_status := v_status; out_reused := true;
      return next;
      return;
    end if;
  end if;

  if exists (
    select 1 from vendor_deal_requests r
    where r.vendor_id = p_vendor_id and r.status = 'pending'
  ) then
    raise exception 'DEAL_REQUEST_PENDING';
  end if;

  insert into vendor_deal_requests (
    vendor_id, requested_by, title, body, kind, duration_hours, client_token
  )
  values (
    p_vendor_id, p_requested_by, v_title, v_body, v_kind, p_duration_hours, p_client_token
  )
  returning id into v_id;

  out_id := v_id; out_status := 'pending'; out_reused := false;
  return next;
end;
$$;

comment on function public.submit_deal_request(uuid, uuid, text, text, text, integer, text) is
  'Queue a vendor''s request to send one deal to every student (migration-069). '
  'Writes nothing a student can see. One pending request per vendor; '
  'idempotent per (vendor_id, client_token).';

revoke execute on function public.submit_deal_request(uuid, uuid, text, text, text, integer, text) from public, anon, authenticated;
grant  execute on function public.submit_deal_request(uuid, uuid, text, text, text, integer, text) to service_role;


-- ---------- 5. the operator decides ----------

create or replace function public.review_deal_request(
  p_request_id       uuid,
  p_reviewer         uuid,
  p_approve          boolean,
  p_note             text    default null,
  p_coalesce_minutes integer default 5
)
returns table (
  out_status       text,
  out_changed      boolean,
  out_campaign_id  uuid,
  out_queued       integer,
  out_vendor_id    uuid,
  out_requested_by uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  r         vendor_deal_requests%rowtype;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_hold    integer := least(greatest(coalesce(p_coalesce_minutes, 5), 0), 120);
  v_slot    integer;
  v_deliver timestamptz;
  v_cid     uuid;
  v_queued  integer;
begin
  if p_approve is null then
    raise exception 'DECISION_REQUIRED';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'NOTE_TOO_LONG';
  end if;

  select * into r from vendor_deal_requests where id = p_request_id for update;
  if not found then
    raise exception 'DEAL_REQUEST_NOT_FOUND';
  end if;

  -- Already decided (a double click, or an Approve racing a Deny): report the
  -- decision that stands and change nothing.
  if r.status <> 'pending' then
    out_status := r.status; out_changed := false; out_campaign_id := r.campaign_id;
    out_queued := r.queued_count; out_vendor_id := r.vendor_id; out_requested_by := r.requested_by;
    return next;
    return;
  end if;

  if not p_approve then
    update vendor_deal_requests
    set status = 'denied', admin_note = v_note, reviewed_by = p_reviewer, reviewed_at = now()
    where id = r.id;
    out_status := 'denied'; out_changed := true; out_campaign_id := null;
    out_queued := null; out_vendor_id := r.vendor_id; out_requested_by := r.requested_by;
    return next;
    return;
  end if;

  -- A spot switched off between the ask and the answer cannot be approved; the
  -- operator can still deny it with a note.
  perform 1 from vendors where id = r.vendor_id and active for update;
  if not found then
    raise exception 'VENDOR_UNAVAILABLE';
  end if;

  -- The same release-slot snap create_campaign uses, so an approval lands in
  -- the same bundle as any vendor deal released in that slot.
  v_slot := greatest(v_hold, 1) * 60;
  v_deliver := to_timestamp(
    ceil(extract(epoch from (now() + make_interval(mins => v_hold))) / v_slot) * v_slot
  );

  insert into vendor_campaigns (
    vendor_id, created_by, title, body, kind, audience, audience_size,
    client_token, deliver_after, expires_at
  )
  values (
    r.vendor_id, r.requested_by, r.title, r.body, r.kind, 'all', 0,
    'everyone:' || r.id::text, v_deliver, now() + make_interval(hours => r.duration_hours)
  )
  returning id into v_cid;

  -- Every profile. Joining profiles is how a signed-in-but-never-consented
  -- account (migration-022) stays out, the same rule admin_broadcast_audience's
  -- 'all' applies. Reachability and each student's frequency budget are decided
  -- later, at claim time; this row is also their in-app Deals list entry, which
  -- is never throttled. 20000 is the same typo guard migration-061 uses.
  insert into campaign_recipients (campaign_id, user_id, deliver_after)
  select v_cid, p.user_id, v_deliver
  from profiles p
  limit 20000;
  get diagnostics v_queued = row_count;

  update vendor_campaigns
  set queued_count = v_queued, audience_size = v_queued
  where id = v_cid;

  update vendor_deal_requests
  set status = 'approved', admin_note = v_note, reviewed_by = p_reviewer, reviewed_at = now(),
      campaign_id = v_cid, queued_count = v_queued
  where id = r.id;

  out_status := 'approved'; out_changed := true; out_campaign_id := v_cid;
  out_queued := v_queued; out_vendor_id := r.vendor_id; out_requested_by := r.requested_by;
  return next;
end;
$$;

comment on function public.review_deal_request(uuid, uuid, boolean, text, integer) is
  'Approve or deny a vendor''s all-student deal request (migration-069). '
  'Approval writes a vendor_campaigns row with audience = ''all'' and a '
  'recipient per profile; delivery is the ordinary campaign worker under the '
  'shared frequency budget. Idempotent: a decided request is reported, not changed.';

revoke execute on function public.review_deal_request(uuid, uuid, boolean, text, integer) from public, anon, authenticated;
grant  execute on function public.review_deal_request(uuid, uuid, boolean, text, integer) to service_role;

commit;
