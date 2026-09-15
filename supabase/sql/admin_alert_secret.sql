-- Step 2 of securing Make scenario #6 ("txt notification to us -Client request", 2026-09-15).
--
-- Same function as before, with one change: the POST now carries `secret` from Supabase Vault
-- (`make_onboarding_hook_secret`), like trg_onboarding_handoff (#4) and
-- send_weekly_checkin_reminders (#5). Nothing else changes: same classification, same recipients,
-- same message wording.
--
-- Safe to run on its own: Make ignores unknown fields, so alerts keep working whether or not the
-- filter exists over there yet. Run this BEFORE adding the filter in Make.
--
-- IMPORTANT — this hook has TWO callers. The morning audit's critical alert posts to the same
-- webhook (supabase/functions/morning-audit/index.ts, which reads MAKE_WEBHOOK_SECRET). Both must
-- be sending the secret before the filter goes in, or critical alerts stop silently. So:
--   1. run this file
--   2. deploy morning-audit
--   3. only then add the filter in Make
--
-- If the Vault secret is missing, no alert is sent and a warning is raised. The task itself is
-- still created either way — this trigger only handles the notification.
create or replace function public.notify_admins_client_request()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_hook       constant text := 'https://hook.us2.make.com/c8l92w09rw5jrncifjxif0b8r1yf89ha';
  v_handoff    constant text := 'Onboarding complete — ready for campaign build';
  v_kind       text;
  v_subject    text;
  v_reqtype    text;
  v_message    text;
  v_recipients jsonb;
  v_secret     text;
begin
  if NEW.type is distinct from 'Client Request' then
    return NEW;
  end if;

  v_reqtype := substring(NEW.title from '^\[([^\]]+)\]');
  v_subject := btrim(regexp_replace(coalesce(NEW.title, ''), '^\[[^\]]+\]\s*', ''));

  if NEW.title = v_handoff then
    v_kind    := 'onboarding_complete';
    v_message := NEW.client || ' has finished onboarding — ready for campaign build.';
  elsif NEW.title ilike 'Tech access call requested%' then
    v_kind    := 'help_request';
    v_message := NEW.client || ' is stuck on onboarding and asked for help: ' || v_subject;
  else
    v_kind    := 'task_request';
    v_message := 'New ' || lower(coalesce(v_reqtype, 'request')) || ' from ' || NEW.client || ': ' || v_subject;
  end if;

  select coalesce(
           jsonb_agg(jsonb_build_object(
             'name',  r.name,
             'phone', '+1' || right(regexp_replace(r.phone, '\D', '', 'g'), 10)
           )) filter (where length(regexp_replace(r.phone, '\D', '', 'g')) >= 10),
           '[]'::jsonb)
    into v_recipients
  from admin_alert_recipients r
  where r.active;

  begin
    select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s
    where s.name = 'make_onboarding_hook_secret'
    limit 1;

    if coalesce(v_secret, '') = '' then
      raise warning 'client request alert: vault secret make_onboarding_hook_secret missing, no alert sent for %', NEW.client;
      return NEW;
    end if;

    perform net.http_post(
      url     := v_hook,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body    := jsonb_build_object(
                   'event',        'client_request',
                   'kind',         v_kind,
                   'request_type', v_reqtype,
                   'client',       NEW.client,
                   'title',        NEW.title,
                   'subject',      v_subject,
                   'notes',        NEW.notes,
                   'message',      v_message,
                   'recipients',   v_recipients,
                   'secret',       v_secret
                 )
    );
  exception when others then
    raise warning 'client request alert failed for %: %', NEW.client, sqlerrm;
  end;

  return NEW;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Step 3: a test request that texts nobody
-- ---------------------------------------------------------------------------
-- An EMPTY recipients list, so Make's iterator has nothing to loop over and no SMS module runs.
-- This is what makes `secret` appear in Make so it can be used in a filter ("Redetermine data
-- structure", then re-run this).
--
-- do $$
-- declare v_secret text;
-- begin
--     select s.decrypted_secret into v_secret from vault.decrypted_secrets s
--     where s.name = 'make_onboarding_hook_secret' limit 1;
--     perform net.http_post(
--         url     := 'https://hook.us2.make.com/c8l92w09rw5jrncifjxif0b8r1yf89ha',
--         headers := '{"Content-Type": "application/json"}'::jsonb,
--         body    := jsonb_build_object(
--                      'event', 'client_request',
--                      'kind', 'task_request',
--                      'request_type', 'Test',
--                      'client', 'ZZ Secret Test',
--                      'title', '[Test] secret plumbing check',
--                      'subject', 'secret plumbing check',
--                      'notes', null,
--                      'message', 'Test only — no recipients, so nobody is texted.',
--                      'recipients', '[]'::jsonb,
--                      'secret', v_secret));
-- end $$;
--
-- Then: select created, status_code, content from net._http_response order by created desc limit 3;
