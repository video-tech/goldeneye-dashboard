// Who is calling an edge function, for functions the browser and pg_cron both reach.
//
// The Supabase gateway only proves a caller holds SOME valid JWT, and the public anon key in the
// page source is one. So any function that spends money, reveals client data or sends texts must
// decide for itself. Used by ai-chat and morning-audit. No imports: `db` is passed in, so this can
// be tested with a fake client.

export type Caller =
    | { ok: true; kind: "admin"; email: string }
    | { ok: true; kind: "cron" }
    | { ok: false; reason: string };

// Constant-time string comparison, so response timing doesn't leak how much of a guess was right.
export function safeEqual(a: string, b: string): boolean {
    const enc = new TextEncoder();
    const x = enc.encode(a), y = enc.encode(b);
    let diff = x.length ^ y.length;
    for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
    return diff === 0;
}

function jwtRole(jwt: string): string | null {
    try {
        const part = jwt.split(".")[1];
        if (!part) return null;
        const json = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4));
        return JSON.parse(json)?.role ?? null;
    } catch {
        return null;
    }
}

// A signed-in admin, with a plain-English reason when not. The reason goes back to the caller and
// into the function log; it never includes the token. Same rule as make-relay: user_profiles.role
// is "admin", matched on the exact auth email (not ilike: "_" is a LIKE wildcard).
export async function adminCheck(db: any, req: Request): Promise<Caller> {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return { ok: false, reason: "No sign-in was sent. Reload Golden Eye and try again." };

    // The public anon key is a JWT with role "anon" and no user: what an app.js from before a
    // lock-down sends, so it almost always means the page needs a reload.
    if (jwtRole(jwt) === "anon") {
        return { ok: false, reason: "This page is running an older version of Golden Eye. Reload the page and try again." };
    }

    const { data, error } = await db.auth.getUser(jwt);
    const email = data?.user?.email;
    if (error || !email) return { ok: false, reason: "Your sign-in has expired or wasn't recognised. Sign out, sign back in, and try again." };

    const { data: profile, error: pErr } = await db.from("user_profiles").select("role").eq("email", email).maybeSingle();
    if (pErr) return { ok: false, reason: `Couldn't read your profile: ${pErr.message}` };
    if (!profile) return { ok: false, reason: `Signed in as ${email}, but there's no user profile for that email.` };
    if (profile.role !== "admin") return { ok: false, reason: `Signed in as ${email}, whose role is "${profile.role}", not admin.` };
    return { ok: true, kind: "admin", email };
}

// pg_cron proves itself with a shared secret header, read from Vault when the job runs, so the job
// definition never stores the value. Fails closed: an unset expected secret never matches, not
// even an empty header.
export function cronCheck(req: Request, expected: string | undefined, header = "x-cron-secret"): boolean {
    const sent = req.headers.get(header) ?? "";
    if (!expected || !sent) return false;
    return safeEqual(sent.trim(), expected.trim());
}
