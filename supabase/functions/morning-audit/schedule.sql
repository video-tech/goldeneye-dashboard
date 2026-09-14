-- Schedule the morning audit. Run this once in the Supabase SQL Editor, after
-- `supabase functions deploy morning-audit` has succeeded.
--
-- No Make scenario is involved: pg_cron holds the schedule and pg_net makes the call,
-- the same pair already behind checkin-reminder-am/pm.
--
-- The Authorization header carries the **anon** key, not service_role, and that is
-- deliberate. The caller only has to satisfy the edge function's JWT check; the
-- function does its own privileged reads with the service_role key already in its
-- environment. So there is nothing sensitive to protect here — the anon key is public
-- in the dashboard page anyway — and no Vault secret to create, rotate, or get wrong.
-- Putting service_role in a cron definition would store full database access in a
-- table any SQL user can read, to buy nothing.

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
            'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh1Z250dHNxdWNldGxkbGxmZ29pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1NzUyODcsImV4cCI6MjA4ODE1MTI4N30.OjUwMHZ-ZQLMtY__gktnY4RneMw7RWXLMKdHzcTWWgQ'
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
--             'Authorization', 'Bearer <same anon key as above>'
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
