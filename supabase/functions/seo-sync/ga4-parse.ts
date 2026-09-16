// GA4 report shaping for seo-sync. No imports, so it can be tested against fixed JSON with no
// network (same reason seranking-sync keeps parse.ts separate).
//
// Every builder MERGES rows that share a primary key. Two things make duplicates possible: paths are
// normalized here ("/about/" and "/about" are one page), and PostgREST refuses an upsert batch that
// touches the same row twice.

// Sessions referred by AI assistants. GA4 regexes must match the WHOLE value (FULL_REGEXP), hence
// the leading and trailing .*
export const AI_SOURCE_REGEX =
    ".*(chatgpt|openai|perplexity|gemini\\.google|bard\\.google|copilot\\.microsoft|claude\\.ai|deepseek|meta\\.ai|grok|you\\.com|poe\\.com).*";

// The six reports pulled for every window. Metric order matters: builders read by index.
export const GA4_REPORTS = {
    daily: {
        dimensions: ["date"],
        metrics: ["sessions", "engagedSessions", "totalUsers", "newUsers", "screenPageViews",
            "averageSessionDuration", "userEngagementDuration", "keyEvents", "eventCount"],
    },
    sources: {
        dimensions: ["date", "sessionDefaultChannelGroup", "sessionSource", "sessionMedium"],
        metrics: ["sessions", "engagedSessions", "keyEvents"],
    },
    pages: {
        dimensions: ["date", "pagePath"],
        metrics: ["screenPageViews", "userEngagementDuration"],
    },
    landing: {
        dimensions: ["date", "landingPage"],
        metrics: ["sessions", "engagedSessions", "keyEvents", "averageSessionDuration"],
    },
    // pageReferrer on a page view is the page the visitor was on before, when they navigated inside
    // the site. hostName tells us which referrers are internal.
    flows: {
        dimensions: ["date", "pagePath", "pageReferrer", "hostName"],
        metrics: ["screenPageViews"],
    },
    events: {
        dimensions: ["date", "eventName"],
        metrics: ["eventCount", "keyEvents"],
    },
    ai: {
        dimensions: ["date", "sessionSource", "landingPage"],
        metrics: ["sessions", "engagedSessions", "keyEvents"],
        dimensionFilter: {
            filter: { fieldName: "sessionSource", stringFilter: { matchType: "FULL_REGEXP", value: AI_SOURCE_REGEX, caseSensitive: false } },
        },
    },
} as const;

export type ReportRow = { d: string[]; m: number[] };

// runReport's {rows: [{dimensionValues: [{value}], metricValues: [{value}]}]} → plain arrays.
// A response without `rows` is an empty report (GA4 omits the key), not an error.
export function reportRows(body: any): ReportRow[] {
    if (!body || typeof body !== "object") throw new Error("GA4 report: response is not an object");
    if (body.rows !== undefined && !Array.isArray(body.rows)) throw new Error("GA4 report: rows is not a list");
    return (body.rows ?? []).map((r: any) => ({
        d: (r.dimensionValues ?? []).map((v: any) => String(v?.value ?? "")),
        m: (r.metricValues ?? []).map((v: any) => {
            const n = Number(v?.value);
            return isFinite(n) ? n : 0;
        }),
    }));
}

// GA4 sends dates as YYYYMMDD, in the property's own time zone.
export function gaDate(s: string): string | null {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s ?? ""));
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// "/services/decks/?utm=x#top" → "/services/decks". The root stays "/". GA4 placeholders like
// "(not set)" pass through. Case is kept: paths are case-sensitive on most hosts.
export function normPath(p: string): string {
    let s = String(p ?? "").trim();
    if (!s) return "(not set)";
    if (s.startsWith("(")) return s;
    s = s.replace(/[?#].*$/, "");
    if (!s.startsWith("/")) s = "/" + s;
    s = s.replace(/\/{2,}/g, "/");
    if (s.length > 1) s = s.replace(/\/+$/, "");
    return s || "/";
}

const bareHost = (h: string) => String(h ?? "").toLowerCase().replace(/^www\./, "").replace(/\.$/, "");

// The path of an internal referrer, or null when the visitor came from another site (or none).
export function referrerPath(referrer: string, hostName: string): string | null {
    if (!referrer || !hostName) return null;
    let u: URL;
    try { u = new URL(referrer); } catch { return null; }
    if (bareHost(u.hostname) !== bareHost(hostName)) return null;
    return normPath(u.pathname);
}

const round = (n: number) => Math.round(n);
const secs = (n: number) => Math.round(n * 10) / 10;

function merge<T extends Record<string, any>>(rows: T[], key: (r: T) => string, sumFields: string[]): T[] {
    const out = new Map<string, T>();
    for (const r of rows) {
        const k = key(r);
        const hit = out.get(k);
        if (!hit) { out.set(k, { ...r }); continue; }
        for (const f of sumFields) (hit as any)[f] = ((hit as any)[f] ?? 0) + ((r as any)[f] ?? 0);
    }
    return [...out.values()];
}

export function buildDailyRows(client: string, rows: ReportRow[]) {
    return merge(rows.flatMap((r) => {
        const date = gaDate(r.d[0]);
        if (!date) return [];
        const [sessions, engaged, users, newUsers, views, avgDur, engagement, keyEvents, events] = r.m;
        return [{
            client_name: client, date,
            sessions: round(sessions), engaged_sessions: round(engaged),
            users: round(users), new_users: round(newUsers), page_views: round(views),
            // averageSessionDuration isn't summable across days; its total is
            session_duration_sec: secs(avgDur * sessions),
            engagement_sec: secs(engagement),
            key_events: secs(keyEvents), event_count: round(events),
        }];
    }), (r) => r.date, ["sessions", "engaged_sessions", "users", "new_users", "page_views", "session_duration_sec", "engagement_sec", "key_events", "event_count"]);
}

export function buildSourceRows(client: string, rows: ReportRow[]) {
    return merge(rows.flatMap((r) => {
        const date = gaDate(r.d[0]);
        if (!date) return [];
        return [{
            client_name: client, date,
            channel: r.d[1] || "(not set)", source: r.d[2] || "(not set)", medium: r.d[3] || "(not set)",
            sessions: round(r.m[0]), engaged_sessions: round(r.m[1]), key_events: secs(r.m[2]),
        }];
    }), (r) => `${r.date}|${r.channel}|${r.source}|${r.medium}`, ["sessions", "engaged_sessions", "key_events"]);
}

// Page views come from pagePath, entrances from landingPage. Same path space, so one row per page.
export function buildPageRows(client: string, pageRows: ReportRow[], landingRows: ReportRow[]) {
    const rows: any[] = [];
    for (const r of pageRows) {
        const date = gaDate(r.d[0]);
        if (!date) continue;
        rows.push({ client_name: client, date, page_path: normPath(r.d[1]),
            page_views: round(r.m[0]), engagement_sec: secs(r.m[1]),
            entrances: 0, landing_engaged_sessions: 0, landing_key_events: 0, landing_duration_sec: 0 });
    }
    for (const r of landingRows) {
        const date = gaDate(r.d[0]);
        if (!date) continue;
        rows.push({ client_name: client, date, page_path: normPath(r.d[1]),
            page_views: 0, engagement_sec: 0,
            entrances: round(r.m[0]), landing_engaged_sessions: round(r.m[1]),
            landing_key_events: secs(r.m[2]), landing_duration_sec: secs(r.m[3] * r.m[0]) });
    }
    return merge(rows, (r) => `${r.date}|${r.page_path}`,
        ["page_views", "engagement_sec", "entrances", "landing_engaged_sessions", "landing_key_events", "landing_duration_sec"])
        .filter((r) => r.page_views > 0 || r.entrances > 0);
}

// Internal page-to-page moves only. External and empty referrers are entrances, already counted.
export function buildFlowRows(client: string, rows: ReportRow[]) {
    return merge(rows.flatMap((r) => {
        const date = gaDate(r.d[0]);
        const from = referrerPath(r.d[2], r.d[3]);
        if (!date || !from || !(r.m[0] > 0)) return [];
        return [{ client_name: client, date, from_path: from, to_path: normPath(r.d[1]), views: round(r.m[0]) }];
    }), (r) => `${r.date}|${r.from_path}|${r.to_path}`, ["views"]);
}

export function buildEventRows(client: string, rows: ReportRow[]) {
    return merge(rows.flatMap((r) => {
        const date = gaDate(r.d[0]);
        if (!date || !r.d[1]) return [];
        return [{ client_name: client, date, event_name: r.d[1], event_count: round(r.m[0]), key_events: secs(r.m[1]) }];
    }), (r) => `${r.date}|${r.event_name}`, ["event_count", "key_events"]);
}

export function buildAiRows(client: string, rows: ReportRow[]) {
    return merge(rows.flatMap((r) => {
        const date = gaDate(r.d[0]);
        if (!date) return [];
        return [{ client_name: client, date, source: (r.d[1] || "(not set)").toLowerCase(), landing_page: normPath(r.d[2]),
            sessions: round(r.m[0]), engaged_sessions: round(r.m[1]), key_events: secs(r.m[2]) }];
    }), (r) => `${r.date}|${r.source}|${r.landing_page}`, ["sessions", "engaged_sessions", "key_events"]);
}

// A plain-English reason for the errors a new client actually hits.
export function explainGa4Error(status: number, text: string, serviceAccount: string): string {
    const t = String(text ?? "");
    if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(t)) {
        return "The Google Analytics Data API isn't turned on in our Google Cloud project. Enable \"Google Analytics Data API\" there, wait a few minutes, and test again.";
    }
    if (status === 403 || /PERMISSION_DENIED|sufficient permissions/i.test(t)) {
        return `${serviceAccount} can't read this GA4 property. Add it as a Viewer in GA4 → Admin → Property access management.`;
    }
    if (status === 400 && /property/i.test(t)) {
        return "GA4 didn't recognise that property ID. Use the digits under Admin → Property details, not the Measurement ID (G-…).";
    }
    return `GA4 returned ${status}: ${t.slice(0, 200)}`;
}
