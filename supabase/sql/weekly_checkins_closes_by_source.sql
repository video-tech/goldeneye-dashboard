-- Where each week's closed jobs came from. Run once in the SQL Editor, BEFORE the app.js that
-- writes it goes live.
--
-- The portal check-in now asks for jobs and revenue per source instead of one total:
--   {"google":   {"closes": 1, "revenue": 9800},    Google search / Maps / the client's website (SEO)
--    "ads":      {"closes": 2, "revenue": 14200},   Facebook / Instagram ads
--    "referral": {"closes": 1, "revenue": 6500},    referral or repeat customer
--    "other":    {"closes": 0, "revenue": 0}}       other / not sure
-- Only rows the client filled in are present, and a value they left blank is null.
--
-- closes_count and revenue_total are still written, as the sums of these rows, so every
-- existing reader (reports, leaderboard, health scores, admin views) is unchanged. This column
-- only adds the split. Null means no breakdown: every check-in before this, and every check-in
-- sent by text. The SEO tab counts those as "source not given", never as Google.
--
-- RLS is row-level, so the existing weekly_checkins policies already cover the new column.

alter table weekly_checkins add column if not exists closes_by_source jsonb;

notify pgrst, 'reload schema';

-- Check, after a client submits with sources:
-- select client_name, week_start, closes_count, revenue_total, closes_by_source
-- from weekly_checkins where closes_by_source is not null order by week_start desc limit 10;
