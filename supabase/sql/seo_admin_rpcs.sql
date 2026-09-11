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
    page text, clicks bigint, impressions bigint, position numeric,
    prior_clicks bigint, prior_impressions bigint, prior_position numeric
)
language sql stable
set search_path = public
as $$
    select
        cur.page,
        coalesce(cur.clicks, 0), coalesce(cur.impressions, 0), cur.position,
        coalesce(pri.clicks, 0), coalesce(pri.impressions, 0), pri.position
    from (
        select page, sum(clicks) as clicks, sum(impressions) as impressions,
               sum(position * impressions) / nullif(sum(impressions), 0) as position
        from seo_pages_daily
        where client_name = p_client and date between p_start and p_end
        group by page
    ) cur
    left join (
        select page, sum(clicks) as clicks, sum(impressions) as impressions,
               sum(position * impressions) / nullif(sum(impressions), 0) as position
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
    query text, clicks bigint, impressions bigint, position numeric,
    prior_clicks bigint, prior_impressions bigint, prior_position numeric
)
language sql stable
set search_path = public
as $$
    select
        cur.query,
        coalesce(cur.clicks, 0), coalesce(cur.impressions, 0), cur.position,
        coalesce(pri.clicks, 0), coalesce(pri.impressions, 0), pri.position
    from (
        select query, sum(clicks) as clicks, sum(impressions) as impressions,
               sum(position * impressions) / nullif(sum(impressions), 0) as position
        from seo_queries_daily
        where client_name = p_client and date between p_start and p_end
        group by query
    ) cur
    left join (
        select query, sum(clicks) as clicks, sum(impressions) as impressions,
               sum(position * impressions) / nullif(sum(impressions), 0) as position
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
create or replace function seo_keyword_summary(
    p_client text, p_start date, p_end date, p_prior_start date, p_prior_end date
)
returns table (
    keyword text, target_page text,
    rank int, map_rank int, rank_date date,
    prior_rank int,
    gsc_clicks bigint, gsc_impressions bigint, gsc_position numeric
)
language sql stable
set search_path = public
as $$
    select
        k.keyword, k.target_page,
        cur.organic_rank, cur.map_rank, cur.date,
        pri.organic_rank,
        coalesce(q.clicks, 0), coalesce(q.impressions, 0), q.position
    from seo_keywords k
    left join lateral (
        select src.organic_rank, src.map_rank, src.date
        from seo_rank_checks src
        where src.client_name = k.client_name and src.keyword = k.keyword
          and src.date between p_start and p_end and src.organic_rank is not null
        order by src.date desc, src.organic_rank asc
        limit 1
    ) cur on true
    left join lateral (
        select src.organic_rank
        from seo_rank_checks src
        where src.client_name = k.client_name and src.keyword = k.keyword
          and src.date between p_prior_start and p_prior_end and src.organic_rank is not null
        order by src.date desc, src.organic_rank asc
        limit 1
    ) pri on true
    left join (
        select query, sum(clicks) as clicks, sum(impressions) as impressions,
               sum(position * impressions) / nullif(sum(impressions), 0) as position
        from seo_queries_daily
        where client_name = p_client and date between p_start and p_end
        group by query
    ) q on q.query = k.keyword
    where k.client_name = p_client and k.active
    order by (cur.organic_rank is null), cur.organic_rank asc nulls last, k.keyword asc;
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
