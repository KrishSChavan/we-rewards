-- ============================================================
-- Migration 051 — "you're walking past somewhere you've never been".
--
--   A student with the app open near a spot they have no history with gets ONE
--   notification about it, ever. The proximity test itself happens ON THE PHONE
--   (public/student/app.js): every vendor's latitude/longitude and this
--   student's `visited` flag are already in hand from GET /api/me/balances, so
--   the distance maths needs no server and no coordinates ever leave the device.
--
--   WHAT THIS MIGRATION IS FOR, then, is the two facts the phone CANNOT hold:
--
--     1. "have I already told them about this spot?" — must survive a reinstall
--        and must be the same answer on their laptop as on their phone;
--     2. "may they be interrupted right now?" — which is not a question about
--        this feature at all. It is a question about the student, and vendor
--        campaigns (migration-032/047) are already asking it.
--
--   THE QUOTA IS SHARED, NOT PARALLEL. This is the load-bearing decision in the
--   whole migration, so it is worth being explicit: claim_nearby_notification
--   reads AND writes student_notify_state.last_push_at / day_count / week_count
--   — the very same counters claim_campaign_pushes uses. A nearby notification
--   therefore SPENDS a deal-alert slot, and vice versa.
--
--   A second, independent budget was the obvious alternative and it is wrong.
--   migration-032's header exists because five vendors sending at 5pm is five
--   interruptions for the network's most valuable students and "one Block is
--   permanent". A student's tolerance for being buzzed by WeRewards is one
--   number. Giving this feature its own 2/day would have doubled the real rate
--   at exactly the moment the app started buzzing people in the street, which
--   is the single most annoying place to be buzzed — and the Block that follows
--   takes the deal alerts down with it, since they share one permission and one
--   subscription.
--
--   NO PUSH IS SENT FROM HERE. Unlike every other notification in this codebase
--   this one is shown by the page itself, via registration.showNotification()
--   on a service worker the student's own browser already holds. The server is
--   asked "am I allowed", not "please deliver". That has three consequences
--   worth knowing before reading the function:
--
--     • it works with no VAPID keys configured at all, and on browsers with no
--       web push (a desktop Safari tab), because nothing is pushed;
--     • the caller can lie. A doctored client could claim proximity it does not
--       have. The blast radius is deliberately tiny — the worst outcome is a
--       student notifies THEMSELVES about a spot, once, inside their own daily
--       cap — so this is priced as not worth a defence. It is also why the
--       function still re-checks opt-in, visited-ness and the caps server-side
--       rather than trusting the client's word on any of them;
--     • the quota is spent at CLAIM time, before the notification is shown. A
--       claim whose notification then fails to render burns a slot. That is the
--       same asymmetry finish_campaign_batch documents, chosen the same way:
--       double-notifying is worse than under-notifying.
--
--   PRIVACY. A claim carries a vendor id and nothing else — no coordinates, no
--   accuracy, no heading. It is not nothing: a row here says this student was
--   within the client's radius of that vendor at that time, which is coarse
--   location, and legal/student-privacy-policy.html §2.9 says so in those words
--   rather than claiming location never reaches us. The ledger is also the
--   student's own data — it rides GET /api/me/export and cascades on account
--   delete like everything else keyed to a profile.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-050. Safe to re-run.
--
--   ⚠ APPLY MIGRATION-048 FIRST IF IT IS NOT ALREADY. This function asks
--   student_visited_vendor_ids() whether the student has been somewhere, and
--   that is 048's. Without it the function below does not compile at all — a
--   deliberate hard failure rather than the silent narrowing src/routes/student.js
--   accepts for the Recommended row, because "somewhere you've never been" is
--   this feature's entire premise. Getting it wrong here does not mis-rank a
--   carousel; it interrupts someone in the street to tell them to try the place
--   they had lunch at last month.
-- ============================================================

begin;

-- ---------- 1. the student's third switch ----------
--
-- Defaults TRUE, matching push_opt_in and email_opt_in and for the reason
-- migration-047 gives: a student who has never opened the Account screen should
-- be reachable, and the switch exists to STOP that rather than to start it.
--
-- Note what "on" does and does not promise here. Unlike the other two, this
-- flag governs a feature that cannot run at all without a SECOND permission the
-- browser owns (geolocation) — so `true` means "they have not opted out", never
-- "they are receiving these". The client is what reconciles the two, and it
-- writes false back here the moment the device says location is unavailable,
-- so the switch never sits on over a phone that can never deliver.

alter table public.student_notify_state
  add column if not exists nearby_opt_in boolean not null default true;

comment on column public.student_notify_state.nearby_opt_in is
  'The student''s own switch (Account -> Nearby spots). Independent of '
  'push_opt_in: the two notifications answer different questions and one being '
  'unwanted says nothing about the other. Set false by the CLIENT, not only by '
  'the student, when the device reports location denied or unavailable — see '
  'migration-051.';
-- ---------- 2. the once-ever ledger ----------
--
-- THE PRIMARY KEY IS THE FEATURE. (user_id, vendor_id) means a student can be
-- told about a given spot exactly once for the life of their account, and the
-- guard is the index rather than a query the caller has to remember to run.
-- Everything else in this table is audit.
--
-- Once, not once-a-week, because of what the notification SAYS. "You haven't
-- earned here yet" is a fact about a place, not an offer that expires — so a
-- student who walks past the same shop every morning on the way to class and
-- has decided they are not interested has already answered it. Repeating is
-- nagging, and it is nagging with the student's shared daily cap, which means
-- every repeat is a deal alert they do not get.
--
-- NOT PRUNED when the student later earns there. A row surviving is what makes
-- "once, ever" true across the case that matters most: they get the
-- notification, they go in, they buy something, and six months later they have
-- stopped going. Deleting on first visit would let the app introduce them to
-- the same shop a second time as though it had never happened.

create table if not exists public.nearby_notifications (
  user_id     uuid not null references public.profiles (user_id) on delete cascade,
  vendor_id   uuid not null references public.vendors (id)       on delete cascade,
  notified_at timestamptz not null default now(),
  primary key (user_id, vendor_id)
);

comment on table public.nearby_notifications is
  'One row per (student, spot) the "you are walking past somewhere new" '
  'notification has fired for. The primary key IS the once-ever guard. Kept '
  'after the student visits the spot, so being introduced to a place can never '
  'happen twice. See migration-051.';
comment on column public.nearby_notifications.notified_at is
  'When the claim was granted, which is a moment this student was within the '
  'client''s radius of this vendor. Coarse location, and documented as such in '
  'the Privacy Policy — not an incidental timestamp.';

-- "What have I already been told about", for the export and for any future
-- screen that wants to show it. The PK already serves the per-vendor lookup the
-- claim does; this covers the user-wide scan in date order.
create index if not exists idx_nearby_notifications_user_time
  on public.nearby_notifications (user_id, notified_at desc);

-- Server-only, like every other notification table. There is no student-facing
-- read of this outside GET /api/me/export, which runs as service_role.
alter table public.nearby_notifications enable row level security;

grant all privileges on public.nearby_notifications to service_role;
revoke all privileges on public.nearby_notifications from anon, authenticated;
-- ---------- 3. may this student be told about this spot, right now? ----------
--
-- One boolean, and every rule that could say no is inside it. The client asks
-- immediately before it would call showNotification(), and shows nothing on
-- false. There is deliberately no "why not" in the return: the phone has no
-- screen to put a reason on at that moment, and a student who is not being
-- interrupted does not need to be told they were nearly interrupted.
--
-- The ORDER of the checks below is chosen so the cheap, lock-free ones run
-- first and the ones that would spend the student's quota run last, under the
-- lock. Nothing here writes until every test has passed.

create or replace function public.claim_nearby_notification(
  p_user_id          uuid,
  p_vendor_id        uuid,
  -- Same knobs, same defaults, same environment variables as CAMPAIGN_CONFIG in
  -- src/lib/campaigns.js — because they are the same budget. src/lib/nearby.js
  -- passes that module's values rather than keeping a second copy, so retuning
  -- the storm defences retunes both features at once.
  p_cooldown_minutes integer default 240,
  p_daily_cap        integer default 2,
  p_weekly_cap       integer default 5,
  p_quiet_start      integer default 22,
  p_quiet_end        integer default 9,
  p_timezone         text    default 'America/New_York'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  st           student_notify_state%rowtype;
  v_hour       integer;
  v_day_start  timestamptz;
  v_week_start timestamptz;
  v_rows       integer;
begin
  if p_user_id is null or p_vendor_id is null then return false; end if;

  -- Quiet hours, campus-local, identical in shape to claim_campaign_pushes.
  -- Applied here for a sharper reason than it is there: this notification fires
  -- on physical proximity, and the times a student is most likely to be walking
  -- past a closed shop are exactly the small hours. WeRewards stores no opening
  -- hours for any vendor, so quiet hours are the ONLY thing standing between a
  -- 3am walk home and a notification about a cafe that shut at four in the
  -- afternoon. If vendor hours are ever added, this is the check to tighten.
  v_hour := extract(hour from (now() at time zone p_timezone))::integer;
  if p_quiet_start = p_quiet_end then
    null;                                              -- quiet hours disabled
  elsif p_quiet_start > p_quiet_end then               -- window wraps midnight
    if v_hour >= p_quiet_start or v_hour < p_quiet_end then return false; end if;
  else
    if v_hour >= p_quiet_start and v_hour < p_quiet_end then return false; end if;
  end if;

  -- The spot still has to be real and live. The client filters on this already,
  -- but its catalogue is whatever was cached when the app last loaded, and a
  -- vendor deactivated this morning is exactly the kind of thing a phone in a
  -- pocket has not heard about yet.
  if not exists (
    select 1 from vendors v where v.id = p_vendor_id and v.active = true
  ) then
    return false;
  end if;

  -- Already introduced. The cheapest test there is (primary key), and the one
  -- most likely to fire, so it goes before anything that touches the student's
  -- state at all.
  if exists (
    select 1 from nearby_notifications n
    where n.user_id = p_user_id and n.vendor_id = p_vendor_id
  ) then
    return false;
  end if;

  -- ...and they have to actually not have been here. This is migration-048's
  -- function, deliberately re-asked server-side rather than trusted from the
  -- client's `visited` flag: that flag was computed when the app last loaded
  -- GET /api/me/balances, and the walk-past case has a specific way of making
  -- it stale — a student earns points at a counter, walks out, and is still
  -- within 150m of the shop they just paid in. Trusting the cached flag there
  -- would notify them about the place they are standing in.
  if exists (
    select 1 from student_visited_vendor_ids(p_user_id) v
    where v.vendor_id = p_vendor_id
  ) then
    return false;
  end if;

  -- From here on the student's own state is in play, so take the row.
  insert into student_notify_state (user_id) values (p_user_id) on conflict do nothing;

  -- Plain FOR UPDATE, not SKIP LOCKED. The campaign worker skips because it has
  -- forty other students to get on with; this is one request for one student and
  -- the contention it exists to serialise is that student's own two devices
  -- deciding they are near the same shop in the same second. Waiting a few
  -- microseconds is the correct behaviour; skipping would drop the claim.
  select * into st from student_notify_state
  where user_id = p_user_id
  for update;
  if not found then return false; end if;         -- profile vanished mid-flight

  -- Their switch. Re-read under the lock rather than taken from the request, for
  -- the same reason claim_campaign_pushes re-derives reachability: what the
  -- caller believes may be a page that has been open since before they turned
  -- this off on another device.
  if not st.nearby_opt_in then return false; end if;

  -- The shared budget. Same three tests, same rollover arithmetic, and against
  -- the same columns as claim_campaign_pushes — see this migration's header on
  -- why the budget is shared rather than parallel.
  if st.last_push_at is not null
     and st.last_push_at > now() - make_interval(mins => greatest(p_cooldown_minutes, 0))
  then
    return false;
  end if;

  v_day_start  := st.day_start;
  v_week_start := st.week_start;
  if v_day_start is null or v_day_start <= now() - interval '24 hours' then
    v_day_start := now(); st.day_count := 0;
  end if;
  if v_week_start is null or v_week_start <= now() - interval '7 days' then
    v_week_start := now(); st.week_count := 0;
  end if;
  if st.day_count >= p_daily_cap or st.week_count >= p_weekly_cap then
    return false;
  end if;

  -- Write the ledger row BEFORE spending the quota, and let the primary key
  -- settle any race we did not lock out. ON CONFLICT DO NOTHING + row_count is
  -- what makes a duplicate claim cost nothing: if another transaction inserted
  -- this pair while we were queued on the lock, we return false having changed
  -- nothing, rather than burning a slot on a notification the other one is
  -- already showing.
  insert into nearby_notifications (user_id, vendor_id)
  values (p_user_id, p_vendor_id)
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return false; end if;

  update student_notify_state
  set last_push_at = now(),
      day_start    = v_day_start,
      day_count    = st.day_count + 1,
      week_start   = v_week_start,
      week_count   = st.week_count + 1,
      updated_at   = now()
  where user_id = p_user_id;

  return true;
end;
$$;

comment on function public.claim_nearby_notification(uuid, uuid, integer, integer, integer, integer, integer, text) is
  'Whether this student may be shown a "you are near somewhere new" notification '
  'for this vendor right now. Spends a slot from the SAME daily/weekly budget as '
  'vendor deal alerts, and records the vendor so it can never fire twice. See '
  'migration-051.';

revoke execute on function public.claim_nearby_notification(uuid, uuid, integer, integer, integer, integer, integer, text) from public, anon, authenticated;
grant  execute on function public.claim_nearby_notification(uuid, uuid, integer, integer, integer, integer, integer, text) to service_role;

commit;
