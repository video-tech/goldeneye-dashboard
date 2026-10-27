// estimate-share: a read-only link a rep can send a homeowner (built 2026-10-27).
//
// A rep builds the deck in the Deck Calculator tab and clicks "Create link". This function stores
// a frozen copy of the estimate (the SNAPSHOT) under a long random token and returns the link.
// The homeowner opens estimate.html?t=<token>, which asks this function for the snapshot. They
// can read it and print it; nothing in it can be edited, and changing the deck afterwards doesn't
// change a link that was already made.
//
// Two kinds of caller, in one function because they share a table:
//   public   mode "view"            the homeowner's page. No sign-in; the token IS the credential.
//   signed in  "create" | "revoke"  a rep acting for a client they can see (client_row_visible,
//                                   asked as the caller, exactly like deck-estimate).
//
// No Deno or npm imports: the clients and the clock are passed in so the tests run it under node.

import { validateShare, validToken } from "./validate.ts";

export type Env = {
    // Where the homeowner page lives. Default is GitHub Pages beside the portal.
    SHARE_VIEW_URL?: string;
};

export type Deps = {
    env: Env;
    serviceDb: any;                       // service_role: reads and writes shared_estimates
    userDbFor: (jwt: string) => any;      // runs as the CALLER, so client_row_visible() answers for them
    now?: () => Date;
    randomToken?: () => string;           // 64 hex chars; injected by tests
};

export const DEFAULT_VIEW_URL = "https://video-tech.github.io/goldeneye-dashboard/estimate.html";
export const LINK_DAYS = 30;              // matches the 30 days 3Sixty's QuickBooks estimates stay open
export const MAX_LINKS_PER_HOUR = 30;     // per rep, so a stuck button can't fill the table

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

export function newToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function linkFor(env: Env, token: string): string {
    return `${env.SHARE_VIEW_URL || DEFAULT_VIEW_URL}?t=${token}`;
}

const GONE = "This estimate link has expired or was turned off. Ask 3Sixty to send you a new one.";

export async function handle(req: Request, deps: Deps): Promise<Response> {
    const cors = corsHeaders(req);
    const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
        Response.json(body, { status, headers: { ...cors, ...extra } });
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return reply({ error: "POST only" }, 405);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return reply({ error: "The request wasn't valid JSON." }, 400);
    const mode = String(body.mode ?? "");
    const now = (deps.now ?? (() => new Date()))();

    // ================= public: the homeowner's page =================
    if (mode === "view") {
        // One answer for "no such token", "expired" and "turned off", so a visitor can't tell which.
        if (!validToken(body.token)) return reply({ error: GONE }, 404, { "Cache-Control": "no-store" });
        const { data: row } = await deps.serviceDb.from("shared_estimates")
            .select("token, created_at, expires_at, revoked_at, snapshot, view_count, first_viewed_at")
            .eq("token", body.token).maybeSingle();
        if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= now.getTime()) {
            return reply({ error: GONE }, 404, { "Cache-Control": "no-store" });
        }
        // The rep opening their own link ("Open" in the portal) sends preview:true and isn't counted.
        if (body.preview !== true) {
            await deps.serviceDb.from("shared_estimates").update({
                view_count: (row.view_count ?? 0) + 1,
                last_viewed_at: now.toISOString(),
                first_viewed_at: row.first_viewed_at ?? now.toISOString(),
            }).eq("token", row.token);
        }
        // Only the snapshot and the expiry. Never who made it or which client's row it is.
        return reply({ snapshot: row.snapshot, expires_at: row.expires_at }, 200, { "Cache-Control": "no-store" });
    }

    // ================= signed in: a rep =================
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

    if (mode !== "create" && mode !== "revoke") return reply({ error: "Unknown mode." }, 400);
    const client = typeof body.client === "string" ? body.client : "";
    if (!client || client.length > 200) return reply({ error: "No client was named." }, 400);

    const { data: visible, error: visErr } = await userDb.rpc("client_row_visible", { p_client: client });
    if (visErr) {
        console.error(`estimate-share: client_row_visible failed for ${email}: ${visErr.message}`);
        return reply({ error: "Couldn't check your access to this client. Try again in a minute." }, 500);
    }
    if (visible !== true) {
        console.warn(`estimate-share REFUSED: ${email} has no access to "${client}"`);
        return reply({ error: "You don't have access to this client." }, 403);
    }
    const { data: clientRow } = await deps.serviceDb.from("clients").select("name").eq("name", client).maybeSingle();
    if (!clientRow) return reply({ error: `No client is named "${client}".` }, 404);

    // ---- turn a link off ----
    if (mode === "revoke") {
        if (!validToken(body.token)) return reply({ error: "That link isn't valid." }, 400);
        // Matched on client too, so a rep can only turn off links that belong to a client they can see.
        const { data: row } = await deps.serviceDb.from("shared_estimates")
            .select("token, revoked_at").eq("token", body.token).eq("client_name", client).maybeSingle();
        if (!row) return reply({ error: "No such link for this client." }, 404);
        if (!row.revoked_at) {
            await deps.serviceDb.from("shared_estimates").update({ revoked_at: now.toISOString() }).eq("token", row.token);
        }
        return reply({ ok: true });
    }

    // ---- make a link ----
    const v = validateShare(body.estimate, now);
    if (!v.ok) return reply({ error: v.errors.join(" "), errors: v.errors }, 400);

    const since = new Date(now.getTime() - 3_600_000).toISOString();
    const { data: recent } = await deps.serviceDb.from("shared_estimates")
        .select("token").eq("created_by", email).gte("created_at", since).limit(MAX_LINKS_PER_HOUR + 1);
    if (recent && recent.length >= MAX_LINKS_PER_HOUR) {
        return reply({ error: "That's a lot of links in an hour. Wait a bit, or reuse one you already made." }, 429);
    }

    const token = (deps.randomToken ?? newToken)();
    const expires = new Date(now.getTime() + LINK_DAYS * 86_400_000).toISOString();
    const { error: insErr } = await deps.serviceDb.from("shared_estimates").insert({
        token, client_name: client, created_by: email, expires_at: expires,
        prepared_for: v.value.prepared_for || null, total: v.value.total, snapshot: v.value.snapshot,
    });
    if (insErr) {
        console.error(`estimate-share: insert failed for "${client}": ${insErr.message}`);
        return reply({ error: "Couldn't save the link. Nothing was made." }, 500);
    }
    return reply({ ok: true, token, url: linkFor(deps.env, token), expires_at: expires });
}
