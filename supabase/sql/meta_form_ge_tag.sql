-- The Meta instant form source tag is "meta form ge", not "meta form" (2026-11-12), matching "quiz ads ge" so the new setup's
-- tags never collide with a client's own. Updates the step wording already in the database (templates and open tasks).
-- Nothing in Golden Eye counts this tag: ad leads are "ge lead" without "website lead". Safe to re-run.

begin;

update public.stage_templates set default_notes = replace(default_notes, '"meta form"', '"meta form ge"')
 where default_notes like '%"meta form"%';

update public.tasks set notes = replace(notes, '"meta form"', '"meta form ge"'), updated_at = now()
 where notes like '%"meta form"%' and (type = 'Setup step' or title = 'Switch to the ge lead setup') and archived_at is null;

commit;
