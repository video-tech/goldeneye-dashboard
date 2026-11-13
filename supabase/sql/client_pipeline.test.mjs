// Runs supabase/sql/client_pipeline.sql twice in PGlite: the pipeline stays empty until the client switches it on, only
// tagged leads are added, once per contact, and only someone who can see the client can switch it.
//   PGLITE_DIR=/path/to/dir node supabase/sql/client_pipeline.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.PGLITE_DIR) { console.log('Set PGLITE_DIR to a folder with @electric-sql/pglite installed.'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(path.join(process.env.PGLITE_DIR, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const db = new PGlite();
await db.exec(`
create role authenticated; create role anon; create role service_role;
create schema auth;
create table auth.me (uid uuid, email text);
create function auth.uid() returns uuid language sql as $$ select uid from auth.me limit 1 $$;
create table clients (name text, created_at timestamptz default now(), lead_tags text[], website_lead_tags text[]);
create table ghl_contacts (ghl_contact_id text, client_name text, tags text[]);
create table client_leads (id uuid default gen_random_uuid(), client_name text not null, lead_name text not null, lead_phone text,
  lead_email text, source text default 'Facebook Ads', stage text default 'New Lead', created_at timestamptz default now());
create function client_row_visible(p text) returns boolean language sql as $$ select exists (select 1 from auth.me where email = lower(p) || '@x.com') $$;
insert into clients (name, lead_tags, website_lead_tags) values ('A', null, null), ('B', array['Quiz Ads'], array['site form']), ('C', null, null);
insert into ghl_contacts values ('c1','A',array['ge lead','quiz ads ge']), ('c2','A',array['website lead','ge lead']), ('c3','A',array['newsletter']),
  ('c4','B',array['quiz ads']), ('c5','B',array['ge lead']), ('c6','B',array['site form']);`);
const sql = fs.readFileSync(path.join(here, 'client_pipeline.sql'), 'utf8');
await db.exec(sql);
await db.exec(sql); // re-runnable
const q = async (s, p) => (await db.query(s, p)).rows;
const add = async (client, contact, name = 'Jane Doe', phone = '+18015550100', email = 'Jane@Example.com') =>
    (await q(`select add_pipeline_lead($1,$2,$3,$4,$5) r`, [client, contact, name, phone, email]))[0].r;
const leads = async (c) => q(`select ghl_contact_id, lead_name, lead_phone, lead_email, source, stage from client_leads where client_name=$1 order by ghl_contact_id`, [c]);

// Off by default
ok(await add('A', 'c1') === false && (await leads('A')).length === 0, 'nothing added while the pipeline is off');

// Switching: signed out, someone else, then the client
await db.exec(`delete from auth.me`);
let err = ''; try { await q(`select set_client_pipeline('A', true)`); } catch (e) { err = e.message; }
ok(/Sign in/.test(err), 'signed out cannot switch it');
await db.exec(`insert into auth.me values ('00000000-0000-0000-0000-000000000001', 'b@x.com')`);
err = ''; try { await q(`select set_client_pipeline('A', true)`); } catch (e) { err = e.message; }
ok(/Not your account/.test(err), 'another client cannot switch it');
await db.exec(`update auth.me set email = 'a@x.com'`);
const on = (await q(`select set_client_pipeline('A', true) v`))[0].v;
ok(on, 'the client switches it on');
const again = (await q(`select set_client_pipeline('A', true) v`))[0].v;
ok(String(on) === String(again), 'switching on twice keeps the first date');

// Leads
ok(await add('A', 'c1') === true, 'a ge lead contact is added');
ok(await add('A', 'c1') === false && (await leads('A')).length === 1, 'the same contact never twice');
ok(await add('A', 'c2') === true, 'a website lead is added');
ok(await add('A', 'c3') === false, 'a contact without a lead tag is not');
ok(await add('A', 'c9') === false, 'a contact not recorded yet is not');
const a = await leads('A');
ok(a[0].source === 'Ads' && a[1].source === 'Website', 'source from the tags, website winning');
ok(a[0].lead_name === 'Jane Doe' && a[0].lead_phone === '+18015550100' && a[0].lead_email === 'jane@example.com' && a[0].stage === 'New Lead', 'name, phone, lower-case email, New Lead');
await db.exec(`insert into ghl_contacts values ('c7','A',array['ge lead'])`);
await add('A', 'c7', '', '+18015550111', '');
ok((await leads('A')).find(r => r.ghl_contact_id === 'c7').lead_name === '+18015550111', 'no name: the phone stands in');

// A client with its own tags
await db.exec(`update auth.me set email = 'b@x.com'`);
await q(`select set_client_pipeline('B', true)`);
ok(await add('B', 'c4') === true && await add('B', 'c6') === true, "the client's own tags count (case-insensitive)");
ok(await add('B', 'c5') === false, "the default tag doesn't, once they set their own");

// Off again
await q(`select set_client_pipeline('B', false)`);
await db.exec(`insert into ghl_contacts values ('c8','B',array['quiz ads'])`);
ok(await add('B', 'c8') === false && (await leads('B')).length === 2, 'switched off: nothing new, the old leads stay');
ok(await add('C', 'c1') === false, 'a client that never switched it on gets nothing');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
