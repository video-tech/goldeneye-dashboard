// meta-sync: per-ad daily numbers and the ad account change log, from Meta's Graph API into
// meta_ad_daily and meta_activity. Golden Eye's daily_reports (the Make pull) is account level,
// so before this nothing could say which ad did what, or line a change up against its effect.
// The weekly report reads both (buildReportAdActivityBlock in app.js).
//
// Modes (POST body):
//   {}                                   daily: the last 8 days for every client. pg_cron, daily.
//   { mode: "backfill", days: 90, client? }  Up to 180 days, one client or all.
//   { mode: "check", client? }           Can the token read each client's ad account?
//
// Who may call: the x-cron-secret header (pg_cron, or a one-off call from the SQL Editor), or a
// signed-in admin. Refused calls are logged as "meta-sync REFUSED: …".
//
// Secrets:  META_ACCESS_TOKEN  a System User token with ads_read only. Never logged: Meta's
//                              paging links carry it, so every error string goes through scrubToken.
//           MAKE_WEBHOOK_SECRET (the cron secret, shared with the other scheduled functions)
// Schema:   meta-sync/schema.sql, then supabase/sql/rename_client.sql. Schedule: schedule.sql.

import { createClient } from "npm:@supabase/supabase-js@2";
import { adminCheck, cronCheck } from "../_shared/admin-auth.ts";
import {
    parseInsights, parseActivities, isRateLimit, scrubToken, windowEndingYesterday,
    pickAccounts, type AdDayRow, type ActivityRow,
} from "./parse.ts";

const GRAPH = "https://graph.facebook.com/v21.0";
const DAILY_DAYS = 8;          // Meta keeps attributing leads to the click day for 7 days
const MAX_BACKFILL_DAYS = 180;
const TIME_BUDGET_MS = 120_000; // stop starting new clients past this; the gateway kills at 150s

class GraphError extends Error {
    constructor(message: string, public code?: number) { super(message); }
}

async function graphGetAll(url: string, token: string, maxPages = 40): Promise<any[]> {
    const out: any[] = [];
    let next: string | null = url;
    for (let page = 0; next && page < maxPages; page++) {
        const res = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.error) {
            const e = json?.error ?? {};
            throw new GraphError(scrubToken(`${e.type ?? "Graph"} ${e.code ?? res.status}: ${e.message ?? res.statusText}`), Number(e.code));
        }
        out.push(json);
        next = json?.paging?.next ?? null;
    }
    return out;
}

function insightsUrl(acct: string, since: string, until: string) {
    const p = new URLSearchParams({
        level: "ad",
        time_increment: "1",
        time_range: JSON.stringify({ since, until }),
        fields: "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,reach,inline_link_clicks,actions",
        limit: "500",
    });
    return `${GRAPH}/act_${acct}/insights?${p}`;
}

function activitiesUrl(acct: string, since: string, until: string) {
    const p = new URLSearchParams({
        since: String(Math.floor(Date.parse(since + "T00:00:00Z") / 1000)),
        // through the end of `until`
        until: String(Math.floor(Date.parse(until + "T00:00:00Z") / 1000) + 86400),
        fields: "event_time,event_type,translated_event_type,object_id,object_name,object_type,actor_id,actor_name,application_name,extra_data",
        limit: "500",
    });
    return `${GRAPH}/act_${acct}/activities?${p}`;
}

async function upsertChunks(db: any, table: string, rows: any[], onConflict: string) {
    for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from(table).upsert(rows.slice(i, i + 500), { onConflict });
        if (error) throw new Error(`${table}: ${error.message}`);
    }
}

async function loadAccounts(db: any, onlyClient?: string) {
    const { data, error } = await db.from("clients").select("name, status, ad_account_id");
    if (error) throw new Error(`clients: ${error.message}`);
    return pickAccounts(data ?? [], onlyClient);
}

async function syncAccount(db: any, token: string, a: { ad_account_id: string; client_name: string }, days: number) {
    const { since, until } = windowEndingYesterday(new Date(), days);
    const ctx = { client_name: a.client_name, ad_account_id: a.ad_account_id };

    const insightPages = await graphGetAll(insightsUrl(a.ad_account_id, since, until), token);
    const adRows: AdDayRow[] = insightPages.flatMap((j) => parseInsights(j, ctx));
    await upsertChunks(db, "meta_ad_daily", adRows, "ad_account_id,date,ad_id");

    const activityPages = await graphGetAll(activitiesUrl(a.ad_account_id, since, until), token);
    // The same change can come back on two pages if it straddles a page boundary
    const seen = new Set<string>();
    const actRows: ActivityRow[] = activityPages.flatMap((j) => parseActivities(j, ctx))
        .filter((r) => !seen.has(r.event_key) && seen.add(r.event_key));
    await upsertChunks(db, "meta_activity", actRows, "event_key");

    return { since, until, ad_rows: adRows.length, changes: actRows.length, significant: actRows.filter((r) => r.significant).length };
}

async function recordState(db: any, client: string, patch: Record<string, unknown>) {
    await db.from("meta_sync_state").upsert({ client_name: client, ...patch }, { onConflict: "client_name" });
}

Deno.serve(async (req: Request) => {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const mode = body?.mode ?? "daily";

    // Who's asking, before anything is read. Unlike client-summary, the cron secret may run every
    // mode: they all only read from Meta and write these two tables (no model calls, no texts, no
    // money), and the secret lives only in Vault and function secrets. That lets the one-time
    // backfill and the token check run from the SQL Editor (schedule.sql has both).
    let caller: "cron" | "admin";
    if (cronCheck(req, Deno.env.get("MAKE_WEBHOOK_SECRET"))) {
        caller = "cron";
    } else {
        const who = await adminCheck(db, req);
        if (!who.ok) {
            console.warn(`meta-sync REFUSED: ${who.reason}`);
            return Response.json({ error: who.reason }, { status: 403 });
        }
        caller = "admin";
    }

    const token = (Deno.env.get("META_ACCESS_TOKEN") ?? "").trim();
    if (!token) {
        return Response.json({ error: "META_ACCESS_TOKEN isn't set. Create a System User token with ads_read and set it with supabase secrets set." }, { status: 500 });
    }

    try {
        if (mode === "check") {
            const accounts = await loadAccounts(db, body?.client);
            if (!accounts.length) return Response.json({ ok: false, reason: `No ad account on file for ${body?.client ?? "that client"}.` });
            const out = [];
            for (const a of accounts) {
                try {
                    const [j] = await graphGetAll(`${GRAPH}/act_${a.ad_account_id}?fields=name,account_status,currency,timezone_name`, token, 1);
                    out.push({ client: a.client_name, ok: true, name: j.name, account_status: j.account_status, currency: j.currency, timezone: j.timezone_name });
                } catch (e) {
                    out.push({ client: a.client_name, ok: false, reason: scrubToken(String((e as Error).message)) });
                }
            }
            return Response.json({ ok: out.every((o) => o.ok), accounts: out });
        }

        const days = mode === "backfill"
            ? Math.max(1, Math.min(MAX_BACKFILL_DAYS, Number(body?.days) || 90))
            : DAILY_DAYS;
        if (mode !== "daily" && mode !== "backfill") {
            return Response.json({ error: `Unknown mode ${mode}` }, { status: 400 });
        }

        const accounts = await loadAccounts(db, body?.client);
        const started = Date.now();
        const results: any[] = [];
        for (const a of accounts) {
            if (Date.now() - started > TIME_BUDGET_MS) {
                results.push({ client: a.client_name, skipped: "out of time this run" });
                continue;
            }
            try {
                const r = await syncAccount(db, token, a, days);
                await recordState(db, a.client_name, { ad_account_id: a.ad_account_id, last_run_at: new Date().toISOString(), last_error: null, last_window: `${r.since}..${r.until}` });
                results.push({ client: a.client_name, ...r });
            } catch (e) {
                const msg = scrubToken(String((e as Error).message));
                await recordState(db, a.client_name, { ad_account_id: a.ad_account_id, last_run_at: new Date().toISOString(), last_error: msg });
                results.push({ client: a.client_name, error: msg });
                console.error(`meta-sync ${a.client_name}: ${msg}`);
                // Rate limited: everything after this would fail the same way. Tomorrow's run
                // re-pulls the whole window, so nothing is lost by stopping.
                if (e instanceof GraphError && isRateLimit(e)) {
                    results.push({ stopped: "Meta rate limit; the next run picks up the rest" });
                    break;
                }
            }
        }
        console.log(`meta-sync ${mode} by ${caller}: ${JSON.stringify(results).slice(0, 2000)}`);
        return Response.json({ mode, days, results });
    } catch (e) {
        const msg = scrubToken(String((e as Error).message));
        console.error(`meta-sync failed: ${msg}`);
        return Response.json({ error: msg }, { status: 500 });
    }
});
