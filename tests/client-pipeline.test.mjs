// The portal pipeline (app.js renderCpPipeline / setCpPipeline, client_pipeline.sql): off until the client switches it on,
// then only leads from that moment, with names escaped. Runs the real code in jsdom.
//   JSDOM_DIR=/path/to/dir node tests/client-pipeline.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.JSDOM_DIR) { console.log('Set JSDOM_DIR to a folder with jsdom installed.'); process.exit(2); }
const { JSDOM } = createRequire(path.join(process.env.JSDOM_DIR, 'package.json'))('jsdom');

const src = fs.readFileSync(path.join(here, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const body = fs.readFileSync(path.join(here, '..', 'body.html'), 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('        var cpPipelineSqlReady'), b = src.indexOf('function renderCpSettings', a);
const code = src.slice(a, b);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const v0 = body.indexOf('<div id="cp-view-pipeline"'), v1 = body.indexOf('<div id="cp-view-creatives"', v0);
const dom = new JSDOM(`<body>${body.slice(v0, v1)}</body>`);
const w = dom.window;
const rpcCalls = [];
let rpcResult = { data: '2026-11-13T18:00:00Z', error: null };
let confirmAnswer = true;
const env = {
    document: w.document,
    normalize: (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    escapeAttr: (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    Sortable: function () { this.destroy = () => {}; },
    window: { cpSortables: [] },
    confirm: () => confirmAnswer,
    alert: () => {},
    supabaseClient: { rpc: async (fn, args) => { rpcCalls.push([fn, args]); return rpcResult; } },
    clientPipelineStages: ['New Lead', 'Contacted', 'Appt Set', 'Won', 'Lost'],
};
const fn = new Function(...Object.keys(env), 'state', `
    let portalClientRows = state.rows, clientLeadsData = state.leads, currentActiveClient = state.client;
    ${code}
    return { renderCpPipeline, setCpPipeline, setReady: (x) => { cpPipelineSqlReady = x; }, rows: () => portalClientRows };`);
const state = {
    client: 'PANDEN Construction',
    rows: [{ name: 'PANDEN Construction', pipeline_enabled_at: null }],
    leads: [
        { id: 'old1', name: 'Old lead', stage: 'New Lead', created_at: '2026-08-19T14:00:00Z', source: 'Facebook Ads' },
        { id: 'new1', name: '<img src=x onerror=alert(1)>', stage: 'New Lead', phone: '+18015550100', created_at: '2026-11-14T10:00:00Z', source: 'Ads' },
        { id: 'new2', name: 'Won lead', stage: 'Won', created_at: '2026-11-15T10:00:00Z', source: 'Website' },
    ],
};
const P = fn(...Object.values(env), state);
const $ = (id) => w.document.getElementById(id);

// Off
P.setReady(true);
P.renderCpPipeline();
ok(/Turn on my pipeline/.test($('cp-pipeline-container').innerHTML), 'off: the switch-on card shows');
ok(!/Old lead|Won lead/.test($('cp-pipeline-container').innerHTML), 'off: no leads shown, not even the old ones');
ok($('cp-pipeline-add').classList.contains('hidden') && $('cp-pipeline-off').classList.contains('hidden'), 'off: Add lead and Turn off hidden');
P.setReady(false);
P.renderCpPipeline();
ok(!/Turn on my pipeline/.test($('cp-pipeline-container').innerHTML) && /Not available/.test($('cp-pipeline-container').innerHTML), 'before the SQL: no button that would fail');
P.setReady(true);

// Switching on
confirmAnswer = false;
await P.setCpPipeline(true);
ok(rpcCalls.length === 0, 'cancelling the confirm changes nothing');
confirmAnswer = true;
await P.setCpPipeline(true);
ok(rpcCalls[0][0] === 'set_client_pipeline' && rpcCalls[0][1].p_client === 'PANDEN Construction' && rpcCalls[0][1].p_on === true, 'switching on asks the database for this client');
const html = $('cp-pipeline-container').innerHTML;
ok(/Won lead/.test(html) && !/Old lead/.test(html), 'on: leads from the switch-on moment only, the old pile stays hidden');
ok(!/<img/.test(html) && /&lt;img/.test(html), 'lead names are escaped');
ok(!$('cp-pipeline-add').classList.contains('hidden') && !$('cp-pipeline-off').classList.contains('hidden') && /On since/.test($('cp-pipeline-note').textContent), 'on: Add lead, Turn off and the note show');
ok(/Ads · /.test(html) && /Website/.test(html), 'each card says where the lead came from');

// Switching off
rpcResult = { data: null, error: null };
await P.setCpPipeline(false);
ok(rpcCalls[1][1].p_on === false && /Turn on my pipeline/.test($('cp-pipeline-container').innerHTML), 'switching off returns to the card');

// The tab is back in the portal's tab row
ok(/id="cp-tab-pipeline"/.test(body) && !/id="cp-more-pipeline"/.test(body), 'Pipeline is a tab again, not hidden under More');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
