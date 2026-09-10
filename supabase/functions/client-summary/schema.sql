-- Run once in the Supabase SQL Editor before deploying client-summary.

create table if not exists client_work_summaries (
    id bigint generated always as identity primary key,
    client_name text not null,
    range_start date not null,
    range_end date not null,
    summary text not null,
    -- Stored alongside the narrative for cheap admin QA — no need to re-derive
    -- them from tasks just to sanity-check what the model was given.
    tasks_completed integer not null default 0,
    tasks_open integer not null default 0,
    created_at timestamptz not null default now(),
    -- Belt-and-suspenders alongside the function's own check-before-insert (same
    -- idempotency pattern as morning_audits): a retry or a second scheduled attempt
    -- can never produce two cards for the same client on the same day.
    unique (client_name, range_end)
);

alter table client_work_summaries enable row level security;

-- This table is read DIRECTLY by each client's own browser session (the same way
-- daily_reports is), so getting this policy right is the whole ballgame — a wrong
-- one here leaks one client's tasks and AI-written notes to another.
--
-- user_has_client_access() is the same helper already proven correct elsewhere in
-- this project (see CLAUDE.md, Access model). Deliberately NOT modeled on
-- daily_reports' policy set — that table currently carries three separate `true`
-- SELECT policies stacked alongside its real ones, which under Postgres RLS's OR
-- semantics means the careful policies are dead and the table is wide open to any
-- authenticated user. That is a pre-existing issue, not a pattern to repeat.
create policy "Clients and admins read their own work summaries"
on client_work_summaries
for select
using (user_has_client_access(client_name) or current_user_is_admin());

-- No insert/update/delete policy for anon/authenticated: only the edge function,
-- via service_role (which bypasses RLS), ever writes here. That is not an oversight
-- — nobody should be able to write their own "AI summary" from the client side.

notify pgrst, 'reload schema';
