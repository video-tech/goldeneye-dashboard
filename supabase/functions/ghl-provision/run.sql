-- ghl-provision from the SQL Editor: the phase 0 account test. Run ONE call at a time, then read the
-- answer with the query at the bottom. Headers are copied from the meta-sync-daily job (anon key + cron secret).

-- 1. Find Master v1.0's snapshot id (read-only):
select net.http_post(
    url := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/ghl-provision',
    headers := (select jsonb_build_object('Content-Type','application/json',
                 'Authorization', 'Bearer ' || substring(command from 'Bearer ([^'']+)'''),
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'make_onboarding_hook_secret'))
                from cron.job where jobname = 'meta-sync-daily'),
    body := '{"mode":"snapshots"}'::jsonb, timeout_milliseconds := 60000);

-- 2. Create the test account. Paste the snapshot id in place of SNAPSHOT_ID:
--    body := '{"mode":"create_test","snapshot_id":"SNAPSHOT_ID","confirm":true}'::jsonb
-- 3. A minute later, see what arrived. Paste the new location id:
--    body := '{"mode":"inspect","location_id":"LOCATION_ID"}'::jsonb
-- 4. Write two test values and read them back:
--    body := '{"mode":"fill_test","location_id":"LOCATION_ID","confirm":true}'::jsonb

-- Read the answer:
-- select id, status_code, content::jsonb, created from net._http_response order by id desc limit 1;
