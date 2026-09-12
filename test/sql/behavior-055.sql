-- Assertions for migration-055 (plans + subscription state).
--
-- Additive columns look like there is nothing to prove. There are seven things,
-- and every one of them is a promise the rest of the stack will rely on:
--
--   * THE SIXTEEN ARE GRANDFATHERED, INCLUDING THE SWITCHED-OFF ONE. "Free for
--     life" was promised verbally to a roster the operator can name. If the
--     backfill misses a row, that vendor is silently on the free tier with
--     three items and no deals, and nobody finds out until they complain.
--
--   * A NEW VENDOR IS NOT. The default has to be freshman/false, or the next
--     vendor onboarded inherits the founding cohort's deal by accident. This is
--     the single most expensive way this migration could be wrong.
--
--   * THE BACKFILL RUNS ONCE. Production migrations here are pasted by hand
--     into the Supabase SQL editor, so re-application is a real event, not a
--     hypothetical. A second run must not re-grandfather a vendor the operator
--     has deliberately moved onto a paid plan.
--
--   * PLAN_SINCE PRESERVES THE REAL SIGNUP DATE. The 12-month rate lock reads
--     it. Stamping now() across the roster would silently reset every founding
--     vendor's anniversary to migration day.
--
--   * THE PLAN IS ONE OF THREE. Typo'd plan strings would fail open — a
--     requirePlan check comparing against 'discovery' simply wouldn't match,
--     and the vendor would lose features with no error anywhere.
--
--   * ONE LOCATION IS ONE STRIPE CUSTOMER. A double Checkout must not be able
--     to attach a second customer (and therefore a second subscription, and a
--     second monthly charge) to one till.
--
--   * THE EVENT ID IS THE IDEMPOTENCY GUARANTEE. Stripe retries until it sees a
--     2xx and does not promise exactly-once delivery. This is the same shape as
--     migration-039's unique (ref_id, kind): the index refuses the duplicate,
--     the handler does not have to remember to check.
--
-- Also asserted: the 30/45-day ladder in vendor_billing_overview, because it is
-- the one place that rule is written down and three callers will read it.
--
-- NOT covered here: requirePlan itself, the webhook handler, and the Checkout
-- flow. Those are Node and belong in test/.

do $$
declare
  v1 uuid := '00000000-0000-0000-0000-000000000551';   -- live, ordinary
  v3 uuid := '00000000-0000-0000-0000-000000000553';   -- switched OFF
  v4 uuid := '00000000-0000-0000-0000-000000000554';   -- known created_at
  vnew uuid;
  n    integer;
  txt  text;
  ts   timestamptz;
  ok   boolean;
begin
  -- ── 1. every pre-existing vendor is on goto, free for life ──────────────
  select count(*) into n
    from public.vendors
   where id in ('00000000-0000-0000-0000-000000000551',
                '00000000-0000-0000-0000-000000000552',
                '00000000-0000-0000-0000-000000000553',
                '00000000-0000-0000-0000-000000000554')
     and plan = 'goto' and grandfathered;
  if n = 4 then raise notice 'PASS all 4 seeded vendors grandfathered onto goto';
  else raise notice 'FAIL only % of 4 seeded vendors were grandfathered', n; end if;

  -- The switched-off one specifically. Disabling is not deleting.
  select grandfathered into ok from public.vendors where id = v3;
  if ok then raise notice 'PASS a switched-off vendor is grandfathered too';
  else raise notice 'FAIL the switched-off vendor was skipped by the backfill'; end if;

  -- ── 2. a NEW vendor gets neither ────────────────────────────────────────
  insert into public.vendors (name, slug, points_per_dollar)
  values ('Brand New Spot', 'brand-new-055', 10)
  returning id into vnew;

  select plan into txt from public.vendors where id = vnew;
  select grandfathered into ok from public.vendors where id = vnew;
  if txt = 'freshman' and not ok then
    raise notice 'PASS a vendor created after the migration defaults to freshman, not grandfathered';
  else
    raise notice 'FAIL a new vendor came out plan=% grandfathered=%', txt, ok;
  end if;

  -- ── 3. re-running the backfill gate changes nothing ─────────────────────
  -- Verbatim the guard from migration-055 §1. The column now exists, so
  -- v_first_run is false and the update must not fire. Move the new vendor
  -- onto a paid plan first, exactly as an operator would, and check it stays.
  update public.vendors set plan = 'discovery' where id = vnew;

  declare
    v_first_run boolean := not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'vendors'
         and column_name = 'grandfathered'
    );
  begin
    if v_first_run then
      update public.vendors set plan = 'goto', grandfathered = true;
    end if;
  end;

  select plan into txt from public.vendors where id = vnew;
  select grandfathered into ok from public.vendors where id = vnew;
  if txt = 'discovery' and not ok then
    raise notice 'PASS re-applying the migration does not re-grandfather a paying vendor';
  else
    raise notice 'FAIL re-application moved a paying vendor to plan=% grandfathered=%', txt, ok;
  end if;

  -- ── 4. plan_since kept the real signup date ─────────────────────────────
  select plan_since into ts from public.vendors where id = v4;
  if ts = timestamptz '2026-01-15 12:00:00+00' then
    raise notice 'PASS plan_since preserved the original created_at';
  else
    raise notice 'FAIL plan_since was stamped as % instead of the 2026-01-15 signup', ts;
  end if;

  -- ── 5. the plan must be one of three ────────────────────────────────────
  begin
    update public.vendors set plan = 'platinum' where id = v1;
    raise notice 'FAIL vendors_plan_check accepted an unknown plan';
  exception when check_violation then
    raise notice 'PASS an unknown plan is refused by vendors_plan_check';
  end;

  -- ── 6. one location, one Stripe customer ────────────────────────────────
  update public.vendors set stripe_customer_id = 'cus_055test' where id = v1;
  begin
    update public.vendors set stripe_customer_id = 'cus_055test' where id = vnew;
    raise notice 'FAIL two vendors were allowed to share one Stripe customer';
  exception when unique_violation then
    raise notice 'PASS a Stripe customer id cannot be attached to two locations';
  end;

  -- ...but many vendors may have none, which is the normal state for the
  -- entire grandfathered roster. A plain UNIQUE would allow this too; the
  -- point is to prove the partial index did not accidentally become total.
  select count(*) into n from public.vendors where stripe_customer_id is null;
  if n >= 3 then raise notice 'PASS many vendors can share a NULL customer id (% of them)', n;
  else raise notice 'FAIL only % vendors have a null customer id — the partial index may be total', n; end if;

  -- ── 7. the webhook event id refuses a replay ────────────────────────────
  insert into public.stripe_events (id, type) values ('evt_055', 'invoice.paid');
  begin
    insert into public.stripe_events (id, type) values ('evt_055', 'invoice.paid');
    raise notice 'FAIL stripe_events accepted a duplicate event id';
  exception when unique_violation then
    raise notice 'PASS a replayed Stripe event is refused by the primary key';
  end;

  -- ── 8. the 30 / 45 day ladder ───────────────────────────────────────────
  -- vendor_billing_overview is where this rule lives; the route, the dashboard
  -- and the sweep all read it rather than each re-deriving the thresholds.
  update public.vendors set grandfathered = false, past_due_since = now() - interval '3 days'  where id = vnew;
  select billing_state, days_past_due into txt, n from public.vendor_billing_overview where id = vnew;
  if txt = 'warn' and n = 3 then raise notice 'PASS 3 days past due reads as warn, 3 days';
  else raise notice 'FAIL 3 days past due read as %/% days', txt, n; end if;

  update public.vendors set past_due_since = now() - interval '31 days' where id = vnew;
  select billing_state into txt from public.vendor_billing_overview where id = vnew;
  if txt = 'degrade' then raise notice 'PASS 31 days past due reads as degrade';
  else raise notice 'FAIL 31 days past due read as %', txt; end if;

  update public.vendors set past_due_since = now() - interval '46 days' where id = vnew;
  select billing_state into txt from public.vendor_billing_overview where id = vnew;
  if txt = 'suspend' then raise notice 'PASS 46 days past due reads as suspend';
  else raise notice 'FAIL 46 days past due read as %', txt; end if;

  -- A grandfathered vendor is never in trouble, even with a stale stamp on the
  -- row. The operator's screen must not invite them to chase somebody who was
  -- promised free access.
  update public.vendors set grandfathered = true where id = vnew;
  select billing_state into txt from public.vendor_billing_overview where id = vnew;
  if txt = 'ok' then raise notice 'PASS a grandfathered vendor never reads as past due';
  else raise notice 'FAIL a grandfathered vendor read as %', txt; end if;

  -- A healthy vendor has NULL days, not 0 — 0 renders as "0 days late".
  select days_past_due into n from public.vendor_billing_overview where id = v1;
  if n is null then raise notice 'PASS a healthy vendor has NULL days_past_due, not 0';
  else raise notice 'FAIL a healthy vendor reported % days past due', n; end if;

  -- ── 9. nothing but the service key reaches the new table ────────────────
  select has_table_privilege('anon', 'public.stripe_events', 'SELECT')
      or has_table_privilege('authenticated', 'public.stripe_events', 'SELECT')
    into ok;
  if not ok then raise notice 'PASS stripe_events is unreachable by anon/authenticated';
  else raise notice 'FAIL stripe_events is readable through the anon or authenticated role'; end if;

  select relrowsecurity into ok from pg_class where oid = 'public.stripe_events'::regclass;
  if ok then raise notice 'PASS row level security is enabled on stripe_events';
  else raise notice 'FAIL row level security is OFF on stripe_events'; end if;

  -- The VIEW needs its own assertion, and it is the one most likely to be
  -- missed. vendor_billing_overview exposes subscription_status, past_due_since
  -- and whether a vendor has a Stripe customer — commercially sensitive facts
  -- about a local business — and two things that protect the underlying table
  -- do NOT protect it: the `vendors readable` RLS policy from schema.sql grants
  -- select on active rows, and a view is SECURITY DEFINER by default, so it
  -- reads `vendors` as its owner and bypasses RLS entirely. Only the grant
  -- stands between anon and this. Migration-037's own sweep checks
  -- relkind = 'r' and would not have caught a view left open.
  select has_table_privilege('anon', 'public.vendor_billing_overview', 'SELECT')
      or has_table_privilege('authenticated', 'public.vendor_billing_overview', 'SELECT')
    into ok;
  if not ok then raise notice 'PASS vendor_billing_overview is unreachable by anon/authenticated';
  else raise notice 'FAIL vendor_billing_overview leaks billing state to anon or authenticated'; end if;

  -- And service_role must still reach it, or /admin's ROI tab 500s.
  select has_table_privilege('service_role', 'public.vendor_billing_overview', 'SELECT') into ok;
  if ok then raise notice 'PASS service_role can still read vendor_billing_overview';
  else raise notice 'FAIL service_role lost select on vendor_billing_overview'; end if;
end $$;
