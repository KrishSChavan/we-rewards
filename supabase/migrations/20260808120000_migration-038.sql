-- Migration 038: receipt claims — earn points by scanning a paper receipt.
--
-- A student photographs a restaurant receipt; the server OCRs it (in memory,
-- the image is never stored), matches the vendor, and calls claim_receipt().
-- The whole anti-fraud story lives in this file:
--
--   1. UNIQUE (vendor_id, receipt_at, total) — one claim per physical receipt,
--      ever. Two people scanning the same receipt race to the insert; the
--      first commit wins and the loser gets RECEIPT_CLAIMED. Same first-
--      insert-wins pattern as the punches once-per-night index (migration-028).
--   2. A 7-day freshness window (and a 1h not-in-the-future skew allowance),
--      so a stack of old receipts isn't a points mine.
--   3. Max 3 claims per student per day (campus-local day), advisory-locked so
--      two concurrent claims can't both sneak under the cap.
--   4. The counter double-dip check: if the vendor already awarded this student
--      the same dollar amount at the terminal within ±5 minutes of the
--      receipt's printed time, this receipt IS that purchase — RECEIPT_ALREADY_EARNED.
--   5. Awarding goes through award_points() (migration-026 body), so the
--      migration-025 write guard, the (vendor_id, client_token) idempotency
--      backstop, the revisit bump, and the 10% community mint all apply
--      unchanged. The $200 ceiling mirrors MAX_AWARD_DOLLARS in routes/vendor.js.
--
-- Error strings raised here surface through server.js's central error map,
-- which matches by SUBSTRING — no code below may contain, or be contained by,
-- another known code. Checked against the full map (nothing else says RECEIPT).

begin;

-- ---------- 1. the claims ledger ----------

create table if not exists public.receipt_claims (
  id         uuid primary key default gen_random_uuid(),
  -- SET NULL, not cascade: the dedup row must outlive the account, or deleting
  -- an account would "un-claim" its receipts for someone else to re-scan
  -- (transactions kept user_id the same way in migration-011). A (vendor,
  -- time, total) triple with no user attached is not personal data.
  user_id    uuid references public.profiles (user_id) on delete set null,
  vendor_id  uuid not null references public.vendors (id) on delete cascade,
  receipt_at timestamptz not null,           -- the PRINTED date+time, campus-local
  total      numeric(8,2) not null check (total > 0 and total <= 200),
  points     integer not null check (points > 0),  -- actually awarded (post-multiplier)
  created_at timestamptz not null default now()    -- when it was scanned
);

-- THE rule: one claim per physical receipt.
create unique index if not exists idx_receipt_claims_once
  on public.receipt_claims (vendor_id, receipt_at, total);

-- The daily-cap count in claim_receipt() below.
create index if not exists idx_receipt_claims_user_day
  on public.receipt_claims (user_id, created_at);

-- RLS on with no policies: server-only, like earn_codes. Reads happen through
-- the Express API with the service key; nothing touches this via the Data API.
alter table public.receipt_claims enable row level security;

-- Belt-and-braces beside 036's default grants / 037's default revokes: prod
-- applies this file by SQL-editor paste, and objects created there can inherit
-- different defaults than the CLI role's.
grant  all privileges on public.receipt_claims to service_role;
revoke all            on public.receipt_claims from public, anon, authenticated;

-- ---------- 2. claim_receipt ----------
-- One atomic transaction: freshness gates → daily cap → dedup insert →
-- award_points. Any raise rolls the whole thing back, so a failed award never
-- leaves a claim row behind blocking the receipt for a retry.

create or replace function public.claim_receipt(
  p_user_id       uuid,
  p_vendor_id     uuid,
  p_receipt_local timestamp,   -- naive printed date+time, e.g. '2026-08-07 18:42:00'
  p_timezone      text,        -- punchTimezone() — one campus clock, same as punch_in
  p_total         numeric,
  p_points        integer      -- computed server-side: floor(total × ratio × tier), like /api/vendor/award
)
returns table (claim_id uuid, new_balance integer, new_community integer)
language plpgsql security definer set search_path = public
as $$
declare
  c_max_age   constant interval := interval '7 days';
  c_skew      constant interval := interval '1 hour';    -- receipt printers keep loose clocks
  c_dup_slop  constant interval := interval '5 minutes'; -- counter award vs printed time
  c_daily_cap constant integer  := 3;
  c_max_total constant numeric  := 200;                  -- mirror of MAX_AWARD_DOLLARS

  v_receipt_at timestamptz;
  v_claims_today integer;
  v_claim_id uuid;
  v_token text;
begin
  -- Announce a legitimate points write to the migration-025 guard triggers.
  -- award_points() sets it again itself; both are transaction-local.
  perform set_config('app.points_write', 'server', true);

  if p_total is null or p_total <= 0 then
    raise exception 'RECEIPT_TOTAL_MISSING';
  end if;
  if p_total > c_max_total then
    raise exception 'RECEIPT_TOTAL_TOO_LARGE';
  end if;
  if p_points is null or p_points <= 0 then
    raise exception 'RECEIPT_TOTAL_MISSING';
  end if;

  -- The printed wall-clock time, pinned to the campus timezone. Same policy as
  -- punch_in: the server passes the zone so there is exactly one definition.
  v_receipt_at := p_receipt_local at time zone p_timezone;

  if v_receipt_at > now() + c_skew then
    raise exception 'RECEIPT_IN_FUTURE';
  end if;
  if v_receipt_at < now() - c_max_age then
    raise exception 'RECEIPT_TOO_OLD';
  end if;

  -- Daily cap, race-proof. A bare count can't be: two concurrent claims both
  -- read 2 and both insert. The advisory xact-lock serializes THIS student's
  -- claims for the transaction; different students don't contend.
  perform pg_advisory_xact_lock(hashtextextended('receipt_claims:' || p_user_id::text, 0));

  select count(*) into v_claims_today
  from receipt_claims rc
  where rc.user_id = p_user_id
    and (rc.created_at at time zone p_timezone)::date = (now() at time zone p_timezone)::date;
  if v_claims_today >= c_daily_cap then
    raise exception 'RECEIPT_DAILY_LIMIT';
  end if;

  -- Counter double-dip: the vendor already awarded this student this exact
  -- amount at the terminal within ±5 min of the printed time — that IS this
  -- purchase, already paid out. Excludes rcpt-* rows so receipt-vs-receipt
  -- dedup stays the unique index's job (a second, genuinely different receipt
  -- with an identical total minutes later must not false-positive against the
  -- student's own first claim). Uses idx (user_id, vendor_id, created_at).
  if exists (
    select 1 from transactions t
    where t.user_id = p_user_id
      and t.vendor_id = p_vendor_id
      and t.type = 'earn'
      and t.dollar_amount = p_total
      and t.created_at between v_receipt_at - c_dup_slop and v_receipt_at + c_dup_slop
      and (t.client_token is null or t.client_token not like 'rcpt-%')
  ) then
    raise exception 'RECEIPT_ALREADY_EARNED';
  end if;

  -- First insert wins. The unique index turns the two-phones-one-receipt race
  -- into a clean loser-sees-RECEIPT_CLAIMED, whatever the commit interleaving.
  begin
    insert into receipt_claims (user_id, vendor_id, receipt_at, total, points)
    values (p_user_id, p_vendor_id, v_receipt_at, p_total, p_points)
    returning id into v_claim_id;
  exception when unique_violation then
    raise exception 'RECEIPT_CLAIMED';
  end;

  -- Token from the receipt's natural key: the same receipt always derives the
  -- same token, so award_points' (vendor_id, client_token) unique index is a
  -- second backstop behind the index above — and the community mint, revisit
  -- bump, and idempotency arrive with it for free.
  v_token := 'rcpt-' || md5(p_vendor_id::text || '|' || v_receipt_at::text || '|' || p_total::text);

  return query
    select v_claim_id, a.new_balance, a.new_community
    from award_points(p_user_id, p_vendor_id, p_points, p_total, v_token) a;
end;
$$;

revoke execute on function public.claim_receipt(uuid, uuid, timestamp, text, numeric, integer) from public, anon, authenticated;
grant  execute on function public.claim_receipt(uuid, uuid, timestamp, text, numeric, integer) to service_role;

commit;
