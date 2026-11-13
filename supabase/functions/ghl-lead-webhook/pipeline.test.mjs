// The portal pipeline hand-off (client_pipeline.sql): after recording a contact, the webhook passes its name, phone and email
// to add_pipeline_lead for each linked client, and a failure there never costs the contact record.
// Run: node --experimental-strip-types pipeline.test.mjs
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "svc" })[k] }, serve: () => {} };

let clients = [{ name: "PANDEN Construction", loc: "L1" }];
let recorded = [], piped = [], pipeStatus = 200, logs = [];
globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/rest/v1/clients")) {
        const loc = decodeURIComponent(u.split("ghl_location_id=eq.")[1]);
        return new Response(JSON.stringify(clients.filter((c) => c.loc === loc)), { status: 200 });
    }
    if (u.includes("/rpc/record_ghl_contact")) { recorded.push(JSON.parse(init.body)); return new Response("", { status: 200 }); }
    if (u.includes("/rpc/add_pipeline_lead")) {
        piped.push(JSON.parse(init.body));
        if (pipeStatus === "throw") throw new Error("network down");
        return new Response(pipeStatus === 200 ? "true" : "nope", { status: pipeStatus });
    }
    throw new Error("unexpected fetch " + u);
};
const realLog = console.log, realWarn = console.warn;
console.log = (...a) => logs.push(a.join(" ")); console.warn = (...a) => logs.push(a.join(" "));
const { recordContact, pipelineFields } = await import("./index.ts");

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; if (!ok) realLog("FAIL " + name); };
const payload = { contact_id: "c1", location: { id: "L1" }, first_name: "Jane", last_name: "Doe", phone: "+18015550100", email: "jane@example.com", tags: "ge lead" };

check("full name preferred", pipelineFields({ full_name: "Jane Q Doe", first_name: "Jane" }).name === "Jane Q Doe");
check("first + last when no full name", pipelineFields(payload).name === "Jane Doe");
check("nested contact shape", pipelineFields({ contact: { name: "Bo", phone: "1", email: "b@x.com" } }).email === "b@x.com");
check("nothing given: nulls", pipelineFields({}).name === null && pipelineFields({}).phone === null);

await recordContact(payload);
check("recorded first, then handed to the pipeline", recorded.length === 1 && piped.length === 1);
check("with the client, contact id, name, phone and email", piped[0].p_client === "PANDEN Construction" && piped[0].p_contact === "c1" && piped[0].p_name === "Jane Doe" && piped[0].p_phone === "+18015550100" && piped[0].p_email === "jane@example.com");
check("the log names the client, never the lead", logs.some((l) => /PIPELINE added for PANDEN/.test(l)) && !logs.some((l) => /Jane|5550100|example\.com/.test(l)));

for (const st of [404, 500, "throw"]) {
    pipeStatus = st; recorded = []; piped = [];
    let n = -1, err = null;
    try { n = await recordContact(payload); } catch (e) { err = e; }
    check(`pipeline ${st}: the contact is still recorded and nothing throws`, !err && n === 1 && recorded.length === 1);
}

console.log = realLog; console.warn = realWarn;
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
