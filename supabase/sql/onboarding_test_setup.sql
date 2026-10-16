-- Test the new onboarding on ONE test client, without any real client seeing it.
--
-- Before running: add the client "GE Test Client" in Golden Eye (Add Client), with
--   client email  video+getest@midasmediafirm.com   (arrives in the video@ inbox; not a GHL contact, so no client text)
--   add-ons       Ads management and SEO Growth
--   website       "They keep their existing site" (switch to "We're building it" later to test Your new website)
-- and run onboarding_questionnaire.sql and rename_client.sql first.
--
-- What this does:
--   1. Adds a temporary service "qtest" ("Onboarding test (temporary)") and gives it to GE Test Client only.
--   2. Saves the current on/off and tags of every new onboarding piece in onboarding_test_backup, then switches them on
--      tagged qtest only: the six questionnaire steps, Quick start, our four answer-driven tasks and the SEO password task.
--      Nobody else has qtest, so nobody else sees them. Ironshell is untouched.
--   3. Marks every OTHER client step done for the test client (completed_by 'backfilled', which never texts), so what is
--      left in their Get Started is exactly the new steps. Delete those rows to walk the whole onboarding instead.
--
-- Undo with onboarding_test_teardown.sql. Safe to re-run: the backup keeps the first originals it saw.

begin;

do $$ begin
    if not exists (select 1 from public.clients where name = 'GE Test Client') then
        raise exception 'Add the client "GE Test Client" in Golden Eye first';
    end if;
    if not exists (select 1 from public.onboarding_steps where title = 'About your business' and step_type = 'questions') then
        raise exception 'Run onboarding_questionnaire.sql first';
    end if;
end $$;

-- The test client is in onboarding and active, the gate the handoff uses
update public.clients set current_stage = 'Onboarding', status = 'active' where name = 'GE Test Client';

-- 1. The temporary service. Active so Edit Client shows it ticked (unticked services are ended on save).
insert into public.services (key, name, description, active, sort_order)
values ('qtest', 'Onboarding test (temporary)', 'Only GE Test Client. Removed by onboarding_test_teardown.sql.', true, 99)
on conflict (key) do update set active = true;

insert into public.client_services (client_name, service_key, status)
values ('GE Test Client', 'qtest', 'onboarding')
on conflict do nothing;
update public.client_services set status = 'onboarding' where client_name = 'GE Test Client' and service_key = 'qtest';

-- 2. Back up, then switch the new pieces on for qtest only
create table if not exists public.onboarding_test_backup (id uuid primary key, active boolean, service_keys text[] not null);
alter table public.onboarding_test_backup enable row level security;
revoke all on public.onboarding_test_backup from anon, authenticated;

create temporary table test_pieces on commit drop as
select id from public.onboarding_steps
 where (owner = 'client' and step_type = 'questions'
        and title in ('About your business', 'Registering your texting number', 'Texting and your service area',
                      'Your jobs and offers', 'Access to your website', 'Your new website', 'Quick start: your Facebook page and CRM'))
    or (owner = 'agency'
        and title in ('Help client create their Facebook page', 'Confirm partner access to their Facebook page',
                      'Follow up: do they have a Facebook page?', 'Build the lead send to their CRM', 'Delete their stored website password'));

insert into public.onboarding_test_backup (id, active, service_keys)
select s.id, s.active, s.service_keys from public.onboarding_steps s join test_pieces p using (id)
on conflict (id) do nothing;

update public.onboarding_steps s set active = true, service_keys = array['qtest']
  from test_pieces p where s.id = p.id;

-- 3. Every other client step counts as done for the test client
insert into public.client_onboarding_progress (client_name, step_id, completed_at, completed_by, watch_percent)
select 'GE Test Client', s.id, now(), 'backfilled', 100
  from public.onboarding_steps s
 where s.owner = 'client' and coalesce(s.active, true)
   and s.id not in (select id from test_pieces)
   and not exists (select 1 from public.client_onboarding_progress p where p.client_name = 'GE Test Client' and p.step_id = s.id);

commit;

notify pgrst, 'reload schema';

-- Check: what the test client sees, and that Ironshell sees none of it
--   select s.title, f.completed from onboarding_steps_for_client('GE Test Client') f join onboarding_steps s on s.id = f.step_id where f.owner = 'client' order by f.sort_order;
--   select count(*) from onboarding_steps_for_client('Ironshell Roofing') f join onboarding_test_backup b on b.id = f.step_id;   -- must be 0
