-- Service-based onboarding: schema, the rule for which steps apply, automatic checks, and the
-- migration of today's clients and steps. Run once in the SQL Editor, then re-run
-- supabase/sql/rename_client.sql (it now moves client_services).
--
-- Safe on its own: nothing in app.js or the handoff trigger reads these columns or functions
-- yet, so running this changes no client's Get Started. The app and trigger switch over in later steps.
--
-- Services are data, not code. Midas sells video, ads, website and SEO in any combination, and the
-- list will change. Adding, renaming or retiring a service is a row edit in Templates → Services;
-- tagging steps with it is how it gets an onboarding. Nothing here names a service except the seed
-- rows and the migration of today's steps.

-- ---------------------------------------------------------------------------
-- Services and which ones each client has
-- ---------------------------------------------------------------------------
create table if not exists services (
    key         text primary key check (key ~ '^[a-z0-9_]+$'),   -- stable id, used in tags; never shown
    name        text not null,                                    -- what clients and admins see
    description text,
    active      boolean not null default true,                    -- retired services keep their history
    sort_order  integer not null default 0,
    created_at  timestamptz not null default now()
);
insert into services (key, name, sort_order) values
    ('ads', 'Ads', 1), ('seo', 'SEO', 2), ('website', 'Website', 3), ('video', 'Video', 4)
on conflict (key) do nothing;

alter table services enable row level security;
-- Service names are shown to clients as Get Started headings, and there's nothing private in them
drop policy if exists "Signed-in users read services" on services;
create policy "Signed-in users read services" on services for select to authenticated using (true);
drop policy if exists "Admins manage services" on services;
create policy "Admins manage services" on services for all using (current_user_is_admin()) with check (current_user_is_admin());

-- One row per service per client. status:
--   onboarding  the service was just added: its client steps show on Get Started
--   active      onboarding done (or predates this system)
--   paused / ended  kept for history; its steps no longer apply
create table if not exists client_services (
    client_name  text not null,
    service_key  text not null references services (key) on update cascade,
    status       text not null default 'onboarding' check (status in ('onboarding', 'active', 'paused', 'ended')),
    started_at   timestamptz not null default now(),
    onboarded_at timestamptz,
    primary key (client_name, service_key)
);
alter table client_services enable row level security;
drop policy if exists "Clients and admins read their own services" on client_services;
create policy "Clients and admins read their own services" on client_services for select using (client_row_visible(client_name));
drop policy if exists "Admins manage client services" on client_services;
create policy "Admins manage client services" on client_services for all using (current_user_is_admin()) with check (current_user_is_admin());

-- The client's website situation. It's a fact about the client, not a service: ads and SEO steps
-- depend on it even when "website" wasn't bought. Null means not set yet, and steps that depend on
-- it are skipped until it is.
alter table clients add column if not exists website_status text;
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'clients_website_status_check') then
        alter table clients add constraint clients_website_status_check
            check (website_status is null or website_status in ('none', 'existing', 'new_build'));
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- Conditions on steps and checklist items
-- ---------------------------------------------------------------------------
-- service_keys      applies when the client has ANY of these services. Empty = every client.
-- website_statuses  applies when the client's website_status is one of these. Empty = any.
-- auto_check        a key from onboarding_auto_checks(). Golden Eye completes the task itself
--                   when the check passes. Null = a person ticks it off.
alter table onboarding_steps
    add column if not exists service_keys     text[] not null default '{}',
    add column if not exists website_statuses text[] not null default '{}',
    add column if not exists auto_check       text;
alter table stage_templates
    add column if not exists service_keys     text[] not null default '{}',
    add column if not exists website_statuses text[] not null default '{}',
    add column if not exists auto_check       text;

-- ---------------------------------------------------------------------------
-- onboarding_steps_for_client: THE rule for what a client gets
-- ---------------------------------------------------------------------------
-- The portal, the admin view and the onboarding-complete trigger all use this, so they can't
-- disagree about what "done" means. That's the same reason the morning audit's engine lives in one file.
--
-- One row per applicable step PER SERVICE it counts toward:
-- - A shared step (no service tags) returns one row with service_key null.
-- - A step tagged [ads, seo, website] for an ads + SEO client returns two rows (ads and seo), since
--   finishing it counts toward both. display_service_key is the one to show it under: the
--   first matching service in services.sort_order.
-- Only services the client has as onboarding or active count. Paused and ended don't bring steps
-- back. completed tells whether the client has done the step.
create or replace function onboarding_steps_for_client(p_client text)
returns table (
    step_id             onboarding_steps.id%type,
    owner               text,
    service_key         text,
    service_status      text,
    display_service_key text,
    completed           boolean,
    sort_order          integer
)
language sql stable
set search_path = public
as $$
    with c as (
        select cl.name, cl.website_status,
               lower(regexp_replace(cl.name, '[^a-zA-Z0-9]', '', 'g')) as key
        from clients cl where cl.name = p_client limit 1
    ),
    mine as (
        select cs.service_key, cs.status, s.sort_order
        from client_services cs
        join services s on s.key = cs.service_key
        where cs.client_name = p_client and cs.status in ('onboarding', 'active')
    ),
    eligible as (
        select st.*
        from onboarding_steps st, c
        where coalesce(st.active, true)
          and exists (select 1 from mine)   -- a client with no services gets no onboarding
          and (cardinality(st.website_statuses) = 0 or c.website_status = any (st.website_statuses))
          and (cardinality(st.service_keys) = 0 or st.service_keys && (select array_agg(service_key) from mine))
    ),
    done as (
        select p.step_id
        from client_onboarding_progress p, c
        where lower(regexp_replace(coalesce(p.client_name, ''), '[^a-zA-Z0-9]', '', 'g')) = c.key
          and p.completed_at is not null
    )
    select e.id,
           coalesce(e.owner, 'client'),
           m.service_key,
           m.status,
           (select m2.service_key from mine m2
             where cardinality(e.service_keys) > 0 and m2.service_key = any (e.service_keys)
             order by m2.sort_order, m2.service_key limit 1),
           exists (select 1 from done d where d.step_id = e.id),
           coalesce(e.sort_order, 0)
    from eligible e
    left join mine m on cardinality(e.service_keys) > 0 and m.service_key = any (e.service_keys)
    order by coalesce(e.sort_order, 0), e.id;
$$;
grant execute on function onboarding_steps_for_client(text) to authenticated;

-- Per-service onboarding progress: a service's onboarding is complete when every client step that
-- counts toward it is done, meaning its own tagged steps plus the shared ones. Agency steps are tasks
-- and never gate the client.
create or replace function service_onboarding_status(p_client text)
returns table (service_key text, status text, client_steps bigint, client_steps_done bigint, complete boolean)
language sql stable
set search_path = public
as $$
    with steps as (select * from onboarding_steps_for_client(p_client) where owner <> 'agency'),
    shared as (select step_id, completed from steps where service_key is null),
    mine as (
        select cs.service_key, cs.status from client_services cs
        where cs.client_name = p_client and cs.status in ('onboarding', 'active')
    )
    select m.service_key, m.status,
           (select count(*) from steps s where s.service_key = m.service_key) + (select count(*) from shared),
           (select count(*) from steps s where s.service_key = m.service_key and s.completed)
             + (select count(*) from shared where completed),
           not exists (select 1 from steps s where s.service_key = m.service_key and not s.completed)
             and not exists (select 1 from shared where not completed)
    from mine m
    order by m.service_key;
$$;
grant execute on function service_onboarding_status(text) to authenticated;

-- ---------------------------------------------------------------------------
-- onboarding_auto_checks: things Golden Eye can see for itself
-- ---------------------------------------------------------------------------
-- A task (or checklist item) with auto_check = one of these keys is completed automatically once
-- the check passes. Add a check here and pick it in the Templates editor, and no other code changes.
create or replace function onboarding_auto_checks(p_client text)
returns table (check_key text, label text, passed boolean)
language sql stable
set search_path = public
as $$
    with c as (select * from clients where name = p_client limit 1)
    select v.check_key, v.label, coalesce(v.passed, false)
    from c cross join lateral (values
        ('ad_account_set',      'Meta ad account ID saved',
            nullif(regexp_replace(coalesce(c.ad_account_id, ''), '\D', '', 'g'), '') is not null),
        -- daily_reports came from a Google Sheet via Make, so spend is read as text and converted,
        -- whatever its column type. Account ids compare as bare digits, like reportsForClient().
        ('ads_data_flowing',    'Ad spend showing up in Golden Eye',
            exists (select 1 from daily_reports d
                    where nullif(regexp_replace(coalesce(c.ad_account_id, ''), '\D', '', 'g'), '') is not null
                      and regexp_replace(coalesce(d.ad_account_id::text, ''), '\D', '', 'g') = regexp_replace(c.ad_account_id, '\D', '', 'g')
                      and coalesce(nullif(regexp_replace(coalesce(d.spend::text, ''), '[^0-9.]', '', 'g'), '')::numeric, 0) > 0)),
        ('ghl_location_set',    'GHL sub-account linked',
            nullif(trim(coalesce(c.ghl_location_id, '')), '') is not null),
        ('gsc_connected',       'Search Console connected and syncing',
            c.gsc_property is not null and exists (select 1 from seo_daily d where d.client_name = c.name)),
        ('seranking_connected', 'SE Ranking project syncing',
            c.seranking_site_id is not null and exists (select 1 from seo_rank_checks r where r.client_name = c.name)),
        ('seo_settings_set',    'SEO start date and fee saved',
            c.seo_start_date is not null and c.seo_monthly_fee is not null),
        ('autolog_configured',  'Article auto-logging set up',
            exists (select 1 from seo_webhook_configs w where w.client_name = c.name)),
        ('first_organic_lead',  'First lead from Google received',
            exists (select 1 from lead_sources l where l.client_name = c.name and l.source = 'organic')),
        ('website_status_set',  'Website situation recorded',
            c.website_status is not null)
    ) as v (check_key, label, passed);
$$;
grant execute on function onboarding_auto_checks(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Migration: today's steps, checklist and clients, so nothing anyone sees changes
-- ---------------------------------------------------------------------------
-- Steps as they stood on 2026-09-14, matched by title. Welcome, setup call, and the two business
-- forms stay shared (no tags). A title that's since been renamed is simply left untagged,
-- meaning shared, which is the current behavior.
update onboarding_steps set service_keys = '{ads}'
where cardinality(service_keys) = 0 and title in (
    'Offers and preferences', 'Give us access to your Facebook', 'Add your card to Facebook',
    'How Meta charges you for ad spend', 'Create your Facebook Page', 'Set up your Business Manager',
    'Add their Meta ad account ID to Golden Eye', 'Build and launch ads');
update onboarding_steps set service_keys = '{ads,seo,website}'
where cardinality(service_keys) = 0 and title in ('Sales team (names & numbers)', 'Set up GHL sub-account & assets');
update onboarding_steps set auto_check = 'ad_account_set'   where auto_check is null and title = 'Add their Meta ad account ID to Golden Eye';
update onboarding_steps set auto_check = 'ads_data_flowing' where auto_check is null and title = 'Build and launch ads';
update onboarding_steps set auto_check = 'ghl_location_set' where auto_check is null and title = 'Set up GHL sub-account & assets';
update stage_templates  set service_keys = '{ads}' where cardinality(service_keys) = 0 and task_title = 'Draft Copywriting Hooks V1';

-- Every existing client is an ads client. Status follows where they are today:
-- archived → ended, paused → paused, still in the Onboarding stage → onboarding, otherwise active.
insert into client_services (client_name, service_key, status, started_at)
select c.name, 'ads',
       case when c.status = 'archived' then 'ended'
            when c.status = 'paused' then 'paused'
            when coalesce(c.current_stage, 'Onboarding') = 'Onboarding' then 'onboarding'
            else 'active' end,
       now()
from clients c
on conflict (client_name, service_key) do nothing;

-- SEO clients today: anyone with Search Console or SE Ranking connected. Active, since their setup
-- is already done and shouldn't reappear as onboarding.
insert into client_services (client_name, service_key, status, started_at, onboarded_at)
select c.name, 'seo', 'active', coalesce(c.seo_start_date::timestamptz, now()), now()
from clients c
where c.gsc_property is not null or c.seranking_site_id is not null
on conflict (client_name, service_key) do nothing;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Checking on it
-- ---------------------------------------------------------------------------
-- select client_name, service_key, status from client_services order by client_name, service_key;
-- select title, owner, service_keys, website_statuses, auto_check from onboarding_steps order by sort_order;
-- select * from onboarding_steps_for_client('3Sixty Industries');
-- select * from service_onboarding_status('3Sixty Industries');
-- select * from onboarding_auto_checks('3Sixty Industries');
