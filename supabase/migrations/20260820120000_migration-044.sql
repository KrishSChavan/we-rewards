-- ============================================================
-- Migration 044 — Point pools: one purse shared across an owner's locations.
--
--   Since migration-043 one login can run several vendors, and every one of
--   them is its own shop: own points, own items, own deals, own stats, own PIN.
--   043's own header says that a shared-purse chain "wants its own table and its
--   own migration". THIS IS THAT TABLE AND THAT MIGRATION. Read 043's note as
--   history, not as a standing decision.
--
--   WHAT SHARING MEANS. A customer earns at any location in the pool and spends
--   at any other. Earn 500 at Downtown, buy a 350-point coffee at Campus. The
--   menu is NOT shared (each location keeps its own reward items), visits are
--   NOT shared, and a redeem code is still minted for one location. Only the
--   money is common.
--
--   THE ONE IDEA: MEMBERSHIP IS THE TOGGLE.
--
--   A location's purse is decided structurally, by one nullable column on its
--   own vendors row:
--
--     pool_id IS NULL      → the purse is point_balances(user_id, vendor_id).
--                            Every line of behaviour that exists today, byte for
--                            byte. This is where every vendor starts and where
--                            nearly all of them stay.
--     pool_id IS NOT NULL  → the purse is pool_balances(user_id, pool_id).
--                            One row, one lock, one check (balance >= 0).
--
--   There is deliberately NO `sharing_enabled` boolean. A flag sitting beside a
--   membership pointer creates a state — in a pool but not sharing — where a
--   customer has two live purses at one counter, and every read path has to
--   agree about which one is real at the exact moment of a write. Sharing IS
--   co-membership. Joining is switching it on; leaving is switching it off.
--
--   WHY A SECOND TABLE RATHER THAN RE-KEYING point_balances.
--
--   Re-keying the money table to (user_id, group_id) is the more normalised
--   model and, with a rehearsal environment, the better one. We do not have one:
--   production migrations are applied by pasting into the Supabase SQL editor
--   because the CLI cannot reach that project (the account it lives in), and
--   there is no staging copy of the real balances. A one-shot ALTER that
--   rewrites every row of the platform's money table, by hand, is not a risk
--   worth taking to avoid a null check. It would also tax every solo vendor —
--   which is nearly all of them — with a group-of-one they will never use.
--
--   The branch is the price of that safety, and it is paid in exactly four SQL
--   functions (award_points, redeem_by_code, reverse_transaction,
--   transfer_community_points) plus campaign_audience. See migration 045.
--
--   THIS FILE IS INERT. It creates tables and one column. It changes no
--   function body and no existing row: every vendor gets pool_id = null, which
--   is the "behave exactly as before" branch. Nothing shares points until an
--   operator creates a pool and calls pool_join (migration 046). Applying this
--   to production changes nothing a vendor or a student can see.
--
--   ⚠ DEPLOY ORDER: run this BEFORE deploying the server code that reads
--   pool_id — src/lib/cache.js selects it as part of the catalogue query, and
--   PostgREST answers 400 to the WHOLE request on one unknown column, which
--   would take out the student home screen. (The reverse order is safe for the
--   DB: nothing here is read until the server asks.)
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-043. Safe to re-run (IF NOT EXISTS throughout, and the constraints
--   and triggers are added idempotently).
-- ============================================================

-- Every statement below takes a lock on a table the POS is actively using.
-- requireVendor runs `select vendor_id, vendors(*)` on EVERY /api/vendor/*
-- request, so one forgotten open transaction in another SQL-editor tab holding
-- ACCESS SHARE on vendors turns a millisecond ALTER into an unbounded outage at
-- every till on the platform. Fail fast and let the operator retry instead.
set lock_timeout = '3s';

-- ---------- 1. the pool ----------
-- Deliberately thin. A pool is an identity for a purse and a name to show a
-- customer ("Shared across 3 Joe's Pizza spots"), nothing more. It carries no
-- earning rate, no menu, no settings: those stay on each vendors row, because
-- each location is still its own shop.
--
-- It is NOT "the owner" and must not grow into one. Ownership is vendor_staff,
-- which is a many-to-many and cannot answer "which owner is this" without
-- ambiguity (a vendor with two staff logins; two logins with overlapping
-- vendors). A pool is an explicit set an operator curates, which is exactly why
-- it can be unambiguous where a derived owner-set cannot.

create table if not exists public.point_pools (
  id         uuid primary key default gen_random_uuid(),
  label      text not null,                -- shown to customers: "Joe's Pizza"
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.point_pools'::regclass
      and conname = 'point_pools_label_len'
  ) then
    alter table public.point_pools
      add constraint point_pools_label_len
      check (char_length(label) between 1 and 80);
  end if;
end $$;

comment on table public.point_pools is
  'A shared points purse for one owner''s locations (migration-044). Membership '
  'is vendors.pool_id; the balance is pool_balances. Not an owner entity and not '
  'a settings holder — each location keeps its own rate, menu, PIN and stats.';

-- ---------- 2. membership ----------
-- ON DELETE RESTRICT, not SET NULL: a pool must never be dropped out from under
-- locations whose customers' money is inside it. Retiring a pool is a deliberate
-- act that first has to empty it (pool_delete, migration 046).

alter table public.vendors
  add column if not exists pool_id uuid references public.point_pools (id) on delete restrict;

alter table public.vendors
  add column if not exists pool_joined_at timestamptz;

comment on column public.vendors.pool_id is
  'Which shared purse this location spends from, or NULL for its own '
  'point_balances (the default, and the pre-044 behaviour). Set only by '
  'pool_join/pool_leave — never by a settings save.';

comment on column public.vendors.pool_joined_at is
  'When this location joined its current pool. The window for its contribution '
  'when it later leaves: trading before this instant belongs to the location, '
  'not to the pool. Reset on every join, which is what makes leave/rejoin '
  'compose correctly.';

-- Partial: nearly every vendors row is NULL here, forever.
create index if not exists idx_vendors_pool
  on public.vendors (pool_id) where pool_id is not null;

-- ---------- 3. the shared purse ----------
-- Mirrors point_balances exactly (same integer, same non-negative check, same
-- cascade from profiles) with pool_id where vendor_id was. Two terminals of one
-- pool converge on ONE row, which is the entire concurrency story: Postgres
-- takes a row lock, the second UPDATE re-evaluates `balance >= cost` against the
-- committed version, and a double-spend cannot happen.
--
-- pool_id is ON DELETE RESTRICT for the same reason as vendors.pool_id, and it
-- deliberately gives this table NO cascade path from vendors. Today
-- `vendors → point_balances` is ON DELETE CASCADE (schema.sql:53), so deleting a
-- vendor destroys its balances. If a chain's shared purse hung off any one
-- vendors row, deleting that one branch would silently zero every customer's
-- balance across the whole chain, with no error and no audit row. It does not
-- hang off a vendor; DELETE of a pooled vendor is refused outright (046).

create table if not exists public.pool_balances (
  user_id    uuid not null references public.profiles (user_id) on delete cascade,
  pool_id    uuid not null references public.point_pools (id)   on delete restrict,
  balance    integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, pool_id)
);

comment on table public.pool_balances is
  'The shared points purse: one row per (customer, pool). The purse for a vendor '
  'with pool_id set; point_balances remains the purse for every vendor without '
  'one. Written ONLY by the RPCs, same as point_balances (see the guard below).';

-- "every customer holding a balance in this pool" — the leave split and the
-- operator's pool view both scan by pool.
create index if not exists idx_pool_balances_pool on public.pool_balances (pool_id);

-- ---------- 4. the audit trail ----------
-- What each location put into the pool, and took back out. This is not
-- decoration: it is the arithmetic of leaving. A location that leaves takes back
-- what its own trading funded, and that number is computed from these rows plus
-- the transactions it wrote while a member. Without them, leaving can only
-- confiscate (zero the customer) or duplicate (mint liability from nothing).
--
-- NOT the ledger. transactions stays the record of what was earned and spent,
-- unchanged and still keyed to the true location. These rows describe money
-- MOVING BETWEEN PURSES, which is not an earn and not a redeem, and giving it a
-- transactions.type would land it in the else-arm of rollupVendorAnalytics
-- (where a redeem's negative points are subtracted and the redemption count is
-- decremented) and in front of migration-027's DO block, which drops every CHECK
-- on transactions matching '%earn%' and is labelled safe to re-run.

create table if not exists public.pool_moves (
  id         uuid primary key default gen_random_uuid(),
  pool_id    uuid not null references public.point_pools (id)   on delete restrict,
  -- SET NULL rather than CASCADE, matching migrations 011/017: the audit row has
  -- to outlive the location and the account it describes.
  vendor_id  uuid references public.vendors (id)          on delete set null,
  user_id    uuid references public.profiles (user_id)    on delete set null,
  kind       text not null check (kind in ('join', 'leave')),
  -- Signed: + into the pool on join, - out of it on leave. NEVER zero — a move
  -- of nothing is not a move, and a zero row would make the contribution sums
  -- below noisier without saying anything. pool_leave (046) must therefore SKIP
  -- customers whose share works out to zero rather than writing a 0 row; the
  -- constraint is here to make that a loud 23514 instead of a silent drift.
  amount     integer not null check (amount <> 0),
  created_at timestamptz not null default now()
);

comment on table public.pool_moves is
  'Ledger of money moving between a location''s own purse and its pool: one row '
  'per (customer, location) per join or leave. The input to the contribution '
  'split that decides what a leaving location takes with it.';

create index if not exists idx_pool_moves_pool_user on public.pool_moves (pool_id, user_id);
create index if not exists idx_pool_moves_vendor    on public.pool_moves (vendor_id);

-- ---------- 5. an index the JOIN drain needs ----------
-- point_balances has carried exactly one index since the first schema: its
-- primary key (user_id, vendor_id). Every read the app makes is by user, so
-- that has always been enough. pool_join is the first query in the product to
-- ask "every balance AT THIS VENDOR", and it asks with FOR UPDATE while holding
-- the vendors row — a sequential scan there would hold row locks across the
-- whole money table and block every award at that location for its duration.
create index if not exists idx_point_balances_vendor on public.point_balances (vendor_id);

-- ---------- 6. THE 025 GUARD, EXTENDED ----------
-- pool_balances is a balance table, so it gets the same fence point_balances,
-- transactions and community_balances have: no direct DML from the table editor,
-- a leaked service-role key, or a pasted snippet. Only a SECURITY DEFINER RPC
-- that announces itself with the transaction-local app.points_write GUC may
-- write it. pool_moves gets the same treatment: it is the evidence the leave
-- split is computed from, so a hand-written row there is a way to walk money out
-- of a pool without the ledger showing it.
--
-- ⚠ NEVER IMPLEMENT ANY PART OF SHARING AS A TRIGGER ON A BALANCE TABLE.
-- enforce_points_write_guard's second escape (025:106-116) permits ANY write
-- reached from inside another trigger (pg_trigger_depth() > 1), because that is
-- how FK cascades arrive. A "mirror the balance into the pool" trigger would
-- therefore bypass the guard completely, silently, with no audit — which is the
-- one shape of this feature that could move money with nothing to read
-- afterwards. Sharing lives in the RPC bodies (045), where it is legible.

drop trigger if exists trg_points_guard_row on public.pool_balances;
create trigger trg_points_guard_row
  before insert or update or delete on public.pool_balances
  for each row execute function public.enforce_points_write_guard();

drop trigger if exists trg_points_guard_truncate on public.pool_balances;
create trigger trg_points_guard_truncate
  before truncate on public.pool_balances
  for each statement execute function public.enforce_points_write_guard();

drop trigger if exists trg_points_guard_row on public.pool_moves;
create trigger trg_points_guard_row
  before insert or update or delete on public.pool_moves
  for each row execute function public.enforce_points_write_guard();

drop trigger if exists trg_points_guard_truncate on public.pool_moves;
create trigger trg_points_guard_truncate
  before truncate on public.pool_moves
  for each statement execute function public.enforce_points_write_guard();

-- ---------- 7. RLS + GRANTS ----------
-- Same posture as point_balances after migration-037: RLS on, one own-row select
-- policy for shape, and no table privileges for anon/authenticated at all (which
-- makes the policy inert — the students' balances are served by Express with the
-- service key, not through the Data API). The policy is still written, so that
-- if the Data API is ever opened up, this table is already correct.

alter table public.point_pools   enable row level security;
alter table public.pool_balances enable row level security;
alter table public.pool_moves    enable row level security;

drop policy if exists "own pool balance" on public.pool_balances;
create policy "own pool balance" on public.pool_balances
  for select using (auth.uid() = user_id);

-- Belt-and-braces beside 036's default grants and 037's default revokes, and NOT
-- optional: a hosted project carries pg_default_acl entries that grant anon and
-- authenticated full DML on every new table in public at CREATE TABLE time, and
-- 037's `alter default privileges … revoke` only rewrites the defaults owned by
-- the role that ran it. Production applies this file by SQL-editor paste, which
-- is a different role again. 038 and 039 each carry this same line for this same
-- reason; without it, three new tables — one of them a money table — would be
-- readable and writable with the public anon key.
grant  all privileges on public.point_pools   to service_role;
grant  all privileges on public.pool_balances to service_role;
grant  all privileges on public.pool_moves    to service_role;
revoke all privileges on public.point_pools   from public, anon, authenticated;
revoke all privileges on public.pool_balances from public, anon, authenticated;
revoke all privileges on public.pool_moves    from public, anon, authenticated;

-- New tables and a new column: PostgREST answers from a cached schema and would
-- 404 the tables and 400 any select naming pool_id until it reloads.
notify pgrst, 'reload schema';
