-- Schedule ghl-account's sweep every 10 minutes. Run AFTER supabase/sql/ghl_accounts.sql and deploying the function.
-- The sweep is cheap when there's nothing to do (a few database reads, no GHL call), and it is what notices the
-- install click and fills the account, so nobody has to press anything after installing the app.
-- The anon key is copied from the working meta-sync job, so no key is pasted here. Safe to re-run.

select cron.unschedule('ghl-account-sweep') where exists (select 1 from cron.job where jobname = 'ghl-account-sweep');

select cron.schedule(
    'ghl-account-sweep',
    '*/10 * * * *',
    format($job$
    select net.http_post(
        url     := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/ghl-account',
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer %s',
            'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'make_onboarding_hook_secret')
        ),
        body    := '{"mode":"sweep"}'::jsonb,
        timeout_milliseconds := 120000
    );
    $job$, (select substring(command from 'Bearer ([^'']+)''') from cron.job where jobname = 'meta-sync-daily'))
);

-- Check it ran and what it said (pg_net is asynchronous: the job goes green when queued, the answer is here):
--   select start_time, status, return_message from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'ghl-account-sweep') order by start_time desc limit 5;
--   select created, status_code, left(content, 600) from net._http_response order by created desc limit 5;
--
-- Run one now, from the SQL Editor:
--   select net.http_post(
--       url     := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/ghl-account',
--       headers := jsonb_build_object('Content-Type', 'application/json',
--                  'Authorization', 'Bearer ' || (select substring(command from 'Bearer ([^'']+)''') from cron.job where jobname = 'meta-sync-daily'),
--                  'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'make_onboarding_hook_secret')),
--       body    := '{"mode":"sweep"}'::jsonb, timeout_milliseconds := 120000);
