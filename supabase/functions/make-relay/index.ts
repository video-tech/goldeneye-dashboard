// Make relay — the browser's only way to reach a Make webhook.
//
// Why this exists: every Make webhook URL in app.js is public (page source), and anything
// holding one can run its scenario. On 2026-09-11 an empty request to the onboarding-complete
// hook texted 10 leads (see CLAUDE.md). A server-side caller can prove itself with a secret, but a
// browser can't, since any secret shipped in app.js is public too. So the browser asks this
// function instead. It checks the caller is a signed-in admin, attaches MAKE_WEBHOOK_SECRET, and
// forwards to Make. Each Make scenario filters on `secret`, so a request straight to the hook
// URL does nothing.
//
// Only named hooks, and only allow-listed fields from the browser, pass through. This is not a
// general proxy, since an open relay would just hand out the secret's authority.
//
// Deploy:  supabase functions deploy make-relay --project-ref hugnttsqucetldllfgoi
// Secret:  MAKE_WEBHOOK_SECRET (the same value Make's filters check)

import { createClient } from "npm:@supabase/supabase-js@2";

type HookSpec = {
    url: string;
    // Form-encoded for hooks Make already parses that way, since changing the encoding changes
    // how Make maps the fields. Report drafts carry an array (to_email), so they're JSON.
    encoding: "json" | "form";
    fields: string[];
};

const HOOKS: Record<string, HookSpec> = {
    // Scenario #7 — Draft button on a report
    report_draft: {
        url: "https://hook.us2.make.com/apq7ghcun1hza8h5ayw1xysy81nddh8v",
        encoding: "json",
        fields: ["client", "subject", "full_email_html", "to_email"],
    },
    // Scenario #8 — fetch Meta's previews for an ad awaiting approval
    ad_preview: {
        url: "https://hook.us2.make.com/2kan16ro46vkcxsubi90aaobv1ym1fxg",
        encoding: "form",
        fields: ["approval_id", "ad_id", "client_name", "ad_name"],
    },
};

const ALLOWED_ORIGINS = [
    "https://goldeneye.midasmediafirm.com",
    "https://video-tech.github.io",
];

function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("Origin") ?? "";
    return {
        "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
    };
}

// Same check as seo-sync / seranking-sync: the gateway only proves the caller has *a* valid
// JWT, which any signed-in client also has.
async function callerIsAdmin(db: any, req: Request): Promise<boolean> {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return false;
    const { data, error } = await db.auth.getUser(jwt);
    const email = data?.user?.email;
    if (error || !email) return false;
    const { data: profile } = await db.from("user_profiles").select("role").eq("email", email).maybeSingle();
    return profile?.role === "admin";
}

Deno.serve(async (req: Request) => {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405, headers: cors });

    try {
        const secret = Deno.env.get("MAKE_WEBHOOK_SECRET");
        // Fail closed: without the secret Make's filter would drop the request anyway, and
        // saying so here beats a button that reports success while nothing happens.
        if (!secret) return Response.json({ error: "MAKE_WEBHOOK_SECRET is not set" }, { status: 500, headers: cors });

        const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        if (!await callerIsAdmin(db, req)) {
            return Response.json({ error: "admin sign-in required" }, { status: 403, headers: cors });
        }

        const body = await req.json().catch(() => ({}));
        const spec = HOOKS[String(body?.hook ?? "")];
        if (!spec) return Response.json({ error: "unknown hook" }, { status: 400, headers: cors });

        const input = (body?.payload && typeof body.payload === "object") ? body.payload : {};
        const out: Record<string, unknown> = {};
        for (const f of spec.fields) if (f in input) out[f] = input[f];

        let res: Response;
        if (spec.encoding === "json") {
            res = await fetch(spec.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...out, secret }),
            });
        } else {
            const form = new URLSearchParams();
            for (const [k, v] of Object.entries(out)) form.set(k, String(v ?? ""));
            form.set("secret", secret);
            res = await fetch(spec.url, { method: "POST", body: form });
        }

        if (!res.ok) {
            const text = (await res.text()).slice(0, 300);
            return Response.json({ error: `Make returned ${res.status}: ${text}` }, { status: 502, headers: cors });
        }
        return Response.json({ ok: true }, { headers: cors });
    } catch (err) {
        console.error("make-relay failed:", err);
        return Response.json({ error: String((err as Error)?.message ?? err) }, { status: 500, headers: cors });
    }
});
