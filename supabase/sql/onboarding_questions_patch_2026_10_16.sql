-- Question changes from the first test run (2026-10-16), for a database where onboarding_facts.sql and
-- onboarding_questionnaire.sql have already run. Both files now hold the same wording for a fresh setup.
--   1. Quick start's CRM question: "No (the text alerts are enough)" / "Yes" become
--      "No, use the default setup" / "Yes, I already have a CRM I want to keep". The saved facts stay no / yes, and
--      the two follow-up questions now show for the new Yes wording.
--   2. "Who answers your calls, and when should a call go to voicemail?" (c_calls) is dropped, and its step is renamed
--      from "Calls, texts and your service area" to "Texting and your service area".
-- Answers already saved keep their own label and value. Safe to re-run.

begin;

update public.onboarding_steps s
   set questions = (
        select jsonb_agg(
                 case
                   when q->>'id' = 'q_crm' then jsonb_set(q, '{options}', '["No, use the default setup", "Yes, I already have a CRM I want to keep"]'::jsonb)
                   when q->>'id' in ('q_crm_name', 'q_crm_method') then jsonb_set(q, '{show_if}', '{"q": "q_crm", "any": ["Yes, I already have a CRM I want to keep"]}'::jsonb)
                   else q
                 end order by ord)
          from jsonb_array_elements(s.questions) with ordinality as x(q, ord))
 where s.title = 'Quick start: your Facebook page and CRM' and s.questions is not null;

update public.onboarding_steps s
   set title = 'Texting and your service area',
       description = 'How you want leads handled, and where you work.',
       questions = (
        select coalesce(jsonb_agg(q order by ord), '[]'::jsonb)
          from jsonb_array_elements(s.questions) with ordinality as x(q, ord)
         where q->>'id' <> 'c_calls')
 where s.title in ('Calls, texts and your service area', 'Texting and your service area') and s.step_type = 'questions';

commit;

-- Check:
--   select s.title, q->>'id', q->'options', q->'show_if' from onboarding_steps s, jsonb_array_elements(s.questions) q
--    where s.title in ('Quick start: your Facebook page and CRM', 'Texting and your service area');
