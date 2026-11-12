// Runs supabase/sql/new_optin_prompts.sql twice in PGlite against a minimal schema: the Launch ads step, and reminders raised
// from Meta's change log (once per event, appended while the task is open, no backlog, skipped clients).
//   PGLITE_DIR=/path/to/dir node supabase/sql/new_optin_prompts.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.PGLITE_DIR) { console.log('Set PGLITE_DIR to a folder with @electric-sql/pglite installed.'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(path.join(process.env.PGLITE_DIR, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const D = '—';
const db = new PGlite();
await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create function current_user_is_admin() returns boolean language sql stable as $$ select coalesce(current_setting('test.admin', true), '') = 'on' $$;
    create schema cron; create table cron.job (jobname text, schedule text, command text);
    create function cron.schedule(n text, s text, c text) returns int language sql as $$ insert into cron.job values (n, s, c) returning 1 $$;
    create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
    create table clients (name text, status text, current_stage text, base_package text);
    create table stage_templates (id serial primary key, stage text, task_title text, due_days int, service_keys text[], website_statuses text[], fact_conditions jsonb, default_notes text, checklist_group text, task_type text, sort_order int);
    create table tasks (id bigserial primary key, client text, title text, type text, stage text, status text, checklist_group text, client_visible boolean, notes text, due date, p int, u int, e int, score int, updated_at timestamptz, archived_at timestamptz);
    create table meta_activity (event_key text primary key, client_name text, event_time timestamptz, event_type text, object_id text, object_name text, actor_name text, actor_is_meta boolean);
    insert into clients values ('A','active','Optimizing',null), ('B','active','Onboarding',null), ('C','active','Optimizing','no'), ('D','paused','Optimizing',null), ('E','active','Campaign Building',null);
    insert into stage_templates (stage, task_title, checklist_group, task_type, sort_order) values
      ('Campaign Building','Draft hooks','Launch ads','Setup step',1), ('Campaign Building','Ads ${D} Build the creatives','Launch ads','Setup step',2),
      ('Campaign Building','Ads ${D} Build the ads in Meta','Launch ads','Setup step',3), ('Campaign Building','Ads ${D} Launch','Launch ads','Setup step',4);
    insert into tasks (client, title, stage, status) values ('E','Launch ads','Campaign Building','Not Started'), ('A','Launch ads','Campaign Building','Complete');
    insert into meta_activity values ('old1','A','2026-10-01','create_ad_set','1','Old set','Tenny',false);
`);
const sql = fs.readFileSync(path.join(here, 'new_optin_prompts.sql'), 'utf8');
await db.exec(sql);
await db.exec(sql); // re-runnable
const q = async (s) => (await db.query(s)).rows;

// 1. Launch ads step
const tpl = await q(`select task_title, sort_order from stage_templates order by sort_order`);
ok(tpl.length === 5 && tpl[2].task_title.startsWith(`Opt-in ${D} Using a new form`) && tpl[2].sort_order === 3, 'step added once, at position 3');
ok(tpl[3].task_title.includes('Build the ads in Meta') && tpl[3].sort_order === 4 && tpl[4].sort_order === 5, 'later steps moved down once');
ok((await q(`select count(*)::int n from tasks where title like 'Opt-in%' and client = 'E' and checklist_group = 'Launch ads' and client_visible = false`))[0].n === 1, 'open Launch ads task gets the step once');
ok((await q(`select count(*)::int n from tasks where title like 'Opt-in%' and client = 'A'`))[0].n === 0, 'a finished Launch ads task does not');
ok((await q(`select count(*)::int n from cron.job where jobname = 'meta-optin-checks'`))[0].n === 1, 'scheduled once');

// 2. Reminders
const run = () => q(`select raise_new_meta_optin_checks() n`).then(r => r[0].n);
ok(await run() === 0, 'old events are not raised (no backlog)');
await db.exec(`insert into meta_activity values
    ('e1','A','2026-11-12T16:00:00Z','create_ad_set','11','Spring promo','Tenny',false),
    ('e2','A','2026-11-12T17:00:00Z','create_campaign_group','12','Kitchen leads','Aidan',false),
    ('e3','A','2026-11-12T18:00:00Z','create_ad','13','Ad 1','Tenny',false),
    ('e4','A','2026-11-12T18:00:00Z','create_ad_set','14','By Meta','Meta',true),
    ('e5','B','2026-11-12T18:00:00Z','create_ad_set','15','x','Tenny',false),
    ('e6','C','2026-11-12T18:00:00Z','create_ad_set','16','x','Tenny',false),
    ('e7','D','2026-11-12T18:00:00Z','create_ad_set','17','x','Tenny',false)`);
ok(await run() === 1, 'one client raised');
let t = await q(`select * from tasks where title = 'New in Meta: a new form or funnel?'`);
ok(t.length === 1 && t[0].client === 'A' && t[0].stage === 'Optimizing' && t[0].client_visible === false && t[0].status === 'Not Started', 'one hidden task for the client, in its stage');
ok(/Nov 12: new ad set "Spring promo" \(Tenny\)/.test(t[0].notes) && /new campaign "Kitchen leads" \(Aidan\)/.test(t[0].notes), 'lists what was created and by whom');
ok(!/Ad 1|By Meta/.test(t[0].notes), 'new ads and Meta\'s own changes are left out');
ok(await run() === 0, 'running again raises nothing');
await db.exec(`insert into meta_activity values ('e8','A','2026-11-13T16:00:00Z','create_ad_set','18','Summer','Tenny',false)`);
await run();
t = await q(`select * from tasks where title = 'New in Meta: a new form or funnel?'`);
ok(t.length === 1 && /Summer/.test(t[0].notes) && /Spring promo/.test(t[0].notes), 'while open, later creations are added to the same task');
await db.exec(`update tasks set status = 'Complete' where title = 'New in Meta: a new form or funnel?';
    insert into meta_activity values ('e9','A','2026-11-14T16:00:00Z','create_ad_set','19','Fall','Tenny',false)`);
await run();
ok((await q(`select count(*)::int n from tasks where title = 'New in Meta: a new form or funnel?'`))[0].n === 2, 'after it is done, the next creation raises a new one');

// Who can run it
await db.exec(`set test.uid = '00000000-0000-0000-0000-000000000001'`);
let refused = false; try { await run(); } catch { refused = true; }
ok(refused, 'a signed-in non-admin is refused');
await db.exec(`set test.admin = 'on'`);
ok(await run() === 0, 'an admin can run it');
await db.exec(`reset test.uid; reset test.admin`);
const priv = (role) => q(`select has_function_privilege('${role}', 'raise_new_meta_optin_checks()', 'execute') p`).then(r => r[0].p);
ok(!(await priv('anon')), 'the public key cannot run it');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
