// The GHL contact check in Golden Eye (app.js): the notice on a client's onboarding progress and Roster profile, and the
// Check now button. Runs the REAL code, cut out of app.js, in jsdom with a fake check function.
//   JSDOM_DIR=/path/to/dir node tests/ghl-contact.test.mjs
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
const code = [
    cut('        const normalize = (str) => {', '        // Escapes for a JS string literal'),
    cut('        const escapeAttr = (str) =>', '        // Repairs values already corrupted'),
    cut('// ---- Is the client a contact in our Midas GHL?', '// ---- question logic (pure; no page needed) ----'),
].join('\n');

function world({ role = 'admin', rows = [], answer = null } = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="out"></div></body>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.__calls = [];
    w.__answer = answer;
    w.eval(`
        var currentUserRole = ${JSON.stringify(role)};
        var supabaseClient = {
            from: () => ({ select: async () => ({ data: ${JSON.stringify(rows)}, error: null }) }),
            auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
        };
        window.fetch = async (url, init) => { __calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
            return { ok: true, status: 200, json: async () => __answer }; };
        window.alert = (m) => __calls.push({ alert: m });
        function renderClientOnboarding() { __calls.push({ redraw: 'onboarding' }); }
        ${code}
        window.__t = { load: loadGhlContactChecks, notice: ghlContactNoticeHtml, rows: () => globalGhlContacts };
    `);
    return { w, t: w.__t, d: w.document };
}

{
    const { t } = world({ rows: [
        { client_name: 'Found Co', email: 'a@found.com', status: 'found', checked_at: '2026-10-16T14:00:00Z' },
        { client_name: 'Missing Co', email: 'x@missing.com', status: 'missing', checked_at: '2026-10-16T14:00:00Z' },
        { client_name: 'Dup Co', email: 'd@dup.com', status: 'duplicate', matches: 2 },
        { client_name: 'Err Co', email: 'e@err.com', status: 'error', error: '<b>401</b> bad key' },
    ] });
    await t.load();
    ok(t.notice('Found Co') === '', 'a client who is found shows nothing on their onboarding progress');
    ok(/In our GHL/.test(t.notice('Found Co', { always: true })), 'the Roster profile says they are in our GHL');
    ok(/Not in our GHL/.test(t.notice('Missing Co')) && /x@missing\.com/.test(t.notice('Missing Co')), 'a missing client is warned about, with the email that was checked');
    ok(/More than one contact/.test(t.notice('Dup Co')), 'a duplicate is warned about');
    ok(/reach GHL/.test(t.notice('Err Co')) && !t.notice('Err Co').includes('<b>') && t.notice('Err Co').includes('&lt;b&gt;'), 'an error says so, escaped');
    ok(t.notice('Unchecked Co') === '' && /Not checked/.test(t.notice('Unchecked Co', { always: true })), 'an unchecked client is quiet on onboarding, and says "not checked" on the Roster');
    ok(t.notice('ALL') === '', 'nothing for "All"');
}
{
    const { t } = world({ role: 'client', rows: [{ client_name: 'Missing Co', status: 'missing' }] });
    await t.load();
    ok(t.notice('Missing Co', { always: true }) === '' && t.rows().length === 0, 'clients never load or see the check');
}
{
    const { w, t, d } = world({ rows: [{ client_name: 'Missing Co', email: 'x@missing.com', status: 'missing' }],
        answer: { checked: 1, results: [{ client_name: 'Missing Co', email: 'x@missing.com', status: 'found', contact_id: 'c1', matches: 1 }] } });
    await t.load();
    d.getElementById('out').innerHTML = t.notice('Missing Co');
    const btn = d.querySelector('.ghl-contact-notice button');
    await w.checkGhlContact(btn.dataset.client, btn);
    const call = w.__calls.find((c) => c.url);
    ok(call && /ghl-contact-check$/.test(call.url) && call.body.client === 'Missing Co' && call.auth === 'Bearer jwt', 'Check now asks the check function, as the signed-in admin, for that client');
    ok(t.rows().find((r) => r.client_name === 'Missing Co').status === 'found' && t.notice('Missing Co') === '', 'the new answer replaces the old one, and the warning goes');
    ok(w.__calls.some((c) => c.redraw === 'onboarding') && btn.innerText === 'Check now' && !btn.disabled, 'the onboarding progress redraws and the button is ready again');
}
{
    const { w } = world({ answer: { error: 'Set GHL_MIDAS_TOKEN first' } });
    await w.checkGhlContact('Any Co', null, { quiet: true });
    ok(!w.__calls.some((c) => c.alert), 'a background check that fails stays quiet');
    await w.checkGhlContact('Any Co', null);
    ok(w.__calls.some((c) => c.alert && /GHL_MIDAS_TOKEN/.test(c.alert)), 'Check now says why it failed');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
