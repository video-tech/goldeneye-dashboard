// Google service-account auth for Deno edge functions.
//
// No googleapis SDK: the whole flow is three steps and Deno ships Web Crypto, which
// does RS256 natively. This is the "JWT bearer" grant — sign a short-lived assertion
// with the service account's private key, trade it at Google's token endpoint for an
// access token, use that as a bearer for an hour.
//
// Why a service account rather than OAuth: nobody has to stay signed in, there is no
// refresh token to expire silently, and access is granted per property by adding one
// email as a user in Search Console / GA4 / Business Profile. The failure mode is
// therefore always the same and always visible — "that email isn't on this property" —
// rather than "the token someone authorised in March stopped working".
//
// Secret: GOOGLE_SA_JSON — the entire service-account key file, verbatim.
//   supabase secrets set GOOGLE_SA_JSON="$(cat service-account.json)"

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const SCOPES = {
    gsc: "https://www.googleapis.com/auth/webmasters.readonly",
    ga4: "https://www.googleapis.com/auth/analytics.readonly",
    // Requested only by the GBP source, and only once Google approves the project for
    // the Business Profile APIs. Kept separate so an unapproved scope can never taint
    // the token the GSC pull depends on — asking for all three at once would fail the
    // whole exchange and take Search Console down with it.
    gbp: "https://www.googleapis.com/auth/business.manage",
};

function b64urlBytes(bytes: Uint8Array): string {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlText(s: string): string {
    return b64urlBytes(new TextEncoder().encode(s));
}

function pemToDer(pem: string): Uint8Array {
    const body = pem
        .replace(/-----BEGIN [^-]+-----/g, "")
        .replace(/-----END [^-]+-----/g, "")
        .replace(/\s+/g, "");
    const bin = atob(body);
    const der = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
    return der;
}

interface ServiceAccount {
    client_email: string;
    private_key: string;
}

let saCache: ServiceAccount | null = null;

function serviceAccount(): ServiceAccount {
    if (saCache) return saCache;
    const raw = Deno.env.get("GOOGLE_SA_JSON");
    if (!raw) throw new Error("GOOGLE_SA_JSON is not set on this project");

    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error("GOOGLE_SA_JSON is not valid JSON — paste the whole key file, not just the private key");
    }
    if (!parsed.client_email || !parsed.private_key) {
        throw new Error("GOOGLE_SA_JSON is missing client_email or private_key");
    }

    // Defensive: a key file that has been through a copy-paste can arrive with the
    // newlines still escaped as the two characters backslash-n rather than as real
    // line breaks. atob() would then choke on the PEM. Valid JSON gives us the real
    // breaks already, so this is a no-op in the normal case.
    saCache = {
        client_email: String(parsed.client_email),
        private_key: String(parsed.private_key).replace(/\n/g, "\n"),
    };
    return saCache;
}

// Tokens are good for an hour and edge-function instances are reused between
// invocations, so a warm instance running every 15 minutes signs once and reuses.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getGoogleToken(scopes: string[]): Promise<string> {
    const scope = scopes.slice().sort().join(" ");
    const hit = tokenCache.get(scope);
    // 60s of headroom so a token can't expire mid-request.
    if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;

    const sa = serviceAccount();
    const iat = Math.floor(Date.now() / 1000);
    const claims = {
        iss: sa.client_email,
        scope,
        aud: TOKEN_URL,
        iat,
        exp: iat + 3600,
    };

    const signingInput = `${b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64urlText(JSON.stringify(claims))}`;

    const key = await crypto.subtle.importKey(
        "pkcs8",
        pemToDer(sa.private_key),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const sig = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(signingInput),
    );
    const assertion = `${signingInput}.${b64urlBytes(new Uint8Array(sig))}`;

    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
        }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
        // Google's errors here are terse but specific — "invalid_grant" almost always
        // means the clock or the key, not the permissions. Pass it through whole.
        throw new Error(
            `Google token exchange failed (${res.status}): ${body.error ?? "unknown"}${body.error_description ? " — " + body.error_description : ""}`,
        );
    }

    const token = String(body.access_token);
    tokenCache.set(scope, {
        token,
        expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    });
    return token;
}

// The service-account email, for the "add this address as a user on the property"
// instruction the admin UI shows. Never the key — only the address.
export function serviceAccountEmail(): string {
    return serviceAccount().client_email;
}
