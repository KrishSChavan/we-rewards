-- ============================================================
-- Migration 061 — operator broadcasts: one message, chosen by us, to students.
--
--   WHAT IT IS. Every student-facing notification before this one is composed by
--   somebody who is not WeRewards, or by nobody at all: a vendor writes a deal
--   (migration-032/047), proximity writes a nearby alert (migration-051), and
--   the absence of activity writes a reminder (migration-060). There has been no
--   way for the operator to say anything — not "six new spots just joined", not
--   "the terminal is down this evening", not "redeem by Friday". This adds that
--   one path, from the /admin Broadcast tab.
--
--   THE BUDGET IS SHARED, and it is shared for the same reason migration-051 and
--   migration-060 share it, so the shape below is copied rather than reinvented.
--   claim_admin_broadcast_pushes reads AND writes
--   student_notify_state.last_push_at / day_start / day_count / week_start /
--   week_count — the same counters all three sibling claims use. A broadcast
--   therefore SPENDS a deal-alert slot and a reminder slot, and vice versa.
--
--   An exemption was the obvious alternative and it is wrong, for a reason that
--   is written down in a document students can read. Privacy Policy §7.4 says,
--   in these words: "Two per day is the total number of times WeRewards will
--   interrupt you, whatever the reason." An operator broadcast that skipped the
--   caps would make that sentence false, and it is the sentence most likely to
--   be quoted back at us. "Whatever the reason" includes our own reasons.
--
--   It also respects push_opt_in and quiet hours, for the same reason: those are
--   promises, not conveniences.
--
--   WHY A QUEUE RATHER THAN A SEND. The operator presses one button and may be
--   addressing the whole student body. Three things follow. A web request cannot
--   hold a few thousand sequential pushes open; a dyno restart mid-send (Heroku
--   cycles them daily, and every deploy is one) must not lose or duplicate the
--   back half; and a push service will rate-limit a parallel burst from one
--   origin, which is a spent budget with nothing delivered. So this writes
--   recipient rows and hands them to a worker, exactly as migration-032 does for
--   vendor deals — and for the same reason the recipient rows are written IN FULL
--   at creation time: the operator's audience count is then a fact about what was
--   queued rather than an estimate of what might be.
--
--   WHAT IT DOES NOT DO. There is no in-app list for broadcasts (a deal has
--   #deals-modal; this has nowhere), no email fallback (migration-047's exists
--   because a deal is news a student can act on later — an announcement that
--   missed its push has usually missed its moment), and no per-student
--   personalisation. A broadcast is one set of words for everyone it reaches.
--
--   INDEPENDENT OF MIGRATION-060. Everything read here comes from
--   migration-032's student_notify_state, so this applies and works whether or
--   not the reminder migration has been run.
--
--   Safe to re-run: every statement is guarded.
-- ============================================================

begin;

-- ---------- 1. the broadcast itself ----------

create table if not exists public.admin_broadcasts (
  id             uuid primary key default gen_random_uuid(),
  -- The operator who sent it. NO FK, deliberately, and the same call
  -- push_subscriptions.user_id makes: this is an audit trail, and a record of
  -- who addressed the student body must outlive the account that did it.
  created_by     uuid,
  title          text not null,
  body           text not null,
  -- Where tapping it goes. Null means the app's home screen; anything else is
  -- validated as a same-origin path by the route before it reaches here, never
  -- by this column, because a check constraint cannot be fixed without a
  -- migration and URL shapes are exactly the thing that changes.
  url            text,
  audience       text not null default 'all'
                 check (audience in ('all', 'lapsed', 'spendable', 'vendor')),
  -- Only meaningful for audience = 'vendor'. on delete set null rather than
  -- cascade: deleting a spot must not delete the record that we once messaged
  -- its customers.
  vendor_id      uuid references public.vendors (id) on delete set null,
  status         text not null default 'queued'
                 check (status in ('queued', 'done', 'cancelled')),
  queued_count   integer not null default 0,
  sent_count     integer not null default 0,
  -- Idempotency for a double-tapped Send, the same mechanism
  -- vendor_campaigns.client_token provides. A partial unique index rather than a
  -- column constraint so rows without a token are unconstrained.
  client_token   text,
  -- After this, undelivered recipients are expired rather than sent. An
  -- announcement is time-bound by nature: a student whose four-hour cooldown and
  -- daily cap kept them out of the queue for a week does not want last week's
  -- news, and without this they would get it the moment a slot opened.
  expires_at     timestamptz not null default now() + interval '48 hours',
  created_at     timestamptz not null default now()
);

comment on table public.admin_broadcasts is
  'One operator-composed push to a chosen student audience (migration-061). '
  'Recipients are materialised into admin_broadcast_recipients at creation; '
  'delivery is a worker draining that queue under the SHARED '
  'student_notify_state budget, so a broadcast costs a deal-alert slot.';

create unique index if not exists idx_admin_broadcast_token
  on public.admin_broadcasts (created_by, client_token)
  where client_token is not null;

create index if not exists idx_admin_broadcast_status
  on public.admin_broadcasts (status, expires_at);

alter table public.admin_broadcasts enable row level security;
-- No policies, on purpose: service_role only, like every other operator table
-- here. A student's anon key must never be able to read what we are about to
-- send, let alone who is in an audience.


-- ---------- 2. who it is going to ----------

create table if not exists public.admin_broadcast_recipients (
  broadcast_id uuid not null references public.admin_broadcasts (id) on delete cascade,
  user_id      uuid not null references public.profiles (user_id) on delete cascade,
  status       text not null default 'queued'
               check (status in ('queued', 'sending', 'sent', 'expired')),
  claimed_at   timestamptz,
  pushed_at    timestamptz,
  primary key (broadcast_id, user_id)
);

comment on table public.admin_broadcast_recipients is
  'The queue. One row per student per broadcast, written in full by '
  'create_admin_broadcast so the operator''s count is what was queued rather '
  'than an estimate. PK (broadcast_id, user_id) is also the guard that one '
  'student cannot be sent one broadcast twice.';

-- The driving index for the claim: it scans for queued rows and nothing else,
-- so status leads.
create index if not exists idx_admin_broadcast_recipients_due
  on public.admin_broadcast_recipients (status, broadcast_id);

alter table public.admin_broadcast_recipients enable row level security;


-- ---------- 3. resolving an audience ----------
--
-- Campus-wide, which is what makes this a different function from
-- migration-032's campaign_audience rather than a call to it. That one answers
-- "which of THIS VENDOR'S customers", is capped at 100 because no vendor should
-- be able to address the student body, and takes a vendor id as its first
-- argument. An operator legitimately does address everybody, so the cap here is
-- a sanity bound rather than a policy one.
--
-- Joining profiles is how a student who signed in but never consented
-- (migration-022) is excluded: they have an auth.users row and no profile, and
-- consent is exactly what we do not have from them.
--
-- `is_vendor` accounts are INCLUDED. A dual-role account (migration-035) is
-- still a student who earns and redeems; excluding them would quietly drop staff
-- who use the app on their day off, and they can opt out like anyone else.

create or replace function public.admin_broadcast_audience(
  p_audience  text    default 'all',
  p_vendor_id uuid    default null,
  p_limit     integer default 20000
)
returns table (user_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- 20000 is a guard against a typo, not a product rule: it is far above any
  -- plausible campus student body and far below anything that would strain the
  -- insert below. greatest(), so a null or 0 cannot mean "no limit".
  v_limit integer := least(greatest(coalesce(p_limit, 20000), 1), 20000);
begin
  if p_audience = 'vendor' then
    -- Everyone who has ever EARNED at this spot. Not "redeemed", not "visited":
    -- earning is the one event that proves they were a paying customer there,
    -- which is what makes a message about that spot relevant to them.
    if p_vendor_id is null then return; end if;
    return query
      select distinct t.user_id
      from transactions t
      join profiles p on p.user_id = t.user_id
      where t.vendor_id = p_vendor_id
        and t.type = 'earn'
        and t.user_id is not null
      limit v_limit;

  elsif p_audience = 'lapsed' then
    -- Earned at least once, anywhere, and nothing at all in 30 days. Campus-wide
    -- rather than per-vendor (migration-032's 'lapsed' is per-vendor and also
    -- requires two visits to that one spot): here the question is whether the
    -- student has stopped using WeRewards, not whether they stopped using one
    -- cafe. `not exists` rather than a max(created_at) < cutoff, so a student
    -- whose only recent row is a community_transfer still counts as active.
    return query
      select p.user_id
      from profiles p
      where exists (
        select 1 from transactions t
        where t.user_id = p.user_id and t.type = 'earn'
      )
      and not exists (
        select 1 from transactions t
        where t.user_id = p.user_id
          and t.created_at >= now() - interval '30 days'
      )
      limit v_limit;

  elsif p_audience = 'spendable' then
    -- Students who could walk in and redeem something RIGHT NOW. The whole
    -- reason this audience exists: the problem this product has is not signups,
    -- it is that people who already own enough points never spend them.
    --
    -- Pooled spots (migration-044) are read through the same purse rule the app
    -- uses, so a student whose points are in a chain's shared purse is not
    -- missed. point_balances for an unpooled vendor, pool_balances for a pooled
    -- one; `exists` stops at the first affordable reward rather than ranking.
    return query
      select p.user_id
      from profiles p
      where exists (
        select 1
        from rewards r
        join vendors v on v.id = r.vendor_id
        left join point_balances b
          on b.user_id = p.user_id and b.vendor_id = v.id and v.pool_id is null
        left join pool_balances pb
          on pb.user_id = p.user_id and pb.pool_id = v.pool_id and v.pool_id is not null
        where r.active = true
          and v.active = true
          and r.cost_in_points is not null
          and coalesce(
                case when v.pool_id is null then b.balance else pb.balance end,
                0
              ) >= r.cost_in_points
      )
      limit v_limit;

  else   -- 'all'
    return query
      select p.user_id from profiles p limit v_limit;
  end if;
end;
$$;

comment on function public.admin_broadcast_audience(text, uuid, integer) is
  'Candidate user ids for an operator broadcast audience (migration-061). '
  'Advisory and campus-wide: reachability (push_opt_in, a live subscription) '
  'and the shared frequency budget are decided later, at claim time.';

revoke execute on function public.admin_broadcast_audience(text, uuid, integer) from public, anon, authenticated;
grant  execute on function public.admin_broadcast_audience(text, uuid, integer) to service_role;


-- ---------- 4. creating one ----------

create or replace function public.create_admin_broadcast(
  p_created_by   uuid,
  p_title        text,
  p_body         text,
  p_url          text    default null,
  p_audience     text    default 'all',
  p_vendor_id    uuid    default null,
  p_limit        integer default 20000,
  p_client_token text    default null
)
returns table (out_id uuid, out_queued integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_aud   text := coalesce(p_audience, 'all');
  v_count integer;
begin
  if coalesce(btrim(p_title), '') = '' then raise exception 'TITLE_REQUIRED'; end if;
  if coalesce(btrim(p_body), '')  = '' then raise exception 'BODY_REQUIRED';  end if;
  if v_aud not in ('all', 'lapsed', 'spendable', 'vendor') then
    raise exception 'BAD_AUDIENCE';
  end if;
  if v_aud = 'vendor' and p_vendor_id is null then
    raise exception 'VENDOR_REQUIRED';
  end if;

  -- The double-tap guard. A repeated token returns the FIRST broadcast rather
  -- than erroring, so a retried request is indistinguishable from the original
  -- to the caller and cannot queue the student body twice.
  if p_client_token is not null then
    select b.id, b.queued_count into v_id, v_count
    from admin_broadcasts b
    where b.created_by = p_created_by and b.client_token = p_client_token;
    if found then
      out_id := v_id; out_queued := v_count; return next; return;
    end if;
  end if;

  insert into admin_broadcasts (created_by, title, body, url, audience, vendor_id, client_token)
  values (p_created_by, btrim(p_title), btrim(p_body), nullif(btrim(coalesce(p_url, '')), ''),
          v_aud, case when v_aud = 'vendor' then p_vendor_id else null end, p_client_token)
  returning id into v_id;

  -- Materialised now, not at send time. The count the operator is shown has to
  -- be what was actually queued: an audience recomputed later would answer a
  -- different question (it moves as students earn and lapse), and the operator
  -- would have approved a number that never existed.
  insert into admin_broadcast_recipients (broadcast_id, user_id)
  select v_id, a.user_id
  from admin_broadcast_audience(v_aud, p_vendor_id, p_limit) a
  on conflict do nothing;
  get diagnostics v_count = row_count;

  update admin_broadcasts set queued_count = v_count where id = v_id;

  -- Nobody matched: close it immediately rather than leaving a queued broadcast
  -- with no recipients for the worker to keep scanning forever.
  if v_count = 0 then
    update admin_broadcasts set status = 'done' where id = v_id;
  end if;

  out_id := v_id; out_queued := v_count; return next;
end;
$$;

comment on function public.create_admin_broadcast(uuid, text, text, text, text, uuid, integer, text) is
  'Create an operator broadcast and materialise its recipient queue '
  '(migration-061). Idempotent per (created_by, client_token). Returns the id '
  'and how many students were queued, which is what the operator is shown.';

revoke execute on function public.create_admin_broadcast(uuid, text, text, text, text, uuid, integer, text) from public, anon, authenticated;
grant  execute on function public.create_admin_broadcast(uuid, text, text, text, text, uuid, integer, text) to service_role;


-- ---------- 5. claiming the next few ----------
--
-- The same shape as claim_reminder_pushes (migration-060) and
-- claim_nearby_notification (migration-051), and the differences are only where
-- a broadcast genuinely differs: it carries its own copy, so the claim returns
-- the words as well as the id and the worker needs no second read; and it is
-- per-(broadcast, student) rather than per-student, so the recipient row is both
-- the queue and the once-only guard.

create or replace function public.claim_admin_broadcast_pushes(
  p_max_users        integer default 40,
  p_skip_users       uuid[]  default '{}',
  -- Same knobs, same defaults, same environment variables as CAMPAIGN_CONFIG in
  -- src/lib/campaigns.js, because it is the same budget. src/lib/broadcasts.js
  -- forwards that module's values rather than keeping a copy.
  p_cooldown_minutes integer default 240,
  p_daily_cap        integer default 2,
  p_weekly_cap       integer default 5,
  p_quiet_start      integer default 22,
  p_quiet_end        integer default 9,
  p_timezone         text    default 'America/New_York'
)
returns table (
  out_user_id      uuid,
  out_broadcast_id uuid,
  out_title        text,
  out_body         text,
  out_url          text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  st     student_notify_state%rowtype;
  v_hour integer;
  v_ds   timestamptz;
  v_ws   timestamptz;
  v_rows integer;
  r      record;
begin
  -- Quiet hours first, campus-local, identical in shape to all three siblings:
  -- `=` disables, `start > end` wraps midnight. Checked before anything is read
  -- or written, so a quiet tick costs nothing and returns no rows.
  v_hour := extract(hour from (now() at time zone p_timezone))::integer;
  if p_quiet_start = p_quiet_end then
    null;
  elsif p_quiet_start > p_quiet_end then
    if v_hour >= p_quiet_start or v_hour < p_quiet_end then return; end if;
  else
    if v_hour >= p_quiet_start and v_hour < p_quiet_end then return; end if;
  end if;

  -- Housekeeping, before the driving scan so an expired broadcast cannot be
  -- claimed by it. An announcement that sat behind a student's cooldown for two
  -- days is stale news, and sending it late is worse than not sending it.
  update admin_broadcast_recipients r2
  set status = 'expired'
  where r2.status in ('queued', 'sending')
    and exists (
      select 1 from admin_broadcasts b
      where b.id = r2.broadcast_id
        and (b.expires_at <= now() or b.status = 'cancelled')
    );

  -- A 'sending' row older than ten minutes is a worker that died between the
  -- claim and the send. Requeued rather than abandoned, the same way
  -- claim_campaign_pushes recovers its own.
  update admin_broadcast_recipients
  set status = 'queued', claimed_at = null
  where status = 'sending' and claimed_at < now() - interval '10 minutes';

  -- Finished broadcasts are closed so the scan below stops looking at them.
  update admin_broadcasts b
  set status = 'done'
  where b.status = 'queued'
    and not exists (
      select 1 from admin_broadcast_recipients r2
      where r2.broadcast_id = b.id and r2.status in ('queued', 'sending')
    );

  for r in
    -- Aliased r2/b: `r` is the record variable above, and plpgsql substitutes
    -- variables into queries before the planner sees them.
    select r2.broadcast_id as bid, r2.user_id as uid,
           b.title as title, b.body as body, b.url as url
    from admin_broadcast_recipients r2
    join admin_broadcasts b on b.id = r2.broadcast_id
    where r2.status = 'queued'
      and b.status = 'queued'
      and b.expires_at > now()
      and r2.user_id <> all(coalesce(p_skip_users, '{}'::uuid[]))
      -- Reachable at all. No endpoint, no claim: spending a student's slot on a
      -- push with nowhere to go is the one failure this cannot refund its way
      -- out of cheaply.
      and exists (
        select 1 from push_subscriptions ps
        where ps.user_id = r2.user_id and ps.role = 'student'
      )
    -- Oldest broadcast first, so two overlapping announcements drain in the
    -- order they were sent rather than interleaving.
    order by b.created_at, r2.user_id
    limit greatest(p_max_users, 1)
  loop
    -- Take the student's budget row. SKIP LOCKED, like the campaign worker and
    -- unlike claim_nearby_notification: there are thirty-nine other students in
    -- this batch and another tick along shortly, so a row another worker holds
    -- is somebody else's to deal with.
    insert into student_notify_state (user_id) values (r.uid) on conflict do nothing;
    select * into st from student_notify_state where user_id = r.uid for update skip locked;
    if not found then continue; end if;

    -- Their switch, re-read under the lock. Deal alerts is the push switch for
    -- this student, and turning it off deletes their endpoints — so this is
    -- belt and braces over the `exists` above, for the window between them.
    if not st.push_opt_in then continue; end if;

    -- The shared budget: same three tests, same rollover arithmetic, same
    -- columns as all three siblings.
    if st.last_push_at is not null
       and st.last_push_at > now() - make_interval(mins => greatest(p_cooldown_minutes, 0))
    then
      continue;
    end if;

    v_ds := st.day_start;
    v_ws := st.week_start;
    if v_ds is null or v_ds <= now() - interval '24 hours' then
      v_ds := now(); st.day_count := 0;
    end if;
    if v_ws is null or v_ws <= now() - interval '7 days' then
      v_ws := now(); st.week_count := 0;
    end if;
    if st.day_count >= p_daily_cap or st.week_count >= p_weekly_cap then continue; end if;

    -- Mark the recipient BEFORE spending the budget, and let the WHERE settle any
    -- race the lock did not: if another transaction moved this row off 'queued'
    -- while we waited, row_count is 0 and we spend nothing.
    update admin_broadcast_recipients
    set status = 'sending', claimed_at = now()
    where broadcast_id = r.bid and user_id = r.uid and status = 'queued';
    get diagnostics v_rows = row_count;
    if v_rows = 0 then continue; end if;

    update student_notify_state
    set last_push_at = now(),
        day_start    = v_ds,
        day_count    = st.day_count + 1,
        week_start   = v_ws,
        week_count   = st.week_count + 1,
        updated_at   = now()
    where user_id = r.uid;

    out_user_id      := r.uid;
    out_broadcast_id := r.bid;
    out_title        := r.title;
    out_body         := r.body;
    out_url          := r.url;
    return next;
  end loop;
end;
$$;

-- ⚠ EIGHT argument types, not nine. claim_reminder_pushes in migration-060 has
-- the same shape plus p_min_interval_hours (its 72-hour cadence gate), and this
-- function has no such knob — a broadcast is sent once, so there is nothing to
-- space out. Copying that signature here cost a whole failed application: the
-- identity in a comment/revoke/grant must match the parameter list exactly, and
-- a wrong one raises 42883 "function does not exist", which inside this file's
-- begin/commit rolls the entire migration back. The arity is now checked by
-- test/migration-signatures.test.js rather than by counting.
comment on function public.claim_admin_broadcast_pushes(integer, uuid[], integer, integer, integer, integer, integer, text) is
  'Students who may be sent a queued operator broadcast right now, oldest '
  'broadcast first, with its copy (migration-061). SPENDS a slot from the SAME '
  'daily/weekly budget as deal alerts, nearby alerts and reminders, at claim '
  'time — so every row returned must be settled by finish_admin_broadcast.';

revoke execute on function public.claim_admin_broadcast_pushes(integer, uuid[], integer, integer, integer, integer, integer, text) from public, anon, authenticated;
grant  execute on function public.claim_admin_broadcast_pushes(integer, uuid[], integer, integer, integer, integer, integer, text) to service_role;


-- ---------- 6. settling one ----------
--
-- Every claimed row must come back through here. `p_delivered` false refunds the
-- student's slot and requeues them, because the claim already spent a cooldown
-- that silences deals and reminders too — four hours of silence bought nothing
-- if the send did not land. Mirrors finish_campaign_batch's refund arithmetic
-- (migration-033), including the greatest(... , 0) that makes a repeat safe.

create or replace function public.finish_admin_broadcast(
  p_broadcast_id uuid,
  p_user_id      uuid,
  p_delivered    boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  if p_broadcast_id is null or p_user_id is null then return false; end if;

  if p_delivered then
    update admin_broadcast_recipients
    set status = 'sent', pushed_at = now()
    where broadcast_id = p_broadcast_id and user_id = p_user_id and status = 'sending';
    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      update admin_broadcasts set sent_count = sent_count + 1 where id = p_broadcast_id;
    end if;
    return v_rows > 0;
  end if;

  -- Not delivered: back on the queue, and the budget returned.
  update admin_broadcast_recipients
  set status = 'queued', claimed_at = null
  where broadcast_id = p_broadcast_id and user_id = p_user_id and status = 'sending';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return false; end if;

  update student_notify_state
  set last_push_at = null,
      day_count    = greatest(day_count - 1, 0),
      week_count   = greatest(week_count - 1, 0),
      updated_at   = now()
  where user_id = p_user_id;

  return true;
end;
$$;

comment on function public.finish_admin_broadcast(uuid, uuid, boolean) is
  'Settle one claimed broadcast recipient (migration-061). Delivered marks it '
  'sent and counts it; not delivered requeues the student AND refunds the '
  'shared slot the claim spent, so a failed send does not silence them.';

revoke execute on function public.finish_admin_broadcast(uuid, uuid, boolean) from public, anon, authenticated;
grant  execute on function public.finish_admin_broadcast(uuid, uuid, boolean) to service_role;

commit;
