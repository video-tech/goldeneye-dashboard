-- GHL logins for the client's team (2026-10-16). The onboarding team step now lists the owner first and asks, per person,
-- whether they should get a GHL login (so new leads reach them and they can work the pipeline). ghl-account adds those
-- people as GHL users, with the limited role, when it fills the new account.
--
--   ghl_login    the client ticked "Give them a GHL login" for this person
--   ghl_user_id  the GHL user Golden Eye made for them (set only by ghl-account; a person is never added twice)
--
-- Safe to re-run. app.js saves the team without these columns until this has run.

alter table public.client_contacts add column if not exists ghl_login boolean not null default false;
alter table public.client_contacts add column if not exists ghl_user_id text;

notify pgrst, 'reload schema';
