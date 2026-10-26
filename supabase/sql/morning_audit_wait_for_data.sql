-- A 9:00 Mountain morning (2026-10-23). Run in the SQL Editor AFTER deploying the morning-audit function
-- that waits for the data (readiness.js); the old function would run its audit on the first 15:00 UTC call.
-- Safe to re-run.
--
-- WHY. Facebook publishes some accounts' "yesterday" late: 3Sixty and Alta Vista were still empty at 8:30
-- Mountain on Oct 21 and 22 and present by 9:30. So instead of fixed times:
--   1. ads_pull_missing: the clients Make pulls that have no row for yesterday yet. Make's second pull reads
--      this view every 15 minutes from 8:30 to 9:45 Mountain, so it only asks Facebook about accounts still
--      missing (a run with nobody missing is one Make operation and no Facebook call).
--   2. The morning audit is called every 15 minutes from 15:00 to 17:45 UTC on weekdays. The function itself
--      decides in Mountain time: from 9:00 it runs as soon as every steady spender has yesterday's row, and at
--      10:00 it runs anyway, naming who is missing. Today's card makes every later call a no-op.
--   3. The "pull is missing" text to Tenny goes at 10:05 Mountain in both seasons: two cron times, and a
--      wrapper that only acts in the 10 o'clock Mountain hour. pg_cron runs in UTC and ignores daylight saving.
--   4. meta-sync runs earlier and fills in late accounts, so yesterday's per-ad rows are in for the audit's
--      "ads to turn off" (the audit also waits for them until 10:00).

begin;

-- 1. Who the second pull still needs. A plain view runs with its owner's rights and skips the tables' RLS,
--    so nobody signed in may read it: only service_role (Make's Supabase connection) can.
create or replace view public.ads_pull_missing as
select c.name, c.ad_account_id, c.business_id, c.client_email, c.status
from public.clients c
where coalesce(c.status, 'active') not in ('paused', 'archived')
  and nullif(btrim(c.ad_account_id), '') is not null
  and nullif(btrim(c.business_id), '') is not null
  and not exists (
      select 1 from public.daily_reports r
      where regexp_replace(coalesce(r.ad_account_id, ''), '\D', '', 'g') = regexp_replace(c.ad_account_id, '\D', '', 'g')
        and r.date = (now() at time zone 'America/Denver')::date - 1);

comment on view public.ads_pull_missing is
    'Clients the Make ads pull covers that have no daily_reports row for yesterday (Mountain). Read by the second pull (Make scenario 6720819). service_role only.';

revoke all on public.ads_pull_missing from public, anon, authenticated;
grant select on public.ads_pull_missing to service_role;

-- 3. The pull-missing text, only in the 10 o'clock Mountain hour (see daily_pull_check.sql for the check itself)
create or replace function public.daily_pull_check_scheduled(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
    if extract(hour from (p_now at time zone 'America/Denver')) <> 10 then
        return jsonb_build_object('skipped', 'only runs at 10 Mountain', 'denver_time', to_char(p_now at time zone 'America/Denver', 'HH24:MI'));
    end if;
    return public.daily_pull_check();
end;
$$;

revoke execute on function public.daily_pull_check_scheduled(timestamptz) from public, anon, authenticated;

commit;

-- 2 and 3. The schedules (UTC). The commands stay as they are for the audit; the pull check calls the wrapper.
select cron.alter_job((select jobid from cron.job where jobname = 'morning-audit'), schedule := '*/15 15-17 * * 1-5');
select cron.alter_job((select jobid from cron.job where jobname = 'daily-pull-check'),
                      schedule := '5 16,17 * * *',
                      command  := 'select public.daily_pull_check_scheduled()');

-- 4. Yesterday's per-ad rows before the audit (2026-10-23: the audit lists the ads to turn off from them).
--    The full meta-sync moves from 15:30 to 14:30 UTC (8:30 MDT / 7:30 MST), and meta-sync-fill re-asks Meta
--    every 15 minutes, 15:00 to 17:45 UTC on weekdays, about accounts that spent yesterday and still have no ad
--    rows for it. With nobody missing a call makes no request to Meta. Deploy meta-sync (with mode "fill") first.
--    The fill job copies meta-sync-daily's command (its key and headers), changing only the body.
do $$
declare cmd text;
begin
    select command into cmd from cron.job where jobname = 'meta-sync-daily';
    if cmd is null or position('''{}''::jsonb' in cmd) = 0 then
        raise exception 'meta-sync-daily not found, or its body is not {}: schedule meta-sync first (meta-sync/schedule.sql)';
    end if;
    perform cron.unschedule(jobid) from cron.job where jobname = 'meta-sync-fill';
    perform cron.schedule('meta-sync-fill', '*/15 15-17 * * 1-5', replace(cmd, '''{}''::jsonb', '''{"mode":"fill"}''::jsonb'));
    perform cron.alter_job((select jobid from cron.job where jobname = 'meta-sync-daily'), schedule := '30 14 * * *');
end $$;

-- Check: every job on its new time, and who the second pull would ask about right now
select jobname, schedule, command like '%daily_pull_check_scheduled%' as guarded, command like '%"mode":"fill"%' as fill
from cron.job where jobname in ('morning-audit', 'daily-pull-check', 'meta-sync-daily', 'meta-sync-fill') order by jobname;
select name from public.ads_pull_missing order by name;
