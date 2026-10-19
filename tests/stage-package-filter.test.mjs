// Templates → Stage Checklists: the package filter and the "Set up" label. Runs the REAL editor code, cut out of
// app.js, in jsdom. The filter only hides rows, so Save still keeps every task of the stage.
//   JSDOM_DIR=/path/to/dir node tests/stage-package-filter.test.mjs
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
const cut = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a + 1); if (a < 0 || b < 0) throw new Error('marker ' + (a < 0 ? from : to)); return app.slice(a, b + to.length); };
const code = [
    cut('function conditionEditorHtml(item) {', '\n}\n'),
    cut('window.toggleConditionChip = function(btn) {', '\n};\n'),
    cut('function updateConditionSummary(wrap) {', '\n}\n'),
    cut('function readConditions(row) {', '\n}\n'),
    cut('window.initStageTemplateEditor = function() {', 'async function saveRowsByIdPresence'),
    cut('window.saveStageTemplates = async function() {', '\n};\n'),
].join('\n').replace('async function saveRowsByIdPresence', '');

const a = body.indexOf('<h3 class="text-lg font-bold text-white">Stage Checklists</h3>');
const markup = body.slice(body.lastIndexOf('<div class="flex flex-wrap justify-between', a), body.indexOf('Save Checklist', a)) + '</button></div>';

function world() {
    const dom = new JSDOM(`<!doctype html><body><style>.hidden{display:none}</style>${markup}</body>`, { runScripts: 'dangerously' });
    const w = dom.window;
    w.__saved = null; w.__deleted = null;
    w.eval(`
        const escapeAttr = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
        const stripSlashEscapes = (s) => String(s ?? '');
        const WEBSITE_STATUS_LABELS = { new_build: 'We build it', existing: 'Existing' };
        const FACT_LABELS = {}; const factsSupported = () => false;
        let autoCheckCatalog = [{}]; const loadAutoCheckCatalog = async () => {}; const refreshAutoCheckSelects = () => {};
        const autoCheckOptions = () => '<option value=""></option>';
        var currentUserRole = 'admin';
        var lifecycleStages = ['Onboarding', 'Campaign Building'];
        var globalServices = [{ key: 'ads', name: 'Ads management', sort_order: 1 }, { key: 'seo', name: 'SEO Growth', sort_order: 2 }, { key: 'video', name: 'Video', active: false }];
        var stageRows = [
            { id: 'b1', stage: 'Onboarding', task_title: 'Base task', service_keys: [] },
            { id: 'a1', stage: 'Onboarding', task_title: 'Ads task', service_keys: ['ads'] },
            { id: 's1', stage: 'Onboarding', task_title: 'SEO task', service_keys: ['seo'] },
            { id: 'x1', stage: 'Onboarding', task_title: 'Ads and SEO task', service_keys: ['ads', 'seo'] },
            { id: 'c1', stage: 'Campaign Building', task_title: 'Launch', service_keys: ['ads'] },
        ];
        function templatesForStage(s) { return stageRows.filter(r => r.stage === s); }
        async function loadStageTemplates() {}
        async function saveRowsByIdPresence(t, rows) { __saved = rows; }
        var supabaseClient = { from: () => ({ delete: () => ({ in: async (c, ids) => { __deleted = ids; return { error: null }; } }) }) };
        window.alert = (m) => { throw new Error('alert: ' + m); };
        ${code}
    `);
    w.initStageTemplateEditor();
    return w;
}
const shownTitles = (w) => [...w.document.querySelectorAll('.tpl-stage-row:not(.hidden) .tpl-title')].map(i => i.value);
const setPkg = (w, v) => { w.document.getElementById('tpl-stage-package').value = v; w.applyStagePackageFilter(); };

let w = world();
const d = w.document;
ok([...d.getElementById('tpl-stage-picker').options].map(o => o.text).join('|') === 'Set up (our tasks)|Campaign Building', 'the Onboarding stage is labelled Set up');
ok(d.getElementById('tpl-stage-picker').value === 'Onboarding', 'the stored stage is still Onboarding');
ok([...d.getElementById('tpl-stage-package').options].map(o => o.value).join('|') === '|base|ads|seo', 'packages: All, Base, then the offered services (retired Video left out)');
ok(shownTitles(w).length === 4 && /4 tasks created once a client finishes their onboarding/.test(d.getElementById('tpl-stage-status').innerText), 'All shows every task');

setPkg(w, 'ads');
ok(shownTitles(w).join('|') === 'Ads task|Ads and SEO task', 'Ads shows only tasks tagged Ads');
ok(/Showing 2 Ads management tasks of 4/.test(d.getElementById('tpl-stage-status').innerText), 'the status line says how many are showing');
setPkg(w, 'seo');
ok(shownTitles(w).join('|') === 'SEO task|Ads and SEO task', 'SEO shows only tasks tagged SEO');
setPkg(w, 'base');
ok(shownTitles(w).join('|') === 'Base task', 'Base shows only untagged tasks');

// Save while filtered keeps every task (the filter must never delete what it hides)
setPkg(w, 'seo');
await w.saveStageTemplates();
ok(w.__deleted === null && w.__saved?.length === 4, 'saving with a filter on keeps all 4 tasks and deletes none');

// Add Task while a package is showing: tagged with it, and visible
setPkg(w, 'ads');
w.addStageTemplateRow();
const last = [...d.querySelectorAll('.tpl-stage-row')].pop();
ok(!last.classList.contains('hidden') && last.querySelector('.ob-chip-svc[data-key="ads"]').getAttribute('aria-pressed') === 'true', 'a new task under Ads starts tagged Ads and stays visible');
setPkg(w, 'base');
w.addStageTemplateRow();
const last2 = [...d.querySelectorAll('.tpl-stage-row')].pop();
ok(!last2.classList.contains('hidden') && !last2.querySelector('.ob-chip-svc[aria-pressed="true"]'), 'a new task under Base starts untagged and visible');

// Switching stage keeps the package choice
setPkg(w, 'ads');
d.getElementById('tpl-stage-picker').value = 'Campaign Building';
w.renderStageTemplates();
ok(shownTitles(w).join('|') === 'Launch' && d.getElementById('tpl-stage-package').value === 'ads', 'switching stage keeps the package filter');
setPkg(w, 'seo');
ok(shownTitles(w).length === 0 && /Showing 0 SEO Growth tasks of 1 task created when a client enters Campaign Building/.test(d.getElementById('tpl-stage-status').innerText), 'a package with nothing in a stage shows none and says so');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
