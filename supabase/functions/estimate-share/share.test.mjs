// Run: node --experimental-strip-types supabase/functions/estimate-share/share.test.mjs
// Runs the real handler.ts and validate.ts against an in-memory fake of the two Supabase clients.
import { handle, DEFAULT_VIEW_URL, MAX_LINKS_PER_HOUR } from "./handler.ts";
import { validateShare, mountainDate } from "./validate.ts";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

// ---- fakes ----
function makeDb(tables) {
    class Q {
        constructor(t) { this.t = t; this.f = []; this.lim = Infinity; this.op = "select"; this.patch = null; this.ins = null; }
        select() { return this; }
        eq(c, v) { this.f.push(r => r[c] === v); return this; }
        gte(c, v) { this.f.push(r => r[c] >= v); return this; }
        limit(n) { this.lim = n; return this; }
        insert(row) { this.op = "insert"; this.ins = row; return this; }
        update(p) { this.op = "update"; this.patch = p; return this; }
        rows() { return tables[this.t].filter(r => this.f.every(fn => fn(r))); }
        async maybeSingle() { return { data: this.rows()[0] ?? null, error: null }; }
        then(res, rej) {
            let out;
            if (this.op === "insert") {
                if (tables.__failInsert) out = { data: null, error: { message: "boom" } };
                else { tables[this.t].push({ ...this.ins }); out = { data: null, error: null }; }
            } else if (this.op === "update") {
                this.rows().forEach(r => Object.assign(r, this.patch)); out = { data: null, error: null };
            } else out = { data: this.rows().slice(0, this.lim), error: null };
            return Promise.resolve(out).then(res, rej);
        }
    }
    return { from: (t) => new Q(t) };
}

const NOW = new Date("2026-10-27T15:00:00Z");
const TOKEN = "a".repeat(64);
function world({ visible = true, email = "joey@3sixty.com", tables } = {}) {
    const t = tables ?? { shared_estimates: [], clients: [{ name: "3Sixty Industries" }] };
    const userDbFor = (jwt) => ({
        auth: { getUser: async () => jwt === "bad" ? { data: null, error: { message: "x" } } : { data: { user: { email } }, error: null } },
        rpc: async () => ({ data: visible, error: null }),
    });
    return { t, deps: { env: {}, serviceDb: makeDb(t), userDbFor, now: () => NOW, randomToken: () => TOKEN } };
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const userJwt = `h.${b64({ role: "authenticated" })}.s`;
const anonJwt = `h.${b64({ role: "anon" })}.s`;
const call = (deps, body, jwt = userJwt, method = "POST") => handle(new Request("https://x/f", {
    method, headers: { "Content-Type": "application/json", Origin: "https://video-tech.github.io", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    body: method === "POST" ? JSON.stringify(body) : undefined,
}), deps);

const lines = [
    { kind: "decking", description: "Trex Enhance", qty: 280, unit: "sqft", rate: 45, amount: 12600 },
    { kind: "footings", description: "Concrete footings", qty: 3, unit: "ea", rate: 350, amount: 1050 },
    { kind: "custom", description: "Gas", qty: 1, unit: "ea", rate: 100, amount: 100 },
    { kind: "discount", description: "Promotion: Spring (10% off)", qty: 1, unit: "ea", rate: -375, amount: -375 },
    { kind: "adjustment", description: "Estimate adjustment", qty: 1, unit: "ea", rate: -100, amount: -100 },
];
const total = 13275;
const estimate = () => ({
    prepared_for: "Pat  Smith", line_items: lines, total, price_low: 12611,
    notes: "Steep slope\u0007 east side", inclusions: ["2x10 Douglas fir framing", "6x6 posts"],
    alternatives: [{ label: "Better", name: "TimberTech Terrain+", low: 14000, high: 14737 }],
    business: "3Sixty Industries", phone: "(435) 660-1944", total_sqft: 280, deck_levels: 1,
});
const create = (deps, est = estimate(), jwt) => call(deps, { mode: "create", client: "3Sixty Industries", estimate: est }, jwt);

// ---- create ----
{
    const { t, deps } = world();
    const r = await create(deps); const j = await r.json();
    ok(r.status === 200 && j.ok && j.token === TOKEN, "create ok");
    ok(j.url === `${DEFAULT_VIEW_URL}?t=${TOKEN}`, "url built from the default page");
    ok(new Date(j.expires_at).getTime() - NOW.getTime() === 30 * 86_400_000, "expires in 30 days");
    const row = t.shared_estimates[0];
    ok(row.client_name === "3Sixty Industries" && row.created_by === "joey@3sixty.com", "row owner recorded");
    ok(row.snapshot.prepared_for === "Pat Smith", "prepared_for cleaned: " + row.snapshot.prepared_for);
    ok(row.snapshot.notes === "Steep slope east side".replace("slope east", "slope  east").replace("  ", " ") || row.snapshot.notes.indexOf("\u0007") < 0, "control characters removed from notes");
    ok(row.snapshot.date === "2026-10-27" && row.total === total, "server date and total");
    ok(row.snapshot.line_items.length === 5 && row.snapshot.alternatives.length === 1, "snapshot holds lines and alternatives");
}
{ const { deps } = world(); deps.env = { SHARE_VIEW_URL: "https://example.test/e.html" };
  const j = await (await create(deps)).json(); ok(j.url === `https://example.test/e.html?t=${TOKEN}`, "SHARE_VIEW_URL override"); }

// ---- access ----
{ const { deps } = world(); const r = await call(deps, { mode: "create", client: "3Sixty Industries", estimate: estimate() }, "");
  ok(r.status === 401, "no sign-in refused"); }
{ const { deps } = world(); const r = await create(deps, estimate(), anonJwt); ok(r.status === 401, "anon key refused"); }
{ const { deps } = world(); const r = await create(deps, estimate(), "bad"); ok(r.status === 401, "dead session refused"); }
{ const { t, deps } = world({ visible: false }); const r = await create(deps);
  ok(r.status === 403 && t.shared_estimates.length === 0, "a user without access to the client gets 403 and nothing stored"); }
{ const { deps } = world(); const r = await call(deps, { mode: "create", client: "Nobody Inc", estimate: estimate() });
  ok(r.status === 404, "unknown client 404"); }
{ const { deps } = world(); const r = await call(deps, { mode: "nope", client: "3Sixty Industries" }); ok(r.status === 400, "unknown mode"); }
{ const { deps } = world(); const r = await call(deps, null, userJwt, "GET"); ok(r.status === 405, "GET refused"); }

// ---- validation: nothing malformed is stored ----
for (const [name, mut] of [
    ["lines don't add to the total", e => { e.total = total + 5; }],
    ["qty x rate mismatch", e => { e.line_items = [{ ...lines[0], amount: 1 }, ...lines.slice(1)]; }],
    ["negative decking", e => { e.line_items = [{ ...lines[0], rate: -45, amount: -12600 }, ...lines.slice(1)]; e.total = -total; }],
    ["unknown kind", e => { e.line_items = [{ ...lines[0], kind: "free_money" }, ...lines.slice(1)]; }],
    ["too many alternatives", e => { e.alternatives = Array(6).fill(e.alternatives[0]); }],
    ["alternative with low > high", e => { e.alternatives = [{ label: "Best", name: "x", low: 10, high: 5 }]; }],
    ["alternative missing name", e => { e.alternatives = [{ label: "Best", name: "", low: 1, high: 5 }]; }],
    ["inclusions not a list", e => { e.inclusions = "all of it"; }],
    ["no lines", e => { e.line_items = []; }],
]) {
    const { t, deps } = world(); const e = estimate(); mut(e);
    const r = await create(deps, e);
    ok(r.status === 400 && t.shared_estimates.length === 0, "rejects: " + name + " (" + r.status + ")");
}
{ const e = estimate(); e.notes = "x".repeat(2001); const { t, deps } = world(); const r = await create(deps, e); ok(r.status === 400 && !t.shared_estimates.length, "notes over 2000 refused"); }
{ const e = estimate(); e.prepared_for = "N".repeat(200); const v = validateShare(e, NOW); ok(v.ok && v.value.snapshot.prepared_for.length === 80, "prepared_for capped at 80"); }
{ const e = estimate(); e.total_sqft = "big"; e.deck_levels = 99; const v = validateShare(e, NOW); ok(v.ok && v.value.snapshot.total_sqft === null && v.value.snapshot.deck_levels === null, "bad sqft/levels dropped, not trusted"); }
ok(mountainDate(new Date("2026-10-28T03:30:00Z")) === "2026-10-27", "an evening in Utah is still today's date");

// ---- rate limit ----
{
    const { t, deps } = world();
    for (let i = 0; i < MAX_LINKS_PER_HOUR; i++) t.shared_estimates.push({ token: String(i).padStart(64, "0"), created_by: "joey@3sixty.com", created_at: NOW.toISOString() });
    const r = await create(deps); ok(r.status === 429, "31st link in an hour refused");
    const other = world({ email: "other@3sixty.com", tables: t }); const r2 = await create(other.deps); ok(r2.status === 200, "limit is per rep");
}
{ const { t, deps } = world(); t.__failInsert = true; const r = await create(deps); ok(r.status === 500, "insert failure is a 500, not a fake link"); }

// ---- view (public) ----
async function made() {
    const w = world(); await create(w.deps); return w;
}
const view = (deps, body, jwt = "") => call(deps, { mode: "view", ...body }, jwt);
{
    const { t, deps } = await made();
    const r = await view(deps, { token: TOKEN }); const j = await r.json();
    ok(r.status === 200 && j.snapshot && j.snapshot.total === total, "homeowner can view with no sign-in");
    ok(!JSON.stringify(j).includes("joey@3sixty.com") && !JSON.stringify(j).includes("client_name") && !("token" in j), "response leaks neither the rep's email, the client row nor the token");
    ok(r.headers.get("Cache-Control") === "no-store", "views are never cached");
    ok(t.shared_estimates[0].view_count === 1 && t.shared_estimates[0].first_viewed_at, "view counted");
    await view(deps, { token: TOKEN }); ok(t.shared_estimates[0].view_count === 2, "second view counted");
    await view(deps, { token: TOKEN, preview: true }); ok(t.shared_estimates[0].view_count === 2, "the rep's own Open (preview) isn't counted");
}
{
    const { deps } = await made(); const msgs = new Set();
    const bad = [{ token: "b".repeat(64) }, { token: "xyz" }, { token: "" }, {}, { token: TOKEN.toUpperCase() }, { token: ["a"] }];
    for (const b of bad) { const r = await view(deps, b); msgs.add(r.status + (await r.json()).error); }
    ok(msgs.size === 1 && [...msgs][0].startsWith("404"), "unknown, malformed and missing tokens all get the same 404");
}
{
    const { t, deps } = await made();
    t.shared_estimates[0].expires_at = new Date(NOW.getTime() - 1000).toISOString();
    const r = await view(deps, { token: TOKEN }); const e = (await r.json()).error;
    ok(r.status === 404, "expired link is gone");
    t.shared_estimates[0].expires_at = new Date(NOW.getTime() + 1000).toISOString();
    ok((await view(deps, { token: TOKEN })).status === 200, "one second before expiry still works");
    t.shared_estimates[0].revoked_at = NOW.toISOString();
    const r2 = await view(deps, { token: TOKEN }); ok(r2.status === 404 && (await r2.json()).error === e, "revoked link is gone with the same message");
}

// ---- revoke ----
{
    const { t, deps } = await made();
    const r = await call(deps, { mode: "revoke", client: "3Sixty Industries", token: TOKEN });
    ok(r.status === 200 && t.shared_estimates[0].revoked_at, "rep turns a link off");
    ok((await view(deps, { token: TOKEN })).status === 404, "and the homeowner can no longer open it");
    const again = await call(deps, { mode: "revoke", client: "3Sixty Industries", token: TOKEN }); ok(again.status === 200, "turning off twice is harmless");
}
{
    const { t, deps } = await made();
    t.clients.push({ name: "Other Client" });
    const r = await call(deps, { mode: "revoke", client: "Other Client", token: TOKEN });
    ok(r.status === 404 && !t.shared_estimates[0].revoked_at, "a rep can't turn off a link by naming a different client");
    const r2 = await call(deps, { mode: "revoke", client: "3Sixty Industries", token: "nope" }); ok(r2.status === 400, "malformed token on revoke");
    const w2 = world({ visible: false, tables: t }); const r3 = await call(w2.deps, { mode: "revoke", client: "3Sixty Industries", token: TOKEN });
    ok(r3.status === 403 && !t.shared_estimates[0].revoked_at, "no access, no revoke");
}

// ---- CORS ----
{ const { deps } = world(); const r = await handle(new Request("https://x/f", { method: "OPTIONS", headers: { Origin: "https://video-tech.github.io" } }), deps);
  ok(r.headers.get("Access-Control-Allow-Origin") === "https://video-tech.github.io", "CORS allows the viewer page's origin"); }

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
