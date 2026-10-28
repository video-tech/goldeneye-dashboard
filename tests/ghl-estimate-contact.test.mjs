// Save the estimate PDF to a GHL contact: the portal panel (app.js, cut out of the real file), the calculator's
// PDF-bytes listener (the real built snippet) and the real function's PDF check, together, in jsdom.
//   JSDOM_DIR=/path/to/dir node --experimental-strip-types tests/ghl-estimate-contact.test.mjs
// (the folder needs jsdom and jspdf installed; strip-types lets it import the function's handler.ts)
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
if (!process.env.JSDOM_DIR) { console.log('Set JSDOM_DIR to a folder with jsdom and jspdf installed.'); process.exit(2); }
const req = createRequire(path.join(process.env.JSDOM_DIR, 'package.json'));
const { JSDOM } = req('jsdom');
const { jsPDF } = req('jspdf');
const { decodePdf } = await import(pathToFileURL(path.join(root, 'supabase/functions/ghl-estimate-contact/handler.ts')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const bodyHtml = fs.readFileSync(path.join(root, 'body.html'), 'utf8').replace(/\r\n/g, '\n');
const cut = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a + 1); if (a < 0 || b < 0) throw new Error('marker ' + (a < 0 ? from : to)); return app.slice(a, b); };
const code = cut(' // ---- Save the estimate PDF to a GHL contact', ' // Position buckets, with the validated');
const panelStart = bodyHtml.indexOf('<div id="cp-deckcalc-ghl"');
const panel = bodyHtml.slice(panelStart, bodyHtml.indexOf('<!-- Create a QuickBooks estimate from the deck above', panelStart));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const CID = 'ContactId1234567890';

// ---------------- the portal panel ----------------
function portal({ status = { ok: true, data: { ready: true } }, search, attach, history = [] } = {}) {
    const dom = new JSDOM(`<!doctype html><body>${panel}<iframe id="cp-deckcalc-frame"></iframe></body>`, { runScripts: 'dangerously', url: 'https://goldeneye.midasmediafirm.com/' });
    const w = dom.window;
    w.__fetches = []; w.__frameMsgs = [];
    const frameWin = w.document.getElementById('cp-deckcalc-frame').contentWindow;
    frameWin.postMessage = (m) => w.__frameMsgs.push(m);      // what the portal sends the calculator
    w.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        w.__fetches.push({ url, headers: init.headers, body });
        const r = body.mode === 'status' ? status : body.mode === 'search' ? (search ? await search(body) : { ok: true, data: { contacts: [] } })
            : (attach ? attach(body) : { ok: true, data: { ok: true, contact_name: 'Pat Smith' } });
        return { ok: r.ok, status: r.ok ? 200 : 502, json: async () => r.data };
    };
    w.eval(`
        var currentActiveClient = '3Sixty Industries', deckCalcEstimate = null;
        var supabaseClient = {
            auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
            from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: window.__history, error: null }) }) }) }) })
        };
        ${code}
    `);
    w.__history = history;
    // Answer the frame's PDF request the way the real calculator does
    w.__answer = (over = {}) => {
        const m = w.__frameMsgs.at(-1); if (!m) return;
        const e = new w.MessageEvent('message', { data: { pdfResult: { id: m.makePdf.id, fileName: 'Est.pdf', base64: 'QUJD', total: 17382.4, material: 'Trex', ...over } }, source: frameWin });
        w.dispatchEvent(e);
    };
    w.__frameWin = frameWin;
    return w;
}
const deck = () => ({ line_items: [{ kind: 'decking', amount: 1 }], total_sqft: 280, material: 'Trex', price_low: 100, price_high: 120 });
const type = async (w, v) => { const q = w.document.getElementById('cp-ghl-q'); q.value = v; q.dispatchEvent(new w.Event('input', { bubbles: true })); await tick(400); };
const contacts = [{ id: CID, name: 'Pat Smith', phone: '+18015551234', email: 'pat@example.com' }, { id: 'Contact2abcdefghijk', name: '<img src=x onerror=alert(1)>', phone: null, email: null }];

{
    const w = portal();
    await w.deckGhlRefresh(); await tick();
    ok(!w.document.getElementById('cp-deckcalc-ghl').classList.contains('hidden'), 'panel shows when the function says GHL is connected');
    ok(w.__fetches[0].body.mode === 'status' && w.__fetches[0].body.client === '3Sixty Industries' && w.__fetches[0].headers.Authorization === 'Bearer tok', 'asks status for the active client with the rep\'s own session');
    ok(w.document.getElementById('cp-ghl-save').disabled === true, 'save is off until there is a deck AND a contact');
}
{
    const w = portal({ status: { ok: true, data: { ready: false } } });
    await w.deckGhlRefresh(); await tick();
    ok(w.document.getElementById('cp-deckcalc-ghl').classList.contains('hidden'), 'not connected: panel stays hidden');
    const w2 = portal({ status: { ok: false, data: { error: 'nope' } } });
    await w2.deckGhlRefresh(); await tick();
    ok(w2.document.getElementById('cp-deckcalc-ghl').classList.contains('hidden'), 'an error from the function also leaves it hidden');
}
{
    const w = portal({ search: () => ({ ok: true, data: { contacts } }) });
    await w.deckGhlRefresh(); await tick();
    w.__fetches.length = 0;
    await type(w, 'p');
    ok(w.__fetches.length === 0, 'one character makes no request');
    await type(w, 'pat');
    ok(w.__fetches.length === 1 && w.__fetches[0].body.mode === 'search' && w.__fetches[0].body.query === 'pat', 'typing searches after a short pause');
    const box = w.document.getElementById('cp-ghl-results');
    ok(box.querySelectorAll('button').length === 2 && /Pat Smith/.test(box.textContent) && /pat@example.com/.test(box.textContent), 'results list shows name, phone and email');
    ok(box.querySelector('img') === null && /<img src=x/.test(box.textContent), 'a contact name with HTML is shown as text, never as markup');
    w.document.getElementById('cp-ghl-q').value = 'pat';
    box.querySelectorAll('button')[0].click();
    ok(/Pat Smith/.test(w.document.getElementById('cp-ghl-picked-name').textContent) && !w.document.getElementById('cp-ghl-picked').classList.contains('hidden'), 'picking a contact shows who it will save to');
    ok(w.document.getElementById('cp-ghl-q').value === '' && box.children.length === 0, 'picking clears the search');
    ok(w.document.getElementById('cp-ghl-save').disabled === true, 'still off with no deck');
    w.eval(`deckCalcEstimate = ${JSON.stringify(deck())}; deckGhlRenderDeck();`);
    ok(w.document.getElementById('cp-ghl-save').disabled === false && /280 sq ft/.test(w.document.getElementById('cp-ghl-deck').textContent), 'contact + deck: save turns on');
    w.deckGhlClear();
    ok(w.document.getElementById('cp-ghl-save').disabled === true && w.document.getElementById('cp-ghl-picked').classList.contains('hidden'), 'change: clears the pick and turns save off');
}
{
    // a slow answer for an old search never overwrites a newer one
    let release;
    const w = portal({ search: async (b) => { if (b.query === 'ab') { await tick(80); return { ok: true, data: { contacts: [{ id: 'OldContact123456', name: 'OLD', phone: null, email: null }] } }; } return { ok: true, data: { contacts } }; } });
    await w.deckGhlRefresh(); await tick();
    const slow = w.deckGhlSearch('ab'); await w.deckGhlSearch('pat'); await slow;
    ok(/Pat Smith/.test(w.document.getElementById('cp-ghl-results').textContent) && !/OLD/.test(w.document.getElementById('cp-ghl-results').textContent), 'a search that was typed over is dropped');
}
{
    const w = portal({ search: () => ({ ok: false, data: { error: 'The GHL access key for this client may be missing a permission.' } }) });
    await w.deckGhlRefresh(); await tick(); await type(w, 'pat');
    ok(/missing a permission/.test(w.document.getElementById('cp-ghl-results').textContent), 'a search error is shown');
    const w2 = portal({ search: () => ({ ok: true, data: { contacts: [] } }) });
    await w2.deckGhlRefresh(); await tick(); await type(w2, 'zzz');
    ok(/No contacts found/.test(w2.document.getElementById('cp-ghl-results').textContent), 'no matches says so');
}
{
    // saving: asks the calculator for the PDF, then sends it to the function
    const w = portal({ search: () => ({ ok: true, data: { contacts } }) });
    await w.deckGhlRefresh(); await tick(); await type(w, 'pat');
    w.document.getElementById('cp-ghl-results').querySelectorAll('button')[0].click();
    w.eval(`deckCalcEstimate = ${JSON.stringify(deck())}; deckGhlRenderDeck();`);
    w.__fetches.length = 0;
    const saving = w.deckGhlSave(); await tick();
    ok(w.__frameMsgs.length === 1 && w.__frameMsgs[0].makePdf.preparedFor === 'Pat Smith' && typeof w.__frameMsgs[0].makePdf.id === 'string', 'asks the calculator frame for the PDF, "Prepared for" = the contact\'s name');
    ok(w.__fetches.length === 0, 'nothing is sent to the function until the PDF arrives');
    w.__answer(); await saving; await tick();
    const a = w.__fetches[0].body;
    ok(a.mode === 'attach' && a.client === '3Sixty Industries' && a.contact_id === CID && a.pdf_base64 === 'QUJD' && a.file_name === 'Est.pdf' && a.total === 17382.4 && a.material === 'Trex', 'sends the picked contact id, the PDF and the totals');
    ok(/Saved to Pat Smith/.test(w.document.getElementById('cp-ghl-msg').textContent), 'shows success');
    ok(w.document.getElementById('cp-ghl-save').textContent === 'Save PDF to contact' && w.document.getElementById('cp-ghl-save').disabled === false, 'button works again');
}
{
    // only our own frame is believed
    const w = portal({ search: () => ({ ok: true, data: { contacts } }) });
    await w.deckGhlRefresh(); await tick(); await type(w, 'pat');
    w.document.getElementById('cp-ghl-results').querySelectorAll('button')[0].click();
    w.eval(`deckCalcEstimate = ${JSON.stringify(deck())}; deckGhlRenderDeck();`);
    w.__fetches.length = 0;
    const saving = w.deckGhlSave(); await tick();
    const id = w.__frameMsgs[0].makePdf.id;
    w.dispatchEvent(new w.MessageEvent('message', { data: { pdfResult: { id, fileName: 'evil.pdf', base64: 'ZXZpbA==', total: 1 } }, source: w }));   // not the frame
    await tick();
    ok(w.__fetches.length === 0, 'a PDF answer from any window other than the calculator frame is ignored');
    w.__answer(); await saving; await tick();
    ok(w.__fetches[0].body.pdf_base64 === 'QUJD', 'the frame\'s real answer is the one used');
}
{
    const w = portal({ search: () => ({ ok: true, data: { contacts } }) });
    await w.deckGhlRefresh(); await tick(); await type(w, 'pat');
    w.document.getElementById('cp-ghl-results').querySelectorAll('button')[0].click();
    w.eval(`deckCalcEstimate = ${JSON.stringify(deck())}; deckGhlRenderDeck();`);
    w.__fetches.length = 0;
    const saving = w.deckGhlSave(); await tick(); w.__answer({ error: 'Could not load the PDF tool.', base64: undefined }); await saving; await tick();
    ok(w.__fetches.length === 0 && /Could not load the PDF tool/.test(w.document.getElementById('cp-ghl-msg').textContent), 'the calculator failing to make the PDF is shown, and nothing is sent');
}
{
    const w = portal({ search: () => ({ ok: true, data: { contacts } }), attach: () => ({ ok: false, data: { error: 'GHL took too long to answer.' } }) });
    await w.deckGhlRefresh(); await tick(); await type(w, 'pat');
    w.document.getElementById('cp-ghl-results').querySelectorAll('button')[0].click();
    w.eval(`deckCalcEstimate = ${JSON.stringify(deck())}; deckGhlRenderDeck();`);
    const saving = w.deckGhlSave(); await tick(); w.__answer(); await saving; await tick();
    ok(/took too long/.test(w.document.getElementById('cp-ghl-msg').textContent) && w.document.getElementById('cp-ghl-save').disabled === false, 'a refusal from the function is shown and the rep can retry');
}
{
    const w = portal({ history: [
        { created_at: new Date().toISOString(), contact_name: '<b>Pat</b>', total: 17382, status: 'saved', file_url: 'https://storage.googleapis.com/b/x.pdf', error: null },
        { created_at: new Date().toISOString(), contact_name: 'Lee', total: 900, status: 'partial', file_url: 'javascript:alert(1)', error: 'no notes scope' },
    ] });
    await w.deckGhlLoadHistory();
    const box = w.document.getElementById('cp-ghl-history');
    ok(!w.document.getElementById('cp-ghl-history-wrap').classList.contains('hidden') && box.querySelector('b') === null && /<b>Pat<\/b>/.test(box.textContent), 'history shows names as plain text');
    ok(/PDF saved, note failed/.test(box.textContent) && /Saved/.test(box.textContent), 'saved and partial are told apart');
    const links = [...box.querySelectorAll('a')];
    ok(links.length === 1 && links[0].href.startsWith('https://storage.googleapis.com/'), 'only an https PDF link is made clickable');
}
ok(/deckGhlRefresh/.test(app.slice(app.indexOf("if(tabName === 'deckcalc')"), app.indexOf("if(tabName === 'deckcalc')") + 180)), 'opening the tab checks whether GHL is connected');
ok(/deckShareRenderDeck\(\);\n\s+deckGhlRenderDeck\(\);/.test(app), 'each deck the calculator reports refreshes this panel too');

// ---------------- the calculator's side, the real built snippet ----------------
const snippet = fs.readFileSync(path.join(root, 'snippets/3sixty-deck-estimator.html'), 'utf8');
{
    const dom = new JSDOM(snippet, { runScripts: 'dangerously', pretendToBeVisual: true });
    const w = dom.window;
    w.jspdf = { jsPDF };                                   // stands in for the CDN script
    const got = []; w.addEventListener('message', (e) => { if (e.data && e.data.pdfResult) got.push(e.data.pdfResult); });
    w.addCustom(); w.setCustom(0, 'name', 'Gas'); w.setCustom(0, 'amount', '85.5');
    w.dispatchEvent(new w.MessageEvent('message', { data: { makePdf: { id: 'abc123', preparedFor: 'Pat Smith' } }, source: w }));
    await tick(100);
    const r = got.find((x) => x.id === 'abc123');
    ok(r && !r.error && typeof r.base64 === 'string' && r.base64.length > 800, 'the calculator answers a PDF request');
    ok(r && /^3Sixty-Estimate-Pat-Smith-\d{4}-\d\d-\d\d\.pdf$/.test(r.fileName), 'with a file name: ' + (r && r.fileName));
    const bytes = decodePdf(r.base64);
    ok(bytes instanceof Uint8Array, 'and the function accepts those exact bytes as a PDF');
    ok(Buffer.from(bytes).toString('latin1').includes('Prepared for: Pat Smith') && Buffer.from(bytes).toString('latin1').includes('Gas'), 'the PDF holds the contact name and the custom line');
    const t = w.Pricing.total(w.state.levels, w.state.custom, w.state.promos);
    ok(r.total === t.high && /Trex/.test(r.material), 'it reports the total and the material');
    got.length = 0;
    const stranger = new JSDOM('<!doctype html>').window;
    w.dispatchEvent(new w.MessageEvent('message', { data: { makePdf: { id: 'evil1' } }, source: stranger }));
    await tick(80);
    ok(got.length === 0, 'a PDF request from any window other than the page that frames the calculator is ignored');
    w.dispatchEvent(new w.MessageEvent('message', { data: { makePdf: { id: 5 } }, source: w })); w.dispatchEvent(new w.MessageEvent('message', { data: { other: 1 }, source: w })); await tick(60);
    ok(got.length === 0, 'a request without a string id, or something else entirely, is ignored');
}
const CALC_DIR = 'C:/Users/tennyson/Documents/deck calculator/';   // the source folder lives beside this repo on the author's machine only
if (fs.existsSync(CALC_DIR + 'estimator.html')) {
    const staff = fs.readFileSync(CALC_DIR + 'ghl-embed-open.html', 'utf8');
    ok(staff.includes('makePdf'), 'the staff page has the listener code too');
    const dom = new JSDOM(fs.readFileSync(CALC_DIR + 'estimator.html', 'utf8'), { runScripts: 'dangerously', pretendToBeVisual: true });
    const w = dom.window; w.jspdf = { jsPDF };
    const got = []; w.addEventListener('message', (e) => { if (e.data && e.data.pdfResult) got.push(e.data); });
    w.dispatchEvent(new w.MessageEvent('message', { data: { makePdf: { id: 'x1' } }, source: w })); await tick(80);
    ok(got.length === 0, 'a build with no portal parent (customer pages, staff page) never answers PDF requests');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
