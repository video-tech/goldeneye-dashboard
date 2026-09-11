-- Run once in the SQL Editor. Then run supabase/sql/rename_client.sql (it names this table),
-- then deploy ghl-lead-webhook.
--
-- One row per new GHL contact whose landing page is on its client's own website. It records
-- where the lead came from, never who they are: no name, email, phone number or IP address.
-- The classification rules, and the real captures they were written against, are in the
-- function's header and tests.

create table if not exists lead_sources (
    ghl_contact_id  text primary key,       -- first write wins, so a GHL retry can't double-count
    client_name     text not null,
    ghl_location_id text,
    created_at      timestamptz not null,   -- GHL's date_created, not when the webhook arrived
    lead_type       text not null check (lead_type in ('booking', 'form', 'call', 'chat', 'unknown')),
    source          text not null check (source in ('organic', 'paid', 'social', 'referral', 'direct', 'other', 'unknown')),
    -- google / bing / gbp / google_ads / microsoft_ads / facebook / a referring host /
    -- 'self_referral' (the lost last hop: the referrer is the client's own site) / ...
    source_detail   text,
    landing_host    text,
    landing_path    text,                   -- path only; the query string is broken out below
    referrer_host   text,
    utm_source      text,
    utm_medium      text,
    utm_campaign    text,
    src_restored    boolean not null default false,  -- source recovered by snippets/lead-source-carry.html
    is_gbp          boolean not null default false,  -- arrived through the Google Business Profile link
    lead_form       text,                   -- the GHL form or calendar name
    received_at     timestamptz not null default now()
);

create index if not exists lead_sources_client_created on lead_sources (client_name, created_at);

alter table lead_sources enable row level security;

drop policy if exists "Clients and admins read their own lead sources" on lead_sources;
create policy "Clients and admins read their own lead sources"
on lead_sources for select using (client_row_visible(client_name));

-- No insert/update/delete policies. Only the webhook writes, with the service-role key.
-- Same reasoning as every other table this build added.

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Checking on it
-- ---------------------------------------------------------------------------
-- select created_at, client_name, source, source_detail, lead_type, src_restored, landing_host, referrer_host
--   from lead_sources order by created_at desc limit 20;
--
-- select client_name, source, count(*) from lead_sources group by 1, 2 order by 1, 3 desc;
--
-- Lost-attribution rate per client. A high number means that client's site needs the
-- snippet, and it should fall once the snippet is installed.
-- select client_name,
--        round(100.0 * count(*) filter (where source_detail = 'self_referral') / count(*), 1) as pct_self_referral
--   from lead_sources group by 1 order by 2 desc;
