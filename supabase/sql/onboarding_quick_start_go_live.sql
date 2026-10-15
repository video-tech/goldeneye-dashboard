-- Switch on the Quick start questions (2026-10-14). Run AFTER onboarding_facts.sql AND after the app.js that
-- understands dependent questions has been pushed and is being served.
--
-- WHY THE ORDER MATTERS. The Quick start step is a Questions step whose later questions ("Which CRM?") only
-- appear after an earlier answer. The old app.js does not know that rule: it shows every question and requires
-- the ones marked required, so a client who answers "no CRM" would be stopped by a "Which CRM?" they cannot
-- answer. Check that the dashboard has the new code before running this (Settings > Updates should list
-- "Onboarding questions that pick the right video").
--
-- WHAT IT DOES
--   1. Switches on the Quick start step (second, right after the welcome video) and our four tasks that react
--      to the answers.
--   2. Points the two existing Facebook videos at the answers: "Give us access to your Facebook" for a client
--      with a page, "Create your Facebook Page" for one who needs a page or is not sure (that video opens with
--      a short "check first" part). A client who has not answered counts as having a page, so anyone
--      mid-onboarding who skips Quick start sees only the access video. "Not sure" also raises our follow-up
--      task, so someone checks.
--   3. Removes the two video placeholders that were dropped, if they are still hidden with no link: the
--      how-to-check video (folded into the create video) and the CRM video (a client with their own CRM is
--      rare, and the task for us covers it).
--
-- WHAT IT DOES NOT TOUCH: progress. Anyone who already watched "Create your Facebook Page" keeps that record;
-- the step just stops being asked of clients who have a page. Safe to re-run.
--
-- Undo (back to everyone seeing everything):
--   update onboarding_steps set active = false where title like 'Quick start:%';
--   update onboarding_steps set fact_conditions = '{}' where title in ('Give us access to your Facebook', 'Create your Facebook Page');

begin;

update onboarding_steps set active = true
where title in (
    'Quick start: your Facebook page and CRM',
    'Help client create their Facebook page',
    'Confirm partner access to their Facebook page',
    'Follow up: do they have a Facebook page?',
    'Build the lead send to their CRM');

update onboarding_steps set fact_conditions = '{"facebook_page": ["yes"]}'::jsonb where title = 'Give us access to your Facebook';
update onboarding_steps set fact_conditions = '{"facebook_page": ["no", "unsure"]}'::jsonb where title = 'Create your Facebook Page';

delete from onboarding_steps
where title in ('How to check if you have a Facebook page', 'Where your leads will also go: your CRM')
  and coalesce(embed_url, '') = '' and not coalesce(active, false);

commit;

-- What clients will see now (a client with no answers yet, ads only):
--   select title, active, fact_conditions from onboarding_steps where fact_conditions <> '{}' or title like 'Quick start:%' order by sort_order;
