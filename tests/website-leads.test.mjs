// Website leads (seo_website_leads): the second lead number beside "Leads from Google", for sites whose form hides the
// source (PANDEN's GHL form in a Wix frame, 2026-10-30). Runs the real websiteLeadsSummary cut from app.js, and checks
// each surface asks for it.   node tests/website-leads.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const body = fs.readFileSync(path.join(root, 'body.html'), 'utf8');
const a = app.indexOf(' function websiteLeadsSummary('), b = app.indexOf('\n }\n', a);
if (a < 0 || b < 0) throw new Error('websiteLeadsSummary not found');
const websiteLeadsSummary = new Function('LEAD_TRACKING_START', app.slice(a, b + 3) + '; return websiteLeadsSummary;')('2026-09-11');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const week = { p_start: '2026-10-19', p_end: '2026-10-25', p_prior_start: '2026-10-12', p_prior_end: '2026-10-18' };

// PANDEN: every website lead unknown, none organic, history backfilled to 2024
let r = websiteLeadsSummary({ website_leads: 4, prior_website_leads: 3, tracking_start: '2024-01-04' }, 0, 0, week);
ok(r && r.cur === 4 && r.prior === 3, 'PANDEN: shows 4 website leads against 3');
ok(r && r.comparable === true, 'PANDEN: backfilled history makes the week comparable');
ok(r && r.start === '2024-01-04', 'PANDEN: tracking start is its own');

// A client with the global start, looking at a range before it
r = websiteLeadsSummary({ website_leads: 2, prior_website_leads: 0, tracking_start: '2026-09-11' }, 0, 0,
    { p_start: '2026-09-08', p_end: '2026-09-14', p_prior_start: '2026-09-01', p_prior_end: '2026-09-07' });
ok(r && r.comparable === false, 'a prior window before tracking is not comparable');

// The prior window only partly measured
r = websiteLeadsSummary({ website_leads: 2, prior_website_leads: 1, tracking_start: '2026-09-11' }, 0, 0,
    { p_start: '2026-09-15', p_end: '2026-09-21', p_prior_start: '2026-09-08', p_prior_end: '2026-09-14' });
ok(r && r.comparable === false, 'a prior window that starts before tracking is not comparable');

// Every website lead is organic: nothing to add, so hidden
ok(websiteLeadsSummary({ website_leads: 3, prior_website_leads: 1, tracking_start: '2026-09-11' }, 3, 1, week) === null,
    'all website leads already counted as Google: hidden');
ok(websiteLeadsSummary({ website_leads: 0, prior_website_leads: 0, tracking_start: '2026-09-11' }, 0, 0, week) === null, 'no leads: hidden');
ok(websiteLeadsSummary(undefined, 0, 0, week) === null, 'RPC missing: hidden');

// 3Sixty-like: some organic, one direct
r = websiteLeadsSummary({ website_leads: 2, prior_website_leads: 0, tracking_start: '2026-09-11' }, 1, 0, week);
ok(r && r.cur === 2, 'one organic plus one direct shows 2');

// A null start falls back to the global date
r = websiteLeadsSummary({ website_leads: 1, prior_website_leads: 0, tracking_start: null }, 0, 0, week);
ok(r && r.start === '2026-09-11', 'null start falls back to LEAD_TRACKING_START');

// Wiring
ok(/id="cp-seo-webleads"[^>]*class="hidden/.test(body), 'client tab box starts hidden');
ok(body.includes('id="cp-seo-webleads-count"') && body.includes('id="cp-seo-webleads-delta"'), 'client tab count and delta exist');
ok(body.includes('id="seo-kpi-webleads"'), 'admin tile exists');
ok((app.match(/rpc\('seo_website_leads'/g) || []).length === 4, 'four callers: client tab, admin tab, report, chat');
ok(app.includes("never call these all Google leads"), 'the report tells the model these are not all Google');
ok(app.includes(".eq('client_name', clientName).eq('source', 'organic')"), 'admin organic load is filtered, not the whole history');
ok(!/\$\('cp-seo-webleads-count'\)\.innerHTML/.test(app), 'count written as text');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
