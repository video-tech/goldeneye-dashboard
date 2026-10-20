-- "Notify assignee" button on a task (2026-10-13).
--
-- notify_task_assignee(task_id) texts whoever a task is assigned to, through the same Make
-- scenario that already texts us client requests (#6, hook c8l92w09...). Nothing changes in Make:
-- the payload is the same shape (event 'client_request', a one-person recipients list, the Vault
-- secret), with kind 'task_nudge' so the scenario's existing route 1 sends it.
--
-- WHO CAN BE REACHED
--   team_contacts       -> name + phone, for people who aren't on the admin alert list (KJ, the
--                          account manager). Add them with the insert at the bottom.
--   admin_alert_recipients -> fallback, so Aidan and Tenny work with no setup.
-- An assignee is matched by full name or first name, case-insensitive. "Tenny, Aidan" texts both.
-- "Client", blank, and names with no number come back as "no number on file", never an error.
--
-- Admin only. SECURITY DEFINER so it can read Vault and the phone lists, which is why it checks
-- current_user_is_admin() first. The message is ONE line (Make's raw-text module doesn't escape
-- newlines or quotes), and carries no notes, which are staff-facing.
--
-- Run once in the SQL Editor. Safe to re-run.

begin;

create table if not exists public.team_contacts (
    name text primary key,
    phone text not null,
    created_at timestamptz not null default now()
);
alter table public.team_contacts enable row level security;
drop policy if exists "Admins manage team contacts" on public.team_contacts;
create policy "Admins manage team contacts" on public.team_contacts
    for all using (current_user_is_admin()) with check (current_user_is_admin());

create or replace function public.notify_task_assignee(p_task_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_hook constant text := 'https://hook.us2.make.com/c8l92w09rw5jrncifjxif0b8r1yf89ha';
    t record;
    v_secret text;
    v_from text;
    v_msg text;
    v_names text[];
    v_name text;
    v_phone text;
    v_intl boolean;
    v_recipients jsonb := '[]'::jsonb;
    v_texted text[] := '{}';
    v_missing text[] := '{}';
begin
    if not current_user_is_admin() then
        raise exception 'Only admins can send task notifications';
    end if;

    select * into t from tasks where id = p_task_id;
    if not found then
        return jsonb_build_object('ok', false, 'reason', 'Task not found');
    end if;
    if coalesce(btrim(t.assignee), '') = '' then
        return jsonb_build_object('ok', false, 'reason', 'This task has no assignee');
    end if;

    select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s where s.name = 'make_onboarding_hook_secret' limit 1;
    if coalesce(v_secret, '') = '' then
        return jsonb_build_object('ok', false, 'reason', 'The Make secret is missing from Vault, so nothing was sent');
    end if;

    -- "Tenny, Aidan" / "Tenny & Aidan" / "Tenny and Aidan"
    v_names := array(
        select btrim(x) from unnest(regexp_split_to_array(t.assignee, '\s*(,|&|/|\yand\y)\s*', 'i')) x
        where btrim(x) <> '' and lower(btrim(x)) <> 'and'
    );

    foreach v_name in array v_names loop
        v_phone := null;
        if lower(v_name) = 'client' then
            v_missing := v_missing || v_name;
            continue;
        end if;

        select c.phone into v_phone from team_contacts c
        where lower(c.name) = lower(v_name) or lower(split_part(c.name, ' ', 1)) = lower(v_name)
        order by (lower(c.name) = lower(v_name)) desc limit 1;

        if v_phone is null then
            select r.phone into v_phone from admin_alert_recipients r
            where coalesce(r.active, true)
              and (lower(r.name) = lower(v_name) or lower(split_part(r.name, ' ', 1)) = lower(v_name))
            order by (lower(r.name) = lower(v_name)) desc limit 1;
        end if;

        -- A number typed with a leading + (KJ is in the Philippines) keeps its own country code;
        -- anything else is treated as a US number.
        v_intl := left(btrim(coalesce(v_phone, '')), 1) = '+';
        v_phone := regexp_replace(coalesce(v_phone, ''), '\D', '', 'g');
        if length(v_phone) < 10 then
            v_missing := v_missing || v_name;
        elsif not exists (select 1 from jsonb_array_elements(v_recipients) e where e->>'name' = v_name) then
            v_recipients := v_recipients || jsonb_build_array(jsonb_build_object(
                'name', v_name, 'phone', case when v_intl then '+' || v_phone else '+1' || right(v_phone, 10) end));
            v_texted := v_texted || v_name;
        end if;
    end loop;

    if jsonb_array_length(v_recipients) = 0 then
        return jsonb_build_object('ok', false, 'texted', v_texted, 'missing', v_missing,
            'reason', 'No number on file for ' || array_to_string(v_missing, ', '));
    end if;

    -- One line, no quotes or backslashes: Make drops this into raw-text JSON.
    v_msg := 'Task for you: ' || regexp_replace(coalesce(t.title, 'Untitled'), '[\r\n"\\]+', ' ', 'g')
        || ' (' || regexp_replace(coalesce(t.client, 'no client'), '[\r\n"\\]+', ' ', 'g') || ')'
        || case when t.due is not null then ' - due ' || to_char(t.due, 'Mon FMDD') else '' end
        || ' - open Golden Eye to pick it up.';

    begin
        perform net.http_post(
            url := v_hook,
            headers := '{"Content-Type": "application/json"}'::jsonb,
            body := jsonb_build_object(
                'event', 'client_request',
                'kind', 'task_nudge',
                'request_type', 'Task nudge',
                'client', t.client,
                'title', t.title,
                'subject', 'Task nudge',
                'notes', '',
                'message', v_msg,
                'recipients', v_recipients,
                'secret', v_secret));
    exception when others then
        return jsonb_build_object('ok', false, 'reason', 'Could not reach Make: ' || sqlerrm);
    end;

    return jsonb_build_object('ok', true, 'texted', v_texted, 'missing', v_missing);
end;
$$;

revoke execute on function public.notify_task_assignee(bigint) from public, anon;
grant execute on function public.notify_task_assignee(bigint) to authenticated;

-- KJ is in the Philippines, so his number keeps its +63 country code.
insert into public.team_contacts (name, phone) values ('KJ', '+639616184346')
on conflict (name) do update set phone = excluded.phone;

commit;

notify pgrst, 'reload schema';

-- Add anyone else (the account manager) the same way:
--   insert into team_contacts (name, phone) values ('Account Manager', '8015551234')
--   on conflict (name) do update set phone = excluded.phone;
