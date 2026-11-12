-- The ge lead setup is called Lead Relay (2026-11-12). Its GHL workflows are named:
--   Lead Relay: Hub                 (Contact Tag Added = ge lead -> Golden Eye webhook, then the Conversions API for "quiz ads ge")
--   Lead Relay: Opt-in - <name>     (one per funnel, quiz or survey: "quiz ads ge", then "ge lead")
--   Lead Relay: Meta forms          (Meta instant forms: "meta form ge", then "ge lead")
--   Lead Relay: Website form        (website forms: "website lead", then "ge lead")
--   Lead Relay: Website source      (SEO clients: Contact Created -> the same webhook)
-- Renames the setup and switch steps (templates and tasks together, since tasks are deduped on title), the switch group
-- ("Switch to the ge lead setup" -> "Switch to Lead Relay", task and checklist_group), and the old names inside every note.
-- Plain ASCII: "~" stands for the long dash, chr(8212). Safe to re-run.

begin;

create temporary table lr_titles (old_title text, new_title text) on commit drop;
insert into lr_titles values
  ('Golden Eye ~ Turn on Lead to Golden Eye and Meta and the standard tags',
   'Golden Eye ~ Turn on Lead Relay and the standard tags'),
  ('Funnel ~ Build an opt-in workflow for the funnel and one for the survey',
   'Funnel ~ Build a Lead Relay opt-in workflow for the funnel and one for the survey'),
  ('Workflows ~ Turn on Lead to Golden Eye and Meta, the opt-in workflows and lead follow-up',
   'Workflows ~ Turn on Lead Relay (the hub and the opt-in workflows) and lead follow-up'),
  ('Switch ~ Build Lead to Golden Eye and Meta, in draft',
   'Switch ~ Build Lead Relay: Hub, in draft'),
  ('Switch ~ Build an opt-in workflow for every funnel, quiz, survey and Meta form, in draft',
   'Switch ~ Build the Lead Relay opt-in workflows for every funnel, quiz, survey and Meta form, in draft'),
  ('Switch ~ Same sitting: publish the opt-in workflows, then Lead to Golden Eye and Meta, then turn off the old Conversions API workflow',
   'Switch ~ Same sitting: publish the opt-in workflows, then Lead Relay: Hub, then turn off the old Conversions API workflow'),
  ('Switch ~ Old leads to Golden Eye workflow: SEO clients make it Website source to Golden Eye, everyone else turn it off',
   'Switch ~ Old leads to Golden Eye workflow: SEO clients make it Lead Relay: Website source, everyone else turn it off'),
  ('Switch to the ge lead setup', 'Switch to Lead Relay');
update lr_titles set old_title = replace(old_title, '~', chr(8212)), new_title = replace(new_title, '~', chr(8212));

update public.stage_templates t set task_title = r.new_title from lr_titles r where t.task_title = r.old_title;
update public.tasks t set title = r.new_title, updated_at = now() from lr_titles r where t.title = r.old_title and t.archived_at is null;
update public.tasks set checklist_group = 'Switch to Lead Relay' where checklist_group = 'Switch to the ge lead setup';

-- The old names inside notes
create temporary table lr_words (old_text text, new_text text) on commit drop;
insert into lr_words values
  ('Lead to Golden Eye and Meta', 'Lead Relay: Hub'),
  ('Website source to Golden Eye', 'Lead Relay: Website source'),
  ('to the ge lead setup', 'to Lead Relay');

do $$
declare w record;
begin
    for w in select * from lr_words loop
        update public.stage_templates set default_notes = replace(default_notes, w.old_text, w.new_text) where default_notes like '%' || w.old_text || '%';
        update public.tasks set notes = replace(notes, w.old_text, w.new_text), updated_at = now()
         where notes like '%' || w.old_text || '%' and archived_at is null;
    end loop;
end $$;

-- How to name the opt-in workflows, at the start of the two steps that build them (once)
update public.stage_templates
   set default_notes = 'Name each "Lead Relay: Opt-in - <funnel name>". ' || default_notes
 where task_title = replace('Funnel ~ Build a Lead Relay opt-in workflow for the funnel and one for the survey', '~', chr(8212))
   and default_notes not like 'Name each%';
update public.tasks
   set notes = 'Name each "Lead Relay: Opt-in - <funnel name>". ' || notes, updated_at = now()
 where title = replace('Funnel ~ Build a Lead Relay opt-in workflow for the funnel and one for the survey', '~', chr(8212))
   and coalesce(notes, '') not like 'Name each%' and archived_at is null;
update public.tasks
   set notes = 'Names: "Lead Relay: Opt-in - <name>" for each funnel or survey, "Lead Relay: Meta forms" for the Meta instant forms, '
            || '"Lead Relay: Website form" for site forms. ' || notes, updated_at = now()
 where title = replace('Switch ~ Build the Lead Relay opt-in workflows for every funnel, quiz, survey and Meta form, in draft', '~', chr(8212))
   and coalesce(notes, '') not like 'Names:%' and archived_at is null;

commit;
