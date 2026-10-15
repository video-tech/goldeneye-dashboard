-- ghl_oauth_tokens: the keys Golden Eye's private GHL Marketplace app gets when it is installed on the agency
-- (built 2026-10-15). One row per GHL company (agency). Written and read only by edge functions (service_role).
--
-- The tokens are stored ENCRYPTED (AES-GCM, key in the GHL_TOKEN_KEY edge secret), because this one key can reach
-- every sub-account in the agency, and other roles (Claude's read-only connection included) can read tables.
-- RLS is on with no policies, so anon and signed-in users get nothing either way.
--
-- Run once in the SQL Editor. Re-runnable.

create table if not exists public.ghl_oauth_tokens (
    company_id          text primary key,
    access_token_enc    text not null,
    refresh_token_enc   text not null,
    expires_at          timestamptz not null,
    scope               text,
    user_id             text,
    install_to_future   boolean,
    approve_all         boolean,
    installed_at        timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

alter table public.ghl_oauth_tokens enable row level security;
revoke all on public.ghl_oauth_tokens from public, anon, authenticated;

-- Claude's read-only connector role: no access at all, encrypted or not.
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'supabase_read_only_user') then
        execute 'revoke all on public.ghl_oauth_tokens from supabase_read_only_user';
    end if;
end $$;

notify pgrst, 'reload schema';

-- Check (shows only whether the app is installed and when the key next renews, never a token):
-- select company_id, expires_at, install_to_future, approve_all, installed_at, updated_at from ghl_oauth_tokens;
