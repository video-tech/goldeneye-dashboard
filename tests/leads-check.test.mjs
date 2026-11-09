// The report pop-up's Leads check (app.js renderLeadsCheck and friends): Golden Eye, Meta and GHL lead counts side by side.
// Runs the REAL code, cut out of app.js, in jsdom against a fake database and a fake ghl-leads function.
//   JSDOM_DIR=/path/to/dir node tests/leads-check.test.mjs
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
const body = fs.readFileSync(path.join(root, 'body.html'), 'utf8');
const cut = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a + 1); if (a < 0 || b < 0) throw new Error('marker ' + (a < 0 ? from : to)); return app.slice(a, b); };
const code = [
    cut('        const normalize = (str) => {', '        // Escapes for a JS string literal'),
    cut('        const escapeAttr = (str) =>', '        // Repairs values already corrupted'),
    cut('        const normalizeAccountId = (val) =>', '        // Phone numbers arrive in many shapes'),
    cut('function adFactsYmd(d)', '\n') + '\n',
    cut('// Leads check (2026-11-09)', 'window.addLeadTag = addLeadTag;'),
].join('\n');

// Markup is real: the box and the Edit Client field exist in body.html
ok(body.includes('id="rpt-leads-check"'), 'the Leads check box is in the report pop-up');
ok(body.includes('id="edit-client-lead-tags"'), 'Edit Client has a GHL lead tags field');
ok(/buildLeadsCheckBlock\(cSelectedAccount, s, e\)/.test(app) && /\$\{adActivityBlock\}\$\{leadsCheckBlock\}/.test(app), 'the fact goes into the report prompt');
ok(/modal\.style\.display = 'flex';\n    renderLeadsCheck\(\);/.test(app), 'opening the report runs the check');

function world({ role = 'admin', client = { id: 1, name: 'Acme', ad_account_id: 'act_123', lead_tags: ['fb lead'] }, reports = [], meta = [], ghl, metaError = false } = {}) {
    const w = new JSDOM('<!doctype html><body><div id="rpt-leads-check" style="display:none"></div></body>', { runScripts: 'dangerously' }).window;
    w.__ghl = ghl; w.__meta = meta; w.__metaError = metaError; w.__updates = [];
    w.eval(`
        var currentUserRole = ${JSON.stringify(role)}, cSelectedAccount = 'Acme', cDateRange = 'custom', cCustomStart = '2026-11-02', cCustomEnd = '2026-11-08';
        var globalClientsData = [${JSON.stringify(client)}];
        function reportsForClient() { return ${JSON.stringify(reports)}; }
        function dateRangeFor(k, a, b) { return { s: new Date(a + 'T00:00:00'), e: new Date(b + 'T23:59:59') }; }
        var supabaseClient = {
            auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
            from: () => {
                const q = { select() { return q; }, eq() { return q; }, gte() { return q; }, lte() { return q; }, order() { return q; },
                    range() { return Promise.resolve(window.__metaError ? { data: null, error: { message: 'x' } } : { data: window.__meta, error: null }); },
                    update(v) { window.__updates.push(v); return { eq: async () => ({ error: null }) }; } };
                return q;
            }
        };
        var fetch = async (url, init) => {
            window.__lastBody = JSON.parse(init.body);
            const g = window.__ghl;
            if (g && g.http) return { ok: false, status: g.http, json: async () => ({ error: g.error }) };
            return { ok: true, status: 200, json: async () => g };
        };
        ${code}
    `);
    return w;
}
const box = (w) => w.document.getElementById('rpt-leads-check');
const rows = (w) => [...box(w).querySelectorAll('div[style*="justify-content:space-between"]')].map(d => d.textContent.replace(/\s+/g, ' ').trim());
const ghlOk = (tagged, extra = {}) => ({ status: 'ok', added: tagged + 3, tagged, lead_tags: ['fb lead'], tags_column: true, truncated: false,
    by_day: ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'].map((d, i) => ({ date: d, added: 0, tagged: i === 0 ? tagged : 0 })),
    other_tags: [{ name: 'referral', count: 2 }], sources: [], ...extra });
const rep = (date, leads) => ({ date, leads: String(leads) });

// ---- the gap rule ----
{
    const w = world({ ghl: ghlOk(0) });
    const gap = w.eval('leadsCheckGap');
    ok(gap(10, 12) === false, '2 apart is never a gap');
    ok(gap(10, 13) === true, '3 apart on 13 (23%) is a gap');
    ok(gap(40, 43) === false, '3 apart on 43 (7%) is not');
    ok(gap(20, 24) === true && gap(20, 23) === false, 'edge: 4 of 24 (16.7%) yes, 3 of 23 no');
    ok(gap(5, null) === false && gap(null, 5) === false, 'a missing side is never a gap');
}

// ---- all three counts ----
{
    const w = world({ reports: [rep('2026-11-02', 8), rep('2026-11-03', 2), rep('2026-11-09', 50), rep('2026-11-01', 50)], meta: [{ date: '2026-11-02', leads: 9 }, { date: '2026-11-03', leads: 2 }], ghl: ghlOk(14) });
    await w.eval('renderLeadsCheck()');
    const r = rows(w);
    ok(box(w).style.display === '', 'box shown');
    ok(r.length === 3, 'three rows');
    ok(/Golden Eye.*10$/.test(r[0]), 'Golden Eye sums only days in range (10)');
    ok(/Meta.*11$/.test(r[1]), 'Meta summed (11), not flagged');
    ok(/GHL.*14.*check/.test(r[2]), 'GHL 14 against 10 is flagged');
    ok(/tagged fb lead/.test(r[2]), 'says which tags were counted');
    const sent = w.__lastBody;
    ok(sent.client === 'Acme' && sent.start === '2026-11-02' && sent.end === '2026-11-08', 'asks ghl-leads for the report dates');
    ok(box(w).querySelectorAll('details tr').length === 8, 'by-day table has every day');
    const fact = w.eval("buildLeadsCheckBlock('Acme', new Date('2026-11-02T00:00:00'), new Date('2026-11-08T23:59:59'))");
    ok(/14 contacts tagged as leads/.test(fact) && /shows 10/.test(fact) && /Do not mention the CRM count/.test(fact), 'report gets the fact, with the daily pull as headline');
    ok(w.eval("buildLeadsCheckBlock('Acme', new Date('2026-11-01T00:00:00'), new Date('2026-11-08T23:59:59'))") === '', 'no fact for different dates');
    ok(w.eval("buildLeadsCheckBlock('Other', new Date('2026-11-02T00:00:00'), new Date('2026-11-08T23:59:59'))") === '', 'no fact for another client');
}

// ---- degrade states ----
{
    let w = world({ ghl: { status: 'no_location', error: 'No GHL location ID is saved for this client. Add it in Edit Client.' } });
    await w.eval('renderLeadsCheck()');
    ok(/GHL.*Edit Client.*—$/.test(rows(w)[2]), 'no location: says where to add it');
    ok(w.eval("buildLeadsCheckBlock('Acme', new Date('2026-11-02T00:00:00'), new Date('2026-11-08T23:59:59'))") === '', 'no fact without GHL data');

    w = world({ ghl: { status: 'no_tags', added: 7, lead_tags: [], tags_column: true, other_tags: [{ name: 'FB <b>lead', count: 5 }], by_day: [] } });
    await w.eval('renderLeadsCheck()');
    ok(/7 contacts added, no lead tags set/.test(rows(w)[2]), 'no tags: count of contacts shown');
    const btn = box(w).querySelector('button');
    ok(btn && btn.textContent.includes('FB <b>lead') && !box(w).querySelector('b'), 'tags offered, escaped');
    btn.click();
    await new Promise(r => setTimeout(r, 0));
    ok(w.__updates.length === 1 && JSON.stringify(w.__updates[0].lead_tags) === '["fb lead","fb <b>lead"]', 'clicking a tag saves it lower-cased with the existing ones');

    w = world({ ghl: { http: 403, error: 'Signed in as x, whose role is "member", not admin.' } });
    await w.eval('renderLeadsCheck()');
    ok(/GHL.*not admin.*—$/.test(rows(w)[2]), 'function refusal shown, not thrown');

    w = world({ client: { id: 1, name: 'Acme', ad_account_id: '', lead_tags: [] }, ghl: ghlOk(0) });
    await w.eval('renderLeadsCheck()');
    ok(/Meta.*not synced.*—$/.test(rows(w)[1]), 'no ad account: Meta not synced');
    w = world({ metaError: true, ghl: ghlOk(0) });
    await w.eval('renderLeadsCheck()');
    ok(/Meta.*—/.test(rows(w)[1]), 'Meta query failing: dash, no crash');

    w = world({ role: 'member', ghl: ghlOk(3) });
    await w.eval('renderLeadsCheck()');
    ok(box(w).style.display === 'none' && w.__lastBody === undefined, 'non-admins see nothing and nothing is asked');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
