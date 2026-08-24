-- ============================================================
-- Migration 048 — "Where haven't I been?": the Recommended row learns which
--                 spots a student has already walked into.
--
--   ONE FUNCTION. public.student_visited_vendor_ids(uuid) returns the ids of
--   every vendor this student has any history with, so the Home carousel's
--   RECOMMENDED row can stop recommending the place they had lunch at
--   yesterday. A recommendation is an answer to "where should I go next", and
--   a spot they already know is not an answer to that question.
--
--   WHY A FUNCTION AND NOT A QUERY IN NODE. This is the one per-student read in
--   this feature that is genuinely ALL-TIME — "ever been" has no window — and
--   supabase/config.toml sets `max_rows = 1000`. An unpaginated
--   `.select('vendor_id').eq('user_id', ...)` over transactions therefore
--   TRUNCATES SILENTLY at a thousand rows, and the failure mode is the worst
--   kind: a heavy student's oldest spots quietly read back as "never visited"
--   and get recommended to them forever. Every other per-user pull in this
--   codebase (src/lib/tiers.js, the recent-spots reads in src/routes/student.js)
--   dodges that only because a `created_at` window bounds it, and that is the
--   exact bound this question removes.
--
--   Doing the DISTINCT in SQL also ships one row per VENDOR instead of one row
--   per transaction — tens of rows rather than a thousand — on what is the
--   hottest read in the app (GET /api/me/balances runs on every socket push).
--
--   TWO SOURCES, UNIONed, because neither is a superset of the other:
--
--     transactions — an 'earn' or a 'redeem'. `community_transfer` is excluded
--       for the same reason top_vendors_by_visits excludes it (migration-041):
--       moving pooled points happens inside the app, not at a counter, so it is
--       not evidence the student has ever set foot in the place.
--
--     punch_cards — a scanned visit. A punch is the one kind of activity that
--       writes no transaction row at all (src/routes/student.js), so a student
--       who only ever scans would read back as having been nowhere.
--
--       EXISTENCE, not `punches > 0`. Redeeming a visits-priced reward assigns
--       the counter back to zero (migration-045: "assignment, never
--       subtraction"), so a `punches > 0` test would forget every regular the
--       moment they cashed a card in — precisely the customers most likely to
--       be recommended somewhere they already go.
--
--       Existence is safe because no path creates a card out of nothing.
--       punch_in() (migration-029) creates one on a scan; reverse_transaction
--       (migration-045) re-creates one only to give back visits that were spent
--       at that vendor, which the student must have earned by being there. Both
--       writers imply a visit, so the row IS the evidence.
--
--   NOT the balance. A pooled spot shows its chain's balance (migration-044),
--   so a positive number on a card is not evidence the student was ever at THAT
--   location — it may have been earned two towns over.
--
--   PERFORMANCE. Both halves are user_id-leading index prefix scans:
--   idx_tx_user_vendor_time (user_id, vendor_id, created_at) from schema.sql and
--   idx_punch_cards_one_per_vendor (user_id, vendor_id) from migration-029. The
--   punch_cards half is index-only. The transactions half is NOT: `type` is not
--   in that index, so it costs a heap fetch per row. The filter is kept anyway —
--   recommending a spot on the strength of a pool transfer would be wrong, and
--   this is one small query per home load, not a hot loop.
--
--   SECURITY. security definer + a pinned search_path, so it reads regardless
--   of the caller's RLS, and execute is service_role only. Unlike
--   top_vendors_by_visits this returns a single student's history, so it must
--   never be reachable with the anon key — GET /api/public-config hands that
--   key to every browser.
--
--   HOW TO APPLY: paste into the Supabase SQL Editor and run, after
--   migration-047. Safe to re-run. Creates no table and changes no data.
--
--   IF IT IS NOT APPLIED the app still serves: src/routes/student.js falls back
--   to the per-student reads it already has in hand — a punch card at the spot,
--   or a transaction inside the 7-day recent window. That is NARROWER than this
--   function, not equal to it: a purchase from two months ago stops counting, so
--   a spot the student has not been to lately can still be recommended. It
--   under-claims by design, which is the safe direction to be wrong in.
-- ============================================================

begin;

create or replace function public.student_visited_vendor_ids(p_user_id uuid)
returns table (vendor_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  -- UNION, not UNION ALL: the dedupe is the entire point of doing this in SQL.
  select t.vendor_id
    from public.transactions t
   where t.user_id = p_user_id
     and t.type in ('earn', 'redeem')
  union
  select pc.vendor_id
    from public.punch_cards pc
   where pc.user_id = p_user_id;
$$;

comment on function public.student_visited_vendor_ids(uuid) is
  'Every vendor this student has ever transacted with or scanned a visit at. Feeds the Recommended row, which shows only spots they have NOT been to.';

revoke all on function public.student_visited_vendor_ids(uuid) from public, anon, authenticated;
grant execute on function public.student_visited_vendor_ids(uuid) to service_role;

commit;
