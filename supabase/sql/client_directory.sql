-- Client directory (the Roster page, 2026-10-02).
--
-- Everyone we might contact at a client lives in client_contacts, the table the weekly
-- check-in reminder already reads. Before this it held only name/phone/title, and every
-- active row was texted every weekday, so a website person or a bookkeeper could not be
-- recorded without also getting check-in texts. Three columns fix that:
--   email          - so a contact can be reached, or recorded, without a phone
--   role           - owner / sales / office / website / marketing / other, for grouping
--   checkin_texts  - whether send_weekly_checkin_reminders() texts them. Defaults to true,
--                    so every existing row (all reps added through the portal's "sales team"
--                    step) keeps getting texted exactly as before.
--
-- The phone number becomes unique per client instead of across the whole table, so the same
-- person (say one website person serving two clients) can be listed on both.
--
-- client_profiles is new and admin-only: business phone, website, address, and private notes.
-- It is NOT a set of clients columns because the clients table is readable by clients (and,
-- until its policies are fixed, by every signed-in user), and private notes must never reach a
-- client. Same reasoning as weekly_report_inputs.
--
-- RLS on client_contacts: "Auth manage contacts" was `for all using (true) with check (true)`,
-- so any signed-in user, client or not, could read, change or delete every client's contacts.
-- It is replaced with admin full access, and the client policies move from
-- user_has_client_access() to client_row_visible(), which adds the client_email fallback. That
-- matters: only ~4 clients have user_client_access rows, and the rest could only save the
-- portal's sales-team step because of the open policy. Without the fallback they'd lose it.
--
-- Run this whole file once in the SQL Editor, then re-run supabase/sql/rename_client.sql
-- (it now moves client_profiles). Safe to re-run.

begin;

-- 1. New contact columns -------------------------------------------------------------------
alter table public.client_contacts
  add column if not exists email text,
  add column if not exists role text,
  add column if not exists checkin_texts boolean not null default true;

alter table public.client_contacts drop constraint if exists client_contacts_role_check;
alter table public.client_contacts add constraint client_contacts_role_check
  check (role is null or role in ('owner', 'sales', 'office', 'website', 'marketing', 'other'));

-- 2. Phone unique per client, not globally --------------------------------------------------
-- app.js upserts on (client_name, phone) and falls back to (phone) if this hasn't run yet.
drop index if exists public.uniq_client_contacts_phone;
create unique index if not exists uniq_client_contacts_client_phone
  on public.client_contacts (client_name, phone);

-- 3. Policies ------------------------------------------------------------------------------
drop policy if exists "Auth manage contacts" on public.client_contacts;
drop policy if exists "client reads own contacts" on public.client_contacts;
drop policy if exists "client adds own contacts" on public.client_contacts;
drop policy if exists "client updates own contacts" on public.client_contacts;
drop policy if exists "Admins manage contacts" on public.client_contacts;

create policy "Admins manage contacts" on public.client_contacts
  for all using (current_user_is_admin()) with check (current_user_is_admin());

create policy "client reads own contacts" on public.client_contacts
  for select using (client_row_visible(client_name));

create policy "client adds own contacts" on public.client_contacts
  for insert with check (client_row_visible(client_name));

create policy "client updates own contacts" on public.client_contacts
  for update using (client_row_visible(client_name)) with check (client_row_visible(client_name));
-- No client delete policy: nothing in the portal deletes contacts. Removing someone is an
-- admin action on the Roster page.

-- 4. Admin-only business details and notes --------------------------------------------------
create table if not exists public.client_profiles (
  client_name    text primary key,
  business_phone text,
  website_url    text,
  address        text,
  notes          text,
  updated_at     timestamptz not null default now(),
  updated_by     text
);

alter table public.client_profiles enable row level security;
drop policy if exists "Admins manage client profiles" on public.client_profiles;
create policy "Admins manage client profiles" on public.client_profiles
  for all using (current_user_is_admin()) with check (current_user_is_admin());

-- 5. Reminders skip contacts switched off -------------------------------------------------
-- Same function as supabase/sql/checkin_reminder_secret.sql with one added condition:
-- `coalesce(ct.checkin_texts, true)`. Everything else is unchanged.
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
                 and coalesce(ct.checkin_texts, true)
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

commit;

notify pgrst, 'reload schema';

-- Check afterwards:
--   select policyname, cmd, qual from pg_policies where tablename in ('client_contacts','client_profiles');
--   select indexname from pg_indexes where tablename = 'client_contacts';
