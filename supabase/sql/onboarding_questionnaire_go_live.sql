-- GO LIVE for the onboarding questionnaire (supabase/sql/onboarding_questionnaire.sql).
--
-- DO NOT RUN until the user says the onboarding rebuild is done. A client may be mid-onboarding: switching this
-- on changes the steps every client in onboarding sees.
--
-- Order: the new app.js must already be served (private answers, the EIN type and the style picker live there),
-- onboarding_questionnaire.sql must have been run, and the Quick start go-live
-- (onboarding_quick_start_go_live.sql) is a separate decision.
--
-- What it does, in one transaction:
--   1. Switches the six questionnaire steps on, and our SEO task "Delete their stored website password"
--      (added by setup_checklist_v2.sql; does nothing if that hasn't run).
--   2. Switches the three GHL form steps they replace off: "Tell us about your business", "Your service area and
--      hours" and "Offers and preferences". Their progress rows stay; hidden steps keep their history.
--   3. Takes two questions out of the existing SEO questions step, because the questionnaire now asks them once:
--        q_services     "Which services do you want more calls for?"  (now in About your business, for everyone)
--        q_liked_sites  "Any websites you like the look of?"          (now in Your new website)
--      Answers already given to them stay in onboarding_answers. The SEO step's Copy for Cuppa still includes the
--      services answer: app.js adds it from About your business.
-- Re-runnable.

begin;

update public.onboarding_steps set active = true
 where step_type = 'questions'
   and title in ('About your business', 'Registering your texting number', 'Texting and your service area',
                 'Your jobs and offers', 'Access to your website', 'Your new website');

-- Our SEO step to delete a stored website password (setup_checklist_v2.sql), on with the step that stores them
update public.onboarding_steps set active = true
 where owner = 'agency' and title = 'Delete their stored website password';

update public.onboarding_steps set active = false
 where step_type = 'form'
   and title in ('Tell us about your business', 'Your service area and hours', 'Offers and preferences');

update public.onboarding_steps
   set questions = (
        select coalesce(jsonb_agg(q order by ord), '[]'::jsonb)
          from jsonb_array_elements(questions) with ordinality as x(q, ord)
         where q->>'id' not in ('q_services', 'q_liked_sites'))
 where title = 'Tell us about your business for SEO'
   and questions is not null;

commit;

notify pgrst, 'reload schema';

-- Check:
--   select title, step_type, active from onboarding_steps where owner = 'client' order by sort_order;
--   select q->>'id', q->>'label' from onboarding_steps s, jsonb_array_elements(s.questions) q where s.title = 'Tell us about your business for SEO';
