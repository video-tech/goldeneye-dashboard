-- Deck calculator -> read-only homeowner links (built 2026-10-27). One row per "Create link"
-- click in a client's Deck Calculator tab (3Sixty Industries today).
--
-- Run this, then re-run supabase/sql/rename_client.sql (it now moves shared_estimates), then
-- deploy supabase/functions/estimate-share.
--
-- The row holds a frozen copy of the estimate (snapshot) under a 64-hex-character token that
-- is the link's whole credential. The homeowner's page (estimate.html) asks the function for the
-- snapshot by token, so it needs no sign-in and sees nothing else. Changing the deck afterwards
-- never changes a link that was already made.
--
-- Written ONLY by the estimate-share function (service_role), so there are no insert, update or
-- delete policies: a browser can't make, edit or un-revoke a link by itself.
--
-- Read by the client's own staff and by admins through client_row_visible() (which includes the
-- client_email fallback; 3Sixty has no user_client_access rows). They are the people who made the
-- links, so seeing the token is expected. The snapshot holds the homeowner's name only if the rep
-- typed it into "Prepared for".

create table if not exists shared_estimates (
    token           text        primary key check (token ~ '^[0-9a-f]{64}$'),
    client_name     text        not null,                 -- exact clients.name
    created_by      text        not null,                 -- auth email of the rep who clicked
    created_at      timestamptz not null default now(),
    expires_at      timestamptz not null,                 -- 30 days, like 3Sixty's QuickBooks estimates
    revoked_at      timestamptz,                          -- "Turn off" in the portal
    prepared_for    text,
    total           numeric(12,2) not null,               -- the top of the range
    snapshot        jsonb       not null,
    view_count      integer     not null default 0,       -- opens by the homeowner (the rep's own "Open" isn't counted)
    first_viewed_at timestamptz,
    last_viewed_at  timestamptz
);

create index if not exists shared_estimates_client_created on shared_estimates (client_name, created_at desc);
create index if not exists shared_estimates_rate_check on shared_estimates (created_by, created_at desc);

alter table shared_estimates enable row level security;

drop policy if exists "Client or admin reads shared estimates" on shared_estimates;
create policy "Client or admin reads shared estimates" on shared_estimates
    for select using (client_row_visible(client_name));

notify pgrst, 'reload schema';

-- Checks (SQL Editor):
--   select client_name, prepared_for, total, view_count, last_viewed_at, expires_at, revoked_at
--     from shared_estimates order by created_at desc limit 20;
