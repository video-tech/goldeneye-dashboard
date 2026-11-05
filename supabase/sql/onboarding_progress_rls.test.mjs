// Runs supabase/sql/onboarding_progress_rls.sql in PGlite against the live policy it replaces, and checks who can
// read, tick, untick, add and delete onboarding progress.
//   PGLITE_DIR=/path/to/dir node supabase/sql/onboarding_progress_rls.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pgliteDir = process.env.PGLITE_DIR;
if (!pgliteDir) { console.log('Set PGLITE_DIR to a folder with @electric-sql/pglite installed.'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(path.join(pgliteDir, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const sql = fs.readFileSync(path.join(here, 'onboarding_progress_rls.sql'), 'utf8');

async function fresh() {
    const db = new PGlite();
    // test.visible: the clients this caller may see (client_row_visible); test.admin: 'on' for an admin
    await db.exec(`
        create role anon nologin; create role authenticated nologin;
        create function client_row_visible(p text) returns boolean language sql stable as $$
            select coalesce(current_setting('test.admin', true), '') = 'on'
                or p = any (string_to_array(coalesce(current_setting('test.visible', true), ''), ',')) $$;
        create function current_user_is_admin() returns boolean language sql stable as $$
            select coalesce(current_setting('test.admin', true), '') = 'on' $$;
        create table client_onboarding_progress (client_name text, step_id text, completed_at timestamptz,
            completed_by text, watch_percent int, primary key (client_name, step_id));
        alter table client_onboarding_progress enable row level security;
        create policy "Auth manage onboarding progress" on client_onboarding_progress for all to authenticated using (true) with check (true);
        grant select, insert, update, delete on client_onboarding_progress to authenticated;
        insert into client_onboarding_progress values
          ('Acme', 's1', now(), 'a@acme.com', null), ('Acme', 's2', null, null, 40),
          ('Other', 's1', now(), 'o@other.com', null);
    `);
    return db;
}

// What a caller can do. visible: comma list; admin: bool
async function as(db, { visible = '', admin = false }, fn) {
    await db.exec(`set role authenticated; set test.visible = '${visible}'; set test.admin = '${admin ? 'on' : 'off'}';`);
    try { return await fn(); } finally { await db.exec(`reset role; reset test.visible; reset test.admin;`); }
}
const count = async (db, where) => Number((await db.query(`select count(*) n from client_onboarding_progress where ${where}`)).rows[0].n);
const tryQ = async (db, q) => { try { const r = await db.query(q); return { rows: r.affectedRows ?? r.rows.length }; } catch (e) { return { error: e.message }; } };

// ---- Control: the old policy lets an Acme client touch Other's steps ----
{
    const db = await fresh();
    const r = await as(db, { visible: 'Acme' }, () => tryQ(db, `update client_onboarding_progress set completed_at = null where client_name = 'Other'`));
    ok(r.rows === 1, 'control: before the fix, an Acme client can untick Other\'s step');
}

const db = await fresh();
await db.exec(sql);

// ---- A client: their own steps only ----
await as(db, { visible: 'Acme' }, async () => {
    ok((await db.query(`select client_name from client_onboarding_progress`)).rows.every((r) => r.client_name === 'Acme'), 'a client reads only their own steps');
    ok((await tryQ(db, `update client_onboarding_progress set completed_at = null where client_name = 'Acme' and step_id = 's1'`)).rows === 1, 'a client can untick their own step');
    ok((await tryQ(db, `update client_onboarding_progress set completed_at = now() where client_name = 'Acme' and step_id = 's2'`)).rows === 1, 'a client can tick their own step');
    ok(!(await tryQ(db, `insert into client_onboarding_progress (client_name, step_id, completed_at) values ('Acme', 's3', now())`)).error, 'a client can add progress for their own step');
    ok((await tryQ(db, `update client_onboarding_progress set completed_at = null where client_name = 'Other'`)).rows === 0, 'a client cannot untick another client\'s step');
    ok(!!(await tryQ(db, `insert into client_onboarding_progress (client_name, step_id, completed_at) values ('Other', 's9', now())`)).error, 'a client cannot add progress under another client');
    ok(!!(await tryQ(db, `update client_onboarding_progress set client_name = 'Other' where client_name = 'Acme' and step_id = 's3'`)).error, 'a client cannot move their row to another client');
    ok((await tryQ(db, `delete from client_onboarding_progress where client_name = 'Acme'`)).rows === 0, 'a client cannot delete, even their own');
});
ok(await count(db, `client_name = 'Other' and completed_at is not null`) === 1, 'Other\'s step is untouched');
ok(await count(db, `client_name = 'Acme'`) === 3, 'Acme\'s rows are all still there');

// ---- Signed in with no client ----
await as(db, {}, async () => {
    ok((await db.query(`select * from client_onboarding_progress`)).rows.length === 0, 'someone with no client reads nothing');
    ok((await tryQ(db, `update client_onboarding_progress set completed_at = null`)).rows === 0, 'and changes nothing');
});

// ---- An admin: everything ----
await as(db, { admin: true }, async () => {
    ok((await db.query(`select * from client_onboarding_progress`)).rows.length === 4, 'an admin reads every client');
    ok((await tryQ(db, `update client_onboarding_progress set completed_at = null where client_name = 'Other'`)).rows === 1, 'an admin can untick any client\'s step');
    ok(!(await tryQ(db, `insert into client_onboarding_progress (client_name, step_id, completed_at, completed_by) values ('Other', 's2', now(), 'backfilled')`)).error, 'an admin can tick any client\'s step');
    ok((await tryQ(db, `delete from client_onboarding_progress where client_name = 'Acme' and step_id = 's3'`)).rows === 1, 'an admin can delete');
});

const policies = (await db.query(`select policyname from pg_policies where tablename = 'client_onboarding_progress' order by 1`)).rows.map((r) => r.policyname);
ok(policies.length === 4 && !policies.includes('Auth manage onboarding progress'), 'four policies, and the open one is gone: ' + policies.join(' | '));

await db.exec(sql);
ok((await db.query(`select count(*) n from pg_policies where tablename = 'client_onboarding_progress'`)).rows[0].n == 4, 're-runs cleanly');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
