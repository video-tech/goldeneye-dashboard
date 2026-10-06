-- The easter egg's leaderboard (2026-10-06). Seven quick clicks on the logo open a code,
-- then a one-level mission (egg.js). Each finished run is one row here; the end screen
-- shows each person's best time.
--
-- Admins only, both ways: only admins can find the egg, read the board, or add a run, and
-- only as themselves. No updates; delete is admin-only, for clearing a silly time.
-- Not keyed on a client, so no rename_client.sql line.
--
-- Run once in the SQL Editor. Safe to re-run.

begin;

create table if not exists public.egg_runs (
    id bigint generated always as identity primary key,
    player_email text not null,
    player_name text,
    time_ms integer not null check (time_ms between 10000 and 3600000),
    kills integer check (kills between 0 and 100),
    accuracy numeric(5,1) check (accuracy between 0 and 100),
    created_at timestamptz not null default now()
);
create index if not exists egg_runs_time_idx on public.egg_runs (time_ms);

alter table public.egg_runs enable row level security;

drop policy if exists "Admins read the egg leaderboard" on public.egg_runs;
drop policy if exists "Admins add their own egg runs" on public.egg_runs;
drop policy if exists "Admins delete egg runs" on public.egg_runs;

create policy "Admins read the egg leaderboard" on public.egg_runs
    for select using (current_user_is_admin());

create policy "Admins add their own egg runs" on public.egg_runs
    for insert with check (
        current_user_is_admin()
        and lower(player_email) = lower(coalesce(auth.email(), ''))
    );

create policy "Admins delete egg runs" on public.egg_runs
    for delete using (current_user_is_admin());

commit;

notify pgrst, 'reload schema';

-- The board, best time per person:
--   select distinct on (lower(player_email)) player_name, time_ms / 1000.0 as seconds, accuracy, created_at
--   from egg_runs order by lower(player_email), time_ms;
