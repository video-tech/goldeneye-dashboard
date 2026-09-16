-- Content ideas: question and long-tail keywords pulled from SE Ranking's Data API, for the admin
-- SEO tab's new Content Ideas panel. This is the first thing in Golden Eye to spend Data API
-- units (never Project API units, which every other SE Ranking pull in this codebase uses) — see
-- the cost note on syncContentIdeas in seranking-sync/index.ts before changing the seed count or
-- the per-call limits.
--
-- Run this in the SQL Editor, then re-run supabase/sql/rename_client.sql, then deploy
-- seranking-sync. Admin-only: this is a planning tool for what to write next, not something a
-- client needs to see.

-- seo_sync_state.source only allowed gsc/ga4/gbp/seranking until now. Its own value keeps a
-- content-ideas run from colliding with the rank sync's own last_daily_run under source
-- 'seranking' — sharing it would make either job falsely think it already ran today.
alter table seo_sync_state drop constraint if exists seo_sync_state_source_check;
alter table seo_sync_state add constraint seo_sync_state_source_check
    check (source = any (array['gsc', 'ga4', 'gbp', 'seranking', 'content_ideas']));

create table if not exists seo_content_ideas (
    id bigint generated always as identity primary key,
    client_name text not null,
    keyword text not null,
    kind text not null check (kind in ('question', 'longtail')),
    seed_keyword text not null,       -- which of the client's tracked keywords this came from
    volume integer,                    -- questions only; longtail returns keyword strings alone
    cpc numeric,
    difficulty integer,
    competition numeric,
    intents text[],
    first_seen date not null default current_date,
    last_seen date not null default current_date,
    dismissed boolean not null default false,
    dismissed_at timestamptz,
    dismissed_by text,
    unique (client_name, keyword)
);
create index if not exists seo_content_ideas_client on seo_content_ideas (client_name, dismissed, volume desc nulls last);

alter table seo_content_ideas enable row level security;
drop policy if exists "Admins read content ideas" on seo_content_ideas;
create policy "Admins read content ideas" on seo_content_ideas for select using (current_user_is_admin());
drop policy if exists "Admins dismiss content ideas" on seo_content_ideas;
create policy "Admins dismiss content ideas" on seo_content_ideas for update
    using (current_user_is_admin()) with check (current_user_is_admin());
-- No insert/delete policy: only seranking-sync writes new ideas, through service_role.

notify pgrst, 'reload schema';
