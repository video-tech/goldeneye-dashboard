// The onboarding team step (app.js): the owner first, an email and a "Give them a login" box per person, saved to
// client_contacts for ghl-account to turn into GHL users. Runs the REAL code, cut out of app.js, in jsdom.
//   JSDOM_DIR=/path/to/dir node tests/team-step.test.mjs
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
    cut('// ---- Sales team step ----', '// Everything the client can see about their own account'),
].join('\n');

function world({ contacts = [], missingColumns = false } = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="out"></div></body>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.__saves = [];
    w.__missing = missingColumns;
    w.eval(`
        var currentActiveClient = 'Acme Decks', currentUserName = 'Pat', clientEmail = 'pat@acme.com';
        var globalContactsData = ${JSON.stringify(contacts)};
        function isCheckinContact(c) { return c.checkin_texts !== false; }
        async function obCompleteStep(id) { window.__completed = id; }
        var supabaseClient = { from: () => ({ upsert: (rows, opts) => ({ select: async () => {
            __saves.push({ rows, opts });
            if (__missing && rows.some(r => 'ghl_login' in r)) return { data: null, error: { code: 'PGRST204', message: "Could not find the 'ghl_login' column" } };
            return { data: rows.map((r, i) => ({ id: 'n' + i, ...r })), error: null };
        } }) }) };
        ${code}
        window.__t = { obTeamStepHtml };
    `);
    const d = w.document;
    d.getElementById('out').innerHTML = w.__t.obTeamStepHtml({ id: 'S1' }, false);
    const rows = () => [...d.querySelectorAll('.ob-team-row')];
    const fill = (row, name, phone, email, login) => {
        row.querySelector('.ob-team-name').value = name; row.querySelector('.ob-team-phone').value = phone;
        row.querySelector('.ob-team-email').value = email; row.querySelector('.ob-team-login').checked = login;
    };
    const err = () => d.getElementById('ob-team-error-S1');
    return { w, d, rows, fill, err };
}

{
    const { w, d, rows, fill, err } = world();
    ok(rows().length === 1 && rows()[0].dataset.owner === '1' && /You \(the owner\)/.test(rows()[0].textContent), 'the first row is the owner');
    ok(!rows()[0].querySelector('button[title="Remove"]'), 'the owner row cannot be removed');
    ok(rows()[0].querySelector('.ob-team-login').checked, 'a login is offered by default');

    await w.obSaveTeam('S1', false);
    ok(/your own name/.test(err().innerText) && !w.__saves.length, 'the owner\'s details come first');

    fill(rows()[0], 'Pat Smith', '801 555 0100', '', true);
    await w.obSaveTeam('S1', false);
    ok(/needs an email for their login/.test(err().innerText) && !w.__saves.length, 'a login needs an email');

    fill(rows()[0], 'Pat Smith', '801 555 0100', 'Pat@Acme.com', true);
    w.obAddTeamRow('S1');
    ok(rows()[1].querySelector('button[title="Remove"]'), 'other people can be removed');
    fill(rows()[1], 'Sam Sales', '801-555-0101', '', false);
    w.obAddTeamRow('S1');
    await w.obSaveTeam('S1', false);
    const saved = w.__saves.at(-1)?.rows ?? [];
    ok(saved.length === 2, 'empty extra rows are ignored; two people saved');
    ok(saved[0].role === 'owner' && saved[0].ghl_login === true && saved[0].email === 'pat@acme.com', 'the owner is saved as owner, with a login and a lower-cased email');
    ok(saved[1].role === 'sales' && saved[1].ghl_login === false && saved[1].email === null, 'someone without a login needs no email');
    ok(w.__completed === 'S1', 'saving completes the step');
}
{
    const { w, rows, fill } = world();
    fill(rows()[0], 'Pat Smith', '8015550100', 'pat@acme.com', true);
    w.obAddTeamRow('S1');
    fill(rows()[1], 'Sam Sales', '8015550101', 'sam@acme.com', true);
    await w.obSaveTeam('S1', true);
    const saved = w.__saves.at(-1).rows;
    ok(saved.length === 1 && saved[0].role === 'owner', '"It\'s just me" saves only the owner');
}
{
    const { w, rows, fill } = world({ missingColumns: true });
    fill(rows()[0], 'Pat Smith', '8015550100', 'pat@acme.com', true);
    await w.obSaveTeam('S1', false);
    ok(w.__saves.length === 2 && !('ghl_login' in w.__saves[1].rows[0]) && w.__completed === 'S1', 'before team_ghl_logins.sql runs, the team still saves (without the login choice)');
}
{
    const { rows } = world({ contacts: [
        { client_name: 'Acme Decks', contact_name: 'Sam Sales', phone: '1', email: 's@a.com', role: 'sales', ghl_login: false },
        { client_name: 'Acme Decks', contact_name: '<b>Pat</b>', phone: '2', email: 'p@a.com', role: 'owner', ghl_login: true },
    ] });
    ok(rows()[0].dataset.owner === '1' && rows()[0].querySelector('.ob-team-name').value === '<b>Pat</b>' && rows()[1].querySelector('.ob-team-login').checked === false,
        'saved people come back with the owner first and their own login choice; names stay text');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
