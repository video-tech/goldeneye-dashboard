// Runs supabase/sql/seo_website_leads.sql in PGlite and checks the counts, the paid exclusion, Denver days,
// the per-client tracking start and RLS (security invoker).
//   PGLITE_DIR=/path/to/dir node supabase/sql/seo_website_leads.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pgliteDir = process.env.PGLITE_DIR;
if (!pgliteDir) { console.log('Set PGLITE_DIR to a folder with @electric-sql/pglite installed.'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(path.join(pgliteDir, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const db = new PGlite();
await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create function client_row_visible(p text) returns boolean language sql stable as $$
        select p = any (string_to_array(coalesce(current_setting('test.visible', true), ''), ',')) $$;
    create table lead_sources (ghl_contact_id text primary key, client_name text, source text, created_at timestamptz);
    alter table lead_sources enable row level security;
    create policy r on lead_sources for select using (client_row_visible(client_name));
    grant select on lead_sources to authenticated;
    insert into lead_sources values
      ('a1','PANDEN','unknown','2024-01-04 18:50+00'),
      ('a2','PANDEN','unknown','2026-10-20 14:00+00'),
      ('a3','PANDEN','organic','2026-10-21 14:00+00'),
      ('a4','PANDEN','paid','2026-10-21 14:00+00'),
      ('a5','PANDEN','unknown','2026-10-14 15:00+00'),
      ('a6','PANDEN','unknown','2026-10-27 03:00+00'),  -- Oct 26 in Denver
      ('a7','PANDEN',null,'2026-10-22 14:00+00'),
      ('b1','Late','organic','2026-10-20 14:00+00'),
      ('c1','OnlyPaid','paid','2025-01-01 14:00+00');
`);
await db.exec(fs.readFileSync(path.join(here, 'seo_website_leads.sql'), 'utf8').replace(/notify pgrst[^;]*;/, ''));

const q = async (client, a, b, c, d) => (await db.query(`select * from seo_website_leads($1,$2,$3,$4,$5)`, [client, a, b, c, d])).rows[0];
const ymd = v => v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

let r = await q('PANDEN', '2026-10-19', '2026-10-25', '2026-10-12', '2026-10-18');
ok(Number(r.website_leads) === 3, `week counts unknown + organic + null source, not paid (got ${r.website_leads})`);
ok(Number(r.prior_website_leads) === 1, 'prior week counts its own lead');
ok(ymd(r.tracking_start) === '2024-01-04', `tracking starts at the backfilled first lead (got ${ymd(r.tracking_start)})`);

r = await q('PANDEN', '2026-10-26', '2026-10-26', '2026-10-25', '2026-10-25');
ok(Number(r.website_leads) === 1, 'a 03:00 UTC lead counts on the Denver day before');

r = await q('Late', '2026-10-19', '2026-10-25', '2026-10-12', '2026-10-18');
ok(ymd(r.tracking_start) === '2026-09-11', 'a client whose first lead came later still starts at 2026-09-11');
r = await q('Nobody', '2026-10-19', '2026-10-25', '2026-10-12', '2026-10-18');
ok(Number(r.website_leads) === 0 && ymd(r.tracking_start) === '2026-09-11', 'no leads: zero and the global start');
r = await q('OnlyPaid', '2024-12-01', '2025-01-31', '2024-10-01', '2024-11-30');
ok(Number(r.website_leads) === 0 && ymd(r.tracking_start) === '2026-09-11', 'paid leads neither count nor move the start');

await db.exec(`set role authenticated; set test.visible = 'Late';`);
r = await q('PANDEN', '2026-10-19', '2026-10-25', '2026-10-12', '2026-10-18');
ok(Number(r.website_leads) === 0, 'RLS: a client who cannot see PANDEN counts nothing');
r = await q('Late', '2026-10-19', '2026-10-25', '2026-10-12', '2026-10-18');
ok(Number(r.website_leads) === 1, 'RLS: their own leads count');
await db.exec(`reset role;`);

const anonCan = (await db.query(`select has_function_privilege('anon', 'seo_website_leads(text,date,date,date,date)', 'execute') as x`)).rows[0].x;
ok(anonCan === false, 'anon cannot execute it');

await db.exec(fs.readFileSync(path.join(here, 'seo_website_leads.sql'), 'utf8').replace(/notify pgrst[^;]*;/, ''));
ok(true, 're-runs cleanly');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
