-- ============================================================
-- Migration 012 — quick-amount buttons become a SET dollar value.
--   vendors.tiers used to be dollar RANGES ({label, min, max}) whose points
--   were the midpoint × ratio. They are now a fixed amount ({label, amount}),
--   which the AWARD screen renders as tap-to-award buttons. This:
--     1. converts existing range rows to a single amount (the old midpoint), and
--     2. updates the column default for fresh vendors.
-- Run in the Supabase SQL Editor after migration-011 (safe to re-run — the
-- conversion only touches rows that still hold the old min/max shape).
-- ============================================================

-- 1. Convert any remaining {label, min, max} entries to {label, amount}.
--    WITH ORDINALITY + ORDER BY keeps the buttons in their original order.
update public.vendors
set tiers = (
  select jsonb_agg(
    case
      when elem ? 'amount' then elem   -- already migrated: leave as-is
      else jsonb_build_object(
        'label', elem->>'label',
        'amount', round((coalesce((elem->>'min')::numeric, 0)
                       + coalesce((elem->>'max')::numeric, 0)) / 2.0, 2)
      )
    end
    order by ord
  )
  from jsonb_array_elements(tiers) with ordinality as t(elem, ord)
)
where tiers is not null
  and exists (select 1 from jsonb_array_elements(tiers) e where e ? 'min');

-- 2. New default shape for vendors created from here on.
alter table public.vendors
  alter column tiers set default '[
    {"label": "Snack",     "amount": 3},
    {"label": "Small",     "amount": 7},
    {"label": "Meal",      "amount": 12},
    {"label": "Big order", "amount": 20}
  ]'::jsonb;
