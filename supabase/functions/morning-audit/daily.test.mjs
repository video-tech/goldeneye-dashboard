// node supabase/functions/morning-audit/daily.test.mjs
// The day read: yesterday's verdict per client, against the target or their own 30-day CPL.
import { computeDayRead, buildDayContext, redAlertLine, sortDayReads, dayHeadline } from './daily.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const Y = '2026-10-25';
const dayBefore = (n) => new Date(Date.parse(Y + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
const sig = (extra = {}) => ({ name: 'Acme', targetCpl: 45, verdict: 'STABLE', notes: [], window: { recentFrom: dayBefore(6), recentTo: Y }, ...extra });
const row = (date, spend, leads) => ({ date, spend: String(spend), leads: String(leads) });
// 30 days of history at $60 a day and 1 lead a day: own 30-day CPL $60
const history = Array.from({ length: 30 }, (_, i) => row(dayBefore(i + 1), 60, 1));

// The edges, with a $45 target
let r = computeDayRead(sig(), [row(Y, 90, 2)]);
ok(r.verdict === 'RED_ALERT' && r.reason === 'cpl' && r.cpl === 45, 'CPL exactly at target is red: ' + r.verdict);
r = computeDayRead(sig(), [row(Y, 89.98, 2)]);
ok(r.verdict === 'ON_TARGET', 'one cent under target is on target');
r = computeDayRead(sig(), [row(Y, 45, 0)]);
ok(r.verdict === 'RED_ALERT' && r.reason === 'no_leads', 'no leads on exactly one target of spend is red');
r = computeDayRead(sig(), [row(Y, 44.99, 0)]);
ok(r.verdict === 'TOO_LITTLE', 'no leads under one target of spend is too little to judge');
r = computeDayRead(sig(), [row(Y, 40, 1), row(Y, 60, 1)]);
ok(r.spend === 100 && r.leads === 2 && r.verdict === 'RED_ALERT', 'two rows on the same day are added together');
ok(r.yardstick === 45 && r.yardstickKind === 'target' && r.day === Y, 'the target is the yardstick when set');

// No target: own 30-day CPL
r = computeDayRead(sig({ targetCpl: null }), [...history, row(Y, 120, 2)]);
ok(r.yardstick === 60 && r.yardstickKind === 'usual' && r.verdict === 'RED_ALERT', 'no target: judged against own 30-day CPL ($60), $60 yesterday is red');
r = computeDayRead(sig({ targetCpl: null }), [...history, row(Y, 118, 2)]);
ok(r.verdict === 'ON_TARGET', 'no target: under own 30-day CPL is on target');
r = computeDayRead(sig({ targetCpl: null }), [row(dayBefore(3), 200, 0), row(Y, 80, 1)]);
ok(r.verdict === 'NO_YARDSTICK' && r.yardstick === null, 'no target and no 30-day leads: no yardstick, never red by guesswork');

// Context windows exclude yesterday and stop at their edge
r = computeDayRead(sig(), [...history, row(dayBefore(31), 1000, 0), row(Y, 500, 0)]);
ok(r.context[30].spend === 1800 && r.context[30].leads === 30, '30 days before yesterday: 30 x $60, the 31st day and yesterday left out: ' + r.context[30].spend);
ok(r.context[7].spend === 420 && r.context[7].perDay === 60 && r.context[7].cpl === 60, '7-day context: $420, $60/day, $60 CPL');
ok(r.context[14].spend === 840, '14-day context');
r = computeDayRead(sig(), [row(dayBefore(7), 70, 1), row(dayBefore(8), 80, 1)]);
ok(r.context[7].spend === 70 && r.context[14].spend === 150, 'the 7th day before is in the 7-day window, the 8th is not');

// A bad week stays red on a day that spent; not on a day that didn't
r = computeDayRead(sig({ verdict: 'CRITICAL' }), [row(Y, 40, 2)]);
ok(r.verdict === 'RED_ALERT' && r.reason === 'week' && r.notes.some((n) => /last 7 days are still critical/.test(n)), 'a 7-day CRITICAL stays red on an on-target day');
r = computeDayRead(sig({ verdict: 'CRITICAL' }), [row(Y, 10, 0)]);
ok(r.verdict === 'RED_ALERT' && r.reason === 'week', 'and on a too-little day');
r = computeDayRead(sig({ verdict: 'CRITICAL' }), []);
ok(r.verdict === 'NO_SPEND', 'but not on a day with no spend (the ads may already be off)');
r = computeDayRead(sig({ verdict: 'WATCH' }), [row(Y, 40, 2)]);
ok(r.verdict === 'ON_TARGET', 'a 7-day WATCH does not make a good day red');

// No spend, and why
r = computeDayRead(sig({ verdict: 'ADS_OFF', notes: ['Meta shows no spend since 2026-10-19'] }), []);
ok(r.verdict === 'NO_SPEND' && r.notes[0] === 'Meta shows no spend since 2026-10-19', 'ads off: the reason is Meta\'s');
r = computeDayRead(sig({ verdict: 'DATA_STALE' }), []);
ok(/daily pull/.test(r.notes[0]), 'stale data says to check the pull');
r = computeDayRead(sig(), [row(dayBefore(1), 50, 1)]);
ok(r.verdict === 'NO_SPEND' && r.notes[0] === `no row in the daily pull for ${Y}` && !r.hasRow, 'no row for yesterday is named as such');
r = computeDayRead(sig(), [row(Y, 0, 0)]);
ok(r.verdict === 'NO_SPEND' && r.hasRow && r.notes[0] === 'a row with no spend', 'a zero-spend row');
let threw = false; try { computeDayRead({ name: 'X', window: {} }, []); } catch { threw = true; }
ok(threw, 'no audit day is an error, not a silent read');

// The context the model writes from
const reads = [
    computeDayRead(sig({ name: 'Small Red' }), [row(Y, 60, 1)]),
    computeDayRead(sig({ name: 'Big Red', drivers: { dominant: 'cvr', dominantWorsened: true, cpm: 0, ctr: 0, cvr: -0.3 }, flags: ['CREATIVE'] }), [...history, row(Y, 300, 2)]),
    computeDayRead(sig({ name: 'Fine' }), [row(Y, 80, 4)]),
    computeDayRead(sig({ name: 'Off', verdict: 'ADS_OFF', notes: ['Meta shows no spend since 2026-10-19'] }), []),
];
const signals = reads.map((x, i) => ({ name: x.name, verdict: i === 1 ? 'WATCH' : 'STABLE', drivers: i === 1 ? { dominant: 'cvr', dominantWorsened: true } : null, flags: i === 1 ? ['CREATIVE'] : [] }));
const md = buildDayContext(reads, signals, { cvr: { worse: 'landing page or form', better: 'b' } });
const order = ['## RED ALERT', 'Big Red |', 'Small Red |', '## ON TARGET', 'Fine |', '## NO SPEND', 'Off —'].map((t) => md.indexOf(t));
ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), 'red alert first, biggest spend first, then on target, then no spend');
ok(/^## RED ALERT — /m.test(md) && /^## ON TARGET — /m.test(md), 'headers the dashboard card can parse');
const bigLine = md.split('\n').find((l) => l.startsWith('Big Red |'));
ok(bigLine.endsWith('$150 CPL yesterday vs $45 target'), 'the last field says why, for the Intelligence card: ' + bigLine.split(' | ').pop());
ok(bigLine.includes('7d $60 CPL ($60/day, 7 leads)') && bigLine.includes('30d $60 CPL') && bigLine.includes('own 30-day CPL $60'), '7/14/30 context on the line');
ok(bigLine.includes('7-day trend WATCH, driver CVR (landing page or form)') && bigLine.includes('creative flag'), 'the 7-day trend and driver ride along');
ok(md.includes(`AUDIT DAY: ${Y}`), 'the day is stated');

// The text line
ok(redAlertLine(reads[1]) === 'Big Red: $150 CPL vs $45 target on $300', 'text line for a CPL red: ' + redAlertLine(reads[1]));
ok(redAlertLine(computeDayRead(sig(), [row(Y, 50, 0)])) === 'Acme: no leads on $50 (target $45)', 'text line for no leads');
ok(redAlertLine(computeDayRead(sig({ verdict: 'CRITICAL' }), [row(Y, 40, 2)])) === 'Acme: last 7 days critical', 'text line for a bad week');
ok(!reads.map(redAlertLine).join('').includes('\n'), 'never a newline (Make\'s raw-text body)');
ok(sortDayReads(reads).map((x) => x.name).join() === 'Big Red,Small Red,Fine,Off', 'sort order');
ok(dayHeadline(reads[2]) === '$80 spent, 4 leads, $20 CPL vs $45 target', 'headline: ' + dayHeadline(reads[2]));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
