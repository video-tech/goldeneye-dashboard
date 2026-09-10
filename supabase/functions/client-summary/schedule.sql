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
            'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh1Z250dHNxdWNldGxkbGxmZ29pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1NzUyODcsImV4cCI6MjA4ODE1MTI4N30.OjUwMHZ-ZQLMtY__gktnY4RneMw7RWXLMKdHzcTWWgQ'
        ),
        body    := '{}'::jsonb
    );
    $$
);

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
