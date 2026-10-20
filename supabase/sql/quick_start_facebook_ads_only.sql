-- Quick start: ask about a Facebook page only when the client has Ads (2026-10-20).
--
-- "Quick start: your Facebook page and CRM" is a Base step, so a Base + SEO client without Ads was asked whether they
-- have a Facebook page, which only the Ads steps use. Its two Facebook questions (q_fb_page, q_fb_url) get
-- service_keys ["ads"], a per-question condition app.js reads in obQuestionsFor(): a question tagged with services is
-- asked only when the client has one of them (onboarding or active). The CRM questions stay for everyone on Base.
--
-- Unanswered still counts as "has a page" (onboarding_fact_defaults), which only matters to Ads-tagged steps, so a client
-- without Ads loses nothing by not being asked.
--
-- ORDER: the app.js that knows per-question services must be served first. The Templates question editor rebuilds each
-- question from its fields, so a Templates save on the old app.js would drop this tag (harmless: the question would just
-- be asked again). Re-runnable.

begin;

update onboarding_steps st
   set questions = (
       select jsonb_agg(
                  case when q ->> 'id' in ('q_fb_page', 'q_fb_url')
                       then q || '{"service_keys": ["ads"]}'::jsonb
                       else q end
                  order by o)
         from jsonb_array_elements(st.questions) with ordinality as x (q, o))
 where st.title = 'Quick start: your Facebook page and CRM'
   and st.step_type = 'questions'
   and jsonb_typeof(st.questions) = 'array';

do $$
begin
    if (select count(*) from onboarding_steps st, jsonb_array_elements(st.questions) q
         where st.title = 'Quick start: your Facebook page and CRM' and q ->> 'id' in ('q_fb_page', 'q_fb_url')
           and q -> 'service_keys' = '["ads"]'::jsonb) <> 2 then
        raise exception 'Expected to tag 2 Facebook questions on Quick start: has the step or its question ids changed?';
    end if;
end $$;

commit;

-- Check it:
-- select q ->> 'id', q -> 'service_keys' from onboarding_steps st, jsonb_array_elements(st.questions) q
--  where st.title = 'Quick start: your Facebook page and CRM';
