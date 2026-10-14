// overview-chat: the chat on Golden Eye's Overview page. Ask anything about clients, ads, tasks,
// check-ins, SEO and onboarding. It answers by running read-only lookups (tools.ts) as the signed-in
// admin, so row-level security applies as in the dashboard and nothing is writable.
//
// Access: a signed-in ADMIN only (_shared/admin-auth.ts, same rule as ai-chat), from Golden Eye's own
// origins. Every lookup runs with the caller's own JWT, never the service key.
//
// Model: gpt-5.6-sol through the Responses API, the same as the morning audit, at low reasoning
// effort (this is lookup and summary, and effort is the cost dial). Stateless: nothing is stored at
// OpenAI (store: false), and the reasoning items are passed back as encrypted content.
//
// Deploy:  supabase functions deploy overview-chat --project-ref hugnttsqucetldllfgoi
//          Push app.js after this is deployed. Secret: OPENAI_API_KEY (already set project-wide).

import OpenAI from "npm:openai";
import { createClient } from "npm:@supabase/supabase-js@2";
import { adminCheck } from "../_shared/admin-auth.ts";
import { allowOrigin } from "../ai-chat/validate.ts";
import { runChat, systemPrompt } from "./chat.ts";
import { validateTurns } from "./validate.ts";

const MODEL = "gpt-5.6-sol";

function corsHeaders(req: Request): Record<string, string> {
    return {
        "Access-Control-Allow-Origin": allowOrigin(req.headers.get("Origin")),
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
    };
}
const fail = (message: string, status: number, headers: Record<string, string>) =>
    Response.json({ error: { message } }, { status, headers });

// Today's calendar date where the team works
const denverToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

Deno.serve(async (req: Request) => {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return fail("POST only", 405, cors);

    try {
        const url = Deno.env.get("SUPABASE_URL")!;
        const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        const who = await adminCheck(service, req);
        if (!who.ok) {
            console.warn("overview-chat REFUSED:", who.reason);
            return fail(who.reason, 403, cors);
        }

        const checked = validateTurns(await req.json().catch(() => null));
        if (!checked.ok) return fail(checked.error, 400, cors);

        const apiKey = Deno.env.get("OPENAI_API_KEY");
        if (!apiKey) return fail("OPENAI_API_KEY is not set", 500, cors);

        // Lookups run as the admin: their own JWT, so RLS applies
        const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
        const asAdmin = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: `Bearer ${jwt}` } } });

        const openai = new OpenAI({ apiKey });
        const today = denverToday();
        const result = await runChat({
            turns: checked.turns,
            today,
            ctx: { db: asAdmin, today, cache: {} },
            createResponse: (req2) => openai.responses.create({
                model: MODEL,
                instructions: systemPrompt(today),
                input: req2.input,
                tools: req2.tools,
                tool_choice: req2.tool_choice,
                reasoning: { effort: "low" },
                max_output_tokens: 6000,
                store: false,
                include: ["reasoning.encrypted_content"],
            }),
        });

        if (!result.ok) return fail(result.error, 422, cors);
        console.log(`overview-chat: ${who.ok && who.kind === "admin" ? who.email : "?"} rounds=${result.rounds} looked_at=${result.looked_at.join(",")}`);
        return Response.json({ reply: result.reply, looked_at: result.looked_at }, { headers: cors });
    } catch (err) {
        console.error("overview-chat failed:", err);
        return fail(String((err as Error)?.message ?? err), 500, cors);
    }
});
