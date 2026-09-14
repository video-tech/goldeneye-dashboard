// Pure parsing for seo-changelog-webhook. No imports and no I/O, so it can be tested with fixed
// JSON. index.ts is the only caller.
//
// Two senders, one shape out:
//   Webflow  "Collection Item Published" webhook, set up per site. Documented payload:
//            {triggerType: "collection_item_published", payload: {items: [{id, collectionId,
//            lastPublished, isDraft, isArchived, fieldData: {name, slug, ...}}]}}. Older and
//            single-item forms put the item straight in `payload`, so both are accepted.
//            There's no site domain or page URL in it, so the webhook URL carries ?site= (and
//            ?path= for the collection's URL prefix, e.g. /blog).
//   Wix      A Wix Automation, "Blog post published" → "Send HTTP request". Wix documents the
//            trigger but not the exact body, so fields are found by name wherever they sit.
//            Verify against a real capture (seo_changelog_webhook_events) before trusting it.
//
// Untested against real payloads from either sender as of 2026-09-14. Every event, parsed or
// not, is recorded with its outcome in seo_changelog_webhook_events so the first real one shows
// exactly what arrived.

export interface Article {
    source: "webflow" | "wix";
    ref: string;          // stable per article, so a republish can't log it twice
    title: string;
    url: string | null;
    host: string | null;  // from url when there is one
    published_at: string | null;
    collection_id?: string | null;  // Webflow only
    slug?: string | null;           // Webflow only, so a held post can get its URL once its blog path is known
}

export type ParseResult =
    | { ok: true; articles: Article[] }
    | { ok: false; reason: string };

const str = (v: unknown): string | null =>
    v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim();

const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");

// Kept identical to ghl-lead-webhook: "sc-domain:example.com" → "example.com",
// "https://www.example.com/" → "example.com".
export function domainOf(gscProperty: unknown): string | null {
    const p = str(gscProperty);
    if (!p) return null;
    if (p.toLowerCase().startsWith("sc-domain:")) return bare(p.slice("sc-domain:".length)) || null;
    try { return bare(new URL(p).hostname) || null; } catch { return null; }
}

// Subdomains count as the client's own site. Also identical to ghl-lead-webhook.
export function onDomain(host: string | null, domain: string | null): boolean {
    if (!host || !domain) return false;
    const h = bare(host);
    return h === domain || h.endsWith("." + domain);
}

function hostOf(u: string | null): string | null {
    if (!u) return null;
    try {
        const url = new URL(u);
        return url.protocol === "https:" || url.protocol === "http:" ? url.hostname.toLowerCase() : null;
    } catch { return null; }
}

// A bare "example.com" or a full URL, as typed into ?site=
export function siteHost(site: string | null): string | null {
    const s = str(site);
    if (!s) return null;
    return hostOf(/^https?:\/\//i.test(s) ? s : `https://${s}`);
}

// ---------------------------------------------------------------------------
// Webflow
// ---------------------------------------------------------------------------

export function parseWebflow(body: any, params: { site: string | null; path: string | null; collection: string | null }): ParseResult {
    const trigger = str(body?.triggerType);
    if (trigger && trigger !== "collection_item_published") return { ok: false, reason: `ignored Webflow event ${trigger}` };

    const p = body?.payload;
    const items: any[] = Array.isArray(p?.items) ? p.items : (p && typeof p === "object" && (p.id || p.fieldData) ? [p] : []);
    if (!items.length) return { ok: false, reason: "no CMS items in the Webflow payload" };

    const host = siteHost(params.site);
    const prefix = str(params.path)?.replace(/^\/*/, "/").replace(/\/+$/, "") ?? null;
    const articles: Article[] = [];
    for (const it of items) {
        // Webflow sends publishes for every collection (team members, testimonials, ...).
        // ?collection= restricts it to the blog.
        if (params.collection && str(it?.collectionId) !== params.collection) continue;
        if (it?.isDraft === true || it?.isArchived === true) continue;
        const id = str(it?.id);
        const title = str(it?.fieldData?.name) ?? str(it?.fieldData?.title);
        if (!id || !title) continue;
        const slug = str(it?.fieldData?.slug);
        const url = host && slug && prefix !== null ? `https://${host}${prefix}/${slug}` : null;
        articles.push({
            source: "webflow",
            ref: `webflow:${id}`,
            title: title.slice(0, 200),
            url,
            host: host,
            published_at: str(it?.lastPublished) ?? str(it?.createdOn),
            collection_id: str(it?.collectionId),
            slug,
        });
    }
    return articles.length
        ? { ok: true, articles }
        : { ok: false, reason: params.collection ? "no published items from the configured collection" : "no usable items (missing id or name, or draft/archived)" };
}

// ---------------------------------------------------------------------------
// Wix
// ---------------------------------------------------------------------------

// Depth-first search for the first non-empty value under any of the given keys. Wix nests the
// post differently depending on how the automation maps it (data.post.title, post.title, title).
function findKey(obj: any, keys: string[], depth = 0): unknown {
    if (!obj || typeof obj !== "object" || depth > 5) return undefined;
    for (const k of keys) {
        const v = obj[k];
        if (v !== undefined && v !== null && v !== "") return v;
    }
    for (const v of Object.values(obj)) {
        if (v && typeof v === "object") {
            const found = findKey(v, keys, depth + 1);
            if (found !== undefined) return found;
        }
    }
    return undefined;
}

// Wix's Blog API describes a post URL as {base, path}. A plain string is also accepted.
function wixUrl(v: unknown): string | null {
    if (typeof v === "string") return hostOf(v) ? v : null;
    if (v && typeof v === "object") {
        const base = str((v as any).base), path = str((v as any).path);
        if (base && path) {
            const joined = base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
            return hostOf(joined) ? joined : null;
        }
    }
    return null;
}

export function parseWix(body: any): ParseResult {
    if (!body || typeof body !== "object") return { ok: false, reason: "Wix body is not JSON" };
    const title = str(findKey(body, ["title", "postTitle", "post_title"]));
    const url = wixUrl(findKey(body, ["url", "postUrl", "postPageUrl", "post_url", "link", "pageUrl"]));
    const id = str(findKey(body, ["postId", "post_id", "_id", "id"]));
    if (!title) return { ok: false, reason: "no post title found in the Wix payload" };
    // The URL is the fallback identity: the same post always has the same address
    const ref = id ? `wix:${id}` : url ? `wix:${url}` : null;
    if (!ref) return { ok: false, reason: "no post id or URL found in the Wix payload" };
    return {
        ok: true,
        articles: [{
            source: "wix",
            ref,
            title: title.slice(0, 200),
            url,
            host: hostOf(url),
            published_at: str(findKey(body, ["firstPublishedDate", "publishedDate", "lastPublishedDate", "publishDate", "published_at"])),
        }],
    };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

// Which client an article belongs to: the article's own URL host, else ?site=, matched to
// exactly one client's Search Console domain, the same identity lead_sources uses. When both
// are present they must agree, so a misconfigured ?site= can't file one client's article
// under another.
export function resolveClient(
    clients: { name: string; gsc_property: string | null }[],
    articleHost: string | null,
    siteParamHost: string | null,
): { client: string } | { reason: string } {
    const host = articleHost ?? siteParamHost;
    if (!host) return { reason: "no site to match: add ?site=yourdomain.com to the webhook URL" };
    if (articleHost && siteParamHost && bare(articleHost) !== bare(siteParamHost)
        && !onDomain(articleHost, bare(siteParamHost)) && !onDomain(siteParamHost, bare(articleHost))) {
        return { reason: `article is on ${articleHost} but the webhook URL says ?site=${siteParamHost}` };
    }
    const matches = clients.filter((c) => onDomain(host, domainOf(c.gsc_property)));
    if (!matches.length) return { reason: `no client has a Search Console property for ${host}` };
    if (matches.length > 1) return { reason: `more than one client matches ${host}` };
    return { client: matches[0].name };
}

// A per-client token already says whose articles these are, so there's nothing to match. The
// one check left is that an article with a URL is really on that client's site, so a Wix
// automation pasted into the wrong client's site can't file articles under this one.
export function checkTokenClient(
    client: { name: string; gsc_property: string | null },
    articleHost: string | null,
): { client: string } | { reason: string } {
    const domain = domainOf(client.gsc_property);
    if (!domain) return { reason: `${client.name} has no Search Console property, so its site can't be confirmed` };
    if (articleHost && !onDomain(articleHost, domain)) {
        return { reason: `article is on ${articleHost}, not ${client.name}'s site (${domain})` };
    }
    return { client: client.name };
}

// The day it went live, in Mountain time, where the team reads the chart. An article published
// at 9 PM Denver on the 14th is the 15th in UTC, and would otherwise sit a day late.
export function liveDateOf(publishedAt: string | null, now = new Date()): string {
    const d = publishedAt ? new Date(publishedAt) : now;
    const when = isNaN(d.getTime()) ? now : d;
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(when);
}
