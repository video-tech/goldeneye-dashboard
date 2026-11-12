// "Add an opt-in funnel" on Our checklist (app.js addOptinFunnel): one task per funnel with the SOP steps under it, in the
// client's current stage, hidden from the client. Runs the REAL code, cut out of app.js, in jsdom against a fake database.
//   JSDOM_DIR=/path/to/dir node tests/optin-funnel.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
if (!process.env.JSDOM_DIR) { console.log('Set JSDOM_DIR to a folder with jsdom installed.'); process.exit(2); }
const { JSDOM } = createRequire(path.join(process.env.JSDOM_DIR, 'package.json'))('jsdom');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const body = fs.readFileSync(path.join(root, 'body.html'), 'utf8');
const cut = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a + 1); if (a < 0 || b < 0) throw new Error('marker ' + (a < 0 ? from : to)); return app.slice(a, b); };
const code = [
    cut('        const normalize = (str) => {', '        // Escapes for a JS string literal'),
    cut('function rememberTaskRows(rows)', '\n}\n') + '\n}\n',
    cut("const OPTIN_FUNNEL_PREFIX", 'async function runAutoChecks()'),
].join('\n');

ok(body.includes('onclick="addOptinFunnel()"'), 'Our checklist has the Add an opt-in funnel button');

function world({ role = 'admin', existing = [], stepsFail = false, answer = 'Kitchen cost quiz' } = {}) {
    const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously' }).window;
    w.__db = { tasks: existing.slice(), inserts: [], deletes: [], stepsFail };
    w.prompt = () => answer;
    w.__alerts = [];
    w.alert = (m) => w.__alerts.push(m);
    w.eval(`
        var currentUserRole = ${JSON.stringify(role)}, setupChecklistClient = 'Acme', SETUP_STEP_TYPE = 'Setup step';
        var globalClientsData = [{ id: 1, name: 'Acme', current_stage: 'Optimizing' }];
        var globalTasksData = [], globalArchivedTasks = [], globalSetupSteps = [];
        var refreshed = 0; function refreshSetupViews() { refreshed++; } function renderActiveTaskView() {}
        var nextId = 100;
        var supabaseClient = { from: () => {
            const db = window.__db, f = {};
            const q = {
                select() { return q; },
                eq(c, v) { f[c] = v; return q; },
                ilike(c, v) { f.ilike = v; return Promise.resolve({ data: db.tasks.filter(t => t.client === f.client && t.stage === f.stage && t.title.toLowerCase() === v.toLowerCase()), error: null }); },
                insert(rows) {
                    db.inserts.push(rows);
                    const bad = db.stepsFail && rows[0].type === 'Setup step';
                    const out = bad ? null : rows.map(r => ({ ...r, id: nextId++ }));
                    if (out) db.tasks.push(...out);
                    return { select: () => Promise.resolve(bad ? { data: null, error: { message: 'nope' } } : { data: out, error: null }) };
                },
                delete() { return { eq: (c, v) => { db.deletes.push(v); return Promise.resolve({ error: null }); } }; },
            };
            return q;
        } };
        ${code}
    `);
    return w;
}

{
    const w = world();
    await w.eval('addOptinFunnel()');
    const [group, steps] = w.__db.inserts;
    ok(group.length === 1 && group[0].title === 'New opt-in funnel: Kitchen cost quiz' && group[0].stage === 'Optimizing', 'one task, named for the funnel, in the client\'s current stage');
    ok(group[0].client_visible === false && group[0].type === 'Checklist' && group[0].checklist_group === null, 'the task is hidden from the client and is not itself a step');
    ok(steps.length === 4 && steps.every(s => s.type === 'Setup step' && s.checklist_group === 'New opt-in funnel: Kitchen cost quiz' && s.stage === 'Optimizing' && s.client_visible === false), 'four steps, filed under that task, hidden');
    const titles = steps.map(s => s.title).join(' | ');
    ok(/right Lead Relay workflow/.test(titles) && /never Lead/.test(titles) && /no pixel Lead/.test(titles) && /first real lead/.test(titles), 'covers the opt-in workflow, the Facebook event, the pages and the first lead');
    ok(/meta form ge/.test(steps[0].notes) && /quiz ads ge/.test(steps[0].notes) && /website lead/.test(steps[0].notes), 'names every source tag');
    ok(w.eval('globalTasksData.length') === 1 && w.eval('globalSetupSteps.length') === 4 && w.eval('refreshed') === 1, 'shown at once');
    ok(steps[0].due < steps[3].due, 'the check on the first real lead is due last');
}
{
    const w = world({ existing: [{ client: 'Acme', stage: 'Optimizing', title: 'New opt-in funnel: kitchen cost quiz' }] });
    await w.eval('addOptinFunnel()');
    ok(w.__db.inserts.length === 0 && /already exists/.test(w.__alerts[0]), 'the same funnel twice is refused');
}
{
    const w = world({ stepsFail: true });
    await w.eval('addOptinFunnel()');
    ok(w.__db.deletes.length === 1 && w.eval('globalTasksData.length') === 0, 'steps failing removes the task again');
}
{
    let w = world({ answer: '   ' });
    await w.eval('addOptinFunnel()');
    ok(w.__db.inserts.length === 0, 'no name, nothing added');
    w = world({ role: 'member' });
    await w.eval('addOptinFunnel()');
    ok(w.__db.inserts.length === 0, 'admins only');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
