-- meta-sync: per-ad daily numbers and the ad account change log (2026-10-05).
-- Run once in the SQL Editor, then re-run supabase/sql/rename_client.sql, then deploy meta-sync.
-- Safe to re-run.
--
-- Admin-only by RLS, by the user's choice: the change log names who made each change, and the
-- per-ad numbers are working data. Clients see only what a report says about them.
-- Written only by the meta-sync function (service_role, which bypasses RLS).

begin;

create table if not exists public.meta_ad_daily (
  client_name    text not null,
  ad_account_id  text not null,
  date           date not null,
  ad_id          text not null,
  ad_name        text,
  adset_id       text,
  adset_name     text,
  campaign_id    text,
  campaign_name  text,
  spend          numeric(12,2) not null default 0,
  impressions    integer not null default 0,
  reach          integer not null default 0,
  link_clicks    integer not null default 0,
  leads          integer not null default 0,
  synced_at      timestamptz not null default now(),
  primary key (ad_account_id, date, ad_id)
);
create index if not exists meta_ad_daily_client_date on public.meta_ad_daily (client_name, date);
create index if not exists meta_ad_daily_adset on public.meta_ad_daily (adset_id, date);
create index if not exists meta_ad_daily_campaign on public.meta_ad_daily (campaign_id, date);

create table if not exists public.meta_activity (
  event_key        text primary key,     -- the log has no id; see fnv64 in meta-sync/parse.ts
  client_name      text not null,
  ad_account_id    text not null,
  event_time       timestamptz not null,
  event_type       text not null,         -- Graph name, e.g. update_ad_set_budget
  event_label      text,                  -- Meta's wording, e.g. "Ad set budget updated"
  object_id        text,
  object_name      text,
  object_type      text,
  actor_name       text,                  -- "Meta" for Meta's own system changes
  actor_is_meta    boolean not null default false,
  application_name text,
  extra            jsonb,                 -- allow-listed: type, old_value, new_value, currency, campaign_id
  category         text not null,         -- status, budget, bid, targeting, creative, schedule, created…
  significant      boolean not null default false,
  synced_at        timestamptz not null default now()
);
create index if not exists meta_activity_client_time on public.meta_activity (client_name, event_time);

create table if not exists public.meta_sync_state (
  client_name    text primary key,
  ad_account_id  text,
  last_run_at    timestamptz,
  last_window    text,
  last_error     text
);

alter table public.meta_ad_daily   enable row level security;
alter table public.meta_activity   enable row level security;
alter table public.meta_sync_state enable row level security;

drop policy if exists "Admins read meta ad daily" on public.meta_ad_daily;
drop policy if exists "Admins read meta activity" on public.meta_activity;
drop policy if exists "Admins read meta sync state" on public.meta_sync_state;
create policy "Admins read meta ad daily"   on public.meta_ad_daily   for select using (current_user_is_admin());
create policy "Admins read meta activity"   on public.meta_activity   for select using (current_user_is_admin());
create policy "Admins read meta sync state" on public.meta_sync_state for select using (current_user_is_admin());

commit;

notify pgrst, 'reload schema';
