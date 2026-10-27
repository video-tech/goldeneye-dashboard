// estimate-share: the Deck Calculator's "send the homeowner a link" (built 2026-10-27).
// The logic is in handler.ts and validate.ts, which import nothing from Deno or npm so they can be
// tested with plain node. This file only supplies the real database clients.
//
// Setup, in order:
//   1. Run supabase/sql/shared_estimates.sql, then re-run supabase/sql/rename_client.sql.
//   2. supabase functions deploy estimate-share --project-ref hugnttsqucetldllfgoi
//      verify_jwt is OFF for this function (supabase/config.toml): the homeowner's page has no
//      sign-in. The public "view" mode needs only the link's token; every other mode checks the
//      caller's own session inside handler.ts, exactly as deck-estimate does.
//   3. Push app.js, body.html and estimate.html. Optional secret SHARE_VIEW_URL if the homeowner
//      page ever moves; the default is GitHub Pages beside the portal.

import { createClient } from "npm:@supabase/supabase-js@2";
import { handle, corsHeaders } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceDb = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
});

Deno.serve(async (req: Request) => {
    try {
        return await handle(req, {
            env: { SHARE_VIEW_URL: Deno.env.get("SHARE_VIEW_URL") },
            serviceDb,
            userDbFor: (jwt: string) => createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
                global: { headers: { Authorization: `Bearer ${jwt}` } },
                auth: { persistSession: false },
            }),
        });
    } catch (err) {
        console.error("estimate-share failed:", err);
        return Response.json({ error: "Something went wrong." }, { status: 500, headers: corsHeaders(req) });
    }
});
