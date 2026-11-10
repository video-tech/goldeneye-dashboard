-- A step in "Connect their GHL to Golden Eye" (2026-11-10): lead tags and the webhook that sends every contact to Golden Eye,
-- so the report's Leads check can count GHL's leads (supabase/sql/ghl_contacts.sql). Last in the task, after the Golden Eye
-- profile step. Base only, like the rest of the task. Also added to clients whose task is already open. Safe to re-run.
-- Plain ASCII on purpose: "~" in a title stands for the long dash, written as chr(8212), so a clipboard copy can't mangle it.

begin;

create temporary table lead_step (title text, notes text) on commit drop;
insert into lead_step values (
    replace('Golden Eye ~ Lead tags and the webhook to Golden Eye', '~', chr(8212)),
    'In their GHL: 1) Make sure every lead gets a tag that says what it is (for example "quiz ads" for funnel and quiz leads, '
    || '"website lead" for their site''s forms). 2) Open the "leads to Golden Eye" workflow (it comes from the snapshot as a draft): '
    || 'triggers Contact Created AND Contact Tag Added (filtered to the lead tags), Allow re-entry ON, the Golden Eye webhook action '
    || 'as is, then Publish. 3) In Golden Eye, Edit Client: type the same tags into "GHL lead tags", spelled exactly as in GHL. '
    || 'Check: once the first real lead comes in, the Leads check box in Generate Report shows it.'
);

insert into public.stage_templates (stage, task_title, due_days, service_keys, website_statuses, fact_conditions, default_notes, checklist_group, task_type, sort_order)
select 'Onboarding', s.title, 3, '{}', '{}', '{"base_package": ["yes"]}'::jsonb, s.notes, 'Connect their GHL to Golden Eye', 'Setup step', 8
  from lead_step s
 where not exists (select 1 from public.stage_templates t where t.stage = 'Onboarding' and t.task_title = s.title);

-- Clients whose "Connect their GHL to Golden Eye" task is already open get the step now
insert into public.tasks (client, title, type, stage, status, checklist_group, client_visible, notes, due, p, u, e, score, updated_at)
select g.client, s.title, 'Setup step', 'Onboarding', 'Not Started', 'Connect their GHL to Golden Eye', false, s.notes,
       current_date + 3, 3, 3, 3, 60, now()
  from public.tasks g cross join lead_step s
 where g.title = 'Connect their GHL to Golden Eye' and g.stage = 'Onboarding' and coalesce(g.status, '') <> 'Complete'
   and g.archived_at is null
   and not exists (select 1 from public.tasks x where x.client = g.client and x.stage = 'Onboarding' and x.title = s.title);

commit;

notify pgrst, 'reload schema';
