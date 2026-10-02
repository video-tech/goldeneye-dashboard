// The deck-estimate request flow. No Deno or npm imports: the database clients, fetch and the
// environment are passed in, so deck-estimate.test.ts runs it under plain node with fakes.
// index.ts is the thin Deno wrapper that supplies the real ones.

import { validateEstimate, parseHooks } from "./validate.ts";

export type Env = {
    MAKE_WEBHOOK_SECRET?: string;
    DECK_ESTIMATE_HOOKS?: string;
};

export type Deps = {
    env: Env;
    // service_role client: writes deck_estimates, reads clients. Bypasses RLS.
    serviceDb: any;
    // A client that runs as the CALLER (their JWT), so client_row_visible() answers for them.
    userDbFor: (jwt: string) => any;
    fetch: typeof fetch;
    makeTimeoutMs?: number;
    now?: () => Date;
};

export const ALLOWED_ORIGINS = [
    "https://goldeneye.midasmediafirm.com",
    "https://video-tech.github.io",
];

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

// The row fields the browser gets back. Never the request payload or anything from Make beyond these.
const ROW_FIELDS = "id, created_at, created_by, customer_name, customer_email, total, status, error, qb_doc_number, qb_estimate_id";

export async function handle(req: Request, deps: Deps): Promise<Response> {
    const cors = corsHeaders(req);
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return reply({ error: "POST only" }, 405);

    // ---- who is calling ----
    // The gateway only proves the caller holds SOME valid JWT, and the public anon key is one.
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
    // client_row_visible() is the same rule every client-facing RLS policy uses: admin, a
    // user_client_access row, or the clients.client_email fallback. Asked AS the caller, not
    // re-implemented here, so this can never drift from what the portal itself lets them see.
    const { data: visible, error: visErr } = await userDb.rpc("client_row_visible", { p_client: client });
    if (visErr) {
        console.error(`deck-estimate: client_row_visible failed for ${email}: ${visErr.message}`);
        return reply({ error: "Couldn't check your access to this client. Try again in a minute." }, 500);
    }
    if (visible !== true) {
        console.warn(`deck-estimate REFUSED: ${email} has no access to "${client}"`);
        return reply({ error: "You don't have access to this client." }, 403);
    }

    // Exact clients.name, so rows stay movable by rename_client(). The hook map is keyed the same way.
    const { data: clientRow } = await deps.serviceDb.from("clients").select("name").eq("name", client).maybeSingle();
    if (!clientRow) return reply({ error: `No client is named "${client}".` }, 404);

    const secret = deps.env.MAKE_WEBHOOK_SECRET;
    const hook = parseHooks(deps.env.DECK_ESTIMATE_HOOKS)[client];
    const ready = !!(secret && hook);

    // Only after the access check, so nobody can probe which clients have QuickBooks connected.
    if (mode === "status") return reply({ ready });
    if (mode !== "create") return reply({ error: "Unknown mode." }, 400);
    if (!ready) return reply({ error: "QuickBooks isn't connected for this client yet." }, 409);

    const v = validateEstimate(body.estimate);
    if (!v.ok) return reply({ error: v.errors.join(" "), errors: v.errors }, 400);
    const est = v.value;
    const customerName = `${est.customer.first_name} ${est.customer.last_name}`;
    const now = (deps.now ?? (() => new Date()))();

    // ---- a double click, or a retry right after a slow answer, must not create two estimates ----
    // Same client, same customer, same total, inside a minute, and not one that failed: return it.
    const since = new Date(now.getTime() - 60_000).toISOString();
    const { data: recent } = await deps.serviceDb.from("deck_estimates").select(ROW_FIELDS)
        // eq, not ilike: "_" is a LIKE wildcard. Every stored email is lowercased by validateEstimate.
        .eq("client_name", client).eq("customer_email", est.customer.email)
        .eq("total", est.total).gte("created_at", since).neq("status", "failed")
        .order("created_at", { ascending: false }).limit(1);
    if (recent && recent.length) return reply({ duplicate: true, estimate: recent[0] });

    const { data: row, error: insErr } = await deps.serviceDb.from("deck_estimates").insert({
        client_name: client, created_by: email,
        customer_name: customerName, customer_email: est.customer.email, customer_phone: est.customer.phone,
        customer_address: est.customer.address, customer_city: est.customer.city,
        customer_postal_code: est.customer.postal_code,
        total: est.total, price_low: est.price_low, line_items: est.line_items,
        deck_summary: est.summary, notes: est.notes, status: "pending",
    }).select(ROW_FIELDS).single();
    if (insErr || !row) {
        console.error(`deck-estimate: insert failed for "${client}": ${insErr?.message}`);
        return reply({ error: "Couldn't save the estimate. Nothing was sent to QuickBooks." }, 500);
    }

    const finish = async (patch: Record<string, unknown>) => {
        const { data } = await deps.serviceDb.from("deck_estimates")
            .update({ ...patch, completed_at: new Date().toISOString() })
            .eq("id", row.id).select(ROW_FIELDS).single();
        return data ?? { ...row, ...patch };
    };

    // ---- hand it to Make ----
    // The contract the client's Make scenario implements is in index.ts's header.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), deps.makeTimeoutMs ?? 60_000);
    let res: Response;
    try {
        res = await deps.fetch(hook!, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                secret,
                estimate_id: row.id,
                client,
                created_by: email,
                customer: est.customer,
                line_items: est.line_items,
                total: est.total,
                price_low: est.price_low,
                notes: est.notes,
                summary: est.summary,
            }),
            signal: ctrl.signal,
        });
    } catch (err) {
        clearTimeout(timer);
        // A timeout or dropped connection doesn't mean it failed: Make may still finish.
        const aborted = (err as Error)?.name === "AbortError";
        const estimate = await finish({
            status: "unconfirmed",
            error: aborted ? "QuickBooks took too long to answer." : "Couldn't reach the automation service.",
        });
        console.error(`deck-estimate: Make call for #${row.id} ${aborted ? "timed out" : "failed"}: ${err}`);
        return reply({ estimate, error: `${estimate.error} Check QuickBooks before trying again, so it isn't created twice.` }, 502);
    }
    clearTimeout(timer);

    const text = await res.text().catch(() => "");
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* Make's default answer is the plain text "Accepted" */ }

    if (!res.ok || data?.ok === false) {
        const why = typeof data?.error === "string" ? data.error.slice(0, 300) : `the automation returned ${res.status}`;
        const estimate = await finish({ status: "failed", error: why });
        return reply({ estimate, error: `QuickBooks didn't create the estimate: ${why}` }, 502);
    }

    const qbId = data?.qb_estimate_id != null ? String(data.qb_estimate_id).slice(0, 64) : "";
    if (!qbId) {
        // Answered OK but said nothing useful: the scenario has no Webhook response module, or it
        // ran but skipped the QuickBooks step. The estimate may exist, so this is not "failed".
        const estimate = await finish({ status: "unconfirmed", error: "The automation didn't report an estimate number." });
        return reply({ estimate, error: `${estimate.error} Check QuickBooks before trying again, so it isn't created twice.` }, 502);
    }

    const estimate = await finish({
        status: "created", error: null,
        qb_estimate_id: qbId,
        qb_doc_number: data.qb_doc_number != null ? String(data.qb_doc_number).slice(0, 64) : null,
        qb_customer_id: data.qb_customer_id != null ? String(data.qb_customer_id).slice(0, 64) : null,
    });
    return reply({ ok: true, estimate });
}
