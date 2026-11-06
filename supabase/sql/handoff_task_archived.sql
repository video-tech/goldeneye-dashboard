-- The "onboarding complete" task no longer sits on the board (2026-11-06).
--
-- Before: when a client finished their own steps, trg_onboarding_handoff raised the Client Request "Onboarding complete —
-- ready for campaign build" (and, for an add-on on a client past onboarding, "<Add-on> onboarding complete — ready to
-- start"). It told us nothing the real tasks don't, and the stage move waited for someone to tick it Complete.
--
-- Now: the same row is still created, but already ARCHIVED and Complete. Archived tasks vanish from the board, counts,
-- reports, the portal and the stage move (see "Archive instead of delete" in CLAUDE.md), yet everything that needs to know
-- "this client was already announced" keeps finding the row by its title:
--   * this trigger's own "already announced" check (so a step ticked, unticked and ticked again never texts twice),
--   * ghl-account (a finished client is one with the handoff row),
--   * the add-on tasks raised for a client past onboarding,
--   * the "Set up" label,
--   * trg_notify_client_request, which fires on the INSERT and still texts the admins "X has finished onboarding".
-- Nothing else changes: same text to the client through the GHL contact check, same gates.
--
-- Also archives the ones that already exist. An UPDATE fires no trigger (the only trigger on tasks is on INSERT), so no
-- text goes out for them.
--
-- ORDER: after onboarding_handoff_contact_gate.sql (this file restates that function with two inserts changed). Safe to re-run.
-- supabase/triggers/onboarding_handoff.sql carries the same inserts for a fresh setup.

create or replace function public.raise_onboarding_handoff_task()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_title    constant text := 'Onboarding complete — ready for campaign build';
  -- The contact check sends Make's webhook once the client is found in our Midas GHL (ghl-contact-check, mode "handoff")
  v_fn       constant text := 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/ghl-contact-check';
  v_key      text := lower(regexp_replace(coalesce(NEW.client_name, ''), '[^a-zA-Z0-9]', '', 'g'));
  v_client   text;
  v_email    text;
  v_status   text;
  v_stage    text;
  v_total    int;
  v_done     int;
  v_secret   text;
  v_addon    record;
  v_addon_title text;
  v_services jsonb;
begin
  if NEW.completed_at is null then
    return NEW;
  end if;

  -- Only a step going from not-done to done is a completion
  if TG_OP = 'UPDATE' and OLD.completed_at is not null then
    return NEW;
  end if;

  -- An admin tidying up history, not a client actually finishing
  if NEW.completed_by = 'backfilled' then
    return NEW;
  end if;

  select c.name,
         coalesce(c.status, 'active'),
         coalesce(c.current_stage, 'Onboarding'),
         regexp_replace(split_part(coalesce(c.client_email, ''), ',', 1), '\s', '', 'g')
    into v_client, v_status, v_stage, v_email
  from clients c
  where lower(regexp_replace(c.name, '[^a-zA-Z0-9]', '', 'g')) = v_key
  order by (coalesce(c.status, 'active') = 'active') desc
  limit 1;

  if v_client is null or v_status <> 'active' then
    return NEW;
  end if;

  -- A client past onboarding: only a newly added add-on can finish here, and it gets a (hidden) task, not a text
  if v_stage <> 'Onboarding' then
    for v_addon in
      select s.service_key, coalesce(sv.name, s.service_key) as name
      from service_onboarding_status(v_client) s
      left join services sv on sv.key = s.service_key
      where s.service_key <> 'base' and s.status = 'onboarding' and s.complete
    loop
      update client_services set status = 'active', onboarded_at = now()
      where client_name = v_client and service_key = v_addon.service_key and status = 'onboarding';

      v_addon_title := v_addon.name || ' onboarding complete — ready to start';
      if not exists (
        select 1 from tasks t
        where lower(btrim(coalesce(t.title, ''))) = lower(v_addon_title)
          and lower(regexp_replace(coalesce(t.client, ''), '[^a-zA-Z0-9]', '', 'g')) = v_key
      ) then
        -- Archived and Complete from the start: kept as the "already announced" marker, never shown
        insert into tasks (client, title, type, stage, status, assignee,
                           p, u, e, score, due, notes, updated_at, archived_at, archived_by)
        values (v_client, v_addon_title, 'Client Request', 'Onboarding', 'Complete', 'Account Manager',
                5, 4, 1, 92, current_date + 1,
                v_client || ' finished their ' || v_addon.name || ' onboarding steps in their portal.', now(), now(), 'Golden Eye');
      end if;
    end loop;
    return NEW;
  end if;

  -- Still onboarding: every client step that applies to them, and only those
  select count(*), count(*) filter (where f.completed)
    into v_total, v_done
  from (select distinct step_id, completed from onboarding_steps_for_client(v_client) where owner <> 'agency') f;

  if v_total = 0 or v_done < v_total then
    return NEW;
  end if;

  -- Their add-ons are onboarded as part of this one event
  select coalesce(jsonb_agg(service_key order by service_key), '[]'::jsonb) into v_services
  from client_services where client_name = v_client and status in ('onboarding', 'active');
  update client_services set status = 'active', onboarded_at = now()
  where client_name = v_client and status = 'onboarding';

  if exists (
    select 1 from tasks t
    where lower(btrim(coalesce(t.title, ''))) = lower(v_title)
      and lower(regexp_replace(coalesce(t.client, ''), '[^a-zA-Z0-9]', '', 'g')) = v_key
  ) then
    return NEW;
  end if;

  -- Archived and Complete from the start: kept as the "already announced" marker, never shown. The INSERT still fires
  -- trg_notify_client_request, which texts the admins.
  insert into tasks (client, title, type, stage, status, assignee,
                     p, u, e, score, due, notes, updated_at, archived_at, archived_by)
  values (v_client, v_title, 'Client Request', 'Onboarding', 'Complete', 'Account Manager',
          5, 4, 1, 92, current_date + 1,
          v_client || ' finished every onboarding step in their portal.', now(), now(), 'Golden Eye');

  -- The text goes through the GHL contact check. GHL's contact search is fuzzy, and on 2026-09-14 one completion with no
  -- email tagged and texted 10 leads; the function sends Make's webhook only on one EXACT email match in our Midas GHL,
  -- and raises a "not sent" task otherwise (a missing or malformed email included).
  -- A failure here must never roll back the client's own progress save.
  begin
    -- The cron secret proves this call is ours. It lives in Supabase Vault, never in the repo. With it missing,
    -- nothing is sent: an unannounced completion is recoverable, a text to the wrong person isn't.
    select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s
    where s.name = 'make_onboarding_hook_secret'
    limit 1;

    if coalesce(v_secret, '') = '' then
      raise warning 'onboarding handoff: vault secret make_onboarding_hook_secret missing, text not requested for %', v_client;
      return NEW;
    end if;

    perform net.http_post(
      url     := v_fn,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
      body    := jsonb_build_object(
                   'mode',         'handoff',
                   'client',       v_client,
                   'client_email', v_email,
                   'completed_at', NEW.completed_at,
                   'services',     v_services
                 ),
      timeout_milliseconds := 30000
    );
  exception when others then
    raise warning 'onboarding handoff request failed for %: %', v_client, sqlerrm;
  end;

  return NEW;
end;
$function$;

-- The ones that already exist: archive and close them. Matched on type and stage as well as title, so nothing a person
-- wrote by hand is touched.
update public.tasks
   set archived_at = coalesce(archived_at, now()),
       archived_by = coalesce(archived_by, 'Golden Eye'),
       status      = 'Complete',
       updated_at  = now()
 where type = 'Client Request'
   and stage = 'Onboarding'
   and archived_at is null
   and (title = 'Onboarding complete — ready for campaign build'
        or title like '% onboarding complete — ready to start');

-- Check: none left on the board, and the markers are still there
--   select client, title, status, archived_at from tasks
--   where title = 'Onboarding complete — ready for campaign build' or title like '% onboarding complete — ready to start' order by client;
