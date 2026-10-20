-- Automatic GHL accounts (2026-10-16): the records the ghl-account function keeps. Run this, then rename_client.sql,
-- then deploy ghl-account, then supabase/functions/ghl-account/schedule.sql. Safe to re-run.
--
--   ghl_accounts    one row per client whose GHL account Golden Eye created. The row is written BEFORE the account is
--                   created, so two runs can never create two accounts for one client (the primary key refuses the
--                   second). status: creating -> awaiting_install (we wait for the install click) -> filled.
--                   failed means creating went wrong; the error is in last_error, and an admin retries.
--   ghl_write_log   every write Golden Eye makes in GHL: who or what started it, which account, which endpoint, a short
--                   summary, and whether GHL accepted it. Never a token, never an answer's value.
--
-- Both are admin-read only. Only the function writes (service_role, which bypasses RLS).

create table if not exists public.ghl_accounts (
    client_name  text primary key,
    location_id  text unique,
    status       text not null default 'creating' check (status in ('creating', 'awaiting_install', 'filled', 'failed')),
    snapshot_id  text,
    created_by   text,
    created_at   timestamptz not null default now(),
    installed_at timestamptz,
    filled_at    timestamptz,
    fill_report  jsonb,
    last_error   text,
    updated_at   timestamptz not null default now()
);

create table if not exists public.ghl_write_log (
    id          bigserial primary key,
    at          timestamptz not null default now(),
    by          text,
    client_name text,
    location_id text,
    method      text not null,
    path        text not null,
    summary     text,
    ok          boolean not null,
    status      int,
    error       text
);
create index if not exists ghl_write_log_at on public.ghl_write_log (at desc);

alter table public.ghl_accounts enable row level security;
alter table public.ghl_write_log enable row level security;
revoke all on public.ghl_accounts, public.ghl_write_log from anon;

drop policy if exists "Admins read GHL accounts" on public.ghl_accounts;
create policy "Admins read GHL accounts" on public.ghl_accounts for select using (current_user_is_admin());
drop policy if exists "Admins read the GHL write log" on public.ghl_write_log;
create policy "Admins read the GHL write log" on public.ghl_write_log for select using (current_user_is_admin());

-- The checklist step now describes what happens
update public.stage_templates set default_notes =
    'Golden Eye creates their GHL account from MasterV.1 within 10 minutes of their onboarding finishing, and saves its location ID. Open the Golden Eye app''s install link, tick the new account and install: GHL won''t install the app on a new account by itself. Within 10 minutes of the install, Golden Eye fills every custom value from their answers.'
 where stage = 'Onboarding' and task_type = 'Setup step' and task_title = 'GHL — Install the Golden Eye app on their new GHL account';
update public.tasks set notes =
    'Golden Eye creates their GHL account from MasterV.1 within 10 minutes of their onboarding finishing, and saves its location ID. Open the Golden Eye app''s install link, tick the new account and install: GHL won''t install the app on a new account by itself. Within 10 minutes of the install, Golden Eye fills every custom value from their answers.'
 where type = 'Setup step' and title = 'GHL — Install the Golden Eye app on their new GHL account' and status <> 'Complete';

notify pgrst, 'reload schema';

-- Check:
--   select client_name, location_id, status, created_at, filled_at, last_error from ghl_accounts order by created_at desc;
--   select at, by, client_name, method, path, summary, ok, status, error from ghl_write_log order by at desc limit 50;
