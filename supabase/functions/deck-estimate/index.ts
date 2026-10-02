// deck-estimate: the portal's "Create QuickBooks estimate" button (built 2026-10-01).
//
// A rep builds a deck in their client's Deck Calculator tab, enters the customer and clicks the
// button. This function checks they may act for that client, validates the estimate, stores it in
// deck_estimates, hands it to that client's Make scenario (which writes to THEIR QuickBooks), and
// records the QuickBooks estimate number Make sends back. The logic is in handler.ts and
// validate.ts, which import nothing so they can be tested with plain node.
//
// Why not make-relay: make-relay only accepts admins, and the people clicking this are the
// client's own staff, signed in to the portal as clients. Opening make-relay to clients would
// widen every hook it carries; this function opens exactly one action, for exactly the clients
// listed in DECK_ESTIMATE_HOOKS.
//
// Setup, in order:
//   1. Run supabase/sql/deck_estimates.sql, then re-run supabase/sql/rename_client.sql.
//   2. supabase functions deploy deck-estimate --project-ref hugnttsqucetldllfgoi
//      (verify_jwt stays on: callers are always signed in.)
//   3. Until step 4 the button stays hidden: mode "status" answers {ready:false}.
//   4. Once the client's QuickBooks is connected in Make and the scenario below is built:
//        supabase secrets set DECK_ESTIMATE_HOOKS='{"3Sixty Industries":"https://hook.us2.make.com/..."}'
//      Keys are exact clients.name. The URL lives only in this secret, never in the repo or app.js.
//      MAKE_WEBHOOK_SECRET is the same secret every other scenario already checks.
//
// ---------------------------------------------------------------------------------------------
// The Make scenario contract (one scenario per client, connected to that client's QuickBooks)
//
// Request, JSON:
//   secret        MAKE_WEBHOOK_SECRET. FILTER ON IT FIRST, before any QuickBooks module: the hook
//                 URL is the only other thing between the internet and their books.
//   estimate_id   deck_estimates.id. Put "Golden Eye #<id>" in the estimate's private note, so an
//                 estimate can always be traced back to its row.
//   client        exact clients.name
//   created_by    the rep's sign-in email
//   customer      {first_name, last_name, email, phone|null, address|null, city|null, postal_code|null}
//   line_items    [{kind, description, qty, unit, rate, amount}], in display order
//                 kind: decking | footings | railing | steps | waterproofing | demo | adjustment | addon_tbd
//                 Map kind -> a QuickBooks Product/Service (3Sixty picks these; see the client plan).
//                 Only "adjustment" is negative. "addon_tbd" lines are $0, "quoted at consultation".
//                 They sum exactly to `total`.
//   total         the top of the calculator's range, which the estimate carries
//   price_low     the bottom of the range, for the memo if wanted
//   notes         the rep's notes from the calculator, or null
//   summary       {total_sqft, deck_levels, material, rail_type, rail_lf, steps, addons}
//
// Customer: search QuickBooks by EXACT email (filter on it; never act on a fuzzy search result,
// see CLAUDE.md's 10-lead incident), create the customer only if none matches.
//
// Response: a "Webhook response" module, status 200, JSON:
//   success  {"ok": true, "qb_estimate_id": "...", "qb_doc_number": "...", "qb_customer_id": "..."}
//   failure  {"ok": false, "error": "<why, readable by a rep>"}
// With no Webhook response module Make answers the plain text "Accepted", which this function
// records as "unconfirmed": the estimate may exist, so the rep is told to check before retrying.
// Add an error handler on the QuickBooks modules that responds {"ok": false, ...}, or a
// QuickBooks refusal also lands as "unconfirmed" after the 60-second timeout.
//
// Still to confirm on the first real test: whether QuickBooks accepts the negative adjustment as an
// ordinary line or needs a discount line, and how it rounds qty x rate for fractional square feet.
// ---------------------------------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2";
import { handle, corsHeaders } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceDb = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
});

Deno.serve(async (req: Request) => {
    try {
        return await handle(req, {
            env: {
                MAKE_WEBHOOK_SECRET: Deno.env.get("MAKE_WEBHOOK_SECRET"),
                DECK_ESTIMATE_HOOKS: Deno.env.get("DECK_ESTIMATE_HOOKS"),
            },
            serviceDb,
            userDbFor: (jwt: string) => createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
                global: { headers: { Authorization: `Bearer ${jwt}` } },
                auth: { persistSession: false },
            }),
            fetch,
        });
    } catch (err) {
        console.error("deck-estimate failed:", err);
        return Response.json({ error: "Something went wrong creating the estimate." }, { status: 500, headers: corsHeaders(req) });
    }
});
