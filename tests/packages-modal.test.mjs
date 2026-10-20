// The Packages pop-up (Roster profile and Accounts page): records a client's add-ons without starting onboarding unless
// asked. Runs the REAL code and markup, cut out of app.js and body.html, in jsdom against a fake database.
//   JSDOM_DIR=/path/to/dir node tests/packages-modal.test.mjs
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
const code = cut('let packagesModalClient = null;', '// ---- Stage checklist editor');
const ma = body.indexOf('<div id="packages-modal"'), mb = body.indexOf('<!-- EDIT CLIENT MODAL -->', ma);
const modal = body.slice(ma, mb);
const btnLine = body.slice(body.indexOf('<button type="button" id="c-packages-btn"'), body.indexOf('</button>', body.indexOf('id="c-packages-btn"')) + 9);

function world({ role = 'admin', confirmAnswer = true, rows } = {}) {
    const dom = new JSDOM(`<!doctype html><body><style>.hidden{display:none}</style>${modal}${btnLine}<div id="edit-client-services"></div><div id="roster-detail"></div></body>`, { runScripts: 'dangerously' });
    const w = dom.window;
    w.__calls = []; w.__redraws = []; w.__confirmAnswer = confirmAnswer;
    w.__rows = rows || [
        { client_name: 'Acme', service_key: 'ads', status: 'active' },
        { client_name: 'Acme', service_key: 'seo', status: 'onboarding' },
        { client_name: 'Other', service_key: 'video', status: 'active' },
    ];
    w.eval(`
        const escapeAttr = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
        var currentUserRole = ${JSON.stringify(role)}, cSelectedAccount = 'Acme';
        var globalServices = [{ key: 'ads', name: 'Ads management', sort_order: 1 }, { key: 'seo', name: 'SEO Growth', sort_order: 2 }, { key: 'video', name: 'Video', active: false, sort_order: 3 }, { key: 'gbp', name: 'GBP boost', sort_order: 4 }];
        var globalClientServices = __rows.map(r => ({ ...r }));
        const serviceName = (k) => globalServices.find(s => s.key === k)?.name || k;
        async function loadOnboardingApplicability(names) { __redraws.push('applicability:' + names.join(',')); }
        function renderRosterDetail() { __redraws.push('roster'); }
        function renderClientOnboarding() { __redraws.push('onboarding'); }
        function renderClientOnboarding() { __redraws.push('onboarding'); }
        window.confirm = () => __confirmAnswer;
        const q = (table) => {
            const chain = { _f: [] };
            chain.insert = async (rows) => { __calls.push({ op: 'insert', table, rows }); rows.forEach(r => globalClientServices.push(r)); return { error: null }; };
            chain.update = (patch) => { const c = { patch, where: {} };
                c.eq = (k, v) => { c.where[k] = v; return c.where.client_name && c.where.service_key ? (__calls.push({ op: 'update', table, patch, where: { ...c.where } }), Promise.resolve({ error: null })) : c; };
                c.in = async (k, v) => { __calls.push({ op: 'update', table, patch, where: { ...c.where, [k]: v } }); return { error: null }; };
                return c; };
            chain.select = async () => ({ data: globalClientServices, error: null });
            return chain;
        };
        var supabaseClient = { from: q };
        ${code}
    `);
    return w;
}
const rowOf = (w, key) => w.document.querySelector(`.pkg-row[data-key="${key}"]`);

// Opening
let w = world();
w.openPackagesModal('Acme');
const d = w.document;
ok(d.getElementById('packages-modal').style.display === 'flex' && d.getElementById('packages-modal-client').textContent === 'Acme', 'opens for the client');
ok([...d.querySelectorAll('.pkg-row')].map(r => r.dataset.key).join('|') === 'ads|seo|gbp', 'offered add-ons only (a retired one the client never had stays out)');
ok(rowOf(w, 'ads').querySelector('.pkg-box').checked && rowOf(w, 'ads').querySelector('.pkg-status-select').value === 'active', 'Ads shows ticked, Active');
ok(rowOf(w, 'seo').querySelector('.pkg-status-select').value === 'onboarding', 'SEO shows Onboarding');
ok(!rowOf(w, 'gbp').querySelector('.pkg-box').checked && rowOf(w, 'gbp').querySelector('.pkg-new').classList.contains('hidden'), 'an add-on they don\'t have is unticked');

// Nothing changed: nothing written
await w.savePackagesModal();
ok(w.__calls.length === 0 && d.getElementById('packages-modal').style.display === 'none', 'saving with no change writes nothing and closes');

// Newly ticked defaults to "already running" (active), no onboarding
w = world(); w.openPackagesModal('Acme');
let box = rowOf(w, 'gbp').querySelector('.pkg-box'); box.checked = true; w.packagesRowChanged(box);
ok(!rowOf(w, 'gbp').querySelector('.pkg-new').classList.contains('hidden'), 'ticking a new one asks: already running or new');
await w.savePackagesModal();
ok(w.__calls.length === 1 && w.__calls[0].op === 'insert' && w.__calls[0].rows[0].status === 'active' && w.__calls[0].rows[0].service_key === 'gbp' && w.__calls[0].rows[0].onboarded_at,
    'a new tick defaults to Active (recorded, no onboarding)');
ok(w.__redraws.includes('applicability:Acme') && w.__redraws.includes('roster') && w.__redraws.includes('onboarding'), 'reloads the client\'s steps and redraws the Roster and Accounts views');
ok(w.document.getElementById('c-packages-btn').innerHTML.includes('GBP boost'), 'the Accounts button shows the new package');
ok(w.packagesSummary('Acme').startsWith('Base + Ads management') && w.packagesSummary('Nobody') === 'Base only', 'the summary reads Base + add-ons');

// "New" starts onboarding
w = world(); w.openPackagesModal('Acme');
box = rowOf(w, 'gbp').querySelector('.pkg-box'); box.checked = true; w.packagesRowChanged(box);
rowOf(w, 'gbp').querySelector('input[value="onboarding"]').checked = true;
await w.savePackagesModal();
ok(w.__calls[0].rows[0].status === 'onboarding' && w.__calls[0].rows[0].onboarded_at === null, '"New" saves it as onboarding');

// Status change on one they have (Midas's SEO stuck on onboarding → active)
w = world(); w.openPackagesModal('Acme');
rowOf(w, 'seo').querySelector('.pkg-status-select').value = 'active';
await w.savePackagesModal();
ok(w.__calls.length === 1 && w.__calls[0].op === 'update' && w.__calls[0].patch.status === 'active' && w.__calls[0].where.service_key === 'seo' && w.__calls[0].where.client_name === 'Acme',
    'changing SEO to Active updates only that row');

// Re-ticking an ended one updates the existing row instead of inserting a duplicate
w = world({ rows: [{ client_name: 'Acme', service_key: 'ads', status: 'ended' }] }); w.openPackagesModal('Acme');
box = rowOf(w, 'ads').querySelector('.pkg-box'); box.checked = true; w.packagesRowChanged(box);
await w.savePackagesModal();
ok(w.__calls.length === 1 && w.__calls[0].op === 'update' && w.__calls[0].patch.status === 'active', 're-ticking an ended package updates its row');

// Unticking ends it, after a confirm; cancelling writes nothing
w = world({ confirmAnswer: false }); w.openPackagesModal('Acme');
rowOf(w, 'ads').querySelector('.pkg-box').checked = false;
await w.savePackagesModal();
ok(w.__calls.length === 0, 'cancelling the end confirm writes nothing');
w = world(); w.openPackagesModal('Acme');
rowOf(w, 'ads').querySelector('.pkg-box').checked = false;
await w.savePackagesModal();
ok(w.__calls.length === 1 && w.__calls[0].patch.status === 'ended' && JSON.stringify(w.__calls[0].where.service_key) === '["ads"]', 'unticking ends it after the confirm');

// Admins only
w = world({ role: 'member' }); w.openPackagesModal('Acme');
ok(w.document.getElementById('packages-modal').style.display !== 'flex', 'a non-admin can\'t open it');
w.eval(`packagesModalClient = 'Acme'`); await w.savePackagesModal();
ok(w.__calls.length === 0, 'a non-admin can\'t save');

// Wiring
ok(/onclick="openPackagesModal\(this\.dataset\.client\)">Edit<\/button>/.test(app), 'the Roster profile has an Edit link on services');
ok(/const showPkg = currentUserRole === 'admin' && stageClient && cSelectedAccount !== 'ALL';/.test(app), 'the Accounts page button shows for admins only');
ok(!/openPackagesModal|pkg-row/.test(body.slice(body.indexOf('id="client-portal-container"'), body.indexOf('id="cp-view-knowledge"'))), 'nothing about packages in the client portal');

// Edit Client uses the same rows, with its own radio groups
w = world();
w.document.getElementById('edit-client-services').innerHTML = w.packageRowsHtml('Acme', 'edit');
w.openPackagesModal('Acme');
const eb = w.document.querySelector('#edit-client-services .pkg-row[data-key="gbp"] .pkg-box'); eb.checked = true; w.packagesRowChanged(eb);
w.document.querySelector('#edit-client-services .pkg-row[data-key="gbp"] input[value="onboarding"]').checked = true;
ok(w.document.querySelector('#packages-modal-rows .pkg-row[data-key="gbp"] input[value="active"]').checked, 'Edit Client\'s choice doesn\'t move the pop-up\'s radio (separate groups)');
const ep = w.planPackageRows(w.document.getElementById('edit-client-services'));
ok(ep.insert.length === 1 && ep.insert[0].status === 'onboarding' && !ep.set.length && !ep.end.length, 'Edit Client plans from its own rows');
ok(/editPkgs\.innerHTML = packageRowsHtml\(c\.name, 'edit'\)/.test(app) && /const servicePlan = planPackageRows\(document\.getElementById\('edit-client-services'\)\);/.test(app) && /await applyPackagePlan\(newName, servicePlan\);/.test(app),
    'Edit Client renders, plans and saves with the new rows');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
