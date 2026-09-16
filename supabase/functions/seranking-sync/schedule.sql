-- KEY: <CURRENT ANON KEY> is a placeholder. The key that used to be written here was stale, and on
-- 2026-09-15 it broke the morning-audit and client-summary jobs with "Invalid JWT". Don't paste a key
-- from an old file. After scheduling, copy the key from a job that works:
--   with good as (select substring(command from 'Bearer ([^'']+)''') as k from cron.job where jobname = 'seo-sync-daily')
--   select cron.alter_job(j.jobid, command := regexp_replace(j.command, 'Bearer [^'']+', 'Bearer ' || (select k from good)))
--   from cron.job j where j.jobname = '<this job>';
-- (or take it from Supabase → Project Settings → API keys → anon).

-- Schedule the SE Ranking sync. Run once in the SQL Editor after
-- `supabase functions deploy seranking-sync` has succeeded and schema.sql has been applied.
--
-- One job, unlike seo-sync's daily/backfill pair. Rank-tracking history is small — a
-- project's own history starts the day a keyword was added, not 16 months ago — so there's
-- no month-by-month backfill to walk. Each run re-fetches the trailing 35 days and upserts,
-- which naturally catches anything a missed run would have skipped.

select cron.schedule(
    'seranking-sync-daily',
    -- 19:00 UTC: an hour after seo-sync-daily (18:00), so a look at both tables together
    -- (SE Ranking rank next to that day's GSC clicks) never straddles a partial run of
    -- either. SE Ranking's own checks run on their schedule, not ours — this just reads
    -- whatever they've already recorded by this time of day.
    '0 19 * * *',
    $job$
    select net.http_post(
        url     := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/seranking-sync',
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer <CURRENT ANON KEY>'
        ),
        body    := '{"mode":"sync"}'::jsonb,
        -- pg_net gives up after 5s by default, far shorter than these functions run
        timeout_milliseconds := 150000
    );
    $job$
);

-- The Authorization header carries the anon key, same reasoning as every other cron job in
-- this project: it satisfies Supabase's edge-function gateway, not who is allowed to sync.
-- The function's own privileged reads and writes use the service_role key already in its
-- environment; SERANKING_API_KEY is a separate secret, read inside the function.

-- ---------------------------------------------------------------------------
-- Content ideas — a second, MONTHLY job. Added 2026-09-16 with supabase/sql/seo_content_ideas.sql.
-- ---------------------------------------------------------------------------
-- Unlike the daily rank sync above, this spends real SE Ranking Data API units (see the cost
-- comment on syncContentIdeasForClient in index.ts) — approved sizing is 5 seed keywords per
-- client, at most 875 units per client per run. The function itself also refuses to run twice in
-- the same calendar month per client even if this job fires more often, and checks the account's
-- remaining units before spending anything.
select cron.schedule(
    'seranking-content-ideas-monthly',
    -- 1st of the month, 10:00 UTC — after that day's seo-sync (18:00) and seranking-sync-daily
    -- (19:00) runs from the day before have already landed, so seo_keywords.search_volume (which
    -- seed selection reads) is current when this picks its seeds.
    '0 10 1 * *',
    $job$
    select net.http_post(
        url     := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/seranking-sync',
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer <CURRENT ANON KEY>'
        ),
        body    := '{"mode":"content_ideas"}'::jsonb,
        timeout_milliseconds := 150000
    );
    $job$
);
-- select client_name, last_daily_run, last_error from seo_sync_state where source = 'content_ideas';
-- select cron.unschedule('seranking-content-ideas-monthly');

-- ---------------------------------------------------------------------------
-- Checking on it
-- ---------------------------------------------------------------------------

-- select jobid, jobname, schedule, active from cron.job where jobname = 'seranking-sync-daily';
-- select * from cron.job_run_details where jobname = 'seranking-sync-daily' order by start_time desc limit 10;

-- pg_net is ASYNCHRONOUS: job_run_details goes green when the request was queued, not
-- when it succeeded. The real answer is here.
-- select id, status_code, left(content, 500), created from net._http_response order by created desc limit 10;

-- Per-client sync health — a repeated last_error here means that client's shape or access
-- broke, without needing to dig through function logs:
-- select client_name, last_daily_run, last_error from seo_sync_state where source = 'seranking';

-- What actually landed:
-- select client_name, count(*) tracked_keywords from seo_keywords group by 1;
-- select client_name, count(*) checks, max(date) latest from seo_rank_checks group by 1;

-- ---------------------------------------------------------------------------
-- Undo
-- ---------------------------------------------------------------------------
-- select cron.unschedule('seranking-sync-daily');
