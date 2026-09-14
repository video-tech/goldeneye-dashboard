// SEO changelog webhook: logs a published article to seo_changelog automatically.
//
// Articles are written in Cuppa and published on each client's Webflow or Wix site. The site's
// own publish event is used, not Cuppa's: Cuppa only stages a Webflow post, which isn't live
// until the site is published, and the changelog is about when work went LIVE. It also catches
// articles published without Cuppa.
//
// Setup is per client on the SEO tab (Auto-log articles). It copies a URL like
// .../seo-changelog-webhook?t=<token>, which goes into either:
//   Webflow  Site settings → Webhooks → "Collection Item Published"
//   Wix      Automations → "Blog post published" → "Send HTTP request" (POST)
// The token identifies the client, and seo_webhook_configs holds its platform, blog path and blog
// collection, so the webhook never has to change when those do. Until a Webflow client's blog
// collection is picked, publishes are held back as "needs_collection" and the SEO tab offers
// what arrived. Picking one there also logs the held posts.
//
// The first version's URLs (?k=<shared secret>&source=...&site=...&path=...&collection=...)
// still work. They're filed by matching the article's domain to a client.
//
// Each article is logged once: seo_changelog's unique (client_name, source_ref) with
// first-write-wins means a republish or a retry never duplicates it. Every authenticated
// request, logged or not, is recorded in seo_changelog_webhook_events with its outcome.
//
// Deploy:  supabase functions deploy seo-changelog-webhook --project-ref hugnttsqucetldllfgoi
//          verify_jwt = false comes from supabase/config.toml, since neither sender can send the
//          gateway JWT. The per-client token, or the shared secret, is the only gate.
// Schema:  schema.sql in this folder, then supabase/sql/rename_client.sql.
// Secret:  SEO_WEBHOOK_SECRET, only needed by ?k= URLs.

import { checkTokenClient, domainOf, liveDateOf, parseGitPush, parseSanity, parseWebflow, parseWix, resolveClient, siteHost, titleFromSource, type Article } from "./parse.ts";

type Config = { client_name: string; platform: "webflow" | "wix" | "git" | "sanity"; blog_path: string | null; collection_id: string | null; content_path: string | null };

// A Git push lists file paths, not titles. Fetch each new file and use its own title. Public repos
// need nothing, and a private repo needs a GITHUB_TOKEN secret with read access. On any failure
// the file-name title stands, and it can be edited in the changelog.
async function fillGitTitles(articles: Article[]): Promise<void> {
    const ghToken = Deno.env.get("GITHUB_TOKEN");
    await Promise.all(articles.map(async (a) => {
        if (!a.git?.sha) return;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        try {
            const res = ghToken
                ? await fetch(`https://api.github.com/repos/${a.git.repo}/contents/${a.git.path.split("/").map(encodeURIComponent).join("/")}?ref=${a.git.sha}`,
                    { headers: { "Authorization": `Bearer ${ghToken}`, "Accept": "application/vnd.github.raw", "User-Agent": "golden-eye" }, signal: ctl.signal })
                : await fetch(`https://raw.githubusercontent.com/${a.git.repo}/${a.git.sha}/${a.git.path.split("/").map(encodeURIComponent).join("/")}`, { signal: ctl.signal });
            if (!res.ok) return;
            const title = titleFromSource((await res.text()).slice(0, 20000));
            if (title) a.title = title;
        } catch { /* keep the file-name title */ } finally { clearTimeout(timer); }
    }));
}

async function loadConfigByToken(token: string): Promise<Config | null> {
    // A token is 64 hex characters, and anything else isn't worth a query
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const { base, headers } = service();
    const res = await fetch(`${base}/rest/v1/seo_webhook_configs?select=client_name,platform,blog_path,collection_id,content_path&token=eq.${token}`, { headers });
    if (!res.ok) throw new Error(`config lookup failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const rows = await res.json();
    return rows[0] ?? null;
}

async function loadClient(name: string): Promise<{ name: string; gsc_property: string | null } | null> {
    const { base, headers } = service();
    const res = await fetch(`${base}/rest/v1/clients?select=name,gsc_property&name=eq.${encodeURIComponent(name)}`, { headers });
    if (!res.ok) throw new Error(`client lookup failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return (await res.json())[0] ?? null;
}

function service() {
    const base = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!base || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
    return { base, headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json" } };
}

async function loadClients(): Promise<{ name: string; gsc_property: string | null }[]> {
    const { base, headers } = service();
    const res = await fetch(`${base}/rest/v1/clients?select=name,gsc_property&gsc_property=not.is.null`, { headers });
    if (!res.ok) throw new Error(`clients lookup failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return await res.json();
}

// true = a new entry, false = this article was already logged
async function logArticle(client: string, a: Article): Promise<boolean> {
    const { base, headers } = service();
    const res = await fetch(`${base}/rest/v1/seo_changelog?on_conflict=client_name,source_ref`, {
        method: "POST",
        headers: { ...headers, "Prefer": "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify({
            client_name: client,
            live_date: liveDateOf(a.published_at),
            kind: "content",
            title: a.title,
            url: a.url,
            notes: null,
            created_by: a.source,
            source_ref: a.ref,
        }),
    });
    if (!res.ok) throw new Error(`seo_changelog insert failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) && rows.length > 0;
}

// Blog payloads carry no customer data, but a Wix automation can be mapped to include anything,
// so emails, phone numbers and credentials are stripped before a copy is kept.
function scrub(value: unknown, secret: string, key = "", depth = 0): unknown {
    if (depth > 8) return "[too deep]";
    if (value === null || value === undefined) return value;
    // GitHub push payloads name whoever committed. Nothing here needs people's names.
    if (/^(author|committer|pusher|sender)$/i.test(key)) return "[removed]";
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, secret, key, depth + 1));
    if (typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v, secret, k, depth + 1)]));
    }
    if (/(secret|token|password|api[_-]?key|authori[sz]ation)/i.test(key)) return "[redacted-secret]";
    if (typeof value === "string") {
        if (secret && value.trim() === secret) return "[redacted-secret]";
        if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(value)) return "[redacted-email]";
        if (!/^\d{4}-\d{2}-\d{2}/.test(value) && /^\+?[\d\s().-]{7,}$/.test(value.trim()) && value.replace(/\D/g, "").length >= 10) return "[redacted-phone]";
        return value.length > 1000 ? value.slice(0, 1000) + "…" : value;
    }
    return value;
}

async function recordEvent(row: Record<string, unknown>): Promise<void> {
    try {
        const { base, headers } = service();
        const res = await fetch(`${base}/rest/v1/seo_changelog_webhook_events`, {
            method: "POST",
            headers: { ...headers, "Prefer": "return=minimal" },
            body: JSON.stringify(row),
        });
        if (!res.ok) console.error("seo-changelog-webhook: event not recorded", res.status, (await res.text()).slice(0, 200));
    } catch (err) {
        // Never fail the webhook over the debug record
        console.error("seo-changelog-webhook: event not recorded", String(err));
    }
}

// Same gate as ghl-lead-webhook: constant-time, both sides trimmed and unquoted.
function safeEqual(a: string, b: string): boolean {
    const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
    let diff = x.length ^ y.length;
    for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
    return diff === 0;
}
function normaliseSecret(s: string | null | undefined): string {
    let t = String(s ?? "").trim();
    if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) t = t.slice(1, -1).trim();
    return t;
}

Deno.serve(async (req: Request) => {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    const url = new URL(req.url);
    const token = url.searchParams.get("t");
    let config: Config | null = null;
    let expected = "";

    if (token !== null) {
        // Per-client token: the row it matches is the credential
        try { config = await loadConfigByToken(token.trim()); }
        catch (err) { console.error("seo-changelog-webhook FAILED", String(err)); return new Response("lookup failed", { status: 500 }); }
        if (!config) {
            console.warn("seo-changelog-webhook REFUSED", JSON.stringify({ reason: "unknown token", token_length: token.length }));
            return new Response("unauthorized", { status: 401 });
        }
    } else {
        // Shared secret (first-version URLs). Fail closed: with verify_jwt off, no secret would
        // leave this open to anyone with the URL.
        expected = normaliseSecret(Deno.env.get("SEO_WEBHOOK_SECRET"));
        if (!expected) return new Response("not configured", { status: 500 });
        const given = normaliseSecret(req.headers.get("x-webhook-secret") ?? url.searchParams.get("k"));
        if (!safeEqual(given, expected)) {
            console.warn("seo-changelog-webhook REFUSED", JSON.stringify({ given_length: given.length, expected_length: expected.length }));
            return new Response("unauthorized", { status: 401 });
        }
    }

    const raw = await req.text();
    let body: any = null;
    try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }

    const params: { source: string | null; site: string | null; path: string | null; collection: string | null } = config
        ? { source: config.platform, site: null, path: config.blog_path, collection: config.collection_id }
        : {
            source: url.searchParams.get("source"),
            site: url.searchParams.get("site"),
            path: url.searchParams.get("path"),
            collection: url.searchParams.get("collection"),
        };
    const source = params.source === "wix" || params.source === "webflow" || params.source === "git" || params.source === "sanity"
        ? params.source
        : (body && typeof body === "object" && "triggerType" in body ? "webflow" : "wix");

    const event: Record<string, unknown> = {
        source,
        client_name: config?.client_name ?? null,
        query: config ? { via: "token" } : { site: params.site, path: params.path, collection: params.collection },
        payload: scrub(body, expected || String(token ?? "")),
    };

    try {
        let tokenClient: { name: string; gsc_property: string | null } | null = null;
        if (config) {
            tokenClient = await loadClient(config.client_name);
            if (!tokenClient) {
                const reason = `client "${config.client_name}" no longer exists`;
                await recordEvent({ ...event, outcome: "skipped", reason });
                return Response.json({ ok: true, logged: 0, reason });
            }
            // Webflow posts need the site to build their URL, taken from the client record
            params.site = domainOf(tokenClient.gsc_property);
        }

        const parsed = source === "webflow"
            ? parseWebflow(body, { site: params.site, path: params.path, collection: params.collection })
            : source === "sanity"
            ? (config ? parseSanity(body, { site: params.site, path: params.path })
                      : { ok: false as const, reason: "Sanity sites need a per-client link from the SEO tab" })
            : source === "git"
            // Git only through a per-client token: its content folder lives in the config
            ? (config ? parseGitPush(body, req.headers.get("x-github-event"), { site: params.site, path: params.path, contentPath: config.content_path })
                      : { ok: false as const, reason: "Git sites need a per-client link from the SEO tab" })
            : parseWix(body);
        if (parsed.ok && source === "git") await fillGitTitles(parsed.articles);
        if (!parsed.ok) {
            await recordEvent({ ...event, outcome: "skipped", reason: parsed.reason });
            // 200, not an error: an ignored event (another collection, a draft) is normal, and a
            // failing webhook can get disabled by the sender
            return Response.json({ ok: true, logged: 0, reason: parsed.reason });
        }

        // A Webflow client whose blog collection isn't picked yet: hold these back rather than log
        // team members and testimonials. The SEO tab lists them, and picking the blog logs them.
        if (config && source === "webflow" && !config.collection_id) {
            const held = parsed.articles.map((a) => ({
                ref: a.ref, title: a.title, slug: a.slug ?? null, collection_id: a.collection_id ?? null, published_at: a.published_at,
            }));
            const reason = "blog collection not picked yet: choose it on the SEO tab";
            await recordEvent({ ...event, outcome: "needs_collection", reason, results: held });
            return Response.json({ ok: true, logged: 0, reason });
        }

        const clients = config ? [] : await loadClients();
        const paramHost = siteHost(params.site);
        const results: { ref: string; client: string | null; outcome: string; reason?: string }[] = [];
        for (const a of parsed.articles) {
            const r = tokenClient ? checkTokenClient(tokenClient, a.host) : resolveClient(clients, a.host, paramHost);
            if ("reason" in r) { results.push({ ref: a.ref, client: null, outcome: "skipped", reason: r.reason }); continue; }
            const isNew = await logArticle(r.client, a);
            results.push({ ref: a.ref, client: r.client, outcome: isNew ? "logged" : "duplicate" });
        }

        const logged = results.filter((r) => r.outcome === "logged").length;
        const outcome = logged ? "logged" : results.every((r) => r.outcome === "duplicate") ? "duplicate" : "skipped";
        await recordEvent({
            ...event,
            outcome,
            reason: results.find((r) => r.reason)?.reason ?? null,
            client_name: results.find((r) => r.client)?.client ?? event.client_name,
            results,
        });
        console.log("seo-changelog-webhook", JSON.stringify({ source, outcome, results }));
        return Response.json({ ok: true, logged, results });
    } catch (err) {
        // The database is the problem, not the article. 500 lets the sender retry, and the insert
        // is first-write-wins, so a retry can never duplicate.
        const msg = String((err as Error)?.message ?? err);
        console.error("seo-changelog-webhook FAILED", msg);
        await recordEvent({ ...event, outcome: "error", reason: msg.slice(0, 500) });
        return Response.json({ ok: false, error: msg }, { status: 500 });
    }
});
