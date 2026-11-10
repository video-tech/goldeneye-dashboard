-- Leads check (2026-11-10): website lead tags, counted apart from ad lead tags.
--
-- clients.lead_tags are now the AD lead tags (funnels, quizzes, Meta forms), compared with the daily pull. A client's
-- website forms get their own tags here, compared with the SEO tab's website leads instead: adding them into the ad
-- count made GHL read high by every website lead and flagged a gap that wasn't one. Run after lead_check.sql.
-- Any tag already saved in lead_tags that contains "website" (3Sixty's "website lead") is moved here. Safe to re-run.

begin;

alter table public.clients add column if not exists website_lead_tags text[] not null default '{}';

comment on column public.clients.website_lead_tags is
    'Tags on a contact in the client''s GHL that mean a lead from their own website (lower-case). Counted apart from lead_tags (ad leads) in the report''s Leads check.';

update public.clients
   set website_lead_tags = array(select distinct t from unnest(website_lead_tags || array(select x from unnest(lead_tags) x where x like '%website%')) t order by t),
       lead_tags = array(select x from unnest(lead_tags) x where x not like '%website%')
 where exists (select 1 from unnest(lead_tags) x where x like '%website%');

commit;

notify pgrst, 'reload schema';
