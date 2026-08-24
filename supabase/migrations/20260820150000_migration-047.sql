-- ============================================================
-- Migration 047 — Email: a second delivery channel, a suppression list, and
--                 self-serve vendor password resets.
--
--   Until now this stack had no mail transport at all. Migration 031's header
--   says it outright ("There is no SMTP anywhere in this stack"), and the whole
--   operator-dictates-a-code recovery flow exists because of it. src/lib/email.js
--   changes that. This migration is the database half.
--
--   THREE THINGS, and they are less separate than they look.
--
--   1. THE SUPPRESSION LIST (email_suppressions)
--      The exact counterpart of the 404/410/401/403 prune in src/lib/push.js. A
--      push endpoint that answers 410 is dead and we stop paying for it; an
--      address that hard-bounces is dead and we must stop sending to it, except
--      the consequence is worse here. Repeatedly mailing dead addresses is the
--      single fastest way to lose a sending domain's reputation, and when that
--      goes, the PASSWORD RESETS stop arriving too. The list protects the
--      transactional mail by disciplining the marketing mail.
--
--   2. EMAIL AS A FALLBACK CHANNEL FOR DEALS
--      claim_campaign_pushes had a hard gate: no push subscription, no claim
--      ("A student who never granted permission would otherwise sit at the head
--      of the queue forever"). Correct when push was the only channel, and it
--      is precisely what shuts out the largest group of students we have —
--      anyone on iOS who never installed the PWA, for whom web push does not
--      exist at all.
--
--      So the gate widens to "reachable by SOMETHING", and the claim now tells
--      the worker WHICH somethings, in a new out_reach column. Everything else
--      about the claim is untouched, and that is the point: email inherits the
--      four-hour cooldown, the daily and weekly caps, the per-vendor cooldown,
--      the coalescing window and quiet hours WITHOUT A LINE OF NEW THROTTLING,
--      because it rides the same claim under the same row lock. A student
--      cannot be emailed twice in four hours for the same reason they cannot be
--      pushed twice in four hours.
--
--      Email is strictly a FALLBACK, decided in src/lib/campaigns.js: push is
--      tried first wherever it is available, and the email goes only if not one
--      endpoint accepted. Nobody gets both for the same deal.
--
--      The two switches are INDEPENDENT (push_opt_in, email_opt_in), which is
--      what their labels in the Account screen promise. Turning off "Deal
--      alerts" no longer implies silence on every channel; it means no push.
--      Turning off both is what means silence, and the one-click unsubscribe in
--      every deal email turns off the email half.
--
--   3. SELF-SERVE VENDOR PASSWORD RESETS (vendor_reset_request)
--      migration-031 could only mint a code for a named (vendor, login) pair,
--      because the only caller was an admin looking at a vendor's row. A vendor
--      who types their address into the terminal supplies neither. This adds
--      the lookup-by-address variant, with a cooldown that is NOT primarily an
--      anti-mailbomb measure: vendor_reset_issue SUPERSEDES any outstanding
--      code, so an unthrottled public endpoint lets anyone who knows a vendor's
--      address invalidate that vendor's live code on repeat, forever. The
--      cooldown is what stops a denial of service against a vendor mid-reset.
--
--      It returns ZERO ROWS for an address that is not a vendor login, and the
--      route answers identically either way. Same rule as the rest of
--      src/routes/vendor-recover.js: the endpoint is public, so it must not
--      become an oracle for which addresses are vendor logins.
--
--   Idempotent and safe to re-run.
-- ============================================================

-- ---------- 1. the suppression list ----------
--
-- Keyed by address rather than user id on purpose. A bounce is a fact about a
-- MAILBOX, and the same mailbox can be a student profile, a vendor login, and
-- an application contact all at once. Keying on the address is what makes one
-- bounce protect all three.

create table if not exists public.email_suppressions (
  email      text primary key,
  -- 'all'       — dead mailbox or a spam complaint. Nothing is sent, ever, and
  --               that INCLUDES password resets: there is no mailbox to receive
  --               one, and pretending otherwise only spends reputation.
  -- 'marketing' — a preference, not a fact. Deals stop; a reset code still goes.
  scope      text not null default 'all' check (scope in ('all', 'marketing')),
  reason     text not null default 'unknown',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.email_suppressions enable row level security;
-- no policies: server (service_role) only, like every other table here.

grant all privileges on table public.email_suppressions to service_role;
revoke all privileges on table public.email_suppressions from anon, authenticated;

/*
 * Add or escalate one suppression.
 *
 * ESCALATING, never downgrading: a row already at 'all' stays there when a
 * later 'marketing' event arrives. A bounce is a fact about the mailbox and an
 * unsubscribe is a preference about content; the fact wins, because sending to
 * a dead address is harmful in a way that not sending an advert is not.
 */
create or replace function public.email_suppress(
  p_email  text,
  p_reason text default 'unknown',
  p_scope  text default 'all'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_scope text := case when p_scope = 'marketing' then 'marketing' else 'all' end;
begin
  if v_email = '' then return false; end if;

  insert into public.email_suppressions (email, scope, reason)
  values (v_email, v_scope, coalesce(p_reason, 'unknown'))
  on conflict (email) do update
    set scope      = case when public.email_suppressions.scope = 'all' then 'all' else excluded.scope end,
        reason     = excluded.reason,
        updated_at = now();
  return true;
end;
$$;

revoke execute on function public.email_suppress(text, text, text) from public, anon, authenticated;
grant  execute on function public.email_suppress(text, text, text) to service_role;

/*
 * Housekeeping. A 'marketing' suppression is a standing preference and is kept
 * forever. A hard bounce is kept long enough to matter and then dropped: an
 * address can be repaired (a mailbox reopened, a domain's MX fixed), and a
 * permanent local blocklist would mean we never find out.
 */
create or replace function public.prune_email_suppressions(p_keep_days integer default 180)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  delete from public.email_suppressions
   where scope = 'all'
     and reason <> 'complained'          -- a spam report is never re-tried
     and updated_at < now() - make_interval(days => greatest(coalesce(p_keep_days, 180), 1));
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.prune_email_suppressions(integer) from public, anon, authenticated;
grant  execute on function public.prune_email_suppressions(integer) to service_role;


-- ---------- 2. the student's email switch ----------
--
-- Defaults TRUE, matching push_opt_in, and for the same reason: a student who
-- has told us nothing has not opted out, and the switch plus one-click
-- unsubscribe in every message is the opt-out the Privacy Policy promises.

alter table public.student_notify_state
  add column if not exists email_opt_in  boolean not null default true;

-- Audit only, never a gate. The gate is last_push_at, which is spent by the
-- CLAIM and therefore already covers both channels (see the header). This
-- column answers "when did this student last actually get an email", which is
-- the first question asked when someone reports not receiving one.
alter table public.student_notify_state
  add column if not exists last_email_at timestamptz;


-- ---------- 3. how a campaign actually went out ----------

-- Null for every row written before this migration, and for anything still
-- queued. Set at settle time, so it records what HAPPENED rather than what was
-- intended.
alter table public.campaign_recipients
  add column if not exists channel text check (channel in ('push', 'email'));

-- The email subset of sent_count. sent_count keeps its old meaning (students
-- this campaign reached, by any channel) so nothing already reading it changes
-- meaning underneath.
alter table public.vendor_campaigns
  add column if not exists emailed_count integer not null default 0;


-- ---------- 4. the claim learns about reachability ----------
--
-- The one substantive change to migration-032's function: the "no endpoint, no
-- claim" gate becomes "no CHANNEL, no claim", and the claim reports which
-- channels are open in out_reach so the worker does not have to re-derive it
-- (and cannot disagree with the row lock that just decided it).
--
-- Migration-033's lesson applies to the signature change: `create or replace`
-- with an extra defaulted parameter leaves the old arity in place as a separate
-- overload, and PostgREST resolves rpc() by argument NAMES, so the pair becomes
-- ambiguous at runtime. Drop first, then create, then re-grant (dropping a
-- function drops its grants with it).

drop function if exists public.claim_campaign_pushes(integer, uuid[], integer, integer, integer, integer, integer, integer, integer, text);

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
  p_timezone              text    default 'America/New_York',
  -- False unless the server has a working mail transport. A deployment with no
  -- RESEND_API_KEY must keep the OLD behaviour exactly: claiming a student who
  -- can only be reached by an email nobody can send spends their quota on
  -- nothing, every four hours, forever — the same silent hole migration-033 was
  -- written to close.
  p_email_enabled         boolean default false
)
returns table (out_user_id uuid, out_batch uuid, out_items jsonb, out_reach text)
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
  v_push_ok  boolean;
  v_email_ok boolean;
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

  -- A stuck 'sending' row (worker died mid-send) returns to the queue rather
  -- than being stranded. The quota it consumed is NOT refunded — see
  -- finish_campaign_batch for why that asymmetry is deliberate.
  update campaign_recipients
  set status = 'queued', push_batch = null, claimed_at = null
  where status = 'sending' and claimed_at < now() - interval '10 minutes';

  -- Quiet hours, campus-local. Applied to email as well as push, deliberately:
  -- a phone showing mail notifications buzzes for an email at 3am exactly as it
  -- does for a push, and the Privacy Policy (§7.4) documents quiet hours as a
  -- property of deal messaging rather than of one transport.
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
      -- REACHABLE BY SOMETHING. Formerly "has a push endpoint" full stop, which
      -- shut out every student whose browser cannot do web push at all.
      and (
        (
          coalesce((select s.push_opt_in from student_notify_state s where s.user_id = r.user_id), true)
          and exists (
            select 1 from push_subscriptions ps
            where ps.user_id = r.user_id and ps.role = 'student'
          )
        )
        or (
          p_email_enabled
          and coalesce((select s.email_opt_in from student_notify_state s where s.user_id = r.user_id), true)
          and exists (
            select 1 from profiles pr
            where pr.user_id = r.user_id
              and pr.email is not null and trim(pr.email) <> ''
              -- Suppressed here as well as in Node. Node's check stops the send;
              -- this one stops the CLAIM, which is what stops a bounced student
              -- silently spending their own quota every four hours.
              and not exists (
                select 1 from email_suppressions es where es.email = lower(trim(pr.email))
              )
          )
        )
      )
      -- Inside the cooldown, or capped out for the day/week. The opt-out halves
      -- moved into the reachability test above, since each now governs only its
      -- own channel.
      and not exists (
        select 1 from student_notify_state s
        where s.user_id = r.user_id
          and (
            (s.last_push_at is not null
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

    -- Re-derived under the lock, so what the worker is told matches what was
    -- true at the moment the quota was spent.
    v_push_ok := st.push_opt_in and exists (
      select 1 from push_subscriptions ps
      where ps.user_id = u.uid and ps.role = 'student'
    );
    v_email_ok := p_email_enabled and st.email_opt_in and exists (
      select 1 from profiles pr
      where pr.user_id = u.uid
        and pr.email is not null and trim(pr.email) <> ''
        and not exists (select 1 from email_suppressions es where es.email = lower(trim(pr.email)))
    );
    if not (v_push_ok or v_email_ok) then continue; end if;

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
    out_reach   := case
                     when v_push_ok and v_email_ok then 'both'
                     when v_push_ok                then 'push'
                     else                               'email'
                   end;
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

revoke execute on function public.claim_campaign_pushes(integer, uuid[], integer, integer, integer, integer, integer, integer, integer, text, boolean) from public, anon, authenticated;
grant  execute on function public.claim_campaign_pushes(integer, uuid[], integer, integer, integer, integer, integer, integer, integer, text, boolean) to service_role;


-- ---------- 5. settle records which channel carried it ----------
--
-- Same drop-first rule as above. The refund logic is migration-033's, unchanged
-- and for unchanged reasons: p_refund is passed only when NOTHING was
-- delivered by ANY channel, so there is no maybe-it-landed case to protect.

drop function if exists public.finish_campaign_batch(uuid, boolean, boolean);

create or replace function public.finish_campaign_batch(
  p_batch   uuid,
  p_ok      boolean default true,
  -- Set only when zero endpoints AND zero mailboxes accepted the payload.
  p_refund  boolean default false,
  -- Which channel actually carried it. Recorded, never enforced.
  p_channel text default 'push'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n        integer;
  v_users  uuid[];
  v_chan   text := case when p_channel = 'email' then 'email' else 'push' end;
begin
  if p_ok then
    update campaign_recipients
    set status = 'sent', pushed_at = now(), channel = v_chan
    where push_batch = p_batch and status = 'sending';
    get diagnostics n = row_count;

    update vendor_campaigns c
    set sent_count    = c.sent_count + s.n,
        emailed_count = c.emailed_count + case when v_chan = 'email' then s.n else 0 end
    from (
      select campaign_id, count(*)::integer as n
      from campaign_recipients
      where push_batch = p_batch and status = 'sent'
      group by campaign_id
    ) s
    where c.id = s.campaign_id;

    -- Audit stamp, so "when did this student last get an email" is answerable
    -- without joining the recipient ledger.
    if v_chan = 'email' then
      update student_notify_state s
      set last_email_at = now(), updated_at = now()
      where s.user_id in (
        select distinct user_id from campaign_recipients where push_batch = p_batch
      );
    end if;
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

revoke execute on function public.finish_campaign_batch(uuid, boolean, boolean, text) from public, anon, authenticated;
grant  execute on function public.finish_campaign_batch(uuid, boolean, boolean, text) to service_role;


-- ---------- 6. self-serve vendor password resets ----------
--
-- The lookup-by-address twin of migration-031's vendor_reset_issue. Everything
-- security-relevant about that function is preserved: the code arrives already
-- hashed (Node holds the only plaintext, exactly once), the TTL is applied
-- here, and any outstanding code for the login is superseded.
--
-- ZERO ROWS means "no vendor login at that address" and MUST be rendered by the
-- caller exactly as success is. One row with reset_throttled = true means "there
-- is a login, but a code was minted for it moments ago" — the caller still
-- answers identically to the client, and simply does not send a second email.

create or replace function public.vendor_reset_request(
  p_email            text,
  p_code_hash        text,
  p_ttl_minutes      integer default 30,
  p_cooldown_seconds integer default 120
)
returns table (
  reset_id          uuid,
  reset_email       text,
  reset_expires_at  timestamptz,
  reset_vendor_name text,
  reset_throttled   boolean
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email   text := lower(trim(coalesce(p_email, '')));
  v_user    uuid;
  v_vendor  uuid;
  v_name    text;
  v_expires timestamptz;
begin
  if v_email = '' then return; end if;

  select u.id into v_user from auth.users u
   where lower(u.email) = v_email
   limit 1;
  if v_user is null then return; end if;              -- no account: zero rows

  -- Must be staff of SOMETHING. A student account at the same address is not a
  -- vendor login and must not be resettable through the terminal's form; the
  -- student app has Supabase's own recovery for that.
  --
  -- One login can run several locations (migration-043). Which vendor id is
  -- recorded matters only for the audit trail, since the reset targets the
  -- LOGIN — so take the oldest link, deterministically.
  select vs.vendor_id, v.name into v_vendor, v_name
    from public.vendor_staff vs
    join public.vendors v on v.id = vs.vendor_id
   where vs.user_id = v_user
   order by v.created_at, v.id
   limit 1;
  if v_vendor is null then return; end if;            -- not a vendor: zero rows

  -- Throttle. See the migration header: the real risk is not mailbombing, it is
  -- that an unthrottled public endpoint can supersede a vendor's live code on
  -- repeat and lock them out of their own recovery.
  if exists (
    select 1 from public.vendor_password_resets pr
    where pr.user_id = v_user
      and pr.used_at is null
      and pr.expires_at > now()
      and pr.created_at > now() - make_interval(secs => greatest(coalesce(p_cooldown_seconds, 120), 0))
  ) then
    reset_id := null;
    reset_email := v_email;
    reset_expires_at := null;
    reset_vendor_name := v_name;
    reset_throttled := true;
    return next;
    return;
  end if;

  v_expires := now() + make_interval(mins => greatest(coalesce(p_ttl_minutes, 30), 1));

  update public.vendor_password_resets
     set used_at = now()
   where user_id = v_user
     and used_at is null;

  insert into public.vendor_password_resets
    (vendor_id, user_id, email, code_hash, expires_at, created_by)
  values
    (v_vendor, v_user, v_email, p_code_hash, v_expires, 'self-serve')
  returning id, email, expires_at into reset_id, reset_email, reset_expires_at;

  reset_vendor_name := v_name;
  reset_throttled := false;
  return next;
end;
$$;

revoke execute on function public.vendor_reset_request(text, text, integer, integer) from public, anon, authenticated;
grant  execute on function public.vendor_reset_request(text, text, integer, integer) to service_role;
