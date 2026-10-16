// ghl-contact-check: is each client a contact in our Midas GHL, exactly once? See handler.ts. Read only.
//
// Setup (in order):
//   1. In our Midas GHL account: Settings > Private Integrations > Create, ONE scope: Contacts > View Contacts (read).
//   2. supabase secrets set GHL_MIDAS_TOKEN=<that token> GHL_MIDAS_LOCATION_ID=<our Midas GHL location id> --project-ref hugnttsqucetldllfgoi
//   3. supabase/sql/ghl_contact_check.sql, then supabase/sql/rename_client.sql
//   4. supabase functions deploy ghl-contact-check --project-ref hugnttsqucetldllfgoi
//   5. supabase/functions/ghl-contact-check/schedule.sql

import { createClient } from "npm:@supabase/supabase-js@2";
import { handle } from "./handler.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
});

Deno.serve(async (req: Request) => {
    try {
        return await handle(req, {
            env: {
                GHL_MIDAS_TOKEN: Deno.env.get("GHL_MIDAS_TOKEN"),
                GHL_MIDAS_LOCATION_ID: Deno.env.get("GHL_MIDAS_LOCATION_ID"),
                MAKE_WEBHOOK_SECRET: Deno.env.get("MAKE_WEBHOOK_SECRET"),
            },
            db,
            fetch,
        });
    } catch (err) {
        console.error("ghl-contact-check failed:", err);
        return Response.json({ error: "Something went wrong." }, { status: 500 });
    }
});
