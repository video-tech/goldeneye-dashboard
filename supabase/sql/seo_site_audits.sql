-- Site audits: SE Ranking's website audit, one row per finished run, for the admin SEO tab.
--
-- Run this in the SQL Editor, then re-run supabase/sql/rename_client.sql, then deploy
-- seranking-sync.
--
-- SE Ranking does the crawling on its own schedule: each client's audit is set to run monthly
-- (1st of the month, 09:00 UTC) in SE Ranking's audit settings. A crawl counts pages against the
-- plan's page limit, not Data API units; reading the results back is free. seranking-sync checks
-- every day whether a newer finished audit exists and stores it once, so history builds up month
-- by month ("70 in September, 82 in October").
--
-- Admin-only. The issues are technical (missing alt text, unminified JavaScript) and would worry a
-- client more than inform them; a simple health score can go to the client tab later.

create table if not exists seo_site_audits (
    client_name text not null,
    seranking_audit_id bigint not null,
    -- when SE Ranking finished this run; a recheck keeps the same audit id with a new time
    audit_time timestamptz not null,
    score integer,                  -- health score, 0-100
    pages_crawled integer,
    errors integer,
    warnings integer,
    notices integer,
    passed integer,
    domain_trust integer,
    -- only the checks that found something: [{code, name, section, severity, count}]
    issues jsonb not null default '[]'::jsonb,
    synced_at timestamptz not null default now(),
    primary key (client_name, seranking_audit_id, audit_time)
);
create index if not exists seo_site_audits_latest on seo_site_audits (client_name, audit_time desc);

alter table seo_site_audits enable row level security;

drop policy if exists "Admins read site audits" on seo_site_audits;
create policy "Admins read site audits" on seo_site_audits
    for select using (current_user_is_admin());

-- Only seranking-sync writes, through service_role. No write policies.

notify pgrst, 'reload schema';
