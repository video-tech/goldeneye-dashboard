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
2. **SEO data to Golden Eye** — writes `seo_metrics`, feeds the portal's Organic SEO tab.
   **Being retired**: the `seo-sync` edge function now pulls Search Console directly and far
   more deeply (by page and by query). Leave this running until the two are compared over the
   same dates, then unschedule it — see SEO measurement
3. **Onboarding form completion** — GHL form submitted → look up client → write
   `client_onboarding_progress` so the step ticks off in the portal
4. **Onboarding complete SMS** — `trg_onboarding_handoff` POSTs
   `{event, client, client_email, completed_at}` to
   `hook.us2.make.com/hucrpp6hm43ps165n7wxut8v9rn3dksu` → tag GHL contact → GHL workflow
   texts the client
5. **Weekly check-in reminder** ("txt reminder twice a day") — pg_cron → `send_weekly_checkin_reminders()`
   → webhook with outstanding clients + contacts → iterate → find by phone → SMS.
   **Secured 2026-09-15**, the first scenario done after #4, and the pattern for the rest:
   - The function sends `secret` from Vault (`supabase/sql/checkin_reminder_secret.sql`). Missing
     secret means nothing is sent, and a warning says so.
   - **Filter right after the webhook:** `secret` equals the value. A wrong secret stops the run at
     1 operation, before the GHL search.
   - **Search Contacts limit 1** (was 10) and the SMS module also requires
     `found phone = the phone we sent`. Before this, one reminder could text up to 10 contacts —
     the same flaw that texted 10 leads through #4.
   - **Order that keeps it working:** update the database first, prove the secret arrives (a request
     with an empty `contacts` list runs the scenario but texts nobody), redetermine the webhook's
     data structure so `secret` is mappable, then add the filter.
   - **Verified** by operation count: wrong secret = 1 op, real secret + a real contact = 4 ops and
     a text.
6. **Admin alerts** — Supabase trigger on `Client Request` tasks → webhook → SMS to us.
   **Unfinished**: trigger + recipients live, Make scenario needs iterator + send modules
7. **Report draft to Gmail** — the "Draft" button on a saved report (`sendSavedReportToMake`,
   app.js) sends `{client, subject, full_email_html, to_email[]}` through **`make-relay`** to
   `hook.us2.make.com/apq7ghcun1hza8h5ayw1xysy81nddh8v`, which drafts the email
8. **Ad previews** — `submitAdForApproval` / `refreshAdPreviews` send
   `{approval_id, ad_id, client_name, ad_name}` (form-encoded) through **`make-relay`** to
   `hook.us2.make.com/2kan16ro46vkcxsubi90aaobv1ym1fxg` → three HTTP calls to
   `graph.facebook.com/v21.0/{ad_id}/previews` (one per placement) → upsert
   `ad_approvals`. See **Ad approvals** below

**Every Make webhook URL is public.** They're in this public repo, and before 2026-09-14 some
were also in `app.js`'s page source. Anyone holding one can run the scenario, and that's how 10
leads got an "onboarding complete" text (see `trg_onboarding_handoff`). So **every scenario
filters on a `secret` field right after its webhook**, and every caller supplies it:
- **Postgres functions** read it from Supabase Vault (`make_onboarding_hook_secret`).
- **Edge functions** read the `MAKE_WEBHOOK_SECRET` secret. It's the same value.
- **The browser never calls Make directly**, because a secret in `app.js` is public.
  `callMakeRelay(hook, payload)` posts to `supabase/functions/make-relay`, which requires a
  signed-in admin, forwards only named hooks and allow-listed fields, and attaches the
  secret. A new browser-triggered scenario needs an entry in its `HOOKS` table.
  **Deploy `make-relay` before pushing `app.js`.**

**Audit of every live scenario, 2026-09-15**, read through the Make MCP connection (Claude can list
and read scenarios, executions and blueprints; the Make account is `video@midasmediafirm.com`,
team "My Team" 1498711):

| Scenario | Secret filter | Notes |
|---|---|---|
| #4 txt to client after onboarding | ✅ | Plus the exact-email check, from the 10-lead incident |
| #5 txt reminder twice a day | ✅ 2026-09-15 | Limit 1 + exact phone match added at the same time |
| #6 txt notification to us | ❌ | Same shape as #5: sends SMS to any number in the payload, searches GHL with limit 10 and no exact-phone check. Needs `notify_admins_client_request()` to send the secret first |
| #7 REPORTS GE to gmail | ❌ | Anyone with the URL can create Gmail drafts. Waiting on `make-relay` |
| #8 ads approval | ❌ | Anyone with the URL can upsert `ad_approvals` rows (overwrite a client's decision) and make us call Meta. Waiting on `make-relay` |
| #2 seo for golden eye | n/a | **Already switched off**, so Make's old SEO pull is retired |

**Credentials live in plain text inside blueprints:** a GHL private integration token (#5, #6) and a
Meta access token (three copies in #8). Reading those blueprints puts the values in whatever tool
reads them, so **rotate both, then paste the new values in Make**, and prefer a Make connection or
custom variable over typing tokens into HTTP modules.

## Database objects we added

- **`raise_onboarding_handoff_task()` + `trg_onboarding_handoff` on
  `client_onboarding_progress`, rebuilt 2026-09-11** — `supabase/triggers/onboarding_handoff.sql`.
  When a client's last client-owned step is completed, it creates the handoff task
  "Onboarding complete — ready for campaign build" and POSTs to Make scenario #4, which
  texts the client. The function had survived, hook URL and all, but the trigger had gone
  (cause unknown), and the table had no triggers at all. The task kept appearing because
  app.js raises it too, but **the text had stopped going out**. What to know before touching it:
  - **It fires on `INSERT OR UPDATE OF completed_at`, not INSERT only.** `saveOnboardingProgress()`
    inserts a video step's row at 10% watched with `completed_at` null, and the step is
    completed later by the upsert's DO UPDATE. An INSERT-only trigger misses every video
    step. The function then acts only when `completed_at` goes from null to set. That's why
    `rename_client()`, which sets `client_name` alone, and Make re-sending a finished form
    never fire it.
  - **"Already announced" means a handoff task exists. There is no separate flag.** That
    is why re-attaching the trigger texted nobody who finished while it was missing (app.js
    had raised their tasks). The check is also concurrency-safe, because the task commits in
    the same transaction as the completion. Consequence: **deleting a client's handoff
    task re-arms their text** if one of their steps is ever completed again.
  - **It only acts for `current_stage = 'Onboarding'` and `status = 'active'`**, the same
    gate `reconcileOnboardingHandoffTasks()` uses. Eight clients past onboarding sit at 9 of
    11 steps, because two steps were added after they were backfilled. Make's form scenario
    writes progress without looking at stage, so without this gate one resubmitted form
    could tell a client whose campaigns are running that their onboarding is complete.
  - Skips `completed_by = 'backfilled'` (`markOnboardingComplete()`, whose confirm dialog
    promises no notification).
  - `client_email` is stripped with `\s`, not `btrim` — the hidden `\r\n` in Known gaps
    would otherwise make Make's GHL contact lookup miss.
  - **Incident: 10 leads were texted "onboarding complete" (found 2026-09-14).** On
    2026-09-11 at 18:36 MDT, scenario #4 ran on a **completely empty** request. Golden Eye
    didn't send it, since this trigger always sends `event`, `client` and `completed_at`. The
    hook URL had been committed to this **public** repo three hours earlier. With no email,
    Make's GHL contact search returned the sub-account's first 10 contacts, Make tagged them
    all, and the GHL workflow texted them. Three guards now:
    - **Make:** `client_email` not empty, `secret` equals the vault value, search limited to 1
      result, and the found contact's email exactly equals `client_email` before tagging.
    - **This trigger never sends without a well-formed email.**
    - **This trigger never sends without the `make_onboarding_hook_secret` Vault secret**,
      which goes in the body as `secret`. The secret is in Supabase Vault, not the repo.
    Two rules from it:
    - **Never let a Make step act on a GHL search result without an exact-match filter.**
      GHL search is fuzzy, and an empty query returns everyone.
    - **Every Make webhook URL in this repo or in `app.js` is public.** Any scenario that
      texts, tags or writes needs a secret filter.
  - `onboarding_handoff_tests.sql` holds four rolled-back tests. Each attaches the trigger
    inside its own transaction, then ends in a deliberate `raise exception` that prints
    the results and makes a commit impossible.
  - Known limit: if a client's last two steps complete in two *concurrent* transactions,
    neither sees the other, so nothing fires. `reconcileOnboardingHandoffTasks()` still
    raises the task on the next admin load, but no text goes out.
  - app.js's portal path used to check only its local `globalTasksData` before filing the
    same task. It never saw the one the trigger had just inserted, so every portal
    completion filed a duplicate, and each duplicate meant another admin alert.
    `obNotifyOnboardingComplete()` now asks the database first.
  - **Live since 2026-09-11.** All four tests passed first (one text on a real completion,
    none on a rename, a post-onboarding client, or a backfill); the trigger was then attached
    and confirmed in `pg_trigger`.
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
- **`weekly_report_inputs`, added 2026-09-14** (`supabase/sql/weekly_report_inputs.sql`) holds
  the notes typed into the Generate Report box, one row per report and keyed on
  `report_id` (cascade delete). It's shown in the admin Reports list and read-only in Edit
  Report. **It's a separate admin-only table, not a `weekly_reports` column, because the
  client portal reads `weekly_reports` with `select('*')`.** RLS is per row, so any column
  added there would be readable by the client. No `rename_client()` line is needed, since it
  follows the report by id. Reports generated before this date have no saved notes.
- **`tasks` policy, fixed 2026-09-10 — same read leak as the other two
  (`Allow authenticated users to read tasks`, `Auth Read Ads` both `USING (true)`;
  `Allow authenticated users to insert tasks` had `WITH CHECK (true)`, so any
  authenticated user could also insert a row under any client's name, as any assignee,
  status, or type), but fixing it surfaced something bigger than the policy itself.**
  `user_has_client_access()` — the helper every fix on this page relies on — depends on
  `user_client_access`, and **that table had rows for only 4 of the ~10+ active
  clients.** `daily_reports` and `weekly_reports` both still carry an older policy that
  matches `client_email` directly and never touches `user_client_access` at all, so most
  clients had been reading those two tables through that legacy path this whole
  time without anyone noticing the gap. `tasks` had no such fallback — applying the
  policy shape used on the other two tables here would have correctly closed the leak
  and *also* correctly locked out most clients from their own Tasks tab, which is worse
  than the bug it fixes. (This also means the first version of this policy, applied
  without the fallback below, was briefly live and did exactly that — caught by testing
  before it had been live long.)

  Fixed by giving the new policy the same `client_email` fallback the older tables
  already lean on, rather than trusting `user_has_client_access()` alone:
  ```sql
  create policy "Clients read their own client's tasks"
  on tasks for select
  using (
      user_has_client_access(client)
      or exists (
          select 1 from clients c
          where c.client_email is not null and c.client_email <> ''
            and lower(regexp_replace(c.name, '[^a-zA-Z0-9]', '', 'g'))
              = lower(regexp_replace(coalesce(tasks.client, ''), '[^a-zA-Z0-9]', '', 'g'))
            and lower(auth.email()) = ANY (string_to_array(lower(regexp_replace(c.client_email, '\s', '', 'g')), ','))
      )
      or current_user_is_admin()
  );

  create policy "Clients submit their own client requests"
  on tasks for insert
  with check (
      current_user_is_admin()
      or (type = 'Client Request' and (
          user_has_client_access(client)
          or exists (
              select 1 from clients c
              where c.client_email is not null and c.client_email <> ''
                and lower(regexp_replace(c.name, '[^a-zA-Z0-9]', '', 'g'))
                  = lower(regexp_replace(coalesce(tasks.client, ''), '[^a-zA-Z0-9]', '', 'g'))
                and lower(auth.email()) = ANY (string_to_array(lower(regexp_replace(c.client_email, '\s', '', 'g')), ','))
          )
      ))
  );
  ```
  The INSERT policy is also narrower than the old one on purpose: a client can only ever
  insert a `Client Request` row under their own client, matching exactly what
  `submitPortalRequest()`/`submitClientRequest()` already do — not an arbitrary row
  under any assignee or status the way the old `WITH CHECK (true)` allowed.

  `regexp_replace(c.client_email, '\s', '', 'g')` rather than a plain space-strip: the
  first attempt used `replace(c.client_email, ' ', '')` and the fallback silently failed
  for a real client until `length(client_email)` showed 2 bytes more than the visible
  address — hidden `\r\n` that a space-only strip never touched. `\s` catches it
  regardless of which whitespace character is actually there. See the Known gaps entry
  on this for why that's worth a wider check across `client_email`.

  Verified with two accounts: one with a real `user_client_access` row (confirms the
  primary path), one without (confirms the fallback) — scoped read, own-client insert
  succeeding, and an insert impersonating a different client failing, on both.
  `Admin and Investor Task Access` (`ALL`, grants `video@midasmediafirm.com`,
  `info@midasmediafirm.com`, and one client contact full read/write/delete on every
  client's tasks) was left completely untouched. The third grant is a deliberate,
  confirmed-intentional exception — that contact is treated as an investor, not an
  ordinary client — not an oversight to clean up.

- **`tasks.client_visible`, added 2026-09-15** (`supabase/sql/task_client_visibility.sql`), set by
  "Hide from client" in the task drawer. A hidden task stays on our board, marked Hidden.
  - **Enforced in the database:** the client read policy above now also requires
    `client_visible` on its two client branches, so a client can't read hidden tasks even from
    DevTools.
  - **Where it's filtered:** app.js filters them from `cpTasksForClient`, portal lists, the
    support list and the weekly report's task lists (for admin preview, where RLS lets everything
    through). `client-summary` skips them.
  - **Still visible to:** the admin chat (it's for us), and the investor contact through
    `Admin and Investor Task Access`, unchanged.
  - **Order:** run the SQL, then deploy `client-summary`, which selects the column. Saving a task
    marked hidden before the SQL exists is refused rather than saved visible.
  - **Tests:** 6 PGlite checks.
- **`client_row_visible(text)`, added 2026-09-10** — the RLS helper every client-facing table
  added from here on should use. Wraps admin / `user_has_client_access()` / `client_email`
  fallback into one call so the fallback cannot be forgotten. See SEO measurement for why that
  matters more than it looks.
- **`seo_daily`, `seo_pages_daily`, `seo_queries_daily`, `seo_sync_state`, added 2026-09-10** —
  Search Console history, written only by the `seo-sync` edge function via `service_role`,
  readable through `client_row_visible(client_name)`. Full reasoning in SEO measurement.
  `clients` also gained `gsc_property`, `ga4_property_id`, `gbp_location_id`, `ghl_location_id`.
- **`rename_client()`, replaced 2026-09-11 — it had no caller check.** It was `SECURITY
  DEFINER` (runs with the owner's rights, bypasses RLS) and **checked nothing about who called
  it**. `has_function_privilege` confirmed both `anon` and `authenticated` could execute it, so
  anyone holding the public anon key — which is in the page source — could rename any client.
  That is worse than vandalism: renaming a victim's client onto your own client's name merges
  their tasks, reports and check-ins into yours, where your own RLS then shows them to you. The
  only guard was app.js hiding the button.

  The replacement lives in `supabase/sql/rename_client.sql`, moved there from `seo-sync/schema.sql`
  on 2026-09-11 once a second feature needed it. That file is now the single list of every table
  keyed on `clients.name`. The replacement:
  - requires `current_user_is_admin()`
  - pins `search_path = public`
  - refuses a new name that normalizes to an existing client. That stops two histories merging,
    and it's also what keeps the `seo_*` primary keys and `client_work_summaries`' unique key
    from colliding mid-rename.
  - revokes EXECUTE from `public` and `anon`. This has to be explicit, because
    `create or replace` keeps the old function's grants.

  It also moves the seven tables the old version skipped, plus `lead_sources` since the lead
  classifier: the four `seo_*` tables,
  `client_contacts`, `client_work_summaries` and `client_onboarding_progress`. The last one is
  safe only because `trg_onboarding_handoff` fires on INSERT or UPDATE OF `completed_at`, and a
  rename sets `client_name` alone — tested in a rolled-back rename, no second text. Any trigger
  ever added to that table needs the same property, or every rename will re-text every client
  who has finished onboarding. Its error messages
  deliberately avoid the word "function", because `saveClientEdits()` reads any error
  containing it as "rename_client isn't installed" and would show the wrong explanation.

  Verified in rolled-back transactions: `anon` can no longer execute it, a client JWT is
  refused, an admin JWT renames, and a rename onto an existing client is refused.

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

**Service-based onboarding (in progress, started 2026-09-14; plan in
`~/.claude/plans/fluttering-gliding-pebble.md`).** Every client starts on **Base** (free website,
missed-call text-back, review automation, lead follow-up, portal access). Add-ons are **SEO Growth**,
**Ads management** and **Video** (Video is seeded switched off as a placeholder).
- **Base is not a service row.** Every client has it, so Base steps are simply the untagged ones,
  and it creates no marketing tasks of its own.
- **Website is not an add-on.** The site comes with Base, so what varies is `clients.website_status`
  (we build their free site, or they keep an existing one).
- **Services are data** (the `services` table), never code, so a changing offer doesn't change the
  onboarding engine.

`supabase/sql/service_onboarding.sql` (step 1) adds:
- **`client_services`:** one row per client per service, status `onboarding` / `active` /
  `paused` / `ended`. Adding a service later sets it to `onboarding`, and its steps come back.
- **`clients.website_status`:** `none` / `existing` / `new_build`, or null when unknown. It's a
  client fact, not a service.
- **Conditions on `onboarding_steps` and `stage_templates`:** `service_keys` (any-of, empty =
  everyone), `website_statuses` (empty = any), and `auto_check`.
- **`onboarding_steps_for_client(p_client)`, the single rule for what applies.** It returns one row
  per step per service it counts toward, plus `display_service_key` for grouping. Everything is meant
  to use it: the portal, the admin view and the handoff trigger, so they can't disagree.
- **`service_onboarding_status(p_client)`:** always a `base` row (the untagged steps), plus one row
  per add-on. An add-on is complete when its tagged client steps AND Base are done. Agency steps
  never gate it.
- **`onboarding_auto_checks(p_client)`:** keys an agency task can auto-complete on (ad account saved,
  ad spend flowing, GHL linked, Search Console syncing, SE Ranking syncing, SEO settings, auto-log,
  first auto-logged article, which is the Cuppa pipeline working end to end (Cuppa has no API),
  lead tracking live, first organic lead, website status). New checks are added there only.
- **Migration:**
  - **Steps:** today's steps are tagged by title. The Facebook/Meta steps and the two ad tasks →
    `ads`. Welcome, setup call, both business forms, sales team and GHL setup stay untagged, as Base.
  - **Clients:** every client gets `ads` with a status from their stage/status, and clients with
    Search Console or SE Ranking connected also get `seo`.
  - **Nothing reads these yet:** app.js and `trg_onboarding_handoff` still use the global list until
    later steps switch them.
  - **Tests:** 35 PGlite checks.
- **`onboarding_condition_matches()` is THE rule** for whether tags apply. `onboarding_preview()`
  and `onboarding_steps_for_client()` both call it, and app.js never re-implements it.
  `onboarding_auto_checks(null)` returns every check with its label, which is the editor's picker list.
- **Editor (built 2026-09-15):**
  - **Templates → Services** manages add-ons. Keys are read-only once saved, because steps are
    tagged with them. Services are switched off, never deleted.
  - **Tags:** every onboarding step and stage checklist row has service chips, website-situation
    pills and, on our own tasks, an auto-check picker.
  - **Preview:** Client Onboarding has **Preview a Client**, which calls `onboarding_preview`.
  - **Add / Edit Client** have add-on checkboxes and a Website select. A newly ticked add-on becomes
    `onboarding`, an unticked one becomes `ended` (after a confirm), and re-ticking an ended one
    restarts it.
  - **Tests:** 26 jsdom checks.
- **Switched over 2026-09-15:** Get Started, agency tasks, stage checklists and `trg_onboarding_handoff`
  all use the tags now.
  - **One source:** app.js loads `onboarding_steps_for_clients` and `service_onboarding_status_for_clients`
    into `obApplicable` on every data load. `allOnboardingItems(client)` and
    `activeOnboardingSteps(client)` read it, and if the SQL isn't there they fall back to every
    step applying to everyone.
  - **Access:** the per-client functions are SECURITY DEFINER. They check `client_row_visible()`
    for signed-in users, while service_role (Make writing progress) and the SQL Editor see all.
    Without that, a client whose `clients` row RLS hides would get "no steps".
  - **In the Onboarding stage:** the old event, over the steps that apply to the client. When
    they're all done, the handoff task and text fire, `services` goes in the Make payload, and every
    `onboarding` add-on is marked active.
  - **Past onboarding, a new add-on** (for example SEO for a long-running ads client): Get Started
    shows only that add-on's steps (`getStartedSteps`). When they're done, the trigger marks it
    active and raises "<add-on name> onboarding complete — ready to start", with **no text**,
    because scenario #4's message is wrong for them.
    - Base doesn't gate an add-on once the client has left Onboarding.
    - Agency tasks for an add-on are raised only when that task exists, so pre-existing SEO clients
      don't suddenly get SEO setup tasks.
    - Renaming a service changes the expected title, so an in-flight add-on onboarding would miss
      its tasks.
  - **Later stages** generate from `stage_templates_for_client()`.
  - **Forms:** an onboarding form's URL also carries `step_id`, `website_status` and `services`.
    Empty values are left off.
  - **Tests:** 49 PGlite checks (functions), 17 (trigger), 18 jsdom checks (portal), plus
    `onboarding_handoff_tests.sql`, with Test 5 added for an add-on.
- **Auto-check reconcile (built 2026-09-15)** is `reconcile_auto_checks()` in
  `supabase/sql/auto_check_reconcile.sql`.
  - **What it closes:** open tasks whose template has an `auto_check` that
    `onboarding_auto_checks(client)` says passes. Agency onboarding steps match on title with stage
    Onboarding; stage checklist items match on title + stage. Tasks have no template id, so this is
    the same link `generateStageTasks` dedupes on.
  - **How:** it sets the task to Complete and appends "Ticked off automatically: <label> (date)" to
    its notes. It never reopens a task.
  - **When:** pg_cron job `onboarding-auto-checks` at 19:30 UTC daily (after both SEO syncs), plus
    `runAutoChecks()` on every admin load, before `autoAdvanceCompletedOnboarding`, so a ticked
    task can move a client on.
  - **Who can run it:** admins, or no signed-in user (the schedule). SECURITY DEFINER.
  - **UI:** a lightning bolt marks self-closing tasks in the client's onboarding list.
  - **Tests:** 19 PGlite checks.

**Questions steps (built 2026-09-15)** are a step type answered inside Golden Eye rather than an
embedded GHL form, for forms nothing in GHL uses. The SEO intake is one. Schema is in
`supabase/sql/onboarding_questions.sql`.
- **Where things live:** questions are data on the step (`onboarding_steps.questions`, a jsonb list of
  `{id, label, type short|long|choice|multi, options, required, website_statuses}`), edited in the
  step's question builder in Templates. Answers go in `onboarding_answers`, one row per client per
  step, as `{question id: {label, value}}`.
- **Stable answers:** a question's `id` never changes, so rewording keeps its answers, and the label
  saved with each answer keeps old answers readable.
- **Submitting** (`obSubmitAnswers`) saves the answers, then completes the step through
  `obCompleteStep`, so the handoff trigger treats it like any step. Editing later just re-saves.
- **Website-conditioned questions** are asked only when the client's `website_status` matches.
- **RLS:** read, insert and update via `client_row_visible`; delete is admin only. It's in
  `rename_client.sql`.
- **Admin view:** answers show under the client's onboarding list, with a Copy button (plain text,
  for Cuppa).
- **The editor's eye button** hides or shows a step. A hidden step can be saved without a link or
  questions, which is how steps are drafted before their video or form exists.
- **SEO steps:** `supabase/sql/seo_onboarding_steps.sql` added 2 client steps (hidden) and 7 agency
  steps, 6 with auto-checks.
- **Tests:** 13 PGlite checks, 20 jsdom checks.

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

`tasks` was checked the same way afterwards and had the same leak, plus a write one —
**fixed 2026-09-10**, see `tasks` in Database objects. The general lesson stands: the portal
filtering `globalTasksData` client-side (`cpTasksForClient()`) only ever proved the *browser*
hides other clients' rows, never that the *query* does.

Every client-facing table added since then uses `client_row_visible()` instead of hand-writing
the policy — see the SEO section below.

## SEO measurement

Four sources, one destination. Everything a client sees about organic search comes out of
Postgres tables that a scheduled edge function fills; nothing is fetched live from Google by a
browser, and nothing about SEO goes through Make.

**Phase 1 (built 2026-09-10) is Search Console ingestion only.** No UI beyond four fields on the
client record. That order is deliberate: Search Console keeps roughly **16 months** and then
drops the oldest month for good, so every week the pull is not running is a week that can never
be reported on or built into a case study. Charts can be written any time; history cannot be
recovered. Phase 2, organic leads, is further down this section. The remaining phases — GA4, the keyword/changelog UI, the portal tab
and report block, baselines, GBP — are in the plan file and land on top of this.

### How a client is connected

Four nullable columns on `clients`, and **the presence of a value is the switch**. There is no
separate "SEO enabled" flag, because a flag can say yes while the data cannot actually be
fetched, and then nobody can tell an empty chart from a broken one.

**This has to mean the ONLY switch — nothing else may gate it, `clients.status` included.**
Both `seo-sync` and `seranking-sync` originally also required `status = 'active'`, and it
silently contradicted the rule above: Midas Media's `gsc_property` and `seranking_site_id`
were both set and both tested as "Connected" (`check` mode never filtered by status), but the
actual scheduled pull skipped it every single run, because its status is `'paused'`. Found
2026-09-11 when Test SE Ranking refused it outright with "no client... has a seranking_site_id
set," which is what made the inconsistency visible — `seo-sync`'s equivalent bug was silent,
since its own `check` mode gave no reason to doubt the connection. **Fixed by removing the
status check from both.** A paused client can have a real reason to keep their organic history
collecting — a paused retainer for billing reasons is not the same thing as "stop tracking
their SEO" — and if syncing should stop for someone, clearing `gsc_property` /
`seranking_site_id` is the one place that decision belongs.

| Column | What it holds | Where it comes from |
|---|---|---|
| `gsc_property` | `sc-domain:example.com` **or** `https://www.example.com/` | Search Console, verbatim |
| `ga4_property_id` | digits only | GA4 Admin → Property details |
| `gbp_location_id` | digits only | Business Profile Manager URL |
| `ghl_location_id` | GHL sub-account id | resolves inbound lead webhooks (phase 2) |

`gsc_property` is stored **exactly as typed and never normalized**. Search Console treats
`https://example.com/` and `https://example.com` as different properties, and a domain property
is a third string again. Tidying a trailing slash away here would silently break the pull, so
the Edit Client modal has a **Test connection** button instead: it asks the function whether the
service account can actually read the string *currently in the box* — not the saved one, or a
correct old value would pass while the new typo sat there unsaved — and when it can't, it names
the close match it *can* read as a one-click fix. That covers the whole failure class: typo,
wrong property type, or the service account never added.

Access is granted per property by adding **one service-account email** as a user in Search
Console (Restricted is enough), GA4 (property Viewer), and later GBP (Manager). No OAuth, no
refresh token to expire quietly — the failure mode is always "that email isn't on this
property", which is visible and fixable.

**"Midas Media" is deliberately NOT excluded from this pull, unlike `client-summary` and
`morning-audit`, which both skip it on purpose.** An earlier version of `loadSeoClients()`
copied that exclusion, reasoning it would generalize. It doesn't: those two exclude Midas
because they generate CLIENT-FACING content (an AI work-summary blurb, an audit signal), and
Midas isn't a client to write one about. Search Console has no equivalent conflict — each
`gsc_property` is an independently scoped Google property, never shared between two client
rows — so once Midas's own record has a real `gsc_property` and the service account has
access, its Search Console history is pulled and stored exactly like any other client's,
which is the point: Golden Eye tracks Midas's own SEO push (targeting the HVAC vertical
first — see the plan file) the same way it tracks a client's. **This is separate from the
Meta-ads exclusion** for the ad account Midas actually shares with Sunset Design Build:
that one works by aliasing the shared account's name to Sunset in `normalize()`, not by
blanket-skipping anything named Midas, and nothing here needs to imitate it.

### The pull

`supabase/functions/seo-sync/` — `schema.sql`, then deploy, then `schedule.sql`. Two cron jobs:

- **`seo-sync-daily`, `0 18 * * *`, every day.** A rolling window over the **last 10 days**, not
  "fetch yesterday". **Search Console does not have yesterday yet** — it finalises a day two to
  three days late and keeps revising after that. A fixed offset would either fetch nothing or
  freeze a half-counted day forever. The window re-fetches and upserts, so late data lands on
  the next run with nobody noticing. This is the exact opposite of the Meta pull, whose rows are
  frozen at a constant age — and that difference is load-bearing in both directions: it is what
  makes the morning audit's comparisons unbiased, and it is why nothing here feeds that engine.
  18:00 UTC clears the 16:00 audit, 16:05 summary, and the 08:00-local ads pull on both sides of
  the daylight-saving drift pg_cron doesn't follow. Every day, not weekdays: weekend traffic is
  still traffic.
- **`seo-sync-backfill`, `*/15 * * * *`, permanently.** Walks backwards one calendar month at a
  time until 16 months exist, then stops for that client for good. It stays scheduled precisely
  so nobody has to remember it — type a property into a client's record and their history starts
  arriving on its own, four months per run, about an hour end to end. Once every client is done
  each run is two cheap queries returning in well under a second, and the Google token is signed
  **lazily** so an idle run never touches Google at all.

Three tables because `[date]`, `[date,page]` and `[date,query]` are three separate API calls:
`seo_daily`, `seo_pages_daily`, `seo_queries_daily`. Deliberately **not** one `[date,page,query]`
table — it multiplies rows for nothing, and its page-level impressions don't sum back to property
totals anyway (one query showing two of your pages is one property impression but two page
impressions). `seo_daily` is the only honest source of account totals.

**`position` is impression-weighted, and aggregating it needs
`sum(position * impressions) / sum(impressions)` — never `avg(position)`.** Google returns an
already-weighted figure per row. The existing `renderAdminSeo`/`renderCpSeo` take a flat mean of
daily averages, which weights a 3-impression day the same as a 3,000-impression one and does not
match what Google shows for the same range. Phase 4 replaces them.

`seo_sync_state` holds a per client + source cursor, because a 16-month backfill cannot finish
inside one invocation's 150s wall clock. The cursor is saved **after every month**, so a run
killed by the clock never re-fetches what it already wrote, and a per-client cap of four months
per run stops one new client eating an entire invocation while another waits at zero. Any
client's error lands in `last_error` rather than only in a log — one client's revoked access
must never stop the other nine, and a silently empty chart is the failure this avoids.

Modes: `daily`, `backfill`, and `check` (the Test connection button). `check` and `force` require
a **real signed-in admin**, verified inside the function — the gateway only proves the caller
holds the anon key, which is public, and both of those spend Google quota on demand.

### `client_row_visible()` — use this on every new client-facing table

One `SECURITY DEFINER` helper wrapping the three-way check the `tasks` policy spells out inline:
admin, **or** `user_has_client_access()`, **or** the `client_email` fallback. It exists because
this build adds seven client-readable tables and **the fallback is not optional** —
`user_client_access` has rows for only about four of the ten-plus active clients, so a policy
trusting `user_has_client_access()` alone locks most clients out of their own data while looking
perfectly correct in review. That already happened once, on `tasks`. A one-line policy that
cannot forget it is the fix:

```sql
create policy "..." on <table> for select using (client_row_visible(client_name));
```

No insert/update/delete policies on any of these tables. Only the edge function writes, via
`service_role`, which bypasses RLS.

**New tables key on the exact `clients.name`**, not a normalized form. The fuzzy
`normalize().includes()` matching stays confined to the Meta tables, where it exists because Meta
renames ad accounts under us. Here we control the writer, so an exact key is both possible and
safer — and it means **every new table needs a line in `supabase/sql/rename_client.sql`**, or a rename
orphans a client's entire SEO history with nothing to say what happened.

### The 1000-row cap, which already bites

PostgREST caps any response at **1000 rows** (`max_rows`) and **nothing in app.js pages past it**
— there is no `.range()` call anywhere. `select('*')` on `seo_metrics` has therefore been
silently truncated for months, and which rows come back is arbitrary. The page and query tables
are a hundred times larger.

So: **these tables are never bulk-loaded.** The browser reads `seo_daily` for one client (≤ ~490
rows for 16 months) and everything else through `security invoker` SQL functions that return a
few hundred rows by construction. Any `select` on `seo_pages_daily`, `seo_queries_daily` or
`lead_sources` without a client *and* date filter is a bug.

### Organic leads (phase 2, built 2026-09-11)

`supabase/functions/ghl-lead-webhook/` receives a GHL workflow webhook (**Contact Created** →
Webhook) for every new contact, and stores **one row per website lead** in `lead_sources`: which
client, when, what kind (booking, form, call or chat), and where it came from (organic, paid,
social, referral, direct, other or unknown). It stores ids and attribution only, **never a name,
email, phone number or IP address**. The rules were written against real GHL payloads rather than
GHL's documentation, and the four real captures are fixtures in its tests. Setup: `schema.sql` in
that folder, then `supabase/sql/rename_client.sql`, then deploy.

- **A lead is stored only when its landing page is on its client's own domain**, taken from
  `gsc_property`. Subdomains count, so a booking page on `book.example.com` belongs to
  `sc-domain:example.com`. Organic means someone searched and landed on the client's site, so
  this is part of the definition rather than a filter. It also means nothing is stored for a
  client without a Search Console property, or for a sub-account not linked to any client. Meta
  instant-form leads have no landing page and are already counted in `daily_reports`, so they
  aren't website leads.
- **Classification order (first match wins):**
  - Google or Microsoft click IDs, a GHL ad id, or a paid `utm_medium` → **paid**.
  - `utm_medium=organic` → **organic**. `utm_source=gbp` also sets `is_gbp`.
  - Other UTM mediums → referral, social or other.
  - `fbclid` on its own → **social**. Facebook adds it to organic post links too, so it isn't
    proof of an ad.
  - GHL's own `sessionSource`, if it says paid or organic.
  - A search-engine referrer → **organic**.
  - A referrer on the client's own domain → **unknown**, with `source_detail = 'self_referral'`.
  - Any other referrer → **referral**. Nothing at all → **direct**.
- **The real captures shaped those rules in three ways.**
  - GHL's `sessionSource` is based only on the referrer and ignores UTM tags, so UTMs read from
    the landing URL outrank it.
  - GHL records only the last hop. A Google visitor who lands on the site and then clicks
    through to a booking page on another host arrives as a "Referral" from the site itself, and
    the Google origin is lost.
  - The Meta `fbc`/`fbp` cookies last 90 days in the browser, so they're never treated as a
    signal. Only click IDs on the current visit's URL are.
- **`snippets/lead-source-carry.html` fixes the lost hop on the site itself.** Pasted into the
  main site's head, it records the real source where the visitor lands: a search engine becomes
  `utm_medium=organic`, other sites become `referral`, and ad tags and click IDs pass through
  untouched. The last non-direct click is kept for 30 days. At click time, it adds that source to
  links pointing at the booking host and marks it with `src_restored=1`. It never tags same-host
  links (GA4 would start a new session mid-visit) or third-party links, and it never overwrites a
  link that already has `utm_source`. It only covers `<a href>` links. **Verified live on
  midasmediafirm.com on 2026-09-11:** a real Google search, then the site, then Book, arrived
  tagged `utm_source=google&utm_medium=organic&src_restored=1`. A client without the snippet
  shows a high `self_referral` rate, which is the signal to install it.
- **Every new SEO client needs one real Google-search test lead** before their organic count is
  trusted, because each site's form or booking setup decides whether the source survives.
- **Security.** `verify_jwt = false` for this one function, because GHL can't send the gateway
  JWT. That leaves the `GHL_WEBHOOK_SECRET` secret as the only gate, sent as an
  `x-webhook-secret` header or as `?k=` for webhook actions without custom headers. If the secret
  is unset, the function refuses everything. Both sides are trimmed and stripped of quotes before
  a constant-time comparison. **A refused request logs why** (`ghl-lead-webhook REFUSED`: nothing
  sent or a mismatch, both lengths, and the header names, but never either value). The first real
  test came back 401 with no explanation, which is why that logging exists.
- **Writes are idempotent.** An upsert on `ghl_contact_id`, where the first write wins, means a
  GHL retry can't double-count a lead. A database failure returns 500 so GHL can retry.
- **Debug capture** is controlled by the `GHL_CAPTURE=1` secret and is off by default. When on,
  it also saves a redacted copy of the payload, plus the decision taken, to
  `ghl_webhook_captures`, where the SQL Editor can read it. That exists because the dashboard's
  log views proved unusable for this. Personal fields are stripped by key and by value, and any
  credential is redacted, including the secret pasted into the body by mistake. Turn it on to see
  why a new client's leads classify the way they do, then turn it off again.
- **Midas's own GHL sub-account is shared with client Sunset Design Build.** Midas isn't a client
  in Golden Eye and Sunset isn't an SEO client, so that sub-account isn't linked to any client and
  nothing from it is stored. The workflow there stays on permanently at no cost. It's the test
  bench: a test contact still lands in Sunset's CRM and fires their Contact Created workflows, so
  test only through Midas's own site with fake details, and delete them afterwards. If Sunset ever
  becomes an SEO client, that sub-account's location ID goes on their record, and the own-domain
  rule keeps Midas's leads out of their numbers.
- **98 local checks** cover the gate, every classification rule, the four real captures, the
  shared-sub-account rule, idempotency, failure handling, and capture-mode redaction.

### Rank tracking, keywords, and the SEO changelog (schema built 2026-09-11)

`supabase/functions/seranking-sync/schema.sql` adds the tables real tracked rank lives in,
alongside the Search Console data `seo-sync` already collects. **GSC and SE Ranking aren't
redundant — GSC only reports a query once it earns impressions**, so a client sitting at
position 40 for a "[service] [city]" term is invisible to it. SE Ranking checks a keyword
whether or not the client shows up yet, which is the entire reason to pay for it. Built
admin-first, on purpose — the client portal SEO tab and report block come after, once the
data has been sanity-checked.

- **`clients.seranking_site_id`** — SE Ranking's numeric project id. Same "presence is the
  switch" pattern as `gsc_property`.
- **`seo_rank_locations`, admin-only.** SE Ranking checks every tracked keyword against
  every search engine configured on a project, and a "search engine" there means a specific
  city (and possibly device), not just "Google" — a client serving three towns gets three
  rows here, one per `site_engine_id`, and every keyword's rank is checked in all three
  automatically. There's no per-keyword location assignment on SE Ranking's side to mirror;
  the full matrix is how their system works. This table is operational wiring, not something
  the portal reads directly yet — a second SELECT policy can be added later if a phase wants
  to show "tracked from: Draper, Sandy, Provo" to the client.
- **`seo_keywords`, managed IN SE Ranking, never typed twice here.** The sync pulls the list;
  nothing writes back to SE Ranking. `keyword` is stored `lower(trim())` so it matches
  exactly against `seo_queries_daily.query` (GSC already lower-cases its own query text) —
  that's what lets the admin tab show "SE Ranking says #4 — here's what GSC says that page's
  clicks and impressions actually did" as one row, not two disconnected numbers.
- **`seo_rank_checks` stores organic AND map-pack rank in one row**, because SE Ranking
  returns both from the same call for a given keyword/location/date (`pos`, `is_map`,
  `map_position` together). Splitting them into two rows keyed by an "engine" column would
  invent a distinction their API doesn't make, and double the row count for nothing.
  `ranking_url` is the landing page SE Ranking found ranking — cross-check it against
  `seo_pages_daily` to catch two pages competing for the same term.
- **`seo_changelog` is the annotation source for the trend chart and, later, the case-study
  view.** A chart can be redrawn any time history exists; the story of *why* a line moved
  can't be reconstructed after the fact if nobody wrote down when a page went live or a fix
  shipped. `notes` is written as client-visible from the start — it's case-study material
  once the portal tab exists, not staff-only commentary like `tasks.notes`.
- **`seo_keywords` and `seo_changelog` get an admin write policy**, unlike every other SEO
  table in this build. The admin tab lets someone add or retire a tracked keyword, or log a
  changelog entry, by hand — `seo_rank_checks` and `seo_rank_locations` stay
  service_role-only, since nothing legitimate ever writes a rank check directly.
- **`seo_sync_state.source` now also accepts `'seranking'`**, alongside `gsc`/`ga4`/`gbp`, so
  the coming ingestion function can track its own sync state the same way `seo-sync` does.
- All four new tables were added to `supabase/sql/rename_client.sql` in the same change.

**`supabase/functions/seranking-sync/` (built 2026-09-11) is the ingestion function.** One
mode, `sync`: for every active client with a `seranking_site_id`, it pulls search engines,
keywords, and positions, in that order, and upserts each into the tables above. `mode:
"check"` is the admin-only Test SE Ranking connection button in Edit Client — same pattern
as Test Search Console, but it checks the client's *saved* project id rather than an
unsaved one, since a numeric id has no near-miss format to correct the way a GSC property
string does.

- **Auth is `Authorization: Token <key>`, confirmed from SE Ranking's own docs and worked
  examples** (their getting-started page itself 403'd a direct fetch, but the header format
  is shown working elsewhere in their documentation) — **not yet confirmed against our own
  key**, the same position the Google auth code was in before its first real token
  exchange. The first live sync is what actually proves it.
- **Parsing is split into `parse.ts`, with no imports at all**, so it can be tested against
  fixed JSON with no network — same reason `morning-audit/engine.js` is kept separate from
  that function's `index.ts`. 39 local checks, and all three response shapes (search
  engines, keywords, positions) are tested against **real data from the SE Ranking MCP**, a
  different auth path onto the same API. Positions was first built from the docs alone, and
  the real 3Sixty response on 2026-09-14 showed it had `landing_pages` wrong: the field
  sits on the **keyword**, not on each daily position, and holds `{url, date}` objects. So
  every `ranking_url` had been stored null. Each day now gets the latest page seen on or
  before it, because a keyword can switch ranking pages. The map fields (`pos`, `is_map`,
  `map_position`, with `is_map` sent as `0`/`1`) were right. A completely wrong top-level
  shape still throws, landing the real response body in `seo_sync_state.last_error`
  rather than silently storing zero rows.
- **A project only tracks the map pack when its search engine has `merge_map: 1` and a
  `business_name`.** 3Sixty's does (Eagle Mountain, UT). Midas's national project doesn't.
  Unverified: with `merge_map` on, whether `pos` on a map-pack day is the true organic rank
  or the local pack's slot on the page. No tracked keyword was in a map pack yet to check.
  Look at the first `seo_rank_checks` row with `map_rank` set against SE Ranking's UI.
- **A keyword is NOT automatically checked against every search engine on a project** — a
  real captured response shows `site_engine_ids` explicit per keyword
  (`{"id":"17705872",...,"site_engine_ids":[386614]}`). An earlier draft of this schema's
  comments assumed a blanket matrix; corrected once real data showed otherwise. Nothing
  about how the tables store results changes: `seo_rank_checks` is keyed by whichever
  `(keyword, site_engine_id)` pairs actually come back with position data.
- **Organic and map-pack rank land in one row**, because SE Ranking returns both from the
  same call. A day with no rank is stored as `null`, never `0` — SE Ranking's own UI shows
  a dash for "not ranking," and storing zero would silently read as "ranked #1" to any
  future chart that doesn't know to check for the sentinel.
- **No backfill cursor, unlike `seo-sync`.** A rank-tracking project's own history starts
  the day a keyword was added, not 16 months ago, so a rolling 35-day window on every run
  is enough to never miss a day even after a missed run — there's no month-by-month walk
  to build.
- **Added 2026-09-14 for the client SEO tab** (`supabase/sql/seo_client_tab.sql`; run it before
  deploying the sync, since the sync writes the new columns):
  - **Keyword metrics:** the positions response's `volume`, `cpc` (falling back to `suggested_bid`)
    and `competition` are saved on `seo_keywords`. SE Ranking reports volume 0 for searches too
    small to measure, which is stored as null.
  - **Ranking pages:** positions are requested with `with_landing_pages=1`. Without it SE Ranking
    omits landing pages, and every `ranking_url` was null even after the parser fix.
  - **Daily snapshot:** `/sites/summary` goes into `seo_project_daily` (visibility %, top-5/10/30,
    avg position, authority from `domain_trust` or the documented `da`, pages indexed).
  - **Room to grow:** `/analytics/seo-potential?top_n=3` (extra traffic and its ad value) is fetched
    at most once every 7 days.
  - **Failure handling:** a snapshot failure doesn't fail the rank sync. It's reported as
    `snapshot error: …` in `last_error`.
  - **Unit cost:** baseline before the first run with these was 23,000 units left, so check what
    the daily snapshot costs before adding more.
- **Client tab calculations** in the same file, all SECURITY INVOKER so client RLS applies:
  - `seo_client_overview` returns, in one row: visits, leads from Google (`lead_sources` organic,
    Denver day), jobs and revenue from Google (`weekly_checkins.closes_by_source->'google'`,
    normalized name match), the ROI multiple (Google revenue ÷ `seo_monthly_fee` pro-rated to the
    window), target searches on page 1 (organic 1–10 or map pack, on each keyword's latest check day),
    ad-equivalent value (matched query clicks × keyword CPC plus remaining clicks × median CPC), and
    the latest snapshot and room to grow.
  - `seo_since_start` compares the 30 days before `clients.seo_start_date` with the latest 30
    finalized days.
  - `seo_keyword_distribution` gives weekly position buckets, where a map pack spot counts at its
    pack position.
  - `seo_keyword_summary` now also returns `search_volume` and `cpc`.
  - **Tests:** 28 known-answer checks run the real SQL in PGlite (in-memory Postgres). Parser: 12 more.
- `clients.seo_start_date` and `clients.seo_monthly_fee` are edited in Edit Client. A client save
  retries without them if the columns aren't there yet.
- Scheduled at `0 19 * * *` (`seranking-sync/schedule.sql`) — an hour after `seo-sync`'s
  daily pull, so the admin tab's GSC and SE Ranking numbers for a given day are never a mix
  of one finished run and one partial one.
- `clients.seranking_site_id` and the Test SE Ranking connection button live in Edit
  Client, same section as the other SEO fields.

### The client Organic Search tab (rebuilt 2026-09-14)

`window.renderCpSeo()` in app.js, with markup in `#cp-view-seo` in body.html. It's written for clients who
know little about SEO, and the approved mockup is at claude.ai/code/artifact/b382d28c-a932-4bb5-ab39-71da6d960c65.
Top to bottom:
1. **What SEO did for you:** leads from Google, jobs closed from Google, and visits.
2. **"Since SEO started"** before-and-after.
3. **Visits chart with changelog markers.** It reuses `seoChangelogChartPlugin` and `seoChangelogMarkers`.
4. **Target searches:** a bucket bar plus chips. A map pack spot counts at its pack position.
5. **Work we did / Up next:** the changelog, almost-page-1 searches, and room to grow.
6. **Visibility and authority.**

It reads `seo_client_overview`, `seo_since_start`, `seo_keyword_summary`, `seo_almost_page_one`,
`seo_daily` for the range, and `seo_changelog`, all in parallel and all RLS-scoped.

- **The tab only exists for SEO clients.** `updateSeoTabVisibility()` (called from
  `portalSwitchClient`) hides `#cp-tab-seo` when the client row has neither `gsc_property` nor
  `seranking_site_id`. If RLS hides the row, the tab stays and the empty state covers it. This is
  the hook for service-based onboarding, since connecting SEO turns the tab on.
- **Honesty rules, all in code:**
  - **Noise guard:** under 5 leads or 50 visits, a change reads as "N the period before", never a %.
  - **Return per dollar:** the line appears only when `roi_multiple > 1`. Otherwise it's "SEO builds
    over time", with page-1 count, ranking count and work since start.
  - **Lead dates:** leads before `LEAD_TRACKING_START` (2026-09-11) show as not measured (—), never 0.
  - **Google's lag:** a lag note appears when Search Console's last day is before the range end.
- **Range clamping:** "All time" is clamped to 16 months, Search Console's history.
- **Stale renders:** a render token drops responses from a render that's been superseded (fast
  client or range switching).
- **Theme:** position chips and the bucket bar use the validated ordinal gold ramp for the
  current theme (`cpSeoRamp`).
- **Tests:** 28 checks render the real markup and code in jsdom with a fake client.

### The admin SEO tab (rebuilt 2026-09-11)

`window.renderAdminSeo()` is the first surface reading GSC, SE Ranking and organic leads
together — `seo_daily` for the chart and KPI tiles, `seo_page_summary` / `seo_keyword_summary`
/ `seo_movers` (RPCs in `supabase/sql/seo_admin_rpcs.sql`) for the two tables and "What
Moved", `lead_sources` for the leads tile. **Admin-only, on purpose** — the portal tab
(`renderCpSeo`) still reads the old `seo_metrics` source until this is checked out against
real client data; see the Known gaps entry on that.

- **An "ALL" rollup is refused outright**, not computed. The old tab produced one anyway,
  because `normalize().includes()` happened to let every client's rows through — but
  averaging position across accounts was never meaningful, so `cSelectedAccount === 'ALL'`
  now shows a "select a client" notice instead of a number nobody should read.
- **No client-side caching.** `seo_daily` tops out around 490 rows per client for a full
  16-month history (see the 1000-row cap above), and every RPC already returns a handful of
  rows — refetching on every account or date-range change costs nothing worth a cache, and
  it means there's no invalidation bug to have.
- **Three states inside `#c-view-seo`, never `.innerHTML` swapped wholesale.** ALL-selected
  (`#seo-select-client-notice`), no `gsc_property`/`seranking_site_id` set for this client
  (`#seo-no-data-notice`), and real data (`#seo-data-body`) toggle visibility as siblings.
  An earlier draft overwrote `#seo-client-content.innerHTML` for the no-data case, which
  would have permanently destroyed the KPI/chart/table markup for the rest of the admin's
  session — the next client with real data would have rendered into elements that no
  longer existed. Caught before it shipped.
- **Position is impression-weighted everywhere**, finally matching what Google's own
  Performance report shows for the same range — `seo_daily.position` is already
  Google's per-day weighted figure; combining days needs
  `sum(position*impressions)/sum(impressions)` applied again across days, not
  `avg(position)`. 19 local checks on this and the delta-pill math, including the case that
  would have silently shipped the exact bug being fixed (a flat average of two very
  different single-day positions).
- **`seoDeltaPill(cur, prior, {invert})`** — the one KPI where a *decrease* is the
  improvement is position, so it's the only tile passing `invert: true`. Tested with the
  identical numeric move both ways to confirm the color genuinely flips, not just the
  arrow.
- **The keyword table blends SE Ranking's tracked rank with GSC's own numbers for the same
  phrase** — `seo_keyword_summary` joins `seo_keywords` to the caller's most recent
  in-window `seo_rank_checks` row (best position across every tracked location that day,
  not an average across the window — "where do we stand right now") and to
  `seo_queries_daily` matched by exact keyword text. A keyword with GSC clicks and no SE
  Ranking rank yet means it isn't being checked, or is ranking below SE Ranking's tracked
  depth — both worth seeing rather than left to cross-reference by eye.
- **Organic and Map Pack are separate columns, each with its own change pill.** The first
  version picked the latest day with an *organic* rank only, so a keyword in the map pack
  with no organic listing read "not ranking". For a local contractor that's often the ranking
  that matters most (fixed 2026-09-14). Each window now takes the latest day with either rank.
  Hovering a keyword shows the page SE Ranking found ranking for it. Changing the function's
  return columns needs `drop function` first, which is already in `seo_admin_rpcs.sql`.
- **Almost Page 1 (added 2026-09-14)** is `seo_almost_page_one`, which lists queries whose
  impression-weighted position for the range is above 10 and at most 20. Page 2 gets a small
  fraction of page 1's clicks, so these are the best content targets: Google already finds the
  page relevant. Rows are ordered by impressions, with an impressions floor of
  `max(10, days in range)` passed from app.js, so long ranges don't fill up with one-off
  searches. Each row shows its position change from the previous period and a `tracked`
  badge when SE Ranking already watches it. The data is GSC's query-level rows only, so it
  can't say *which page* ranks for the query. That needs a `[date,page,query]` pull
  `seo-sync` deliberately doesn't do.
- **The dead "AI SEO Specialist Analysis" box is gone** — `triggerAdminSeoAI` never existed,
  so its Run Analysis button always threw. Replaced with "What Moved"
  (`seo_movers`): the top page/query gainers and losers by click delta, gated on
  impressions ≥ 50 in either window so a 3-impression page can't read as a 300% swing —
  same noise guard as the weekly report's ban on narrating small-count swings as trends. No
  model call.
- **SEO Changelog (added 2026-09-14)** is the panel under the chart. Admins log work on the
  day it went live (date, kind, title, optional URL, and notes written for the client), and
  can edit or delete entries. Entries inside the selected range are numbered oldest-first,
  and `seoChangelogChartPlugin` draws the same numbers as dashed lines on the trend chart.
  It's an inline Chart.js plugin rather than `chartjs-plugin-annotation`, because adding a CDN
  script means re-pasting `goldeneye.html` into GHL. `seo_daily` can skip a day, so a marker
  lands on the first plotted day on or after its date, and same-day markers stack. URLs are
  only linked when they're http(s). No SQL was needed, since the table and its admin write
  policy already existed from `seranking-sync/schema.sql`.
- **Articles published on Webflow, Wix, Sanity or a GitHub-based site log themselves (built 2026-09-14).** Setup
  is on the SEO tab: **Auto-log articles**, on the changelog panel.
  `supabase/functions/seo-changelog-webhook/` takes the site's own publish event, not Cuppa's.
  Cuppa only stages a Webflow post, and the changelog records when work went live.
  - **One-time:** `schema.sql`, then `supabase/sql/rename_client.sql` (it now moves
    `seo_webhook_configs`), then deploy. `verify_jwt = false` is in `config.toml`.
  - **Per client, about a minute:** pick Webflow or Wix, click *Save & get link*, and paste the
    link, `...?t=<token>`, into Webflow (Site settings → Webhooks → *Collection Item
    Published*) or a Wix Automation (*Blog post published* → *Send HTTP request*).
  - **`seo_webhook_configs`, one row per client, holds the token** plus platform,
    `blog_path` and `collection_id`. Everything is edited in Golden Eye, so the pasted
    webhook never changes. That matters because Webflow can't edit a webhook, only delete and
    recreate it, which is what made the first version slow.
  - **The token is the credential:** 64 hex characters from two v4 UUIDs, which use a secure
    random source. It's admin-only by RLS, and *Turn off* deletes the row, revoking the link at
    once. A leaked token can only add fake article entries to that one client's changelog.
  - **Blog path:** Webflow's payload has only a slug, so the path is needed to build the URL. The
    panel suggests it from the most common first segment of the client's Search Console pages
    at least two levels deep.
  - **Blog collection:** Webflow sends publishes for every CMS collection. Until one is picked,
    publishes are recorded as `needs_collection` and not logged. The panel groups them by
    collection and shows their titles. Clicking *These are blog posts* saves the collection and
    logs the held posts client-side, the same shape the webhook writes.
  - **How entries are filed:** each article is logged once. `seo_changelog.source_ref`
    (`webflow:<item id>` / `wix:<post id or URL>`) is unique per client and inserts are
    first-write-wins, so a republish never duplicates it. A major update to an old article must
    be logged by hand. A Wix post whose URL isn't on the token's client's domain is refused.
    `live_date` is the publish day in America/Denver.
  - **Wix's body isn't documented,** so the parser finds title, URL, id and date by field name at
    any depth. **Check the first real Wix payload** in `seo_changelog_webhook_events`, where
    every authenticated request is recorded with its outcome and a scrubbed payload. Only admins
    can read it, and it's not in `rename_client.sql` because `client_name` there is
    informational.
  - **Sanity, added 2026-09-14. Midas's own site uses it.** midasmediafirm.com is Eleventy
    (`src/_data/posts.js` fetches, `src/post.njk` renders), with articles in the Sanity project
    **"midas cuppa"** (`n37ohuk0`, dataset `production`, type `post`, 42 posts as of
    2026-09-14). Cuppa writes posts there, and they're served at `/resources/<slug>`. The repo has
    no article files, so the Git option can't see new posts for this site. Setup is a Sanity
    webhook (manage → API → Webhooks) to the client's `?t=` link: trigger **Create**, filter
    `_type == "post"`, projection
    `{_id, title, "slug": coalesce(slug.current, slug), "publishedAt": coalesce(publishedAt, _createdAt)}`.
    Cuppa's posts store `slug` as a plain string, not Sanity's usual `{current}`, and some have
    no `publishedAt`, both checked against the live dataset. `drafts.`/`versions.` ids are
    ignored. `source_ref` is `sanity:<_id>`. The older "midas" project (`30tk2q5k`) is
    disabled. 9 checks.
  - **Git (Jamstack sites), added 2026-09-14:** a GitHub repo webhook (push event,
    application/json) to the same `?t=` link. A new article is a `.md/.mdx/.markdown/.html`
    file **added** under the client's `content_path` in a push to the repo's default branch.
    Edits, code, other branches, drafts (`_file`), READMEs and files added then removed in
    the same push are ignored. The slug is the file name, or the folder name for `index.*`,
    minus a leading `YYYY-MM-DD-`. The URL is domain + `blog_path` + slug, where `/` means
    articles sit at the root. The title comes from the file's frontmatter `title:` (else its
    first `#` heading or HTML `<title>`/`<h1>`), fetched from raw.githubusercontent.com. A
    private repo needs a `GITHUB_TOKEN` secret, and without one the title falls back to the
    file name. `source_ref` is `git:<repo>:<path>`. Author, committer, pusher and sender are
    dropped before a payload is stored. 22 checks.
  - **First-version URLs** (`?k=<SEO_WEBHOOK_SECRET>&source=&site=&path=&collection=`) still
    work, matched to a client by domain. 3Sixty's Webflow webhook uses one.
  - **Tests:** parsing is in dependency-free `parse.ts`. 38 checks (26 on the first version,
    12 on the token path, 22 on Git, 9 on Sanity).
- **Not yet built:** the keyword manager. `seo_keywords` is currently populated only by
  `seranking-sync`'s sync, with no admin-side add/retire form yet, even though its RLS already
  allows admin writes. The changelog isn't in the weekly report or the client portal yet either.

## Weekly check-in

`weekly_checkins`: estimates, closes, revenue, `indirect_leads` (ad-attributed but not
tracked), `source`, `contact_name`.

**Closes and revenue are entered by source (added 2026-09-14)**, in four rows: Google search /
your website, Facebook / Instagram ads, Referral or repeat customer, Other / not sure
(`CHECKIN_SOURCES` in app.js). The split is saved to `closes_by_source jsonb`
(`supabase/sql/weekly_checkins_closes_by_source.sql`) as `{google: {closes, revenue}, ...}`, with
only filled rows present. **`closes_count` / `revenue_total` are still written, as the row sums**,
so every existing reader (reports, leaderboard, health, admin views) is unchanged. A total
stays null when no row has a value, so "not reported" still differs from a reported 0. The
`google` row is what the SEO tab's "Jobs closed from Google" reads. Don't rename the keys.
- **Old check-ins:** editing one saved before sources existed prefills its totals under
  *Other / not sure*, never Google.
- **Text check-ins:** no breakdown (null). The SEO tab counts them as "source not given".
- **Missing column:** if `closes_by_source` isn't in the database, the submit retries without
  it, so a client's totals are never lost to a schema that's behind.
- The check-in history shows "From Google" for weeks with a breakdown. 16 checks. Reporting week is the **completed** Mon–Sun.
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

- **`user_client_access` has rows for only 4 of the ~10+ active clients**, discovered
  while fixing `tasks`' RLS (see Database objects). Per the Access model section, a row
  is supposed to be created automatically when a client is created, and again when a
  `pre_approved_users` invite is applied at sign-in — one or both of those isn't firing
  reliably, or these clients predate whichever one is supposed to do it. Not urgent
  right now, since every RLS policy that matters also falls back to matching
  `clients.client_email` directly — but that fallback is a patch, not a fix, and every
  future client-facing table will need the same fallback bolted on until the real
  auto-grant path is repaired.
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
- **A `client_email` value had 2 bytes of hidden trailing whitespace** (length 23 for a
  21-character address — almost certainly `\r\n`), discovered while testing the `tasks`
  RLS fix below. Only confirmed on that one row, but `client_email` is what several
  legacy RLS policies on `daily_reports`/`weekly_reports` match against via plain string
  equality — if this is a wider data-quality issue rather than a one-off, other clients
  could have been silently losing access through those tables' legacy path too, not
  just the new `tasks` fallback. Worth a sweep: `select name, client_email from clients
  where client_email ~ '\s' or client_email != btrim(client_email);` — none of the
  policies that already existed before this session normalize for it, only the two new
  `tasks` policies documented below do (`regexp_replace(c.client_email, '\s', '', 'g')`)
- Reports are meant to start pulling from the client work summary once revamped — not
  built yet, this is the documented intention only (see Client work summary)
- `architecture.txt` is the original doc and is substantially out of date — it predates
  onboarding, check-ins, reports, triggers, cron and every Make scenario
- **Clients who finished onboarding while `trg_onboarding_handoff` was missing never got
  their "onboarding complete" text.** Found and rebuilt 2026-09-11 (see Database objects).
  The only clients affected were Alta Vista Construction and the `test` client. Decided
  2026-09-11 **not** to send Alta Vista a late text; nothing further to do.
- **SEO phase 1 needs its Google prerequisites before it does anything**: a GCP project with
  the Search Console and Analytics Data APIs enabled, a service account whose JSON key is set
  as the `GOOGLE_SA_JSON` secret, and that service account added as a user on each client's
  property. Until then every client's `last_error` will say so. The Business Profile API also
  needs Google's manual approval — days to weeks — which is why GBP is the last phase and
  nothing else waits on it
- **The client portal no longer reads `seo_metrics`** (Organic Search tab rebuilt 2026-09-14),
  but `initClientPortal()` still fetches it into `allRawSeo`, unused. Remove that query, and
  retire Make scenario #2, once `seo_metrics` and `seo_daily` have been compared over the same dates.
- **The client tab has no AI search or competitor sections yet.** Both need the monthly Data API
  job (plan step 6), and the tab adds them when that data exists.
- `lead_sources` is written but not yet shown in the weekly report. The weekly report
  (phases 4–5) will read it. Until then, check it from the SQL Editor with the queries at the end
  of `ghl-lead-webhook/schema.sql`
- The SEO plan beyond phases 1 and 2 (GA4, keywords + changelog,
  the rebuilt portal tab and report block, baselines and case study, GBP) lives in
  `~/.claude/plans/fluttering-gliding-pebble.md`
