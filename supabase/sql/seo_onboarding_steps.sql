-- SEO Growth onboarding steps (2026-09-15). Run after service_onboarding.sql and auto_check_reconcile.sql.
-- Run once. A step whose title already exists is skipped, so edits made in Templates → Client
-- Onboarding are never overwritten, but a step renamed there would be added again by a re-run.
--
-- Every step is tagged {seo}, so only clients with SEO Growth get them.
--
-- The two CLIENT steps go in HIDDEN (active = false). The intake is a GHL form and the access step
-- is a video, and neither exists yet; a live step with no link shows clients an empty box. When
-- each is ready: Templates → Client Onboarding, paste the link, click the eye to switch it on, Save.
--
-- The seven AGENCY steps go in live. They only become tasks when an SEO client finishes their
-- onboarding steps, and six of them close themselves (see auto_check_reconcile.sql).

with new_steps (n, owner, step_type, title, description, due_days, requires_confirm, confirm_label, offer_help, auto_check, active) as (values
    -- Client steps (hidden until the form and video exist)
    (1, 'client', 'form',  'Tell us about your business for SEO',
        'The services you want to be found for, the towns you serve, and how your brand talks, so every page and article sounds like you.',
        0, false, null, false, null, false),
    (2, 'client', 'video', 'Give us access to Google',
        'A short video showing how to add us to Search Console, Google Analytics and your Google Business Profile. If we''re building your website, you only need the Business Profile part.',
        0, true, 'I''ve added you', true, null, false),

    -- Our tasks, in the order they're worked
    (3, 'agency', 'action', 'Connect Search Console',
        'Accept the Search Console access, paste the exact property into Edit Client, and click Test Search Console. Closes itself once data starts arriving.',
        2, false, null, false, 'gsc_connected', true),
    (4, 'agency', 'action', 'Create the SE Ranking project',
        'New project for their domain, a Google search engine per town they serve, their target keywords. Put the project ID in Edit Client. Closes itself once rankings arrive.',
        3, false, null, false, 'seranking_connected', true),
    (5, 'agency', 'action', 'Save SEO start date and fee',
        'Edit Client: SEO start date and monthly SEO fee. Their SEO tab''s "since we started" and return figures use these.',
        1, false, null, false, 'seo_settings_set', true),
    (6, 'agency', 'action', 'Set up article auto-logging',
        'SEO tab → Auto-log articles: pick their platform, save, paste the link into their site''s webhook settings. Do this before Cuppa publishes anything.',
        3, false, null, false, 'autolog_configured', true),
    (7, 'agency', 'action', 'Set up Cuppa',
        'Create their Cuppa workspace with the brand voice from their intake, connect it to their site, and publish the first article. Closes itself when that article auto-logs.',
        7, false, null, false, 'first_article_logged', true),
    (8, 'agency', 'action', 'Set up lead tracking',
        'GHL: Contact Created workflow webhook to Golden Eye, GHL location ID in Edit Client, and the lead-source snippet on their site. Then submit one real Google-search test lead. Closes itself when the first website lead arrives.',
        5, false, null, false, 'lead_tracking_live', true),
    (9, 'agency', 'action', 'Keyword research and page plan',
        'Pick the searches worth ranking for and plan the service and location pages to build. Tick this off by hand.',
        7, false, null, false, null, true)
),
start as (select coalesce(max(sort_order), 0) as base from onboarding_steps)
insert into onboarding_steps (owner, step_type, title, description, embed_url, assignee, due_days,
                              offer_help, requires_confirm, confirm_label, sort_order, active,
                              service_keys, website_statuses, auto_check)
select ns.owner, ns.step_type, ns.title, ns.description, null, null, ns.due_days,
       ns.offer_help, ns.requires_confirm, ns.confirm_label, (select base from start) + ns.n, ns.active,
       '{seo}', '{}', ns.auto_check
from new_steps ns
where not exists (select 1 from onboarding_steps s where lower(btrim(s.title)) = lower(btrim(ns.title)));

-- What went in:
--   select sort_order, owner, step_type, title, active, service_keys, auto_check
--   from onboarding_steps where 'seo' = any (service_keys) order by sort_order;
