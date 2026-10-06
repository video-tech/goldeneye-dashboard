-- Check-ins logged by our team (2026-10-06).
--
-- Clients aren't texted for their weekly numbers any more (the checkin-reminder-am/pm cron jobs
-- were switched off on 2026-10-06). VAs text clients themselves and log the answers on the
-- Roster, as source = 'staff'. A VA is a `member` login with user_client_access rows for the
-- clients they look after (Settings → Users).
--
-- New columns:
--   entered_by  the staff email that logged the row (a client's own portal row leaves it null)
-- Reused: contact_name / contact_phone = the client person the VA texted, raw_reply = what they
-- said (optional). contact_phone keeps the existing unique (contact_phone, week_start) index
-- meaningful: the same person can't be logged twice for one week.
--
-- RLS. "Auth read checkins" was `for select using (true)`: any signed-in user, any client
-- included, could read every client's estimates, jobs and revenue. Replaced with:
--   - admins: everything
--   - read: client_row_visible(client_name) (admin, user_client_access, or the client_email
--     fallback). The fallback matters: the old client policies used user_has_client_access()
--     alone, which only ~4 clients have rows for, so most clients couldn't save a portal
--     check-in at all.
--   - clients: insert their own portal rows, update their own (same rule as before)
--   - staff (admin or member): insert source 'staff' rows for clients they can see, as
--     themselves, and update their own staff rows
-- No delete for anyone but admins.
--
-- Run once in the SQL Editor. Safe to re-run.

begin;

alter table public.weekly_checkins add column if not exists entered_by text;

create or replace function public.current_user_is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from user_profiles p
    where lower(p.email) = lower(coalesce(auth.email(), ''))
      and p.role in ('admin', 'member')
  );
$$;
revoke execute on function public.current_user_is_staff() from public;
grant execute on function public.current_user_is_staff() to authenticated;

drop policy if exists "Auth read checkins" on public.weekly_checkins;
drop policy if exists "client reads own checkins" on public.weekly_checkins;
drop policy if exists "client inserts own checkins" on public.weekly_checkins;
drop policy if exists "client updates own checkin" on public.weekly_checkins;
drop policy if exists "Admins manage checkins" on public.weekly_checkins;
drop policy if exists "Read checkins for visible clients" on public.weekly_checkins;
drop policy if exists "Clients add their own portal checkins" on public.weekly_checkins;
drop policy if exists "Clients update their own portal checkin" on public.weekly_checkins;
drop policy if exists "Staff log checkins" on public.weekly_checkins;
drop policy if exists "Staff update their own logged checkins" on public.weekly_checkins;

create policy "Admins manage checkins" on public.weekly_checkins
  for all using (current_user_is_admin()) with check (current_user_is_admin());

create policy "Read checkins for visible clients" on public.weekly_checkins
  for select using (client_row_visible(client_name));

create policy "Clients add their own portal checkins" on public.weekly_checkins
  for insert with check (
    client_row_visible(client_name)
    and source = 'portal'
    and lower(coalesce(contact_name, '')) = lower(coalesce(auth.email(), ''))
  );

create policy "Clients update their own portal checkin" on public.weekly_checkins
  for update
  using (client_row_visible(client_name) and source = 'portal'
         and lower(coalesce(contact_name, '')) = lower(coalesce(auth.email(), '')))
  with check (client_row_visible(client_name) and source = 'portal'
         and lower(coalesce(contact_name, '')) = lower(coalesce(auth.email(), '')));

create policy "Staff log checkins" on public.weekly_checkins
  for insert with check (
    current_user_is_staff()
    and client_row_visible(client_name)
    and source = 'staff'
    and lower(coalesce(entered_by, '')) = lower(coalesce(auth.email(), ''))
  );

create policy "Staff update their own logged checkins" on public.weekly_checkins
  for update
  using (current_user_is_staff() and client_row_visible(client_name) and source = 'staff'
         and lower(coalesce(entered_by, '')) = lower(coalesce(auth.email(), '')))
  with check (current_user_is_staff() and client_row_visible(client_name) and source = 'staff'
         and lower(coalesce(entered_by, '')) = lower(coalesce(auth.email(), '')));

commit;

notify pgrst, 'reload schema';

-- Check afterwards:
--   select policyname, cmd from pg_policies where tablename = 'weekly_checkins' order by 1;
-- This week's logged numbers:
--   select client_name, week_start, source, contact_name, entered_by, estimates_count, closes_count, revenue_total
--   from weekly_checkins order by week_start desc, client_name;
