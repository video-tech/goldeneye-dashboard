// Golden Eye's private GHL Marketplace app (built 2026-10-15): storing its keys and getting tokens from them.
// No imports: db, fetch and the environment are passed in, so app-oauth.test.mjs runs this under plain node.
//
// The app is installed once on the agency. GHL then gives a Company (agency) access token (~24 h) and a refresh
// token (1 year or until used; each use returns a new one and kills the old). A Company token is exchanged for a
// Location token to work inside one sub-account (/oauth/locationToken, scope oauth.write), which is what an agency
// Private Integration token can't do.
//
// Tokens live in ghl_oauth_tokens, encrypted with AES-GCM under GHL_TOKEN_KEY (base64, 32 bytes). Nothing here
// ever logs or returns a token.

export type OAuthEnv = {
    GHL_APP_CLIENT_ID?: string;
    GHL_APP_CLIENT_SECRET?: string;
    GHL_TOKEN_KEY?: string;
    GHL_COMPANY_ID?: string;
};

export type OAuthDeps = { env: OAuthEnv; db: any; fetch: typeof fetch; now?: () => Date };

const GHL = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
// Renew this long before the access token actually expires.
const RENEW_EARLY_MS = 5 * 60 * 1000;

export function oauthConfigured(env: OAuthEnv): boolean {
    return !!(env.GHL_APP_CLIENT_ID?.trim() && env.GHL_APP_CLIENT_SECRET?.trim() && env.GHL_TOKEN_KEY?.trim() && env.GHL_COMPANY_ID?.trim());
}

// ---- encryption ----
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(env: OAuthEnv): Promise<CryptoKey> {
    const raw = unb64(String(env.GHL_TOKEN_KEY ?? "").trim());
    if (raw.length !== 32) throw new Error("GHL_TOKEN_KEY must be 32 random bytes, base64-encoded.");
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(env: OAuthEnv, text: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), new TextEncoder().encode(text)));
    return `${b64(iv)}.${b64(ct)}`;
}

export async function decrypt(env: OAuthEnv, stored: string): Promise<string> {
    const [iv, ct] = String(stored).split(".");
    if (!iv || !ct) throw new Error("A stored GHL token isn't in the expected format.");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(env), unb64(ct));
    return new TextDecoder().decode(pt);
}

// ---- talking to GHL ----
async function form(deps: OAuthDeps, path: string, fields: Record<string, string>, bearer?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json", "Version": VERSION };
    if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
    const res = await deps.fetch(GHL + path, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
        const secrets = [deps.env.GHL_APP_CLIENT_SECRET, bearer, fields.code, fields.refresh_token].filter(Boolean) as string[];
        let msg = String(json?.error_description ?? json?.message ?? json?.error ?? text ?? "").slice(0, 300);
        for (const s of secrets) msg = msg.split(s).join("[secret]");
        const err = new Error(`GHL ${path} answered ${res.status}: ${msg}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
    }
    return json;
}

function expiresAt(deps: OAuthDeps, json: any): string {
    const secs = Number(json?.expires_in) || 3600;
    return new Date((deps.now ?? (() => new Date()))().getTime() + secs * 1000).toISOString();
}

// The install's redirect: trade the code for the agency's tokens and store them. Refuses anything that isn't a
// Company (agency) install of OUR agency, so nobody can plant their own agency's keys by installing the app.
export async function exchangeCode(deps: OAuthDeps, code: string, redirectUri: string) {
    const json = await form(deps, "/oauth/token", {
        client_id: deps.env.GHL_APP_CLIENT_ID!.trim(),
        client_secret: deps.env.GHL_APP_CLIENT_SECRET!.trim(),
        grant_type: "authorization_code",
        code,
        user_type: "Company",
        redirect_uri: redirectUri,
    });
    // Identifiers only in these messages (never a token), so a refusal says exactly what GHL sent.
    const got = `GHL returned userType "${String(json?.userType ?? "none")}", companyId "${String(json?.companyId ?? "none").slice(0, 40)}"` +
        `${json?.locationId ? `, locationId "${String(json.locationId).slice(0, 40)}"` : ""}; fields: ${Object.keys(json ?? {}).filter((k) => !/token/i.test(k)).join(", ")}`;
    if (json?.userType !== "Company") throw new Error(`The app was installed on a single sub-account, not the agency (${got}).`);
    if (String(json?.companyId ?? "") !== deps.env.GHL_COMPANY_ID!.trim()) {
        throw new Error(`The install isn't for Midas Media's agency (expected companyId "${deps.env.GHL_COMPANY_ID!.trim()}"; ${got}).`);
    }
    if (!json?.access_token || !json?.refresh_token) throw new Error("GHL's answer had no tokens.");
    const row = {
        company_id: String(json.companyId),
        access_token_enc: await encrypt(deps.env, String(json.access_token)),
        refresh_token_enc: await encrypt(deps.env, String(json.refresh_token)),
        expires_at: expiresAt(deps, json),
        scope: json.scope ? String(json.scope).slice(0, 4000) : null,
        user_id: json.userId ? String(json.userId) : null,
        install_to_future: json.installToFutureLocations ?? null,
        approve_all: json.approveAllLocations ?? null,
        installed_at: (deps.now ?? (() => new Date()))().toISOString(),
        updated_at: (deps.now ?? (() => new Date()))().toISOString(),
    };
    const { error } = await deps.db.from("ghl_oauth_tokens").upsert(row, { onConflict: "company_id" });
    if (error) throw new Error(`Couldn't save the app's keys: ${error.message}. Has supabase/sql/ghl_oauth.sql been run?`);
    // Which sub-accounts this install covers (ids only, not secret): the location token is refused for any other.
    const approved = Array.isArray(json.approvedLocations) ? json.approvedLocations.map((x: unknown) => String(x)) : null;
    return { companyId: row.company_id, installToFuture: row.install_to_future, approveAll: row.approve_all, scope: row.scope,
        approvedLocations: approved, isBulk: json.isBulkInstallation ?? null };
}

async function readRow(deps: OAuthDeps) {
    const { data, error } = await deps.db.from("ghl_oauth_tokens").select("*").eq("company_id", deps.env.GHL_COMPANY_ID!.trim()).maybeSingle();
    if (error) throw new Error(`Couldn't read the app's keys: ${error.message}`);
    if (!data) throw new Error("The Golden Eye app isn't installed on the agency yet (no keys stored).");
    return data;
}

// A valid agency access token, renewed when it's about to expire. GHL kills a refresh token once it's used, so
// the renewal only counts if this request is the one that swapped it (the update matches the old refresh token);
// if another request got there first, its fresh token is read back and used instead.
export async function companyAccessToken(deps: OAuthDeps): Promise<string> {
    const now = (deps.now ?? (() => new Date()))().getTime();
    const row = await readRow(deps);
    if (new Date(row.expires_at).getTime() - RENEW_EARLY_MS > now) return await decrypt(deps.env, row.access_token_enc);

    const json = await form(deps, "/oauth/token", {
        client_id: deps.env.GHL_APP_CLIENT_ID!.trim(),
        client_secret: deps.env.GHL_APP_CLIENT_SECRET!.trim(),
        grant_type: "refresh_token",
        refresh_token: await decrypt(deps.env, row.refresh_token_enc),
        user_type: "Company",
    });
    if (!json?.access_token || !json?.refresh_token) throw new Error("GHL's renewal answer had no tokens.");
    const { data, error } = await deps.db.from("ghl_oauth_tokens").update({
        access_token_enc: await encrypt(deps.env, String(json.access_token)),
        refresh_token_enc: await encrypt(deps.env, String(json.refresh_token)),
        expires_at: expiresAt(deps, json),
        updated_at: new Date(now).toISOString(),
    }).eq("company_id", row.company_id).eq("refresh_token_enc", row.refresh_token_enc).select("company_id");
    if (error) throw new Error(`Couldn't save the renewed keys: ${error.message}`);
    if (!data?.length) return await decrypt(deps.env, (await readRow(deps)).access_token_enc);
    return String(json.access_token);
}

// The app's id, for GHL's installed-locations list: GHL_APP_ID if set, else the part of the client id before its first "-".
export function appId(env: OAuthEnv & { GHL_APP_ID?: string }): string {
    return (env.GHL_APP_ID?.trim() || String(env.GHL_APP_CLIENT_ID ?? "").trim().split("-")[0]);
}

// A token for one sub-account, from the agency token. Never stored: it's asked for when needed.
export async function locationAccessToken(deps: OAuthDeps, locationId: string): Promise<string> {
    const company = await companyAccessToken(deps);
    const json = await form(deps, "/oauth/locationToken", { companyId: deps.env.GHL_COMPANY_ID!.trim(), locationId }, company);
    const t = String(json?.access_token ?? "");
    if (!t) throw new Error("GHL's location token answer had no access_token.");
    return t;
}
