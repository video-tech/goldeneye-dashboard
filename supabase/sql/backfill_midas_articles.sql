-- One-off: backfill Midas Media's 42 existing Sanity articles into seo_changelog.
-- Generated 2026-09-14 from the "midas cuppa" Sanity project (dataset production, type post),
-- the same source the Sanity auto-log webhook reads. Run once in the SQL Editor, after
-- supabase/functions/seo-changelog-webhook/schema.sql (which adds source_ref and its unique key).
--
-- The same shape the webhook writes: kind content, created_by sanity, source_ref sanity:<_id>,
-- live_date = publishedAt (else _createdAt) as a Denver-time day. ON CONFLICT DO NOTHING on
-- (client_name, source_ref), so re-running it, or a post the webhook already logged, can never
-- create a duplicate.
--
-- 18 of these share 2026-04-14. That's the day the first batch of articles was imported into
-- Sanity, so they'll stack as one tall group of markers on that day.

insert into seo_changelog (client_name, live_date, kind, title, url, notes, created_by, source_ref)
select 'Midas Media', v.live_date::date, 'content', v.title, v.url, null, 'sanity', v.source_ref
from (values
    ('2026-04-14', 'How To Get Exclusive Contractor Leads In 2026 Without Fighting Competitors For Every Job', 'https://midasmediafirm.com/resources/how-to-get-exclusive-contractor-leads', 'sanity:62719f39-b331-41d8-932b-dd8ee6660dfb'),
    ('2026-04-14', 'Video Marketing For Contractors: 7 Smart Ways To Win More Local Jobs In 2026', 'https://midasmediafirm.com/resources/video-marketing-for-contractors', 'sanity:14f91250-ff40-493a-a3b7-2915415dea48'),
    ('2026-04-14', 'Why Your Contractor Facebook Ads Are Not Working: 7 Fixes To Get Better Leads In 2026', 'https://midasmediafirm.com/resources/why-are-my-contractor-facebook-ads-not-working', 'sanity:e4d5bc16-6cbb-4b2c-8709-318abd830b9e'),
    ('2026-04-14', 'HVAC Marketing Strategy In 2026: 7 Moves To Win More Local Leads And Book Better Jobs', 'https://midasmediafirm.com/resources/hvac-marketing-strategy', 'sanity:87bf0260-b039-4fd1-b980-1ec8d0a148f4'),
    ('2026-04-14', 'Contractor Marketing In Utah: 7 Proven Ways To Win More Local Jobs In 2026', 'https://midasmediafirm.com/resources/contractor-marketing-utah', 'sanity:4615f42f-3dec-4fbb-bb44-8aeb18d7b606'),
    ('2026-04-14', 'Hyper-Local Contractor Marketing In 2026: How To Win More Jobs In Your Exact Service Area', 'https://midasmediafirm.com/resources/hyper-local-contractor-marketing', 'sanity:5d9da13f-c729-41b2-ae91-0279c013c6eb'),
    ('2026-04-14', 'AI Chatbots For Home Services In 2026: How Contractors Turn More Leads Into Booked Jobs', 'https://midasmediafirm.com/resources/ai-chatbot-for-home-services', 'sanity:90774095-0419-4b85-bfe4-e63aed9126d3'),
    ('2026-04-14', 'Contractor Answering Service Alternatives: 7 Smarter Ways To Capture More Home Service Leads In 2026', 'https://midasmediafirm.com/resources/contractor-answering-service-alternative', 'sanity:29fb3bf9-7280-4f9c-8ceb-dee2d302b815'),
    ('2026-04-14', 'AI For Contractors In 2026: Practical Ways To Win More Jobs And Run Leaner', 'https://midasmediafirm.com/resources/ai-for-contractors', 'sanity:6687364c-4546-46af-9d7c-628e967f0ea7'),
    ('2026-04-14', 'Contractor CRM Marketing In 2026: How To Turn Every Lead Into More Booked Jobs', 'https://midasmediafirm.com/resources/contractor-crm-marketing', 'sanity:19b00e30-b496-41d0-8495-c9b806c9b627'),
    ('2026-04-14', 'How To Get More Leads For Your Business In 2026: A Practical Playbook For Home Service Contractors', 'https://midasmediafirm.com/resources/get-more-leads-for-my-business', 'sanity:162dde1c-e258-477c-a9ac-34f5fab6f4a5'),
    ('2026-04-14', 'Contractor Marketing In 2026: 7 Proven Ways To Win More High-Value Local Jobs', 'https://midasmediafirm.com/resources/contractor-marketing', 'sanity:bfbc7316-040d-4526-be92-9a0d8277b4bd'),
    ('2026-04-14', 'How Do I Generate Leads? A Practical 2026 Guide For Home Service Contractors', 'https://midasmediafirm.com/resources/how-do-i-generate-leads', 'sanity:28b2e102-e8d9-4b76-a9c0-65fd44c1f273'),
    ('2026-04-14', 'What Does Lead Generation Do? A Clear Guide For Contractors Who Want More Qualified Jobs In 2026', 'https://midasmediafirm.com/resources/what-does-a-lead-generation-do', 'sanity:1941084f-e1d2-4c34-ad19-619a9a92ba6b'),
    ('2026-04-14', 'Contractor Marketing Agency Guide For 2026: How To Choose A Partner That Actually Delivers Qualified Leads', 'https://midasmediafirm.com/resources/contractor-marketing-agency', 'sanity:93fdfcbd-afdc-486f-aa74-17324ba88391'),
    ('2026-04-14', 'Marketing Agency For Contractors: How To Choose A Partner That Actually Delivers Qualified Leads In 2026', 'https://midasmediafirm.com/resources/marketing-agency', 'sanity:32820065-5e11-4ad4-9fd9-75f920589138'),
    ('2026-04-14', 'Marketing For My Business: A Practical Growth Plan For Home Service Contractors In 2026', 'https://midasmediafirm.com/resources/marketing-for-my-business', 'sanity:a33aa59e-1175-414d-ab5b-b26f01798fc5'),
    ('2026-04-14', 'How To Market Yourself As A Contractor In 2026: 7 Proven Ways To Win Better Local Jobs', 'https://midasmediafirm.com/resources/how-do-i-market-myself-as-a-contractor', 'sanity:0beda0ab-66e9-4b80-bb55-25ee317d27f9'),
    ('2026-05-13', 'iPhone vs Pro Ads for Home Service Lead Gen: Which Actually Brings Better Jobs in 2026?', 'https://midasmediafirm.com/resources/iphone-vs-pro-ads-home-service-lead-gen', 'sanity:RKRc4uxrbtm49GvZOom3zM'),
    ('2026-05-18', 'How To Use Facebook Ads To Kill The Off-Season And Keep Contractor Leads Flowing Year-Round In 2026', 'https://midasmediafirm.com/resources/how-to-use-facebook-ads-to-kill-the-off-season', 'sanity:vnZzCzn6q0gJcDt7it97Lw'),
    ('2026-05-20', 'The 5-Minute Rule: Why Slow Callbacks Kill High-Value Home Service Leads', 'https://midasmediafirm.com/resources/the-5-minute-rule-why-slow-callbacks-kill-leads', 'sanity:PKbTRCtvxyclBMESgk8vqm'),
    ('2026-05-26', 'Stop Using Stock Photos: Why Real Job Pics Win More Home Service Leads In 2026', 'https://midasmediafirm.com/resources/stop-using-stock-photos-use-real-job-pics-instead', 'sanity:0QwS3wan4r6cc2lRseujTB'),
    ('2026-06-01', 'Why Your Business Is Missing From The Map Pack: 7 Fixes To Win More Local Leads In 2026', 'https://midasmediafirm.com/resources/why-your-business-is-missing-from-the-map-pack', 'sanity:AhyIjaVcinM8sLVLbidXPS'),
    ('2026-06-23', 'Top Home Service Marketing Strategies In Salt Lake City: 7 Ways Contractors Can Win More Local Leads In 2026', 'https://midasmediafirm.com/resources/top-home-service-marketing-strategies-in-salt-lake-city', 'sanity:267YtE2DEssDklBWvQTrh7'),
    ('2026-06-24', 'SEO Ranking for AI (GEO): How Local Contractors Get Recommended in AI Search Results', 'https://midasmediafirm.com/resources/seo-ranking-for-ai-geo', 'sanity:kyxiloQVPgxGx18JP6HQnQ'),
    ('2026-06-26', 'Lead Generation For My Business: A Practical 2026 Guide To Getting More High-Value Local Customers', 'https://midasmediafirm.com/resources/lead-generation-for-my-business', 'sanity:c20a111d-fc5c-4aef-98f5-5e2b46f6674f'),
    ('2026-06-29', 'SEO Vs. FB Ads for Contractors: What Fills Your Trucks Faster in 2026?', 'https://midasmediafirm.com/resources/seo-vs-fb-ads-what-fills-your-trucks-faster', 'sanity:08tw3Ka4Pyohc88UsBIT5j'),
    ('2026-07-02', 'Target Customers Before They Search Google: How Contractors Can Win Demand Earlier In 2026', 'https://midasmediafirm.com/resources/target-customers-before-they-search-google', 'sanity:tf6DGwL4K9iQqYknlp3Wic'),
    ('2026-07-03', 'Mastering Local SEO From Provo To SLC: How Contractors Can Win More Calls In 2026', 'https://midasmediafirm.com/resources/mastering-local-seo-how-to-dominate-searches-provo-to-slc', 'sanity:v6fPI7wqA7fdSHckDh0Yk4'),
    ('2026-07-06', 'Speed To Lead For Contractors: How Faster Follow-Up Wins More High-Value Jobs In 2026', 'https://midasmediafirm.com/resources/speed-to-lead-for-contractors', 'sanity:334633c2-f7f7-400e-bde4-c04e893650bd'),
    ('2026-07-10', 'The $2.5K Facebook Mistake: Why Buying Likes Hurts Contractors More Than It Helps', 'https://midasmediafirm.com/resources/the-dollar25k-facebook-mistake-stop-buying-likes', 'sanity:CWFLRSHj5scJqBD0vndfgB'),
    ('2026-07-16', 'Contractor Lead Follow-Up That Wins More Jobs: A 2026 Playbook For Faster Responses And Higher Close Rates', 'https://midasmediafirm.com/resources/contractor-lead-follow-up', 'sanity:be3c2faa-731a-47d5-bb7e-1bff9fac18a1'),
    ('2026-07-17', 'Stop Buying Shared Contractor Leads: How To Win More Jobs With Exclusive Opportunities In 2026', 'https://midasmediafirm.com/resources/stop-buying-shared-contractor-leads', 'sanity:bd37a4f2-953b-4034-a9ff-d33d2321b712'),
    ('2026-07-20', 'Silicon Slopes Boom: Why Smart-Home Upgrade Services Are Surging In Utah Homes In 2026', 'https://midasmediafirm.com/resources/silicon-slopes-boom-upgrading-services-for-smart-home-owners', 'sanity:voglyBY2PyVH17sSry1qqB'),
    ('2026-08-17', 'Leads for Contractors: How to Get Better Jobs, Higher Close Rates, and Real ROI in 2026', 'https://midasmediafirm.com/resources/leads-for-contractors', 'sanity:d3kJtsVAMS1XBcl0zzLx7c'),
    ('2026-08-18', 'SEO Cost for Contractors: What to Budget—and How to Turn Rankings Into Profitable Jobs', 'https://midasmediafirm.com/resources/seo-cost-for-contractors', 'sanity:2U7qkJP6n1IdQ0j7nlFH8Q'),
    ('2026-08-21', 'How to Get Google Reviews for HVAC: A Compliant System for More Local Leads', 'https://midasmediafirm.com/resources/how-to-get-google-reviews-for-hvac', 'sanity:T3VPSjTNNmrHdHuGR0TZlI'),
    ('2026-08-24', 'Angi vs. Meta Ads for Contractors: Why Shared Leads May Be Draining Your Budget', 'https://midasmediafirm.com/resources/angi-vs-meta-ads-for-contractors', 'sanity:T3VPSjTNNmrHdHuGR5Y8Bq'),
    ('2026-08-26', 'Stop Buying Shared Remodeling Leads: Build a More Predictable Pipeline Instead', 'https://midasmediafirm.com/resources/stop-buying-shared-leads-for-remodeling', 'sanity:cH9DwHcv9nWgReDwASSlgd'),
    ('2026-08-28', 'What Contractor Leads Cost in Utah County by Trade: 2026 Benchmarks and Break-Even Rules', 'https://midasmediafirm.com/resources/what-a-contractor-leads-costs-in-utah-county-by-trade', 'sanity:SiiogsG59ZyfHfGyR0hd2G'),
    ('2026-09-01', 'How a Custom Cabinet Contractor Generated $1.6 Million in Revenue in 19 Months', 'https://midasmediafirm.com/resources/kitchen-cabinet-lead-generation-case-study', 'sanity:c68a7635-9255-4ea5-ab08-17e6c3257451'),
    ('2026-09-08', 'How Much Should Contractors Spend On Ads? A Practical Budget Guide for 2026', 'https://midasmediafirm.com/resources/how-much-should-contractors-spend-on-ads', 'sanity:arAjFvkA3eHvQsV8VwNLqh')
) as v(live_date, title, url, source_ref)
on conflict (client_name, source_ref) do nothing;

-- Check: expect 42 (or 42 plus anything logged since)
-- select count(*), min(live_date), max(live_date) from seo_changelog
-- where client_name = 'Midas Media' and created_by = 'sanity';
