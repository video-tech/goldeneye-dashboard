// Checks for ghl-contact-check. Run (node 22.6+):
//   node --experimental-strip-types supabase/functions/ghl-contact-check/ghl-contact-check.test.mjs
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { handle, primaryEmail } = await import(pathToFileURL(path.join(here, 'handler.ts')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const TOKEN = 'pit-midas-read-only-123', LOC = 'MidasLoc1234567890ab', CRON = 'cron-secret';

function fakeDb(clients) {
    const tables = { clients, client_ghl_contacts: [], user_profiles: [{ email: 'tenny@midasmediafirm.com', role: 'admin' }] };
    class Q {
        constructor(t) { this.t = t; this.f = []; this.op = 'select'; }
        select() { return this; }
        eq(c, v) { this.f.push((r) => r[c] === v); return this; }
        maybeSingle() { this.one = true; return this; }
        upsert(rows, opts) { this.op = 'upsert'; this.rows = rows; this.key = opts.onConflict; return this; }
        then(res) {
            if (this.op === 'upsert') {
                for (const r of this.rows) { const i = tables[this.t].findIndex((x) => x[this.key] === r[this.key]); if (i >= 0) tables[this.t][i] = r; else tables[this.t].push(r); }
                return res({ data: null, error: null });
            }
            const out = tables[this.t].filter((r) => this.f.every((fn) => fn(r)));
            return res(this.one ? { data: out[0] ?? null, error: null } : { data: out, error: null });
        }
    }
    return { tables, from: (t) => new Q(t), auth: { getUser: async (jwt) => (jwt === 'admin-jwt' ? { data: { user: { email: 'tenny@midasmediafirm.com' } }, error: null } : { data: null, error: { message: 'bad' } }) } };
}
// GHL's search is fuzzy: it returns anything that looks like the query
function fakeGhl(contacts, { fail = false } = {}) {
    const calls = [];
    const f = async (url, init) => {
        const u = new URL(url);
        calls.push({ method: init.method, path: u.pathname, query: u.searchParams.get('query'), loc: u.searchParams.get('locationId'), auth: init.headers.Authorization });
        if (fail) return new Response(JSON.stringify({ message: 'Invalid token ' + TOKEN }), { status: 401 });
        const q = (u.searchParams.get('query') || '').toLowerCase();
        return new Response(JSON.stringify({ contacts: contacts.filter((c) => (c.email || '').toLowerCase().includes(q.split('@')[0])) }));
    };
    return { f, calls };
}
const clients = [
    { name: 'Found Co', client_email: ' Owner@Found.com , second@found.com', status: 'active', current_stage: 'Onboarding' },
    { name: 'Missing Co', client_email: 'nobody@missing.com', status: 'active', current_stage: 'Onboarding' },
    { name: 'Dup Co', client_email: 'dup@dup.com', status: 'active', current_stage: 'Onboarding' },
    { name: 'Near Co', client_email: 'pat@near.com', status: 'active', current_stage: 'Onboarding' },
    { name: 'No Email Co', client_email: null, status: 'active', current_stage: 'Onboarding' },
    { name: 'Live Co', client_email: 'live@live.com', status: 'active', current_stage: 'Campaign Learning' },
    { name: 'Paused Co', client_email: 'p@paused.com', status: 'paused', current_stage: 'Onboarding' },
];
const contacts = [
    { id: 'c1', email: 'owner@found.com' }, { id: 'c2', email: 'owner@found.com.au' },
    { id: 'c3', email: 'dup@dup.com' }, { id: 'c4', email: 'DUP@dup.com' },
    { id: 'c5', email: 'pat@near.co' },
];
async function call(db, g, body, as = 'cron', envOver = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (as === 'cron') headers['x-cron-secret'] = CRON; else headers.Authorization = 'Bearer ' + as;
    const res = await handle(new Request('https://x', { method: 'POST', headers, body: JSON.stringify(body) }),
        { env: { GHL_MIDAS_TOKEN: TOKEN, GHL_MIDAS_LOCATION_ID: LOC, MAKE_WEBHOOK_SECRET: CRON, ...envOver }, db, fetch: g.f, now: () => new Date('2026-10-16T14:00:00Z') });
    return { status: res.status, body: await res.json() };
}

ok(primaryEmail(' Owner@Found.com , second@found.com') === 'owner@found.com' && primaryEmail('a @b.com') === 'a@b.com' && primaryEmail(null) === '',
    'the email checked is the one the onboarding trigger sends: the first, spaces removed');
{
    const db = fakeDb(clients.map((c) => ({ ...c }))), g = fakeGhl(contacts);
    const r = await call(db, g, { mode: 'check' });
    const by = Object.fromEntries(db.tables.client_ghl_contacts.map((x) => [x.client_name, x]));
    ok(r.status === 200 && r.body.checked === 5, 'the schedule checks every active client in onboarding: ' + r.body.checked);
    ok(!by['Live Co'] && !by['Paused Co'], 'clients past onboarding or paused are not checked by the schedule');
    ok(by['Found Co'].status === 'found' && by['Found Co'].contact_id === 'c1' && by['Found Co'].matches === 1, 'exactly one exact match is found (a look-alike address does not count)');
    ok(by['Missing Co'].status === 'missing', 'no contact is missing');
    ok(by['Dup Co'].status === 'duplicate' && by['Dup Co'].matches === 2, 'two contacts with the same email (any case) is a duplicate');
    ok(by['Near Co'].status === 'missing', 'a near-miss email from the fuzzy search is not a match');
    ok(by['No Email Co'].status === 'no_email' && !g.calls.some((c) => c.query === ''), 'a client with no email is reported, and GHL is never searched with an empty query');
    ok(g.calls.every((c) => c.method === 'GET' && c.loc === LOC && c.auth === 'Bearer ' + TOKEN), 'it only reads, from our Midas account, with the read-only key');
    ok(by['Found Co'].checked_at === '2026-10-16T14:00:00.000Z', 'each result records when it was checked');
    // re-running replaces, never duplicates
    await call(db, g, { mode: 'check' });
    ok(db.tables.client_ghl_contacts.length === 5, 'a re-run replaces each client\'s result');
}
{
    const db = fakeDb(clients.map((c) => ({ ...c }))), g = fakeGhl(contacts);
    const r = await call(db, g, { mode: 'check', client: 'Live Co' }, 'admin-jwt');
    ok(r.status === 200 && r.body.checked === 1 && db.tables.client_ghl_contacts[0].client_name === 'Live Co', 'an admin can check one client, at any stage');
    ok((await call(db, g, { mode: 'check', client: 'Nope' }, 'admin-jwt')).status === 404, 'an unknown client is reported');
}
{
    const db = fakeDb(clients.map((c) => ({ ...c }))), g = fakeGhl(contacts, { fail: true });
    await call(db, g, { mode: 'check', client: 'Found Co' }, 'admin-jwt');
    const row = db.tables.client_ghl_contacts[0];
    ok(row.status === 'error' && /401/.test(row.error) && !row.error.includes(TOKEN), "GHL refusing is recorded as an error, with the key scrubbed from GHL's message");
}
{
    const db = fakeDb(clients.map((c) => ({ ...c }))), g = fakeGhl(contacts);
    ok((await call(db, g, {}, 'anon-or-bad')).status === 403 && !g.calls.length, 'anyone but the schedule or an admin is refused');
    ok((await call(db, g, {}, 'cron', { GHL_MIDAS_TOKEN: '' })).status === 500 && !g.calls.length, 'nothing runs without the key');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
