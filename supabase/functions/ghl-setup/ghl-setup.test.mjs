// Checks for ghl-setup. Run (node 22.6+):
//   node --experimental-strip-types supabase/functions/ghl-setup/ghl-setup.test.mjs
// Runs the real handler against a fake GHL and a fake database.
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { handle } = await import(pathToFileURL(path.join(here, 'handler.ts')).href);
const { planValues, planPipeline, choicesMissing, keyOf, MASTER_CUSTOM_VALUES, MASTER_CONTACT_FIELDS, MASTER_FIELD_FOLDERS, MASTER_PIPELINE } =
    await import(pathToFileURL(path.join(here, 'plan.ts')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

const TOKEN = 'pit-secret-token-123';
const LOC = 'sXL42Tk6BFlMz8GEe5LQ';
const CRON = 'cron-secret';

// ---- the plan: custom values ----
ok(MASTER_CUSTOM_VALUES.length === 22, 'the plan lists 22 values');
ok(new Set(MASTER_CUSTOM_VALUES.map((w) => w.key)).size === 22, 'keys are unique');
ok(MASTER_CUSTOM_VALUES.every((w) => keyOf({ name: w.name }) === w.key), 'every display name turns into its own key');
ok(keyOf({ name: 'x', fieldKey: '{{ custom_values.physical_address }}' }) === 'physical_address', 'key read from fieldKey');
ok(keyOf({ name: '  Company  Name! ' }) === 'company_name', 'key from a messy name');

const p = planValues([
    { id: 'a', name: 'Physical Address', fieldKey: '{{ custom_values.physical_address }}' },
    { id: 'b', name: 'company name', fieldKey: '{{ custom_values.company_name }}' },
    { id: 'c', name: 'Old Thing', fieldKey: '{{ custom_values.old_thing }}' },
]);
const row = (k) => p.rows.find((r) => r.key === k);
ok(row('company_name').status === 'exists' && row('company_name').id === 'b', 'an existing value matches by key');
ok(row('business_address').status === 'covered_by_alias' && row('business_address').alias === 'physical_address', 'physical_address covers business_address');
ok(p.rows.filter((r) => r.status === 'missing').length === 20, '20 missing');
ok(p.extra.length === 1 && p.extra[0].key === 'old_thing', 'values the plan does not name are listed, the alias is not');
const p2 = planValues([{ id: 'a', name: 'Physical Address' }, { id: 'd', name: 'Business Address' }]);
ok(p2.rows.find((r) => r.key === 'business_address').status === 'exists' && p2.extra.some((e) => e.key === 'physical_address'),
    'a real business_address wins over the alias, and physical_address is then reported as extra');

// Master as the first real check found it (2026-10-14): names and keys only.
const REAL_MASTER = [
    ['Business Phone', 'business_phone'], ['Business Email', 'business_email'], ['Physical Address', 'physical_address'],
    ['Service Area', 'service_area'], ['Business Name', 'business_name'], ['Business Legal Name', 'business_legal_name'],
    ['Logo URL', 'logo_url'], ['Favicon URL', 'favicon_url'], ['Business Niche', 'business_niche'],
    ['Primary Service', 'primary_service'], ['Main Offer', 'main_offer'], ['Google Review Link', 'google_review_link'],
    ['Facebook Page URL', 'facebook_page_url'], ['Instagram Handle', 'instagram_handle'], ['Hours of Operation', 'hours_of_operation'],
    ['Promotion Name', 'promotion_name'], ['Marketing - New Booking Thank You Page URL', 'new_booking_ty_url'],
    ['Marketing - Website Booking Page URL', 'marketing__website_booking_page_url'],
].map(([name, key], i) => ({ id: 'r' + i, name, fieldKey: `{{ custom_values.${key} }}` }));
const real = planValues(REAL_MASTER);
const realMissing = real.rows.filter((x) => x.status === 'missing').map((x) => x.key).sort();
ok(JSON.stringify(realMissing) === JSON.stringify(['asset_link', 'awards', 'business_website', 'call_routing', 'current_offer', 'design_offer',
    'excluded_areas', 'financing_offer', 'owner_name', 'services_list', 'service_radius', 'text_window'].sort()),
    'real Master: exactly the agreed 12 are missing: ' + realMissing.join(','));
ok(real.rows.filter((x) => x.status === 'covered_by_alias').length === 7, 'real Master: 7 covered by Master\'s own names');
ok(real.extra.map((e) => e.key).sort().join(',') === 'business_legal_name,business_niche,favicon_url,logo_url,main_offer,new_booking_ty_url,primary_service,promotion_name',
    'real Master: the 8 unrelated values are listed as extra, untouched');

// ---- the plan: contact fields and pipeline ----
const N_FIELDS = MASTER_CONTACT_FIELDS.length;
const N_CHOICE = MASTER_CONTACT_FIELDS.filter((w) => w.dataType === 'SINGLE_OPTIONS').length;
ok(MASTER_FIELD_FOLDERS.map((f) => f.fields.length).join() === '5,7,11' && N_FIELDS === 23, '3 folders: Lead Info 5, kitchen 7, home builder 11');
ok(new Set(MASTER_CONTACT_FIELDS.map((w) => w.key)).size === N_FIELDS, 'no two fields share a key, across every pack');
ok(MASTER_CONTACT_FIELDS.every((w) => keyOf({ name: w.name }) === w.key), 'each field name turns into its own key (GHL makes the key from the name)');
ok(MASTER_FIELD_FOLDERS[1].fields.every((w) => w.key.startsWith('kitchen_')) && MASTER_FIELD_FOLDERS[2].fields.every((w) => w.key.startsWith('build_')), 'quiz keys carry their trade');
ok(MASTER_CONTACT_FIELDS.filter((w) => w.dataType === 'SINGLE_OPTIONS').every((w) => w.options.length >= 3), 'every choice field has its choices');
ok(MASTER_FIELD_FOLDERS[0].recreate.length === 3 && MASTER_FIELD_FOLDERS.slice(1).every((f) => !f.recreate), 'only today\'s 3 remaining lead fields may be recreated');
ok(keyOf({ name: 'x', fieldKey: 'contact.project_timeline' }) === 'project_timeline', 'contact field key read from fieldKey');
// Master's two existing review fields, as the connector read them
const REAL_FIELDS = [
    { id: 'f1', name: 'Rate Us', fieldKey: 'contact.rate_us', dataType: 'RADIO', picklistOptions: ['5', '4'], parentId: 'REVIEWS', dateAdded: '2026-03-13T16:46:44.945Z' },
    { id: 'f2', name: 'Tell us how we missed mark:', fieldKey: 'contact.tell_us_how_we_missed_mark', dataType: 'LARGE_TEXT', parentId: 'REVIEWS', dateAdded: '2026-03-13T16:52:46.002Z' },
];
const pf = planValues(REAL_FIELDS, MASTER_CONTACT_FIELDS);
ok(pf.rows.every((x) => x.status === 'missing') && pf.extra.length === 2, 'no plan fields yet: all missing, the 2 review fields listed as extra');
const timeline = MASTER_CONTACT_FIELDS.find((w) => w.key === 'project_timeline');
ok(choicesMissing(timeline, { picklistOptions: timeline.options }).length === 0, 'all choices saved: nothing missing');
ok(choicesMissing(timeline, { picklistOptions: [] }).length === 5, 'saved with no choices: all 5 reported');
ok(choicesMissing(MASTER_CONTACT_FIELDS.find((w) => w.dataType === 'TEXT'), {}).length === 0, 'a text field has no choices to miss');
ok(planPipeline([{ id: 'x', name: 'Kitchen Remodel Program', stages: [] }]).status === 'missing', 'real Master: no Lead Pipeline yet');
const pp = planPipeline([{ id: 'y', name: 'lead pipeline', stages: [{ name: 'New lead' }, { name: 'Won' }] }]);
ok(pp.status === 'exists' && pp.missing_stages.length === 4, 'pipeline matched by name, case-insensitive; missing stages reported');

// Today's 4 lead fields as the second run left them: unfiled (GHL's default folder), added today.
const TODAYS_FOUR = MASTER_FIELD_FOLDERS[0].fields.slice(0, 3).map((w, i) => ({
    id: 't' + i, name: w.name, fieldKey: `contact.${w.key}`, dataType: w.dataType, picklistOptions: w.options ?? undefined,
    parentId: 'DEFAULT', dateAdded: '2026-10-14T21:18:2' + i + '.000Z',
}));

// ---- the handler ----
// A fake GHL holding values, contact fields (with folders) and pipelines for Master only.
//   foldersApi: GHL lists and creates contact-field folders on the newer endpoint (undocumented)
//   v2Fields:   GHL accepts contact fields on the newer endpoint; otherwise 422 there
//   oldTakesParent: the older endpoint honours parentId
function fakeGhl({ values = [], fields = [], pipelines = [], folders = [], failOn = null, status = 200, pipelineRejectsV3 = false,
                   dropOptions = false, foldersApi = true, v2Fields = true, oldTakesParent = true } = {}) {
    const store = { seq: 100, values: values.map((v) => ({ ...v })), fields: fields.map((f) => ({ ...f })), pipelines: pipelines.map((x) => ({ ...x })), folders: folders.map((x) => ({ ...x })) };
    const calls = [];
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
    const addField = (b, parentId, options) => {
        const fl = { id: 'f' + (++store.seq), name: b.name, model: 'contact', dataType: b.dataType, fieldKey: b.fieldKey ?? `contact.${keyOf({ name: b.name })}`,
            picklistOptions: dropOptions ? [] : options, parentId: parentId ?? 'DEFAULT', dateAdded: '2026-10-14T22:00:00.000Z' };
        store.fields.push(fl);
        return fl;
    };
    const f = async (url, init) => {
        calls.push({ url, init });
        if (status !== 200) return json({ message: 'nope ' + TOKEN + ' ' + LOC }, status);
        const u = new URL(url);
        const b = init.body ? JSON.parse(init.body) : null;
        if (b?.name && b.name === failOn) return json({ message: 'refused' }, 422);
        if (u.pathname === `/locations/${LOC}/customValues`) {
            if (init.method === 'GET') return json({ customValues: store.values });
            const v = { id: 'v' + store.values.length, name: b.name, fieldKey: `{{ custom_values.${keyOf({ name: b.name })} }}`, value: b.value };
            store.values.push(v);
            return json({ customValue: v }, 201);
        }
        if (u.pathname === `/locations/${LOC}/customFields`) {
            if (init.method === 'GET') return json({ customFields: store.fields });
            return json({ customField: addField(b, oldTakesParent ? b.parentId : undefined, b.options ?? []) }, 201);
        }
        const del = u.pathname.match(new RegExp(`^/locations/${LOC}/customFields/(.+)$`));
        if (del && init.method === 'PUT') {
            const fl = store.fields.find((x) => x.id === decodeURIComponent(del[1]));
            if (!fl) return json({ message: 'not found' }, 404);
            fl.name = b.name;
            if (fl.dataType === 'SINGLE_OPTIONS') fl.picklistOptions = b.options ?? [];
            return json({ customField: fl });
        }
        if (del && init.method === 'DELETE') {
            const i = store.fields.findIndex((x) => x.id === decodeURIComponent(del[1]));
            if (i < 0) return json({ message: 'not found' }, 404);
            store.fields.splice(i, 1);
            return json({ succeded: true });
        }
        if (u.pathname === '/custom-fields/object-key/contact') {
            if (!foldersApi || u.searchParams.get('locationId') !== LOC) return json({ message: 'Only custom objects' }, 400);
            return json({ fields: store.fields, folders: store.folders });
        }
        if (u.pathname === '/custom-fields/folder' && init.method === 'POST') {
            if (!foldersApi || b.locationId !== LOC || b.objectKey !== 'contact') return json({ message: 'Only custom objects' }, 400);
            const fo = { id: 'folder' + store.folders.length, name: b.name };
            store.folders.push(fo);
            return json(fo, 201);
        }
        if (u.pathname === '/custom-fields/' && init.method === 'POST') {
            if (!v2Fields || b.locationId !== LOC) return json({ message: 'Only custom objects' }, 422);
            if (store.fields.some((x) => x.fieldKey === b.fieldKey)) return json({ message: 'key taken' }, 422);
            return json({ field: addField(b, b.parentId, (b.options ?? []).map((o) => o.label)) }, 201);
        }
        if (u.pathname === '/opportunities/pipelines') {
            if (init.method === 'GET') return u.searchParams.get('locationId') === LOC ? json({ pipelines: store.pipelines }) : json({ message: 'wrong location' }, 403);
            if (pipelineRejectsV3 && init.headers.Version === 'v3') return json({ message: 'bad version' }, 400);
            if (b.locationId !== LOC) return json({ message: 'wrong location' }, 403);
            if (store.pipelines.some((x) => x.name.toLowerCase() === b.name.toLowerCase())) return json({ message: 'name taken' }, 422);
            const pl = { id: 'p' + store.pipelines.length, name: b.name, stages: b.stages.map((s) => ({ id: s.name, name: s.name })) };
            store.pipelines.push(pl);
            return json({ pipeline: pl }, 201);
        }
        return json({ message: 'unknown path' }, 404);
    };
    return { f, calls, store };
}
const fakeDb = (role) => ({
    auth: { getUser: async (jwt) => (jwt === 'user-jwt' ? { data: { user: { email: 'a@x.com' } }, error: null } : { data: null, error: { message: 'bad' } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: role ? { role } : null, error: null }) }) }) }),
});
const env = { GHL_MASTER_TOKEN: TOKEN, GHL_MASTER_LOCATION_ID: LOC, MAKE_WEBHOOK_SECRET: CRON };
const req = (body, headers = { 'x-cron-secret': CRON }) =>
    new Request('https://x/ghl-setup', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const run = async (body, opts = {}) => {
    const g = opts.ghl ?? fakeGhl();
    const res = await handle(req(body, opts.headers), { env: opts.env ?? env, db: fakeDb(opts.role ?? 'admin'), fetch: g.f, sleep: async (ms) => { g.slept = (g.slept ?? 0) + ms; } });
    return { status: res.status, json: await res.json(), g };
};
const writes = (g) => g.calls.filter((c) => c.init.method !== 'GET');

// who may call
let r = await run({}, { headers: {} });
ok(r.status === 403 && r.g.calls.length === 0, 'no sign-in and no secret: refused before GHL is called');
r = await run({}, { headers: { 'x-cron-secret': 'wrong' } });
ok(r.status === 403 && r.g.calls.length === 0, 'wrong cron secret: refused');
r = await run({}, { headers: { Authorization: 'Bearer user-jwt' }, role: 'client' });
ok(r.status === 403 && r.g.calls.length === 0, 'a signed-in non-admin: refused');
r = await run({}, { headers: { Authorization: 'Bearer user-jwt' }, role: 'admin' });
ok(r.status === 200, 'a signed-in admin: allowed');
r = await run({});
ok(r.status === 200, 'the cron secret: allowed');
r = await run({}, { env: { ...env, GHL_MASTER_LOCATION_ID: '' } });
ok(r.status === 500 && r.g.calls.length === 0, 'no location secret: refused, nothing called');

// check: reads all three, writes nothing
const g1 = fakeGhl({ values: [{ id: 'a', name: 'Physical Address', fieldKey: '{{ custom_values.physical_address }}' }], fields: REAL_FIELDS });
r = await run({ mode: 'check' }, { ghl: g1 });
ok(r.json.dry_run && r.json.values.missing.length === 21, 'check: 21 values missing when only physical_address exists');
ok(r.json.fields.missing.length === N_FIELDS && r.json.pipeline.status === 'missing', 'check: all 25 fields and the pipeline missing');
ok(writes(g1).length === 0, 'check only reads');
ok(g1.calls[0].init.headers.Authorization === 'Bearer ' + TOKEN && g1.calls[0].init.headers.Version === '2021-07-28', 'token and Version header sent');
ok(!JSON.stringify(r.json).includes(TOKEN), 'the token never appears in the answer');

// location from the secret only
const g2 = fakeGhl();
r = await run({ mode: 'check', location: 'SOME_CLIENT', locationId: 'SOME_CLIENT' }, { ghl: g2 });
ok(g2.calls.every((c) => !c.url.includes('SOME_CLIENT')) && g2.calls.every((c) => c.url.includes(LOC)), 'a location in the request is ignored');

// create without confirm writes nothing
const g3 = fakeGhl();
r = await run({ mode: 'create' }, { ghl: g3 });
ok(r.json.dry_run && writes(g3).length === 0, 'create without confirm writes nothing');
r = await run({ mode: 'create', confirm: 'true' }, { ghl: g3 });
ok(writes(g3).length === 0, 'confirm must be the boolean true, not a string');
r = await run({ mode: 'delete' });
ok(r.status === 400, 'unknown mode refused');

// create with confirm, on Master as it really is now: 22 values, 2 review fields in their own folder,
// today's 4 lead fields unfiled, 3 client pipelines plus Lead Pipeline.
const valuesNow = [...REAL_MASTER, ...['Owner Name', 'Business Website', 'Awards', 'Asset Link', 'Call Routing', 'Text Window', 'Service Radius',
    'Excluded Areas', 'Services List', 'Financing Offer', 'Design Offer', 'Current Offer'].map((n, i) => ({ id: 'n' + i, name: n, fieldKey: `{{ custom_values.${keyOf({ name: n })} }}` }))];
const masterNow = () => fakeGhl({
    values: valuesNow, fields: [...REAL_FIELDS, ...TODAYS_FOUR], folders: [{ id: 'REVIEWS', name: 'Reviews' }],
    pipelines: [{ id: 'k', name: 'Kitchen Remodel Program', stages: [] }],
});
const g4 = masterNow();
r = await run({ mode: 'check' }, { ghl: g4 });
ok(r.json.fields.missing.length === N_FIELDS - 3 && r.json.fields.outside_folder.length === 3, 'check on Master now: 20 to create, today\'s 3 outside a folder');
ok(r.json.fields.folders.every((f) => f.folder_id === null) && r.json.fields.folders_listed, 'check: none of the 3 folders exist yet');
r = await run({ mode: 'create', confirm: true }, { ghl: g4 });
ok(r.json.values.created.length === 0, 'values already complete: none created');
ok(r.json.fields.folders_created.join('|') === 'Lead Info|Cost Quiz: Kitchen Remodel|Cost Quiz: Home Builder', 'creates the 3 folders');
ok(r.json.fields.created.length === N_FIELDS - 3 && r.json.fields.recreated.length === 3 && r.json.fields.failed.length === 0, 'creates 20 fields and recreates today\'s 3');
ok(r.json.fields.still_missing.length === 0 && r.json.fields.outside_folder.length === 0, 'read back: all 23 present, all filed');
ok(r.json.fields.choices_missing.length === 0, 'read back: every choice field has every choice: ' + JSON.stringify(r.json.fields.choices_missing));
const fid = (name) => g4.store.folders.find((x) => x.name === name).id;
const inFolder = (name) => g4.store.fields.filter((x) => x.parentId === fid(name)).map((x) => keyOf(x));
ok(inFolder('Lead Info').length === 5 && inFolder('Cost Quiz: Kitchen Remodel').length === 7 && inFolder('Cost Quiz: Home Builder').length === 11, 'each field landed in its own folder');
ok(g4.store.fields.filter((x) => x.parentId === 'REVIEWS').length === 2, 'the 2 review fields are untouched, in their own folder');
const deletes = writes(g4).filter((c) => c.init.method === 'DELETE').map((c) => c.url.split('/').pop());
ok(deletes.sort().join() === 't0,t1,t2', 'only today\'s 3 were deleted, nothing else');
const v2posts = writes(g4).filter((c) => c.url.endsWith('/custom-fields/')).map((c) => JSON.parse(c.init.body));
ok(v2posts.length === N_FIELDS && v2posts.every((b) => b.objectKey === 'contact' && MASTER_CONTACT_FIELDS.some((w) => b.fieldKey === 'contact.' + w.key && b.name === w.question) && b.parentId), 'newer endpoint: contact object, the planned key, named as the question, a folder');
const kitchenSize = v2posts.find((b) => b.name === 'How big is your kitchen?');
ok(kitchenSize.dataType === 'SINGLE_OPTIONS' && kitchenSize.options[0].label === 'Small (under 100 sq ft)' && kitchenSize.options[0].key === 'small_under_100_sq_ft', 'choices sent as key and label');
ok(r.json.pipeline.created === false && r.json.pipeline.status === 'exists' || r.json.pipeline.created === true, 'pipeline section still runs');
ok(g4.slept > 0, 'waits before reading back after a write');
const nWrites = writes(g4).length;
r = await run({ mode: 'create', confirm: true }, { ghl: g4 });
ok(writes(g4).length === nWrites && r.json.fields.created.length === 0 && r.json.fields.recreated.length === 0, 'running it again writes nothing');

// questions: GHL shows a field's name as the question
ok(MASTER_CONTACT_FIELDS.every((w) => w.question.endsWith('?')), 'every asked field is named as a question');
ok(new Set(MASTER_CONTACT_FIELDS.map((w) => w.question.toLowerCase())).size === N_FIELDS, 'no two fields ask the same question');
const allKeys = MASTER_CONTACT_FIELDS.flatMap((w) => [w.key, ...(w.aliases ?? [])]);
ok(new Set(allKeys).size === allKeys.length, 'no key or question-made key is shared by two fields, across every pack');
ok(r.json.fields.to_rename.length === 0, 'fields made or recreated in this run already carry their question');

// rename: Master as it really is after the 2026-10-14 runs (all 25 under short names, unfiled, no folder API)
const shortNamed = MASTER_CONTACT_FIELDS.map((w, i) => ({ id: 's' + i, name: w.name, fieldKey: `contact.${w.key}`, dataType: w.dataType,
    picklistOptions: w.options, parentId: 'DEFAULT', dateAdded: '2026-10-14T22:07:0' + (i % 10) + '.000Z' }));
const g4r = fakeGhl({ fields: [...REAL_FIELDS, ...shortNamed], foldersApi: false });
r = await run({ mode: 'check' }, { ghl: g4r });
ok(r.json.fields.to_rename.length === N_FIELDS && r.json.fields.to_rename.find((x) => x.name === 'Kitchen Size').to === 'How big is your kitchen?', 'check lists all 23 renames');
ok(writes(g4r).length === 0, 'check renames nothing');
r = await run({ mode: 'create', confirm: true }, { ghl: g4r });
ok(r.json.fields.renamed.length === N_FIELDS && r.json.fields.failed.length === 0 && r.json.fields.created.length === 0, 'renames 23, creates nothing');
ok(r.json.fields.to_rename.length === 0 && r.json.fields.choices_missing.length === 0, 'read back: every name is its question, every choice survived');
ok(g4r.store.fields.filter((x) => x.id.startsWith('s')).every((x, i) => x.fieldKey === shortNamed[i].fieldKey), 'renaming kept every key');
ok(!writes(g4r).some((c) => /custom-?[fF]ields/.test(c.url) && (c.init.method === 'DELETE' || c.init.method === 'POST')), 'a rename never deletes or creates a field');
ok(g4r.store.fields.find((x) => x.id === 'f1').name === 'Rate Us', 'fields outside the plan are never renamed');
const putBodies = writes(g4r).filter((c) => c.init.method === 'PUT').map((c) => JSON.parse(c.init.body));
ok(putBodies.filter((b) => b.options).length === N_CHOICE, 'every choice field\'s rename resends its choices');
const nR = writes(g4r).length;
r = await run({ mode: 'create', confirm: true }, { ghl: g4r });
ok(writes(g4r).length === nR, 'running it again renames nothing');

// a new field made where GHL picks the key from the question: matched by that key, never made twice
const g4q = fakeGhl({ foldersApi: false });
r = await run({ mode: 'create', confirm: true }, { ghl: g4q });
ok(g4q.store.fields.find((x) => x.name === 'How big is your kitchen?').fieldKey === 'contact.how_big_is_your_kitchen', 'unfiled create: GHL made the key from the question');
const nQ = writes(g4q).length;
r = await run({ mode: 'create', confirm: true }, { ghl: g4q });
ok(writes(g4q).length === nQ && r.json.fields.missing.length === 0, 'question-made keys count as present: nothing made twice');

// safety: a recreatable key that is NOT from today is never deleted, only reported
const oldOne = { ...TODAYS_FOUR[0], id: 'old', dateAdded: '2026-05-01T00:00:00.000Z' };
const g4b = fakeGhl({ fields: [oldOne] });
r = await run({ mode: 'create', confirm: true }, { ghl: g4b });
ok(!writes(g4b).some((c) => c.init.method === 'DELETE') && r.json.fields.outside_folder.includes('Project Timeline'), 'an older field outside the folder is reported, never deleted');

// safety: a field made today that isn't one of the 4 allowed (say someone built a quiz field by hand) is never deleted
const handMade = { id: 'hand', name: 'Kitchen Size', fieldKey: 'contact.kitchen_size', dataType: 'SINGLE_OPTIONS', picklistOptions: [], parentId: 'DEFAULT', dateAdded: '2026-10-14T23:00:00.000Z' };
const g4h = fakeGhl({ fields: [handMade] });
r = await run({ mode: 'create', confirm: true }, { ghl: g4h });
ok(!writes(g4h).some((c) => c.init.method === 'DELETE') && r.json.fields.outside_folder.includes('Kitchen Size'), 'a same-day field not on the allow-list is reported, never deleted');

// GHL won't list contact folders: no folder is created (it could be made twice), nothing is deleted, fields go in unfiled
const g4c = fakeGhl({ fields: [...TODAYS_FOUR], foldersApi: false });
r = await run({ mode: 'create', confirm: true }, { ghl: g4c });
ok(!writes(g4c).some((c) => c.url.includes('/custom-fields/folder')) && !writes(g4c).some((c) => c.init.method === 'DELETE'), 'no folder API: no folder made, nothing deleted');
ok(r.json.fields.created.length === N_FIELDS - 3 && r.json.fields.outside_folder.length === N_FIELDS && !r.json.fields.folders_listed && r.json.fields.folders_error, 'no folder API: fields created unfiled, and it says so');

// the newer endpoint refuses contact fields: the older one gets parentId, and the read-back confirms the filing
const g4d = fakeGhl({ v2Fields: false });
r = await run({ mode: 'create', confirm: true }, { ghl: g4d });
ok(r.json.fields.created.length === N_FIELDS && r.json.fields.outside_folder.length === 0, 'newer endpoint refused: older one files them');
const g4e = fakeGhl({ v2Fields: false, oldTakesParent: false });
r = await run({ mode: 'create', confirm: true }, { ghl: g4e });
ok(r.json.fields.created.length === N_FIELDS && r.json.fields.outside_folder.length === N_FIELDS, 'neither endpoint files them: created, and reported as outside their folder');

// an existing folder is reused, never made twice
const g4f = fakeGhl({ folders: [{ id: 'LI', name: 'lead info' }] });
r = await run({ mode: 'create', confirm: true }, { ghl: g4f });
ok(g4f.store.folders.filter((x) => x.name.toLowerCase() === 'lead info').length === 1 && g4f.store.fields.filter((x) => x.parentId === 'LI').length === 5, 'existing Lead Info folder reused (name match ignores case)');

// pipeline created on a Master without one
const g4g = fakeGhl({ pipelines: [{ id: 'k', name: 'Kitchen Remodel Program', stages: [] }] });
r = await run({ mode: 'create', confirm: true }, { ghl: g4g });
ok(r.json.pipeline.created === true && r.json.pipeline.status === 'exists' && r.json.pipeline.missing_stages.length === 0, 'pipeline created with all 6 stages');
const pipePost = writes(g4g).find((c) => c.url.endsWith('/opportunities/pipelines'));
ok(pipePost.init.headers.Version === 'v3' && JSON.parse(pipePost.init.body).locationId === LOC, 'pipeline posted with Version v3 and Master\'s location');
ok(JSON.parse(pipePost.init.body).stages.map((s) => s.position).join() === '0,1,2,3,4,5', 'stages in order');
ok(g4g.store.pipelines.find((x) => x.name === 'Kitchen Remodel Program') && r.json.pipeline.other_pipelines.includes('Kitchen Remodel Program'), 'existing pipelines untouched and listed');

// GHL saves a choice field without its choices: reported, not hidden
const g5 = fakeGhl({ dropOptions: true });
r = await run({ mode: 'create', confirm: true }, { ghl: g5 });
ok(r.json.fields.choices_missing.length === N_CHOICE && r.json.fields.choices_missing.every((c) => c.missing.length >= 3), 'choices GHL dropped are reported per field');

// pipeline: v3 refused, retried once with 2021-07-28
const g6 = fakeGhl({ pipelineRejectsV3: true });
r = await run({ mode: 'create', confirm: true }, { ghl: g6 });
const pipePosts = writes(g6).filter((c) => c.url.endsWith('/opportunities/pipelines'));
ok(pipePosts.length === 2 && pipePosts[1].init.headers.Version === '2021-07-28', 'v3 refused: one retry with 2021-07-28');
ok(r.json.pipeline.created === true && g6.store.pipelines.length === 1, 'retry created exactly one pipeline');

// one refusal is reported, the rest still go, and the other sections still run
const g7 = fakeGhl({ failOn: 'Awards' });
r = await run({ mode: 'create', confirm: true }, { ghl: g7 });
ok(r.json.values.failed.length === 1 && r.json.values.failed[0].name === 'Awards' && r.json.values.created.length === 21, 'one 422 reported, the rest created');
ok(r.json.values.still_missing.length === 1 && r.json.values.still_missing[0] === 'Awards', 'read back shows Awards still missing');
ok(r.json.fields.created.length === N_FIELDS && r.json.pipeline.created === true, 'a value failure does not stop fields or the pipeline');

// GHL refuses the token
const g8 = fakeGhl({ status: 401 });
r = await run({ mode: 'check' }, { ghl: g8 });
ok(r.status === 502 && /scope/.test(r.json.error), '401 explained as a scope problem');
ok(!JSON.stringify(r.json).includes(TOKEN) && !JSON.stringify(r.json).includes(LOC), 'answer scrubbed of the token and location id');

const badToken = async () => new Response('{"statusCode":401,"message":"Invalid JWT"}', { status: 401 });
const res9 = await handle(req({ mode: 'check' }), { env, db: fakeDb('admin'), fetch: badToken, sleep: async () => {} });
const j9 = await res9.json();
ok(/doesn't recognise GHL_MASTER_TOKEN/.test(j9.error) && !/scope/.test(j9.error), '"Invalid JWT" is explained as a bad token value, not a scope');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
