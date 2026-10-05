// Parsing for meta-sync. No imports, so it runs under plain node for tests (same reason as
// seranking-sync/parse.ts and morning-audit/engine.js).
//
// Two Graph API reads per ad account:
//   /act_{id}/insights   level=ad, time_increment=1  -> one row per ad per day
//   /act_{id}/activities                              -> the account's change history
//
// The activity log's extra_data is the reason this file is careful. On real SimpliBlinds data
// (2026-10-05) Meta's own system entries carried ip, server_ip, machine_cookie, ssl_fp and
// request ids in extra_data. Only EXTRA_KEEP survives, and long strings are cut.

export type AdDayRow = {
    client_name: string; ad_account_id: string; date: string;
    ad_id: string; ad_name: string | null;
    adset_id: string | null; adset_name: string | null;
    campaign_id: string | null; campaign_name: string | null;
    spend: number; impressions: number; reach: number; link_clicks: number; leads: number;
};

export type ActivityRow = {
    event_key: string; client_name: string; ad_account_id: string;
    event_time: string; event_type: string; event_label: string | null;
    object_id: string | null; object_name: string | null; object_type: string | null;
    actor_name: string | null; actor_is_meta: boolean; application_name: string | null;
    extra: Record<string, unknown> | null;
    category: string; significant: boolean;
};

const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
};

// One lead figure per row. Meta reports the same lead under several action types, so adding
// them would double count. "lead" is Meta's total; the others are fallbacks for accounts whose
// rows only carry the narrower type.
const LEAD_TYPES = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];
export function leadsFromActions(actions: unknown): number {
    if (!Array.isArray(actions)) return 0;
    for (const t of LEAD_TYPES) {
        const hit = actions.find((a: any) => a && a.action_type === t);
        if (hit) return Math.round(num((hit as any).value));
    }
    return 0;
}

export function parseInsights(json: any, ctx: { client_name: string; ad_account_id: string }): AdDayRow[] {
    if (!json || !Array.isArray(json.data)) {
        throw new Error(`insights: unexpected response ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json.data
        .filter((r: any) => r && r.ad_id && r.date_start)
        .map((r: any) => ({
            client_name: ctx.client_name,
            ad_account_id: ctx.ad_account_id,
            date: String(r.date_start).slice(0, 10),
            ad_id: String(r.ad_id),
            ad_name: str(r.ad_name),
            adset_id: str(r.adset_id),
            adset_name: str(r.adset_name),
            campaign_id: str(r.campaign_id),
            campaign_name: str(r.campaign_name),
            spend: Math.round(num(r.spend) * 100) / 100,
            impressions: Math.round(num(r.impressions)),
            reach: Math.round(num(r.reach)),
            link_clicks: Math.round(num(r.inline_link_clicks)),
            leads: leadsFromActions(r.actions),
        }));
}

// What we keep from extra_data. old_value/new_value are what a report needs ("budget $30 to
// $45", "Active to Inactive"); type says what kind of change; campaign_id is Meta's legacy name
// for the AD SET id (campaign = ad set, campaign group = campaign in the old API naming), which
// is how a change to an ad set reaches the ads under it.
const EXTRA_KEEP = ["type", "old_value", "new_value", "currency", "campaign_id"];
const UNSAFE_KEY = /ip|cookie|fp$|_fp|request_id|user_agent|svn|session|token|email|phone/i;

function cleanValue(v: unknown, depth = 0): unknown {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return v.length > 300 ? v.slice(0, 300) + "…" : v;
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (depth >= 2) return null;
    if (Array.isArray(v)) return v.slice(0, 10).map((x) => cleanValue(x, depth + 1));
    if (typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
            if (UNSAFE_KEY.test(k)) continue;
            out[k] = cleanValue(x, depth + 1);
        }
        return out;
    }
    return null;
}

export function cleanExtra(raw: unknown): Record<string, unknown> | null {
    let obj: any = raw;
    if (typeof raw === "string") {
        try { obj = JSON.parse(raw); } catch { return null; }
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const out: Record<string, unknown> = {};
    for (const k of EXTRA_KEEP) if (k in obj) out[k] = cleanValue(obj[k]);
    return Object.keys(out).length ? out : null;
}

// The activity log has no id of its own. Two entries are the same change when the account,
// time, type, object and kept details all match, so that is the key. FNV-1a 64-bit, in plain
// JS so the key is identical in tests and in Deno.
export function fnv64(s: string): string {
    let h = 0xcbf29ce484222325n;
    const p = 0x100000001b3n;
    for (const b of new TextEncoder().encode(s)) { h ^= BigInt(b); h = (h * p) & 0xffffffffffffffffn; }
    return h.toString(16).padStart(16, "0");
}

// Grouping by Graph event_type. Matched on the snake_case name, with the translated label as a
// fallback for any type Meta adds later.
export function categorize(eventType: string, label: string | null): string {
    const t = `${eventType} ${label ?? ""}`.toLowerCase();
    if (/audience/.test(t)) return "audience";
    if (/image|video|library/.test(t) && !/creative/.test(t)) return "library";
    if (/review/.test(t) && /declin|reject|disapprov/.test(t)) return "review_declined";
    if (/review/.test(t) && /approv/.test(t)) return "review_approved";
    // "Updated status of ad after it finishes Ad Review" repeats the status change it schedules
    if (/after_review|after it finishes/.test(t)) return "status_scheduled";
    if (/run_status|status/.test(t)) return "status";
    if (/budget|spend_cap|spend cap/.test(t)) return "budget";
    if (/bid/.test(t)) return "bid";
    if (/target|keyword|conversion_event|optimization|placement/.test(t)) return "targeting";
    if (/creative/.test(t)) return "creative";
    if (/duration|schedule|end_time|start_time/.test(t)) return "schedule";
    if (/^create_|created/.test(t)) return "created";
    if (/name/.test(t)) return "renamed";
    if (/deliver/.test(t)) return "delivery";
    if (/ad_account|user_to_role|business_information|payment|billing/.test(t)) return "account";
    return "other";
}

// The run-status steps an ad passes through on its way to a state ("Pending Process",
// "Pending Review") aren't changes anyone made; the state it lands in is.
const SETTLED_STATUS = /^(active|inactive|paused|deleted|archived|disapproved|rejected|with issues)$/i;

export function isSignificant(category: string, actorIsMeta: boolean, extra: Record<string, unknown> | null): boolean {
    switch (category) {
        case "budget": case "bid": case "targeting": case "creative": case "schedule": case "created":
            return true;
        case "review_declined":
            return true;
        case "status": {
            const nv = typeof extra?.new_value === "string" ? extra.new_value : "";
            if (!SETTLED_STATUS.test(nv)) return false;
            // Meta flipping an ad to Inactive after review is bookkeeping; Meta disapproving it isn't
            if (actorIsMeta) return /disapprov|reject|issues/i.test(nv);
            return true;
        }
        default:
            return false;
    }
}

export function parseActivities(json: any, ctx: { client_name: string; ad_account_id: string }): ActivityRow[] {
    if (!json || !Array.isArray(json.data)) {
        throw new Error(`activities: unexpected response ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json.data
        .filter((a: any) => a && a.event_time && a.event_type)
        .map((a: any) => {
            const extra = cleanExtra(a.extra_data);
            const eventType = String(a.event_type);
            const label = str(a.translated_event_type);
            const actorIsMeta = String(a.actor_id ?? "") === "0" || /^meta$|^facebook$/i.test(String(a.actor_name ?? ""));
            const category = categorize(eventType, label);
            const time = new Date(a.event_time);
            const eventTime = isNaN(time.getTime()) ? String(a.event_time) : time.toISOString();
            const key = fnv64([ctx.ad_account_id, eventTime, eventType, a.object_id ?? "", JSON.stringify(extra ?? {})].join("|"));
            return {
                event_key: key,
                client_name: ctx.client_name,
                ad_account_id: ctx.ad_account_id,
                event_time: eventTime,
                event_type: eventType,
                event_label: label,
                object_id: str(a.object_id),
                object_name: str(a.object_name),
                object_type: str(a.object_type),
                actor_name: actorIsMeta ? "Meta" : str(a.actor_name),
                actor_is_meta: actorIsMeta,
                application_name: str(a.application_name),
                extra,
                category,
                significant: isSignificant(category, actorIsMeta, extra),
            };
        });
}

// Graph errors that mean "slow down", where the right move is to stop this run and let the next
// one pick up (the Make pull failed twice in September on exactly code 4).
export function isRateLimit(err: any): boolean {
    const c = Number(err?.code);
    return c === 4 || c === 17 || c === 32 || c === 613 || c === 80000 || c === 80004;
}

// Any URL or message can carry the token (Meta's paging "next" links include access_token).
export function scrubToken(s: string): string {
    return String(s).replace(/access_token=[^&\s"]+/gi, "access_token=***").replace(/EAA[A-Za-z0-9]{20,}/g, "***");
}

export function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

// [since, until] covering the last `days` days ending yesterday (UTC). Meta's own day is the ad
// account's time zone; a few hours of skew at the edge is harmless because every run re-pulls
// the whole window and upserts.
export function windowEndingYesterday(now: Date, days: number): { since: string; until: string } {
    const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
    const since = new Date(until.getTime() - (days - 1) * 86400000);
    return { since: ymd(since), until: ymd(until) };
}

export const normalizeAccountId = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const normalizeName = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// One Meta account per client, archived clients left out. Midas shares its ad account with
// Sunset Design Build (see CLAUDE.md), so an account listed on two clients goes to the one that
// isn't Midas Media.
export function pickAccounts(clients: any[], onlyClient?: string): { ad_account_id: string; client_name: string }[] {
    const byAcct = new Map<string, string>();
    for (const c of clients) {
        const acct = normalizeAccountId(c.ad_account_id);
        if (!acct || (c.status || "active") === "archived") continue;
        if (onlyClient && c.name !== onlyClient) continue;
        const prev = byAcct.get(acct);
        if (!prev || normalizeName(prev) === normalizeName("Midas Media")) byAcct.set(acct, c.name);
    }
    return [...byAcct.entries()].map(([ad_account_id, client_name]) => ({ ad_account_id, client_name }));
}
