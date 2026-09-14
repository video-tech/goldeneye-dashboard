-- rename_client(): the ONE place every table keyed on clients.name is listed.
--
-- Add a line here for every new table that stores clients.name, then re-run this whole file in
-- the SQL Editor. A table left out is silently orphaned by the next rename, with nothing to say
-- what happened. Moved out of seo-sync/schema.sql on 2026-09-11, when lead_sources became the
-- second feature to need it. A copy per feature would drift.
--
-- Run it AFTER every table it names exists (seo-sync/schema.sql, ghl-lead-webhook/schema.sql,
-- and everything older): plpgsql resolves table names when the function is called, not when
-- it is created, so running it early succeeds and then makes every rename fail.
--
-- ---------------------------------------------------------------------------
-- History. The version that lived only in the database (dumped 2026-09-11) had two problems:
--
-- 1. It skipped tables. A rename that misses one orphans that client's rows, with nothing to
--    say what happened. It was missing the four seo_* tables, client_contacts (check-in texts
--    silently stop for a renamed client), client_work_summaries and client_onboarding_progress.
--    All of those are in the list below now, along with lead_sources.
--
-- 2. It never checked who was calling. It is SECURITY DEFINER, so it runs with the owner's
--    rights and bypasses RLS. Postgres grants EXECUTE on a new function to PUBLIC by default,
--    and Supabase exposes every public-schema function over the API. has_function_privilege
--    confirmed anon could call it, so anyone holding the public anon key could rename ANY
--    client. Renaming a victim's client to your own client's name would merge their tasks,
--    reports and check-ins into yours, where your own RLS then lets you read them. The only
--    guard was app.js hiding the button.
create or replace function rename_client(old_name text, new_name text)
returns void
language plpgsql
security definer
-- Pinned so a caller cannot put a schema of their own first on the search path and have
-- this owner-rights code resolve "clients" or "tasks" to a table they control.
set search_path = public
as $fn$
begin
    -- None of these messages may contain the word "function": saveClientEdits() in
    -- app.js treats any error mentioning it as "rename_client isn't installed yet" and
    -- would show the admin the wrong explanation for a perfectly clear refusal.
    if not current_user_is_admin() then
        raise exception 'Only an admin can rename a client.';
    end if;

    -- Checked, never rewritten. app.js writes clients.name again straight after this
    -- call using its own trimmed value; trimming here too could leave clients.name and
    -- every other table holding two slightly different strings.
    if coalesce(btrim(new_name), '') = '' then
        raise exception 'The new name cannot be empty.';
    end if;
    if new_name = old_name then
        return;
    end if;

    if not exists (select 1 from clients where name = old_name) then
        raise exception 'No client is named "%".', old_name;
    end if;

    -- Compared the way app.js compares names almost everywhere — lower-cased with
    -- punctuation stripped — because two clients that normalize to the same string are
    -- already the same client as far as the dashboard is concerned. Without this, a
    -- rename onto an existing client silently merges both histories with no way to
    -- separate them again. It is also what keeps the primary keys on the seo_* tables
    -- and the unique key on client_work_summaries from colliding mid-rename. The client
    -- being renamed is excluded, so a case-only rename of itself still works.
    if exists (
        select 1 from clients
        where name <> old_name
          and lower(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g'))
            = lower(regexp_replace(new_name, '[^a-zA-Z0-9]', '', 'g'))
    ) then
        raise exception 'A client named "%" (or one that matches it) already exists.', new_name;
    end if;

    -- One transaction: either the whole rename lands or none of it does.
    update clients               set name        = new_name where name        = old_name;
    update tasks                 set client      = new_name where client      = old_name;
    update client_health         set client_name = new_name where client_name = old_name;
    update health_logs           set client_name = new_name where client_name = old_name;
    update client_leads          set client_name = new_name where client_name = old_name;
    update client_milestones     set client_name = new_name where client_name = old_name;
    update ad_approvals          set client_name = new_name where client_name = old_name;
    update seo_metrics           set client_name = new_name where client_name = old_name;
    update weekly_reports        set client_name = new_name where client_name = old_name;
    update weekly_checkins       set client_name = new_name where client_name = old_name;
    update user_client_access    set client_name = new_name where client_name = old_name;
    -- Added 2026-09-11:
    update client_contacts       set client_name = new_name where client_name = old_name;
    update client_work_summaries set client_name = new_name where client_name = old_name;
    update seo_daily             set client_name = new_name where client_name = old_name;
    update seo_pages_daily       set client_name = new_name where client_name = old_name;
    update seo_queries_daily     set client_name = new_name where client_name = old_name;
    update seo_sync_state        set client_name = new_name where client_name = old_name;

    -- Safe only because trg_onboarding_handoff (supabase/triggers/onboarding_handoff.sql)
    -- fires on INSERT or UPDATE OF completed_at, and this sets client_name alone — so
    -- moving these rows never re-sends the "onboarding complete" text. Tested 2026-09-11
    -- with a rename in a rolled-back transaction. Any other trigger ever added to this
    -- table needs the same property, or every rename re-texts every finished client.
    update client_onboarding_progress set client_name = new_name where client_name = old_name;
    -- Added 2026-09-11 with the lead classifier (ghl-lead-webhook/schema.sql):
    update lead_sources               set client_name = new_name where client_name = old_name;
    -- Added 2026-09-11 with SE Ranking + the SEO changelog (seranking-sync/schema.sql):
    update seo_rank_locations         set client_name = new_name where client_name = old_name;
    update seo_keywords               set client_name = new_name where client_name = old_name;
    update seo_rank_checks            set client_name = new_name where client_name = old_name;
    update seo_changelog              set client_name = new_name where client_name = old_name;
    -- Added 2026-09-14 with article auto-logging (seo-changelog-webhook/schema.sql). Run that
    -- schema first: this table must exist before a rename runs.
    update seo_webhook_configs        set client_name = new_name where client_name = old_name;
    -- Added 2026-09-14 with the client SEO tab data (supabase/sql/seo_client_tab.sql):
    update seo_project_daily          set client_name = new_name where client_name = old_name;
    -- Added 2026-09-14 with service-based onboarding (supabase/sql/service_onboarding.sql):
    update client_services            set client_name = new_name where client_name = old_name;

    -- client_access is a jsonb array of names, so it needs rewriting element-wise.
    update pre_approved_users
    set client_access = (
        select jsonb_agg(case when value::text = to_jsonb(old_name)::text
                              then to_jsonb(new_name) else value end)
        from jsonb_array_elements(client_access)
    )
    where client_access @> to_jsonb(array[old_name]);
end;
$fn$;

-- create or replace KEEPS whatever privileges the old function had, so if PUBLIC could
-- execute it before, it still can. Revoke explicitly. Signed-in users keep EXECUTE —
-- they need it to call the function at all — and the admin check inside decides.
revoke execute on function rename_client(text, text) from public, anon;
grant  execute on function rename_client(text, text) to authenticated;

notify pgrst, 'reload schema';
