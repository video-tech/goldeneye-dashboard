// Homeowner estimate links: the portal panel (app.js, cut out of the real file) and the homeowner's page
// (estimate.html), both in jsdom. The function itself is tested in supabase/functions/estimate-share.
//   JSDOM_DIR=/path/to/dir node tests/estimate-share.test.mjs
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
const bodyHtml = fs.readFileSync(path.join(root, 'body.html'), 'utf8').replace(/\r\n/g, '\n');
const cut = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a + 1); if (a < 0 || b < 0) throw new Error('marker ' + (a < 0 ? from : to)); return app.slice(a, b); };
const code = cut(' // ---- Send the homeowner a read-only link', ' // Position buckets, with the validated');
const panelStart = bodyHtml.indexOf('<div id="cp-deckcalc-share"');
const panel = bodyHtml.slice(panelStart, bodyHtml.indexOf('<!-- Create a QuickBooks estimate from the deck above', panelStart));
const T1 = 'a'.repeat(64), T2 = 'b'.repeat(64);

// ---------------- the portal panel ----------------
function portal({ history = [], fnReply } = {}) {
    const dom = new JSDOM(`<!doctype html><body>${panel}</body>`, { runScripts: 'dangerously', url: 'https://goldeneye.midasmediafirm.com/' });
    const w = dom.window;
    w.__fetches = []; w.__alerts = []; w.__clip = [];
    w.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        w.__fetches.push({ url, headers: init.headers, body });
        const r = fnReply ? fnReply(body) : { status: 200, json: { ok: true, token: T1, url: `https://video-tech.github.io/goldeneye-dashboard/estimate.html?t=${T1}`, expires_at: '2026-11-26T00:00:00Z' } };
        return { ok: r.status < 400, status: r.status, json: async () => r.json };
    };
    Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t) => { w.__clip.push(t); } }, configurable: true });
    w.eval(`
        var currentActiveClient = '3Sixty Industries', deckCalcEstimate = null;
        var supabaseClient = {
            auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
            from: (t) => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: __history, error: null }) }) }) }) })
        };
        const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        window.confirm = () => true;
        window.alert = (m) => __alerts.push(m);
        ${code}
    `);
    w.__history = history;
    w.eval('var __history = window.__history;');
    return w;
}
const deck = (extra = {}) => ({
    line_items: [{ kind: 'decking', description: 'Trex', qty: 280, unit: 'sqft', rate: 45, amount: 12600 }], total_sqft: 280, deck_levels: 1, material: 'Trex Enhance',
    price_low: 11970, price_high: 12600, notes: 'steep', inclusions_list: ['6x6 posts'], alternatives: [{ label: 'Better', name: 'TimberTech', low: 1, high: 2 }],
    business_name: '3Sixty Industries', business_phone: '(435) 660-1944', ...extra,
});
const tick = () => new Promise((r) => setTimeout(r, 20));

{
    const w = portal();
    const btn = w.document.getElementById('cp-share-create');
    ok(btn.disabled === true && /Waiting/.test(w.document.getElementById('cp-share-deck').textContent), 'button is off until the calculator reports a deck');
    w.eval(`deckCalcEstimate = ${JSON.stringify(deck())}; deckShareRenderDeck();`);
    ok(btn.disabled === false && /280 sq ft/.test(w.document.getElementById('cp-share-deck').textContent), 'button turns on once there is a deck');
    w.document.getElementById('cp-share-for').value = '  Pat Smith ';
    await w.deckShareCreate(); await tick();
    const f = w.__fetches[0];
    ok(f.url.endsWith('/functions/v1/estimate-share') && f.headers.Authorization === 'Bearer tok', 'calls the function with the rep\'s own session');
    ok(f.body.mode === 'create' && f.body.client === '3Sixty Industries', 'asks to create for the active client');
    const e = f.body.estimate;
    ok(e.prepared_for === 'Pat Smith' && e.total === 12600 && e.price_low === 11970 && e.line_items.length === 1, 'sends the name, the top of the range, the low end and the lines');
    ok(e.inclusions[0] === '6x6 posts' && e.alternatives[0].label === 'Better' && e.business === '3Sixty Industries' && e.phone === '(435) 660-1944', 'sends inclusions, alternatives and the business');
    ok(e.total_sqft === 280 && e.deck_levels === 1 && e.notes === 'steep', 'sends the size and notes');
    ok(w.document.getElementById('cp-share-link').value.endsWith(`?t=${T1}`) && !w.document.getElementById('cp-share-result').classList.contains('hidden'), 'shows the link');
    ok(w.document.getElementById('cp-share-open').href.endsWith(`?t=${T1}&p=1`), 'the rep\'s Open button is a preview link (not counted as a homeowner view)');
    ok(w.__clip[0] && w.__clip[0].endsWith(`?t=${T1}`) && !w.__clip[0].includes('p=1'), 'copies the plain link to the clipboard');
    ok(/copied/i.test(w.document.getElementById('cp-share-msg').textContent), 'says it was copied');
}
{
    const w = portal({ fnReply: () => ({ status: 403, json: { error: "You don't have access to this client." } }) });
    w.eval(`deckCalcEstimate = ${JSON.stringify(deck())}; deckShareRenderDeck();`);
    await w.deckShareCreate(); await tick();
    ok(/don't have access/.test(w.document.getElementById('cp-share-msg').textContent) && w.document.getElementById('cp-share-result').classList.contains('hidden'), 'a refusal is shown and no link appears');
    ok(w.document.getElementById('cp-share-create').disabled === false && w.document.getElementById('cp-share-create').textContent === 'Create link', 'the button works again after a refusal');
}
{
    const w = portal();
    w.eval(`deckCalcEstimate = ${JSON.stringify(deck({ inclusions_list: undefined, alternatives: 'x', business_name: undefined }))}; deckShareRenderDeck();`);
    await w.deckShareCreate(); await tick();
    const e = w.__fetches[0].body.estimate;
    ok(Array.isArray(e.inclusions) && e.inclusions.length === 0 && Array.isArray(e.alternatives) && e.alternatives.length === 0, 'odd data from the calculator frame is replaced by empty lists, not forwarded');
}
{
    const w = portal();
    await w.deckShareCreate(); await tick();
    ok(w.__fetches.length === 0, 'no deck, no request');
}
{
    const past = new Date(Date.now() - 86_400_000).toISOString(), future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const w = portal({ history: [
        { token: T1, created_at: new Date().toISOString(), expires_at: future, revoked_at: null, prepared_for: '<img src=x onerror=alert(1)>', total: 12600, view_count: 3, last_viewed_at: new Date().toISOString() },
        { token: T2, created_at: new Date().toISOString(), expires_at: past, revoked_at: null, prepared_for: 'Old one', total: 9000, view_count: 0, last_viewed_at: null },
        { token: 'c'.repeat(64), created_at: new Date().toISOString(), expires_at: future, revoked_at: new Date().toISOString(), prepared_for: 'Turned off', total: 1000, view_count: 1, last_viewed_at: new Date().toISOString() },
        { token: "'); alert(1); ('", created_at: new Date().toISOString(), expires_at: future, revoked_at: null, prepared_for: 'Bad token', total: 1, view_count: 0 },
    ] });
    await w.deckShareLoadHistory();
    const box = w.document.getElementById('cp-share-history');
    ok(!w.document.getElementById('cp-share-history-wrap').classList.contains('hidden'), 'history shows when there are links');
    ok(box.querySelector('img') === null && /<img/.test(box.textContent), 'a name typed with HTML is shown as text, never as markup');
    ok(/3 views/.test(box.textContent) && /Not opened yet/.test(box.textContent), 'view counts shown');
    const text = box.textContent;
    ok(/Active/.test(text) && /Expired/.test(text) && /Off/.test(text), 'Active, Expired and Off are told apart');
    ok(!/Bad token/.test(text), 'a row whose token isn\'t 64 hex characters is never rendered (it would go into an onclick)');
    const links = [...box.querySelectorAll('a')].map((a) => a.textContent);
    ok(links.filter((x) => x === 'Turn off').length === 1 && links.filter((x) => x === 'Copy').length === 1, 'only the live link has Copy / Open / Turn off');
    w.__fetches.length = 0;
    await w.deckShareRevoke(T1); await tick();
    ok(w.__fetches[0].body.mode === 'revoke' && w.__fetches[0].body.token === T1 && w.__fetches[0].body.client === '3Sixty Industries', 'Turn off sends the token and client to the function');
    w.__fetches.length = 0;
    await w.deckShareRevoke('nope'); ok(w.__fetches.length === 0, 'a malformed token is never sent');
    await w.deckShareCopyToken(T1); ok(w.__clip.at(-1) === `https://video-tech.github.io/goldeneye-dashboard/estimate.html?t=${T1}`, 'Copy in the list copies the plain link');
}
{
    const w = portal({ history: [] });
    await w.deckShareLoadHistory();
    ok(w.document.getElementById('cp-share-history-wrap').classList.contains('hidden'), 'no links yet: history stays hidden');
}
ok(/deckShareLoadHistory/.test(app.slice(app.indexOf("if(tabName === 'deckcalc')"), app.indexOf("if(tabName === 'deckcalc')") + 140)), 'opening the tab loads the link history');
ok(app.includes('deckShareRenderDeck();') && /deckCalcEstimate = d\.deckEstimate;\n\s+deckQbRenderDeck\(\);\n\s+deckShareRenderDeck\(\);/.test(app), 'each deck the calculator reports refreshes the panel');

// ---------------- the homeowner's page ----------------
const page = fs.readFileSync(path.join(root, 'estimate.html'), 'utf8');
async function viewer(search, reply) {
    const calls = [];
    const dom = new JSDOM(page, {
        runScripts: 'dangerously', url: 'https://video-tech.github.io/goldeneye-dashboard/estimate.html' + search,
        beforeParse(w) {
            w.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); const r = reply(); return { ok: r.status < 400, status: r.status, json: async () => r.json }; };
            w.print = () => { w.__printed = true; };
        },
    });
    await tick();
    return { w: dom.window, calls };
}
const snap = (over = {}) => ({
    v: 1, business: '3Sixty Industries', phone: '(435) 660-1944', date: '2026-10-27', prepared_for: 'Pat Smith', total_sqft: 280, deck_levels: 1,
    line_items: [
        { kind: 'decking', description: 'Trex Enhance', qty: 280, unit: 'sqft', rate: 45, amount: 12600 },
        { kind: 'footings', description: 'Concrete footings', qty: 3, unit: 'ea', rate: 350, amount: 1050 },
        { kind: 'discount', description: 'Promotion: Spring (10% off)', qty: 1, unit: 'ea', rate: -375, amount: -375 },
        { kind: 'addon_tbd', description: 'Soffit (quoted at consultation)', qty: 1, unit: 'ea', rate: 0, amount: 0 },
    ],
    total: 13275, price_low: 12611, inclusions: ['2x10 Douglas fir framing', '6x6 posts'], notes: 'Steep slope\neast side',
    alternatives: [{ label: 'Better', name: 'TimberTech Terrain+ 30yr', low: 14000, high: 14737 }], ...over,
});
{
    const { w, calls } = await viewer(`?t=${T1}`, () => ({ status: 200, json: { snapshot: snap(), expires_at: '2026-11-26T15:00:00Z' } }));
    const t = w.document.getElementById('page').textContent;
    ok(calls.length === 1 && calls[0].body.mode === 'view' && calls[0].body.token === T1 && calls[0].body.preview === false, 'asks the function for the snapshot by token, as a real view');
    ok(/3Sixty Industries/.test(t) && /October 27, 2026/.test(t) && /Estimate for\s*Pat Smith/.test(t), 'shows the business, the date and who it is for');
    ok(/\$12,611 – \$13,275/.test(t), 'shows the price range');
    ok(/Trex Enhance/.test(t) && /\$12,600\.00/.test(t) && /280 sqft x \$45\.00/.test(t) && /-\$375\.00/.test(t) && /TBD/.test(t), 'shows every line with its amount and detail');
    ok(/Estimate total\s*\$13,275\.00/.test(t), 'shows the total');
    ok(/If you went with\s*Better\s*material \(TimberTech Terrain\+ 30yr\), it would be \$14,000 – \$14,737 \(\+\$1,462\)/.test(t), 'shows the material comparison with the difference');
    ok(/Included in every estimate/.test(t) && /6x6 posts/.test(t) && /Steep slope/.test(t), 'shows what is included and the notes');
    ok(/Valid until November 26, 2026/.test(t), 'shows when the link expires');
    ok(w.document.querySelector('a[href="tel:4356601944"]'), 'phone number is a tap-to-call link');
    ok(w.document.querySelectorAll('input, textarea, select, form, [contenteditable]').length === 0, 'nothing on the page can be edited');
    w.document.querySelector('button.print').click(); ok(w.__printed === true, 'Print / save as PDF button prints');
    ok(w.document.querySelector('meta[name=robots]').content.includes('noindex'), 'told search engines not to index it');
}
{
    const { w } = await viewer(`?t=${T1}`, () => ({ status: 200, json: { snapshot: snap({ business: '<b>Evil</b>', prepared_for: '<img src=x onerror=alert(1)>', notes: '<script>alert(1)<\/script>', phone: '"><x', inclusions: ['<i>x</i>'], line_items: [{ kind: 'custom', description: '<svg onload=alert(1)>', qty: 1, unit: 'ea', rate: 5, amount: 5 }], total: 5, price_low: null, alternatives: [{ label: '<u>L</u>', name: '<u>N</u>', low: 1, high: 2 }] }) } }));
    ok(w.document.querySelectorAll('img, svg, script:not([src]) ~ script, b, i, u, x').length === 0 || ![...w.document.querySelectorAll('img, svg, u, i, x')].length, 'text from the snapshot is never turned into markup');
    ok(/<img src=x onerror=alert\(1\)>/.test(w.document.getElementById('page').textContent) && /<svg onload=alert\(1\)>/.test(w.document.getElementById('page').textContent), 'it is shown as plain text instead');
}
{
    const { w } = await viewer(`?t=${T1}&p=1`, () => ({ status: 200, json: { snapshot: snap({ price_low: null, prepared_for: '', alternatives: [], inclusions: [], notes: '' }) } }));
    const t = w.document.getElementById('page').textContent;
    ok(/\$13,275/.test(t) && !/–/.test(w.document.querySelector('.price').textContent), 'no low end: a single price');
    ok(!/Compare materials/.test(t) && !/Included in every estimate/.test(t) && !/Notes/.test(t), 'empty sections are left out');
}
{
    const { w, calls } = await viewer(`?t=${T1}&p=1`, () => ({ status: 200, json: { snapshot: snap() } }));
    ok(calls[0].body.preview === true, 'a ?p=1 link tells the function it is the rep previewing');
}
{
    const { w } = await viewer(`?t=${T1}`, () => ({ status: 404, json: { error: 'This estimate link has expired or was turned off. Ask 3Sixty to send you a new one.' } }));
    ok(/isn.t available/.test(w.document.getElementById('page').textContent) && /expired or was turned off/.test(w.document.getElementById('page').textContent), 'an expired or turned-off link says so plainly');
}
{
    const { w } = await viewer(`?t=${T1}`, () => ({ status: 500, json: {} }));
    ok(/couldn.t load/.test(w.document.getElementById('page').textContent), 'a server error asks them to try again');
}
for (const s of ['', '?t=abc', `?t=${'g'.repeat(64)}`, `?t=${T1}x`]) {
    const { w, calls } = await viewer(s, () => ({ status: 200, json: { snapshot: snap() } }));
    ok(calls.length === 0 && /isn.t complete/.test(w.document.getElementById('page').textContent), `an incomplete link makes no request (${s || 'no token'})`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
