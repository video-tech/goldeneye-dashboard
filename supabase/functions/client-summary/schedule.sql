-- KEY: <CURRENT ANON KEY> is a placeholder. The key that used to be written here was stale, and on
-- 2026-09-15 it broke the morning-audit and client-summary jobs with "Invalid JWT". Don't paste a key
-- from an old file. After scheduling, copy the key from a job that works:
--   with good as (select substring(command from 'Bearer ([^'']+)''') as k from cron.job where jobname = 'seo-sync-daily')
--   select cron.alter_job(j.jobid, command := regexp_replace(j.command, 'Bearer [^'']+', 'Bearer ' || (select k from good)))
--   from cron.job j where j.jobname = '<this job>';
-- (or take it from Supabase → Project Settings → API keys → anon).

-- Schedule the client work summary. Run once in the SQL Editor after
-- `supabase functions deploy client-summary` has succeeded.

select cron.schedule(
    'client-summary',
    -- A few minutes after the morning audit, mostly for tidiness rather than any real
    -- dependency — this reads tasks, not ad data, so it isn't tied to the 08:00 Meta
    -- pull the way the audit is. Mon-Fri: a trailing-7-day recap barely changes over a
    -- weekend with no staff activity, so a Saturday run would mostly restate Friday.
    '5 16 * * 1-5',
    $$
    select net.http_post(
        url     := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/client-summary',
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

-- x-cron-secret (added 2026-09-16) is what actually lets this job run: the function refuses
-- any caller without it or an admin sign-in. It's read from Vault when the job runs, so
-- cron.job stores only the lookup. An existing job was migrated with
-- supabase/sql/client_summary_cron_secret.sql. The note below about the anon key predates that:
-- it's still what gets past the gateway, but it no longer grants anything by itself.
--
-- The Authorization header carries the anon key, same as morning-audit's schedule.
-- This is not about who is *allowed* to run the summary — nothing outside this project
-- ever calls this function on its own — it is Supabase's edge-function gateway itself,
-- which requires a valid JWT on every request before your code ever runs, regardless of
-- caller. The function's own privileged reads use the service_role key already in its
-- environment; this header only gets the request past the gateway.

-- ---------------------------------------------------------------------------
-- Checking on it
-- ---------------------------------------------------------------------------

-- select jobid, jobname, schedule, active from cron.job where jobname = 'client-summary';
-- select * from cron.job_run_details where jobname = 'client-summary' order by start_time desc limit 10;
-- select id, status_code, content, created from net._http_response order by created desc limit 10;
-- select client_name, range_end, tasks_completed, tasks_open, left(summary, 100)
--   from client_work_summaries order by created_at desc limit 10;
