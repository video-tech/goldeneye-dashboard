-- Show clients what we're doing (2026-10-16). Our setup tasks (one per piece of work) become visible in the client's
-- portal; their steps stay hidden (they're internal: "chase the client", pixel tokens, and 50 small items would bury the
-- picture). Titles that read oddly to a client are reworded, since one title shows on both our board and their portal,
-- and every task's description is written for the client. Run after setup_checklist_v3.sql and
-- setup_checklist_a2p_profile.sql. Safe to re-run.
--
--   Connect their GHL to Golden Eye          -> Set up your CRM
--   Register their texting number            -> Register your texting number
--   Build their website                      -> Build your website
--   Turn on automations and add their team   -> Turn on your automations and add your team
--   Set up Cuppa                             -> Set up your blog articles
--   Connect Meta, Build the funnel and survey, Final check and test, Set up SEO tracking, Launch ads: unchanged.

begin;

create temporary table renames (old text, new text, about text) on commit drop;
insert into renames values
    ('Connect Meta', 'Connect Meta', 'We connect your Facebook ad account to Golden Eye so we can track your ads.'),
    ('Connect their GHL to Golden Eye', 'Set up your CRM', 'We set up your CRM, where your new leads, texts and calls come in.'),
    ('Register their texting number', 'Register your texting number', 'We register your business texting number with the phone carriers. Approval usually takes 1 to 3 weeks.'),
    ('Build their website', 'Build your website', 'We build your website from the look you picked, or connect your current site so its leads get followed up too.'),
    ('Build the funnel and survey', 'Build the funnel and survey', 'We build the page your ads send people to, and the short survey they fill in.'),
    ('Turn on automations and add their team', 'Turn on your automations and add your team', 'We turn on your lead follow-up and add your team to the CRM.'),
    ('Final check and test', 'Final check and test', 'We test everything from start to finish before your ads go live.'),
    ('Set up SEO tracking', 'Set up SEO tracking', 'We set up tracking for your Google rankings and the leads your website brings in.'),
    ('Set up Cuppa', 'Set up your blog articles', 'We set up the articles we publish on your site to bring in more visitors from Google.');

-- 1. The task definitions (active agency rows in onboarding_steps; switched-off rows keep their name)
update public.onboarding_steps s set title = r.new, description = r.about
  from renames r
 where s.owner = 'agency' and s.active and s.title in (r.old, r.new);

update public.stage_templates t set checklist_group = r.new
  from renames r where t.checklist_group = r.old and r.old <> r.new;

update public.stage_templates set default_notes = 'We build your ads, send them to you for approval, and launch them.'
 where stage = 'Campaign Building' and task_type = 'Checklist' and task_title = 'Launch ads';

-- 2. Tasks already raised: same names, and the group tasks shown to the client (their steps stay hidden)
update public.tasks k set title = r.new
  from renames r where k.title = r.old and r.old <> r.new and k.stage = 'Onboarding' and k.type <> 'Setup step';
update public.tasks k set checklist_group = r.new
  from renames r where k.checklist_group = r.old and r.old <> r.new;

update public.tasks set client_visible = true
 where type <> 'Setup step'
   and ((stage = 'Onboarding' and title in (select new from renames))
        or (stage = 'Campaign Building' and title = 'Launch ads'));

commit;

notify pgrst, 'reload schema';

-- Check:
--   select title, active, description from onboarding_steps where owner = 'agency' and active order by sort_order;
--   select checklist_group, count(*) from stage_templates where task_type = 'Setup step' group by 1 order by 1;
