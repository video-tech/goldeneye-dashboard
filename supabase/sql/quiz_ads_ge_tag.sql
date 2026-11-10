-- The ad-funnel source tag is "quiz ads ge", not "quiz ads" (2026-11-10): some clients already use "quiz ads" in their own
-- workflows, and the new setup's tag must mean only one thing. Updates the step wording ge_lead_setup.sql wrote (templates and
-- existing tasks), and turns the switch step "Take out every other action that adds quiz ads or website lead" into "Leave their
-- old tags alone", since old tags no longer collide. ge_lead_setup.sql itself now says "quiz ads ge" too. Safe to re-run.

begin;

update public.stage_templates set default_notes = replace(default_notes, '"quiz ads"', '"quiz ads ge"')
 where default_notes like '%"quiz ads"%';

update public.tasks set notes = replace(notes, '"quiz ads"', '"quiz ads ge"'), updated_at = now()
 where notes like '%"quiz ads"%' and (type = 'Setup step' or title = 'Switch to the ge lead setup') and archived_at is null;

update public.tasks
   set title = replace('Switch ~ Leave their old tags alone', '~', chr(8212)),
       notes = 'Only "quiz ads ge", "website lead" and "ge lead" are counted, so old tags (like a plain quiz ads tag) and campaign tags can stay. Just never add "ge lead" anywhere but an opt-in workflow.',
       updated_at = now()
 where title = replace('Switch ~ Take out every other action that adds quiz ads or website lead', '~', chr(8212))
   and checklist_group = 'Switch to the ge lead setup';

commit;
