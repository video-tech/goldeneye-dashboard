---
name: seo-keyword-plan
description: Build or review a client's SEO keyword list and load it into SE Ranking — the process used for 3Sixty Industries on 2026-09-15. Use when setting up keywords for a new SEO client, doing the quarterly keyword review, or when asked "what keywords should we track for X", "set up SE Ranking for X", or to add cities, target pages or competitors to a client's project.
---

# SEO keyword plan (new client or quarterly review)

The keyword list decides which pages need to exist, what gets written, and what "progress" means in
the SEO tab and reports. A wrong list makes all three wrong at once. This skill builds one with the
client's real services and cities, checks it against their site, and loads it into SE Ranking.

**Work with the user step by step.** Present findings and a draft, get approval, then change
SE Ranking. Never delete a keyword or add paid data they haven't approved.

## 0. Check the SE Ranking connection first
This skill needs the **SE Ranking** connector (tools named `PROJECT_…`, e.g. `PROJECT_listProjects`).
A skill doesn't bring its own connection — it uses the session's. Before asking the user anything,
confirm those tools are available (load them via tool search if they're deferred) and call
`PROJECT_listProjects` once.
- **Works** → carry on, and mention which projects you can see.
- **Missing or failing** → stop and tell the user: in the Claude app, turn on the SE Ranking connector
  for this session; in a terminal session, run `/mcp` and sign in to SE Ranking. Steps 1 and 3–6 can
  still be drafted without it, but nothing can be read from or loaded into SE Ranking until it's on.

## Mode
- **New client** → do every step.
- **Quarterly review** → skip to "Quarterly review" at the bottom, then return to steps 5–7 for changes.

## 1. Gather from the user (ask, don't assume)
1. **Services they want more of** — profitable ones, not everything they do.
2. **Priority cities** — usually 3–5, in order. These become SE Ranking locations.
3. **Business name and phone exactly as on their Google Business Profile** (needed for map pack tracking).
4. **SE Ranking keyword budget** for the project (e.g. 100).
5. **Brand/certification facts that change keywords** — e.g. "are they a TrexPro installer?", "do they do patio covers?"
6. **Seed data** if they have it — a Cuppa.ai or SE Ranking keyword export (paste is fine).

## 2. Pull what already exists (read-only, no units)
- **SE Ranking** (Project API tools, no Data API units): `PROJECT_listProjects` → find the project;
  `PROJECT_getSearchEngines` (locations, `merge_map`, business name); `PROJECT_listKeywords`
  (ids, `link` = target page, `site_engine_ids`); `PROJECT_getKeywordStats` with
  `with_landing_pages=1` for current positions and ranking pages.
- **Their site's pages**: fetch `https://<domain>/sitemap.xml`. Split service pages, city/service-area
  pages, blog posts. Blog slugs reveal existing matrix-style posts (e.g. `custom-deck-builder-lehi`).
- **Search Console** (Golden Eye data, via the user running SQL): searches already on page 2 —
  ```sql
  select * from seo_almost_page_one('<Client Name>', current_date - 90, current_date,
      current_date - 180, current_date - 91, 20, 30);
  ```
- **Golden Eye client record**: `clients.seranking_site_id` should match the project.

Report back: current locations, keyword count vs budget, what's ranking, what has no target page.

## 3. Filter the candidates
Read every seed keyword against these rules:
- **Volumes from Cuppa/SE Ranking are national.** A 12,000 national term is still worth tracking
  locally — SE Ranking checks it from the client's city — but don't read it as local demand.
- **Drop:** too broad or another trade ("construction contractor"), retail/product browsing
  ("deck accessories"), things they don't sell.
- **Collapse duplicates** Google treats as one search (builder/builders, company/companies,
  word order swaps). Track one.
- **Other businesses' names are competitors, not keywords** → list them for step 8.
- **Don't drop a city search for "0 volume".** Small-city volume often can't be measured; if the
  state version has demand, the city version has some.
- **Intent decides the page type:** hiring words (builder, contractor, company, near me, cost) →
  service/city pages; research words (ideas, colors, best, vs, how to) → articles.
- **CPC is a money signal** — a high cost per click means that search makes advertisers money.

## 4. Shape the list and do the budget math
**SE Ranking counts one check per keyword per location.** 10 keywords × 5 cities = 50 of the budget.
So:

| Group | What | Checked from | Target page |
|---|---|---|---|
| A | "near me" and generic hiring searches (~6) | **all** priority cities | service page |
| B | service + city ("deck builder lehi") | **only that city** | city or matrix page |
| C | state/region searches ("deck builders utah") | main city | service page |
| D | research questions | main city | the article answering it |
| E | brand (1–2) | main city | home page |

Aim for roughly half the budget on the first pass, leaving room to grow. **Keep existing keywords that
match a new one** (same meaning) instead of re-adding them — deleting in SE Ranking loses that
keyword's ranking history there.

## 5. Target pages — "which page should win this?"
- **A page answers it** → that's the target.
- **No page answers it** → leave the target blank and list it as a **page to build**. Add the target
  once the page exists.
- **Several pages compete** (e.g. a city page plus several blog posts about the same city+service) →
  **don't guess**. Flag it as possible **cannibalization**, set the most likely page, and revisit after
  the first rank check shows which page Google actually picked.
- **Never enable strict matching** (`is_strict`). It hides the wrong-page ranking this is meant to catch.

## 6. Present the draft for approval
Show, in tables:
- Locations to add (with map pack on)
- Keywords by group A–E, with target page and where each is checked
- Total checks vs budget
- Keywords to **delete** — listed by name, explicitly approved
- Pages to build, and any cannibalization found (competing pages, duplicate slugs)
- Competitors found
- Open questions (e.g. certification facts)

Wait for a clear go-ahead. Anything not on the approved list stays untouched — if you find an extra
old keyword while loading, ask before deleting it.

## 7. Load into SE Ranking, in this order, verifying each step
1. **Locations**: `PROJECT_getAvailableRegions` with the city name to get the exact `region_name`,
   then `PROJECT_addSearchEngine` (`search_engine_id` 200 = Google US, `merge_map` "1",
   `business_name`, `phone`, `lang_code` "en"). Verify with `PROJECT_getSearchEngines`.
2. **New keywords**: one `PROJECT_addKeywords` call with `site_engine_ids` per group and
   `target_url` where known. Use the project's existing `group_id`.
3. **Kept keywords**: `PROJECT_updateKeyword` with `keyword` (required when changing the target)
   and `target_url`. Omit `site_engine_ids` unless changing them — passing it replaces the set.
4. **Deletions**: re-list with `PROJECT_listKeywords`, then `PROJECT_deleteKeywords` with only the
   approved ids.
5. **Verify**: `PROJECT_getSearchEngines` keyword counts per location add up to the planned total;
   spot-check targets in `PROJECT_listKeywords`.

Tell the user new keywords show no position until SE Ranking's next daily check, and Golden Eye picks
up target pages and retires deleted keywords on the next `seranking-sync` run (19:00 UTC).

## 8. Competitors (after the list is loaded)
**Pick them from the client's own search results, not from a name list.** Once the keywords are
loaded and checked at least once, `PROJECT_getAllCompetitorsMetrics` (site_id, date from
`PROJECT_getCheckDates`, one `site_engine_id` per city) returns every domain that held a top-10 spot
for the tracked searches, with a project-wide visibility share. It costs no units: the checks are
already paid for.

1. Run it **per city** and build a table of domain × city.
2. **Drop directories and manufacturers** — Yelp, Houzz, Angi, HomeAdvisor, Thumbtack, BBB, Trex,
   Home Depot, Facebook, Reddit. Also drop booking-widget hosts (e.g. `book.xapp.ai`), which are a
   competitor's form, not a site.
3. **Rank by how many cities a domain appears in**, then by visibility. A site that shows up in every
   city is competing for the whole service area; one 90% in a single city may be one lucky keyword.
4. **Add 3–5** with `PROJECT_addCompetitor` (`subdomain_match` 0), after the user confirms. Check the
   `domain_trust` in `PROJECT_listCompetitors` against the client's own — it says how hard each is to
   outrank.
5. Say that competitor positions start at the **next daily check**: `PROJECT_getCompetitorPositions`
   returns empty until then, and history never backfills. That's why they're added early rather than
   after a month of watching.

**Two blind spots to name out loud:** the top-10 snapshot is only kept ~14 days (Golden Eye stores it
daily, which is the archive), and none of this covers the map pack. Cross-check the Google Maps 3-pack
and ask the client who they lose bids to — a company on all three lists is the one to watch.

**Beware a stale list:** this data only reflects the keywords tracked at the time. Right after a
keyword rebuild, snapshots from before it are meaningless — say so rather than comparing them.

## Quarterly review
1. `PROJECT_getKeywordStats` over the last ~90 days, with landing pages.
2. **Retire** keywords that never moved and have little value (confirm with the user).
3. **Add** from Search Console's almost-page-1 list, new services, and new cities.
4. **Wrong pages**: compare ranking page vs `link` for ranking keywords — the Golden Eye SEO tab's
   wrong-page alert shows the same. Decide per keyword: update the target, or fix the site
   (merge/redirect competing pages, strengthen the target page).
5. **Cannibalization**: re-check the sitemap for new posts chasing groups another page already owns.
6. **Budget**: recount checks per location.
7. **Competitors**: re-run step 8's city table. Swap out any competitor that has dropped out of the
   results, and add anyone new who now appears across several cities.
Then steps 6–7 for the changes.

## Guardrails
- **Data API tools cost units** (the plan has ~25,000 a month; three Data API calls once cost ~1,900).
  Keyword research, domain competitors and SERP pulls through the Data API: state the likely cost and
  get approval first. Project API reads are fine.
- Never paste or store SE Ranking API keys; the connection handles auth.
- Changes in SE Ranking are real and immediate. Deletions can't be undone there.
- If Golden Eye code changes as part of the work, add an `updates.json` entry and update CLAUDE.md.

## Reference: 3Sixty Industries, 2026-09-15
Project `12904139`. 5 locations (Eagle Mountain, Lehi, Saratoga Springs, American Fork, Draper), map
pack on. 53 checks of 100: 6 near-me/generic keywords × 5 cities, 10 city searches (deck + pergola per
city), 7 Utah-wide, 5 article searches (2 existing posts, 3 to write), 1 brand. 18 old narrow keywords
removed. Found: 5 blog posts plus the city page chasing "deck builder lehi", including a duplicate slug —
the cannibalization example.
