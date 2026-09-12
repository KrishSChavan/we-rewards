-- ============================================================
-- Migration 055 — plans, and the subscription state behind them.
--
--   THREE PLANS, PER LOCATION.
--
--     freshman   free forever. The till (award, redeem, undo, PIN), up to three
--                active reward items, a listing on /spots, today+7d stats.
--                No deals. This tier exists to buy DENSITY, not revenue:
--                scoreProfile's synergy term is cbrt(B·L·S), so a student who
--                visits one spot scores near zero and the whole breadth
--                mechanic is worthless below roughly ten vendors in a town.
--                Every free vendor makes the paid vendors' product better.
--     discovery  the paid plan. Deals, the full 30-day stats, the visits/punch
--                rail, unlimited reward items, a loaner tablet.
--                NOT receipt scanning: the operator's decision sheet puts that
--                switch on every plan, default ON, as a liability control
--                rather than a feature to sell. It is migration-056's column
--                (vendors.receipts_enabled) and is deliberately ungated.
--     goto       the top plan. Quoted by hand, not published: it carries the
--                slow-night multiplier, which DOES NOT EXIST YET
--                (mds/go-to-market.md sells it in the bar pitch; nothing in the
--                repo implements it). Nobody outside the grandfathered roster
--                should be put on this plan until that is built.
--
--   The unit is the vendors ROW, not the login. Since migration-043 one account
--   can staff many vendors and a chain of twelve can apply in a single form
--   submission; since migration-044 those locations may share one purse. A
--   location is nonetheless what gets a tablet, a menu, an audience and a
--   street address, so it is what gets a plan. A chain discount is a Stripe
--   price, not a schema change — which is exactly why this column is here and
--   not on vendor_staff.
--
--   GRANDFATHERED IS A COLUMN, NOT A MEMORY. Every vendor that existed before
--   this migration is put on `goto` with `grandfathered = true`: free for as
--   long as the relationship runs, decided by the database rather than by
--   anybody remembering who was here first. It is a separate flag from the plan
--   on purpose — "which features" and "do they pay" are different questions,
--   and merging them would mean a grandfathered vendor could never be moved
--   between plans without also starting to be billed.
--
--   NO STRIPE OBJECTS FOR THEM. A grandfathered vendor gets no customer, no
--   subscription and no $0 price — those would be sixteen rows of permanent
--   noise in a dashboard whose job is to show you who is paying. The billing
--   code's first question is `grandfathered`, and it stops there.
--
--   THE BACKFILL RUNS EXACTLY ONCE, gated on `grandfathered` not existing yet
--   rather than on a hard-coded cutoff date. A date would re-grandfather anyone
--   the operator had deliberately moved OFF the free roster if this file were
--   ever re-applied, which is precisely the sort of thing that happens when
--   production migrations are pasted by hand into the SQL editor (see
--   mds/prod-transfer.md). Re-running this file on a database that already has
--   the column changes no vendor's plan.
--
--   PAST_DUE_SINCE IS SET BY THE WEBHOOK, READ BY /admin. Stripe's own
--   `subscription_status` says THAT a card is failing; it does not say for how
--   long, and "how many days have they missed" is the only form of that fact an
--   operator can act on. Stamped on the first failure, cleared on the first
--   success, so the dashboard's day count is a subtraction rather than a scan
--   of invoice history.
--
--   Idempotent and safe to re-run.
-- ============================================================

-- ---------- 1. the columns ----------

do $$
declare
  -- Captured BEFORE the alter below, because `add column if not exists` would
  -- otherwise make this true on every run. This is the whole idempotency gate.
  v_first_run boolean := not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'vendors'
       and column_name  = 'grandfathered'
  );
begin
  alter table public.vendors
    add column if not exists plan                   text        not null default 'freshman',
    add column if not exists grandfathered          boolean     not null default false,
    add column if not exists stripe_customer_id     text,
    add column if not exists stripe_subscription_id text,
    add column if not exists subscription_status    text,
    add column if not exists current_period_end     timestamptz,
    add column if not exists past_due_since         timestamptz,
    add column if not exists plan_since             timestamptz not null default now();

  if v_first_run then
    -- The sixteen. Top plan, never billed, no Stripe object.
    update public.vendors
       set plan          = 'goto',
           grandfathered = true,
           plan_since    = coalesce(created_at, now());

    raise notice 'migration-055: grandfathered % existing vendor row(s) onto the goto plan',
      (select count(*) from public.vendors);
  end if;
end $$;

comment on column public.vendors.plan is
  'Which feature set this LOCATION gets: freshman (free) | discovery (paid) | '
  'goto (top, quoted by hand). Per vendors row rather than per login because a '
  'location is what gets a tablet, a menu and an audience (migration-043 lets '
  'one account staff many). Enforced server-side by requirePlan, never in the '
  'terminal UI — terminal.js is a client. Says nothing about whether money '
  'changes hands; see grandfathered.';

comment on column public.vendors.grandfathered is
  'True for every vendor that predates migration-055: free for as long as the '
  'relationship runs, and deliberately a column rather than an operator''s '
  'memory. A grandfathered vendor has NO Stripe customer and NO subscription — '
  'the billing code checks this flag first and stops. Separate from `plan` '
  'because "which features" and "do they pay" are different questions, and '
  'merging them would make a grandfathered vendor unmovable between plans.';

comment on column public.vendors.stripe_customer_id is
  'Stripe Customer id (cus_...). NULL for every grandfathered vendor and for '
  'anyone who has not reached Checkout yet. Unique where present, so a double '
  'Checkout cannot silently attach a second customer to one location.';

comment on column public.vendors.stripe_subscription_id is
  'Stripe Subscription id (sub_...). NULL until Checkout completes. One per '
  'location: a chain pays per row, and a chain discount is a Stripe price.';

comment on column public.vendors.subscription_status is
  'Stripe''s own status string, stored verbatim (trialing, active, past_due, '
  'canceled, unpaid, incomplete, incomplete_expired, paused). Verbatim on '
  'purpose — a local enum would need a migration every time Stripe adds a '
  'state, and the webhook would have to guess what to do with the one it did '
  'not recognise. NULL means "no subscription", which is not the same as '
  'canceled.';

comment on column public.vendors.current_period_end is
  'When the paid period this vendor has already been billed for runs out. Used '
  'to keep access alive through a period that is paid but cancelled — '
  '§11.1-style "no refunds, you keep the month you bought".';

comment on column public.vendors.past_due_since is
  'Stamped by the Stripe webhook on the FIRST failed payment, cleared on the '
  'first success. Exists because Stripe tells you THAT a card is failing and '
  'not for how long — and "days missed" is the only form of that an operator '
  'can act on. /admin subtracts it from now() rather than scanning invoice '
  'history. Drives the dashboard warning and the 30-day / 45-day ladder.';

comment on column public.vendors.plan_since is
  'When this location last changed plan. Backfilled to created_at for the '
  'grandfathered roster so the column is never a lie about the founding '
  'sixteen. Read by the 12-month rate lock: a vendor''s price is held for a '
  'year from the day they signed, and this is that day.';

-- ---------- 2. the plan has to be one of three ----------

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.vendors'::regclass
       and conname  = 'vendors_plan_check'
  ) then
    alter table public.vendors
      add constraint vendors_plan_check
      check (plan in ('freshman', 'discovery', 'goto'));
  end if;
end $$;

-- A location cannot be two customers. Partial, because NULL is the normal
-- state for the whole grandfathered roster and a plain UNIQUE would be fine
-- with that but says less about intent.
create unique index if not exists idx_vendors_stripe_customer
  on public.vendors (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists idx_vendors_stripe_subscription
  on public.vendors (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- The dashboard's "who is failing to pay" query, and the 30/45-day sweep.
create index if not exists idx_vendors_past_due
  on public.vendors (past_due_since)
  where past_due_since is not null;

-- ---------- 3. webhook idempotency ----------
--
-- Stripe retries a webhook until it gets a 2xx, and it does not promise to
-- deliver an event only once even when it does. Every handler in this codebase
-- that moves money already makes the unique index BE the guarantee rather than
-- a flag that is merely checked (migration-039's `unique (ref_id, kind)`), and
-- this is the same shape: insert the event id first, and a duplicate delivery
-- fails the insert instead of applying twice.
--
-- `payload` is deliberately NOT stored. It would be the largest table in the
-- database within a year, it carries cardholder-adjacent metadata this app has
-- no reason to hold, and everything worth keeping from an event is already
-- written onto the vendors row by the handler.

create table if not exists public.stripe_events (
  id          text        primary key,          -- evt_...
  type        text        not null,
  received_at timestamptz not null default now()
);

comment on table public.stripe_events is
  'One row per Stripe webhook event actually processed. The primary key is the '
  'idempotency guarantee: Stripe retries until it sees a 2xx and does not '
  'promise exactly-once delivery, so the handler inserts here FIRST and treats '
  'a unique violation as "already done, return 200". No payload is stored — it '
  'would be the biggest table here inside a year and carries payment metadata '
  'this app has no reason to hold.';

create index if not exists idx_stripe_events_received
  on public.stripe_events (received_at desc);

-- ---------- 4. lock it down ----------
--
-- Same shape as migration-053: RLS on with no policies at all, so PostgREST
-- gives anon/authenticated nothing, and the service key (which bypasses RLS)
-- is the only way in. The explicit REVOKE is not redundant — hosted Supabase
-- carries a pg_default_acl that grants new tables to anon/authenticated at
-- creation time, which is the exact bug migration-037 existed to clean up.

alter table public.stripe_events enable row level security;

grant all privileges on public.stripe_events to service_role;
revoke all privileges on public.stripe_events from anon, authenticated;

-- ---------- 5. the operator's roster view ----------
--
-- One row per location with the billing facts /admin needs, so the dashboard
-- does not re-derive "is this vendor in trouble" in three different places.
-- days_past_due is null rather than 0 for a healthy vendor: 0 would render as
-- a warning that says nothing is wrong.

create or replace view public.vendor_billing_overview as
select
  v.id,
  v.name,
  v.slug,
  v.active,
  v.plan,
  v.grandfathered,
  v.subscription_status,
  v.current_period_end,
  v.past_due_since,
  v.plan_since,
  v.stripe_customer_id is not null as has_stripe_customer,
  case
    when v.past_due_since is null then null
    else greatest(0, floor(extract(epoch from (now() - v.past_due_since)) / 86400)::int)
  end as days_past_due,
  -- The 30 / 45 day ladder, decided once here rather than in the route, the
  -- dashboard and the sweep separately. `ok` covers both a paying vendor and a
  -- grandfathered one: neither is in trouble, and the operator's screen should
  -- not invite them to chase somebody who was promised free access.
  case
    when v.grandfathered                                        then 'ok'
    when v.past_due_since is null                               then 'ok'
    when now() - v.past_due_since >= interval '45 days'         then 'suspend'
    when now() - v.past_due_since >= interval '30 days'         then 'degrade'
    else 'warn'
  end as billing_state
from public.vendors v;

comment on view public.vendor_billing_overview is
  'Billing facts per location for /admin. Exists so the 30-day degrade / '
  '45-day suspend ladder is written down ONCE instead of in the route, the '
  'dashboard and the sweep. days_past_due is NULL (not 0) for a healthy vendor '
  'so a template cannot render "0 days late" as a warning.';

grant select on public.vendor_billing_overview to service_role;
revoke all privileges on public.vendor_billing_overview from anon, authenticated;
