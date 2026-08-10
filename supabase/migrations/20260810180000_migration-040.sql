-- ============================================================
-- Migration 040 — Incentive kind #2: the signup bonus.
--
--   "Sign up with a .psu.edu address between these dates and get N community
--   points." One new value in the incentives.kind CHECK, and nothing else:
--   the payout rail (grant_community_points), the budget, the ledger, the
--   one-active-program-per-kind index and the idempotency index all came from
--   migration-039 and apply to this kind unchanged. That is the whole point of
--   how 039 was shaped — a new deal type should be an evaluator, not a schema.
--
--   THE IDEMPOTENCY KEY IS THE STUDENT. A payout is recorded with
--   ref_id = user_id and kind = 'signup_domain', so 039's
--   UNIQUE (ref_id, kind) index means one bonus per account, ever, whatever
--   the application does. That matters more here than it looks: the bonus is
--   evaluated in POST /api/me/accept-terms, which a student ALSO hits whenever
--   the terms are revised (src/lib/terms.js). Without the index, bumping
--   TERMS_VERSION would pay the whole campus a second time.
--
--   Belt and braces on top of that, in the evaluator rather than here: the
--   student's profiles.created_at must fall inside the program's window. A
--   re-accepting student signed up long before it, so they don't qualify even
--   on the first payout. See src/lib/signup-bonus.js.
--
--   WHY PENN STATE ADDRESSES WORK AT ALL: PSU accounts federate with Google,
--   so a student who signs in with their university address arrives with
--   profiles.email already holding it, verified by Google. This stack sends no
--   email and has no way to verify an address itself, so that federation is
--   the entire reason this deal is cheap rather than a whole new subsystem.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-039. Safe to re-run.
-- ============================================================

begin;

-- The CHECK is inline in migration-039's create table, so Postgres named it.
-- Look the name up rather than assuming it: an inline constraint's generated
-- name is not part of the contract, and a hard-coded DROP would fail on any
-- database where it differs. Same defensive shape migration-027 used on
-- transactions_type_check.
do $$
declare con record;
begin
  for con in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.incentives'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%kind%'
  loop
    execute format('alter table public.incentives drop constraint %I', con.conname);
  end loop;
end;
$$;

alter table public.incentives
  add constraint incentives_kind_check
  check (kind in ('referral', 'signup_domain'));

comment on column public.incentives.kind is
  'Which engine evaluates this deal. referral (migration-039), signup_domain '
  '(migration-040). Adding a value here without adding an evaluator would let '
  'an operator create a deal that silently never pays.';

commit;
