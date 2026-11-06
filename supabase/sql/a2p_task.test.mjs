// Tests for a2p_task.sql: the A2P and website steps become one task with the highest priority, in the order the work happens,
// and clients already part-way through are moved over without new tasks. Runs the real SQL in PGlite against the live shape.
// Run: PGLITE_DIR=<folder with node_modules/@electric-sql/pglite 0.2.x> node supabase/sql/a2p_task.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { PGlite } = await import(pathToFileURL(path.join(process.env.PGLITE_DIR, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href);
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const sql = fs.readFileSync(path.join(here, 'a2p_task.sql'), 'utf8');
const NEW = 'Texting number and website (A2P)';
const REVIEW = 'Review — Paste the A2P details into their Business Profile';

// names: the live (internal) names, or the client-friendly ones show_setup_tasks_to_clients.sql would have made
async function world(names) {
    const db = new PGlite();
    const q = async (t) => (await db.query(t)).rows;
    await db.exec(`
        create table onboarding_steps (id serial primary key, title text, owner text, active boolean default true, sort_order int, due_days int, description text);
        create table stage_templates (id serial primary key, stage text, task_title text, task_type text, checklist_group text, sort_order int, due_days int,
                                      website_statuses text[], fact_conditions jsonb, service_keys text[]);
        create table tasks (id serial primary key, client text, title text, type text, stage text, status text, checklist_group text,
                            p smallint, u smallint, e smallint, score smallint, archived_at timestamptz, archived_by text, updated_at timestamptz);
        insert into onboarding_steps (title, owner, active, sort_order, due_days) values
            ('Welcome video', 'client', true, 1, 0), ('Questions', 'client', true, 12, 0),
            ('Connect Meta', 'agency', true, 13, 3), ('${names.ghl}', 'agency', true, 14, 4), ('${names.reg}', 'agency', true, 15, 10),
            ('${names.web}', 'agency', true, 16, 8), ('Build the funnel and survey', 'agency', true, 17, 7), ('Final check and test', 'agency', true, 19, 8),
            ('Build and launch ads', 'agency', false, 15, 1);
        insert into stage_templates (stage, task_title, task_type, checklist_group, sort_order, due_days, website_statuses, fact_conditions, service_keys) values
            ('Onboarding', 'GHL — Install the Golden Eye app on their new GHL account', 'Setup step', '${names.ghl}', 1, 2, '{}', '{"base_package":["yes"]}', '{}'),
            ('Onboarding', '${REVIEW}', 'Setup step', '${names.ghl}', 6, 3, '{}', '{"base_package":["yes"]}', '{}'),
            ('Onboarding', 'Golden Eye — Fill their profile, add check-in people and confirm portal sign-in', 'Setup step', '${names.ghl}', 7, 3, '{}', '{"base_package":["yes"]}', '{}'),
            ('Onboarding', 'A2P — Check the legal name, address and EIN match exactly', 'Setup step', '${names.reg}', 1, 2, '{}', '{"base_package":["yes"]}', '{}'),
            ('Onboarding', 'A2P — Make their website and host it on their GHL account', 'Setup step', '${names.reg}', 2, 4, '{}', '{"base_package":["yes"]}', '{}'),
            ('Onboarding', 'A2P — Buy a local number', 'Setup step', '${names.reg}', 3, 3, '{}', '{"base_package":["yes"]}', '{}'),
            ('Onboarding', 'A2P — Submit the brand and the campaign', 'Setup step', '${names.reg}', 4, 5, '{}', '{"base_package":["yes"]}', '{}'),
            ('Onboarding', 'A2P — When approved, attach the number to the campaign and make it the default', 'Setup step', '${names.reg}', 5, 14, '{}', '{"base_package":["yes"]}', '{}'),
            ('Onboarding', 'Website — Check the logo and photos are usable', 'Setup step', '${names.web}', 1, 3, '{new_build}', '{"base_package":["yes"]}', '{}'),
            ('Onboarding', 'Website — Read their style picks and design answers', 'Setup step', '${names.web}', 2, 4, '{new_build}', '{"base_package":["yes"]}', '{}'),
            ('Onboarding', 'Website — Build the site from their first-choice look', 'Setup step', '${names.web}', 3, 7, '{new_build}', '{"base_package":["yes"]}', '{}'),
            ('Onboarding', 'Website — Connect the domain and publish', 'Setup step', '${names.web}', 4, 8, '{new_build}', '{"base_package":["yes"]}', '{}'),
            ('Onboarding', 'Website — Test the contact form lands in GHL', 'Setup step', '${names.web}', 5, 8, '{new_build}', '{"base_package":["yes"]}', '{}'),
            ('Onboarding', 'Website — Connect their site''s contact form to GHL', 'Setup step', '${names.web}', 6, 6, '{existing}', '{"base_package":["yes"]}', '{}'),
            ('Onboarding', 'Funnel — Build the funnel', 'Setup step', 'Build the funnel and survey', 1, 6, '{}', '{}', '{ads}'),
            ('Campaign Building', 'Launch ads', 'Checklist', null, 1, 7, '{}', '{}', '{ads}');
        -- Optimum: the group tasks and their steps exist, nothing started. Pure: no website task. Other: a different client entirely.
        insert into tasks (client, title, type, stage, status, checklist_group, p, u, e, score) values
            ('Optimum', '${names.reg}', 'Checklist', 'Onboarding', 'Not Started', null, 3, 3, 3, 60),
            ('Optimum', '${names.web}', 'Checklist', 'Onboarding', 'Not Started', null, 3, 3, 3, 60),
            ('Optimum', '${names.ghl}', 'Checklist', 'Onboarding', 'In Progress', null, 3, 3, 3, 60),
            ('Optimum', 'A2P — Buy a local number', 'Setup step', 'Onboarding', 'Not Started', '${names.reg}', 3, 3, 3, 60),
            ('Optimum', 'Website — Build the site from their first-choice look', 'Setup step', 'Onboarding', 'Complete', '${names.web}', 3, 3, 3, 60),
            ('Optimum', '${REVIEW}', 'Setup step', 'Onboarding', 'Not Started', '${names.ghl}', 3, 3, 3, 60),
            ('Optimum', 'GHL — Install the Golden Eye app on their new GHL account', 'Setup step', 'Onboarding', 'Complete', '${names.ghl}', 3, 3, 3, 60),
            ('Pure', '${names.reg}', 'Checklist', 'Onboarding', 'Complete', null, 3, 3, 3, 60),
            ('Pure', 'A2P — Submit the brand and the campaign', 'Setup step', 'Onboarding', 'Complete', '${names.reg}', 3, 3, 3, 60),
            ('Pure', 'Connect Meta', 'Checklist', 'Onboarding', 'Blocked', null, 3, 3, 3, 60),
            ('Pure', 'Launch ads', 'Checklist', 'Campaign Building', 'Not Started', null, 3, 3, 3, 60);
    `);
    return { db, q };
}

for (const [label, names] of [
    ['live names', { ghl: 'Connect their GHL to Golden Eye', reg: 'Register their texting number', web: 'Build their website' }],
    ['after show_setup_tasks_to_clients.sql', { ghl: 'Set up your CRM', reg: 'Register your texting number', web: 'Build your website' }],
]) {
    const { db, q } = await world(names);
    const snap = async () => JSON.stringify([await q(`select * from onboarding_steps order by id`), await q(`select * from stage_templates order by id`),
        await q(`select id, client, title, status, checklist_group, p, u, e, score, archived_at is not null a from tasks order by id`)]);
    const tasksBefore = (await q(`select count(*)::int n from tasks`))[0].n;
    await db.exec(sql);
    const L = (s) => `${label}: ${s}`;

    // ---- the definition ----
    const agency = await q(`select title, active, priority, urgency, effort, sort_order, description from onboarding_steps where owner = 'agency' order by sort_order, id`);
    const a2p = agency.find((r) => r.title === NEW);
    ok(!!a2p && a2p.active && a2p.priority === 5 && a2p.urgency === 5 && a2p.effort === 1, L('the task is renamed and set to priority 5, urgency 5, effort 1 (score 100)'));
    ok(Math.round(((5 * 0.4) + (5 * 0.4) + ((6 - 1) * 0.2)) * 20) === 100, L('which scores 100, the most there is'));
    ok(agency.filter((r) => r.active)[0].title === NEW, L('and it is first among our active tasks: ' + agency.filter((r) => r.active).map((r) => r.title).join(' | ')));
    ok(/website and register your business texting number/.test(a2p.description), L('it has a description for the client'));
    ok(agency.find((r) => r.title === names.web)?.active === false, L('"Build their website" is switched off, not deleted'));
    ok(agency.filter((r) => r.title !== NEW && r.priority !== null).length === 0, L('no other task gets a priority, so they stay at 3'));
    ok(agency.find((r) => r.title === 'Connect Meta').active && agency.find((r) => r.title === 'Build the funnel and survey').active, L('the other tasks are untouched'));

    // ---- the checklist ----
    const steps = await q(`select task_title, sort_order, due_days, website_statuses from stage_templates where checklist_group = '${NEW}' order by sort_order`);
    ok(steps.length === 12, L('twelve steps in the one group, got ' + steps.length));
    ok(steps[0].task_title.startsWith('A2P — Check the legal name') && steps[1].task_title === REVIEW && steps[2].task_title === 'A2P — Buy a local number',
        L('legal name check, then the Business Profile step (moved from Connect GHL), then the number'));
    ok(steps.slice(3, 9).every((s) => s.task_title.startsWith('Website — ')) && steps[9].task_title.startsWith('A2P — Make their website')
        && steps[10].task_title.startsWith('A2P — Submit') && steps[11].task_title.startsWith('A2P — When approved'),
        L('then the six website steps, host the site, submit, attach: ' + steps.map((s) => s.task_title.split(' — ')[1]).join(' / ')));
    ok(steps.map((s) => s.sort_order).join() === '1,2,3,4,5,6,7,8,9,10,11,12', L('in a clean order'));
    ok(steps[9].due_days === 8 && steps[10].due_days === 9 && steps[11].due_days === 21, L('dues follow the work: site 8, submit 9, attach 21'));
    ok(steps.filter((s) => s.website_statuses.length).length === 6 && steps.find((s) => /Connect their site/.test(s.task_title)).website_statuses.join() === 'existing',
        L('website steps keep their situation tags (a new site vs an existing one)'));
    const fc = await q(`select distinct fact_conditions::text f from stage_templates where checklist_group = '${NEW}'`);
    ok(fc.length === 1 && fc[0].f === '{"base_package": ["yes"]}', L('every step is still Base only'));
    ok((await q(`select count(*)::int n from stage_templates where checklist_group = '${names.ghl}'`))[0].n === 2, L('Connect GHL keeps its other two steps'));
    ok((await q(`select count(*)::int n from stage_templates where checklist_group in ('${names.reg}', '${names.web}')`))[0].n === 0, L('nothing is left under the old names'));
    ok((await q(`select count(*)::int n from stage_templates where checklist_group = 'Build the funnel and survey' and due_days = 6`))[0].n === 1, L('other groups are untouched'));

    // ---- clients part-way through ----
    const t = await q(`select client, title, type, status, checklist_group, p, u, e, score, archived_at is not null a from tasks order by id`);
    const g = (c, title) => t.find((r) => r.client === c && r.title === title);
    ok(g('Optimum', NEW)?.score === 100 && g('Optimum', NEW).p === 5 && g('Optimum', NEW).e === 1 && g('Optimum', NEW).status === 'Not Started', L("Optimum's register task is renamed and raised in priority"));
    ok(g('Pure', NEW)?.score === 100 && g('Pure', NEW).status === 'Complete', L("Pure's keeps its status"));
    ok(g('Optimum', names.web)?.a === true, L("Optimum's old website task is archived"));
    ok(t.filter((r) => r.client === 'Optimum' && r.type === 'Setup step').every((r) => r.checklist_group === NEW || r.title.startsWith('GHL —')), L("all of Optimum's A2P and website steps are under the new task, and the Review step moved"));
    ok(g('Optimum', 'GHL — Install the Golden Eye app on their new GHL account').checklist_group === names.ghl, L('and its other CRM steps stay put'));
    ok(g('Optimum', names.ghl).status === 'In Progress', L("Optimum's CRM task is untouched"));
    ok(g('Pure', 'Connect Meta').score === 60 && g('Pure', 'Launch ads').score === 60, L("other tasks keep their score of 60"));
    ok((await q(`select count(*)::int n from tasks`))[0].n === tasksBefore, L('no new tasks were made'));

    // ---- re-running ----
    const once = await snap();
    await db.exec(sql);
    ok((await snap()) === once, L('re-running changes nothing'));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
