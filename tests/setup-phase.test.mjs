// "Set up" is a label, not a stage: a client in the Onboarding stage reads Onboarding until their own steps are done,
// then Set up. Runs the REAL helpers, the Journey box and the Onboarding & Set up list, cut out of app.js, in jsdom.
// Also checks that nothing that decides anything was switched to the label.
//   JSDOM_DIR=/path/to/dir node tests/setup-phase.test.mjs
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
const body = fs.readFileSync(path.join(root, 'body.html'), 'utf8').replace(/\r\n/g, '\n');
const cut = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a + 1); if (a < 0 || b < 0) throw new Error('marker ' + (a < 0 ? from : to)); return app.slice(a, b); };
const code = [
    cut('function onboardingProgressFor(clientName, stepId) {', '// Add-ons this client is part-way through onboarding'),
    cut('const SETUP_PHASE = ', '\n\n// Checklist templates per stage'),
    cut('        function stageProgressFor(client) {', '        // What the client answered on built-in Questions steps'),
].join('\n');

function world({ progress = [], tasks = [], stage = 'Onboarding' } = {}) {
    const dom = new JSDOM(`<!doctype html><body>
        <div id="c-stage-box"><div id="c-stage-steps"></div><button id="c-stage-checklist"><span id="c-stage-checklist-label"></span></button>
        <div id="c-stage-bar-track"><div id="c-stage-bar"></div></div><p id="c-stage-summary"></p><p id="c-stage-detail"></p></div>
        <div id="c-onboarding-box"><span id="c-onboarding-summary"></span><button id="c-onboarding-backfill"></button><div id="c-onboarding-ghl"></div><div id="c-onboarding-list"></div></div>
    </body>`, { runScripts: 'dangerously' });
    const w = dom.window;
    w.__in = { progress, tasks, stage };
    w.eval(`
        const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const escapeAttr = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
        const escapeHTML = (s) => String(s ?? '');
        const OB_COMPLETE_TASK_TITLE = 'Onboarding complete — ready for campaign build';
        const lifecycleStages = ['Onboarding', 'Campaign Building', 'Campaign Learning', 'Optimizing', 'Offboarding'];
        var currentActiveClient = 'Acme', currentUserRole = 'admin', cSelectedAccount = 'Acme';
        var globalClientsData = [{ name: 'Acme', current_stage: __in.stage }];
        var globalTasksData = __in.tasks;
        var globalOnboardingProgress = __in.progress;
        var globalOnboardingSteps = [
            { id: 'v1', title: 'Welcome video', owner: 'client', sort_order: 1 },
            { id: 'a1', title: 'Connect Meta', owner: 'agency', sort_order: 2 },
            { id: 'q1', title: 'About your business', owner: 'client', sort_order: 3 },
            { id: 'a2', title: 'Final check and test', owner: 'agency', sort_order: 4 },
        ];
        function setupGroupsFor() { return []; }
        function ghlContactNoticeHtml() { return ''; }
        function clientAnswersHtml() { return ''; }
        ${code}
        window.displayStages = displayStages;
    `);
    return w;
}
const done = (id) => ({ client_name: 'Acme', step_id: id, completed_at: '2026-10-18T00:00:00Z' });
const phase = (w) => w.eval(`clientPhase(globalClientsData[0])`);

// The phase
let w = world();
ok(phase(w) === 'Onboarding', 'nothing done: Onboarding');
w = world({ progress: [done('v1')] });
ok(phase(w) === 'Onboarding', 'some of their steps done: still Onboarding');
w = world({ progress: [done('v1'), done('q1')] });
ok(phase(w) === 'Set up', 'all their steps done: Set up');
w = world({ tasks: [{ client: 'Acme', title: 'Onboarding complete — ready for campaign build', stage: 'Onboarding' }] });
ok(phase(w) === 'Set up', 'the onboarding-complete task alone also means Set up');
w = world({ progress: [done('v1'), done('q1')], stage: 'Campaign Building' });
ok(phase(w) === 'Campaign Building', 'later stages show as themselves');
ok(w.eval(`globalClientsData[0].current_stage`) === 'Campaign Building' && world({ progress: [done('v1'), done('q1')] }).eval(`globalClientsData[0].current_stage`) === 'Onboarding',
    'the stored stage is never changed');
ok(w.eval(`displayStages.join('|')`) === 'Onboarding|Set up|Campaign Building|Campaign Learning|Optimizing|Offboarding', 'the journey shows six steps');
ok(w.eval(`stageLabelForOurWork('Onboarding') + '|' + stageLabelForOurWork('Campaign Building')`) === 'Set up|Campaign Building', 'our onboarding-stage work is labelled Set up');

// The Journey box
w = world({ progress: [done('v1')] });
w.renderStageProgress();
let d = w.document;
ok(d.getElementById('c-stage-summary').innerText === 'Onboarding → Set up', 'while onboarding, the next step is Set up');
ok(/1 of 2 steps done/.test(d.getElementById('c-stage-detail').innerText), 'Onboarding counts only the client\'s steps');
ok([...d.querySelectorAll('#c-stage-steps span')].length === 6, 'six steps drawn');
w = world({ progress: [done('v1'), done('q1')], tasks: [{ client: 'Acme', title: 'Connect Meta', stage: 'Onboarding', status: 'Complete' }] });
w.renderStageProgress();
d = w.document;
ok(d.getElementById('c-stage-summary').innerText === 'Set up → Campaign Building', 'in Set up, the next step is Campaign Building');
ok(/1 of 2 tasks done/.test(d.getElementById('c-stage-detail').innerText), 'Set up counts only our tasks');
const steps = [...d.querySelectorAll('#c-stage-steps span')].map(s => s.textContent);
ok(steps[0] === '✓ Onboarding' && steps[1] === 'Set up', 'Onboarding is ticked and Set up is current');

// Onboarding & Set up list: two sections, theirs first
w.renderClientOnboarding();
const heads = [...d.querySelectorAll('.ob-section-head')].map(h => h.textContent.replace(/\s+/g, ' ').trim());
ok(heads.length === 2 && /^Onboarding · what they do · 2 of 2$/.test(heads[0]) && /^Set up · what we do · 1 of 2$/.test(heads[1]), 'two sections with their own counts');
const order = [...d.querySelectorAll('#c-onboarding-list .text-sm.truncate')].map(e => e.textContent);
ok(order.join('|') === 'Welcome video|About your business|Connect Meta|Final check and test', 'their steps first, then ours, each in order');
ok(d.getElementById('c-onboarding-summary').innerText === '3 of 4 complete', 'the overall count is unchanged');

// Nothing that decides anything uses the label
const logic = app.split('\n').filter(l => /clientPhase\(|SETUP_PHASE|displayStages/.test(l) && !/^\s*\/\//.test(l));
ok(!logic.some(l => /\.eq\(|\.update\(|\.insert\(|\.upsert\(|current_stage\s*=[^=]/.test(l)), 'the label is never saved');
ok(/function autoAdvanceCompletedOnboarding[\s\S]{0,800}!== 'Onboarding'/.test(app) && !/function autoAdvanceCompletedOnboarding[\s\S]{0,800}clientPhase/.test(app), 'the stage advance still checks the stored Onboarding stage');
ok(/<option value="Onboarding">Onboarding \/ Set up<\/option>/.test(body), 'the task drawer keeps the stored value Onboarding');
ok(/<option value="\$\{stage\}">\$\{stage === 'Onboarding' \? 'Onboarding \/ Set up' : stage\}<\/option>/.test(app), 'Move Stage keeps the stored values');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
