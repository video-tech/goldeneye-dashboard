-- Contractor or not (2026-11-02).
--
-- Onboarding was written for home-service contractors: people who go to the customer, quote jobs and close them.
-- Clients who aren't (a tattoo shop, a recruiter, a clinic, a real-estate team) were asked how far they travel for a
-- job, their average job value, 3D renderings and financing. This adds one more client fact, clients.contractor, so
-- those clients get questions that fit them. Two groups only: contractor (the default, what everyone had) and not.
--
-- HOW IT PLUGS IN. `contractor` is a client fact like base_package (seo_only_package.sql), so THE RULE stays
-- onboarding_condition_matches(): a step tagged {"contractor": ["yes"]} or ["no"] shows to one group, and unanswered
-- counts as "yes". The portal, our task list, the handoff trigger and the Templates preview all read the same
-- functions, so they can't disagree. Questions inside a step can carry the same tag (q.fact_conditions, read by
-- obQuestionsFor in app.js), so one step can serve both groups.
--
-- WHO SETS IT: an admin, in Add Client / Edit Client (Contractor). A client can't: set_client_onboarding_facts()
-- only writes the keys it knows (facebook_page, crm_choice...), and the clients policies only let admins write.
--
-- WHAT CHANGES FOR A NON-CONTRACTOR
--   * Service area: "Do customers come to you, or do you go to them?" replaces the travel radius question, and the radius
--     and excluded areas only appear for "we go to them" / "both".
--   * "Your jobs and offers" (job value, estimates, financing, 3D design, price calculator, AI renderings) is replaced by
--     "Your customers and offers".
--   * Your new website: a neutral feature list, page list and content question.
--   * Quick start's CRM list also offers Mindbody, Vagaro, Square and Calendly (everyone sees it; harmless).
--   Contractors see exactly what they saw before.
--
-- ORDER (matters):
--   1. The app.js that knows the "Contractor" tag and per-question tags must be served first. The Templates editor
--      saves only the tags it has chips for, and rebuilds each question from its fields, so a Templates save with the
--      old app.js would strip the tags this file adds.
--   2. Run this file.
-- Re-runnable. The one client list (section 5) only sets clients whose value is still null, and the column is on
-- clients, so rename_client.sql needs no new line.

begin;

-- ---------------------------------------------------------------------------
-- 1. The fact, on the client
-- ---------------------------------------------------------------------------
alter table clients add column if not exists contractor text;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'clients_contractor_check') then
        alter table clients add constraint clients_contractor_check
            check (contractor is null or contractor in ('yes', 'no'));
    end if;
end $$;

comment on column clients.contractor is
    'yes/null = a contractor (goes to the customer, quotes and closes jobs). no = any other business (contractor_fact.sql).';

-- Unanswered = contractor, so every existing client keeps every step. This carries all four facts: the last file to
-- redefine it wins, so it must restate base_package too.
create or replace function onboarding_fact_defaults()
returns jsonb language sql immutable as $$
    select '{"facebook_page": "yes", "crm_choice": "no", "base_package": "yes", "contractor": "yes"}'::jsonb;
$$;

create or replace function onboarding_client_facts(p_client text)
returns jsonb
language sql stable
security definer
set search_path = public
as $$
    select onboarding_fact_defaults() || coalesce(
        (select jsonb_strip_nulls(jsonb_build_object('facebook_page', c.facebook_page, 'crm_choice', c.crm_choice,
                                                     'base_package', c.base_package, 'contractor', c.contractor))
         from clients c where c.name = p_client
         -- a name stored twice must not break every client's list (onboarding_client_facts_fix.sql)
         order by c.created_at desc nulls last
         limit 1), '{}'::jsonb);
$$;

-- ---------------------------------------------------------------------------
-- 2. A step for each group: "Your jobs and offers" stays for contractors, "Your customers and offers" is new
-- ---------------------------------------------------------------------------
update onboarding_steps
   set fact_conditions = coalesce(fact_conditions, '{}'::jsonb) || '{"contractor": ["yes"]}'::jsonb
 where title = 'Your jobs and offers' and step_type = 'questions';

insert into onboarding_steps (title, description, step_type, owner, sort_order, active, service_keys, website_statuses,
                              fact_conditions, questions)
select 'Your customers and offers',
       'What you want more of, so your ads and follow-up say the right things.',
       'questions', 'client', coalesce((select sort_order from onboarding_steps
                                         where title = 'Your jobs and offers' and step_type = 'questions' limit 1), 6),
       true, '{ads}', '{}', '{"contractor": ["no"]}'::jsonb,
       $q$[
         {"id": "n_value", "label": "What is a new customer worth to you? (the average first sale, or the average over a year)",
          "type": "long", "required": false, "options": [], "website_statuses": [], "private": true, "dest": "admin:customer_value"},
         {"id": "n_close", "label": "Roughly what share of the people who contact you become customers?",
          "type": "short", "required": false, "options": [], "website_statuses": [], "private": true, "dest": "admin:close_rate"},
         {"id": "n_book", "label": "How do people usually start with you?",
          "type": "choice", "required": false, "options": ["They call", "They book online", "They walk in", "They fill out a form or apply", "A mix"],
          "website_statuses": [], "dest": "custom_value:booking_method"},
         {"id": "n_promo", "label": "Any current promotion or offer for new leads? (optional)",
          "type": "long", "required": false, "options": [], "website_statuses": [], "dest": "custom_value:current_offer"},
         {"id": "n_ad_cities", "label": "Which cities should we name in your ads? (leave blank if you serve everywhere)",
          "type": "short", "required": false, "options": [], "website_statuses": [], "dest": "ad_brief:cities"}
       ]$q$::jsonb
 where not exists (select 1 from onboarding_steps where title = 'Your customers and offers' and step_type = 'questions');

-- ---------------------------------------------------------------------------
-- 3. Questions inside a step: tag the contractor ones, add the others after them
-- ---------------------------------------------------------------------------
-- A throwaway helper: tag the questions in p_tag_ids as contractor-only, then put p_new after the question p_after_id
-- (or at the end when it isn't there). Skips a step that already has the first new question, so it is re-runnable.
create or replace function pg_temp.ct_split_step(p_title text, p_tag_ids text[], p_after_id text, p_new jsonb)
returns void language plpgsql as $$
declare
    r record;
    q jsonb;
    out_q jsonb;
    placed boolean;
begin
    for r in select id, questions from onboarding_steps where title = p_title and step_type = 'questions' loop
        if jsonb_typeof(r.questions) <> 'array' then continue; end if;
        if exists (select 1 from jsonb_array_elements(r.questions) e where e ->> 'id' = p_new -> 0 ->> 'id') then continue; end if;
        out_q := '[]'::jsonb;
        placed := false;
        for q in select value from jsonb_array_elements(r.questions) loop
            if q ->> 'id' = any (p_tag_ids) then
                q := q || jsonb_build_object('fact_conditions', '{"contractor": ["yes"]}'::jsonb);
            end if;
            out_q := out_q || jsonb_build_array(q);
            if q ->> 'id' = p_after_id then
                out_q := out_q || p_new;
                placed := true;
            end if;
        end loop;
        if not placed then out_q := out_q || p_new; end if;
        update onboarding_steps set questions = out_q where id = r.id;
    end loop;
end $$;

-- Service area. Both versions of the step (Base and No Base) share these ids.
select pg_temp.ct_split_step('Texting and your service area', array['c_radius', 'c_exclude'], 'c_area', $q$[
  {"id": "c_visit", "label": "Do your customers come to you, or do you go to them?", "type": "choice", "required": false,
   "options": ["They come to us", "We go to them", "Both", "Online or nationwide"], "website_statuses": [],
   "fact_conditions": {"contractor": ["no"]}, "dest": "custom_value:service_mode"},
  {"id": "c_radius_nc", "label": "How far will you travel to a customer?", "type": "short", "required": false, "options": [],
   "website_statuses": [], "fact_conditions": {"contractor": ["no"]},
   "show_if": {"q": "c_visit", "any": ["We go to them", "Both"]}, "dest": "custom_value:service_radius"},
  {"id": "c_exclude_nc", "label": "Areas you will not serve (optional)", "type": "long", "required": false, "options": [],
   "website_statuses": [], "fact_conditions": {"contractor": ["no"]},
   "show_if": {"q": "c_visit", "any": ["We go to them", "Both"]}, "dest": "custom_value:excluded_areas"}
]$q$::jsonb);

select pg_temp.ct_split_step('Your service area', array['c_radius', 'c_exclude'], 'c_area', $q$[
  {"id": "c_visit", "label": "Do your customers come to you, or do you go to them?", "type": "choice", "required": false,
   "options": ["They come to us", "We go to them", "Both", "Online or nationwide"], "website_statuses": [],
   "fact_conditions": {"contractor": ["no"]}, "dest": "custom_value:service_mode"},
  {"id": "c_radius_nc", "label": "How far will you travel to a customer?", "type": "short", "required": false, "options": [],
   "website_statuses": [], "fact_conditions": {"contractor": ["no"]},
   "show_if": {"q": "c_visit", "any": ["We go to them", "Both"]}, "dest": "custom_value:service_radius"},
  {"id": "c_exclude_nc", "label": "Areas you will not serve (optional)", "type": "long", "required": false, "options": [],
   "website_statuses": [], "fact_conditions": {"contractor": ["no"]},
   "show_if": {"q": "c_visit", "any": ["We go to them", "Both"]}, "dest": "custom_value:excluded_areas"}
]$q$::jsonb);

-- The new website. The style picker's looks come from contractor sites and are left as they are (see the note at the end).
select pg_temp.ct_split_step('Your new website', array['w_features', 'w_pages', 'w_content'], 'w_content', $q$[
  {"id": "w_features_nc", "label": "Which features do you want?", "type": "multi", "required": false,
   "options": ["Online booking", "Review wall", "Photo gallery", "Pricing or menu", "Live chat", "Online store"],
   "website_statuses": [], "fact_conditions": {"contractor": ["no"]}, "dest": "design:features"},
  {"id": "w_pages_nc", "label": "Which pages do you need?", "type": "multi", "required": false,
   "options": ["Home", "Services", "Gallery", "About", "Reviews", "Locations", "Blog", "Contact"],
   "website_statuses": [], "fact_conditions": {"contractor": ["no"]}, "dest": "design:pages"},
  {"id": "w_content_nc", "label": "Do you have photos of your business and written content ready?", "type": "choice", "required": false,
   "options": ["Both", "Photos only", "Text only", "Neither yet"], "website_statuses": [],
   "fact_conditions": {"contractor": ["no"]}, "dest": "design:content_ready"}
]$q$::jsonb);

-- Quick start: more CRMs, before "Other". Same list for everyone.
update onboarding_steps st
   set questions = (
       select jsonb_agg(
                  case when e.q ->> 'id' = 'q_crm_name'
                       then jsonb_set(e.q, '{options}',
                            (select jsonb_agg(z.opt order by z.n)
                               from (select t.opt, t.n from jsonb_array_elements_text(e.q -> 'options') with ordinality as t (opt, n)
                                      where t.opt <> 'Other'
                                     union all
                                     select u.opt, 1000 + u.n from unnest(array['Mindbody', 'Vagaro', 'Square', 'Calendly']) with ordinality as u (opt, n)
                                     union all
                                     select 'Other', 2000) z))
                       else e.q end
                  order by e.o)
         from jsonb_array_elements(st.questions) with ordinality as e (q, o))
 where st.title = 'Quick start: your Facebook page and CRM' and st.step_type = 'questions'
   and jsonb_typeof(st.questions) = 'array'
   and exists (select 1 from jsonb_array_elements(st.questions) c
                where c ->> 'id' = 'q_crm_name' and not ((c -> 'options') ? 'Mindbody'));

-- ---------------------------------------------------------------------------
-- 4. Checks: stop with a clear message if a step or id has moved
-- ---------------------------------------------------------------------------
do $$
begin
    if not exists (select 1 from onboarding_steps where title = 'Your customers and offers' and step_type = 'questions') then
        raise exception 'Your customers and offers was not created.';
    end if;
    if exists (select 1 from onboarding_steps where title = 'Texting and your service area')
       and not exists (select 1 from onboarding_steps st, jsonb_array_elements(st.questions) q
                        where st.title = 'Texting and your service area' and q ->> 'id' = 'c_visit') then
        raise exception 'Texting and your service area did not get its non-contractor questions: has c_area changed?';
    end if;
    if exists (select 1 from onboarding_steps where title = 'Your new website')
       and not exists (select 1 from onboarding_steps st, jsonb_array_elements(st.questions) q
                        where st.title = 'Your new website' and q ->> 'id' = 'w_pages_nc') then
        raise exception 'Your new website did not get its non-contractor questions.';
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Clients who aren't contractors today (2026-11-02; only while still unset, so re-running changes nothing)
-- ---------------------------------------------------------------------------
update clients set contractor = 'no'
 where contractor is null
   and name in ('Anxiety Solutions', 'Astra Real Estate', 'FreeBird Recruiting', 'PureAirK9', 'Tattoo Ink Utah');

notify pgrst, 'reload schema';

commit;

-- Check it (a non-contractor preview loses the contractor step and gains its own):
-- select source, title from onboarding_preview('{ads}', 'new_build', '{"contractor": "no"}') order by 1 desc, title;
-- select source, title from onboarding_preview('{ads}', 'new_build', '{"contractor": "yes"}') order by 1 desc, title;
--
-- NOT DONE HERE: the website style picker ("Pick the look closest...") shows four looks drawn from contractor sites. A
-- non-contractor sees the same looks until someone adds their own in Templates. The GHL Master snapshot's pipeline
-- (Estimate scheduled / Estimate sent) and cost-quiz fields are adjusted by hand in "Turn on automations and add their team".
