-- Who is online, and what they are doing (2026-10-14): the office on Settings > Users & Roles.
--
-- One row per team member. Their browser updates it every 30 seconds while Golden Eye is open (page,
-- the client they are looking at, whether they have stepped away), and the Users tab reads everyone's
-- row to draw the office. The row also keeps the person's character and their typed status, so a
-- character survives being offline.
--
-- Admins only, both ways, and only their own row can be written: nobody can move or rename a colleague.
-- Clients and investors can neither read nor write it, so a client's browser never learns who is on the
-- team or what they are looking at. Nothing here is personal data beyond a first name and an email,
-- both already in user_profiles. Not keyed on a client, so no rename_client.sql line.
--
-- Plain table and polling rather than Realtime channels on purpose: a public Realtime channel can be
-- joined by anyone holding the (public) anon key, while a table is protected by row-level security.
--
-- Run once in the SQL Editor. Safe to re-run.

begin;

create table if not exists public.team_presence (
    email text primary key,
    name text check (char_length(name) <= 40),
    character jsonb check (character is null or pg_column_size(character) < 600),
    status text check (char_length(status) <= 80),
    status_at timestamptz,
    page text check (char_length(page) <= 40),
    detail text check (char_length(detail) <= 80),
    away boolean not null default false,
    last_seen timestamptz not null default now(),
    check (email = lower(email))
);

alter table public.team_presence enable row level security;

drop policy if exists "Admins see the team" on public.team_presence;
drop policy if exists "Admins add their own presence" on public.team_presence;
drop policy if exists "Admins update their own presence" on public.team_presence;
drop policy if exists "Admins remove their own presence" on public.team_presence;

create policy "Admins see the team" on public.team_presence
    for select using (current_user_is_admin());

create policy "Admins add their own presence" on public.team_presence
    for insert with check (current_user_is_admin() and email = lower(coalesce(auth.email(), '')));

create policy "Admins update their own presence" on public.team_presence
    for update using (current_user_is_admin() and email = lower(coalesce(auth.email(), '')))
    with check (current_user_is_admin() and email = lower(coalesce(auth.email(), '')));

create policy "Admins remove their own presence" on public.team_presence
    for delete using (current_user_is_admin() and email = lower(coalesce(auth.email(), '')));

commit;

notify pgrst, 'reload schema';

-- Look at it:
--   select email, name, page, detail, status, away, now() - last_seen as ago from team_presence order by last_seen desc;
