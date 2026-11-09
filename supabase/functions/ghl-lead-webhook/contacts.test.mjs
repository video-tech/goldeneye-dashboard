// Every contact is recorded for the report's Leads check. Run: node --experimental-strip-types contacts.test.mjs
// Runs the real recordContact() and contactTags() against a fake clients table and RPC.

globalThis.Deno = {
    env: { get: (k) => ({ SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "svc" })[k] },
    serve: () => {},
};

let clients = [];
let calls = [];
let rpcStatus = 200;
globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/rest/v1/clients")) {
        const loc = decodeURIComponent(u.split("ghl_location_id=eq.")[1]);
        return new Response(JSON.stringify(clients.filter((c) => c.loc === loc)), { status: 200 });
    }
    if (u.includes("/rest/v1/rpc/record_ghl_contact")) {
        calls.push(JSON.parse(init.body));
        return new Response(rpcStatus === 200 ? "" : "boom", { status: rpcStatus });
    }
    throw new Error("unexpected fetch " + u);
};

const { recordContact, contactTags } = await import("./index.ts");

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; if (!ok) console.log("FAIL " + name); };

// Tags in every shape GHL sends them
check("comma string", JSON.stringify(contactTags({ tags: "FB Lead, quiz ,," })) === '["fb lead","quiz"]');
check("array, and under contact, merged", JSON.stringify(contactTags({ tags: ["a"], contact: { tags: "B,a" } })) === '["a","b"]');
check("empty string (Contact Created arrives like this)", contactTags({ tags: "" }).length === 0);
check("none at all", contactTags({}).length === 0);

clients = [{ loc: "L1", name: "Acme", gsc_property: null }];
const payload = {
    contact_id: "c1", location: { id: "L1" }, date_created: "2026-11-03T16:00:00Z", tags: "fb lead", contact_source: "facebook form",
    first_name: "Jane", email: "jane@x.com", phone: "+18015550100", full_address: "1 Main St",
};
let n = await recordContact(payload);
check("recorded for the linked client", n === 1 && calls.length === 1);
const c = calls[0];
check("sends id, client, location, created date, tags and source", c.p_contact === "c1" && c.p_client === "Acme" && c.p_location === "L1" && c.p_created === "2026-11-03T16:00:00.000Z" && JSON.stringify(c.p_tags) === '["fb lead"]' && c.p_source === "facebook form");
check("nothing personal is sent", !/jane|8015550100|Main St/i.test(JSON.stringify(c)));
check("recorded even with no landing page or Search Console (a Meta form lead)", n === 1);

calls = [];
check("unlinked sub-account: nothing recorded", (await recordContact({ contact_id: "c2", location: { id: "nope" } })) === 0 && calls.length === 0);
check("no contact id: nothing", (await recordContact({ location: { id: "L1" } })) === 0);
check("not JSON: nothing", (await recordContact(null)) === 0);

clients = [{ loc: "S", name: "Sunset", gsc_property: null }, { loc: "S", name: "Other", gsc_property: null }];
calls = [];
check("shared sub-account: recorded under each linked client", (await recordContact({ contact_id: "c3", location: { id: "S" } })) === 2 && calls.map((x) => x.p_client).join() === "Sunset,Other");

clients = [{ loc: "L1", name: "Acme", gsc_property: null }];
rpcStatus = 404;
check("before the SQL: skipped quietly, so website leads still work", (await recordContact(payload)) === 0);
rpcStatus = 500;
let threw = false;
try { await recordContact(payload); } catch { threw = true; }
check("a database failure throws, so GHL retries", threw);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
