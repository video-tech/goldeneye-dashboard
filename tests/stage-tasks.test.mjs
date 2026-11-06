// generateStageTasks (app.js): our setup tasks are raised visible to the client, their steps hidden. Runs the REAL
// function, cut out of app.js, with a fake database.
//   JSDOM_DIR=/path/to/dir node tests/stage-tasks.test.mjs
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
const cut = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a + 1); if (a < 0 || b < 0) throw new Error('marker ' + (a < 0 ? from : to)); return app.slice(a, b + to.length); };
const code = [
    cut('        const normalize = (str) => {', '        // Escapes for a JS string literal'),
    "const SETUP_STEP_TYPE = 'Setup step';",
    cut('async function generateStageTasks(clientName, stage, opts = {}) {', '\n}\n'),
].join('\n');

const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously' });
const w = dom.window;
w.__inserted = [];
w.eval(`
    var globalTasksData = [];
    function allOnboardingItems() { return [
        { id: 'g1', owner: 'agency', title: 'Register your texting number', description: 'We register your number.', due_days: 10 },
        { id: 'g2', owner: 'agency', title: 'Texting number and website (A2P)', description: 'A2P.', due_days: 10, priority: 5, urgency: 5, effort: 1 },
        { id: 'c1', owner: 'client', title: 'About your business' },
    ]; }
    function obFor() { return null; }
    function templatesForStage() { return []; }
    var supabaseClient = {
        rpc: async (name, args) => ({ data: args.p_stage === 'Onboarding'
            ? [{ task_title: 'A2P — Buy a local number', task_type: 'Setup step', checklist_group: 'Register your texting number', due_days: 3, service_keys: [] }]
            : [{ task_title: 'Launch ads', task_type: 'Checklist', due_days: 7 }, { task_title: 'Ads — Build the creatives', task_type: 'Setup step', checklist_group: 'Launch ads', due_days: 3 }], error: null }),
        from: () => ({
            select: () => ({ eq: async () => ({ data: [], error: null }) }),
            insert: (rows) => ({ select: async () => { __inserted.push(...rows); return { data: rows, error: null }; } }),
        }),
    };
    ${code}
    window.__gen = generateStageTasks;
`);
await w.__gen('Acme', 'Onboarding');
await w.__gen('Acme', 'Campaign Building');
const by = Object.fromEntries(w.__inserted.map((r) => [r.title, r]));
ok(by['Register your texting number']?.client_visible === true && by['Launch ads']?.client_visible === true, 'our tasks are raised visible to the client');
ok(by['A2P — Buy a local number']?.client_visible === false && by['Ads — Build the creatives']?.client_visible === false, 'their steps are raised hidden');
ok(!by['About your business'], "the client's own steps never become our tasks");

// Priority comes from the task's definition (a2p_task.sql); a task with none counts as 3, which is what every task used
ok(by['Texting number and website (A2P)']?.p === 5 && by['Texting number and website (A2P)'].u === 5 && by['Texting number and website (A2P)'].e === 1
    && by['Texting number and website (A2P)'].score === 100, 'the A2P task is raised at priority 5, urgency 5, effort 1: score 100');
ok(by['Register your texting number']?.p === 3 && by['Register your texting number'].u === 3 && by['Register your texting number'].e === 3
    && by['Register your texting number'].score === 60, 'a task with no priority is raised at 3 / 3 / 3: score 60');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
