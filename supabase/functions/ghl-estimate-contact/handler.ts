// ghl-estimate-contact: save a deck estimate PDF to a contact in the client's own GHL (built 2026-10-28).
//
// In the Deck Calculator tab a rep searches the client's GHL contacts, picks one, and clicks "Save to
// contact". This function re-checks everything, uploads the PDF to that GHL account's media library and
// adds a note on the contact with the link, so it shows in the contact's timeline.
//
// Two reads and exactly two kinds of write, all against the one GHL account named for the client:
//   read   GET  /contacts/?locationId=&query=      the search box
//   read   GET  /contacts/{id}                     confirms the contact is in THIS account before any write
//   write  POST /medias/upload-file                the PDF
//   write  POST /contacts/{id}/notes               the note holding the link
// Every write is logged in ghl_write_log BEFORE it is sent (a write that can't be logged isn't sent), the same
// rule the account automation follows. Only signed-in people who can see this client may call it
// (client_row_visible, asked as the caller, like deck-estimate). The GHL token is a secret and never leaves
// the server or appears in any answer, log or error.
//
// No Deno or npm imports: the clients, fetch and the clock are passed in so the tests run under node.

export const ALLOWED_ORIGINS = [
    "https://goldeneye.midasmediafirm.com",
    "https://video-tech.github.io",
];

// Which secret holds each client's GHL token (a Private Integration token made inside THAT client's GHL
// account). Keyed on the exact clients.name, so a rename needs the key changed here. The location id is not
// a secret: it comes from clients.ghl_location_id.
export const ACCOUNTS: Record<string, string> = {
    "3Sixty Industries": "GHL_3SIXTY_TOKEN",
};

export type Deps = {
    env: Record<string, string | undefined>;
    serviceDb: any;
    userDbFor: (jwt: string) => any;
    fetch: typeof fetch;
    now?: () => Date;
    timeoutMs?: number;
};

const GHL = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
export const MAX_PDF_BYTES = 2_000_000;
export const MAX_SAVES_PER_HOUR = 30;
const ID = /^[A-Za-z0-9]{10,40}$/;

export function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("Origin") ?? "";
    return {
        "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
    };
}

function jwtRole(jwt: string): string | null {
    try {
        const part = jwt.split(".")[1];
        if (!part) return null;
        const json = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4));
        return JSON.parse(json)?.role ?? null;
    } catch {
        return null;
    }
}

const clean = (v: unknown, max: number) =>
    typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, max) : "";

// A safe file name: letters, digits, dot, dash, underscore. Always ends .pdf.
export function safeFileName(v: unknown): string {
    let base = clean(v, 120).replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80);
    if (!base) base = "Deck-Estimate";
    return base + ".pdf";
}

export function decodePdf(b64: unknown): Uint8Array | null {
    if (typeof b64 !== "string" || b64.length < 600 || b64.length > Math.ceil(MAX_PDF_BYTES * 4 / 3) + 8) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); } catch { return null; }
    if (bytes.length > MAX_PDF_BYTES) return null;
    // %PDF-
    if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d) return null;
    return bytes;
}

class GhlError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
    const cors = corsHeaders(req);
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return reply({ error: "POST only" }, 405);
    const now = (deps.now ?? (() => new Date()))();

    // ---- who is calling ----
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return reply({ error: "No sign-in was sent. Reload Golden Eye and try again." }, 401);
    if (jwtRole(jwt) === "anon") {
        return reply({ error: "This page is running an older version of Golden Eye. Reload the page and try again." }, 401);
    }
    const userDb = deps.userDbFor(jwt);
    const { data: who, error: whoErr } = await userDb.auth.getUser(jwt);
    const email: string | undefined = who?.user?.email;
    if (whoErr || !email) return reply({ error: "Your sign-in has expired. Sign out, sign back in, and try again." }, 401);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return reply({ error: "The request wasn't valid JSON." }, 400);
    const mode = String(body.mode ?? "");
    const client = typeof body.client === "string" ? body.client : "";
    if (!client || client.length > 200) return reply({ error: "No client was named." }, 400);

    // ---- may they act for this client ----
    const { data: visible, error: visErr } = await userDb.rpc("client_row_visible", { p_client: client });
    if (visErr) {
        console.error(`ghl-estimate-contact: client_row_visible failed for ${email}: ${visErr.message}`);
        return reply({ error: "Couldn't check your access to this client. Try again in a minute." }, 500);
    }
    if (visible !== true) {
        console.warn(`ghl-estimate-contact REFUSED: ${email} has no access to "${client}"`);
        return reply({ error: "You don't have access to this client." }, 403);
    }
    const { data: clientRow } = await deps.serviceDb.from("clients").select("name, ghl_location_id").eq("name", client).maybeSingle();
    if (!clientRow) return reply({ error: `No client is named "${client}".` }, 404);

    const token = ACCOUNTS[client] ? deps.env[ACCOUNTS[client]] : undefined;
    const loc = typeof clientRow.ghl_location_id === "string" ? clientRow.ghl_location_id.trim() : "";
    const ready = !!(token && ID.test(loc));

    // Only after the access check, so nobody can probe which clients have a GHL connected here.
    if (mode === "status") return reply({ ready });
    if (mode !== "search" && mode !== "attach") return reply({ error: "Unknown mode." }, 400);
    if (!ready) return reply({ error: "GHL isn't connected for this client yet." }, 409);

    // ---- talking to GHL ----
    const call = async (method: string, path: string, init: { json?: unknown; form?: FormData } = {}) => {
        const headers: Record<string, string> = { "Authorization": `Bearer ${token}`, "Version": VERSION, "Accept": "application/json" };
        let payload: BodyInit | undefined;
        if (init.json !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(init.json); }
        else if (init.form) payload = init.form;   // fetch sets the multipart boundary itself
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 25_000);
        try {
            const res = await deps.fetch(GHL + path, { method, headers, body: payload, signal: ctrl.signal });
            const text = await res.text();
            let json: any = null;
            try { json = JSON.parse(text); } catch { /* not JSON */ }
            if (!res.ok) {
                const raw = json?.message ?? json?.error ?? text ?? "";
                let msg = (Array.isArray(raw) ? raw.join("; ") : String(raw)).slice(0, 300);
                msg = msg.split(token!).join("[token]");
                throw new GhlError(`GHL ${method} ${path.split("?")[0].replace(/[A-Za-z0-9]{20,}/g, ":id")} answered ${res.status}: ${msg}`, res.status);
            }
            return json;
        } catch (e) {
            if ((e as Error)?.name === "AbortError") throw new GhlError("GHL took too long to answer.", 504);
            throw e;
        } finally {
            clearTimeout(timer);
        }
    };
    const fail = (e: unknown, fallback: string) => {
        const status = e instanceof GhlError ? e.status : 502;
        console.error(`ghl-estimate-contact: "${client}": ${(e as Error)?.message}`);
        const why = e instanceof GhlError ? e.message : fallback;
        const hint = status === 401 || status === 403
            ? " The GHL access key for this client may be missing a permission (contacts, notes or media library)."
            : "";
        return reply({ error: why + hint }, 502);
    };

    // ---- search ----
    if (mode === "search") {
        const q = clean(body.query, 80);
        if (q.length < 2) return reply({ error: "Type at least 2 characters to search." }, 400);
        let data: any;
        try {
            data = await call("GET", `/contacts/?locationId=${encodeURIComponent(loc)}&query=${encodeURIComponent(q)}&limit=10`);
        } catch (e) { return fail(e, "Couldn't search GHL."); }
        const contacts = (Array.isArray(data?.contacts) ? data.contacts : [])
            .filter((c: any) => typeof c?.id === "string" && ID.test(c.id))
            // Only what the picker shows. Never tags, notes, custom fields or addresses.
            .map((c: any) => ({
                id: c.id,
                name: clean(c.contactName || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || "(no name)", 80),
                phone: clean(c.phone, 40) || null,
                email: clean(c.email, 120) || null,
            }))
            .slice(0, 8);
        return reply({ contacts });
    }

    // ---- attach: PDF to media library, note on the contact ----
    const contactId = typeof body.contact_id === "string" ? body.contact_id : "";
    if (!ID.test(contactId)) return reply({ error: "Pick a contact first." }, 400);
    const pdf = decodePdf(body.pdf_base64);
    if (!pdf) return reply({ error: "The PDF wasn't valid or was too large. Try again." }, 400);
    const total = typeof body.total === "number" && Number.isFinite(body.total) && body.total >= 0 && body.total <= 5_000_000 ? Math.round(body.total * 100) / 100 : null;
    const material = clean(body.material, 120);
    const label = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

    const since = new Date(now.getTime() - 3_600_000).toISOString();
    const { data: recent } = await deps.serviceDb.from("contact_estimate_files")
        .select("id").eq("created_by", email).gte("created_at", since).limit(MAX_SAVES_PER_HOUR + 1);
    if (recent && recent.length >= MAX_SAVES_PER_HOUR) {
        return reply({ error: "That's a lot of saves in an hour. Wait a bit and try again." }, 429);
    }

    // The contact must exist in THIS client's account. GHL would also refuse a foreign id, but the check
    // here means nothing is written, and the name comes from GHL rather than from the browser.
    let contact: any;
    try {
        const r = await call("GET", `/contacts/${contactId}`);
        contact = r?.contact ?? r;
    } catch (e) {
        if (e instanceof GhlError && e.status === 404) return reply({ error: "That contact no longer exists in GHL. Search again." }, 404);
        return fail(e, "Couldn't open that contact in GHL.");
    }
    if (!contact || contact.id !== contactId || (contact.locationId && contact.locationId !== loc)) {
        return reply({ error: "That contact isn't in this client's GHL account." }, 403);
    }
    const contactName = clean(contact.contactName || [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "(no name)", 80);

    // One log row per write, written first. No row, no write.
    const logWrite = async (method: string, path: string, summary: string) => {
        const { data: row, error } = await deps.serviceDb.from("ghl_write_log").insert({
            by: email, client_name: client, location_id: loc, method, path, summary: summary.slice(0, 300), ok: false,
        }).select("id").single();
        if (error || !row?.id) throw new GhlError(`The write couldn't be logged (${error?.message ?? "no id"}), so nothing was sent.`, 500);
        return row.id as number;
    };
    const finishLog = (id: number, ok: boolean, patch: Record<string, unknown> = {}) =>
        deps.serviceDb.from("ghl_write_log").update({ ok, ...patch }).eq("id", id);

    const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .format(now).replace(/[^0-9]/g, "");
    const fileName = safeFileName(body.file_name).replace(/\.pdf$/, "") + "-" + stamp + ".pdf";

    // 1. the file
    let url: string, fileId: string | null;
    let upId: number;
    try {
        upId = await logWrite("POST", "/medias/upload-file", `deck estimate PDF (${Math.ceil(pdf.length / 1024)} KB) for contact ${contactId}`);
    } catch (e) {
        return fail(e, "Couldn't log the upload, so nothing was sent to GHL.");
    }
    try {
        const form = new FormData();
        form.append("file", new Blob([pdf], { type: "application/pdf" }), fileName);
        form.append("name", fileName);
        const up = await call("POST", "/medias/upload-file", { form });
        url = typeof up?.url === "string" ? up.url : "";
        fileId = typeof up?.fileId === "string" ? up.fileId : null;
        if (!/^https:\/\//.test(url)) throw new GhlError("GHL accepted the file but sent back no link to it.", 502);
        await finishLog(upId, true, { status: 200 });
    } catch (e) {
        await finishLog(upId, false, { status: e instanceof GhlError ? e.status : null, error: String((e as Error).message).slice(0, 300) });
        return fail(e, "Couldn't upload the PDF to GHL.");
    }

    // 2. the note that points at it
    const text = [
        "Deck estimate from Golden Eye" + (total !== null ? ` - ${label(total)}` : ""),
        material ? `Material: ${material}` : "",
        `PDF: ${url}`,
        `Saved by ${email}`,
    ].filter(Boolean).join("\n");
    let noteId: string | null = null;
    let noteError: string | null = null;
    let noteLog: number | null = null;
    try {
        noteLog = await logWrite("POST", `/contacts/${contactId}/notes`, `note with the estimate PDF link on contact ${contactId}`);
        const n = await call("POST", `/contacts/${contactId}/notes`, { json: { body: text } });
        noteId = typeof (n?.note?.id ?? n?.id) === "string" ? (n?.note?.id ?? n?.id) : null;
        await finishLog(noteLog, true, { status: 200 });
    } catch (e) {
        noteError = String((e as Error).message).slice(0, 300);
        if (noteLog !== null) await finishLog(noteLog, false, { status: e instanceof GhlError ? e.status : null, error: noteError });
    }

    const { data: row } = await deps.serviceDb.from("contact_estimate_files").insert({
        client_name: client, created_by: email, contact_id: contactId, contact_name: contactName, file_name: fileName,
        file_url: url, file_id: fileId, note_id: noteId, total, material: material || null,
        status: noteError ? "partial" : "saved", error: noteError,
    }).select("id").single();

    if (noteError) {
        return reply({
            ok: false, partial: true, url, contact_name: contactName, id: row?.id ?? null,
            error: `The PDF was uploaded to GHL, but the note on ${contactName} couldn't be added: ${noteError}`,
        }, 502);
    }
    return reply({ ok: true, url, contact_name: contactName, id: row?.id ?? null });
}
