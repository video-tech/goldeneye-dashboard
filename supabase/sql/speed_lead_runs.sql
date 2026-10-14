-- The second easter egg's leaderboard (2026-10-13). Typing 5min anywhere (outside a text box) opens
-- Speed to Lead (speedlead.js): a 60-second game of replying to leads before they go cold. Each
-- finished run is one row here; the end screen shows each person's best score.
--
-- Admins only, both ways: only admins can find the game, read the board, or add a run, and only as
-- themselves. No updates; delete is admin-only, for clearing a silly score. Not keyed on a client,
-- so no rename_client.sql line. Separate from egg_runs, whose time check does not fit a score.
--
-- Run once in the SQL Editor. Safe to re-run.

begin;

create table if not exists public.speed_lead_runs (
    id bigint generated always as identity primary key,
    player_email text not null,
    player_name text,
    score integer not null check (score between 1 and 50000),
    replies integer check (replies between 0 and 200),
    best_streak integer check (best_streak between 0 and 200),
    avg_reply_ms integer check (avg_reply_ms between 0 and 120000),
    accuracy numeric(5,1) check (accuracy between 0 and 100),
    created_at timestamptz not null default now()
);
create index if not exists speed_lead_runs_score_idx on public.speed_lead_runs (score desc);

alter table public.speed_lead_runs enable row level security;

drop policy if exists "Admins read the speed to lead board" on public.speed_lead_runs;
drop policy if exists "Admins add their own speed to lead runs" on public.speed_lead_runs;
drop policy if exists "Admins delete speed to lead runs" on public.speed_lead_runs;

create policy "Admins read the speed to lead board" on public.speed_lead_runs
    for select using (current_user_is_admin());

create policy "Admins add their own speed to lead runs" on public.speed_lead_runs
    for insert with check (
        current_user_is_admin()
        and lower(player_email) = lower(coalesce(auth.email(), ''))
    );

create policy "Admins delete speed to lead runs" on public.speed_lead_runs
    for delete using (current_user_is_admin());

commit;

notify pgrst, 'reload schema';

-- The board, best score per person:
--   select distinct on (lower(player_email)) player_name, score, avg_reply_ms, created_at
--   from speed_lead_runs order by lower(player_email), score desc;
