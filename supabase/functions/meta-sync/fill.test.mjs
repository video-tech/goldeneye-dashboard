// Which accounts meta-sync's fill mode re-asks Meta about. Run (node 22.6+):
//   node --experimental-strip-types supabase/functions/meta-sync/fill.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { accountsToFill, pickAccounts } = await import(pathToFileURL(path.join(here, 'parse.ts')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const accounts = pickAccounts([
    { name: 'Red Co', status: 'active', ad_account_id: 'act_111' },
    { name: 'Good Co', status: 'active', ad_account_id: '222' },
    { name: 'Astra', status: 'active', ad_account_id: '333' },
    { name: 'Quiet', status: 'active', ad_account_id: '444' },
]);
const pick = (o) => accountsToFill(accounts, o).map((a) => a.client_name).sort().join();
const base = { spentAccts: ['111', 'act_222', '333'], haveAccts: [], connectedClients: ['Red Co', 'Good Co', 'Quiet'] };

ok(pick(base) === 'Good Co,Red Co', 'spent yesterday, connected, no ad rows: both asked; Astra (never connected) and Quiet (no spend) not');
ok(pick({ ...base, haveAccts: ['act_111'] }) === 'Good Co', 'an account that already has yesterday\'s rows is not asked again (ids matched by digits)');
ok(pick({ ...base, haveAccts: ['111', '222'] }) === '', 'everyone in: no call to Meta at all');
ok(pick({ ...base, connectedClients: [] }) === '', 'nobody connected: nothing asked');
ok(pick({ ...base, spentAccts: [] }) === '', 'nobody spent: nothing asked');

// How index.ts uses it
const src = fs.readFileSync(path.join(here, 'index.ts'), 'utf8');
const fill = src.slice(src.indexOf('if (mode === "fill")'), src.indexOf('const days = mode === "backfill"'));
ok(fill.includes('accountsToFill(accounts, { spentAccts, haveAccts, connectedClients })'), 'fill mode picks accounts with accountsToFill');
ok(/syncAccount\(db, token, a, 2,/.test(fill), 'on a 2-day window');
ok(!/last_window:/.test(fill.slice(fill.indexOf('const todo'))), 'and leaves last_window (the full daily sync\'s window) alone');
ok(/\.range\(from, from \+ 999\)/.test(fill), 'reads yesterday\'s ad rows past the 1000-row cap');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
