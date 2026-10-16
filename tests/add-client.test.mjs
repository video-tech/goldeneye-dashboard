// Add client (app.js saveNewClient): refuses a name that already exists (a duplicated name broke the onboarding view for
// every client), and redraws the Roster when it was opened from there. Runs the REAL function, cut out of app.js, in jsdom.
//   JSDOM_DIR=/path/to/dir node tests/add-client.test.mjs
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
const line = (start) => { const a = app.indexOf(start); return app.slice(a, app.indexOf('\n', a)); };
const body = fs.readFileSync(path.join(root, 'body.html'), 'utf8');
const code = [
    cut('        const normalize = (str) => {', '        // Escapes for a JS string literal'),
    line('        const stripSlashEscapes = (str) =>'),
    cut('window.saveNewClient = async function(e) {', '\n};\n'),
].join('\n');

async function world({ rosterOpen = true } = {}) {
    const dom = new JSDOM(`<!doctype html><body>
        <form id="add-client-form"><input id="new-client-name"><input id="new-client-contact-name"><input id="new-client-industry"><input id="new-client-email" value="owner@new.com">
        <input id="new-client-ad-account"><input id="new-client-business-id"><select id="new-client-contract"><option value="m">m</option></select><input id="new-client-retainer" value="0">
        <select id="new-client-website-status"><option value="existing">x</option></select><button id="btn-save-new-client"></button></form>
        <div id="add-client-modal" style="display:flex"></div>
        <div id="page-tasks" class="hidden"></div><div id="page-clients" class="hidden"></div><div id="page-roster" class="${rosterOpen ? '' : 'hidden'}"></div>
    </body>`, { runScripts: 'dangerously' });
    const w = dom.window;
    w.__calls = [];
    w.eval(`
        var globalClientsData = [{ name: 'Acme Decks', status: 'active' }, { name: 'Old Co', status: 'archived' }], globalAllowedClients = [];
        var supabaseClient = { from: (t) => ({ insert: (rows) => ({ select: async () => { __calls.push({ insert: t, rows }); return { data: rows, error: null }; } }) }) };
        const normalizeAccountId = (v) => String(v || '').replace(/\\D/g, '');
        function planClientServiceChanges() { return {}; }
        async function applyClientServiceChanges() {}
        async function grantPortalAccessToAll() { return ['owner@new.com']; }
        async function fetchAllGlobalData() {}
        function cSelectAccount() {}
        function initTasksPage() {}
        function filterAdsData() {}
        function renderRoster() { __calls.push({ roster: true }); }
        window.alert = (m) => __calls.push({ alert: m });
        ${code}
    `);
    return w;
}
const submit = async (w, name) => { w.document.getElementById('new-client-name').value = name; await w.saveNewClient({ preventDefault() {} }); };

{
    const w = await world();
    await submit(w, 'acme  DECKS');
    ok(!w.__calls.some((c) => c.insert) && w.__calls.some((c) => c.alert && /already a client called "Acme Decks"/.test(c.alert)), 'a name that matches an existing client (ignoring case and spaces) is refused');
    ok(w.document.getElementById('btn-save-new-client').disabled === false, 'the button works again after a refusal');
    await submit(w, 'Old Co');
    ok(!w.__calls.some((c) => c.insert) && w.__calls.some((c) => c.alert && /\(archived\)/.test(c.alert)), 'an archived client\'s name is refused too, and says it is archived');
    await submit(w, '   ');
    ok(!w.__calls.some((c) => c.insert), 'a blank name is refused');
    await submit(w, 'Brand New Roofing');
    ok(w.__calls.some((c) => c.insert === 'clients' && c.rows[0].name === 'Brand New Roofing'), 'a new name is created');
    ok(w.__calls.some((c) => c.roster), 'the Roster redraws when the client was added from there');
}
{
    const w = await world({ rosterOpen: false });
    await submit(w, 'Another New Co');
    ok(w.__calls.some((c) => c.insert) && !w.__calls.some((c) => c.roster), 'the Roster is left alone when it is not open');
}
ok(/id="btn-roster-add-client"[^>]*onclick="openAddClientModal\(\)"/.test(body) && /id="page-roster"[\s\S]*btn-roster-add-client/.test(body), 'the Roster page has an Add client button that opens the Add Client form');
ok(/btn-roster-add-client'\)\?\.classList\.toggle\('hidden', currentUserRole !== 'admin'\)/.test(app), 'only admins see it');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
