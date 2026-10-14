// Checks for meta-sync's fall-back to short windows. Run (node 22.6+):
//   node --experimental-strip-types supabase/functions/meta-sync/chunks.test.mjs
// It pulls the real syncAccount and its helpers out of index.ts and runs them against a fake Meta
// that refuses any window longer than 8 days with code 2, the way Caliber Cabinets' account does.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const parseUrl = pathToFileURL(path.join(here, 'parse.ts')).href;
const { windowsInChunks, windowEndingYesterday } = await import(parseUrl);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

// ---- the window maths ----
const NOW = new Date('2026-10-13T16:00:00Z');
const w = windowsInChunks(NOW, 90, 7);
ok(w.length === 13, '90 days in 7-day pieces is 13 windows: ' + w.length);
ok(w[0].until === '2026-10-12', 'newest window ends yesterday');
ok(w[w.length - 1].since === windowEndingYesterday(NOW, 90).since, 'oldest window starts where the single window would');
ok(w.every((x, i) => i === 0 || Date.parse(x.until) + 86400000 === Date.parse(w[i - 1].since)), 'windows are contiguous, with no gap and no overlap');
const span = (x) => (Date.parse(x.until) - Date.parse(x.since)) / 86400000 + 1;
ok(w.every((x) => span(x) <= 7) && w.reduce((n, x) => n + span(x), 0) === 90, 'no piece longer than 7 days, and the pieces add up to 90');
ok(windowsInChunks(NOW, 5, 7).length === 1 && windowsInChunks(NOW, 0, 7).length === 0, 'short and empty cases');

// ---- the real syncAccount, with a fake Meta and a fake database ----
const src = fs.readFileSync(path.join(here, 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('class GraphError');
const b = src.indexOf('async function recordState');
if (a < 0 || b < 0) throw new Error('markers not found in index.ts');
const consts = src.slice(src.indexOf('const GRAPH ='), src.indexOf('class GraphError'));
// Node's type stripping cannot read a TypeScript parameter property, so this one class is swapped for
// the equivalent plain version. Nothing else in the block is changed.
const classStart = src.indexOf('class GraphError');
const classEnd = src.indexOf('\n}\n', classStart) + 3;
if (classStart < 0 || classEnd < 3) throw new Error('GraphError class not found');
const body = src.slice(a, b).replace(src.slice(classStart, classEnd),
    'class GraphError extends Error {\n    constructor(message, code) { super(message); this.code = code; }\n}\n');
const header = `import { parseInsights, parseActivities, isRateLimit, scrubToken, windowEndingYesterday, windowsInChunks } from '${parseUrl}';\n`;
const file = path.join(os.tmpdir(), 'meta_sync_under_test.ts');
fs.writeFileSync(file, header + consts + body + '\nexport { syncAccount, GraphError };\n');

let calls = [], failWindows = null, alwaysFail = false, rateLimit = false;
const fakeInsight = (since) => ({ data: [{ ad_id: 'ad-' + since, ad_name: 'n', adset_id: 's', adset_name: 's', campaign_id: 'c', campaign_name: 'c', date_start: since, date_stop: since, spend: '10', impressions: '100', reach: '90', inline_link_clicks: '3', actions: [{ action_type: 'lead', value: '1' }] }] });
globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u.pathname + ' ' + (u.searchParams.get('time_range') || ''));
    const err = (code, message) => ({ ok: false, status: 400, statusText: 'Bad', json: async () => ({ error: { type: 'OAuthException', code, message } }) });
    if (rateLimit) return err(17, 'User request limit reached');
    if (alwaysFail) return err(2, 'Service temporarily unavailable');
    if (u.pathname.endsWith('/insights')) {
        const tr = JSON.parse(u.searchParams.get('time_range'));
        const days = (Date.parse(tr.until) - Date.parse(tr.since)) / 86400000 + 1;
        if (days > 8) return err(2, 'Service temporarily unavailable');
        if (failWindows && failWindows.has(tr.since)) return err(2, 'Service temporarily unavailable');
        return { ok: true, status: 200, json: async () => fakeInsight(tr.since) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
};
const written = [];
const db = { from: (t) => ({ upsert: async (rows) => { written.push(...rows.map((r) => ({ t, ...r }))); return { error: null }; } }) };

const { syncAccount } = await import(pathToFileURL(file).href);
const acct = { ad_account_id: '1186680545676569', client_name: 'Caliber Cabinets' };

// 90 days: the big request is refused, so it is pulled in pieces and all of them load
let r = await syncAccount(db, 'tok', acct, 90);
ok(r.chunked === true && r.failed_windows.length === 0, 'falls back to pieces and every piece loads');
ok(written.filter((x) => x.t === 'meta_ad_daily').length === 13, 'one ad row from each of the 13 pieces: ' + written.filter((x) => x.t === 'meta_ad_daily').length);
ok(r.since === windowEndingYesterday(new Date(), 90).since && r.until === windowEndingYesterday(new Date(), 90).until, 'reports the whole window');

// a window that always fails is skipped and named, and the others still load
written.length = 0; calls = [];
const bad = windowsInChunks(new Date(), 90, 7)[3].since;
failWindows = new Set([bad]);
r = await syncAccount(db, 'tok', acct, 90);
ok(r.failed_windows.length === 1 && r.failed_windows[0].startsWith(bad), 'one failed piece is named: ' + r.failed_windows);
ok(written.filter((x) => x.t === 'meta_ad_daily').length === 12, 'the other 12 pieces still load');
ok(calls.filter((c) => c.includes(JSON.stringify(bad)) || c.includes(bad)).length >= 2, 'the failing piece was retried once');
failWindows = null;

// an 8-day pull (the daily job) still works, and a short window that fails is not chunked again
written.length = 0;
r = await syncAccount(db, 'tok', acct, 8);
ok(!r.chunked && written.length >= 1, 'an 8-day window loads in one request');

// nothing loads at all: the error is thrown, as before, for the caller to report
alwaysFail = true;
let threw = null;
try { await syncAccount(db, 'tok', acct, 90); } catch (e) { threw = e; }
ok(threw && /Service temporarily unavailable/.test(threw.message), 'if no piece loads, the last error is thrown');
alwaysFail = false;

// a rate limit stops at once, with no chunking
calls = [];
rateLimit = true;
threw = null;
try { await syncAccount(db, 'tok', acct, 90); } catch (e) { threw = e; }
ok(threw && threw.code === 17 && calls.length === 1, 'a rate limit stops immediately instead of hammering Meta: ' + calls.length + ' call(s)');


// ---- asking for pieces outright, skipping what is already loaded, and stopping in time ----
rateLimit = false; alwaysFail = false; failWindows = null; // the checks above leave the fake Meta rate limited
written.length = 0; calls = [];
r = await syncAccount(db, 'tok', acct, 90, { chunked: true });
ok(r.chunked === true && r.failed_windows.length === 0 && written.filter((x) => x.t === 'meta_ad_daily').length === 13, 'chunked: true loads all 13 pieces');
const ninety = windowEndingYesterday(new Date(), 90);
ok(!calls.some((c) => c.includes(ninety.since) && c.includes(ninety.until)), 'chunked: true never makes the doomed whole-window request first');

written.length = 0;
r = await syncAccount(db, 'tok', acct, 90, { chunked: true, skipDays: 42 });
ok(written.filter((x) => x.t === 'meta_ad_daily').length === 7, 'skip 42 days leaves out the 6 newest pieces: ' + written.filter((x) => x.t === 'meta_ad_daily').length);
const all = windowsInChunks(new Date(), 90, 7);
ok(r.until === all[6].until && r.since === ninety.since, 'and the reported window is the older part only: ' + r.since + '..' + r.until);
ok(!written.some((x) => x.t === 'meta_ad_daily' && x.date >= all[5].since), 'nothing newer than the skipped range was rewritten');
let threw2 = null;
try { await syncAccount(db, 'tok', acct, 90, { chunked: true, skipDays: 90 }); } catch (e) { threw2 = e; }
ok(threw2 && /nothing to load/.test(threw2.message), 'skipping everything is an error, not a silent no-op');

// the deadline: each Meta call costs 40 seconds on a fake clock, so the pieces run out of time part way
const realNow = Date.now;
let fake = realNow();
Date.now = () => fake;
const slowFetch = globalThis.fetch;
globalThis.fetch = async (...args) => { fake += 40_000; return slowFetch(...args); };
written.length = 0;
r = await syncAccount(db, 'tok', acct, 90, { chunked: true, deadline: fake + 135_000 });
Date.now = realNow;
globalThis.fetch = slowFetch;
const loadedPieces = written.filter((x) => x.t === 'meta_ad_daily').length;
ok(loadedPieces >= 1 && loadedPieces < 13, 'out of time part way: some pieces load and the rest do not (' + loadedPieces + ' of 13)');
ok(r.failed_windows.length === 13 - loadedPieces && r.failed_windows.every((w) => /out of time/.test(w)), 'the pieces left over are named as out of time, so a rerun knows what is missing');
ok(r.failed_windows[0].startsWith(windowsInChunks(new Date(), 90, 7)[loadedPieces].since), 'and they are the older ones');

console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
