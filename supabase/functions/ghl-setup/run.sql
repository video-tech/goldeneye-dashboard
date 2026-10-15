-- ghl-setup from the SQL Editor. Run each call on its own, then read the answer with the last query.
-- Headers are copied from the meta-sync-daily job (anon key + the cron secret from Vault).

-- 1. Check: what Master has against the plan's 22 custom values. Writes nothing.
select net.http_post(
    url := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/ghl-setup',
    headers := (select jsonb_build_object('Content-Type','application/json',
                 'Authorization', 'Bearer ' || substring(command from 'Bearer ([^'']+)'''),
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'make_onboarding_hook_secret'))
                from cron.job where jobname = 'meta-sync-daily'),
    body := '{"mode":"check"}'::jsonb, timeout_milliseconds := 60000);

-- 2. Create the missing ones (empty). Only once the check's list looks right.
-- select net.http_post(
--     url := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/ghl-setup',
--     headers := (select jsonb_build_object('Content-Type','application/json',
--                  'Authorization', 'Bearer ' || substring(command from 'Bearer ([^'']+)'''),
--                  'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'make_onboarding_hook_secret'))
--                 from cron.job where jobname = 'meta-sync-daily'),
--     body := '{"mode":"create","confirm":true}'::jsonb, timeout_milliseconds := 120000);

-- Read the answer (give it a few seconds):
-- select id, status_code, content::jsonb, created from net._http_response order by created desc limit 1;
