-- Check every onboarding client against our Midas GHL each morning at 14:00 UTC (8am Mountain in summer, 7am in winter),
-- before the team starts. Run AFTER ghl_contact_check.sql and deploying the function. Copies the anon key from the
-- working meta-sync job, so no key is pasted here. Safe to re-run.

select cron.unschedule('ghl-contact-check') where exists (select 1 from cron.job where jobname = 'ghl-contact-check');

select cron.schedule(
    'ghl-contact-check',
    '0 14 * * *',
    format($job$
    select net.http_post(
        url     := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/ghl-contact-check',
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer %s',
            'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'make_onboarding_hook_secret')
        ),
        body    := '{"mode":"check"}'::jsonb,
        timeout_milliseconds := 60000
    );
    $job$, (select substring(command from 'Bearer ([^'']+)''') from cron.job where jobname = 'meta-sync-daily'))
);

-- Run one now, from the SQL Editor (then read the answer in net._http_response):
--   select net.http_post(
--       url     := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/ghl-contact-check',
--       headers := jsonb_build_object('Content-Type', 'application/json',
--                  'Authorization', 'Bearer ' || (select substring(command from 'Bearer ([^'']+)''') from cron.job where jobname = 'meta-sync-daily'),
--                  'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'make_onboarding_hook_secret')),
--       body    := '{"mode":"check"}'::jsonb, timeout_milliseconds := 60000);
--   select created, status_code, left(content, 800) from net._http_response order by created desc limit 3;
