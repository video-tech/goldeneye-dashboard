-- Make the morning-audit cron job prove itself (2026-09-16).
--
-- Run this in the SQL Editor BEFORE deploying the morning-audit version that checks callers.
-- The function deployed today ignores the new header, so this changes nothing until then.
--
-- Why: morning-audit used to accept anyone holding the public anon key. The new version accepts a
-- signed-in admin, or this job sending `x-cron-secret`. The value is looked up in Vault each time
-- the job runs, so cron.job only ever stores the lookup, never the secret. It's the same Vault
-- secret the Postgres functions already send to Make, and the same value as the MAKE_WEBHOOK_SECRET
-- edge secret the function compares it to. Rotating that secret rotates this too; nothing else to
-- update.
--
-- The existing Authorization key is kept exactly as it is: it's the one that works (see the
-- "Invalid JWT" note in supabase/functions/morning-audit/schedule.sql).

with cur as (
    select jobid, substring(command from 'Bearer ([^'']+)''') as anon_key
    from cron.job
    where jobname = 'morning-audit'
)
select cron.alter_job(
    cur.jobid,
    command := format($cmd$
    select net.http_post(
        url     := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/morning-audit',
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

-- Check: one row, sends_cron_secret = true, and the key still looks like a JWT.
select jobname, schedule, active,
       command like '%x-cron-secret%'                    as sends_cron_secret,
       command like '%make_onboarding_hook_secret%'      as reads_it_from_vault,
       substring(command from 'Bearer (eyJ)')  = 'eyJ'  as key_kept
from cron.job
where jobname = 'morning-audit';
