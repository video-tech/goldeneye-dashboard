// Run: node --experimental-strip-types supabase/functions/ghl-estimate-contact/ghl-estimate-contact.test.mjs
// Runs the real handler.ts against an in-memory fake of the two Supabase clients and a fake GHL.
import { handle, safeFileName, decodePdf, MAX_PDF_BYTES, MAX_SAVES_PER_HOUR } from "./handler.ts";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

function makeDb(tables) {
    class Q {
        constructor(t) { this.t = t; this.f = []; this.lim = Infinity; this.op = "select"; this.row = null; this.patch = null; this.wantRow = false; }
        select() { if (this.op === "insert") this.wantRow = true; return this; }
        eq(c, v) { this.f.push(r => r[c] === v); return this; }
        gte(c, v) { this.f.push(r => r[c] >= v); return this; }
        limit(n) { this.lim = n; return this; }
        insert(r) { this.op = "insert"; this.row = r; return this; }
        update(p) { this.op = "update"; this.patch = p; return this; }
        rows() { return tables[this.t].filter(r => this.f.every(fn => fn(r))); }
        run() {
            if (this.op === "insert") {
                if (tables.__failLog && this.t === "ghl_write_log") return { data: null, error: { message: "no table" } };
                const r = { id: tables[this.t].length + 1, ...this.row, created_at: this.row.created_at ?? new Date(2026, 9, 28).toISOString() };
                tables[this.t].push(r); return { data: r, error: null };
            }
            if (this.op === "update") { this.rows().forEach(r => Object.assign(r, this.patch)); return { data: null, error: null }; }
            return { data: this.rows().slice(0, this.lim), error: null };
        }
        async maybeSingle() { return { data: this.rows()[0] ?? null, error: null }; }
        async single() { const o = this.run(); return { data: o.data, error: o.error }; }
        then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
    }
    return { from: (t) => new Q(t) };
}

const NOW = new Date("2026-10-28T16:30:00Z");
const LOC = "AnLEimJMuN2n7YCCGQnP";
const TOKEN = "pit-secret-token-123";
const CID = "ContactId1234567890";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const userJwt = `h.${b64({ role: "authenticated" })}.s`;
const anonJwt = `h.${b64({ role: "anon" })}.s`;

function pdfBase64(size = 1500) {
    const bytes = new Uint8Array(size); bytes.fill(0x20);
    bytes.set(new TextEncoder().encode("%PDF-1.3\n"), 0);
    return Buffer.from(bytes).toString("base64");
}

// A fake GHL. Records every request; behaviour is adjustable per test.
function ghl(opts = {}) {
    const calls = [];
    const f = async (url, init = {}) => {
        const u = new URL(url); const path = u.pathname; const method = init.method ?? "GET";
        calls.push({ method, path, search: u.search, headers: init.headers, body: init.body });
        const res = (status, json) => new Response(JSON.stringify(json), { status });
        if (method === "GET" && path === "/contacts/") {
            if (opts.searchFail) return res(opts.searchFail, { message: `bad ${TOKEN}` });
            return res(200, { contacts: opts.contacts ?? [
                { id: CID, contactName: "Pat Smith", phone: "+18015551234", email: "pat@example.com", tags: ["secret-tag"], customFields: [{ v: 1 }], address1: "1 Main St" },
                { id: "x", contactName: "Bad id" },
                { id: "Contact2abcdefghijk", firstName: "Lee", lastName: "Jones" },
            ] });
        }
        if (method === "GET" && path.startsWith("/contacts/")) {
            if (opts.contactMissing) return res(404, { message: "not found" });
            return res(200, { contact: { id: path.split("/")[2], locationId: opts.contactLocation ?? LOC, contactName: "Pat Smith" } });
        }
        if (method === "POST" && path === "/medias/upload-file") {
            if (opts.uploadFail) return res(opts.uploadFail, { message: `forbidden for ${TOKEN}` });
            return res(200, opts.uploadReply ?? { fileId: "file123", url: "https://storage.googleapis.com/bucket/estimate.pdf" });
        }
        if (method === "POST" && path.endsWith("/notes")) {
            if (opts.noteFail) return res(opts.noteFail, { message: "no notes scope" });
            return res(201, { note: { id: "note123" } });
        }
        return res(404, { message: "unexpected " + method + " " + path });
    };
    return { f, calls };
}

function world({ visible = true, email = "joey@3sixty.com", g = ghl(), env = { GHL_3SIXTY_TOKEN: TOKEN }, loc = LOC, tables } = {}) {
    const t = tables ?? { ghl_write_log: [], contact_estimate_files: [], clients: [{ name: "3Sixty Industries", ghl_location_id: loc }, { name: "Other Co", ghl_location_id: "OtherLocation12345" }] };
    const userDbFor = (jwt) => ({
        auth: { getUser: async () => jwt === "bad" ? { data: null, error: { message: "x" } } : { data: { user: { email } }, error: null } },
        rpc: async () => ({ data: visible, error: null }),
    });
    return { t, g, deps: { env, serviceDb: makeDb(t), userDbFor, fetch: g.f, now: () => NOW } };
}
const call = (deps, body, jwt = userJwt, method = "POST") => handle(new Request("https://x/f", {
    method, headers: { "Content-Type": "application/json", Origin: "https://video-tech.github.io", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    body: method === "POST" ? JSON.stringify(body) : undefined,
}), deps);
const C = "3Sixty Industries";
const attach = (deps, over = {}) => call(deps, { mode: "attach", client: C, contact_id: CID, file_name: "3Sixty-Estimate-Pat-Smith-2026-10-28.pdf", pdf_base64: pdfBase64(), total: 17382.4, material: "Trex Enhance - 25yr", ...over });

// ---- helpers ----
ok(safeFileName("../../etc/passwd") === "etc-passwd.pdf", "path tricks flattened: " + safeFileName("../../etc/passwd"));
ok(safeFileName("Pat O'Neil & Sons.PDF") === "Pat-O-Neil-Sons.pdf", "odd characters replaced");
ok(safeFileName("") === "Deck-Estimate.pdf" && safeFileName(null) === "Deck-Estimate.pdf", "empty name gets a default");
ok(decodePdf(pdfBase64()) instanceof Uint8Array, "a real PDF header decodes");
ok(decodePdf(Buffer.from("x".repeat(2000)).toString("base64")) === null, "not a PDF: refused");
ok(decodePdf("!!!" + "a".repeat(700)) === null, "not base64: refused");
ok(decodePdf(pdfBase64(MAX_PDF_BYTES + 10)) === null, "too big: refused");
ok(decodePdf("JVBERi0=") === null, "too small: refused");

// ---- access ----
{ const { deps } = world(); ok((await call(deps, { mode: "status", client: C }, "")).status === 401, "no sign-in refused"); }
{ const { deps } = world(); ok((await call(deps, { mode: "status", client: C }, anonJwt)).status === 401, "anon key refused"); }
{ const { deps } = world(); ok((await call(deps, { mode: "status", client: C }, "bad")).status === 401, "dead session refused"); }
{ const { g, deps } = world({ visible: false }); const r = await call(deps, { mode: "search", client: C, query: "pat" });
  ok(r.status === 403 && g.calls.length === 0, "a user without access gets 403 and GHL is never called"); }
{ const { deps } = world(); ok((await call(deps, { mode: "status", client: "Nobody" })).status === 404, "unknown client"); }
{ const { deps } = world(); ok((await call(deps, null, userJwt, "GET")).status === 405, "GET refused"); }
{ const { deps } = world(); ok((await call(deps, { mode: "wat", client: C })).status === 400, "unknown mode"); }

// ---- status / readiness ----
{ const { deps } = world(); ok((await (await call(deps, { mode: "status", client: C })).json()).ready === true, "ready with token and location"); }
{ const { deps } = world({ env: {} }); ok((await (await call(deps, { mode: "status", client: C })).json()).ready === false, "not ready without the token secret"); }
{ const { deps } = world({ loc: "" }); ok((await (await call(deps, { mode: "status", client: C })).json()).ready === false, "not ready without a location id"); }
{ const { deps, g } = world({ env: {} }); const r = await call(deps, { mode: "search", client: C, query: "pat" }); ok(r.status === 409 && g.calls.length === 0, "search refused when not connected"); }
{ const { deps, t } = world(); t.clients.push({ name: "Other Co", ghl_location_id: "OtherLocation12345" });
  const r = await call(deps, { mode: "status", client: "Other Co" }); ok((await r.json()).ready === false, "a client with no token mapping is never ready"); }

// ---- search ----
{
    const { deps, g } = world();
    const r = await call(deps, { mode: "search", client: C, query: "  pat  " }); const j = await r.json();
    ok(r.status === 200 && j.contacts.length === 2, "search returns contacts (the one with a bad id is dropped)");
    ok(j.contacts[0].name === "Pat Smith" && j.contacts[0].phone === "+18015551234" && j.contacts[1].name === "Lee Jones", "name, phone, and first+last fallback");
    ok(JSON.stringify(j).indexOf("secret-tag") < 0 && JSON.stringify(j).indexOf("Main St") < 0 && !("tags" in j.contacts[0]), "only name, phone and email leave the function");
    const c = g.calls[0];
    ok(c.method === "GET" && c.path === "/contacts/" && c.search.includes(`locationId=${LOC}`) && c.search.includes("query=pat") && c.headers.Authorization === `Bearer ${TOKEN}`, "GHL asked for this client's location only, with the token");
    ok(JSON.stringify(j).indexOf(TOKEN) < 0, "token never in the answer");
}
{ const { deps } = world(); ok((await call(deps, { mode: "search", client: C, query: "a" })).status === 400, "1 character is too short"); }
{ const { deps, g } = world(); await call(deps, { mode: "search", client: C, query: "x&locationId=Other&limit=999" });
  ok(g.calls[0].search.includes("locationId=" + LOC) && !g.calls[0].search.includes("locationId=Other&") && g.calls[0].search.includes("%26locationId"), "query text can't smuggle in another location: " + g.calls[0].search); }
{ const { deps } = world({ g: ghl({ searchFail: 403 }) }); const r = await call(deps, { mode: "search", client: C, query: "pat" }); const j = await r.json();
  ok(r.status === 502 && /permission/.test(j.error) && JSON.stringify(j).indexOf(TOKEN) < 0, "403 from GHL gives a permission hint and never echoes the token"); }

// ---- attach ----
{
    const { deps, g, t } = world();
    const r = await attach(deps); const j = await r.json();
    ok(r.status === 200 && j.ok && j.contact_name === "Pat Smith" && j.url.startsWith("https://"), "attach saves the PDF and the note");
    const seq = g.calls.map(c => c.method + " " + c.path.replace(CID, ":id"));
    ok(JSON.stringify(seq) === JSON.stringify(["GET /contacts/:id", "POST /medias/upload-file", "POST /contacts/:id/notes"]), "exactly: check the contact, upload, add the note: " + seq.join(" | "));
    const up = g.calls[1];
    ok(up.body instanceof FormData && up.body.get("file").type === "application/pdf" && /-202610281030\.pdf$/.test(up.body.get("name")), "multipart upload with a stamped name: " + up.body.get("name"));
    ok(!("Content-Type" in up.headers), "no hand-set content type on the multipart upload");
    const note = JSON.parse(g.calls[2].body);
    ok(/Deck estimate from Golden Eye - \$17,382/.test(note.body) && note.body.includes("PDF: https://storage.googleapis.com") && note.body.includes("Saved by joey@3sixty.com") && note.body.includes("Trex Enhance"), "note text");
    ok(t.ghl_write_log.length === 2 && t.ghl_write_log.every(l => l.ok === true && l.by === "joey@3sixty.com" && l.location_id === LOC && l.client_name === C), "both writes logged, and completed");
    ok(t.ghl_write_log.some(l => l.path === "/medias/upload-file") && t.ghl_write_log.some(l => l.path === `/contacts/${CID}/notes`), "log names the endpoints");
    ok(JSON.stringify(t.ghl_write_log).indexOf(TOKEN) < 0, "no token in the log");
    ok(t.contact_estimate_files.length === 1 && t.contact_estimate_files[0].status === "saved" && t.contact_estimate_files[0].note_id === "note123" && t.contact_estimate_files[0].contact_name === "Pat Smith", "history row saved");
}
// invalid input: nothing sent
for (const [name, over] of [
    ["no contact", { contact_id: "" }],
    ["malformed contact id", { contact_id: "../locations/x" }],
    ["not a pdf", { pdf_base64: Buffer.from("x".repeat(2000)).toString("base64") }],
    ["too big", { pdf_base64: pdfBase64(MAX_PDF_BYTES + 10) }],
]) {
    const { deps, g, t } = world(); const r = await attach(deps, over);
    ok(r.status === 400 && g.calls.length === 0 && t.ghl_write_log.length === 0, "rejects without touching GHL: " + name);
}
{ const { deps, g, t } = world({ g: ghl({ contactMissing: true }) }); const r = await attach(deps);
  ok(r.status === 404 && g.calls.length === 1 && t.ghl_write_log.length === 0, "contact gone: nothing written"); }
{ const { deps, g, t } = world({ g: ghl({ contactLocation: "SomeOtherLocation99" }) }); const r = await attach(deps);
  ok(r.status === 403 && g.calls.length === 1 && t.ghl_write_log.length === 0, "a contact from a different GHL account is refused before any write"); }
{ const { deps, g, t } = world(); t.__failLog = true; const r = await attach(deps);
  ok(r.status === 502 && !g.calls.some(c => c.method === "POST"), "if the write can't be logged, nothing is written to GHL"); }
{
    const { deps, t } = world({ g: ghl({ uploadFail: 403 }) }); const r = await attach(deps); const j = await r.json();
    ok(r.status === 502 && /permission/.test(j.error) && JSON.stringify(j).indexOf(TOKEN) < 0, "upload refused: explained, token scrubbed");
    ok(t.ghl_write_log.length === 1 && t.ghl_write_log[0].ok === false && t.ghl_write_log[0].status === 403 && JSON.stringify(t.ghl_write_log).indexOf(TOKEN) < 0, "failed write is logged as failed");
    ok(t.contact_estimate_files.length === 0, "no history row for a failed upload");
}
{ const { deps, g } = world({ g: ghl({ uploadReply: { fileId: "x" } }) }); const r = await attach(deps);
  ok(r.status === 502 && !g.calls.some(c => c.path.endsWith("/notes")), "upload with no link back: no note is added"); }
{
    const { deps, t } = world({ g: ghl({ noteFail: 403 }) }); const r = await attach(deps); const j = await r.json();
    ok(r.status === 502 && j.partial === true && j.url && /PDF was uploaded/.test(j.error), "note failure says the PDF IS in GHL");
    ok(t.contact_estimate_files[0].status === "partial" && t.contact_estimate_files[0].note_id === null, "recorded as partial");
}
{
    const { deps, t } = world();
    for (let i = 0; i < MAX_SAVES_PER_HOUR; i++) t.contact_estimate_files.push({ id: i + 100, created_by: "joey@3sixty.com", created_at: NOW.toISOString() });
    const r = await attach(deps); ok(r.status === 429, "31st save in an hour refused");
    const o = world({ email: "other@3sixty.com", tables: t }); ok((await attach(o.deps)).status === 200, "limit is per rep");
}
{ const { deps, g } = world(); await attach(deps, { contact_id: "Contact2abcdefghijk" });
  ok(g.calls[0].path === "/contacts/Contact2abcdefghijk" && g.calls[2].path === "/contacts/Contact2abcdefghijk/notes", "writes go to the chosen contact only"); }
{ const { deps, g } = world({ g: ghl() }); const r = await attach(deps, { file_name: "../../x.pdf" });
  const name = g.calls[1].body.get("name"); ok(r.status === 200 && /^x-\d{12}\.pdf$/.test(name), "file name sanitised: " + name); }

// ---- CORS ----
{ const { deps } = world(); const r = await handle(new Request("https://x/f", { method: "OPTIONS", headers: { Origin: "https://video-tech.github.io" } }), deps);
  ok(r.headers.get("Access-Control-Allow-Origin") === "https://video-tech.github.io", "CORS allows the portal's origin"); }

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
