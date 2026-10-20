// Tests for onboarding_handoff_contact_gate.sql: the onboarding trigger asks the GHL contact check (not Make) when a
// client finishes. Runs the real function in PGlite, with net.http_post and Vault stood in.
// Run: PGLITE_DIR=<folder with node_modules/@electric-sql/pglite 0.2.x> node supabase/sql/onboarding_handoff_contact_gate.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { PGlite } = await import(pathToFileURL(path.join(process.env.PGLITE_DIR, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href);
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const db = new PGlite();
const q = async (t) => (await db.query(t)).rows;

await db.exec(`
    create schema net; create schema vault;
    create table net.calls (url text, headers jsonb, body jsonb);
    create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int default 5000) returns bigint
        language sql as $$ insert into net.calls values (url, headers, body); select 1::bigint $$;
    create table vault.secrets (name text, secret text);
    create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
    insert into vault.secrets values ('make_onboarding_hook_secret', 's3cret');
    create table clients (name text, status text, current_stage text, client_email text);
    create table tasks (id serial, client text, title text, type text, stage text, status text, assignee text, p int, u int, e int, score int, due date, notes text, updated_at timestamptz);
    create table client_services (client_name text, service_key text, status text, onboarded_at timestamptz);
    create table services (key text, name text);
    create table client_onboarding_progress (client_name text, step_id text, completed_at timestamptz, completed_by text);
    -- two client steps per client; done = a completed progress row exists
    create function onboarding_steps_for_client(p text) returns table (step_id text, owner text, completed boolean) language sql as $$
        select s, 'client', exists (select 1 from client_onboarding_progress pr where pr.client_name = p and pr.step_id = s and pr.completed_at is not null)
        from unnest(array['a','b']) s $$;
    create function service_onboarding_status(p text) returns table (service_key text, status text, complete boolean) language sql as $$ select null::text, null::text, false where false $$;
    insert into clients values ('Acme', 'active', 'Onboarding', ' Owner@Acme.com , other@acme.com'),
                               ('NoMail', 'active', 'Onboarding', null),
                               ('Live', 'active', 'Campaign Learning', 'live@live.com');
    insert into client_services values ('Acme', 'ads', 'onboarding', null);
`);
await db.exec(fs.readFileSync(path.join(here, 'onboarding_handoff_contact_gate.sql'), 'utf8'));
await db.exec(`create trigger trg_onboarding_handoff after insert or update of completed_at on client_onboarding_progress
               for each row when (NEW.completed_at is not null) execute function raise_onboarding_handoff_task();`);

const calls = async () => q(`select url, headers, body from net.calls`);

await db.exec(`insert into client_onboarding_progress values ('Acme', 'a', now(), null)`);
ok((await calls()).length === 0, 'nothing is sent before the last step');
await db.exec(`insert into client_onboarding_progress values ('Acme', 'b', now(), null)`);
let c = await calls();
ok(c.length === 1 && c[0].url === 'https://hugnttsqucetldllfgoi.supabase.co/functions/v1/ghl-contact-check', 'the last step asks the GHL contact check, not Make');
ok(!c.some((x) => /hook\.us2\.make\.com/.test(x.url)), 'nothing goes straight to Make any more');
ok(c[0].headers['x-cron-secret'] === 's3cret' && !('secret' in c[0].body), 'the secret travels as the cron header, not in the body');
ok(c[0].body.mode === 'handoff' && c[0].body.client === 'Acme' && c[0].body.client_email === 'Owner@Acme.com' && JSON.stringify(c[0].body.services) === '["ads"]',
    'the body carries the client, their first email with spaces removed, and their add-ons');
ok((await q(`select count(*)::int n from tasks where title = 'Onboarding complete — ready for campaign build'`))[0].n === 1, 'the handoff task is still raised');
await db.exec(`update client_onboarding_progress set completed_at = now() where client_name = 'Acme' and step_id = 'a'`);
ok((await calls()).length === 1, 'a repeat completion sends nothing more');

await db.exec(`insert into client_onboarding_progress values ('NoMail', 'a', now(), null), ('NoMail', 'b', now(), null)`);
c = await calls();
ok(c.length === 2 && c[1].body.client === 'NoMail', 'a client with no email still reaches the check, so their "not sent" task is raised');

await db.exec(`insert into client_onboarding_progress values ('Live', 'a', now(), null), ('Live', 'b', now(), null)`);
ok((await calls()).length === 2, 'a client past onboarding is not sent (add-ons get a task, never a text)');

await db.exec(`insert into clients values ('Back', 'active', 'Onboarding', 'b@back.com'); insert into client_onboarding_progress values ('Back', 'a', now(), 'backfilled'), ('Back', 'b', now(), 'backfilled')`);
ok((await calls()).length === 2, 'backfilled steps never send');

await db.exec(`delete from vault.secrets; insert into clients values ('NoSecret', 'active', 'Onboarding', 'n@n.com');
               insert into client_onboarding_progress values ('NoSecret', 'a', now(), null), ('NoSecret', 'b', now(), null)`);
ok((await calls()).length === 2 && (await q(`select count(*)::int n from tasks where client = 'NoSecret'`))[0].n === 1, 'with the Vault secret missing nothing is sent, but the handoff task still appears');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
