// Per-question services (service_keys on a question): the Quick start Facebook questions are asked only of clients with
// Ads (supabase/sql/quick_start_facebook_ads_only.sql). Runs the REAL obQuestionsFor and the Templates question editor,
// cut out of app.js, in jsdom.
//   JSDOM_DIR=/path/to/dir node tests/question-services.test.mjs
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
const code = cut('function obClientWebsiteStatus', '// ---- private and secret answers')
    + cut('const OB_QUESTION_TYPES', '// Offer the questions above this one')
    + cut('function readObQuestions', 'function obQuestionProblems');

const QUICK_START = { id: 'qs', title: 'Quick start: your Facebook page and CRM', questions: [
    { id: 'q_fb_page', label: 'Do you have a Facebook business page?', type: 'choice', options: ['Yes', 'No (I need one)', 'Not sure'], required: true, fact: 'facebook_page', fact_values: ['yes', 'no', 'unsure'], website_statuses: [], service_keys: ['ads'] },
    { id: 'q_fb_url', label: 'Paste the link to your Facebook page', type: 'link', options: [], required: false, show_if: { q: 'q_fb_page', any: ['Yes'] }, website_statuses: [], service_keys: ['ads'] },
    { id: 'q_crm', label: 'Do you have a CRM you want your leads sent to?', type: 'choice', options: ['No, use the default setup', 'Yes, I already have a CRM I want to keep'], required: true, fact: 'crm_choice', fact_values: ['no', 'yes'], website_statuses: [] },
] };

function world(services) {
    const dom = new JSDOM(`<!doctype html><body><div id="ed"></div></body>`, { runScripts: 'dangerously' });
    const w = dom.window;
    w.__services = services;
    w.eval(`
        const escapeAttr = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
        const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        var portalClientRows = [{ name: 'Acme', website_status: 'existing' }], globalClientsData = [];
        var globalServices = [{ key: 'ads', name: 'Ads management' }, { key: 'seo', name: 'SEO Growth' }, { key: 'video', name: 'Video', active: false }];
        const WEBSITE_STATUS_LABELS = { new_build: "We're building it", existing: 'They have one', none: 'No website' };
        // null = applicability not loaded (before service_onboarding.sql)
        function obFor() { return __services === null ? null : { services: [{ service_key: 'base' }, ...__services.map(k => ({ service_key: k }))] }; }
        ${code}
    `);
    return w;
}
const ids = (w) => w.obQuestionsFor(QUICK_START, 'Acme').map((q) => q.id).join(',');

ok(ids(world(['ads'])) === 'q_fb_page,q_fb_url,q_crm', 'an Ads client is asked about their Facebook page');
ok(ids(world(['ads', 'seo'])) === 'q_fb_page,q_fb_url,q_crm', 'Ads + SEO too');
ok(ids(world(['seo'])) === 'q_crm', 'Base + SEO (no Ads) is asked only about a CRM: ' + ids(world(['seo'])));
ok(ids(world([])) === 'q_crm', 'Base with no add-ons is asked only about a CRM');
ok(ids(world(null)) === 'q_fb_page,q_fb_url,q_crm', 'before the onboarding SQL, every question is asked, as before');

// The Templates editor shows the chips and keeps the tag on save
{
    const w = world(['seo']);
    const d = w.document;
    d.getElementById('ed').innerHTML = QUICK_START.questions.map((q) => w.obQuestionRowHtml(q)).join('');
    const chips = [...d.querySelectorAll('.ob-q-row')[0].querySelectorAll('.ob-q-svc')];
    ok(chips.map((c) => c.textContent.trim()).join('|') === 'Ads management|SEO Growth', 'offered services as chips (a retired one stays out): ' + chips.map((c) => c.textContent.trim()));
    ok(chips[0].getAttribute('aria-pressed') === 'true' && chips[1].getAttribute('aria-pressed') === 'false', 'the Facebook question shows Ads pressed');
    const back = w.readObQuestions(d.getElementById('ed'));
    ok(JSON.stringify(back[0].service_keys) === '["ads"]' && JSON.stringify(back[1].service_keys) === '["ads"]', 'saving keeps the Ads tag on both Facebook questions');
    ok(!('service_keys' in back[2]), 'an untagged question stays untagged (nothing new saved)');
    d.querySelectorAll('.ob-q-row')[2].querySelectorAll('.ob-q-svc')[1].click();
    ok(JSON.stringify(w.readObQuestions(d.getElementById('ed'))[2].service_keys) === '["seo"]', 'ticking a chip saves that service');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
