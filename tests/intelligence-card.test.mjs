// The dashboard's Midas Intelligence card reads the morning audit's context (mode "context"). Since
// 2026-10-23 that context starts with yesterday's day read (RED ALERT first), then the 7-day trend.
// Runs the real parser from app.js on context built by the real audit modules.
//   node tests/intelligence-card.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const audit = (f) => pathToFileURL(path.join(root, 'supabase/functions/morning-audit', f)).href;
const { computeDayRead, buildDayContext } = await import(audit('daily.js'));
const { buildAuditContext } = await import(audit('engine.js'));

const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const start = app.indexOf('function parseAuditSignalsForIntelligenceCard(md)');
const end = app.indexOf('async function loadDashIntelligence()');
if (start < 0 || end < 0) throw new Error('parser not found in app.js');
const parse = new Function(app.slice(start, end) + '\nreturn parseAuditSignalsForIntelligenceCard;')();

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const Y = '2026-10-25';
const sig = (name, verdict, extra = {}) => ({ name, verdict, targetCpl: 45, notes: [], flags: [], drivers: null, window: { recentFrom: '2026-10-19', recentTo: Y, baselineFrom: '2026-09-21', baselineTo: '2026-10-18' },
    recent: { spend: 700, leads: 10, cpl: 70 }, baseline: { cpl: 50 }, expectedLeads: 15, yardstick: 45, yardstickKind: 'target', cplDelta: 0.5, z: -2.5, spendDelta: 0, healthScore: 60, ...extra });
const signals = [sig('Red Co', 'CRITICAL'), sig('Fine Co', 'STABLE'), sig('Watch Co', 'WATCH', { notes: ['CTR down 20%'] })];
const rows = { 'Red Co': [{ date: Y, spend: 200, leads: 2 }], 'Fine Co': [{ date: Y, spend: 80, leads: 4 }], 'Watch Co': [{ date: Y, spend: 60, leads: 3 }] };
const reads = signals.map((s) => computeDayRead(s, rows[s.name]));
const md = buildDayContext(reads, signals) + '\n=== THE LAST 7 DAYS ===\n' + buildAuditContext(signals);

const items = parse(md);
const names = items.map((i) => i.client);
ok(names[0] === 'Red Co' && items[0].dot === '--neg' && items[0].note === '$100 CPL yesterday vs $45 target', 'yesterday\'s red alert comes first, with why: ' + JSON.stringify(items[0]));
ok(names.filter((n) => n === 'Red Co').length === 1, 'a client red yesterday and critical over 7 days shows once');
ok(names.includes('Watch Co') && items.find((i) => i.client === 'Watch Co').dot === '--warn', 'the 7-day WATCH still shows');
ok(!names.includes('Fine Co'), 'on-target and stable clients are not flagged');
ok(parse('').length === 0, 'no context, nothing shown');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
