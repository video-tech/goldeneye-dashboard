// SE Ranking sync — pulls tracked rank into seo_rank_locations / seo_keywords /
// seo_rank_checks for every client with a seranking_site_id set.
//
// Companion to seo-sync (Search Console) and ghl-lead-webhook (organic leads). This is the
// piece that answers "are we ranking for a term we don't have impressions on yet" — GSC
// only reports a query once it earns an impression, so a client at position 40 for a real
// money term is invisible to it. SE Ranking checks a keyword whether or not the client
// shows up yet. See CLAUDE.md, SEO measurement, for the fuller reasoning.
//
// Three calls per client, matching how SE Ranking's own data is shaped:
//   1. search engines  -> seo_rank_locations  (which cities/devices are tracked)
//   2. keyword list    -> seo_keywords        (site_engine_ids per keyword is recorded,
//                                               not assumed — see the comment on that below)
//   3. positions       -> seo_rank_checks     (organic AND map-pack rank, one row each)
//
// Deploy:  supabase functions deploy seranking-sync --project-ref hugnttsqucetldllfgoi
// Secret:  SERANKING_API_KEY
// Schema:  seranking-sync/schema.sql, then supabase/sql/rename_client.sql

import { createClient } from "npm:@supabase/supabase-js@2";
import { parseKeywords, parsePositions, parseSearchEngines } from "./parse.ts";

const API_BASE = "https://api.seranking.com/v1/project-management";

// Confirmed from SE Ranking's own docs and examples (their getting-started page 403'd a
// direct fetch, but the Authorization: Token format is documented and shown working in
// their curl examples elsewhere). Untested against OUR key until the first live sync —
// that call is what actually proves it, the same way the Google auth code was built
// against the documented flow and confirmed by the first real token exchange.
function authHeaders(key: string): Record<string, string> {
    return { "Authorization": `Token ${key}`, "Content-Type": "application/json" };
}

async function seRankingGet(key: string, path: string): Promise<unknown> {
    const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders(key) });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`SE Ranking ${res.status} on ${path}: ${text.slice(0, 400)}`);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`SE Ranking returned non-JSON from ${path}: ${text.slice(0, 400)}`);
    }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

async function loadSeRankingClients(db: any, only?: string) {
    const { data, error } = await db.from("clients").select("name, status, seranking_site_id");
    if (error) throw new Error(`clients: ${error.message}`);
    const normalize = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return (data ?? []).filter((c: any) => {
        if (!c.seranking_site_id) return false;
        if (only && normalize(c.name) !== normalize(only)) return false;
        return true;
    });
}
// No status check here — same fix as seo-sync's loadSeoClients, found the same day. This
// is exactly what surfaced the bug: Midas Media's seranking_site_id was set and saved, but
// "Test SE Ranking" (which calls this same function) refused it with "no client... has a
// seranking_site_id set" because its status is 'paused'. Presence of seranking_site_id is
// meant to be the only switch, matching gsc_property's own rule.

async function upsertChunked(db: any, table: string, rows: any[], onConflict: string, chunk = 1000) {
    for (let i = 0; i < rows.length; i += chunk) {
        const { error } = await db.from(table).upsert(rows.slice(i, i + chunk), { onConflict });
        if (error) throw new Error(`${table}: ${error.message}`);
    }
}

async function saveState(db: any, clientName: string, patch: Record<string, unknown>) {
    const { error } = await db.from("seo_sync_state").upsert(
        [{ client_name: clientName, source: "seranking", last_run_at: new Date().toISOString(), ...patch }],
        { onConflict: "client_name,source" },
    );
    if (error) console.error(`seo_sync_state upsert failed for ${clientName}:`, error.message);
}

// The window a rank-tracking sync actually needs is small: a project's own history starts
// the day someone added the keyword, not 16 months ago like Search Console. 35 days
// comfortably covers "since the last successful run" even after a missed week, without
// ever asking SE Ranking for a range unrelated to what the account has tracked.
const HISTORY_DAYS = 35;

async function syncClient(db: any, key: string, client: { name: string; seranking_site_id: number }) {
    const siteId = client.seranking_site_id;

    const engines = parseSearchEngines(await seRankingGet(key, `/sites/search-engines?site_id=${siteId}`));
    if (engines.length) {
        await upsertChunked(db, "seo_rank_locations", engines.map((e) => ({
            client_name: client.name,
            seranking_site_id: siteId,
            site_engine_id: e.site_engine_id,
            label: e.label,
            device: e.device,
            synced_at: new Date().toISOString(),
        })), "seranking_site_id,site_engine_id");
    }

    const keywords = parseKeywords(await seRankingGet(key, `/keywords?site_id=${siteId}`));
    if (keywords.length) {
        await upsertChunked(db, "seo_keywords", keywords.map((k) => ({
            client_name: client.name,
            seranking_keyword_id: k.seranking_keyword_id,
            keyword: k.keyword,
        })), "client_name,keyword");
    }
    const keywordById = new Map(keywords.map((k) => [k.seranking_keyword_id, k.keyword]));

    const dateTo = new Date().toISOString().slice(0, 10);
    const dateFrom = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().slice(0, 10);

    let checksWritten = 0;
    for (const engine of engines) {
        const raw = await seRankingGet(
            key,
            `/sites/positions?site_id=${siteId}&site_engine_id=${engine.site_engine_id}&date_from=${dateFrom}&date_to=${dateTo}`,
        );
        const checks = parsePositions(raw, keywordById);
        if (!checks.length) continue;
        await upsertChunked(db, "seo_rank_checks", checks.map((c) => ({
            client_name: client.name,
            keyword: c.keyword,
            site_engine_id: engine.site_engine_id,
            date: c.date,
            organic_rank: c.organic_rank,
            map_rank: c.map_rank,
            ranking_url: c.ranking_url,
        })), "client_name,keyword,site_engine_id,date");
        checksWritten += checks.length;
    }

    return { engines: engines.length, keywords: keywords.length, rank_checks: checksWritten };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = [
    "https://goldeneye.midasmediafirm.com",
    "https://video-tech.github.io",
];

function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("Origin") ?? "";
    return {
        "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
    };
}

async function callerIsAdmin(db: any, req: Request): Promise<boolean> {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return false;
    const { data, error } = await db.auth.getUser(jwt);
    const email = data?.user?.email;
    if (error || !email) return false;
    const { data: profile } = await db.from("user_profiles").select("role").eq("email", email).maybeSingle();
    return profile?.role === "admin";
}

Deno.serve(async (req: Request) => {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

    try {
        const body = await req.json().catch(() => ({}));
        const only = body?.client ? String(body.client) : undefined;
        const mode = String(body?.mode ?? "sync");

        const db = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
        const key = Deno.env.get("SERANKING_API_KEY");
        if (!key) return Response.json({ error: "SERANKING_API_KEY is not set" }, { status: 500, headers: cors });

        if (mode === "check") {
            if (!await callerIsAdmin(db, req)) {
                return Response.json({ error: "admin sign-in required" }, { status: 403, headers: cors });
            }
            if (!only) return Response.json({ error: "check needs a client" }, { status: 400, headers: cors });
            const [client] = await loadSeRankingClients(db, only);
            if (!client) {
                return Response.json({ ok: false, message: `No client named "${only}" has a seranking_site_id set.` }, { headers: cors });
            }
            try {
                const engines = parseSearchEngines(await seRankingGet(key, `/sites/search-engines?site_id=${client.seranking_site_id}`));
                return Response.json({
                    ok: true,
                    message: `Connected — project ${client.seranking_site_id}, ${engines.length} search engine(s) configured.`,
                }, { headers: cors });
            } catch (err) {
                return Response.json({ ok: false, message: String((err as Error)?.message ?? err) }, { headers: cors });
            }
        }

        const clients = await loadSeRankingClients(db, only);
        if (!clients.length) {
            return Response.json({ mode, results: {}, note: "no active clients have a seranking_site_id set" }, { headers: cors });
        }

        const results: Record<string, unknown> = {};
        for (const c of clients) {
            try {
                const counts = await syncClient(db, key, c);
                await saveState(db, c.name, { last_daily_run: new Date().toISOString().slice(0, 10), last_error: null });
                results[c.name] = counts;
            } catch (err) {
                // One client's rate limit or a shape SE Ranking changed must never stop the
                // other nine — same discipline as seo-sync. The raw failure lands in
                // last_error, readable from the SQL Editor, not just a function log.
                const msg = String((err as Error)?.message ?? err);
                console.error(`seranking-sync failed for ${c.name}:`, msg);
                await saveState(db, c.name, { last_error: msg.slice(0, 500) });
                results[c.name] = `error: ${msg}`;
            }
        }

        return Response.json({ mode, results }, { headers: cors });
    } catch (err) {
        console.error("seranking-sync failed:", err);
        return Response.json({ error: String((err as Error)?.message ?? err) }, { status: 500, headers: cors });
    }
});
