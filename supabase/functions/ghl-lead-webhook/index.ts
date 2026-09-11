// GHL lead webhook: classifies every new website lead by where it came from.
//
// A GHL workflow (Contact Created → Webhook) posts each new contact here. This function
// works out which client the lead belongs to and whether it came from organic search, paid
// ads, social, another site, or directly. It stores ONE row per contact in lead_sources:
// ids and attribution only, never a name, email, phone number or IP address.
//
// The rules below were written against real GHL payloads captured on 2026-09-11 (four of
// them are the fixtures in the tests), not against GHL's documentation. Three findings
// shaped them:
//   1. GHL's own sessionSource label is referrer-only and ignores UTM tags. A lead tagged
//      utm_medium=organic still read "Direct traffic". So UTMs are read straight from the
//      landing URL, and they outrank that label.
//   2. GHL records only the last hop. A visitor who lands on a client's site from Google and
//      then clicks through to a booking page on another host arrives as a "Referral" from
//      the client's own site. That is recorded as unknown (self_referral), never as a real
//      referral. snippets/lead-source-carry.html on the site fixes it at source, and was
//      verified live: the same journey then arrives tagged google / organic.
//   3. The Meta fbc/fbp cookies stay in the browser for 90 days, so they are never a paid
//      signal. Only click IDs and paid UTM mediums on THIS visit's landing URL count.
//
// A lead is stored only when its landing page is on its client's own domain, taken from
// clients.gsc_property. Organic means someone searched and landed on the client's site, so
// this is part of the definition, not a filter. It is also what keeps leads from a
// sub-account shared with a non-client out of anyone's numbers: Midas's own sub-account is
// shared with Sunset Design Build. Meta instant-form leads have no landing page and are
// already counted in daily_reports; they are not website leads and are not stored here.
//
// Deploy:  supabase functions deploy ghl-lead-webhook --project-ref hugnttsqucetldllfgoi
//          verify_jwt = false comes from supabase/config.toml. GHL cannot send the Supabase
//          gateway JWT, so the shared secret is the ONLY gate.
// Schema:  schema.sql in this folder, then supabase/sql/rename_client.sql.
// Secrets: GHL_WEBHOOK_SECRET (required), either as an x-webhook-secret header or as ?k=
//          on the URL. GHL_CAPTURE=1 (optional, debugging only) also saves a redacted copy
//          of each payload, plus the decision taken, to ghl_webhook_captures, where the SQL
//          Editor can read it. Turn it on to see why a new client's leads classify the way
//          they do, then off again.

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

// Search result pages only. NOT any *.google.* host: a link clicked in Gmail arrives from
// mail.google.com, and that is not a search. Kept in step with the site snippet.
const SEARCH_ENGINES: [RegExp, string][] = [
    [/^(www\.)?google\.[a-z.]+$/, "google"],
    [/^(www\.)?bing\.com$/, "bing"],
    [/^(www\.|html\.)?duckduckgo\.com$/, "duckduckgo"],
    [/^search\.yahoo\.com$/, "yahoo"],
    [/^(www\.)?ecosia\.org$/, "ecosia"],
    [/^search\.brave\.com$/, "brave"],
];

const PAID_MEDIUMS = new Set([
    "cpc", "ppc", "paid", "paidsearch", "paid_search", "paid-search", "paidsocial",
    "paid_social", "paid-social", "cpm", "cpv", "display", "retargeting", "ads", "ad",
]);
const SOCIAL_MEDIUMS = new Set(["social", "social-media", "social_media", "organic_social", "organic-social"]);

const str = (v: unknown): string | null =>
    v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim();
const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");
// The last two labels. Fine for .com/.net/.org clients; not for .co.uk-style suffixes.
const rootOf = (h: string) => bare(h).split(".").slice(-2).join(".");

// "sc-domain:example.com" → "example.com"; "https://www.example.com/" → "example.com".
export function domainOf(gscProperty: unknown): string | null {
    const p = str(gscProperty);
    if (!p) return null;
    if (p.toLowerCase().startsWith("sc-domain:")) return bare(p.slice("sc-domain:".length)) || null;
    try { return bare(new URL(p).hostname) || null; } catch { return null; }
}

// Subdomains count as the client's own site, so a booking page on book.example.com belongs
// to sc-domain:example.com (Midas's own calendar lives on goldeneye.midasmediafirm.com).
export function onDomain(host: string | null, domain: string | null): boolean {
    if (!host || !domain) return false;
    const h = bare(host);
    return h === domain || h.endsWith("." + domain);
}

function hostOf(u: unknown): string | null {
    const s = str(u);
    if (!s) return null;
    try {
        const url = new URL(s);
        // The Google app on Android sends an android-app:// referrer, not a web one.
        if (url.protocol === "android-app:") {
            return /^com\.google\./.test(url.hostname) ? "google.com" : url.hostname.toLowerCase();
        }
        return url.hostname.toLowerCase() || null;
    } catch { return null; }
}

function engineOf(host: string | null): string | null {
    if (!host) return null;
    for (const [re, name] of SEARCH_ENGINES) if (re.test(host)) return name;
    return null;
}

export type Source = "organic" | "paid" | "social" | "referral" | "direct" | "other" | "unknown";
export type LeadType = "booking" | "form" | "call" | "chat" | "unknown";

export interface Classification {
    source: Source;
    source_detail: string | null;
    lead_type: LeadType;
    landing_host: string | null;
    landing_path: string | null;
    referrer_host: string | null;
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    src_restored: boolean;
    is_gbp: boolean;
}

// GHL's `medium` names the widget the contact came through: "calendar" on every real capture.
function leadType(medium: unknown): LeadType {
    const m = String(medium ?? "").toLowerCase();
    if (/calendar|appointment|booking/.test(m)) return "booking";
    if (/form|survey|quiz/.test(m)) return "form";
    if (/chat/.test(m)) return "chat";
    if (/call|phone/.test(m)) return "call";
    return "unknown";
}

// First match wins, and the order is the whole point. Each step is a rule a real capture
// forced, or a trap one of them exposed.
export function classify(payload: any, domain: string | null): Classification {
    // First-touch attribution. The top-level attributionSource is always {} and must not be
    // read.
    const attr = payload?.contact?.attributionSource ?? {};
    let landing: URL | null = null;
    try { landing = str(attr.url) ? new URL(String(attr.url)) : null; } catch { landing = null; }
    const q = landing ? landing.searchParams : new URLSearchParams();

    // Read from the landing URL first. GHL has no utmCampaign field at all, and the URL is the
    // record of what was actually on the link.
    const utmSource = str(q.get("utm_source")) ?? str(attr.utmSource);
    const utmMedium = (str(q.get("utm_medium")) ?? str(attr.utmMedium))?.toLowerCase() ?? null;
    const utmCampaign = str(q.get("utm_campaign")) ?? str(attr.utmCampaign) ?? str(attr.campaign);
    const referrerHost = hostOf(attr.referrer);
    const landingHost = landing ? landing.hostname.toLowerCase() : null;
    const session = String(attr.sessionSource ?? "");

    const out = (source: Source, detail: string | null): Classification => ({
        source,
        source_detail: detail,
        lead_type: leadType(attr.medium),
        landing_host: landingHost,
        landing_path: landing ? landing.pathname : null,
        referrer_host: referrerHost,
        utm_source: utmSource,
        utm_medium: utmMedium,
        utm_campaign: utmCampaign,
        src_restored: q.get("src_restored") === "1",
        is_gbp: (utmSource ?? "").toLowerCase() === "gbp",
    });

    // 1. Paid, on evidence from THIS visit only. Never fbc/fbp: those are Meta pixel cookies
    //    that sit in the browser for 90 days. Every early real capture carried one, left by
    //    an ad click months before.
    if (["gclid", "gbraid", "wbraid"].some((k) => str(q.get(k)) || str(attr[k]))) return out("paid", "google_ads");
    if (str(q.get("msclkid"))) return out("paid", "microsoft_ads");
    if (str(attr.adId) || str(attr.adGroupId)) return out("paid", "ads");
    if (utmMedium && PAID_MEDIUMS.has(utmMedium)) return out("paid", utmSource?.toLowerCase() ?? "ads");

    // 2. Explicit UTM tags outrank everything below, including GHL's sessionSource and a
    //    self-referral. That covers tags restored by the site snippet: the verified live lead
    //    has the site as its referrer AND google / organic on its URL, and it must count as
    //    organic.
    if (utmMedium === "organic") return out("organic", utmSource?.toLowerCase() ?? "search");
    if (utmMedium === "referral") return out("referral", utmSource?.toLowerCase() ?? referrerHost);
    if (utmMedium && SOCIAL_MEDIUMS.has(utmMedium)) return out("social", utmSource?.toLowerCase() ?? null);
    if (utmMedium || utmSource) return out("other", utmMedium ?? utmSource?.toLowerCase() ?? null);

    // 3. Facebook adds fbclid to every outbound link, organic posts included. On its own it
    //    says "came from Facebook", not "came from an ad".
    if (str(q.get("fbclid"))) return out("social", "facebook");

    // 4. GHL's own label, where it says something the rules above haven't already decided.
    if (/paid/i.test(session)) return out("paid", session);
    if (/organic/i.test(session)) return out("organic", engineOf(referrerHost) ?? "search");

    // 5. The referrer.
    const engine = engineOf(referrerHost);
    if (engine) return out("organic", engine);
    if (referrerHost) {
        // A referrer on the client's own site is not a source. It's the lost last hop, so it
        // is recorded as unknown and the lost-attribution rate stays measurable per client.
        // A high rate is the signal to install the site snippet.
        const own = onDomain(referrerHost, domain) ||
            (landingHost !== null && rootOf(referrerHost) === rootOf(landingHost));
        if (own) return out("unknown", "self_referral");
        return out("referral", bare(referrerHost));
    }
    if (/social/i.test(session)) return out("social", null);
    if (!landing) return out("unknown", "no_landing_page");
    return out("direct", null);
}

// ---------------------------------------------------------------------------
// Database: PostgREST with the service-role key. No supabase-js import, so this file stays
// dependency-free and the tests can stub fetch.
// ---------------------------------------------------------------------------

function service() {
    const base = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!base || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
    return { base, headers: { "apikey": key, "Authorization": `Bearer ${key}` } };
}

async function clientsForLocation(locationId: string): Promise<{ name: string; gsc_property: string | null }[]> {
    const { base, headers } = service();
    const res = await fetch(
        `${base}/rest/v1/clients?select=name,gsc_property&ghl_location_id=eq.${encodeURIComponent(locationId)}`,
        { headers },
    );
    if (!res.ok) throw new Error(`clients lookup failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return await res.json();
}

async function storeLead(row: Record<string, unknown>): Promise<void> {
    const { base, headers } = service();
    const res = await fetch(`${base}/rest/v1/lead_sources?on_conflict=ghl_contact_id`, {
        method: "POST",
        headers: {
            ...headers,
            "Content-Type": "application/json",
            // First write wins: a GHL retry of the same contact must never double-count it,
            // or overwrite the original classification.
            "Prefer": "resolution=ignore-duplicates,return=minimal",
        },
        body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`lead_sources insert failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

function isoOrNow(v: unknown): string {
    const d = new Date(String(v ?? ""));
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

interface Decision {
    stored: boolean;
    reason: string | null;
    client: string | null;
    classification: Classification | null;
}

// Decides whether this contact is a website lead for exactly one client, and stores it if so.
// Every "not stored" path still carries the classification, so capture mode can show what the
// rules made of a payload even when it belongs to no one.
async function decide(payload: any): Promise<Decision> {
    const skip = (reason: string, client: string | null = null): Decision =>
        ({ stored: false, reason, client, classification: payload ? classify(payload, null) : null });

    if (!payload || typeof payload !== "object") return skip("body is not JSON");

    const contactId = str(payload.contact_id) ?? str(payload.contact?.id);
    const locationId = str(payload.location?.id);
    const landingHost = hostOf(payload.contact?.attributionSource?.url);

    if (!contactId) return skip("no contact id");
    if (!locationId) return skip("no location id");
    // Before the lookup, so calls, instant forms and manual adds cost no query.
    if (!landingHost) return skip("no landing page (call, instant form or manual add)");

    const candidates = await clientsForLocation(locationId);
    if (!candidates.length) return skip("location not linked to any client");

    const seo = candidates.filter((c) => domainOf(c.gsc_property));
    if (!seo.length) return skip("linked client has no Search Console property", candidates[0].name);

    // For a sub-account shared between clients, or with a non-client, the landing page is
    // what decides whose lead it is. The case that forced this was Midas's own sub-account
    // being shared with Sunset Design Build.
    const matches = seo.filter((c) => onDomain(landingHost, domainOf(c.gsc_property)));
    if (!matches.length) return skip("landing page is not on the client's website");
    if (matches.length > 1) return skip("more than one client matches this landing page");

    const client = matches[0];
    const c = classify(payload, domainOf(client.gsc_property));
    await storeLead({
        ghl_contact_id: contactId,
        client_name: client.name,
        ghl_location_id: locationId,
        created_at: isoOrNow(payload.date_created),
        lead_type: c.lead_type,
        source: c.source,
        source_detail: c.source_detail,
        landing_host: c.landing_host,
        landing_path: c.landing_path,
        referrer_host: c.referrer_host,
        utm_source: c.utm_source,
        utm_medium: c.utm_medium,
        utm_campaign: c.utm_campaign,
        src_restored: c.src_restored,
        is_gbp: c.is_gbp,
        lead_form: str(payload.contact_source)?.slice(0, 200) ?? null,
    });
    return { stored: true, reason: null, client: client.name, classification: c };
}

// ---------------------------------------------------------------------------
// Debug capture (GHL_CAPTURE=1 only): a redacted copy of the payload and the decision
// ---------------------------------------------------------------------------

// Keys whose values are personal and never needed to classify a lead. Matched at a word
// start so "first_name", "firstName", "email", "phone_raw", "postal_code" etc. all hit.
const PERSONAL_KEY = /(^|_)(email|phone|name|first|last|full|address|street|city|state|postal|zip|country|dob|birth|ip|company|website)/i;

// Personal data can also turn up under arbitrary custom-field keys, so check values too.
const LOOKS_LIKE_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const LOOKS_LIKE_PHONE = /^\+?[\d\s().-]{7,}$/;

// Credentials never belong in a log, whatever GHL calls the field. GHL's standard Webhook
// action can't send custom headers, so whoever sets it up may paste the secret into its
// "custom data" instead. That puts it in the BODY, where a 64-character hex string looks like
// neither an email nor a phone number and would otherwise be printed verbatim.
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
        // A bare "2026-09-11" is digits and dashes, which the phone pattern would otherwise
        // swallow, and a contact's creation date is exactly what classification needs.
        if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value;
        // Ten digits minimum, so an 8-digit numeric id is not mistaken for a phone number.
        if (LOOKS_LIKE_PHONE.test(value.trim()) && value.replace(/\D/g, "").length >= 10) {
            return "[redacted-phone]";
        }
        return value.length > 300 ? value.slice(0, 300) + "…" : value;
    }
    return value;
}

// Written straight to PostgREST, into a table with RLS on and no policies. The public API
// can't see it; the SQL Editor, which runs as postgres, can. Only for requests that passed
// the secret check, so nobody can fill the table by hitting the URL.
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
        // Never fail the webhook over a debug copy.
        console.error("ghl-lead-webhook: capture not saved", String(err));
    }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

// Constant-time comparison. Timing attacks against a webhook over the internet are not a
// realistic threat, but this costs nothing and removes the question entirely.
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

Deno.serve(async (req: Request) => {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    // Fail closed: with no secret configured, verify_jwt = false would otherwise leave this
    // endpoint open to anyone who guesses the URL.
    const expected = normaliseSecret(Deno.env.get("GHL_WEBHOOK_SECRET"));
    if (!expected) return new Response("not configured", { status: 500 });

    const url = new URL(req.url);
    const headerVal = req.headers.get("x-webhook-secret");
    const queryVal = url.searchParams.get("k");
    const via = headerVal !== null ? "header" : queryVal !== null ? "query" : "none";
    const given = normaliseSecret(headerVal ?? queryVal);

    if (!safeEqual(given, expected)) {
        // Says WHICH failure it was (nothing sent, or a value that doesn't match) without ever
        // writing either secret, or any of the body, into the logs. The first real GHL test
        // came back 401 with no clue as to why, because refusals used to log nothing.
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
        format = "form";
        body = Object.fromEntries(new URLSearchParams(raw));
    }

    const capturing = Deno.env.get("GHL_CAPTURE") === "1";
    const captureOf = (result: unknown) => ({
        received_at: new Date().toISOString(),
        format,
        bytes: raw.length,
        auth_via: via,
        header_names: [...req.headers.keys()].sort(),
        query_keys: [...url.searchParams.keys()].filter((k) => k !== "k"),
        result,
        payload: redact(body, "", 0, expected),
    });

    let decision: Decision;
    try {
        decision = await decide(format === "json" ? body : null);
    } catch (err) {
        // The database, not the lead, is the problem. 500 lets GHL retry, and the insert is
        // first-write-wins, so a retry can never double-count.
        const msg = String((err as Error)?.message ?? err);
        console.error("ghl-lead-webhook FAILED", msg);
        if (capturing) await saveCapture(captureOf({ error: msg }));
        return Response.json({ ok: false, error: msg }, { status: 500 });
    }

    // One line per lead, no personal data: enough to see what happened without a capture.
    console.log("ghl-lead-webhook LEAD", JSON.stringify({
        stored: decision.stored,
        reason: decision.reason,
        client: decision.client,
        source: decision.classification?.source ?? null,
        detail: decision.classification?.source_detail ?? null,
        lead_type: decision.classification?.lead_type ?? null,
        landing_host: decision.classification?.landing_host ?? null,
        src_restored: decision.classification?.src_restored ?? false,
    }));
    if (capturing) await saveCapture(captureOf(decision));

    return Response.json({
        ok: true,
        stored: decision.stored,
        reason: decision.reason,
        source: decision.classification?.source ?? null,
    });
});
