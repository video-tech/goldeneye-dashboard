-- Three questions about the customer's problem (2026-11-12), in "About your business" right after the services question, so
-- every client answers them (Base, Ads, SEO and No Base alike). The answers feed ad copy, the website and SEO articles.
-- Questions are data on the step (onboarding_questions.sql), so this needs no code change. Labels carry their examples in
-- brackets, like the other questions, because a question has no separate hint line. dest "ad_brief:" is recorded only.
-- Clients who already submitted the step aren't asked again unless the step is unticked. Safe to re-run: a question whose id
-- is already on the step is never added twice.

begin;

update public.onboarding_steps s
   set questions = (
       select jsonb_agg(q order by o, sub)
         from (
             select x.q, x.o, 0 as sub from jsonb_array_elements(s.questions) with ordinality x(q, o)
             union all
             select n.q, (select o from jsonb_array_elements(s.questions) with ordinality y(q, o) where y.q->>'id' = 'a_services'), n.sub
               from (values
                 (1, jsonb_build_object('id', 'a_pain_main', 'type', 'long', 'required', true, 'options', '[]'::jsonb, 'website_statuses', '[]'::jsonb,
                     'dest', 'ad_brief:pain_main',
                     'label', 'What problem usually makes someone contact you? (describe it the way a customer would)')),
                 (2, jsonb_build_object('id', 'a_pain_triggers', 'type', 'long', 'required', true, 'options', '[]'::jsonb, 'website_statuses', '[]'::jsonb,
                     'dest', 'ad_brief:pain_triggers',
                     'label', 'What finally pushes people to reach out? List up to 5 specific moments or reasons, in their words (for example: a deadline is coming, it got worse, a friend recommended you, the last company let them down)')),
                 (3, jsonb_build_object('id', 'a_pain_worries', 'type', 'long', 'required', false, 'options', '[]'::jsonb, 'website_statuses', '[]'::jsonb,
                     'dest', 'ad_brief:pain_worries',
                     'label', 'What worries people most about hiring a business like yours? (optional; for example: the price, being let down, how long it takes)'))
               ) n(sub, q)
              where not exists (select 1 from jsonb_array_elements(s.questions) z(q) where z.q->>'id' = n.q->>'id')
         ) all_q
   )
 where s.title = 'About your business' and s.owner = 'client'
   and exists (select 1 from jsonb_array_elements(s.questions) z(q) where z.q->>'id' = 'a_services');

commit;
