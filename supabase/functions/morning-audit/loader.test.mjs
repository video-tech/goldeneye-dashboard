// Pulls loadAdRows / loadAdData out of the real index.ts and runs them against a fake database.
// Run (node 22.6+): node --experimental-strip-types supabase/functions/morning-audit/loader.test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const dir = path.dirname(fileURLToPath(import.meta.url)) + '/';
const tmp = path.join(os.tmpdir(), 'loader_under_test.ts');
const src = fs.readFileSync(dir + 'index.ts', 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('async function loadAdRows');
const b = src.indexOf('const PROMPT_INSTRUCTIONS');
if (a < 0 || b < 0) throw new Error('markers');
const block = src.slice(a, b);
const header = `const HISTORY_DAYS = 45;\n`;
fs.writeFileSync(tmp, header + block + '\nexport { loadAdRows, loadAdData };\n');
const { loadAdRows, loadAdData } = await import('file:///' + process.env.TEMP.replace(/\\/g, '/') + '/loader_under_test.ts');

let pass = 0, fail = 0; const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

// A fake PostgREST: 2300 rows for "Big", 3 for "Small"; honours eq / range / order enough to page
const make = ({ failAds = null, failState = null } = {}) => ({
    from(table) {
        const q = { table, name: null, lo: 0, hi: 999 };
        const api = {
            select() { return api; }, gte() { return api; }, order() { return api; },
            eq(c, v) { q.name = v; return api; },
            range(lo, hi) { q.lo = lo; q.hi = hi; return api; },
            then(res) {
                if (table === 'meta_sync_state') return res(failState ? { data: null, error: failState } : { data: [{ client_name: 'Small', last_run_at: '2026-10-13T15:30:00Z', last_error: null, last_window: '2026-10-05..2026-10-12' }], error: null });
                if (failAds) return res({ data: null, error: failAds });
                const total = q.name === 'Big' ? 2300 : 3;
                const rows = Array.from({ length: total }, (_, i) => ({ client_name: q.name, ad_id: String(i), date: '2026-10-10', spend: 1, leads: 0, ad_account_id: 'x' }));
                return res({ data: rows.slice(q.lo, q.hi + 1), error: null });
            },
        };
        return api;
    },
});
const sig = (name, target, verdict = 'STABLE') => ({ name, targetCpl: target, verdict });

let r = await loadAdRows(make(), ['Big', 'Small']);
ok(r && r.rows.length === 2303, 'pages past the 1000-row cap: got ' + r?.rows.length);
ok(/^\d{4}-\d{2}-\d{2}$/.test(r.cutoff), 'returns the history start date');
ok((await loadAdRows(make({ failAds: { message: 'relation "meta_ad_daily" does not exist' } }), ['Big'])) === null, 'a missing table returns null instead of throwing');

let d = await loadAdData(make(), [sig('A', null), sig('B', 0)]);
ok(d && d.rows.length === 0 && d.syncState.length === 0, 'no targets and nothing stale: nothing is loaded');
d = await loadAdData(make(), [sig('Small', 50)]);
ok(d && d.rows.length === 3 && d.syncState.length === 1, 'a client with a target: its ad rows and the sync state are loaded');
d = await loadAdData(make(), [sig('Small', null, 'DATA_STALE')]);
ok(d && d.rows.length === 3, 'a client with no target but stale data is loaded too, so "ads off" can be told apart');
d = await loadAdData(make(), [sig('Small', null, 'DATA_GAPS'), sig('Other', null, 'STABLE')]);
ok(d && d.rows.length === 3, 'only the stale client is read, not the stable one with no target');
ok((await loadAdData(make({ failAds: { message: 'boom' } }), [sig('Small', 50)])) === null, 'a database failure gives null, so the audit card is unaffected');
d = await loadAdData(make({ failState: { message: 'no table' } }), [sig('Small', 50)]);
ok(d && d.rows.length === 3 && d.syncState.length === 0, 'sync state unreadable: the ads still load, and nothing is declared "off"');

console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
