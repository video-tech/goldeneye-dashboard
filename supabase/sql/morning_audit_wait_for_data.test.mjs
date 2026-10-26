// Runs supabase/sql/morning_audit_wait_for_data.sql in PGlite (in-memory Postgres), twice, and checks the view the
// second ads pull reads, who may read it, the 10 o'clock Mountain guard on the pull-missing text in both seasons,
// and the two schedules. PGlite 0.2.x; point PGLITE_DIR at the folder holding node_modules:
//   PGLITE_DIR=/path/to/dir node supabase/sql/morning_audit_wait_for_data.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.PGLITE_DIR) { console.log('Set PGLITE_DIR to a folder with @electric-sql/pglite 0.2.x installed.'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(path.join(process.env.PGLITE_DIR, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
const sql = fs.readFileSync(path.join(here, 'morning_audit_wait_for_data.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const db = new PGlite();
await db.exec(`create role authenticated; create role anon; create role service_role;
create schema cron;
create table cron.job (jobid serial primary key, jobname text, schedule text, command text);
insert into cron.job (jobname, schedule, command) values ('morning-audit', '5 17 * * 1-5', 'select net.http_post(''audit'')'), ('daily-pull-check', '0 17 * * *', 'select public.daily_pull_check()'),
  ('meta-sync-daily', '30 15 * * *', 'select net.http_post(url := ''meta-sync'', headers := jsonb_build_object(''Authorization'', ''Bearer KEY''), body    := ''{}''::jsonb)');
create function cron.schedule(name text, sched text, cmd text) returns int language sql as $$ insert into cron.job (jobname, schedule, command) values (name, sched, cmd) returning jobid $$;
create function cron.unschedule(id int) returns boolean language sql as $$ delete from cron.job where jobid = id returning true $$;
create function cron.alter_job(job_id int, schedule text default null, command text default null) returns void language sql as $$
  update cron.job set schedule = coalesce(alter_job.schedule, cron.job.schedule), command = coalesce(alter_job.command, cron.job.command) where jobid = job_id $$;
create table public.clients (name text, status text, ad_account_id text, business_id text, client_email text);
create table public.daily_reports (ad_account_id text, date date, spend numeric);
create function public.daily_pull_check() returns jsonb language sql as $$ select '{"checked": true}'::jsonb $$;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase's default: every new table and view in public is granted to the API roles. The SQL must revoke it.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated;`);
await db.exec(sql); await db.exec(sql);
ok(true, 'runs twice');

const Y = `((now() at time zone 'America/Denver')::date - 1)`;
await db.exec(`insert into clients values
  ('Has yesterday', 'active', 'act_111', 'b', 'a@x.com'),
  ('Missing', 'active', '222', 'b', 'b@x.com'),
  ('Only older', null, '333', 'b', null),
  ('Paused', 'paused', '444', 'b', null),
  ('Archived', 'archived', '555', 'b', null),
  ('No business', 'active', '666', ' ', null),
  ('No account', 'active', '', 'b', null);
insert into daily_reports values ('111', ${Y}, 10), ('333', ${Y} - 1, 10), ('act_222', ${Y} - 3, 5);`);
const names = (await db.query('select name from ads_pull_missing order by name')).rows.map((r) => r.name);
ok(names.join() === 'Missing,Only older', 'the view lists only pullable clients without yesterday\'s row: ' + names.join());
const cols = (await db.query(`select column_name from information_schema.columns where table_name = 'ads_pull_missing' order by ordinal_position`)).rows.map((r) => r.column_name);
ok(['name', 'ad_account_id', 'business_id', 'client_email'].every((c) => cols.includes(c)), 'the columns Make maps are all there: ' + cols.join());
await db.exec(`insert into daily_reports values ('222', ${Y}, 7)`);
ok((await db.query('select name from ads_pull_missing')).rows.map((r) => r.name).join() === 'Only older', 'a row arriving (account matched by digits) takes a client off the list');

for (const role of ['anon', 'authenticated']) {
    let refused = false;
    try { await db.exec(`set role ${role}; select * from ads_pull_missing;`); } catch { refused = true; }
    await db.exec('reset role');
    ok(refused, `${role} cannot read the view (it skips the tables' RLS)`);
}
await db.exec('set role service_role');
ok((await db.query('select count(*)::int n from ads_pull_missing')).rows[0].n === 1, 'service_role (Make) can read it');
await db.exec('reset role');

const at = async (ts) => (await db.query('select public.daily_pull_check_scheduled($1::timestamptz) r', [ts])).rows[0].r;
ok((await at('2026-10-23T16:05:00Z')).checked === true, 'October 16:05 UTC is 10:05 Mountain: the check runs');
ok(/only runs at 10/.test((await at('2026-10-23T17:05:00Z')).skipped || ''), 'October 17:05 UTC is 11:05 Mountain: skipped');
ok((await at('2026-11-05T17:05:00Z')).checked === true, 'November 17:05 UTC is 10:05 Mountain: the check runs');
ok(/only runs at 10/.test((await at('2026-11-05T16:05:00Z')).skipped || ''), 'November 16:05 UTC is 9:05 Mountain: skipped');
for (const role of ['anon', 'authenticated']) {
    let refused = false;
    try { await db.exec(`set role ${role}; select public.daily_pull_check_scheduled();`); } catch { refused = true; }
    await db.exec('reset role');
    ok(refused, `${role} cannot run the pull-check wrapper`);
}

const jobs = Object.fromEntries((await db.query('select jobname, schedule, command from cron.job')).rows.map((r) => [r.jobname, r]));
ok(jobs['morning-audit'].schedule === '*/15 15-17 * * 1-5' && jobs['morning-audit'].command.includes('audit'), 'the audit is called every 15 minutes 15:00-17:45 UTC on weekdays, command kept');
ok(jobs['daily-pull-check'].schedule === '5 16,17 * * *' && jobs['daily-pull-check'].command === 'select public.daily_pull_check_scheduled()', 'the pull check runs at 16:05 and 17:05 UTC through the guard');

ok(jobs['meta-sync-daily'].schedule === '30 14 * * *' && jobs['meta-sync-daily'].command.includes("'{}'::jsonb"), 'the full meta-sync moves to 14:30 UTC, command kept');
ok(jobs['meta-sync-fill']?.schedule === '*/15 15-17 * * 1-5', 'meta-sync-fill every 15 minutes, 15:00-17:45 UTC on weekdays');
ok(jobs['meta-sync-fill']?.command.includes(`'{"mode":"fill"}'::jsonb`) && jobs['meta-sync-fill'].command.includes('Bearer KEY') && !jobs['meta-sync-fill'].command.includes("'{}'::jsonb"), 'the fill job is the daily job command with the fill body');
ok((await db.query("select count(*)::int n from cron.job where jobname = 'meta-sync-fill'")).rows[0].n === 1, 'running the file twice leaves one fill job');
await db.exec("delete from cron.job where jobname = 'meta-sync-daily'");
let refusedNoDaily = false; try { await db.exec(sql); } catch (e) { refusedNoDaily = /schedule meta-sync first/.test(e.message); }
ok(refusedNoDaily, 'without meta-sync scheduled, the file stops and says so');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
