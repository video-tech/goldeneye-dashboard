// Checks for the onboarding questionnaire's browser side (app.js): private and secret answers in the portal form,
// saving them, the admin view with Reveal, and the Templates toggles. Runs the REAL app.js code, cut out by its
// section markers, in jsdom with a fake Supabase client. Needs jsdom installed; point JSDOM_DIR at the folder
// holding node_modules:
//   JSDOM_DIR=/path/to/dir node tests/onboarding-questionnaire.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
if (!process.env.JSDOM_DIR) { console.log('Set JSDOM_DIR to a folder with jsdom installed.'); process.exit(2); }
const { JSDOM } = createRequire(path.join(process.env.JSDOM_DIR, 'package.json'))('jsdom');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const cut = (from, to) => {
    const a = app.indexOf(from), b = app.indexOf(to, a + 1);
    if (a < 0 || b < 0) throw new Error(`marker not found: ${a < 0 ? from : to}`);
    return app.slice(a, b);
};
const sqlFile = fs.readFileSync(path.join(root, 'supabase', 'sql', 'onboarding_questionnaire.sql'), 'utf8');
const stepsFromSql = [...sqlFile.matchAll(/select '([^']+)',\n[\s\S]*?'(\[\n[\s\S]*?\])'::jsonb/g)].map((m) => ({ title: m[1], questions: JSON.parse(m[2]) }));

const code = [
    cut('        const normalize = (str) => {', '        // Escapes for a JS string literal'),
    cut('        const escapeAttr = (str) =>', '        // Repairs values already corrupted'),
    cut('const WEBSITE_STATUS_LABELS = {', '// The answers a step can depend on'),
    cut('// ---- Built-in Questions steps ----', '// Restore playback position'),
    cut('        const obAnswerText = {};', '        window.copyClientAnswers = '),
    cut('const OB_QUESTION_TYPES = ', '// Hide a step without deleting it'),
].join('\n');

function makeWorld() {
    const dom = new JSDOM('<!doctype html><body><div id="out"></div></body>', { runScripts: 'outside-only' });
    const w = dom.window;
    const calls = [];
    w.__fake = { upsertError: null, rpcError: null, rpcData: {} };
    w.__calls = calls;
    w.eval(`
        var globalOnboardingSteps = [], globalOnboardingAnswers = [], globalClientsData = [], portalClientRows = [];
        var globalPrivateAnswerKeys = new Set(), globalPrivateAnswers = [], globalSecretsMeta = [];
        var currentActiveClient = 'Acme Decks', clientEmail = 'owner@acme.com', currentUserRole = 'client';
        // Applicability not loaded, so every question is asked (per-question services: tests/question-services.test.mjs)
        function obFor() { return null; }
        var globalServices = [];
        var supabaseClient = {
            from: (t) => ({ upsert: async (row, opts) => { __calls.push({ kind: 'upsert', table: t, row, opts }); return { error: __fake.upsertError }; },
                            delete: () => { const filters = []; const ch = { eq: (k, v) => { filters.push([k, v]); return ch; },
                                select: async () => { __calls.push({ kind: 'delete', table: t, filters }); return { data: __fake.deleteRows ?? [{ question_id: 'x' }], error: null }; } }; return ch; } }),
            rpc: async (name, args) => { __calls.push({ kind: 'rpc', name, args }); return __fake.rpcError ? { data: null, error: __fake.rpcError } : { data: __fake.rpcData[name] ?? null, error: null }; }
        };
        var CSS = { escape: (s) => String(s) }; // jsdom has no CSS.escape; ids here are plain letters, digits and _
        function previewBlocksWrite() { return false; }
        function onboardingProgressFor() { return null; }
        async function obCompleteStep(id) { window.__completed = id; }
        async function loadOnboardingApplicability() {}
        function renderGetStarted() {}
        function updateGetStartedTabVisibility() {}
        ${code}
        window.__t = { obCleanAnswer, obCollectAnswers, obQuestionsFormHtml, obSaveAnswers, clientAnswersHtml, obQuestionRowHtml,
                       readObQuestions, obQuestionProblems, obPrivateKey, answerText: (id) => obAnswerText[id], setRole: (r) => { currentUserRole = r; },
                       state: () => ({ globalOnboardingSteps, globalOnboardingAnswers, globalPrivateAnswerKeys, globalPrivateAnswers, globalSecretsMeta }) };
    `);
    return { w, t: w.__t, calls, st: w.__t.state() };
}

const STEP_B = { id: '11111111-1111-1111-1111-111111111111', title: 'Registering your texting number', step_type: 'questions', questions: stepsFromSql.find((s) => s.title === 'Registering your texting number').questions };
const STEP_E = { id: '22222222-2222-2222-2222-222222222222', title: 'Access to your website', step_type: 'questions', questions: stepsFromSql.find((s) => s.title === 'Access to your website').questions };
const STEP_A = { id: '33333333-3333-3333-3333-333333333333', title: 'About your business', step_type: 'questions', questions: stepsFromSql.find((s) => s.title === 'About your business').questions };
ok(stepsFromSql.length === 6, 'read the six steps from the real SQL file');

// ---- the steps in the SQL pass the editor's own checks ----
{
    const { t } = makeWorld();
    for (const s of stepsFromSql) ok(t.obQuestionProblems(s.title, s.questions).length === 0, `${s.title}: no problems in the editor's checks: ${t.obQuestionProblems(s.title, s.questions).join(' | ')}`);
}

// ---- EIN ----
{
    const { t } = makeWorld();
    const ein = { id: 'x', type: 'ein' };
    ok(t.obCleanAnswer(ein, '123456789').value === '12-3456789', 'EIN tidied to 12-3456789');
    ok(t.obCleanAnswer(ein, ' 12-3456789 ').value === '12-3456789', 'EIN with a dash accepted');
    ok(/9 digits/.test(t.obCleanAnswer(ein, '1234').error), 'a short EIN is refused');
    ok(t.obCleanAnswer(ein, '').value === '', 'a blank EIN is fine (sole proprietors)');
}

// ---- the form ----
{
    const { w, t, st } = makeWorld();
    st.globalOnboardingSteps.push(STEP_B, STEP_E);
    // a stray public answer under a private id must never be shown back
    st.globalOnboardingAnswers.push({ client_name: 'Acme Decks', step_id: STEP_B.id, answers: { b_legal: { label: 'x', value: 'LEAKED VALUE' } } });
    let html = t.obQuestionsFormHtml(STEP_B, false);
    ok(!html.includes('LEAKED VALUE'), 'a private question never shows a value back');
    ok((html.match(/Only our team can see this/g) || []).length === 3, 'every private question says only our team can see it');
    ok(/inputmode="numeric"/.test(html) && /placeholder="12-3456789"/.test(html), 'the EIN box asks for numbers');
    ok(!/Saved\./.test(html), 'nothing says saved before anything is');
    st.globalPrivateAnswerKeys.add(t.obPrivateKey('Acme Decks', STEP_B.id, 'b_legal'));
    html = t.obQuestionsFormHtml(STEP_B, false);
    ok(/placeholder="Saved"/.test(html) && /Saved\. Only our team can see this\. Type here to change it\./.test(html), 'a saved private answer says so, without its value');
    const eh = t.obQuestionsFormHtml(STEP_E, false);
    ok(/type="password"[^>]*data-qid="e_password"|data-qid="e_password"[^>]*type="password"|type="password" id="obq-[^"]+-e_password"/.test(eh) && /autocomplete="new-password"/.test(eh), 'the website password is a password box');
    ok(/stored encrypted/.test(eh), 'the password says it is stored encrypted');
}

// ---- collecting answers ----
function formFor(w, t, step) {
    w.document.getElementById('out').innerHTML = t.obQuestionsFormHtml(step, false);
    return w.document.getElementById(`obq-form-${step.id}`);
}
function fill(w, form, id, value) {
    const el = form.querySelector(`[data-qid="${id}"]`);
    if (el.tagName === 'FIELDSET') el.querySelector(`input[value="${value}"]`).checked = true; else el.value = value;
}
{
    const { w, t, st } = makeWorld();
    st.globalOnboardingSteps.push(STEP_B);
    let form = formFor(w, t, STEP_B);
    let c = t.obCollectAnswers(STEP_B, form);
    ok(c.missing.length === 2, 'required private questions are required while unanswered: ' + c.missing.join('; '));
    fill(w, form, 'b_legal', 'Acme Decks LLC'); fill(w, form, 'b_type', 'LLC'); fill(w, form, 'b_ein', '123456789');
    c = t.obCollectAnswers(STEP_B, form);
    ok(Object.keys(c.answers).length === 0 && Object.keys(c.privateAnswers).sort().join() === 'b_ein,b_legal,b_type', 'private answers are kept apart from the readable ones');
    ok(c.privateAnswers.b_ein.value === '12-3456789', 'the EIN is tidied before saving');
    st.globalPrivateAnswerKeys.add(t.obPrivateKey('Acme Decks', STEP_B.id, 'b_legal'));
    st.globalPrivateAnswerKeys.add(t.obPrivateKey('Acme Decks', STEP_B.id, 'b_type'));
    form = formFor(w, t, STEP_B);
    c = t.obCollectAnswers(STEP_B, form);
    ok(c.missing.length === 0, 'a saved private answer counts as answered though its box is empty');
}

// ---- saving ----
{
    const { w, t, st, calls } = makeWorld();
    st.globalOnboardingSteps.push(STEP_A);
    const form = formFor(w, t, STEP_A);
    fill(w, form, 'a_name', 'Acme Decks'); fill(w, form, 'a_mobile', '801-555-0100');
    w.__fake.rpcData.save_private_onboarding_answers = ['a_mobile'];
    const r = await t.obSaveAnswers(STEP_A.id, { draft: true });
    const up = calls.find((x) => x.kind === 'upsert');
    const rpc = calls.find((x) => x.kind === 'rpc' && x.name === 'save_private_onboarding_answers');
    ok(r.ok && up.table === 'onboarding_answers' && up.row.answers.a_name.value === 'Acme Decks' && !up.row.answers.a_mobile, 'readable answers saved as before, without the private one');
    ok(rpc && rpc.args.p_client === 'Acme Decks' && rpc.args.p_step_id === STEP_A.id && rpc.args.p_answers.a_mobile.value === '801-555-0100' && !rpc.args.p_answers.a_name, 'the private answer goes to the private store only');
    ok(st.globalPrivateAnswerKeys.has(t.obPrivateKey('Acme Decks', STEP_A.id, 'a_mobile')), 'the portal now knows it is saved');
}
{
    const { w, t, st, calls } = makeWorld();
    st.globalOnboardingSteps.push(STEP_A);
    const form = formFor(w, t, STEP_A);
    fill(w, form, 'a_name', 'Acme Decks');
    await t.obSaveAnswers(STEP_A.id, { draft: true });
    ok(!calls.some((x) => x.kind === 'rpc'), 'no private answers typed: the private store is not called');
}
{
    const { w, t, st } = makeWorld();
    st.globalOnboardingSteps.push(STEP_B);
    const form = formFor(w, t, STEP_B);
    fill(w, form, 'b_legal', 'Acme Decks LLC');
    w.__fake.rpcError = { message: 'function save_private_onboarding_answers does not exist' };
    const r = await t.obSaveAnswers(STEP_B.id, { draft: false });
    ok(!r.ok && /Couldn't save some of your answers/.test(w.document.getElementById(`obq-status-${STEP_B.id}`).innerText), 'a failed private save is reported, never silently dropped');
}

// ---- the admin view ----
{
    const { w, t, st } = makeWorld();
    t.setRole('admin');
    st.globalOnboardingSteps.push(STEP_B, STEP_E);
    st.globalPrivateAnswers.push({ client_name: 'Acme Decks', step_id: STEP_B.id, answers: { b_legal: { label: 'Legal business name', value: '<img src=x onerror=alert(1)> LLC' }, b_ein: { label: 'EIN', value: '12-3456789' } }, updated_at: '2026-10-15T12:00:00Z' });
    st.globalSecretsMeta.push({ client_name: 'Acme Decks', step_id: STEP_E.id, question_id: 'e_password', label: 'Password', updated_at: '2026-10-15T12:00:00Z' });
    const html = t.clientAnswersHtml('Acme Decks');
    ok(html.includes('Registering your texting number') && html.includes('12-3456789'), 'a step with only private answers still shows, with its answers');
    ok(!html.includes('<img src=x') && html.includes('&lt;img'), 'answers are escaped');
    ok(/fa-lock/.test(html) && /fa-key/.test(html), 'private answers and the stored login are marked');
    ok(html.includes('••••••••') && /onclick="revealOnboardingSecret\(this\)"/.test(html) && !/Copy answers/.test(html), 'the password is masked behind Reveal; no Copy when nothing is shareable');
    w.document.getElementById('out').innerHTML = html;
    const btn = w.document.querySelector('[onclick="revealOnboardingSecret(this)"]');
    // reveal: fake answers with markup, which must stay text
    const calls = w.__calls;
    w.__fake.rpcData.reveal_onboarding_secret = '<b>hunter2</b>';
    await w.revealOnboardingSecret(btn);
    const rv = calls.find((x) => x.name === 'reveal_onboarding_secret');
    ok(rv && rv.args.p_client === 'Acme Decks' && rv.args.p_step_id === STEP_E.id && rv.args.p_question_id === 'e_password', 'Reveal asks for exactly that one secret');
    const span = btn.parentElement.querySelector('.ob-secret-val');
    ok(span.textContent === '<b>hunter2</b>' && !span.querySelector('b'), 'the revealed value is shown as text, never as markup');
}
{
    const { w, t, st } = makeWorld();
    st.globalOnboardingSteps.push(STEP_E);
    st.globalSecretsMeta.push({ client_name: 'Acme Decks', step_id: STEP_E.id, question_id: 'e_password', label: 'Password' });
    w.document.getElementById('out').innerHTML = t.clientAnswersHtml('Acme Decks');
    await w.revealOnboardingSecret(w.document.querySelector('[onclick="revealOnboardingSecret(this)"]'));
    ok(!w.__calls.some((x) => x.name === 'reveal_onboarding_secret'), 'a non-admin page never asks to reveal');
}
{
    const { t, st } = makeWorld();
    t.setRole('admin');
    st.globalOnboardingSteps.push(STEP_A);
    st.globalOnboardingAnswers.push({ client_name: 'Acme Decks', step_id: STEP_A.id, answers: { a_name: { label: 'Business name', value: 'Acme' } }, updated_at: '2026-10-15T12:00:00Z' });
    st.globalPrivateAnswers.push({ client_name: 'Acme Decks', step_id: STEP_A.id, answers: { a_mobile: { label: 'Your mobile', value: '801-555-0100' } } });
    const html = t.clientAnswersHtml('Acme Decks');
    ok(/Copy answers \(leaves out the private ones\)/.test(html) && html.includes('801-555-0100'), 'Copy is offered and says it leaves the private answers out');
}

// ---- Templates toggles ----
{
    const { w, t } = makeWorld();
    const wrap = w.document.createElement('div');
    wrap.innerHTML = t.obQuestionRowHtml({ id: 'q1', label: 'Password', type: 'short', secret: true }) + t.obQuestionRowHtml({ id: 'q2', label: 'Mobile', type: 'phone', private: true }) + t.obQuestionRowHtml({ id: 'q3', label: 'Name', type: 'short' });
    const rows = wrap.querySelectorAll('.ob-q-row');
    ok(rows[0].querySelector('.ob-q-secret').checked && rows[0].querySelector('.ob-q-private').checked, 'an encrypted question shows both boxes ticked');
    ok(!rows[2].querySelector('.ob-q-private').checked && !rows[2].querySelector('.ob-q-secret').checked, 'an ordinary question shows neither');
    ok([...rows[0].querySelectorAll('.ob-q-type option')].some((o) => o.value === 'ein'), 'EIN is a question type');
    const read = t.readObQuestions(wrap);
    ok(read[0].secret === true && !read[0].private && read[1].private === true && !read[1].secret && !read[2].private && !read[2].secret, 'saving reads the boxes back: encrypted, private, neither');
    const probs = t.obQuestionProblems('S', [
        { id: 'a', label: 'Type', type: 'choice', options: ['A', 'B'], private: true },
        { id: 'b', label: 'Follow-up', type: 'short', options: [], show_if: { q: 'a', any: ['A'] } },
        { id: 'c', label: 'Fact', type: 'short', private: true, fact: 'crm_name' },
        { id: 'd', label: 'Pick', type: 'choice', options: ['x'], secret: true },
    ]);
    ok(probs.length === 3 && /depend on a private answer/.test(probs.join()) && /can't also save to the client/.test(probs.join()) && /can't be encrypted/.test(probs.join()),
        'the editor refuses a question depending on a private answer, a private fact, and an encrypted choice: ' + probs.join(' | '));
}

// ---- the style picker ----
const STEP_W = { id: '44444444-4444-4444-4444-444444444444', title: 'Your new website', step_type: 'questions', questions: JSON.parse(JSON.stringify(stepsFromSql.find((s) => s.title === 'Your new website').questions)) };
{
    const { w, t, st } = makeWorld();
    const sq = STEP_W.questions.find((x) => x.type === 'style');
    sq.styles[0].link = 'https://claude.ai/artifact/PkBs8x6iwdoZdUHkMtcdJX';
    sq.styles[0].image = 'https://example.supabase.co/storage/v1/object/public/media/bold.jpg';
    sq.styles[1].link = 'javascript:alert(1)';
    sq.styles[1].image = 'http://not-https.example/x.jpg';
    sq.styles[2].colors = ['#123456', 'red;background:url(x)', '#zzz'];
    sq.styles[3].name = 'Refined <b>and</b> premium';
    st.globalOnboardingSteps.push(STEP_W);
    const html = t.obQuestionsFormHtml(STEP_W, false);
    w.document.getElementById('out').innerHTML = html;
    const cards = w.document.querySelectorAll('.ob-style-card');
    ok(cards.length === 4, 'four looks shown as cards');
    ok(cards[0].querySelector('a[target="_blank"][rel~="noopener"]')?.href === sq.styles[0].link && cards[0].querySelector('img')?.src === sq.styles[0].image, 'a look links to its example site (new tab) and shows its picture');
    ok(!cards[1].querySelector('a') && !cards[1].querySelector('img'), 'a non-https link or picture is never shown');
    ok(cards[2].querySelectorAll('[aria-label="Colors"] span').length === 1 && !html.includes('url(x)'), 'only real color codes reach the page');
    ok(!cards[3].querySelector('b') && cards[3].textContent.includes('Refined <b>and</b> premium'), 'look names are escaped');
    ok(cards[0].querySelectorAll('input[type="radio"]').length === 2, 'each look has a 1st and a 2nd choice');

    const form = w.document.getElementById(`obq-form-${STEP_W.id}`);
    const pick = (i, which) => { cards[i].querySelector(`input[name$="-${which}"]`).checked = true; };
    let c = t.obCollectAnswers(STEP_W, form);
    ok(c.missing.some((m) => /Pick the look/.test(m)), 'the style picker is required');
    pick(0, 'first'); pick(2, 'second');
    c = t.obCollectAnswers(STEP_W, form);
    ok(JSON.stringify(c.answers.w_style.value) === JSON.stringify(['Bold and local', 'Warm and friendly']) && !c.missing.some((m) => /Pick the look/.test(m)), 'saved as [1st, 2nd]');
    pick(0, 'second');
    c = t.obCollectAnswers(STEP_W, form);
    ok(c.errors.some((e) => /different look/.test(e.message)), 'the same look twice is refused');
    ok(/Pick your first choice too/.test(t.obCleanAnswer(sq, ['', 'Bold and local']).error), 'a second choice without a first is refused');
    ok(/from the looks shown/.test(t.obCleanAnswer(sq, ['Something else', '']).error), 'a look that is not offered is refused');
    ok(JSON.stringify(t.obCleanAnswer(sq, ['Bold and local', '']).value) === '["Bold and local"]', 'a first choice alone is fine');
}
{
    const { w, t } = makeWorld();
    const wrap = w.document.createElement('div');
    const sq = stepsFromSql.find((s) => s.title === 'Your new website').questions.find((x) => x.type === 'style');
    wrap.innerHTML = t.obQuestionRowHtml(sq);
    ok(wrap.querySelectorAll('.ob-style-row').length === 4 && wrap.querySelector('.ob-q-styles').style.display === '', 'Templates shows the looks editor for a style picker');
    wrap.querySelector('.ob-style-link').value = 'https://claude.ai/artifact/abc';
    const read = t.readObQuestions(wrap)[0];
    ok(read.type === 'style' && read.styles.length === 4 && read.styles[0].link === 'https://claude.ai/artifact/abc' && read.styles[0].colors.length === 4, 'saving reads the looks back, links and colors included');
    ok(t.obQuestionProblems('S', [read]).length === 0, 'the starting looks pass the editor checks');
    const bad = { ...read, styles: [{ ...read.styles[0], link: 'http://x.com', colors: ['blue'] }] };
    const probs = t.obQuestionProblems('S', [bad]).join(' | ');
    ok(/at least two looks/.test(probs) && /must start with https/.test(probs) && /isn't a color code/.test(probs), 'the editor refuses one look, a non-https link and a bad color: ' + probs);
    const plain = w.document.createElement('div');
    plain.innerHTML = t.obQuestionRowHtml({ id: 'z', label: 'Plain', type: 'short' });
    ok(plain.querySelector('.ob-q-styles').style.display === 'none', 'other question types hide the looks editor');
}

// ---- the SEO step's Copy (for Cuppa) carries the services answer from About your business ----
{
    const { t, st } = makeWorld();
    t.setRole('admin');
    const SEO = { id: '55555555-5555-5555-5555-555555555555', title: 'Tell us about your business for SEO', step_type: 'questions', service_keys: ['seo'],
                  questions: [{ id: 'q_area', label: 'Areas you serve', type: 'short' }] };
    ok(STEP_A.questions.some((q) => q.id === 'a_services' && /custom_value:services_list/.test(q.dest || '')), 'About your business asks the services question, saving to services_list');
    ok(!stepsFromSql.find((s) => s.title === 'Your jobs and offers').questions.some((q) => q.id === 'd_services'), 'Your jobs and offers no longer asks it');
    st.globalOnboardingSteps.push(STEP_A, SEO);
    st.globalOnboardingAnswers.push({ client_name: 'Acme Decks', step_id: STEP_A.id, answers: { a_services: { label: 'Which services do you want more calls for?', value: 'Decks, pergolas' } } });
    st.globalOnboardingAnswers.push({ client_name: 'Acme Decks', step_id: SEO.id, answers: { q_area: { label: 'Areas you serve', value: 'Lehi' } } });
    t.clientAnswersHtml('Acme Decks');
    const seo = t.answerText(SEO.id);
    ok(seo.includes('Which services do you want more calls for?\nDecks, pergolas') && seo.includes('Areas you serve\nLehi'), 'the SEO copy includes the services answer');
    ok(!t.answerText(STEP_A.id).includes('Areas you serve'), "other steps' copy is unchanged");
    st.globalOnboardingAnswers[1].answers.q_services = { label: 'Which services do you want more calls for?', value: 'Old answer' };
    t.clientAnswersHtml('Acme Decks');
    const again = t.answerText(SEO.id);
    ok(again.includes('Old answer') && !again.includes('Decks, pergolas'), 'an SEO step that already has a services answer keeps its own');
}

// ---- deleting a stored password ----
{
    const { w, t, st } = makeWorld();
    t.setRole('admin');
    w.confirm = () => true;
    const STEP_E2 = { ...STEP_E };
    st.globalOnboardingSteps.push(STEP_E2);
    st.globalSecretsMeta.push({ client_name: 'Acme Decks', step_id: STEP_E.id, question_id: 'e_password', label: 'Password' });
    w.document.getElementById('out').innerHTML = t.clientAnswersHtml('Acme Decks');
    const del = w.document.querySelector('[onclick="deleteOnboardingSecret(this)"]');
    ok(!!del, 'an admin sees Delete beside Reveal');
    w.__fake.deleteRows = [];
    await w.deleteOnboardingSecret(del);
    ok(/Couldn't delete/.test(w.document.querySelector('.ob-secret-val').textContent) && t.state().globalSecretsMeta.length === 1, 'a delete that removed no row is reported, not shown as done');
    w.__fake.deleteRows = null;
    await w.deleteOnboardingSecret(del);
    const call = w.__calls.filter((x) => x.kind === 'delete').pop();
    ok(call.table === 'onboarding_secrets' && JSON.stringify(call.filters) === JSON.stringify([['client_name', 'Acme Decks'], ['step_id', STEP_E.id], ['question_id', 'e_password']]),
        'Delete removes exactly that one stored password');
    ok(t.state().globalSecretsMeta.length === 0 && w.document.querySelector('.ob-secret-val').textContent === 'Deleted', 'it disappears from the list');
}
{
    const { w, t, st } = makeWorld();
    w.confirm = () => true;
    st.globalSecretsMeta.push({ client_name: 'Acme Decks', step_id: STEP_E.id, question_id: 'e_password', label: 'Password' });
    w.document.getElementById('out').innerHTML = t.clientAnswersHtml('Acme Decks');
    await w.deleteOnboardingSecret(w.document.querySelector('[onclick="deleteOnboardingSecret(this)"]'));
    ok(!w.__calls.some((x) => x.kind === 'delete'), 'a non-admin page never deletes');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
