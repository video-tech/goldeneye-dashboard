-- Website analytics from Google Analytics 4, for the Site Analytics section of the admin SEO tab.
--
-- Run this in the SQL Editor, then re-run supabase/sql/rename_client.sql, then deploy seo-sync.
-- The existing seo-sync cron jobs pick GA4 up on their own: the 18:00 daily run and the
-- every-15-minutes backfill (16 months, four per run) now cover every client with a
-- ga4_property_id.
--
-- Six tables, one per GA4 report shape, all keyed on the exact clients.name like the other SEO
-- tables. Dates are in the GA4 property's own time zone. Only seo-sync writes (service_role).
--
-- Never bulk-loaded by the browser (1000-row cap): the tab reads everything through
-- seo_ga4_report(), which returns one JSON document of a few hundred rows at most.

create table if not exists ga4_daily (
    client_name text not null,
    date date not null,
    sessions integer not null default 0,
    engaged_sessions integer not null default 0,
    users integer not null default 0,          -- per day; summing days over-counts returning visitors
    new_users integer not null default 0,
    page_views integer not null default 0,
    session_duration_sec numeric(14,1) not null default 0,   -- average x sessions, so it sums
    engagement_sec numeric(14,1) not null default 0,
    key_events numeric(12,1) not null default 0,
    event_count integer not null default 0,
    synced_at timestamptz not null default now(),
    primary key (client_name, date)
);

create table if not exists ga4_sources_daily (
    client_name text not null,
    date date not null,
    channel text not null,     -- GA4's default channel group: Organic Search, Direct, Referral...
    source text not null,
    medium text not null,
    sessions integer not null default 0,
    engaged_sessions integer not null default 0,
    key_events numeric(12,1) not null default 0,
    primary key (client_name, date, channel, source, medium)
);

-- page_views from pagePath; entrances (sessions that started on the page) from landingPage.
-- Paths are normalized by seo-sync: no query string, no trailing slash.
create table if not exists ga4_pages_daily (
    client_name text not null,
    date date not null,
    page_path text not null,
    page_views integer not null default 0,
    engagement_sec numeric(14,1) not null default 0,
    entrances integer not null default 0,
    landing_engaged_sessions integer not null default 0,
    landing_key_events numeric(12,1) not null default 0,
    landing_duration_sec numeric(14,1) not null default 0,
    primary key (client_name, date, page_path)
);
create index if not exists ga4_pages_daily_page on ga4_pages_daily (client_name, page_path, date);

-- Internal page-to-page moves, from each page view's referrer. Approximate: a reload, the back
-- button or a new tab can blur it. Exits are page views minus the moves onward from that page.
create table if not exists ga4_page_flows_daily (
    client_name text not null,
    date date not null,
    from_path text not null,
    to_path text not null,
    views integer not null default 0,
    primary key (client_name, date, from_path, to_path)
);

create table if not exists ga4_events_daily (
    client_name text not null,
    date date not null,
    event_name text not null,
    event_count integer not null default 0,
    key_events numeric(12,1) not null default 0,   -- non-zero only for events marked as key events in GA4
    primary key (client_name, date, event_name)
);

-- Sessions referred by AI assistants (ChatGPT, Perplexity, Gemini, Copilot, Claude...). GA4 sees
-- the referral and the landing page, never the question that was asked.
create table if not exists ga4_ai_daily (
    client_name text not null,
    date date not null,
    source text not null,
    landing_page text not null,
    sessions integer not null default 0,
    engaged_sessions integer not null default 0,
    key_events numeric(12,1) not null default 0,
    primary key (client_name, date, source, landing_page)
);

do $$
declare t text;
begin
    foreach t in array array['ga4_daily','ga4_sources_daily','ga4_pages_daily','ga4_page_flows_daily','ga4_events_daily','ga4_ai_daily'] loop
        execute format('alter table %I enable row level security', t);
        execute format('drop policy if exists "Client or admin reads" on %I', t);
        execute format('create policy "Client or admin reads" on %I for select using (client_row_visible(client_name))', t);
    end loop;
end $$;

-- Everything the Site Analytics section shows, for one client and range, with the previous period
-- beside it. SECURITY INVOKER, so the caller's RLS applies.
drop function if exists seo_ga4_report(text, date, date, date, date);
create function seo_ga4_report(p_client text, p_start date, p_end date, p_prior_start date, p_prior_end date)
returns jsonb
language sql stable security invoker set search_path = public
as $$
with
cur_d as (select * from ga4_daily where client_name = p_client and date between p_start and p_end),
pri_d as (select * from ga4_daily where client_name = p_client and date between p_prior_start and p_prior_end),
blog as (
    select nullif(rtrim(blog_path, '/'), '') as path
    from seo_webhook_configs where client_name = p_client and blog_path is not null and blog_path <> '' and blog_path <> '/'
    limit 1
),
cur_pages as (
    select page_path, sum(page_views) as page_views, sum(engagement_sec) as engagement_sec,
           sum(entrances) as entrances, sum(landing_engaged_sessions) as landing_engaged,
           sum(landing_key_events) as landing_key_events, sum(landing_duration_sec) as landing_duration_sec
    from ga4_pages_daily where client_name = p_client and date between p_start and p_end
    group by page_path
),
pri_pages as (
    select page_path, sum(page_views) as page_views, sum(entrances) as entrances
    from ga4_pages_daily where client_name = p_client and date between p_prior_start and p_prior_end
    group by page_path
),
onward as (
    select from_path, sum(views) as views
    from ga4_page_flows_daily where client_name = p_client and date between p_start and p_end
    group by from_path
),
totals as (
    select
        (select jsonb_build_object(
            'sessions', coalesce(sum(sessions),0), 'engaged_sessions', coalesce(sum(engaged_sessions),0),
            'page_views', coalesce(sum(page_views),0), 'session_duration_sec', coalesce(sum(session_duration_sec),0),
            'engagement_sec', coalesce(sum(engagement_sec),0), 'key_events', coalesce(sum(key_events),0),
            'new_users', coalesce(sum(new_users),0), 'days', count(*)) from cur_d) as cur,
        (select jsonb_build_object(
            'sessions', coalesce(sum(sessions),0), 'engaged_sessions', coalesce(sum(engaged_sessions),0),
            'page_views', coalesce(sum(page_views),0), 'session_duration_sec', coalesce(sum(session_duration_sec),0),
            'engagement_sec', coalesce(sum(engagement_sec),0), 'key_events', coalesce(sum(key_events),0),
            'new_users', coalesce(sum(new_users),0), 'days', count(*)) from pri_d) as pri
)
select jsonb_build_object(
    'last_date', (select max(date) from ga4_daily where client_name = p_client),
    'first_date', (select min(date) from ga4_daily where client_name = p_client),
    'current', (select cur from totals),
    'prior', (select pri from totals),
    'series', coalesce((select jsonb_agg(jsonb_build_object('date', date, 'sessions', sessions, 'page_views', page_views) order by date) from cur_d), '[]'::jsonb),
    'prior_series', coalesce((select jsonb_agg(jsonb_build_object('date', date, 'sessions', sessions) order by date) from pri_d), '[]'::jsonb),
    'channels', coalesce((
        select jsonb_agg(x order by (x->>'sessions')::int desc) from (
            select jsonb_build_object('channel', c.channel, 'sessions', c.sessions, 'engaged_sessions', c.engaged, 'key_events', c.key_events,
                                      'prior_sessions', coalesce(p.sessions, 0)) as x
            from (select channel, sum(sessions) sessions, sum(engaged_sessions) engaged, sum(key_events) key_events
                  from ga4_sources_daily where client_name = p_client and date between p_start and p_end group by channel) c
            left join (select channel, sum(sessions) sessions
                  from ga4_sources_daily where client_name = p_client and date between p_prior_start and p_prior_end group by channel) p
              using (channel)
            where c.sessions > 0
        ) s), '[]'::jsonb),
    'sources', coalesce((
        select jsonb_agg(x order by (x->>'sessions')::int desc) from (
            select jsonb_build_object('channel', channel, 'source', source, 'medium', medium, 'sessions', sum(sessions),
                                      'engaged_sessions', sum(engaged_sessions), 'key_events', sum(key_events)) as x
            from ga4_sources_daily where client_name = p_client and date between p_start and p_end
            group by channel, source, medium having sum(sessions) > 0
            order by sum(sessions) desc limit 25
        ) s), '[]'::jsonb),
    'pages', coalesce((
        select jsonb_agg(x order by (x->>'page_views')::int desc) from (
            select jsonb_build_object(
                'page_path', c.page_path, 'page_views', c.page_views, 'prior_page_views', coalesce(p.page_views, 0),
                'engagement_sec', c.engagement_sec, 'entrances', c.entrances,
                'exits', greatest(c.page_views - coalesce(o.views, 0), 0)) as x
            from cur_pages c
            left join pri_pages p using (page_path)
            left join onward o on o.from_path = c.page_path
            where c.page_views > 0
            order by c.page_views desc limit 50
        ) s), '[]'::jsonb),
    'landing', coalesce((
        select jsonb_agg(x order by (x->>'entrances')::int desc) from (
            select jsonb_build_object(
                'page_path', c.page_path, 'entrances', c.entrances, 'prior_entrances', coalesce(p.entrances, 0),
                'engaged_sessions', c.landing_engaged, 'key_events', c.landing_key_events,
                'duration_sec', c.landing_duration_sec) as x
            from cur_pages c left join pri_pages p using (page_path)
            where c.entrances > 0
            order by c.entrances desc limit 25
        ) s), '[]'::jsonb),
    'flows', coalesce((
        select jsonb_agg(x order by (x->>'views')::int desc) from (
            select jsonb_build_object('from_path', from_path, 'to_path', to_path, 'views', sum(views)) as x
            from ga4_page_flows_daily where client_name = p_client and date between p_start and p_end and from_path <> to_path
            group by from_path, to_path
            order by sum(views) desc limit 300
        ) s), '[]'::jsonb),
    'events', coalesce((
        select jsonb_agg(x order by (x->>'key_events')::numeric desc, (x->>'event_count')::int desc) from (
            select jsonb_build_object('event_name', c.event_name, 'event_count', c.event_count, 'key_events', c.key_events,
                                      'prior_event_count', coalesce(p.event_count, 0), 'prior_key_events', coalesce(p.key_events, 0)) as x
            from (select event_name, sum(event_count) event_count, sum(key_events) key_events
                  from ga4_events_daily where client_name = p_client and date between p_start and p_end group by event_name) c
            left join (select event_name, sum(event_count) event_count, sum(key_events) key_events
                  from ga4_events_daily where client_name = p_client and date between p_prior_start and p_prior_end group by event_name) p
              using (event_name)
            order by c.key_events desc, c.event_count desc limit 40
        ) s), '[]'::jsonb),
    'ai', coalesce((
        select jsonb_agg(x order by (x->>'sessions')::int desc) from (
            select jsonb_build_object('source', source, 'landing_page', landing_page, 'sessions', sum(sessions),
                                      'engaged_sessions', sum(engaged_sessions), 'key_events', sum(key_events)) as x
            from ga4_ai_daily where client_name = p_client and date between p_start and p_end
            group by source, landing_page having sum(sessions) > 0
            order by sum(sessions) desc limit 50
        ) s), '[]'::jsonb),
    'ai_prior_sessions', (select coalesce(sum(sessions), 0) from ga4_ai_daily where client_name = p_client and date between p_prior_start and p_prior_end),
    'blog_path', (select path from blog),
    'post_views', (select coalesce(sum(c.page_views), 0) from cur_pages c, blog b where c.page_path like b.path || '/%'),
    'prior_post_views', (select coalesce(sum(p.page_views), 0) from pri_pages p, blog b where p.page_path like b.path || '/%'),
    'top_posts', coalesce((
        select jsonb_agg(x order by (x->>'page_views')::int desc) from (
            select jsonb_build_object('page_path', c.page_path, 'page_views', c.page_views, 'engagement_sec', c.engagement_sec) as x
            from cur_pages c, blog b where c.page_path like b.path || '/%' and c.page_views > 0
            order by c.page_views desc limit 10
        ) s), '[]'::jsonb)
);
$$;
grant execute on function seo_ga4_report(text, date, date, date, date) to authenticated;

notify pgrst, 'reload schema';
