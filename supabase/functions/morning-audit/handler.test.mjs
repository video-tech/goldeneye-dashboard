// The real morning-audit handler (index.ts), end to end, against a fake database, a fake model, and fake
// Make and Resend endpoints, at fixed Mountain times. Run (node 22.6+):
//   node --experimental-strip-types supabase/functions/morning-audit/handler.test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-handler-'));
const url = (p) => pathToFileURL(p).href;

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

// ---- a clock we control (Mountain is UTC-6 in October) ----
const RealDate = Date;
let NOW = RealDate.parse('2026-10-26T15:30:00Z'); // Monday 9:30 MDT
class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
}
globalThis.Date = FakeDate;
const iso = (offsetDays) => new RealDate(RealDate.parse('2026-10-26T12:00:00Z') + offsetDays * 86400000).toISOString().slice(0, 10);
const Y = iso(-1); // 2026-10-25

// ---- the fake database ----
const tables = {};
function reset({ adRowsYesterday = true } = {}) {
    tables.clients = [
        { name: 'Red Co', ad_account_id: 'act_111', business_id: 'b1', status: 'active', target_cpl: 45 },
        { name: 'Good Co', ad_account_id: '222', business_id: 'b2', status: 'active', target_cpl: 50 },
        { name: 'NoTarget Co', ad_account_id: '333', business_id: 'b3', status: 'active', target_cpl: null },
    ];
    const dr = [];
    for (let i = 1; i <= 40; i++) {
        dr.push({ date: iso(-1 - i), ad_account_id: '111', account_name: 'Red', spend: '100', Leads: '2', impressions: '5000', unique_link_clicks: '50', reach: '3000' });
        dr.push({ date: iso(-1 - i), ad_account_id: '222', account_name: 'Good', spend: '100', Leads: '4', impressions: '5000', unique_link_clicks: '50', reach: '3000' });
        dr.push({ date: iso(-1 - i), ad_account_id: '333', account_name: 'NoT', spend: '60', Leads: '1', impressions: '5000', unique_link_clicks: '50', reach: '3000' });
    }
    dr.push({ date: Y, ad_account_id: '111', account_name: 'Red', spend: '200', Leads: '2', impressions: '5000', unique_link_clicks: '50', reach: '3000' });  // $100 CPL vs $45: red
    dr.push({ date: Y, ad_account_id: '222', account_name: 'Good', spend: '100', Leads: '5', impressions: '5000', unique_link_clicks: '50', reach: '3000' }); // $20: on target
    dr.push({ date: Y, ad_account_id: '333', account_name: 'NoT', spend: '50', Leads: '0', impressions: '5000', unique_link_clicks: '50', reach: '3000' });  // $50 < $60 usual: too little
    tables.daily_reports = dr;
    tables.client_health = [];
    const ad = [];
    for (let i = 1; i <= 40; i++) {
        ad.push({ client_name: 'Red Co', ad_account_id: '111', date: iso(-1 - i), ad_id: '901', ad_name: 'Old <i>hook</i>', adset_name: 'Set', campaign_name: 'C', spend: 100, leads: 2 });
        ad.push({ client_name: 'Good Co', ad_account_id: '222', date: iso(-1 - i), ad_id: '902', ad_name: 'Good ad', adset_name: 'Set', campaign_name: 'C', spend: 100, leads: 4 });
    }
    if (adRowsYesterday) {
        ad.push({ client_name: 'Red Co', ad_account_id: '111', date: Y, ad_id: '901', ad_name: 'Old <i>hook</i>', adset_name: 'Set', campaign_name: 'C', spend: 200, leads: 2 });
        ad.push({ client_name: 'Good Co', ad_account_id: '222', date: Y, ad_id: '902', ad_name: 'Good ad', adset_name: 'Set', campaign_name: 'C', spend: 100, leads: 5 });
    }
    tables.meta_ad_daily = ad;
    const window = `${iso(-8)}..${iso(-1)}`;
    tables.meta_sync_state = [
        { client_name: 'Red Co', last_run_at: new RealDate(NOW - 3600e3).toISOString(), last_error: null, last_window: window },
        { client_name: 'Good Co', last_run_at: new RealDate(NOW - 3600e3).toISOString(), last_error: null, last_window: window },
    ];
    tables.morning_audits = [];
    tables.admin_alert_recipients = [{ name: 'Tenny', phone: '(801) 709-8501', active: true }];
    tables.user_profiles = [{ email: 'admin@midas.test', role: 'admin' }];
}
const db = {
    auth: { getUser: async (jwt) => ({ data: { user: jwt === ADMIN_JWT ? { email: 'admin@midas.test' } : null }, error: null }) },
    from(table) {
        let rows = null, filters = [], lo = 0, hi = Infinity, lim = Infinity, single = false, inserted = null;
        const api = {
            select() { return api; }, order() { return api; },
            eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return api; },
            gte(c, v) { filters.push((r) => String(r[c]) >= String(v)); return api; },
            range(a, b) { lo = a; hi = b; return api; },
            limit(n) { lim = n; return api; },
            maybeSingle() { single = true; return api; },
            insert(list) { inserted = list.map((x, i) => ({ id: tables[table].length + i + 1, created_at: new Date().toISOString(), ...x })); tables[table].push(...inserted); return api; },
            then(res, rej) {
                if (inserted) return Promise.resolve({ data: inserted, error: null }).then(res, rej);
                if (!tables[table]) return Promise.resolve({ data: null, error: { message: `no table ${table}` } }).then(res, rej);
                rows = tables[table].filter((r) => filters.every((f) => f(r))).slice(lo, hi + 1).slice(0, lim);
                return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(res, rej);
            },
        };
        return api;
    },
};

// ---- fake model, Make and Resend ----
const modelInputs = [], posts = [];
fs.writeFileSync(path.join(tmp, 'openai.mjs'), `export default class OpenAI { constructor() { this.responses = { create: async (req) => { globalThis.__modelInputs.push(req.input); return { status: 'completed', output_text: '<p>written by the model</p>', usage: {} }; } }; } }`);
fs.writeFileSync(path.join(tmp, 'supabase.mjs'), `export function createClient() { return globalThis.__db; }`);
globalThis.__modelInputs = modelInputs;
globalThis.__db = db;
globalThis.fetch = async (u, opts) => {
    posts.push({ url: String(u), body: JSON.parse(opts.body), headers: opts.headers });
    return { ok: true, status: 200, json: async () => ({ id: 'email-1' }) };
};
const ENV = { MAKE_WEBHOOK_SECRET: 'cron-secret', RESEND_API_KEY: 'resend-key', AUDIT_EMAIL_TO: 'info@midasmediafirm.com', OPENAI_API_KEY: 'x', SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x' };
let handler = null;
globalThis.Deno = { serve: (h) => { handler = h; }, env: { get: (k) => ENV[k] } };
const ADMIN_JWT = 'h.' + Buffer.from(JSON.stringify({ role: 'authenticated' })).toString('base64url') + '.s';

// ---- load the real index.ts with its imports pointed at the fakes and the real modules ----
let src = fs.readFileSync(path.join(here, 'index.ts'), 'utf8')
    .replace('"npm:openai"', JSON.stringify(url(path.join(tmp, 'openai.mjs'))))
    .replace('"npm:@supabase/supabase-js@2"', JSON.stringify(url(path.join(tmp, 'supabase.mjs'))))
    .replace('"../_shared/admin-auth.ts"', JSON.stringify(url(path.join(here, '../_shared/admin-auth.ts'))));
for (const m of ['engine.js', 'ads.js', 'daily.js', 'readiness.js', 'email.js']) src = src.replace(`"./${m}"`, JSON.stringify(url(path.join(here, m))));
fs.writeFileSync(path.join(tmp, 'index.ts'), src);
await import(url(path.join(tmp, 'index.ts')));
if (!handler) throw new Error('Deno.serve was never called');

const call = async (body, who = 'cron') => {
    const headers = { 'Content-Type': 'application/json', Origin: 'https://goldeneye.midasmediafirm.com' };
    if (who === 'cron') headers['x-cron-secret'] = 'cron-secret';
    if (who === 'admin') headers.Authorization = 'Bearer ' + ADMIN_JWT;
    const res = await handler(new Request('https://x/functions/v1/morning-audit', { method: 'POST', headers, body: JSON.stringify(body) }));
    return { status: res.status, json: await res.json() };
};
const textPosts = () => posts.filter((p) => p.url.includes('hook.us2.make.com'));
const emailPosts = () => posts.filter((p) => p.url.includes('api.resend.com'));

// 1. The schedule at 9:30 Mountain, everything in: runs, saves, texts and emails
reset(); posts.length = 0; modelInputs.length = 0;
let r = await call({});
ok(r.status === 200 && r.json.ran === 'ready' && r.json.day === Y, 'the schedule runs at 9:30 once the data is in: ' + JSON.stringify(r.json).slice(0, 200));
ok(r.json.yesterday.RED_ALERT === 1 && r.json.yesterday.ON_TARGET === 1 && r.json.yesterday.TOO_LITTLE === 1, 'yesterday: Red Co red, Good Co on target, NoTarget Co too little: ' + JSON.stringify(r.json.yesterday));
const input = modelInputs[0] || '';
ok(input.includes(`AUDIT DAY: ${Y}`) && input.indexOf('## RED ALERT') < input.indexOf('## ON TARGET') && input.includes('THE LAST 7 DAYS') && input.includes('[REPORTING WINDOW'), 'the model gets the day read first, then the 7-day trend');
ok(!input.includes('hook') && !input.includes('Good ad'), 'the model never sees an ad name');
const saved = tables.morning_audits[0]?.html_body || '';
ok(saved.startsWith('<p>written by the model</p>') && saved.includes('Ads to turn off') && saved.includes('Old &lt;i&gt;hook&lt;/i&gt;') && !saved.includes('Good ad'), 'the card is the model\'s text plus the code-built ads to turn off');
ok(r.json.ads_to_turn_off === 1, 'one ad to turn off');
ok(textPosts().length === 1, 'one text');
const t = textPosts()[0]?.body || {};
ok(t.secret === 'cron-secret' && t.event === 'morning_audit_critical' && t.recipients[0].phone === '+18017098501', 'the text goes through scenario #6 with the secret and the recipient');
ok(t.message.includes(`Morning audit, ${Y}: 1 red alert: Red Co: $100 CPL vs $45 target on $200`) && t.message.includes('1 ad to turn off') && !t.message.includes('\n'), 'the text says who and why, on one line: ' + t.message);
ok(t.clients.length === 1 && t.clients[0].reason === 'cpl' && !t.message.includes('Good Co'), 'only red-alert clients are in the text');
ok(emailPosts().length === 1 && /1 red alert, 1 ad to turn off$/.test(emailPosts()[0].body.subject) && emailPosts()[0].body.to[0] === 'info@midasmediafirm.com', 'the email: ' + emailPosts()[0]?.body.subject);

// 2. A second scheduled call the same morning: nothing new
posts.length = 0;
r = await call({});
ok(r.json.skipped && tables.morning_audits.length === 1 && !posts.length, 'the next 15-minute call is a no-op');

// 3. Ad rows for yesterday not in yet at 9:30: waits, naming who
reset({ adRowsYesterday: false }); posts.length = 0;
r = await call({});
ok(r.json.waiting && JSON.stringify(r.json.ad_data_missing) === '["Good Co","Red Co"]' && !tables.morning_audits.length, 'waits for yesterday\'s ad rows: ' + JSON.stringify(r.json));
// ...and runs at 10:00 regardless, saying so
NOW = RealDate.parse('2026-10-26T16:00:00Z');
r = await call({});
ok(r.json.ran === 'deadline' && JSON.stringify(r.json.ad_data_missing) === '["Good Co","Red Co"]', 'runs at the 10:00 deadline');
ok(tables.morning_audits[0].html_body.includes("Yesterday's ad data wasn't in yet for Red Co, Good Co") || tables.morning_audits[0].html_body.includes("Yesterday's ad data wasn't in yet for Good Co, Red Co"), 'the card says whose ads weren\'t checked');
ok(emailPosts()[0]?.body.html.includes("yesterday's ad data for Good Co, Red Co"), 'and so does the email');
ok(textPosts().length === 1 && !/ad.? to turn off/.test(textPosts()[0].body.message), 'the red alert still texts, with no ad count');
NOW = RealDate.parse('2026-10-26T15:30:00Z');

// 4. The dashboard button: a new card, no text, no email
posts.length = 0;
r = await call({ force: true }, 'admin');
ok(r.status === 200 && tables.morning_audits.length === 2 && !textPosts().length && !emailPosts().length, 'Run audit makes a card without texting or emailing');

// 5. The chat's context: the day read and the ads, no model call
modelInputs.length = 0;
r = await call({ mode: 'context' }, 'admin');
ok(r.json.context.includes("Not checked, yesterday's ad data not in yet: Good Co, Red Co") || r.json.context.includes("Not checked, yesterday's ad data not in yet: Red Co, Good Co"), 'context names clients whose ad data is not in yet');
reset();
r = await call({ mode: 'context' }, 'admin');
ok(r.json.context.includes('## RED ALERT') && r.json.context.includes('- TURN OFF: Red Co: "Old <i>hook</i>"') && r.json.context.includes('[REPORTING WINDOW') && Array.isArray(r.json.dayReads) && !modelInputs.length, 'context mode returns the day read, the trend and the ads');

// 6. The email test: re-sends today's card, no text
posts.length = 0; reset(); tables.morning_audits.push({ id: 9, created_at: new Date().toISOString(), html_body: '<p>saved card</p>' });
r = await call({ mode: 'email_test' });
ok(r.json.email?.sent && emailPosts().length === 1 && !textPosts().length && emailPosts()[0].body.html.includes('saved card'), 'email_test sends today\'s card and nothing else');

// 7. The cron secret can't force or read the matrix; nobody else gets in
ok((await call({ force: true })).status === 403 && (await call({ mode: 'context' })).status === 403, 'the cron secret cannot force or read context');
ok((await call({}, 'nobody')).status === 403, 'no secret, no sign-in: refused');

// 8. Before 9:00 Mountain the schedule waits even with everything in
reset(); NOW = RealDate.parse('2026-10-26T14:45:00Z');
r = await call({});
ok(r.json.waiting && !tables.morning_audits.length, 'before 9:00: waits');

globalThis.Date = RealDate;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
