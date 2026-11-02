// Contractor or not (clients.contractor, supabase/sql/contractor_fact.sql). Runs the REAL helpers, question filter, Templates
// question editor and weekly check-in form, cut out of app.js, in jsdom:
//   - a question tagged {"contractor": ["no"]} is asked only of clients flagged "no"; ["yes"] only of everyone else, and an
//     unset client counts as a contractor (so nobody existing sees a change);
//   - the travel questions depend on "do you go to them?" and so show only for the right answers;
//   - the Templates editor shows the chips, keeps the tag on save, and doesn't drop a tag it has no chip for;
//   - the weekly check-in says appointments / new customers for a business that isn't a contractor.
//   JSDOM_DIR=/path/to/dir node tests/contractor-fact.test.mjs
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
const cutBlock = (from, end) => { const a = app.indexOf(from); if (a < 0) throw new Error('marker ' + from); const b = app.indexOf(end, a); return app.slice(a, b + end.length); };

const code = cut('const CLIENT_FACT_DEFAULTS', '// ---- private and secret answers')          // helpers, obStepDescription, obClientWebsiteStatus, obQuestionsFor
    + cut('// The questions that are showing, given the answers so far', '// A style picker')   // obVisibleQuestions
    + cut('const FACT_LABELS', '// False until onboarding_facts.sql')
    + cut('const OB_QUESTION_TYPES', '// Offer the questions above this one')
    + cut('function readObQuestions', 'function obQuestionProblems')
    + cutBlock('// The weekly check-in keeps its columns', '\n}\n')                             // checkinTerms
    + cutBlock('const CHECKIN_SOURCES = [', '];')
    + cutBlock('window.updateCheckinSourceTotal = function', '\n};\n')
    + cutBlock('function weeklyCheckinFormHtml', '\n}\n');

// The questions as contractor_fact.sql leaves them in "Texting and your service area"
const STEP = { id: 's1', title: 'Texting and your service area', questions: [
    { id: 'c_text_ok', label: 'We text between 8am and 8pm. OK?', type: 'choice', options: ['Yes', 'No'], required: true, website_statuses: [] },
    { id: 'c_area', label: 'Main cities you serve', type: 'short', options: [], required: true, website_statuses: [] },
    { id: 'c_visit', label: 'Do your customers come to you, or do you go to them?', type: 'choice', options: ['They come to us', 'We go to them', 'Both', 'Online or nationwide'], required: false, website_statuses: [], fact_conditions: { contractor: ['no'] } },
    { id: 'c_radius_nc', label: 'How far will you travel to a customer?', type: 'short', options: [], required: false, website_statuses: [], fact_conditions: { contractor: ['no'] }, show_if: { q: 'c_visit', any: ['We go to them', 'Both'] } },
    { id: 'c_radius', label: 'How far will you travel for a job?', type: 'short', options: [], required: true, website_statuses: [], fact_conditions: { contractor: ['yes'] } },
] };

function world(clients, current = 'Roofer Co') {
    const dom = new JSDOM(`<!doctype html><body><div id="ed"></div></body>`, { runScripts: 'dangerously' });
    const w = dom.window;
    w.__clients = clients;
    w.eval(`
        const escapeAttr = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
        const stripSlashEscapes = (s) => s;
        const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        var portalClientRows = [], globalClientsData = __clients;
        var currentActiveClient = ${JSON.stringify(current)};
        var globalServices = [{ key: 'ads', name: 'Ads management' }];
        const WEBSITE_STATUS_LABELS = { new_build: "We're building it", existing: 'They have one', none: 'No website' };
        const money0 = n => '$' + Math.round(Number(n) || 0).toLocaleString();
        function obFor() { return null; }
        function reportingWeekStart() { return '2026-11-02'; }
        function portalCheckinFor() { return null; }
        ${code}
        window.__FACT_LABELS = FACT_LABELS;
    `);
    return w;
}
const CLIENTS = [{ name: 'Roofer Co' }, { name: 'Explicit Yes Co', contractor: 'yes' }, { name: 'Tattoo Ink Utah', contractor: 'no' }];
const ids = (w, c) => w.obQuestionsFor(STEP, c).map((q) => q.id).join(',');

// ---- the rule ----
{
    const w = world(CLIENTS);
    ok(w.obClientFact('Roofer Co', 'contractor') === 'yes', 'an unset client counts as a contractor');
    ok(w.clientIsContractor('Roofer Co') && w.clientIsContractor('Explicit Yes Co') && !w.clientIsContractor('Tattoo Ink Utah'), 'only a client flagged no is not a contractor');
    ok(w.clientIsContractor('Nobody Known'), 'a client we have no row for counts as a contractor');
    ok(w.clientIsContractor('tattoo ink utah') === false, 'names match the way the rest of the app matches them (normalized)');
    ok(w.obFactConditionsMatch(undefined, 'Roofer Co') && w.obFactConditionsMatch({}, 'Roofer Co') && w.obFactConditionsMatch({ contractor: [] }, 'Roofer Co'), 'no tag, an empty tag: asked of everyone');
    ok(w.obFactConditionsMatch({ contractor: ['no'] }, 'Tattoo Ink Utah') && !w.obFactConditionsMatch({ contractor: ['no'] }, 'Roofer Co'), 'a "no" tag reaches only non-contractors');
    ok(!w.obFactConditionsMatch({ contractor: ['yes'] }, 'Tattoo Ink Utah') && w.obFactConditionsMatch({ contractor: ['yes'] }, 'Roofer Co'), 'a "yes" tag reaches only contractors');
    ok(w.obFactConditionsMatch({ contractor: ['yes', 'no'] }, 'Tattoo Ink Utah'), 'both values: everyone');
    ok(!w.obFactConditionsMatch({ nonsense: ['x'] }, 'Roofer Co'), "a tag on a fact we don't know hides the question, like the database rule");
    ok(w.obFactConditionsMatch({ base_package: ['yes'] }, 'Roofer Co'), 'other client facts default the same way (Base)');
}

// ---- the questions each group is asked ----
{
    const w = world(CLIENTS);
    ok(ids(w, 'Roofer Co') === 'c_text_ok,c_area,c_radius', 'a contractor is asked the travel question, as before: ' + ids(w, 'Roofer Co'));
    ok(ids(w, 'Explicit Yes Co') === 'c_text_ok,c_area,c_radius', 'contractor = yes is the same');
    ok(ids(w, 'Tattoo Ink Utah') === 'c_text_ok,c_area,c_visit,c_radius_nc', 'a non-contractor is asked who goes to whom instead: ' + ids(w, 'Tattoo Ink Utah'));
    const qs = w.obQuestionsFor(STEP, 'Tattoo Ink Utah');
    const shown = (v) => w.obVisibleQuestions(qs, v).map((q) => q.id).join(',');
    ok(shown({}) === 'c_text_ok,c_area,c_visit', 'travel distance is hidden until they say they go to customers');
    ok(shown({ c_visit: 'They come to us' }) === 'c_text_ok,c_area,c_visit', 'and stays hidden for "they come to us"');
    ok(shown({ c_visit: 'We go to them' }).endsWith('c_radius_nc') && shown({ c_visit: 'Both' }).endsWith('c_radius_nc'), 'and shows for "we go to them" or "both"');
}
// A client the portal loaded (its own rows) is judged the same way
{
    const w = world([]);
    w.eval(`portalClientRows = [{ name: 'Tattoo Ink Utah', contractor: 'no' }]`);
    ok(!w.clientIsContractor('Tattoo Ink Utah'), "the client portal's own rows count");
}

// ---- Templates editor ----
{
    const w = world(CLIENTS);
    const d = w.document;
    d.getElementById('ed').innerHTML = STEP.questions.map((q) => w.obQuestionRowHtml(q)).join('');
    const rows = [...d.querySelectorAll('.ob-q-row')];
    const chips = (r) => [...r.querySelectorAll('.ob-q-contractor')];
    ok(chips(rows[0]).map((c) => c.textContent.trim()).join('|') === 'Contractor|Not a contractor', 'each question offers a Contractor / Not a contractor chip');
    ok(chips(rows[2])[1].getAttribute('aria-pressed') === 'true' && chips(rows[2])[0].getAttribute('aria-pressed') === 'false', 'the non-contractor question shows "Not a contractor" pressed');
    ok(chips(rows[4])[0].getAttribute('aria-pressed') === 'true', 'the contractor question shows "Contractor" pressed');
    const back = w.readObQuestions(d.getElementById('ed'));
    ok(JSON.stringify(back[2].fact_conditions) === '{"contractor":["no"]}' && JSON.stringify(back[4].fact_conditions) === '{"contractor":["yes"]}', 'saving keeps both tags');
    ok(!('fact_conditions' in back[0]) && !('fact_conditions' in back[1]), 'an untagged question stays untagged');
    ok(back[3].show_if.q === 'c_visit' && back[3].show_if.any.join() === 'We go to them,Both', 'saving keeps the dependency too');
    chips(rows[0])[1].click();
    ok(JSON.stringify(w.readObQuestions(d.getElementById('ed'))[0].fact_conditions) === '{"contractor":["no"]}', 'ticking a chip tags the question');
    chips(rows[2])[1].click();
    ok(!('fact_conditions' in w.readObQuestions(d.getElementById('ed'))[2]), 'unticking the last chip removes the tag');
    // A tag the editor has no chip for survives a save
    d.getElementById('ed').innerHTML = w.obQuestionRowHtml({ id: 'x', label: 'Q', type: 'short', options: [], website_statuses: [], fact_conditions: { contractor: ['no'], base_package: ['yes'] } });
    const kept = w.readObQuestions(d.getElementById('ed'))[0].fact_conditions;
    ok(JSON.stringify(kept) === '{"contractor":["no"],"base_package":["yes"]}', 'a tag for another fact is kept: ' + JSON.stringify(kept));
    d.querySelector('.ob-q-contractor[data-key="no"]').click();
    ok(JSON.stringify(w.readObQuestions(d.getElementById('ed'))[0].fact_conditions) === '{"base_package":["yes"]}', 'clearing the contractor chip leaves the other tag');
}
// The step-level chip row comes from the same table
{
    const w = world(CLIENTS);
    ok(JSON.stringify(w.__FACT_LABELS.contractor.values) === '{"yes":"Contractor","no":"Not a contractor"}', 'the step tag row offers Contractor / Not a contractor');
}

// ---- check-in words ----
{
    const w = world(CLIENTS);
    const c = w.checkinTerms('Roofer Co'), n = w.checkinTerms('Tattoo Ink Utah');
    ok(c.estimates === 'Estimates given' && c.googleJobs === 'Jobs closed from Google' && c.noun.join() === 'job,jobs', 'a contractor keeps the words it had');
    ok(n.estimates === 'Appointments held' && n.googleJobs === 'New customers from Google' && n.closedWord === 'New customers', 'a non-contractor says appointments and new customers');
    ok(!/estimate|job|quote|closed/i.test(JSON.stringify(Object.values(n))), 'no contractor word is left in the non-contractor wording: ' + JSON.stringify(Object.values(n)));
    const html = (client, current) => world(CLIENTS, current).weeklyCheckinFormHtml('t', client ? { client, existing: null } : { existing: null });
    const hc = html(null, 'Roofer Co'), hn = html(null, 'Tattoo Ink Utah');
    ok(hc.includes('Estimates given') && hc.includes('<span>Jobs</span>') && hc.includes('Jobs closed and revenue, by where the customer came from'), 'the contractor form is unchanged');
    ok(hn.includes('Appointments held') && hn.includes('<span>Customers</span>') && hn.includes('New customers and revenue, by where they came from') && !/Estimates given|Jobs closed/.test(hn), 'the non-contractor form uses the new words');
    ok(world(CLIENTS, 'Roofer Co').weeklyCheckinFormHtml('t', { client: 'Tattoo Ink Utah', existing: null }).includes('Appointments held'), "the Roster can ask for another client's words (a VA logging for them)");
    ok(hn.includes('data-client="Tattoo Ink Utah"'), 'the total line knows which client it is for');
    // The running total under the rows
    const wn = world(CLIENTS, 'Tattoo Ink Utah');
    wn.document.body.innerHTML = wn.weeklyCheckinFormHtml('t', { existing: null });
    wn.document.getElementById('wc-src-google-jobs-t').value = '1'; wn.updateCheckinSourceTotal('t');
    ok(wn.document.getElementById('wc-src-total-t').innerText === 'Total: 1 new customer · $0', 'running total: ' + wn.document.getElementById('wc-src-total-t').innerText);
    wn.document.getElementById('wc-src-google-jobs-t').value = '3'; wn.updateCheckinSourceTotal('t');
    ok(wn.document.getElementById('wc-src-total-t').innerText === 'Total: 3 new customers · $0', 'plural: ' + wn.document.getElementById('wc-src-total-t').innerText);
    wn.document.getElementById('wc-src-google-jobs-t').value = ''; wn.updateCheckinSourceTotal('t');
    ok(/nobody new signed up/.test(wn.document.getElementById('wc-src-total-t').innerText), 'empty hint');
    const wc = world(CLIENTS, 'Roofer Co');
    wc.document.body.innerHTML = wc.weeklyCheckinFormHtml('t', { existing: null });
    wc.document.getElementById('wc-src-google-jobs-t').value = '2'; wc.updateCheckinSourceTotal('t');
    ok(wc.document.getElementById('wc-src-total-t').innerText === 'Total: 2 jobs · $0', 'a contractor still sees jobs: ' + wc.document.getElementById('wc-src-total-t').innerText);
}

// ---- the team step ----
{
    const w = world(CLIENTS);
    const team = { step_type: 'team', description: 'Anyone who quotes or closes jobs. We text them weekly for their numbers.' };
    ok(w.obStepDescription(team, 'Roofer Co') === team.description, 'a contractor sees the team description as written');
    ok(w.obStepDescription(team, 'Tattoo Ink Utah') === 'Anyone who books or signs up customers. We text them weekly for their numbers.', 'a non-contractor sees it reworded');
    ok(w.obStepDescription({ step_type: 'video', description: 'quotes or closes jobs' }, 'Tattoo Ink Utah') === 'quotes or closes jobs', 'other step types are never reworded');
}

// ---- the client dashboard ----
{
    const w = world(CLIENTS);
    const c = w.checkinTerms('Roofer Co'), n = w.checkinTerms('Tattoo Ink Utah');
    ok(c.dashTile === 'Closed Revenue' && c.dashChart === 'Ad spend vs. revenue' && c.dashBar === 'Revenue' && /^Revenue back/.test(c.dashRoi), 'a contractor keeps the dashboard words it had');
    ok(n.dashTile === 'Results' && n.dashChart === 'Ad spend vs. results' && n.dashBar === 'Results' && /^Results back/.test(n.dashRoi), 'a non-contractor sees Results');
    ok(!/revenue|closed/i.test([n.dashTile, n.dashChart, n.dashBar, n.dashRoi].join(' ')), 'and none of the revenue / closed wording');
    // The markup carries the ids the code writes to, with the contractor words as the default
    const body = fs.readFileSync(path.join(root, 'body.html'), 'utf8');
    ok(/id="stat-revenue-label">Closed Revenue</.test(body) && /id="roi-caption"[^>]*>Revenue back for every dollar/.test(body) && /id="roi-chart-title">Ad spend vs\. revenue</.test(body),
        'the dashboard markup has the three ids, defaulting to the contractor words');
    ok(app.includes("setText('stat-revenue-label', dashT.dashTile)") && app.includes("setText('roi-caption', dashT.dashRoi)") && app.includes("setText('roi-chart-title', dashT.dashChart)"),
        'the dashboard render writes all three');
    ok(app.includes("labels: ['Ad Spend', checkinTerms(currentActiveClient).dashBar]"), 'the chart bar uses the same word');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
