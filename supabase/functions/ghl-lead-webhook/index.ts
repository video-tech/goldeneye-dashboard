// GHL lead webhook — CAPTURE MODE (temporary).
//
// Phase 2 of the SEO build counts organic leads: a GHL workflow fires a webhook when a
// contact is created, and this function decides whether that lead came from organic
// search. That classifier has to be written against what GHL *actually sends*, not what
// its docs imply — attribution field names differ by form type, by plan, and by whether
// the lead came from a form, a call or a chat, and guessing them wrong fails silently:
// every lead would just land as "unknown" and the count would read zero forever.
//
// So this first version only captures. It checks the shared secret, logs a REDACTED copy
// of the payload (structure and attribution fields kept, personal details stripped), and
// returns 200. Nothing is written to the database. Once one real payload has been read
// from the logs, this file is replaced by the real classifier.
//
// Deploy:  supabase functions deploy ghl-lead-webhook --project-ref hugnttsqucetldllfgoi
//          verify_jwt = false comes from supabase/config.toml — GHL cannot send the
//          Supabase gateway JWT, so the shared secret below is the ONLY gate.
// Secret:  GHL_WEBHOOK_SECRET — any long random string. The same value goes into the GHL
//          workflow's webhook, either as an `x-webhook-secret` header or as `?k=` on the
//          URL for webhook actions that can't set custom headers.
// Read:    Dashboard → Edge Functions → ghl-lead-webhook → Logs.

// Keys whose values are personal and never needed to classify a lead. Matched at a word
// start so "first_name", "firstName", "email", "phone_raw", "postal_code" etc. all hit.
const PERSONAL_KEY = /(^|_)(email|phone|name|first|last|full|address|street|city|state|postal|zip|country|dob|birth|ip|company|website)/i;

// Personal data can also turn up under arbitrary custom-field keys, so check values too.
const LOOKS_LIKE_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const LOOKS_LIKE_PHONE = /^\+?[\d\s().-]{7,}$/;

function redact(value: unknown, key = "", depth = 0): unknown {
    if (depth > 8) return "[too deep]";
    if (value === null || value === undefined) return value;

    if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, key, depth + 1));

    if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = redact(v, k, depth + 1);
        }
        return out;
    }

    if (PERSONAL_KEY.test(key)) return "[redacted]";

    if (typeof value === "string") {
        if (LOOKS_LIKE_EMAIL.test(value)) return "[redacted-email]";
        // A bare "2026-09-11" is digits and dashes, which the phone pattern would
        // otherwise swallow — and the date a contact was created is exactly the field
        // the real classifier needs to see.
        if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value;
        // Ten digits minimum, so an 8-digit numeric id is not mistaken for a number to
        // hide. US phone numbers always carry ten.
        if (LOOKS_LIKE_PHONE.test(value.trim()) && value.replace(/\D/g, "").length >= 10) {
            return "[redacted-phone]";
        }
        return value.length > 300 ? value.slice(0, 300) + "…" : value;
    }
    return value;
}

// Constant-time comparison. Timing attacks against a webhook over the internet are not
// a realistic threat, but this costs nothing and removes the question entirely.
function safeEqual(a: string, b: string): boolean {
    const x = new TextEncoder().encode(a);
    const y = new TextEncoder().encode(b);
    let diff = x.length ^ y.length;
    for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
    return diff === 0;
}

Deno.serve(async (req: Request) => {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    // Fail closed: with no secret configured, verify_jwt = false would otherwise leave
    // this endpoint open to anyone who guesses the URL.
    const expected = Deno.env.get("GHL_WEBHOOK_SECRET");
    if (!expected) return new Response("not configured", { status: 500 });

    const url = new URL(req.url);
    const given = req.headers.get("x-webhook-secret") ?? url.searchParams.get("k") ?? "";
    if (!safeEqual(given, expected)) return new Response("unauthorized", { status: 401 });

    const raw = await req.text();
    let body: unknown;
    let format = "json";
    try {
        body = JSON.parse(raw);
    } catch {
        // Some webhook actions post form-encoded. Capture that shape too rather than
        // throwing the evidence away.
        format = "form";
        body = Object.fromEntries(new URLSearchParams(raw));
    }

    // Header NAMES only, never values — this tells us whether GHL's action honoured a
    // custom header, without writing the secret (or anything else) into the logs.
    const headerNames = [...req.headers.keys()].sort();
    const queryKeys = [...url.searchParams.keys()].filter((k) => k !== "k");

    console.log("ghl-lead-webhook CAPTURE", JSON.stringify({
        received_at: new Date().toISOString(),
        format,
        bytes: raw.length,
        auth_via: req.headers.get("x-webhook-secret") ? "header" : "query",
        header_names: headerNames,
        query_keys: queryKeys,
        payload: redact(body),
    }, null, 2));

    return Response.json({ ok: true, captured: true });
});
