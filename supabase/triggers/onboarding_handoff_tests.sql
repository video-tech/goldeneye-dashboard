-- =============================================================================
-- Tests for onboarding_handoff.sql — run AFTER its Part A, BEFORE its Part B
-- =============================================================================
-- Four tests. Paste and run ONE AT A TIME: each is its own transaction.
--
-- Nothing here can reach anyone:
-- - Every test ends in an error on purpose. The red error box IS the result — it lists the
--   checkpoints — and raising it is what guarantees the rollback: an aborted transaction
--   cannot commit, whatever the editor does afterwards. The trailing rollback is belt and
--   braces.
-- - pg_net queues requests in the same transaction, and its worker only reads committed
--   rows, so a rolled-back POST is never sent. That covers the client text, the admin
--   alert, and the welcome email that inserting a test client queues.
-- - Each test attaches the trigger itself, inside the transaction, so it rolls back too.
--
-- Most tests run as the SQL editor's own role rather than a JWT. The function is SECURITY
-- DEFINER, so the caller's role changes nothing it can read or write. The one role-sensitive
-- step, rename_client(), runs under a real admin's JWT.
--
-- Columns in each result line:
--   steps_done     client steps completed, out of the active non-agency total (11 today)
--   handoff_tasks  tasks titled "Onboarding complete — ready for campaign build"
--   client_texts   requests queued to the scenario #4 hook — THE TEXT
--   admin_alerts   requests queued to the admin-alert hook. 0 is also fine there if no
--                  admin_alert_recipients are enabled; what matters is it never exceeds 1


-- =============================================================================
-- Test 1 — a client finishing through the portal. Expect exactly one text.
-- =============================================================================
begin;

drop trigger if exists trg_onboarding_handoff on client_onboarding_progress;
create trigger trg_onboarding_handoff
after insert or update of completed_at on client_onboarding_progress
for each row when (NEW.completed_at is not null)
execute function raise_onboarding_handoff_task();

create temp table t_log (n serial, checkpoint text, steps_done int, handoff_tasks int,
                         client_texts int, admin_alerts int) on commit drop;
create function pg_temp.snap(label text, who text) returns void language sql as $$
  insert into t_log (checkpoint, steps_done, handoff_tasks, client_texts, admin_alerts)
  select label,
    (select count(*) from onboarding_steps s
       join client_onboarding_progress p on p.step_id = s.id and p.completed_at is not null
        and lower(regexp_replace(p.client_name, '[^a-zA-Z0-9]', '', 'g'))
          = lower(regexp_replace(who, '[^a-zA-Z0-9]', '', 'g'))
      where coalesce(s.active, true) and coalesce(s.owner, 'client') <> 'agency'),
    (select count(*) from tasks t
      where lower(regexp_replace(coalesce(t.client, ''), '[^a-zA-Z0-9]', '', 'g'))
          = lower(regexp_replace(who, '[^a-zA-Z0-9]', '', 'g'))
        and lower(btrim(t.title)) = lower('Onboarding complete — ready for campaign build')),
    (select count(*) from net.http_request_queue where url like '%hucrpp6hm43ps165n7wxut8v9rn3dksu%'),
    (select count(*) from net.http_request_queue where url like '%c8l92w09rw5jrncifjxif0b8r1yf89ha%');
$$;

insert into clients (name, client_email, current_stage, status)
values ('ZZ Handoff Test', 'zz-handoff-test@example.invalid', 'Onboarding', 'active');
select pg_temp.snap('1 new client, nothing done', 'ZZ Handoff Test');

-- Every client step done but the last, a video 40% watched: its row exists with
-- completed_at null, exactly as saveOnboardingProgress() leaves it
with s as (
    select id, row_number() over (order by sort_order, id) as rn, count(*) over () as total
    from onboarding_steps
    where coalesce(active, true) and coalesce(owner, 'client') <> 'agency'
)
insert into client_onboarding_progress (client_name, step_id, completed_at, completed_by, watch_percent)
select 'ZZ Handoff Test', id, case when rn < total then now() end,
       'zz-handoff-test@example.invalid', case when rn < total then 100 else 40 end
from s;
select pg_temp.snap('2 all but one done, last 40% watched', 'ZZ Handoff Test');

-- The last step completed the way PostgREST runs the portal's upsert: an insert that
-- conflicts and becomes an UPDATE setting completed_at
insert into client_onboarding_progress (client_name, step_id, completed_at, completed_by, watch_percent)
select client_name, step_id, now(), completed_by, 100
from client_onboarding_progress
where client_name = 'ZZ Handoff Test' and completed_at is null
on conflict (client_name, step_id) do update
set completed_at = excluded.completed_at, completed_by = excluded.completed_by,
    watch_percent = excluded.watch_percent;
select pg_temp.snap('3 last step completed via upsert', 'ZZ Handoff Test');

-- Make re-sending completions for steps already done
update client_onboarding_progress set completed_at = now() where client_name = 'ZZ Handoff Test';
select pg_temp.snap('4 completed_at re-sent on every step', 'ZZ Handoff Test');

-- Expect:  1 → 0 / 0 / 0 / 0     2 → 10 / 0 / 0 / 0
--          3 → 11 / 1 / 1 / ≤1   4 → 11 / 1 / 1 / ≤1
do $$ begin raise exception E'TEST 1 RESULTS (rolled back)\n%', (select string_agg(format('%s | steps_done=%s handoff_tasks=%s client_texts=%s admin_alerts=%s', checkpoint, steps_done, handoff_tasks, client_texts, admin_alerts), E'\n' order by n) from t_log); end $$;
rollback;


-- =============================================================================
-- Test 2 — rename_client() must not re-text a finished client. Expect no second text.
-- Needs the updated rename_client (end of seo-sync/schema.sql), which moves progress rows.
-- =============================================================================
begin;

drop trigger if exists trg_onboarding_handoff on client_onboarding_progress;
create trigger trg_onboarding_handoff
after insert or update of completed_at on client_onboarding_progress
for each row when (NEW.completed_at is not null)
execute function raise_onboarding_handoff_task();

create temp table t_log (n serial, checkpoint text, steps_done int, handoff_tasks int,
                         client_texts int, admin_alerts int) on commit drop;
create function pg_temp.snap(label text, who text) returns void language sql as $$
  insert into t_log (checkpoint, steps_done, handoff_tasks, client_texts, admin_alerts)
  select label,
    (select count(*) from onboarding_steps s
       join client_onboarding_progress p on p.step_id = s.id and p.completed_at is not null
        and lower(regexp_replace(p.client_name, '[^a-zA-Z0-9]', '', 'g'))
          = lower(regexp_replace(who, '[^a-zA-Z0-9]', '', 'g'))
      where coalesce(s.active, true) and coalesce(s.owner, 'client') <> 'agency'),
    (select count(*) from tasks t
      where lower(regexp_replace(coalesce(t.client, ''), '[^a-zA-Z0-9]', '', 'g'))
          = lower(regexp_replace(who, '[^a-zA-Z0-9]', '', 'g'))
        and lower(btrim(t.title)) = lower('Onboarding complete — ready for campaign build')),
    (select count(*) from net.http_request_queue where url like '%hucrpp6hm43ps165n7wxut8v9rn3dksu%'),
    (select count(*) from net.http_request_queue where url like '%c8l92w09rw5jrncifjxif0b8r1yf89ha%');
$$;

insert into clients (name, client_email, current_stage, status)
values ('ZZ Rename Test', 'zz-rename-test@example.invalid', 'Onboarding', 'active');

-- Every step in one statement, as a Make upsert of several rows would. Row triggers fire
-- after the statement, so all eleven see a finished client; only the first may act.
insert into client_onboarding_progress (client_name, step_id, completed_at, completed_by)
select 'ZZ Rename Test', id, now(), 'zz-rename-test@example.invalid'
from onboarding_steps
where coalesce(active, true) and coalesce(owner, 'client') <> 'agency';
select pg_temp.snap('1 every step done in one statement', 'ZZ Rename Test');

-- Take the handoff task away, so the "already announced" check can't be the thing that
-- stops a text below. Only the trigger's UPDATE OF / not-done-to-done guard is left.
delete from tasks where client = 'ZZ Rename Test'
  and title = 'Onboarding complete — ready for campaign build';
select pg_temp.snap('2 handoff task deleted', 'ZZ Rename Test');

select set_config('request.jwt.claims',
                  json_build_object('sub', id, 'email', email, 'role', 'authenticated')::text, true)
from auth.users where email = 'video@midasmediafirm.com';
set local role authenticated;
select rename_client('ZZ Rename Test', 'ZZ Rename Test Moved');
reset role;
select pg_temp.snap('3 after rename — new name', 'ZZ Rename Test Moved');
select pg_temp.snap('4 after rename — old name', 'ZZ Rename Test');

-- Expect:  1 → 11 / 1 / 1 / ≤1   2 → 11 / 0 / 1 / ≤1
--          3 → 11 / 0 / 1 / ≤1   (progress moved, no new task, no second text)
--          4 → 0 / 0 / 1 / ≤1    (nothing left behind under the old name)
do $$ begin raise exception E'TEST 2 RESULTS (rolled back)\n%', (select string_agg(format('%s | steps_done=%s handoff_tasks=%s client_texts=%s admin_alerts=%s', checkpoint, steps_done, handoff_tasks, client_texts, admin_alerts), E'\n' order by n) from t_log); end $$;
rollback;


-- =============================================================================
-- Test 3 — a client long past onboarding finishing the two newer steps. Expect nothing.
-- SimpliBlinds: Optimizing, active, 9 of 11, backfilled, and no handoff task.
-- =============================================================================
begin;

drop trigger if exists trg_onboarding_handoff on client_onboarding_progress;
create trigger trg_onboarding_handoff
after insert or update of completed_at on client_onboarding_progress
for each row when (NEW.completed_at is not null)
execute function raise_onboarding_handoff_task();

create temp table t_log (n serial, checkpoint text, steps_done int, handoff_tasks int,
                         client_texts int, admin_alerts int) on commit drop;
create function pg_temp.snap(label text, who text) returns void language sql as $$
  insert into t_log (checkpoint, steps_done, handoff_tasks, client_texts, admin_alerts)
  select label,
    (select count(*) from onboarding_steps s
       join client_onboarding_progress p on p.step_id = s.id and p.completed_at is not null
        and lower(regexp_replace(p.client_name, '[^a-zA-Z0-9]', '', 'g'))
          = lower(regexp_replace(who, '[^a-zA-Z0-9]', '', 'g'))
      where coalesce(s.active, true) and coalesce(s.owner, 'client') <> 'agency'),
    (select count(*) from tasks t
      where lower(regexp_replace(coalesce(t.client, ''), '[^a-zA-Z0-9]', '', 'g'))
          = lower(regexp_replace(who, '[^a-zA-Z0-9]', '', 'g'))
        and lower(btrim(t.title)) = lower('Onboarding complete — ready for campaign build')),
    (select count(*) from net.http_request_queue where url like '%hucrpp6hm43ps165n7wxut8v9rn3dksu%'),
    (select count(*) from net.http_request_queue where url like '%c8l92w09rw5jrncifjxif0b8r1yf89ha%');
$$;

select pg_temp.snap('1 before', 'SimpliBlinds');

insert into client_onboarding_progress (client_name, step_id, completed_at, completed_by)
select 'SimpliBlinds', s.id, now(), 'zz-trigger-test'
from onboarding_steps s
where coalesce(s.active, true) and coalesce(s.owner, 'client') <> 'agency'
  and not exists (
      select 1 from client_onboarding_progress p
      where p.step_id = s.id and p.completed_at is not null
        and lower(regexp_replace(p.client_name, '[^a-zA-Z0-9]', '', 'g')) = 'simpliblinds')
on conflict (client_name, step_id) do update
set completed_at = excluded.completed_at, completed_by = excluded.completed_by;
select pg_temp.snap('2 remaining steps completed', 'SimpliBlinds');

-- Expect:  1 → 9 / 0 / n / n     2 → 11 / 0 / same n / same n
-- steps_done reaching 11 is what shows the set really was completed — without the stage
-- gate, this is where the old function would have filed the task and texted them.
do $$ begin raise exception E'TEST 3 RESULTS (rolled back)\n%', (select string_agg(format('%s | steps_done=%s handoff_tasks=%s client_texts=%s admin_alerts=%s', checkpoint, steps_done, handoff_tasks, client_texts, admin_alerts), E'\n' order by n) from t_log); end $$;
rollback;


-- =============================================================================
-- Test 4 — an admin backfilling a client's steps. Expect nothing.
-- =============================================================================
begin;

drop trigger if exists trg_onboarding_handoff on client_onboarding_progress;
create trigger trg_onboarding_handoff
after insert or update of completed_at on client_onboarding_progress
for each row when (NEW.completed_at is not null)
execute function raise_onboarding_handoff_task();

create temp table t_log (n serial, checkpoint text, steps_done int, handoff_tasks int,
                         client_texts int, admin_alerts int) on commit drop;
create function pg_temp.snap(label text, who text) returns void language sql as $$
  insert into t_log (checkpoint, steps_done, handoff_tasks, client_texts, admin_alerts)
  select label,
    (select count(*) from onboarding_steps s
       join client_onboarding_progress p on p.step_id = s.id and p.completed_at is not null
        and lower(regexp_replace(p.client_name, '[^a-zA-Z0-9]', '', 'g'))
          = lower(regexp_replace(who, '[^a-zA-Z0-9]', '', 'g'))
      where coalesce(s.active, true) and coalesce(s.owner, 'client') <> 'agency'),
    (select count(*) from tasks t
      where lower(regexp_replace(coalesce(t.client, ''), '[^a-zA-Z0-9]', '', 'g'))
          = lower(regexp_replace(who, '[^a-zA-Z0-9]', '', 'g'))
        and lower(btrim(t.title)) = lower('Onboarding complete — ready for campaign build')),
    (select count(*) from net.http_request_queue where url like '%hucrpp6hm43ps165n7wxut8v9rn3dksu%'),
    (select count(*) from net.http_request_queue where url like '%c8l92w09rw5jrncifjxif0b8r1yf89ha%');
$$;

insert into clients (name, client_email, current_stage, status)
values ('ZZ Backfill Test', 'zz-backfill-test@example.invalid', 'Onboarding', 'active');

-- Exactly what markOnboardingComplete() writes
insert into client_onboarding_progress (client_name, step_id, completed_at, completed_by)
select 'ZZ Backfill Test', id, now(), 'backfilled'
from onboarding_steps
where coalesce(active, true) and coalesce(owner, 'client') <> 'agency';
select pg_temp.snap('1 every step backfilled', 'ZZ Backfill Test');

-- Expect:  1 → 11 / 0 / 0 / 0
do $$ begin raise exception E'TEST 4 RESULTS (rolled back)\n%', (select string_agg(format('%s | steps_done=%s handoff_tasks=%s client_texts=%s admin_alerts=%s', checkpoint, steps_done, handoff_tasks, client_texts, admin_alerts), E'\n' order by n) from t_log); end $$;
rollback;
