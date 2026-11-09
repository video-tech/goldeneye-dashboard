// Checks for ghl-leads. Run (node 22.6+):
//   node --experimental-strip-types supabase/functions/ghl-leads/ghl-leads.test.mjs
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const H = await import(pathToFileURL(path.join(here, 'handler.ts')).href);
const W = await import(pathToFileURL(path.join(here, '..', '_shared', 'ghl-write.ts')).href);
const { handle, denverMidnight, denverDay, countContacts, cleanTags, explainGhlError, PAGE, MAX_PAGES } = H;

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const LOC = 'ClientLoc1234567890a', MIDAS = 'MidasLoc1234567890ab', APPTOKEN = 'app-location-token-xyz', MIDASTOKEN = 'pit-midas-123';

function fakeDb(clients) {
    const tables = { clients, user_profiles: [{ email: 'tenny@midasmediafirm.com', role: 'admin' }, { email: 'va@x.com', role: 'member' }] };
    class Q {
        constructor(t) { this.t = t; this.f = []; }
        select() { return this; } limit() { return this; }
        eq(c, v) { this.f.push((r) => r[c] === v); return this; }
        maybeSingle() { this.one = true; return this; }
        then(res) {
            const out = tables[this.t].filter((r) => this.f.every((fn) => fn(r)));
            return res(this.one ? { data: out[0] ?? null, error: null } : { data: out, error: null });
        }
    }
    const users = { 'admin-jwt': 'tenny@midasmediafirm.com', 'member-jwt': 'va@x.com' };
    return { from: (t) => new Q(t), auth: { getUser: async (jwt) => (users[jwt] ? { data: { user: { email: users[jwt] } }, error: null } : { data: null, error: { message: 'bad' } }) } };
}

// A GHL that holds contacts and honours the dateAdded range, sort and searchAfter paging
function fakeGhl(contacts, { status = 200, message = '' } = {}) {
    const calls = [];
    const f = async (url, init) => {
        const u = new URL(url);
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ method: init.method, path: u.pathname, auth: init.headers.Authorization, body });
        if (status !== 200) return new Response(JSON.stringify({ message }), { status });
        const r = body.filters[0].value;
        let list = contacts.filter((c) => c.dateAdded >= r.gte && c.dateAdded < r.lt).sort((a, b) => a.dateAdded.localeCompare(b.dateAdded) || a.id.localeCompare(b.id));
        if (body.searchAfter) { const [t, id] = body.searchAfter; list = list.filter((c) => c.dateAdded > t || (c.dateAdded === t && c.id > id)); }
        const page = list.slice(0, body.pageLimit).map((c) => ({ ...c, searchAfter: [c.dateAdded, c.id] }));
        return new Response(JSON.stringify({ contacts: page, total: list.length }), { status: 200 });
    };
    f.calls = calls;
    return f;
}
const contact = (id, dateAdded, tags = [], extra = {}) => ({ id, dateAdded, tags, firstName: 'Jane', lastName: 'Doe', email: `jane${id}@x.com`, phone: '+18015550100', source: 'facebook form', ...extra });

const req = (body, jwt = 'admin-jwt', origin = 'https://goldeneye.midasmediafirm.com') => new Request('https://x/ghl-leads', { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
const run = async (clients, ghl, body, jwt, envExtra = {}, token) => {
    const res = await handle(req(body, jwt), { env: { GHL_MIDAS_LOCATION_ID: MIDAS, GHL_MIDAS_TOKEN: MIDASTOKEN, ...envExtra }, db: fakeDb(clients), fetch: ghl, token });
    return { status: res.status, json: await res.json(), headers: res.headers };
};
const appToken = async () => APPTOKEN;
const client = (extra = {}) => ({ name: 'Acme', ghl_location_id: LOC, lead_tags: ['FB Lead', 'quiz'], ...extra });

// ---- Mountain time ----
ok(denverMidnight('2026-11-09').toISOString() === '2026-11-09T07:00:00.000Z', 'MST midnight is 07:00 UTC');
ok(denverMidnight('2026-07-01').toISOString() === '2026-07-01T06:00:00.000Z', 'MDT midnight is 06:00 UTC');
ok(denverMidnight('2026-11-01').toISOString() === '2026-11-01T06:00:00.000Z', 'the day DST ends starts in MDT');
ok(denverDay('2026-11-10T06:59:59Z') === '2026-11-09', '11:59pm Mountain is still that day');
ok(denverDay('2026-11-10T07:00:00Z') === '2026-11-10', 'midnight Mountain is the next day');

// ---- tags ----
ok(JSON.stringify(cleanTags([' FB Lead ', 'fb lead', '', 'Quiz'])) === '["fb lead","quiz"]', 'tags trimmed, lower-cased, de-duplicated');
ok(JSON.stringify(cleanTags('a, B ,a')) === '["a","b"]', 'comma text accepted');

// ---- counting ----
{
    const cs = [
        contact('1', '2026-11-03T15:00:00Z', ['fb lead']),
        contact('2', '2026-11-03T16:00:00Z', ['FB Lead', 'Quiz']),
        contact('3', '2026-11-04T16:00:00Z', ['referral']),
        contact('4', '2026-11-10T06:30:00Z', ['quiz']),          // Nov 9, 11:30pm Mountain: in range
        contact('5', '2026-11-10T07:30:00Z', ['quiz']),          // Nov 10 Mountain: out of range
    ];
    const r = countContacts(cs, ['fb lead', 'quiz'], '2026-11-03', '2026-11-09');
    ok(r.added === 4, 'added counts only days in range');
    ok(r.tagged === 3, 'a contact with two lead tags counts once');
    ok(r.per_tag['fb lead'] === 2 && r.per_tag.quiz === 2, 'per tag counts, case-insensitive');
    ok(r.by_day.length === 7 && r.by_day[0].date === '2026-11-03' && r.by_day[0].tagged === 2, 'every day listed, with its counts');
    ok(r.by_day.find((d) => d.date === '2026-11-09').tagged === 1, 'late-evening contact lands on its Mountain day');
    ok(r.other_tags.length === 1 && r.other_tags[0].name === 'referral', 'other tags listed');
    ok(r.sources[0].name === 'facebook form' && r.sources[0].count === 4, 'sources counted');
    const none = countContacts(cs, [], '2026-11-03', '2026-11-09');
    ok(none.tagged === 0 && none.other_tags.some((t) => t.name === 'fb lead'), 'no lead tags: nothing tagged, all tags offered');
}

// ---- the handler ----
{
    const cs = [contact('1', '2026-11-03T15:00:00Z', ['fb lead']), contact('2', '2026-11-05T15:00:00Z', ['other'])];
    const ghl = fakeGhl(cs);
    const { status, json, headers } = await run([client()], ghl, { client: 'Acme', start: '2026-11-03', end: '2026-11-09' }, 'admin-jwt', {}, appToken);
    ok(status === 200 && json.status === 'ok', 'admin gets an answer');
    ok(json.added === 2 && json.tagged === 1, 'counts returned');
    ok(headers.get('Access-Control-Allow-Origin') === 'https://goldeneye.midasmediafirm.com', 'CORS for Golden Eye');
    const text = JSON.stringify(json);
    ok(!/jane|Doe|@x\.com|8015550100|"id"/i.test(text), 'no names, emails, phones or contact ids in the answer');
    const c0 = ghl.calls[0];
    ok(c0.method === 'POST' && c0.path === '/contacts/search', 'uses the contact search');
    ok(c0.auth === `Bearer ${APPTOKEN}`, 'with the app location token');
    ok(c0.body.locationId === LOC && c0.body.pageLimit === PAGE && c0.body.page === 1 && !c0.body.searchAfter, 'first page asked by page');
    ok(c0.body.filters[0].value.gte === '2026-11-03T07:00:00.000Z' && c0.body.filters[0].value.lt === '2026-11-10T07:00:00.000Z', 'range is Mountain midnight to the midnight after the last day');
}
{
    // paging past one page with searchAfter
    const cs = [];
    for (let i = 0; i < PAGE + 120; i++) cs.push(contact(String(i).padStart(5, '0'), `2026-11-04T1${i % 10}:00:00Z`, i % 2 ? ['quiz'] : []));
    const ghl = fakeGhl(cs);
    const { json } = await run([client()], ghl, { client: 'Acme', start: '2026-11-03', end: '2026-11-09' }, 'admin-jwt', {}, appToken);
    ok(json.added === PAGE + 120, 'all pages read');
    ok(ghl.calls.length === 2 && Array.isArray(ghl.calls[1].body.searchAfter) && ghl.calls[1].body.page === undefined, 'second page by searchAfter, not page');
    ok(json.truncated === false, 'not truncated');
}
{
    const cs = [];
    for (let i = 0; i < PAGE * MAX_PAGES + 5; i++) cs.push(contact(String(i).padStart(5, '0'), '2026-11-04T15:00:00Z'));
    const ghl = fakeGhl(cs);
    const { json } = await run([client()], ghl, { client: 'Acme', start: '2026-11-03', end: '2026-11-09' }, 'admin-jwt', {}, appToken);
    ok(json.truncated === true && ghl.calls.length === MAX_PAGES, 'stops at the page cap and says so');
}
{
    // our own Midas sub-account uses the Midas token, not the app
    const ghl = fakeGhl([contact('1', '2026-11-04T15:00:00Z', ['sunset lead'])]);
    let appAsked = false;
    const { json } = await run([client({ name: 'Sunset', ghl_location_id: MIDAS, lead_tags: ['sunset lead'] })], ghl, { client: 'Sunset', start: '2026-11-03', end: '2026-11-09' }, 'admin-jwt');
    ok(json.tagged === 1 && ghl.calls[0].auth === `Bearer ${MIDASTOKEN}`, 'Midas sub-account read with GHL_MIDAS_TOKEN');
    void appAsked;
}
{
    // refusals and setup states
    const ghl = fakeGhl([]);
    let r = await run([client()], ghl, { client: 'Acme', start: '2026-11-03', end: '2026-11-09' }, 'member-jwt', {}, appToken);
    ok(r.status === 403 && ghl.calls.length === 0, 'non-admin refused before any GHL call');
    r = await run([client()], ghl, { client: 'Acme', start: '2026-11-03', end: '2026-11-09' }, 'nobody', {}, appToken);
    ok(r.status === 403, 'unknown sign-in refused');
    r = await run([client()], ghl, { client: 'Acme', start: '2026-11-09', end: '2026-11-03' }, 'admin-jwt', {}, appToken);
    ok(r.status === 400, 'start after end refused');
    r = await run([client()], ghl, { client: 'Acme', start: 'last week', end: '2026-11-03' }, 'admin-jwt', {}, appToken);
    ok(r.status === 400, 'bad date refused');
    r = await run([client()], ghl, { client: 'Nope', start: '2026-11-03', end: '2026-11-09' }, 'admin-jwt', {}, appToken);
    ok(r.status === 404, 'unknown client');
    r = await run([client({ ghl_location_id: '' })], ghl, { client: 'Acme', start: '2026-11-03', end: '2026-11-09' }, 'admin-jwt', {}, appToken);
    ok(r.json.status === 'no_location' && /Edit Client/.test(r.json.error), 'no location id: says where to add it');
    r = await run([client({ lead_tags: undefined })], fakeGhl([contact('1', '2026-11-04T15:00:00Z', ['fb'])]), { client: 'Acme', start: '2026-11-03', end: '2026-11-09' }, 'admin-jwt', {}, appToken);
    ok(r.json.status === 'no_tags' && r.json.tags_column === true && r.json.other_tags[0].name === 'fb', 'no lead tags: counts plus tags to pick from');
    const noCol = { name: 'Acme', ghl_location_id: LOC };
    r = await run([noCol], fakeGhl([]), { client: 'Acme', start: '2026-11-03', end: '2026-11-09' }, 'admin-jwt', {}, appToken);
    ok(r.json.status === 'no_tags' && r.json.tags_column === false, 'works before the SQL adds lead_tags');
    r = await run([client()], ghl, { client: 'Acme', start: '2026-11-03', end: '2026-11-09' }, 'admin-jwt', {}, async () => { throw new Error('accessToken does not have access to following location'); });
    ok(r.json.status === 'no_access' && /not installed/.test(r.json.error), 'no location token: app not installed');
    r = await run([client()], ghl, { client: 'Acme', start: '2026-11-03', end: '2026-11-09' }, 'admin-jwt');
    ok(r.json.status === 'no_access', 'app not configured on the server: no_access');
    r = await run([client()], fakeGhl([], { status: 401, message: 'The token is not authorized for this scope. ' + APPTOKEN }), { client: 'Acme', start: '2026-11-03', end: '2026-11-09' }, 'admin-jwt', {}, appToken);
    ok(r.json.status === 'ghl_error' && /View Contacts/.test(r.json.error), 'missing scope explained');
    ok(!JSON.stringify(r.json).includes(APPTOKEN), 'token never echoed back');
}

// ---- the read gate ----
ok(W.READ_POST_ALLOW.some((x) => x.test('/contacts/search')), 'search allowed as a read');
{
    let threw = false;
    try { await W.ghlReadPost({ db: null, fetch: async () => new Response('{}') }, '/contacts/', 't', {}); } catch { threw = true; }
    ok(threw, 'a POST that would create a contact is refused');
}
ok(/not installed/.test(explainGhlError(Object.assign(new Error('accessToken does not have access to following location'), { status: 403 }))), 'location error explained');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
