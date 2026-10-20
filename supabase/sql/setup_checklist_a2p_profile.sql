-- A step in "Connect their GHL to Golden Eye" (2026-10-16): paste the A2P details into the new account's Business Profile.
-- GHL's API can't fill the legal business name, business type, EIN or authorized representative (its location API has
-- no such fields), so Golden Eye has the client's answers ready to copy: the step shows a "Copy A2P details" button.
-- Also adds the step to clients who already have the task open, so they get it too. Safe to re-run.

begin;

update public.stage_templates set sort_order = 7
 where stage = 'Onboarding' and task_type = 'Setup step' and checklist_group = 'Connect their GHL to Golden Eye'
   and task_title = 'Golden Eye — Fill their profile, add check-in people and confirm portal sign-in';

insert into public.stage_templates (stage, task_title, due_days, service_keys, website_statuses, default_notes, checklist_group, task_type, sort_order)
select 'Onboarding', 'Review — Paste the A2P details into their Business Profile', 3, '{}', '{}',
       'Settings > Business Profile in their GHL account: legal business name, business type, EIN and the authorized representative. GHL doesn''t let apps fill these, so click "Copy A2P details" on this step and paste each one. They must match the EIN paperwork exactly.',
       'Connect their GHL to Golden Eye', 'Setup step', 6
where not exists (select 1 from public.stage_templates where stage = 'Onboarding'
                    and task_title = 'Review — Paste the A2P details into their Business Profile');

-- Clients whose "Connect their GHL to Golden Eye" task is already open get the new step now
insert into public.tasks (client, title, type, stage, status, checklist_group, client_visible, notes, due, p, u, e, score, updated_at)
select g.client, 'Review — Paste the A2P details into their Business Profile', 'Setup step', 'Onboarding', 'Not Started',
       'Connect their GHL to Golden Eye', false,
       'Settings > Business Profile in their GHL account: legal business name, business type, EIN and the authorized representative. GHL doesn''t let apps fill these, so click "Copy A2P details" on this step and paste each one. They must match the EIN paperwork exactly.',
       current_date + 3, 3, 3, 3, 60, now()
  from public.tasks g
 where g.title = 'Connect their GHL to Golden Eye' and g.stage = 'Onboarding' and coalesce(g.status, '') <> 'Complete'
   and g.archived_at is null
   and not exists (select 1 from public.tasks s where s.client = g.client and s.stage = 'Onboarding'
                     and s.title = 'Review — Paste the A2P details into their Business Profile');

commit;

notify pgrst, 'reload schema';
