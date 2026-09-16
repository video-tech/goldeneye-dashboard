-- Make the client-summary cron job prove itself (2026-09-16). Same change as
-- supabase/sql/morning_audit_cron_secret.sql, for the other scheduled AI function.
--
-- Run this in the SQL Editor BEFORE deploying the client-summary version that checks callers.
-- The function deployed today ignores the new header, so this changes nothing until then.
--
-- The secret is looked up in Vault each time the job runs, so cron.job stores the lookup, never
-- the value. The existing Authorization key is kept exactly as it is.

with cur as (
    select jobid, substring(command from 'Bearer ([^'']+)''') as anon_key
    from cron.job
    where jobname = 'client-summary'
)
select cron.alter_job(
    cur.jobid,
    command := format($cmd$
    select net.http_post(
        url     := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/client-summary',
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer %s',
            'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'make_onboarding_hook_secret')
        ),
        body    := '{}'::jsonb,
        timeout_milliseconds := 150000
    );
    $cmd$, cur.anon_key)
)
from cur
where cur.anon_key is not null;

-- Check: one row, and all three are true.
select jobname, schedule, active,
       command like '%x-cron-secret%'                    as sends_cron_secret,
       command like '%make_onboarding_hook_secret%'      as reads_it_from_vault,
       substring(command from 'Bearer (eyJ)')  = 'eyJ'  as key_kept
from cron.job
where jobname = 'client-summary';
