// ghl-estimate-contact: save a deck estimate PDF to a contact in the client's own GHL (built 2026-10-28).
// The logic is in handler.ts, which imports nothing from Deno or npm so it can be tested with plain node.
//
// Setup, in order (PowerShell):
//   1. In the CLIENT's GHL account (3Sixty's): Settings > Private Integrations > Create new integration.
//      Scopes: View Contacts, Edit Contacts (notes), and Media Library read + write. Copy the token once.
//   2. supabase secrets set GHL_3SIXTY_TOKEN=<that token> --project-ref hugnttsqucetldllfgoi
//      (the secret name per client is the ACCOUNTS table in handler.ts; the location id is the client's
//      clients.ghl_location_id, so it is not a secret.)
//   3. supabase/sql/contact_estimate_files.sql, then supabase/sql/rename_client.sql
//   4. supabase functions deploy ghl-estimate-contact --project-ref hugnttsqucetldllfgoi
//      verify_jwt stays ON: every caller is signed in to Golden Eye.
// Until step 2 the portal panel stays hidden: mode "status" answers {ready:false}.

import { createClient } from "npm:@supabase/supabase-js@2";
import { handle, corsHeaders, ACCOUNTS } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceDb = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
});

Deno.serve(async (req: Request) => {
    try {
        const env: Record<string, string | undefined> = {};
        for (const name of Object.values(ACCOUNTS)) env[name] = Deno.env.get(name);
        return await handle(req, {
            env,
            serviceDb,
            userDbFor: (jwt: string) => createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
                global: { headers: { Authorization: `Bearer ${jwt}` } },
                auth: { persistSession: false },
            }),
            fetch,
        });
    } catch (err) {
        console.error("ghl-estimate-contact failed:", err);
        return Response.json({ error: "Something went wrong." }, { status: 500, headers: corsHeaders(req) });
    }
});
