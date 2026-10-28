-- Deck estimate PDFs saved to a client's GHL contacts (built 2026-10-28). One row per "Save to contact"
-- click in a client's Deck Calculator tab (3Sixty Industries today).
--
-- Run this, then re-run supabase/sql/rename_client.sql (it now moves contact_estimate_files), then deploy
-- supabase/functions/ghl-estimate-contact. Needs ghl_accounts.sql to have been run already: the function
-- logs each GHL write in ghl_write_log first.
--
-- Written ONLY by the function (service_role): no insert, update or delete policies. Read by the client's own
-- staff and by admins through client_row_visible() (which includes the client_email fallback). Holds the
-- contact's NAME as GHL returned it, so the rep can see who it went to, and a link to the stored PDF.

create table if not exists contact_estimate_files (
    id           bigint generated always as identity primary key,
    client_name  text        not null,             -- exact clients.name
    created_by   text        not null,             -- auth email of the rep who clicked
    created_at   timestamptz not null default now(),
    contact_id   text        not null,             -- GHL contact id
    contact_name text,
    file_name    text        not null,
    file_url     text        not null,             -- the PDF in that GHL account's media library
    file_id      text,
    note_id      text,                             -- the note on the contact that links to it
    total        numeric(12,2),
    material     text,
    -- saved    PDF uploaded and the note added
    -- partial  PDF uploaded, but the note failed (error says why): the file exists, the contact has no note
    status       text        not null default 'saved' check (status in ('saved', 'partial')),
    error        text
);

create index if not exists contact_estimate_files_client_created on contact_estimate_files (client_name, created_at desc);
create index if not exists contact_estimate_files_rate_check on contact_estimate_files (created_by, created_at desc);

alter table contact_estimate_files enable row level security;

drop policy if exists "Client or admin reads contact estimate files" on contact_estimate_files;
create policy "Client or admin reads contact estimate files" on contact_estimate_files
    for select using (client_row_visible(client_name));

notify pgrst, 'reload schema';

-- Checks (SQL Editor):
--   select client_name, contact_name, total, status, error, created_at from contact_estimate_files order by created_at desc limit 20;
--   select at, by, method, path, summary, ok, status, error from ghl_write_log order by at desc limit 20;
