-- Deck calculator -> QuickBooks estimates (built 2026-10-01). One row per "Create QuickBooks
-- estimate" click in a client's Deck Calculator tab (3Sixty Industries only today).
--
-- Run this, then re-run supabase/sql/rename_client.sql (it now moves deck_estimates), then deploy
-- supabase/functions/deck-estimate. Nothing reaches QuickBooks until that function's
-- DECK_ESTIMATE_HOOKS secret names the client's Make webhook; see the function's header.
--
-- Written ONLY by the deck-estimate edge function, with service_role: it validates the request,
-- checks the caller can see this client, inserts the row as 'pending', calls Make, and records
-- what Make reports back. So there are no insert/update/delete policies at all. A browser can't
-- fake a "created" row or rewrite a QuickBooks number.
--
-- Read by the client's own staff and by admins through client_row_visible(), which includes the
-- client_email fallback. That matters here: 3Sixty has no user_client_access rows (checked
-- 2026-10-01), so a policy on user_has_client_access() alone would hide every row from them.
--
-- Holds the CUSTOMER's name, email, phone and address, unlike lead_sources, which stores ids only.
-- That's deliberate: the estimate is for a named person, and the rep needs to find it again. It
-- is the client's own customer data, readable only by that client and by us.

create table if not exists deck_estimates (
    id                   bigint generated always as identity primary key,
    client_name          text        not null,           -- exact clients.name
    created_by           text        not null,           -- auth email of the rep who clicked
    created_at           timestamptz not null default now(),

    customer_name        text        not null,
    customer_email       text        not null,
    customer_phone       text,
    customer_address     text,
    customer_city        text,
    customer_postal_code text,

    -- What the calculator showed. total = the top of its range, which is what the estimate
    -- carries; line_items always sum to it (buildLineItems in the calculator, re-checked by the
    -- function before anything is stored).
    total                numeric(12,2) not null,
    price_low            numeric(12,2),
    line_items           jsonb       not null,
    deck_summary         jsonb       not null default '{}'::jsonb,
    notes                text,

    -- pending     row stored, Make not answered yet (or the function died mid-call)
    -- created     Make reported a QuickBooks estimate: qb_* filled in
    -- failed      Make or QuickBooks refused; error says why. Safe to try again.
    -- unconfirmed Make accepted the request but sent no estimate number back. The estimate may
    --             exist; check QuickBooks before trying again, or it may be created twice.
    status               text        not null default 'pending'
                         check (status in ('pending', 'created', 'failed', 'unconfirmed')),
    error                text,
    qb_estimate_id       text,
    qb_doc_number        text,
    qb_customer_id       text,
    completed_at         timestamptz
);

-- The portal lists a client's recent estimates newest first; the function's duplicate-click
-- check looks up a client + customer email inside the last minute. customer_email is stored
-- lowercased by the function, so the check is a plain equality and needs no lower() index.
create index if not exists deck_estimates_client_created on deck_estimates (client_name, created_at desc);
create index if not exists deck_estimates_dup_check on deck_estimates (client_name, customer_email, created_at desc);

alter table deck_estimates enable row level security;

drop policy if exists "Client or admin reads deck estimates" on deck_estimates;
create policy "Client or admin reads deck estimates" on deck_estimates
    for select using (client_row_visible(client_name));

notify pgrst, 'reload schema';

-- Checks (SQL Editor):
--   select status, count(*) from deck_estimates group by 1;
--   select id, client_name, created_by, customer_name, total, status, qb_doc_number, error, created_at
--     from deck_estimates order by created_at desc limit 20;
