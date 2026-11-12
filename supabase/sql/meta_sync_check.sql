-- "Did Meta's ad sync reach everyone?" check, texted to Tenny only (2026-11-12).
--
-- WHY: on 2026-11-12 meta-sync's daily run ran out of time on Sunset's account and skipped 3Sixty, Alta Vista, Anxiety
-- Solutions, Red Valley and PureAirK9. Nobody was told; it was found while checking something else. meta-sync now runs three
-- clients at a time, and this catches it if a client is ever left behind again, for any reason (time, an error, access removed).
--
-- WHAT COUNTS: a client meta-sync has loaded before (meta_sync_state.last_window set) and that is still active, whose last full
-- sync window doesn't reach yesterday (Mountain), or whose last run left days out ("partial: ..."). Clients meta-sync was never
-- given access to (no last_window: Astra, Midas, SimpliBlinds) are left out, so a known gap doesn't text every day.
--
-- WHEN: 18:00 UTC daily (11am Mountain in winter, noon in summer), after the 14:30 daily sync and the morning fills.
-- HOW: the same Make scenario (#6) and payload as daily_pull_check(): one recipient, the Vault secret, a one-line message.
--
-- Test without texting:   select meta_sync_check(false);
-- Run for real by hand:   select meta_sync_check();
-- Safe to re-run.

begin;

create or replace function public.meta_sync_check(p_send boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_hook constant text := 'https://hook.us2.make.com/c8l92w09rw5jrncifjxif0b8r1yf89ha';
    v_phone constant text := '+18017098501';
    v_yesterday date := (now() at time zone 'America/Denver')::date - 1;
    v_behind text[];
    v_secret text;
    v_msg text;
begin
    select array_agg(line order by line) into v_behind
    from (
        select s.client_name || ' ('
               || case
                    when nullif(split_part(s.last_window, '..', 2), '')::date < v_yesterday
                        then 'last synced to ' || to_char(nullif(split_part(s.last_window, '..', 2), '')::date, 'Mon FMDD')
                             || coalesce(', ' || left(regexp_replace(nullif(s.last_error, ''), '[\r\n"\\]+', ' ', 'g'), 60), '')
                    else 'some days missing'
                  end || ')' as line
        from meta_sync_state s
        join clients c on c.name = s.client_name
        where coalesce(c.status, 'active') not in ('paused', 'archived')
          and nullif(s.last_window, '') is not null
          and (nullif(split_part(s.last_window, '..', 2), '')::date < v_yesterday
               or coalesce(s.last_error, '') like 'partial%')
    ) x;

    if v_behind is null then
        return jsonb_build_object('ok', true, 'yesterday', v_yesterday, 'behind', '[]'::jsonb, 'texted', false);
    end if;

    -- One line, no double quotes or backslashes: Make drops this into raw-text JSON.
    v_msg := 'Golden Eye: Meta ad sync is behind for ' || array_length(v_behind, 1)
        || case when array_length(v_behind, 1) = 1 then ' client: ' else ' clients: ' end
        || array_to_string(v_behind, '; ') || '. Check meta-sync.';

    if not p_send then
        return jsonb_build_object('ok', true, 'yesterday', v_yesterday, 'behind', to_jsonb(v_behind), 'texted', false, 'message', v_msg);
    end if;

    select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s where s.name = 'make_onboarding_hook_secret' limit 1;
    if coalesce(v_secret, '') = '' then
        raise warning 'meta_sync_check: the Make secret is missing from Vault, nothing was sent';
        return jsonb_build_object('ok', false, 'behind', to_jsonb(v_behind), 'texted', false, 'reason', 'secret missing');
    end if;

    begin
        perform net.http_post(
            url := v_hook,
            headers := '{"Content-Type": "application/json"}'::jsonb,
            body := jsonb_build_object(
                'event', 'client_request',
                'kind', 'meta_sync_check',
                'request_type', 'Data pull',
                'client', 'Golden Eye',
                'title', 'Meta sync behind',
                'subject', 'Meta sync behind',
                'notes', '',
                'message', v_msg,
                'recipients', jsonb_build_array(jsonb_build_object('name', 'Tenny', 'phone', v_phone)),
                'secret', v_secret));
    exception when others then
        raise warning 'meta_sync_check: could not reach Make: %', sqlerrm;
        return jsonb_build_object('ok', false, 'behind', to_jsonb(v_behind), 'texted', false, 'reason', sqlerrm);
    end;

    return jsonb_build_object('ok', true, 'yesterday', v_yesterday, 'behind', to_jsonb(v_behind), 'texted', true);
end;
$$;

-- Only the schedule (the database owner) runs it. Nobody signed in, and not the public key.
revoke execute on function public.meta_sync_check(boolean) from public, anon, authenticated;

commit;

select cron.unschedule('meta-sync-check') where exists (select 1 from cron.job where jobname = 'meta-sync-check');
select cron.schedule('meta-sync-check', '0 18 * * *', 'select public.meta_sync_check()');

-- See what it would say right now, without texting:
select public.meta_sync_check(false);
