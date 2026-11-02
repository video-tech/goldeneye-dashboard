// Runs supabase/sql/contractor_fact.sql in PGlite (in-memory Postgres) on top of the real service_onboarding.sql,
// onboarding_facts.sql, onboarding_client_facts_fix.sql and seo_only_package.sql, with the live steps' shape (read
// 2026-11-02), and checks:
//   - a contractor (the default, or contractor = yes) gets exactly the steps and questions it got before;
//   - a non-contractor loses "Your jobs and offers" and gains "Your customers and offers", and its questions
//     (service area, website) swap to the neutral ones, with the travel questions shown only for "we go to them";
//   - base_package still works (the defaults function was restated, not clobbered);
//   - a client can't switch themselves; the column refuses anything but yes/no; the five named clients are set only
//     while unset; re-running changes nothing.
// Needs PGlite 0.2.x; point PGLITE_DIR at the folder holding node_modules:
//   PGLITE_DIR=/path/to/dir node supabase/sql/contractor_fact.test.mjs
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
await db.exec(`set check_function_bodies = off`);
await db.exec(read('service_onboarding.sql'));
await db.exec(read('onboarding_facts.sql'));
await db.exec(read('onboarding_client_facts_fix.sql'));
await db.exec(`set check_function_bodies = on`);

// The live questions (read 2026-11-02), trimmed to what the file touches
const Q = {
    quick: [
        { id: 'q_crm_name', dest: null, type: 'choice', label: 'Which CRM?', options: ['HubSpot', 'Jobber', 'JobNimbus', 'Housecall Pro', 'ServiceTitan', 'Salesforce', 'Other'], required: false, website_statuses: [] },
        { id: 'q_fb_page', type: 'choice', label: 'Do you have a Facebook business page?', options: ['Yes', 'No (I need one)', 'Not sure'], required: true, website_statuses: [], service_keys: ['ads'] },
    ],
    texting: [
        { id: 'c_text_ok', dest: 'custom_value:text_window', type: 'choice', label: 'We text new leads between 8am and 8pm. OK?', options: ['Yes', 'No (I would like different hours)'], required: true, website_statuses: [] },
        { id: 'c_area', dest: 'custom_value:service_area', type: 'short', label: 'Main cities you serve', options: [], required: true, website_statuses: [] },
        { id: 'c_radius', dest: 'custom_value:service_radius', type: 'short', label: 'How far will you travel for a job?', options: [], required: true, website_statuses: [] },
        { id: 'c_exclude', dest: 'custom_value:excluded_areas', type: 'long', label: 'Areas you will not serve (optional)', options: [], required: false, website_statuses: [] },
    ],
    website: [
        { id: 'w_features', dest: 'design:features', type: 'multi', label: 'Which features do you want?', options: ['Online booking', 'Instant price calculator', 'Financing application'], required: false, website_statuses: [] },
        { id: 'w_pages', dest: 'design:pages', type: 'multi', label: 'Which pages do you need?', options: ['Home', 'Our work', 'Financing'], required: false, website_statuses: [] },
        { id: 'w_content', dest: 'design:content_ready', type: 'choice', label: 'Do you have photos of your work and written content ready?', options: ['Both', 'Neither yet'], required: false, website_statuses: [] },
        { id: 'w_logo', dest: 'design:logo', type: 'choice', label: 'Do you have a logo?', options: ['Yes', 'No (I need one)'], required: false, website_statuses: [] },
    ],
};
const STEPS = [
    // title, owner, type, services, websites, facts, questions
    ['Welcome — how your dashboard works', 'client', 'video', [], [], {}, null],
    ['Quick start: your Facebook page and CRM', 'client', 'questions', [], [], { base_package: ['yes'] }, Q.quick],
    ['About your business', 'client', 'questions', [], [], {}, null],
    ['Texting and your service area', 'client', 'questions', [], [], { base_package: ['yes'] }, Q.texting],
    ['Your jobs and offers', 'client', 'questions', ['ads'], [], {}, [{ id: 'd_job_value', type: 'long', label: 'Your average job value for each of your main services', options: [], required: false, website_statuses: [], dest: 'admin:job_values' }]],
    ['Your new website', 'client', 'questions', [], ['new_build'], { base_package: ['yes'] }, Q.website],
    ['Sales team (names & numbers)', 'client', 'team', [], [], {}, null],
    ['Connect Meta', 'agency', 'action', ['ads'], [], {}, null],
    ['Build their website', 'agency', 'action', [], ['new_build', 'existing'], { base_package: ['yes'] }, null],
    ['Tell us about your business for SEO', 'client', 'questions', ['seo'], [], {}, null],
];
await db.exec(`delete from onboarding_steps; delete from stage_templates;`);
let order = 0;
for (const [title, owner, type, svc, web, facts, qs] of STEPS) {
    await db.query(`insert into onboarding_steps (title, owner, step_type, service_keys, website_statuses, fact_conditions, sort_order, questions)
                    values ($1, $2, $3, $4, $5, $6, $7, $8)`, [title, owner, type, svc, web, JSON.stringify(facts), ++order, qs ? JSON.stringify(qs) : null]);
}
// The Package file is already live: it tags the Base steps and adds "Your service area" from the texting step
await db.exec(`set check_function_bodies = off`);
await db.exec(read('seo_only_package.sql'));
await db.exec(`set check_function_bodies = on`);

await db.exec(`
    insert into clients (name) values ('Roofer Co'), ('Shop Co'), ('Shop No Base Co'), ('Anxiety Solutions'), ('Tattoo Ink Utah'), ('Kept Yes Co'), ('FreeBird Recruiting');
    update clients set website_status = 'new_build';
    insert into client_services (client_name, service_key, status)
        select name, 'ads', 'onboarding' from clients;
    update clients set base_package = 'no' where name = 'Shop No Base Co';
`);
const steps = async (c) => (await db.query(`select st.title from onboarding_steps_for_client($1) f join onboarding_steps st on st.id = f.step_id order by st.title`, [c])).rows.map((r) => r.title);
const stepQs = async (title) => (await db.query(`select questions from onboarding_steps where title = $1`, [title])).rows[0]?.questions || [];
const ids = (qs) => qs.map((q) => q.id).join();

// Before: what everyone gets today
const before = { Roofer: await steps('Roofer Co'), Shop: await steps('Shop Co'), NoBase: await steps('Shop No Base Co') };
const beforeTexting = JSON.stringify(await stepQs('Texting and your service area'));

const file = read('contractor_fact.sql');
await db.exec(`update clients set contractor = null where false`).catch(() => {});
await db.exec(file);

// ---- the five named clients, set only while unset ----
const flag = async (n) => (await db.query(`select contractor from clients where name = $1`, [n])).rows[0].contractor;
ok(await flag('Anxiety Solutions') === 'no' && await flag('Tattoo Ink Utah') === 'no' && await flag('FreeBird Recruiting') === 'no', 'the named non-contractors are set to no');
ok(await flag('Roofer Co') === null && await flag('Shop Co') === null, 'other clients stay unset (a contractor)');
await db.exec(`update clients set contractor = 'yes' where name = 'Kept Yes Co'`);
await db.exec(`update clients set contractor = 'yes' where name = 'Tattoo Ink Utah'`);
await db.exec(file);
ok(await flag('Tattoo Ink Utah') === 'yes', 'a named client already set to yes is not overwritten on a re-run');
await db.exec(`update clients set contractor = 'no' where name in ('Shop Co', 'Shop No Base Co')`);

// ---- contractor: exactly what they had ----
ok(JSON.stringify(await steps('Roofer Co')) === JSON.stringify(before.Roofer), 'an unset client gets exactly the steps it got before: ' + (await steps('Roofer Co')).join(' | '));
ok((await steps('Roofer Co')).includes('Your jobs and offers') && !(await steps('Roofer Co')).includes('Your customers and offers'), 'a contractor keeps Your jobs and offers and never sees Your customers and offers');
await db.exec(`update clients set contractor = 'yes' where name = 'Roofer Co'`);
ok(JSON.stringify(await steps('Roofer Co')) === JSON.stringify(before.Roofer), 'contractor = yes is the same as unset');

// ---- non-contractor ----
const shop = await steps('Shop Co');
ok(!shop.includes('Your jobs and offers') && shop.includes('Your customers and offers'), 'a non-contractor swaps the jobs step for the customers step: ' + shop.join(' | '));
const expectShop = before.Shop.filter((t) => t !== 'Your jobs and offers').concat('Your customers and offers').sort();
ok(JSON.stringify(shop) === JSON.stringify(expectShop), 'and nothing else changes: ' + shop.join(' | '));
ok(JSON.stringify(await steps('Shop No Base Co')).includes('Your customers and offers') && !(await steps('Shop No Base Co')).includes('Your jobs and offers'), 'No Base and not a contractor combine');
// base_package still works: the defaults function was restated, not clobbered
const nb = await steps('Shop No Base Co');
ok(!nb.includes('Texting and your service area') && nb.includes('Your service area'), 'base_package = no still drops the texting step and adds Your service area');
const facts = (await db.query(`select onboarding_client_facts('Shop No Base Co') f`)).rows[0].f;
ok(facts.contractor === 'no' && facts.base_package === 'no' && facts.facebook_page === 'yes' && facts.crm_choice === 'no', 'client facts carry all four: ' + JSON.stringify(facts));
ok((await db.query(`select onboarding_fact_defaults() d`)).rows[0].d.contractor === 'yes', 'unset counts as contractor');

// ---- the new step ----
const cust = await stepQs('Your customers and offers');
ok(ids(cust) === 'n_value,n_close,n_book,n_promo,n_ad_cities', 'customers step questions: ' + ids(cust));
ok(cust.filter((q) => q.private).map((q) => q.id).join() === 'n_value,n_close', 'its money questions are team-only, like the job value was');
ok(cust.every((q) => q.dest), 'every question says where its answer goes');
const cs = (await db.query(`select active, owner, step_type, service_keys, fact_conditions, sort_order from onboarding_steps where title = 'Your customers and offers'`)).rows[0];
ok(cs.active && cs.owner === 'client' && cs.step_type === 'questions' && JSON.stringify(cs.service_keys) === '["ads"]' && JSON.stringify(cs.fact_conditions) === '{"contractor":["no"]}',
    'a live client questions step for Ads clients who are not contractors: ' + JSON.stringify(cs));
ok(cs.sort_order === 5, 'it sits where the jobs step sits');
const jobs = (await db.query(`select fact_conditions from onboarding_steps where title = 'Your jobs and offers'`)).rows[0].fact_conditions;
ok(JSON.stringify(jobs) === '{"contractor":["yes"]}', 'the jobs step is tagged contractor only');

// ---- questions inside a step ----
const strip = (qs) => qs.filter((q) => !(q.fact_conditions && q.fact_conditions.contractor && q.fact_conditions.contractor[0] === 'no')).map((q) => { const { fact_conditions, ...r } = q; return r; });
const tx = await stepQs('Texting and your service area');
ok(ids(tx) === 'c_text_ok,c_area,c_visit,c_radius_nc,c_exclude_nc,c_radius,c_exclude', 'texting step order: ' + ids(tx));
ok(JSON.stringify(strip(tx).filter((q) => true)) === JSON.stringify(Q.texting.filter((q) => true).map((q) => ({ ...q }))) || ids(strip(tx)) === 'c_text_ok,c_area,c_radius,c_exclude',
    'contractor questions are the same ones, in the same order');
ok(JSON.stringify(strip(tx)) === JSON.stringify(Q.texting), 'and unchanged apart from the tag (labels, required, dest)');
ok(JSON.stringify(tx.find((q) => q.id === 'c_radius').fact_conditions) === '{"contractor":["yes"]}' && JSON.stringify(tx.find((q) => q.id === 'c_exclude').fact_conditions) === '{"contractor":["yes"]}', 'the travel radius and excluded areas are contractor-only');
ok(!tx.find((q) => q.id === 'c_area').fact_conditions && !tx.find((q) => q.id === 'c_text_ok').fact_conditions, 'cities and the texting question stay for everyone');
const visit = tx.find((q) => q.id === 'c_visit'), rad = tx.find((q) => q.id === 'c_radius_nc');
ok(visit.type === 'choice' && visit.options.join('|') === 'They come to us|We go to them|Both|Online or nationwide', 'the new question asks who goes to whom');
ok(rad.show_if.q === 'c_visit' && rad.show_if.any.join() === 'We go to them,Both' && ids(tx).indexOf('c_visit') < ids(tx).indexOf('c_radius_nc'), 'the travel questions depend on it, and it comes first');
// the choices the dependency names are real choices
ok(rad.show_if.any.every((a) => visit.options.includes(a)), 'the dependency names exact choices');
const sa = await stepQs('Your service area');
ok(ids(sa) === 'c_area,c_visit,c_radius_nc,c_exclude_nc,c_radius,c_exclude', 'the No Base service area step gets the same swap: ' + ids(sa));
const web = await stepQs('Your new website');
ok(ids(web) === 'w_features,w_pages,w_content,w_features_nc,w_pages_nc,w_content_nc,w_logo', 'website step: ' + ids(web));
ok(['w_features', 'w_pages', 'w_content'].every((i) => JSON.stringify(web.find((q) => q.id === i).fact_conditions) === '{"contractor":["yes"]}'), 'the contractor website questions are tagged');
ok(!web.find((q) => q.id === 'w_logo').fact_conditions, 'the logo question is for everyone');
const wnc = web.filter((q) => q.id.endsWith('_nc'));
ok(wnc.every((q) => q.dest && JSON.stringify(q.fact_conditions) === '{"contractor":["no"]}'), 'every neutral website question has a dest and the tag');
ok(!wnc.some((q) => /financ|calculator|work\b|Our work/i.test(q.label + q.options.join())), 'no contractor wording in the neutral website questions');

// ---- Quick start CRM list ----
const crm = (await stepQs('Quick start: your Facebook page and CRM')).find((q) => q.id === 'q_crm_name').options;
ok(crm.join('|') === 'HubSpot|Jobber|JobNimbus|Housecall Pro|ServiceTitan|Salesforce|Mindbody|Vagaro|Square|Calendly|Other', 'CRM list gains four, existing order kept, Other last: ' + crm.join('|'));
ok((await stepQs('Quick start: your Facebook page and CRM')).find((q) => q.id === 'q_fb_page').service_keys[0] === 'ads', 'other Quick start questions are untouched');

// ---- preview agrees ----
const prev = async (f) => (await db.query(`select title from onboarding_preview('{ads}', 'new_build', $1) where source = 'step' order by title`, [f])).rows.map((r) => r.title);
ok(JSON.stringify(await prev('{"contractor": "no"}')) === JSON.stringify(shop), 'Templates preview for a non-contractor matches the client');
ok(JSON.stringify(await prev('{}')) === JSON.stringify(before.Roofer), 'Templates preview with nothing picked matches a contractor');

// ---- who can set it ----
await db.exec(`update clients set contractor = null where name = 'Roofer Co'`);
await db.exec(`set test.role = 'authenticated'; set test.visible = 'Roofer Co'; set test.admin = 'false';`);
await db.query(`select set_client_onboarding_facts('Roofer Co', '{"contractor": "no"}')`);
await db.exec(`reset test.role; reset test.visible; reset test.admin;`);
ok(await flag('Roofer Co') === null, "a client can't switch themselves to non-contractor through set_client_onboarding_facts");
let refused = false;
try { await db.exec(`update clients set contractor = 'maybe' where name = 'Roofer Co'`); } catch { refused = true; }
ok(refused, 'contractor accepts only yes or no');

// ---- re-runnable ----
const snap = async () => JSON.stringify((await db.query(`select title, fact_conditions, questions from onboarding_steps order by title`)).rows);
const s1 = await snap();
await db.exec(file);
ok(s1 === await snap(), 're-running changes nothing (no second step, no doubled questions or CRMs)');
ok((await db.query(`select count(*)::int n from onboarding_steps where title = 'Your customers and offers'`)).rows[0].n === 1, 'still one customers step');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
