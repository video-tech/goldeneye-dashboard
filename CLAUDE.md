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
- `user_has_client_access()`, `current_user_is_admin()` — SECURITY DEFINER helpers used by
  RLS policies.
- `admin_alert_recipients` — who gets texted, toggleable in Settings → Notifications.

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

## Known gaps

- Admin alert Make scenario unfinished
- Reminder "goes quiet once submitted" never verified
- `client_contacts` mostly empty, so reminders reach almost nobody yet
- ~20 display-only spots still use `escapeHTML` (stray backslash on apostrophes)
- Embed URL isn't validated — pasting a whole `<iframe>` snippet shows clients a
  Cloudflare error
- Deleting an onboarding step that has progress rows assumes the FK cascades; untested
- Pipeline tab hidden pending a rebuild
- `architecture.txt` is the original doc and is substantially out of date — it predates
  onboarding, check-ins, reports, triggers, cron and every Make scenario
