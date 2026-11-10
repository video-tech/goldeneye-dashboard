-- The "ge lead" setup (2026-11-10). Every opt-in has its own GHL workflow that adds a source tag ("quiz ads", "meta form" or
-- "website lead") and then "ge lead". One workflow per account, "Lead to Golden Eye and Meta" (trigger: tag ge lead added,
-- re-entry off), sends every lead to Golden Eye and, for "quiz ads" only, a Lead to Meta. It replaces the separate
-- Conversions API and "leads to Golden Eye" workflows.
--
-- 1. Rewrites the setup steps that described the old workflows. Templates AND existing tasks are renamed together:
--    tasks are deduped on title, so renaming only the template would raise a second copy for clients who have the old one.
-- 2. Raises "Switch to the ge lead setup" (hidden from the client, with its steps) for every active client past Onboarding
--    whose GHL we run (not No Base). Clients still in Onboarding follow the rewritten setup steps instead.
-- Plain ASCII on purpose: "~" in a title stands for the long dash, chr(8212). Safe to re-run.

begin;

create temporary table step_rewrite (old_title text, new_title text, notes text) on commit drop;
insert into step_rewrite values
  ('Golden Eye ~ Lead tags and the webhook to Golden Eye',
   'Golden Eye ~ Turn on Lead to Golden Eye and Meta and the standard tags',
   'In their GHL (it comes from the snapshot): the tags "ge lead", "quiz ads", "meta form" and "website lead" exist, spelled exactly; the workflow "Lead to Golden Eye and Meta" has trigger Contact Tag Added = ge lead, re-entry OFF, the Golden Eye webhook, then an If/Else that sends the Conversions API Lead only when the contact has "quiz ads". The Golden Eye webhook URL is pasted in (copy it from another client; it carries our key). SEO clients also get "Website source to Golden Eye": Contact Created, re-entry off, the same webhook. Edit Client''s lead tag fields stay blank (blank = the standard tags). Publish with the rest at the final check.'),
  ('Funnel ~ Connect the funnel and survey to their workflows',
   'Funnel ~ Build an opt-in workflow for the funnel and one for the survey',
   'Each: trigger Form Submitted or Survey Submitted, filtered to it, re-entry on. Add Tag "quiz ads", then (a separate action after it) Add Tag "ge lead", then the client notification and lead follow-up. "ge lead" is what sends it to Golden Eye and Meta, so nothing else is connected by hand. A Meta instant form gets "meta form" instead of "quiz ads" (Meta counts those itself).'),
  ('Funnel ~ Paste their pixel and token into the Conversions API workflow',
   'Funnel ~ Paste their pixel and token into Lead to Golden Eye and Meta',
   'Done by hand, in the Conversions API action inside "Lead to Golden Eye and Meta". Pick their Facebook account and dataset; the token is generated in their Events Manager for that dataset. Never paste one token into another client''s account.'),
  ('Workflows ~ Turn on the Conversions API and lead follow-up (survey) workflows',
   'Workflows ~ Turn on Lead to Golden Eye and Meta, the opt-in workflows and lead follow-up',
   'Publish the opt-in workflows and "Lead to Golden Eye and Meta" together. Check no other workflow sends a Lead to Meta, and GHL''s own Meta integration (Settings, Integrations) isn''t sending events.');

update step_rewrite set old_title = replace(old_title, '~', chr(8212)), new_title = replace(new_title, '~', chr(8212));

update public.stage_templates t set task_title = r.new_title, default_notes = r.notes
  from step_rewrite r where t.task_title = r.old_title;
update public.tasks t set title = r.new_title, notes = r.notes, updated_at = now()
  from step_rewrite r where t.title = r.old_title and t.type = 'Setup step';

update public.stage_templates set default_notes = 'Lead to Golden Eye and Meta sends the Lead, so a form event would count every lead twice. Also check the thank-you page has no pixel Lead event.'
 where task_title = replace('Funnel ~ Set the Facebook event to Submit Application or None, never Lead', '~', chr(8212));

-- 2. The switch for existing clients
create temporary table switch_steps (ord int, title text, notes text, due_days int) on commit drop;
insert into switch_steps values
  (1, 'Switch ~ Their GHL location ID is saved in Edit Client', 'Without it Golden Eye can''t tell whose leads arrive. Find it in their GHL under Settings, Business Profile.', 7),
  (2, 'Switch ~ Copy the pixel ID, token and field mapping from the old Conversions API workflow', 'Before changing anything: the dataset (pixel) ID, the access token and what each field maps to (email, phone, name, event source URL).', 7),
  (3, 'Switch ~ Build Lead to Golden Eye and Meta, in draft', 'Trigger Contact Tag Added = ge lead, re-entry OFF. Golden Eye webhook (copy the URL from their old leads to Golden Eye workflow), then If/Else: contact has "quiz ads" -> Conversions API Lead with the values from step 2. Create the tags ge lead, quiz ads, meta form and website lead if they don''t exist.', 7),
  (4, 'Switch ~ Build an opt-in workflow for every funnel, quiz, survey and Meta form, in draft', 'Each: trigger on that one form or survey, re-entry on, Add Tag source ("quiz ads", or "meta form" for a Meta instant form, or "website lead" for a site form), then a separate Add Tag "ge lead", then the notification and follow-up it already has.', 7),
  (5, 'Switch ~ Take out every other action that adds quiz ads or website lead', 'So the opt-in workflows are the only place tags come from. Campaign tags can stay.', 7),
  (6, 'Switch ~ Check forms, surveys and funnel pages send no Lead event, and GHL''s own Meta integration is off', 'Facebook event on each form and survey: Submit Application or None. Thank-you pages: no pixel Lead in the tracking code. GHL sends no event ID, so Meta can''t remove duplicates.', 7),
  (7, 'Switch ~ Same sitting: publish the opt-in workflows, then Lead to Golden Eye and Meta, then turn off the old Conversions API workflow', 'All three together, so there is never a moment with two Lead senders or none. Turn the old one off, don''t delete it yet.', 7),
  (8, 'Switch ~ Old leads to Golden Eye workflow: SEO clients make it Website source to Golden Eye, everyone else turn it off', 'SEO clients: remove the Contact Tag Added trigger, keep Contact Created, re-entry off, rename it. Everyone else: turn it off.', 7),
  (9, 'Switch ~ Clear the lead tag fields in Edit Client', 'Blank means the standard tags (ge lead, website lead). Only a client whose GHL keeps its own tag names needs anything typed.', 7),
  (10, 'Switch ~ First real lead: both tags in GHL, one server Lead in Meta', 'For a "quiz ads" lead, one server Lead in Events Manager, not two. A Meta form or website lead sends none.', 10),
  (11, 'Switch ~ A week later: the Leads check lines up, then delete the old Conversions API workflow', 'Generate Report: GHL ad leads close to the daily pull. Then delete the old workflow.', 14);
update switch_steps set title = replace(title, '~', chr(8212));

create temporary table switch_clients on commit drop as
select c.name, c.current_stage as stage
  from public.clients c
 where c.status = 'active' and coalesce(c.current_stage, '') not in ('', 'Onboarding') and coalesce(c.base_package, 'yes') <> 'no'
   and not exists (select 1 from public.tasks t where t.client = c.name and t.title = 'Switch to the ge lead setup');

insert into public.tasks (client, title, type, stage, status, checklist_group, client_visible, notes, due, p, u, e, score, updated_at)
select name, 'Switch to the ge lead setup', 'Checklist', stage, 'Not Started', null, false,
       'Move their GHL to the ge lead setup: one Lead to Golden Eye and Meta workflow, one opt-in workflow per funnel. Open the arrow for the steps.',
       current_date + 14, 3, 3, 3, 60, now()
  from switch_clients;

insert into public.tasks (client, title, type, stage, status, checklist_group, client_visible, notes, due, p, u, e, score, updated_at)
select c.name, s.title, 'Setup step', c.stage, 'Not Started', 'Switch to the ge lead setup', false, s.notes,
       current_date + s.due_days, 3, 3, 3, 60, now()
  from switch_clients c cross join switch_steps s
 order by c.name, s.ord;

commit;

notify pgrst, 'reload schema';
