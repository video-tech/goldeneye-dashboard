-- Run once in the Supabase SQL Editor before deploying seo-sync.
--
-- Phase 1 of the SEO measurement build: the tables that make Search Console history
-- start accumulating. History is the whole asset here — a week not collected is a week
-- that can never be reported on — so this lands before any of the UI that reads it.
--
-- Safe to re-run: every statement is guarded.

-- ---------------------------------------------------------------------------
-- Where each client's Google resources live
-- ---------------------------------------------------------------------------
-- Presence of a value IS the feature switch. No separate "SEO enabled" flag to fall
-- out of sync with whether the data can actually be fetched: if gsc_property is set,
-- the client is pulled and the portal shows the tab; if it is null, neither happens.
alter table clients
    add column if not exists gsc_property    text,  -- verbatim from GSC: 'sc-domain:example.com' OR 'https://www.example.com/'
    add column if not exists ga4_property_id text,  -- digits only, e.g. '123456789'
    add column if not exists gbp_location_id text,  -- digits only
    add column if not exists ghl_location_id text;  -- GHL sub-account id; resolves inbound lead webhooks (phase 2)

-- ---------------------------------------------------------------------------
-- One RLS helper, so the fallback can never be forgotten on a new table
-- ---------------------------------------------------------------------------
-- This is exactly the three-way check the tasks policy spells out inline (see
-- CLAUDE.md, Database objects). It is a function rather than a copied WHERE clause
-- because this build adds seven client-readable tables, and the client_email fallback
-- is not optional: user_client_access has rows for only about four of the ten-plus
-- active clients, so a policy relying on user_has_client_access() alone locks most
-- clients out of their own data while looking perfectly correct in review.
create or replace function client_row_visible(p_client text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
    select current_user_is_admin()
        or user_has_client_access(p_client)
        or exists (
            select 1
            from clients c
            where c.client_email is not null
              and c.client_email <> ''
              and lower(regexp_replace(c.name, '[^a-zA-Z0-9]', '', 'g'))
                = lower(regexp_replace(coalesce(p_client, ''), '[^a-zA-Z0-9]', '', 'g'))
              -- regexp_replace on \s, not replace(' '): a real client_email in this
              -- database carries a trailing CRLF, and a space-only strip silently
              -- failed to match it. See CLAUDE.md, Known gaps.
              and lower(auth.email()) = any (
                  string_to_array(lower(regexp_replace(c.client_email, '\s', '', 'g')), ',')
              )
        );
$fn$;

grant execute on function client_row_visible(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Search Console data
-- ---------------------------------------------------------------------------
-- Three tables because [date], [date,page] and [date,query] are three separate API
-- calls with three different row counts. Deliberately NOT one [date,page,query] table:
-- it multiplies rows for no gain, and its page-level impressions do not sum back to
-- property totals anyway (one query showing two of your pages is one property
-- impression but two page impressions). The [date] table is the only honest source of
-- account totals and of Google's own impression-weighted position.
--
-- client_name holds the EXACT clients.name, not a normalized form. Unlike the Meta
-- tables — where account names change under us and matching has to be fuzzy — we
-- control the writer here, so an exact key is both possible and safer.

create table if not exists seo_daily (
    client_name text not null,
    date        date not null,
    clicks      integer not null default 0,
    impressions integer not null default 0,
    -- Google's own impression-weighted average position for the property that day.
    -- Never re-derive it by averaging rows: see the aggregation note below.
    position    numeric(6,2),
    synced_at   timestamptz not null default now(),
    primary key (client_name, date)
);

create table if not exists seo_pages_daily (
    client_name text not null,
    date        date not null,
    page        text not null,
    clicks      integer not null default 0,
    impressions integer not null default 0,
    position    numeric(6,2),
    primary key (client_name, date, page)
);
create index if not exists seo_pages_daily_client_page_date
    on seo_pages_daily (client_name, page, date);

create table if not exists seo_queries_daily (
    client_name text not null,
    date        date not null,
    query       text not null,   -- GSC already lower-cases these
    clicks      integer not null default 0,
    impressions integer not null default 0,
    position    numeric(6,2),
    primary key (client_name, date, query)
);
create index if not exists seo_queries_daily_client_query_date
    on seo_queries_daily (client_name, query, date);

-- IMPORTANT for anything that aggregates position across rows or days:
--     sum(position * impressions) / nullif(sum(impressions), 0)
-- and never avg(position). The existing renderAdminSeo/renderCpSeo take a flat mean of
-- daily averages, which weights a 3-impression day the same as a 3,000-impression one
-- and does not match the figure Google shows for the same range. Phase 4 fixes those.

-- ---------------------------------------------------------------------------
-- Per client + source sync progress
-- ---------------------------------------------------------------------------
-- A 16-month backfill cannot finish inside one edge-function invocation (150s wall
-- clock), so it walks backwards a calendar month at a time and remembers where it got
-- to. The every-15-minutes backfill cron then finishes a newly configured client on
-- its own, with nobody having to press anything or watch it.
create table if not exists seo_sync_state (
    client_name     text not null,
    source          text not null check (source in ('gsc','ga4','gbp')),
    backfill_cursor date,     -- next month-start still to fetch, walking backwards; null = not started
    backfill_done   boolean not null default false,
    last_daily_run  date,     -- last date the rolling window completed
    last_run_at     timestamptz,
    last_error      text,     -- one client's 403 must never stop the other nine; it lands here instead
    primary key (client_name, source)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table seo_daily         enable row level security;
alter table seo_pages_daily   enable row level security;
alter table seo_queries_daily enable row level security;
alter table seo_sync_state    enable row level security;

drop policy if exists "Clients and admins read their own seo daily"   on seo_daily;
drop policy if exists "Clients and admins read their own seo pages"   on seo_pages_daily;
drop policy if exists "Clients and admins read their own seo queries" on seo_queries_daily;
drop policy if exists "Admins read seo sync state"                    on seo_sync_state;

create policy "Clients and admins read their own seo daily"
on seo_daily for select using (client_row_visible(client_name));

create policy "Clients and admins read their own seo pages"
on seo_pages_daily for select using (client_row_visible(client_name));

create policy "Clients and admins read their own seo queries"
on seo_queries_daily for select using (client_row_visible(client_name));

-- Operational plumbing, not client data — cursors and error strings only.
create policy "Admins read seo sync state"
on seo_sync_state for select using (current_user_is_admin());

-- No insert/update/delete policies anywhere above. Only the edge function writes here,
-- via service_role, which bypasses RLS. Same reasoning as client_work_summaries: there
-- is no legitimate path by which a browser should write its own SEO history.

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- rename_client(): move every table, and only for an admin
-- ---------------------------------------------------------------------------
-- Replaces the version that lived only in the database (dumped 2026-09-11). Two
-- separate problems with that one:
--
-- 1. It skipped tables. clients.name is the join key for everything below, and a rename
--    that misses one orphans that client's rows with nothing to say what happened. It
--    was missing the four SEO tables above, client_contacts (check-in texts silently
--    stop for a renamed client), client_work_summaries, and client_onboarding_progress
--    — which is STILL deliberately left out, see the note at the bottom of the updates.
--
-- 2. It never checked who was calling. It is SECURITY DEFINER — it runs with the
--    owner's rights and bypasses RLS — and Postgres grants EXECUTE on a new function to
--    PUBLIC by default, while Supabase exposes every public-schema function over the
--    API. So any signed-in user, and possibly anyone holding the public anon key, could
--    rename ANY client. Renaming a victim's client to your own client's name would
--    merge their tasks, reports and check-ins into yours, where your own RLS then lets
--    you read them. The only guard was app.js hiding the button.
--
-- Must run AFTER the tables above exist: plpgsql resolves table names when the function
-- is called, not when it is created, so creating it early would succeed and then make
-- every rename fail with "relation seo_daily does not exist".
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

    -- NOT YET: client_onboarding_progress. It needs moving too, but trg_onboarding_handoff
    -- sits on that table and texts the client "onboarding complete" when every step is
    -- done. If that trigger fires on UPDATE rather than only INSERT, renaming a client
    -- who has finished onboarding would re-send that text. Add the line below only once
    -- the trigger has been checked:
    --   update client_onboarding_progress set client_name = new_name where client_name = old_name;

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

-- ---------------------------------------------------------------------------
-- Checking on it
-- ---------------------------------------------------------------------------
-- select * from seo_sync_state order by client_name;
-- select client_name, count(*) days, min(date), max(date) from seo_daily group by 1 order by 1;
-- select date, clicks, impressions, position from seo_daily where client_name = 'X' order by date desc limit 14;
-- select sum(clicks) clicks, sum(impressions) impr,
--        round(sum(position * impressions) / nullif(sum(impressions),0), 1) pos
--   from seo_daily where client_name = 'X' and date between '2026-08-01' and '2026-08-31';
