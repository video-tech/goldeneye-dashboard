-- Schedule meta-sync. Run AFTER schema.sql, setting the token, and deploying:
--   supabase secrets set META_ACCESS_TOKEN=<System User token with ads_read>
--   supabase functions deploy meta-sync
--
-- KEY: <CURRENT ANON KEY> is a placeholder (see client-summary/schedule.sql for why). After
-- scheduling, copy the key from a job that works:
--   with good as (select substring(command from 'Bearer ([^'']+)''') as k from cron.job where jobname = 'seo-sync-daily')
--   select cron.alter_job(j.jobid, command := regexp_replace(j.command, 'Bearer [^'']+', 'Bearer ' || (select k from good)))
--   from cron.job j where j.jobname = 'meta-sync-daily';

-- Daily at 15:30 UTC (09:30 MDT / 08:30 MST): after the 08:00-local Make pull, before the 16:00
-- morning audit, in both daylight-saving states. Every day: weekend spend is still spend.
select cron.schedule(
    'meta-sync-daily',
    '30 15 * * *',
    $$
    select net.http_post(
        url     := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/meta-sync',
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer <CURRENT ANON KEY>',
            'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'make_onboarding_hook_secret')
        ),
        body    := '{}'::jsonb,
        timeout_milliseconds := 150000
    );
    $$
);

-- ---------------------------------------------------------------------------
-- One-off calls from the SQL Editor (same headers as the job; copy the key from it)
-- ---------------------------------------------------------------------------
-- Check the token can read every client's ad account, then read the answer in net._http_response:
--
-- select net.http_post(
--     url := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/meta-sync',
--     headers := (select jsonb_build_object('Content-Type','application/json',
--                  'Authorization', 'Bearer ' || substring(command from 'Bearer ([^'']+)'''),
--                  'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'make_onboarding_hook_secret'))
--                 from cron.job where jobname = 'meta-sync-daily'),
--     body := '{"mode":"check"}'::jsonb, timeout_milliseconds := 60000);
--
-- Backfill 90 days (change the body to '{"mode":"backfill","days":90}'). If the result lists a
-- client as "out of time this run", run it again with '{"mode":"backfill","days":90,"client":"<exact name>"}'.
--
-- select id, status_code, left(content::text, 2000), created from net._http_response order by created desc limit 3;

-- ---------------------------------------------------------------------------
-- Checking on it
-- ---------------------------------------------------------------------------
-- select * from meta_sync_state order by client_name;
-- select client_name, max(date), count(*) from meta_ad_daily group by 1;
-- select client_name, event_time, event_label, object_name, extra from meta_activity
--   where significant order by event_time desc limit 30;
