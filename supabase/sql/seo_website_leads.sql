-- seo_website_leads: every lead from a client's own website, whatever its source, plus the day
-- lead tracking began for that client. Added 2026-10-30.
--
-- Why: "Leads from Google" counts source = 'organic' only, and some sites hide the source. PANDEN's
-- contact form sits in a Wix frame, so every one of its website leads is stored as unknown /
-- wix_embed, and its Google tile read 0 while the site brought in about 15 leads a month. This is
-- the honest second number: website leads, not claimed to be from Google.
--
-- - Counted: every lead_sources row for the client except source = 'paid' (a paid funnel on the
--   client's own subdomain, like PANDEN's go.pandenconstruction.com, lands in lead_sources too).
-- - Days are Denver days, the same as seo_client_overview.
-- - tracking_start: the earlier of 2026-09-11 (when the webhook started) and the client's first
--   stored lead, so a client whose history was backfilled from GHL (PANDEN, back to 2024-01-04)
--   gets compared over periods that really were measured. Organic leads keep the global date:
--   a backfill can't say which old leads came from Google.
-- - SECURITY INVOKER, so lead_sources' own RLS (client_row_visible) decides what a caller sees.
--
-- Re-runnable. No table changes, so nothing for rename_client.sql.

create or replace function seo_website_leads(
    p_client text, p_start date, p_end date, p_prior_start date, p_prior_end date
)
returns table (website_leads bigint, prior_website_leads bigint, tracking_start date)
language sql stable
security invoker
set search_path = public
as $$
    with l as (
        select (created_at at time zone 'America/Denver')::date as d
        from lead_sources
        where client_name = p_client and source is distinct from 'paid'
    )
    select count(*) filter (where d between p_start and p_end),
           count(*) filter (where d between p_prior_start and p_prior_end),
           least(date '2026-09-11', min(d))
    from l;
$$;

revoke execute on function seo_website_leads(text, date, date, date, date) from public, anon;
grant execute on function seo_website_leads(text, date, date, date, date) to authenticated, service_role;

notify pgrst, 'reload schema';
