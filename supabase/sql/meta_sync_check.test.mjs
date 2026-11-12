// Runs supabase/sql/meta_sync_check.sql in PGlite: who counts as behind, the message, the text, and who can run it.
//   PGLITE_DIR=/path/to/dir node supabase/sql/meta_sync_check.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.PGLITE_DIR) { console.log('Set PGLITE_DIR to a folder with @electric-sql/pglite installed.'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(path.join(process.env.PGLITE_DIR, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const db = new PGlite();
const today = (await db.query(`select (now() at time zone 'America/Denver')::date d`)).rows[0].d;
const ymd = (offset) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema vault; create table vault.decrypted_secrets (name text, decrypted_secret text);
    insert into vault.decrypted_secrets values ('make_onboarding_hook_secret', 's3cret');
    create schema net; create table net.sent (url text, body jsonb);
    create function net.http_post(url text, headers jsonb, body jsonb) returns bigint language sql as $$ insert into net.sent values (url, body) returning 1::bigint $$;
    create schema cron; create table cron.job (jobname text, schedule text, command text);
    create function cron.schedule(n text, s text, c text) returns int language sql as $$ insert into cron.job values (n, s, c) returning 1 $$;
    create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
    create table clients (name text, status text);
    create table meta_sync_state (client_name text, last_window text, last_error text);
    insert into clients values ('Current','active'), ('Behind','active'), ('Partial','active'), ('Never','active'), ('Paused','paused'), ('Errored','active');
    insert into meta_sync_state values
      ('Current', '${ymd(-8)}..${ymd(-1)}', null),
      ('Behind',  '${ymd(-9)}..${ymd(-2)}', null),
      ('Partial', '${ymd(-8)}..${ymd(-1)}', 'partial: 1 window(s) not loaded'),
      ('Never',   null, 'OAuthException 200: no access'),
      ('Paused',  '${ymd(-20)}..${ymd(-13)}', null),
      ('Errored', '${ymd(-10)}..${ymd(-3)}', 'OAuthException 200: (#200) "access" removed');
`);
const sql = fs.readFileSync(path.join(here, 'meta_sync_check.sql'), 'utf8');
await db.exec(sql);
await db.exec(sql); // re-runnable
const run = async (send) => (await db.query(`select meta_sync_check(${send}) r`)).rows[0].r;

let r = await run(false);
const names = r.behind.map((x) => x.split(' (')[0]);
ok(names.join() === 'Behind,Errored,Partial', 'behind, errored and partial clients, nobody else: ' + names.join());
ok(/Behind \(last synced to /.test(r.message) && /Partial \(some days missing\)/.test(r.message) && /OAuthException 200/.test(r.message), 'says why for each');
ok(!/["\\\n]/.test(r.message), 'one line, no quotes or backslashes (Make raw text)');
ok((await db.query(`select count(*)::int n from net.sent`)).rows[0].n === 0, 'test mode sends nothing');

r = await run(true);
const sent = (await db.query(`select * from net.sent`)).rows;
ok(r.texted && sent.length === 1 && sent[0].body.secret === 's3cret' && sent[0].body.recipients[0].phone === '+18017098501', 'texts Tenny once, with the secret');

await db.exec(`update meta_sync_state set last_window = '${ymd(-8)}..${ymd(-1)}', last_error = null`);
r = await run(true);
ok(r.behind.length === 0 && !r.texted && (await db.query(`select count(*)::int n from net.sent`)).rows[0].n === 1, 'all caught up: no text');

ok((await db.query(`select count(*)::int n from cron.job where jobname = 'meta-sync-check'`)).rows[0].n === 1, 'scheduled once');
const priv = (role) => db.query(`select has_function_privilege('${role}', 'meta_sync_check(boolean)', 'execute') p`).then((x) => x.rows[0].p);
ok(!(await priv('anon')) && !(await priv('authenticated')), 'only the schedule can run it');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
