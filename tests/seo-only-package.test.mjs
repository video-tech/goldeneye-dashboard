// SEO only (clients.base_package = 'no', supabase/sql/seo_only_package.sql): the app.js side. Runs the REAL code and
// markup, cut out of app.js and body.html, in jsdom against a fake database.
//   JSDOM_DIR=/path/to/dir node tests/seo-only-package.test.mjs
// Checks: the Templates editor shows and KEEPS the Package tag (a save that dropped it would hand SEO-only clients every
// GHL step), the preview passes it, Add / Edit Client save it and refuse SEO only without SEO, a missing column never
// quietly drops an SEO-only choice, the team step offers no GHL login to an SEO-only client, and the Roster shows it.
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
const cut = (src, from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a + 1); if (a < 0 || b < 0) throw new Error('marker ' + (a < 0 ? from : to)); return src.slice(a, b); };

const tagCode = cut(app, 'const WEBSITE_STATUS_LABELS', '// ---- Services editor (Templates');
const previewCode = cut(app, 'let obPreviewSeq = 0;', "    const checkLabel = key =>") + '};';
const seoOnlyCode = cut(app, '// SEO only (clients.base_package', 'function obClientWebsiteStatus');
const teamRowCode = cut(app, 'function obTeamRowHtml', 'function obTeamStepHtml');
const packageCode = cut(app, 'const PACKAGE_LIVE', '// The pop-up: Edit on a Roster');
const editSave = cut(app, 'window.saveClientEdits = async function', '// ================= CLIENT PORTAL PREVIEW');
const addSave = cut(app, 'window.saveNewClient = async function', "        // Add to local cache and refresh UI") + '} catch (err) { alert("Error creating client: " + err.message); } finally { btn.disabled = false; } };';
const editModalFull = body.slice(body.indexOf('<div id="edit-client-modal"'), body.indexOf('</form>', body.indexOf('<div id="edit-client-modal"')) + 7);
const addModal = body.slice(body.indexOf('<div id="add-client-modal"'), body.indexOf('</form>', body.indexOf('<div id="add-client-modal"')) + 7);
const previewBar = body.slice(body.indexOf('<select id="ob-preview-website"'), body.indexOf('<div id="ob-preview-result"'));

function world({ clients = [], updateError = null, insertError = null } = {}) {
    const dom = new JSDOM(`<!doctype html><body>${editModalFull}${addModal}${previewBar}<div id="ob-preview-result"></div>
        <div id="ob-preview-services"></div><div id="tags"></div><div id="team"></div>
        <div id="page-goldeneye" class="hidden"></div><div id="page-roster" class="hidden"></div><div id="page-tasks" class="hidden"></div><div id="page-clients" class="hidden"></div></body>`,
        { runScripts: 'dangerously' });
    const w = dom.window;
    w.__calls = []; w.__alerts = []; w.__updateError = updateError; w.__insertError = insertError; w.__clients = clients;
    w.eval(`
        const escapeAttr = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
        const stripSlashEscapes = (s) => String(s ?? '');
        const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const normalizeAccountId = (s) => String(s || '').replace(/\\D/g, '');
        var currentUserRole = 'admin', cSelectedAccount = 'Acme', currentActiveClient = 'Acme', globalAllowedClients = [];
        var globalServices = [{ key: 'ads', name: 'Ads management', sort_order: 1 }, { key: 'seo', name: 'SEO Growth', sort_order: 2 }];
        var globalClientServices = [{ client_name: 'Acme', service_key: 'seo', status: 'onboarding' }];
        var globalOnboardingSteps = [{ id: 's1', fact_conditions: {} }], globalStageTemplates = [];
        var globalClientsData = __clients, portalClientRows = [];
        window.alert = (m) => __alerts.push(String(m)); window.confirm = () => true;
        async function fetchAllGlobalData() {} function initClientsPage() {} function renderGoldenEye() {} function renderRoster() {}
        function initTasksPage() {} function filterAdsData() {}
        async function applyClientServiceChanges() {} function planClientServiceChanges() { return {}; }
        async function grantPortalAccessToAll() { return []; }
        window.checkGhlContact = () => {};
        const q = (table) => ({
            update(patch) { return { eq: async (k, v) => { __calls.push({ op: 'update', table, patch: { ...patch } });
                return { error: __updateError && 'base_package' in patch ? __updateError : null }; } }; },
            insert(rows) { return { select: async () => { __calls.push({ op: 'insert', table, rows }); return __insertError ? { data: null, error: __insertError } : { data: rows, error: null }; } }; },
        });
        var supabaseClient = { from: q, rpc: async (fn, args) => { __calls.push({ op: 'rpc', fn, args }); return { data: null, error: { message: 'stop' } }; } };
        async function loadAutoCheckCatalog() { return []; }
        ${tagCode.replace('function loadAutoCheckCatalog', 'function _unusedLoadAutoCheckCatalog')}
        ${seoOnlyCode}
        ${teamRowCode}
        ${packageCode}
        ${previewCode}
        ${editSave}
        ${addSave}
    `);
    return w;
}

// ---- Templates: the Package tag shows, and survives a save ----
{
    const w = world();
    const d = w.document;
    d.getElementById('tags').innerHTML = `<div class="row">${w.conditionEditorHtml({ service_keys: [], website_statuses: [], fact_conditions: { base_package: ['yes'], crm_choice: ['yes'] } })}</div>`;
    const chips = [...d.querySelectorAll('.ob-chip-fact[data-fact="base_package"]')];
    ok(chips.map((c) => c.textContent.trim()).join('|') === 'Base|No Base', 'the editor offers Base and No Base chips: ' + chips.map((c) => c.textContent.trim()));
    ok(chips.find((c) => c.dataset.key === 'yes').getAttribute('aria-pressed') === 'true', 'a step tagged Base shows its chip pressed');
    const read = w.readConditions(d.querySelector('.row'));
    ok(JSON.stringify(read.fact_conditions) === JSON.stringify({ crm_choice: ['yes'], base_package: ['yes'] }), 'saving keeps the Package tag next to the others: ' + JSON.stringify(read.fact_conditions));
}

// ---- Templates preview passes the package ----
{
    const w = world();
    w.document.getElementById('ob-preview-package').value = 'no';
    await w.runOnboardingPreview();
    const call = w.__calls.find((c) => c.fn === 'onboarding_preview');
    ok(call && call.args.p_facts?.base_package === 'no', 'Preview a Client sends the SEO-only package: ' + JSON.stringify(call?.args));
    const w2 = world();
    await w2.runOnboardingPreview();
    ok(!('p_facts' in (w2.__calls.find((c) => c.fn === 'onboarding_preview')?.args || {})), 'nothing picked sends no facts (works before the SQL)');
}

// ---- Edit Client ----
function editWorld(opts) {
    const w = world(opts), d = w.document;
    d.getElementById('edit-client-id').value = '7';
    d.getElementById('edit-client-original-name').value = 'Acme';
    d.getElementById('edit-client-name').value = 'Acme';
    d.getElementById('edit-client-services').innerHTML = w.packageRowsHtml('Acme', 'edit');
    return w;
}
const seoBox = (w) => w.document.querySelector('#edit-client-services .pkg-row[data-key="seo"] .pkg-box');
const ev = { preventDefault() {} };
{
    const w = editWorld();
    w.document.getElementById('edit-client-base-package').value = 'no';
    await w.saveClientEdits(ev);
    const up = w.__calls.find((c) => c.op === 'update' && c.table === 'clients');
    ok(up && up.patch.base_package === 'no', 'Edit Client saves SEO only as base_package = no');
}
{
    const w = editWorld();
    await w.saveClientEdits(ev);
    const up = w.__calls.find((c) => c.op === 'update' && c.table === 'clients');
    ok(up && up.patch.base_package === null, 'Base + add-ons saves null (unchanged default)');
}
{
    const w = editWorld();
    w.document.getElementById('edit-client-base-package').value = 'no';
    seoBox(w).checked = false;
    await w.saveClientEdits(ev);
    ok(!w.__calls.some((c) => c.op === 'update') && /SEO Growth ticked/.test(w.__alerts.join()), 'No Base without Ads or SEO ticked is refused before anything saves');
}
{
    // Ads only, no Base (2026-10-23: Tattoo Ink Utah)
    // Acme already runs Ads and has no SEO, so the save changes the package and nothing else
    const w = world(), d = w.document;
    w.globalClientServices.splice(0, w.globalClientServices.length, { client_name: 'Acme', service_key: 'ads', status: 'active' });
    d.getElementById('edit-client-id').value = '7';
    d.getElementById('edit-client-original-name').value = 'Acme';
    d.getElementById('edit-client-name').value = 'Acme';
    d.getElementById('edit-client-services').innerHTML = w.packageRowsHtml('Acme', 'edit');
    d.getElementById('edit-client-base-package').value = 'no';
    ok(!seoBox(w).checked && d.querySelector('#edit-client-services .pkg-row[data-key="ads"] .pkg-box').checked, 'the Ads-only client shows Ads ticked and SEO not');
    await w.saveClientEdits(ev);
    const up = w.__calls.find((c) => c.op === 'update' && c.table === 'clients');
    ok(up && up.patch.base_package === 'no' && !w.__alerts.length, 'Edit Client saves No Base with Ads ticked and SEO not: ' + w.__alerts.join());
}
{
    // Column not there yet: Base saves without it, SEO only is refused rather than saved as Base
    const missing = { message: 'Could not find the base_package column of clients in the schema cache', code: 'PGRST204' };
    const w = editWorld({ updateError: missing });
    await w.saveClientEdits(ev);
    const ups = w.__calls.filter((c) => c.op === 'update' && c.table === 'clients');
    ok(ups.length === 2 && !('base_package' in ups[1].patch) && !w.__alerts.length, 'before the SQL, a Base save retries without the column');
    const w2 = editWorld({ updateError: missing });
    w2.document.getElementById('edit-client-base-package').value = 'no';
    await w2.saveClientEdits(ev);
    ok(w2.__calls.filter((c) => c.op === 'update' && c.table === 'clients').length === 1 && /seo_only_package\.sql/.test(w2.__alerts.join()),
        'before the SQL, SEO only is refused with the file to run, never saved as Base: ' + w2.__alerts.join());
}

// ---- Add Client ----
function addWorld(opts) {
    const w = world(opts), d = w.document;
    d.getElementById('new-client-name').value = 'Newco';
    d.getElementById('new-client-email').value = 'a@newco.com';
    d.getElementById('new-client-services').innerHTML = `<input type="checkbox" class="client-service-box" value="seo">`;
    return w;
}
{
    const w = addWorld();
    w.document.querySelector('#new-client-services .client-service-box').checked = true;
    w.document.getElementById('new-client-base-package').value = 'no';
    await w.saveNewClient(ev);
    const ins = w.__calls.find((c) => c.op === 'insert');
    ok(ins && ins.rows[0].base_package === 'no', 'Add Client saves SEO only');
}
{
    const w = addWorld();
    await w.saveNewClient(ev);
    const ins = w.__calls.find((c) => c.op === 'insert');
    ok(ins && !('base_package' in ins.rows[0]), 'Add Client leaves the column off for Base, so it works before the SQL');
}
{
    const w = addWorld();
    w.document.getElementById('new-client-base-package').value = 'no';
    await w.saveNewClient(ev);
    ok(!w.__calls.some((c) => c.op === 'insert') && /SEO Growth ticked/.test(w.__alerts.join()), 'Add Client refuses No Base without Ads or SEO ticked');
}
{
    const w = addWorld();
    w.document.getElementById('new-client-services').innerHTML = '<input type="checkbox" class="client-service-box" value="ads"><input type="checkbox" class="client-service-box" value="seo">';
    w.document.querySelector('#new-client-services .client-service-box[value="ads"]').checked = true;
    w.document.getElementById('new-client-base-package').value = 'no';
    await w.saveNewClient(ev);
    const ins = w.__calls.find((c) => c.op === 'insert');
    ok(ins && ins.rows[0].base_package === 'no', 'Add Client saves No Base with only Ads ticked: ' + w.__alerts.join());
}
{
    const w = addWorld({ insertError: { message: 'column "base_package" of relation "clients" does not exist' } });
    w.document.querySelector('#new-client-services .client-service-box').checked = true;
    w.document.getElementById('new-client-base-package').value = 'no';
    await w.saveNewClient(ev);
    ok(/seo_only_package\.sql/.test(w.__alerts.join()) && /wasn't created/.test(w.__alerts.join()), 'before the SQL, an SEO-only Add Client says what to run: ' + w.__alerts.join());
}

// ---- The team step: no GHL login for SEO only ----
{
    const w = world({ clients: [{ name: 'Acme', base_package: 'no' }] });
    const html = w.obTeamRowHtml('s1', { contact_name: 'Ann', phone: '8015550100', ghl_login: true }, true);
    ok(!/ob-team-login/.test(html) && !/Give them a login/.test(html), 'an SEO-only client is not offered a GHL login');
    const w2 = world({ clients: [{ name: 'Acme', base_package: null }] });
    ok(/Give them a login/.test(w2.obTeamRowHtml('s1', null, true)), 'a Base client still is');
    const w3 = world();
    w3.eval(`portalClientRows = [{ name: 'Acme', base_package: 'no' }]`);
    ok(w3.clientIsSeoOnly('ACME'), 'the portal side reads the package too (and matches names loosely)');
}

// ---- The Roster profile line ----
ok(/\['Package', c\.base_package === 'no' \? 'No Base \(no GHL\)' : 'Base \+ add-ons'\]/.test(app), 'the Roster profile shows the package');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
