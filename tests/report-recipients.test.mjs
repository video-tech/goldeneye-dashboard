// Who a report draft goes to (app.js reportRecipients): every address on the client's email field, not the oldest
// daily_reports row's. PANDEN's oldest rows carry alpha@ only, so the old rule drafted to alpha@ alone.
// Run: node tests/report-recipients.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('        function reportRecipients(clientName) {'), b = src.indexOf('        window.reportRecipients', a);
if (a < 0 || b < 0) throw new Error('reportRecipients not found');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const make = (clients, reports, clientEmail = '') => new Function('globalClientsData', 'reportsForClient', 'clientEmail', 'normalize',
    src.slice(a, b) + '; return reportRecipients;')(clients, () => reports, clientEmail, (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, ''));

const panden = { name: 'PANDEN Construction', client_email: 'alpha@pandenconstruction.com,estimates@pandenconstruction.com,ryan@pandenconstruction.com' };
const oldRows = [{ date: '2023-02-11', client_email: 'alpha@pandenconstruction.com' }, { date: '2026-11-11', client_email: panden.client_email }];
let f = make([panden], oldRows);
ok(JSON.stringify(f('PANDEN Construction')) === JSON.stringify(['alpha@pandenconstruction.com', 'estimates@pandenconstruction.com', 'ryan@pandenconstruction.com']), 'all three PANDEN addresses, from the client field');

f = make([{ name: 'X', client_email: '' }], [{ date: '2023-01-01', client_email: 'old@x.com' }, { date: '2026-11-01', client_email: 'a@x.com,\r\nb@x.com\r\n' }]);
ok(JSON.stringify(f('X')) === '["a@x.com","b@x.com"]', 'no client field: the newest report row, hidden line breaks dropped');

f = make([{ name: 'Y', client_email: 'one@y.com; one@y.com ,  two@y.com' }], []);
ok(JSON.stringify(f('Y')) === '["one@y.com","two@y.com"]', 'repeats and odd separators cleaned');

f = make([], [], '');
ok(f('Nobody').length === 0, 'nothing on file: no recipients');

const usesIt = (src.match(/const emailArray = reportRecipients\(clientName\);/g) || []).length;
ok(usesIt === 2 && !/recordWithEmail/.test(src), 'both Draft buttons use it, and the old oldest-row lookup is gone');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
