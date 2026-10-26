// Checks for the per-ad flags. Run: node supabase/functions/morning-audit/ads.test.mjs
import { computeAdFlags, renderAdFlagsHtml, adFlagsContext, adsManagerUrl, applyAdsOff, AD_ALERT_CONFIG } from './ads.js';
import { buildAuditContext } from './engine.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const FROM = '2026-10-05', TO = '2026-10-11';
const days = (a, b) => { const o = []; for (let d = Date.parse(a); d <= Date.parse(b); d += 86400000) o.push(new Date(d).toISOString().slice(0, 10)); return o; };
// rows for one ad across a date range: spend per day, leads spread as given per day list
const rows = (client, acct, id, name, from, to, spendPerDay, leadsByDay = {}, extra = {}) =>
    days(from, to).map((date) => ({ client_name: client, ad_account_id: acct, ad_id: id, ad_name: name, adset_name: 'Set A', campaign_name: 'Camp', date, spend: spendPerDay, leads: leadsByDay[date] || 0, ...extra }));
const sig = (name, target, pullLeads, coverage = 1) => ({ name, targetCpl: target, window: { recentFrom: FROM, recentTo: TO }, recent: { leads: pullLeads, coverage } });
const HIST = '2026-08-27';

// ---- Alpha: target 50, scale 1 (pull leads = Meta leads) ----
const alpha = [
    ...rows('Alpha', 'act1', '111', 'zero leads ad', '2026-09-01', TO, 12),                       // $84 week, 0 leads
    ...rows('Alpha', 'act1', '222', 'pricey ad', '2026-09-01', TO, 15, { '2026-10-07': 1 }),      // $105, 1 lead
    ...rows('Alpha', 'act1', '333', 'good ad', '2026-09-01', TO, 10, { '2026-10-06': 1, '2026-10-08': 1, '2026-10-10': 1 }), // $70, 3 leads
    ...rows('Alpha', 'act1', '444', 'young ad', '2026-10-09', TO, 80),                             // 3 days old, big spend
    ...rows('Alpha', 'act1', '555', 'stopped ad', '2026-09-01', '2026-10-08', 30),                // nothing the last 2 days
    ...rows('Alpha', 'act1', '666', 'small spend ad', '2026-09-01', TO, 5),                       // $35 < target
];
let r = computeAdFlags([sig('Alpha', 50, 4)], alpha, AD_ALERT_CONFIG, HIST);
const names = r.flags.map((f) => f.adName).sort();
ok(JSON.stringify(names) === JSON.stringify(['pricey ad', 'zero leads ad']), 'flags exactly the two bad ads: ' + names);
const zero = r.flags.find((f) => f.adId === '111'), pricey = r.flags.find((f) => f.adId === '222');
ok(zero.kind === 'NO_LEADS' && zero.estCpl === null, 'zero-lead ad is NO_LEADS');
ok(pricey.kind === 'OVER_TARGET' && Math.round(pricey.estCpl) === 105, 'pricey ad over target at $105');
ok(!r.flags.some((f) => f.adId === '333'), 'good ad (CPL $23) not flagged');
ok(!r.flags.some((f) => f.adId === '444'), 'ad under 4 days old skipped');
ok(!r.flags.some((f) => f.adId === '555'), 'ad with no spend in the last 2 days skipped');
ok(!r.flags.some((f) => f.adId === '666'), 'ad that spent less than the target skipped');
ok(pricey.url === 'https://www.facebook.com/adsmanager/manage/ads?act=1&selected_ad_ids=222', 'Ads Manager link');
ok(r.flags[0].spend >= r.flags[1].spend, 'sorted by spend');

// ---- an ad AT the bar counts (at target = flagged) and 1.5/2x moves the bar ----
ok(computeAdFlags([sig('Alpha', 50, 4)], alpha, { ...AD_ALERT_CONFIG, targetMultiple: 2 }, HIST).flags.map((f) => f.adId).join() === '222', 'at 2x only the $105 ad passes');
const exact = rows('Alpha', 'act1', '777', 'exactly at target', '2026-09-01', TO, 10, { '2026-10-06': 1 }); // $70, 1 lead -> CPL 70
ok(computeAdFlags([sig('Alpha', 70, 1)], exact, AD_ALERT_CONFIG, HIST).flags.length === 1, 'CPL equal to target is flagged at 1x');
ok(computeAdFlags([sig('Alpha', 71, 1)], exact, AD_ALERT_CONFIG, HIST).flags.length === 0, 'CPL just under target is not');

// ---- scaling to the daily pull ----
// Beta: Meta says 5 leads on a $100 ad, the pull says 2 for the account. Target 22.
const beta = rows('Beta', 'act2', '901', 'scaled ad', '2026-09-01', TO, 100 / 7, { '2026-10-06': 5 });
let rb = computeAdFlags([sig('Beta', 22, 2)], beta, AD_ALERT_CONFIG, HIST);
ok(rb.flags.length === 1 && Math.abs(rb.flags[0].estLeads - 2) < 0.01 && Math.round(rb.flags[0].estCpl) === 50, 'Meta leads scaled down to the pull: CPL about $50');
ok(computeAdFlags([sig('Beta', 22, 5)], beta, AD_ALERT_CONFIG, HIST).flags.length === 0, 'without a gap between Meta and the pull, $20 CPL is under a $22 target');
ok(computeAdFlags([sig('Beta', 22, 2, 0.5)], beta, AD_ALERT_CONFIG, HIST).flags.length === 0, 'pull covered under 80% of the window: no scaling');
// Meta 5 leads on $100, pull says 20: uncapped (x4) CPL $5, capped (x1.5) CPL about $13. Target $10 only flags if capped.
ok(computeAdFlags([sig('Beta', 10, 20)], beta, AD_ALERT_CONFIG, HIST).flags.length === 1, 'scale is capped at 1.5, so a huge pull total cannot erase a real overspend');
// a scaled-away ad is not hidden as NO_LEADS when Meta shows leads but the pull shows zero
ok(computeAdFlags([sig('Beta', 22, 0)], beta, AD_ALERT_CONFIG, HIST).flags[0]?.kind === 'NO_LEADS', 'pull shows zero leads: the ad is reported as no leads');

// ---- age is judged against the data we hold ----
const startsAtHistory = rows('Gamma', 'act3', '321', 'present from first day', '2026-10-09', TO, 60);
ok(computeAdFlags([sig('Gamma', 50, 0)], startsAtHistory, AD_ALERT_CONFIG, '2026-10-09').flags.length === 1, 'an ad present on the first day we hold data is treated as old');
ok(computeAdFlags([sig('Gamma', 50, 0)], startsAtHistory, AD_ALERT_CONFIG, HIST).flags.length === 0, 'the same rows are young when we hold earlier history');

// ---- skipped clients ----
const mix = computeAdFlags([sig('NoTarget', null, 3), sig('Alpha', 50, 4), sig('Empty', 50, 3), sig('Stale', 50, 3)], [
    ...alpha,
    ...rows('Stale', 'act9', '88', 'old data', '2026-09-01', '2026-10-06', 50),
], AD_ALERT_CONFIG, HIST);
ok(mix.noTarget.join() === 'NoTarget' && mix.noData.join() === 'Empty' && mix.stale.join() === 'Stale', 'noTarget / noData / stale reported separately');
ok(mix.checked.length === 1 && mix.checked[0].client === 'Alpha', 'only the client with a target and fresh data is checked');

// ---- rendering ----
const evil = rows('Alpha', 'act1', '999', '<img src=x onerror=alert(1)> "quoted" & co', '2026-09-01', TO, 20);
const html = renderAdFlagsHtml(computeAdFlags([sig('Alpha', 50, 4)], evil, AD_ALERT_CONFIG, HIST));
ok(!/<img/.test(html) && html.includes('&lt;img src=x onerror=alert(1)&gt;') && html.includes('&quot;quoted&quot;'), 'ad names are escaped');
ok(html.includes('Open in Ads Manager') && html.includes('target $50'), 'link and target shown');
const many = Array.from({ length: 9 }, (_, i) => rows('Alpha', 'act1', 'm' + i, 'ad ' + i, '2026-09-01', TO, 20 + i)).flat();
const htmlMany = renderAdFlagsHtml(computeAdFlags([sig('Alpha', 50, 0)], many, AD_ALERT_CONFIG, HIST));
ok((htmlMany.match(/<li style="margin/g) || []).length === AD_ALERT_CONFIG.maxPerClient && /and 3 more/.test(htmlMany), 'lists the first six and counts the rest');
const htmlScaled = renderAdFlagsHtml(rb);
ok(/Meta counted 250% of the leads your daily pull did/.test(htmlScaled), 'scaling is explained: ' + (htmlScaled.match(/Meta counted[^<]*/) || [''])[0]);
const quiet = renderAdFlagsHtml(computeAdFlags([sig('Alpha', 50, 3)], rows('Alpha', 'act1', '5', 'fine', '2026-09-01', TO, 8, { '2026-10-06': 1, '2026-10-08': 1, '2026-10-10': 1 }), AD_ALERT_CONFIG, HIST));
ok(/none across 1 client/.test(quiet), 'quiet morning says none');
ok(/No target CPL set, so ads weren't checked: NoTarget/.test(renderAdFlagsHtml(mix)), 'clients without a target are named');
ok(renderAdFlagsHtml({ flags: [], checked: [], noTarget: [], stale: [] }) === '', 'nothing to say renders nothing');

// ---- chat context ----
const ctx = adFlagsContext(r);
ok(/pricey ad/.test(ctx) && /zero leads ad/.test(ctx) && /no leads/.test(ctx), 'chat context lists the flagged ads');
ok(adFlagsContext({ flags: [], checked: [], noTarget: [] }) === '', 'chat context empty when nothing was checked');
ok(adsManagerUrl('act_123', '45') === 'https://www.facebook.com/adsmanager/manage/ads?act=123&selected_ad_ids=45' && adsManagerUrl(null, '1') === null, 'link builder strips act_ and refuses missing ids');


// ---- ads off versus a broken pull ----
const NOW = new Date('2026-10-13T16:00:00Z');
const stale = (name, verdict = 'DATA_STALE') => ({ name, verdict, notes: ['last row is 2026-10-06, 6 days behind the rest of the agency'], window: { recentFrom: FROM, recentTo: TO, baselineFrom: '2026-09-07', baselineTo: '2026-10-04' }, recent: { spend: 0, leads: 0, cpl: null }, baseline: { cpl: null, leads: 0 }, targetCpl: null, flags: [] });
const okSync = (client, extra = {}) => ({ client_name: client, last_run_at: '2026-10-13T15:30:00Z', last_error: null, last_window: '2026-10-05..2026-10-12', ...extra });
const spendRow = (client, date, spend = 20) => ({ client_name: client, date, spend, leads: 0, ad_id: '1' });

let sg = [stale('Off Co')];
let changed = applyAdsOff(sg, [spendRow('Off Co', '2026-09-29')], [okSync('Off Co')], NOW);
ok(changed.join() === 'Off Co' && sg[0].verdict === 'ADS_OFF', 'no spend since Sep 29, with a healthy sync: ADS_OFF');
ok(sg[0].adsOffSince === '2026-09-30' && /no spend since 2026-09-29/.test(sg[0].notes[0]), 'the note names the last day with spend');
sg = [stale('Gaps Co', 'DATA_GAPS')];
ok(applyAdsOff(sg, [spendRow('Gaps Co', '2026-09-20')], [okSync('Gaps Co')], NOW).length === 1 && sg[0].verdict === 'ADS_OFF', 'DATA_GAPS converts too');
sg = [stale('Never Co')];
applyAdsOff(sg, [], [okSync('Never Co')], NOW);
ok(sg[0].verdict === 'ADS_OFF' && /last 45 days/.test(sg[0].notes[0]) && sg[0].adsOffSince === null, 'no spend at all in the history: ADS_OFF, said as such');

sg = [stale('X')]; applyAdsOff(sg, [spendRow('X', '2026-09-29')], [okSync('X', { last_error: 'OAuthException 200: not granted' })], NOW);
ok(sg[0].verdict === 'DATA_STALE', 'meta-sync reported an error for the client: left as a data problem');
sg = [stale('X')]; applyAdsOff(sg, [spendRow('X', '2026-09-29')], [okSync('X', { last_run_at: '2026-10-10T15:30:00Z' })], NOW);
ok(sg[0].verdict === 'DATA_STALE', 'meta-sync has not run for 3 days: cannot vouch for Meta, left alone');
sg = [stale('X')]; applyAdsOff(sg, [spendRow('X', '2026-09-29')], [], NOW);
ok(sg[0].verdict === 'DATA_STALE', 'no sync record at all: left alone');
sg = [stale('X')]; applyAdsOff(sg, [spendRow('X', '2026-09-29')], [okSync('X', { last_window: '2026-09-20..2026-10-01' })], NOW);
ok(sg[0].verdict === 'DATA_STALE', 'sync window ends well before the audit window: left alone');
sg = [stale('X')]; applyAdsOff(sg, [spendRow('X', '2026-10-10')], [okSync('X')], NOW);
ok(sg[0].verdict === 'DATA_STALE', 'Meta shows spend a day ago: the ads are running, so it really is the pull');
sg = [stale('X')]; applyAdsOff(sg, [spendRow('X', '2026-10-08')], [okSync('X')], NOW);
ok(sg[0].verdict === 'ADS_OFF', 'exactly 3 days without spend counts as off');
sg = [stale('X')]; applyAdsOff(sg, [spendRow('X', '2026-10-09')], [okSync('X')], NOW);
ok(sg[0].verdict === 'DATA_STALE', 'only 2 days without spend does not');
sg = [stale('X')]; applyAdsOff(sg, [{ client_name: 'X', date: '2026-10-11', spend: 0, ad_id: '1' }, spendRow('X', '2026-09-29')], [okSync('X')], NOW);
ok(sg[0].verdict === 'ADS_OFF', 'a zero-spend row does not count as spend');
sg = [{ ...stale('Crit'), verdict: 'CRITICAL' }, { ...stale('Watch'), verdict: 'WATCH' }, { ...stale('Stable'), verdict: 'STABLE' }];
ok(applyAdsOff(sg, [], [okSync('Crit'), okSync('Watch'), okSync('Stable')], NOW).length === 0 && sg.map((x) => x.verdict).join() === 'CRITICAL,WATCH,STABLE', 'other verdicts are never touched');

// what the model is told
const md = buildAuditContext([{ ...stale('Off Co'), verdict: 'ADS_OFF', notes: ['Meta shows no spend since 2026-09-29'] }, stale('Broken Co')]);
ok(/## ADS OFF — Meta confirms no spend/.test(md) && /Off Co — Meta shows no spend since 2026-09-29/.test(md), 'the audit context has an ADS OFF section with the note');
ok(md.indexOf('## ADS OFF') < md.indexOf('## DATA STALE') && /Broken Co/.test(md), 'ADS OFF is listed before DATA STALE, which is still there for real problems');

// ---- Day mode (2026-10-23): judged on yesterday alone ----
const DAY = TO;
const bravo = [
    ...rows('Bravo', 'act2', 'b1', 'no leads yesterday', '2026-09-01', '2026-10-10', 10), ...rows('Bravo', 'act2', 'b1', 'no leads yesterday', DAY, DAY, 60),
    ...rows('Bravo', 'act2', 'b2', 'at target yesterday', '2026-09-01', '2026-10-10', 10, { '2026-10-06': 1 }), ...rows('Bravo', 'act2', 'b2', 'at target yesterday', DAY, DAY, 100, { [DAY]: 2 }),
    ...rows('Bravo', 'act2', 'b3', 'good yesterday', '2026-09-01', '2026-10-10', 10), ...rows('Bravo', 'act2', 'b3', 'good yesterday', DAY, DAY, 100, { [DAY]: 3 }),
    ...rows('Bravo', 'act2', 'b4', 'new <b>ad</b>', '2026-10-09', '2026-10-10', 20), ...rows('Bravo', 'act2', 'b4', 'new <b>ad</b>', DAY, DAY, 80),
    ...rows('Bravo', 'act2', 'b5', 'bad week, off yesterday', '2026-09-01', '2026-10-10', 50),
    ...rows('Bravo', 'act2', 'b6', 'small yesterday', '2026-09-01', '2026-10-10', 5), ...rows('Bravo', 'act2', 'b6', 'small yesterday', DAY, DAY, 40),
];
const dsig = (target, pull) => ({ ...sig('Bravo', target, pull), recent: { leads: pull, coverage: 1 } });
r = computeAdFlags([dsig(50, 6)], bravo, AD_ALERT_CONFIG, HIST, { day: DAY });
const byId = Object.fromEntries(r.flags.map((f) => [f.adId, f]));
ok(r.mode === 'day' && Object.keys(byId).sort().join() === 'b1,b2,b4', 'day mode flags exactly yesterday\'s bad ads: ' + Object.keys(byId));
ok(byId.b1.action === 'TURN_OFF' && byId.b1.kind === 'NO_LEADS' && byId.b1.spend === 60, 'no leads on $60 yesterday (target $50): TURN OFF');
ok(byId.b2.action === 'TURN_OFF' && byId.b2.estCpl === 50 && byId.b2.spend === 100, 'CPL exactly at target yesterday: TURN OFF');
ok(byId.b4.action === 'LEARNING', 'an ad under 4 days old is listed as still learning, not turned off');
ok(!byId.b5 && !byId.b6 && !byId.b3, 'not flagged: off yesterday (whatever its week), under one target of spend, or under target');
ok(byId.b2.week.spend === 160 && byId.b2.week.metaLeads === 3 && Math.round(byId.b2.week.estCpl) === 53, 'each flag carries its last 7 days as context');
ok(byId.b1.windowTo === DAY && byId.b1.targetKind === 'target', 'the flag names the day and the yardstick');
// The scale comes from the 7-day window: pull 3 leads against Meta's 6 = 0.5, so b3's 3 leads count as 1.5 ($67 CPL)
r = computeAdFlags([dsig(50, 3)], bravo, AD_ALERT_CONFIG, HIST, { day: DAY });
ok(r.flags.some((f) => f.adId === 'b3') && r.checked[0].scale === 0.5, 'Meta\'s leads scaled to the pull over 7 days: b3 is over target');
// No target: the client's own 30-day CPL from the day read
r = computeAdFlags([dsig(null, 6)], bravo, AD_ALERT_CONFIG, HIST, { day: DAY, yardstick: () => ({ value: 55 }) });
ok(r.flags.map((f) => f.adId).sort().join() === 'b1,b4' && r.flags[0].targetKind === 'usual' && r.flags[0].target === 55, 'no target: judged against the usual CPL ($55)');
r = computeAdFlags([dsig(null, 6)], bravo, AD_ALERT_CONFIG, HIST, { day: DAY, yardstick: () => ({ value: null }) });
ok(r.noTarget.join() === 'Bravo' && !r.flags.length, 'no target and no usual CPL: not checked');
ok(computeAdFlags([dsig(null, 6)], bravo, AD_ALERT_CONFIG, HIST, { day: DAY }).noTarget.join() === 'Bravo', 'no yardstick function: no target means not checked');
// Ad data that doesn't reach yesterday yet
r = computeAdFlags([dsig(50, 6)], bravo.filter((x) => x.date !== DAY), AD_ALERT_CONFIG, HIST, { day: DAY });
ok(r.stale.join() === 'Bravo' && !r.flags.length, 'no ad rows for yesterday: listed as not in yet, nothing judged on old days');
// Rendering
r = computeAdFlags([dsig(50, 6)], bravo, AD_ALERT_CONFIG, HIST, { day: DAY });
const dh = renderAdFlagsHtml(r);
ok(dh.includes('Ads to turn off') && dh.includes('2 ads across 1 client were at or over target yesterday'), 'titled Ads to turn off, counting only TURN OFF: ' + (dh.match(/Ads to turn off<\/strong> — [^<]*/) || [''])[0]);
ok(dh.includes('Over target but still learning') && dh.includes('Bravo: new &lt;b&gt;ad&lt;/b&gt;') && !dh.includes('<b>ad</b>'), 'learning ads listed apart, names escaped');
ok(dh.includes('yesterday $100 spent, 2 leads, CPL about $50') && dh.includes('last 7 days $160, 3 leads, CPL about $53'), 'yesterday then the 7-day context');
ok(dh.includes('target $50 · 2026-10-11'), 'the yardstick and day per client');
ok(renderAdFlagsHtml(computeAdFlags([dsig(50, 6)], bravo.filter((x) => x.date !== DAY), AD_ALERT_CONFIG, HIST, { day: DAY })).includes("Yesterday's ad data wasn't in yet for Bravo"), 'a client without yesterday\'s ad rows is named');
ok(renderAdFlagsHtml(computeAdFlags([dsig(50, 6)], bravo.filter((x) => x.ad_id === 'b3'), AD_ALERT_CONFIG, HIST, { day: DAY })).includes('none: no ad was at or over target yesterday'), 'a clean day says so');
const dc = adFlagsContext(r);
ok(dc.includes('ADS TO TURN OFF') && dc.includes('- TURN OFF: Bravo: "no leads yesterday"') && dc.includes('STILL LEARNING'), 'the chat context lists them by action');

console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
