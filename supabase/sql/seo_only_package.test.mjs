// Runs supabase/sql/seo_only_package.sql in PGlite (in-memory Postgres) on top of the real service_onboarding.sql,
// onboarding_facts.sql and onboarding_client_facts_fix.sql, with the live steps' tags (read 2026-10-20), and checks:
//   - Base + SEO (the default) gets exactly the steps it got before the file ran;
//   - SEO only gets no GHL, texting or free-website step, and gets "Your service area" instead;
//   - a client can't switch themselves to SEO only; the column refuses anything but yes/no; re-running changes nothing.
// Needs PGlite 0.2.x; point PGLITE_DIR at the folder holding node_modules:
//   PGLITE_DIR=/path/to/dir node supabase/sql/seo_only_package.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pgliteDir = process.env.PGLITE_DIR;
if (!pgliteDir) { console.log('Set PGLITE_DIR to a folder with @electric-sql/pglite 0.2.x installed.'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(path.join(pgliteDir, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href);
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const db = new PGlite();
await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.role() returns text language sql stable as $$ select coalesce(current_setting('test.role', true), '') $$;
    create function auth.email() returns text language sql stable as $$ select nullif(current_setting('test.email', true), '') $$;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create function current_user_is_admin() returns boolean language sql stable as $$ select coalesce(current_setting('test.admin', true), '') = 'true' $$;
    create function client_row_visible(p text) returns boolean language sql stable as $$
        select current_user_is_admin() or p = any (string_to_array(coalesce(current_setting('test.visible', true), ''), ',')) $$;
    create table clients (id serial primary key, name text, status text default 'active', current_stage text default 'Onboarding',
        gsc_property text, seranking_site_id bigint, ad_account_id text, ghl_location_id text, seo_start_date date,
        seo_monthly_fee numeric, ga4_property_id text, created_at timestamptz default now());
    create table onboarding_steps (id uuid primary key default gen_random_uuid(), title text not null, description text,
        step_type text not null default 'action', embed_url text, linked_task_title text, sort_order integer default 0,
        active boolean default true, created_at timestamptz default now(), owner text not null default 'client',
        assignee text, due_days integer default 0, notes text, questions jsonb);
    create table stage_templates (id serial primary key, stage text, task_title text, task_type text, sort_order integer,
        assignee text, due_days integer, default_notes text, priority int, urgency int, effort int, checklist_group text);
    create table client_onboarding_progress (id serial primary key, client_name text, step_id uuid, completed_at timestamptz,
        completed_by text);
    create table tasks (id serial primary key, client text, title text, status text, stage text, type text);
`);
// The earlier files create functions over tables this test doesn't need (auto-checks read daily_reports, the SEO
// tables...); only the onboarding functions are called, so their bodies are checked when they run, not when created.
await db.exec(`set check_function_bodies = off`);
await db.exec(read('service_onboarding.sql'));
await db.exec(read('onboarding_facts.sql'));
await db.exec(read('onboarding_client_facts_fix.sql'));
await db.exec(`set check_function_bodies = on`);

// The live steps, as tagged on 2026-10-20 (active only), replacing the seeds the files above inserted
const QUESTIONS = JSON.stringify([
    { id: 'c_text_ok', dest: 'custom_value:text_window', type: 'choice', label: 'We text new leads between 8am and 8pm, weekends included. Is that OK?', options: ['Yes', 'No (I would like different hours)'], required: true, website_statuses: [] },
    { id: 'c_text_hours', dest: 'custom_value:text_window', type: 'short', label: 'What hours should we text your leads?', options: [], show_if: { q: 'c_text_ok', any: ['No (I would like different hours)'] }, required: true, website_statuses: [] },
    { id: 'c_area', dest: 'custom_value:service_area', type: 'short', label: 'Main cities you serve', options: [], required: true, website_statuses: [] },
    { id: 'c_radius', dest: 'custom_value:service_radius', type: 'short', label: 'How far will you travel for a job?', options: [], required: true, website_statuses: [] },
    { id: 'c_exclude', dest: 'custom_value:excluded_areas', type: 'long', label: 'Areas you will not serve (optional)', options: [], required: false, website_statuses: [] },
]);
const STEPS = [
    // title, owner, type, services, websites, facts
    ['Welcome — how your dashboard works', 'client', 'video', [], [], {}],
    ['Quick start: your Facebook page and CRM', 'client', 'questions', [], [], {}],
    ['Book your setup call', 'client', 'form', [], [], {}],
    ['About your business', 'client', 'questions', [], [], {}],
    ['Registering your texting number', 'client', 'questions', [], [], {}],
    ['Texting and your service area', 'client', 'questions', [], [], {}],
    ['Your jobs and offers', 'client', 'questions', ['ads'], [], {}],
    ['Your new website', 'client', 'questions', [], ['new_build'], {}],
    ['Give us access to your Facebook', 'client', 'video', ['ads'], [], { facebook_page: ['yes'] }],
    ['Sales team (names & numbers)', 'client', 'team', [], [], {}],
    ['Connect Meta', 'agency', 'action', ['ads'], [], {}],
    ['Connect their GHL to Golden Eye', 'agency', 'action', [], [], {}],
    ['Register their texting number', 'agency', 'action', [], [], {}],
    ['Tell us about your business for SEO', 'client', 'questions', ['seo'], [], {}],
    ['Build their website', 'agency', 'action', [], ['new_build', 'existing'], {}],
    ['Give us access to Google', 'client', 'video', ['seo'], [], {}],
    ['Access to your website', 'client', 'questions', ['seo'], ['existing'], {}],
    ['Turn on automations and add their team', 'agency', 'action', [], [], {}],
    ['Final check and test', 'agency', 'action', [], [], {}],
    ['Set up SEO tracking', 'agency', 'action', ['seo'], [], {}],
    ['Set up Cuppa', 'agency', 'action', ['seo'], [], {}],
    ['Delete their stored website password', 'agency', 'action', ['seo'], ['existing'], {}],
    ['Build the lead send to their CRM', 'agency', 'action', [], [], { crm_choice: ['yes'] }],
];
await db.exec(`delete from onboarding_steps; delete from stage_templates;`);
let order = 0;
for (const [title, owner, type, svc, web, facts] of STEPS) {
    await db.query(`insert into onboarding_steps (title, owner, step_type, service_keys, website_statuses, fact_conditions, sort_order, questions)
                    values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [title, owner, type, svc, web, JSON.stringify(facts), ++order, title === 'Texting and your service area' ? QUESTIONS : null]);
}
const GROUPS = {
    'Connect their GHL to Golden Eye': [[]], 'Register their texting number': [[]], 'Build their website': [[]],
    'Turn on automations and add their team': [[], ['ads']], 'Final check and test': [[], ['ads']],
    'Set up SEO tracking': [['seo']], 'Set up Cuppa': [['seo']], 'Connect Meta': [['ads']],
};
for (const [group, tagSets] of Object.entries(GROUPS)) {
    for (const [i, tags] of tagSets.entries()) {
        await db.query(`insert into stage_templates (stage, task_type, checklist_group, task_title, service_keys, sort_order)
                        values ('Onboarding', 'Setup step', $1, $2, $3, $4)`, [group, `${group.split(' ')[0]} — step ${i + 1}`, tags, i + 1]);
    }
}
await db.query(`insert into stage_templates (stage, task_type, checklist_group, task_title, service_keys, sort_order)
                values ('Onboarding', 'Setup step', 'Set up SEO tracking', 'Leads — Add the lead-source snippet to their site and send one real Google test lead', '{seo}', 9)`);

await db.exec(`
    insert into clients (name) values ('Base Seo Co'), ('Seo Only Co'), ('Base Only Co');
    update clients set website_status = 'existing';
    insert into client_services (client_name, service_key, status) values ('Base Seo Co', 'seo', 'onboarding'), ('Seo Only Co', 'seo', 'onboarding');
`);

const steps = async (c) => (await db.query(`select st.title from onboarding_steps_for_client($1) f join onboarding_steps st on st.id = f.step_id order by st.title`, [c])).rows.map((r) => r.title);
const setup = async (c) => (await db.query(`select task_title from stage_templates_for_client($1, 'Onboarding') where task_type = 'Setup step' order by task_title`, [c])).rows.map((r) => r.task_title);

// Before: what Base clients get today
const beforeBaseSeo = await steps('Base Seo Co'), beforeBaseSeoSetup = await setup('Base Seo Co');
const beforeBaseOnly = await steps('Base Only Co');

const file = read('seo_only_package.sql');
await db.exec(file);
await db.exec(`update clients set base_package = 'no' where name = 'Seo Only Co'`);

// ---- Base + SEO: no change ----
ok(JSON.stringify(await steps('Base Seo Co')) === JSON.stringify(beforeBaseSeo), 'Base + SEO gets exactly the steps it got before');
ok(JSON.stringify(await setup('Base Seo Co')) === JSON.stringify(beforeBaseSeoSetup), 'Base + SEO gets exactly the setup steps it got before');
ok(JSON.stringify(await steps('Base Only Co')) === JSON.stringify(beforeBaseOnly), 'Base only (no add-ons) is unchanged too');
ok(!(await steps('Base Seo Co')).includes('Your service area'), 'a Base client never sees the SEO-only service area step');
await db.exec(`update clients set base_package = 'yes' where name = 'Base Only Co'`);
ok(JSON.stringify(await steps('Base Only Co')) === JSON.stringify(beforeBaseOnly), 'base_package = yes is the same as unset');

// ---- SEO only ----
const seo = await steps('Seo Only Co');
const GONE = ['Quick start: your Facebook page and CRM', 'Registering your texting number', 'Texting and your service area', 'Your new website',
    'Connect their GHL to Golden Eye', 'Register their texting number', 'Build their website', 'Turn on automations and add their team',
    'Final check and test', 'Build the lead send to their CRM'];
ok(GONE.every((t) => !seo.includes(t)), 'SEO only: no GHL, texting or website step: ' + seo.filter((t) => GONE.includes(t)).join(', '));
const KEPT = ['Welcome — how your dashboard works', 'Book your setup call', 'About your business', 'Sales team (names & numbers)',
    'Your service area', 'Tell us about your business for SEO', 'Give us access to Google', 'Access to your website',
    'Set up SEO tracking', 'Set up Cuppa', 'Delete their stored website password'];
ok(KEPT.every((t) => seo.includes(t)) && seo.length === KEPT.length, 'SEO only gets the shared steps, its service area and the SEO steps: ' + seo.join(' | '));
const seoSetup = await setup('Seo Only Co');
// Fake step titles are "<first word of the group> — step N": Set = Set up SEO tracking / Set up Cuppa
ok(seoSetup.length === 2 && seoSetup.every((t) => t.startsWith('Set — ')), 'SEO only gets just the SEO setup steps: ' + seoSetup.join(' | '));
ok(!seoSetup.some((t) => /^(Connect|Register|Build|Turn|Final) — /.test(t)), 'SEO only: no setup step from a GHL, texting, website or final-check group');
ok(!seoSetup.some((t) => t.startsWith('Leads — ')), 'SEO only: no lead-tracking step (it needs their GHL)');
ok((await setup('Base Seo Co')).some((t) => t.startsWith('Leads — ')), 'Base + SEO still has the lead-tracking step');

// "Your service area" copies the three area questions, in order, unchanged
const area = (await db.query(`select questions, owner, step_type, active, fact_conditions from onboarding_steps where title = 'Your service area'`)).rows;
const qs = area[0]?.questions || [];
ok(area.length === 1 && qs.map((q) => q.id).join() === 'c_area,c_radius,c_exclude', 'service area step has c_area, c_radius, c_exclude: ' + qs.map((q) => q.id));
ok(JSON.stringify(qs) === JSON.stringify(JSON.parse(QUESTIONS).slice(2)), 'its questions are copied exactly (labels, required, dest)');
ok(area[0]?.owner === 'client' && area[0]?.step_type === 'questions' && area[0]?.active === true && JSON.stringify(area[0]?.fact_conditions) === JSON.stringify({ base_package: ['no'] }),
    'it is a live client questions step for SEO only');

// The CRM tag on the lead send survives the merge
const lead = (await db.query(`select fact_conditions from onboarding_steps where title = 'Build the lead send to their CRM'`)).rows[0];
ok(JSON.stringify(lead.fact_conditions) === JSON.stringify({ crm_choice: ['yes'], base_package: ['yes'] }), 'existing tags are kept: ' + JSON.stringify(lead.fact_conditions));

// Add-on status: SEO completes on the SEO-only client's own steps, never waiting on a Base step it doesn't have
const sid = async (t) => (await db.query(`select id from onboarding_steps where title = $1`, [t])).rows[0].id;
for (const t of ['Welcome — how your dashboard works', 'Book your setup call', 'About your business', 'Sales team (names & numbers)', 'Your service area',
    'Tell us about your business for SEO', 'Give us access to Google', 'Access to your website']) {
    await db.query(`insert into client_onboarding_progress (client_name, step_id, completed_at) values ('Seo Only Co', $1, now())`, [await sid(t)]);
}
const st = (await db.query(`select service_key, complete from service_onboarding_status('Seo Only Co') order by 1`)).rows;
ok(st.find((r) => r.service_key === 'base')?.complete === true && st.find((r) => r.service_key === 'seo')?.complete === true,
    'SEO only is complete once its own steps are done: ' + JSON.stringify(st));

// Preview agrees
const prev = async (facts) => (await db.query(`select title from onboarding_preview('{seo}', 'existing', $1) where source = 'step' order by title`, [facts])).rows.map((r) => r.title);
ok(JSON.stringify(await prev('{"base_package": "no"}')) === JSON.stringify(seo), 'Templates preview for SEO only matches the client');
ok(JSON.stringify(await prev('{}')) === JSON.stringify(beforeBaseSeo), 'Templates preview with nothing picked matches Base + SEO');

// ---- who can set it ----
await db.exec(`set test.role = 'authenticated'; set test.visible = 'Base Seo Co'; set test.admin = 'false';`);
await db.query(`select set_client_onboarding_facts('Base Seo Co', '{"base_package": "no"}')`);
await db.exec(`reset test.role; reset test.visible; reset test.admin;`);
ok((await db.query(`select base_package from clients where name = 'Base Seo Co'`)).rows[0].base_package === null,
    "a client can't switch themselves to SEO only through set_client_onboarding_facts");
let refused = false;
try { await db.exec(`update clients set base_package = 'maybe' where name = 'Base Seo Co'`); } catch { refused = true; }
ok(refused, 'base_package accepts only yes or no');

// ---- re-runnable ----
const snap = async () => JSON.stringify((await db.query(`select title, fact_conditions from onboarding_steps order by title`)).rows)
    + JSON.stringify((await db.query(`select task_title, fact_conditions from stage_templates order by task_title`)).rows);
const s1 = await snap();
await db.exec(file);
ok(s1 === await snap(), 're-running changes nothing (no second service area step, no doubled tags)');
ok((await db.query(`select count(*)::int n from onboarding_steps where title = 'Your service area'`)).rows[0].n === 1, 'still one service area step');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
