// ghl-account: Golden Eye makes each new client's GHL account from MasterV.1, and fills it once the Golden Eye app is
// installed on it. See handler.ts for who qualifies and what it may touch.
//
// Modes (POST JSON). The schedule sends {"mode":"sweep"} every 10 minutes (schedule.sql); the rest are for an admin.
//   {"mode":"status"}                                   accounts made so far, who is ready, and why everyone else waits
//   {"mode":"sweep"}                                    create accounts for whoever is ready (if GHL_AUTO_CREATE=on), fill installed ones
//   {"mode":"create","client":"<name>","confirm":true}  create one now (same rules)
//   {"mode":"fill","client":"<name>"}                   fill one now, once the app is installed on it
//   {"mode":"retry","client":"<name>","confirm":true}   try a failed creation again (only when no account was made)
//
// Setup (in order):
//   1. supabase/sql/ghl_accounts.sql, then supabase/sql/rename_client.sql
//   2. supabase secrets set GHL_SNAPSHOT_ID=XySR40RNsweVul9Gxtlp GHL_AUTO_CREATE=on GHL_APP_INSTALL_URL=<the app's install link> --project-ref hugnttsqucetldllfgoi
//      (GHL_APP_CLIENT_ID, GHL_APP_CLIENT_SECRET, GHL_TOKEN_KEY, GHL_COMPANY_ID, GHL_MASTER_LOCATION_ID, MAKE_WEBHOOK_SECRET exist already)
//   3. supabase functions deploy ghl-account --project-ref hugnttsqucetldllfgoi
//   4. supabase/functions/ghl-account/schedule.sql
// Switch it off: supabase secrets set GHL_AUTO_CREATE=off (the sweep then only reports who it would create).

import { createClient } from "npm:@supabase/supabase-js@2";
import { handle } from "./handler.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
});

const env = (k: string) => Deno.env.get(k);

Deno.serve(async (req: Request) => {
    try {
        return await handle(req, {
            env: {
                GHL_APP_CLIENT_ID: env("GHL_APP_CLIENT_ID"),
                GHL_APP_CLIENT_SECRET: env("GHL_APP_CLIENT_SECRET"),
                GHL_TOKEN_KEY: env("GHL_TOKEN_KEY"),
                GHL_COMPANY_ID: env("GHL_COMPANY_ID"),
                GHL_APP_ID: env("GHL_APP_ID"),
                GHL_MASTER_LOCATION_ID: env("GHL_MASTER_LOCATION_ID"),
                GHL_SNAPSHOT_ID: env("GHL_SNAPSHOT_ID"),
                GHL_AUTO_CREATE: env("GHL_AUTO_CREATE"),
                GHL_APP_INSTALL_URL: env("GHL_APP_INSTALL_URL"),
                MAKE_WEBHOOK_SECRET: env("MAKE_WEBHOOK_SECRET"),
            },
            db,
            fetch,
        });
    } catch (err) {
        console.error("ghl-account failed:", err);
        return Response.json({ error: "Something went wrong." }, { status: 500 });
    }
});
