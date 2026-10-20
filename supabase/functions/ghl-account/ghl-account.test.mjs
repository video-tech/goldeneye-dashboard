// Checks for ghl-account and the write gate (_shared/ghl-write.ts). Run (node 22.6+):
//   node --experimental-strip-types supabase/functions/ghl-account/ghl-account.test.mjs
// Runs the real handler against a fake GHL agency and an in-memory database that understands the queries it makes.
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(path.join(here, p)).href);
const { handle, mapAnswers, accountBody, planFill, e164, timezoneFor, MAX_PER_SWEEP, randomPassword } = await imp('handler.ts');
const { encrypt } = await imp('../_shared/ghl-oauth.ts');
const { writeAllowed, ghlWrite } = await imp('../_shared/ghl-write.ts');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const COMPANY = 'aO4gguGsn5P1gl647qjV', MASTER = 'sXL42Tk6BFlMz8GEe5LQ', SNAP = 'XySR40RNsweVul9Gxtlp';
const COMPANY_TOKEN = 'company-token-secret-111', CRON = 'cron-secret';
const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 1)).toString('base64');
const env = (over = {}) => ({ GHL_APP_CLIENT_ID: 'appid123-x', GHL_APP_CLIENT_SECRET: 'appsecret', GHL_TOKEN_KEY: KEY, GHL_COMPANY_ID: COMPANY,
    GHL_MASTER_LOCATION_ID: MASTER, GHL_SNAPSHOT_ID: SNAP, GHL_AUTO_CREATE: 'on', GHL_APP_INSTALL_URL: 'https://marketplace.example/install', MAKE_WEBHOOK_SECRET: CRON, ...over });

// ---- an in-memory database with just enough of supabase-js ----
function fakeDb(tables, { unique = { ghl_accounts: ['client_name'] }, failInsert = {} } = {}) {
    const rows = (t) => (tables[t] ??= []);
    class Q {
        constructor(t) { this.t = t; this.f = []; this.op = 'select'; }
        select() { if (this.op === 'select') this.op = 'select'; this.ret = true; return this; }
        insert(r) { this.op = 'insert'; this.payload = Array.isArray(r) ? r : [r]; return this; }
        update(r) { this.op = 'update'; this.payload = r; return this; }
        delete() { this.op = 'delete'; return this; }
        eq(c, v) { this.f.push((r) => r[c] === v); return this; }
        is(c, v) { this.f.push((r) => (r[c] ?? null) === v); return this; }
        in(c, vs) { this.f.push((r) => vs.includes(r[c])); return this; }
        limit() { return this; }
        maybeSingle() { this.one = 'maybe'; return this; }
        single() { this.one = 'single'; return this; }
        run() {
            const match = (r) => this.f.every((fn) => fn(r));
            let out;
            if (this.op === 'select') out = rows(this.t).filter(match).map((r) => ({ ...r }));
            if (this.op === 'insert') {
                if (failInsert[this.t]) return { data: null, error: { message: failInsert[this.t] } };
                for (const r of this.payload) {
                    for (const col of unique[this.t] ?? []) if (rows(this.t).some((x) => x[col] === r[col])) return { data: null, error: { message: 'duplicate key value violates unique constraint (23505)' } };
                }
                out = this.payload.map((r) => { const row = { id: rows(this.t).length + 1, ...r }; rows(this.t).push(row); return { ...row }; });
            }
            if (this.op === 'update') { out = rows(this.t).filter(match); out.forEach((r) => Object.assign(r, this.payload)); out = out.map((r) => ({ ...r })); }
            if (this.op === 'delete') { out = rows(this.t).filter(match); tables[this.t] = rows(this.t).filter((r) => !match(r)); }
            if (this.one === 'maybe') return { data: out[0] ?? null, error: null };
            if (this.one === 'single') return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: 'not one row' } };
            return { data: out, error: null };
        }
        then(res, rej) { try { res(this.run()); } catch (e) { rej(e); } }
    }
    return {
        tables,
        from: (t) => new Q(t),
        auth: { getUser: async (jwt) => (jwt === 'admin-jwt' ? { data: { user: { email: 'tenny@midasmediafirm.com' } }, error: null } : { data: null, error: { message: 'bad' } }) },
    };
}

// ---- a fake GHL agency ----
function fakeGhl({ installed = [], createFails = false, putFails = [] } = {}) {
    const store = { locations: [], seq: 1, installed: new Set(installed) };
    const calls = [];
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
    const f = async (url, init) => {
        const u = new URL(url);
        const b = init.body && init.headers['Content-Type'] === 'application/json' ? JSON.parse(init.body) : null;
        calls.push({ method: init.method, path: u.pathname, search: u.search, body: b, auth: init.headers.Authorization });
        const auth = init.headers.Authorization;
        if (u.pathname === '/locations/' && init.method === 'POST') {
            if (auth !== 'Bearer ' + COMPANY_TOKEN) return json({ message: 'agency only' }, 401);
            if (createFails) return json({ message: 'snapshot not found for ' + COMPANY_TOKEN }, 422);
            const id = 'NewLoc' + String(store.seq++).padStart(14, '0');
            store.locations.push({ id, body: b, values: [
                { id: 'cvName00001', name: 'Business Name', fieldKey: '{{ custom_values.business_name }}', value: '' },
                { id: 'cvOwner0001', name: 'Owner Name', fieldKey: '{{ custom_values.owner_name }}', value: '' },
                { id: 'cvPhone0001', name: 'Business Phone', fieldKey: '{{ custom_values.business_phone }}', value: '' },
                { id: 'cvAddr00001', name: 'Physical Address', fieldKey: '{{ custom_values.physical_address }}', value: '' },
                { id: 'cvSvc000001', name: 'Services List', fieldKey: '{{ custom_values.services_list }}', value: '' },
                { id: 'cvText00001', name: 'Text Window', fieldKey: '{{ custom_values.text_window }}', value: '' },
                { id: 'cvFb0000001', name: 'Facebook Page URL', fieldKey: '{{ custom_values.facebook_page_url }}', value: '' },
            ] });
            return json({ id, name: b.name });
        }
        if (u.pathname === '/oauth/installedLocations') {
            return json({ locations: [...store.installed].map((id) => ({ _id: id, name: 'x' })), count: store.installed.size });
        }
        if (u.pathname === '/oauth/locationToken') {
            const loc = new URLSearchParams(init.body).get('locationId');
            if (!store.installed.has(loc)) return json({ message: 'accessToken does not have access to following location' }, 400);
            return json({ access_token: 'loc-token-' + loc });
        }
        const m = u.pathname.match(/^\/locations\/([^/]+)\/customValues(?:\/([^/]+))?$/);
        if (m) {
            const loc = store.locations.find((l) => l.id === m[1]);
            if (auth !== 'Bearer loc-token-' + m[1] || !loc) return json({ message: 'no' }, 401);
            if (init.method === 'GET') return json({ customValues: loc.values });
            if (init.method === 'PUT') {
                if (putFails.includes(m[2])) return json({ message: 'nope' }, 500);
                const v = loc.values.find((x) => x.id === m[2]); v.value = b.value; return json({ customValue: v });
            }
        }
        if (u.pathname === '/users/' && init.method === 'POST') {
            if (auth !== 'Bearer ' + COMPANY_TOKEN) return json({ message: 'agency only' }, 401);
            if ((store.refuseEmails ?? []).includes(b.email)) return json({ message: 'The email address is already taken' }, 400);
            const id = 'User' + String(store.seq++).padStart(16, '0');
            (store.users ??= []).push({ id, ...b });
            return json({ id, name: b.firstName });
        }
        return json({ message: 'unknown ' + init.method + ' ' + u.pathname }, 404);
    };
    return { f, calls, store };
}

const STEPS = [
    { id: 'step-about', title: 'About your business', step_type: 'questions', questions: [
        { id: 'a_name', dest: 'ghl:name; custom_value:business_name' }, { id: 'a_phone', dest: 'ghl:phone; custom_value:business_phone' },
        { id: 'a_email', dest: 'ghl:email; custom_value:business_email' }, { id: 'a_street', dest: 'ghl:address; custom_value:physical_address' },
        { id: 'a_city', dest: 'ghl:city' }, { id: 'a_state', dest: 'ghl:state' }, { id: 'a_zip', dest: 'ghl:postalCode' },
        { id: 'a_services', dest: 'custom_value:services_list' }, { id: 'a_owner', dest: 'custom_value:owner_name' },
        { id: 'a_mobile', private: true, dest: 'admin:owner_mobile' } ] },
    { id: 'step-text', title: 'Texting and your service area', step_type: 'questions', questions: [
        { id: 'c_text_ok', dest: 'custom_value:text_window' }, { id: 'c_text_hours', dest: 'custom_value:text_window' } ] },
    { id: 'step-quick', title: 'Quick start', step_type: 'questions', questions: [ { id: 'q_fb_url', dest: 'custom_value:facebook_url' } ] },
];
const a = (v) => ({ label: 'x', value: v });
const ANSWERS = (client) => [
    { client_name: client, step_id: 'step-about', answers: { a_name: a('Acme Decks'), a_phone: a('(801) 555-0100'), a_email: a('owner@acme.com'), a_street: a('1 Main St'),
        a_city: a('Lehi'), a_state: a('UT'), a_zip: a('84043'), a_services: a(['Decks', 'Pergolas']), a_owner: a('Pat Smith'), a_mobile: a('801-555-9999') } },
    { client_name: client, step_id: 'step-text', answers: { c_text_ok: a('Yes') } },
    { client_name: client, step_id: 'step-quick', answers: { q_fb_url: a('https://facebook.com/acme') } },
];
async function world({ clients, handoffs = [], answers = [], accounts = [], ghl = {}, envOver = {}, dbOpts = {} } = {}) {
    const tables = {
        clients: clients ?? [{ name: 'Acme Decks', status: 'active', current_stage: 'Onboarding', ghl_location_id: null }],
        tasks: (handoffs.length ? handoffs : ['Acme Decks']).map((c) => ({ client: c, title: 'Onboarding complete — ready for campaign build' })),
        onboarding_steps: STEPS.map((s) => ({ ...s })),
        onboarding_answers: answers.length ? answers : ANSWERS('Acme Decks'),
        ghl_accounts: accounts,
        ghl_write_log: [],
        user_profiles: [{ email: 'tenny@midasmediafirm.com', role: 'admin' }],
        ghl_oauth_tokens: [{ company_id: COMPANY, access_token_enc: await encrypt({ GHL_TOKEN_KEY: KEY }, COMPANY_TOKEN), refresh_token_enc: 'x.y', expires_at: '2099-01-01T00:00:00Z' }],
    };
    const db = fakeDb(tables, dbOpts);
    const g = fakeGhl(ghl);
    const deps = { env: env(envOver), db, fetch: g.f, now: () => new Date('2026-10-16T20:00:00Z') };
    const call = async (body, as = 'cron') => {
        const headers = { 'Content-Type': 'application/json' };
        if (as === 'cron') headers['x-cron-secret'] = CRON; else if (as === 'admin') headers.Authorization = 'Bearer admin-jwt'; else headers.Authorization = 'Bearer ' + as;
        const res = await handle(new Request('https://x/ghl-account', { method: 'POST', headers, body: JSON.stringify(body) }), deps);
        return { status: res.status, body: await res.json() };
    };
    return { db, g, call, tables };
}

// ---- pure parts ----
ok(e164('(801) 555-0100') === '+18015550100' && e164('1-801-555-0100') === '+18015550100' && e164('555') === '', 'phone numbers are put in +1 format');
ok(timezoneFor('UT') === 'America/Denver' && timezoneFor('texas') === 'America/Chicago' && timezoneFor('FL') === 'America/New_York' && timezoneFor('') === 'America/Denver', 'time zone from the state');
{
    const { ghl, cv } = mapAnswers(STEPS, ANSWERS('Acme Decks'));
    ok(ghl.name === 'Acme Decks' && ghl.city === 'Lehi' && cv.business_name === 'Acme Decks' && cv.services_list === 'Decks, Pergolas', 'answers map to GHL fields and custom values; lists are joined');
    ok(cv.text_window === '8am to 8pm, every day', '"Yes" to the texting window becomes the standard window');
    ok(!Object.values({ ...ghl, ...cv }).includes('801-555-9999'), 'private answers never go to GHL');
    const priv = mapAnswers([{ id: 's', questions: [{ id: 'p1', private: true, dest: 'custom_value:awards' }, { id: 'p2', secret: true, dest: 'ghl:website' }] }],
        [{ step_id: 's', answers: { p1: a('PRIVATE'), p2: a('hunter2') } }]);
    ok(!priv.cv.awards && !priv.ghl.website, 'a private or encrypted question never goes to GHL, even with a GHL destination');
    const other = mapAnswers(STEPS, [{ step_id: 'step-text', answers: { c_text_ok: a('No (I would like different hours)'), c_text_hours: a('9 to 5 weekdays') } }]);
    ok(other.cv.text_window === '9 to 5 weekdays', 'a different texting window comes from the follow-up question');
    const body = accountBody('Acme Decks', ghl, cv, COMPANY, SNAP);
    ok(body.name === 'Acme Decks' && body.phone === '+18015550100' && body.timezone === 'America/Denver' && body.snapshotId === SNAP && body.companyId === COMPANY && body.prospectInfo?.firstName === 'Pat', 'the account body is their business');
    const plan = planFill([{ id: 'p1', name: 'Physical Address', fieldKey: '{{ custom_values.physical_address }}', value: '' },
        { id: 'f1', name: 'Facebook Page URL', fieldKey: '{{ custom_values.facebook_page_url }}', value: 'https://facebook.com/acme' }],
        { physical_address: '1 Main St', facebook_url: 'https://facebook.com/acme', awards: 'BBB' });
    ok(plan.writes.length === 1 && plan.writes[0].id === 'p1' && plan.unchanged.join() === 'facebook_url' && plan.missing.join() === 'awards',
        "Master's own names count (facebook_url fills facebook_page_url); an equal value isn't rewritten; a missing value is reported");
}

// ---- the write gate ----
ok(writeAllowed('POST', '/locations/') && writeAllowed('PUT', '/locations/NewLoc00000000000001/customValues/cvName00001'), 'creating an account and filling a value are allowed');
ok(!writeAllowed('DELETE', '/locations/NewLoc00000000000001') && !writeAllowed('POST', '/contacts/') && !writeAllowed('PUT', '/locations/NewLoc00000000000001')
    && !writeAllowed('POST', '/workflows/') && !writeAllowed('PUT', '/locations/NewLoc00000000000001/customFields/abc12'), 'anything else is refused: deletes, contacts, workflows, account edits, custom fields');
{
    const { db, g } = await world();
    let err = '';
    try { await ghlWrite({ db, fetch: g.f }, 'DELETE', '/locations/NewLoc00000000000001', 't', undefined, { by: 'x', client: null, location: null, summary: 's' }); } catch (e) { err = e.message; }
    ok(/allow-list/.test(err) && !g.calls.length && !db.tables.ghl_write_log.length, 'a refused write never reaches GHL');
}
{
    const { db, g } = await world({ dbOpts: { failInsert: { ghl_write_log: 'relation does not exist' } } });
    let err = '';
    try { await ghlWrite({ db, fetch: g.f }, 'POST', '/locations/', COMPANY_TOKEN, { name: 'x' }, { by: 'x', client: null, location: null, summary: 's' }); } catch (e) { err = e.message; }
    ok(/couldn't be logged/.test(err) && !g.calls.length, 'a write that cannot be logged is never sent');
}

// ---- the sweep ----
{
    const w = await world();
    const r = await w.call({ mode: 'sweep' });
    const loc = w.g.store.locations[0];
    ok(r.status === 200 && r.body.created.length === 1 && r.body.created[0].created === true, 'the sweep creates the account: ' + JSON.stringify(r.body.created));
    ok(loc && loc.body.snapshotId === SNAP && loc.body.name === 'Acme Decks' && loc.body.phone === '+18015550100' && loc.body.city === 'Lehi', 'from MasterV.1, with their real business details');
    ok(w.tables.clients[0].ghl_location_id === loc.id, 'the location ID is saved on the client (the checklist step ticks itself)');
    ok(w.tables.ghl_accounts[0].status === 'awaiting_install' && w.tables.ghl_accounts[0].created_by === 'schedule', 'the account waits for the install click');
    ok(w.tables.ghl_write_log.length === 1 && w.tables.ghl_write_log[0].ok === true && w.tables.ghl_write_log[0].path === '/locations/', 'the creation is in the write log');
    ok(!JSON.stringify(w.tables.ghl_write_log).includes(COMPANY_TOKEN), 'the log never holds a token');
    ok(r.body.waiting_for_install.join() === 'Acme Decks' && r.body.install_url, 'the report says it waits for the install, with the install link');

    // Not installed yet: nothing filled, nothing new created
    const r2 = await w.call({ mode: 'sweep' });
    ok(r2.body.created.length === 0 && w.g.store.locations.length === 1 && r2.body.filled.length === 0, 'a second sweep never makes a second account, and fills nothing before the install');

    // The install click
    w.g.store.installed.add(loc.id);
    const r3 = await w.call({ mode: 'sweep' });
    const v = Object.fromEntries(loc.values.map((x) => [x.fieldFor ?? x.name, x.value]));
    ok(r3.body.filled[0]?.filled === true, 'once installed, the sweep fills it: ' + JSON.stringify(r3.body.filled));
    ok(v['Business Name'] === 'Acme Decks' && v['Owner Name'] === 'Pat Smith' && v['Business Phone'] === '(801) 555-0100' && v['Physical Address'] === '1 Main St'
        && v['Services List'] === 'Decks, Pergolas' && v['Text Window'] === '8am to 8pm, every day' && v['Facebook Page URL'] === 'https://facebook.com/acme', 'every custom value is filled from their answers');
    ok(w.tables.ghl_accounts[0].status === 'filled' && w.tables.ghl_accounts[0].fill_report.not_in_account.includes('business_email'), 'the account is marked filled, with what the snapshot lacked');
    ok(!JSON.stringify(w.tables.ghl_write_log).includes('Pat Smith'), "the log never holds an answer's value");

    // Filled accounts are left alone
    const before = w.g.calls.length;
    const r4 = await w.call({ mode: 'sweep' });
    ok(r4.body.filled.length === 0 && r4.body.created.length === 0 && w.g.calls.filter((c, i) => i >= before && c.method !== 'GET').length === 0, 'a filled account is never written again');
}

{
    // Someone types a location ID into Edit Client while the account is being made: theirs is kept
    const w = await world();
    const real = w.g.f;
    w.g.f = async (url, init) => { if (new URL(url).pathname === '/locations/') w.tables.clients[0].ghl_location_id = 'TypedByHand123456789'; return real(url, init); };
    const deps = { env: env(), db: w.db, fetch: w.g.f, now: () => new Date() };
    await handle(new Request('https://x', { method: 'POST', headers: { 'x-cron-secret': CRON }, body: JSON.stringify({ mode: 'sweep' }) }), deps);
    ok(w.tables.clients[0].ghl_location_id === 'TypedByHand123456789', 'a location ID typed in meanwhile is never overwritten');
}

// ---- who qualifies ----
{
    const clients = [
        { name: 'Acme Decks', status: 'active', current_stage: 'Onboarding', ghl_location_id: null },
        { name: 'Ironshell Roofing', status: 'active', current_stage: 'Onboarding', ghl_location_id: null },
        { name: 'Has GHL', status: 'active', current_stage: 'Onboarding', ghl_location_id: 'ExistingLoc123456789' },
        { name: 'Not done', status: 'active', current_stage: 'Onboarding', ghl_location_id: null },
        { name: 'Paused', status: 'paused', current_stage: 'Onboarding', ghl_location_id: null },
        { name: 'Running Ads', status: 'active', current_stage: 'Campaign Learning', ghl_location_id: null },
    ];
    const w = await world({ clients, handoffs: ['Acme Decks', 'Ironshell Roofing', 'Has GHL', 'Paused', 'Running Ads'],
        answers: [...ANSWERS('Acme Decks'), ...ANSWERS('Has GHL'), ...ANSWERS('Not done'), ...ANSWERS('Paused'), ...ANSWERS('Running Ads')] });
    const r = await w.call({ mode: 'status' }, 'admin');
    const why = Object.fromEntries(r.body.waiting.map((x) => [x.client, x.why]));
    ok(r.body.ready.join() === 'Acme Decks', 'only the finished client on the new questionnaire is ready: ' + r.body.ready.join());
    ok(/new questionnaire/.test(why['Ironshell Roofing']) && /already has/.test(why['Has GHL']) && /not finished/.test(why['Not done']) && /not active/.test(why['Paused']),
        'everyone else says why: ' + JSON.stringify(why));
    ok(!r.body.ready.includes('Running Ads') && !why['Running Ads'], 'clients past onboarding are never considered');
}
{
    // SEO only (clients.base_package = 'no'): finished, on the new questionnaire, otherwise exactly Acme. No account, ever.
    const clients = [
        { name: 'Acme Decks', status: 'active', current_stage: 'Onboarding', ghl_location_id: null, base_package: 'yes' },
        { name: 'Seo Only Co', status: 'active', current_stage: 'Onboarding', ghl_location_id: null, base_package: 'no' },
    ];
    const w = await world({ clients, handoffs: ['Acme Decks', 'Seo Only Co'], answers: [...ANSWERS('Acme Decks'), ...ANSWERS('Seo Only Co')] });
    const r = await w.call({ mode: 'status' }, 'admin');
    const why = Object.fromEntries(r.body.waiting.map((x) => [x.client, x.why]));
    ok(r.body.ready.join() === 'Acme Decks' && /SEO only/.test(why['Seo Only Co'] || ''), 'an SEO-only client is never ready for a GHL account: ' + JSON.stringify(r.body));
    const before = w.g.calls.length;
    await w.call({ mode: 'sweep' });
    const creates = w.g.calls.slice(before).filter((c) => c.method === 'POST' && c.path === '/locations/');
    ok(creates.length === 1 && !w.tables.ghl_accounts.some((a) => a.client_name === 'Seo Only Co'), 'the sweep creates for Acme only, nothing for the SEO-only client');
}
{
    // A failed creation on record, then the client is switched to SEO only: an admin retry must still be refused
    const clients = [{ name: 'Seo Only Co', status: 'active', current_stage: 'Onboarding', ghl_location_id: null, base_package: 'no' }];
    const w = await world({ clients, handoffs: ['Seo Only Co'], answers: ANSWERS('Seo Only Co') });
    w.tables.ghl_accounts.push({ client_name: 'Seo Only Co', status: 'failed', location_id: null, last_error: 'boom' });
    const before = w.g.calls.length;
    const rr = await w.call({ mode: 'retry', client: 'Seo Only Co', confirm: true }, 'admin');
    ok(rr.status === 409 && /SEO only/.test(rr.body.error || ''), 'an admin retry is refused for an SEO-only client: ' + JSON.stringify(rr.body));
    ok(!w.g.calls.slice(before).some((c) => c.method === 'POST' && c.path === '/locations/'), 'and no account is created');
}
{
    const many = ['A1', 'A2', 'A3'].map((n) => ({ name: n, status: 'active', current_stage: 'Onboarding', ghl_location_id: null }));
    const w = await world({ clients: many, handoffs: ['A1', 'A2', 'A3'], answers: ['A1', 'A2', 'A3'].flatMap(ANSWERS) });
    const r = await w.call({ mode: 'sweep' });
    ok(r.body.created.length === MAX_PER_SWEEP && w.g.store.locations.length === MAX_PER_SWEEP, `at most ${MAX_PER_SWEEP} accounts per sweep`);
}

// ---- the switch, the lock, failures ----
{
    const w = await world({ envOver: { GHL_AUTO_CREATE: 'off' } });
    const r = await w.call({ mode: 'sweep' });
    ok(r.body.created.length === 0 && r.body.would_create.join() === 'Acme Decks' && !w.g.store.locations.length, 'switched off, the sweep only says who it would create');
}
{
    const w = await world({ accounts: [{ client_name: 'Acme Decks', status: 'creating' }] });
    const r = await w.call({ mode: 'sweep' });
    ok(r.body.created.length === 0 && !w.g.store.locations.length, 'a client with any account record is never created again');
}
{
    const w = await world({ ghl: { createFails: true } });
    const r = await w.call({ mode: 'sweep' });
    ok(r.body.created[0].created === false && w.tables.ghl_accounts[0].status === 'failed' && /422/.test(w.tables.ghl_accounts[0].last_error), 'a failed creation is recorded as failed, with GHL\'s reason');
    ok(!w.tables.ghl_accounts[0].last_error.includes(COMPANY_TOKEN), "GHL's error text is scrubbed of the token");
    const again = await w.call({ mode: 'sweep' });
    ok(again.body.created.length === 0, 'a failed client is not retried by the schedule');
    const dry = await w.call({ mode: 'retry', client: 'Acme Decks' }, 'admin');
    ok(dry.body.dry_run === true, 'retry asks for confirm first');
    w.g.store.locations.length = 0;
    const fixed = fakeGhl();
    // GHL fixed: point the world's fetch at a working agency
    w.g.f = fixed.f;
}
{
    const w = await world({ ghl: { createFails: true } });
    await w.call({ mode: 'sweep' });
    const w2 = { ...w };
    // retry with a working GHL
    const good = fakeGhl();
    const deps = { env: env(), db: w.db, fetch: good.f, now: () => new Date('2026-10-16T21:00:00Z') };
    const res = await handle(new Request('https://x', { method: 'POST', headers: { Authorization: 'Bearer admin-jwt' }, body: JSON.stringify({ mode: 'retry', client: 'Acme Decks', confirm: true }) }), deps);
    const body = await res.json();
    ok(body.created?.[0]?.created === true && good.store.locations.length === 1 && w.tables.ghl_accounts[0].status === 'awaiting_install', 'an admin retry creates it once GHL works: ' + JSON.stringify(body));
    const res2 = await handle(new Request('https://x', { method: 'POST', headers: { Authorization: 'Bearer admin-jwt' }, body: JSON.stringify({ mode: 'retry', client: 'Acme Decks', confirm: true }) }), deps);
    ok(res2.status === 409 && good.store.locations.length === 1, 'a retry is refused once an account exists');
}
{
    // One value failing leaves the account waiting, so the next sweep finishes it
    const w = await world({ ghl: { putFails: ['cvSvc000001'] } });
    await w.call({ mode: 'sweep' });
    w.g.store.installed.add(w.g.store.locations[0].id);
    const r = await w.call({ mode: 'sweep' });
    ok(r.body.filled[0].filled === false && w.tables.ghl_accounts[0].status === 'awaiting_install' && /1 value/.test(w.tables.ghl_accounts[0].last_error), 'a value that fails is reported and retried on the next sweep');
}

// ---- the client's team as GHL users ----
{
    const pw = new Set(Array.from({ length: 50 }, () => randomPassword()));
    ok(pw.size === 50 && [...pw].every((p) => p.length >= 12 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p)),
        'every password is different and meets GHL\'s rules (12+, upper, lower, digit, symbol)');
    ok(writeAllowed('POST', '/users/') && !writeAllowed('PUT', '/users/User0000000000000001') && !writeAllowed('DELETE', '/users/User0000000000000001'),
        'adding a user is allowed; changing or deleting one is not');
}
{
    const w = await world();
    w.tables.client_contacts = [
        { id: 'c1', client_name: 'Acme Decks', contact_name: 'Pat Smith', email: 'pat@acme.com', phone: '801 555 0100', role: 'owner', ghl_login: true, active: true },
        { id: 'c2', client_name: 'Acme Decks', contact_name: 'Sam Sales', email: 'sam@acme.com', phone: '801-555-0101', role: 'sales', ghl_login: true, active: true },
        { id: 'c3', client_name: 'Acme Decks', contact_name: 'Nolan NoLogin', email: 'n@acme.com', phone: '8015550102', role: 'sales', ghl_login: false, active: true },
        { id: 'c4', client_name: 'Acme Decks', contact_name: 'Eve NoEmail', email: null, phone: '8015550103', role: 'sales', ghl_login: true, active: true },
        { id: 'c5', client_name: 'Other Co', contact_name: 'Other Person', email: 'o@other.com', phone: '8015550104', role: 'owner', ghl_login: true, active: true },
    ];
    w.g.store.refuseEmails = [];
    await w.call({ mode: 'sweep' });
    const loc = w.g.store.locations[0].id;
    ok(!(w.g.store.users ?? []).length, 'nobody is added before the app is installed');
    w.g.store.installed.add(loc);
    const r = await w.call({ mode: 'sweep' });
    const users = w.g.store.users ?? [];
    ok(users.map((u) => u.email).sort().join() === 'pat@acme.com,sam@acme.com', 'the people who asked for a login become GHL users: ' + users.map((u) => u.email).join());
    const pat = users.find((u) => u.email === 'pat@acme.com');
    ok(pat && pat.firstName === 'Pat' && pat.lastName === 'Smith' && pat.phone === '+18015550100' && pat.role === 'user' && pat.type === 'account'
        && JSON.stringify(pat.locationIds) === JSON.stringify([loc]) && pat.companyId === COMPANY, 'each is a limited user on this account only');
    ok(pat.permissions.opportunitiesEnabled === true && pat.permissions.contactsEnabled === true && pat.permissions.conversationsEnabled === true
        && pat.permissions.workflowsEnabled === false && pat.permissions.settingsEnabled === false && pat.permissions.triggersEnabled === false,
        'they can work leads and the pipeline, never workflows or settings');
    ok(w.tables.client_contacts.find((c) => c.id === 'c1').ghl_user_id && w.tables.client_contacts.find((c) => c.id === 'c2').ghl_user_id, 'their GHL user is recorded');
    ok(r.body.filled[0].users_added.length === 2 && r.body.filled[0].users_failed.some((f) => f.name === 'Eve NoEmail'), 'someone without an email is reported, not guessed');
    const everything = JSON.stringify([w.tables, r.body]);
    ok(!everything.includes(pat.password), 'a password is never stored, logged or returned');
    ok(w.tables.ghl_write_log.filter((l) => l.path === '/users/').length === 2 && w.tables.ghl_write_log.every((l) => !/pat@acme/.test(l.summary)), 'each user is in the write log, without their email');

    // Added later: an admin adds them; nobody is added twice
    w.tables.client_contacts.push({ id: 'c6', client_name: 'Acme Decks', contact_name: 'Late Larry', email: 'larry@acme.com', phone: '8015550105', role: 'sales', ghl_login: true, active: true });
    await w.call({ mode: 'sweep' });
    ok((w.g.store.users ?? []).length === 2, 'the schedule never adds people to a filled account');
    const add = await w.call({ mode: 'add_users', client: 'Acme Decks' }, 'admin');
    ok(add.body.users_added?.join() === 'Late Larry' && w.g.store.users.length === 3, 'an admin adds the new person, and only them: ' + JSON.stringify(add.body));
    ok((await w.call({ mode: 'add_users', client: 'Acme Decks' })).status === 403, 'the schedule cannot add users');
    ok((await w.call({ mode: 'add_users', client: 'Other Co' }, 'admin')).status === 409 && w.g.store.users.length === 3, 'never for an account Golden Eye did not make');
}
{
    const w = await world();
    w.tables.client_contacts = [{ id: 'c1', client_name: 'Acme Decks', contact_name: 'Pat Smith', email: 'pat@acme.com', phone: '8015550100', ghl_login: true, active: true }];
    await w.call({ mode: 'sweep' });
    const r = await w.call({ mode: 'add_users', client: 'Acme Decks' }, 'admin');
    ok(r.status === 409 && !(w.g.store.users ?? []).length, 'add_users waits until the account is filled');
}
{
    const w = await world();
    w.tables.client_contacts = [{ id: 'c1', client_name: 'Acme Decks', contact_name: 'Pat Smith', email: 'taken@acme.com', phone: '8015550100', ghl_login: true, active: true }];
    w.g.store.refuseEmails = ['taken@acme.com'];
    await w.call({ mode: 'sweep' });
    w.g.store.installed.add(w.g.store.locations[0].id);
    const r = await w.call({ mode: 'sweep' });
    ok(r.body.filled[0].users_failed[0]?.error.includes('already taken') && w.tables.ghl_accounts[0].status === 'filled', 'a refused user is reported and does not hold the account back');
}

// ---- who may call ----
{
    const w = await world();
    ok((await w.call({ mode: 'status' }, 'anon-or-bad-jwt')).status === 403, 'a caller who is neither the schedule nor an admin is refused');
    ok((await w.call({ mode: 'create', client: 'Acme Decks', confirm: true })).status === 403 && !w.g.store.locations.length, 'the schedule can only sweep');
    const dry = await w.call({ mode: 'create', client: 'Acme Decks' }, 'admin');
    ok(dry.body.dry_run === true && !w.g.store.locations.length, 'an admin create asks for confirm first');
    const real = await w.call({ mode: 'create', client: 'Acme Decks', confirm: true }, 'admin');
    ok(real.body.created[0].created === true && w.tables.ghl_accounts[0].created_by === 'tenny@midasmediafirm.com', 'an admin can create one now; the record says who');
    const nope = await w.call({ mode: 'create', client: 'Ironshell Roofing', confirm: true }, 'admin');
    ok(nope.status === 409, 'an admin can only create for a client who qualifies');
}
{
    const w = await world({ envOver: { GHL_SNAPSHOT_ID: '' } });
    ok((await w.call({ mode: 'sweep' })).status === 500 && !w.g.calls.length, 'nothing happens without the snapshot id');
}
{
    // Master is never filled, even if a record pointed at it
    const w = await world({ accounts: [{ client_name: 'Acme Decks', status: 'awaiting_install', location_id: MASTER }], ghl: { installed: [MASTER] } });
    const r = await w.call({ mode: 'sweep' });
    ok(r.body.filled[0]?.filled === false && /Master/.test(r.body.filled[0].error) && !w.tables.ghl_write_log.length, 'Master is never filled');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
