-- GHL contacts for the report's Leads check (2026-11-09).
--
-- GHL's app couldn't be given read access to contacts, so each client's GHL sends them to us instead: the existing
-- ghl-lead-webhook (the "leads to Golden Eye" workflow) now also records every contact it receives here, on Contact
-- Created AND on Contact Tag added, because a contact arrives with no tags and GHL's workflows tag it a moment later.
-- Tags from every event are merged, never replaced, so a later event can't drop a tag.
--
-- Counts only: the contact id, which client, when it was created, its tags and GHL's source label. No name, email,
-- phone or address. Admins read it (the report pop-up counts it); only the webhook writes it, through
-- record_ghl_contact() with the service key. Safe to re-run. Then re-run supabase/sql/rename_client.sql.

begin;

create table if not exists public.ghl_contacts (
    ghl_contact_id  text not null,
    client_name     text not null,
    ghl_location_id text,
    created_at      timestamptz not null,
    tags            text[] not null default '{}',
    source          text,
    first_seen      timestamptz not null default now(),
    last_seen       timestamptz not null default now(),
    primary key (ghl_contact_id, client_name)
);
create index if not exists ghl_contacts_client_created on public.ghl_contacts (client_name, created_at);

alter table public.ghl_contacts enable row level security;
drop policy if exists "Admins read GHL contacts" on public.ghl_contacts;
create policy "Admins read GHL contacts" on public.ghl_contacts for select using (current_user_is_admin());

-- One contact event: insert it, or merge its tags into the stored ones (lower-cased, no blanks, no repeats).
-- The first created_at and source win, so a later event never moves a contact to another day.
create or replace function public.record_ghl_contact(
    p_contact text, p_client text, p_location text, p_created timestamptz, p_tags text[], p_source text
) returns void
language sql
security definer
set search_path = public
as $$
    insert into ghl_contacts (ghl_contact_id, client_name, ghl_location_id, created_at, tags, source)
    values (
        p_contact, p_client, p_location, coalesce(p_created, now()),
        coalesce(array(select distinct lower(btrim(t)) from unnest(coalesce(p_tags, '{}')) t where btrim(t) <> '' order by 1), '{}'),
        nullif(left(btrim(coalesce(p_source, '')), 200), '')
    )
    on conflict (ghl_contact_id, client_name) do update set
        tags = array(select distinct t from unnest(ghl_contacts.tags || excluded.tags) t order by 1),
        ghl_location_id = coalesce(ghl_contacts.ghl_location_id, excluded.ghl_location_id),
        source = coalesce(ghl_contacts.source, excluded.source),
        last_seen = now();
$$;

revoke all on function public.record_ghl_contact(text, text, text, timestamptz, text[], text) from public, anon, authenticated;
grant execute on function public.record_ghl_contact(text, text, text, timestamptz, text[], text) to service_role;

commit;

notify pgrst, 'reload schema';
