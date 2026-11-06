-- One A2P task: "Texting number and website (A2P)" (2026-11-06).
--
-- A2P approval takes days to weeks and the carriers check the client's website, so the website and the registration are one
-- job and it is the one that must start first. Until now they were two tasks ("Register their texting number" and "Build
-- their website"), with the A2P Business Profile step buried in "Connect their GHL to Golden Eye".
--
-- After this, for Base clients (it was Base-only already: every step carries {"base_package": ["yes"]}):
--   * ONE task, "Texting number and website (A2P)", first in the list, with the highest priority score there is (100).
--     Every other task is 60. A task's priority comes from the new onboarding_steps.priority / urgency / effort columns;
--     an empty one counts as 3, which is what every task used.
--   * Its checklist, in order: check the legal name and EIN, paste the A2P details into the Business Profile (moved here from
--     "Connect their GHL"), buy the number, the website steps (5 for a site we build, 1 to connect an existing site), host the
--     site on their GHL, submit the brand and campaign, attach the number once approved.
--   * "Build their website" stops being a task of its own (switched off, not deleted).
--   * Due days follow the order of the work: site 8, submit 9, attach 21 (carriers take 1 to 3 weeks).
-- Clients already part-way through (their tasks exist): the "Register" task is renamed and raised in priority, the website
-- steps and the Business Profile step move into it, and the old "Build their website" task is archived. No new tasks, no texts.
--
-- This file is plain ASCII on purpose. The step titles contain a long dash, and copying a file with one through a Windows
-- clipboard can turn it into garbage, so the dash is written as chr(8212) (the "~" in a title below stands for it).
-- Works whether or not show_setup_tasks_to_clients.sql has been run (it accepts both the old and the client-friendly names).
-- Safe to re-run.

begin;

alter table public.onboarding_steps
    add column if not exists priority smallint,
    add column if not exists urgency  smallint,
    add column if not exists effort   smallint;

comment on column public.onboarding_steps.priority is 'Our task''s priority 1-5 when it is raised (empty = 3). With urgency and effort it sets the task''s score.';

-- 1. The task definition (what the board and the client's portal show)
update public.onboarding_steps s
   set title       = 'Texting number and website (A2P)',
       description = 'We build or connect your website and register your business texting number with the phone carriers. Approval usually takes 1 to 3 weeks.',
       priority    = 5,
       urgency     = 5,
       effort      = 1,
       -- first among our tasks
       sort_order  = coalesce((select min(o.sort_order) - 1 from public.onboarding_steps o
                                where o.owner = 'agency' and o.active
                                  and o.title not in ('Register their texting number', 'Register your texting number', 'Texting number and website (A2P)')),
                              s.sort_order)
 where s.owner = 'agency'
   and s.title in ('Register their texting number', 'Register your texting number', 'Texting number and website (A2P)');

-- The website now lives inside it
update public.onboarding_steps
   set active = false
 where owner = 'agency' and title in ('Build their website', 'Build your website');

-- 2. The checklist: every A2P and website step in one group, in the order the work happens
update public.stage_templates
   set checklist_group = 'Texting number and website (A2P)'
 where stage = 'Onboarding' and task_type = 'Setup step'
   and (checklist_group in ('Register their texting number', 'Register your texting number', 'Build their website', 'Build your website')
        or task_title = replace('Review ~ Paste the A2P details into their Business Profile', '~', chr(8212)));

create temporary table a2p_order (task_title text, sort_order int, due_days int) on commit drop;
insert into a2p_order
select replace(v.t, '~', chr(8212)), v.s, v.d
from (values
    ('A2P ~ Check the legal name, address and EIN match exactly', 1, 2),
    ('Review ~ Paste the A2P details into their Business Profile', 2, 3),
    ('A2P ~ Buy a local number', 3, 3),
    ('Website ~ Check the logo and photos are usable', 4, 3),
    ('Website ~ Read their style picks and design answers', 5, 4),
    ('Website ~ Build the site from their first-choice look', 6, 7),
    ('Website ~ Connect the domain and publish', 7, 8),
    ('Website ~ Test the contact form lands in GHL', 8, 8),
    ('Website ~ Connect their site''s contact form to GHL', 9, 6),
    ('A2P ~ Make their website and host it on their GHL account', 10, 8),
    ('A2P ~ Submit the brand and the campaign', 11, 9),
    ('A2P ~ When approved, attach the number to the campaign and make it the default', 12, 21)
) as v(t, s, d);

update public.stage_templates t
   set sort_order = o.sort_order, due_days = o.due_days
  from a2p_order o
 where t.stage = 'Onboarding' and t.task_type = 'Setup step' and t.task_title = o.task_title
   and t.checklist_group = 'Texting number and website (A2P)';

-- 3. Clients already part-way through: same task, higher priority, steps moved
update public.tasks
   set title = 'Texting number and website (A2P)', p = 5, u = 5, e = 1, score = 100, updated_at = now()
 where stage = 'Onboarding' and type <> 'Setup step'
   and title in ('Register their texting number', 'Register your texting number');

update public.tasks
   set checklist_group = 'Texting number and website (A2P)', updated_at = now()
 where stage = 'Onboarding' and type = 'Setup step'
   and (checklist_group in ('Register their texting number', 'Register your texting number', 'Build their website', 'Build your website')
        or title = replace('Review ~ Paste the A2P details into their Business Profile', '~', chr(8212)));

-- Their old "Build their website" task: its steps now live above, so archive it (kept, not deleted, so it is never raised again)
update public.tasks
   set archived_at = coalesce(archived_at, now()), archived_by = coalesce(archived_by, 'Golden Eye'), updated_at = now()
 where stage = 'Onboarding' and type <> 'Setup step'
   and title in ('Build their website', 'Build your website');

commit;

notify pgrst, 'reload schema';

-- Check (run after): 12 steps in the group, in order, with the Business Profile step second
--   select sort_order, due_days, task_title from stage_templates
--    where checklist_group = 'Texting number and website (A2P)' order by sort_order;
