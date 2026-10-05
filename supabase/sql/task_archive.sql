-- Archive tasks instead of deleting them (2026-10-05).
--
-- An archived task keeps its row with archived_at set. Golden Eye keeps those rows out of every
-- board, count, report, the client portal and the stage-advance rule (app.js filters them when it
-- loads), and restores them from Tasks → Archived. Keeping the row matters: task generation dedupes
-- on title against the database, so an archived onboarding or checklist task is not created again,
-- where a deleted one would be.
--
-- Run this, then re-run supabase/sql/auto_check_reconcile.sql (it now skips archived tasks), then
-- deploy client-summary (it leaves archived tasks out of the portal recap). Safe to re-run.

alter table public.tasks
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by text;

create index if not exists tasks_archived_at on public.tasks (archived_at) where archived_at is not null;

notify pgrst, 'reload schema';

-- Archived tasks, newest first:
--   select client, title, status, archived_at, archived_by from tasks where archived_at is not null order by archived_at desc;
