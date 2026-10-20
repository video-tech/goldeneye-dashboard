-- SEO only: a package with no Base (2026-10-20).
--
-- Two packages from now on:
--   Base + add-ons  (clients.base_package null or 'yes', the default): exactly what every client gets today. Nothing changes.
--   SEO only        (clients.base_package = 'no'): no GHL account, no texting, no free website, no automations.
--                   They still do the welcome video, the setup call, About your business, the sales team and the SEO steps,
--                   plus a short "Your service area" step (the service-area questions without the texting ones).
--
-- HOW IT PLUGS IN. base_package is one more client fact (onboarding_facts.sql), so THE RULE stays
-- onboarding_condition_matches(): every step and setup step that is GHL, texting or the free site gets the tag
-- {"base_package": ["yes"]}, and unanswered counts as "yes". The portal, our task list, service_onboarding_status, the
-- handoff trigger and the Templates preview all read onboarding_steps_for_client / stage_templates_for_client, so they
-- drop those steps for an SEO-only client together. ghl-account also refuses SEO-only clients (deploy it with this).
--
-- WHO SETS IT: an admin, in Add Client / Edit Client (Package). A client can't: set_client_onboarding_facts() ignores
-- this key, and the clients policies only let admins write (clients_rls.sql).
--
-- ORDER (matters):
--   1. The app.js that knows the "Package" tag must be served first. The Templates editor saves only the tags it has
--      chips for, so a Templates save with the old app.js would strip base_package from every step below.
--   2. Run this file.
--   3. Deploy ghl-account (it skips SEO-only clients; until deployed, nobody should be set to SEO only).
-- Re-runnable. Nothing here is keyed on a client name, so rename_client.sql needs no new line.

begin;

-- ---------------------------------------------------------------------------
-- The fact, on the client
-- ---------------------------------------------------------------------------
alter table clients add column if not exists base_package text;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'clients_base_package_check') then
        alter table clients add constraint clients_base_package_check
            check (base_package is null or base_package in ('yes', 'no'));
    end if;
end $$;

comment on column clients.base_package is
    'yes/null = Base + add-ons (the default). no = SEO only: no GHL account, texting or free website (seo_only_package.sql).';

-- Unanswered = Base, so every existing client keeps every step
create or replace function onboarding_fact_defaults()
returns jsonb language sql immutable as $$
    select '{"facebook_page": "yes", "crm_choice": "no", "base_package": "yes"}'::jsonb;
$$;

create or replace function onboarding_client_facts(p_client text)
returns jsonb
language sql stable
security definer
set search_path = public
as $$
    select onboarding_fact_defaults() || coalesce(
        (select jsonb_strip_nulls(jsonb_build_object('facebook_page', c.facebook_page, 'crm_choice', c.crm_choice,
                                                     'base_package', c.base_package))
         from clients c where c.name = p_client
         -- a name stored twice must not break every client's list (onboarding_client_facts_fix.sql)
         order by c.created_at desc nulls last
         limit 1), '{}'::jsonb);
$$;

-- ---------------------------------------------------------------------------
-- Tag the Base-only steps
-- ---------------------------------------------------------------------------
-- Client steps and our onboarding tasks (onboarding_steps). Merged with ||, so an existing tag such as
-- "Build the lead send to their CRM" {"crm_choice": ["yes"]} is kept.
update onboarding_steps
   set fact_conditions = coalesce(fact_conditions, '{}'::jsonb) || '{"base_package": ["yes"]}'::jsonb
 where title in (
        -- the client's
        'Quick start: your Facebook page and CRM',   -- the CRM answer only matters for the GHL lead send
        'Registering your texting number',
        'Texting and your service area',              -- SEO only gets "Your service area" below instead
        'Your new website',                           -- the free site is Base
        -- ours
        'Connect their GHL to Golden Eye',
        'Register their texting number',
        'Build their website',
        'Turn on automations and add their team',
        'Final check and test',
        'Build the lead send to their CRM'
       );

-- Our setup steps (stage_templates). They're raised separately from their group's task, so they need the tag too, or
-- an SEO-only client would get orphan GHL steps that hold up the move out of Onboarding.
update stage_templates
   set fact_conditions = coalesce(fact_conditions, '{}'::jsonb) || '{"base_package": ["yes"]}'::jsonb
 where task_type = 'Setup step'
   and stage = 'Onboarding'
   and checklist_group in ('Connect their GHL to Golden Eye', 'Register their texting number', 'Build their website',
                           'Turn on automations and add their team', 'Final check and test');

-- Website leads reach Golden Eye only through a webhook in the client's own GHL (ghl-lead-webhook), so an SEO-only
-- client has no lead tracking, and this step could never tick.
update stage_templates
   set fact_conditions = coalesce(fact_conditions, '{}'::jsonb) || '{"base_package": ["yes"]}'::jsonb
 where task_type = 'Setup step'
   and checklist_group = 'Set up SEO tracking'
   and task_title like 'Leads — %';

-- ---------------------------------------------------------------------------
-- "Your service area", for SEO only: the service-area questions from "Texting and your service area", without the
-- texting ones. Copied from the live step so the wording and ids match; a Base client never sees this step.
-- ---------------------------------------------------------------------------
insert into onboarding_steps (title, description, step_type, owner, sort_order, active, service_keys, website_statuses,
                              fact_conditions, questions)
select 'Your service area',
       'Where you work, so we target the right towns.',
       'questions', 'client', s.sort_order, true, '{}', '{}',
       '{"base_package": ["no"]}'::jsonb,
       (select jsonb_agg(q order by o)
          from jsonb_array_elements(s.questions) with ordinality as x (q, o)
         where q ->> 'id' in ('c_area', 'c_radius', 'c_exclude'))
  from onboarding_steps s
 where s.title = 'Texting and your service area' and s.step_type = 'questions'
   and not exists (select 1 from onboarding_steps where title = 'Your service area' and step_type = 'questions')
 limit 1;

do $$
begin
    if not exists (select 1 from onboarding_steps where title = 'Your service area' and step_type = 'questions'
                   and jsonb_array_length(coalesce(questions, '[]'::jsonb)) = 3) then
        raise exception 'Your service area was not created with its 3 questions: is "Texting and your service area" still there with c_area, c_radius and c_exclude?';
    end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- Check it (an SEO-only preview should have no GHL, texting or website steps; Base + SEO should match today):
-- select source, title from onboarding_preview('{seo}', 'existing', '{"base_package": "no"}') order by 1 desc, title;
-- select source, title from onboarding_preview('{seo}', 'existing', '{"base_package": "yes"}') order by 1 desc, title;
