-- Keep two non-contractor answers in Golden Eye instead of sending them to GHL (2026-11-02).
--
-- contractor_fact.sql first pointed "Do your customers come to you, or do you go to them?" (c_visit) at the GHL custom
-- value service_mode, and "How do people usually start with you?" (n_book) at booking_method. Master doesn't have those
-- values, so the GHL account fill would only have reported them missing. They are now destination admin:<field>, which
-- ghl-account ignores (it sends only ghl: and custom_value: destinations). The answers stay in Golden Eye and show on the
-- client's Roster profile under "onboarding answers", like every other answer that isn't private.
--
-- Run it once after contractor_fact.sql (a fresh run of the updated contractor_fact.sql already does this, and this file
-- then changes nothing). Re-runnable. No app.js or function deploy.

begin;

update onboarding_steps st
   set questions = (
       select jsonb_agg(
                  case when e.q ->> 'id' = 'c_visit' then jsonb_set(e.q, '{dest}', '"admin:service_mode"')
                       when e.q ->> 'id' = 'n_book'  then jsonb_set(e.q, '{dest}', '"admin:booking_method"')
                       else e.q end
                  order by e.o)
         from jsonb_array_elements(st.questions) with ordinality as e (q, o))
 where jsonb_typeof(st.questions) = 'array'
   and exists (select 1 from jsonb_array_elements(st.questions) c
                where (c ->> 'id' = 'c_visit' and c ->> 'dest' is distinct from 'admin:service_mode')
                   or (c ->> 'id' = 'n_book'  and c ->> 'dest' is distinct from 'admin:booking_method'));

notify pgrst, 'reload schema';

commit;

-- Check it (every row should say admin:):
-- select st.title, q ->> 'id' id, q ->> 'dest' dest from onboarding_steps st, jsonb_array_elements(st.questions) q
--  where q ->> 'id' in ('c_visit', 'n_book') order by 1;
