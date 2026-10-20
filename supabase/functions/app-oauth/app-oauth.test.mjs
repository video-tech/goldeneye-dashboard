// Checks for Golden Eye's GHL Marketplace app plumbing: _shared/ghl-oauth.ts, the app-oauth callback, and
// ghl-provision using the app. Run (node 22.6+):
//   node --experimental-strip-types supabase/functions/app-oauth/app-oauth.test.mjs
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = await import(pathToFileURL(path.join(here, '..', '_shared', 'ghl-oauth.ts')).href);
const { handle: callback } = await import(pathToFileURL(path.join(here, 'handler.ts')).href);
const { handle: provision } = await import(pathToFileURL(path.join(here, '..', 'ghl-provision', 'handler.ts')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const COMPANY = 'aO4gguGsn5P1gl647qjV';
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const env = { GHL_APP_CLIENT_ID: 'client-id-1', GHL_APP_CLIENT_SECRET: 'client-SECRET-xyz', GHL_TOKEN_KEY: KEY, GHL_COMPANY_ID: COMPANY };
const REDIRECT = 'https://x.supabase.co/functions/v1/app-oauth';
const T0 = new Date('2026-10-15T17:00:00Z');

// A one-table fake database supporting what the library uses.
function fakeDb() {
    const rows = new Map();
    let beforeUpdate = null;
    const db = {
        rows, setBeforeUpdate: (fn) => { beforeUpdate = fn; },
        from: () => ({
            upsert: async (row) => { rows.set(row.company_id, { ...row }); return { error: null }; },
            select: () => ({ eq: (_c, v) => ({ maybeSingle: async () => ({ data: rows.get(v) ? { ...rows.get(v) } : null, error: null }) }) }),
            update: (patch) => {
                const conds = [];
                const chain = {
                    eq: (c, v) => { conds.push([c, v]); return chain; },
                    select: async () => {
                        if (beforeUpdate) { const fn = beforeUpdate; beforeUpdate = null; await fn(); }
                        const hits = [...rows.values()].filter((r) => conds.every(([c, v]) => r[c] === v));
                        for (const r of hits) Object.assign(r, patch);
                        return { data: hits.map((r) => ({ company_id: r.company_id })), error: null };
                    },
                };
                return chain;
            },
        }),
    };
    return db;
}

// A fake GHL token server.
function fakeGhl({ userType = 'Company', companyId = COMPANY, installToFuture = true } = {}) {
    let n = 0;
    const calls = [];
    const f = async (url, init) => {
        calls.push({ url, init });
        const u = new URL(url);
        const body = new URLSearchParams(init.body ?? '');
        if (u.pathname === '/oauth/token') {
            if (body.get('client_secret') !== env.GHL_APP_CLIENT_SECRET) return new Response(JSON.stringify({ error: 'bad secret ' + body.get('client_secret') }), { status: 401 });
            if (body.get('grant_type') === 'authorization_code' && body.get('code') !== 'good-code') return new Response(JSON.stringify({ error: 'invalid code good?' }), { status: 400 });
            n++;
            return new Response(JSON.stringify({ access_token: 'AT' + n, refresh_token: 'RT' + n, expires_in: 86399, userType, companyId,
                scope: 'locations.write oauth.write', userId: 'u1', installToFutureLocations: installToFuture, approveAllLocations: true }), { status: 200 });
        }
        if (u.pathname === '/oauth/locationToken') {
            if (!String(init.headers.Authorization).startsWith('Bearer AT')) return new Response('{"message":"no"}', { status: 401 });
            return new Response(JSON.stringify({ access_token: 'LT-' + body.get('locationId') }), { status: 200 });
        }
        return new Response('{"message":"unknown"}', { status: 404 });
    };
    return { f, calls, tokenCalls: () => calls.filter((c) => new URL(c.url).pathname === '/oauth/token') };
}

// ---- encryption ----
const enc = await lib.encrypt(env, 'secret-token-value');
ok(!enc.includes('secret-token-value') && enc.includes('.'), 'stored form is not the token');
ok(await lib.decrypt(env, enc) === 'secret-token-value', 'round trip');
ok(await lib.encrypt(env, 'x') !== await lib.encrypt(env, 'x'), 'a fresh random IV each time');
let threw = false;
try { await lib.decrypt({ ...env, GHL_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64') }, enc); } catch { threw = true; }
ok(threw, 'the wrong key cannot read it');
threw = false;
try { await lib.encrypt({ ...env, GHL_TOKEN_KEY: 'c2hvcnQ=' }, 'x'); } catch (e) { threw = /32 random bytes/.test(e.message); }
ok(threw, 'a short key is refused with a clear message');
ok(lib.oauthConfigured(env) && !lib.oauthConfigured({ ...env, GHL_TOKEN_KEY: '' }), 'configured only when all four settings are there');

// ---- the install (callback) ----
let db = fakeDb(), g = fakeGhl();
const deps = () => ({ env, db, fetch: g.f, now: () => T0, redirectUri: REDIRECT });
let res = await callback(new Request(REDIRECT + '?code=good-code'), deps());
let html = await res.text();
ok(res.status === 200 && /connected to GHL/.test(html) && /created from now on/.test(html), 'install stores the keys and says it covers future sub-accounts');
const row = db.rows.get(COMPANY);
ok(row && !JSON.stringify(row).includes('AT1') && !JSON.stringify(row).includes('RT1'), 'tokens are stored encrypted, never in plain text');
ok(row.install_to_future === true && row.expires_at === new Date(T0.getTime() + 86399000).toISOString(), 'expiry and the future-sub-accounts flag recorded');
const ex = new URLSearchParams(g.calls[0].init.body);
ok(ex.get('grant_type') === 'authorization_code' && ex.get('user_type') === 'Company' && ex.get('redirect_uri') === REDIRECT, 'exchange asks for the agency (Company) token with our redirect');
ok(!/AT1|RT1|client-SECRET/.test(html), 'the page shows no token or secret');

db = fakeDb(); g = fakeGhl({ companyId: 'SomeoneElse123456789' });
res = await callback(new Request(REDIRECT + '?code=good-code'), deps());
ok(res.status === 400 && db.rows.size === 0 && /isn't for Midas Media's agency/.test(await res.text()), 'an install on another agency is refused and nothing stored');
db = fakeDb(); g = fakeGhl({ userType: 'Location' });
res = await callback(new Request(REDIRECT + '?code=good-code'), deps());
ok(res.status === 400 && db.rows.size === 0, 'an install on a single sub-account is refused');
db = fakeDb(); g = fakeGhl({ installToFuture: false });
res = await callback(new Request(REDIRECT + '?code=good-code'), deps());
ok(/was not installed for future sub-accounts/.test(await res.text()), 'warns when future sub-accounts were not included');
db = fakeDb(); g = fakeGhl();
res = await callback(new Request(REDIRECT + '?code=bad<script>'), deps());
html = await res.text();
ok(res.status === 400 && !html.includes('<script>') && db.rows.size === 0, 'a bad code is refused, and nothing it echoes runs as markup');
res = await callback(new Request(REDIRECT + '?error=access_denied%3Cb%3E'), deps());
ok(res.status === 400 && !(await res.text()).includes('<b>'), 'an error from GHL is shown escaped');
res = await callback(new Request(REDIRECT), deps());
ok(res.status === 200 && db.rows.size === 0, 'a visit with no code just explains itself');
res = await callback(new Request(REDIRECT + '?code=good-code'), { ...deps(), env: { ...env, GHL_APP_CLIENT_SECRET: '' } });
ok(res.status === 500, 'missing settings: refused');
res = await callback(new Request(REDIRECT, { method: 'POST' }), deps());
ok(res.status === 405, 'only GET');

// ---- tokens after install ----
db = fakeDb(); g = fakeGhl();
await callback(new Request(REDIRECT + '?code=good-code'), deps());
const at = (now) => lib.companyAccessToken({ env, db, fetch: g.f, now: () => now });
ok(await at(new Date(T0.getTime() + 3600e3)) === 'AT1' && g.tokenCalls().length === 1, 'a fresh token is used as is, no renewal');
ok(await at(new Date(T0.getTime() + 86399e3 - 60e3)) === 'AT2' && g.tokenCalls().length === 2, 'renewed five minutes before it expires');
const renew = new URLSearchParams(g.tokenCalls()[1].init.body);
ok(renew.get('grant_type') === 'refresh_token' && renew.get('refresh_token') === 'RT1', 'renewal spends the stored refresh token');
ok(await lib.decrypt(env, db.rows.get(COMPANY).refresh_token_enc) === 'RT2', 'the new refresh token replaces the used one');

// two requests renewing at once: the loser reads the winner's token instead of saving a dead one
db.rows.get(COMPANY).expires_at = T0.toISOString();
// another request renews in between this one's read and its save
const winnerRefresh = await lib.encrypt(env, 'RT-WINNER');
db.setBeforeUpdate(async () => {
    const r = db.rows.get(COMPANY);
    r.refresh_token_enc = winnerRefresh;
    r.access_token_enc = await lib.encrypt(env, 'AT-WINNER');
    r.expires_at = new Date(T0.getTime() + 86400e3).toISOString();
});
const lost = await at(new Date(T0.getTime() + 10e3));
ok(lost === 'AT-WINNER' && db.rows.get(COMPANY).refresh_token_enc === winnerRefresh, 'losing a renewal race uses the winner\'s token and overwrites nothing');

// location token
db.rows.get(COMPANY).expires_at = new Date(T0.getTime() + 86400e3).toISOString();
db.rows.get(COMPANY).access_token_enc = await lib.encrypt(env, 'AT9');
ok(await lib.locationAccessToken({ env, db, fetch: g.f, now: () => T0 }, 'Loc12345678901234567') === 'LT-Loc12345678901234567', 'a location token for one sub-account');
const lt = g.calls.at(-1);
ok(new URLSearchParams(lt.init.body).get('companyId') === COMPANY && lt.init.headers.Authorization === 'Bearer AT9', 'asked with our company id and the agency token');

threw = false;
try { await lib.companyAccessToken({ env, db: fakeDb(), fetch: g.f, now: () => T0 }); } catch (e) { threw = /isn't installed/.test(e.message); }
ok(threw, 'not installed yet: a clear message');
const leak = { f: async () => new Response(JSON.stringify({ error: 'nope client-SECRET-xyz RT9' }), { status: 400 }) };
db.rows.get(COMPANY).expires_at = T0.toISOString();
db.rows.get(COMPANY).refresh_token_enc = await lib.encrypt(env, 'RT9');
threw = false;
try { await lib.companyAccessToken({ env, db, fetch: leak.f, now: () => T0 }); } catch (e) { threw = !/client-SECRET|RT9/.test(e.message) && /\[secret\]/.test(e.message); }
ok(threw, 'an error echoing the secret or refresh token is scrubbed');

// ---- ghl-provision with the app ----
db = fakeDb(); g = fakeGhl();
await callback(new Request(REDIRECT + '?code=good-code'), deps());
const TEST_LOC = 'iezHGamWbxcwOYybQx7u';
const pcalls = [];
const pf = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/oauth/')) return g.f(url, init);
    pcalls.push({ url, auth: init.headers.Authorization });
    if (u.pathname === `/locations/${TEST_LOC}`) return new Response(JSON.stringify({ location: { id: TEST_LOC, name: 'GE TEST 2026-10-15 16:40' } }));
    if (u.pathname === `/locations/${TEST_LOC}/customValues`) return new Response(JSON.stringify({ customValues: [] }));
    return new Response(JSON.stringify({}));
};
const pdb = { ...db, from: (t) => (t === 'clients' ? { select: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) } : db.from(t)) };
res = await provision(new Request('https://x', { method: 'POST', headers: { 'x-cron-secret': 'c' }, body: JSON.stringify({ mode: 'inspect', location_id: TEST_LOC }) }),
    { env: { ...env, MAKE_WEBHOOK_SECRET: 'c', GHL_MASTER_LOCATION_ID: 'sXL42Tk6BFlMz8GEe5LQ' }, db: pdb, fetch: pf, now: () => T0, sleep: async () => {} });
const pj = await res.json();
ok(res.status === 200 && pj.access === 'app location token', 'ghl-provision uses the app when it is installed');
ok(pcalls.find((c) => c.url.includes('/customValues')).auth === 'Bearer LT-' + TEST_LOC && pcalls.find((c) => c.url.endsWith(TEST_LOC)).auth === 'Bearer AT1',
    'agency token to check the account, location token inside it');
ok(!JSON.stringify(pj).includes('AT1') && !JSON.stringify(pj).includes('LT-'), 'no token in its answer');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
