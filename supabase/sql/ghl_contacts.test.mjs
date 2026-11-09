// Runs supabase/sql/ghl_contacts.sql in PGlite: record_ghl_contact merges tags across events, keeps the first created
// date, and only admins can read the table.
//   PGLITE_DIR=/path/to/dir node supabase/sql/ghl_contacts.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pgliteDir = process.env.PGLITE_DIR;
if (!pgliteDir) { console.log('Set PGLITE_DIR to a folder with @electric-sql/pglite installed.'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(path.join(pgliteDir, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const sql = fs.readFileSync(path.join(here, 'ghl_contacts.sql'), 'utf8');

const db = new PGlite();
await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create function current_user_is_admin() returns boolean language sql stable as $$
        select coalesce(current_setting('test.admin', true), '') = 'on' $$;
`);
await db.exec(sql);
await db.exec(sql); // re-runnable

const rec = (id, client, created, tags, source = null) =>
    db.query(`select record_ghl_contact($1, $2, 'L1', $3::timestamptz, $4::text[], $5)`, [id, client, created, tags, source]);
const row = async (id, client = 'Acme') => (await db.query(`select * from ghl_contacts where ghl_contact_id = $1 and client_name = $2`, [id, client])).rows[0];

await rec('c1', 'Acme', '2026-11-03T16:00:00Z', [], 'facebook form');          // Contact Created: no tags yet
await rec('c1', 'Acme', '2026-11-03T16:00:05Z', ['FB Lead', ' '], null);        // Tag added a moment later
await rec('c1', 'Acme', '2026-11-04T10:00:00Z', ['quiz', 'fb lead'], 'other');  // another tag the next day
let r = await row('c1');
ok(JSON.stringify(r.tags) === '["fb lead","quiz"]', 'tags merged, lower-cased, blanks dropped, no repeats');
ok(new Date(r.created_at).toISOString() === '2026-11-03T16:00:00.000Z', 'the first created date is kept');
ok(r.source === 'facebook form', 'the first source is kept');
ok((await db.query(`select count(*)::int n from ghl_contacts`)).rows[0].n === 1, 'one row per contact per client');

await rec('c1', 'Other', '2026-11-03T16:00:00Z', ['x']);
ok((await row('c1', 'Other')).tags[0] === 'x' && (await row('c1')).tags.length === 2, 'a shared sub-account keeps one row per client');

await rec('c2', 'Acme', null, null);
ok((await row('c2')).created_at && (await row('c2')).tags.length === 0, 'missing date and tags are tolerated');

// Who can read
await db.exec(`alter table ghl_contacts force row level security; grant select on ghl_contacts to authenticated;`);
await db.exec(`set role authenticated`);
ok((await db.query(`select count(*)::int n from ghl_contacts`)).rows[0].n === 0, 'a non-admin reads nothing');
await db.exec(`set test.admin = 'on'`);
ok((await db.query(`select count(*)::int n from ghl_contacts`)).rows[0].n === 3, 'an admin reads every row');
await db.exec(`reset role; reset test.admin`);

// Who can write
const priv = (role) => db.query(`select has_function_privilege($1, 'record_ghl_contact(text,text,text,timestamptz,text[],text)', 'execute') p`, [role]).then((x) => x.rows[0].p);
ok(await priv('service_role'), 'the webhook (service role) can record');
ok(!(await priv('anon')) && !(await priv('authenticated')), 'the public key and signed-in users cannot');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
