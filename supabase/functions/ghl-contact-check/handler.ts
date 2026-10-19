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
    const token = deps.env.GHL_MIDAS_TOKEN?.trim() ?? "", loc = deps.env.GHL_MIDAS_LOCATION_ID?.trim() ?? "";
    if (!token || !loc) return { ...base, status: "error", error: "GHL_MIDAS_TOKEN or GHL_MIDAS_LOCATION_ID is not set" };
    try {
        const j = await ghlRead(deps, `/contacts/?locationId=${encodeURIComponent(loc)}&query=${encodeURIComponent(email)}&limit=100`, token);
        const exact = (Array.isArray(j?.contacts) ? j.contacts : []).filter((c: any) => String(c?.email ?? "").trim().toLowerCase() === email);
        if (exact.length === 1) return { ...base, status: "found", contact_id: String(exact[0].id ?? ""), matches: 1 };
        return { ...base, status: exact.length ? "duplicate" : "missing", matches: exact.length };
    } catch (e) {
        return { ...base, status: "error", error: errText(e).slice(0, 300) };
    }
}

// ---- The onboarding-complete handoff (trg_onboarding_handoff sends it here instead of straight to Make) ----
// When a client finishes onboarding, the database asks this function to send Make scenario #4's webhook (the tag that
// texts them "what happens next"). It is sent only when the client is a contact in our Midas GHL exactly once; otherwise
// nothing is sent and a task says why, so a missing contact is never silent.
export const ONBOARDING_HOOK = "https://hook.us2.make.com/hucrpp6hm43ps165n7wxut8v9rn3dksu";
export const NOT_SENT_TITLE = "Onboarding-complete text not sent: check them in our GHL";

const NOT_SENT_WHY: Record<string, string> = {
    missing: "They aren't a contact in our Midas GHL with this email.",
    duplicate: "More than one contact in our Midas GHL has this email.",
    no_email: "Their client record has no usable email.",
    error: "The check couldn't reach GHL.",
};

export async function handoff(deps: Deps, body: any) {
    const client = String(body?.client ?? "");
    if (!client) return { sent: false, error: "no client" };
    const result = await checkOne(deps, { name: client, client_email: body?.client_email });
    const nowIso = (deps.now ?? (() => new Date()))().toISOString();
    await deps.db.from("client_ghl_contacts").upsert([{ ...result, checked_at: nowIso }], { onConflict: "client_name" });

    if (result.status === "found") {
        const res = await deps.fetch(ONBOARDING_HOOK, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                event: "onboarding_complete", client, client_email: body?.client_email ?? result.email,
                completed_at: body?.completed_at ?? null, services: body?.services ?? [], secret: deps.env.MAKE_WEBHOOK_SECRET,
            }),
        });
        console.log(`ghl-contact-check handoff: ${client} found in our GHL, webhook sent (${res.status})`);
        return { sent: res.ok, status: result.status, make_status: res.status };
    }

    // Not sent: a task for the team, once per client, hidden from the client
    const { data: existing } = await deps.db.from("tasks").select("id").eq("client", client).eq("title", NOT_SENT_TITLE);
    if (!existing?.length) {
        await deps.db.from("tasks").insert([{
            client, title: NOT_SENT_TITLE, type: "One-off", stage: "Onboarding", status: "Not Started", assignee: "Account Manager",
            client_visible: false, p: 4, u: 4, e: 1, score: 84, due: nowIso.slice(0, 10), updated_at: nowIso,
            notes: `${client} finished onboarding, but the "what happens next" text wasn't sent. ${NOT_SENT_WHY[result.status] ?? ""}` +
                `${result.email ? ` Email checked: ${result.email}.` : ""} Fix it in GHL (or the email in Edit Client), then add the onboarding-complete tag to their contact in our GHL to send the text, or text them by hand.`,
        }]);
    }
    console.log(`ghl-contact-check handoff: ${client} ${result.status}, webhook NOT sent`);
    return { sent: false, status: result.status };
}

// Check now runs in the dashboard's browser, on another origin, so the browser first asks (OPTIONS) whether it may call.
export const ALLOWED_ORIGINS = ["https://goldeneye.midasmediafirm.com", "https://video-tech.github.io"];
export function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("Origin") ?? "";
    return {
        "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
    };
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
    const cors = corsHeaders(req);
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return reply({ error: "POST only" }, 405);
    if (!cronCheck(req, deps.env.MAKE_WEBHOOK_SECRET)) {
        const caller = await adminCheck(deps.db, req);
        if (!caller.ok) { console.warn("ghl-contact-check REFUSED:", caller.reason); return reply({ error: caller.reason }, 403); }
    }
    const body = await req.json().catch(() => ({}));
    // Before the key check on purpose: with the key missing the handoff still raises its "not sent" task
    if (body?.mode === "handoff") {
        if (!cronCheck(req, deps.env.MAKE_WEBHOOK_SECRET)) return reply({ error: '"handoff" is sent by the database only.' }, 403);
        return reply(await handoff(deps, body));
    }
    if (!deps.env.GHL_MIDAS_TOKEN?.trim() || !deps.env.GHL_MIDAS_LOCATION_ID?.trim()) {
        return reply({ error: "Set GHL_MIDAS_TOKEN (our Midas GHL account's read-only Contacts key) and GHL_MIDAS_LOCATION_ID first." }, 500);
    }
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
