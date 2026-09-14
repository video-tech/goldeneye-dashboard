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

notify pgrst, 'reload schema';

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
