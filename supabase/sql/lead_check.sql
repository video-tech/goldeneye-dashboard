-- Leads check (2026-11-09): the tags that mark a lead in a client's own GHL, for the report's Leads check.
--
-- The ghl-leads edge function counts contacts added to the client's GHL sub-account carrying any of these tags, and
-- the report pop-up shows that count beside Golden Eye's (daily_reports) and Meta's (meta_ad_daily). Lower-case, no
-- blanks; empty means not set yet. On clients, which only admins write (clients_rls.sql), so no new policy. It lives on
-- the client's row, so rename_client() needs nothing new. Safe to re-run.

alter table public.clients add column if not exists lead_tags text[] not null default '{}';

comment on column public.clients.lead_tags is
    'Tags on a contact in the client''s GHL that mean it is a lead (lower-case). Used by the report''s Leads check (ghl-leads).';

notify pgrst, 'reload schema';
