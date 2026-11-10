// The report pop-up's Leads check (app.js renderLeadsCheck and friends): Golden Eye, Meta and GHL lead counts side by side.
// GHL's count comes from ghl_contacts, which ghl-lead-webhook fills. Runs the REAL code, cut out of app.js, in jsdom
// against a fake database.
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

ok(body.includes('id="rpt-leads-check"'), 'the Leads check box is in the report pop-up');
ok(body.includes('id="edit-client-lead-tags"'), 'Edit Client has a GHL lead tags field');
ok(/buildLeadsCheckBlock\(cSelectedAccount, s, e\)/.test(app) && /\$\{adActivityBlock\}\$\{leadsCheckBlock\}/.test(app), 'the fact goes into the report prompt');
ok(/modal\.style\.display = 'flex';\n    renderLeadsCheck\(\);/.test(app), 'opening the report runs the check');
ok(!/ghl-leads/.test(app), 'no call to the retired ghl-leads function');

const CLIENT = { id: 1, name: 'Acme', ad_account_id: 'act_123', ghl_location_id: 'Loc123', lead_tags: ['fb lead'] };
function world({ role = 'admin', client = CLIENT, reports = [], meta = [], contacts = [], metaError = false, contactsError = null, siteCount = 0 } = {}) {
    const w = new JSDOM('<!doctype html><body><div id="rpt-leads-check" style="display:none"></div></body>', { runScripts: 'dangerously' }).window;
    w.__db = { meta, contacts, metaError, contactsError, siteCount, updates: [], asked: [] };
    w.eval(`
        var currentUserRole = ${JSON.stringify(role)}, cSelectedAccount = 'Acme', cDateRange = 'custom', cCustomStart = '2026-11-02', cCustomEnd = '2026-11-08';
        var globalClientsData = [${JSON.stringify(client)}];
        function reportsForClient() { return ${JSON.stringify(reports)}; }
        function dateRangeFor(k, a, b) { return { s: new Date(a + 'T00:00:00'), e: new Date(b + 'T23:59:59') }; }
        var supabaseClient = {
            from: (table) => {
                const db = window.__db; db.asked.push(table);
                const f = {};
                const q = {
                    select() { return q; }, order() { return q; }, neq(c, v) { f['neq_' + c] = v; return q; },
                    ...(table === 'lead_sources' ? { then(res) { window.__site = f; return Promise.resolve({ count: db.siteCount, error: null }).then(res); } } : {}),
                    eq(c, v) { f[c] = v; return q; }, gte(c, v) { f.gte = v; return q; }, lte(c, v) { f.lte = v; return q; }, lt(c, v) { f.lt = v; return q; },
                    limit() { return Promise.resolve(table === 'ghl_contacts' ? { data: db.contacts.filter(r => r.client_name === f.client_name).slice(0, 1), error: null } : { data: [], error: null }); },
                    range(a, b) {
                        if (table === 'meta_ad_daily') return Promise.resolve(db.metaError ? { data: null, error: { message: 'x' } } : { data: db.meta, error: null });
                        if (db.contactsError) return Promise.resolve({ data: null, error: db.contactsError });
                        const rows = db.contacts.filter(r => r.client_name === f.client_name && r.created_at >= f.gte && r.created_at < f.lt);
                        window.__bounds = { gte: f.gte, lt: f.lt };
                        return Promise.resolve({ data: rows.slice(a, b + 1), error: null });
                    },
                    update(v) { db.updates.push(v); return { eq: async () => ({ error: null }) }; },
                };
                return q;
            }
        };
        ${code}
    `);
    return w;
}
const box = (w) => w.document.getElementById('rpt-leads-check');
const rows = (w) => [...box(w).querySelectorAll('div[style*="justify-content:space-between"]')].map(d => d.textContent.replace(/\s+/g, ' ').trim());
const rep = (date, leads) => ({ date, leads: String(leads) });
const ct = (id, created_at, tags) => ({ ghl_contact_id: id, client_name: 'Acme', created_at, tags });

// ---- the gap rule ----
{
    const w = world();
    const gap = w.eval('leadsCheckGap');
    ok(gap(10, 12) === false, '2 apart is never a gap');
    ok(gap(10, 13) === true, '3 apart on 13 (23%) is a gap');
    ok(gap(40, 43) === false, '3 apart on 43 (7%) is not');
    ok(gap(20, 24) === true && gap(20, 23) === false, 'edge: 4 of 24 (16.7%) yes, 3 of 23 no');
    ok(gap(5, null) === false && gap(null, 5) === false, 'a missing side is never a gap');
}

// ---- Mountain time ----
{
    const w = world();
    ok(w.eval("denverMidnightUtc('2026-11-09').toISOString()") === '2026-11-09T07:00:00.000Z', 'MST midnight is 07:00 UTC');
    ok(w.eval("denverMidnightUtc('2026-07-01').toISOString()") === '2026-07-01T06:00:00.000Z', 'MDT midnight is 06:00 UTC');
    ok(w.eval("denverMidnightUtc('2026-11-01').toISOString()") === '2026-11-01T06:00:00.000Z', 'the day DST ends starts in MDT');
    ok(w.eval("denverDayOf('2026-11-10T06:59:59Z')") === '2026-11-09', '11:59pm Mountain is still that day');
}

// ---- all three counts ----
{
    const contacts = [
        ct('a', '2026-11-02T15:00:00Z', ['fb lead']),
        ct('b', '2026-11-02T16:00:00Z', ['FB Lead', 'quiz']),   // two tags, one lead; case ignored
        ct('c', '2026-11-03T16:00:00Z', ['referral']),
        ct('d', '2026-11-09T06:30:00Z', ['fb lead']),           // Nov 8, 11:30pm Mountain: in range
        ct('e', '2026-11-09T07:30:00Z', ['fb lead']),           // Nov 9 Mountain: out of range
        { ...ct('f', '2026-11-03T16:00:00Z', ['fb lead']), client_name: 'Other' },
    ];
    for (let i = 0; i < 11; i++) contacts.push(ct('x' + i, '2026-11-04T16:00:00Z', ['fb lead']));
    const w = world({ reports: [rep('2026-11-02', 8), rep('2026-11-03', 2), rep('2026-11-09', 50), rep('2026-11-01', 50)], meta: [{ date: '2026-11-02', leads: 9 }, { date: '2026-11-03', leads: 2 }], contacts });
    await w.eval('renderLeadsCheck()');
    const r = rows(w);
    ok(box(w).style.display === '' && r.length === 3, 'box shown with three rows');
    ok(/Golden Eye.*10$/.test(r[0]), 'Golden Eye sums only days in range (10)');
    ok(/Meta.*11$/.test(r[1]), 'Meta summed (11), not flagged');
    ok(/GHL.*14.*check/.test(r[2]), 'GHL counts each tagged contact once, in range, this client only (14), flagged against 10');
    ok(/tagged fb lead/.test(r[2]), 'says which tags were counted');
    ok(w.__bounds.gte === '2026-11-02T07:00:00.000Z' && w.__bounds.lt === '2026-11-09T07:00:00.000Z', 'asks the database for Mountain days');
    ok(box(w).querySelectorAll('details tr').length === 8, 'by-day table has every day');
    ok([...box(w).querySelectorAll('button')].some(b => b.textContent.includes('referral') && b.textContent.includes('quiz') === false), 'other tags offered');
    const fact = w.eval("buildLeadsCheckBlock('Acme', new Date('2026-11-02T00:00:00'), new Date('2026-11-08T23:59:59'))");
    ok(/14 contacts tagged as leads/.test(fact) && /shows 10/.test(fact) && /Do not mention the CRM count/.test(fact), 'report gets the fact, with the daily pull as headline');
    ok(w.eval("buildLeadsCheckBlock('Acme', new Date('2026-11-01T00:00:00'), new Date('2026-11-08T23:59:59'))") === '', 'no fact for different dates');
}

// ---- website leads counted apart (2026-11-10) ----
{
    const contacts = [
        ct('a', '2026-11-02T15:00:00Z', ['quiz ads']),
        ct('b', '2026-11-03T16:00:00Z', ['quiz ads']),
        ct('c', '2026-11-03T17:00:00Z', ['website lead']),
        ct('d', '2026-11-04T17:00:00Z', ['Website Lead']),
        ct('e', '2026-11-04T18:00:00Z', ['website lead']),
        ct('f', '2026-11-05T18:00:00Z', ['other']),
    ];
    const w = world({ client: { ...CLIENT, lead_tags: ['quiz ads'], website_lead_tags: ['website lead'] }, reports: [rep('2026-11-02', 1), rep('2026-11-03', 1)], contacts, siteCount: 3 });
    await w.eval('renderLeadsCheck()');
    const r = rows(w);
    ok(/GHL \(ad leads\).*2$/.test(r[2]), 'ad leads count only the ad tag (2), not website leads');
    ok(!/check/.test(r[2]), 'so no false gap against the daily pull');
    ok(r.length === 5 && /Golden Eye \(SEO tab\).*3$/.test(r[3]) && /GHL \(website leads\).*tagged website lead.*3$/.test(r[4]), 'website leads on their own lines (3 and 3)');
    ok(w.__site.neq_source === 'paid' && w.__site.gte === '2026-11-02T07:00:00.000Z', 'site count: every source except paid, Mountain days');
    ok(/GHL web/.test(box(w).querySelector('details').textContent), 'by-day table has a website column');
    ok(![...box(w).querySelectorAll('button')].some(b => b.textContent.includes('website lead')), 'website tags are not offered as ad tags');
    ok(/2 contacts tagged/.test(w.eval("buildLeadsCheckBlock('Acme', new Date('2026-11-02T00:00:00'), new Date('2026-11-08T23:59:59'))")), 'the report fact counts ad leads only');

    const w2 = world({ client: { ...CLIENT, lead_tags: ['quiz ads'], website_lead_tags: ['website lead'] }, contacts, siteCount: 9 });
    await w2.eval('renderLeadsCheck()');
    ok(/GHL \(website leads\).*3.*check/.test(rows(w2)[4]), 'a website gap is flagged against the SEO tab count');

    const w3 = world({ client: { ...CLIENT, lead_tags: [], website_lead_tags: ['website lead'] }, contacts });
    await w3.eval('renderLeadsCheck()');
    ok(/GHL \(ad leads\).*ge lead \(standard\).*0$/.test(rows(w3)[2]) && rows(w3).length === 5, 'website tags only: ad leads fall back to the standard ge lead tag');

    const w4 = world({ client: { ...CLIENT, lead_tags: ['quiz ads'] }, contacts });
    await w4.eval('renderLeadsCheck()');
    ok(rows(w4).length === 5 && /tagged website lead/.test(rows(w4)[4]), 'no website tags set: the standard website lead tag is used, shown because there are website leads');
    const w5 = world({ client: { ...CLIENT, lead_tags: ['quiz ads'] }, contacts: [ct('a', '2026-11-03T16:00:00Z', ['quiz ads'])] });
    await w5.eval('renderLeadsCheck()');
    ok(rows(w5).length === 3 && !/GHL web/.test(box(w5).textContent), 'standard website tag and no website leads anywhere: no website section');
    const w6 = world({ client: { ...CLIENT, lead_tags: [] }, contacts: [ct('a', '2026-11-03T16:00:00Z', ['quiz ads', 'ge lead']), ct('b', '2026-11-03T17:00:00Z', ['website lead', 'ge lead']), ct('c', '2026-11-03T18:00:00Z', ['quiz ads'])] });
    await w6.eval('renderLeadsCheck()');
    ok(/GHL \(ad leads\).*ge lead \(standard\).*1$/.test(rows(w6)[2]), 'no tags set: counts ge lead contacts; a website lead with ge lead is not an ad lead');
    ok(/GHL \(website leads\).*1/.test(rows(w6)[4]), 'and counts it as a website lead');
}

// ---- setup states ----
{
    let w = world({ client: { ...CLIENT, ghl_location_id: '' } });
    await w.eval('renderLeadsCheck()');
    ok(/GHL.*Edit Client.*—$/.test(rows(w)[2]) && !w.__db.asked.includes('ghl_contacts'), 'no location id: says where to add it, asks nothing');

    w = world({ contacts: [] });
    await w.eval('renderLeadsCheck()');
    ok(/GHL.*No contacts have come in.*webhook.*—$/.test(rows(w)[2]), 'nothing ever received: says to add the webhook');
    ok(w.eval("buildLeadsCheckBlock('Acme', new Date('2026-11-02T00:00:00'), new Date('2026-11-08T23:59:59'))") === '', 'no fact without GHL data');

    w = world({ contacts: [ct('old', '2026-10-01T16:00:00Z', ['fb lead'])] });
    await w.eval('renderLeadsCheck()');
    ok(/GHL.*0$/.test(rows(w)[2]), 'connected but none this week: a real 0');

    w = world({ contactsError: { code: '42P01', message: 'relation "ghl_contacts" does not exist' } });
    await w.eval('renderLeadsCheck()');
    ok(/ghl_contacts\.sql/.test(rows(w)[2]), 'table missing: names the SQL to run');

    w = world({ client: { ...CLIENT, lead_tags: [] }, contacts: [ct('a', '2026-11-03T16:00:00Z', ['FB <b>lead'])] });
    await w.eval('renderLeadsCheck()');
    ok(/GHL \(ad leads\).*ge lead \(standard\).*0$/.test(rows(w)[2]), 'no tags set: the standard ge lead tag is counted');
    const btn = box(w).querySelector('button');
    ok(btn && btn.textContent.includes('fb <b>lead') && !box(w).querySelector('b'), 'other tags offered, escaped');
    btn.click();
    await new Promise(r => setTimeout(r, 0));
    ok(w.__db.updates.length === 1 && JSON.stringify(w.__db.updates[0].lead_tags) === '["ge lead","fb <b>lead"]', 'clicking a tag adds it and keeps the standard one');

    w = world({ client: { ...CLIENT, ad_account_id: '' } });
    await w.eval('renderLeadsCheck()');
    ok(/Meta.*not synced.*—$/.test(rows(w)[1]), 'no ad account: Meta not synced');
    w = world({ metaError: true });
    await w.eval('renderLeadsCheck()');
    ok(/Meta.*—/.test(rows(w)[1]), 'Meta query failing: dash, no crash');

    w = world({ role: 'member' });
    await w.eval('renderLeadsCheck()');
    ok(box(w).style.display === 'none' && w.__db.asked.length === 0, 'non-admins see nothing and nothing is asked');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
