-- Service-based onboarding: schema, the rule for which steps apply, automatic checks, and the
-- migration of today's clients and steps. Run once in the SQL Editor, then re-run
-- supabase/sql/rename_client.sql (it now moves client_services).
--
-- Safe on its own: nothing in app.js or the handoff trigger reads these columns or functions
-- yet, so running this changes no client's Get Started. The app and trigger switch over in later steps.
--
-- Services are data, not code, so the list can change without touching the engine. Adding,
-- renaming or retiring a service is a row edit in Templates → Services, and tagging steps with it is
-- how it gets an onboarding. Nothing here names a service except the seed rows and the migration
-- of today's steps.
--
-- Midas's offer (2026-09-14): every client starts on Base (free website, missed-call text-back,
-- review automation, lead follow-up, portal access). Add-ons are SEO Growth, Ads management and
-- Video. Base is NOT a service row: every client has it, so Base steps are simply the untagged
-- ones. Website is not an add-on either, since the site comes with Base. What varies is the website
-- situation (we build their free site, or they keep an existing one), stored on the client.

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
-- Video is a placeholder: created switched off, so it can't be picked until its onboarding is built.
-- Turning it on is one toggle in Templates → Services.
insert into services (key, name, description, active, sort_order) values
    ('ads',   'Ads management', 'Meta ads, creative testing, the morning audit, weekly reports', true, 1),
    ('seo',   'SEO Growth', 'On-site SEO, service and location pages, Google Business Profile, content, rank tracking', true, 2),
    ('video', 'Video', 'Ad creative, website and service videos, social clips', false, 3)
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

-- The client's website situation, a fact about the client and not a service:
--   new_build  we're building their free Base site (we own the access, so there's no chase)
--   existing   they keep a site they already have (SEO needs login/collaborator access to it)
--   none       no site and not building one yet
-- Null means not set yet, and steps that depend on it are skipped until it is.
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
-- onboarding_condition_matches: THE rule, in one place
-- ---------------------------------------------------------------------------
-- Does a step or checklist item with these tags apply to a client with these services and this
-- website situation? Every function below calls this, whether for a real client, the Templates
-- preview, or stage checklists. Nothing else, including app.js, reimplements it, so the preview can
-- never promise something the portal or the handoff trigger won't do.
create or replace function onboarding_condition_matches(
    p_step_services text[], p_step_websites text[], p_services text[], p_website text
)
returns boolean
language sql immutable
as $$
    select (cardinality(coalesce(p_step_websites, '{}')) = 0 or p_website = any (p_step_websites))
       and (cardinality(coalesce(p_step_services, '{}')) = 0 or coalesce(p_step_services, '{}') && coalesce(p_services, '{}'));
$$;
grant execute on function onboarding_condition_matches(text[], text[], text[], text) to authenticated;

-- What a hypothetical client would get, for the Templates editor's preview ("ads + SEO, existing
-- site"). display_service_key follows the same "first matching service by sort order" rule as the
-- real thing. Steps and stage checklist items both come back, told apart by source.
create or replace function onboarding_preview(p_services text[], p_website text)
returns table (source text, item_id text, title text, owner text, stage text, display_service_key text, auto_check text, sort_order integer)
language sql stable
set search_path = public
as $$
    select 'step', st.id::text, st.title, coalesce(st.owner, 'client'), 'Onboarding',
           (select s.key from services s where s.key = any (st.service_keys) and s.key = any (coalesce(p_services, '{}'))
             order by s.sort_order, s.key limit 1),
           st.auto_check, coalesce(st.sort_order, 0)
    from onboarding_steps st
    where coalesce(st.active, true)
      and onboarding_condition_matches(st.service_keys, st.website_statuses, p_services, p_website)
    union all
    select 'checklist', t.id::text, t.task_title, 'agency', t.stage,
           (select s.key from services s where s.key = any (t.service_keys) and s.key = any (coalesce(p_services, '{}'))
             order by s.sort_order, s.key limit 1),
           t.auto_check, coalesce(t.sort_order, 0)
    from stage_templates t
    where onboarding_condition_matches(t.service_keys, t.website_statuses, p_services, p_website)
    order by 1 desc, 5, 8;
$$;
grant execute on function onboarding_preview(text[], text) to authenticated;

-- ---------------------------------------------------------------------------
-- onboarding_steps_for_client: what a real client gets
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
          -- untagged steps are Base, which every client has, even with no add-ons
          and onboarding_condition_matches(st.service_keys, st.website_statuses,
                                           (select array_agg(service_key) from mine), c.website_status)
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

-- Onboarding progress per service:
-- - The first row is always 'base': the untagged steps every client does. Its status is onboarding
--   until they're all done, then active.
-- - Each add-on is complete when its own tagged client steps are done AND Base is done, since an SEO
--   client can't finish SEO onboarding without the shared basics.
-- Agency steps are tasks and never gate the client.
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
    select 'base'::text,
           case when exists (select 1 from shared where not completed) then 'onboarding' else 'active' end,
           (select count(*) from shared), (select count(*) from shared where completed),
           not exists (select 1 from shared where not completed)
    where exists (select 1 from clients where name = p_client)
    union all
    select m.service_key, m.status,
           (select count(*) from steps s where s.service_key = m.service_key) + (select count(*) from shared),
           (select count(*) from steps s where s.service_key = m.service_key and s.completed)
             + (select count(*) from shared where completed),
           not exists (select 1 from steps s where s.service_key = m.service_key and not s.completed)
             and not exists (select 1 from shared where not completed)
    from mine m;
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
        -- Cuppa has no API to ask, but its end result is visible: an article published to the
        -- client's site and logged automatically proves Cuppa, the site connection and auto-logging
        -- all work together. Manual changelog entries (created_by an email) don't count.
        ('first_article_logged', 'First article published and auto-logged (Cuppa pipeline working)',
            exists (select 1 from seo_changelog l where l.client_name = c.name and l.created_by in ('webflow', 'wix', 'sanity', 'git'))),
        ('lead_tracking_live',  'Website lead tracking receiving leads',
            exists (select 1 from lead_sources l where l.client_name = c.name)),
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
-- Steps as they stood on 2026-09-14, matched by title. Everything Base stays untagged (every client):
-- welcome, setup call, the two business forms, sales team (lead follow-up is Base), and GHL setup
-- (missed-call text-back, reviews and follow-up all run in GHL). A title renamed since is simply
-- left untagged, meaning every client, which is the current behavior.
update onboarding_steps set service_keys = '{ads}'
where cardinality(service_keys) = 0 and title in (
    'Offers and preferences', 'Give us access to your Facebook', 'Add your card to Facebook',
    'How Meta charges you for ad spend', 'Create your Facebook Page', 'Set up your Business Manager',
    'Add their Meta ad account ID to Golden Eye', 'Build and launch ads');
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
