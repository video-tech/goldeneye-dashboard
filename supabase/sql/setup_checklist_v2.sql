-- The setup checklist, version 2 (2026-10-16): rewritten for the onboarding rebuild (the Golden Eye questionnaire,
-- the MasterV.1 snapshot and the Golden Eye GHL app). Replaces the steps setup_checklist.sql added.
--
-- How the checklist works is unchanged (see setup_checklist.sql and CLAUDE.md "The setup checklist"): each group is one
-- task on the board, each step a hidden 'Setup step' task shown only in the client's checklist, and a group ticks
-- itself when its last step is done.
--
-- What changes:
--   - Every step template in the three groups is replaced (stage_templates rows only). No client has a step task yet
--     (checked 2026-10-16), and tasks already raised would be kept anyway: only templates are deleted here.
--   - "Draft Copywriting Hooks V1" stays as it is, the first step of Launch ads.
--   - New: website steps (only for clients whose site we build, or who keep their own), a "Final check" before tests,
--     and a new group "First week live" in Campaign Learning, raised when a client is moved to that stage.
--   - Workflows arrive from the snapshot unpublished and stay that way until the final check, except lead to Golden Eye
--     (everyone) and, for Ads clients, the Conversions API and lead follow-up (survey) workflows. GHL's API can list workflows but not edit or publish them, so this part stays by hand.
--   - Steps the GHL automation will do later (create the account, business info, custom values, people) are written
--     as checks, so they still make sense once Golden Eye does the work. Golden Eye will create the GHL account once a
--     client's answers are in; we install the Golden Eye app on it (GHL won't do that for us).
--   - An SEO step to delete a stored website password once we have our own login, added switched off: the
--     questionnaire go-live (onboarding_questionnaire_go_live.sql) switches it on with the step that stores passwords.
-- Needs setup_checklist.sql first. Safe to re-run.

begin;

-- 1. The two onboarding groups (agency rows in onboarding_steps)
update public.onboarding_steps set
    description = 'Check their answers and the Facebook access, tell them what happens next, and get Golden Eye ready.'
where owner = 'agency' and title = 'Get ready for GHL';

update public.onboarding_steps set
    description = 'Create their GHL account from MasterV.1, connect the Golden Eye app, get A2P started, build the website and funnel, review everything, then test.'
where owner = 'agency' and title = 'Set up GHL';

-- 2. Replace the step templates
delete from public.stage_templates
 where task_type = 'Setup step'
   and stage in ('Onboarding', 'Campaign Building', 'Campaign Learning')
   and task_title <> 'Draft Copywriting Hooks V1';

insert into public.stage_templates (stage, task_title, due_days, service_keys, website_statuses, auto_check, default_notes, checklist_group, task_type, sort_order)
select v.stage, v.task_title, v.due_days, v.service_keys, v.website_statuses, v.auto_check, v.default_notes, v.checklist_group, 'Setup step', v.sort_order
from (values
    -- Get ready for GHL
    ('Onboarding', 'Answers — Read every answer and flag gaps', 1, '{}'::text[], '{}'::text[], null::text,
     'Client > Onboarding progress > their answers. Private ones (EIN, mobile, job values) show with a lock. Ask the client now about anything vague, missing or contradictory, before it blocks setup.', 'Get ready for GHL', 1),
    ('Onboarding', 'Answers — Check the legal name, address and EIN match exactly', 1, '{}', '{}', null,
     'From "Registering your texting number". They must match what the EIN is registered under, character for character. A mismatch is the most common reason A2P is rejected.', 'Get ready for GHL', 2),
    ('Onboarding', 'Answers — Check the logo and photos are usable', 1, '{}', '{}', null,
     'High enough quality for the website and ads. If a link asks for access, ask the client to share it with anyone who has the link.', 'Get ready for GHL', 3),
    ('Onboarding', 'Client — Send the "what happens next" message', 1, '{}', '{}', null,
     'Text or email the owner: we are setting up your account this week; your texting number needs carrier approval, usually 1 to 3 weeks; your website / ads should be live around <date>. Tell them who to contact with questions.', 'Get ready for GHL', 4),
    ('Onboarding', 'Meta — Confirm Midas Media LLC has full admin, the account is healthy and a dataset exists', 1, '{ads}', '{}', null,
     'Page, Business Manager and card are done; Midas Media LLC has full admin on the ad account; no restrictions; payment works; the Page is connected; a dataset (pixel) exists and is shared with us. If anything is missing, chase the client first.', 'Get ready for GHL', 5),
    ('Onboarding', 'Meta — Save their ad account ID and business ID in Golden Eye', 2, '{ads}', '{}', 'ad_account_set',
     'Edit Client > Ad account ID (digits only) and Business ID. Saving them starts the daily pull in Make.', 'Get ready for GHL', 6),
    ('Onboarding', 'Meta — Run meta-sync and confirm their first rows arrive', 3, '{ads}', '{}', 'ads_data_flowing',
     'In Midas Media LLC assign the ad account to Golden Eye Sync (view only), run the connection check and read the result. The daily pull should show rows within a day of saving the IDs.', 'Get ready for GHL', 7),
    ('Onboarding', 'Golden Eye — Fill their profile, add check-in people and confirm portal sign-in', 2, '{}', '{}', null,
     'Roster > their profile: business phone, website, address, private notes. Add everyone who gives numbers. Confirm the client can sign in.', 'Get ready for GHL', 8),
    ('Onboarding', 'Golden Eye — Set their target CPL', 2, '{ads}', '{}', null,
     'From their average job value and close rate answers. The morning audit and the per-ad flags use it.', 'Get ready for GHL', 9),

    -- Set up GHL: account and values
    ('Onboarding', 'Account — Install the Golden Eye app on their new GHL account', 3, '{}', '{}', null,
     'Golden Eye creates their GHL account from MasterV.1 once their onboarding answers are in. Open the app''s install link, tick the new account, install: GHL does not install the app on new accounts by itself, and without it Golden Eye cannot fill the account. Until the automatic account creation is built, create the account from MasterV.1 by hand first, named exactly as the business.', 'Set up GHL', 11),
    ('Onboarding', 'Account — Save the GHL location ID in Edit Client', 3, '{}', '{}', 'ghl_location_set',
     'Golden Eye saves it when it creates the account. Until then: Edit Client > GHL location ID.', 'Set up GHL', 12),
    ('Onboarding', 'Account — Check business info, timezone and logo', 3, '{}', '{}', null,
     'Settings > Business Profile: name, address, phone, email, website, timezone, logo.', 'Set up GHL', 13),
    ('Onboarding', 'Values — Check every custom value is filled from their answers', 4, '{}', '{}', null,
     'Settings > Custom Values. Master''s own keys are used (business_name, physical_address, hours_of_operation and so on). Anything empty: fill it from their answers or ask them.', 'Set up GHL', 14),
    ('Onboarding', 'Values — Create the Google review link and booking link', 4, '{}', '{}', null, null, 'Set up GHL', 15),

    -- Set up GHL: number and A2P
    ('Onboarding', 'A2P — Buy a local number', 3, '{}', '{}', null, 'Area code from their business address.', 'Set up GHL', 16),
    ('Onboarding', 'A2P — Build the A2P site on a subdomain of ours', 4, '{}', '{}', null,
     'Home, services, a contact form with the consent wording, privacy and terms pages, all with their exact legal name, address and phone. Start from the snapshot''s site template.', 'Set up GHL', 17),
    ('Onboarding', 'A2P — Submit the A2P brand', 4, '{}', '{}', null, 'Legal name, EIN, address, website and contact, from their texting-number answers.', 'Set up GHL', 18),
    ('Onboarding', 'A2P — Submit the A2P campaign', 4, '{}', '{}', null, 'Use case, sample messages, opt-in description and the link to the form page.', 'Set up GHL', 19),
    ('Onboarding', 'A2P — Record the submission date and set a reminder to check back', 4, '{}', '{}', null, null, 'Set up GHL', 20),
    ('Onboarding', 'A2P — When approved, attach the number to the campaign and make it the default', 10, '{}', '{}', null,
     'Approval can take days to weeks. Everything else carries on while it is under review.', 'Set up GHL', 21),

    -- Set up GHL: website
    ('Onboarding', 'Website — Read their style picks and design answers', 4, '{}', '{new_build}', null,
     'Their answers to "Your new website": first and second look, colors, logo, lettering, pages, features, domain.', 'Set up GHL', 22),
    ('Onboarding', 'Website — Build the site from their first-choice look', 7, '{}', '{new_build}', null, null, 'Set up GHL', 23),
    ('Onboarding', 'Website — Connect the domain and publish', 8, '{}', '{new_build}', null, null, 'Set up GHL', 24),
    ('Onboarding', 'Website — Test the contact form lands in GHL', 8, '{}', '{new_build}', null,
     'Submit a test, check the contact is created and the follow-up starts, then delete the test contact.', 'Set up GHL', 25),
    ('Onboarding', 'Website — Connect their site''s contact form to GHL', 6, '{}', '{existing}', null,
     'So their website leads get the same follow-up. Embed our GHL form, or send their form to GHL. Test it, then delete the test contact.', 'Set up GHL', 26),

    -- Set up GHL: funnel, survey and the workflows they feed (ads)
    ('Onboarding', 'Funnel — Build the funnel', 6, '{ads}', '{}', null,
     'Import it from Master and rebrand it: logo, colors, phone, business name, cities, offer and testimonials.', 'Set up GHL', 27),
    ('Onboarding', 'Funnel — Build the survey', 6, '{ads}', '{}', null, 'Import it from Master and match it to their services and offer.', 'Set up GHL', 28),
    ('Onboarding', 'Funnel — Set the Facebook event to Submit Application or None, never Lead', 6, '{ads}', '{}', null,
     'The Conversions API workflow sends Lead, so a form event would count every lead twice.', 'Set up GHL', 29),
    ('Onboarding', 'Funnel — Connect a subdomain of ours and set the thank-you page', 6, '{ads}', '{}', null,
     'A client''s own domain is only for SEO.', 'Set up GHL', 30),
    ('Onboarding', 'Funnel — Connect the funnel and survey to their workflows', 6, '{ads}', '{}', null,
     'The Conversions API workflow and the lead follow-up (survey) workflow.', 'Set up GHL', 31),
    ('Onboarding', 'Funnel — Paste their pixel and token into the Conversions API workflow', 7, '{ads}', '{}', null,
     'Done by hand. Pick their Facebook account and dataset; the token is generated in their Events Manager for that dataset. Never paste one token into another client''s account.', 'Set up GHL', 32),
    ('Onboarding', 'Funnel — Test on a phone, publish and copy the final URL for the ad', 7, '{ads}', '{}', null, null, 'Set up GHL', 33),

    -- Set up GHL: workflows and people
    ('Onboarding', 'Workflows — Turn on the lead to Golden Eye workflow', 7, '{}', '{}', null,
     'On for every client, so their leads reach Golden Eye.', 'Set up GHL', 34),
    ('Onboarding', 'Workflows — Turn on the Conversions API and lead follow-up (survey) workflows', 7, '{ads}', '{}', null,
     'Every other workflow stays unpublished until the final check.', 'Set up GHL', 35),
    ('Onboarding', 'Workflows — Adjust the pipeline stages to their flow', 7, '{}', '{}', null, 'Some clients have more than one pipeline.', 'Set up GHL', 36),
    ('Onboarding', 'People — Add our team with full access', 7, '{}', '{}', null, null, 'Set up GHL', 37),
    ('Onboarding', 'People — Add the owner and their sales people with a limited role', 7, '{}', '{}', null,
     'No workflow access. The account owner must be right: the workflows assign and notify by owner.', 'Set up GHL', 38),
    ('Onboarding', 'People — Set new-lead notifications per person and have them install the mobile app', 7, '{}', '{}', null, null, 'Set up GHL', 39),

    -- Set up GHL: final check, then tests
    ('Onboarding', 'Final check — Review every workflow, then publish them', 8, '{}', '{}', null,
     'The ones still off: owner, number, calendar, pipeline, templates and the review link in each one. Publish each only after it reads right.', 'Set up GHL', 40),
    ('Onboarding', 'Final check — Review the funnels and surveys', 8, '{ads}', '{}', null, 'Wording, branding, every link and the thank-you page.', 'Set up GHL', 41),
    ('Onboarding', 'Test — Submit a lead through the form and follow it end to end', 8, '{}', '{}', null,
     'Contact created, text and email sent, client notified, the lead lands in the pipeline and in Golden Eye.', 'Set up GHL', 42),
    ('Onboarding', 'Test — Book an appointment and check the reminders fire', 8, '{}', '{}', null, null, 'Set up GHL', 43),
    ('Onboarding', 'Test — Miss a call and check the missed-call text arrives', 8, '{}', '{}', null, null, 'Set up GHL', 44),
    ('Onboarding', 'Test — Trigger a review request', 8, '{}', '{}', null, null, 'Set up GHL', 45),
    ('Onboarding', 'Test — Confirm one test Lead event reaches Meta once', 8, '{ads}', '{}', null, 'Check the dataset''s test events for duplicates.', 'Set up GHL', 46),
    ('Onboarding', 'Test — Delete the test contacts and show the client how to log in and reply from the app', 8, '{}', '{}', null, null, 'Set up GHL', 47),

    -- Launch ads (Campaign Building); "Draft Copywriting Hooks V1" is step 1 and is kept
    ('Campaign Building', 'Ads — Build the creatives', 3, '{ads}', '{}', null, null, 'Launch ads', 2),
    ('Campaign Building', 'Ads — Build the ads in Meta, paused, with the funnel URL and UTM tags', 4, '{ads}', '{}', null,
     'Check every ad points at the final funnel URL from setup.', 'Launch ads', 3),
    ('Campaign Building', 'Ads — Send the ads for client approval on the Creatives page', 5, '{ads}', '{}', null, null, 'Launch ads', 4),
    ('Campaign Building', 'Ads — Launch in Ads Manager, then Move Stage to Campaign Learning', 7, '{ads}', '{}', null,
     'Launching is manual in Ads Manager, and so is moving the stage. Moving the stage raises "First week live".', 'Launch ads', 5),

    -- First week live (Campaign Learning)
    ('Campaign Learning', 'Live — First real lead reached GHL, the client was notified and Meta counted it once', 2, '{ads}', '{}', null,
     'Open the contact in GHL, check the client got the notification, and check the dataset shows one Lead, not two.', 'First week live', 1),
    ('Campaign Learning', 'Live — Day 3 check: spend pacing, nothing rejected, ads delivering', 3, '{ads}', '{}', null, null, 'First week live', 2),
    ('Campaign Learning', 'Live — Day 7: review CPL against the target and tell the client how week one went', 7, '{ads}', '{}', null, null, 'First week live', 3)
) as v(stage, task_title, due_days, service_keys, website_statuses, auto_check, default_notes, checklist_group, sort_order)
where not exists (select 1 from public.stage_templates t where t.stage = v.stage and lower(btrim(t.task_title)) = lower(btrim(v.task_title)));

-- 3. Group tasks: Launch ads exists; First week live is new
update public.stage_templates set
    default_notes = 'Draft the hooks, build the creatives and the ads, get client approval and launch. Details are in the client''s checklist.'
where stage = 'Campaign Building' and lower(btrim(task_title)) = 'launch ads';

insert into public.stage_templates (stage, task_title, due_days, service_keys, default_notes, checklist_group, task_type, sort_order)
select 'Campaign Learning', 'First week live', 7, array['ads']::text[],
       'Check the first real lead end to end, then the day 3 and day 7 reviews. Details are in the client''s checklist.',
       null, 'Checklist', 0
where not exists (select 1 from public.stage_templates t where t.stage = 'Campaign Learning' and lower(btrim(t.task_title)) = 'first week live');

-- 4. SEO: delete a stored website password once we have our own login (off until the questionnaire goes live)
insert into public.onboarding_steps (title, description, owner, step_type, active, service_keys, website_statuses, sort_order, due_days)
select 'Delete their stored website password',
       'Once we have our own login to their website, delete the password they gave us: Client > their answers > Access to your website. Nobody should hold it longer than needed.',
       'agency', 'action', false, array['seo']::text[], array['existing']::text[], 25, 7
where not exists (select 1 from public.onboarding_steps s where s.owner = 'agency' and s.title = 'Delete their stored website password');

commit;

notify pgrst, 'reload schema';

-- Check afterwards:
--   select stage, checklist_group, count(*) from stage_templates where task_type in ('Setup step','Checklist') group by 1, 2 order by 1, 2;
