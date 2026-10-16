// Tests for onboarding_test_setup.sql and onboarding_test_teardown.sql in PGlite.
// Run: PGLITE_DIR=<folder with node_modules/@electric-sql/pglite 0.2.x> node supabase/sql/onboarding_test_setup.test.mjs
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
    create role anon nologin; create role authenticated nologin;
    create table clients (name text primary key, current_stage text, status text);
    create table onboarding_steps (id uuid primary key default gen_random_uuid(), title text, owner text default 'client', step_type text default 'action',
        active boolean default true, service_keys text[] not null default '{}');
    create table services (key text primary key, name text not null, description text, active boolean not null default true, sort_order int not null default 0);
    create table client_services (client_name text, service_key text references services(key) on update cascade, status text not null default 'onboarding', primary key (client_name, service_key));
    create table ghl_accounts (client_name text primary key, location_id text, status text);
    create table client_onboarding_progress (id uuid primary key default gen_random_uuid(), client_name text not null, step_id uuid not null,
        completed_at timestamptz, completed_by text, watch_percent int default 0);
    create table tasks (id serial, client text, title text);
    create table user_client_access (user_email text, client_name text);
    create table pre_approved_users (email text);
    create table onboarding_answers (client_name text, step_id uuid);
    insert into services values ('ads', 'Ads management', null, true, 1), ('seo', 'SEO Growth', null, true, 2);
    insert into clients values ('GE Test Client', 'Campaign Building', 'paused'), ('Ironshell Roofing', 'Onboarding', 'active');
    insert into client_services values ('GE Test Client', 'ads', 'onboarding'), ('Ironshell Roofing', 'ads', 'onboarding');
    insert into onboarding_steps (title, owner, step_type, active, service_keys) values
        ('Welcome — how your dashboard works', 'client', 'video', true, '{}'),
        ('Tell us about your business', 'client', 'form', true, '{}'),
        ('Old hidden step', 'client', 'video', false, '{}'),
        ('About your business', 'client', 'questions', false, '{}'),
        ('Your jobs and offers', 'client', 'questions', false, '{ads}'),
        ('Access to your website', 'client', 'questions', false, '{seo}'),
        ('Quick start: your Facebook page and CRM', 'client', 'questions', false, '{}'),
        ('Tell us about your business for SEO', 'client', 'questions', true, '{seo}'),
        ('Help client create their Facebook page', 'agency', 'action', false, '{ads}'),
        ('Delete their stored website password', 'agency', 'action', false, '{seo}'),
        ('Set up GHL', 'agency', 'action', true, '{}');
    insert into client_onboarding_progress (client_name, step_id, completed_at) select 'Ironshell Roofing', id, null from onboarding_steps where title = 'Welcome — how your dashboard works';
    insert into tasks (client, title) values ('GE Test Client', 'x'), ('Ironshell Roofing', 'y');
    insert into user_client_access values ('video+getest@midasmediafirm.com', 'GE Test Client');
    insert into ghl_accounts values ('GE Test Client', 'TestLoc0000000000001', 'awaiting_install'), ('Real Client', 'RealLoc0000000000001', 'filled');
`);
const before = await q(`select title, active, service_keys from onboarding_steps order by title`);
const setup = read('onboarding_test_setup.sql').replace(/notify pgrst[^;]*;/g, '');
const teardown = read('onboarding_test_teardown.sql').replace(/notify pgrst[^;]*;/g, '');

// refuses without the client
await db.exec(`update clients set name = 'Someone' where name = 'GE Test Client'`);
let refused = false;
try { await db.exec(setup); } catch (e) { refused = /Add the client/.test(e.message); }
await db.exec('rollback'); // the SQL Editor rolls a failed run back; PGlite leaves it open
ok(refused, 'setup refuses when GE Test Client does not exist');
await db.exec(`update clients set name = 'GE Test Client' where name = 'Someone'`);

await db.exec(setup);
await db.exec(setup); // re-runnable
const s = Object.fromEntries((await q(`select title, active, service_keys from onboarding_steps`)).map((r) => [r.title, r]));
const newOnes = ['About your business', 'Your jobs and offers', 'Access to your website', 'Quick start: your Facebook page and CRM',
    'Help client create their Facebook page', 'Delete their stored website password'];
ok(newOnes.every((t) => s[t].active && s[t].service_keys.join() === 'qtest'), 'every new piece is on, tagged qtest only');
ok(s['Tell us about your business for SEO'].service_keys.join() === 'seo' && s['Set up GHL'].service_keys.length === 0 && s['Old hidden step'].active === false,
    'other steps are untouched');
const cs = await q(`select client_name, service_key, status from client_services where service_key = 'qtest'`);
ok(cs.length === 1 && cs[0].client_name === 'GE Test Client' && cs[0].status === 'onboarding', 'only the test client has qtest');
const cl = (await q(`select current_stage, status from clients where name = 'GE Test Client'`))[0];
ok(cl.current_stage === 'Onboarding' && cl.status === 'active', 'the test client is put in Onboarding, active');
const prog = await q(`select s.title, p.completed_by from client_onboarding_progress p join onboarding_steps s on s.id = p.step_id where p.client_name = 'GE Test Client'`);
ok(prog.map((p) => p.title).join('|') === 'Tell us about your business'
    && prog.every((p) => p.completed_by === 'backfilled'), 'only the old GHL form steps go-live switches off are ticked for the test client, once; the rest stay real');
ok((await q(`select count(*)::int n from client_onboarding_progress where client_name = 'Ironshell Roofing' and completed_at is not null`))[0].n === 0, 'Ironshell gets no progress');
ok((await q(`select count(*)::int n from onboarding_test_backup`))[0].n === 6, 'six originals backed up');

await db.exec(teardown);
await db.exec(teardown); // re-runnable
const after = await q(`select title, active, service_keys from onboarding_steps order by title`);
ok(JSON.stringify(after) === JSON.stringify(before), 'teardown restores every step exactly');
ok((await q(`select count(*)::int n from services where key = 'qtest'`))[0].n === 0, 'qtest is gone');
ok((await q(`select count(*)::int n from clients where name = 'GE Test Client'`))[0].n === 0
    && (await q(`select count(*)::int n from tasks where client = 'GE Test Client'`))[0].n === 0
    && (await q(`select count(*)::int n from user_client_access`))[0].n === 0, 'the test client and its rows are gone');
ok((await q(`select count(*)::int n from clients where name = 'Ironshell Roofing'`))[0].n === 1
    && (await q(`select count(*)::int n from tasks where client = 'Ironshell Roofing'`))[0].n === 1
    && (await q(`select count(*)::int n from client_services where client_name = 'Ironshell Roofing'`))[0].n === 1, 'Ironshell and its rows are untouched');
ok((await q(`select client_name from ghl_accounts`)).map((r) => r.client_name).join() === 'Real Client', "the test client's GHL account record goes; other clients' stay");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
