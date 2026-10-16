-- Is each client a contact in our Midas GHL? (2026-10-16) The onboarding-complete tag and text (Make scenario #4) only
-- reach a client whose email matches exactly one contact in our Midas GHL account; a missing or duplicated contact makes
-- them silently not happen. The ghl-contact-check function looks each client up and records the result here, and
-- Golden Eye shows it on the Roster and on the client's onboarding progress.
--
--   email   the email the onboarding trigger sends to Make: the FIRST address in clients.client_email, spaces removed
--   status  found (exactly one contact) / missing (none) / duplicate (more than one) / no_email / error
--
-- Run this, then rename_client.sql, then deploy ghl-contact-check, then supabase/functions/ghl-contact-check/schedule.sql.
-- Admin-read only; only the function writes (service_role). Safe to re-run.

create table if not exists public.client_ghl_contacts (
    client_name text primary key,
    email       text,
    status      text not null check (status in ('found', 'missing', 'duplicate', 'no_email', 'error')),
    contact_id  text,
    matches     int not null default 0,
    error       text,
    checked_at  timestamptz not null default now()
);

alter table public.client_ghl_contacts enable row level security;
revoke all on public.client_ghl_contacts from anon;
drop policy if exists "Admins read the GHL contact check" on public.client_ghl_contacts;
create policy "Admins read the GHL contact check" on public.client_ghl_contacts for select using (current_user_is_admin());

notify pgrst, 'reload schema';

-- Check:
--   select client_name, email, status, matches, checked_at, error from client_ghl_contacts order by status, client_name;
