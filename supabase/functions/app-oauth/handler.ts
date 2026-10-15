// app-oauth: where GHL sends the browser after Golden Eye's private Marketplace app is installed (built 2026-10-15).
// It trades the one-time code for the agency's keys (stored encrypted, see _shared/ghl-oauth.ts) and shows a plain
// page saying whether it worked. It never shows a token. Only an install on Midas Media's own agency is accepted.
//
// Plain text, not HTML: Supabase serves every edge-function response on its own domain as text/plain (with
// nosniff), so an HTML page would show as raw markup. Angle brackets are stripped from anything echoed back anyway.

import { exchangeCode, oauthConfigured, type OAuthDeps } from "../_shared/ghl-oauth.ts";

const clean = (s: unknown) => String(s ?? "").replace(/[<>]/g, "").slice(0, 600);

function page(title: string, lines: string[], status = 200) {
    const text = [title, "=".repeat(title.length), "", ...lines, ""].join("\n");
    return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function handle(req: Request, deps: OAuthDeps & { redirectUri: string }): Promise<Response> {
    if (req.method !== "GET") return page("Not allowed", ["This address only takes GHL's install redirect."], 405);
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) return page("GHL didn't complete the install", [`GHL said: ${clean(error)}`, "Try installing again from the Developer Portal."], 400);
    if (!code) return page("Golden Eye GHL app", ["This is where GHL sends you after installing the Golden Eye app.", "Install it from the app's page in the GHL Developer Portal."]);
    if (!oauthConfigured(deps.env)) {
        return page("Not set up yet", ["Golden Eye is missing the app's settings (GHL_APP_CLIENT_ID, GHL_APP_CLIENT_SECRET, GHL_TOKEN_KEY, GHL_COMPANY_ID).", "Set them, then install again."], 500);
    }
    try {
        const r = await exchangeCode(deps, code, deps.redirectUri);
        console.log(`app-oauth installed for company ${r.companyId} (future locations: ${r.installToFuture}, all locations: ${r.approveAll}, bulk: ${r.isBulk}, approved: ${r.approvedLocations ? r.approvedLocations.join(",") : "not listed"})`);
        const future = r.installToFuture === true
            ? ["It will also reach sub-accounts created from now on."]
            : ["NOTE: it was not installed for future sub-accounts, so new accounts Golden Eye creates may not be reachable."];
        return page("Golden Eye is connected to GHL", ["The app is installed on the agency and its keys are stored securely.", ...future, "", "You can close this tab."]);
    } catch (e) {
        console.error("app-oauth install failed:", (e as Error).message);
        return page("Golden Eye couldn't finish connecting", [clean((e as Error).message)], 400);
    }
}
