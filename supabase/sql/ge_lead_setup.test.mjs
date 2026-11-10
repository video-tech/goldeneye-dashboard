// Runs supabase/sql/ge_lead_setup.sql twice in PGlite against a minimal schema: setup steps renamed (templates and tasks
// together, with a real long dash), and "Switch to the ge lead setup" raised once for the right clients.
//   PGLITE_DIR=/path/to/dir node supabase/sql/ge_lead_setup.test.mjs
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
await db.exec(`create table clients (name text, status text, current_stage text, base_package text);
create table stage_templates (task_title text, default_notes text);
create table tasks (id serial, client text, title text, type text, stage text, status text, checklist_group text, client_visible bool, notes text, due date, p int, u int, e int, score int, updated_at timestamptz);
insert into clients values ('A','active','Optimizing',null),('B','active','Onboarding',null),('C','active','Campaign Building','no'),('D','paused','Optimizing',null),('E','active','Campaign Building','yes');
insert into stage_templates values ('Golden Eye ${D} Lead tags and the webhook to Golden Eye','x'),('Funnel ${D} Connect the funnel and survey to their workflows','x'),
  ('Funnel ${D} Paste their pixel and token into the Conversions API workflow','x'),('Workflows ${D} Turn on the Conversions API and lead follow-up (survey) workflows','x'),
  ('Funnel ${D} Set the Facebook event to Submit Application or None, never Lead','y');
insert into tasks (client,title,type,stage,status) values ('B','Golden Eye ${D} Lead tags and the webhook to Golden Eye','Setup step','Onboarding','Not Started'),
  ('B','Golden Eye ${D} Lead tags and the webhook to Golden Eye','Checklist','Onboarding','Not Started');`);
const sql = fs.readFileSync(path.join(here, 'ge_lead_setup.sql'), 'utf8');
await db.exec(sql);
await db.exec(sql); // re-runnable
const q = async (s) => (await db.query(s)).rows;

const t = (await q(`select task_title from stage_templates`)).map(r => r.task_title);
ok(t.includes(`Golden Eye ${D} Turn on Lead to Golden Eye and Meta and the standard tags`), 'webhook step renamed, with a real long dash');
ok(t.includes(`Funnel ${D} Build an opt-in workflow for the funnel and one for the survey`) && t.includes(`Funnel ${D} Paste their pixel and token into Lead to Golden Eye and Meta`) && t.some(x => x.startsWith(`Workflows ${D} Turn on Lead to Golden Eye`)), 'the other three steps renamed');
ok(!t.some(x => /Conversions API workflow|Lead tags and the webhook/.test(x)), 'no old title left');
const b = await q(`select title, type from tasks where client='B' order by id`);
ok(b[0].title.includes('Turn on Lead to Golden Eye') && b[1].title.includes('Lead tags and the webhook'), 'existing step tasks renamed, other task types left alone');
const a = await q(`select title, type, checklist_group, stage, client_visible from tasks where client='A' order by id`);
ok(a.length === 12 && a[0].title === 'Switch to the ge lead setup' && a[0].stage === 'Optimizing' && a[0].type === 'Checklist' && a[0].client_visible === false, 'group task raised once, in the client\'s stage, hidden');
ok(a.slice(1).every(r => r.type === 'Setup step' && r.checklist_group === 'Switch to the ge lead setup' && r.client_visible === false), '11 hidden steps under it');
ok(a[1].title === `Switch ${D} Their GHL location ID is saved in Edit Client` && a[11].title.includes('A week later'), 'steps in order');
ok((await q(`select count(*)::int n from tasks where client='E' and title like 'Switch%'`))[0].n === 12, 'Base clients in Campaign Building get it');
ok((await q(`select count(*)::int n from tasks where client in ('B','C','D') and title like 'Switch%'`))[0].n === 0, 'not Onboarding, No Base or paused clients');
ok((await q(`select default_notes from stage_templates where task_title like 'Funnel%Facebook%'`))[0].default_notes.includes('thank-you'), 'Facebook event step mentions the thank-you page');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
