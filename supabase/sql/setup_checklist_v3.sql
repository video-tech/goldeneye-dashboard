-- The setup checklist, version 3 (2026-10-16): smaller tasks. Run after setup_checklist_v2.sql. Safe to re-run.
--
-- A task on the board is a piece of work ("Register their texting number"); its checklist is the steps inside it, opened
-- with the arrow on the task. v2 had two huge tasks (Set up GHL had 37 steps); v3 splits the work into these tasks:
--
--   Onboarding (our tasks, raised when the client finishes their steps):
--     Connect Meta                              Ads      4 steps
--     Connect their GHL to Golden Eye           all      6
--     Register their texting number             all      5   (A2P: website on their GHL, submit, number when approved)
--     Build their website                       new site 5 / existing site 1
--     Build the funnel and survey               Ads      7
--     Turn on automations and add their team    all      6
--     Final check and test                      all      8
--     Set up SEO tracking                       SEO      9
--     Set up Cuppa                              SEO      4
--   Campaign Building:
--     Launch ads                                Ads      6   (ends with checking the first real lead)
--
-- Gone: "Review their answers" (the EIN check moved to A2P, the logo check to the website), "Create their GHL account"
-- (Golden Eye will create it; we connect it and review it), "First week live", and six of the seven separate SEO tasks,
-- which are switched off (not deleted); the seventh, "Set up Cuppa", becomes the Cuppa task. Every auto-tick moved to the
-- matching step. Only templates change here: no client had a
-- step task yet (checked 2026-10-16), and tasks already raised stay as they are.

begin;

-- 1. The task rows (agency rows in onboarding_steps). The two v2 groups are renamed in place.
update public.onboarding_steps set title = 'Connect Meta', service_keys = array['ads'], sort_order = 13, due_days = 3,
       description = 'Facebook access, the ad account IDs, meta-sync and their target CPL. Steps are in the task''s checklist.'
 where owner = 'agency' and title in ('Get ready for GHL', 'Connect Meta');

update public.onboarding_steps set title = 'Connect their GHL to Golden Eye', service_keys = '{}', sort_order = 14, due_days = 4,
       description = 'Install the Golden Eye app on their new GHL account and review what Golden Eye filled in. Steps are in the task''s checklist.'
 where owner = 'agency' and title in ('Set up GHL', 'Connect their GHL to Golden Eye');

-- The old SEO task "Set up Cuppa" has the new group's name, so it becomes the group (its auto-tick moves to a step)
update public.onboarding_steps set active = true, service_keys = array['seo'], auto_check = null, sort_order = 21, due_days = 10,
       description = 'Auto-logging, their brand voice, connecting their site and the first article. Steps are in the task''s checklist.'
 where owner = 'agency' and title = 'Set up Cuppa';

insert into public.onboarding_steps (title, description, owner, step_type, active, service_keys, website_statuses, sort_order, due_days)
select v.title, v.description, 'agency', 'action', true, v.service_keys, v.website_statuses, v.sort_order, v.due_days
from (values
    ('Register their texting number', 'A2P: make their website on their GHL, submit the brand and campaign, and attach the number when approved. Steps are in the task''s checklist.', '{}'::text[], '{}'::text[], 15, 10),
    ('Build their website', 'Build it from their style picks, or connect their existing site''s form to GHL. Steps are in the task''s checklist.', '{}', '{new_build,existing}', 16, 8),
    ('Build the funnel and survey', 'Build them, connect them to the Conversions API and follow-up workflows, test on a phone. Steps are in the task''s checklist.', '{ads}', '{}', 17, 7),
    ('Turn on automations and add their team', 'Turn on the lead, Conversions API and follow-up workflows, set the pipeline, add their people. Steps are in the task''s checklist.', '{}', '{}', 18, 7),
    ('Final check and test', 'Review every workflow and funnel, publish, then test leads, bookings, missed calls and reviews. Steps are in the task''s checklist.', '{}', '{}', 19, 8),
    ('Set up SEO tracking', 'Search Console, the keyword plan, SE Ranking and lead tracking. Steps are in the task''s checklist.', '{seo}', '{}', 20, 8),
    ('Set up Cuppa', 'Auto-logging, their brand voice, connecting their site and the first article. Steps are in the task''s checklist.', '{seo}', '{}', 21, 10)
) as v(title, description, service_keys, website_statuses, sort_order, due_days)
where not exists (select 1 from public.onboarding_steps s where s.owner = 'agency' and s.title = v.title);

-- The other six separate SEO tasks become steps below
update public.onboarding_steps set active = false
 where owner = 'agency'
   and title in ('Connect Search Console', 'Create the SE Ranking project', 'Save SEO start date and fee', 'Set up article auto-logging',
                 'Set up lead tracking', 'Keyword research and page plan');

-- 2. Replace the step templates
delete from public.stage_templates
 where task_type = 'Setup step'
   and stage in ('Onboarding', 'Campaign Building', 'Campaign Learning')
   and task_title <> 'Draft Copywriting Hooks V1';
delete from public.stage_templates where stage = 'Campaign Learning' and task_type = 'Checklist' and task_title = 'First week live';

insert into public.stage_templates (stage, task_title, due_days, service_keys, website_statuses, auto_check, default_notes, checklist_group, task_type, sort_order)
select v.stage, v.task_title, v.due_days, v.service_keys, v.website_statuses, v.auto_check, v.default_notes, v.checklist_group, 'Setup step', v.sort_order
from (values
    -- Connect Meta
    ('Onboarding', 'Meta — Confirm Midas Media LLC has full admin, the account is healthy and a dataset exists', 1, '{ads}'::text[], '{}'::text[], null::text,
     'Page, Business Manager and card are done; Midas Media LLC has full admin on the ad account; no restrictions; payment works; the Page is connected; a dataset (pixel) exists and is shared with us. If anything is missing, chase the client first.', 'Connect Meta', 1),
    ('Onboarding', 'Meta — Save their ad account ID and business ID in Golden Eye', 2, '{ads}', '{}', 'ad_account_set',
     'Edit Client > Ad account ID (digits only) and Business ID. Saving them starts the daily pull in Make.', 'Connect Meta', 2),
    ('Onboarding', 'Meta — Run meta-sync and confirm their first rows arrive', 3, '{ads}', '{}', 'ads_data_flowing',
     'In Midas Media LLC assign the ad account to Golden Eye Sync (view only), run the connection check and read the result. The daily pull should show rows within a day of saving the IDs.', 'Connect Meta', 3),
    ('Onboarding', 'Golden Eye — Set their target CPL', 3, '{ads}', '{}', null,
     'From their average job value and close rate answers. The morning audit and the per-ad flags use it.', 'Connect Meta', 4),

    -- Connect their GHL to Golden Eye
    ('Onboarding', 'GHL — Install the Golden Eye app on their new GHL account', 2, '{}', '{}', null,
     'Golden Eye creates their GHL account from MasterV.1 once their answers are in. Open the app''s install link, tick the new account, install: GHL does not install the app on new accounts by itself, and without it Golden Eye cannot fill the account. Until the automatic account creation is built, create the account from MasterV.1 by hand first, named exactly as the business.', 'Connect their GHL to Golden Eye', 1),
    ('Onboarding', 'GHL — Save the GHL location ID in Edit Client', 2, '{}', '{}', 'ghl_location_set',
     'Golden Eye saves it when it creates the account. Until then: Edit Client > GHL location ID.', 'Connect their GHL to Golden Eye', 2),
    ('Onboarding', 'Review — Business info, timezone and logo', 3, '{}', '{}', null,
     'Settings > Business Profile: name, address, phone, email, website, timezone, logo.', 'Connect their GHL to Golden Eye', 3),
    ('Onboarding', 'Review — Every custom value is filled from their answers', 3, '{}', '{}', null,
     'Settings > Custom Values. Master''s own keys are used (business_name, physical_address, hours_of_operation and so on). Anything empty: fill it from their answers or ask them.', 'Connect their GHL to Golden Eye', 4),
    ('Onboarding', 'Review — Create the Google review link and booking link', 3, '{}', '{}', null, null, 'Connect their GHL to Golden Eye', 5),
    ('Onboarding', 'Golden Eye — Fill their profile, add check-in people and confirm portal sign-in', 3, '{}', '{}', null,
     'Roster > their profile: business phone, website, address, private notes. Add everyone who gives numbers. Confirm the client can sign in.', 'Connect their GHL to Golden Eye', 6),

    -- Register their texting number
    ('Onboarding', 'A2P — Check the legal name, address and EIN match exactly', 2, '{}', '{}', null,
     'From their "Registering your texting number" answers. They must match what the EIN is registered under, character for character. A mismatch is the most common reason A2P is rejected.', 'Register their texting number', 1),
    ('Onboarding', 'A2P — Make their website and host it on their GHL account', 4, '{}', '{}', null,
     'Sites > Websites in their GHL account, from the snapshot''s site template: home, services, a contact form with the consent wording, privacy and terms pages, all with their exact legal name, address and phone. The carriers check this site. For a client whose site we build, it is the same site: Build their website finishes it.', 'Register their texting number', 2),
    ('Onboarding', 'A2P — Buy a local number', 3, '{}', '{}', null, 'Area code from their business address.', 'Register their texting number', 3),
    ('Onboarding', 'A2P — Submit the brand and the campaign', 5, '{}', '{}', null,
     'Brand: legal name, EIN, address, website and contact. Campaign: use case, sample messages, opt-in description and the link to the form page. Note the date in this task: approval can take days to weeks, and everything else carries on meanwhile.', 'Register their texting number', 4),
    ('Onboarding', 'A2P — When approved, attach the number to the campaign and make it the default', 14, '{}', '{}', null, null, 'Register their texting number', 5),

    -- Build their website
    ('Onboarding', 'Website — Check the logo and photos are usable', 3, '{}', '{new_build}', null,
     'High enough quality for the website. If a link asks for access, ask the client to share it with anyone who has the link.', 'Build their website', 1),
    ('Onboarding', 'Website — Read their style picks and design answers', 4, '{}', '{new_build}', null,
     'Their answers to "Your new website": first and second look, colors, logo, lettering, pages, features, domain.', 'Build their website', 2),
    ('Onboarding', 'Website — Build the site from their first-choice look', 7, '{}', '{new_build}', null,
     'In their GHL account, on top of the website made for A2P.', 'Build their website', 3),
    ('Onboarding', 'Website — Connect the domain and publish', 8, '{}', '{new_build}', null, null, 'Build their website', 4),
    ('Onboarding', 'Website — Test the contact form lands in GHL', 8, '{}', '{new_build}', null,
     'Submit a test, check the contact is created and the follow-up starts, then delete the test contact.', 'Build their website', 5),
    ('Onboarding', 'Website — Connect their site''s contact form to GHL', 6, '{}', '{existing}', null,
     'So their website leads get the same follow-up. Embed our GHL form, or send their form to GHL. Test it, then delete the test contact.', 'Build their website', 6),

    -- Build the funnel and survey
    ('Onboarding', 'Funnel — Build the funnel', 6, '{ads}', '{}', null,
     'Import it from Master and rebrand it: logo, colors, phone, business name, cities, offer and testimonials.', 'Build the funnel and survey', 1),
    ('Onboarding', 'Funnel — Build the survey', 6, '{ads}', '{}', null, 'Import it from Master and match it to their services and offer.', 'Build the funnel and survey', 2),
    ('Onboarding', 'Funnel — Set the Facebook event to Submit Application or None, never Lead', 6, '{ads}', '{}', null,
     'The Conversions API workflow sends Lead, so a form event would count every lead twice.', 'Build the funnel and survey', 3),
    ('Onboarding', 'Funnel — Connect a subdomain of ours and set the thank-you page', 6, '{ads}', '{}', null, 'A client''s own domain is only for SEO.', 'Build the funnel and survey', 4),
    ('Onboarding', 'Funnel — Connect the funnel and survey to their workflows', 6, '{ads}', '{}', null,
     'The Conversions API workflow and the lead follow-up (survey) workflow.', 'Build the funnel and survey', 5),
    ('Onboarding', 'Funnel — Paste their pixel and token into the Conversions API workflow', 7, '{ads}', '{}', null,
     'Done by hand. Pick their Facebook account and dataset; the token is generated in their Events Manager for that dataset. Never paste one token into another client''s account.', 'Build the funnel and survey', 6),
    ('Onboarding', 'Funnel — Test on a phone, publish and copy the final URL for the ad', 7, '{ads}', '{}', null, null, 'Build the funnel and survey', 7),

    -- Turn on automations and add their team
    ('Onboarding', 'Workflows — Turn on the lead to Golden Eye workflow', 5, '{}', '{}', null,
     'On for every client, so their leads reach Golden Eye. Every other workflow stays unpublished until the final check, except the two below for Ads clients.', 'Turn on automations and add their team', 1),
    ('Onboarding', 'Workflows — Turn on the Conversions API and lead follow-up (survey) workflows', 7, '{ads}', '{}', null, null, 'Turn on automations and add their team', 2),
    ('Onboarding', 'Workflows — Adjust the pipeline stages to their flow', 7, '{}', '{}', null, 'Some clients have more than one pipeline.', 'Turn on automations and add their team', 3),
    ('Onboarding', 'People — Add our team with full access', 5, '{}', '{}', null, null, 'Turn on automations and add their team', 4),
    ('Onboarding', 'People — Add the owner and their sales people with a limited role', 6, '{}', '{}', null,
     'No workflow access. The account owner must be right: the workflows assign and notify by owner.', 'Turn on automations and add their team', 5),
    ('Onboarding', 'People — Set new-lead notifications per person and have them install the mobile app', 7, '{}', '{}', null, null, 'Turn on automations and add their team', 6),

    -- Final check and test
    ('Onboarding', 'Final check — Review every workflow, then publish them', 8, '{}', '{}', null,
     'The ones still off: owner, number, calendar, pipeline, templates and the review link in each one. Publish each only after it reads right.', 'Final check and test', 1),
    ('Onboarding', 'Final check — Review the funnels and surveys', 8, '{ads}', '{}', null, 'Wording, branding, every link and the thank-you page.', 'Final check and test', 2),
    ('Onboarding', 'Test — Submit a lead through the form and follow it end to end', 8, '{}', '{}', null,
     'Contact created, text and email sent, client notified, the lead lands in the pipeline and in Golden Eye.', 'Final check and test', 3),
    ('Onboarding', 'Test — Book an appointment and check the reminders fire', 8, '{}', '{}', null, null, 'Final check and test', 4),
    ('Onboarding', 'Test — Miss a call and check the missed-call text arrives', 8, '{}', '{}', null, null, 'Final check and test', 5),
    ('Onboarding', 'Test — Trigger a review request', 8, '{}', '{}', null, null, 'Final check and test', 6),
    ('Onboarding', 'Test — Confirm one test Lead event reaches Meta once', 8, '{ads}', '{}', null, 'Check the dataset''s test events for duplicates.', 'Final check and test', 7),
    ('Onboarding', 'Test — Delete the test contacts and show the client how to log in and reply from the app', 8, '{}', '{}', null, null, 'Final check and test', 8),

    -- Set up SEO tracking
    ('Onboarding', 'Search Console — Accept the access, paste the exact property in Edit Client and test it', 2, '{seo}', '{}', 'gsc_connected',
     'Click Test Search Console. Ticks itself once data starts arriving.', 'Set up SEO tracking', 1),
    ('Onboarding', 'Golden Eye — Save the SEO start date and monthly fee', 1, '{seo}', '{}', 'seo_settings_set',
     'Edit Client. Their SEO tab''s "since we started" and return figures use these.', 'Set up SEO tracking', 2),
    ('Onboarding', 'Plan — Keyword research and page plan', 5, '{seo}', '{}', null,
     'Pick the searches worth ranking for and the service and city pages to build (the seo-keyword-plan method), from their SEO answers.', 'Set up SEO tracking', 3),
    ('Onboarding', 'SE Ranking — Create the project with a search engine for each city they serve', 5, '{seo}', '{}', null,
     'Map pack on for each city, with their Business Profile name and phone.', 'Set up SEO tracking', 4),
    ('Onboarding', 'SE Ranking — Load the keywords, each with its target page', 6, '{seo}', '{}', null,
     'Only the "near me" and generic searches run in every city; a search naming a city runs from that city. Keep strict matching off.', 'Set up SEO tracking', 5),
    ('Onboarding', 'SE Ranking — Add 3 to 5 competitors', 6, '{seo}', '{}', null, 'From the top 10 by city, leaving out directories and manufacturers.', 'Set up SEO tracking', 6),
    ('Onboarding', 'SE Ranking — Run the site audit once and set it to monthly', 6, '{seo}', '{}', null, 'Day 1, 09:00 UTC, like the other clients.', 'Set up SEO tracking', 7),
    ('Onboarding', 'SE Ranking — Put the project ID in Edit Client', 6, '{seo}', '{}', 'seranking_connected', 'Ticks itself once rankings arrive.', 'Set up SEO tracking', 8),
    ('Onboarding', 'Leads — Add the lead-source snippet to their site and send one real Google test lead', 8, '{seo}', '{}', 'lead_tracking_live',
     'snippets/lead-source-carry.html in their site''s head. Ticks itself when the first website lead arrives.', 'Set up SEO tracking', 9),

    -- Set up Cuppa
    ('Onboarding', 'Cuppa — Set up article auto-logging first', 6, '{seo}', '{}', 'autolog_configured',
     'SEO tab > Auto-log articles: pick their platform, save, paste the link into their site''s webhook settings, before Cuppa publishes anything.', 'Set up Cuppa', 1),
    ('Onboarding', 'Cuppa — Create their workspace with their brand voice', 7, '{seo}', '{}', null,
     'From their SEO answers: Copy for Cuppa on their answers puts everything on the clipboard, services included.', 'Set up Cuppa', 2),
    ('Onboarding', 'Cuppa — Connect it to their site', 7, '{seo}', '{}', null, null, 'Set up Cuppa', 3),
    ('Onboarding', 'Cuppa — Publish the first article', 10, '{seo}', '{}', 'first_article_logged', 'Ticks itself when that article auto-logs.', 'Set up Cuppa', 4),

    -- Launch ads (Campaign Building); "Draft Copywriting Hooks V1" is step 1 and is kept
    ('Campaign Building', 'Ads — Build the creatives', 3, '{ads}', '{}', null, null, 'Launch ads', 2),
    ('Campaign Building', 'Ads — Build the ads in Meta, paused, with the funnel URL and UTM tags', 4, '{ads}', '{}', null,
     'Check every ad points at the final funnel URL from setup.', 'Launch ads', 3),
    ('Campaign Building', 'Ads — Send the ads for client approval on the Creatives page', 5, '{ads}', '{}', null, null, 'Launch ads', 4),
    ('Campaign Building', 'Ads — Launch in Ads Manager, then Move Stage to Campaign Learning', 7, '{ads}', '{}', null,
     'Launching is manual in Ads Manager, and so is moving the stage.', 'Launch ads', 5),
    ('Campaign Building', 'Ads — Check the first real lead reached GHL, the client was notified and Meta counted it once', 9, '{ads}', '{}', null,
     'Open the contact in GHL, check the client got the notification, and check the dataset shows one Lead, not two.', 'Launch ads', 6)
) as v(stage, task_title, due_days, service_keys, website_statuses, auto_check, default_notes, checklist_group, sort_order)
where not exists (select 1 from public.stage_templates t where t.stage = v.stage and lower(btrim(t.task_title)) = lower(btrim(v.task_title)));

commit;

notify pgrst, 'reload schema';

-- Check afterwards:
--   select checklist_group, count(*), count(auto_check) from stage_templates where task_type = 'Setup step' group by 1 order by 1;
--   select title, active, service_keys, website_statuses from onboarding_steps where owner = 'agency' order by sort_order;
