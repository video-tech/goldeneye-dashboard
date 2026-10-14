-- "Did yesterday's ad pull land?" check, texted to Tenny only (2026-10-14).
--
-- WHY: Make's daily ads pull (scenario "Midas Dashboard") stopped halfway on 2026-09-23 and again on
-- 2026-10-14 (Meta's app-level rate limit). Nobody was told; it was found by hand. Make can't send the
-- alert itself, because the Vault secret can't go into a scenario's blueprint, so the database checks.
--
-- WHEN: 13:30 UTC every day. The pull runs at 08:00 Eastern (12:00 UTC in summer, 13:00 in winter) and
-- takes about 3 minutes, so this is after it in both, and 2.5 hours before the 16:00 UTC morning audit.
--
-- WHAT COUNTS AS MISSING: a client Make is asked to pull (status not paused/archived, with an ad account
-- and a business id) that has NO daily_reports row for yesterday, but DID have one on at least 5 of the 7
-- days before. Make writes no row for a day with no spend, so a client whose ads are off, or who spends
-- on and off (Midas Contractor), would otherwise be reported every morning. Steady spenders only.
--
-- WHO GETS THE TEXT: Tenny, and only Tenny (decided 2026-10-14). The number is the constant below.
--
-- HOW IT TEXTS: the same Make scenario (#6) and payload shape as notify_task_assignee(): one recipient,
-- the Vault secret, one-line message. No change in Make. If the secret is missing nothing is sent.
--
-- Test without texting:   select daily_pull_check(false);
-- Look at an older day:   select daily_pull_check(false, '2026-10-13');
-- Run for real by hand:   select daily_pull_check();
--
-- Run once in the SQL Editor. Safe to re-run.

begin;

create or replace function public.daily_pull_check(p_send boolean default true, p_day date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_hook constant text := 'https://hook.us2.make.com/c8l92w09rw5jrncifjxif0b8r1yf89ha';
    v_phone constant text := '+18017098501';
    v_day date := coalesce(p_day, current_date - 1);
    v_missing text[];
    v_steady int;
    v_secret text;
    v_msg text;
begin
    create temporary table if not exists _pull_steady (name text, acct text) on commit drop;
    truncate _pull_steady;

    insert into _pull_steady (name, acct)
    select c.name, regexp_replace(c.ad_account_id, '\D', '', 'g')
    from clients c
    where coalesce(c.status, 'active') not in ('paused', 'archived')
      and nullif(btrim(c.ad_account_id), '') is not null
      and nullif(btrim(c.business_id), '') is not null
      and (select count(distinct r.date) from daily_reports r
           where regexp_replace(coalesce(r.ad_account_id, ''), '\D', '', 'g') = regexp_replace(c.ad_account_id, '\D', '', 'g')
             and r.date between v_day - 7 and v_day - 1) >= 5;

    select count(*) into v_steady from _pull_steady;

    select array_agg(s.name order by s.name) into v_missing
    from _pull_steady s
    where not exists (
        select 1 from daily_reports r
        where regexp_replace(coalesce(r.ad_account_id, ''), '\D', '', 'g') = s.acct and r.date = v_day);

    if v_missing is null then
        return jsonb_build_object('ok', true, 'day', v_day, 'steady_clients', v_steady, 'missing', '[]'::jsonb, 'texted', false);
    end if;

    -- One line, no double quotes or backslashes: Make drops this into raw-text JSON.
    v_msg := 'Golden Eye: the ad pull for ' || to_char(v_day, 'Mon FMDD') || ' is missing '
        || case when array_length(v_missing, 1) = v_steady and v_steady > 1 then 'every client (did it run?)'
                else array_length(v_missing, 1) || ' client' || case when array_length(v_missing, 1) = 1 then '' else 's' end
                     || ': ' || regexp_replace(array_to_string(v_missing, ', '), '[\r\n"\\]+', ' ', 'g') end
        || '. Replay it in Make (Midas Dashboard).';

    if not p_send then
        return jsonb_build_object('ok', true, 'day', v_day, 'steady_clients', v_steady, 'missing', to_jsonb(v_missing), 'texted', false, 'message', v_msg);
    end if;

    select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s where s.name = 'make_onboarding_hook_secret' limit 1;
    if coalesce(v_secret, '') = '' then
        raise warning 'daily_pull_check: the Make secret is missing from Vault, nothing was sent';
        return jsonb_build_object('ok', false, 'day', v_day, 'missing', to_jsonb(v_missing), 'texted', false, 'reason', 'secret missing');
    end if;

    begin
        perform net.http_post(
            url := v_hook,
            headers := '{"Content-Type": "application/json"}'::jsonb,
            body := jsonb_build_object(
                'event', 'client_request',
                'kind', 'pull_check',
                'request_type', 'Data pull',
                'client', 'Golden Eye',
                'title', 'Ad pull incomplete',
                'subject', 'Ad pull incomplete',
                'notes', '',
                'message', v_msg,
                'recipients', jsonb_build_array(jsonb_build_object('name', 'Tenny', 'phone', v_phone)),
                'secret', v_secret));
    exception when others then
        raise warning 'daily_pull_check: could not reach Make: %', sqlerrm;
        return jsonb_build_object('ok', false, 'day', v_day, 'missing', to_jsonb(v_missing), 'texted', false, 'reason', sqlerrm);
    end;

    return jsonb_build_object('ok', true, 'day', v_day, 'steady_clients', v_steady, 'missing', to_jsonb(v_missing), 'texted', true);
end;
$$;

-- Only the schedule (the database owner) runs it. Nobody signed in, and not the public key.
revoke execute on function public.daily_pull_check(boolean, date) from public, anon, authenticated;

commit;

-- The schedule: 13:30 UTC daily.
do $$ begin perform cron.unschedule('daily-pull-check'); exception when others then null; end $$;
select cron.schedule('daily-pull-check', '30 13 * * *', 'select public.daily_pull_check()');

-- See what it would say right now, without texting:
select public.daily_pull_check(false);
