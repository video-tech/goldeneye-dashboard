// ghl-leads (2026-11-09): how many leads a client's own GHL shows for a date range, for the Leads check in Generate Report.
//
// READ ONLY. It lists the contacts added to the client's GHL sub-account in the range (POST /contacts/search, a search,
// allow-listed in _shared/ghl-write.ts as a read) and returns COUNTS ONLY: contacts added, how many carry one of the
// client's lead tags (clients.lead_tags), per tag, per day, and the most common other tags and sources (so the right
// tags can be picked). No name, email, phone or contact id ever leaves this function, and nothing is stored.
//
// Access: the Golden Eye GHL app's location token (it needs the "View Contacts" scope and to be installed on the
// sub-account), except our own Midas sub-account (shared with Sunset), which uses GHL_MIDAS_TOKEN.
// Caller: a signed-in admin only. Body: {"client": "<exact name>", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}, both
// days inclusive, in Mountain time (the same days the report and daily_reports use).

import { adminCheck } from "../_shared/admin-auth.ts";
import { ghlReadPost, GhlError } from "../_shared/ghl-write.ts";
import { locationAccessToken, oauthConfigured, type OAuthEnv } from "../_shared/ghl-oauth.ts";

export type Env = OAuthEnv & { GHL_MIDAS_TOKEN?: string; GHL_MIDAS_LOCATION_ID?: string };
export type Deps = { env: Env; db: any; fetch: typeof fetch; token?: (deps: Deps, loc: string) => Promise<string> };

export const PAGE = 500;
export const MAX_PAGES = 4; // 2,000 contacts in a range is far beyond any client's week; more is reported as truncated
const TZ = "America/Denver";
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const ALLOWED_ORIGINS = ["https://goldeneye.midasmediafirm.com", "https://video-tech.github.io"];
function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("Origin") ?? "";
    return {
        "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
    };
}

const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function parts(d: Date) {
    const o: Record<string, string> = {};
    for (const p of fmt.formatToParts(d)) o[p.type] = p.value;
    return o;
}
// The Mountain-time day an instant falls on, as YYYY-MM-DD
export function denverDay(iso: string): string {
    const o = parts(new Date(iso));
    return `${o.year}-${o.month}-${o.day}`;
}
// The UTC instant of midnight Mountain time at the start of a day (MST is UTC-7, MDT UTC-6)
export function denverMidnight(ymd: string): Date {
    const [y, m, d] = ymd.split("-").map(Number);
    for (const h of [6, 7]) {
        const t = new Date(Date.UTC(y, m - 1, d, h));
        const o = parts(t);
        if (`${o.year}-${o.month}-${o.day}` === ymd && o.hour === "00" && o.minute === "00") return t;
    }
    throw new Error(`Couldn't place ${ymd} in Mountain time.`);
}
function nextDay(ymd: string): string {
    const d = new Date(ymd + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

export const normTag = (t: unknown) => String(t ?? "").trim().toLowerCase();
export function cleanTags(list: unknown): string[] {
    const arr = Array.isArray(list) ? list : String(list ?? "").split(",");
    return [...new Set(arr.map(normTag).filter(Boolean))];
}

// Counts only. Contacts are reduced to their day, their tags and their source here; nothing else is kept.
export function countContacts(contacts: any[], leadTags: string[], start: string, end: string) {
    const wanted = new Set(leadTags);
    const perTag: Record<string, number> = Object.fromEntries(leadTags.map((t) => [t, 0]));
    const otherTags: Record<string, number> = {};
    const sources: Record<string, number> = {};
    const days: Record<string, { added: number; tagged: number }> = {};
    for (let d = start; d <= end; d = nextDay(d)) days[d] = { added: 0, tagged: 0 };
    let added = 0, tagged = 0;
    for (const c of contacts) {
        if (!c?.dateAdded) continue;
        const day = denverDay(c.dateAdded);
        if (day < start || day > end) continue;
        added++;
        days[day].added++;
        const tags = cleanTags(c.tags);
        const hits = tags.filter((t) => wanted.has(t));
        for (const t of hits) perTag[t]++;
        for (const t of tags) if (!wanted.has(t)) otherTags[t] = (otherTags[t] ?? 0) + 1;
        if (hits.length) { tagged++; days[day].tagged++; }
        const src = String(c.source ?? "").trim();
        if (src) sources[src] = (sources[src] ?? 0) + 1;
    }
    const top = (o: Record<string, number>, n: number) => Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([name, count]) => ({ name, count }));
    return {
        added, tagged, per_tag: perTag,
        by_day: Object.entries(days).map(([date, v]) => ({ date, ...v })),
        other_tags: top(otherTags, 10),
        sources: top(sources, 5),
    };
}

// Plain-English reasons for GHL's refusals, so the box says what to fix
export function explainGhlError(e: unknown): string {
    const msg = String((e as Error)?.message ?? e);
    const status = (e as GhlError)?.status;
    if (/scope/i.test(msg)) return "The Golden Eye GHL app doesn't have the View Contacts permission yet. Add it in the GHL Developer Portal and reinstall the app.";
    if (/does not have access to (the )?(following )?location|not installed|location.*access/i.test(msg)) return "The Golden Eye GHL app is not installed on this client's GHL account. Reinstall the app from the agency and tick this account.";
    if (status === 401 || status === 403) return `GHL refused the request (${status}). The app may not be installed on this account or may be missing the View Contacts permission.`;
    return `GHL answered with an error: ${msg.slice(0, 200)}`;
}

async function defaultToken(deps: Deps, loc: string): Promise<string> {
    const midasLoc = deps.env.GHL_MIDAS_LOCATION_ID?.trim();
    if (midasLoc && loc === midasLoc) {
        const t = deps.env.GHL_MIDAS_TOKEN?.trim();
        if (!t) throw new Error("This is our Midas GHL account, and GHL_MIDAS_TOKEN isn't set.");
        return t;
    }
    if (!oauthConfigured(deps.env)) throw new Error("The Golden Eye GHL app isn't set up on the server (GHL_APP_CLIENT_ID and friends).");
    return await locationAccessToken(deps, loc);
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
    const cors = corsHeaders(req);
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return reply({ error: "POST only" }, 405);

    const caller = await adminCheck(deps.db, req);
    if (!caller.ok) { console.warn("ghl-leads REFUSED:", caller.reason); return reply({ error: caller.reason }, 403); }

    const body = await req.json().catch(() => ({}));
    const client = typeof body?.client === "string" ? body.client.trim() : "";
    const start = String(body?.start ?? ""), end = String(body?.end ?? "");
    if (!client) return reply({ error: "Pick a client." }, 400);
    if (!YMD.test(start) || !YMD.test(end) || start > end) return reply({ error: "Send start and end as YYYY-MM-DD, start first." }, 400);
    if ((new Date(end).getTime() - new Date(start).getTime()) / 86400000 > 400) return reply({ error: "Pick a range of a year or less." }, 400);

    // select("*") so this works before lead_check.sql adds lead_tags
    const { data: row, error } = await deps.db.from("clients").select("*").eq("name", client).limit(1).maybeSingle();
    if (error) return reply({ error: `Couldn't read the client: ${error.message}` }, 500);
    if (!row) return reply({ error: `No client is called "${client}".` }, 404);
    const loc = String(row.ghl_location_id ?? "").trim();
    const leadTags = cleanTags(row.lead_tags);
    const base = { client, start, end, lead_tags: leadTags, tags_column: "lead_tags" in row };
    if (!loc) return reply({ ...base, status: "no_location", error: "No GHL location ID is saved for this client. Add it in Edit Client." });

    let token: string;
    try { token = await (deps.token ?? defaultToken)(deps, loc); }
    catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 200);
        console.warn(`ghl-leads: ${client} no token: ${msg}`);
        return reply({ ...base, status: "no_access", error: `Couldn't get into this client's GHL account. The Golden Eye GHL app is probably not installed on it: reinstall the app from the agency and tick this account. (${msg})` });
    }

    const contacts: any[] = [];
    let truncated = false;
    try {
        let after: unknown[] | undefined;
        for (let page = 0; ; page++) {
            if (page >= MAX_PAGES) { truncated = true; break; }
            const q: Record<string, unknown> = {
                locationId: loc,
                pageLimit: PAGE,
                filters: [{ field: "dateAdded", operator: "range", value: { gte: denverMidnight(start).toISOString(), lt: denverMidnight(nextDay(end)).toISOString() } }],
                sort: [{ field: "dateAdded", direction: "asc" }],
            };
            if (after) q.searchAfter = after; else q.page = 1;
            const json = await ghlReadPost(deps, "/contacts/search", token, q, [token]);
            const got: any[] = Array.isArray(json?.contacts) ? json.contacts : [];
            // Keep only what is counted; drop everything personal straight away
            for (const c of got) contacts.push({ dateAdded: c?.dateAdded, tags: c?.tags, source: c?.source });
            const last = got[got.length - 1];
            if (got.length < PAGE || !Array.isArray(last?.searchAfter)) break;
            after = last.searchAfter;
        }
    } catch (e) {
        console.warn(`ghl-leads: ${client} search failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        return reply({ ...base, status: "ghl_error", error: explainGhlError(e) });
    }

    const counts = countContacts(contacts, leadTags, start, end);
    console.log(`ghl-leads: ${client} ${start}..${end} added ${counts.added}, tagged ${counts.tagged}${truncated ? " (truncated)" : ""}`);
    return reply({ ...base, status: leadTags.length ? "ok" : "no_tags", truncated, ...counts });
}
