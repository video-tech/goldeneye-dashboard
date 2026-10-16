-- Answers that pick the video (2026-10-14): the two early questions from the onboarding rebuild plan.
--   "Do you have a Facebook business page?"      facebook_page: yes | no | unsure
--   "Do you have a CRM you want leads sent to?"  crm_choice: no | yes   (plus which CRM, and how it takes leads)
-- Run after service_onboarding.sql. Nothing here is keyed on a client name, so rename_client.sql needs no
-- new line. Safe to re-run.
--
-- HOW IT PLUGS IN. These are facts about the client, saved on the clients row like website_status. Steps
-- (onboarding_steps) and checklist items (stage_templates) get one more tag, fact_conditions, such as
--   {"facebook_page": ["no"]}      applies only when the client answered "no, I need one"
--   {"crm_choice": ["yes"]}
-- An empty {} applies to everyone, so nothing existing changes. Several keys must ALL match; several values
-- in one key are any-of. THE RULE stays in one place, onboarding_condition_matches(), which gains a six
-- argument form that adds the fact check. Everything that already called it (the portal's step list, the
-- handoff trigger, stage checklists, the Templates preview) is re-created below to pass the facts, so the
-- portal, the admin view and the trigger still cannot disagree about which video a client sees.
--
-- UNANSWERED = THE DEFAULT. A client who has not answered (every existing client) is treated as
-- facebook_page = yes and crm_choice = no, because that is almost everyone. So tagging a step "no" never
-- shows it to someone who simply was not asked, and nothing existing changes until a step is tagged.
--
-- WRITES go through set_client_onboarding_facts(), not a direct update: the clients table's policies are
-- all open (see Known gaps), and the client's own browser should be able to set exactly these four fields
-- for exactly its own client and nothing else.
--
-- The steps seeded at the bottom are all HIDDEN (active = false). Going live is two statements that are
-- commented out at the end, because switching the Quick start step on changes what every client in
-- onboarding sees.

begin;

-- ---------------------------------------------------------------------------
-- The facts, on the client
-- ---------------------------------------------------------------------------
alter table clients
    add column if not exists facebook_page text,
    add column if not exists crm_choice    text,
    add column if not exists crm_name      text,
    add column if not exists crm_method    text;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'clients_facebook_page_check') then
        alter table clients add constraint clients_facebook_page_check
            check (facebook_page is null or facebook_page in ('yes', 'no', 'unsure'));
    end if;
    if not exists (select 1 from pg_constraint where conname = 'clients_crm_choice_check') then
        alter table clients add constraint clients_crm_choice_check
            check (crm_choice is null or crm_choice in ('no', 'yes'));
    end if;
    if not exists (select 1 from pg_constraint where conname = 'clients_crm_method_check') then
        alter table clients add constraint clients_crm_method_check
            check (crm_method is null or crm_method in ('email', 'webhook', 'unsure'));
    end if;
end $$;

alter table onboarding_steps add column if not exists fact_conditions jsonb not null default '{}'::jsonb;
alter table stage_templates  add column if not exists fact_conditions jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- The rule
-- ---------------------------------------------------------------------------
create or replace function onboarding_fact_defaults()
returns jsonb language sql immutable as $$
    select '{"facebook_page": "yes", "crm_choice": "no"}'::jsonb;
$$;

-- A client's facts with the defaults filled in. SECURITY DEFINER so it can read the clients row from
-- inside the functions that already check the caller; it returns only these two non-sensitive values.
create or replace function onboarding_client_facts(p_client text)
returns jsonb
language sql stable
security definer
set search_path = public
as $$
    select onboarding_fact_defaults() || coalesce(
        (select jsonb_strip_nulls(jsonb_build_object('facebook_page', c.facebook_page, 'crm_choice', c.crm_choice))
         from clients c where c.name = p_client), '{}'::jsonb);
$$;

-- Do these fact conditions hold for these facts? Every key with a non-empty list must have the client's
-- value in that list. A key the facts do not mention fails, so a typo in a tag hides the step rather than
-- showing it to everyone.
create or replace function onboarding_facts_match(p_conditions jsonb, p_facts jsonb)
returns boolean
language sql immutable
as $$
    select not exists (
        select 1 from jsonb_each(coalesce(p_conditions, '{}'::jsonb)) c (k, v)
        where jsonb_typeof(v) = 'array' and jsonb_array_length(v) > 0
          and not (v ? coalesce(p_facts ->> k, ''))
    );
$$;

-- The four-argument form stays (nothing else breaks); the six-argument form is the new rule.
create or replace function onboarding_condition_matches(
    p_step_services text[], p_step_websites text[], p_step_facts jsonb,
    p_services text[], p_website text, p_facts jsonb
)
returns boolean
language sql immutable
as $$
    select onboarding_condition_matches(p_step_services, p_step_websites, p_services, p_website)
       and onboarding_facts_match(p_step_facts, p_facts);
$$;
grant execute on function onboarding_fact_defaults(), onboarding_facts_match(jsonb, jsonb),
    onboarding_condition_matches(text[], text[], jsonb, text[], text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Everything that applies steps now passes the facts
-- ---------------------------------------------------------------------------
drop function if exists onboarding_preview(text[], text);
create or replace function onboarding_preview(p_services text[], p_website text, p_facts jsonb default null)
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
      and onboarding_condition_matches(st.service_keys, st.website_statuses, st.fact_conditions, p_services, p_website,
                                       onboarding_fact_defaults() || coalesce(p_facts, '{}'::jsonb))
    union all
    select 'checklist', t.id::text, t.task_title, 'agency', t.stage,
           (select s.key from services s where s.key = any (t.service_keys) and s.key = any (coalesce(p_services, '{}'))
             order by s.sort_order, s.key limit 1),
           t.auto_check, coalesce(t.sort_order, 0)
    from stage_templates t
    where onboarding_condition_matches(t.service_keys, t.website_statuses, t.fact_conditions, p_services, p_website,
                                       onboarding_fact_defaults() || coalesce(p_facts, '{}'::jsonb))
    order by 1 desc, 5, 8;
$$;

grant execute on function onboarding_preview(text[], text, jsonb) to authenticated;

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
security definer
set search_path = public
as $$
    with c as (
        select cl.name, cl.website_status,
               lower(regexp_replace(cl.name, '[^a-zA-Z0-9]', '', 'g')) as key
        from clients cl
        where cl.name = p_client
          and (coalesce(auth.role(), '') in ('', 'service_role') or client_row_visible(p_client))
        limit 1
    ),
    mine as (
        select cs.service_key, cs.status, s.sort_order
        from client_services cs
        join services s on s.key = cs.service_key
        where cs.client_name = (select name from c) and cs.status in ('onboarding', 'active')
    ),
    eligible as (
        select st.*
        from onboarding_steps st, c
        where coalesce(st.active, true)
          -- untagged steps are Base, which every client has, even with no add-ons
          and onboarding_condition_matches(st.service_keys, st.website_statuses, st.fact_conditions,
                                           (select array_agg(service_key) from mine), c.website_status,
                                           onboarding_client_facts(c.name))
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

create or replace function stage_templates_for_client(p_client text, p_stage text)
returns setof stage_templates
language sql stable
security definer
set search_path = public
as $$
    select t.*
    from stage_templates t, clients cl
    where cl.name = p_client
      and (coalesce(auth.role(), '') in ('', 'service_role') or client_row_visible(p_client))
      and t.stage = p_stage
      and onboarding_condition_matches(
            t.service_keys, t.website_statuses, t.fact_conditions,
            (select array_agg(cs.service_key) from client_services cs
              where cs.client_name = cl.name and cs.status in ('onboarding', 'active')),
            cl.website_status, onboarding_client_facts(cl.name))
    order by t.sort_order;
$$;

-- create or replace keeps old grants, but say it again: signed-in users and service_role only
revoke execute on function onboarding_steps_for_client(text), stage_templates_for_client(text, text),
    onboarding_client_facts(text) from public;
do $$ begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        execute 'revoke execute on function onboarding_steps_for_client(text), stage_templates_for_client(text, text), onboarding_client_facts(text) from anon';
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        execute 'grant execute on function onboarding_steps_for_client(text), stage_templates_for_client(text, text), onboarding_client_facts(text) to service_role';
    end if;
end $$;
grant execute on function onboarding_steps_for_client(text), stage_templates_for_client(text, text),
    onboarding_client_facts(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Saving a client's answers
-- ---------------------------------------------------------------------------
-- p_facts may carry facebook_page, crm_choice, crm_name, crm_method. Only keys that are present change.
-- Choosing "no CRM" clears the CRM name and method. Returns what is saved. A client can do this only for
-- a client they can see (client_row_visible, which includes the client_email fallback and admins).
create or replace function set_client_onboarding_facts(p_client text, p_facts jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_page text; v_crm text; v_name text; v_method text;
begin
    if coalesce(auth.role(), '') not in ('', 'service_role') and not client_row_visible(p_client) then
        raise exception 'You cannot change this client''s answers';
    end if;
    if not exists (select 1 from clients where name = p_client) then
        raise exception 'No client called %', p_client;
    end if;
    p_facts := coalesce(p_facts, '{}'::jsonb);

    if p_facts ? 'facebook_page' then
        v_page := nullif(btrim(p_facts ->> 'facebook_page'), '');
        if v_page is not null and v_page not in ('yes', 'no', 'unsure') then raise exception 'facebook_page must be yes, no or unsure'; end if;
        update clients set facebook_page = v_page where name = p_client;
    end if;
    if p_facts ? 'crm_choice' then
        v_crm := nullif(btrim(p_facts ->> 'crm_choice'), '');
        if v_crm is not null and v_crm not in ('no', 'yes') then raise exception 'crm_choice must be no or yes'; end if;
        update clients set crm_choice = v_crm where name = p_client;
        if v_crm = 'no' then update clients set crm_name = null, crm_method = null where name = p_client; end if;
    end if;
    if p_facts ? 'crm_name' and coalesce((select crm_choice from clients where name = p_client), '') = 'yes' then
        v_name := left(nullif(btrim(p_facts ->> 'crm_name'), ''), 60);
        update clients set crm_name = v_name where name = p_client;
    end if;
    if p_facts ? 'crm_method' and coalesce((select crm_choice from clients where name = p_client), '') = 'yes' then
        v_method := nullif(btrim(p_facts ->> 'crm_method'), '');
        if v_method is not null and v_method not in ('email', 'webhook', 'unsure') then raise exception 'crm_method must be email, webhook or unsure'; end if;
        update clients set crm_method = v_method where name = p_client;
    end if;

    return (select jsonb_strip_nulls(jsonb_build_object('facebook_page', c.facebook_page, 'crm_choice', c.crm_choice,
                                                         'crm_name', c.crm_name, 'crm_method', c.crm_method))
            from clients c where c.name = p_client);
end;
$$;
revoke execute on function set_client_onboarding_facts(text, jsonb) from public;
do $$ begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        execute 'revoke execute on function set_client_onboarding_facts(text, jsonb) from anon';
    end if;
end $$;
grant execute on function set_client_onboarding_facts(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- The steps this adds, all hidden
-- ---------------------------------------------------------------------------
-- (Choices must not contain commas: the Templates editor splits choices on them.)
-- Quick start goes second, right after the welcome video. Everything from there down moves one place so
-- the order stays as it is. Only runs the first time.
do $$
begin
    if not exists (select 1 from onboarding_steps where title = 'Quick start: your Facebook page and CRM') then
        update onboarding_steps set sort_order = sort_order + 1 where sort_order >= 2;
        insert into onboarding_steps (title, description, step_type, owner, active, sort_order, questions) values (
            'Quick start: your Facebook page and CRM',
            'Two quick questions so we show you the right setup videos.',
            'questions', 'client', false, 2,
            '[
              {"id": "q_fb_page", "label": "Do you have a Facebook business page?", "type": "choice", "required": true,
               "options": ["Yes", "No (I need one)", "Not sure"], "website_statuses": [],
               "fact": "facebook_page", "fact_values": ["yes", "no", "unsure"]},
              {"id": "q_fb_url", "label": "Paste the link to your Facebook page", "type": "link", "required": false,
               "options": [], "website_statuses": [], "show_if": {"q": "q_fb_page", "any": ["Yes"]}, "dest": "custom_value:facebook_url"},
              {"id": "q_crm", "label": "Do you have a CRM you want your leads sent to?", "type": "choice", "required": true,
               "options": ["No, use the default setup", "Yes, I already have a CRM I want to keep"], "website_statuses": [],
               "fact": "crm_choice", "fact_values": ["no", "yes"]},
              {"id": "q_crm_name", "label": "Which CRM?", "type": "choice", "required": true,
               "options": ["HubSpot", "Jobber", "JobNimbus", "Housecall Pro", "ServiceTitan", "Salesforce", "Other"], "website_statuses": [],
               "show_if": {"q": "q_crm", "any": ["Yes, I already have a CRM I want to keep"]}, "fact": "crm_name"},
              {"id": "q_crm_method", "label": "How does it take in new leads?", "type": "choice", "required": true,
               "options": ["An email address", "A webhook link", "Not sure"], "website_statuses": [],
               "show_if": {"q": "q_crm", "any": ["Yes, I already have a CRM I want to keep"]}, "fact": "crm_method", "fact_values": ["email", "webhook", "unsure"]}
            ]'::jsonb);
    end if;
end $$;

-- No new videos. The create-a-page and partner-access videos already exist as live steps, there is no
-- how-to-check video (the create video opens with a short "check first" part, and go-live tags it for
-- "no" and "not sure"), and there is no CRM video (a client with their own CRM is rare, and the task
-- below covers it by hand).

-- Our side: tasks raised from the answers. They appear for a client once the step is on and the answer is given.
insert into onboarding_steps (title, description, step_type, owner, active, sort_order, due_days, fact_conditions, service_keys)
select 'Help client create their Facebook page',
       'They said they do not have a page. Walk them through creating one, or create it with them on a call.',
       'action', 'agency', false, 90, 2, '{"facebook_page": ["no"]}'::jsonb, '{ads}'
where not exists (select 1 from onboarding_steps where title = 'Help client create their Facebook page');

insert into onboarding_steps (title, description, step_type, owner, active, sort_order, due_days, fact_conditions, service_keys, auto_check)
select 'Confirm partner access to their Facebook page',
       'They have a page. Check Midas Media was added as a partner and the ad account is saved. Ticks itself once ad data flows.',
       'action', 'agency', false, 91, 3, '{"facebook_page": ["yes"]}'::jsonb, '{ads}', 'ads_data_flowing'
where not exists (select 1 from onboarding_steps where title = 'Confirm partner access to their Facebook page');

insert into onboarding_steps (title, description, step_type, owner, active, sort_order, due_days, fact_conditions, service_keys)
select 'Follow up: do they have a Facebook page?',
       'They were not sure. Check their business on Facebook, or ask them, and set their answer on the client.',
       'action', 'agency', false, 92, 2, '{"facebook_page": ["unsure"]}'::jsonb, '{ads}'
where not exists (select 1 from onboarding_steps where title = 'Follow up: do they have a Facebook page?');

insert into onboarding_steps (title, description, step_type, owner, active, sort_order, due_days, fact_conditions)
select 'Build the lead send to their CRM',
       'They want leads sent to their CRM. Their CRM and how it takes leads are in the answers. Nothing is promised until we have looked at it.',
       'action', 'agency', false, 93, 5, '{"crm_choice": ["yes"]}'::jsonb
where not exists (select 1 from onboarding_steps where title = 'Build the lead send to their CRM');

commit;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- GO LIVE (not run by this file). Do these together, once the videos are recorded:
--   1. Switch the Quick start step and the new videos and tasks on with the eye button in Templates >
--      Client Onboarding. Switching Quick start on shows it to every client currently in onboarding.
--   2. Point the two videos that already exist at the answers, so "almost everyone has a page" stops
--      showing the create-a-page video:
--        update onboarding_steps set fact_conditions = '{"facebook_page": ["yes"]}' where title = 'Give us access to your Facebook';
--        update onboarding_steps set fact_conditions = '{"facebook_page": ["no"]}'  where title = 'Create your Facebook Page';
--      Unanswered clients count as "yes", so anyone who has not been asked sees the access video only.
--
-- Checking on it:
--   select name, facebook_page, crm_choice, crm_name, crm_method from clients where facebook_page is not null or crm_choice is not null;
--   select onboarding_client_facts('Acme Decks');
--   select title, active, fact_conditions from onboarding_steps where fact_conditions <> '{}' order by sort_order;
