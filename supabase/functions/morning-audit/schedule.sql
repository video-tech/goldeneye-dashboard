-- KEY: <CURRENT ANON KEY> is a placeholder. The key that used to be written here was stale, and on
-- 2026-09-15 it broke the morning-audit and client-summary jobs with "Invalid JWT". Don't paste a key
-- from an old file. After scheduling, copy the key from a job that works:
--   with good as (select substring(command from 'Bearer ([^'']+)''') as k from cron.job where jobname = 'seo-sync-daily')
--   select cron.alter_job(j.jobid, command := regexp_replace(j.command, 'Bearer [^'']+', 'Bearer ' || (select k from good)))
--   from cron.job j where j.jobname = '<this job>';
-- (or take it from Supabase → Project Settings → API keys → anon).

-- Schedule the morning audit. Run this once in the Supabase SQL Editor, after
-- `supabase functions deploy morning-audit` has succeeded.
--
-- No Make scenario is involved: pg_cron holds the schedule and pg_net makes the call,
-- the same pair already behind checkin-reminder-am/pm.
--
-- The Authorization header carries the **anon** key, not service_role: it only gets the
-- request past the gateway. Putting service_role in a cron definition would store full
-- database access in a table any SQL user can read.
--
-- The anon key is NOT what lets this job run the audit — it's public, and until
-- 2026-09-16 that was exactly the hole. The function now requires a signed-in admin or
-- `x-cron-secret`, which this job reads from Vault at run time (so cron.job stores the
-- lookup, never the value). An existing job was migrated with
-- supabase/sql/morning_audit_cron_secret.sql.

select cron.schedule(
    'morning-audit',
    -- 16:00 UTC = 10:00 MDT in summer, 09:00 MST in winter.
    --
    -- pg_cron runs in UTC and does not follow daylight saving, so the local time shifts
    -- an hour twice a year — the same drift already noted on the check-in reminders.
    -- 16:00 was chosen so BOTH sides of that drift stay clear of the 08:00 ads pull.
    -- 15:00 UTC would be 08:00 MST in winter, landing right on top of it.
    --
    -- Mon-Fri only. Nobody reads this on a Saturday, and Monday's 28-day baseline
    -- covers the weekend regardless.
    '0 16 * * 1-5',
    $$
    select net.http_post(
        url     := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/morning-audit',
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer <CURRENT ANON KEY>',
            'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'make_onboarding_hook_secret')
        ),
        body    := '{}'::jsonb,
        -- pg_net gives up after 5s by default, far shorter than these functions run
        timeout_milliseconds := 150000
    );
    $$
);


-- ---------------------------------------------------------------------------
-- Optional: a second attempt an hour later
-- ---------------------------------------------------------------------------
-- The function is idempotent — it returns {"skipped": ...} when a card already exists
-- for today — so this costs nothing on a normal morning and only does work when the
-- 16:00 run failed outright, or when the ads pull had not landed in time.
--
-- select cron.schedule(
--     'morning-audit-retry',
--     '0 17 * * 1-5',
--     $$
--     select net.http_post(
--         url     := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/morning-audit',
--         headers := jsonb_build_object(
--             'Content-Type',  'application/json',
--             'Authorization', 'Bearer <same anon key as above>',
--             'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'make_onboarding_hook_secret')
--         ),
--         body    := '{}'::jsonb,
--         -- pg_net gives up after 5s by default, far shorter than these functions run
--         timeout_milliseconds := 150000
--     );
--     $$
-- );


-- ---------------------------------------------------------------------------
-- Checking on it
-- ---------------------------------------------------------------------------

-- Is it scheduled?
--   select jobid, jobname, schedule, active from cron.job where jobname like 'morning-audit%';

-- Did the job fire?
--   select * from cron.job_run_details
--    where jobname = 'morning-audit'
--    order by start_time desc limit 10;

-- pg_net is ASYNCHRONOUS: the row above goes green when the request is *queued*, not
-- when it succeeded. This is where the real HTTP result lives:
--   select id, status_code, content, created from net._http_response
--    order by created desc limit 10;

-- Did a card actually land?
--   select id, created_at, left(html_body, 120) from morning_audits
--    order by created_at desc limit 5;

-- Rescheduling or removing:
--   select cron.unschedule('morning-audit');
