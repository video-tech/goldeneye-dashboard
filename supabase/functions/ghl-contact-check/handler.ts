// ghl-contact-check (2026-10-16): is each client a contact in our Midas GHL account, exactly once?
// Make scenario #4 (the onboarding-complete tag and text) finds the client by the email the onboarding trigger sends,
// and acts only on an exact, single match, so a missing or duplicated contact makes the tag and text silently not happen.
// This looks each client up the same way and records the answer in client_ghl_contacts for Golden Eye to show.
//
// READ ONLY: it uses GHL_MIDAS_TOKEN, a Private Integration token on our Midas GHL account with the Contacts read scope
// only, and makes GET requests only (through _shared/ghl-write.ts's ghlRead). It never writes to GHL.
//
// Modes (POST JSON): {} or {"mode":"check"} checks every active client in the Onboarding stage (the schedule);
// {"mode":"check","client":"<exact name>"} checks one (Golden Eye after Add client, and the Check now button).
// Callers: the schedule (x-cron-secret) or a signed-in admin.

import { adminCheck, cronCheck } from "../_shared/admin-auth.ts";
import { ghlRead } from "../_shared/ghl-write.ts";

export type Env = { GHL_MIDAS_TOKEN?: string; GHL_MIDAS_LOCATION_ID?: string; MAKE_WEBHOOK_SECRET?: string };
export type Deps = { env: Env; db: any; fetch: typeof fetch; now?: () => Date };

const errText = (e: unknown) => String((e as Error)?.message ?? e);

// The email the onboarding trigger sends to Make (supabase/triggers/onboarding_handoff.sql): the first address in
// client_email, with every space removed. Lower-cased here because GHL compares emails without case.
export function primaryEmail(clientEmail: unknown): string {
    return String(clientEmail ?? "").split(",")[0].replace(/\s/g, "").toLowerCase();
}

export type Result = { client_name: string; email: string | null; status: string; contact_id: string | null; matches: number; error: string | null };

// One client: GHL's contact search is fuzzy, so only contacts whose own email is exactly this one count.
export async function checkOne(deps: Deps, client: { name: string; client_email?: string | null }): Promise<Result> {
    const email = primaryEmail(client.client_email);
    const base = { client_name: client.name, email: email || null, contact_id: null as string | null, matches: 0, error: null as string | null };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ...base, status: "no_email" };
    const token = deps.env.GHL_MIDAS_TOKEN!.trim(), loc = deps.env.GHL_MIDAS_LOCATION_ID!.trim();
    try {
        const j = await ghlRead(deps, `/contacts/?locationId=${encodeURIComponent(loc)}&query=${encodeURIComponent(email)}&limit=100`, token);
        const exact = (Array.isArray(j?.contacts) ? j.contacts : []).filter((c: any) => String(c?.email ?? "").trim().toLowerCase() === email);
        if (exact.length === 1) return { ...base, status: "found", contact_id: String(exact[0].id ?? ""), matches: 1 };
        return { ...base, status: exact.length ? "duplicate" : "missing", matches: exact.length };
    } catch (e) {
        return { ...base, status: "error", error: errText(e).slice(0, 300) };
    }
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
    const reply = (body: unknown, status = 200) => Response.json(body, { status });
    if (req.method !== "POST") return reply({ error: "POST only" }, 405);
    if (!cronCheck(req, deps.env.MAKE_WEBHOOK_SECRET)) {
        const caller = await adminCheck(deps.db, req);
        if (!caller.ok) { console.warn("ghl-contact-check REFUSED:", caller.reason); return reply({ error: caller.reason }, 403); }
    }
    if (!deps.env.GHL_MIDAS_TOKEN?.trim() || !deps.env.GHL_MIDAS_LOCATION_ID?.trim()) {
        return reply({ error: "Set GHL_MIDAS_TOKEN (our Midas GHL account's read-only Contacts key) and GHL_MIDAS_LOCATION_ID first." }, 500);
    }
    const body = await req.json().catch(() => ({}));
    const one = typeof body?.client === "string" ? body.client : null;

    let q = deps.db.from("clients").select("name, client_email, status, current_stage");
    q = one ? q.eq("name", one) : q.eq("status", "active").eq("current_stage", "Onboarding");
    const { data: clients, error } = await q;
    if (error) return reply({ error: `Couldn't read clients: ${error.message}` }, 500);
    if (one && !clients?.length) return reply({ error: `No client is called "${one}".` }, 404);

    const nowIso = (deps.now ?? (() => new Date()))().toISOString();
    const results: Result[] = [];
    for (const c of clients ?? []) results.push(await checkOne(deps, c));
    if (results.length) {
        const { error: wErr } = await deps.db.from("client_ghl_contacts").upsert(results.map((r) => ({ ...r, checked_at: nowIso })), { onConflict: "client_name" });
        if (wErr) return reply({ error: `Couldn't save the results: ${wErr.message}. Has supabase/sql/ghl_contact_check.sql been run?` }, 500);
    }
    const summary = results.reduce((s: Record<string, number>, r) => { s[r.status] = (s[r.status] ?? 0) + 1; return s; }, {});
    console.log(`ghl-contact-check: ${results.length} checked ${JSON.stringify(summary)}`);
    return reply({ checked: results.length, summary, results });
}
