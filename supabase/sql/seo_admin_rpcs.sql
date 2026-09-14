-- Aggregation for the admin SEO tab. Run once in the SQL Editor.
--
-- Every function here is left as SECURITY INVOKER (Postgres's default — none of them
-- write `security definer`), which is what makes them safe to expose to `authenticated`
-- at all: the CALLER's own RLS decides what rows they can see. An admin gets every
-- client's rows; a client calling the same function gets only their own, exactly as if
-- they'd queried seo_pages_daily directly. search_path is still pinned as a defense in
-- depth habit, the same reasoning as client_row_visible — a caller manipulating their own
-- search_path shouldn't be able to shadow a table name these functions read.
--
-- None of these hand raw per-day rows to the browser. seo_pages_daily and
-- seo_queries_daily are far past the 1000-row PostgREST cap for a real client's history
-- (see CLAUDE.md) — every function below returns one row per page, per query, or per
-- keyword, never one row per day.
--
-- Position is always impression-weighted: sum(position * impressions) /
-- nullif(sum(impressions), 0). Never avg(position) — see CLAUDE.md, and the
-- renderAdminSeo/renderCpSeo bug this replaces.

create or replace function seo_page_summary(
    p_client text, p_start date, p_end date, p_prior_start date, p_prior_end date,
    p_limit int default 25
)
returns table (
    page text, clicks bigint, impressions bigint, weighted_position numeric,
    prior_clicks bigint, prior_impressions bigint, prior_position numeric
)
language sql stable
set search_path = public
as $$
    select
        cur.page,
        coalesce(cur.clicks, 0), coalesce(cur.impressions, 0), cur.weighted_position,
        coalesce(pri.clicks, 0), coalesce(pri.impressions, 0), pri.weighted_position
    from (
        select page, sum(clicks) as clicks, sum(impressions) as impressions,
               sum(position * impressions) / nullif(sum(impressions), 0) as weighted_position
        from seo_pages_daily
        where client_name = p_client and date between p_start and p_end
        group by page
    ) cur
    left join (
        select page, sum(clicks) as clicks, sum(impressions) as impressions,
               sum(position * impressions) / nullif(sum(impressions), 0) as weighted_position
        from seo_pages_daily
        where client_name = p_client and date between p_prior_start and p_prior_end
        group by page
    ) pri using (page)
    order by cur.clicks desc
    limit p_limit;
$$;
grant execute on function seo_page_summary(text, date, date, date, date, int) to authenticated;

-- Same shape, over queries, ordered by IMPRESSIONS rather than clicks: a query with real
-- impressions and zero clicks is exactly "we show up, nobody clicks yet" — the thing
-- worth seeing that a clicks-only ranking would bury.
create or replace function seo_query_summary(
    p_client text, p_start date, p_end date, p_prior_start date, p_prior_end date,
    p_limit int default 25
)
returns table (
    query text, clicks bigint, impressions bigint, weighted_position numeric,
    prior_clicks bigint, prior_impressions bigint, prior_position numeric
)
language sql stable
set search_path = public
as $$
    select
        cur.query,
        coalesce(cur.clicks, 0), coalesce(cur.impressions, 0), cur.weighted_position,
        coalesce(pri.clicks, 0), coalesce(pri.impressions, 0), pri.weighted_position
    from (
        select query, sum(clicks) as clicks, sum(impressions) as impressions,
               sum(position * impressions) / nullif(sum(impressions), 0) as weighted_position
        from seo_queries_daily
        where client_name = p_client and date between p_start and p_end
        group by query
    ) cur
    left join (
        select query, sum(clicks) as clicks, sum(impressions) as impressions,
               sum(position * impressions) / nullif(sum(impressions), 0) as weighted_position
        from seo_queries_daily
        where client_name = p_client and date between p_prior_start and p_prior_end
        group by query
    ) pri using (query)
    order by cur.impressions desc
    limit p_limit;
$$;
grant execute on function seo_query_summary(text, date, date, date, date, int) to authenticated;

-- Tracked keywords: SE Ranking's own rank next to what GSC says the exact same phrase is
-- doing as a search query. "rank" is the best position seen across every location tracked
-- for that keyword, on its most recently checked day within the window — not an average
-- across the window, and not blended across days, because "where do we stand right now"
-- is the question this table answers. A keyword with real GSC clicks and no SE Ranking
-- rank yet is either not being checked, or ranking below SE Ranking's tracked depth —
-- both worth seeing side by side rather than left to cross-reference by eye across two
-- tools.
--
-- Map pack counts as ranking. The first version only looked at days with an organic rank, so
-- a keyword sitting #2 in the map pack with no organic listing showed as "not ranking" — for a
-- local contractor, often the one ranking that matters most. Now each window takes the most
-- recent day with EITHER rank, and the best organic and best map position across every
-- tracked location on that day (min() ignores nulls, so one location's map rank and another's
-- organic rank both survive).
--
-- The return columns changed (prior_map_rank, ranking_url added), and Postgres can't change a
-- function's return type with create or replace, hence the drop first.
drop function if exists seo_keyword_summary(text, date, date, date, date);
create function seo_keyword_summary(
    p_client text, p_start date, p_end date, p_prior_start date, p_prior_end date
)
returns table (
    keyword text, target_page text,
    rank int, map_rank int, rank_date date, ranking_url text,
    prior_rank int, prior_map_rank int,
    gsc_clicks bigint, gsc_impressions bigint, gsc_position numeric
)
language sql stable
set search_path = public
as $$
    select
        k.keyword, k.target_page,
        cur.organic_rank, cur.map_rank, cur.date, cur.ranking_url,
        pri.organic_rank, pri.map_rank,
        coalesce(q.clicks, 0), coalesce(q.impressions, 0), q.weighted_position
    from seo_keywords k
    left join lateral (
        select src.date,
               min(src.organic_rank) as organic_rank,
               min(src.map_rank) as map_rank,
               max(src.ranking_url) as ranking_url
        from seo_rank_checks src
        where src.client_name = k.client_name and src.keyword = k.keyword
          and src.date between p_start and p_end
          and (src.organic_rank is not null or src.map_rank is not null)
        group by src.date
        order by src.date desc
        limit 1
    ) cur on true
    left join lateral (
        select min(src.organic_rank) as organic_rank, min(src.map_rank) as map_rank
        from seo_rank_checks src
        where src.client_name = k.client_name and src.keyword = k.keyword
          and src.date between p_prior_start and p_prior_end
          and (src.organic_rank is not null or src.map_rank is not null)
        group by src.date
        order by src.date desc
        limit 1
    ) pri on true
    left join (
        select query, sum(clicks) as clicks, sum(impressions) as impressions,
               sum(position * impressions) / nullif(sum(impressions), 0) as weighted_position
        from seo_queries_daily
        where client_name = p_client and date between p_start and p_end
        group by query
    ) q on q.query = k.keyword
    where k.client_name = p_client and k.active
    -- Ranking anywhere first, then by organic rank, map-only keywords after the organic ones,
    -- and keywords not ranking at all last.
    order by (cur.organic_rank is null and cur.map_rank is null),
             cur.organic_rank asc nulls last, cur.map_rank asc nulls last, k.keyword asc;
$$;
grant execute on function seo_keyword_summary(text, date, date, date, date) to authenticated;

-- Top movers among pages AND queries together, current vs prior. impressions >= 50 in
-- EITHER window keeps a page with 3 impressions from reading as a 300% gainer on noise —
-- same principle as the weekly report's ban on narrating small-count swings as trends.
create or replace function seo_movers(
    p_client text, p_start date, p_end date, p_prior_start date, p_prior_end date,
    p_limit int default 5
)
returns table (
    kind text, name text, clicks bigint, prior_clicks bigint, click_delta bigint,
    impressions bigint, prior_impressions bigint
)
language sql stable
set search_path = public
as $$
    with combined as (
        select 'page' as kind, page as name,
               sum(clicks) filter (where date between p_start and p_end) as clicks,
               sum(clicks) filter (where date between p_prior_start and p_prior_end) as prior_clicks,
               sum(impressions) filter (where date between p_start and p_end) as impressions,
               sum(impressions) filter (where date between p_prior_start and p_prior_end) as prior_impressions
        from seo_pages_daily
        where client_name = p_client
          and (date between p_start and p_end or date between p_prior_start and p_prior_end)
        group by page
        union all
        select 'query' as kind, query as name,
               sum(clicks) filter (where date between p_start and p_end),
               sum(clicks) filter (where date between p_prior_start and p_prior_end),
               sum(impressions) filter (where date between p_start and p_end),
               sum(impressions) filter (where date between p_prior_start and p_prior_end)
        from seo_queries_daily
        where client_name = p_client
          and (date between p_start and p_end or date between p_prior_start and p_prior_end)
        group by query
    )
    select kind, name, coalesce(clicks, 0), coalesce(prior_clicks, 0),
           coalesce(clicks, 0) - coalesce(prior_clicks, 0) as click_delta,
           coalesce(impressions, 0), coalesce(prior_impressions, 0)
    from combined
    where coalesce(impressions, 0) >= 50 or coalesce(prior_impressions, 0) >= 50
    order by abs(coalesce(clicks, 0) - coalesce(prior_clicks, 0)) desc
    limit p_limit;
$$;
grant execute on function seo_movers(text, date, date, date, date, int) to authenticated;

-- Almost page 1: searches where the client already shows up, just past the first page
-- (impression-weighted position above 10, up to 20), with real impressions behind them. Page 2
-- gets a small fraction of page 1's clicks, so these are the highest-return targets for content
-- and on-page work. Google already considers the page relevant, it just needs a push.
--
-- Ordered by impressions, meaning the most searched first. The impressions floor is passed in by
-- the caller, scaled to the window length, so a 90-day view isn't flooded with queries that
-- got two impressions a month. prior_position shows which way each query is already moving, and
-- `tracked` flags queries SE Ranking is already watching.
create or replace function seo_almost_page_one(
    p_client text, p_start date, p_end date, p_prior_start date, p_prior_end date,
    p_min_impressions int default 10, p_limit int default 20
)
returns table (
    query text, clicks bigint, impressions bigint, weighted_position numeric,
    prior_position numeric, tracked boolean
)
language sql stable
set search_path = public
as $$
    with cur as (
        select q.query, sum(q.clicks) as clicks, sum(q.impressions) as impressions,
               sum(q.position * q.impressions) / nullif(sum(q.impressions), 0) as weighted_position
        from seo_queries_daily q
        where q.client_name = p_client and q.date between p_start and p_end
        group by q.query
    ),
    pri as (
        select q.query,
               sum(q.position * q.impressions) / nullif(sum(q.impressions), 0) as weighted_position
        from seo_queries_daily q
        where q.client_name = p_client and q.date between p_prior_start and p_prior_end
        group by q.query
    )
    select cur.query, cur.clicks, cur.impressions,
           round(cur.weighted_position, 1), round(pri.weighted_position, 1),
           exists (select 1 from seo_keywords k
                   where k.client_name = p_client and k.keyword = cur.query and k.active)
    from cur
    left join pri on pri.query = cur.query
    where cur.weighted_position > 10 and cur.weighted_position <= 20
      and cur.impressions >= p_min_impressions
    order by cur.impressions desc, cur.weighted_position asc
    limit p_limit;
$$;
grant execute on function seo_almost_page_one(text, date, date, date, date, int, int) to authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Checking on it — run as yourself in the SQL Editor (runs as postgres, sees everything;
-- to test what a specific user sees, use the rolled-back-transaction pattern from
-- CLAUDE.md's Access model section instead)
-- ---------------------------------------------------------------------------
-- select * from seo_page_summary('3Sixty Industries', current_date - 6, current_date,
--   current_date - 13, current_date - 7);
-- select * from seo_keyword_summary('3Sixty Industries', current_date - 6, current_date,
--   current_date - 13, current_date - 7) order by rank nulls last limit 20;
-- select * from seo_movers('3Sixty Industries', current_date - 6, current_date,
--   current_date - 13, current_date - 7);
