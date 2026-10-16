-- Example-site links for the style picker in "Your new website" (2026-10-16). Each look's card shows a
-- "See the example site" link that opens in a new tab. Add a line to the values list as each site is built.
-- Only the looks named here change; the others are left as they are. Links must be https (the picker refuses others).
-- The same links can be edited in Templates > Client Onboarding > Your new website > the style question. Safe to re-run.

update public.onboarding_steps s
   set questions = (
        select jsonb_agg(
                 case when q->>'type' = 'style' then jsonb_set(q, '{styles}', (
                        select jsonb_agg(
                                 case when l.link is not null then jsonb_set(look, '{link}', to_jsonb(l.link)) else look end
                                 order by ord)
                          from jsonb_array_elements(q->'styles') with ordinality as st(look, ord)
                          left join (values
                              ('Bold and local',      'https://claude.ai/artifact/3QmahedVMqA4pd7tBxmEPB'),
                              ('Sharp and modern',    'https://claude.ai/artifact/4XofsfBmYf1pWWss64KzGJ'),
                              ('Warm and friendly',   'https://claude.ai/artifact/LQkogU3C1CnLtQa3jpmUsJ'),
                              ('Refined and premium', 'https://claude.ai/artifact/EFjnTxRLcVggXMG13LZTrm')
                          ) as l(name, link) on l.name = look->>'name'))
                      else q end
                 order by qord)
          from jsonb_array_elements(s.questions) with ordinality as x(q, qord))
 where s.title = 'Your new website' and s.step_type = 'questions';

-- Check:
--   select look->>'name', look->>'link' from onboarding_steps s, jsonb_array_elements(s.questions) q, jsonb_array_elements(q->'styles') look
--    where s.title = 'Your new website' and q->>'type' = 'style';
