-- Auto-check reconcile: tick off our own tasks that Golden Eye can see are done.
--
-- A task qualifies when:
--   - it's open (status isn't Complete)
--   - it came from a template with an auto_check: an agency onboarding step (task stage Onboarding,
--     same title) or a stage checklist item (same stage, same title). Tasks carry no template id,
--     so title + stage is the link, the same way generateStageTasks() dedupes.
--   - onboarding_auto_checks(client) says that check passes
-- It's set to Complete, with a line added to its notes saying why. Nothing is ever reopened: a
-- check that later fails (an ad account id removed, say) leaves the task as it is.
--
-- Runs in two places, both calling this one function:
--   - the admin dashboard on every load (app.js), so a task closes as soon as someone looks
--   - pg_cron daily (below), so tasks close even on days nobody opens the dashboard
-- Needs supabase/sql/service_onboarding.sql first.

create or replace function reconcile_auto_checks()
returns table (task_id tasks.id%type, client text, title text, check_key text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
    -- The schedule (no signed-in user) and admins only. It writes tasks for every client.
    if coalesce(auth.role(), '') not in ('', 'service_role') and not current_user_is_admin() then
        raise exception 'Only an admin can run the automatic checks.';
    end if;

    return query
    with templates as (
        select 'Onboarding'::text as stage, lower(btrim(s.title)) as title_key, s.auto_check
        from onboarding_steps s
        where s.auto_check is not null and coalesce(s.owner, 'client') = 'agency' and coalesce(s.active, true)
        union
        select t.stage, lower(btrim(t.task_title)), t.auto_check
        from stage_templates t
        where t.auto_check is not null
    ),
    candidates as (
        select k.id, k.client, k.title, tp.auto_check, cl.name as client_name
        from tasks k
        join templates tp on tp.stage = k.stage and tp.title_key = lower(btrim(coalesce(k.title, '')))
        join clients cl on lower(regexp_replace(cl.name, '[^a-zA-Z0-9]', '', 'g'))
                         = lower(regexp_replace(coalesce(k.client, ''), '[^a-zA-Z0-9]', '', 'g'))
        where coalesce(k.status, 'Not Started') <> 'Complete'
    ),
    passing as (
        -- Each client's checks run once, however many of their tasks are waiting
        select c.client_name, ch.check_key, ch.label
        from (select distinct client_name from candidates) c
        cross join lateral onboarding_auto_checks(c.client_name) ch
        where ch.passed
    ),
    done as (
        update tasks k
        set status = 'Complete',
            updated_at = now(),
            notes = concat_ws(E'\n', nullif(k.notes, ''), 'Ticked off automatically: ' || p.label || ' (' || to_char(now() at time zone 'America/Denver', 'Mon DD') || ').')
        from candidates c
        join passing p on p.client_name = c.client_name and p.check_key = c.auto_check
        where k.id = c.id
        returning k.id, k.client, k.title, c.auto_check
    )
    select d.id, d.client, d.title, d.auto_check from done d;
end;
$$;

revoke execute on function reconcile_auto_checks() from public;
do $$ begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        execute 'revoke execute on function reconcile_auto_checks() from anon';
    end if;
end $$;
grant execute on function reconcile_auto_checks() to authenticated;

-- Daily at 19:30 UTC: after seo-sync (18:00) and seranking-sync (19:00), so the Search Console
-- and SE Ranking checks see that day's data. The 08:00-local ads pull is long done by then.
-- Plain SQL, so no pg_net call and no timeout to worry about. Scheduling the same name again
-- replaces it, so re-running this file is safe.
do $$ begin
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        perform cron.schedule('onboarding-auto-checks', '30 19 * * *', 'select count(*) from reconcile_auto_checks()');
    end if;
end $$;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Checking on it
-- ---------------------------------------------------------------------------
-- What would each client's checks say right now?
--   select * from onboarding_auto_checks('3Sixty Industries');
-- Open tasks waiting on a check (nothing is changed by this):
--   select k.client, k.title, k.stage, coalesce(s.auto_check, t.auto_check) as auto_check
--   from tasks k
--   left join onboarding_steps s on k.stage = 'Onboarding' and lower(btrim(s.title)) = lower(btrim(k.title)) and s.auto_check is not null
--   left join stage_templates t on t.stage = k.stage and lower(btrim(t.task_title)) = lower(btrim(k.title)) and t.auto_check is not null
--   where coalesce(k.status, '') <> 'Complete' and coalesce(s.auto_check, t.auto_check) is not null;
-- Did the schedule run?
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'onboarding-auto-checks')
--   order by start_time desc limit 5;
-- Undo the schedule:
--   select cron.unschedule('onboarding-auto-checks');
