-- Security audit fixes (2026-11-12). Same class of bug as the 2026-09-10 and 2026-10-02 RLS fixes: policies that say
-- "true" for any signed-in user, so every portal client (and anyone who signs up, since a new sign-up is a signed-in
-- "pending" user) could read or change other clients' data.
--
-- CRITICAL
-- 1. pre_approved_users was ALL true. handle_new_user() gives a new account whatever role its pre-approval says, so anyone
--    could sign up, add a pre-approval for a second email with role 'admin', sign up again and be an admin of everything.
--    Not used as of this audit (the only admins are video@, info@ and support@). Now: admins manage; a user reads only
--    their own row (initApp reads it at sign-in).
-- 2. send_weekly_checkin_reminders() could be run by the public anon key (in the page source), which texts every active
--    client's check-in contacts through Make #5 (still switched on). Now: the database owner only.
--
-- HIGH (any signed-in client could read or change other clients' data)
-- 3. onboarding_steps and stage_templates (ALL true): anyone could rewrite any client's onboarding, including the links and
--    videos shown in every client's portal. Now: everyone signed in reads, admins write.
-- 4. morning_audits (ALL true): every client's spend, CPL and verdicts. Now admins only.
-- 5. ad_approvals (ALL true): clients read/approve/delete other clients' ads. Now: a client reads and updates (approves,
--    leaves feedback) its own; admins do everything. Make writes with its own key, unaffected.
-- 6. client_leads (ALL true): other clients' leads, with names, phones and emails. Now: a client manages its own.
-- 7. user_profiles and user_client_access (read true): everyone's email and role, and who can see which client. Now: your
--    own row, staff (admins and members) read all, admins manage (unchanged).
-- 8. client_health, health_logs, client_milestones (ALL true), seo_metrics (read true): now a client reads its own, admins
--    write. health_settings, milestone_config (ALL true): everyone signed in reads, admins write.
-- 9. client_estimates, client_jobs (legacy, unused by the app): the open read and open insert are dropped; their existing
--    "own email or Midas" read policy stays.
-- 10. Storage, ad-creatives bucket: any signed-in user could upload or overwrite files. Now admins only (the bucket stays
--    public to read, as the previews need).
--
-- Also: onboarding_client_facts() no longer callable by signed-in users (it skipped the visibility check; only other
-- functions use it, and they run as the owner), and the trigger functions lose their pointless public EXECUTE grants
-- (a trigger function can't be called directly anyway).
--
-- One transaction: a failure leaves the old policies in place. Safe to re-run.

begin;

-- helper: drop a policy if it exists
create or replace function pg_temp.drop_pol(t text, p text) returns void language plpgsql as $$
begin execute format('drop policy if exists %I on public.%I', p, t); end $$;

-- 1. pre_approved_users
select pg_temp.drop_pol('pre_approved_users', 'Allow authenticated users to manage pre-approved users');
select pg_temp.drop_pol('pre_approved_users', 'Allow authenticated users to read pre-approved users');
select pg_temp.drop_pol('pre_approved_users', 'Admins manage pre-approved users');
select pg_temp.drop_pol('pre_approved_users', 'Read own pre-approval');
create policy "Admins manage pre-approved users" on public.pre_approved_users for all to authenticated
    using (current_user_is_admin()) with check (current_user_is_admin());
create policy "Read own pre-approval" on public.pre_approved_users for select to authenticated
    using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- 2. check-in reminders: owner only
revoke execute on function public.send_weekly_checkin_reminders() from public, anon, authenticated;

-- 3. onboarding_steps, stage_templates
select pg_temp.drop_pol('onboarding_steps', 'Auth manage onboarding steps');
select pg_temp.drop_pol('onboarding_steps', 'Signed-in users read onboarding steps');
select pg_temp.drop_pol('onboarding_steps', 'Admins manage onboarding steps');
create policy "Signed-in users read onboarding steps" on public.onboarding_steps for select to authenticated using (true);
create policy "Admins manage onboarding steps" on public.onboarding_steps for all to authenticated
    using (current_user_is_admin()) with check (current_user_is_admin());
select pg_temp.drop_pol('stage_templates', 'Auth manage stage templates');
select pg_temp.drop_pol('stage_templates', 'Signed-in users read stage templates');
select pg_temp.drop_pol('stage_templates', 'Admins manage stage templates');
create policy "Signed-in users read stage templates" on public.stage_templates for select to authenticated using (true);
create policy "Admins manage stage templates" on public.stage_templates for all to authenticated
    using (current_user_is_admin()) with check (current_user_is_admin());

-- 4. morning_audits
select pg_temp.drop_pol('morning_audits', 'Allow authenticated full access');
select pg_temp.drop_pol('morning_audits', 'Admins manage morning audits');
create policy "Admins manage morning audits" on public.morning_audits for all to authenticated
    using (current_user_is_admin()) with check (current_user_is_admin());

-- 5. ad_approvals
select pg_temp.drop_pol('ad_approvals', 'Allow authenticated users full access to ad_approvals');
select pg_temp.drop_pol('ad_approvals', 'Auth Read Approvals');
select pg_temp.drop_pol('ad_approvals', 'Admins manage ad approvals');
select pg_temp.drop_pol('ad_approvals', 'Clients read their own ad approvals');
select pg_temp.drop_pol('ad_approvals', 'Clients review their own ad approvals');
create policy "Admins manage ad approvals" on public.ad_approvals for all to authenticated
    using (current_user_is_admin()) with check (current_user_is_admin());
create policy "Clients read their own ad approvals" on public.ad_approvals for select to authenticated
    using (client_row_visible(client_name));
create policy "Clients review their own ad approvals" on public.ad_approvals for update to authenticated
    using (client_row_visible(client_name)) with check (client_row_visible(client_name));

-- 6. client_leads
select pg_temp.drop_pol('client_leads', 'Allow authenticated users to manage client leads');
select pg_temp.drop_pol('client_leads', 'Allow authenticated users to read client leads');
select pg_temp.drop_pol('client_leads', 'Auth Read Leads');
select pg_temp.drop_pol('client_leads', 'Clients manage their own leads');
create policy "Clients manage their own leads" on public.client_leads for all to authenticated
    using (client_row_visible(client_name)) with check (client_row_visible(client_name));

-- 7. user_profiles, user_client_access
select pg_temp.drop_pol('user_profiles', 'Allow Auth Read Profiles');
select pg_temp.drop_pol('user_profiles', 'Staff read profiles');
create policy "Staff read profiles" on public.user_profiles for select to authenticated using (current_user_is_staff());
select pg_temp.drop_pol('user_client_access', 'Allow Auth Read Access');
select pg_temp.drop_pol('user_client_access', 'Staff read client access');
create policy "Staff read client access" on public.user_client_access for select to authenticated using (current_user_is_staff());

-- 8. health, milestones, legacy SEO
select pg_temp.drop_pol('client_health', 'Auth Read Health');
select pg_temp.drop_pol('client_health', 'Team Access Health');
select pg_temp.drop_pol('client_health', 'Admins manage client health');
select pg_temp.drop_pol('client_health', 'Clients read their own health');
create policy "Admins manage client health" on public.client_health for all to authenticated
    using (current_user_is_admin()) with check (current_user_is_admin());
create policy "Clients read their own health" on public.client_health for select to authenticated
    using (client_row_visible(client_name));

select pg_temp.drop_pol('health_logs', 'Team Access Logs');
select pg_temp.drop_pol('health_logs', 'Admins manage health logs');
select pg_temp.drop_pol('health_logs', 'Clients read their own health logs');
create policy "Admins manage health logs" on public.health_logs for all to authenticated
    using (current_user_is_admin()) with check (current_user_is_admin());
create policy "Clients read their own health logs" on public.health_logs for select to authenticated
    using (client_row_visible(client_name));

select pg_temp.drop_pol('client_milestones', 'Team Access Client Milestones');
select pg_temp.drop_pol('client_milestones', 'Admins manage client milestones');
select pg_temp.drop_pol('client_milestones', 'Clients read their own milestones');
create policy "Admins manage client milestones" on public.client_milestones for all to authenticated
    using (current_user_is_admin()) with check (current_user_is_admin());
create policy "Clients read their own milestones" on public.client_milestones for select to authenticated
    using (client_row_visible(client_name));

select pg_temp.drop_pol('health_settings', 'Team Access Settings');
select pg_temp.drop_pol('health_settings', 'Signed-in users read health settings');
select pg_temp.drop_pol('health_settings', 'Admins manage health settings');
create policy "Signed-in users read health settings" on public.health_settings for select to authenticated using (true);
create policy "Admins manage health settings" on public.health_settings for all to authenticated
    using (current_user_is_admin()) with check (current_user_is_admin());

select pg_temp.drop_pol('milestone_config', 'Team Access Milestone Config');
select pg_temp.drop_pol('milestone_config', 'Signed-in users read milestone config');
select pg_temp.drop_pol('milestone_config', 'Admins manage milestone config');
create policy "Signed-in users read milestone config" on public.milestone_config for select to authenticated using (true);
create policy "Admins manage milestone config" on public.milestone_config for all to authenticated
    using (current_user_is_admin()) with check (current_user_is_admin());

select pg_temp.drop_pol('seo_metrics', 'Auth Read SEO');
select pg_temp.drop_pol('seo_metrics', 'Clients read their own SEO metrics');
create policy "Clients read their own SEO metrics" on public.seo_metrics for select to authenticated
    using (client_row_visible(client_name));

-- 9. legacy estimates/jobs
select pg_temp.drop_pol('client_estimates', 'Allow authenticated inserts');
select pg_temp.drop_pol('client_estimates', 'Auth Read Estimates');
select pg_temp.drop_pol('client_jobs', 'Allow authenticated inserts');
select pg_temp.drop_pol('client_jobs', 'Auth Read Jobs');

-- 10. storage: only admins upload or overwrite ad creatives
drop policy if exists "Allow team uploads" on storage.objects;
drop policy if exists "Allow team to update files" on storage.objects;
drop policy if exists "Admins upload ad creatives" on storage.objects;
drop policy if exists "Admins update ad creatives" on storage.objects;
create policy "Admins upload ad creatives" on storage.objects for insert to authenticated
    with check (bucket_id = 'ad-creatives' and public.current_user_is_admin());
create policy "Admins update ad creatives" on storage.objects for update to authenticated
    using (bucket_id = 'ad-creatives' and public.current_user_is_admin());

-- Function grants
revoke execute on function public.onboarding_client_facts(text) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.notify_admins_client_request() from public, anon, authenticated;
revoke execute on function public.notify_new_client_welcome() from public, anon, authenticated;
revoke execute on function public.raise_onboarding_handoff_task() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

commit;

notify pgrst, 'reload schema';
