// Tests for show_setup_tasks_to_clients.sql: runs v1, v2, v3, the A2P step and this file (twice) in PGlite.
// Run: PGLITE_DIR=<folder with node_modules/@electric-sql/pglite 0.2.x> node supabase/sql/show_setup_tasks_to_clients.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { PGlite } = await import(pathToFileURL(path.join(process.env.PGLITE_DIR, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href);
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const db = new PGlite();
const q = async (t) => (await db.query(t)).rows;
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8');

await db.exec(`
    create table public.onboarding_steps (
        id uuid primary key default gen_random_uuid(), title text not null, description text, step_type text not null default 'action',
        sort_order int default 0, active boolean default true, owner text not null default 'client', assignee text, due_days int default 0,
        service_keys text[] not null default '{}', website_statuses text[] not null default '{}', auto_check text, questions jsonb,
        fact_conditions jsonb not null default '{}'::jsonb);
    create table public.stage_templates (
        id uuid primary key default gen_random_uuid(), stage text, task_title text, priority int, urgency int, effort int, default_notes text,
        assignee text, due_days int, checklist_group text, task_type text, sort_order int, service_keys text[] not null default '{}',
        website_statuses text[] not null default '{}', auto_check text, fact_conditions jsonb not null default '{}'::jsonb);
    create table public.tasks (id serial primary key, client text, title text, type text, stage text, status text, checklist_group text,
        client_visible boolean default true, notes text, due date, p int, u int, e int, score int, updated_at timestamptz, archived_at timestamptz);
    insert into onboarding_steps (title, owner, sort_order, service_keys, auto_check) values
        ('Add their Meta ad account ID to Golden Eye', 'agency', 13, '{ads}', null), ('Set up GHL sub-account & assets', 'agency', 14, '{}', null),
        ('Build and launch ads', 'agency', 15, '{ads}', null),
        ('Connect Search Console', 'agency', 18, '{seo}', 'gsc_connected'), ('Create the SE Ranking project', 'agency', 19, '{seo}', 'seranking_connected'),
        ('Save SEO start date and fee', 'agency', 20, '{seo}', 'seo_settings_set'), ('Set up article auto-logging', 'agency', 21, '{seo}', 'autolog_configured'),
        ('Set up Cuppa', 'agency', 22, '{seo}', 'first_article_logged'), ('Set up lead tracking', 'agency', 23, '{seo}', 'lead_tracking_live'),
        ('Keyword research and page plan', 'agency', 24, '{seo}', null);
    insert into stage_templates (stage, task_title, task_type, sort_order, service_keys) values ('Campaign Building', 'Draft Copywriting Hooks V1', 'Checklist', 1, '{ads}');
`);
await db.exec(read('setup_checklist.sql'));
await db.exec(read('setup_checklist_v2.sql'));
await db.exec(read('setup_checklist_v3.sql'));
await db.exec(read('setup_checklist_a2p_profile.sql'));
// A client part-way through, with tasks raised under the old names (group tasks hidden, as app.js used to raise them)
await db.exec(`
    insert into tasks (client, title, type, stage, status, checklist_group, client_visible) values
        ('Acme', 'Register their texting number', 'Checklist', 'Onboarding', 'In Progress', null, false),
        ('Acme', 'A2P — Buy a local number', 'Setup step', 'Onboarding', 'Complete', 'Register their texting number', false),
        ('Acme', 'Set up Cuppa', 'Checklist', 'Onboarding', 'Not Started', null, false),
        ('Acme', 'Cuppa — Connect it to their site', 'Setup step', 'Onboarding', 'Not Started', 'Set up Cuppa', false),
        ('Acme', 'Launch ads', 'Checklist', 'Campaign Building', 'Not Started', null, false),
        ('Acme', 'Call the owner', 'One-off', 'Onboarding', 'Not Started', null, false);
`);
const sql = read('show_setup_tasks_to_clients.sql');
await db.exec(sql);
await db.exec(sql); // re-runnable

const agency = Object.fromEntries((await q(`select title, active, description from onboarding_steps where owner = 'agency' and active`)).map((r) => [r.title, r]));
const want = ['Connect Meta', 'Set up your CRM', 'Register your texting number', 'Build your website', 'Build the funnel and survey',
    'Turn on your automations and add your team', 'Final check and test', 'Set up SEO tracking', 'Set up your blog articles'];
ok(want.every((t) => agency[t]) && Object.keys(agency).length === want.length, 'the nine tasks carry the client-friendly names: ' + Object.keys(agency).join(' | '));
ok(Object.values(agency).every((a) => /^We /.test(a.description)), 'every task description is written for the client');
ok(!Object.values(agency).some((a) => /checklist|meta-sync|Conversions API|their /i.test(a.description)), 'no internal wording in the descriptions');

const groups = (await q(`select distinct checklist_group g from stage_templates where task_type = 'Setup step'`)).map((r) => r.g).sort();
ok(groups.join('|') === [...want, 'Launch ads'].sort().join('|'), 'every step points at its renamed task: ' + groups.join(' | '));
ok((await q(`select count(*)::int n from stage_templates where checklist_group in ('Connect their GHL to Golden Eye','Set up Cuppa','Register their texting number')`))[0].n === 0, 'no step is left under an old name');
ok((await q(`select default_notes n from stage_templates where task_title = 'Launch ads' and task_type = 'Checklist'`))[0].n.startsWith('We build your ads'), 'Launch ads reads well to the client');

const t = Object.fromEntries((await q(`select title, type, checklist_group, client_visible from tasks`)).map((r) => [r.title, r]));
ok(t['Register your texting number']?.client_visible === true && t['Set up your blog articles']?.client_visible === true && t['Launch ads'].client_visible === true,
    'raised tasks are renamed and shown to the client');
ok(t['A2P — Buy a local number'].client_visible === false && t['A2P — Buy a local number'].checklist_group === 'Register your texting number'
    && t['Cuppa — Connect it to their site'].checklist_group === 'Set up your blog articles', 'their steps stay hidden and follow the new name');
ok(t['Call the owner'].client_visible === false, 'unrelated hidden tasks stay hidden');
ok((await q(`select count(*)::int n from onboarding_steps where title = 'Set up Cuppa' and active`))[0].n === 0
    && (await q(`select count(*)::int n from onboarding_steps where title = 'Set up your blog articles'`))[0].n === 1, 'one blog-articles task, no live Set up Cuppa left');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
