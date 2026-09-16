-- Google Business Profile, pulled through SE Ranking's Local Marketing API, for the Business Profile
-- panel on the admin SEO tab.
--
-- Run this in the SQL Editor, then re-run supabase/sql/rename_client.sql, then deploy seranking-sync.
-- The existing 19:00 UTC seranking-sync job picks it up for every client with seranking_local_id.
--
-- Why SE Ranking and not Google's own API: Google's Business Profile APIs need a manual approval that
-- can take weeks, and don't include reviews. SE Ranking's Local Marketing endpoints are free to call
-- (no API credits); each profile is added as a location in SE Ranking, using the plan's allowance.

-- The Local Marketing location id (SE Ranking → Local Marketing, the number in the location's URL).
-- Presence is the switch, like gsc_property. clients.gbp_location_id stays for Google's API later.
alter table clients add column if not exists seranking_local_id bigint;

create table if not exists gbp_daily (
    client_name text not null,
    date date not null,
    impressions_search_mobile integer not null default 0,
    impressions_search_desktop integer not null default 0,
    impressions_maps_mobile integer not null default 0,
    impressions_maps_desktop integer not null default 0,
    calls integer not null default 0,              -- taps on the call button
    website_clicks integer not null default 0,
    direction_requests integer not null default 0,
    conversations integer not null default 0,      -- messages started from the profile
    synced_at timestamptz not null default now(),
    primary key (client_name, date)
);

-- How people found the profile, monthly. Google withholds small numbers, so null means "not reported".
create table if not exists gbp_searches_monthly (
    client_name text not null,
    month date not null,
    direct integer,        -- searched the business name or address
    discovery integer,     -- searched a category, product or service
    branded integer,
    primary key (client_name, month)
);

-- The search terms that showed the profile, per finished month. Impressions under Google's threshold
-- come back null.
create table if not exists gbp_keywords_monthly (
    client_name text not null,
    month date not null,
    keyword text not null,
    impressions integer,
    clicks integer,
    primary key (client_name, month, keyword)
);

-- One review summary per day the sync runs, so the rating and count have a history.
create table if not exists gbp_reviews_daily (
    client_name text not null,
    date date not null,
    total_reviews integer not null default 0,
    average_rating numeric(3,2),
    answered_reviews integer not null default 0,
    unanswered_reviews integer not null default 0,
    primary key (client_name, date)
);

-- Individual reviews, admin-only: the panel lists the ones still waiting for a reply.
create table if not exists gbp_reviews (
    client_name text not null,
    review_id bigint not null,          -- SE Ranking's id
    source text,                        -- gmb = Google
    rating integer,
    review_text text,
    reviewer_name text,
    created_at timestamptz not null,
    is_answered boolean not null default false,
    replied_at timestamptz,
    review_url text,
    synced_at timestamptz not null default now(),
    primary key (client_name, review_id)
);
create index if not exists gbp_reviews_recent on gbp_reviews (client_name, created_at desc);

do $$
declare t text;
begin
    foreach t in array array['gbp_daily','gbp_searches_monthly','gbp_keywords_monthly','gbp_reviews_daily'] loop
        execute format('alter table %I enable row level security', t);
        execute format('drop policy if exists "Client or admin reads" on %I', t);
        execute format('create policy "Client or admin reads" on %I for select using (client_row_visible(client_name))', t);
    end loop;
end $$;

alter table gbp_reviews enable row level security;
drop policy if exists "Admins read reviews" on gbp_reviews;
create policy "Admins read reviews" on gbp_reviews for select using (current_user_is_admin());

-- Everything the Business Profile panel shows for one client and range, with the period before.
-- SECURITY INVOKER: a client caller gets no review list (admin-only table), everything else by RLS.
drop function if exists seo_gbp_report(text, date, date, date, date);
create function seo_gbp_report(p_client text, p_start date, p_end date, p_prior_start date, p_prior_end date)
returns jsonb
language sql stable security invoker set search_path = public
as $$
with
cur as (select * from gbp_daily where client_name = p_client and date between p_start and p_end),
pri as (select * from gbp_daily where client_name = p_client and date between p_prior_start and p_prior_end),
kw as (
    select keyword,
           case when count(impressions) = 0 then null else sum(impressions) end as impressions,
           case when count(clicks) = 0 then null else sum(clicks) end as clicks
    from gbp_keywords_monthly
    where client_name = p_client and month between date_trunc('month', p_start)::date and p_end
    group by keyword
),
snap as (
    select * from gbp_reviews_daily where client_name = p_client
    order by (date <= p_end) desc, date desc limit 1
)
select jsonb_build_object(
    'first_date', (select min(date) from gbp_daily where client_name = p_client),
    'last_date', (select max(date) from gbp_daily where client_name = p_client),
    'current', (select jsonb_build_object(
        'calls', coalesce(sum(calls),0), 'website_clicks', coalesce(sum(website_clicks),0),
        'direction_requests', coalesce(sum(direction_requests),0), 'conversations', coalesce(sum(conversations),0),
        'views_search', coalesce(sum(impressions_search_mobile + impressions_search_desktop),0),
        'views_maps', coalesce(sum(impressions_maps_mobile + impressions_maps_desktop),0),
        'views_mobile', coalesce(sum(impressions_search_mobile + impressions_maps_mobile),0),
        'views_desktop', coalesce(sum(impressions_search_desktop + impressions_maps_desktop),0),
        'days', count(*)) from cur),
    'prior', (select jsonb_build_object(
        'calls', coalesce(sum(calls),0), 'website_clicks', coalesce(sum(website_clicks),0),
        'direction_requests', coalesce(sum(direction_requests),0), 'conversations', coalesce(sum(conversations),0),
        'views_search', coalesce(sum(impressions_search_mobile + impressions_search_desktop),0),
        'views_maps', coalesce(sum(impressions_maps_mobile + impressions_maps_desktop),0),
        'days', count(*)) from pri),
    'series', coalesce((select jsonb_agg(jsonb_build_object(
        'date', date, 'calls', calls, 'website_clicks', website_clicks, 'direction_requests', direction_requests,
        'views', impressions_search_mobile + impressions_search_desktop + impressions_maps_mobile + impressions_maps_desktop) order by date) from cur), '[]'::jsonb),
    'searches', coalesce((select jsonb_agg(jsonb_build_object('month', month, 'direct', direct, 'discovery', discovery, 'branded', branded) order by month)
        from (select * from gbp_searches_monthly where client_name = p_client and month <= p_end order by month desc limit 12) m), '[]'::jsonb),
    'keywords', coalesce((select jsonb_agg(jsonb_build_object('keyword', keyword, 'impressions', impressions, 'clicks', clicks)
        order by impressions desc nulls last, keyword)
        from (select * from kw order by impressions desc nulls last, keyword limit 50) k), '[]'::jsonb),
    'keyword_months', coalesce((select jsonb_agg(distinct month order by month) from gbp_keywords_monthly
        where client_name = p_client and month between date_trunc('month', p_start)::date and p_end), '[]'::jsonb),
    'reviews', (select jsonb_build_object('date', date, 'total_reviews', total_reviews, 'average_rating', average_rating,
        'answered_reviews', answered_reviews, 'unanswered_reviews', unanswered_reviews) from snap),
    'new_reviews', (select jsonb_build_object('count', count(*), 'average_rating', round(avg(rating)::numeric, 2))
        from gbp_reviews where client_name = p_client and created_at::date between p_start and p_end),
    'prior_new_reviews', (select count(*) from gbp_reviews where client_name = p_client and created_at::date between p_prior_start and p_prior_end),
    'unanswered', coalesce((select jsonb_agg(jsonb_build_object('rating', rating, 'review_text', review_text, 'reviewer_name', reviewer_name,
        'created_at', created_at, 'review_url', review_url) order by created_at desc)
        from (select * from gbp_reviews where client_name = p_client and not is_answered order by created_at desc limit 10) u), '[]'::jsonb)
);
$$;
grant execute on function seo_gbp_report(text, date, date, date, date) to authenticated;

notify pgrst, 'reload schema';
