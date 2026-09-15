-- ============================================================
-- Migration 058 — the referrer is paid at SIGNUP, not at first purchase.
--
--   WHAT CHANGES. migration-039 paid a referrer only once their friend had an
--   'earn' row: settle_referrals' WHERE carried an `exists (select 1 from
--   transactions …)` clause, and until that was true the referral sat pending.
--   That clause is gone. src/lib/referrals.js now pays the referrer inline at
--   attribution, next to the friend's bonus and on identical terms, and this
--   function drops to being the retry behind it.
--
--   ⚠ THIS DELETES THE PROGRAM'S PRINCIPAL ANTI-FRAUD CONTROL, and the
--   migration-039 header should be read as describing a rule that no longer
--   holds. Its reasoning was that a Google account is free and takes thirty
--   seconds while a purchase at a real counter cannot be manufactured — so the
--   purchase was the thing being paid for, and everything else was a backstop
--   to it. The backstops are now the whole defence:
--
--     · incentives.config.maxPerReferrer — the per-referrer cap. DEFAULTS TO 10
--       AND MAY BE SET TO UNLIMITED (blank) FROM THE ADMIN FORM. Unlimited was
--       a defensible setting when a payout required somebody to walk into a
--       shop; it is now the difference between a capped promotion and an open
--       tap. Set it.
--     · incentives.budget_points — the total the program may ever pay. Also
--       optional, also now load-bearing. Set it too.
--     · idx_referrals_one_per_friend — one attribution per account, ever. This
--       one is a real constraint rather than a setting, and it still holds: the
--       farm costs one fresh account per payout, it just no longer costs a
--       purchase.
--     · config.signupWindowDays — a code is claimable only for a window after
--       the account is created. Unchanged, and it never did much here: a fresh
--       account is inside the window by construction.
--
--   ⚠ THIS PAYS THE EXISTING BACKLOG ON THE NEXT TICK. Every referral sitting
--   at status='pending' today is pending precisely because the friend never
--   bought anything — that WAS the condition. Removing it makes all of them
--   immediately payable, and the sweep runs every 45 seconds. Look at
--   /admin → Incentives → Referrals, or
--
--     select count(*) from referrals where status = 'pending';
--
--   BEFORE running this, and multiply by the program's referrerPoints: that is
--   what leaves the budget within a minute of the paste. To keep any of it from
--   going out, void those rows first (`update referrals set status = 'void'
--   where status = 'pending'`) — void is the only status this function skips.
--
--   HEALING A TORN PAIR. Paying inline means two writes that can come apart:
--   grant_community_points moves the money, then referrals.status records that
--   it moved. If the second fails, the row is pending with the grant already
--   written — and the old exception handler read the resulting
--   GRANT_ALREADY_PAID as a failure, stamped qualified_at, and left it pending
--   for a next tick that would do exactly the same thing, forever. That error
--   is now read for what it means: the money is there, mark the row. This is
--   also what makes a sweep racing the inline payout harmless in both
--   directions, on top of the grant's own UNIQUE (ref_id, kind) index.
--
--   NO NEW POINTS PATH. Nothing here writes to a balance or a ledger directly;
--   grant_community_points is still the only thing that moves money, so the
--   migration-025 write guard, the idempotency index and the budget accounting
--   all apply exactly as they did.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-057. Safe to re-run. ⚠ Read the backlog warning above first —
--   this is the one migration in this project whose paste spends money by
--   itself.
-- ============================================================

begin;

-- ---------- 1. settle_referrals — now a retry, not a qualifier ----------

create or replace function public.settle_referrals(p_limit integer default 50)
returns table (settled integer, skipped integer)
language plpgsql security definer set search_path = public
as $$
declare
  r         record;
  v_settled integer := 0;
  v_skipped integer := 0;
begin
  for r in
    select rf.id, rf.referrer_id, rf.incentive_id, rf.referrer_points
      from referrals rf
     -- The `exists (… transactions …)` gate that used to sit here is gone; see
     -- the header. 'pending' now means only "owed and not yet paid", which for
     -- a healthy program is a set that stays empty — the inline payout in
     -- src/lib/referrals.js gets there first.
     where rf.status = 'pending'
     order by rf.created_at
     limit greatest(1, least(coalesce(p_limit, 50), 500))
     -- skip locked: two overlapping ticks (or two dynos) share the queue
     -- instead of one waiting on the other's locks.
     for update of rf skip locked
  loop
    begin
      if r.referrer_points > 0 then
        perform grant_community_points(
          r.referrer_id, r.referrer_points, 'referral_referrer',
          'Referral bonus', r.incentive_id, r.id, 'system'
        );
      end if;

      update referrals
         set status       = 'paid',
             qualified_at = coalesce(qualified_at, now()),
             paid_at      = now()
       where id = r.id;

      v_settled := v_settled + 1;
    exception when others then
      -- THE MONEY IS ALREADY THERE — an inline payout whose status update was
      -- lost, or a concurrent tick that won the race. Either way the row is
      -- what is wrong, not the balance, so mark it and count it settled. Doing
      -- anything else here is what strands the row forever: the retry is
      -- deterministic, so a tick that treats this as a failure will treat it as
      -- a failure every time.
      if sqlerrm like '%GRANT_ALREADY_PAID%' then
        update referrals
           set status       = 'paid',
               qualified_at = coalesce(qualified_at, now()),
               paid_at      = coalesce(paid_at, now())
         where id = r.id;
        v_settled := v_settled + 1;
      else
        -- One referral must never stall the batch. The commonest reason to land
        -- here is GRANT_BUDGET_EXHAUSTED, which is a state an operator can fix
        -- by raising the budget — so stamp qualified_at (the row rolled back to
        -- the savepoint, so this UPDATE is the only survivor) and leave it
        -- pending for the next tick to retry.
        update referrals set qualified_at = coalesce(qualified_at, now()) where id = r.id;
        v_skipped := v_skipped + 1;
      end if;
    end;
  end loop;

  return query select v_settled, v_skipped;
end;
$$;

revoke execute on function public.settle_referrals(integer) from public, anon, authenticated;
grant  execute on function public.settle_referrals(integer) to service_role;

-- ---------- 2. say what the columns mean now ----------
-- These are the operator's documentation of the rule, and the rule moved. The
-- old text described the purchase gate in so many words.

comment on table public.referrals is
  'One row per referred student. status pending -> paid at ATTRIBUTION for both '
  'sides (migration-058); pending now means a payout that was refused, not one '
  'waiting on a purchase. -> void when a merge proves the two accounts are one '
  'person (migration-057).';

comment on column public.referrals.qualified_at is
  'When the referral became payable. Since migration-058 that is attribution '
  'time, not the friend''s first earn. Stamped even if the payout was refused '
  '(exhausted budget), so a waiting referral is visible in /admin instead of '
  'looking like it never qualified.';

commit;
