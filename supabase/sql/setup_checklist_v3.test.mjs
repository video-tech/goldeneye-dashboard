// Tests for setup_checklist_v3.sql: runs the real v1, v2 and v3 files in PGlite against the live table shapes.
// Run: PGLITE_DIR=<folder with node_modules/@electric-sql/pglite 0.2.x> node supabase/sql/setup_checklist_v3.test.mjs
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
    insert into onboarding_steps (title, owner, sort_order, service_keys, auto_check) values
        ('Add their Meta ad account ID to Golden Eye', 'agency', 13, '{ads}', null), ('Set up GHL sub-account & assets', 'agency', 14, '{}', null),
        ('Build and launch ads', 'agency', 15, '{ads}', null),
        ('Connect Search Console', 'agency', 18, '{seo}', 'gsc_connected'), ('Create the SE Ranking project', 'agency', 19, '{seo}', 'seranking_connected'),
        ('Save SEO start date and fee', 'agency', 20, '{seo}', 'seo_settings_set'), ('Set up article auto-logging', 'agency', 21, '{seo}', 'autolog_configured'),
        ('Set up Cuppa', 'agency', 22, '{seo}', 'first_article_logged'), ('Set up lead tracking', 'agency', 23, '{seo}', 'lead_tracking_live'),
        ('Keyword research and page plan', 'agency', 24, '{seo}', null),
        ('Delete their stored website password', 'agency', 25, '{seo}', null);
    insert into stage_templates (stage, task_title, task_type, sort_order, service_keys) values
        ('Campaign Building', 'Draft Copywriting Hooks V1', 'Checklist', 1, '{ads}');
`);
const oldAutos = (await q(`select auto_check from onboarding_steps where auto_check is not null order by 1`)).map((r) => r.auto_check);
await db.exec(read('setup_checklist.sql'));
await db.exec(read('setup_checklist_v2.sql'));
const v2Autos = (await q(`select auto_check from stage_templates where auto_check is not null order by 1`)).map((r) => r.auto_check);
const v3 = read('setup_checklist_v3.sql');
await db.exec(v3);
await db.exec(v3); // re-runnable

const steps = await q(`select stage, checklist_group g, task_title t, sort_order s, service_keys sk, website_statuses ws, auto_check ac, default_notes n
                       from stage_templates where task_type = 'Setup step' order by checklist_group, sort_order`);
const by = (g) => steps.filter((x) => x.g === g);
const sizes = {
    'Connect Meta': 4, 'Connect their GHL to Golden Eye': 6, 'Register their texting number': 5, 'Build their website': 6,
    'Build the funnel and survey': 7, 'Turn on automations and add their team': 6, 'Final check and test': 8,
    'Set up SEO tracking': 9, 'Set up Cuppa': 4, 'Launch ads': 6,
};
ok(JSON.stringify(Object.keys(sizes).sort()) === JSON.stringify([...new Set(steps.map((x) => x.g))].sort()), 'exactly these tasks have steps: ' + [...new Set(steps.map((x) => x.g))].join(' | '));
for (const [g, n] of Object.entries(sizes)) ok(by(g).length === n, `${g} has ${n} steps (${by(g).length})`);
for (const g of Object.keys(sizes)) ok(new Set(by(g).map((x) => x.s)).size === by(g).length, `${g}: sort orders unique`);

// What the user asked for
ok(!steps.some((x) => /Read every answer|what happens next/.test(x.t)), 'Review their answers is gone');
ok(!steps.some((x) => /Create the sub-account/.test(x.t)) && by('Connect their GHL to Golden Eye')[0].t.includes('Install the Golden Eye app'),
    'no manual account creation; connecting starts with installing the app');
ok(by('Connect their GHL to Golden Eye').filter((x) => x.t.startsWith('Review')).length === 3, 'connecting includes reviewing their GHL info');
const a2p = by('Register their texting number').map((x) => x.t);
ok(a2p.some((t) => /website and host it on their GHL/.test(t)) && a2p.some((t) => /Submit the brand and the campaign/.test(t)) && /When approved/.test(a2p[a2p.length - 1]),
    'one A2P task: website on their GHL, submit, number when approved');
ok(a2p.some((t) => /EIN/.test(t)), 'the EIN check moved into A2P');
ok(by('Build their website').some((x) => /logo and photos/.test(x.t) && x.ws.join() === 'new_build'), 'the logo check moved into the website task');
ok(!steps.some((x) => x.stage === 'Campaign Learning') && (await q(`select count(*)::int n from stage_templates where task_title = 'First week live'`))[0].n === 0,
    'First week live is gone');
ok(/first real lead/.test(by('Launch ads').at(-1).t) && by('Launch ads')[0].t === 'Draft Copywriting Hooks V1', 'Launch ads keeps the hooks first and ends with the first real lead');

// Tags
ok(by('Build the funnel and survey').every((x) => x.sk.join() === 'ads') && by('Connect Meta').every((x) => x.sk.join() === 'ads'), 'funnel and Meta steps are Ads only');
ok(by('Set up SEO tracking').every((x) => x.sk.join() === 'seo') && by('Set up Cuppa').every((x) => x.sk.join() === 'seo'), 'SEO steps are SEO only');
ok(by('Build their website').every((x) => x.ws.length === 1), 'every website step names its website situation');

// Auto-ticks: every one the old SEO tasks and v2 had is still on a step
const v3Autos = steps.filter((x) => x.ac).map((x) => x.ac).sort();
ok([...new Set([...oldAutos, ...v2Autos])].sort().join() === v3Autos.join(), 'every auto-tick kept: ' + v3Autos.join());

// The task rows
const agency = Object.fromEntries((await q(`select title, active, service_keys, website_statuses, auto_check, description from onboarding_steps where owner = 'agency'`)).map((r) => [r.title, r]));
const groupTasks = Object.keys(sizes).filter((g) => g !== 'Launch ads');
ok(groupTasks.every((g) => agency[g]?.active === true), 'every onboarding task exists and is on');
ok(agency['Connect Meta'].service_keys.join() === 'ads' && agency['Build the funnel and survey'].service_keys.join() === 'ads', 'Meta and funnel tasks are Ads only');
ok(agency['Set up SEO tracking'].service_keys.join() === 'seo' && agency['Set up Cuppa'].service_keys.join() === 'seo' && agency['Set up Cuppa'].auto_check === null,
    'SEO tasks are SEO only; Set up Cuppa ticks from its steps, not on its own');
ok(agency['Build their website'].website_statuses.sort().join() === 'existing,new_build', 'the website task only exists when there are website steps');
ok(!agency['Get ready for GHL'] && !agency['Set up GHL'], 'the two v2 tasks were renamed, not duplicated');
ok(['Connect Search Console', 'Create the SE Ranking project', 'Save SEO start date and fee', 'Set up article auto-logging', 'Set up lead tracking',
    'Keyword research and page plan'].every((t) => agency[t]?.active === false), 'the other six old SEO tasks are switched off, not deleted');
ok(agency['Delete their stored website password'].active === true && agency['Build and launch ads'].active === false, 'unrelated agency rows are untouched');
ok((await q(`select count(*)::int n from onboarding_steps where title = 'Set up Cuppa'`))[0].n === 1, 'one Set up Cuppa row');
const launch = await q(`select count(*)::int n from stage_templates where task_type = 'Checklist' and task_title = 'Launch ads'`);
ok(launch[0].n === 1, 'one Launch ads task');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
