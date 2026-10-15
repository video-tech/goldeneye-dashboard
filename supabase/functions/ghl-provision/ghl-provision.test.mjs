// Checks for ghl-provision. Run (node 22.6+):
//   node --experimental-strip-types supabase/functions/ghl-provision/ghl-provision.test.mjs
// Runs the real handler against a fake GHL agency and a fake database.
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { handle, testName, TEST_PREFIX } = await import(pathToFileURL(path.join(here, 'handler.ts')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const AGENCY = 'pit-agency-secret-999';
const LOCTOKEN = 'loc-token-secret-777';
const COMPANY = 'aO4gguGsn5P1gl647qjV';
const MASTER = 'sXL42Tk6BFlMz8GEe5LQ';
const CLIENT_LOC = 'ClientLoc1234567890a';
const CRON = 'cron-secret';
const NOW = new Date('2026-10-15T16:42:10Z');

// A fake agency. agencyWorksOnLocation: the agency token is accepted on a sub-account's endpoints;
// otherwise those answer 401 and only a token from /oauth/locationToken works.
function fakeGhl({ agencyWorksOnLocation = false, locations = [], snapshotValues = true } = {}) {
    const store = { locations: locations.map((l) => ({ ...l })), seq: 1 };
    const calls = [];
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
    const f = async (url, init) => {
        calls.push({ url, init });
        const u = new URL(url);
        const auth = init.headers.Authorization;
        const b = init.body && init.headers['Content-Type'] === 'application/json' ? JSON.parse(init.body) : null;
        if (u.pathname === '/snapshots/') {
            if (auth !== 'Bearer ' + AGENCY || u.searchParams.get('companyId') !== COMPANY) return json({ message: 'no ' + AGENCY }, 401);
            return json({ snapshots: [{ id: 'SnapMasterV10abcdef', name: 'Master v1.0', type: 'own' }] });
        }
        if (u.pathname === '/locations/search') return json({ locations: store.locations.map((l) => ({ id: l.id, name: l.name })) });
        if (u.pathname === '/locations/' && init.method === 'POST') {
            if (auth !== 'Bearer ' + AGENCY) return json({ message: 'agency only' }, 401);
            const id = 'NewLoc' + String(store.seq++).padStart(14, '0');
            const values = snapshotValues ? [
                { id: 'cv1', name: 'Business Name', fieldKey: '{{ custom_values.business_name }}', value: '' },
                { id: 'cv2', name: 'Owner Name', fieldKey: '{{ custom_values.owner_name }}', value: '' },
            ] : [];
            store.locations.push({ id, name: b.name, snapshotId: b.snapshotId, body: b, values, fields: [{ name: 'Do you own the home?' }], pipelines: [{ name: 'Lead Pipeline' }], workflows: [{ name: 'Golden Eye lead webhook', status: 'published' }] });
            return json({ id, name: b.name });
        }
        if (u.pathname === '/oauth/locationToken' && init.method === 'POST') {
            const form = new URLSearchParams(init.body);
            if (auth !== 'Bearer ' + AGENCY || form.get('companyId') !== COMPANY) return json({ message: 'no' }, 401);
            return json({ access_token: LOCTOKEN + ':' + form.get('locationId') });
        }
        const m = u.pathname.match(/^\/locations\/([^/]+)(\/.*)?$/);
        const locId = m ? decodeURIComponent(m[1]) : u.searchParams.get('locationId');
        const loc = store.locations.find((l) => l.id === locId);
        if (u.pathname.startsWith('/locations/') && !m?.[2]) {
            if (!loc) return json({ message: 'not found' }, 404);
            return json({ location: { id: loc.id, name: loc.name } });
        }
        // sub-account endpoints
        const okToken = auth === 'Bearer ' + LOCTOKEN + ':' + locId || (agencyWorksOnLocation && auth === 'Bearer ' + AGENCY);
        if (!okToken) return json({ message: 'The token is not authorized for this scope.' }, 401);
        if (!loc) return json({ message: 'not found' }, 404);
        if (m?.[2] === '/customValues' && init.method === 'GET') return json({ customValues: loc.values });
        const cv = m?.[2]?.match(/^\/customValues\/(.+)$/);
        if (cv && init.method === 'PUT') { const v = loc.values.find((x) => x.id === cv[1]); v.value = b.value; return json({ customValue: v }); }
        if (m?.[2] === '/customFields') return json({ customFields: loc.fields });
        if (u.pathname === '/opportunities/pipelines') return json({ pipelines: loc.pipelines });
        if (u.pathname === '/workflows/') return json({ workflows: loc.workflows });
        return json({ message: 'unknown ' + u.pathname }, 404);
    };
    return { f, calls, store };
}
const fakeDb = (role = 'admin', clientLocs = [CLIENT_LOC]) => ({
    auth: { getUser: async (jwt) => (jwt === 'user-jwt' ? { data: { user: { email: 'a@x.com' } }, error: null } : { data: null, error: { message: 'bad' } }) },
    from: (table) => ({
        select: () => ({
            eq: (col, val) => {
                if (table === 'clients') return { limit: async () => ({ data: clientLocs.includes(val) ? [{ name: 'Some Client' }] : [], error: null }) };
                return { maybeSingle: async () => ({ data: role ? { role } : null, error: null }) };
            },
        }),
    }),
});
const env = { GHL_AGENCY_TOKEN: AGENCY, GHL_COMPANY_ID: COMPANY, GHL_MASTER_LOCATION_ID: MASTER, MAKE_WEBHOOK_SECRET: CRON };
const req = (body, headers = { 'x-cron-secret': CRON }) =>
    new Request('https://x/ghl-provision', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const run = async (body, opts = {}) => {
    const g = opts.ghl ?? fakeGhl();
    const res = await handle(req(body, opts.headers), { env: opts.env ?? env, db: fakeDb(opts.role ?? 'admin'), fetch: g.f, now: () => NOW, sleep: async () => {} });
    const text = await res.text();
    return { status: res.status, json: JSON.parse(text), text, g };
};
const posts = (g, p) => g.calls.filter((c) => c.init.method === 'POST' && new URL(c.url).pathname === p);
const noSecrets = (t) => !t.includes(AGENCY) && !t.includes(LOCTOKEN);

// naming
ok(testName(NOW) === 'GE TEST 2026-10-15 16:42' && testName(NOW).startsWith(TEST_PREFIX), 'test accounts are named "GE TEST <date time>"');

// who may call
let r = await run({ mode: 'snapshots' }, { headers: {} });
ok(r.status === 403 && r.g.calls.length === 0, 'no sign-in, no secret: refused before GHL is called');
r = await run({ mode: 'snapshots' }, { headers: { Authorization: 'Bearer user-jwt' }, role: 'client' });
ok(r.status === 403 && r.g.calls.length === 0, 'a non-admin: refused');
r = await run({ mode: 'snapshots' }, { env: { ...env, GHL_AGENCY_TOKEN: '' } });
ok(r.status === 500 && r.g.calls.length === 0, 'no agency token: refused');

// snapshots
r = await run({ mode: 'snapshots' });
ok(r.status === 200 && r.json.snapshots[0].name === 'Master v1.0' && Array.isArray(r.json.test_accounts), 'lists snapshots and test accounts');
ok(noSecrets(r.text), 'no token in the answer');

// create_test
const g = fakeGhl({ locations: [{ id: MASTER, name: 'Master', values: [] }] });
r = await run({ mode: 'create_test', snapshot_id: 'SnapMasterV10abcdef' }, { ghl: g });
ok(r.json.dry_run && posts(g, '/locations/').length === 0, 'create without confirm creates nothing');
r = await run({ mode: 'create_test', confirm: true }, { ghl: g });
ok(r.status === 400 && posts(g, '/locations/').length === 0, 'no snapshot id: refused');
r = await run({ mode: 'create_test', snapshot_id: 'SnapMasterV10abcdef', confirm: true }, { ghl: g });
const created = posts(g, '/locations/').map((c) => JSON.parse(c.init.body));
ok(r.json.created && created.length === 1, 'confirm creates one account');
ok(created[0].name === 'GE TEST 2026-10-15 16:42' && created[0].snapshotId === 'SnapMasterV10abcdef' && created[0].companyId === COMPANY, 'named GE TEST, from the snapshot, under our company');
ok(created[0].phone === '+15555550123' && created[0].website === 'https://example.com', 'made-up contact details (555 number, example.com)');
const newId = r.json.location_id;
ok(/^NewLoc/.test(newId), 'returns the new location id');

// at most 3 test accounts
const g3 = fakeGhl({ locations: [1, 2, 3].map((i) => ({ id: 'TestLoc00000000000' + i, name: 'GE TEST old ' + i, values: [] })) });
r = await run({ mode: 'create_test', snapshot_id: 'SnapMasterV10abcdef', confirm: true }, { ghl: g3 });
ok(r.status === 409 && posts(g3, '/locations/').length === 0, 'a fourth test account is refused');

// inspect: agency token refused on the sub-account, so it exchanges for a location token
r = await run({ mode: 'inspect', location_id: newId }, { ghl: g });
ok(r.status === 200 && r.json.access === 'location token' && /refused/.test(r.json.access_note), 'agency token refused: exchanged for a location token, and says so');
ok(r.json.values.count === 2 && r.json.values.empty === 2, 'reads the custom values that came with the snapshot, empty');
ok(r.json.fields.count === 1 && r.json.pipelines.names[0] === 'Lead Pipeline' && r.json.workflows.list[0].name === 'Golden Eye lead webhook', 'reads fields, pipelines and workflows');
ok(noSecrets(r.text), 'neither token appears in the answer');
const ltCall = posts(g, '/oauth/locationToken')[0];
ok(new URLSearchParams(ltCall.init.body).get('locationId') === newId, 'location token asked for that account only');

// inspect when the agency token works directly
const gd = fakeGhl({ agencyWorksOnLocation: true, locations: [{ id: 'TestLoc0000000000009', name: 'GE TEST x', values: [], fields: [], pipelines: [], workflows: [] }] });
r = await run({ mode: 'inspect', location_id: 'TestLoc0000000000009' }, { ghl: gd });
ok(r.json.access === 'agency token' && posts(gd, '/oauth/locationToken').length === 0, 'agency token accepted: no exchange');

// guards
r = await run({ mode: 'inspect', location_id: MASTER }, { ghl: g });
ok(r.status === 502 && /Master/.test(r.json.error), 'Master refused');
const gm = fakeGhl({ locations: [{ id: MASTER, name: 'GE TEST renamed master', values: [{ id: 'm1', name: 'Business Name', fieldKey: '{{ custom_values.business_name }}', value: '' }] }] });
r = await run({ mode: 'fill_test', location_id: MASTER, confirm: true }, { ghl: gm });
ok(r.status === 502 && /Master/.test(r.json.error) && !gm.calls.some((c) => c.init.method === 'PUT'), 'Master refused even if someone renamed it GE TEST');
const gc = fakeGhl({ locations: [{ id: CLIENT_LOC, name: 'GE TEST but a client', values: [] }] });
r = await run({ mode: 'fill_test', location_id: CLIENT_LOC, confirm: true }, { ghl: gc });
ok(r.status === 502 && /client/.test(r.json.error) && !gc.calls.some((c) => c.init.method === 'PUT'), 'an account linked to a Golden Eye client is refused, even if named GE TEST');
const gn = fakeGhl({ locations: [{ id: 'RealBiz000000000000a', name: 'Joe Roofing', values: [{ id: 'x', name: 'Business Name', fieldKey: '{{ custom_values.business_name }}', value: 'Joe' }] }] });
r = await run({ mode: 'fill_test', location_id: 'RealBiz000000000000a', confirm: true }, { ghl: gn });
ok(r.status === 502 && /not "GE TEST/.test(r.json.error) && !gn.calls.some((c) => c.init.method === 'PUT' || c.url.includes('locationToken')), 'an account not named GE TEST is refused before any token or write');
r = await run({ mode: 'inspect', location_id: '../../locations' }, { ghl: g });
ok(r.status === 502 && /look like/.test(r.json.error), 'a malformed location id is refused');

// fill_test
r = await run({ mode: 'fill_test', location_id: newId }, { ghl: g });
ok(r.json.dry_run && !g.calls.some((c) => c.init.method === 'PUT'), 'fill without confirm writes nothing');
r = await run({ mode: 'fill_test', location_id: newId, confirm: true }, { ghl: g });
ok(r.json.results.business_name === 'written' && r.json.results.owner_name === 'written', 'writes the two test values');
ok(r.json.read_back.business_name === 'GE Test Co' && r.json.read_back.owner_name === 'Test Owner', 'reads them back');
const puts = g.calls.filter((c) => c.init.method === 'PUT');
ok(puts.length === 2 && puts.every((c) => c.url.includes(newId)), 'writes only to the test account');
ok(noSecrets(r.text), 'no token in the answer');

// a snapshot that brought no custom values: reported, not invented
const ge = fakeGhl({ snapshotValues: false });
r = await run({ mode: 'create_test', snapshot_id: 'SnapMasterV10abcdef', confirm: true }, { ghl: ge });
r = await run({ mode: 'fill_test', location_id: r.json.location_id, confirm: true }, { ghl: ge });
ok(/didn't bring it/.test(r.json.results.business_name) && !ge.calls.some((c) => c.init.method === 'PUT'), 'values missing from the snapshot are reported, never created');

// errors never carry a token
const gx = { f: async () => new Response(JSON.stringify({ message: 'bad token ' + AGENCY }), { status: 401 }), calls: [] };
r = await run({ mode: 'snapshots' }, { ghl: gx });
ok(r.status === 502 && noSecrets(r.text), 'a GHL error echoing the token is scrubbed');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
