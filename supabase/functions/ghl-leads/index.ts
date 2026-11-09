// ghl-leads: lead counts from a client's own GHL for the Leads check in Generate Report. See handler.ts. Read only.
//
// Setup:
//   1. supabase/sql/lead_check.sql (adds clients.lead_tags)
//   2. supabase functions deploy ghl-leads --project-ref hugnttsqucetldllfgoi
//   3. GHL Developer Portal: add "View Contacts" (contacts.readonly) to the Golden Eye app, then reinstall it from the
//      agency and tick each client's sub-account.
//   4. Each client: GHL location ID and GHL lead tags in Edit Client.
// Uses the existing GHL_APP_* / GHL_TOKEN_KEY / GHL_COMPANY_ID secrets, and GHL_MIDAS_TOKEN for our own sub-account.

import { createClient } from "npm:@supabase/supabase-js@2";
import { handle } from "./handler.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
});

Deno.serve(async (req: Request) => {
    try {
        return await handle(req, {
            env: {
                GHL_APP_CLIENT_ID: Deno.env.get("GHL_APP_CLIENT_ID"),
                GHL_APP_CLIENT_SECRET: Deno.env.get("GHL_APP_CLIENT_SECRET"),
                GHL_TOKEN_KEY: Deno.env.get("GHL_TOKEN_KEY"),
                GHL_COMPANY_ID: Deno.env.get("GHL_COMPANY_ID"),
                GHL_MIDAS_TOKEN: Deno.env.get("GHL_MIDAS_TOKEN"),
                GHL_MIDAS_LOCATION_ID: Deno.env.get("GHL_MIDAS_LOCATION_ID"),
            },
            db,
            fetch,
        });
    } catch (err) {
        console.error("ghl-leads failed:", err);
        return Response.json({ error: "Something went wrong." }, { status: 500 });
    }
});
