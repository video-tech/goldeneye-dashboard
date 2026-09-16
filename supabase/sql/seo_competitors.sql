-- Competitor tracking: who else ranks for the client's keywords, and how we compare.
--
-- Run this in the SQL Editor, then deploy seranking-sync (it writes these tables), then
-- re-run supabase/sql/rename_client.sql (it now moves them).
--
-- Three things arrive from SE Ranking's Project API, all on checks we already pay for:
--   1. /competitors              -> seo_competitors        (the sites we chose to track)
--   2. /competitors/positions    -> seo_competitor_ranks   (their rank, per keyword per city per day)
--   3. /competitors/metrics      -> seo_serp_top10_daily   (EVERY domain in Google's top 10 that day)
--
-- (3) is the one worth keeping most: SE Ranking only retains that snapshot for about 14 days,
-- so a daily copy here is the only place a "who owns this market" history can ever exist. It's
-- also how the next competitor is picked, without anyone guessing from memory.
--
-- Competitor rank history starts the day a competitor is added in SE Ranking and never
-- backfills, which is why competitors are added early rather than after a month of watching.

create table if not exists seo_competitors (
    client_name text not null,
    seranking_competitor_id bigint not null,
    name text,
    url text,
    -- host only, lowercased, no "www." — so it can be compared with seo_serp_top10_daily.domain
    domain text,
    domain_trust numeric(6,2),
    -- Removed in SE Ranking: kept, never deleted, so an older report still reads correctly.
    active boolean not null default true,
    first_seen_at timestamptz not null default now(),
    synced_at timestamptz not null default now(),
    primary key (client_name, seranking_competitor_id)
);

-- One row per competitor per keyword per city per day. Organic only: SE Ranking's competitor
-- endpoint returns `pos` alone, with no is_map/map_position, unlike our own positions call. So
-- a competitor sitting in the map pack is invisible here, and nothing should imply otherwise.
create table if not exists seo_competitor_ranks (
    client_name text not null,
    seranking_competitor_id bigint not null,
    keyword text not null,
    site_engine_id bigint not null,
    date date not null,
    rank integer,           -- null = not ranking that day, never 0 (same rule as seo_rank_checks)
    primary key (client_name, seranking_competitor_id, keyword, site_engine_id, date)
);
create index if not exists seo_competitor_ranks_client_date on seo_competitor_ranks (client_name, date);

-- Google's top 10 for the tracked searches, by domain, as SE Ranking saw it that day.
-- visibility is that domain's share of the tracked top-10 spots in that city (0-100).
create table if not exists seo_serp_top10_daily (
    client_name text not null,
    date date not null,
    site_engine_id bigint not null,
    domain text not null,
    visibility numeric(6,2),
    backlinks bigint,
    ref_domains bigint,
    synced_at timestamptz not null default now(),
    primary key (client_name, date, site_engine_id, domain)
);

alter table seo_competitors        enable row level security;
alter table seo_competitor_ranks   enable row level security;
alter table seo_serp_top10_daily   enable row level security;

-- The first two are client-facing (the portal's "how you compare" section), so they use the
-- helper that can't forget the client_email fallback. The top-10 list is ours: it's full of
-- directories and one-off domains, and picking competitors from it is our job, not theirs.
drop policy if exists "Clients read their own competitors" on seo_competitors;
create policy "Clients read their own competitors" on seo_competitors
    for select using (client_row_visible(client_name));

drop policy if exists "Clients read their own competitor ranks" on seo_competitor_ranks;
create policy "Clients read their own competitor ranks" on seo_competitor_ranks
    for select using (client_row_visible(client_name));

drop policy if exists "Admins read the top 10 snapshot" on seo_serp_top10_daily;
create policy "Admins read the top 10 snapshot" on seo_serp_top10_daily
    for select using (current_user_is_admin());

-- Only seranking-sync writes, through service_role, which bypasses RLS. No write policies.

-- ---------------------------------------------------------------------------
-- How we compare, per keyword
-- ---------------------------------------------------------------------------
-- One row per keyword per competitor, each side's latest in-window rank. The client's own
-- side is the BEST rank across the cities checked that day, matching seo_keyword_summary —
-- "where do we stand right now", not an average over the window.
--
-- A map-pack-only keyword reads as "not ranking" on both sides here on purpose: comparing our
-- map rank against a competitor's organic rank would be two different ladders in one column.
drop function if exists seo_competitor_keyword_matrix(text, date, date);
create or replace function seo_competitor_keyword_matrix(p_client text, p_start date, p_end date)
returns table (
    keyword text,
    search_volume integer,
    client_rank integer,
    seranking_competitor_id bigint,
    competitor_name text,
    competitor_rank integer
)
language sql stable security invoker set search_path = public as $$
    select k.keyword,
           k.search_volume,
           mine.rank,
           c.seranking_competitor_id,
           coalesce(c.name, c.domain, c.url),
           theirs.rank
    from seo_keywords k
    cross join lateral (
        select min(src.organic_rank) as rank
        from seo_rank_checks src
        where src.client_name = k.client_name and src.keyword = k.keyword
          and src.date between p_start and p_end
          and src.date = (
              select max(d.date) from seo_rank_checks d
              where d.client_name = k.client_name and d.keyword = k.keyword
                and d.date between p_start and p_end
                and (d.organic_rank is not null or d.map_rank is not null)
          )
    ) mine
    join seo_competitors c
      on c.client_name = k.client_name and c.active
    left join lateral (
        select min(cr.rank) as rank
        from seo_competitor_ranks cr
        where cr.client_name = k.client_name
          and cr.seranking_competitor_id = c.seranking_competitor_id
          and cr.keyword = k.keyword
          and cr.date between p_start and p_end
          and cr.date = (
              select max(d.date) from seo_competitor_ranks d
              where d.client_name = k.client_name
                and d.seranking_competitor_id = c.seranking_competitor_id
                and d.keyword = k.keyword
                and d.date between p_start and p_end
                and d.rank is not null
          )
    ) theirs on true
    where k.client_name = p_client and k.active
    order by k.keyword, coalesce(c.name, c.domain, c.url);
$$;
grant execute on function seo_competitor_keyword_matrix(text, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- One line per competitor
-- ---------------------------------------------------------------------------
-- ahead_of_them / behind_them only count keywords where BOTH sides have a rank, so a
-- competitor who simply isn't tracked on a search can't read as a win. not_ranking_them is
-- the separate, honest bucket: we rank and they don't.
drop function if exists seo_competitor_overview(text, date, date);
create or replace function seo_competitor_overview(p_client text, p_start date, p_end date)
returns table (
    seranking_competitor_id bigint,
    competitor_name text,
    domain text,
    domain_trust numeric,
    keywords_compared integer,
    their_page1 integer,
    their_avg_rank numeric,
    ahead_of_them integer,
    behind_them integer,
    not_ranking_them integer
)
language sql stable security invoker set search_path = public as $$
    select m.seranking_competitor_id,
           m.competitor_name,
           c.domain,
           c.domain_trust,
           count(*) filter (where m.client_rank is not null or m.competitor_rank is not null)::int,
           count(*) filter (where m.competitor_rank between 1 and 10)::int,
           round(avg(m.competitor_rank) filter (where m.competitor_rank is not null), 1),
           count(*) filter (where m.client_rank is not null and m.competitor_rank is not null and m.client_rank < m.competitor_rank)::int,
           count(*) filter (where m.client_rank is not null and m.competitor_rank is not null and m.client_rank > m.competitor_rank)::int,
           count(*) filter (where m.client_rank is not null and m.competitor_rank is null)::int
    from seo_competitor_keyword_matrix(p_client, p_start, p_end) m
    join seo_competitors c
      on c.client_name = p_client and c.seranking_competitor_id = m.seranking_competitor_id
    group by m.seranking_competitor_id, m.competitor_name, c.domain, c.domain_trust
    order by count(*) filter (where m.competitor_rank between 1 and 10) desc, m.competitor_name;
$$;
grant execute on function seo_competitor_overview(text, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Who owns the market (admin)
-- ---------------------------------------------------------------------------
-- Every domain in the top 10 on the latest snapshot day, averaged across the client's cities,
-- with how many of those cities it shows up in — the number that actually picks a competitor,
-- because one city at 90% is usually one lucky keyword. `tracked` marks the ones already
-- added as competitors, and `is_client` marks the client themselves.
--
-- `is_directory` marks sites no local business competes with for the job: directories, review
-- sites, manufacturers, big-box stores, social networks and booking-widget hosts. On 3Sixty's
-- first snapshot (2026-09-15) the top four were book.xapp.ai, Houzz, Yelp and Trex — all noise
-- when choosing a competitor. They sort after real businesses and the tab hides them by default,
-- but they stay in the data, because a directory owning page 1 is still worth knowing. Add to the
-- list below; a domain matches itself and any of its subdomains.
drop function if exists seo_market_leaders(text, date, date, integer);
create or replace function seo_market_leaders(p_client text, p_start date, p_end date, p_limit integer default 25)
returns table (
    domain text,
    cities integer,
    avg_visibility numeric,
    best_visibility numeric,
    tracked boolean,
    is_client boolean,
    is_directory boolean,
    snapshot_date date
)
language sql stable security invoker set search_path = public as $$
    with latest as (
        select max(date) as d from seo_serp_top10_daily
        where client_name = p_client and date between p_start and p_end
    ),
    rows as (
        select s.domain, regexp_replace(s.domain, '^www\.', '') as host, s.site_engine_id, s.visibility, s.date
        from seo_serp_top10_daily s, latest
        where s.client_name = p_client and s.date = latest.d
    ),
    own as (
        -- One step at a time: an anchored ^www\. can't match once "https://" is removed in the same pass
        select lower(regexp_replace(regexp_replace(regexp_replace(coalesce(c.gsc_property, ''),
                   '^sc-domain:|^https?://', ''), '^www\.', ''), '/.*$', '')) as domain
        from clients c where c.name = p_client
    ),
    directories(d) as (values
        ('yelp.com'), ('houzz.com'), ('angi.com'), ('angieslist.com'), ('homeadvisor.com'),
        ('thumbtack.com'), ('bbb.org'), ('yellowpages.com'), ('expertise.com'), ('porch.com'),
        ('networx.com'), ('buildzoom.com'), ('nextdoor.com'), ('mapquest.com'), ('provenexpert.com'),
        ('birdeye.com'), ('about.me'), ('facebook.com'), ('instagram.com'), ('pinterest.com'),
        ('youtube.com'), ('reddit.com'), ('linkedin.com'), ('tiktok.com'), ('google.com'),
        ('homedepot.com'), ('lowes.com'), ('trex.com'), ('timbertech.com'), ('azek.com'),
        ('fiberondecking.com'), ('decks.com'), ('decksdirect.com'), ('bobvila.com'),
        ('thisoldhouse.com'), ('forbes.com'), ('wikipedia.org'), ('xapp.ai')
    ),
    grouped as (
        select r.domain,
               r.host,
               count(distinct r.site_engine_id)::int as cities,
               round(avg(r.visibility), 2) as avg_visibility,
               round(max(r.visibility), 2) as best_visibility,
               max(r.date) as snapshot_date
        from rows r
        group by r.domain, r.host
    )
    select g.domain,
           g.cities,
           g.avg_visibility,
           g.best_visibility,
           exists (select 1 from seo_competitors c where c.client_name = p_client and c.active and c.domain = g.host),
           g.host = (select domain from own),
           exists (select 1 from directories x where g.host = x.d or g.host like '%.' || x.d),
           g.snapshot_date
    from grouped g
    order by exists (select 1 from directories x where g.host = x.d or g.host like '%.' || x.d),
             g.cities desc, g.avg_visibility desc
    limit greatest(p_limit, 1);
$$;
grant execute on function seo_market_leaders(text, date, date, integer) to authenticated;

-- One-time repair, safe to re-run. The first seranking-sync build stored SE Ranking's competitor
-- "outside the top 100" value (pos 100) as rank 100. The parser now stores null; this clears the
-- rows written before that fix instead of waiting for the next sync to overwrite them.
update seo_competitor_ranks set rank = null where rank >= 100;

notify pgrst, 'reload schema';
