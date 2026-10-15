// ghl-provision: the phase 0 account test (built 2026-10-15). See handler.ts for what it may and may not touch.
//
// Modes (POST JSON), in the order the test runs:
//   {"mode":"snapshots"}                                          lists the agency's snapshots (find Master v1.0) and GE TEST accounts
//   {"mode":"create_test","snapshot_id":"…"}                       says what it would create
//   {"mode":"create_test","snapshot_id":"…","confirm":true}        creates "GE TEST <date time>" from the snapshot
//   {"mode":"inspect","location_id":"…"}                           what arrived: custom values, fields, pipelines, workflows
//   {"mode":"fill_test","location_id":"…","confirm":true}          writes 2 test values and reads them back
//
// Setup:
//   supabase secrets set GHL_AGENCY_TOKEN=<agency Private Integration token> GHL_COMPANY_ID=aO4gguGsn5P1gl647qjV --project-ref hugnttsqucetldllfgoi
//   supabase functions deploy ghl-provision --project-ref hugnttsqucetldllfgoi
//   GHL_MASTER_LOCATION_ID and MAKE_WEBHOOK_SECRET already exist (ghl-setup, meta-sync).

import { createClient } from "npm:@supabase/supabase-js@2";
import { handle } from "./handler.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
});

Deno.serve(async (req: Request) => {
    try {
        return await handle(req, {
            env: {
                GHL_AGENCY_TOKEN: Deno.env.get("GHL_AGENCY_TOKEN"),
                GHL_APP_CLIENT_ID: Deno.env.get("GHL_APP_CLIENT_ID"),
                GHL_APP_CLIENT_SECRET: Deno.env.get("GHL_APP_CLIENT_SECRET"),
                GHL_TOKEN_KEY: Deno.env.get("GHL_TOKEN_KEY"),
                GHL_COMPANY_ID: Deno.env.get("GHL_COMPANY_ID"),
                GHL_MASTER_LOCATION_ID: Deno.env.get("GHL_MASTER_LOCATION_ID"),
                MAKE_WEBHOOK_SECRET: Deno.env.get("MAKE_WEBHOOK_SECRET"),
            },
            db,
            fetch,
        });
    } catch (err) {
        console.error("ghl-provision failed:", err);
        return Response.json({ error: "Something went wrong." }, { status: 500 });
    }
});
