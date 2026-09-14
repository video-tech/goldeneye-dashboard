-- Schema for seo-changelog-webhook (auto-logging articles published on Webflow and Wix).
-- Run once in the SQL Editor, before deploying the function.

-- ---------------------------------------------------------------------------
-- seo_changelog.source_ref: which published article an automatic entry came from
-- ---------------------------------------------------------------------------
-- "webflow:<CMS item id>" or "wix:<post id or URL>". Unique per client, so republishing an
-- article, or a sender retrying, never logs it twice: the insert is first-write-wins, and the
-- first publish is the date that matters. Manual entries leave it null, and nulls never
-- conflict, so they're unaffected.
alter table seo_changelog add column if not exists source_ref text;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'seo_changelog_client_source_ref_key') then
        alter table seo_changelog
            add constraint seo_changelog_client_source_ref_key unique (client_name, source_ref);
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- Every authenticated webhook request and what became of it
-- ---------------------------------------------------------------------------
-- Neither Wix's automation body nor Webflow's webhook was captured before this was built, so
-- this is how the first real publish gets checked, and how "why didn't that article log?" gets
-- answered later. Emails, phone numbers and credentials are scrubbed before storing.
--
-- RLS on with no policies: the public API can't read it, and the SQL Editor (which runs as
-- postgres) can. client_name here is informational only, so it's deliberately not in
-- rename_client.sql. A renamed client's old debug rows keeping the old name loses nothing.
create table if not exists seo_changelog_webhook_events (
    id          bigint generated always as identity primary key,
    received_at timestamptz not null default now(),
    source      text,
    outcome     text,      -- logged | duplicate | skipped | error
    reason      text,
    client_name text,
    query       jsonb,
    results     jsonb,
    payload     jsonb
);
create index if not exists seo_changelog_webhook_events_received on seo_changelog_webhook_events (received_at desc);
alter table seo_changelog_webhook_events enable row level security;

-- ---------------------------------------------------------------------------
-- Per-client setup, managed from the SEO tab (added 2026-09-14, the same day)
-- ---------------------------------------------------------------------------
-- The first version put everything in the webhook URL (the shared secret, site, blog path,
-- collection id). Setting a client up meant hand-building that URL and finding a collection id,
-- and Webflow can't edit a webhook, so any correction meant deleting and recreating it.
--
-- Now each client gets a random token, and the URL is just ?t=<token>. Platform, blog path and
-- collection live here and are edited in Golden Eye, and the webhook itself never changes. The
-- token is the credential: 64 random hex characters from two v4 UUIDs, which are generated with
-- a cryptographically secure source. Leaking one lets someone add fake article entries to that
-- client's changelog, nothing more, and deleting the row revokes it.
--
-- The old ?k=<shared secret> URLs keep working.
create table if not exists seo_webhook_configs (
    client_name   text primary key,
    token         text not null unique
                  default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
    platform      text not null check (platform in ('webflow', 'wix')),
    blog_path     text,   -- Webflow only: the URL prefix before a post's slug, e.g. /blog-posts
    collection_id text,   -- Webflow only: which CMS collection is the blog. Null = not picked yet
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
alter table seo_webhook_configs enable row level security;

drop policy if exists "Admins manage webhook configs" on seo_webhook_configs;
create policy "Admins manage webhook configs"
on seo_webhook_configs for all using (current_user_is_admin()) with check (current_user_is_admin());

-- The SEO tab lists collections seen in publishes that arrived before a blog collection was
-- picked, so admins read these events too. Nobody else can.
drop policy if exists "Admins read webhook events" on seo_changelog_webhook_events;
create policy "Admins read webhook events"
on seo_changelog_webhook_events for select using (current_user_is_admin());

notify pgrst, 'reload schema';

-- Then re-run supabase/sql/rename_client.sql, which now also moves seo_webhook_configs.

-- ---------------------------------------------------------------------------
-- Checking on it
-- ---------------------------------------------------------------------------
-- What arrived, and what happened to it:
--   select received_at, source, outcome, reason, client_name, results
--   from seo_changelog_webhook_events order by received_at desc limit 20;
--
-- The full (scrubbed) payload of the latest one, e.g. to check Wix's real field names:
--   select payload from seo_changelog_webhook_events order by received_at desc limit 1;
--
-- Automatic entries:
--   select client_name, live_date, created_by, title, url from seo_changelog
--   where source_ref is not null order by live_date desc limit 20;
