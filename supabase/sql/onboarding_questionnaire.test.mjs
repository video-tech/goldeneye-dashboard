// Runs supabase/sql/onboarding_questionnaire.sql in PGlite (in-memory Postgres) and checks it.
// Needs PGlite 0.2.x installed somewhere (0.3.x crashes after an error raised in a function); point PGLITE_DIR at the folder holding node_modules:
//   PGLITE_DIR=/path/to/dir node supabase/sql/onboarding_questionnaire.test.mjs
// Supabase pieces (auth.email, vault, client_row_visible, current_user_is_admin) are stubbed with settings
// the test flips: test.email, test.admin ('true'), test.visible (comma list of client names).
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pgliteDir = process.env.PGLITE_DIR;
if (!pgliteDir) { console.log('Set PGLITE_DIR to a folder with @electric-sql/pglite 0.2.x installed.'); process.exit(2); }
const pgliteRoot = path.join(pgliteDir, 'node_modules', '@electric-sql', 'pglite');
const { PGlite } = await import(pathToFileURL(path.join(pgliteRoot, 'dist', 'index.js')).href);
// PGlite can't load pgcrypto here, so the three pgcrypto functions the SQL uses are stood in by a reversible
// stand-in with the same names and signatures (NOT real encryption: Supabase runs the real pgcrypto). What this
// test checks is the logic around them: who may save and reveal, that the stored bytes aren't the plain text, and
// that the key comes from Vault.
const PGCRYPTO_STANDIN = `
    create function extensions.gen_random_bytes(n int) returns bytea language sql as
        $$ select decode(substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, n * 2), 'hex') $$;
    create function extensions.pgp_sym_encrypt(v text, k text) returns bytea language sql as
        $$ select convert_to('ENC1:' || md5(k) || ':' || reverse(encode(convert_to(v, 'UTF8'), 'base64')), 'UTF8') $$;
    create function extensions.pgp_sym_decrypt(b bytea, k text) returns text language plpgsql as $$
    declare s text := convert_from(b, 'UTF8');
    begin
        if split_part(s, ':', 2) <> md5(k) then raise exception 'Wrong key.'; end if;
        return convert_from(decode(reverse(split_part(s, ':', 3)), 'base64'), 'UTF8');
    end $$;`;

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const throwsLike = async (fn, re, n) => { try { await fn(); ok(false, n + ' (did not throw)'); } catch (e) { ok(re.test(String(e.message)), n + ': ' + e.message); } };

const db = new PGlite();
await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema extensions;
    create schema auth;
    create function auth.email() returns text language sql stable as $$ select nullif(current_setting('test.email', true), '') $$;
    create schema vault;
    create table vault.secrets (name text primary key, secret text, description text);
    create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(p_secret text, p_name text, p_description text default null) returns void language sql as
        $$ insert into vault.secrets values (p_name, p_secret, p_description) $$;
    create function public.current_user_is_admin() returns boolean language sql stable as $$ select coalesce(current_setting('test.admin', true), '') = 'true' $$;
    create function public.client_row_visible(p text) returns boolean language sql stable as
        $$ select current_user_is_admin() or p = any(string_to_array(coalesce(current_setting('test.visible', true), ''), ',')) $$;
    grant usage on schema public, auth, extensions to authenticated, anon;
    grant execute on function auth.email(), public.current_user_is_admin(), public.client_row_visible(text) to authenticated;
    create table public.onboarding_steps (
        id uuid primary key default gen_random_uuid(), title text, description text, step_type text default 'action',
        owner text default 'client', active boolean default true, sort_order int default 0,
        service_keys text[] default '{}', website_statuses text[] default '{}', questions jsonb, fact_conditions jsonb default '{}'::jsonb);
    grant select on public.onboarding_steps to authenticated;
`);
await db.exec(PGCRYPTO_STANDIN);
const sql = fs.readFileSync(path.join(here, 'onboarding_questionnaire.sql'), 'utf8');
await db.exec(sql);
await db.exec(sql); // re-runnable
const q = async (text, params) => (await db.query(text, params)).rows;
const as = async ({ admin = false, visible = '', email = 'client@acme.com', role = null } = {}) => {
    await db.exec(`reset role; select set_config('test.admin', '${admin}', false), set_config('test.visible', '${visible}', false), set_config('test.email', '${email}', false);`);
    if (role) await db.exec(`set role ${role}`);
};

// ---- the steps ----
const steps = await q(`select id, title, active, sort_order, service_keys, website_statuses, questions from onboarding_steps order by sort_order, title`);
const byTitle = Object.fromEntries(steps.map((s) => [s.title, s]));
const titles = ['About your business', 'Registering your texting number', 'Calls, texts and your service area', 'Your jobs and offers', 'Access to your website', 'Your new website'];
ok(steps.length === 6 && titles.every((t) => byTitle[t]), 'six steps, inserted once even on a second run');
ok(byTitle['Your new website'].website_statuses.join() === 'new_build' && byTitle['Your new website'].service_keys.length === 0, 'new website: everyone whose site we build');
const styleQ = byTitle['Your new website'].questions.find((x) => x.type === 'style');
ok(styleQ && styleQ.styles.length === 4 && styleQ.styles.every((s) => s.name && s.colors.length === 4 && s.image === '' && s.link === ''), 'the style picker starts with 4 looks, pictures and links to be pasted in later');
ok(steps.every((s) => s.active === false), 'every step is switched off');
ok(byTitle['Your jobs and offers'].service_keys.join() === 'ads', 'jobs and offers: Ads clients only');
ok(byTitle['Access to your website'].service_keys.join() === 'seo' && byTitle['Access to your website'].website_statuses.join() === 'existing', 'website access: SEO clients keeping their own site');
for (const s of steps) {
    const qs = s.questions;
    ok(new Set(qs.map((x) => x.id)).size === qs.length, `${s.title}: question ids unique`);
    ok(qs.every((x) => (x.options || []).every((o) => !o.includes(','))), `${s.title}: no choice contains a comma`);
    qs.forEach((x, i) => {
        if (!x.show_if) return;
        const parent = qs.slice(0, i).find((p) => p.id === x.show_if.q);
        ok(parent && x.show_if.any.every((a) => parent.options.includes(a)), `${s.title}: "${x.label}" depends on an earlier question with those choices`);
        ok(!parent?.private && !parent?.secret, `${s.title}: "${x.label}" doesn't depend on a private answer (the portal can't read it back)`);
    });
    ok(qs.every((x) => x.dest), `${s.title}: every question says where it goes`);
}
const allQ = steps.flatMap((s) => s.questions.map((x) => ({ ...x, step: s.title })));
const privateIds = allQ.filter((x) => x.private || x.secret).map((x) => x.id).sort().join();
ok(privateIds === 'a_mobile,b_ein,b_legal,b_type,d_close,d_job_value,e_2fa_who,e_login_url,e_password,e_username', 'exactly the agreed questions are private: ' + privateIds);
ok(allQ.filter((x) => x.secret).map((x) => x.id).join() === 'e_password', 'only the password is encrypted');
ok(byTitle['Registering your texting number'].questions.every((x) => x.private), 'the whole texting-registration step is private');

const A = byTitle['About your business'].id, B = byTitle['Registering your texting number'].id, E = byTitle['Access to your website'].id;

// ---- saving private answers ----
await as({ visible: 'Acme Decks', role: 'authenticated' });
let r = await q(`select save_private_onboarding_answers('Acme Decks', $1, $2::jsonb) as saved`, [B, JSON.stringify({
    b_legal: { label: 'I typed my own label', value: 'Acme Decks LLC' }, b_type: { value: 'LLC' }, b_ein: '12-3456789',
    a_name: { value: 'should be ignored, not on this step' }, nope: { value: 'x' },
})]);
ok(JSON.stringify(r[0].saved.sort()) === JSON.stringify(['b_ein', 'b_legal', 'b_type']), 'saves the private answers, ignores unknown ones: ' + JSON.stringify(r[0].saved));
r = await q(`select save_private_onboarding_answers('Acme Decks', $1, $2::jsonb) as saved`, [A, JSON.stringify({ a_name: { value: 'Acme' }, a_mobile: { value: '801-555-0100' } })]);
ok(JSON.stringify(r[0].saved) === '["a_mobile"]', 'a public question is never stored privately, even if sent');
r = await q(`select save_private_onboarding_answers('Acme Decks', $1, $2::jsonb) as saved`, [B, JSON.stringify({ b_legal: { value: '   ' }, b_ein: { value: '98-7654321' } })]);
ok(JSON.stringify(r[0].saved) === '["b_ein"]', 'a blank answer is skipped');
r = await q(`select save_private_onboarding_answers('Acme Decks', $1, $2::jsonb) as saved`, [E, JSON.stringify({ e_username: { value: 'owner@acme.com' }, e_password: { value: 'hunter2-Secret!' } })]);
ok(JSON.stringify(r[0].saved.sort()) === '["e_password","e_username"]', 'website login saved');

// the client can't read any of it back
ok((await q(`select count(*)::int n from onboarding_private_answers`))[0].n === 0, 'a client reads no private answers, not even their own');
ok((await q(`select count(*)::int n from onboarding_secrets`))[0].n === 0, 'a client reads no secrets');
const keys = await q(`select step_id, question_id from private_onboarding_answer_keys('Acme Decks') order by question_id`);
ok(keys.map((k) => k.question_id).join() === 'a_mobile,b_ein,b_legal,b_type,e_password,e_username', 'the client learns which questions are answered, nothing more');
await throwsLike(() => q(`select reveal_onboarding_secret('Acme Decks', $1, 'e_password')`, [E]), /Only an admin/, 'a client cannot reveal a secret');
await throwsLike(() => q(`select save_private_onboarding_answers('Other Co', $1, '{"b_legal":{"value":"x"}}'::jsonb)`, [B]), /Not allowed/, 'saving for another client is refused');
await throwsLike(() => q(`select * from private_onboarding_answer_keys('Other Co')`), /Not allowed/, 'reading another client\'s keys is refused');
await throwsLike(() => q(`select onboarding_secret_key()`), /permission denied/, 'nobody but the functions can read the key');
await throwsLike(() => q(`insert into onboarding_private_answers (client_name, step_id, answers) values ('Acme Decks', $1, '{}')`, [B]), /permission denied|row-level security/, 'no direct writes to private answers');
await throwsLike(() => q(`select save_private_onboarding_answers('Acme Decks', $1, $2::jsonb)`, [B, JSON.stringify({ b_legal: { value: 'x'.repeat(2001) } })]), /too long/, 'an over-long answer is refused');

// ---- what an admin sees ----
await as({ admin: true, email: 'tenny@midasmediafirm.com', role: 'authenticated' });
const priv = await q(`select step_id, answers from onboarding_private_answers where client_name = 'Acme Decks'`);
const bRow = priv.find((p) => p.step_id === B);
ok(bRow.answers.b_legal.value === 'Acme Decks LLC' && bRow.answers.b_legal.label === 'Legal business name, exactly as on your EIN paperwork', 'stored with the step\'s own label, not the one sent');
ok(bRow.answers.b_ein.value === '98-7654321' && bRow.answers.b_type.value === 'LLC', 'a later answer replaces the earlier one; untouched answers stay');
const sec = await q(`select encode(value_enc, 'escape') as raw from onboarding_secrets where question_id = 'e_password'`);
ok(sec.length === 1 && !sec[0].raw.includes('hunter2'), 'the password is stored encrypted');
const shown = await q(`select reveal_onboarding_secret('Acme Decks', $1, 'e_password') as v`, [E]);
ok(shown[0].v === 'hunter2-Secret!', 'an admin can reveal it');
const log = await q(`select revealed_by, question_id from onboarding_secret_reveals`);
ok(log.length === 1 && log[0].revealed_by === 'tenny@midasmediafirm.com' && log[0].question_id === 'e_password', 'every reveal is logged with who looked');
ok((await q(`select reveal_onboarding_secret('Acme Decks', $1, 'nothing_here') as v`, [E]))[0].v === null, 'revealing something never saved returns nothing');

// re-saving a secret replaces it
await q(`select save_private_onboarding_answers('Acme Decks', $1, '{"e_password":{"value":"new-pass"}}'::jsonb)`, [E]);
ok((await q(`select reveal_onboarding_secret('Acme Decks', $1, 'e_password') as v`, [E]))[0].v === 'new-pass', 'a new password replaces the old one');

// admins can delete once we have our own access
await q(`delete from onboarding_secrets where client_name = 'Acme Decks'`);
ok((await q(`select count(*)::int n from onboarding_secrets`))[0].n === 0, 'an admin can delete a stored login');

// anon gets nothing at all
await as({ role: 'anon' });
await throwsLike(() => q(`select count(*) from onboarding_private_answers`), /permission denied/, 'anon cannot even query the private answers');
await throwsLike(() => q(`select save_private_onboarding_answers('Acme Decks', $1, '{}'::jsonb)`, [B]), /permission denied/, 'anon cannot call the save function');
await as({});

// ---- the services question moved to About your business ----
ok(byTitle['About your business'].questions.some((x) => x.id === 'a_services' && /custom_value:services_list/.test(x.dest || '') && !x.private),
    'About your business asks which services, for everyone, saving to services_list');
ok(!byTitle['Your jobs and offers'].questions.some((x) => x.id === 'd_services'), 'Your jobs and offers no longer asks it');

// ---- go-live (onboarding_questionnaire_go_live.sql) ----
await as({});
await db.exec(`
    insert into onboarding_steps (title, step_type, active, sort_order) values
        ('Tell us about your business', 'form', true, 3), ('Your service area and hours', 'form', true, 4),
        ('Offers and preferences', 'form', true, 5), ('Some other form', 'form', true, 6), ('Welcome video', 'video', true, 1);
    insert into onboarding_steps (title, step_type, owner, active, sort_order) values ('Delete their stored website password', 'action', 'agency', false, 25);
    insert into onboarding_steps (title, step_type, active, sort_order, service_keys, questions) values
        ('Tell us about your business for SEO', 'questions', false, 20, '{seo}',
         '[{"id":"q_area","label":"Areas"},{"id":"q_services","label":"Services"},{"id":"q_tone","label":"Tone"},{"id":"q_liked_sites","label":"Sites"}]');
`);
ok((await q(`select count(*)::int n from onboarding_steps where active and title = any($1)`, [titles]))[0].n === 0, 'before go-live, every questionnaire step is still off');
const goLive = fs.readFileSync(path.join(here, 'onboarding_questionnaire_go_live.sql'), 'utf8');
await db.exec(goLive);
await db.exec(goLive); // re-runnable
const after = Object.fromEntries((await q(`select title, active, questions from onboarding_steps`)).map((r) => [r.title, r]));
ok(titles.every((tt) => after[tt].active), 'go-live switches all six questionnaire steps on');
ok(['Tell us about your business', 'Your service area and hours', 'Offers and preferences'].every((tt) => !after[tt].active), 'go-live switches the three GHL form steps off');
ok(after['Some other form'].active && after['Welcome video'].active, 'other steps are left alone');
ok(after['Tell us about your business for SEO'].questions.map((x) => x.id).join() === 'q_area,q_tone', 'the SEO step loses q_services and q_liked_sites, keeping the rest in order');
ok(after['Delete their stored website password'].active === true, 'go-live also switches on our task to delete a stored website password');
ok(after['Tell us about your business for SEO'].active === false, 'the SEO step keeps its own on/off setting');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
