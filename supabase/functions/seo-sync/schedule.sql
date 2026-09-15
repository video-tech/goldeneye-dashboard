-- KEY: <CURRENT ANON KEY> is a placeholder. The key that used to be written here was stale, and on
-- 2026-09-15 it broke the morning-audit and client-summary jobs with "Invalid JWT". Don't paste a key
-- from an old file. After scheduling, copy the key from a job that works:
--   with good as (select substring(command from 'Bearer ([^'']+)''') as k from cron.job where jobname = 'seo-sync-daily')
--   select cron.alter_job(j.jobid, command := regexp_replace(j.command, 'Bearer [^'']+', 'Bearer ' || (select k from good)))
--   from cron.job j where j.jobname = '<this job>';
-- (or take it from Supabase → Project Settings → API keys → anon).

-- Schedule the Search Console sync. Run once in the SQL Editor after
-- `supabase functions deploy seo-sync` has succeeded and schema.sql has been applied.
--
-- Two jobs, because the two halves have nothing in common: one keeps every client
-- current, the other fills in a new client's past and then never does anything again.

-- ---------------------------------------------------------------------------
-- 1. The rolling daily window
-- ---------------------------------------------------------------------------
select cron.schedule(
    'seo-sync-daily',
    -- 18:00 UTC = 12:00 MDT / 11:00 MST. Clear of the 16:00 morning audit, the 16:05
    -- client summary and — on both sides of the daylight-saving drift pg_cron does not
    -- follow — the 08:00 local Meta pull.
    --
    -- EVERY day, not Mon-Fri. Weekend traffic is still traffic, and unlike the audit
    -- (which nobody reads on a Saturday) this is data collection: a day skipped is a
    -- day that has to be picked up later or lost. The 10-day window would in fact
    -- recover it, but there is no reason to lean on that.
    '0 18 * * *',
    $job$
    select net.http_post(
        url     := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/seo-sync',
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer <CURRENT ANON KEY>'
        ),
        body    := '{"mode":"daily"}'::jsonb,
        -- pg_net gives up after 5s by default, far shorter than these functions run
        timeout_milliseconds := 150000
    );
    $job$
);

-- ---------------------------------------------------------------------------
-- 2. The backfill
-- ---------------------------------------------------------------------------
select cron.schedule(
    'seo-sync-backfill',
    -- Every 15 minutes, permanently. This is not as wasteful as it looks: once every
    -- client shows backfill_done, each run is a couple of cheap queries and returns in
    -- well under a second without touching Google at all.
    --
    -- It stays scheduled precisely so nobody has to remember it. The moment a Search
    -- Console property is typed into a client's record, that client's 16 months start
    -- arriving on their own — four months per run, so about an hour from nothing to a
    -- full history, with no button to press and nothing to watch.
    '*/15 * * * *',
    $job$
    select net.http_post(
        url     := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/seo-sync',
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer <CURRENT ANON KEY>'
        ),
        body    := '{"mode":"backfill"}'::jsonb,
        -- pg_net gives up after 5s by default, far shorter than these functions run
        timeout_milliseconds := 150000
    );
    $job$
);

-- The Authorization header carries the anon key, same as morning-audit and
-- client-summary. It is not deciding who is allowed to sync — it satisfies Supabase's
-- edge-function gateway, which wants a valid project JWT before our code runs at all.
-- The function's own privileged reads and writes use the service_role key already in
-- its environment. The two modes that cost something on demand — force and check —
-- verify a real signed-in admin inside the function instead.

-- ---------------------------------------------------------------------------
-- Checking on it
-- ---------------------------------------------------------------------------

-- select jobid, jobname, schedule, active from cron.job where jobname like 'seo-sync%';
-- select * from cron.job_run_details where jobname like 'seo-sync%' order by start_time desc limit 10;

-- pg_net is ASYNCHRONOUS: job_run_details goes green when the request was queued, not
-- when it succeeded. The real answer is here.
-- select id, status_code, left(content, 500), created from net._http_response order by created desc limit 10;

-- Progress of the backfill, and any client whose access has broken:
-- select client_name, source, backfill_cursor, backfill_done, last_daily_run, last_error
--   from seo_sync_state order by client_name;

-- What actually landed:
-- select client_name, count(*) days, min(date) first_day, max(date) last_day, sum(clicks) clicks
--   from seo_daily group by 1 order by 1;

-- ---------------------------------------------------------------------------
-- Undo
-- ---------------------------------------------------------------------------
-- select cron.unschedule('seo-sync-daily');
-- select cron.unschedule('seo-sync-backfill');
