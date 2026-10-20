// app-oauth: the Redirect URL of Golden Eye's private GHL Marketplace app. See handler.ts.
//
// Setup:
//   1. Run supabase/sql/ghl_oauth.sql.
//   2. supabase secrets set GHL_APP_CLIENT_ID=… GHL_APP_CLIENT_SECRET=… GHL_TOKEN_KEY=<32 random bytes, base64> --project-ref hugnttsqucetldllfgoi
//      (GHL_COMPANY_ID is already set.)
//   3. supabase functions deploy app-oauth --project-ref hugnttsqucetldllfgoi   (verify_jwt = false: GHL redirects a browser here)
//   4. In the Developer Portal the app's Redirect URL is https://hugnttsqucetldllfgoi.supabase.co/functions/v1/app-oauth

import { createClient } from "npm:@supabase/supabase-js@2";
import { handle } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req: Request) => {
    try {
        return await handle(req, {
            env: {
                GHL_APP_CLIENT_ID: Deno.env.get("GHL_APP_CLIENT_ID"),
                GHL_APP_CLIENT_SECRET: Deno.env.get("GHL_APP_CLIENT_SECRET"),
                GHL_TOKEN_KEY: Deno.env.get("GHL_TOKEN_KEY"),
                GHL_COMPANY_ID: Deno.env.get("GHL_COMPANY_ID"),
            },
            db,
            fetch,
            redirectUri: `${url}/functions/v1/app-oauth`,
        });
    } catch (err) {
        console.error("app-oauth failed:", err);
        return new Response("Something went wrong.", { status: 500 });
    }
});
