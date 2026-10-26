// node supabase/functions/morning-audit/email.test.mjs
// The morning audit email: yesterday per client, what it says, and that the model's card can't carry
// anything active into an inbox.
import { renderAuditEmail, emailSafeCard, sendViaResend } from './email.js';
import { computeDayRead } from './daily.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const Y = '2026-10-25';
const before = (n) => new Date(Date.parse(Y + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
const row = (date, spend, leads) => ({ date, spend, leads });
const hist = (perDay, leadsEvery) => Array.from({ length: 30 }, (_, i) => row(before(i + 1), perDay, i % leadsEvery === 0 ? 1 : 0));
const sig = (name, extra = {}) => ({ name, targetCpl: 45, verdict: 'STABLE', notes: [], flags: [], drivers: null, window: { recentFrom: before(6), recentTo: Y }, ...extra });
const signals = [
    sig('Deck <b>Co</b>', { verdict: 'WATCH', drivers: { dominant: 'ctr', cpm: 0.05, ctr: -0.4, cvr: 0.02 }, flags: ['CREATIVE'] }),
    sig('Fine Co'),
    sig('Quiet', { verdict: 'ADS_OFF', notes: ['Meta shows no spend since 2026-10-19'] }),
    sig('Small Red'),
];
const rowsFor = {
    'Deck <b>Co</b>': [...hist(60, 2), row(Y, 300, 2)],     // $150 CPL vs $45: red
    'Fine Co': [...hist(40, 1), row(Y, 80, 4)],             // $20: on target
    'Quiet': [],
    'Small Red': [row(Y, 50, 0)],                           // no leads on $50: red
};
const dayReads = signals.map((s) => computeDayRead(s, rowsFor[s.name]));
const adResult = { mode: 'day', flags: [{ action: 'TURN_OFF' }, { action: 'TURN_OFF' }, { action: 'LEARNING' }], checked: [], noTarget: [], stale: [] };
const card = `<p><i class="fa-solid fa-fire" style="color:var(--neg);"></i> <strong style="color:var(--neg);">Deck Co</strong> — CTR fell.</p>
<script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">x</a><iframe src="https://evil"></iframe><style>body{display:none}</style>
<p style="color:var(--unknown)">ads</p>`;
const m = renderAuditEmail({ html: card, dayReads, signals, adResult, dateLabel: 'Mon, Oct 26' });

ok(m.subject === 'Morning audit for Mon, Oct 26: 2 red alert, 2 ads to turn off', 'subject counts red alerts and ads to turn off (not still-learning ones): ' + m.subject);
ok(renderAuditEmail({ html: '', dayReads: [dayReads[1]], signals, dateLabel: 'Tue, Oct 27' }).subject === 'Morning audit for Tue, Oct 27: nothing red', 'a quiet morning says so');
ok(m.html.includes(`Yesterday (${Y})`), 'the day is stated');
ok(!/<script|onerror|javascript:|<iframe|<style>body/i.test(m.html), 'nothing active survives from the card');
ok(!/var\(--/.test(m.html) && m.html.includes('color:#b42318') && m.html.includes('color:#475467'), 'CSS variables become hex (unknown ones a neutral grey)');
ok(!/class="fa-/.test(m.html) && m.html.includes('&#9679;'), 'icon-font icons become a coloured dot');
ok(m.html.includes('Deck &lt;b&gt;Co&lt;/b&gt;') && !m.html.includes('Deck <b>Co</b>'), 'client names are escaped');
ok(['Fine Co', 'Quiet', 'Small Red'].every((n) => m.html.includes(n)), 'every client gets a row');
const order = ['Deck &lt;b&gt;Co', 'Small Red', 'Fine Co', 'Quiet'].map((n) => m.html.lastIndexOf(n));
ok(order.every((v, i) => i === 0 || v > order[i - 1]), 'red alert first (biggest spend first), then on target, then no spend');
ok(['>Yesterday<', '>7d CPL<', '>14d CPL<', '>30d CPL<', '>7-day trend<'].every((h) => m.html.includes(h)), 'the columns: yesterday, 7/14/30-day CPL, 7-day trend');
const deckRow = m.html.slice(m.html.lastIndexOf('Deck &lt;b&gt;Co'), m.html.indexOf('</tr>', m.html.lastIndexOf('Deck &lt;b&gt;Co')));
ok(deckRow.includes('Red alert') && deckRow.includes('$300') && deckRow.includes('$150') && deckRow.includes('$45 target'), 'yesterday\'s spend, CPL and target on the row');
ok(deckRow.includes('>$120<') && deckRow.includes('Watch · CTR (CPM +5%, CTR -40%, CVR +2%)') && deckRow.includes('CREATIVE flag'), 'the 7-day context, trend and flag on the row');
const quietRow = m.html.slice(m.html.lastIndexOf('Quiet'), m.html.indexOf('</tr>', m.html.lastIndexOf('Quiet')));
ok(quietRow.includes('No spend') && quietRow.includes('Meta shows no spend since 2026-10-19') && !quietRow.includes('$0'), 'no spend reads as a dash with its reason, never $0');
ok(m.html.includes('>none<'), 'spend with no leads reads as none');
ok(!m.html.includes('Ran at 10:00'), 'no deadline note on a normal run');
const late = renderAuditEmail({ html: '', dayReads, signals, missing: ['3Sixty <x>'], adMissing: ['Caliber'], deadline: true, dateLabel: 'Mon' });
ok(late.html.includes('Ran at 10:00 Mountain without yesterday') && late.html.includes('3Sixty &lt;x&gt;') && late.html.includes("yesterday's ad data for Caliber"), 'a deadline run names who was missing, pull and ad data, escaped');
ok(!renderAuditEmail({ html: '', dayReads, signals, missing: ['A'], deadline: false, dateLabel: 'Mon' }).html.includes('Ran at 10:00'), 'missing without a deadline run (the test email) adds no note');
ok(m.text.startsWith('Morning audit for Mon, Oct 26') && m.text.includes('Deck <b>Co</b> [Red alert] yesterday spend $300') && !/<p|<td/.test(m.text), 'a plain-text version');
ok(emailSafeCard('<a href = "javascript:x" >y</a>').includes('href="#"'), 'javascript links neutralised');

// Sending
const calls = [];
const fakeFetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization }); return { ok: true, json: async () => ({ id: 'e1' }) }; };
let r = await sendViaResend({ apiKey: 'k', to: 'info@midasmediafirm.com, bad-address ,', subject: 's', html: 'h', text: 't' }, fakeFetch);
ok(r.sent && r.id === 'e1' && calls[0].url === 'https://api.resend.com/emails' && calls[0].auth === 'Bearer k', 'sends through Resend with the key');
ok(JSON.stringify(calls[0].body.to) === '["info@midasmediafirm.com"]' && calls[0].body.from.includes('hello@mail.midasmediafirm.com') && calls[0].body.reply_to === 'video@midasmediafirm.com', 'only valid addresses, from the verified domain, replies to Tenny');
ok(!(await sendViaResend({ apiKey: '', to: 'a@b.co' }, fakeFetch)).sent && calls.length === 1, 'no key: nothing sent');
ok(!(await sendViaResend({ apiKey: 'k', to: '' }, fakeFetch)).sent && calls.length === 1, 'no recipients: nothing sent');
r = await sendViaResend({ apiKey: 'k', to: 'a@b.co' }, async () => ({ ok: false, status: 422, json: async () => ({ message: 'domain not verified' }) }));
ok(!r.sent && /422: domain not verified/.test(r.reason), 'a refusal is reported, not thrown');
r = await sendViaResend({ apiKey: 'k', to: 'a@b.co' }, async () => { throw new Error('offline'); });
ok(!r.sent && r.reason === 'offline', 'a network failure is reported, not thrown');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
