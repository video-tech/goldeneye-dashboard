-- Map Pack: a dedicated view of Google's local 3-pack, on the admin SEO tab.
--
-- Run this in the SQL Editor. No new tables — everything already lands in seo_rank_checks
-- (map_rank, synced daily by seranking-sync) and, for local clients, gbp_daily (Maps profile
-- views, from supabase/sql/gbp.sql). This just aggregates what's already there into a day-by-day
-- trend, which nothing on the tab shows today: seo_keyword_summary and seo_keyword_city_ranks
-- both collapse to the LATEST day in range, so there was no way to see the pack forming or
-- slipping over a week, only a snapshot.
--
-- "In the pack" means map_rank is not null (1, 2 or 3 — SE Ranking only fills map_rank when the
-- keyword actually shows in the pack; see parse.ts). A keyword can be in the pack in one tracked
-- city and not another, so both the trend and the per-keyword rows take the BEST (lowest) map_rank
-- across a client's tracked locations for a given keyword and day — the same "where do we stand
-- right now" rule as seo_keyword_summary, applied per day instead of once.

create or replace function seo_map_pack_report(
    p_client text, p_start date, p_end date, p_prior_start date, p_prior_end date
)
returns jsonb
language sql stable
set search_path = public
as $$
with
-- One row per keyword per day: the best (lowest) map rank across every tracked city that day.
-- min() ignores nulls, so a keyword only counts as "in the pack" on a day some city put it there.
daily_best as (
    select client_name, keyword, date, min(map_rank) as map_rank
    from seo_rank_checks
    where client_name = p_client and map_rank is not null
      and date between p_prior_start and p_end
    group by client_name, keyword, date
),
cur_daily as (select * from daily_best where date between p_start and p_end),
pri_daily as (select * from daily_best where date between p_prior_start and p_prior_end),
-- Per keyword, the latest day IN RANGE with a pack rank — "where do we stand right now",
-- same rule seo_keyword_summary uses for organic. A keyword absent from cur_daily entirely
-- never shows here (it's not in the pack for any tracked city in this range).
cur_kw as (
    select distinct on (keyword) keyword, date, map_rank
    from cur_daily order by keyword, date desc
),
pri_kw as (
    select distinct on (keyword) keyword, map_rank
    from pri_daily order by keyword, date desc
),
-- Best organic rank alongside, so a pack listing without an organic one isn't mistaken for
-- "not ranking at all" when the tab is read next to Tracked Keywords.
organic_now as (
    select keyword, min(organic_rank) as organic_rank
    from seo_rank_checks
    where client_name = p_client and date between p_start and p_end and organic_rank is not null
    group by keyword
),
-- City breakdown for keywords with more than one tracked location, so a keyword that's #1 in
-- one town and out of the pack in another isn't flattened to a single misleading number.
cities as (
    select k.keyword, l.label as city, k.map_rank
    from cur_kw k
    join lateral (
        select site_engine_id, min(map_rank) as map_rank
        from seo_rank_checks src
        where src.client_name = p_client and src.keyword = k.keyword and src.date = k.date
          and src.map_rank is not null
        group by site_engine_id
    ) per_engine on true
    join seo_rank_locations l on l.client_name = p_client and l.site_engine_id = per_engine.site_engine_id
),
gbp_cur as (select coalesce(sum(impressions_maps_mobile + impressions_maps_desktop), 0) as views
            from gbp_daily where client_name = p_client and date between p_start and p_end),
gbp_pri as (select coalesce(sum(impressions_maps_mobile + impressions_maps_desktop), 0) as views
            from gbp_daily where client_name = p_client and date between p_prior_start and p_prior_end)
select jsonb_build_object(
    'current', jsonb_build_object(
        'keywords_in_pack', (select count(*) from cur_kw),
        'top3_count', (select count(*) from cur_kw where map_rank = 1),
        'avg_position', (select round(avg(map_rank), 1) from cur_kw),
        'maps_views', (select views from gbp_cur)
    ),
    'prior', jsonb_build_object(
        'keywords_in_pack', (select count(*) from pri_kw),
        'avg_position', (select round(avg(map_rank), 1) from pri_kw),
        'maps_views', (select views from gbp_pri)
    ),
    -- One point per day the pack was checked at all: how many keywords were in it, and their
    -- average rank that day. This is the trend line nothing on the tab shows today.
    'trend', coalesce((
        select jsonb_agg(jsonb_build_object('date', date, 'count', cnt, 'avg_position', avg_pos) order by date)
        from (
            select date, count(*) as cnt, round(avg(map_rank), 2) as avg_pos
            from cur_daily group by date
        ) t), '[]'::jsonb),
    'keywords', coalesce((
        select jsonb_agg(jsonb_build_object(
            'keyword', c.keyword, 'map_rank', c.map_rank, 'prior_map_rank', p.map_rank,
            'organic_rank', o.organic_rank,
            'cities', (select jsonb_agg(jsonb_build_object('city', ci.city, 'map_rank', ci.map_rank) order by ci.map_rank)
                       from cities ci where ci.keyword = c.keyword)
        ) order by c.map_rank asc, c.keyword asc)
        from cur_kw c
        left join pri_kw p using (keyword)
        left join organic_now o using (keyword)
    ), '[]'::jsonb),
    'cities_tracked', (select count(distinct site_engine_id) from seo_rank_locations where client_name = p_client)
);
$$;
grant execute on function seo_map_pack_report(text, date, date, date, date) to authenticated;

notify pgrst, 'reload schema';
