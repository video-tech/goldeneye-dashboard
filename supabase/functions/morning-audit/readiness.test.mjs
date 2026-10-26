// node supabase/functions/morning-audit/readiness.test.mjs
// The scheduled audit's wait-for-the-data rules, plus where index.ts uses them.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { steadyMissing, decideRun, denverNow, adDataMissing } from './readiness.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const Y = '2026-10-22';
const days = (from, to) => { const out = []; for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10)); return out; };
const prior = days('2026-10-15', '2026-10-21');
const rows = (acct, ds) => ds.map((d) => ({ ad_account_id: acct, date: d }));
const C = (name, acct, extra = {}) => ({ name, status: 'active', ad_account_id: acct, business_id: 'b', ...extra });

// The same cases as daily_pull_check's PGlite test
ok(steadyMissing([C('A', '111')], rows('111', [...prior, Y]), Y).length === 0, 'everyone in: nobody missing');
ok(steadyMissing([C('A', '111'), C('B', '222')], [...rows('111', prior), ...rows('222', [...prior, Y])], Y).join() === 'A', 'a steady spender without yesterday is missing');
ok(steadyMissing([C('A', '111')], rows('111', prior.slice(0, 5)), Y).length === 1, '5 of the 7 prior days is steady');
ok(steadyMissing([C('A', '111')], rows('111', prior.slice(0, 4)), Y).length === 0, '4 of the 7 is not (ads on and off never block)');
ok(steadyMissing([C('A', '111')], rows('111', [...prior.slice(0, 4), prior[0], prior[0]]), Y).length === 0, 'duplicate rows on one day count once');
ok(steadyMissing([C('A', 'act_123')], rows('123', prior), Y).length === 1 && steadyMissing([C('A', '123')], rows('act_123', [...prior, Y]), Y).length === 0, 'accounts match by digits, act_ or not');
ok(steadyMissing([C('P', '1', { status: 'paused' }), C('X', '2', { status: 'archived' }), C('N', '3', { status: null }), C('NB', '4', { business_id: ' ' }), C('NA', '', {})],
    [...rows('1', prior), ...rows('2', prior), ...rows('3', prior), ...rows('4', prior)], Y).join() === 'N', 'the Make pull\'s own filter: paused, archived, no business id and no account never block; null status is active');
ok(steadyMissing([C('A', '111')], rows('111', ['2026-10-14', ...prior.slice(0, 4)]), Y).length === 0, 'only the 7 days before yesterday count');
ok(steadyMissing([C('Z', '9'), C('A', '8')], [...rows('9', prior), ...rows('8', prior)], Y).join() === 'A,Z', 'sorted by name');
let threw = false; try { steadyMissing([], [], 'yesterday'); } catch { threw = true; }
ok(threw, 'a malformed date is an error, not a silent pass');

// When to run
const at = (h, m, ready) => decideRun({ minutes: h * 60 + m, ready });
ok(!at(8, 59, true).run, '8:59: too early even when ready');
ok(at(9, 0, true).run && at(9, 0, true).reason === 'ready' && !at(9, 0, true).deadline, '9:00 and ready: run');
ok(!at(9, 0, false).run && /waiting/.test(at(9, 0, false).reason), '9:00 and not ready: wait');
ok(!at(9, 59, false).run, '9:59 and not ready: still wait');
ok(at(10, 0, false).run && at(10, 0, false).deadline, '10:00: run anyway, marked as the deadline');
ok(at(10, 0, true).run && !at(10, 0, true).deadline, '10:00 and ready is a normal run');
ok(at(11, 59, false).run, 'late but before noon: still run (a missed morning catches up)');
ok(!at(12, 0, true).run, 'noon: give up, the button is still there');

// Mountain time, daylight saving included
const summer = denverNow(new Date('2026-10-23T15:05:00Z')), winter = denverNow(new Date('2026-11-05T16:05:00Z'));
ok(summer.today === '2026-10-23' && summer.yesterday === '2026-10-22' && summer.minutes === 9 * 60 + 5, 'October: 15:05 UTC is 9:05 Mountain: ' + JSON.stringify(summer));
ok(winter.minutes === 9 * 60 + 5 && winter.yesterday === '2026-11-04', 'November: 16:05 UTC is 9:05 Mountain');
ok(denverNow(new Date('2026-10-23T05:30:00Z')).today === '2026-10-22', 'just before midnight Mountain is still the day before');
ok(denverNow(new Date('2026-11-02T06:30:00Z')).yesterday === '2026-10-31', 'yesterday rolls back across a month');

// Waiting for yesterday's ad rows (meta-sync)
const st = (client_name, last_window) => ({ client_name, last_window });
const state = [st('A', '2026-10-15..2026-10-22'), st('B', '2026-10-15..2026-10-22'), st('Astra', null), st('C', '2026-10-15..2026-10-22')];
ok(adDataMissing({ spentYesterday: ['A', 'B', 'Astra', 'D'], syncState: state, withAdRows: ['B'] }).join() === 'A', 'waits only for a connected meta-sync client that spent yesterday and has no ad rows');
ok(adDataMissing({ spentYesterday: ['C'], syncState: state, withAdRows: [] }).join() === 'C', 'C spent and is connected with no rows: missing');
ok(adDataMissing({ spentYesterday: [], syncState: state, withAdRows: [] }).length === 0, 'nobody spent: nothing to wait for (C has no spend yesterday)');
ok(adDataMissing({ spentYesterday: ['Astra'], syncState: state, withAdRows: [] }).length === 0, 'meta-sync never loaded a window (Astra): never holds the audit up');
ok(adDataMissing({ spentYesterday: ['Z', 'A', 'A'], syncState: [...state, st('Z', 'x..y')], withAdRows: [] }).join() === 'A,Z', 'deduped and sorted');
ok(adDataMissing({ spentYesterday: ['A'], syncState: undefined, withAdRows: undefined }).length === 0, 'no sync state read: nothing to wait for');

// How index.ts uses it
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');
const iGate = src.indexOf('const decision = decideRun('), iModel = src.indexOf('openai.responses.create'), iCard = src.indexOf('if (fromCron && !force && !emailTest) {');
ok(iGate > 0 && iGate < iModel, 'the wait happens before any model call');
ok(iCard > 0 && iCard < src.indexOf('await loadSignals(db)'), 'today\'s card is checked before anything is loaded');
ok(/if \(fromCron && !emailTest\) \{\s*const now = denverNow/.test(src), 'only the schedule waits (the button, the chat and the test email never do)');
ok(/if \(force \|\| contextOnly\) \{\s*console\.warn\("morning-audit REFUSED/.test(src), 'the cron secret still cannot force a run or read the matrix');
ok(/const email = gate \? await sendAuditEmail/.test(src) && src.indexOf('const email = gate') > src.indexOf('.insert([{ html_body: html }])'), 'the email goes only with a scheduled card, after it is saved');
ok(/ready: missing\.length === 0 && adMissing\.length === 0/.test(src), 'the schedule also waits for yesterday\'s ad rows');
ok(/const text = gate \? await sendRedAlert/.test(src) && src.indexOf('const text = gate') > src.indexOf('.insert([{ html_body: html }])'), 'the red-alert text goes only with a scheduled card, after it is saved');
ok(!/sendCriticalAlert/.test(src), 'the old 7-day critical text is gone');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
