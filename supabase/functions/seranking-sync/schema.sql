-- Run once in the Supabase SQL Editor before deploying seranking-sync. Then re-run
-- supabase/sql/rename_client.sql — it's been extended to move these four tables too.
--
-- Real tracked rank, from SE Ranking, alongside the Search Console history seo-sync already
-- collects. The two aren't redundant: GSC only reports a query once it earns impressions,
-- so a client sitting at position 40 for "deck builder draper" is invisible to it. SE
-- Ranking checks a keyword whether or not the client shows up yet — that gap is the entire
-- reason to pay for it. See CLAUDE.md, SEO measurement, for the fuller reasoning and the
-- real API research this schema is built from.
--
-- Safe to re-run: every statement is guarded.

-- ---------------------------------------------------------------------------
-- Which SE Ranking project belongs to which client
-- ---------------------------------------------------------------------------
alter table clients
    add column if not exists seranking_site_id bigint;  -- SE Ranking's numeric project ("site") id

-- ---------------------------------------------------------------------------
-- Which locations are tracked for a client
-- ---------------------------------------------------------------------------
-- A "search engine" here means a specific city (and possibly device) SE Ranking is
-- configured to check, not just "Google" — a client serving three towns gets three rows
-- here, one per site_engine_id. **Correction, confirmed against real data 2026-09-11:**
-- keywords are NOT automatically checked against every engine on a project. SE Ranking's
-- own keyword list carries an explicit site_engine_ids array per keyword (seen in a real
-- response: {"id":"17705872",...,"site_engine_ids":[386614]}), so the pairing is
-- per-keyword, not a blanket matrix. That doesn't change how the tables below store
-- results: seo_rank_checks is keyed by whichever (keyword, site_engine_id) pairs actually
-- come back with position data, whatever SE Ranking's own scoping turns out to be.
--
-- Admin-only, like seo_sync_state: this is operational wiring — which search engines exist
-- for a client's project — not something the portal needs to query directly yet. If a later
-- phase wants to show "tracked from: Draper, Sandy, Provo" to the client, add a second
-- policy then; nothing here blocks it.
create table if not exists seo_rank_locations (
    id                bigint generated always as identity primary key,
    client_name       text not null,
    seranking_site_id bigint not null,
    site_engine_id    bigint not null,  -- SE Ranking's id; this is what a positions row is keyed by
    label             text,             -- e.g. "Draper, UT" — for display, filled in by the sync
    -- Device may or may not be a distinct field on SE Ranking's side — city and device can
    -- be one combined selection when a search engine is configured. Left nullable and
    -- filled in only when the sync can actually determine it, rather than asserting a
    -- shape not yet confirmed against their real API response.
    device            text,
    synced_at         timestamptz not null default now(),
    unique (seranking_site_id, site_engine_id)
);
create index if not exists seo_rank_locations_client on seo_rank_locations (client_name);

-- ---------------------------------------------------------------------------
-- Tracked keywords
-- ---------------------------------------------------------------------------
-- Managed IN SE Ranking, never typed twice here — the sync pulls the list; nothing here
-- ever writes back to SE Ranking. keyword is stored lower(trim()) so it can be matched
-- exactly against seo_queries_daily.query (GSC already lower-cases its own query text) —
-- that's what lets the admin tab show "SE Ranking says #4 — and here's what GSC says that
-- page's clicks and impressions actually did" as one row, not two unrelated numbers.
create table if not exists seo_keywords (
    id                   bigint generated always as identity primary key,
    client_name          text not null,
    seranking_keyword_id bigint,          -- SE Ranking's own id, so a re-sync matches by id, not by text
    keyword              text not null,
    target_page          text,
    active               boolean not null default true,
    added_at             timestamptz not null default now(),
    unique (client_name, keyword)
);
create index if not exists seo_keywords_client_active on seo_keywords (client_name) where active;

-- ---------------------------------------------------------------------------
-- Daily rank checks
-- ---------------------------------------------------------------------------
-- Organic AND map-pack rank live in ONE row here, because SE Ranking returns both from the
-- SAME call for a given keyword/location/date (their response carries pos, is_map and
-- map_position together). Splitting them into two rows keyed by an "engine" column would
-- invent a distinction their API doesn't make, and double the row count for nothing.
create table if not exists seo_rank_checks (
    client_name    text not null,
    keyword        text not null,
    site_engine_id bigint not null,  -- which tracked location this check is for — see seo_rank_locations
    date           date not null,
    organic_rank   integer,   -- null = not ranking within SE Ranking's tracked depth that day
    map_rank       integer,   -- null = not in the map pack that day
    ranking_url    text,      -- the landing page SE Ranking found ranking — cross-check against seo_pages_daily
    primary key (client_name, keyword, site_engine_id, date)
);
create index if not exists seo_rank_checks_client_kw_date on seo_rank_checks (client_name, keyword, date);

-- ---------------------------------------------------------------------------
-- SEO changelog: what work went live, and when
-- ---------------------------------------------------------------------------
-- A chart can be redrawn any time history exists; the story of WHY a line moved can't be
-- reconstructed after the fact if nobody wrote down when a page went live or a fix shipped.
-- This is the annotation source for the admin tab's trend chart, and later the case-study
-- view — "dated intervention -> visibility lift -> lead lift" only works if the dates exist.
create table if not exists seo_changelog (
    id          bigint generated always as identity primary key,
    client_name text not null,
    live_date   date not null,
    kind        text not null check (kind in ('content', 'technical', 'onpage', 'gbp', 'migration', 'other')),
    title       text not null,
    url         text,
    notes       text,     -- client-visible once the portal tab ships — this is case-study material, write it that way
    task_id     bigint,   -- optional link to tasks.id — no FK, since a task can be deleted independently
    created_by  text,
    created_at  timestamptz not null default now()
);
create index if not exists seo_changelog_client_date on seo_changelog (client_name, live_date);

-- ---------------------------------------------------------------------------
-- Let seo_sync_state track SE Ranking syncs too, alongside gsc/ga4/gbp
-- ---------------------------------------------------------------------------
-- The constraint below was created inline with no explicit name, so Postgres auto-named it
-- <table>_<column>_check — that generated name is what's being replaced here.
alter table seo_sync_state drop constraint if exists seo_sync_state_source_check;
alter table seo_sync_state add constraint seo_sync_state_source_check
    check (source in ('gsc', 'ga4', 'gbp', 'seranking'));

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table seo_rank_locations enable row level security;
alter table seo_keywords       enable row level security;
alter table seo_rank_checks    enable row level security;
alter table seo_changelog      enable row level security;

drop policy if exists "Admins read seo rank locations" on seo_rank_locations;
create policy "Admins read seo rank locations"
on seo_rank_locations for select using (current_user_is_admin());

drop policy if exists "Clients and admins read their own keywords" on seo_keywords;
create policy "Clients and admins read their own keywords"
on seo_keywords for select using (client_row_visible(client_name));

drop policy if exists "Clients and admins read their own rank checks" on seo_rank_checks;
create policy "Clients and admins read their own rank checks"
on seo_rank_checks for select using (client_row_visible(client_name));

drop policy if exists "Clients and admins read their own changelog" on seo_changelog;
create policy "Clients and admins read their own changelog"
on seo_changelog for select using (client_row_visible(client_name));

-- seo_keywords and seo_changelog also get an admin WRITE policy — the admin tab lets
-- someone add or retire a tracked keyword, or log a changelog entry, by hand. That's
-- different from seo_rank_checks and seo_rank_locations, which stay service_role-only like
-- every sync-only table in this build: nothing legitimate ever writes a rank check by hand.
drop policy if exists "Admins manage keywords" on seo_keywords;
create policy "Admins manage keywords"
on seo_keywords for all using (current_user_is_admin()) with check (current_user_is_admin());

drop policy if exists "Admins manage changelog" on seo_changelog;
create policy "Admins manage changelog"
on seo_changelog for all using (current_user_is_admin()) with check (current_user_is_admin());

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Checking on it
-- ---------------------------------------------------------------------------
-- select client_name, seranking_site_id from clients where seranking_site_id is not null;
-- select client_name, site_engine_id, label, device from seo_rank_locations order by client_name;
-- select client_name, count(*) tracked from seo_keywords where active group by 1;
-- select client_name, keyword, site_engine_id, date, organic_rank, map_rank, ranking_url
--   from seo_rank_checks order by date desc limit 20;
-- select client_name, live_date, kind, title from seo_changelog order by live_date desc limit 20;
