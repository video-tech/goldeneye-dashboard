-- Step 2 of securing Make scenario #5 ("txt reminder twice a day", 2026-09-15).
--
-- Same function as before, with one change: the POST now carries `secret`, read from Supabase
-- Vault (`make_onboarding_hook_secret`), exactly as trg_onboarding_handoff does for scenario #4.
-- Everything else — who gets a reminder, the phone formatting, the per-client error handling —
-- is unchanged.
--
-- Safe to run on its own: Make ignores a field it doesn't know about, so reminders keep working
-- whether or not the filter has been added over there yet. Run this BEFORE adding the filter in
-- Make, or the next reminder would be blocked.
--
-- If the Vault secret is missing, nothing is sent and a warning is raised, rather than sending a
-- request that the filter will refuse anyway. Same choice as the onboarding trigger: a missed
-- reminder is recoverable, and this way the reason is visible in the Postgres logs.
create or replace function public.send_weekly_checkin_reminders()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_hook constant text := 'https://hook.us2.make.com/fpeogcbj7x1hdf2onwg38kk6nq41tan0';
  v_week date := (date_trunc('week', current_date)::date - 7);
  v_secret text;
  r record;
begin
  -- Read once, not per client
  select s.decrypted_secret into v_secret
  from vault.decrypted_secrets s
  where s.name = 'make_onboarding_hook_secret'
  limit 1;

  if coalesce(v_secret, '') = '' then
    raise warning 'checkin reminders: vault secret make_onboarding_hook_secret missing, no reminders sent';
    return;
  end if;

  for r in
    select c.name as client,
           coalesce(
             jsonb_agg(jsonb_build_object(
               'name',  ct.contact_name,
               -- Last 10 digits in E.164, since GHL stores and searches that way and
               -- these are saved however someone typed them
               'phone', '+1' || right(regexp_replace(ct.phone, '\D', '', 'g'), 10)
             )) filter (
               where ct.phone is not null
                 and length(regexp_replace(ct.phone, '\D', '', 'g')) >= 10
                 and coalesce(ct.active, true)
             ),
             '[]'::jsonb) as contacts
    from clients c
    left join client_contacts ct
      on lower(regexp_replace(ct.client_name, '[^a-zA-Z0-9]', '', 'g'))
       = lower(regexp_replace(c.name, '[^a-zA-Z0-9]', '', 'g'))
    where coalesce(c.status, 'active') = 'active'
      and coalesce(c.current_stage, 'Onboarding') <> 'Onboarding'
      and not exists (
        select 1 from weekly_checkins w
        where lower(regexp_replace(w.client_name, '[^a-zA-Z0-9]', '', 'g'))
            = lower(regexp_replace(c.name, '[^a-zA-Z0-9]', '', 'g'))
          and w.week_start = v_week
      )
    group by c.name
  loop
    continue when jsonb_array_length(r.contacts) = 0;

    begin
      perform net.http_post(
        url     := v_hook,
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body    := jsonb_build_object(
                     'event',      'checkin_reminder',
                     'client',     r.client,
                     'week_start', v_week,
                     'contacts',   r.contacts,
                     'secret',     v_secret
                   )
      );
    exception when others then
      raise warning 'checkin reminder failed for %: %', r.client, sqlerrm;
    end;
  end loop;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Step 3: a test request that texts nobody
-- ---------------------------------------------------------------------------
-- Sends one request to the same webhook with an EMPTY contacts list, so Make's iterator has
-- nothing to loop over and no SMS module ever runs. It's what makes `secret` appear in Make, so
-- the field can be mapped in a filter ("Redetermine data structure", then re-run this).
--
-- Run it on its own:
--
-- do $$
-- declare v_secret text;
-- begin
--     select s.decrypted_secret into v_secret from vault.decrypted_secrets s
--     where s.name = 'make_onboarding_hook_secret' limit 1;
--     perform net.http_post(
--         url     := 'https://hook.us2.make.com/fpeogcbj7x1hdf2onwg38kk6nq41tan0',
--         headers := '{"Content-Type": "application/json"}'::jsonb,
--         body    := jsonb_build_object(
--                      'event', 'checkin_reminder',
--                      'client', 'ZZ Secret Test',
--                      'week_start', current_date,
--                      'contacts', '[]'::jsonb,
--                      'secret', v_secret));
-- end $$;
--
-- Then check it arrived: select created, status_code, content from net._http_response
-- order by created desc limit 3;   (200 means Make accepted it)
