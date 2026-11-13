// onboarding-booking: see handler.ts. verify_jwt is off (supabase/config.toml): GHL can't send a Supabase JWT, so the
// GHL_WEBHOOK_SECRET (the same one Lead Relay's webhook sends as x-webhook-secret, or ?k=) is the gate, and an unset secret
// refuses everything.
// Deploy: supabase functions deploy onboarding-booking --project-ref hugnttsqucetldllfgoi

import { createClient } from "npm:@supabase/supabase-js@2";
import { handle, type Db } from "./handler.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const store: Db = {
    async clients() {
        const { data, error } = await db.from("clients").select("name, client_email, status");
        if (error) throw new Error(`clients: ${error.message}`);
        return data ?? [];
    },
    async bookingSteps() {
        const { data, error } = await db.from("onboarding_steps").select("id, embed_url")
            .eq("owner", "client").eq("step_type", "form").eq("active", true);
        if (error) throw new Error(`onboarding_steps: ${error.message}`);
        return data ?? [];
    },
    async progress(client, stepId) {
        const { data, error } = await db.from("client_onboarding_progress").select("id, completed_at")
            .eq("client_name", client).eq("step_id", stepId).order("completed_at", { ascending: false, nullsFirst: false }).limit(1);
        if (error) throw new Error(`progress: ${error.message}`);
        return data?.[0] ?? null;
    },
    async insertProgress(row) {
        const { error } = await db.from("client_onboarding_progress").insert(row);
        if (error) throw new Error(`insert progress: ${error.message}`);
    },
    async completeProgress(id, completedAt) {
        const { error } = await db.from("client_onboarding_progress")
            .update({ completed_at: completedAt, completed_by: "booking" }).eq("id", id).is("completed_at", null);
        if (error) throw new Error(`update progress: ${error.message}`);
    },
};

Deno.serve(async (req: Request) => {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const url = new URL(req.url);
    let body: unknown = {};
    try { body = await req.json(); } catch { /* an empty or non-JSON body is answered below */ }
    try {
        const r = await handle({
            secret: Deno.env.get("GHL_WEBHOOK_SECRET") ?? null,
            given: req.headers.get("x-webhook-secret") ?? url.searchParams.get("k"),
            body,
        }, store);
        // The client name only: never the email or anything else from the booking
        console.log(`onboarding-booking ${r.status} ${JSON.stringify(r.body)}`);
        return Response.json(r.body, { status: r.status });
    } catch (e) {
        console.error("onboarding-booking failed:", (e as Error).message);
        return Response.json({ error: "failed" }, { status: 500 });
    }
});
