// Fill in for client (app.js previewBlocksWrite / togglePreviewFillMode / obCompleteStep): while previewing, an admin can
// enter a client's answers and finish their questions and team steps, saved as the admin; nothing else gets through.
// Runs the real code in jsdom.   JSDOM_DIR=/path/to/dir node tests/preview-fill.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.JSDOM_DIR) { console.log('Set JSDOM_DIR to a folder with jsdom installed.'); process.exit(2); }
const { JSDOM } = createRequire(path.join(process.env.JSDOM_DIR, 'package.json'))('jsdom');

const src = fs.readFileSync(path.join(here, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const body = fs.readFileSync(path.join(here, '..', 'body.html'), 'utf8').replace(/\r\n/g, '\n');
const slice = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) throw new Error('slice ' + from); return src.slice(a, b); };
const guard = slice('// Guards any write that would be attributed', 'window.previewAsClient');
const progress = slice('async function saveOnboardingProgress', '// A help request is an open Client Request');
const complete = slice('window.obCompleteStep = async function', '// ---- Ticking and unticking');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const b0 = body.indexOf('<div id="client-preview-banner"'), b1 = body.indexOf('<div id="drawer-overlay"', b0);
const dom = new JSDOM(`<body>${body.slice(b0, b1)}</body>`);
const env = { alerts: [], confirms: [], answers: [], upserts: [] };
const win = { isClientPreview: false };
const ctx = {
    window: win, document: dom.window.document,
    alert: (m) => env.alerts.push(m),
    confirm: (m) => { env.confirms.push(m); return env.answers.length ? env.answers.shift() : true; },
    currentUserRole: 'admin', currentActiveClient: 'Todd Woods', clientEmail: 'admin@midas.test',
    globalOnboardingSteps: [{ id: 'q1', step_type: 'questions' }, { id: 'v1', step_type: 'video' }, { id: 't1', step_type: 'team' }, { id: 'q2', step_type: 'questions' }],
    globalOnboardingProgress: [],
    lastStep: null,
};
const run = new Function(...Object.keys(ctx), `
    const onboardingProgressFor = (c, id) => globalOnboardingProgress.find(p => p.client_name === c && p.step_id === id);
    const supabaseClient = { from: () => ({ upsert: async (row) => { __upserts.push(row); return { error: null }; } }) };
    const renderGetStarted = () => {}, updateGetStartedTabVisibility = () => {}, obNotifyOnboardingComplete = async () => {};
    const obWouldFinishOnboarding = (c, id) => id === __last();
    const previewBlocksWrite = (...a) => window.previewBlocksWrite(...a);
    ${guard}
    ${progress}
    ${complete}
    return { saveOnboardingProgress };`.replace(/__upserts/g, 'window.__upserts').replace(/__last\(\)/g, 'window.__last'));
win.__upserts = env.upserts;
const api = run(...Object.values(ctx));
const $ = (id) => dom.window.document.getElementById(id);
const reset = () => { env.alerts.length = 0; env.confirms.length = 0; env.upserts.length = 0; ctx.globalOnboardingProgress.length = 0; };

// Outside preview nothing is blocked
ok(win.previewBlocksWrite('saving answers', { fillable: true }) === false && env.alerts.length === 0, 'not previewing: writes go through');

// Previewing, fill-in off
win.isClientPreview = true; win.previewFillMode = false;
ok(win.previewBlocksWrite('saving answers', { fillable: true }) === true && /Fill in for client/.test(env.alerts[0]), 'preview: answers blocked, and the alert says how to fill them in');
reset();
ok(win.previewBlocksWrite('saving answers', { fillable: true, quiet: true }) === true && env.alerts.length === 0, 'a draft autosave is blocked without an alert');
await win.obCompleteStep('q1');
ok(env.upserts.length === 0 && env.alerts.length === 1, 'preview: finishing a step is still blocked');
reset();
ok(await api.saveOnboardingProgress('v1', { watch_percent: 50 }) === null && env.upserts.length === 0, 'preview: video progress is never saved');

// Turning fill-in on asks first, and the banner shows it
env.answers.push(false);
win.togglePreviewFillMode();
ok(win.previewFillMode === false, 'cancelling the confirm leaves fill-in off');
win.togglePreviewFillMode();
ok(win.previewFillMode === true && /saved to their real account/.test(env.confirms[1]) && /admin@midas\.test/.test(env.confirms[1]), 'confirm names the real account and who it is saved as');
ok(/Stop filling in/.test($('btn-preview-fill').innerHTML) && $('client-preview-fill-note').style.display === 'inline', 'banner shows fill-in is on');
reset();

// Fill-in on
ok(win.previewBlocksWrite('saving answers', { fillable: true }) === false, 'fill-in: answers go through');
ok(win.previewBlocksWrite('submitting a check-in') === true, 'fill-in: a check-in is still blocked');
reset();
win.__last = 'none';
await win.obCompleteStep('q1');
ok(env.upserts.length === 1 && env.upserts[0].step_id === 'q1' && env.upserts[0].completed_by === 'admin@midas.test' && env.upserts[0].completed_at, 'fill-in: a questions step is finished, as the admin');
reset();
await win.obCompleteStep('t1');
ok(env.upserts.length === 1 && env.upserts[0].step_id === 't1', 'fill-in: the team step is finished too');
reset();
await win.obCompleteStep('v1');
ok(env.upserts.length === 0 && env.alerts.length === 1, 'fill-in: a video step is still not finished for them');
reset();
ok(await api.saveOnboardingProgress('v1', { watch_percent: 50 }) === null, 'fill-in: video progress still never saved');

// Their last step asks about the text
reset(); win.__last = 'q2'; env.answers.push(false);
await win.obCompleteStep('q2');
ok(/last onboarding step/.test(env.confirms[0]) && env.upserts[0].completed_by === 'backfilled', 'last step, no text: saved as backfilled, which the trigger skips');
reset(); win.__last = 'q2'; env.answers.push(true);
await win.obCompleteStep('q2');
ok(env.upserts[0].completed_by === 'admin@midas.test', 'last step, text: saved as the admin, so the trigger texts them');

// Off again
win.togglePreviewFillMode();
ok(win.previewFillMode === false && /Fill in for client/.test($('btn-preview-fill').innerHTML) && $('client-preview-fill-note').style.display === 'none', 'turning it off needs no confirm and resets the banner');

// Wiring
ok(/window\.isClientPreview = true;\n    window\.previewFillMode = false;/.test(src) && /window\.isClientPreview = false;\n    window\.previewFillMode = false;/.test(src), 'off whenever a preview opens or closes');
ok(/previewBlocksWrite\('saving answers', \{ fillable: true, quiet: draft \}\)/.test(src) && /previewBlocksWrite\('submitting answers', \{ fillable: true \}\)/.test(src), 'answers save and submit are fillable');
ok(/obSaveTeam = async function\(stepId, justMe\) \{\n    if \(previewBlocksWrite\('saving their team', \{ fillable: true \}\)\) return;/.test(src), 'the team step refuses before writing anything');
ok(/previewBlocksWrite\('submitting a check-in'\)\)/.test(src) && /previewBlocksWrite\('approving an ad'\)\)/.test(src), 'check-ins and ad approvals are not fillable');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
