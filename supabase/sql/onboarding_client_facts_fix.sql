-- Fix (2026-10-16): onboarding_client_facts() failed with "more than one row returned by a subquery used as an
-- expression" for any client name stored twice. Two archived placeholder clients from August are ("Custom Professional
-- Renovations" and "SUNDARA Medical", two rows each), and the dashboard asks for every client at once, so
-- onboarding_steps_for_clients() failed for EVERYONE on every admin load (seen in the logs all of 2026-10-16, likely since
-- onboarding_facts.sql ran). app.js then fell back to "every step applies to every client", which is why a finished
-- client's tasks were never raised.
--
-- The lookup now takes one row (the newest), so a duplicated name can never take the whole list down again.
-- Safe to re-run. onboarding_facts.sql holds the same definition for a fresh setup.

create or replace function public.onboarding_client_facts(p_client text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select onboarding_fact_defaults() || coalesce(
        (select jsonb_strip_nulls(jsonb_build_object('facebook_page', c.facebook_page, 'crm_choice', c.crm_choice))
         from clients c where c.name = p_client
         order by c.created_at desc nulls last
         limit 1), '{}'::jsonb);
$$;

-- Check (should return rows, not an error):
--   select count(*) from onboarding_steps_for_clients((select array_agg(name) from clients));
