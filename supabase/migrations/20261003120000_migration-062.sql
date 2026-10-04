-- ============================================================
-- Migration 062 — a notification log, and a read-only window onto the queues.
--
--   THE PROBLEM. WeRewards now interrupts people through seven different paths
--   (deal alerts and their email fallback, nearby alerts, reminders, operator
--   broadcasts, account emails to vendors and applicants, and admin alerts), and
--   not one of them leaves a record an operator can read. What survives today is
--   scattered and partial: campaign_recipients knows a deal was sent and by
--   which channel but not what the notification SAID (the copy is composed in
--   Node and thrown away); a FAILED deal leaves nothing but a console.warn, its
--   recipient row requeued and its budget refunded as though nothing happened;
--   a reminder leaves one timestamp (last_reminder_at) that a refund then nulls;
--   an email to a vendor leaves nothing at all. So "did X get the notification?"
--   is currently answered by reading Heroku logs, and "is anything even queued?"
--   by hand-written SQL. This migration is the database half of the /admin
--   Notifications tab that answers both.
--
--   THREE THINGS.
--
--   1. public.notification_log — one row per push or email we sent, tried to
--      send, or decided not to send, written by src/lib/notification-log.js.
--      Outcomes are sent / failed / refused, plus 'allowed' for nearby alerts:
--      the server only PERMITS those and the student's own device decides
--      whether to show one, so calling it "sent" would be a claim we cannot
--      back. Kept 30 days (prune_notification_log + pg_cron), and a student's
--      rows go the moment their profile does (FK cascade) — this is a record
--      of messages to a person, and it is disclosed as exactly that in Privacy
--      Policy §2.6. What it must NEVER hold: reset codes, link codes, push
--      endpoint URLs or keys, email bodies, headers or unsubscribe links. Node
--      redacts before writing; nothing here can check that, which is why the
--      columns are narrow (an email row has a redacted subject and a template
--      name, never a body).
--
--   2. push_subscriptions.device_label — "iPhone Safari", parsed from the user
--      agent at subscribe time, so a per-device result in the log can say which
--      device it was without storing the endpoint (which IS the device's
--      address and is a bearer credential for pushing to it).
--
--   3. Five READ-ONLY functions behind the Queue view. Each mirrors one claim's
--      predicates (claim_campaign_pushes in 047, claim_reminder_pushes in 060,
--      claim_admin_broadcast_pushes in 061) and reports, per waiting item, the
--      list of things holding it back and when it will next be eligible. They
--      are deliberately NOT the claims called in a dry-run mode: a claim spends
--      the shared budget and runs housekeeping writes, and a screen an operator
--      refreshes every fifteen seconds must not be able to change who gets
--      notified. All five are STABLE, which plpgsql enforces at run time — an
--      INSERT/UPDATE/DELETE inside a non-volatile function raises rather than
--      writing — so "never writes" is a property of the declaration, not of
--      anyone's care.
--
--      The cost of mirroring is drift: when a claim's rules change, its queue
--      function must change with it, or the Queue view tells the operator a
--      student is blocked for a reason the worker no longer applies. Every
--      predicate below names the claim line it copies for that reason.
--
--   BACKFILL. The last 30 days of what the database already knows (sent deals,
--   sent broadcasts, nearby claims) is imported as source = 'backfill' rows, so
--   the log is not empty on day one. Idempotent through dedupe_key, which uses
--   the same 'deal:<batch>' / 'broadcast:<id>:<user>' / 'nearby:<user>:<vendor>'
--   keys the live writers use, so a re-paste after live logging has started
--   cannot double anything up.
--
--   PREREQUISITE: migration-047 (campaign_recipients.channel,
--   student_notify_state.email_opt_in, email_suppressions). Applies cleanly
--   with or without 048/051/060/061: everything that names a 051/060/061
--   object is either behind to_regclass() or inside a plpgsql body, which is
--   not resolved until the function is CALLED. admin_broadcast_queue errors
--   when 061 is missing and admin_reminder_queue when 060 is; Node maps both to
--   "Migration 0NN not applied" for that section only.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-061. Safe to re-run. The app ships BEFORE this is applied and
--   degrades silently until it is: log writes are skipped, the Queue view
--   reports the migration as missing, and no send path changes behaviour.
-- ============================================================

begin;

-- ---------- 1. the log ----------

create table if not exists public.notification_log (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  channel          text not null check (channel in ('push', 'email')),
  -- NO check constraint, on purpose. The kind vocabulary grows every time a
  -- feature learns to notify someone (this is the fourth in a year), and a
  -- check here would turn each new kind into a migration that has to be pasted
  -- BEFORE the deploy or every write of that kind fails. Node validates it
  -- (NOTIFICATION_KINDS in src/lib/notification-log.js, unknown -> 'other').
  kind             text not null,
  outcome          text not null check (outcome in ('sent', 'failed', 'refused', 'allowed')),
  reason           text,
  recipient_kind   text not null check (recipient_kind in ('student', 'vendor', 'applicant', 'admin', 'other')),
  student_id       uuid references public.profiles (user_id) on delete cascade,
  -- NO FK, the audit-trail convention push_subscriptions.user_id and
  -- admin_broadcasts.created_by follow: a record that we emailed a vendor login
  -- must outlive that login.
  recipient_user_id uuid,
  recipient_email  text,
  recipient_label  text,
  vendor_id        uuid references public.vendors (id) on delete set null,
  title            text,
  body             text,
  url              text,
  template         text,
  ref              jsonb not null default '{}'::jsonb,
  devices          jsonb not null default '[]'::jsonb,
  devices_tried    integer not null default 0,
  devices_accepted integer not null default 0,
  provider_id      text,
  delivery_status  text check (delivery_status in ('delivered', 'bounced', 'complained')),
  delivery_at      timestamptz,
  source           text not null default 'live' check (source in ('live', 'backfill')),
  -- A PLAIN unique constraint, not a partial unique index, and the difference
  -- is load-bearing: PostgREST's upsert sends `on conflict (dedupe_key)`, and
  -- Postgres will only match that against a partial index when the statement
  -- repeats the index's WHERE clause, which PostgREST has no way to do. A plain
  -- constraint still lets every row without a key through, because NULLs are
  -- distinct.
  dedupe_key       text unique
);

comment on table public.notification_log is
  'One row per push or email WeRewards sent, tried to send, or decided not to '
  'send (migration-062). Written by src/lib/notification-log.js, read by the '
  '/admin Notifications tab and the student''s own data export. Kept 30 days '
  '(prune_notification_log); student rows cascade with the profile. Never '
  'holds codes, push endpoints/keys, or email bodies.';
comment on column public.notification_log.outcome is
  'sent = at least one device or the mail provider accepted it; failed = '
  'attempted and nothing accepted it; refused = never attempted (switched off, '
  'suppressed, no devices, nothing to say); allowed = nearby only, the server '
  'permitted it and the student''s device shows it itself.';
comment on column public.notification_log.title is
  'Push title as sent, or the email subject with any secret (reset code, link '
  'code) replaced by [redacted] BEFORE it reaches the database.';
comment on column public.notification_log.devices is
  'Per-device push results: [{subId, service, label, ok, status, pruned, '
  'error}]. Never the endpoint URL, p256dh or auth.';
comment on column public.notification_log.ref is
  'Source references (campaignIds, batch, broadcastId, resetId, ...). See '
  'migration-062 and src/lib/notification-log.js for the vocabulary.';
comment on column public.notification_log.delivery_status is
  'From the Resend webhook: delivered, bounced or complained ONLY. Opens and '
  'clicks are never stored.';
comment on column public.notification_log.dedupe_key is
  'Idempotency for writers that can repeat (deal:<batch>, '
  'broadcast:<id>:<user>, nearby:<user>:<vendor>) and for the backfill.';

-- The admin list is newest-first and pages by offset; id breaks ties so a page
-- boundary never lands between two rows written in the same instant.
create index if not exists idx_notification_log_time
  on public.notification_log (created_at desc, id desc);
-- The student lookup and the student detail popup.
create index if not exists idx_notification_log_student
  on public.notification_log (student_id, created_at desc)
  where student_id is not null;
create index if not exists idx_notification_log_kind
  on public.notification_log (kind, created_at desc);
create index if not exists idx_notification_log_outcome
  on public.notification_log (outcome, created_at desc);
-- The Resend webhook looks rows up by message id.
create index if not exists idx_notification_log_provider
  on public.notification_log (provider_id)
  where provider_id is not null;

alter table public.notification_log enable row level security;
-- No policies: service_role only. And an explicit revoke on top, because
-- migration 20260807162120's default-privilege fix only covers tables created
-- by the role that ran it — a hosted project's supabase_admin defaults can
-- still hand anon full DML on a new table at CREATE time. RLS with no policies
-- would deny anyway; this is the second lock, for the day someone adds one.
revoke all on table public.notification_log from anon, authenticated;
grant select, insert, update, delete on table public.notification_log to service_role;


-- ---------- 2. which device a push went to ----------

alter table public.push_subscriptions
  add column if not exists device_label text;

comment on column public.push_subscriptions.device_label is
  'Short human label parsed from the user agent at subscribe time, e.g. '
  '"iPhone Safari"; null for rows subscribed before migration-062. Lets the '
  'notification log name a device without ever storing its endpoint.';


-- ---------- 3. retention ----------

create or replace function public.prune_notification_log(p_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  -- greatest(...,1): a null or 0 must not mean "delete everything".
  delete from public.notification_log
   where created_at < now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.prune_notification_log(integer) is
  'Deletes notification_log rows older than p_days (default 30, minimum 1). '
  'Scheduled daily by pg_cron as prune-notification-log. See migration-062.';

revoke execute on function public.prune_notification_log(integer) from public, anon, authenticated;
grant  execute on function public.prune_notification_log(integer) to service_role;


-- ---------- 4. backfill: the last 30 days the database already knows ----------
--
-- Each block keeps only rows whose student still has a profile: student_id is
-- an FK, and one orphan would abort the whole migration.

-- (a) Deals. ONE row per notification, not per campaign: a push_batch is one
-- notification carrying up to four campaigns (claim_campaign_pushes' bundle),
-- and that is what the student saw. Rows from before batching existed (null
-- push_batch) are one notification each.
--
-- The `not exists` on ref->>'batch' covers the one key the live writers do NOT
-- share: an email-fallback row is written by sendEmail with no dedupe_key, so
-- without it a re-paste after go-live would import a second copy of every
-- email fallback.
insert into public.notification_log
  (created_at, channel, kind, outcome, recipient_kind, student_id, recipient_email,
   vendor_id, title, body, ref, source, dedupe_key)
select g.last_at,
       g.channel,
       'deal', 'sent', 'student',
       g.user_id,
       case when g.channel = 'email' then pr.email end,
       g.first_vendor,
       case when g.n = 1 then g.first_title else g.n::text || ' spots have something on' end,
       case when g.n = 1 and g.channel = 'push' then g.first_body end,
       jsonb_build_object('campaignIds', g.ids, 'batch', g.push_batch, 'imported', true),
       'backfill',
       g.dedupe
from (
  select cr.user_id,
         cr.push_batch,
         case when cr.push_batch is not null then 'deal:' || cr.push_batch::text
              else 'deal:c:' || min(cr.campaign_id::text) || ':' || cr.user_id::text end as dedupe,
         max(cr.pushed_at)                                                as last_at,
         coalesce(max(cr.channel), 'push')                                as channel,
         count(*)::integer                                                as n,
         (array_agg(vc.vendor_id order by vc.created_at, vc.id))[1]       as first_vendor,
         (array_agg(vc.title     order by vc.created_at, vc.id))[1]       as first_title,
         (array_agg(vc.body      order by vc.created_at, vc.id))[1]       as first_body,
         jsonb_agg(cr.campaign_id order by vc.created_at, vc.id)          as ids
  from public.campaign_recipients cr
  join public.vendor_campaigns vc on vc.id = cr.campaign_id
  where cr.status = 'sent'
    and cr.pushed_at >= now() - interval '30 days'
  -- A null push_batch groups per (user, campaign); a real one per (user, batch).
  group by cr.user_id, cr.push_batch, case when cr.push_batch is null then cr.campaign_id end
) g
join public.profiles pr on pr.user_id = g.user_id
where not (
  g.push_batch is not null
  and exists (
    select 1 from public.notification_log nl
    where nl.kind = 'deal' and nl.ref ->> 'batch' = g.push_batch::text
  )
)
on conflict (dedupe_key) do nothing;

-- (b) Broadcasts and (c) nearby claims, each only if its migration has been
-- applied, and through EXECUTE so this file still parses and runs on a
-- database where the table does not exist.
do $$
begin
  if to_regclass('public.admin_broadcast_recipients') is not null
     and to_regclass('public.admin_broadcasts') is not null then
    execute $q$
      insert into public.notification_log
        (created_at, channel, kind, outcome, recipient_kind, student_id,
         title, body, url, ref, source, dedupe_key)
      select r.pushed_at, 'push', 'broadcast', 'sent', 'student', r.user_id,
             b.title, b.body, b.url,
             jsonb_build_object('broadcastId', b.id, 'imported', true),
             'backfill',
             'broadcast:' || b.id::text || ':' || r.user_id::text
      from public.admin_broadcast_recipients r
      join public.admin_broadcasts b on b.id = r.broadcast_id
      join public.profiles pr on pr.user_id = r.user_id
      where r.status = 'sent'
        and r.pushed_at >= now() - interval '30 days'
      on conflict (dedupe_key) do nothing
    $q$;
  end if;

  -- 'allowed', not 'sent': the server granted the claim and the phone decided
  -- whether to show it. Nearby REFUSALS were never recorded and are not
  -- invented here (they would be more location history, not less).
  if to_regclass('public.nearby_notifications') is not null then
    execute $q$
      insert into public.notification_log
        (created_at, channel, kind, outcome, recipient_kind, student_id, vendor_id,
         title, url, ref, source, dedupe_key)
      select n.notified_at, 'push', 'nearby', 'allowed', 'student', n.user_id, n.vendor_id,
             'You''re near ' || v.name,
             '/?spot=' || n.vendor_id::text,
             jsonb_build_object('shownBy', 'device', 'imported', true),
             'backfill',
             'nearby:' || n.user_id::text || ':' || n.vendor_id::text
      from public.nearby_notifications n
      join public.vendors v on v.id = n.vendor_id
      join public.profiles pr on pr.user_id = n.user_id
      where n.notified_at >= now() - interval '30 days'
      on conflict (dedupe_key) do nothing
    $q$;
  end if;
end;
$$;


-- ---------- 5. the queue, read-only ----------
--
-- Shared shape for all four queue functions:
--
--   * language plpgsql, NOT sql. A LANGUAGE SQL body is parsed and resolved at
--     CREATE time, so admin_broadcast_queue would fail to create (and, inside
--     this begin/commit, roll the whole migration back) on any database without
--     migration-061. plpgsql defers resolution to the first call.
--   * STABLE, so a write anywhere inside raises. See the header.
--   * p_now instead of now(), so the behaviour tests can pin the clock. Every
--     claim uses now(); passing now() reproduces it exactly.
--   * #variable_conflict use_column: the RETURNS TABLE column names (user_id,
--     status, title, ...) are also plpgsql variables, and without this every
--     unqualified column of the same name in the query is an "ambiguous" error
--     at CALL time — i.e. in production, not when the migration is pasted.
--   * blockers is ordered most-fundamental first, and a terminal state is
--     reported ALONE, as exactly one entry picked in the order expired >
--     cancelled > stuck > sending: those rows are not waiting for a budget at
--     all, listing "cooldown" beside "sending" only says the claim already
--     spent it, and a row can be in two terminal states at once (stuck on a
--     dead campaign) while the operator only needs the one that decides it.
--   * next_eligible_at is null when nothing time can fix is in the way
--     (switched off, no device, no channel, terminal); otherwise the latest
--     release time among the active gates, pushed past quiet hours. When that
--     release is at or after expires_at the claim will expire the row first
--     (it only takes rows with expires_at > now()), so next_eligible_at is
--     null and 'expires_first' is appended LAST, after the gates that cause it.
--   * p_user_id narrows to one student BEFORE the limit, so total_queued is
--     that student's count. The /admin student lookup used to fetch the whole
--     queue and filter in Node, which PostgREST's max_rows (1000) silently
--     truncated.
--
-- Defaults are CAMPAIGN_CONFIG's (src/lib/campaigns.js) and the claims' own.

-- The quiet-hours rule every claim inlines: start = end disables it, start > end
-- wraps midnight. Returns p_ts itself when p_ts is outside the window, else the
-- next local p_quiet_end:00. Shared by the four functions below so they cannot
-- disagree with each other about when quiet hours end.
create or replace function public.admin_next_outside_quiet(
  p_ts          timestamptz,
  p_quiet_start integer,
  p_quiet_end   integer,
  p_timezone    text
)
returns timestamptz
language plpgsql
stable
set search_path = public
as $$
declare
  v_tz    text := coalesce(p_timezone, 'America/New_York');
  v_local timestamp;
  v_hour  integer;
  v_day   timestamp;
begin
  if p_ts is null then return null; end if;
  -- A null bound makes every comparison in the claims' version null, which
  -- falls through to "not quiet". Same answer here, spelled out.
  if p_quiet_start is null or p_quiet_end is null or p_quiet_start = p_quiet_end then
    return p_ts;
  end if;

  v_local := p_ts at time zone v_tz;
  v_hour  := extract(hour from v_local)::integer;
  v_day   := date_trunc('day', v_local);

  if p_quiet_start > p_quiet_end then                 -- window wraps midnight
    if v_hour >= p_quiet_start then
      return (v_day + interval '1 day' + make_interval(hours => p_quiet_end)) at time zone v_tz;
    elsif v_hour < p_quiet_end then
      return (v_day + make_interval(hours => p_quiet_end)) at time zone v_tz;
    end if;
  elsif v_hour >= p_quiet_start and v_hour < p_quiet_end then
    return (v_day + make_interval(hours => p_quiet_end)) at time zone v_tz;
  end if;
  return p_ts;
end;
$$;

comment on function public.admin_next_outside_quiet(timestamptz, integer, integer, text) is
  'p_ts if it falls outside the campus-local quiet window, else the next local '
  'p_quiet_end:00. Same wrap-midnight rule as every claim function (start = end '
  'disables). Read-only helper for the admin queue functions (migration-062).';

revoke execute on function public.admin_next_outside_quiet(timestamptz, integer, integer, text) from public, anon, authenticated;
grant  execute on function public.admin_next_outside_quiet(timestamptz, integer, integer, text) to service_role;


-- (1) Deal campaigns: one row per waiting campaign_recipients row.
--
-- Per ROW rather than per student, because that is what the operator is asking
-- about ("why hasn't Sher Halal's deal reached anyone?"). The claim itself is
-- per student and builds its bundle in two steps, modelled differently here:
--
--   * per_vendor: at most ONE campaign per vendor per bundle, picked by
--     (deliver_after, created_at). That is deterministic, so it is modelled:
--     a student's due rows are ranked per vendor in the same order (campaign_id
--     breaking the last tie), and rank N > 1 is 'same_spot_queued', released
--     (N - 1) vendor cooldowns from now - the earlier ones must each be sent
--     and then wait out the cooldown they start. Only DUE rows are ranked,
--     because only due rows compete in the claim; a held row behind a due one
--     from the same spot still reads as plain 'hold'.
--   * p_bundle_max: a student with more due spots than that shows every one as
--     eligible now while only the first few ride the next bundle; the rest then
--     wait out the cooldown that bundle spends. That is silent about the cap,
--     which is a choice the claim makes in the moment rather than a rule.
--
-- The narrower pre-p_user_id signature is dropped first: left beside the new
-- one, every named call that omits p_user_id (both overloads match) fails with
-- "function is not unique".
drop function if exists public.admin_campaign_queue(integer, boolean, integer, integer, integer, integer, integer, integer, text, timestamptz);

create or replace function public.admin_campaign_queue(
  p_limit                 integer     default 200,
  p_email_enabled         boolean     default false,
  p_cooldown_minutes      integer     default 240,
  p_daily_cap             integer     default 2,
  p_weekly_cap            integer     default 5,
  p_vendor_cooldown_hours integer     default 20,
  p_quiet_start           integer     default 22,
  p_quiet_end             integer     default 9,
  p_timezone              text        default 'America/New_York',
  p_now                   timestamptz default now(),
  p_user_id               uuid        default null
)
returns table (
  campaign_id      uuid,
  user_id          uuid,
  vendor_id        uuid,
  status           text,
  title            text,
  queued_at        timestamptz,
  deliver_after    timestamptz,
  expires_at       timestamptz,
  claimed_at       timestamptz,
  has_push         boolean,
  email_reachable  boolean,
  next_eligible_at timestamptz,
  blockers         text[],
  total_queued     bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_now    timestamptz := coalesce(p_now, now());
  v_limit  integer     := least(greatest(coalesce(p_limit, 200), 1), 5000);
  v_cool   interval    := make_interval(mins  => greatest(coalesce(p_cooldown_minutes, 240), 0));
  v_vcool  interval    := make_interval(hours => greatest(coalesce(p_vendor_cooldown_hours, 20), 0));
  v_quiet  boolean;
begin
  v_quiet := public.admin_next_outside_quiet(v_now, p_quiet_start, p_quiet_end, p_timezone) > v_now;

  return query
  with base as (
    select r.campaign_id                 as b_campaign,
           r.user_id                     as b_user,
           c.vendor_id                   as b_vendor,
           r.status                      as b_status,
           c.title                       as b_title,
           c.status                      as b_cstatus,
           c.created_at                  as b_created,
           r.deliver_after               as b_deliver,
           c.expires_at                  as b_expires,
           r.claimed_at                  as b_claimed,
           st.last_push_at               as b_last_push,
           st.day_start                  as b_day_start,
           st.week_start                 as b_week_start,
           -- No state row = the claim's own defaults: switches on, counters
           -- empty (it inserts that row `on conflict do nothing` before reading).
           coalesce(st.push_opt_in, true) as b_push_on,
           coalesce(st.day_count, 0)      as b_day_count,
           coalesce(st.week_count, 0)     as b_week_count,
           exists (
             select 1 from push_subscriptions ps
             where ps.user_id = r.user_id and ps.role = 'student'
           )                             as b_has_sub,
           -- 047's email reach, verbatim: transport on, switch on, a non-empty
           -- address, not suppressed.
           (coalesce(p_email_enabled, false)
            and coalesce(st.email_opt_in, true)
            and exists (
              select 1 from profiles pr
              where pr.user_id = r.user_id
                and pr.email is not null and trim(pr.email) <> ''
                and not exists (
                  select 1 from email_suppressions es where es.email = lower(trim(pr.email))
                )
            ))                           as b_email_ok,
           -- 047's per-vendor cooldown: the most recent SENT row from this
           -- campaign's vendor still inside the window, if any.
           (select max(r2.pushed_at)
              from campaign_recipients r2
              join vendor_campaigns c2 on c2.id = r2.campaign_id
             where r2.user_id = r.user_id
               and r2.status = 'sent'
               and c2.vendor_id = c.vendor_id
               and r2.pushed_at > v_now - v_vcool) as b_vendor_last
    from campaign_recipients r
    join vendor_campaigns c on c.id = r.campaign_id
    left join student_notify_state st on st.user_id = r.user_id
    where r.status in ('queued', 'sending')
      and (p_user_id is null or r.user_id = p_user_id)
  ),
  flags as (
    select b.*,
           -- Position among this student's DUE rows from the same vendor, in
           -- claim_campaign_pushes' per_vendor order. Partitioned by "is due"
           -- too, so a held or sending row neither takes nor shifts a rank.
           case when coalesce(b.b_status = 'queued' and b.b_deliver <= v_now and b.b_expires > v_now, false)
                then row_number() over (
                       partition by b.b_user, b.b_vendor,
                                    coalesce(b.b_status = 'queued' and b.b_deliver <= v_now and b.b_expires > v_now, false)
                       order by b.b_deliver, b.b_created, b.b_campaign)
           end                                                             as f_spot_rank,
           (b.b_push_on and b.b_has_sub)                                   as f_push,
           (b.b_status = 'sending'
            and b.b_claimed < v_now - interval '10 minutes')               as f_stuck,
           (b.b_status = 'sending'
            and not coalesce(b.b_claimed < v_now - interval '10 minutes', false)) as f_sending,
           -- The claim expires QUEUED rows only, and requeues a stuck row first
           -- (so a stuck row on a dead campaign expires on the tick after). A
           -- row genuinely mid-send on an expired campaign still completes.
           -- Cancelling a deal (PATCH in src/routes/vendor.js) sets status AND
           -- expires_at = now(), and the claim acts on the expiry alone; a
           -- 'cancelled' status with a future expiry would still be delivered,
           -- so it is not reported as cancelled.
           coalesce(b.b_expires <= v_now
            and (b.b_status = 'queued'
                 or b.b_claimed < v_now - interval '10 minutes'), false) as f_gone,
           (b.b_deliver > v_now)                                           as f_hold,
           (b.b_last_push is not null and b.b_last_push > v_now - v_cool)  as f_cool,
           (b.b_day_start is not null
            and b.b_day_start > v_now - interval '24 hours'
            and b.b_day_count >= p_daily_cap)                              as f_daily,
           (b.b_week_start is not null
            and b.b_week_start > v_now - interval '7 days'
            and b.b_week_count >= p_weekly_cap)                            as f_weekly
    from base b
  ),
  judged as (
    select f.*,
           (f.f_push or f.b_email_ok) as f_reach,
           (f.f_gone or f.f_sending or coalesce(f.f_stuck, false)) as f_terminal
    from flags f
  ),
  -- The release time, computed once so the expiry test and next_eligible_at
  -- cannot disagree.
  timed as (
    select j.*,
           case
             when j.f_terminal or not j.f_reach then null
             else public.admin_next_outside_quiet(
                    greatest(
                      v_now,
                      case when j.f_hold                    then j.b_deliver end,
                      case when j.b_vendor_last is not null then j.b_vendor_last + v_vcool end,
                      case when j.f_spot_rank > 1           then v_now + (j.f_spot_rank - 1) * v_vcool end,
                      case when j.f_cool                    then j.b_last_push + v_cool end,
                      case when j.f_daily                   then j.b_day_start + interval '24 hours' end,
                      case when j.f_weekly                  then j.b_week_start + interval '7 days' end
                    ),
                    p_quiet_start, p_quiet_end, p_timezone)
           end as t_release
    from judged j
  )
  select j.b_campaign,
         j.b_user,
         j.b_vendor,
         j.b_status,
         j.b_title,
         j.b_created,
         j.b_deliver,
         j.b_expires,
         j.b_claimed,
         j.f_push,
         j.b_email_ok,
         case when j.t_release >= j.b_expires then null else j.t_release end,
         case
           -- One entry, in priority order. f_gone already covers a stuck row on
           -- a dead campaign, so 'expired'/'cancelled' wins over 'stuck' there.
           when j.f_gone and j.b_cstatus = 'cancelled' then array['cancelled']::text[]
           when j.f_gone                                then array['expired']::text[]
           when coalesce(j.f_stuck, false)              then array['stuck']::text[]
           when j.f_sending                             then array['sending']::text[]
           else array_remove(array[
             -- Push-side reasons only matter when there is no email to fall back
             -- on; an email-reachable student is not blocked by a missing phone.
             case when not j.f_reach and not j.b_push_on                  then 'push_opt_out' end,
             case when not j.f_reach and j.b_push_on and not j.b_has_sub  then 'no_device' end,
             case when not j.f_reach                                      then 'no_channel' end,
             case when j.f_hold                                           then 'hold' end,
             case when j.b_vendor_last is not null                        then 'vendor_cooldown' end,
             case when j.f_spot_rank > 1                                  then 'same_spot_queued' end,
             case when j.f_cool                                           then 'cooldown' end,
             case when j.f_daily                                          then 'daily_cap' end,
             case when j.f_weekly                                         then 'weekly_cap' end,
             case when v_quiet                                            then 'quiet_hours' end,
             case when j.t_release >= j.b_expires                         then 'expires_first' end
           ]::text[], null)
         end,
         count(*) over ()
  from timed j
  order by j.b_created, j.b_user, j.b_campaign
  limit v_limit;
end;
$$;

comment on function public.admin_campaign_queue(integer, boolean, integer, integer, integer, integer, integer, integer, text, timestamptz, uuid) is
  'READ-ONLY view of the deal queue for /admin (migration-062): every queued or '
  'sending campaign_recipients row with what is holding it back (blockers) and '
  'when it next becomes eligible, optionally for one student (p_user_id). '
  'Mirrors claim_campaign_pushes (migration-047); change both together. Never '
  'claims, never writes.';

revoke execute on function public.admin_campaign_queue(integer, boolean, integer, integer, integer, integer, integer, integer, text, timestamptz, uuid) from public, anon, authenticated;
grant  execute on function public.admin_campaign_queue(integer, boolean, integer, integer, integer, integer, integer, integer, text, timestamptz, uuid) to service_role;


-- (2) Operator broadcasts: one row per waiting admin_broadcast_recipients row.
-- Mirrors claim_admin_broadcast_pushes (migration-061). Errors with 42P01 when
-- 061 is not applied; Node reports that section as unavailable. The narrower
-- pre-p_user_id signature is dropped first, for the same reason as above.
drop function if exists public.admin_broadcast_queue(integer, integer, integer, integer, integer, integer, text, timestamptz);

create or replace function public.admin_broadcast_queue(
  p_limit            integer     default 200,
  p_cooldown_minutes integer     default 240,
  p_daily_cap        integer     default 2,
  p_weekly_cap       integer     default 5,
  p_quiet_start      integer     default 22,
  p_quiet_end        integer     default 9,
  p_timezone         text        default 'America/New_York',
  p_now              timestamptz default now(),
  p_user_id          uuid        default null
)
returns table (
  broadcast_id     uuid,
  user_id          uuid,
  status           text,
  title            text,
  audience         text,
  queued_at        timestamptz,
  expires_at       timestamptz,
  claimed_at       timestamptz,
  has_push         boolean,
  next_eligible_at timestamptz,
  blockers         text[],
  total_queued     bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_now   timestamptz := coalesce(p_now, now());
  v_limit integer     := least(greatest(coalesce(p_limit, 200), 1), 5000);
  v_cool  interval    := make_interval(mins => greatest(coalesce(p_cooldown_minutes, 240), 0));
  v_quiet boolean;
begin
  v_quiet := public.admin_next_outside_quiet(v_now, p_quiet_start, p_quiet_end, p_timezone) > v_now;

  return query
  with base as (
    select r.broadcast_id                  as b_broadcast,
           r.user_id                       as b_user,
           r.status                        as b_status,
           b.title                         as b_title,
           b.audience                      as b_audience,
           b.status                        as b_bstatus,
           b.created_at                    as b_created,
           b.expires_at                    as b_expires,
           r.claimed_at                    as b_claimed,
           st.last_push_at                 as b_last_push,
           st.day_start                    as b_day_start,
           st.week_start                   as b_week_start,
           coalesce(st.push_opt_in, true)  as b_push_on,
           coalesce(st.day_count, 0)       as b_day_count,
           coalesce(st.week_count, 0)      as b_week_count,
           exists (
             select 1 from push_subscriptions ps
             where ps.user_id = r.user_id and ps.role = 'student'
           )                               as b_has_sub
    from admin_broadcast_recipients r
    join admin_broadcasts b on b.id = r.broadcast_id
    left join student_notify_state st on st.user_id = r.user_id
    where r.status in ('queued', 'sending')
      and (p_user_id is null or r.user_id = p_user_id)
  ),
  flags as (
    select b.*,
           -- 061's housekeeping expires queued AND sending rows, on expiry or
           -- cancellation alike, so unlike deals this needs no status test.
           (b.b_bstatus = 'cancelled')                                      as f_cancel,
           (b.b_bstatus <> 'cancelled' and b.b_expires <= v_now)            as f_expired,
           (b.b_status = 'sending'
            and b.b_claimed < v_now - interval '10 minutes')                as f_stuck,
           (b.b_status = 'sending'
            and not coalesce(b.b_claimed < v_now - interval '10 minutes', false)) as f_sending,
           (b.b_last_push is not null and b.b_last_push > v_now - v_cool)   as f_cool,
           (b.b_day_start is not null
            and b.b_day_start > v_now - interval '24 hours'
            and b.b_day_count >= p_daily_cap)                               as f_daily,
           (b.b_week_start is not null
            and b.b_week_start > v_now - interval '7 days'
            and b.b_week_count >= p_weekly_cap)                             as f_weekly
    from base b
  ),
  judged as (
    select f.*,
           (f.f_cancel or f.f_expired or f.f_sending or coalesce(f.f_stuck, false)) as f_terminal,
           -- The claim's driving scan requires a student endpoint; the loop
           -- then re-reads push_opt_in under the lock and skips without
           -- spending. Either way the row waits, and time will not fix it.
           (not f.b_push_on or not f.b_has_sub)                              as f_unreachable
    from flags f
  ),
  timed as (
    select j.*,
           case
             when j.f_terminal or j.f_unreachable then null
             else public.admin_next_outside_quiet(
                    greatest(
                      v_now,
                      case when j.f_cool   then j.b_last_push + v_cool end,
                      case when j.f_daily  then j.b_day_start + interval '24 hours' end,
                      case when j.f_weekly then j.b_week_start + interval '7 days' end
                    ),
                    p_quiet_start, p_quiet_end, p_timezone)
           end as t_release
    from judged j
  )
  select j.b_broadcast,
         j.b_user,
         j.b_status,
         j.b_title,
         j.b_audience,
         j.b_created,
         j.b_expires,
         j.b_claimed,
         (j.b_push_on and j.b_has_sub),
         -- 061's housekeeping expires the row at expires_at, before any claim
         -- at or after it could take it.
         case when j.t_release >= j.b_expires then null else j.t_release end,
         case
           when j.f_expired                 then array['expired']::text[]
           when j.f_cancel                  then array['cancelled']::text[]
           when coalesce(j.f_stuck, false)  then array['stuck']::text[]
           when j.f_sending                 then array['sending']::text[]
           else array_remove(array[
             case when not j.b_push_on                      then 'push_opt_out' end,
             case when j.b_push_on and not j.b_has_sub      then 'no_device' end,
             case when j.f_cool                             then 'cooldown' end,
             case when j.f_daily                            then 'daily_cap' end,
             case when j.f_weekly                           then 'weekly_cap' end,
             case when v_quiet                              then 'quiet_hours' end,
             case when j.t_release >= j.b_expires           then 'expires_first' end
           ]::text[], null)
         end,
         count(*) over ()
  from timed j
  -- The claim's own order: oldest broadcast first, then user.
  order by j.b_created, j.b_user, j.b_broadcast
  limit v_limit;
end;
$$;

comment on function public.admin_broadcast_queue(integer, integer, integer, integer, integer, integer, text, timestamptz, uuid) is
  'READ-ONLY view of the operator broadcast queue for /admin (migration-062): '
  'every queued or sending admin_broadcast_recipients row with its blockers and '
  'next eligible time, optionally for one student (p_user_id). Mirrors '
  'claim_admin_broadcast_pushes (migration-061); '
  'change both together. Errors when migration-061 is not applied.';

revoke execute on function public.admin_broadcast_queue(integer, integer, integer, integer, integer, integer, text, timestamptz, uuid) from public, anon, authenticated;
grant  execute on function public.admin_broadcast_queue(integer, integer, integer, integer, integer, integer, text, timestamptz, uuid) to service_role;


-- (3) Reminders. There is no recipients table (migration-060's header says
-- why), so the "queue" is the candidate set and its order: every student with a
-- profile and a student endpoint, which is exactly the set the claim's own
-- backfill would give a state row — LEFT JOINed here instead, because this
-- function may not insert it. Opted-out students are included and say so,
-- which answers "why is X never reminded?" directly.
--
-- Errors with 42703 when 060 is not applied (no reminder_opt_in /
-- last_reminder_at); Node reports that section as unavailable.
create or replace function public.admin_reminder_queue(
  p_limit              integer     default 50,
  p_min_interval_hours integer     default 72,
  p_cooldown_minutes   integer     default 240,
  p_daily_cap          integer     default 2,
  p_weekly_cap         integer     default 5,
  p_quiet_start        integer     default 22,
  p_quiet_end          integer     default 9,
  p_timezone           text        default 'America/New_York',
  p_now                timestamptz default now()
)
returns table (
  user_id          uuid,
  queue_position   integer,
  last_reminder_at timestamptz,
  last_push_at     timestamptz,
  has_push         boolean,
  next_eligible_at timestamptz,
  blockers         text[],
  total_candidates bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_now      timestamptz := coalesce(p_now, now());
  v_limit    integer     := least(greatest(coalesce(p_limit, 50), 1), 5000);
  v_cool     interval    := make_interval(mins  => greatest(coalesce(p_cooldown_minutes, 240), 0));
  v_interval interval    := make_interval(hours => greatest(coalesce(p_min_interval_hours, 72), 0));
  v_quiet    boolean;
begin
  v_quiet := public.admin_next_outside_quiet(v_now, p_quiet_start, p_quiet_end, p_timezone) > v_now;

  return query
  with cand as (
    select p.user_id as c_user
    from profiles p
    where exists (
      select 1 from push_subscriptions ps
      where ps.user_id = p.user_id and ps.role = 'student'
    )
  ),
  base as (
    select c.c_user                          as b_user,
           st.last_reminder_at               as b_last_rem,
           st.last_push_at                   as b_last_push,
           st.day_start                      as b_day_start,
           st.week_start                     as b_week_start,
           coalesce(st.push_opt_in, true)     as b_push_on,
           coalesce(st.reminder_opt_in, true) as b_rem_on,
           coalesce(st.day_count, 0)          as b_day_count,
           coalesce(st.week_count, 0)         as b_week_count
    from cand c
    left join student_notify_state st on st.user_id = c.c_user
  ),
  flags as (
    select b.*,
           (b.b_last_rem is not null and b.b_last_rem > v_now - v_interval) as f_interval,
           (b.b_last_push is not null and b.b_last_push > v_now - v_cool)   as f_cool,
           (b.b_day_start is not null
            and b.b_day_start > v_now - interval '24 hours'
            and b.b_day_count >= p_daily_cap)                               as f_daily,
           (b.b_week_start is not null
            and b.b_week_start > v_now - interval '7 days'
            and b.b_week_count >= p_weekly_cap)                             as f_weekly,
           -- The claim's queue order, verbatim: never-reminded first.
           (row_number() over (order by b.b_last_rem asc nulls first, b.b_user))::integer as f_pos,
           count(*) over ()                                                 as f_total
    from base b
  )
  select f.b_user,
         f.f_pos,
         f.b_last_rem,
         f.b_last_push,
         f.b_push_on,
         case
           when not f.b_push_on or not f.b_rem_on then null
           else public.admin_next_outside_quiet(
                  greatest(
                    v_now,
                    case when f.f_interval then f.b_last_rem + v_interval end,
                    case when f.f_cool     then f.b_last_push + v_cool end,
                    case when f.f_daily    then f.b_day_start + interval '24 hours' end,
                    case when f.f_weekly   then f.b_week_start + interval '7 days' end
                  ),
                  p_quiet_start, p_quiet_end, p_timezone)
         end,
         array_remove(array[
           case when not f.b_push_on then 'push_opt_out' end,
           case when not f.b_rem_on  then 'reminder_opt_out' end,
           case when f.f_interval    then 'interval' end,
           case when f.f_cool        then 'cooldown' end,
           case when f.f_daily       then 'daily_cap' end,
           case when f.f_weekly      then 'weekly_cap' end,
           case when v_quiet         then 'quiet_hours' end
         ]::text[], null),
         f.f_total
  from flags f
  order by f.f_pos
  limit v_limit;
end;
$$;

comment on function public.admin_reminder_queue(integer, integer, integer, integer, integer, integer, integer, text, timestamptz) is
  'READ-ONLY view of the reminder queue for /admin (migration-062): every '
  'student with a profile and a student push endpoint, in claim order '
  '(last_reminder_at nulls first), with blockers and next eligible time. '
  'Mirrors claim_reminder_pushes (migration-060) without its backfill insert. '
  'Errors when migration-060 is not applied.';

revoke execute on function public.admin_reminder_queue(integer, integer, integer, integer, integer, integer, integer, text, timestamptz) from public, anon, authenticated;
grant  execute on function public.admin_reminder_queue(integer, integer, integer, integer, integer, integer, integer, text, timestamptz) to service_role;


-- (4) One student's shared budget, for the Student lookup. Always one row for a
-- non-null id, state row or not (has_state says which), so "never notified" is
-- a readable answer rather than an empty card.
--
-- Optional columns (nearby_opt_in from 051, reminder_opt_in / last_reminder_at
-- from 060) are read through to_jsonb(row), so this works on a database that
-- has neither: a missing key reads as null and falls back to the default.
create or replace function public.admin_student_notify_budget(
  p_user_id          uuid,
  p_cooldown_minutes integer     default 240,
  p_daily_cap        integer     default 2,
  p_weekly_cap       integer     default 5,
  p_quiet_start      integer     default 22,
  p_quiet_end        integer     default 9,
  p_timezone         text        default 'America/New_York',
  p_now              timestamptz default now()
)
returns table (
  user_id          uuid,
  has_state        boolean,
  push_opt_in      boolean,
  email_opt_in     boolean,
  nearby_opt_in    boolean,
  reminder_opt_in  boolean,
  last_push_at     timestamptz,
  last_email_at    timestamptz,
  last_reminder_at timestamptz,
  day_count        integer,
  week_count       integer,
  day_resets_at    timestamptz,
  week_resets_at   timestamptz,
  cooldown_until   timestamptz,
  in_quiet_hours   boolean,
  quiet_ends_at    timestamptz,
  devices          integer,
  next_eligible_at timestamptz,
  blockers         text[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_now        timestamptz := coalesce(p_now, now());
  v_cool       interval    := make_interval(mins => greatest(coalesce(p_cooldown_minutes, 240), 0));
  v_j          jsonb;
  v_day_start  timestamptz;
  v_week_start timestamptz;
  v_raw_day    integer;
  v_raw_week   integer;
  v_daily      boolean;
  v_weekly     boolean;
  v_quiet_end  timestamptz;
begin
  if p_user_id is null then return; end if;

  select to_jsonb(s) into v_j from student_notify_state s where s.user_id = p_user_id;

  user_id          := p_user_id;
  has_state        := v_j is not null;
  v_j              := coalesce(v_j, '{}'::jsonb);
  push_opt_in      := coalesce((v_j ->> 'push_opt_in')::boolean, true);
  email_opt_in     := coalesce((v_j ->> 'email_opt_in')::boolean, true);
  nearby_opt_in    := coalesce((v_j ->> 'nearby_opt_in')::boolean, true);
  reminder_opt_in  := coalesce((v_j ->> 'reminder_opt_in')::boolean, true);
  last_push_at     := (v_j ->> 'last_push_at')::timestamptz;
  last_email_at    := (v_j ->> 'last_email_at')::timestamptz;
  last_reminder_at := (v_j ->> 'last_reminder_at')::timestamptz;
  v_day_start      := (v_j ->> 'day_start')::timestamptz;
  v_week_start     := (v_j ->> 'week_start')::timestamptz;
  v_raw_day        := coalesce((v_j ->> 'day_count')::integer, 0);
  v_raw_week       := coalesce((v_j ->> 'week_count')::integer, 0);

  -- EFFECTIVE counts: a window the claims would roll over on their next read
  -- counts as zero, so the card never shows "2 of 2 today" for a day that ended
  -- yesterday.
  if v_day_start is not null and v_day_start > v_now - interval '24 hours' then
    day_count     := v_raw_day;
    day_resets_at := v_day_start + interval '24 hours';
  else
    day_count     := 0;
    day_resets_at := null;
  end if;
  if v_week_start is not null and v_week_start > v_now - interval '7 days' then
    week_count     := v_raw_week;
    week_resets_at := v_week_start + interval '7 days';
  else
    week_count     := 0;
    week_resets_at := null;
  end if;

  cooldown_until := case
                      when last_push_at is not null and last_push_at > v_now - v_cool
                      then last_push_at + v_cool
                    end;
  v_daily  := day_resets_at  is not null and day_count  >= p_daily_cap;
  v_weekly := week_resets_at is not null and week_count >= p_weekly_cap;

  v_quiet_end    := public.admin_next_outside_quiet(v_now, p_quiet_start, p_quiet_end, p_timezone);
  in_quiet_hours := v_quiet_end > v_now;
  quiet_ends_at  := case when in_quiet_hours then v_quiet_end end;

  select count(*)::integer into devices
  from push_subscriptions ps
  where ps.user_id = p_user_id and ps.role = 'student';

  blockers := array_remove(array[
    case when not push_opt_in                 then 'push_opt_out' end,
    case when push_opt_in and devices = 0     then 'no_device' end,
    case when cooldown_until is not null      then 'cooldown' end,
    case when v_daily                         then 'daily_cap' end,
    case when v_weekly                        then 'weekly_cap' end,
    case when in_quiet_hours                  then 'quiet_hours' end
  ]::text[], null);

  next_eligible_at := case
    when not push_opt_in or devices = 0 then null
    else public.admin_next_outside_quiet(
           greatest(
             v_now,
             cooldown_until,
             case when v_daily  then day_resets_at end,
             case when v_weekly then week_resets_at end
           ),
           p_quiet_start, p_quiet_end, p_timezone)
  end;

  return next;
end;
$$;

comment on function public.admin_student_notify_budget(uuid, integer, integer, integer, integer, integer, text, timestamptz) is
  'READ-ONLY summary of one student''s shared notification budget for /admin '
  '(migration-062): switches, effective day/week counts and when they reset, '
  'cooldown, quiet hours, device count, blockers and next eligible push time. '
  'One row even with no student_notify_state row (has_state = false). Works '
  'with or without migrations 051/060.';

revoke execute on function public.admin_student_notify_budget(uuid, integer, integer, integer, integer, integer, text, timestamptz) from public, anon, authenticated;
grant  execute on function public.admin_student_notify_budget(uuid, integer, integer, integer, integer, integer, text, timestamptz) to service_role;

commit;

-- ---------- 6. daily prune (best-effort, outside the transaction) ----------
-- migration-032's shape: the function always installs, the schedule is
-- optional so the migration still succeeds without pg_cron. Unscheduled first
-- so a re-paste replaces the job rather than adding a second one (older pg_cron
-- versions do not upsert by name).
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'prune-notification-log';
  perform cron.schedule(
    'prune-notification-log',
    '17 4 * * *',                       -- daily at 04:17 UTC, off-peak
    $cron$ select public.prune_notification_log(30); $cron$
  );
  raise notice 'Scheduled daily notification log prune (job: prune-notification-log).';
exception when others then
  raise notice 'pg_cron not available (%). Enable it (Dashboard -> Database -> Extensions), then re-run this DO block, or call prune_notification_log() on a schedule yourself.', sqlerrm;
end;
$$;

notify pgrst, 'reload schema';

-- ============================================================
-- POST-RUN CHECKS (run by hand)
--
--   -- the backfill landed, by kind:
--   select kind, outcome, count(*) from notification_log group by 1, 2 order by 1, 2;
--
--   -- the queue functions answer (all three should return rows or nothing, never an error):
--   select * from admin_campaign_queue(p_limit => 5);
--   select * from admin_broadcast_queue(p_limit => 5);   -- errors if 061 is not applied
--   select * from admin_campaign_queue(p_user_id => '<student uuid>');   -- one student
--   select * from admin_reminder_queue(p_limit => 5);    -- errors if 060 is not applied
--
--   -- the prune is scheduled:
--   select jobname, schedule from cron.job where jobname = 'prune-notification-log';
--
--   -- anon cannot read it (expect false):
--   select has_table_privilege('anon', 'public.notification_log', 'select');
-- ============================================================
