\echo '=== visit totals per student (expect 3 / 10 / 0 / 12) ==='
select p.name, pc.punches as visits
from punch_cards pc join profiles p on p.user_id = pc.user_id
order by p.name;

\echo '=== duplicate counter rows (expect 0) ==='
select count(*) as dupes from (
  select user_id, vendor_id from punch_cards group by 1,2 having count(*) > 1) d;

\echo '=== punch audit rows survived + repointed (expect 3, all same card_id) ==='
select business_day, card_id from punches order by business_day;

\echo '=== unique index built? ==='
select indexname from pg_indexes
where tablename = 'punch_cards' and indexname = 'idx_punch_cards_one_per_vendor';

\echo '=== totals conserved vs backup (expect equal) ==='
select (select sum(case when completed_at is not null and redeemed_at is null then target
                        when completed_at is not null then 0 else punches end)
        from punch_cards_pre_029) as before,
       (select sum(punches) from punch_cards) as after;

\echo '=== punch_redeem_codes dropped? (expect f) ==='
select to_regclass('public.punch_redeem_codes') is not null as still_there;

\echo '=== retired RPCs gone? (expect 0) ==='
select count(*) as leftover from pg_proc
where proname in ('create_punch_redeem_code', 'redeem_punch_card');

\echo '=== card columns gone, new columns present? ==='
select column_name from information_schema.columns
where table_name = 'punch_cards' order by ordinal_position;

\echo '=== rewards dual pricing ==='
select column_name, is_nullable from information_schema.columns
where table_name = 'rewards' and column_name in ('cost_in_points', 'cost_in_visits');
