-- Data for the client-facing SEO tab. Run once in the SQL Editor, then:
--   1. re-run supabase/sql/seo_admin_rpcs.sql (seo_keyword_summary now returns volume and CPC)
--   2. re-run supabase/sql/rename_client.sql (it now moves seo_project_daily)
--   3. deploy seranking-sync (it now fills the new columns and table)
--
-- Every function here is SECURITY INVOKER (the default), so a client calling it sees only what
-- their own RLS allows: the same rows they could select directly. search_path is pinned, as on
-- the admin RPCs.

-- ---------------------------------------------------------------------------
-- Keyword value: search volume and cost per click, from SE Ranking
-- ---------------------------------------------------------------------------
-- They arrive in the same positions response seranking-sync already pulls. search_volume null
-- means too small for SE Ranking to measure (it reports those as 0), not "nobody searches this".
alter table seo_keywords
    add column if not exists search_volume      integer,
    add column if not exists cpc                numeric(10, 2),
    add column if not exists competition        numeric(8, 3),
    add column if not exists metrics_updated_at timestamptz;

-- ---------------------------------------------------------------------------
-- One daily SE Ranking snapshot per client
-- ---------------------------------------------------------------------------
-- visibility_percent is SE Ranking's 0–100 "how visible for your target searches" score.
-- domain_trust is its authority score. seo_potential_* is extra monthly traffic and its ad value
-- if every target search reached the top 3. It's fetched at most weekly, so most days leave it null.
create table if not exists seo_project_daily (
    client_name           text not null,
    date                  date not null,
    visibility_percent    numeric(6, 2),
    visibility            integer,
    top5                  integer,
    top10                 integer,
    top30                 integer,
    avg_position          numeric(6, 2),
    domain_trust          integer,
    pages_indexed         integer,
    seo_potential_traffic integer,
    seo_potential_value   numeric(12, 2),
    synced_at             timestamptz not null default now(),
    primary key (client_name, date)
);
alter table seo_project_daily enable row level security;
drop policy if exists "Clients and admins read their own project snapshots" on seo_project_daily;
create policy "Clients and admins read their own project snapshots"
on seo_project_daily for select using (client_row_visible(client_name));

-- ---------------------------------------------------------------------------
-- Per-client SEO settings, edited in Edit Client
-- ---------------------------------------------------------------------------
-- seo_start_date is what "Since SEO started" compares against. seo_monthly_fee is what the ROI
-- multiple divides by, and the multiple is shown to a client only when it's above 1×.
alter table clients
    add column if not exists seo_start_date  date,
    add column if not exists seo_monthly_fee numeric(10, 2);

-- ---------------------------------------------------------------------------
-- seo_client_overview: everything the top of the client tab needs, in one call
-- ---------------------------------------------------------------------------
-- Windows are dates (the tab passes the selected range and the same-length range before it).
--
-- - Visits: Search Console clicks from seo_daily.
-- - Leads from Google: lead_sources rows with source = 'organic', counted by their Denver-time day.
-- - Jobs closed from Google: the "google" row of weekly_checkins.closes_by_source, for check-ins
--   whose week_start falls in the window. Matched on normalized client name, because text
--   check-ins arrive through Make and may not spell it exactly. checkins_with_sources counts
--   check-ins that gave a breakdown at all, so the tab can tell "closed nothing from Google" from
--   "nobody said".
-- - roi_multiple: Google revenue ÷ (monthly fee × days in window ÷ 30.44). Null without a fee.
--   The app decides whether to show it. Clients only see it above 1.
-- - Target searches: each keyword's most recent check day in the window (its best position
--   across tracked locations that day). "On page 1" = organic 1–10 or in the map pack, since both
--   sit on Google's first page. A keyword that dropped out counts as not ranking, not as its old rank.
-- - ad_equivalent_value: what the clicks would have cost as Google Ads. Clicks on queries that
--   exactly match a tracked keyword use that keyword's CPC. All remaining clicks (other queries,
--   and clicks Google anonymizes) use the median tracked CPC. Null when no keyword has a CPC.
--   Always an estimate, and labelled that way in the app.
create or replace function seo_client_overview(
    p_client text, p_start date, p_end date, p_prior_start date, p_prior_end date
)
returns table (
    clicks bigint, impressions bigint, prior_clicks bigint, prior_impressions bigint, gsc_last_date date,
    organic_leads bigint, prior_organic_leads bigint,
    google_closes numeric, google_revenue numeric, prior_google_closes numeric, prior_google_revenue numeric,
    checkins_with_sources bigint,
    seo_monthly_fee numeric, seo_fee_for_period numeric, roi_multiple numeric, seo_start_date date,
    keywords_tracked bigint, keywords_ranking bigint, keywords_page1 bigint, prior_keywords_page1 bigint,
    ad_equivalent_value numeric,
    visibility_percent numeric, domain_trust integer, pages_indexed integer, avg_position numeric, snapshot_date date,
    seo_potential_traffic integer, seo_potential_value numeric
)
language sql stable
set search_path = public
as $$
    with
    cl as (
        select c.seo_monthly_fee, c.seo_start_date,
               lower(regexp_replace(c.name, '[^a-zA-Z0-9]', '', 'g')) as key
        from clients c where c.name = p_client limit 1
    ),
    gsc as (
        select coalesce(sum(d.clicks) filter (where d.date between p_start and p_end), 0) as clicks,
               coalesce(sum(d.impressions) filter (where d.date between p_start and p_end), 0) as impressions,
               coalesce(sum(d.clicks) filter (where d.date between p_prior_start and p_prior_end), 0) as prior_clicks,
               coalesce(sum(d.impressions) filter (where d.date between p_prior_start and p_prior_end), 0) as prior_impressions,
               max(d.date) filter (where d.date <= p_end) as last_date
        from seo_daily d
        where d.client_name = p_client
          and (d.date between p_start and p_end or d.date between p_prior_start and p_prior_end)
    ),
    leads as (
        select count(*) filter (where (l.created_at at time zone 'America/Denver')::date between p_start and p_end) as cur,
               count(*) filter (where (l.created_at at time zone 'America/Denver')::date between p_prior_start and p_prior_end) as pri
        from lead_sources l
        where l.client_name = p_client and l.source = 'organic'
          and l.created_at >= (p_prior_start - 1)::timestamptz and l.created_at < (p_end + 2)::timestamptz
    ),
    checkins as (
        select sum((w.closes_by_source -> 'google' ->> 'closes')::numeric)  filter (where w.week_start::date between p_start and p_end) as closes,
               sum((w.closes_by_source -> 'google' ->> 'revenue')::numeric) filter (where w.week_start::date between p_start and p_end) as revenue,
               sum((w.closes_by_source -> 'google' ->> 'closes')::numeric)  filter (where w.week_start::date between p_prior_start and p_prior_end) as prior_closes,
               sum((w.closes_by_source -> 'google' ->> 'revenue')::numeric) filter (where w.week_start::date between p_prior_start and p_prior_end) as prior_revenue,
               count(*) filter (where w.closes_by_source is not null and w.week_start::date between p_start and p_end) as with_sources
        from weekly_checkins w, cl
        where lower(regexp_replace(coalesce(w.client_name, ''), '[^a-zA-Z0-9]', '', 'g')) = cl.key
    ),
    latest_rank as (
        -- most recent check day per keyword per window, best position across locations that day
        select win, keyword, organic, map
        from (
            select case when r.date between p_start and p_end then 'cur' else 'pri' end as win,
                   r.keyword, r.date, min(r.organic_rank) as organic, min(r.map_rank) as map,
                   row_number() over (partition by case when r.date between p_start and p_end then 'cur' else 'pri' end, r.keyword
                                      order by r.date desc) as rn
            from seo_rank_checks r
            where r.client_name = p_client
              and (r.date between p_start and p_end or r.date between p_prior_start and p_prior_end)
            group by 1, r.keyword, r.date
        ) x
        where rn = 1
    ),
    ranks as (
        select count(*) filter (where win = 'cur' and (organic is not null or map is not null)) as ranking,
               count(*) filter (where win = 'cur' and (organic <= 10 or map is not null)) as page1,
               count(*) filter (where win = 'pri' and (organic <= 10 or map is not null)) as prior_page1
        from latest_rank
    ),
    kw as (
        select count(*) filter (where k.active) as tracked,
               percentile_cont(0.5) within group (order by k.cpc) filter (where k.active and k.cpc > 0) as median_cpc
        from seo_keywords k where k.client_name = p_client
    ),
    matched as (
        select coalesce(sum(q.clicks * k.cpc), 0) as value, coalesce(sum(q.clicks), 0) as clicks
        from seo_queries_daily q
        join seo_keywords k on k.client_name = q.client_name and k.keyword = q.query and k.active and k.cpc > 0
        where q.client_name = p_client and q.date between p_start and p_end
    ),
    snap as (
        select s.visibility_percent, s.domain_trust, s.pages_indexed, s.avg_position, s.date
        from seo_project_daily s
        where s.client_name = p_client and s.date <= p_end
        order by s.date desc limit 1
    ),
    potential as (
        select s.seo_potential_traffic, s.seo_potential_value
        from seo_project_daily s
        where s.client_name = p_client and s.date <= p_end and s.seo_potential_value is not null
        order by s.date desc limit 1
    )
    select
        gsc.clicks, gsc.impressions, gsc.prior_clicks, gsc.prior_impressions, gsc.last_date,
        leads.cur, leads.pri,
        checkins.closes, checkins.revenue, checkins.prior_closes, checkins.prior_revenue,
        checkins.with_sources,
        cl.seo_monthly_fee,
        round(cl.seo_monthly_fee * ((p_end - p_start + 1) / 30.44), 2),
        case when cl.seo_monthly_fee > 0 and checkins.revenue is not null
             then round(checkins.revenue / (cl.seo_monthly_fee * ((p_end - p_start + 1) / 30.44)), 2) end,
        cl.seo_start_date,
        kw.tracked, ranks.ranking, ranks.page1, ranks.prior_page1,
        case when kw.median_cpc is null then null
             else round(matched.value + greatest(gsc.clicks - matched.clicks, 0) * kw.median_cpc::numeric, 2) end,
        snap.visibility_percent, snap.domain_trust, snap.pages_indexed, snap.avg_position, snap.date,
        potential.seo_potential_traffic, potential.seo_potential_value
    from gsc
    cross join leads
    cross join ranks
    cross join kw
    cross join matched
    left join cl on true
    left join checkins on true
    left join snap on true
    left join potential on true;
$$;
grant execute on function seo_client_overview(text, date, date, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- seo_since_start: the "Since SEO started" before-and-after
-- ---------------------------------------------------------------------------
-- Before = the 30 days before seo_start_date. After = the latest 30 days Search Console has
-- finalized (it runs 2–3 days behind, so this ends on the newest seo_daily date, not today).
-- Target searches: "before" is the first rank check on or after 7 days before the start. Tracking
-- often begins the day SEO does, and rank_baseline_date says which day was used. No rows when
-- seo_start_date isn't set: the tab hides the section and the admin tab prompts for the date.
create or replace function seo_since_start(p_client text)
returns table (
    start_date date, before_start date, before_end date, after_start date, after_end date,
    clicks_before bigint, clicks_after bigint, days_with_data_before bigint,
    leads_before bigint, leads_after bigint,
    rank_baseline_date date, rank_latest_date date,
    page1_before bigint, page1_after bigint, ranking_before bigint, ranking_after bigint
)
language sql stable
set search_path = public
as $$
    with
    s as (
        select c.seo_start_date as start_date from clients c
        where c.name = p_client and c.seo_start_date is not null limit 1
    ),
    w as (
        select s.start_date,
               s.start_date - 30 as before_start, s.start_date - 1 as before_end,
               coalesce((select max(d.date) from seo_daily d where d.client_name = p_client), current_date - 3) as after_end
        from s
    ),
    w2 as (select w.*, w.after_end - 29 as after_start from w),
    gsc as (
        select coalesce(sum(d.clicks) filter (where d.date between w2.before_start and w2.before_end), 0) as before,
               coalesce(sum(d.clicks) filter (where d.date between w2.after_start and w2.after_end), 0) as after,
               count(*) filter (where d.date between w2.before_start and w2.before_end) as days_before
        from w2 left join seo_daily d on d.client_name = p_client
    ),
    leads as (
        select count(*) filter (where (l.created_at at time zone 'America/Denver')::date between w2.before_start and w2.before_end) as before,
               count(*) filter (where (l.created_at at time zone 'America/Denver')::date between w2.after_start and w2.after_end) as after
        from w2 left join lead_sources l on l.client_name = p_client and l.source = 'organic'
    ),
    days as (
        select (select min(r.date) from seo_rank_checks r, w2 where r.client_name = p_client and r.date >= w2.start_date - 7) as baseline,
               (select max(r.date) from seo_rank_checks r where r.client_name = p_client) as latest
    ),
    per_day as (
        select r.date, r.keyword, min(r.organic_rank) as organic, min(r.map_rank) as map
        from seo_rank_checks r, days
        where r.client_name = p_client and r.date in (days.baseline, days.latest)
        group by r.date, r.keyword
    ),
    ranks as (
        select count(*) filter (where p.date = days.baseline and (p.organic <= 10 or p.map is not null)) as page1_before,
               count(*) filter (where p.date = days.latest and (p.organic <= 10 or p.map is not null)) as page1_after,
               count(*) filter (where p.date = days.baseline and (p.organic is not null or p.map is not null)) as ranking_before,
               count(*) filter (where p.date = days.latest and (p.organic is not null or p.map is not null)) as ranking_after
        from days left join per_day p on true
    )
    select w2.start_date, w2.before_start, w2.before_end, w2.after_start, w2.after_end,
           gsc.before, gsc.after, gsc.days_before,
           leads.before, leads.after,
           days.baseline, days.latest,
           ranks.page1_before, ranks.page1_after, ranks.ranking_before, ranks.ranking_after
    from w2 cross join gsc cross join leads cross join days cross join ranks;
$$;
grant execute on function seo_since_start(text) to authenticated;

-- ---------------------------------------------------------------------------
-- seo_keyword_distribution: target searches by position bucket, week by week
-- ---------------------------------------------------------------------------
-- For each week (Monday start), each keyword's latest check day that week, best position across
-- locations. A map pack spot counts at its pack position when that beats the organic one, so
-- "Top 3" includes being #2 in the map pack. A keyword not checked that week is left out of
-- that week, rather than counted as not ranking.
create or replace function seo_keyword_distribution(p_client text, p_start date, p_end date)
returns table (week_start date, top3 bigint, page1 bigint, page2 bigint, r21_50 bigint, r51_100 bigint, not_ranking bigint)
language sql stable
set search_path = public
as $$
    with per_day as (
        select date_trunc('week', r.date)::date as wk, r.date, r.keyword,
               least(coalesce(min(r.organic_rank), 1000), coalesce(min(r.map_rank), 1000)) as best
        from seo_rank_checks r
        where r.client_name = p_client and r.date between p_start and p_end
        group by r.date, r.keyword
    ),
    latest as (
        select distinct on (wk, keyword) wk, keyword, best
        from per_day order by wk, keyword, date desc
    )
    select wk,
           count(*) filter (where best <= 3),
           count(*) filter (where best between 4 and 10),
           count(*) filter (where best between 11 and 20),
           count(*) filter (where best between 21 and 50),
           count(*) filter (where best between 51 and 100),
           count(*) filter (where best > 100)
    from latest
    group by wk
    order by wk;
$$;
grant execute on function seo_keyword_distribution(text, date, date) to authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Checking on it
-- ---------------------------------------------------------------------------
-- select * from seo_client_overview('3Sixty Industries', current_date - 30, current_date - 1, current_date - 60, current_date - 31);
-- select * from seo_since_start('3Sixty Industries');          -- no rows until seo_start_date is set
-- select * from seo_keyword_distribution('3Sixty Industries', current_date - 90, current_date);
-- select client_name, date, visibility_percent, domain_trust, pages_indexed, seo_potential_value
--   from seo_project_daily order by date desc limit 10;
-- select keyword, search_volume, cpc from seo_keywords where client_name = '3Sixty Industries' order by search_volume desc nulls last;
