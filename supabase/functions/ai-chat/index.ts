// ai-chat — the dashboard's model calls: the Client Intelligence Agent chat and Generate Report.
//
// Replaced 2026-09-16. The previous version (never in this repo; downloaded from the project to
// review it) had no sign-in check and `Access-Control-Allow-Origin: *`, and forwarded whatever
// `messages` it was sent to OpenAI. The anon key in the page source was enough to call it, so
// anyone could run requests on our OpenAI account. This version:
//   - requires a signed-in ADMIN, verified here: the gateway only proves the caller holds a valid
//     JWT, and every portal client has one;
//   - only answers browser requests from Golden Eye's own origins;
//   - passes on role + content only, within size limits (validate.ts);
//   - keeps the same model, temperature, request and response shape, so both callers work as before.
//
// Deploy:  supabase functions deploy ai-chat --project-ref hugnttsqucetldllfgoi
//          Push app.js FIRST (it sends the session token, which the old function also accepts,
//          since it checks nothing), confirm it's served, then deploy this. The other order breaks
//          the chat and Generate Report until the push lands: this refuses the anon key old app.js sent.
// Secret:  OPENAI_API_KEY (unchanged, project-wide)

import { createClient } from "npm:@supabase/supabase-js@2";
import { allowOrigin, validateMessages } from "./validate.ts";
import { adminCheck } from "../_shared/admin-auth.ts";

// Unchanged from the version it replaces, deliberately: this fix is about access, and a model
// change would alter every report and chat answer at the same time. Worth revisiting separately.
const MODEL = "gpt-4o-mini";
const TEMPERATURE = 0.4;

function corsHeaders(req: Request): Record<string, string> {
    return {
        "Access-Control-Allow-Origin": allowOrigin(req.headers.get("Origin")),
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
    };
}

// The signed-in admin check, with a reason when refused, lives in _shared/admin-auth.ts so
// morning-audit uses the identical rule.

// Errors keep the shape both callers already read: `data.error.message`.
const fail = (message: string, status: number, headers: Record<string, string>) =>
    Response.json({ error: { message } }, { status, headers });

Deno.serve(async (req: Request) => {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return fail("POST only", 405, cors);

    try {
        const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        const who = await adminCheck(db, req);
        if (!who.ok) {
            console.warn("ai-chat REFUSED:", who.reason);
            return fail(who.reason, 403, cors);
        }

        const body = await req.json().catch(() => null);
        const checked = validateMessages(body);
        if (!checked.ok) return fail(checked.error, 400, cors);

        const apiKey = Deno.env.get("OPENAI_API_KEY");
        if (!apiKey) return fail("OPENAI_API_KEY is not set", 500, cors);

        const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: MODEL, messages: checked.messages, temperature: TEMPERATURE }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) {
            // OpenAI's own message is useful ("rate limit", "context too long"); never the key
            const message = data?.error?.message ?? `OpenAI returned ${res.status}`;
            console.error("ai-chat: OpenAI error", res.status, message);
            return fail(message, 502, cors);
        }
        return Response.json(data, { headers: cors });
    } catch (err) {
        console.error("ai-chat failed:", err);
        return fail(String((err as Error)?.message ?? err), 500, cors);
    }
});
