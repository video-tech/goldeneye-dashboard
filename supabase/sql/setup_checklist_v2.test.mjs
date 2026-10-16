// Tests for setup_checklist_v2.sql: runs the real v1 then v2 files in PGlite against the live table shapes.
// Run: PGLITE_DIR=<folder with node_modules/@electric-sql/pglite 0.2.x> node supabase/sql/setup_checklist_v2.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pgliteDir = process.env.PGLITE_DIR;
if (!pgliteDir) { console.error('Set PGLITE_DIR'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(path.join(pgliteDir, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const db = new PGlite();
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
    insert into onboarding_steps (title, owner, sort_order, service_keys) values
        ('Add their Meta ad account ID to Golden Eye', 'agency', 13, '{ads}'), ('Set up GHL sub-account & assets', 'agency', 14, '{}'),
        ('Build and launch ads', 'agency', 15, '{ads}'), ('Connect Search Console', 'agency', 18, '{seo}');
    insert into stage_templates (stage, task_title, task_type, sort_order, service_keys) values
        ('Campaign Building', 'Draft Copywriting Hooks V1', 'Checklist', 1, '{ads}'),
        ('Campaign Building', 'Some other checklist item', 'Checklist', 9, '{}');
`);
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8');
await db.exec(read('setup_checklist.sql'));
const v2 = read('setup_checklist_v2.sql');
await db.exec(v2);
await db.exec(v2); // re-runnable
const q = async (t) => (await db.query(t)).rows;

const steps = await q(`select stage, checklist_group g, task_title t, sort_order s, service_keys sk, website_statuses ws, auto_check ac
                       from stage_templates where task_type = 'Setup step' order by stage, s`);
const by = (g) => steps.filter((x) => x.g === g);
ok(by('Get ready for GHL').length === 9, 'Get ready for GHL has 9 steps: ' + by('Get ready for GHL').length);
ok(by('Set up GHL').length === 37, 'Set up GHL has 37 steps: ' + by('Set up GHL').length);
ok(by('Launch ads').length === 5 && by('Launch ads')[0].t === 'Draft Copywriting Hooks V1', 'Launch ads keeps the hooks step first, 5 steps');
ok(by('First week live').length === 3 && by('First week live').every((x) => x.stage === 'Campaign Learning'), 'First week live: 3 steps in Campaign Learning');
ok(!steps.some((x) => /Check the ad account is healthy|Check the Drive link|Fill every custom value/.test(x.t)), 'the old v1 steps are gone');
ok(steps.every((x) => / — /.test(x.t) || x.t === 'Draft Copywriting Hooks V1'), 'every new step title is "Section — Step"');
for (const g of ['Get ready for GHL', 'Set up GHL', 'Launch ads', 'First week live']) {
    const s = by(g).map((x) => x.s);
    ok(new Set(s).size === s.length, `${g}: sort orders are unique`);
}
const autos = steps.filter((x) => x.ac).map((x) => x.ac).sort().join();
ok(autos === 'ad_account_set,ads_data_flowing,ghl_location_set', 'the three auto-checks are kept: ' + autos);
ok(steps.filter((x) => (x.ws || []).includes('new_build')).length === 4 && steps.filter((x) => (x.ws || []).includes('existing')).length === 1,
    'website steps: 4 for a site we build, 1 for an existing site');
ok(steps.filter((x) => x.t.startsWith('Website')).every((x) => x.ws.length === 1), 'every website step names its website situation');
ok(by('First week live').every((x) => x.sk.includes('ads')) && by('Launch ads').every((x) => x.sk.includes('ads')), 'ads groups are Ads only');
const capi = steps.find((x) => /Conversions API/.test(x.t));
ok(capi && capi.sk.includes('ads'), 'the CAPI step is Ads only');
const titles = steps.map((x) => x.t);
ok(titles.indexOf(titles.find((t) => t.startsWith('Final check'))) < titles.indexOf(titles.find((t) => t.startsWith('Test —'))), 'the final check comes before the tests');

const ghl = by('Set up GHL');
ok(!ghl.some((x) => /Create the sub-account/.test(x.t)) && ghl.some((x) => x.t === 'Account — Install the Golden Eye app on their new GHL account'),
    'Golden Eye creates the account; our step is installing the app');
const leadGe = ghl.find((x) => x.t === 'Workflows — Turn on the lead to Golden Eye workflow');
ok(leadGe && leadGe.sk.length === 0, 'lead to Golden Eye is turned on for every client');
ok(['Funnel — Build the funnel', 'Funnel — Build the survey', 'Funnel — Connect the funnel and survey to their workflows',
    'Funnel — Paste their pixel and token into the Conversions API workflow', 'Workflows — Turn on the Conversions API and lead follow-up (survey) workflows']
    .every((t) => ghl.find((x) => x.t === t)?.sk.includes('ads')), 'funnel, survey, CAPI and follow-up steps are Ads only');

// Group tasks
const groups = await q(`select stage, task_title from stage_templates where task_type = 'Checklist' order by stage, task_title`);
ok(groups.filter((g) => g.task_title === 'First week live').length === 1 && groups.find((g) => g.task_title === 'First week live').stage === 'Campaign Learning',
    'one First week live group task, in Campaign Learning');
ok(groups.filter((g) => g.task_title === 'Launch ads').length === 1, 'one Launch ads group task');
ok(groups.some((g) => g.task_title === 'Some other checklist item'), 'unrelated checklist items are left alone');
const agency = await q(`select title, active, description, service_keys, website_statuses from onboarding_steps where owner = 'agency'`);
const groupNames = new Set([...agency.map((a) => a.title), ...groups.map((g) => g.task_title)]);
ok([...new Set(steps.map((x) => x.g))].every((g) => groupNames.has(g)), 'every step group has a group task to roll up into');
ok(/MasterV\.1/.test(agency.find((a) => a.title === 'Set up GHL').description), 'the Set up GHL description is updated');

// The SEO password step
const pw = agency.filter((a) => a.title === 'Delete their stored website password');
ok(pw.length === 1 && pw[0].active === false && pw[0].service_keys.join() === 'seo' && pw[0].website_statuses.join() === 'existing',
    'the password step is added once, switched off, SEO with an existing site only');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
