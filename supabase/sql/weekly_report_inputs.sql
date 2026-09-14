-- What the admin typed into the "Generate report" notes box, kept beside the report it produced.
-- Run once in the SQL Editor.
--
-- This is a separate table rather than a column on weekly_reports on purpose. The client portal
-- reads weekly_reports with select('*') (initClientPortal in app.js), so any column added there
-- is readable by every client whose RLS lets them see the row. RLS works on rows, not columns.
-- These notes are staff input, often blunter than what goes to the client (the same reason
-- tasks.notes never reaches the client work summary), so they get their own admin-only table.
--
-- Keyed on report_id, not client_name, so rename_client() needs no line for it: a rename moves
-- the report, and its notes follow through the id. Deleting a report deletes its notes.

create table if not exists weekly_report_inputs (
    report_id  bigint primary key references weekly_reports(id) on delete cascade,
    notes      text not null,
    created_by text default auth.email(),
    created_at timestamptz not null default now()
);

alter table weekly_report_inputs enable row level security;

drop policy if exists "Admins manage report inputs" on weekly_report_inputs;
create policy "Admins manage report inputs"
on weekly_report_inputs for all
using (current_user_is_admin())
with check (current_user_is_admin());

notify pgrst, 'reload schema';

-- Check: an admin sees rows, and nobody else does.
-- select r.created_at, r.client_name, i.notes
-- from weekly_reports r join weekly_report_inputs i on i.report_id = r.id
-- order by r.created_at desc limit 10;
