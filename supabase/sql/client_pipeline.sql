-- The client's lead pipeline, back on the portal (2026-11-13).
--
-- Off until the client switches it on: clients.pipeline_enabled_at stays null until they press "Turn on my pipeline" in the
-- portal, so leads never pile up in a pipeline nobody works (the old Make scenario "LEADS ghl to goldeneye" filled PANDEN's
-- with 357 leads that never left New Lead; it has been off since 2026-08-19 and is not used again).
--
-- Where leads come from: the Lead Relay webhook (ghl-lead-webhook), which already receives every contact from each client's
-- GHL. After recording the contact it calls add_pipeline_lead(); a lead is added only when the client's pipeline is on and
-- the contact carries one of the client's lead tags (clients.lead_tags, else 'ge lead'; website: website_lead_tags, else
-- 'website lead'), with the tags merged across events in ghl_contacts. One row per contact (first write wins), so GHL's
-- retries and later tag events never add it twice, and a lead a client deleted or moved is never touched again.
--
-- This is the one place Golden Eye stores a lead's name, phone and email: the pipeline is useless without them. Only for
-- clients who switched it on; read and changed by that client (and admins) through the existing client_row_visible policy.
--
-- Safe to re-run. Run before deploying ghl-lead-webhook (it carries on without the function, but adds nothing).

begin;

alter table public.clients add column if not exists pipeline_enabled_at timestamptz;

alter table public.client_leads add column if not exists ghl_contact_id text;
create unique index if not exists client_leads_client_contact on public.client_leads (client_name, ghl_contact_id)
    where ghl_contact_id is not null;

-- Switch the pipeline on or off. Clients don't write `clients` (admins only), so this checks the caller can see the client
-- and changes that one column. Turning it off stops new leads and hides the board; leads already in it are kept.
create or replace function public.set_client_pipeline(p_client text, p_on boolean)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare v timestamptz;
begin
    if auth.uid() is null then raise exception 'Sign in first'; end if;
    if not client_row_visible(p_client) then raise exception 'Not your account'; end if;
    update clients
       set pipeline_enabled_at = case when p_on then coalesce(pipeline_enabled_at, now()) else null end
     where name = p_client
    returning pipeline_enabled_at into v;
    if not found then raise exception 'No such client'; end if;
    return v;
end;
$$;
revoke all on function public.set_client_pipeline(text, boolean) from public, anon;
grant execute on function public.set_client_pipeline(text, boolean) to authenticated;

-- Called by ghl-lead-webhook (service key) after record_ghl_contact. Returns true when a lead was added.
create or replace function public.add_pipeline_lead(
    p_client text, p_contact text, p_name text, p_phone text, p_email text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    c       record;
    v_tags  text[];
    v_ad    text[];
    v_web   text[];
    v_src   text;
    v_rows  int;
begin
    select name, pipeline_enabled_at, lead_tags, website_lead_tags into c
      from clients where name = p_client order by created_at desc nulls last limit 1;
    if c.name is null or c.pipeline_enabled_at is null or coalesce(btrim(p_contact), '') = '' then return false; end if;

    select tags into v_tags from ghl_contacts where ghl_contact_id = p_contact and client_name = p_client;
    v_ad  := coalesce(nullif(array(select lower(btrim(t)) from unnest(coalesce(c.lead_tags, '{}')) t where btrim(t) <> ''), '{}'), array['ge lead']);
    v_web := coalesce(nullif(array(select lower(btrim(t)) from unnest(coalesce(c.website_lead_tags, '{}')) t where btrim(t) <> ''), '{}'), array['website lead']);
    if coalesce(v_tags, '{}') && v_web then v_src := 'Website';
    elsif coalesce(v_tags, '{}') && v_ad then v_src := 'Ads';
    else return false;
    end if;

    insert into client_leads (client_name, ghl_contact_id, lead_name, lead_phone, lead_email, source, stage)
    values (
        p_client, p_contact,
        coalesce(nullif(left(btrim(coalesce(p_name, '')), 200), ''), nullif(left(btrim(coalesce(p_phone, '')), 40), ''), 'New lead'),
        nullif(left(btrim(coalesce(p_phone, '')), 40), ''),
        nullif(left(lower(btrim(coalesce(p_email, ''))), 200), ''),
        v_src, 'New Lead'
    )
    on conflict (client_name, ghl_contact_id) where ghl_contact_id is not null do nothing;
    get diagnostics v_rows = row_count;
    return v_rows > 0;
end;
$$;
revoke all on function public.add_pipeline_lead(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.add_pipeline_lead(text, text, text, text, text) to service_role;

commit;

notify pgrst, 'reload schema';
