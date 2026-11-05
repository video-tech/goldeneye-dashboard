-- client_onboarding_progress RLS (2026-11-05). Replaces the one wide-open policy.
--
-- Before: "Auth manage onboarding progress" was FOR ALL USING (true) WITH CHECK (true), so anyone signed in, at any
-- client, could read, tick, untick or delete every client's onboarding steps. Same class of bug as daily_reports,
-- weekly_reports, tasks and clients (see CLAUDE.md, Database objects). It mattered more once steps can be unticked:
-- the portal now writes completed_at back to null.
--
-- After:
--   * admins (current_user_is_admin()) can do everything;
--   * everyone else reads, inserts and updates only their own client's rows, through client_row_visible(client_name)
--     (user_client_access OR the client_email fallback; members are covered by user_client_access). WITH CHECK on
--     both, so a row can't be written for, or moved to, another client;
--   * nobody but an admin can DELETE. Unticking is an UPDATE (completed_at = null), never a delete.
--
-- Unaffected: Make's form scenario (#3) writes through its own Supabase connection, which isn't anon or a signed-in
-- user; the edge functions use service_role; rename_client() and the onboarding functions and triggers are
-- SECURITY DEFINER. All of those skip RLS.
--
-- One transaction, so the open policy is never gone with nothing yet in its place. Re-runnable.

begin;

drop policy if exists "Auth manage onboarding progress" on public.client_onboarding_progress;

drop policy if exists "Admins manage all onboarding progress"      on public.client_onboarding_progress;
drop policy if exists "Clients read their own onboarding progress"  on public.client_onboarding_progress;
drop policy if exists "Clients add their own onboarding progress"   on public.client_onboarding_progress;
drop policy if exists "Clients update their own onboarding progress" on public.client_onboarding_progress;

alter table public.client_onboarding_progress enable row level security;

create policy "Admins manage all onboarding progress"
on public.client_onboarding_progress for all
to authenticated
using (current_user_is_admin())
with check (current_user_is_admin());

create policy "Clients read their own onboarding progress"
on public.client_onboarding_progress for select
to authenticated
using (client_row_visible(client_name));

create policy "Clients add their own onboarding progress"
on public.client_onboarding_progress for insert
to authenticated
with check (client_row_visible(client_name));

create policy "Clients update their own onboarding progress"
on public.client_onboarding_progress for update
to authenticated
using (client_row_visible(client_name))
with check (client_row_visible(client_name));

commit;

-- Check afterwards: expect exactly four policies, and no "Auth manage onboarding progress"
-- select policyname, cmd, qual, with_check from pg_policies
-- where schemaname = 'public' and tablename = 'client_onboarding_progress' order by policyname;
