-- Two reminders so a new opt-in (form, funnel, survey, Meta instant form) always gets its GHL workflow (2026-11-12).
--
-- 1. A step in the "Launch ads" checklist (Campaign Building), before the ads are built in Meta: using a new form, funnel or
--    survey? Click Add a new opt-in on Our checklist. Also added to clients whose Launch ads task is still open.
-- 2. raise_new_meta_optin_checks(): meta-sync records every change in each client's Meta account (meta_activity). When someone
--    creates a campaign or an ad set (create_campaign_group / create_ad_set, never Meta's own changes), this raises one task for
--    that client, "New in Meta: a new form or funnel?", listing what was created, hidden from the client. While that task is
--    open, later creations are added to its notes instead of raising another. meta_optin_prompts remembers which events were
--    already raised, and everything in meta_activity when this file is first run is marked as seen, so there is no backlog.
--    Skipped: clients not active, in Onboarding (their setup checklist builds the funnel), or No Base (their own GHL).
--    New ads alone don't raise it: they're created by the hundred (Meta duplicates), and a new form or funnel nearly always
--    comes with a new ad set or campaign. pg_cron runs it daily at 19:15 UTC, after meta-sync and its morning fills.
-- Plain ASCII: "~" in a title stands for the long dash, chr(8212). Safe to re-run.

begin;

-- 1. The Launch ads step -------------------------------------------------------------------------------------------------
create temporary table optin_step (title text, notes text) on commit drop;
insert into optin_step values (
    replace('Opt-in ~ Using a new form, funnel, survey or Meta instant form? Click Add a new opt-in', '~', chr(8212)),
    'Before the ads are built: if any ad sends people to a form, funnel, survey or Meta instant form this client has not used before, '
    || 'open Our checklist (Health tab) and click Add a new opt-in. Its steps say which GHL workflow to change, so the leads get '
    || '"ge lead" and reach Golden Eye (and Meta, for funnel leads). Nothing new? Tick this off.'
);

-- Make room at position 3 (before "Build the ads in Meta"), once
update public.stage_templates set sort_order = sort_order + 1
 where stage = 'Campaign Building' and checklist_group = 'Launch ads' and sort_order >= 3
   and not exists (select 1 from public.stage_templates t, optin_step s where t.stage = 'Campaign Building' and t.task_title = s.title);

insert into public.stage_templates (stage, task_title, due_days, service_keys, website_statuses, fact_conditions, default_notes, checklist_group, task_type, sort_order)
select 'Campaign Building', s.title, 2, '{ads}', '{}', '{}'::jsonb, s.notes, 'Launch ads', 'Setup step', 3
  from optin_step s
 where not exists (select 1 from public.stage_templates t where t.stage = 'Campaign Building' and t.task_title = s.title);

insert into public.tasks (client, title, type, stage, status, checklist_group, client_visible, notes, due, p, u, e, score, updated_at)
select g.client, s.title, 'Setup step', 'Campaign Building', 'Not Started', 'Launch ads', false, s.notes,
       current_date + 2, 3, 3, 3, 60, now()
  from public.tasks g cross join optin_step s
 where g.title = 'Launch ads' and g.stage = 'Campaign Building' and coalesce(g.status, '') <> 'Complete' and g.archived_at is null
   and not exists (select 1 from public.tasks x where x.client = g.client and x.stage = 'Campaign Building' and x.title = s.title);

-- 2. Reminders from Meta's change log ------------------------------------------------------------------------------------
create table if not exists public.meta_optin_prompts (
    event_key  text primary key,
    task_id    bigint,
    seen_at    timestamptz not null default now()
);
alter table public.meta_optin_prompts enable row level security;
drop policy if exists "Admins read optin prompts" on public.meta_optin_prompts;
create policy "Admins read optin prompts" on public.meta_optin_prompts for select using (current_user_is_admin());

-- Everything already in the log counts as seen: no backlog of reminders for old campaigns
insert into public.meta_optin_prompts (event_key, task_id)
select event_key, null from public.meta_activity
 where event_type in ('create_campaign_group', 'create_ad_set')
on conflict (event_key) do nothing;

create or replace function public.raise_new_meta_optin_checks()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
    v_title constant text := 'New in Meta: a new form or funnel?';
    v_intro constant text := 'Someone built something new in this client''s Meta account. If any of it sends people to a form, funnel, '
        || 'survey or Meta instant form they haven''t used before, open Our checklist (Health tab) and click Add a new opt-in, so its '
        || 'leads get "ge lead" and reach Golden Eye. Nothing new? Mark this done.';
    r record;
    v_task bigint;
    v_lines text;
    v_raised integer := 0;
begin
    -- The schedule runs with no signed-in user; anyone signed in must be an admin
    if auth.uid() is not null and not current_user_is_admin() then
        raise exception 'Only an admin can run this.';
    end if;

    for r in
        select a.client_name, c.current_stage,
               array_agg(a.event_key order by a.event_time) as keys,
               string_agg(
                   '- ' || to_char(a.event_time at time zone 'America/Denver', 'Mon DD') || ': new '
                   || case a.event_type when 'create_campaign_group' then 'campaign' else 'ad set' end
                   || ' "' || coalesce(nullif(a.object_name, ''), a.object_id, 'unnamed') || '"'
                   || coalesce(' (' || nullif(a.actor_name, '') || ')', ''),
                   chr(10) order by a.event_time) as lines
          from public.meta_activity a
          join public.clients c on c.name = a.client_name
         where a.event_type in ('create_campaign_group', 'create_ad_set')
           and not coalesce(a.actor_is_meta, false)
           and c.status = 'active'
           and coalesce(c.current_stage, '') not in ('', 'Onboarding')
           and coalesce(c.base_package, 'yes') <> 'no'
           and not exists (select 1 from public.meta_optin_prompts p where p.event_key = a.event_key)
         group by a.client_name, c.current_stage
    loop
        v_lines := r.lines;
        select t.id into v_task from public.tasks t
         where t.client = r.client_name and t.title = v_title and coalesce(t.status, '') <> 'Complete' and t.archived_at is null
         order by t.id desc limit 1;

        if v_task is null then
            insert into public.tasks (client, title, type, stage, status, client_visible, notes, due, p, u, e, score, updated_at)
            values (r.client_name, v_title, 'Checklist', r.current_stage, 'Not Started', false,
                    v_intro || chr(10) || chr(10) || v_lines, current_date + 1, 3, 4, 2, 72, now())
            returning id into v_task;
        else
            update public.tasks set notes = coalesce(notes, '') || chr(10) || v_lines, updated_at = now() where id = v_task;
        end if;

        insert into public.meta_optin_prompts (event_key, task_id)
        select unnest(r.keys), v_task
        on conflict (event_key) do nothing;
        v_raised := v_raised + 1;
    end loop;

    return v_raised;
end;
$fn$;

revoke execute on function public.raise_new_meta_optin_checks() from public, anon;
grant execute on function public.raise_new_meta_optin_checks() to authenticated;

commit;

-- The schedule (pg_cron runs in UTC): daily after meta-sync's 14:30 run and its fills, which end by 17:45
select cron.unschedule('meta-optin-checks') where exists (select 1 from cron.job where jobname = 'meta-optin-checks');
select cron.schedule('meta-optin-checks', '15 19 * * *', 'select public.raise_new_meta_optin_checks()');

notify pgrst, 'reload schema';
