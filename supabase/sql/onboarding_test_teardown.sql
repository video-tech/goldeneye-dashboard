-- Undo onboarding_test_setup.sql: put every onboarding piece back exactly as it was (switched off, original tags),
-- remove the temporary "qtest" service, and delete GE Test Client and everything filed under it.
--
-- Only touches rows for the exact name 'GE Test Client' and the pieces listed in onboarding_test_backup.
-- The test person's sign-in (video+getest@midasmediafirm.com) stays in Supabase Auth; remove it under
-- Authentication > Users if you want it gone. Safe to re-run.

begin;

-- 1. Restore the onboarding pieces
do $$ begin
    if to_regclass('public.onboarding_test_backup') is not null then
        update public.onboarding_steps s set active = b.active, service_keys = b.service_keys
          from public.onboarding_test_backup b where s.id = b.id;
        drop table public.onboarding_test_backup;
    end if;
end $$;

-- 2. The temporary service
delete from public.client_services where service_key = 'qtest';
delete from public.services where key = 'qtest';

-- 3. The test client and everything filed under it. Tables that may not exist yet are skipped.
do $$
declare t text;
begin
    foreach t in array array['onboarding_secret_reveals', 'onboarding_secrets', 'onboarding_private_answers', 'onboarding_answers',
                             'client_onboarding_progress', 'client_services', 'client_contacts', 'client_profiles',
                             'client_work_summaries', 'weekly_checkins',
                             -- its GHL account record (delete the account itself in GHL), so a new test client gets a new
                             -- account. The write log is kept: it's the history of what Golden Eye did in GHL.
                             'ghl_accounts'] loop
        if to_regclass('public.' || t) is not null then
            execute format('delete from public.%I where client_name = %L', t, 'GE Test Client');
        end if;
    end loop;
    delete from public.tasks where client = 'GE Test Client';
    delete from public.user_client_access where client_name = 'GE Test Client';
    delete from public.pre_approved_users where lower(email) = 'video+getest@midasmediafirm.com';
    delete from public.clients where name = 'GE Test Client';
end $$;

commit;

notify pgrst, 'reload schema';

-- Check: both must be 0
--   select count(*) from services where key = 'qtest';
--   select count(*) from clients where name = 'GE Test Client';
