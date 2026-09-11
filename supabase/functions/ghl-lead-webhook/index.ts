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

// Credentials never belong in a log, whatever GHL calls the field. This matters more than
// it looks: GHL's standard Webhook action can't send custom headers, so whoever sets it up
// may paste the secret into its "custom data" instead — which puts it in the BODY, where a
// 64-char hex string looks like neither an email nor a phone number and would otherwise be
// printed verbatim.
const SECRET_KEY = /(secret|token|password|passwd|api[_-]?key|authori[sz]ation)/i;

function redact(value: unknown, key = "", depth = 0, secret = ""): unknown {
    if (depth > 8) return "[too deep]";
    if (value === null || value === undefined) return value;

    if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, key, depth + 1, secret));

    if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = redact(v, k, depth + 1, secret);
        }
        return out;
    }

    if (SECRET_KEY.test(key)) return "[redacted-secret]";
    // ...and by value, for a secret pasted under a key nobody would think to guess.
    if (typeof value === "string" && secret && normaliseSecret(value) === secret) return "[redacted-secret]";
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

// Paste errors are the usual reason a correct secret fails: a trailing newline picked up
// pasting the value into the Supabase dashboard, a space, or a pair of quotes in the GHL
// field. The secret is 64 hex characters and can never legitimately contain any of those,
// so normalising BOTH sides removes the most common failure without weakening anything.
function normaliseSecret(s: string | null | undefined): string {
    let t = String(s ?? "").trim();
    const quoted = t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"));
    if (quoted) t = t.slice(1, -1).trim();
    return t;
}

// Also keep each capture in a table. The first real capture could not be found in the
// dashboard's log views at all, while the SQL Editor is where every other check in this
// build has been read. Written with the service-role key straight to PostgREST — no
// supabase-js import, so this file stays dependency-free and testable. The table has RLS
// on and no policies: invisible to the public API, readable from the SQL Editor (which runs
// as postgres). Only the same REDACTED object the log gets is stored, and only for requests
// that passed the secret check — an unauthenticated request never causes a write, so nobody
// can fill this table by hitting the URL.
async function saveCapture(capture: unknown): Promise<void> {
    const base = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!base || !key) return;
    try {
        const res = await fetch(`${base}/rest/v1/ghl_webhook_captures`, {
            method: "POST",
            headers: {
                "apikey": key,
                "Authorization": `Bearer ${key}`,
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            body: JSON.stringify({ capture }),
        });
        if (!res.ok) {
            console.error("ghl-lead-webhook: capture not saved", res.status, (await res.text()).slice(0, 200));
        }
    } catch (err) {
        // Never fail the webhook over this. A 200 to GHL is still correct, and the capture
        // is in the function log regardless.
        console.error("ghl-lead-webhook: capture not saved", String(err));
    }
}

Deno.serve(async (req: Request) => {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    // Fail closed: with no secret configured, verify_jwt = false would otherwise leave
    // this endpoint open to anyone who guesses the URL.
    const expected = normaliseSecret(Deno.env.get("GHL_WEBHOOK_SECRET"));
    if (!expected) return new Response("not configured", { status: 500 });

    const url = new URL(req.url);
    const headerVal = req.headers.get("x-webhook-secret");
    const queryVal = url.searchParams.get("k");
    const via = headerVal !== null ? "header" : queryVal !== null ? "query" : "none";
    const given = normaliseSecret(headerVal ?? queryVal);

    if (!safeEqual(given, expected)) {
        // A refused request used to log nothing, which made a wrong secret invisible: the
        // first real GHL test came back 401 with no clue as to why. This names WHICH
        // failure it was — nothing sent at all (GHL's standard Webhook action cannot send
        // custom headers) or a value that doesn't match — without ever writing either
        // secret, or any of the body, into the logs. Header NAMES catch a misspelt header.
        console.warn("ghl-lead-webhook REFUSED", JSON.stringify({
            reason: via === "none" ? "no secret sent (no x-webhook-secret header and no ?k=)" : "secret does not match",
            via,
            given_length: given.length,
            expected_length: expected.length,
            header_names: [...req.headers.keys()].sort(),
        }));
        return new Response("unauthorized", { status: 401 });
    }

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

    const capture = {
        received_at: new Date().toISOString(),
        format,
        bytes: raw.length,
        auth_via: via,
        header_names: headerNames,
        query_keys: queryKeys,
        payload: redact(body, "", 0, expected),
    };
    console.log("ghl-lead-webhook CAPTURE", JSON.stringify(capture, null, 2));
    await saveCapture(capture);

    return Response.json({ ok: true, captured: true });
});
