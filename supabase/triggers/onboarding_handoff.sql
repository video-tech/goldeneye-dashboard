-- =============================================================================
-- Onboarding handoff — the "onboarding complete" text (Make scenario #4)
-- =============================================================================
-- When a client's last onboarding step is completed, raise the handoff task
-- "Onboarding complete — ready for campaign build" and ask Make to text the client.
--
-- Restored 2026-09-11. raise_onboarding_handoff_task() had survived, hook URL and all, but
-- trg_onboarding_handoff was gone and client_onboarding_progress had no triggers at all. The
-- handoff TASK kept appearing because app.js raises it too; the TEXT did not go out.
--
-- Run in two parts, with onboarding_handoff_tests.sql in between:
--   Part A replaces the function. Harmless on its own — a function nothing calls fires
--          nothing. Also re-run the rename_client block at the end of
--          supabase/functions/seo-sync/schema.sql, which now moves this table's rows too.
--   Tests  attach the trigger inside their own transaction and roll back, so they send
--          nothing and leave no trigger behind.
--   Part B attaches the trigger. This is the switch: from here, the next client to finish
--          onboarding gets texted.

-- -----------------------------------------------------------------------------
-- Part A — the function
-- -----------------------------------------------------------------------------
-- Changes from the definition that survived:
--
-- 1. It ignores updates that don't complete a step. The trigger has to fire on UPDATE as
--    well as INSERT: saveOnboardingProgress() in app.js upserts a video step's row at 10%
--    watched with completed_at null, and the step is only completed later, by the upsert's
--    DO UPDATE. An INSERT-only trigger would miss every video step. Re-writing a
--    completed_at that was already set (Make re-sending a form, say) is not a completion
--    either, and neither is rename_client() moving the row.
--
-- 2. It only fires for a client whose current_stage is still Onboarding — the same gate
--    reconcileOnboardingHandoffTasks() applies in app.js. On 2026-09-11 eight clients well
--    past onboarding showed 9 of 11 steps done: two steps were added after they were
--    backfilled, and five of them have no handoff task. Their portal hides Get Started past
--    the Onboarding stage, but Make's form-completion scenario writes progress without
--    looking at stage. With the task check alone, one resubmitted form could text a client
--    whose campaigns are running that their onboarding is complete, and file "ready for
--    campaign build" for them.
--
-- 3. No matching clients row means nothing happens: there is no email to find them in GHL
--    by. Where two rows share a normalized name (archived duplicates exist), the active one
--    is the one that counts.
--
-- 4. The email is stripped of all whitespace, not just trimmed. At least one client_email
--    carries a hidden \r\n, which btrim() leaves in place and which makes Make's GHL
--    contact lookup miss. Same fix the tasks RLS policy uses.
--
-- Unchanged, and deliberate:
-- - completed_by = 'backfilled' is skipped. markOnboardingComplete() in app.js is an admin
--   tidying up history, and its confirm dialog promises the client won't be notified.
-- - An existing handoff task means "already announced", for the task and the text alike.
--   That is what protects the clients who finished while the trigger was missing — app.js
--   raised their tasks — so re-attaching it texts none of them. It also holds under
--   concurrency: the task is inserted in the same transaction as the completion that
--   caused it, so a later check sees both or neither.
-- - The task insert fires trg_notify_client_request, which classifies it as
--   onboarding_complete and alerts the admins. That is the admin side of the same event.
--
-- Service-based onboarding (2026-09-15, needs supabase/sql/service_onboarding.sql run first):
-- - "Every step" now means every step that APPLIES to this client, from
--   onboarding_steps_for_client(), the same function the portal uses. An ads-only client is no
--   longer waiting on SEO steps, and the other way round.
-- - Client still in the Onboarding stage: unchanged event. When all their applicable client steps
--   are done, raise the handoff task and text them once, and mark every add-on they were
--   onboarding as active.
-- - Client past the Onboarding stage who was given a new add-on: when that add-on's steps are done
--   (service_onboarding_status says complete), mark it active and raise "<add-on> onboarding
--   complete — ready to start". NO text: scenario #4's message says their onboarding is complete,
--   which is the wrong thing to tell a long-running client. client_services.status going from
--   onboarding to active, in the same transaction, is what stops it happening twice.
create or replace function public.raise_onboarding_handoff_task()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_title    constant text := 'Onboarding complete — ready for campaign build';
  v_hook     constant text := 'https://hook.us2.make.com/hucrpp6hm43ps165n7wxut8v9rn3dksu';
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

  -- A client past onboarding: only a newly added add-on can finish here, and it gets a task, not a text
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
        insert into tasks (client, title, type, stage, status, assignee,
                           p, u, e, score, due, notes, updated_at)
        values (v_client, v_addon_title, 'Client Request', 'Onboarding', 'Not Started', 'Account Manager',
                5, 4, 1, 92, current_date + 1,
                v_client || ' finished their ' || v_addon.name || ' onboarding steps in their portal.', now());
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

  insert into tasks (client, title, type, stage, status, assignee,
                     p, u, e, score, due, notes, updated_at)
  values (v_client, v_title, 'Client Request', 'Onboarding', 'Not Started', 'Account Manager',
          5, 4, 1, 92, current_date + 1,
          v_client || ' finished every onboarding step in their portal.', now());

  -- No usable email means no text. Make finds the client in GHL by email, and GHL's contact
  -- search is fuzzy. On 2026-09-14 a single completion came back with 10 contacts, all
  -- leads, which Make tagged, and GHL texted every one "onboarding complete". Make now
  -- filters for an exact email match too, but a blank or malformed email must never leave
  -- here at all. The handoff task above is still raised, so an admin sees the client finished.
  if v_email !~ '^[^@\s,]+@[^@\s,]+\.[^@\s,]+$' then
    raise warning 'onboarding handoff: no usable client_email for %, text not requested', v_client;
    return NEW;
  end if;

  -- A Make outage must never roll back the client's own progress save
  begin
    -- The hook URL is public (this file is in a public repo), and on 2026-09-11 an EMPTY
    -- request to it, not sent by this trigger, texted 10 leads. So Make only acts when the body
    -- carries this secret. It lives in Supabase Vault, never in the repo. With it missing,
    -- nothing is sent: an unannounced completion is recoverable, a text to the wrong person
    -- isn't.
    select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s
    where s.name = 'make_onboarding_hook_secret'
    limit 1;

    if coalesce(v_secret, '') = '' then
      raise warning 'onboarding handoff: vault secret make_onboarding_hook_secret missing, text not requested for %', v_client;
      return NEW;
    end if;

    perform net.http_post(
      url     := v_hook,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body    := jsonb_build_object(
                   'event',        'onboarding_complete',
                   'client',       v_client,
                   'client_email', v_email,
                   'completed_at', NEW.completed_at,
                   'services',     v_services,
                   'secret',       v_secret
                 )
    );
  exception when others then
    raise warning 'onboarding handoff webhook failed for %: %', v_client, sqlerrm;
  end;

  return NEW;
end;
$function$;


-- -----------------------------------------------------------------------------
-- Part B — attach it. Run only after the tests pass.
-- -----------------------------------------------------------------------------
-- UPDATE OF completed_at, not every UPDATE: rename_client() only sets client_name, and a
-- watch_percent save doesn't list completed_at, so neither even calls the function. The
-- not-done-to-done check is inside the function rather than here because a trigger that
-- also covers INSERT cannot mention OLD in its WHEN clause.
drop trigger if exists trg_onboarding_handoff on client_onboarding_progress;
create trigger trg_onboarding_handoff
after insert or update of completed_at on client_onboarding_progress
for each row
when (NEW.completed_at is not null)
execute function raise_onboarding_handoff_task();


-- -----------------------------------------------------------------------------
-- Checking on it
-- -----------------------------------------------------------------------------
-- Is it attached?
--   select tgname, tgrelid::regclass, pg_get_triggerdef(oid) from pg_trigger
--   where tgname = 'trg_onboarding_handoff';
--
-- Did Make accept the last few? pg_net keeps responses for about six hours.
--   select r.created, r.status_code, r.content, r.error_msg
--   from net._http_response r order by r.created desc limit 20;
--
-- Anyone who would be texted on their next completed step (Onboarding, active, no handoff
-- task yet):
--   select c.name from clients c
--   where coalesce(c.current_stage, 'Onboarding') = 'Onboarding'
--     and coalesce(c.status, 'active') = 'active'
--     and not exists (select 1 from tasks t
--                     where lower(regexp_replace(coalesce(t.client, ''), '[^a-zA-Z0-9]', '', 'g'))
--                         = lower(regexp_replace(c.name, '[^a-zA-Z0-9]', '', 'g'))
--                       and lower(btrim(t.title)) = lower('Onboarding complete — ready for campaign build'));
