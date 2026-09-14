-- One-off: backfill 3Sixty Industries' 55 published Webflow blog posts into seo_changelog.
-- Generated 2026-09-14 from their Webflow CMS export (Blog Posts collection 69a61807115af520abd83806).
-- Left out: 5 drafts, 3 never-published items. The Webflow webhook logs those when they go live.
--
-- WHY THE DATE NEEDS WORK. Webflow's "Published On" is the item's MOST RECENT publish, not its first.
-- 30 posts share 2026-07-07 and 11 share 2026-08-13 from bulk republishes, and 4 posts written in
-- 2025 show 2026-03-13. "Created On" is when the draft was made. So each post's live_date is,
-- in order:
--   1. Original Post Date, when someone set it (8 posts)
--   2. otherwise the earlier of Published On and the first day Search Console recorded an
--      impression for that page (a page can't be shown in Google before it's live), and never
--      earlier than Created On
--   3. and when Search Console has never seen the page, Published On
-- All as the Denver-time day, matching the auto-log webhook.
--
-- source_ref is webflow:<Item ID>, exactly what the Webflow webhook writes. ON CONFLICT DO NOTHING
-- on (client_name, source_ref), so a post the webhook already logged (the Sep 14 pergola article)
-- isn't duplicated, and re-running this file changes nothing.
--
-- Preview before inserting: run everything from "with posts as" down to "from dated", replacing
-- the INSERT line with "select *".

insert into seo_changelog (client_name, live_date, kind, title, url, notes, created_by, source_ref)
with posts (source_ref, title, slug, created_on, original_date, published_on) as (
  values
    ('webflow:69a61807115af520abd838c0', 'Top 5 Deck Design Ideas for Utah Backyards', 'top-5-deck-design-ideas-for-utah-backyards', '2025-07-28T16:38:57.000Z', '2025-07-25T00:00:00.000Z', '2026-03-13T21:02:47.000Z'),
    ('webflow:69a61807115af520abd838c1', 'Avoid These Common Remodeling Mistakes', 'avoid-these-common-remodeling-mistakes', '2025-07-28T16:39:23.000Z', '2025-07-28T00:00:00.000Z', '2026-03-13T21:02:47.000Z'),
    ('webflow:69a61807115af520abd838c2', 'How to Choose the Right Contractor for Your Remodel', 'how-to-choose-the-right-contractor-for-your-remodel', '2025-07-28T16:40:05.000Z', '2025-07-18T00:00:00.000Z', '2026-03-13T21:02:47.000Z'),
    ('webflow:69a61807115af520abd838c3', 'Deck Repair vs. Deck Replacement: Is Your Old Deck Safe to Use?', 'deck-repair-vs-deck-replacement-is-your-old-deck-safe-to-use', '2025-11-17T15:35:05.000Z', '2025-11-17T00:00:00.000Z', '2026-03-13T21:02:47.000Z'),
    ('webflow:69de949c8d45d6cda9a750a5', 'Hiring Deck Builders in Tooele: How to Build a Better Backyard for Utah’s Climate', 'deck-builders-tooele', '2026-04-14T19:25:16.000Z', null, '2026-04-14T19:32:24.000Z'),
    ('webflow:69dffd2cee01d0f5db98ec8f', 'Salt Lake City Composite Deck Repair: 7 Signs It Is Time To Fix Your Deck In 2026', 'salt-lake-city-composite-deck-repair', '2026-04-15T21:03:40.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69dffdc43917f52f7a8950f6', 'Deck Installation In Lehi: How To Plan A Beautiful, Code-Compliant Outdoor Space In 2026', 'deck-installation-company-lehi', '2026-04-15T21:06:12.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e0020b1c44368f484cd834', 'Deck Repair In Sandy, Utah: How To Protect Your Deck And Know When It’s Time To Fix It In 2026', 'deck-repair-company-sandy', '2026-04-15T21:24:27.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e0026fbd48f8700c4443d5', 'Signs Of Deck Collapse: 7 Warning Signals Utah Homeowners Should Never Ignore In 2026', 'signs-of-deck-collapse', '2026-04-15T21:26:07.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e002e9f13a22b1c48e1a25', 'Safe Deck Construction In 2026: How To Build A Durable, Code-Compliant Outdoor Space', 'safe-deck-construction', '2026-04-15T21:28:09.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e00385c7eb7e871149509c', 'Local Deck Contractors In Santaquin: How To Choose The Right Builder For A Durable, Custom Outdoor Space In 2026', 'local-deck-contractors-santaquin', '2026-04-15T21:30:45.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e00522fd24c69f991d9d84', 'Deck Rebuilding In Salt Lake City: How To Create A Safer, Longer-Lasting Outdoor Space In 2026', 'deck-rebuilding-salt-lake-city', '2026-04-15T21:37:38.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e00788b7d4a7437393c43f', 'Composite Decking Companies In Lehi: How To Choose The Right Builder For A Beautiful, Low-Maintenance Deck In 2026', 'composite-decking-companies-lehi', '2026-04-15T21:47:52.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e008e60db2cd17c99e6ee8', 'Santaquin Deck Building Professionals: How To Choose The Right Builder For A Durable, Custom Outdoor Space In 2026', 'santaquin-deck-building-professionals', '2026-04-15T21:53:42.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e0097b5f01bc11c1249eaf', 'Deck Repair Estimate In Santaquin: What Utah Homeowners Should Expect In 2026', 'deck-repair-estimate-santaquin', '2026-04-15T21:56:11.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e009d88ecbdaef653a77f4', 'Utah County Composite Deck Installers: How To Choose The Right Builder For A Low-Maintenance Outdoor Upgrade In 2026', 'utah-county-composite-deck-installers', '2026-04-15T21:57:44.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e00a1b6cb57b5346290a6c', 'Custom Deck Builder In Lehi: How To Design A Durable, Code-Compliant Outdoor Space In 2026', 'custom-deck-builder-lehi', '2026-04-15T21:58:51.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e00a646b6ff421150caa6c', 'Salt Lake City Custom Deck Estimate: What Homeowners Should Expect In 2026', 'salt-lake-city-custom-deck-estimate', '2026-04-15T22:00:04.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e00ab3f98ad1ccd504d7e4', 'Deck Repair In Lehi And Provo: 7 Signs Your Utah Deck Needs Attention In 2026', 'deck-repair-lehi-provo', '2026-04-15T22:01:23.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e00afdb1419a02e743b2c5', 'Deck Repair Specialists In Sandy: How To Restore A Safer, Longer-Lasting Outdoor Space In 2026', 'deck-repair-specialists-sandy', '2026-04-15T22:02:37.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e00b44e4287ee1d54a8efd', 'Backyard Deck Upgrades On A Budget: 7 Smart Ways To Refresh Your Outdoor Space In 2026', 'backyard-deck-upgrades-on-a-budget', '2026-04-15T22:03:48.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e00b8ad612d753aee8fe3d', 'Deck Framing Repair In Utah: How To Spot Structural Problems Before They Become Expensive', 'deck-framing-repair-utah', '2026-04-15T22:04:58.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e00bcdfc2dae02e87181ad', 'Sandy Custom Deck Builders: How To Choose The Right Team For A Beautiful, Code-Compliant Backyard In 2026', 'sandy-custom-deck-builders', '2026-04-15T22:06:05.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e00c799b4ca454a8ec79b4', 'Utah County Custom Deck Builders: How To Choose The Right Team For A Durable, Beautiful Backyard In 2026', 'utah-county-custom-deck-builders', '2026-04-15T22:08:57.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e00cc5b61be2c0c1a6bc07', 'Sandy Deck Installation Pros: How To Build A Beautiful, Code-Compliant Outdoor Space In 2026', 'sandy-deck-installation-professionals', '2026-04-15T22:10:13.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e00d0e9b4ca454a8ecccc2', 'How To Clean A Wood Deck Without Pressure Washing: A Safer Step-By-Step Guide For Utah Homeowners', 'how-to-clean-a-wood-deck-without-pressure-washing', '2026-04-15T22:11:26.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e00d4ddbad48a8e96abd0c', 'Provo Composite Deck Installation: A Smart Home Upgrade for Utah Backyards in 2026', 'provo-composite-deck-installation', '2026-04-15T22:12:29.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:69e00d8d9b4ca454a8ed02f1', 'Custom Deck Design And Build In Salt Lake City: How To Create An Outdoor Space That Fits Your Home In 2026', 'custom-deck-design-and-build-salt-lake-city', '2026-04-15T22:13:32.000Z', '2026-06-12T00:00:00.000Z', '2026-07-07T19:16:05.000Z'),
    ('webflow:6a305cd872b243c9743afdd8', 'Custom Deck Builder In Lehi: How To Plan A Beautiful, Long-Lasting Outdoor Space In 2026', 'custom-deck-builder-lehi-ed8b3', '2026-06-15T20:13:12.000Z', '2026-06-23T00:00:00.000Z', '2026-07-07T19:16:05.000Z'),
    ('webflow:6a305d1e5358f20bb032b564', 'Deck Repair Contractors In Provo: How To Fix Unsafe Decks And Choose The Right Local Expert In 2026', 'deck-repair-contractors-provo', '2026-06-15T20:14:22.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:6a305d6fb247fef1377de227', 'Composite Deck Installers In Draper: How To Choose The Right Builder For A Beautiful, Low-Maintenance Outdoor Space In 2026', 'composite-deck-installers-draper', '2026-06-15T20:15:43.000Z', '2026-06-26T00:00:00.000Z', '2026-07-07T19:16:05.000Z'),
    ('webflow:6a305dbe51841e2293cc8f45', '7 Reasons To Choose The Best Deck Building Company In Sandy For A Backyard That Lasts', 'best-deck-building-company-sandy', '2026-06-15T20:17:02.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:6a305e0fa6ac9d8d60ba1e8b', 'Custom Deck Contractors In Salt Lake City: How To Plan A Durable, Code-Compliant Outdoor Space In 2026', 'custom-deck-contractors-salt-lake-city', '2026-06-15T20:18:23.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:6a305e5065f24c9f415161a4', 'Deck Repair Estimate In Santaquin: How Utah Homeowners Can Plan Costs And Choose The Right Contractor', 'deck-repair-estimate-santaquin-d41a4', '2026-06-15T20:19:28.000Z', '2026-07-03T00:00:00.000Z', '2026-07-07T19:16:05.000Z'),
    ('webflow:6a305ee2d026d8f7e1ceba6d', 'Composite Vs. Wood Deck Cost In Utah: What Homeowners Will Really Pay In 2026', 'composite-vs-wood-deck-cost-utah', '2026-06-15T20:21:54.000Z', null, '2026-07-07T19:16:05.000Z'),
    ('webflow:6a305f28d13f8194b1b66ea4', '7 Deck Makeover Before-And-After Ideas That Transform Salt Lake City Backyards', 'deck-makeover-before-and-after-salt-lake-city', '2026-06-15T20:23:04.000Z', null, '2026-07-13T01:49:13.000Z'),
    ('webflow:6a305ffafa2c12b6f5b597e1', '7 Smart Ideas To Create A Year-Round Outdoor Living Space In Utah', 'year-round-outdoor-living-space-utah', '2026-06-15T20:26:34.000Z', null, '2026-08-13T21:57:53.000Z'),
    ('webflow:6a3060400ed033f6f4f14743', 'Decks For Sloped Yards In Utah: Smart Design Ideas, Costs, And Local Builder Tips For 2026', 'decks-for-sloped-yards-utah', '2026-06-15T20:27:44.000Z', null, '2026-08-13T21:57:53.000Z'),
    ('webflow:6a3060c373706f753594ad2f', 'Deck Resurfacing Contractors In Draper: How To Restore Your Deck Without A Full Rebuild In 2026', 'deck-resurfacing-contractors-draper', '2026-06-15T20:29:55.000Z', null, '2026-08-13T21:57:53.000Z'),
    ('webflow:6a5a6162d3ab262bc5f25efd', 'Deck Builders Near Lehi, UT: How to Choose the Right Local Team for a Deck That Lasts', 'deck-builders-near-lehi-ut', '2026-07-17T17:07:46.000Z', null, '2026-08-13T21:57:53.000Z'),
    ('webflow:6a68cea2ab6d1fe686f67f77', 'Deck Builders In Herriman, UT: How To Plan A Custom Outdoor Space That Lasts In 2026', 'deck-builders-herriman-ut', '2026-07-28T15:45:38.000Z', null, '2026-08-13T21:57:53.000Z'),
    ('webflow:6a6cd97384e0ae0b7b24ad2e', 'Choosing the Right Pergola Contractor in Pleasant Grove, UT: What Homeowners Should Know Before Building', 'pergola-contractor-pleasant-grove-ut', '2026-07-31T17:20:51.000Z', null, '2026-08-13T21:57:53.000Z'),
    ('webflow:6a70c29e813c9c48d12f1dcf', 'How to Hire the Right Patio Builder in Bluffdale, UT for a Backyard That Lasts', 'patio-builders-bluffdale-ut', '2026-08-03T16:32:30.000Z', null, '2026-08-13T21:57:53.000Z'),
    ('webflow:6a73a646c2df6a5681c69178', 'Deck Permits In Utah County: What Homeowners Need To Know Before Building In 2026', 'permits-for-building-a-deck-in-utah-county', '2026-08-05T21:08:22.000Z', null, '2026-08-13T21:57:53.000Z'),
    ('webflow:6a75f6adcb3ef410cc1e91fd', 'Deck Builders Near Me: 7 Tips for Hiring the Right Utah Pro', 'deck-builders-near-me-ef9ca', '2026-08-07T15:15:57.000Z', null, '2026-08-13T21:57:53.000Z'),
    ('webflow:6a79ecdf659f625444465261', 'Deck Building Permits in the Wasatch Front: What Salt Lake and Utah County Homeowners Need to Know', 'deck-building-permits-in-wasatch-front', '2026-08-10T15:23:11.000Z', null, '2026-08-13T21:57:53.000Z'),
    ('webflow:6a7cc179c1b3e427306f3812', 'Covered vs. Open Deck for Utah Heat: What Actually Feels Better in Salt Lake and Utah County?', 'covered-vs-open-deck-for-utah-heat', '2026-08-12T18:54:49.000Z', null, '2026-08-13T21:57:53.000Z'),
    ('webflow:6a834875c095afc4fe010393', 'Best Motorized Patio Awnings in Draper: What Actually Holds Up in Utah’s Sun, Wind, and Snow', 'best-motorized-patio-awnings-in-draper', '2026-08-17T17:44:21.000Z', null, '2026-08-18T21:54:49.000Z'),
    ('webflow:6a886b12ec1314815851796b', 'Sandy UT Louvered Roof Building Permits: A Homeowner’s 2026 Guide', 'sandy-ut-louvered-roof-building-permits', '2026-08-21T15:13:22.000Z', null, '2026-08-21T17:47:53.000Z'),
    ('webflow:6a8ca953631e65a92dad6d60', '5 Genius Deck Upgrades You Didn’t Know Existed for Utah Homes', '5-genius-deck-upgrades-you-didnt-know-existed', '2026-08-24T20:28:03.000Z', null, '2026-08-26T21:57:47.000Z'),
    ('webflow:6a8f0c804f7defb13cfaf17f', 'Do Pergolas Add Appraisal Value in Utah? What Homeowners Should Know Before Building', 'do-pergolas-add-appraisal-value-in-utah', '2026-08-26T15:55:44.000Z', null, '2026-08-26T21:57:47.000Z'),
    ('webflow:6a91b7418cca28db36a70cf3', 'Custom Decks in Daybreak: A Smarter Path to HOA Approval and Outdoor Living', 'custom-decks-hoa-approval-requirements-daybreak', '2026-08-28T16:28:49.000Z', null, '2026-08-28T16:32:33.000Z'),
    ('webflow:6a96f06613e44fc2fdbefe38', 'Covered Patios Lehi City Permit Requirements: A Homeowner’s 2026 Guide', 'covered-patios-lehi-city-permit-requirements', '2026-09-01T15:33:58.000Z', null, '2026-09-01T15:48:35.000Z'),
    ('webflow:6aa03e0e0ee320cd00e02dc0', 'Custom Decks for Sloped Lots in Herriman: Build More Usable Outdoor Space', 'custom-decks-sloped-lots-herriman', '2026-09-08T16:55:42.000Z', null, '2026-09-08T17:01:58.000Z'),
    ('webflow:6aa19c0156eab503426789ec', 'Pergola Installation In Eagle Mountain: How To Anchor For High Winds And Utah Weather', 'pergola-installation-high-wind-anchoring-eagle-mountain', '2026-09-09T17:48:49.000Z', null, '2026-09-14T19:59:29.000Z')
),
first_seen as (
    -- first day Google showed each blog post, matched on path so www / trailing slash / query don't matter
    select regexp_replace(rtrim(split_part(p.page, '?', 1), '/'), '^https?://[^/]+', '') as path,
           min(p.date) as first_date
    from seo_pages_daily p
    where p.client_name = '3Sixty Industries' and p.page like '%/blog-posts/%'
    group by 1
),
dated as (
    select posts.*,
           (posts.created_on::timestamptz at time zone 'America/Denver')::date as created_day,
           (posts.published_on::timestamptz at time zone 'America/Denver')::date as published_day,
           -- a date-only field, exported as midnight UTC: take the UTC day, or it shifts back a day in Denver
           (posts.original_date::timestamptz at time zone 'UTC')::date as original_day,
           fs.first_date
    from posts
    left join first_seen fs on fs.path = '/blog-posts/' || posts.slug
)
select '3Sixty Industries',
       coalesce(original_day,
                greatest(created_day, least(published_day, coalesce(first_date, published_day)))),
       'content', title, 'https://www.3sixty-industries.com/blog-posts/' || slug, null, 'webflow', source_ref
from dated
on conflict (client_name, source_ref) do nothing;

-- Check: how many were backfilled, and which evidence dated them
-- select count(*), min(live_date), max(live_date) from seo_changelog
-- where client_name = '3Sixty Industries' and created_by = 'webflow';
-- select live_date, count(*) from seo_changelog where client_name = '3Sixty Industries'
-- and created_by = 'webflow' group by 1 order by 1;
