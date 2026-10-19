// The admin SEO tab's "Organic Leads" tile counts organic website leads only. lead_sources holds every website lead, and
// a paid funnel on the client's own subdomain lands there too (PANDEN: 22 paid quiz leads read as 22 organic, 2026-10-19).
// Runs the real seoLeadsInWindow cut from app.js.   node tests/seo-leads-tile.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const app = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const a = app.indexOf(' function seoLeadsInWindow('), b = app.indexOf('\n }\n', a);
if (a < 0 || b < 0) throw new Error('seoLeadsInWindow not found');
const seoLeadsInWindow = new Function(app.slice(a, b + 3) + '; return seoLeadsInWindow;')();

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const s = new Date('2026-10-12T00:00:00'), e = new Date('2026-10-18T23:59:59');
const leads = [
    ...Array.from({ length: 22 }, (_, i) => ({ created_at: `2026-10-${String(12 + (i % 7)).padStart(2, '0')}T15:00:00`, source: 'paid' })),
    { created_at: '2026-10-15T15:00:00', source: 'organic' },
    { created_at: '2026-10-16T15:00:00', source: 'unknown' },
    { created_at: '2026-10-16T15:00:00', source: 'referral' },
    { created_at: '2026-10-05T15:00:00', source: 'organic' },
];
ok(seoLeadsInWindow(leads, s, e) === 1, 'PANDEN\'s week: 22 paid + 1 organic + others reads 1');
ok(seoLeadsInWindow(leads, new Date('2026-10-01'), new Date('2026-10-11T23:59:59')) === 1, 'an organic lead outside the week counts in its own window');
ok(seoLeadsInWindow([], s, e) === 0, 'no leads reads 0');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
