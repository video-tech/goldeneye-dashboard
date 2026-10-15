// ghl-setup: phase 0 of the onboarding rebuild (built 2026-10-14). Talks to GHL's REST API for the
// MASTER sub-account only, the one the snapshot is saved from. GHL's MCP connector has no custom
// values tools, so this is how Master's custom values get listed and created, and the base the
// later account-creation function (phases 2 and 3) builds on. The logic is in handler.ts and plan.ts.
//
// Modes (POST JSON):
//   {"mode":"check"}                    lists Master's custom values against the plan's 22. Default.
//   {"mode":"create"}                   the same, saying what it WOULD create. Writes nothing.
//   {"mode":"create","confirm":true}    creates the missing ones, empty, then reads them back.
//
// Callers: a signed-in admin, or the SQL Editor with the cron secret (run.sql has the calls).
// The location id comes from a secret, never from the request, so no call can reach a client's account.
//
// Setup:
//   supabase secrets set GHL_MASTER_TOKEN=<Master's Private Integration token> GHL_MASTER_LOCATION_ID=sXL42Tk6BFlMz8GEe5LQ --project-ref hugnttsqucetldllfgoi
//   supabase functions deploy ghl-setup --project-ref hugnttsqucetldllfgoi
//   The token needs "View Custom Values" and "Edit Custom Values". MAKE_WEBHOOK_SECRET already exists.

import { createClient } from "npm:@supabase/supabase-js@2";
import { handle } from "./handler.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
});

Deno.serve(async (req: Request) => {
    try {
        return await handle(req, {
            env: {
                GHL_MASTER_TOKEN: Deno.env.get("GHL_MASTER_TOKEN"),
                GHL_MASTER_LOCATION_ID: Deno.env.get("GHL_MASTER_LOCATION_ID"),
                MAKE_WEBHOOK_SECRET: Deno.env.get("MAKE_WEBHOOK_SECRET"),
            },
            db,
            fetch,
        });
    } catch (err) {
        console.error("ghl-setup failed:", err);
        return Response.json({ error: "Something went wrong." }, { status: 500 });
    }
});
