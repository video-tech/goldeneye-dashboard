-- The setup checklist (2026-10-14): everything we do after a client finishes onboarding, for Base and Ads.
--
-- How it works (app.js, "Our checklist" on the client's Health tab):
--   - Each GROUP is one ordinary task on the board: "Get ready for GHL" and "Set up GHL" (our onboarding
--     steps, which gate the move to Campaign Building) and "Launch ads" (a Campaign Building checklist item).
--   - Each STEP inside a group is a task of type 'Setup step', hidden from the board, the feeds and the
--     client's portal (client_visible = false), and shown only in the client's checklist. A group's task ticks
--     itself when its last step is done. Steps with an auto_check tick themselves too (reconcile_auto_checks).
--   - Steps are tagged like everything else: untagged = Base, 'ads' = Ads clients only.
--   - Onboarding-stage steps live in stage_templates with stage = 'Onboarding'. generateStageTasks reads them
--     when the agency tasks are raised, so editing them is Templates > Stage Checklists > Onboarding.
--
-- Changes to existing rows (nothing is deleted):
--   - "Add their Meta ad account ID to Golden Eye" becomes the group "Get ready for GHL".
--   - "Set up GHL sub-account & assets" becomes the group "Set up GHL".
--   - "Build and launch ads" is switched off. Launching now belongs to Campaign Building ("Launch ads"), so a client
--     reaches Campaign Building when GHL is set up, instead of only once the ads are live.
--   - "Draft Copywriting Hooks V1" joins the "Launch ads" group.
-- Needs service_onboarding.sql and task_client_visibility.sql first. Run once. Safe to re-run.

begin;

-- 1. The two onboarding groups reuse the existing agency rows
update public.onboarding_steps set
    title = 'Get ready for GHL', service_keys = '{}', auto_check = null, due_days = 3,
    description = 'Check their answers, the Facebook access and Meta sync, and set their target CPL.'
where owner = 'agency' and title in ('Add their Meta ad account ID to Golden Eye', 'Get ready for GHL');

update public.onboarding_steps set
    title = 'Set up GHL', service_keys = '{}', auto_check = null, due_days = 10,
    description = 'Create their GHL account, get A2P started, and set up their funnel, workflows, people and tests.'
where owner = 'agency' and title in ('Set up GHL sub-account & assets', 'Set up GHL');

update public.onboarding_steps set active = false
where owner = 'agency' and title = 'Build and launch ads';

-- 2. The steps
insert into public.stage_templates (stage, task_title, due_days, service_keys, auto_check, default_notes, checklist_group, task_type, sort_order)
select v.stage, v.task_title, v.due_days, v.service_keys, v.auto_check, v.default_notes, v.checklist_group, v.task_type, v.sort_order
from (values
    ('Onboarding', 'Answers — Read their questionnaire end to end and flag gaps', 1, '{}'::text[], null, 'Open their answers (Client > Onboarding progress). Note anything vague, missing or contradictory and ask the client now, before it blocks setup.', 'Get ready for GHL', 'Setup step', 1),
    ('Onboarding', 'Answers — Check the legal name and address match the EIN', 1, '{}'::text[], null, 'The name and address must match what the EIN is registered under, exactly. A mismatch is the most common reason A2P is rejected. Compare with their EIN letter and fix it with the client.', 'Get ready for GHL', 'Setup step', 2),
    ('Onboarding', 'Answers — Check the Drive link opens and the files are usable', 1, '{}'::text[], null, 'Logo and photos. If it asks for access, ask the client to set it to anyone with the link can view.', 'Get ready for GHL', 'Setup step', 3),
    ('Onboarding', 'Meta — Confirm every Facebook step is done and Midas Media LLC has full admin on the ad account', 1, array['ads']::text[], null, 'Page, Business Manager, card added, and our business (Midas Media LLC) has full admin on their ad account. If not, chase the client first.', 'Get ready for GHL', 'Setup step', 4),
    ('Onboarding', 'Meta — Save their Meta ad account ID and business ID in Golden Eye', 2, array['ads']::text[], 'ad_account_set', 'Edit Client > Ad account ID (digits only) and Business ID. Saving them starts the daily pull in Make.', 'Get ready for GHL', 'Setup step', 5),
    ('Onboarding', 'Meta — Check the ad account is healthy', 2, array['ads']::text[], null, 'No restrictions, the payment method works, and the Page is connected to the ad account.', 'Get ready for GHL', 'Setup step', 6),
    ('Onboarding', 'Meta — Make sure a dataset (pixel) exists and is shared with us', 2, array['ads']::text[], null, 'Needed for the Conversions API later. Used server-side only, with no browser pixel on their pages.', 'Get ready for GHL', 'Setup step', 7),
    ('Onboarding', 'Meta — Run Meta sync', 2, array['ads']::text[], null, 'Only after all the Facebook access is done. In Midas Media LLC assign the ad account to Golden Eye Sync with view-only, then run the connection check and read the result.', 'Get ready for GHL', 'Setup step', 8),
    ('Onboarding', 'Meta — Confirm their first rows show in the daily pull', 3, array['ads']::text[], 'ads_data_flowing', 'Within a day of saving the IDs. If nothing appears, check that Make''s Facebook connection can see the account.', 'Get ready for GHL', 'Setup step', 9),
    ('Onboarding', 'Golden Eye — Fill their client profile, add check-in people and confirm portal sign-in', 2, '{}'::text[], null, 'Roster > their profile: business phone, website, address, private notes. Add everyone who gives numbers, with check-in texts on. Confirm the client can sign in.', 'Get ready for GHL', 'Setup step', 10),
    ('Onboarding', 'Golden Eye — Set their target CPL', 2, array['ads']::text[], null, 'Use their average job value and close rate answers. The morning audit and the per-ad flags use it.', 'Get ready for GHL', 'Setup step', 11),
    ('Onboarding', 'Account — Create the sub-account from the master snapshot', 3, '{}'::text[], null, 'Name it exactly as the business.', 'Set up GHL', 'Setup step', 12),
    ('Onboarding', 'Account — Fill in business info, timezone and logo', 3, '{}'::text[], null, null, 'Set up GHL', 'Setup step', 13),
    ('Onboarding', 'Account — Save the GHL location ID in Edit Client', 3, '{}'::text[], 'ghl_location_set', 'Edit Client > GHL location ID.', 'Set up GHL', 'Setup step', 14),
    ('Onboarding', 'Account — Spot-check what the snapshot brought in', 3, '{}'::text[], null, 'Workflows, pipelines, custom fields and values, forms, calendars and templates.', 'Set up GHL', 'Setup step', 15),
    ('Onboarding', 'A2P — Buy a local number', 3, '{}'::text[], null, 'Area code from their business address.', 'Set up GHL', 'Setup step', 16),
    ('Onboarding', 'A2P — Build the A2P site on a subdomain of ours', 4, '{}'::text[], null, 'Home page, services page, a contact form with the consent wording, a privacy page and a terms page, using their exact legal name, address and phone. Start from the snapshot''s site template.', 'Set up GHL', 'Setup step', 17),
    ('Onboarding', 'A2P — Submit the A2P brand', 4, '{}'::text[], null, 'Legal name, EIN, address, website and contact.', 'Set up GHL', 'Setup step', 18),
    ('Onboarding', 'A2P — Submit the A2P campaign', 4, '{}'::text[], null, 'Use case, sample messages, opt-in description and the link to the form page.', 'Set up GHL', 'Setup step', 19),
    ('Onboarding', 'A2P — Record the submission date and set a reminder to check back', 4, '{}'::text[], null, null, 'Set up GHL', 'Setup step', 20),
    ('Onboarding', 'A2P — When approved, attach the number to the campaign and make it the default', 10, '{}'::text[], null, 'Approval can take days to weeks. Everything else can carry on while it is under review.', 'Set up GHL', 'Setup step', 21),
    ('Onboarding', 'Values — Fill every custom value from their answers', 5, '{}'::text[], null, 'Company, owner, phone, email, address, website, social, awards, service area, radius, exclusions, hours, call routing, text window, services, financing, design offer, current offer and ad cities.', 'Set up GHL', 'Setup step', 22),
    ('Onboarding', 'Values — Create the Google review link and booking link', 5, '{}'::text[], null, null, 'Set up GHL', 'Setup step', 23),
    ('Onboarding', 'Funnel — Share each relevant funnel from the master account and import it', 6, array['ads']::text[], null, null, 'Set up GHL', 'Setup step', 24),
    ('Onboarding', 'Funnel — Replace the logo, colors, phone, business name, cities, offer and testimonials', 6, array['ads']::text[], null, null, 'Set up GHL', 'Setup step', 25),
    ('Onboarding', 'Funnel — Connect the funnel form to its workflow', 6, array['ads']::text[], null, null, 'Set up GHL', 'Setup step', 26),
    ('Onboarding', 'Funnel — Set the thank-you page and after-submit tracking', 6, array['ads']::text[], null, null, 'Set up GHL', 'Setup step', 27),
    ('Onboarding', 'Funnel — Connect it to a subdomain on our domain', 6, array['ads']::text[], null, 'A client''s own domain is only for SEO.', 'Set up GHL', 'Setup step', 28),
    ('Onboarding', 'Funnel — Publish and test the forms and surveys, with the Facebook event set to Submit Application or None', 7, array['ads']::text[], null, 'Never Lead. The Conversions API workflow sends Lead, so a form event would count every lead twice.', 'Set up GHL', 'Setup step', 29),
    ('Onboarding', 'Funnel — Test on a phone, publish and copy the final URL for the ad', 7, array['ads']::text[], null, null, 'Set up GHL', 'Setup step', 30),
    ('Onboarding', 'Workflows — Adjust the pipeline stages to their flow', 7, '{}'::text[], null, 'Some clients have more than one pipeline.', 'Set up GHL', 'Setup step', 31),
    ('Onboarding', 'Workflows — Publish every workflow and point it at the right pipeline, calendar, number, user and templates', 7, '{}'::text[], null, 'Check the review-request workflow has their review link.', 'Set up GHL', 'Setup step', 32),
    ('Onboarding', 'Workflows — Select their Facebook account and dataset in the Conversions API workflow', 7, array['ads']::text[], null, null, 'Set up GHL', 'Setup step', 33),
    ('Onboarding', 'People — Add our team to the sub-account with full access', 7, '{}'::text[], null, null, 'Set up GHL', 'Setup step', 34),
    ('Onboarding', 'People — Add the owner and their sales people with a limited role', 7, '{}'::text[], null, 'No workflow access.', 'Set up GHL', 'Setup step', 35),
    ('Onboarding', 'People — Set new-lead notifications per person and have them install the mobile app', 7, '{}'::text[], null, null, 'Set up GHL', 'Setup step', 36),
    ('Onboarding', 'Test — Submit a lead through the form and follow it end to end', 8, '{}'::text[], null, 'Contact created, text and email sent, client notified, and the lead lands in the pipeline.', 'Set up GHL', 'Setup step', 37),
    ('Onboarding', 'Test — Book an appointment and check the reminders fire', 8, '{}'::text[], null, null, 'Set up GHL', 'Setup step', 38),
    ('Onboarding', 'Test — Miss a call and check the missed-call text arrives', 8, '{}'::text[], null, null, 'Set up GHL', 'Setup step', 39),
    ('Onboarding', 'Test — Trigger a review request', 8, '{}'::text[], null, null, 'Set up GHL', 'Setup step', 40),
    ('Onboarding', 'Test — Confirm one test Lead event reaches Meta once', 8, array['ads']::text[], null, 'Check the dataset''s test events for duplicates.', 'Set up GHL', 'Setup step', 41),
    ('Onboarding', 'Test — Delete the test contacts and tell the client how to log in and reply from the app', 8, '{}'::text[], null, null, 'Set up GHL', 'Setup step', 42),
    ('Campaign Building', 'Ads — Build the creatives', 3, array['ads']::text[], null, null, 'Launch ads', 'Setup step', 2),
    ('Campaign Building', 'Ads — Build the ads in Meta, paused', 4, array['ads']::text[], null, null, 'Launch ads', 'Setup step', 3),
    ('Campaign Building', 'Ads — Send the ads for client approval on the Creatives page', 5, array['ads']::text[], null, null, 'Launch ads', 'Setup step', 4),
    ('Campaign Building', 'Ads — Launch in Ads Manager, then Move Stage to Campaign Learning', 7, array['ads']::text[], null, 'Launching is manual in Ads Manager, and so is moving the stage.', 'Launch ads', 'Setup step', 5)
) as v(stage, task_title, due_days, service_keys, auto_check, default_notes, checklist_group, task_type, sort_order)
where not exists (select 1 from public.stage_templates t where t.stage = v.stage and lower(btrim(t.task_title)) = lower(btrim(v.task_title)));

-- 3. The hooks task that already existed joins the Launch ads group
update public.stage_templates set checklist_group = 'Launch ads', task_type = 'Setup step', sort_order = 1
where stage = 'Campaign Building' and task_title = 'Draft Copywriting Hooks V1';

-- 4. The Launch ads group itself, a normal task in Campaign Building
insert into public.stage_templates (stage, task_title, due_days, service_keys, default_notes, checklist_group, task_type, sort_order)
select 'Campaign Building', 'Launch ads', 7, array['ads']::text[],
       'Draft the hooks, build the creatives and the ads, get client approval and launch. Details are in the client''s checklist.',
       null, 'Checklist', 0
where not exists (select 1 from public.stage_templates t where t.stage = 'Campaign Building' and lower(btrim(t.task_title)) = 'launch ads');

commit;

notify pgrst, 'reload schema';

-- Check afterwards:
--   select stage, checklist_group, count(*) from stage_templates group by 1, 2 order by 1, 2;
--   select title, owner, active from onboarding_steps where owner = 'agency' order by sort_order;
