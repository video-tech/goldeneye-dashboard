// Wix embedded-form leads. Run: node --experimental-strip-types wix-embed.test.mjs
// A GHL form inside a Wix "Embed HTML" box reports www-<site>.filesusr.com as its landing page.
// These run the real decide() against a fake clients table and lead_sources insert.

globalThis.Deno = {
    env: { get: (k) => ({ SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "svc" })[k] },
    serve: () => {},
};

let clients = [];
let inserted = [];
globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/rest/v1/clients")) {
        const loc = decodeURIComponent(u.split("ghl_location_id=eq.")[1]);
        return new Response(JSON.stringify(clients.filter((c) => c.loc === loc)), { status: 200 });
    }
    if (u.includes("/rest/v1/lead_sources")) {
        inserted.push(JSON.parse(init.body));
        return new Response(null, { status: 201 });
    }
    throw new Error("unexpected fetch " + u);
};

const { decide, wixEmbedSite } = await import("./index.ts");

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log((ok ? "ok   " : "FAIL ") + name); };

const lead = (loc, url, referrer, extra = {}) => ({
    contact_id: "c" + Math.random(),
    location: { id: loc },
    contact: { attributionSource: { url, referrer, medium: "form", sessionSource: "Referral", ...extra } },
});

const PANDEN = { loc: "L1", name: "PANDEN Construction", gsc_property: "sc-domain:pandenconstruction.com", lead_hosts: null };
const HYPHEN = { loc: "L2", name: "3Sixty", gsc_property: "sc-domain:3sixty-industries.com", lead_hosts: null };
const MIDAS = { loc: "L3", name: "Midas Media", gsc_property: "sc-domain:midasmediafirm.com", lead_hosts: ["midasmediafirm.com", "goldeneye.midasmediafirm.com"] };
const URLX = "https://www-pandenconstruction-com.filesusr.com/html/bd881c_e69e04375e1ed90129e7af93e856b4c1.html";

// wixEmbedSite
check("www embed maps to www host", wixEmbedSite("www-pandenconstruction-com.filesusr.com", "pandenconstruction.com") === "www.pandenconstruction.com");
check("bare embed maps to bare domain", wixEmbedSite("pandenconstruction-com.filesusr.com", "pandenconstruction.com") === "pandenconstruction.com");
check("hyphenated domain matches", wixEmbedSite("www-3sixty-industries-com.filesusr.com", "3sixty-industries.com") === "www.3sixty-industries.com");
check("another site's embed does not match", wixEmbedSite("www-calibercabinetsut-com.filesusr.com", "pandenconstruction.com") === null);
check("lookalike prefix does not match", wixEmbedSite("www-evilpandenconstruction-com.filesusr.com", "pandenconstruction.com") === null);
check("not a filesusr host", wixEmbedSite("www-pandenconstruction-com.example.com", "pandenconstruction.com") === null);
check("subdomain of filesusr label does not match", wixEmbedSite("x.www-pandenconstruction-com.filesusr.com", "pandenconstruction.com") === null);
check("null host", wixEmbedSite(null, "pandenconstruction.com") === null);

// decide(): the real PANDEN case, as logged on 2026-10-20
clients = [PANDEN]; inserted = [];
let d = await decide(lead("L1", URLX, "https://www.pandenconstruction.com/contact"));
check("PANDEN embed lead is stored", d.stored === true && d.client === "PANDEN Construction");
check("one row written", inserted.length === 1);
check("landing host is the site, not filesusr", inserted[0]?.landing_host === "www.pandenconstruction.com");
check("landing path is the page the form is on", inserted[0]?.landing_path === "/contact");
check("source is unknown, marked wix_embed", inserted[0]?.source === "unknown" && inserted[0]?.source_detail === "wix_embed");
check("lead type is form", inserted[0]?.lead_type === "form");

// a referrer that is origin only gives the home page
inserted = [];
d = await decide(lead("L1", URLX, "https://www.pandenconstruction.com/"));
check("origin-only referrer: stored, path /", d.stored && inserted[0]?.landing_path === "/");

// UTM tags on the embed URL still win
inserted = [];
d = await decide(lead("L1", URLX + "?utm_source=google&utm_medium=organic", "https://www.pandenconstruction.com/contact"));
check("organic tag on the embed counts as organic", d.stored && inserted[0]?.source === "organic" && inserted[0]?.source_detail === "google");

// another Wix site's embed on PANDEN's sub-account is still refused
inserted = [];
d = await decide(lead("L1", "https://www-calibercabinetsut-com.filesusr.com/html/x.html", "https://calibercabinetsut.com/"));
check("someone else's embed is refused", !d.stored && d.reason === "landing page is not on the client's website" && inserted.length === 0);

// hyphenated domain end to end
clients = [HYPHEN]; inserted = [];
d = await decide(lead("L2", "https://www-3sixty-industries-com.filesusr.com/html/x.html", "https://www.3sixty-industries.com/contact"));
check("hyphenated domain embed stored", d.stored && inserted[0]?.landing_host === "www.3sixty-industries.com");

// lead_hosts is checked against the site host, not filesusr
clients = [MIDAS]; inserted = [];
d = await decide(lead("L3", "https://www-midasmediafirm-com.filesusr.com/html/x.html", "https://midasmediafirm.com/"));
check("embed on an allowed lead host (www stripped) is stored", d.stored);
inserted = [];
d = await decide(lead("L3", "https://everoakcabinetry-midasmediafirm-com.filesusr.com/html/x.html", "https://everoakcabinetry.midasmediafirm.com/"));
check("embed for a client landing page under Midas is not Midas's", !d.stored && inserted.length === 0);

// unchanged behaviour
clients = [PANDEN]; inserted = [];
d = await decide(lead("L1", "https://go.pandenconstruction.com/basement-finishing-cost-quiz?utm_source=fb&utm_medium=paid", "https://m.facebook.com/"));
check("funnel lead unchanged: stored as paid on go.", d.stored && inserted[0]?.source === "paid" && inserted[0]?.landing_host === "go.pandenconstruction.com");
inserted = [];
d = await decide(lead("L1", "https://www.pandenconstruction.com/contact", "https://www.pandenconstruction.com/"));
check("plain self-referral keeps its old detail", d.stored && inserted[0]?.source_detail === "self_referral");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
