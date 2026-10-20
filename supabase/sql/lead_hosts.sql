-- Which landing hosts count as a client's own website (2026-10-12).
--
-- ghl-lead-webhook files a lead under a client when its landing page is on the client's
-- domain, subdomains included. That's wrong for Midas Media, whose domain also hosts client
-- landing pages: leads from everoakcabinetry.midasmediafirm.com and
-- astrarealestate.midasmediafirm.com (paid, for our clients Everoak and Astra) were stored as
-- Midas's website leads. 42 of Midas's 43 rows were those.
--
-- clients.lead_hosts is an optional allow-list. When it has values, only those hosts count
-- (www. is ignored). Empty or null keeps the old rule: the whole domain.
--
-- Run this BEFORE deploying the updated function. The function copes either way (it asks
-- without the column if it isn't there yet), but the allow-list does nothing until this runs.
-- Safe to re-run.

begin;

alter table public.clients add column if not exists lead_hosts text[];

-- Midas's own pages: the site, and the calendar's booking host
update public.clients
set lead_hosts = array['midasmediafirm.com', 'goldeneye.midasmediafirm.com']
where name = 'Midas Media';

-- Remove the leads that were filed under Midas by mistake. They belong to other clients'
-- landing pages, which aren't website leads for any SEO client. The contacts are untouched
-- in GHL; only these Golden Eye rows go.
delete from public.lead_sources
where client_name = 'Midas Media'
  and lower(landing_host) not in ('midasmediafirm.com', 'www.midasmediafirm.com', 'goldeneye.midasmediafirm.com');

commit;

notify pgrst, 'reload schema';

-- Check afterwards (expect 1 row, the organic lead from goldeneye.midasmediafirm.com):
--   select landing_host, source, count(*) from lead_sources where client_name = 'Midas Media' group by 1, 2;
