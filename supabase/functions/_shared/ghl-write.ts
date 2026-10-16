// The one gate every GHL write goes through (rule 1 and 2 of "Rules for anything that uses the app's key", CLAUDE.md).
// No imports: db and fetch are passed in, so tests run it under plain node.
//
//   - Reads (GET) go through ghlRead and may hit any endpoint.
//   - Writes go through ghlWrite, which refuses any method and endpoint not on WRITE_ALLOW, even though the app's key
//     could do far more. Adding a kind of write means adding it here, on purpose.
//   - Every write is logged in ghl_write_log BEFORE it is sent (a write that can't be logged is never sent), then the
//     row is completed with GHL's answer. The log holds a summary written by the caller, never a token or a value.
//   - GHL's error text is scrubbed of every token in play.

export type GhlDeps = { db: any; fetch: typeof fetch };

const GHL = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

export const WRITE_ALLOW: { method: string; path: RegExp; what: string }[] = [
    { method: "POST", path: /^\/locations\/$/, what: "create a sub-account" },
    { method: "PUT", path: /^\/locations\/[A-Za-z0-9]{10,40}\/customValues\/[A-Za-z0-9]{5,40}$/, what: "fill a custom value" },
    { method: "POST", path: /^\/users\/$/, what: "add a person from the client's team as a GHL user" },
];

export class GhlError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
}

export function writeAllowed(method: string, path: string): boolean {
    const p = path.split("?")[0];
    return WRITE_ALLOW.some((a) => a.method === method.toUpperCase() && a.path.test(p));
}

async function send(deps: GhlDeps, method: string, path: string, token: string, body: unknown, scrub: string[]) {
    const headers: Record<string, string> = { "Authorization": `Bearer ${token}`, "Version": VERSION, "Accept": "application/json" };
    let payload: string | undefined;
    if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await deps.fetch(GHL + path, { method, headers, body: payload });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
        const raw = json?.message ?? json?.error ?? text ?? "";
        let msg = (Array.isArray(raw) ? raw.join("; ") : String(raw)).slice(0, 300);
        for (const s of [token, ...scrub]) if (s) msg = msg.split(s).join("[token]");
        throw new GhlError(`GHL ${method} ${path.split("?")[0]} answered ${res.status}: ${msg}`, res.status);
    }
    return json;
}

export async function ghlRead(deps: GhlDeps, path: string, token: string, scrub: string[] = []) {
    return await send(deps, "GET", path, token, undefined, scrub);
}

export type WriteLog = { by: string; client: string | null; location: string | null; summary: string };

export async function ghlWrite(deps: GhlDeps, method: string, path: string, token: string, body: unknown, log: WriteLog, scrub: string[] = []) {
    const p = path.split("?")[0];
    if (!writeAllowed(method, p)) throw new Error(`Refused: Golden Eye doesn't make "${method} ${p}" writes in GHL (not on the allow-list).`);
    const { data: row, error } = await deps.db.from("ghl_write_log").insert({
        by: log.by, client_name: log.client, location_id: log.location, method: method.toUpperCase(), path: p,
        summary: String(log.summary).slice(0, 300), ok: false,
    }).select("id").single();
    if (error || !row?.id) throw new Error(`Refused: the write couldn't be logged (${error?.message ?? "no id"}), so it wasn't sent. Has supabase/sql/ghl_accounts.sql been run?`);
    try {
        const json = await send(deps, method, path, token, body, scrub);
        await deps.db.from("ghl_write_log").update({ ok: true, status: 200 }).eq("id", row.id);
        return json;
    } catch (e) {
        await deps.db.from("ghl_write_log").update({ ok: false, status: (e as GhlError).status ?? null, error: String((e as Error).message).slice(0, 300) }).eq("id", row.id);
        throw e;
    }
}
