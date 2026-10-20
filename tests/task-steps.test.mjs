// The arrow on a task card (app.js): a task that is a checklist group opens its steps underneath, and they can be
// ticked right there. Runs the REAL board, list and checklist code, cut out of app.js by its section markers, in
// jsdom with a fake Supabase client.
//   JSDOM_DIR=/path/to/dir node tests/task-steps.test.mjs
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
const cut = (from, to) => {
    const a = app.indexOf(from), b = app.indexOf(to, a + 1);
    if (a < 0 || b < 0) throw new Error(`marker not found: ${a < 0 ? from : to}`);
    return app.slice(a, b);
};
const line = (start) => { const a = app.indexOf(start); if (a < 0) throw new Error('marker ' + start); return app.slice(a, app.indexOf('\n', a)); };

const code = [
    cut('        const normalize = (str) => {', '        // Escapes for a JS string literal'),
    cut('        const escapeAttr = (str) =>', '        // Repairs values already corrupted'),
    line('        const escapeHTML = (str) =>'),
    line('        const stripSlashEscapes = (str) =>'),
    cut('        const clientTaskBadge = t =>', '        function setTaskSort(c)'),
    cut('const SETUP_STEP_TYPE', '// A step is a task underneath'),
].join('\n');

function makeWorld({ role = 'admin' } = {}) {
    const dom = new JSDOM(`<!doctype html><body>
        <div id="page-tasks">
            <div class="kanban-col" data-status="Not Started" id="col-todo"></div><div class="kanban-col" data-status="In Progress" id="col-prog"></div>
            <div class="kanban-col" data-status="Blocked" id="col-rev"></div><div class="kanban-col" data-status="Complete" id="col-done"></div>
        </div>
        <span id="count-todo"></span><span id="count-prog"></span><span id="count-rev"></span><span id="count-done"></span>
        <button id="btn-archive-done"></button><input id="task-search-filter" value="">
        <table><thead id="t-table-head"></thead><tbody id="t-table-body"></tbody></table>
    </body>`, { runScripts: 'dangerously' });
    const w = dom.window;
    w.__calls = [];
    w.__sortableOpts = [];
    w.__refuse = false;
    w.eval(`
        var currentUserRole = ${JSON.stringify(role)}, currentTaskView = 'kanban', taskArchiveView = false, taskOwnerFilter = 'all';
        var selectedTaskIds = new Set(), activeCols = [], masterCols = [], currentTaskSort = 'score', taskSortDir = 'desc', taskPrioMode = 'total';
        var sortableInstances = [], globalArchivedTasks = [], globalStageTemplates = [], cSelectedAccount = 'Acme Decks';
        var lifecycleStages = ['Onboarding', 'Campaign Building', 'Campaign Learning'];
        var globalOnboardingSteps = [
            { id: 'about', questions: [{ id: 'a_owner', dest: 'custom_value:owner_name; a2p:representative_name' }, { id: 'a_title', dest: 'a2p:representative_title' },
                { id: 'a_email', dest: 'ghl:email; custom_value:business_email' }, { id: 'a_street', dest: 'ghl:address' }, { id: 'a_city', dest: 'ghl:city' },
                { id: 'a_state', dest: 'ghl:state' }, { id: 'a_zip', dest: 'ghl:postalCode' }, { id: 'a_mobile', private: true, dest: 'admin:owner_mobile; a2p:representative_phone' }] },
            { id: 'texting', questions: [{ id: 'b_legal', private: true, dest: 'a2p:legal_name' }, { id: 'b_type', private: true, dest: 'a2p:business_type' }, { id: 'b_ein', private: true, dest: 'a2p:ein' }] },
        ];
        var globalOnboardingAnswers = [
            { client_name: 'Acme Decks', step_id: 'about', answers: { a_owner: { value: 'Pat Smith' }, a_title: { value: 'Owner' }, a_email: { value: 'pat@acme.com' },
                a_street: { value: '1 Main St' }, a_city: { value: 'Lehi' }, a_state: { value: 'UT' }, a_zip: { value: '84043' } } },
            { client_name: 'Other Co', step_id: 'texting', answers: {} },
        ];
        var globalPrivateAnswers = [
            // another client's answers first, so a missing client filter would show up as a leak
            { client_name: 'Other Co', step_id: 'texting', answers: { b_ein: { value: '99-9999999' } } },
            { client_name: 'Acme Decks', step_id: 'texting', answers: { b_legal: { value: 'Acme Decks LLC' }, b_type: { value: 'LLC' }, b_ein: { value: '12-3456789' } } },
            { client_name: 'Acme Decks', step_id: 'about', answers: { a_mobile: { value: '801-555-9999' } } },
        ];
        window.__copied = null;
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied = t; } }, configurable: true });
        var globalClientsData = [{ name: 'Acme Decks', current_stage: 'Onboarding' }, { name: 'Other Co', current_stage: 'Onboarding' }];
        var globalTasksData = [
            { id: 1, client: 'Acme Decks', title: 'Register their texting number', stage: 'Onboarding', status: 'Not Started', type: 'Checklist', score: 60, assignee: 'Tenny', client_visible: false },
            { id: 2, client: 'Acme Decks', title: 'Call the owner', stage: 'Onboarding', status: 'Not Started', type: 'One-off', score: 50 },
        ];
        var globalSetupSteps = [
            { id: 11, client: 'Acme Decks', title: 'A2P — Make their website and host it on their GHL account', stage: 'Onboarding', status: 'Complete', type: 'Setup step', checklist_group: 'Register their texting number' },
            { id: 12, client: 'Acme Decks', title: 'A2P — Buy a local number', stage: 'Onboarding', status: 'Not Started', type: 'Setup step', checklist_group: 'Register their texting number', notes: '<img src=x onerror=alert(1)>' },
            { id: 13, client: 'Acme Decks', title: 'A2P — Submit the brand and the campaign <b>now</b>', stage: 'Onboarding', status: 'Not Started', type: 'Setup step', checklist_group: 'Register their texting number' },
            { id: 21, client: 'Other Co', title: 'A2P — Buy a local number', stage: 'Onboarding', status: 'Not Started', type: 'Setup step', checklist_group: 'Register their texting number' },
        ];
        var supabaseClient = { from: (t) => ({ update: (row) => ({ eq: (k, v) => ({ select: async () => { __calls.push({ table: t, row, id: v }); return __refuse ? { data: [], error: null } : { data: [{ id: v }], error: null }; } }) }) }) };
        var Sortable = function (el, opts) { __sortableOpts.push(opts); this.destroy = () => {}; };
        const taskIsClients = t => normalize(t.assignee || '') === 'client';
        const taskTextMatch = () => true;
        function taskMatchesFilters() { return true; }
        function getStartedSteps() { return []; }
        function onboardingProgressFor() { return null; }
        function updateTaskBulkBar() {}
        function renderTaskSummary() {}
        async function runLifecycleCatchUp() { return 0; }
        function openTaskDrawer(id) { __calls.push({ drawer: id }); }
        function goToClient() {}
        window.alert = (m) => __calls.push({ alert: m });
        ${code}
        function renderActiveTaskView() { if (currentTaskView === 'kanban') renderKanban(); else renderTable(); }
        window.__t = { renderKanban, renderTable, setupChecklistHtml, setView: (v) => { currentTaskView = v; }, tasks: () => globalTasksData, steps: () => globalSetupSteps };
    `);
    return { w, t: w.__t, d: w.document };
}
const card = (d, id) => d.querySelector(`.kanban-card[data-id="${id}"]`);

// ---- the board ----
{
    const { w, t, d } = makeWorld();
    t.renderKanban();
    const c1 = card(d, 1), c2 = card(d, 2);
    const tog = c1.querySelector('.task-steps-toggle');
    ok(tog && /1 of 3 steps/.test(tog.textContent), 'a group task shows how many of its steps are done: ' + (tog && tog.textContent.trim()));
    ok(!c1.querySelector('.task-steps'), 'the steps start collapsed');
    ok(!c2.querySelector('.task-steps-toggle'), 'an ordinary task has no arrow');
    ok(w.__sortableOpts.every((o) => /\.task-steps/.test(o.filter || '')), 'dragging from the steps or the arrow never moves the card');

    tog.click();
    ok(!w.__calls.some((x) => x.drawer), 'opening the steps does not open the task drawer');
    const panel = card(d, 1).querySelector('.task-steps');
    ok(panel && panel.querySelectorAll('.setup-step').length === 3, 'the arrow opens its three steps under the card');
    ok(!panel.innerHTML.includes('<img src=x') && !panel.querySelector('b'), 'step titles and notes are escaped');
    ok(panel.querySelectorAll('[aria-checked="true"]').length === 1, 'the finished step shows ticked');
    ok(card(d, 1).querySelector('.task-steps-toggle').getAttribute('aria-expanded') === 'true', 'the arrow says it is open');

    // tick a step from the card
    const box = [...panel.querySelectorAll('[role="checkbox"]')].find((b) => b.getAttribute('aria-label') === 'Buy a local number');
    box.click();
    await new Promise((r) => setTimeout(r, 20));
    ok(!w.__calls.some((x) => x.drawer), 'ticking a step does not open the task drawer');
    ok(w.__calls.some((x) => x.table === 'tasks' && x.id === 12 && x.row.status === 'Complete'), 'ticking saves that step');
    ok(w.__calls.some((x) => x.table === 'tasks' && x.id === 1 && x.row.status === 'In Progress'), 'the task moves to In Progress once a step is done');
    const moved = d.querySelector('#col-prog .kanban-card[data-id="1"]');
    ok(moved && /2 of 3 steps/.test(moved.querySelector('.task-steps-toggle').textContent), 'the card moves column and its count follows');
    ok(moved && moved.querySelector('.task-steps'), 'the steps stay open after ticking');

    // finish the rest
    for (const id of [13]) { [...d.querySelectorAll('.task-steps [role="checkbox"]')].find((b) => b.getAttribute('onclick').includes(`'${id}'`)).click(); await new Promise((r) => setTimeout(r, 20)); }
    ok(t.tasks()[0].status === 'Complete' && d.querySelector('#col-done .kanban-card[data-id="1"]'), 'the last step completes the task');

    // collapse
    d.querySelector('.kanban-card[data-id="1"] .task-steps-toggle').click();
    ok(!d.querySelector('.kanban-card[data-id="1"] .task-steps'), 'the arrow closes it again');
    ok(t.steps().find((s) => s.id === 21).status === 'Not Started', 'another client\'s step with the same name is never touched');
}
{
    const { w, d, t } = makeWorld();
    t.renderKanban();
    card(d, 1).querySelector('.task-steps-toggle').click();
    w.__refuse = true;
    [...d.querySelectorAll('.task-steps [role="checkbox"]')].find((b) => b.getAttribute('aria-checked') === 'false').click();
    await new Promise((r) => setTimeout(r, 20));
    ok(w.__calls.some((x) => x.alert && /Could not save/.test(x.alert)) && /1 of 3 steps/.test(card(d, 1).querySelector('.task-steps-toggle').textContent),
        'a refused save is reported and the tick is put back');
}
{
    const { d, t } = makeWorld({ role: 'client' });
    t.renderKanban();
    ok(!d.querySelector('.task-steps-toggle'), 'non-admins get no arrow');
}

// ---- Copy A2P details ----
{
    const { w, d, t } = makeWorld();
    t.steps().push({ id: 14, client: 'Acme Decks', title: 'Review — Paste the A2P details into their Business Profile', stage: 'Onboarding', status: 'Not Started', type: 'Setup step', checklist_group: 'Register their texting number' });
    t.renderKanban();
    card(d, 1).querySelector('.task-steps-toggle').click();
    const btns = d.querySelectorAll('.task-steps .a2p-copy');
    ok(btns.length === 1, 'the copy button shows on the Business Profile step only');
    await w.copyA2pDetails(btns[0]);
    const text = w.__copied || '';
    ok(!w.__calls.some((x) => x.drawer), 'copying does not open the task drawer');
    ok(text.includes('Legal business name: Acme Decks LLC') && text.includes('Business type: LLC') && text.includes('EIN: 12-3456789'), 'the private A2P answers are copied: ' + JSON.stringify(text));
    ok(text.includes('Address: 1 Main St, Lehi, UT 84043') && text.includes('Authorized representative: Pat Smith') && text.includes('Title: Owner')
        && text.includes('Email: pat@acme.com') && text.includes('Phone: 801-555-9999'), 'address and the representative are copied');
    ok(text.includes('Website: (not answered)') && !text.includes('99-9999999'), "a blank answer says so; another client's answers never leak in");
    ok(/Copied/.test(btns[0].innerHTML), 'the button says it copied');
}
{
    const { w, d, t } = makeWorld({ role: 'client' });
    const btn = d.createElement('button'); btn.dataset.client = 'Acme Decks';
    await w.copyA2pDetails(btn);
    ok(w.__copied === null, 'a non-admin page never copies');
}

// ---- the list view ----
{
    const { d, t } = makeWorld();
    t.setView('list');
    t.renderTable();
    const tog = d.querySelector('#t-table-body .task-steps-toggle');
    ok(tog && /1 of 3 steps/.test(tog.textContent) && d.querySelectorAll('#t-table-body .task-steps-toggle').length === 1, 'the list shows the arrow on the group task only');
    tog.click();
    const panel = d.querySelector('#t-table-body .task-steps');
    ok(panel && panel.querySelectorAll('.setup-step').length === 3 && panel.closest('td').colSpan === 5, 'the list opens the steps in a row underneath');
}

// ---- Our checklist still draws the same steps ----
{
    const { t } = makeWorld();
    const html = t.setupChecklistHtml('Acme Decks');
    ok(/Register their texting number/.test(html) && /1 of 3/.test(html) && (html.match(/class="setup-step"/g) || []).length === 3, 'Our checklist still lists the group with its steps');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
