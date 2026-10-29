-- Alta Vista Construction: past ad data (2026-10-07).
--
-- From Ads Manager's campaign export, 2026-09-08 to 2026-10-06 (29 days, 29 rows), so the
-- audit, reports and charts have history from the day Alta joined. Totals: $855.16 spent,
-- 12 leads, 24708 impressions.
--
-- Leads are the export's "Results" where the indicator is a lead form. Days with no results are 0 leads.
-- unique_link_clicks is NOT in that export, so it is left empty. Spend, leads, CPL, impressions and
-- reach are exact; CTR and click-to-lead rate will read as zero for these days only.
-- The campaign shows "not delivering" and zero spend from 2026-09-30, so the audit will show Alta as
-- spend stopped until it is switched back on. That is true, not a data problem.
--
-- Safe to re-run: a date already stored for this ad account is skipped, so it never doubles up
-- with the daily Make pull. Run once in the SQL Editor.

insert into public.daily_reports (date, account_name, spend, impressions, reach, unique_link_clicks, "Leads", client_email, ad_account_id)
select v.d, 'Alta Vista Ad Account', v.spend, v.imp, v.reach, null, v.leads,
       (select c.client_email from public.clients c where c.name = 'Alta Vista Construction'),
       '28982253984709065'
from (values
    ('2026-09-08'::date, 61.78, 2077, 1702, 0),
    ('2026-09-09'::date, 44.84, 1360, 1085, 1),
    ('2026-09-10'::date, 29.22, 1013, 860, 0),
    ('2026-09-11'::date, 47.71, 1699, 1416, 1),
    ('2026-09-12'::date, 15.35, 552, 506, 0),
    ('2026-09-13'::date, 42.64, 1754, 1606, 1),
    ('2026-09-14'::date, 30.04, 1162, 1079, 0),
    ('2026-09-15'::date, 36.61, 1201, 1114, 0),
    ('2026-09-16'::date, 52.70, 1383, 1295, 2),
    ('2026-09-17'::date, 33.80, 916, 841, 0),
    ('2026-09-18'::date, 41.37, 1216, 1093, 0),
    ('2026-09-19'::date, 42.30, 880, 804, 0),
    ('2026-09-20'::date, 50.67, 1086, 975, 0),
    ('2026-09-21'::date, 40.74, 1340, 1152, 1),
    ('2026-09-22'::date, 37.11, 1158, 959, 0),
    ('2026-09-23'::date, 42.57, 1142, 947, 3),
    ('2026-09-24'::date, 43.42, 1192, 1005, 0),
    ('2026-09-25'::date, 28.99, 592, 493, 0),
    ('2026-09-26'::date, 35.22, 869, 770, 2),
    ('2026-09-27'::date, 50.64, 864, 733, 0),
    ('2026-09-28'::date, 29.92, 667, 537, 1),
    ('2026-09-29'::date, 17.52, 585, 529, 0),
    ('2026-09-30'::date, 0.00, 0, 0, 0),
    ('2026-10-01'::date, 0.00, 0, 0, 0),
    ('2026-10-02'::date, 0.00, 0, 0, 0),
    ('2026-10-03'::date, 0.00, 0, 0, 0),
    ('2026-10-04'::date, 0.00, 0, 0, 0),
    ('2026-10-05'::date, 0.00, 0, 0, 0),
    ('2026-10-06'::date, 0.00, 0, 0, 0)
) as v(d, spend, imp, reach, leads)
where not exists (
    select 1 from public.daily_reports r
    where regexp_replace(coalesce(r.ad_account_id, ''), '\D', '', 'g') = '28982253984709065' and r.date = v.d
);

-- Check afterwards (expect 29 rows, $855.16, 12 leads):
--   select count(*), min(date), max(date), sum(spend), sum("Leads") from daily_reports where ad_account_id = '28982253984709065';
