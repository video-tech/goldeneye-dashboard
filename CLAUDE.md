# Golden Eye — project context

Internal dashboard + client portal for Midas Media, a Meta ads agency.
Full human-readable version: **https://claude.ai/code/artifact/c11f883f-b220-4919-91b2-20638ad17737**

## Shape of the thing

No build step, no server. Three static files:

- `goldeneye.html` — loader pasted into a GoHighLevel page; fetches the other two from
  GitHub Pages with a `?v=Date.now()` cache-buster
- `body.html` — all markup + CSS, both admin dashboard and client portal
- `app.js` — all logic, one file

`git push` → GitHub Pages → live at goldeneye.midasmediafirm.com.
**Pages takes 1–2 min to rebuild.** Always confirm a change is actually served before
concluding it didn't work — testing too fast has burned a whole session before.

Backend is Supabase (Postgres + auth + storage), project `hugnttsqucetldllfgoi`.

## Logic lives in five places

Nearly every "why didn't that fire?" is really "which layer owns this?":

| Layer | Owns | Debug via |
|---|---|---|
| **app.js** | Everything on screen | DevTools console, `[LIFECYCLE ENGINE]` lines |
| **Postgres triggers** | Reactions the instant data changes | Supabase → Logs → Postgres; `net._http_response` |
| **pg_cron** | Scheduled jobs | `select * from cron.job_run_details order by start_time desc` |
| **Make.com** | Glue to Meta / GHL / Sheets / Gmail | Make → scenario → History (check per-module op counts) |
| **GoHighLevel** | Forms, calendars, contacts, **all SMS** | GHL Automations + contact conversation |

No SMS is ever sent by this app. Supabase asks Make, Make asks GHL.

## Make scenarios (none of these are in the repo)

1. **Daily ads pull** — schedule → Supabase Search Rows (active clients) → Facebook
   Insights per client → Google Sheets → write `daily_reports`
2. **SEO data to Golden Eye** — writes `seo_metrics`, feeds the portal's Organic SEO tab
3. **Onboarding form completion** — GHL form submitted → look up client → write
   `client_onboarding_progress` so the step ticks off in the portal
4. **Onboarding complete SMS** — Supabase trigger → webhook → tag GHL contact → GHL
   workflow texts the client
5. **Weekly check-in reminder** — pg_cron → webhook with outstanding clients + contacts →
   iterate → find by phone → SMS
6. **Admin alerts** — Supabase trigger on `Client Request` tasks → webhook → SMS to us.
   **Unfinished**: trigger + recipients live, Make scenario needs iterator + send modules
7. **Report draft to Gmail** — the "Draft" button on a saved report (`sendSavedReportToMake`,
   app.js) POSTs `{client, subject, full_email_html, to_email[]}` to
   `hook.us2.make.com/apq7ghcun1hza8h5ayw1xysy81nddh8v`, which drafts the email
8. **Ad previews** — `submitAdForApproval` / `refreshAdPreviews` POST
   `{approval_id, ad_id, client_name, ad_name}` to
   `hook.us2.make.com/2kan16ro46vkcxsubi90aaobv1ym1fxg` → three HTTP calls to
   `graph.facebook.com/v21.0/{ad_id}/previews` (one per placement) → upsert
   `ad_approvals`. See **Ad approvals** below

## Database objects we added

- `raise_onboarding_handoff_task()` + `trg_onboarding_handoff` on
  `client_onboarding_progress` — when every client step is done, create the handoff task
  "Onboarding complete — ready for campaign build" and POST to Make. Skips rows whose
  `completed_by = 'backfilled'`.
- `notify_admins_client_request()` + `trg_notify_client_request` on `tasks` — classifies
  `Client Request` inserts into onboarding_complete / help_request / task_request, builds
  the SMS text, POSTs to Make with the recipient list.
- `send_weekly_checkin_reminders()` + cron jobs `checkin-reminder-am` (`0 15 * * 1-5`) and
  `-pm` (`0 22 * * 1-5`), UTC.
- `notify_new_client_welcome()` + `trg_new_client_welcome` on `clients` — welcome email
  with the sign-in link, on insert only. **Posts straight to the Resend API, not Make** —
  it was the one flow simple enough not to need a scenario. Sends from
  `hello@mail.midasmediafirm.com` (the root domain is *not* verified in Resend), with
  `reply_to` set to a real inbox since the copy invites replies. Rewording it means
  re-running the function.
- `user_has_client_access()`, `current_user_is_admin()` — SECURITY DEFINER helpers used by
  RLS policies.
- `admin_alert_recipients` — who gets texted, toggleable in Settings → Notifications.
- **`daily_reports` SELECT policy, fixed 2026-09-10.** Three `USING (true)` policies —
  `Allow authenticated users to read daily reports`, `Allow Auth Read Reports`,
  `Auth Read Ads` — were dropped; under RLS's OR semantics they had made every
  authenticated user able to read every client's ad performance regardless of the two
  properly-scoped policies sitting right next to them. Replaced with one policy keyed on
  `ad_account_id` rather than `client_email` — only 91% of rows had a populated email,
  so an email-only policy would have made the other 9% invisible to *everyone*, a
  regression rather than a fix:
  ```sql
  create policy "Clients read their own account by ad_account_id"
  on daily_reports for select
  using (
      exists (
          select 1 from clients c
          where c.ad_account_id is not null and c.ad_account_id <> ''
            and regexp_replace(c.ad_account_id, '\D', '', 'g')
              = regexp_replace(coalesce(daily_reports.ad_account_id, ''), '\D', '', 'g')
            and user_has_client_access(c.name)
      )
      or current_user_is_admin()
  );
  ```
  Mirrors `reportsForClient()` in app.js exactly — strip both sides to bare digits and
  compare — so it doesn't depend on `client_email` ever having been backfilled. Verified
  by simulating a real client's JWT in a rolled-back transaction
  (`set local request.jwt.claims`) and confirming it returned only that client's own
  `account_name`, and by an actual client login afterward. The two pre-existing
  email-based policies (`Agency Owner Master Access`, `Users can only see their own
  data`) were left in place as an additional path, untouched.
- **`weekly_reports` policy, fixed 2026-09-10 — worse than the `daily_reports` gap, not
  just the same shape of it.** `Allow authenticated users to manage reports` was `cmd =
  ALL, USING (true)` — covering INSERT/UPDATE/DELETE as well as SELECT, so any
  authenticated user, client or not, could edit or delete **any** client's saved report,
  not only read it. The existing `client reads own reports` SELECT policy
  (`user_has_client_access(client_name)`) was already correct but dead under RLS's OR
  semantics for the same reason as `daily_reports`' policies were. Fixed by dropping the
  blanket policy and replacing it with an admin-only `ALL` policy — needed because the
  dashboard's Generate/Edit/Delete Report buttons run on this same table with no other
  write path, so removing the blanket policy without this would have broken them for
  admins too, not only closed the hole for clients:
  ```sql
  create policy "Admins manage all reports"
  on weekly_reports for all
  using (current_user_is_admin())
  with check (current_user_is_admin());
  ```
  Clients keep read-only access via the pre-existing SELECT policy; no client-side code
  ever wrote to this table, so no client write policy was added. Both DROP and CREATE
  run in one transaction, so a failure can't leave the table with the blanket policy
  gone and nothing yet in its place. Verified the same two ways: a rolled-back
  transaction simulating a real client's JWT confirmed reads are scoped to their own
  rows and a write against another client's row affects 0 rows, and the admin
  Generate/Edit/Delete flow was confirmed still working from the live dashboard.

All outbound HTTP from Postgres uses `pg_net` wrapped in an exception block, so a Make
outage can never roll back a client's transaction.

## Access model — read this before touching invites

Three tables: `user_profiles` (role), `user_client_access` (which clients), and
`pre_approved_users` (an invite made before the person exists).

**`user_client_access.user_email` is a FK to `user_profiles(email)`.** Access cannot be
granted before someone signs up. `pre_approved_users` holds the invite; sign-in applies it
and writes the real rows. Creating a client auto-grants from `client_email`; the Invite to
Portal button is only for adding a second person or repairing an account.

Sign-in is a **6-digit OTP, not a magic link** — the app runs in a GHL iframe and browsers
partition storage. Both Supabase email templates (Magic Link *and* Confirm signup) need
`{{ .Token }}`.

## Onboarding

`onboarding_steps` rows have an **owner** (`client` shows in the portal / `agency` becomes
a task for us) and a **type** (`video`, `form`, `action`, `team`). Order comes from row
position on save. Progress in `client_onboarding_progress`.

Client finishes last step → DB trigger raises the handoff task + texts them → app raises
our agency tasks → when *every* Onboarding-stage task is Complete, the client
auto-advances to Campaign Building and that checklist generates from `stage_templates`.

Videos should be self-hosted MP4 in Supabase Storage (public bucket): gives 1.5× default
playback, watch tracking, resume, auto-complete. Loom = cross-origin iframe = none of
those. Encode H.264 (**not HEVC** — Chrome/Firefox won't reliably play it), `+faststart`.

## Ad approvals

Clients approve the **finished ad**, not a loose creative. You build the ad in Meta and
leave it paused, paste its Ad ID into the Creatives page, and Make fetches Meta's own
preview per placement. Nothing in Golden Eye ever changes an ad's status — launching
stays in Ads Manager, deliberately.

Why previews rather than a link to the ad: most ads are **dark posts**, unpublished page
posts with no public URL at all. Where an ad *is* built from a published post, the
permalink shows the organic post without the headline or CTA — the client would be
reviewing something that isn't the ad.

- `ad_approvals` columns: `ad_id`, `ad_name`, `preview_facebook_feed`,
  `preview_instagram_feed`, `preview_instagram_story`, `preview_fetched_at`,
  `preview_error`, `status`, `feedback`, `reviewed_by`, `reviewed_at`. A legacy
  `previews` jsonb is still read if populated; `file_url` is a dead column from the
  abandoned upload design.
- **One text column per placement, not JSON.** Meta's snippet is full of double quotes,
  so building JSON inside a Make mapping field means hand-escaping every one — and a
  single miss makes the whole jsonb value unparseable with nothing to say why.
- `decodePreviewUrl` accepts a bare URL, Meta's `<iframe src="...">` snippet, or that
  snippet JSON-encoded (what you get when a Make field maps the whole response instead
  of `data[1].body`). `adPreviewBox` reads the width/height Meta sends, because
  placements differ and the iframe's contents don't reflow.
- The Meta token lives in Make only — same rule as `service_role`. The token in the
  *preview* URL is a different, weaker one that only renders that preview, but it is
  visible to a client who opens DevTools.
- Previews expire; anything over 20 hours shows as stale with a refresh button.
- `ad_approvals.id` is **bigint**, so rows carry numbers while `onclick` handlers pass
  strings. Compare with `String()` on both sides.

## Morning audit

The "Run Morning Audit" button on the dashboard writes a saved HTML card into
`morning_audits`; `checkSavedAudit()` reloads today's row on page load rather than
re-running, and the Audits tab lists, edits and deletes past ones.

**The verdicts are computed in JavaScript, never by the model.** `computeClientSignal()`
in app.js decides each client's label; `prepareAIBrainContext()` groups clients under
those labels and the model only explains and prioritises them. Keep it that way — the
model is asked never to recalculate, and a wrong figure in a morning alert costs far
more than a clumsy sentence.

Every threshold is in `AUDIT_CONFIG` at the top of the engine. The four that matter:

- **`lagDays: 1`** — never read a day still in progress; it carries full spend against a
  fraction of its leads. Beyond that one day the window is **not** a fixed offset from
  today:
  `resolveAuditAnchor()` ends it on the freshest day the Make pull actually delivered.
  The pull writes yesterday each morning, so a fixed offset either threw away the newest
  day or, when the audit ran before the pull, invented a gap for every client at once.
  The anchor is **agency-wide**, not per client — the pull runs for everyone together,
  so a client whose rows stop early is genuinely behind and gets `DATA_STALE` instead of
  being quietly measured over its own older window.
- **`recentDays: 7` / `baselineDays: 28`** — disjoint, and whole weeks so both windows
  hold the same mix of weekdays. The old baseline was 30 days *including* the 7 it was
  being compared against.
- **`minExpectedLeads` / `minBaselineLeads` / `minCoverage`** — below these no CPL
  verdict is issued. The honest output is `INSUFFICIENT_VOLUME`, not a coin flip.
  The gate is **expected leads, not dollars**: what gives the z-test power is the
  expected count. A raw spend floor silenced an account that spent $246 and got *zero*
  leads for being $4 short of it, while saying nothing about whether its numbers were
  readable. **The creative flag is evaluated before this gate** — CTR is measured over
  impressions, not conversions, so it stays valid on accounts far too thin to judge CPL,
  and those are exactly the ones likely to be quietly running one tired ad. A thin
  account whose creative is dying still reaches `WATCH`; its `z` and driver are nulled
  so no unreliable figure gets printed next to the caveat.
- **`criticalZ`** — significance, not a percentage. `z = (leads − expected) / √expected`,
  where `expected = recentSpend / baselineCPL`. Leads are count data, so a normal week's
  spread scales with √n: a client expecting 3 leads cannot trip the wire on a one-lead
  miss, which is what the old flat ±5% rule did daily.

Data problems get their own verdicts (`DATA_STALE`, `DATA_GAPS`, `SPEND_STOPPED`) so a
broken Make pull stops being reported as a client emergency — in the totals alone those
two are identical.

**`decomposeCplChange()` is what makes account-level data worth having.** CPL is an
identity — `CPL = CPM/1000 ÷ CTR ÷ CVR` — so in logs the three contributions add up
exactly to the CPL change and the largest one is the driver. Three clients can show the
same CPL rise for three unrelated reasons, and the fix differs every time:

| Driver | What actually happened | Where to send someone |
|---|---|---|
| `CPM` | impressions got more expensive | auction, targeting too narrow, or a budget jump |
| `CTR` | fewer people clicking | creative fatigue or a saturated audience |
| `CVR` | clicks stopped becoming leads | **landing page or form — not the ads** |

`DRIVER_MEANING` carries a `worse` and a `better` phrasing for each, because the same
driver reads very differently in each direction; `dominantWorsened` picks between them.
Below `minCplDeltaForDriver` the headline driver is withheld — decomposing a CPL that
did not move produces a confident-sounding diagnosis of a non-event — but the component
deltas stay, because the creative flag reads CTR out of them.

**`SCALE_CANDIDATE` needs spend steady in *both* directions** (`scaleSpendCeiling` /
`scaleSpendFloor`). Cheaper leads on triple the budget is just more budget; cheaper leads
on 40% less budget is usually the cut itself, since a smaller budget stops buying the
expensive end of the inventory. Both fall through to `IMPROVING` with the reason in a
note — recommending a scale-up on the second kind would undo the thing that helped.

**`signal.flags` sits alongside the verdict rather than replacing it** — an account can be
losing its creative *and* blowing its CPL, and one label cannot hold both. Today there is
one flag, `CREATIVE`, raised whenever CTR falls 15%+ on a meaningful impression base.
Frequency (`impressions / summed daily reach` — reach is unique people so summing days is
not window reach, but the ratio is average *daily* frequency, comparable between windows)
only decides the wording:

- frequency rising or already high → *the same people are seeing it too often*
- frequency flat → *the creative is losing people, not the audience running out*

Either way someone opens the account and looks at the ads, which is why the flag does not
depend on telling the two apart. **A flag promotes an otherwise `STABLE` client to
`WATCH`** — CTR turns days before CPL does, and catching it while CPL still looks fine is
the entire value. By the time CPL moves, a week of budget has gone through it.

This is the ceiling of what the current data supports: it can say **whether to go into
an account and what to look at first**, never which ad to switch off. That needs
ad-level rows (see Known gaps).

Two traps worth knowing:

- **A week with spend and no leads has no CPL, not a CPL of zero.** The old engine
  computed `$0`, read `0 < baseline` as an improvement, and filed those accounts under
  Scale Opportunities. `recent.cpl` is `null` in that case and `cplDelta` is `Infinity`.
- **The prompt must permit an empty section.** Forcing three populated columns every
  morning guarantees invention on a quiet day.

`clients.target_cpl` is read if present and degrades to "no CPL target set". Without it
the model can only compare a client to their own past, so it cannot tell a good $60 CPL
from a terrible one.

### Meta restates the past — checked, and it does not bite us

Meta keeps revising a day's figures after it ends: conversions attribute back to the
**click** that caused them, so with a 7-day click window a lead can land in Tuesday's row
on Saturday. Reach and frequency are estimated metrics that finalise later, and spend
gets retroactive credits for invalid activity.

**Measured 2026-09-03 across 7 sample days: our stored rows matched Ads Manager closely.
Treat this as a non-issue at our spend.** It would start to matter at thousands a day, or
if a client moved from instant lead forms (which fire at click time) to a landing-page
form (where the click and the submit can be days apart).

Two properties worth keeping in mind anyway, because they are what make the audit safe:

- The pull runs at 08:00, asks for `yesterday`, and writes the row **once, never
  revisiting it** — so every row is frozen at the same age and both audit windows are
  under-counted by the same small factor. The comparison is unbiased *because* nothing
  is restated.
- Absolute lead counts are therefore very slightly low, so CPLs are very slightly high.
  Immaterial at our volumes, but set `target_cpl` against Golden Eye's numbers rather
  than Ads Manager's so the two never drift apart.

If the pull is ever changed to re-fetch a rolling range, this inverts: older days settle
while fresh ones have not, fresh days read worse than they are, and `lagDays` must rise
to 3.

### Running it unattended

`supabase/functions/morning-audit/` runs the whole thing server-side: reads the rows with
`service_role`, computes the signals, asks the model to write them up, inserts the
`morning_audits` row. **No Make scenario** — pg_cron holds the schedule and pg_net makes
the call, the same pair already behind `checkin-reminder-am/pm`. `schedule.sql` in that
folder sets it up and lists the queries for checking on it.

- Fires **16:00 UTC, Mon–Fri**. That is 10:00 MDT / 09:00 MST — pg_cron does not follow
  daylight saving, and 16:00 was chosen so *both* sides of that drift stay clear of the
  08:00 ads pull. 15:00 UTC would be 08:00 MST in winter, landing on top of it.
- **Idempotent.** Returns `{"skipped": ...}` if a card already exists for today, so a
  retry, a manual click, or a second scheduled attempt cannot stack up duplicates.
- Model is **`gpt-5.6-sol`** through the **Responses API** (not Chat Completions — that
  is what OpenAI documents for the reasoning models), at `reasoning.effort: "medium"`.
  The judgment is already made by the engine, so this call is interpretation and prose;
  effort is the cost dial and reasoning tokens bill as output. Reads `OPENAI_API_KEY`,
  the same project-wide secret `ai-chat` uses — so all four AI features sit on one
  vendor and one key.
- **pg_net is asynchronous**: `cron.job_run_details` goes green when the request is
  *queued*, not when it succeeded. `net._http_response` is where the real result is.

**The engine lives in exactly one place** — `morning-audit/engine.js`. `app.js` holds no
copy: `prepareAIBrainContext()` is now an async fetch to `{"mode": "context"}`, which
returns the computed matrix without spending a model call, and the dashboard button posts
`{"force": true}` and renders whatever comes back. That matters because two copies would
not crash when they drifted — the button would just quietly report a different verdict
from the one the schedule filed an hour earlier.

Consequences of that, worth knowing before editing:

- **The button needs the function deployed.** Deploy before pushing `app.js`, or the
  button and the "ALL" mode of the AI chat break until you do.
- The chat degrades rather than dies: a failed context fetch returns a
  `[MATRIX UNAVAILABLE: ...]` string and the model is told to say so rather than guess.
- The chat, the weekly report and the portal summary still call the old `ai-chat`
  function, which is on GPT-4o. Only the audit is on `gpt-5.6-sol`, so the four AI
  features share a vendor but not a model.

## Client work summary

A second daily AI feature, separate from the morning audit — `supabase/functions/client-summary/`
runs once a day per active client, reads their `tasks` (completed in the trailing 7 days, plus
currently open), and asks the model for a short plain-text recap. That goes into
`client_work_summaries`, read directly by the client's own browser session, and replaces the old
"AI Performance Summary" button (GPT-4o, `finalStats`, two sentences about spend and leads) on the
Dashboard tab, and shows by default at the top of the Tasks tab too.

**This is about the work, not the numbers — the prompt explicitly forbids the model from
mentioning spend, leads, or CPL.** Those already have KPI tiles of their own; conflating the two
risked the model restating a number slightly differently than the tile beside it.

**The model only ever sees task title, status, type, and due date — never `notes`.** That field is
staff-facing and can carry commentary never meant for the client reading it back in their own
portal. This is the same reasoning as the morning audit's driver logic never touching raw ad
creative, just at the content-safety end of the spectrum rather than the accuracy end.

**Rendered with `innerText`, not `innerHTML`, deliberately.** The morning audit's HTML goes into an
admin-only page; this reaches a client's browser directly, so nothing the model writes should ever
be capable of being interpreted as markup.

**No live model call from the browser, ever.** The cached daily narrative covers the default
7-day view on both surfaces. When a client picks a different date range on the Tasks tab,
`buildTasksRecap()` swaps in a plain factual recap computed client-side from data already in
`globalTasksData` — no network call, no cost, no wait. The daily cron run is the only thing that
ever spends a token on this feature.

**"Still working on" has no honest date-scoped meaning.** Tasks carry current status only, no
history — there's no record of what was open on some past date, only what's open right now. A
custom date range on the Tasks tab therefore relabels that bucket "due in that period" (a real,
`due`-column fact) rather than fake a historical view the data can't support.

Scheduled at 16:05 UTC, five minutes after the morning audit, Mon–Fri — see
`client-summary/schedule.sql`. No real dependency on that timing; it just isn't tied to the 08:00
ads pull the way the audit is, since it reads tasks, not `daily_reports`.

### RLS on `client_work_summaries` — read this before adding a client-facing table

This table is queried **directly by each client's own browser session**, the same way
`daily_reports` is. Its SELECT policy uses `user_has_client_access(client_name)` — the helper
CLAUDE.md's Access model section already documents.

**It was deliberately not modeled on `daily_reports`'s policy set at the time**, because that
table then carried three separate `SELECT ... USING (true)` policies stacked alongside two
properly-scoped ones. Postgres RLS policies OR together for the same command, so any `true` policy
makes the careful ones dead — any authenticated user, client or not, could read every client's
spend, leads, and account names. Found while building this feature. **Fixed 2026-09-10** — see
`daily_reports` in Database objects below for the exact policy now in place.

`tasks` itself has not been checked the same way — the portal filters `globalTasksData`
client-side (`cpTasksForClient()`), which only proves the *browser* hides other clients' tasks,
not that the *query* does. Worth the same check before trusting it.

## Weekly check-in

`weekly_checkins`: estimates, closes, revenue, `indirect_leads` (ad-attributed but not
tracked), `source`, `contact_name`. Reporting week is the **completed** Mon–Sun.
**One row per person** — several reps per client, totals sum them. Reports tab stays
locked until the week's numbers are in. Reminder recipients come from `client_contacts`,
which the `team` onboarding step writes to.

## Conventions

- Client names are compared **normalized** (lowercased, non-alphanumerics stripped) almost
  everywhere, because Meta renames ad accounts freely. A few spots still match exactly —
  that mismatch has caused silent misses.
- A task belongs to the client when its **assignee is "Client"**.
- Task generation dedupes on title within client+stage, so re-running is always safe.
- `escapeAttr` for HTML attributes and text; `escapeHTML` is a *JS-string* escaper and is
  only correct inside inline `onclick`. Using it in `value="..."` added a backslash before
  every apostrophe on each save.

## Gotchas that have each cost an hour

- **PGRST204 "column not found"** — PostgREST caches the schema. After any `alter table`:
  `notify pgrst, 'reload schema';`
- **`daily_reports."Leads"` has a capital L.** Make built the table from a Google Sheet,
  so the header casing became a quoted — and therefore case-sensitive — Postgres
  identifier. Every other column is lowercase. Two consequences: naming it in a
  PostgREST `select` list fails with *column daily_reports.leads does not exist*, and
  `row.leads` in JavaScript is `undefined`, not a lead count. **Both readers lowercase
  every key on the way in** — `app.js` where it fills `globalAdsData`, and `loadSignals`
  in the morning-audit function — so downstream code sees `leads` and neither has to
  care. Select `*` from that table rather than a column list, or the query 400s before
  the lowercasing ever runs.
- **Make bundles run end-to-end, one at a time.** An error on the *last* module aborts the
  whole scenario, silently skipping everything queued behind it. Add error handlers set to
  Resume on modules that write.
- **Make webhooks cache their data structure.** New payload fields need "Redetermine data
  structure" + a re-send.
- **Supabase Search Rows defaults to a limit of 10.** Cross that many clients and the rest
  silently get nothing.
- **pg_cron runs in UTC** — reminder times shift an hour at daylight saving.
- **Drawers/modals live inside the hidden client-portal container** and are re-parented to
  `theme-wrapper` at startup. Anything new that must show on both sides needs the same.
- Browser autofill can overwrite the email the portal prefills into GHL embeds, which
  makes the webhook resolve to the wrong client or none.
- **A GHL form question bound to the standard Email field rewrites the contact's
  identity.** Asking for a "personal email" on form 1-B changed the contact from
  `info@` to `nick@`, and every webhook after that resolved to a client that didn't
  exist. Ask for identity **once**, on the first form; later forms carry it in a
  **hidden** field prefilled from `?email=` — hidden fields are also immune to autofill.
  Anything else the client types twice can disagree, and GHL resolves that by
  overwriting rather than flagging.
- **A hidden field you don't prefill submits empty**, which can blank the contact's
  stored value. `prefillFormUrl` only sends `email`, so a hidden phone would wipe the
  number the check-in reminders match on.
- **Turn GHL "sticky contact" off.** It's a second, cookie-based source of truth for the
  same fields, it can beat the URL prefill, and third-party iframe partitioning makes it
  inconsistent across browsers.
- **`mode: 'no-cors'` silently downgrades Content-Type.** Make's webhooks send no CORS
  headers so browser posts must be no-cors — which permits only a few Content-Type
  values. `application/json` becomes `text/plain` and Make delivers the whole body as a
  single field called `value`. Post `URLSearchParams` instead.
- **A raw-text Make module does not escape the variables it substitutes.** The
  `morning-audit` critical-alert POST to GHL builds its body from
  `{ "message": "{{2.message}}" }` as literal text, not through Make's JSON-building
  tools — so a value containing a real newline lands as an unescaped control character
  inside what has to be valid JSON, and the module fails with *"bad control character"*.
  The fix was upstream: the edge function builds the SMS text on one line (`•`-joined,
  no `\n`) rather than asking every future editor of the Make scenario to remember an
  `escapeJSON()` wrapper. The same trap is waiting for any other field pasted into a
  raw-text body — a client name or note with a stray `"` would trip the same failure.
- **Make's Supabase app has no plain update, only upsert** — which Postgres runs as an
  insert that falls back to update, so the row must still satisfy `NOT NULL`. Send the
  identifying columns, not just the id. Leave client-owned columns (`status`, `feedback`)
  unmapped or a refresh overwrites a decision the client already made.
- **An id selector beats every Tailwind utility.** `#cp-view-dashboard { display: flex }`
  outranks `.hidden`, so the portal dashboard rendered on every tab. Keep layout CSS
  class-based, or guard with `:not(.hidden)`.

## Mobile

Installable to the home screen. The Apple meta tags are injected by the loader in
`goldeneye.html` because GHL owns that page's `<head>` — **so a change there means
re-pasting the block into GHL**, unlike `body.html`/`app.js` which are fetched fresh.
A manifest only counts on its own origin, so Android installs properly from the
GitHub Pages copy but not from the GHL domain.

- iOS snapshots the icon and title at install time; delete and re-add to see changes.
- An installed PWA gets its own storage sandbox, so everyone signs in once more there.
- Status bar is `black-translucent`, hence `env(safe-area-inset-*)` padding on
  `#theme-wrapper` and on the client-preview banner.
- GHL's builder wraps the block in `.c-row`, which carries 10px of horizontal padding —
  that showed as white bars down both edges on a phone. The reset on line 1 of
  `body.html` was written against `.row`/`.container` and never matched it.
- Client portal ordering on phones is CSS `order` inside a media query, not DOM order, so
  desktop is untouched. `display: contents` dissolves the two-column grids so their
  children can be ordered individually.

## Known gaps

- Admin alert Make scenario unfinished
- Reminder "goes quiet once submitted" never verified
- `client_contacts` mostly empty, so reminders reach almost nobody yet
- ~20 display-only spots still use `escapeHTML` (stray backslash on apostrophes)
- Embed URL isn't validated — pasting a whole `<iframe>` snippet shows clients a
  Cloudflare error
- Deleting an onboarding step that has progress rows assumes the FK cascades; untested
- Pipeline tab hidden pending a rebuild
- Ad approvals never tested end to end with a client actually approving; pending
  approvals aren't surfaced in the dashboard notification feed yet
- The onboarding form chain has broken twice on email identity and hasn't been
  re-tested since the hidden-field fix
- `ad_approvals.file_url` is a dead NOT NULL column, dropped to nullable rather than
  removed
- Morning audit thresholds in `AUDIT_CONFIG` are reasoned defaults, not tuned against
  real history — worth a backtest over a few months of `daily_reports`
- `clients.target_cpl` is read by the audit but the column does not exist yet
- `ai-chat` still accepts an arbitrary prompt from the browser using the anon key, which
  is visible to every portal user — an open proxy to our OpenAI account. The audit no
  longer uses it, but the weekly report and the per-client chat still do
- `preview/app.js` and `preview/body.html` are a stale snapshot that predates the signal
  engine and still carries the dead OpenAI key box. The deploy serves the repo root, so
  they affect nothing — but they will mislead anyone who greps
- The audit returns raw HTML injected with `innerHTML`; JSON plus client-side rendering
  would be cheaper, safer, and restyleable without re-running the model
- No ad-level performance data exists anywhere — `daily_reports` is account-level, so
  "which ad should we turn off" is unanswerable until the Make pull fetches Insights at
  `level=ad`
- **`tasks`' own RLS hasn't been checked** and may have the same shape of problem
  `daily_reports` did (see below) — the portal only proves its *browser* filters by
  client (`cpTasksForClient()`), not that its *query* does
- Reports are meant to start pulling from the client work summary once revamped — not
  built yet, this is the documented intention only (see Client work summary)
- `architecture.txt` is the original doc and is substantially out of date — it predates
  onboarding, check-ins, reports, triggers, cron and every Make scenario
