-- TEMPORARY. Holds the redacted payloads that ghl-lead-webhook captures while the
-- organic-lead classifier is being written. Drop it once that's done (last line below).
--
-- Why a table at all: the capture is also written to the function log, but the first real
-- capture could not be found in the dashboard's log views, while the SQL Editor is where
-- every other check in this build has been read. So the same redacted object lands here.
--
-- Run in the SQL Editor BEFORE redeploying: a capture that arrives before this table
-- exists is logged but not saved.

create table if not exists ghl_webhook_captures (
    id          bigint generated always as identity primary key,
    received_at timestamptz not null default now(),
    capture     jsonb not null
);

alter table ghl_webhook_captures enable row level security;
-- No policies, on purpose: the webhook writes with the service-role key, the SQL Editor
-- (which runs as postgres) reads, and the public API can't see the table at all.

-- Explicit, because newer Supabase projects no longer auto-grant new tables to the API
-- roles. Harmless if this project still does.
grant insert, select on ghl_webhook_captures to service_role;

notify pgrst, 'reload schema';

-- Read:  select id, received_at, capture from ghl_webhook_captures order by id;
-- Done:  drop table ghl_webhook_captures;
