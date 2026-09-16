-- Case studies: the "before SEO / now / a year ago" story, for showing a client (or a prospect)
-- what the work actually did. Read through seo_case_study_report(client), rendered by the new
-- Case Study button on the admin SEO tab as a printable page (browser print-to-PDF, no PDF library).
--
-- Run this in the SQL Editor. No deploy needed — it's SQL plus app.js.
--
-- Three windows, each 90 days (long enough to smooth weekly noise, short enough to stay a fair
-- comparison to the others):
--   BASELINE  the 90 days immediately before SEO work started — clients.seo_start_date if set,
--             else the day before the earliest logged changelog entry. Neither means "not enough
--             history yet" rather than guessing a start date.
--   NOW       the latest 90 finalized days (ending the day before today, or Search Console's
--             last synced day if that's earlier — the same "don't read a half-finished day" rule
--             as everywhere else in this file).
--   YOY       the same 90-day window one year before NOW, only shown when Search Console's
--             history actually reaches that far back (16-month retention means a client just
--             past their first year will have this; a newer client won't, and the report says so
--             rather than compare against a partial or missing window).
--
-- Every "is this even measurable" question below is answered with an availability flag rather
-- than a zero, following the same rule as leads before LEAD_TRACKING_START elsewhere in this
-- codebase: a metric that didn't exist yet must never read as "measured and found to be zero".
--   - Leads:        lead_sources didn't exist before 2026-09-11. A window ending before that date
--                   has leads_available = false.
--   - Keywords/map: seo_rank_checks NEVER backfills (SE Ranking has no history before a keyword
--                   was added — see CLAUDE.md). A window that ends before this client's first
--                   tracked check has keywords_available/map_available = false, not zero.
--   - Revenue:      weekly_checkins.closes_by_source is only as old as the check-ins that used it
--                   (added 2026-09-14). revenue_weeks counts how many check-ins in the window
--                   actually carried a source breakdown; zero of those means "not reported", and
--                   the UI treats it that way rather than as a real $0.
--   - GA4:          simply whether any ga4_daily row exists in the window.

create table if not exists seo_baselines (
    id bigint generated always as identity primary key,
    client_name text not null,
    captured_at timestamptz not null default now(),
    window_start date not null,
    window_end date not null,
    clicks integer,
    impressions integer,
    position numeric(6,2),
    organic_leads integer,
    ga4_sessions integer,
    keywords_page1 integer,
    google_revenue numeric,
    notes text,
    captured_by text
);
create index if not exists seo_baselines_client on seo_baselines (client_name, captured_at desc);

-- A manually captured snapshot survives Search Console quietly restating the derived baseline
-- later (see CLAUDE.md, SEO measurement) — capture it once at signing, and the number told to the
-- client that day never moves. The derived baseline below is still always computed too, so a
-- client with no manual snapshot still gets a case study.
alter table seo_baselines enable row level security;
drop policy if exists "Client or admin reads" on seo_baselines;
create policy "Client or admin reads" on seo_baselines for select using (client_row_visible(client_name));
drop policy if exists "Admins capture baselines" on seo_baselines;
create policy "Admins capture baselines" on seo_baselines for all
    using (current_user_is_admin()) with check (current_user_is_admin());

drop function if exists seo_case_study_report(text);
create function seo_case_study_report(p_client text)
returns jsonb
language sql stable
set search_path = public
as $$
with
bounds as (
    select
        (select seo_start_date from clients where name = p_client) as seo_start,
        (select min(live_date) from seo_changelog where client_name = p_client) as first_changelog,
        (select min(date) from seo_daily where client_name = p_client) as gsc_min,
        (select max(date) from seo_daily where client_name = p_client) as gsc_max,
        (select min(date) from seo_rank_checks where client_name = p_client) as rank_min
),
calc as (
    select
        coalesce(seo_start - 1, first_changelog - 1) as baseline_end,
        least(current_date - 1, gsc_max) as now_end,
        gsc_min, gsc_max, rank_min
    from bounds
),
calc2 as (
    select
        baseline_end,
        greatest(baseline_end - 89, gsc_min) as baseline_start,
        now_end,
        now_end - 89 as now_start,
        now_end - 364 as yoy_end,
        now_end - 364 - 89 as yoy_start,
        gsc_min, gsc_max, rank_min
    from calc
),
-- One lateral block per window per source, rather than one shared function, because a plain SQL
-- function can't parameterize a CTE — this mirrors the existing cur/pri duplication in
-- seo_gbp_report and seo_ga4_report rather than inventing a new pattern.
gsc_baseline as (select sum(clicks) c, sum(impressions) i, sum(position*impressions)/nullif(sum(impressions),0) p, count(*) d
    from seo_daily, calc2 where client_name = p_client and date between calc2.baseline_start and calc2.baseline_end),
gsc_now as (select sum(clicks) c, sum(impressions) i, sum(position*impressions)/nullif(sum(impressions),0) p, count(*) d
    from seo_daily, calc2 where client_name = p_client and date between calc2.now_start and calc2.now_end),
gsc_yoy as (select sum(clicks) c, sum(impressions) i, sum(position*impressions)/nullif(sum(impressions),0) p, count(*) d
    from seo_daily, calc2 where client_name = p_client and date between calc2.yoy_start and calc2.yoy_end),
leads_baseline as (select count(*) n from lead_sources, calc2 where client_name = p_client and source = 'organic'
    and created_at::date between calc2.baseline_start and calc2.baseline_end),
leads_now as (select count(*) n from lead_sources, calc2 where client_name = p_client and source = 'organic'
    and created_at::date between calc2.now_start and calc2.now_end),
leads_yoy as (select count(*) n from lead_sources, calc2 where client_name = p_client and source = 'organic'
    and created_at::date between calc2.yoy_start and calc2.yoy_end),
ga4_baseline as (select sum(sessions) s, count(*) d from ga4_daily, calc2 where client_name = p_client and date between calc2.baseline_start and calc2.baseline_end),
ga4_now as (select sum(sessions) s, count(*) d from ga4_daily, calc2 where client_name = p_client and date between calc2.now_start and calc2.now_end),
ga4_yoy as (select sum(sessions) s, count(*) d from ga4_daily, calc2 where client_name = p_client and date between calc2.yoy_start and calc2.yoy_end),
-- Page-1 organic count: active keywords whose best (across cities) organic rank in the window is 1-10.
-- n = organically on page 1 (1-10); m = holding a map pack spot. Independent counts — a
-- keyword can do either, both, or neither, so they must never be OR'd into one filter first.
rank_baseline as (select count(*) filter (where organic_rank between 1 and 10) n, count(*) filter (where map_rank is not null) m from (
    select k.keyword, min(r.organic_rank) as organic_rank, min(r.map_rank) as map_rank
    from seo_keywords k, calc2, seo_rank_checks r
    where k.client_name = p_client and k.active and r.client_name = k.client_name and r.keyword = k.keyword
      and r.date between calc2.baseline_start and calc2.baseline_end
    group by k.keyword) x),
rank_now as (select count(*) filter (where organic_rank between 1 and 10) n, count(*) filter (where map_rank is not null) m from (
    select k.keyword, min(r.organic_rank) as organic_rank, min(r.map_rank) as map_rank
    from seo_keywords k, calc2, seo_rank_checks r
    where k.client_name = p_client and k.active and r.client_name = k.client_name and r.keyword = k.keyword
      and r.date between calc2.now_start and calc2.now_end
    group by k.keyword) x),
rev_baseline as (select sum((closes_by_source->'google'->>'revenue')::numeric) rev, sum((closes_by_source->'google'->>'closes')::numeric) jobs,
    count(*) filter (where closes_by_source is not null) reported
    from weekly_checkins, calc2 where client_name = p_client and week_start between calc2.baseline_start and calc2.baseline_end),
rev_now as (select sum((closes_by_source->'google'->>'revenue')::numeric) rev, sum((closes_by_source->'google'->>'closes')::numeric) jobs,
    count(*) filter (where closes_by_source is not null) reported
    from weekly_checkins, calc2 where client_name = p_client and week_start between calc2.now_start and calc2.now_end)
select jsonb_build_object(
    'seo_start_date', (select seo_start from bounds),
    'seo_monthly_fee', (select seo_monthly_fee from clients where name = p_client),
    'rank_tracking_started', (select rank_min from calc2),
    'lead_tracking_start', '2026-09-11',
    'manual_baseline', (select jsonb_build_object(
        'captured_at', captured_at, 'window_start', window_start, 'window_end', window_end,
        'clicks', clicks, 'impressions', impressions, 'position', position, 'organic_leads', organic_leads,
        'ga4_sessions', ga4_sessions, 'keywords_page1', keywords_page1, 'google_revenue', google_revenue, 'notes', notes)
        from seo_baselines where client_name = p_client order by captured_at desc limit 1),
    'baseline', jsonb_build_object(
        'available', (select baseline_end is not null and gsc_min is not null from calc2),
        'start', (select baseline_start from calc2), 'end', (select baseline_end from calc2),
        'days', (select d from gsc_baseline), 'clicks', (select c from gsc_baseline), 'impressions', (select i from gsc_baseline),
        'position', (select p from gsc_baseline),
        'leads', (select n from leads_baseline),
        'leads_available', (select calc2.baseline_end >= '2026-09-11'::date from calc2),
        'ga4_sessions', (select s from ga4_baseline), 'ga4_available', (select d > 0 from ga4_baseline),
        'keywords_page1', (select n from rank_baseline), 'map_pack_count', (select m from rank_baseline),
        'rank_available', (select rank_min is not null and rank_min <= calc2.baseline_end from calc2),
        'google_revenue', (select rev from rev_baseline), 'jobs_closed', (select jobs from rev_baseline),
        'revenue_weeks_reported', (select reported from rev_baseline)
    ),
    'now', jsonb_build_object(
        'available', (select now_end is not null from calc2),
        'start', (select now_start from calc2), 'end', (select now_end from calc2),
        'days', (select d from gsc_now), 'clicks', (select c from gsc_now), 'impressions', (select i from gsc_now),
        'position', (select p from gsc_now),
        'leads', (select n from leads_now), 'leads_available', true,
        'ga4_sessions', (select s from ga4_now), 'ga4_available', (select d > 0 from ga4_now),
        'keywords_page1', (select n from rank_now), 'map_pack_count', (select m from rank_now),
        'rank_available', (select rank_min is not null from calc2),
        'google_revenue', (select rev from rev_now), 'jobs_closed', (select jobs from rev_now),
        'revenue_weeks_reported', (select reported from rev_now)
    ),
    'yoy', jsonb_build_object(
        'available', (select gsc_min is not null and gsc_min <= calc2.yoy_start from calc2),
        'start', (select yoy_start from calc2), 'end', (select yoy_end from calc2),
        'days', (select d from gsc_yoy), 'clicks', (select c from gsc_yoy), 'impressions', (select i from gsc_yoy),
        'position', (select p from gsc_yoy),
        'leads', (select n from leads_yoy), 'leads_available', (select calc2.yoy_end >= '2026-09-11'::date from calc2),
        'ga4_sessions', (select s from ga4_yoy), 'ga4_available', (select d > 0 from ga4_yoy)
    )
);
$$;
grant execute on function seo_case_study_report(text) to authenticated;

notify pgrst, 'reload schema';

-- Checking on it:
-- select seo_case_study_report('3Sixty Industries');
