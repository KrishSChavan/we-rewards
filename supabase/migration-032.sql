-- ============================================================
-- Migration 032 — vendor campaigns (deals / notices) + storm-proof delivery.
--   notes.md ADD #2: let a vendor push "2x points this weekend" to their best
--   customers. The naive version of this feature is a Send button that loops
--   over 100 students and calls web-push inline. That version is why this file
--   is long.
--
--   THE PROBLEM IT EXISTS TO SOLVE
--   A vendor's "top 100" is ranked by how often that student comes back. The
--   tier model (src/lib/tiers.js) pays its biggest bonus for BREADTH — the
--   synergy term is cbrt(B*L*S), so a student who only ever visits one spot
--   scores near zero. The students who rank top-100 anywhere are therefore, by
--   construction, the students who rank top-100 almost EVERYWHERE. Five vendors
--   sending a Friday 5pm deal do not hit five disjoint audiences; they hit one
--   heavily-overlapping core, and the most valuable students in the network get
--   five notifications inside a minute.
--
--   That is not merely annoying. Browser notification permission is one-shot:
--   once a student taps Block, Notification.requestPermission() no-ops forever
--   and the channel is gone for good. A storm permanently burns the exact
--   people it was aimed at, and on iOS (where PWA push is already fragile, see
--   notes.md IMPROVE #4) it gets the PWA deleted off the home screen.
--
--   THE FIX, IN LAYERS (each independently sufficient to bound the damage)
--     1. Vendors never send. They ENQUEUE. Nothing leaves the process on the
--        request that created it; a worker (src/lib/campaigns.js) decides what
--        each student actually receives.
--     2. Per-student cooldown + daily/weekly caps, held in student_notify_state
--        and consumed under a row lock in claim_campaign_pushes(). This is the
--        hard guarantee: whatever N vendors do, a student cannot receive two
--        notifications closer together than the cooldown. Five simultaneous
--        campaigns can only ever produce ONE chirp.
--     3. Coalescing. Because delivery is held for a few minutes, the claim can
--        take EVERY campaign that is due for a student and hand the worker one
--        bundle. Two or more become a single digest notification ("3 spots have
--        something on") that opens an in-app list. So layer 2 does not silently
--        eat the 2nd..5th vendor; layer 3 delivers them in the same breath.
--     4. Per-vendor-per-student cooldown, so one chatty vendor cannot spend a
--        student's whole daily quota, and a bundle never names one vendor twice.
--     5. Quiet hours in the campus timezone, so a bar's 1am deal waits for
--        morning rather than being dropped or, worse, delivered.
--     6. A per-vendor weekly send quota, which fixes the problem at the source:
--        scarcity makes vendors spend sends on offers worth sending.
--
--   WHAT IS DELIBERATELY NOT THROTTLED
--   The in-app inbox. Every targeted student gets a campaign_recipients row the
--   moment the campaign is created, and the student app lists it immediately.
--   Suppression here only ever removes the INTERRUPTION, never the message —
--   which is what makes throttling this aggressively safe for vendors.
--
--   PRIVACY. A vendor never learns who is in their audience. The audience is
--   expanded server-side into campaign_recipients; the terminal only ever sees
--   a count. (Privacy Policy §"Marketing communications" — updated alongside
--   this migration, TERMS_VERSION bumped.)
--
--   POINTS GUARD (migration-025): nothing here writes point_balances or
--   transactions, so no function below needs the app.points_write GUC. The two
--   money tables are read-only inputs to the audience query.
--
-- Run in the Supabase SQL Editor after migration-031 (safe to re-run).
-- ============================================================

begin;

-- ---------- 1. push_subscriptions grows a second population ----------
--
-- migration-018 built this table for admin browsers. Students now subscribe
-- too, from a DIFFERENT service worker scope (/sw.js vs /admin/sw.js), so their
-- endpoints never collide with an operator's. `role` is what keeps the two
-- populations from being handed each other's notifications: notifyAdmins()
-- filters role='admin', campaign delivery filters role='student'.
--
-- Default 'admin' so every existing row keeps its meaning with no backfill.

alter table public.push_subscriptions
  add column if not exists role text not null default 'admin';

do $$
begin
  alter table public.push_subscriptions
    add constraint push_subscriptions_role_check check (role in ('admin', 'student'));
exception when duplicate_object then null;
end;
$$;

-- The delivery worker asks "does this student have any live endpoint?" on every
-- tick, and the fan-out asks "give me this student's endpoints".
create index if not exists idx_push_subs_user_role
  on public.push_subscriptions (user_id, role);

-- ---------- 2. the campaign a vendor composes ----------

create table if not exists public.vendor_campaigns (
  id             uuid primary key default gen_random_uuid(),
  vendor_id      uuid not null references public.vendors (id) on delete cascade,
  created_by     uuid,                       -- vendor_staff user; best-effort, no FK
  title          text not null,
  body           text not null,
  kind           text not null default 'deal' check (kind in ('deal', 'event', 'notice')),
  audience       text not null default 'top' check (audience in ('top', 'lapsed', 'close')),
  audience_size  integer not null default 100,
  status         text not null default 'queued' check (status in ('queued', 'done', 'cancelled')),
  -- Idempotency, same contract as award_points' client_token (migration-019): a
  -- terminal that retries after a network drop must not send twice to 100 people.
  client_token   text,
  -- Nothing is delivered before this. The hold is what makes coalescing
  -- possible at all: with instant send there is no window in which a second
  -- vendor's campaign can join the first one's notification.
  deliver_after  timestamptz not null default now(),
  -- Governs BOTH the inbox (a deal stops being shown) and delivery (a push
  -- still queued at this point is abandoned, not delivered stale).
  expires_at     timestamptz not null,
  queued_count   integer not null default 0,   -- students targeted
  sent_count     integer not null default 0,   -- students actually pushed
  created_at     timestamptz not null default now()
);

create index if not exists idx_campaigns_vendor_time
  on public.vendor_campaigns (vendor_id, created_at desc);

-- One campaign per (vendor, idempotency token). Partial so untokened sends are
-- unconstrained.
create unique index if not exists idx_campaigns_client_token
  on public.vendor_campaigns (vendor_id, client_token)
  where client_token is not null;

alter table public.vendor_campaigns enable row level security;
-- no policies: server (service role) only. Vendors read theirs through
-- /api/vendor/campaigns, students never read this table directly.

-- ---------- 3. the delivery ledger, which is also the student's inbox ----------
--
-- One row per (campaign, student). Written in full at creation time, so the
-- in-app list is instant and complete even when push is suppressed, blocked,
-- or unconfigured.

create table if not exists public.campaign_recipients (
  campaign_id   uuid not null references public.vendor_campaigns (id) on delete cascade,
  user_id       uuid not null references public.profiles (user_id) on delete cascade,
  -- queued   : waiting for a delivery slot
  -- sending  : claimed by a worker, push in flight
  -- sent     : a notification went out carrying this campaign
  -- expired  : the campaign died before a slot opened (still readable in-app
  --            until expires_at, then pruned)
  status        text not null default 'queued'
                check (status in ('queued', 'sending', 'sent', 'expired')),
  deliver_after timestamptz not null,
  push_batch    uuid,          -- groups the campaigns that shared one notification
  claimed_at    timestamptz,
  pushed_at     timestamptz,
  read_at       timestamptz,   -- student opened the in-app deals list
  opened_at     timestamptz,   -- student tapped through to the vendor
  primary key (campaign_id, user_id)
);

-- The claim's driving scan.
create index if not exists idx_recipients_due
  on public.campaign_recipients (status, deliver_after);
-- The inbox read, and the per-vendor cooldown lookup.
create index if not exists idx_recipients_user
  on public.campaign_recipients (user_id, status, pushed_at desc);

alter table public.campaign_recipients enable row level security;
-- no policies: server only (students read via /api/me/deals).

-- ---------- 4. the throttle state, one row per student ----------
--
-- Deliberately O(1): a cooldown timestamp plus two fixed windows, instead of
-- counting rows in campaign_recipients. The fixed windows are safe BECAUSE of
-- the cooldown — a window rollover at midnight cannot bunch four notifications
-- together when no two may be closer than the cooldown apart.

create table if not exists public.student_notify_state (
  user_id      uuid primary key references public.profiles (user_id) on delete cascade,
  -- The student's own switch (Account → Deal alerts). Governs PUSH only; the
  -- in-app inbox is never suppressed by it.
  push_opt_in  boolean not null default true,
  last_push_at timestamptz,
  day_start    timestamptz,
  day_count    integer not null default 0,
  week_start   timestamptz,
  week_count   integer not null default 0,
  updated_at   timestamptz not null default now()
);

alter table public.student_notify_state enable row level security;
-- no policies: server only.

-- ---------- 5. who a campaign reaches ----------
--
-- Ranked entirely from transactions, which is the source of truth everywhere
-- else in this app (the user_scores cache is a snapshot, not an authority).
--
-- A "visit" is one DAY at this vendor, not one transaction — the same
-- anti-farming collapse scoreProfile() uses in src/lib/tiers.js, so three
-- awards during one lunch rush count once and a cashier cannot inflate a
-- regular into the top 100 by splitting a ticket.
--
--   top    — the vendor's regulars: most visit-days in the last 90, ties broken
--            by spend then recency. The default, and what "top 100" means.
--   lapsed — came back at least twice, then stopped: nothing in 30 days.
--   close  — has points at this vendor between 50% and 100% of its cheapest
--            active points-priced reward. The highest-converting audience there
--            is ("you're 40 pts from a free coffee", notes.md ADD #2).
--
-- Students without a profiles row (signed in, never consented — migration-022)
-- are excluded by the join.

create or replace function public.campaign_audience(
  p_vendor_id uuid,
  p_audience  text default 'top',
  p_limit     integer default 100
)
returns table (user_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
begin
  if p_audience = 'lapsed' then
    return query
      select v.uid
      from (
        select t.user_id as uid,
               count(distinct (t.created_at at time zone 'UTC')::date) as visit_days,
               max(t.created_at) as last_seen
        from transactions t
        where t.vendor_id = p_vendor_id
          and t.type = 'earn'
          and t.user_id is not null
          and t.created_at >= now() - interval '180 days'
        group by t.user_id
      ) v
      join profiles p on p.user_id = v.uid
      where v.visit_days >= 2
        and v.last_seen < now() - interval '30 days'
      order by v.visit_days desc, v.last_seen desc
      limit v_limit;

  elsif p_audience = 'close' then
    return query
      with cheapest as (
        select min(r.cost_in_points) as cost
        from rewards r
        where r.vendor_id = p_vendor_id
          and r.active = true
          and r.cost_in_points is not null
      )
      select b.user_id
      from point_balances b
      join profiles p on p.user_id = b.user_id
      cross join cheapest c
      where b.vendor_id = p_vendor_id
        and c.cost is not null
        and b.balance >= ceil(c.cost * 0.5)
        and b.balance < c.cost
      order by b.balance desc, b.updated_at desc
      limit v_limit;

  else   -- 'top'
    return query
      select v.uid
      from (
        select t.user_id as uid,
               count(distinct (t.created_at at time zone 'UTC')::date) as visit_days,
               sum(coalesce(t.dollar_amount, 0)) as spend,
               max(t.created_at) as last_seen
        from transactions t
        where t.vendor_id = p_vendor_id
          and t.type = 'earn'
          and t.user_id is not null
          and t.created_at >= now() - interval '90 days'
        group by t.user_id
      ) v
      join profiles p on p.user_id = v.uid
      order by v.visit_days desc, v.spend desc, v.last_seen desc
      limit v_limit;
  end if;
end;
$$;

-- ---------- 6. enqueue a campaign ----------
--
-- Atomic: the weekly quota is checked under a lock on the vendors row, so two
-- terminals tapping Send at once cannot both squeeze past the last slot.
-- Idempotent on (vendor, client_token) — a retry returns the ORIGINAL campaign
-- rather than fanning out to 100 students a second time.

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
                   and c2.status <> 'cancelled'
                   and c2.created_at >= now() - interval '7 days')),
               true
        from vendor_campaigns c where c.id = v_id;
      return;
    end if;
  end if;

  select count(*)::integer into v_used
  from vendor_campaigns
  where vendor_id = p_vendor_id
    and status <> 'cancelled'
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

-- ---------- 7. the claim: what a student may receive right now ----------
--
-- Returns at most ONE bundle per student. Everything a student is owed that is
-- due travels in that bundle (up to p_bundle_max vendors); the rest stays
-- queued for a later slot or lapses into the inbox at expiry.
--
-- Quota is consumed HERE, under a per-student row lock taken with SKIP LOCKED —
-- two workers (or an overlapping tick) can never both claim the same student,
-- so the cooldown holds even without a distributed lock. Rows are left in
-- 'sending'; the worker calls finish_campaign_batch() to settle them.
--
-- p_skip_users lets the worker exclude students who are looking at the app
-- right now (a live socket): interrupting them is pointless, and burning their
-- daily quota to do it is worse. They see the deal in-app instead.

create or replace function public.claim_campaign_pushes(
  p_max_users             integer default 40,
  p_skip_users            uuid[]  default '{}',
  p_cooldown_minutes      integer default 240,
  p_daily_cap             integer default 2,
  p_weekly_cap            integer default 5,
  p_vendor_cooldown_hours integer default 20,
  p_bundle_max            integer default 4,
  p_quiet_start           integer default 22,
  p_quiet_end             integer default 9,
  p_timezone              text    default 'America/New_York'
)
returns table (out_user_id uuid, out_batch uuid, out_items jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  u          record;
  st         student_notify_state%rowtype;
  v_batch    uuid;
  v_claimed  integer;
  v_hour     integer;
  v_day_start  timestamptz;
  v_week_start timestamptz;
begin
  -- Housekeeping first: anything whose campaign outlived its window stops being
  -- deliverable. Cheap and indexed; keeps the driving scan from re-reading dead
  -- rows on every tick.
  update campaign_recipients r
  set status = 'expired'
  from vendor_campaigns c
  where c.id = r.campaign_id
    and r.status = 'queued'
    and c.expires_at <= now();

  -- A stuck 'sending' row (worker died mid-push) returns to the queue rather
  -- than being stranded. The quota it consumed is NOT refunded — see
  -- finish_campaign_batch for why that asymmetry is deliberate.
  update campaign_recipients
  set status = 'queued', push_batch = null, claimed_at = null
  where status = 'sending' and claimed_at < now() - interval '10 minutes';

  -- Quiet hours, campus-local. Nothing is claimed; queued work simply waits for
  -- the window to open, at which point coalescing turns a night's accumulation
  -- into one morning digest rather than a 9am volley.
  v_hour := extract(hour from (now() at time zone p_timezone))::integer;
  if p_quiet_start = p_quiet_end then
    null;                                              -- quiet hours disabled
  elsif p_quiet_start > p_quiet_end then               -- window wraps midnight
    if v_hour >= p_quiet_start or v_hour < p_quiet_end then return; end if;
  else
    if v_hour >= p_quiet_start and v_hour < p_quiet_end then return; end if;
  end if;

  -- The driving query must select only students who will ACTUALLY produce a
  -- bundle. It costs a duplicate of the eligibility rules below, and it is not
  -- optional: this is ordered oldest-first and capped at p_max_users, so a
  -- student who is picked and then skipped inside the loop still consumes one
  -- of those slots. Let blocked students through here and the head of the queue
  -- fills with people who cannot be delivered to, every tick, for as long as
  -- their cooldown lasts — starving everyone behind them. Every `continue`
  -- inside the loop is therefore a belt-and-braces race guard, not the fence.
  for u in
    select r.user_id as uid
    from campaign_recipients r
    join vendor_campaigns c on c.id = r.campaign_id
    where r.status = 'queued'
      and r.deliver_after <= now()
      and c.expires_at > now()
      and not (r.user_id = any(coalesce(p_skip_users, '{}'::uuid[])))
      -- No endpoint, no claim. A student who never granted permission would
      -- otherwise sit at the head of the queue forever.
      and exists (
        select 1 from push_subscriptions ps
        where ps.user_id = r.user_id and ps.role = 'student'
      )
      -- Opted out, inside the cooldown, or capped out for the day/week.
      and not exists (
        select 1 from student_notify_state s
        where s.user_id = r.user_id
          and (
            s.push_opt_in = false
            or (s.last_push_at is not null
                and s.last_push_at > now() - make_interval(mins => greatest(p_cooldown_minutes, 0)))
            or (s.day_start  > now() - interval '24 hours' and s.day_count  >= p_daily_cap)
            or (s.week_start > now() - interval '7 days'   and s.week_count >= p_weekly_cap)
          )
      )
      -- Heard from this vendor too recently. Without this, a student whose only
      -- queued deal is a repeat from one vendor holds a slot for the whole
      -- per-vendor cooldown.
      and not exists (
        select 1
        from campaign_recipients r2
        join vendor_campaigns c2 on c2.id = r2.campaign_id
        where r2.user_id = r.user_id
          and r2.status = 'sent'
          and c2.vendor_id = c.vendor_id
          and r2.pushed_at > now() - make_interval(hours => greatest(p_vendor_cooldown_hours, 0))
      )
    group by r.user_id
    order by min(r.deliver_after)
    limit greatest(p_max_users, 1)
  loop
    insert into student_notify_state (user_id) values (u.uid) on conflict do nothing;

    select * into st from student_notify_state
    where user_id = u.uid
    for update skip locked;
    if not found then continue; end if;             -- another worker owns them

    if not st.push_opt_in then continue; end if;

    -- THE hard guarantee. Everything else is optimisation.
    if st.last_push_at is not null
       and st.last_push_at > now() - make_interval(mins => greatest(p_cooldown_minutes, 0))
    then
      continue;
    end if;

    v_day_start  := st.day_start;
    v_week_start := st.week_start;
    if v_day_start is null or v_day_start <= now() - interval '24 hours' then
      v_day_start := now(); st.day_count := 0;
    end if;
    if v_week_start is null or v_week_start <= now() - interval '7 days' then
      v_week_start := now(); st.week_count := 0;
    end if;
    if st.day_count >= p_daily_cap or st.week_count >= p_weekly_cap then continue; end if;

    v_batch := gen_random_uuid();

    with eligible as (
      select r.campaign_id, c.vendor_id, r.deliver_after, c.created_at
      from campaign_recipients r
      join vendor_campaigns c on c.id = r.campaign_id
      where r.user_id = u.uid
        and r.status = 'queued'
        and r.deliver_after <= now()
        and c.expires_at > now()
        -- One chatty vendor may not spend this student's whole quota.
        and not exists (
          select 1
          from campaign_recipients r2
          join vendor_campaigns c2 on c2.id = r2.campaign_id
          where r2.user_id = u.uid
            and r2.status = 'sent'
            and c2.vendor_id = c.vendor_id
            and r2.pushed_at > now() - make_interval(hours => greatest(p_vendor_cooldown_hours, 0))
        )
    ),
    -- ...nor appear twice in one bundle.
    per_vendor as (
      select distinct on (vendor_id) campaign_id, deliver_after, created_at
      from eligible
      order by vendor_id, deliver_after, created_at
    ),
    pick as (
      select campaign_id from per_vendor
      order by deliver_after, created_at
      limit greatest(p_bundle_max, 1)
    )
    update campaign_recipients r
    set status = 'sending', push_batch = v_batch, claimed_at = now()
    from pick
    where r.campaign_id = pick.campaign_id and r.user_id = u.uid;

    get diagnostics v_claimed = row_count;
    -- Everything due was from a vendor still in cooldown: leave it queued and
    -- do NOT spend the student's slot on an empty bundle.
    if v_claimed = 0 then continue; end if;

    update student_notify_state
    set last_push_at = now(),
        day_start    = v_day_start,
        day_count    = st.day_count + 1,
        week_start   = v_week_start,
        week_count   = st.week_count + 1,
        updated_at   = now()
    where user_id = u.uid;

    out_user_id := u.uid;
    out_batch   := v_batch;
    select jsonb_agg(
             jsonb_build_object(
               'campaignId', r.campaign_id,
               'vendorId',   c.vendor_id,
               'vendor',     v.name,
               'title',      c.title,
               'body',       c.body,
               'kind',       c.kind,
               'hasLogo',    v.has_logo
             ) order by c.created_at
           )
      into out_items
    from campaign_recipients r
    join vendor_campaigns c on c.id = r.campaign_id
    join vendors v on v.id = c.vendor_id
    where r.user_id = u.uid and r.push_batch = v_batch;

    return next;
  end loop;
end;
$$;

-- ---------- 8. settle a claimed batch ----------
--
-- p_ok=false returns the rows to the queue but does NOT refund the quota. The
-- asymmetry is on purpose: a refund path is a way to double-notify (settle
-- failure, re-claim, first push turns out to have landed after all), and the
-- only common cause of total failure is every endpoint being dead — in which
-- case the 404/410 prune in src/lib/push.js removes them and the student stops
-- being claimed at all.

create or replace function public.finish_campaign_batch(
  p_batch uuid,
  p_ok    boolean default true
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
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
    update campaign_recipients
    set status = 'queued', push_batch = null, claimed_at = null
    where push_batch = p_batch and status = 'sending';
    get diagnostics n = row_count;
  end if;
  return n;
end;
$$;

-- ---------- 9. retention ----------
--
-- Campaigns are short-lived marketing, not an audit trail. Drop them (and their
-- recipient rows, by cascade) once they are well past expiry.

create or replace function public.prune_campaigns(p_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from vendor_campaigns
  where expires_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------- 10. grants (migration-007 convention: service_role only) ----------

revoke execute on function public.campaign_audience(uuid, text, integer) from public, anon, authenticated;
grant  execute on function public.campaign_audience(uuid, text, integer) to service_role;

revoke execute on function public.create_campaign(uuid, uuid, text, text, text, text, integer, text, integer, integer, integer) from public, anon, authenticated;
grant  execute on function public.create_campaign(uuid, uuid, text, text, text, text, integer, text, integer, integer, integer) to service_role;

revoke execute on function public.claim_campaign_pushes(integer, uuid[], integer, integer, integer, integer, integer, integer, integer, text) from public, anon, authenticated;
grant  execute on function public.claim_campaign_pushes(integer, uuid[], integer, integer, integer, integer, integer, integer, integer, text) to service_role;

revoke execute on function public.finish_campaign_batch(uuid, boolean) from public, anon, authenticated;
grant  execute on function public.finish_campaign_batch(uuid, boolean) to service_role;

revoke execute on function public.prune_campaigns(integer) from public, anon, authenticated;
grant  execute on function public.prune_campaigns(integer) to service_role;

commit;

-- ---------- 11. daily prune (best-effort, outside the transaction) ----------
-- Same shape as migration-021: the function always installs, the schedule is
-- optional so the migration still succeeds without pg_cron.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule(
    'prune-campaigns',
    '41 4 * * *',                       -- daily at 04:41 UTC, off-peak
    $cron$ select public.prune_campaigns(30); $cron$
  );
  raise notice 'Scheduled daily campaign prune (job: prune-campaigns).';
exception when others then
  raise notice 'pg_cron not available (%). Enable it (Dashboard -> Database -> Extensions), then re-run this DO block, or call prune_campaigns() on a schedule yourself.', sqlerrm;
end;
$$;

notify pgrst, 'reload schema';

-- ============================================================
-- POST-RUN CHECKS (run by hand)
--
--   -- the two populations are separated:
--   select role, count(*) from push_subscriptions group by 1;   -- all 'admin' pre-launch
--
--   -- a vendor's top 100, without seeing who they are:
--   select count(*) from campaign_audience('<vendor-uuid>', 'top', 100);
--
--   -- no student can ever hold two bundles at once:
--   select push_batch, count(distinct user_id) from campaign_recipients
--   where push_batch is not null group by 1 having count(distinct user_id) > 1;  -- expect 0
--
--   -- the cooldown is actually holding (no two pushes closer than it):
--   select user_id, pushed_at, lag(pushed_at) over (partition by user_id order by pushed_at)
--   from campaign_recipients where status = 'sent';
-- ============================================================
