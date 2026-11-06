// Tests for handoff_task_archived.sql: the "onboarding complete" task is raised already archived and Complete, still counts
// as "already announced", still fires the admin alert on insert, and the existing ones are archived. Runs the real
// trigger function in PGlite, with net.http_post and Vault stood in.
// Run: PGLITE_DIR=<folder with node_modules/@electric-sql/pglite 0.2.x> node supabase/sql/handoff_task_archived.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { PGlite } = await import(pathToFileURL(path.join(process.env.PGLITE_DIR, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href);
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const db = new PGlite();
const q = async (t) => (await db.query(t)).rows;
const HANDOFF = 'Onboarding complete — ready for campaign build';

await db.exec(`
    create schema net; create schema vault;
    create table net.calls (url text, headers jsonb, body jsonb);
    create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int default 5000) returns bigint
        language sql as $$ insert into net.calls values (url, headers, body); select 1::bigint $$;
    create table vault.secrets (name text, secret text);
    create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
    insert into vault.secrets values ('make_onboarding_hook_secret', 's3cret');
    create table clients (name text, status text, current_stage text, client_email text);
    create table tasks (id serial, client text, title text, type text, stage text, status text, assignee text, p int, u int, e int, score int, due date, notes text, updated_at timestamptz, archived_at timestamptz, archived_by text);
    create table client_services (client_name text, service_key text, status text, onboarded_at timestamptz);
    create table services (key text, name text);
    create table client_onboarding_progress (client_name text, step_id text, completed_at timestamptz, completed_by text);
    create function onboarding_steps_for_client(p text) returns table (step_id text, owner text, completed boolean) language sql as $$
        select s, 'client', exists (select 1 from client_onboarding_progress pr where pr.client_name = p and pr.step_id = s and pr.completed_at is not null)
        from unnest(array['a','b']) s $$;
    -- Live is past onboarding and has just finished its SEO add-on
    create function service_onboarding_status(p text) returns table (service_key text, status text, complete boolean) language sql as $$
        select 'seo'::text, 'onboarding'::text, true where p = 'Live' $$;
    insert into services values ('seo', 'SEO Growth');
    insert into clients values ('Acme', 'active', 'Onboarding', 'a@acme.com'), ('Live', 'active', 'Campaign Learning', 'live@live.com'),
                               ('Old', 'active', 'Onboarding', 'o@old.com');
    insert into client_services values ('Live', 'seo', 'onboarding', null);
    -- stands in for trg_notify_client_request: it fires on INSERT of any Client Request, archived or not
    create table alerts (client text, title text);
    create function note_alert() returns trigger language plpgsql as $$ begin
        if NEW.type = 'Client Request' then insert into alerts values (NEW.client, NEW.title); end if; return NEW; end $$;
    create trigger trg_notify_client_request after insert on tasks for each row execute function note_alert();

    -- what exists before this change: visible handoff tasks, a hand-made request, and a look-alike that is not ours
    insert into tasks (client, title, type, stage, status) values
        ('Old', '${HANDOFF}', 'Client Request', 'Onboarding', 'Not Started'),
        ('Old', 'SEO Growth onboarding complete — ready to start', 'Client Request', 'Onboarding', 'Not Started'),
        ('Old', 'Please add a phone number to my site', 'Client Request', 'Onboarding', 'Not Started'),
        ('Old', 'Onboarding complete — ready for campaign build', 'Task', 'Onboarding', 'Not Started'),
        ('Old', 'SEO Growth onboarding complete — ready to start', 'Client Request', 'Campaign Learning', 'Not Started');
    delete from alerts;
`);
await db.exec(fs.readFileSync(path.join(here, 'onboarding_handoff_contact_gate.sql'), 'utf8'));
// 1. Apply the change. Capture the function body to confirm the archived inserts, then run it
const sql = fs.readFileSync(path.join(here, 'handoff_task_archived.sql'), 'utf8');
await db.exec(sql);
await db.exec(`create trigger trg_onboarding_handoff after insert or update of completed_at on client_onboarding_progress
               for each row when (NEW.completed_at is not null) execute function raise_onboarding_handoff_task();`);

// ---- The ones that already existed ----
let rows = await q(`select client, title, type, stage, status, archived_at is not null as archived from tasks where client = 'Old' order by id`);
ok(rows[0].archived && rows[0].status === 'Complete', 'an existing handoff task is archived and closed');
ok(rows[1].archived && rows[1].status === 'Complete', 'an existing add-on handoff task is archived and closed');
ok(!rows[2].archived && rows[2].status === 'Not Started', 'a request a person wrote is left alone');
ok(!rows[3].archived, 'a look-alike that is not a Client Request is left alone');
ok(!rows[4].archived, 'an add-on task outside the Onboarding stage is left alone');
ok((await q(`select count(*)::int n from alerts`))[0].n === 0, 'archiving them texts nobody (an UPDATE fires no alert)');

// ---- A client finishing now ----
await db.exec(`insert into client_onboarding_progress values ('Acme', 'a', now(), null)`);
ok((await q(`select count(*)::int n from tasks where client = 'Acme'`))[0].n === 0, 'nothing is raised before the last step');
await db.exec(`insert into client_onboarding_progress values ('Acme', 'b', now(), null)`);
let t = await q(`select title, type, status, assignee, archived_at is not null as archived, archived_by from tasks where client = 'Acme'`);
ok(t.length === 1 && t[0].title === HANDOFF && t[0].type === 'Client Request', 'the handoff task is still raised');
ok(t[0].archived && t[0].archived_by === 'Golden Eye' && t[0].status === 'Complete', 'but archived and Complete from the start');
ok((await q(`select count(*)::int n from alerts where client = 'Acme' and title = '${HANDOFF}'`))[0].n === 1, 'the admin alert still fires on the insert');
const calls = async () => q(`select url, body from net.calls`);
let c = await calls();
ok(c.length === 1 && /ghl-contact-check$/.test(c[0].url) && c[0].body.client === 'Acme', 'the client text still goes through the contact check, once');

// Untick and tick again: the archived row is the "already announced" marker, so no second task, alert or text
await db.exec(`update client_onboarding_progress set completed_at = null where client_name = 'Acme' and step_id = 'b'`);
await db.exec(`update client_onboarding_progress set completed_at = now() where client_name = 'Acme' and step_id = 'b'`);
ok((await q(`select count(*)::int n from tasks where client = 'Acme'`))[0].n === 1, 'ticking the last step again raises nothing new');
ok((await q(`select count(*)::int n from alerts where client = 'Acme'`))[0].n === 1 && (await calls()).length === 1, 'and sends no second alert or text');

// ---- An add-on on a client past onboarding ----
await db.exec(`insert into client_onboarding_progress values ('Live', 'a', now(), null)`);
t = await q(`select title, status, archived_at is not null as archived from tasks where client = 'Live'`);
ok(t.length === 1 && t[0].title === 'SEO Growth onboarding complete — ready to start' && t[0].archived && t[0].status === 'Complete',
    'the add-on version is archived and Complete too: ' + JSON.stringify(t));
ok((await q(`select status from client_services where client_name = 'Live'`))[0].status === 'active', 'and the add-on is still marked active');
ok((await calls()).length === 1, 'an add-on never texts the client');
await db.exec(`insert into client_onboarding_progress values ('Live', 'b', now(), null)`);
ok((await q(`select count(*)::int n from tasks where client = 'Live'`))[0].n === 1, 'the add-on task is raised once');

// ---- Re-running the file changes nothing ----
const before = JSON.stringify(await q(`select client, title, status, archived_at is not null a from tasks order by id`));
await db.exec(sql);
ok(JSON.stringify(await q(`select client, title, status, archived_at is not null a from tasks order by id`)) === before, 're-runs cleanly');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
