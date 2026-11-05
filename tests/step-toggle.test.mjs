// Ticking and unticking onboarding steps by hand (app.js, 2026-11-05): the client can change any step but a form that
// ticks itself or a Questions step; an admin can change any step, on the Relationship tab or while previewing; every
// change asks first; an admin ticking a client's last step chooses whether they get the "onboarding complete" text.
// Runs the REAL renderGetStarted, the toggle helpers and the Relationship tab's onboarding list, cut out of app.js, in jsdom.
//   JSDOM_DIR=/path/to/dir node tests/step-toggle.test.mjs
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
const cut = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a + 1); if (a < 0 || b < 0) throw new Error('marker ' + (a < 0 ? from : to)); return app.slice(a, b); };
const line = (start) => { const a = app.indexOf(start); return app.slice(a, app.indexOf('\n', a)); };
const code = [
    cut('        const normalize = (str) => {', '        // Escapes for a JS string literal'),
    cut('        const escapeAttr = (str) =>', '        // Repairs values already corrupted'),
    line('        const stripSlashEscapes = (str) =>'),
    cut('window.renderGetStarted = function() {', '// ---- Built-in Questions steps ----'),
    cut('// kind \'form\': a client who submitted', 'window.obCompleteStep = async function'),
    cut('// ---- Ticking and unticking a step by hand', '// Finishing the last step is the agency'),
    cut('        function renderClientOnboarding() {', '        // What the client answered on built-in Questions steps'),
].join('\n');

const STEPS = [
    { id: 'v1', title: 'Welcome video', step_type: 'video', embed_url: 'https://x/v.mp4', owner: 'client' },
    { id: 'f1', title: 'Tell us about your business', step_type: 'form', embed_url: 'https://forms/x', owner: 'client' },
    { id: 'q1', title: 'About your business', step_type: 'questions', owner: 'client' },
    { id: 'a1', title: "Give us access to your Facebook", step_type: 'action', owner: 'client' },
    { id: 't1', title: 'Your team', step_type: 'team', owner: 'client' },
    { id: 'c1', title: 'Book your setup call', step_type: 'form', embed_url: 'https://cal/x', requires_confirm: true, owner: 'client' },
];

function world({ done = [], preview = false, role = 'client', stage = 'Onboarding', handoff = false, confirms = [] } = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="ob-steps-list"></div><div id="c-onboarding-box"><div id="c-onboarding-list"></div></div></body>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.__saves = []; w.__asked = []; w.__answers = [...confirms]; w.__notified = 0;
    w.confirm = (q) => { w.__asked.push(q); return w.__answers.length ? w.__answers.shift() : true; };
    w.alert = (m) => { w.__alert = m; };
    w.isClientPreview = preview;
    w.eval(`
        var currentActiveClient = 'Acme', cSelectedAccount = 'Acme', currentUserRole = ${JSON.stringify(role)}, clientEmail = ${JSON.stringify(role === 'admin' ? 'video@midasmediafirm.com' : 'pat@acme.com')};
        var globalOnboardingSteps = ${JSON.stringify(STEPS)};
        var globalOnboardingProgress = ${JSON.stringify(done.map((id) => ({ client_name: 'Acme', step_id: id, completed_at: '2026-11-01T00:00:00Z', completed_by: 'pat@acme.com' })))};
        var globalClientsData = [{ name: 'Acme', status: 'active', current_stage: ${JSON.stringify(stage)} }], portalClientRows = [];
        var globalTasksData = ${JSON.stringify(handoff ? [{ client: 'Acme', title: 'Onboarding complete — ready for campaign build', status: 'Not Started' }] : [])}, globalServices = [];
        var obManualOpen = new Proxy({}, { has: () => true, get: () => true });   // every card open
        var obManualRevealTimer;
        function onboardingProgressFor(c, id) { return globalOnboardingProgress.find(p => normalize(p.client_name) === normalize(c) && p.step_id === id) || null; }
        function activeOnboardingSteps() { return globalOnboardingSteps.filter(s => s.owner !== 'agency'); }
        function getStartedSteps() { return activeOnboardingSteps(); }
        function onboardingItemsToShow() { return globalOnboardingSteps; }
        function onboardingHandoffRaised(c) { return globalTasksData.some(t => normalize(t.client) === normalize(c) && /^onboarding complete/i.test(t.title)); }
        function portalClientStage() { return ${JSON.stringify(stage)}; }
        function serviceName(k) { return k; }
        function obStepDescription(s) { return s.description || ''; }
        function isDirectVideo(u) { return /\\.mp4$/.test(u); }
        function obTeamStepHtml() { return '<div class="team"></div>'; }
        function obQuestionsFormHtml() { return '<form class="qs"></form>'; }
        function prefillFormUrl(u) { return u; }
        function previewBlocksWrite() { return !!window.isClientPreview; }
        function updateGetStartedTabVisibility() {}
        async function obNotifyOnboardingComplete() { window.__notified++; }
        function renderStageProgress() {}
        function ghlContactNoticeHtml() { return ''; }
        function agencyStepImplicitlyDone() { return false; }
        function setupGroupsFor() { return []; }
        function clientAnswersHtml() { return ''; }
        function escapeHTML(s) { return String(s ?? ''); }
        var supabaseClient = { from: (t) => ({
            upsert: async (row, opts) => { __saves.push({ t, row, opts }); return { error: null }; },
            insert: async (rows) => { __saves.push({ t, rows }); return { error: null }; },
        }) };
        ${code}
    `);
    const d = w.document;
    const card = (title) => [...d.querySelectorAll('#ob-steps-list .glass')].find((c) => c.querySelector('h4').textContent.trim() === title);
    const portal = () => { w.renderGetStarted(); return card; };
    return { w, d, card, portal };
}

const T = Object.fromEntries(STEPS.map((s) => [s.id, s.title]));

// ---- The client: what can be ticked by hand ----
{
    const { portal, card } = world();
    portal();
    const can = (id) => !!card(T[id]).querySelector('.ob-mark');
    ok(can('v1') && can('a1') && can('t1') && can('c1'), 'a client can mark a video, an action, the team step and a booking (confirm) step done');
    ok(!can('f1') && !can('q1'), 'a client cannot mark a form or a Questions step done by hand');
    ok(card(T.f1).querySelector('#ob-manual-f1')?.textContent.includes('Let us know'), 'a form that didn\'t tick itself offers "let us know" instead of a tick');
}
{
    const { portal, card } = world({ done: STEPS.map((s) => s.id) });
    portal();
    const undo = (id) => !!card(T[id]).querySelector('.ob-undo');
    ok(undo('v1') && undo('a1') && undo('t1') && undo('c1'), 'a client can mark their done steps as not done');
    ok(!undo('f1') && !undo('q1'), 'but not a form or a Questions step');
}

// ---- The client: ticking asks first, and saves as them ----
{
    const { w } = world({ confirms: [false] });
    await w.obManualToggle('a1', true);
    ok(w.__asked.length === 1 && /Mark "Give us access to your Facebook" as done\?/.test(w.__asked[0]), 'ticking asks first: ' + w.__asked[0]);
    ok(!w.__saves.length, 'saying no saves nothing');
}
{
    const { w } = world();
    await w.obManualToggle('a1', true);
    const s = w.__saves[0]?.row;
    ok(s && s.completed_at && s.completed_by === 'pat@acme.com' && w.__saves[0].opts.onConflict === 'client_name,step_id', 'saying yes ticks it as the client');
    ok(w.__notified === 1, 'a tick runs the usual finished-onboarding check');
}
{
    const { w } = world({ done: ['a1'] });
    await w.obManualToggle('a1', false);
    const s = w.__saves[0]?.row;
    ok(/as not done\?/.test(w.__asked[0]), 'unticking asks first');
    ok(s && s.completed_at === null && !('completed_by' in s), 'unticking sets completed_at back to null');
    ok(!w.onboardingProgressFor('Acme', 'a1').completed_at, 'and the screen sees it as not done');
}
{
    const { w } = world();
    await w.obManualToggle('f1', true);
    await w.obManualToggle('q1', true);
    ok(!w.__saves.length && !w.__asked.length, 'a client\'s tick on a form or Questions step is refused outright');
}
{
    const { w } = world();
    await w.obManualToggle('v1', true);
    ok(w.__saves[0]?.row.watch_percent === 100, 'a video ticked by hand records 100% watched');
}

// ---- An admin previewing the portal ----
{
    const { portal, card, w } = world({ preview: true, role: 'admin' });
    portal();
    ok(['v1', 'f1', 'q1', 'a1', 't1', 'c1'].every((id) => card(T[id]).querySelector('.ob-mark')), 'previewing, an admin can tick every step, forms and Questions too');
    await w.obManualToggle('f1', true);
    ok(/^You're previewing Acme's portal\. This changes their real progress\./.test(w.__asked[0]), 'the popup says it changes their real progress');
    ok(w.__saves.length === 1, 'and it saves despite the preview');
}

// ---- The admin Relationship tab ----
{
    const { w, d } = world({ role: 'admin', done: ['v1'] });
    w.renderClientOnboarding();
    const btn = (title) => [...d.querySelectorAll('#c-onboarding-list > div')].find((r) => r.textContent.includes(title))?.querySelector('.ob-admin-toggle');
    ok(btn(T.v1)?.textContent === 'Mark not done' && btn(T.f1)?.textContent === 'Mark done' && btn(T.q1)?.textContent === 'Mark done', 'every client step has a tick or untick for an admin, forms included');
    await w.adminToggleClientStep('f1', true);
    ok(/as done for Acme\?/.test(w.__asked[0]) && w.__saves[0]?.row.completed_by === 'video@midasmediafirm.com', 'an admin tick asks, then saves');
}
{
    const { w, d } = world({ role: 'client' });
    w.renderClientOnboarding();
    ok(!d.querySelector('.ob-admin-toggle'), 'no admin buttons for anyone else');
    await w.adminToggleClientStep('a1', true);
    ok(!w.__saves.length, 'and the handler refuses them');
}

// ---- The last step: text or no text ----
const allBut = (id) => STEPS.map((s) => s.id).filter((x) => x !== id);
{
    const { w } = world({ role: 'admin', done: allBut('a1'), confirms: [true, true] });
    await w.adminToggleClientStep('a1', true);
    ok(w.__asked.length === 2 && /last onboarding step/.test(w.__asked[1]), 'ticking the last step asks about the text');
    ok(w.__saves[0].row.completed_by === 'video@midasmediafirm.com', 'OK: saved as the admin, so the database texts them as usual');
}
{
    const { w } = world({ role: 'admin', done: allBut('a1'), confirms: [true, false] });
    await w.adminToggleClientStep('a1', true);
    ok(w.__saves[0].row.completed_by === 'backfilled', 'Cancel: saved as backfilled, which the database never texts');
}
{
    const { w } = world({ role: 'admin', done: allBut('a1'), handoff: true });
    await w.adminToggleClientStep('a1', true);
    ok(w.__asked.length === 1, 'no text question once they were already told (the handoff task exists)');
}
{
    const { w } = world({ role: 'admin', done: allBut('a1'), stage: 'Optimizing' });
    await w.adminToggleClientStep('a1', true);
    ok(w.__asked.length === 1, 'no text question for a client past onboarding');
}
{
    const { w } = world({ role: 'admin', done: ['v1'] });
    await w.adminToggleClientStep('a1', true);
    ok(w.__asked.length === 1, 'no text question when other steps are still open');
}
{
    const { w } = world({ done: allBut('a1') });
    await w.obManualToggle('a1', true);
    ok(w.__asked.length === 1 && w.__saves[0].row.completed_by === 'pat@acme.com', 'a client finishing their own last step is never asked: they get the text as always');
}

// ---- A form that didn't tick: tell us, never a tick ----
{
    const { w } = world();
    await w.obRequestHelp('f1', 'form');
    const t = w.__saves[0]?.rows?.[0];
    ok(t && t.title === 'Form submitted but not ticked off — Tell us about your business' && t.type === 'Client Request', 'raises a request on our board: ' + t?.title);
    ok(!w.__saves.some((s) => s.t === 'client_onboarding_progress'), 'and doesn\'t tick the form');
    ok(w.obHelpAlreadyRequested('f1', 'form') && !w.obHelpAlreadyRequested('f1'), 'kept apart from a call request');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
