-- clients RLS — replaces the wide-open policies found 2026-10-02.
--
-- Before this, public.clients had five policies for `authenticated` that all said `true`:
-- read, insert (twice), update and delete. Every client who signs into the portal is
-- `authenticated`, so any of them could read every client's retainer, payment status,
-- emails and ad account ids, and could UPDATE or DELETE any client row (another client's
-- ad_account_id, status, stage...). Same class of bug as daily_reports / weekly_reports /
-- tasks, fixed 2026-09-10 (see CLAUDE.md, Database objects).
--
-- After this:
--   * admins (current_user_is_admin()) can do everything, as before;
--   * everyone else can SELECT only rows client_row_visible(name) allows: their own
--     client(s), through user_client_access OR the client_email fallback. Members are
--     covered by user_client_access;
--   * nobody but an admin can INSERT, UPDATE or DELETE. With no policy for those commands,
--     a non-admin UPDATE/DELETE silently matches 0 rows and an INSERT is refused (42501);
--   * "Investor Read Access" (alpha@pandenconstruction.com reads every row) is left exactly
--     as it is. It's the intentional investor exception, like "Admin and Investor Task Access"
--     on tasks.
--
-- client_row_visible() reads public.clients itself. That doesn't recurse: it's SECURITY
-- DEFINER, owned by postgres, which owns clients and has no FORCE ROW LEVEL SECURITY, so
-- its inner read bypasses RLS. (Checked 2026-10-02: relforcerowsecurity = false.)
--
-- Unaffected: edge functions use service_role (bypasses RLS); Make reads clients through
-- its own Supabase connection, which can't be the anon key, since anon had no policy here
-- and the daily pull has been reading rows all along; rename_client(), the onboarding
-- functions and the handoff trigger are SECURITY DEFINER. The other tables' policies that
-- look into clients (daily_reports, tasks) only ever need rows this policy still shows.
--
-- app.js changes ship with this: the auto-overdue payment update and the Payments buttons
-- are admin-only now, so a member or client never fires a write that would silently do
-- nothing.
--
-- Drop and create in ONE transaction, so a failure can't leave the table with the open
-- policies gone and nothing yet in their place (or, under RLS, nothing readable at all).
-- Re-runnable: every drop is IF EXISTS, including the two policies this file creates.
--
-- Run clients_rls_tests.sql first: it applies the same change inside a transaction it
-- always rolls back, and prints the results.

begin;

drop policy if exists "Enable read access for authenticated users"   on public.clients;
drop policy if exists "Enable insert access for authenticated users" on public.clients;
drop policy if exists "Enable insert for authenticated users only"   on public.clients;
drop policy if exists "Enable update access for authenticated users" on public.clients;
drop policy if exists "Enable delete access for authenticated users" on public.clients;

drop policy if exists "Admins manage all clients"        on public.clients;
drop policy if exists "Clients read their own client row" on public.clients;

alter table public.clients enable row level security;

create policy "Admins manage all clients"
on public.clients for all
to authenticated
using (current_user_is_admin())
with check (current_user_is_admin());

create policy "Clients read their own client row"
on public.clients for select
to authenticated
using (client_row_visible(name));

-- "Investor Read Access" is deliberately not touched.

commit;

-- Check afterwards: expect exactly three policies —
--   Admins manage all clients (ALL), Clients read their own client row (SELECT),
--   Investor Read Access (SELECT).
-- select policyname, cmd, qual, with_check from pg_policies
-- where schemaname = 'public' and tablename = 'clients' order by policyname;
