// Runs supabase/sql/quick_start_facebook_ads_only.sql in PGlite against the live Quick start step (read 2026-10-20), twice.
//   PGLITE_DIR=/path/to/dir node supabase/sql/quick_start_facebook_ads_only.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.PGLITE_DIR) { console.log('Set PGLITE_DIR to a folder with @electric-sql/pglite 0.2.x installed.'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(path.join(process.env.PGLITE_DIR, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href);
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const QS = [
    { id: 'q_fb_page', fact: 'facebook_page', type: 'choice', label: 'Do you have a Facebook business page?', options: ['Yes', 'No (I need one)', 'Not sure'], required: true, fact_values: ['yes', 'no', 'unsure'], website_statuses: [] },
    { id: 'q_fb_url', dest: 'custom_value:facebook_url', type: 'link', label: 'Paste the link to your Facebook page', options: [], show_if: { q: 'q_fb_page', any: ['Yes'] }, required: false, website_statuses: [] },
    { id: 'q_crm', fact: 'crm_choice', type: 'choice', label: 'Do you have a CRM you want your leads sent to?', options: ['No, use the default setup', 'Yes, I already have a CRM I want to keep'], required: true, fact_values: ['no', 'yes'], website_statuses: [] },
    { id: 'q_crm_name', fact: 'crm_name', type: 'choice', label: 'Which CRM?', options: ['HubSpot', 'Other'], show_if: { q: 'q_crm', any: ['Yes, I already have a CRM I want to keep'] }, required: true, website_statuses: [] },
];
const db = new PGlite();
await db.exec(`create table onboarding_steps (id serial primary key, title text, step_type text, questions jsonb);`);
await db.query(`insert into onboarding_steps (title, step_type, questions) values ('Quick start: your Facebook page and CRM', 'questions', $1), ('About your business', 'questions', $2)`,
    [JSON.stringify(QS), JSON.stringify([{ id: 'q_fb_page', label: 'same id, other step' }])]);
const sql = fs.readFileSync(path.join(here, 'quick_start_facebook_ads_only.sql'), 'utf8');
await db.exec(sql);
const after = (await db.query(`select questions from onboarding_steps where title like 'Quick start%'`)).rows[0].questions;
ok(after.map((q) => q.id).join() === QS.map((q) => q.id).join(), 'question order kept');
ok(after.filter((q) => JSON.stringify(q.service_keys) === '["ads"]').map((q) => q.id).join() === 'q_fb_page,q_fb_url', 'exactly the two Facebook questions are tagged Ads');
ok(JSON.stringify(after.map(({ service_keys, ...q }) => q)) === JSON.stringify(QS), 'nothing else about any question changed');
const other = (await db.query(`select questions from onboarding_steps where title = 'About your business'`)).rows[0].questions;
ok(!('service_keys' in other[0]), 'another step with the same question id is untouched');
await db.exec(sql);
ok(JSON.stringify((await db.query(`select questions from onboarding_steps where title like 'Quick start%'`)).rows[0].questions) === JSON.stringify(after), 're-running changes nothing');
await db.exec(`update onboarding_steps set title = 'Renamed' where title like 'Quick start%'`);
let refused = false; try { await db.exec(sql); } catch (e) { refused = /Expected to tag 2/.test(e.message); }
ok(refused, 'if the step has been renamed, it says so instead of quietly doing nothing');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
