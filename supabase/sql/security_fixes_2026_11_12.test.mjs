// Runs supabase/sql/security_fixes_2026_11_12.sql in PGlite against the live policy shape, then signs in as an admin, a
// portal client and a brand-new pending user to check who can do what. The old policies are the control.
//   PGLITE_DIR=/path/to/dir node supabase/sql/security_fixes_2026_11_12.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.PGLITE_DIR) { console.log('Set PGLITE_DIR to a folder with @electric-sql/pglite installed.'); process.exit(2); }
const { PGlite } = await import(pathToFileURL(path.join(process.env.PGLITE_DIR, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

async function world(applyFix) {
    const db = new PGlite();
    await db.exec(`
        create role anon nologin; create role authenticated nologin;
        create schema auth;
        create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
        create function auth.email() returns text language sql stable as $$ select auth.jwt() ->> 'email' $$;
        create table user_profiles (email text, role text, full_name text);
        create table user_client_access (user_email text, client_name text);
        create table pre_approved_users (email text, role text, client_access jsonb);
        create table clients (name text, client_email text);
        create function current_user_is_admin() returns boolean language sql stable security definer as $$
            select exists (select 1 from user_profiles p where lower(p.email) = lower(coalesce(auth.jwt() ->> 'email','')) and p.role = 'admin') $$;
        create function current_user_is_staff() returns boolean language sql stable security definer as $$
            select exists (select 1 from user_profiles p where lower(p.email) = lower(coalesce(auth.jwt() ->> 'email','')) and p.role in ('admin','member')) $$;
        create function client_row_visible(p_client text) returns boolean language sql stable security definer as $$
            select current_user_is_admin() or exists (select 1 from clients c where c.name = p_client and lower(auth.email()) = any(string_to_array(lower(c.client_email), ','))) $$;
        create function send_weekly_checkin_reminders() returns void language sql security definer as $$ select $$;
        create function onboarding_client_facts(p text) returns jsonb language sql security definer as $$ select '{}'::jsonb $$;
        create function handle_new_user() returns trigger language plpgsql security definer as $$ begin return new; end $$;
        create function notify_admins_client_request() returns trigger language plpgsql security definer as $$ begin return new; end $$;
        create function notify_new_client_welcome() returns trigger language plpgsql security definer as $$ begin return new; end $$;
        create function raise_onboarding_handoff_task() returns trigger language plpgsql security definer as $$ begin return new; end $$;
        create function rls_auto_enable() returns event_trigger language plpgsql security definer as $$ begin end $$;
        create table onboarding_steps (id int, title text); create table stage_templates (id int, task_title text);
        create table morning_audits (id int, html_body text);
        create table ad_approvals (id int, client_name text, status text);
        create table client_leads (id int, client_name text, lead_name text);
        create table client_health (client_name text, current_score int); create table health_logs (client_name text, score int);
        create table client_milestones (client_name text, milestone_id int);
        create table health_settings (id int, churn_threshold int); create table milestone_config (id int, name text);
        create table seo_metrics (client_name text, clicks int);
        create table client_estimates (id int, client_email text); create table client_jobs (id int, client_email text);
        create schema storage; create table storage.objects (bucket_id text, name text);
        insert into user_profiles values ('boss@midas.com','admin','Boss'), ('a@acme.com','client','A'), ('new@x.com','pending','N');
        insert into user_client_access values ('a@acme.com','Acme');
        insert into clients values ('Acme','a@acme.com'), ('Other','o@other.com');
        insert into pre_approved_users values ('invitee@acme.com','client','["Acme"]');
        insert into onboarding_steps values (1,'Welcome'); insert into stage_templates values (1,'Step');
        insert into morning_audits values (1,'<p>all clients</p>');
        insert into ad_approvals values (1,'Acme','pending'), (2,'Other','pending');
        insert into client_leads values (1,'Acme','Jane'), (2,'Other','Bob');
        insert into client_health values ('Acme',80), ('Other',40); insert into seo_metrics values ('Acme',5), ('Other',9);
        insert into health_settings values (1,40); insert into milestone_config values (1,'Launch');
    `);
    // The live "true" policies, as found 2026-11-12
    const open = {
        pre_approved_users: ['Allow authenticated users to manage pre-approved users:all', 'Allow authenticated users to read pre-approved users:select'],
        user_profiles: ['Allow Auth Read Profiles:select'], user_client_access: ['Allow Auth Read Access:select'],
        onboarding_steps: ['Auth manage onboarding steps:all'], stage_templates: ['Auth manage stage templates:all'],
        morning_audits: ['Allow authenticated full access:all'],
        ad_approvals: ['Allow authenticated users full access to ad_approvals:all', 'Auth Read Approvals:select'],
        client_leads: ['Allow authenticated users to manage client leads:all', 'Auth Read Leads:select'],
        client_health: ['Team Access Health:all', 'Auth Read Health:select'], health_logs: ['Team Access Logs:all'],
        client_milestones: ['Team Access Client Milestones:all'], health_settings: ['Team Access Settings:all'],
        milestone_config: ['Team Access Milestone Config:all'], seo_metrics: ['Auth Read SEO:select'],
        client_estimates: ['Allow authenticated inserts:insert', 'Auth Read Estimates:select'],
        client_jobs: ['Allow authenticated inserts:insert', 'Auth Read Jobs:select'],
    };
    for (const [t, pols] of Object.entries(open)) {
        await db.exec(`alter table ${t} enable row level security; grant all on ${t} to authenticated;`);
        for (const p of pols) {
            const [name, cmd] = p.split(':');
            const clause = cmd === 'insert' ? 'with check (true)' : cmd === 'select' ? 'using (true)' : 'using (true) with check (true)';
            await db.exec(`create policy "${name}" on ${t} for ${cmd} to authenticated ${clause}`);
        }
    }
    await db.exec(`create policy "read own profile" on user_profiles for select to authenticated using (lower(email) = lower(coalesce(auth.jwt() ->> 'email','')));
        create policy "admins manage profiles" on user_profiles for all to authenticated using (current_user_is_admin()) with check (current_user_is_admin());
        grant usage on schema storage to authenticated; alter table storage.objects enable row level security; grant all on storage.objects to authenticated;
        create policy "Allow team uploads" on storage.objects for insert to authenticated with check (bucket_id = 'ad-creatives');`);
    if (applyFix) {
        const sql = fs.readFileSync(path.join(here, 'security_fixes_2026_11_12.sql'), 'utf8');
        await db.exec(sql);
        await db.exec(sql); // re-runnable
    }
    return db;
}

async function as(db, email, fn) {
    await db.exec(`set role authenticated; set test.jwt = '${JSON.stringify(email ? { email } : {})}'`);
    try { return await fn(); } finally { await db.exec(`reset role; reset test.jwt`); }
}
const n = async (db, q) => (await db.query(q)).rows.length;
const tryRun = async (db, q) => { try { const r = await db.query(q); return r.affectedRows ?? r.rows.length; } catch { return -1; } };

for (const fixed of [false, true]) {
    const db = await world(fixed);
    const label = (s) => (fixed ? '' : 'OLD (control): ') + s;
    // The escalation: a pending sign-up adds an admin pre-approval for a second email
    const esc = await as(db, 'new@x.com', () => tryRun(db, `insert into pre_approved_users values ('evil@x.com','admin','[]')`));
    ok(fixed ? esc === -1 : esc === 1, label('a pending user cannot pre-approve an admin'));
    const ownInvite = await as(db, 'invitee@acme.com', () => n(db, `select * from pre_approved_users`));
    if (fixed) ok(ownInvite === 1, 'an invited person still reads their own invite at sign-in');
    if (fixed) ok(await as(db, 'boss@midas.com', () => tryRun(db, `insert into pre_approved_users values ('vip@acme.com','client','[]')`)) === 1, 'admins still invite');

    // Client A
    const leads = await as(db, 'a@acme.com', () => n(db, `select * from client_leads`));
    ok(fixed ? leads === 1 : leads === 2, label('a client sees only its own leads'));
    const appr = await as(db, 'a@acme.com', () => n(db, `select * from ad_approvals`));
    ok(fixed ? appr === 1 : appr === 2, label('a client sees only its own ad approvals'));
    if (fixed) {
        ok(await as(db, 'a@acme.com', () => tryRun(db, `update ad_approvals set status='approved' where id=1`)) === 1, 'a client can approve its own ad');
        ok(await as(db, 'a@acme.com', () => tryRun(db, `update ad_approvals set status='approved' where id=2`)) === 0, 'but not another client\'s');
        ok(await as(db, 'a@acme.com', () => tryRun(db, `insert into client_leads values (3,'Acme','New')`)) === 1, 'a client adds its own lead');
        ok(await as(db, 'a@acme.com', () => tryRun(db, `insert into client_leads values (4,'Other','X')`)) === -1, 'but not under another client');
    }
    const audits = await as(db, 'a@acme.com', () => n(db, `select * from morning_audits`));
    ok(fixed ? audits === 0 : audits === 1, label('a client cannot read the morning audits'));
    const stepEdit = await as(db, 'a@acme.com', () => tryRun(db, `update onboarding_steps set title='hacked'`));
    ok(fixed ? stepEdit === 0 : stepEdit === 1, label('a client cannot rewrite onboarding steps'));
    if (fixed) ok(await as(db, 'a@acme.com', () => n(db, `select * from onboarding_steps`)) === 1, 'but still reads them for the portal');
    const profiles = await as(db, 'a@acme.com', () => n(db, `select * from user_profiles`));
    ok(fixed ? profiles === 1 : profiles === 3, label('a client sees only its own profile'));
    const health = await as(db, 'a@acme.com', () => n(db, `select * from client_health`));
    ok(fixed ? health === 1 : health === 2, label('a client sees only its own health score'));
    const seo = await as(db, 'a@acme.com', () => n(db, `select * from seo_metrics`));
    ok(fixed ? seo === 1 : seo === 2, label('a client sees only its own SEO rows'));
    const upload = await as(db, 'a@acme.com', () => tryRun(db, `insert into storage.objects values ('ad-creatives','x.png')`));
    ok(fixed ? upload === -1 : upload === 1, label('a client cannot upload ad creatives'));

    if (fixed) {
        // Admins keep everything
        ok(await as(db, 'boss@midas.com', () => n(db, `select * from client_leads`)) >= 2, 'admins see every lead');
        ok(await as(db, 'boss@midas.com', () => n(db, `select * from morning_audits`)) === 1, 'admins read audits');
        ok(await as(db, 'boss@midas.com', () => tryRun(db, `update onboarding_steps set title='Welcome!'`)) === 1, 'admins edit steps');
        ok(await as(db, 'boss@midas.com', () => n(db, `select * from user_profiles`)) === 3, 'admins see every profile');
        ok(await as(db, 'boss@midas.com', () => tryRun(db, `insert into storage.objects values ('ad-creatives','y.png')`)) === 1, 'admins upload creatives');
        const priv = async (role, fn) => (await db.query(`select has_function_privilege('${role}', '${fn}', 'execute') p`)).rows[0].p;
        ok(!(await priv('anon', 'send_weekly_checkin_reminders()')) && !(await priv('authenticated', 'send_weekly_checkin_reminders()')), 'nobody signed in, and not the public key, can send check-in texts');
        ok(!(await priv('authenticated', 'onboarding_client_facts(text)')), 'onboarding_client_facts is internal only');
        ok(await as(db, 'a@acme.com', () => n(db, `select * from health_settings`)) === 1, 'settings stay readable');
    }
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
