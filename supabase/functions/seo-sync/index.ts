// Search Console sync — runs unattended from pg_cron, and on demand from the admin
// dashboard's "Test connection" button.
//
// Two jobs share this one function:
//   mode: "daily"    — a rolling window over the last 10 days, every day
//   mode: "backfill" — walks backwards a calendar month at a time until 16 months of
//                      history exist for a client, then stops for good
//   mode: "check"    — admin-only, browser-called: can the service account actually
//                      read this client's property?
//
// Why a rolling window rather than "fetch yesterday" the way the Meta pull does:
// **Search Console does not have yesterday yet.** It finalises a day two to three days
// late, and keeps revising recent days after that. Asking for a fixed offset would
// either fetch nothing or freeze a half-finished day forever. The window re-fetches
// and upserts, so late-arriving data lands on the next run without anyone noticing.
// (The Meta pull's opposite property — rows frozen at a constant age — is what makes
// the morning audit's comparisons unbiased. Nothing here feeds that engine.)
//
// Deploy:  supabase functions deploy seo-sync
// Secrets: GOOGLE_SA_JSON — see _shared/google-auth.ts.
//          SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected for us.
// Schema:  run schema.sql once first, then schedule.sql.

import { createClient } from "npm:@supabase/supabase-js@2";
import { getGoogleToken, SCOPES, serviceAccountEmail } from "../_shared/google-auth.ts";

// The rolling window. Ten days comfortably covers GSC's 2-3 day finalisation lag plus
// a few days of a cron outage, at three cheap API calls per client per day.
const DAILY_WINDOW_DAYS = 10;

// Search Console keeps roughly 16 months. Past that the API returns nothing, so this
// is where the backfill stops rather than a policy choice.
const GSC_MAX_MONTHS = 16;

// Edge functions get 150s of wall clock. Stop starting new work at 100s so whatever is
// in flight has room to finish and save its cursor.
const TIME_BUDGET_MS = 100_000;

// So one client with 16 months to fetch cannot eat an entire invocation while another
// waits at zero. Every client that still needs backfill makes progress on every run;
// four months a run against a 15-minute cron finishes a new client inside about an hour.
const MAX_MONTHS_PER_CLIENT_PER_RUN = 4;

const GSC_ROW_LIMIT = 25000;   // Google's per-request maximum
const UPSERT_CHUNK = 1000;     // keep PostgREST payloads well clear of any body limit

const normalize = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// ---------------------------------------------------------------------------
// Dates. All UTC — edge functions run in UTC and so does pg_cron, so there is no
// local-time concept here to get wrong.
// ---------------------------------------------------------------------------
const toISO = (d: Date) => d.toISOString().slice(0, 10);
const parseISO = (s: string) => new Date(`${s}T00:00:00Z`);
function addDaysUTC(d: Date, n: number) {
    const x = new Date(d.getTime());
    x.setUTCDate(x.getUTCDate() + n);
    return x;
}
const monthStartUTC = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const monthEndUTC = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
const addMonthsUTC = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));

// ---------------------------------------------------------------------------
// Search Console
// ---------------------------------------------------------------------------

// Note the absence of `dataState`. Its default is "final", which means Google simply
// does not return the days it has not finished counting — exactly what we want. Asking
// for "all" would hand us partial days that look like a collapse in traffic.
async function gscQuery(
    token: string,
    property: string,
    startDate: string,
    endDate: string,
    dimensions: string[],
): Promise<any[]> {
    const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
    const out: any[] = [];
    let startRow = 0;

    for (;;) {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                startDate,
                endDate,
                dimensions,
                // Web search only, which is what the Performance report shows by
                // default — so our numbers and the ones the client sees in GSC match.
                type: "web",
                rowLimit: GSC_ROW_LIMIT,
                startRow,
            }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`GSC ${res.status} on ${property} [${dimensions.join(",")}]: ${text.slice(0, 300)}`);
        }

        const body = await res.json();
        const batch: any[] = body.rows ?? [];
        for (const r of batch) out.push(r);       // not push(...batch): 25k args blows the stack
        if (batch.length < GSC_ROW_LIMIT) break;
        startRow += batch.length;
        if (startRow > 250_000) break;            // a month that large means something is wrong
    }
    return out;
}

function roundPos(v: unknown): number | null {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n * 100) / 100;
}

async function upsertChunked(db: any, table: string, rows: any[], onConflict: string) {
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const { error } = await db.from(table).upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict });
        if (error) throw new Error(`${table}: ${error.message}`);
    }
}

// Fetches one window for one client across all three dimension sets and writes it.
//
// Upsert rather than delete-then-insert: a delete leaves a visible hole in a client's
// chart if the insert behind it fails, and GSC's restatements overwhelmingly ADD data
// to a day rather than remove a page from it — so a stale row is both unlikely and
// harmless, while a hole is neither.
async function syncGscWindow(
    db: any,
    token: string,
    client: any,
    startDate: string,
    endDate: string,
) {
    const property = String(client.gsc_property).trim();
    const name = client.name;

    const daily = await gscQuery(token, property, startDate, endDate, ["date"]);
    await upsertChunked(db, "seo_daily", daily.map((r) => ({
        client_name: name,
        date: r.keys[0],
        clicks: Math.round(Number(r.clicks) || 0),
        impressions: Math.round(Number(r.impressions) || 0),
        position: roundPos(r.position),
        synced_at: new Date().toISOString(),
    })), "client_name,date");

    const pages = await gscQuery(token, property, startDate, endDate, ["date", "page"]);
    await upsertChunked(db, "seo_pages_daily", pages.map((r) => ({
        client_name: name,
        date: r.keys[0],
        page: r.keys[1],
        clicks: Math.round(Number(r.clicks) || 0),
        impressions: Math.round(Number(r.impressions) || 0),
        position: roundPos(r.position),
    })), "client_name,date,page");

    const queries = await gscQuery(token, property, startDate, endDate, ["date", "query"]);
    await upsertChunked(db, "seo_queries_daily", queries.map((r) => ({
        client_name: name,
        date: r.keys[0],
        query: r.keys[1],
        clicks: Math.round(Number(r.clicks) || 0),
        impressions: Math.round(Number(r.impressions) || 0),
        position: roundPos(r.position),
    })), "client_name,date,query");

    return { days: daily.length, pages: pages.length, queries: queries.length };
}

// ---------------------------------------------------------------------------
// Clients and sync state
// ---------------------------------------------------------------------------

async function loadSeoClients(db: any, only?: string) {
    const { data, error } = await db.from("clients").select("name, status, gsc_property");
    if (error) throw new Error(`clients: ${error.message}`);
    return (data ?? []).filter((c: any) => {
        if (!c.gsc_property || !String(c.gsc_property).trim()) return false;
        if (only && normalize(c.name) !== normalize(only)) return false;
        return true;
    });
}
// No status check here, on purpose — found and removed 2026-09-11. "Presence of
// gsc_property is the switch" (see the comment on that column in schema.sql) means exactly
// that: nothing else gates whether a client's Search Console history gets collected.
// A status !== 'active' filter silently contradicted it — Midas Media's own record tested
// as "Connected" (runCheck below never filtered by status) while its scheduled pull was
// quietly skipped the whole time, because its status is 'paused'. A client can be paused
// for billing reasons and still want organic history collected; if syncing should stop for
// someone, clear their gsc_property — that's the one place this decision belongs.
// No "Midas Media" exclusion here, on purpose. client-summary/index.ts skips it for a
// real reason — Midas isn't a client, so it shouldn't get an AI-generated client work
// summary written about it — and an earlier version of this function copied that pattern
// on the assumption it'd generalize. It doesn't: that exclusion protects CLIENT-FACING
// content. Search Console has no equivalent conflict to protect against — each gsc_property
// is an independently scoped Google property, one per client, never shared — so any client
// row with a valid property gets pulled, Midas's own included. (The real Meta-ads-sharing
// fix, for the ad account Midas and Sunset actually share, works differently: normalize()
// aliases the shared account's name to Sunset Design Build so spend attributes correctly.
// It was never a blanket "skip Midas" rule, and nothing here needs to imitate it.)

async function loadState(db: any, clientName: string, source: string) {
    const { data } = await db
        .from("seo_sync_state")
        .select("*")
        .eq("client_name", clientName)
        .eq("source", source)
        .maybeSingle();
    return data;
}

async function saveState(db: any, clientName: string, source: string, patch: Record<string, unknown>) {
    const { error } = await db.from("seo_sync_state").upsert(
        [{ client_name: clientName, source, last_run_at: new Date().toISOString(), ...patch }],
        { onConflict: "client_name,source" },
    );
    if (error) console.error(`seo_sync_state upsert failed for ${clientName}:`, error.message);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

// Signed on first use, not on entry. The backfill cron fires every 15 minutes forever
// and, in the steady state where every client is already complete, has nothing to do —
// so the common case should not involve signing a JWT and calling Google's token
// endpoint 96 times a day to then use none of them.
function lazyGscToken() {
    let pending: Promise<string> | null = null;
    return () => (pending ??= getGoogleToken([SCOPES.gsc]));
}

async function runDaily(db: any, clients: any[], force: boolean) {
    const token = lazyGscToken();
    const today = new Date();
    const todayISO = toISO(today);
    const start = toISO(addDaysUTC(today, -DAILY_WINDOW_DAYS));
    const end = toISO(addDaysUTC(today, -1));

    const results: Record<string, unknown> = {};
    for (const c of clients) {
        try {
            const st = await loadState(db, c.name, "gsc");
            if (!force && st?.last_daily_run === todayISO) { results[c.name] = "already ran today"; continue; }

            const counts = await syncGscWindow(db, await token(), c, start, end);
            await saveState(db, c.name, "gsc", { last_daily_run: todayISO, last_error: null });
            results[c.name] = counts;
        } catch (err) {
            // One client's revoked access must never stop the other nine. The error is
            // stored where the admin UI can show it rather than only in a log nobody
            // opens — a silently empty chart is the failure mode this avoids.
            const msg = String((err as Error)?.message ?? err);
            console.error(`seo-sync daily failed for ${c.name}:`, msg);
            await saveState(db, c.name, "gsc", { last_error: msg.slice(0, 500) });
            results[c.name] = `error: ${msg}`;
        }
    }
    return { window: { start, end }, results };
}

async function runBackfill(db: any, clients: any[], startedAt: number) {
    const token = lazyGscToken();
    const today = new Date();
    const yesterday = addDaysUTC(today, -1);
    // Inclusive of the current month, so -(16-1).
    const earliestMonth = addMonthsUTC(monthStartUTC(today), -(GSC_MAX_MONTHS - 1));

    const results: Record<string, unknown> = {};
    for (const c of clients) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) { results[c.name] = "deferred — out of time this run"; continue; }

        const st = await loadState(db, c.name, "gsc");
        if (st?.backfill_done) { results[c.name] = "complete"; continue; }

        let cursor = st?.backfill_cursor ? parseISO(st.backfill_cursor) : monthStartUTC(today);
        let monthsDone = 0;

        try {
            while (
                cursor >= earliestMonth &&
                monthsDone < MAX_MONTHS_PER_CLIENT_PER_RUN &&
                Date.now() - startedAt <= TIME_BUDGET_MS
            ) {
                const mStart = cursor;
                let mEnd = monthEndUTC(cursor);
                if (mEnd > yesterday) mEnd = yesterday;

                // Only possible on the 1st of a month, when "yesterday" is still in the
                // previous one. Nothing to fetch — just step the cursor.
                if (mEnd >= mStart) {
                    await syncGscWindow(db, await token(), c, toISO(mStart), toISO(mEnd));
                    monthsDone++;
                }

                cursor = addMonthsUTC(cursor, -1);
                // Saved after every month, not at the end: an invocation killed by the
                // wall clock must never re-fetch months it already wrote.
                await saveState(db, c.name, "gsc", { backfill_cursor: toISO(cursor), last_error: null });
            }

            if (cursor < earliestMonth) {
                await saveState(db, c.name, "gsc", { backfill_done: true, last_error: null });
                results[c.name] = `complete (${monthsDone} month(s) this run)`;
            } else {
                results[c.name] = `${monthsDone} month(s) this run, next ${toISO(cursor)}`;
            }
        } catch (err) {
            const msg = String((err as Error)?.message ?? err);
            console.error(`seo-sync backfill failed for ${c.name}:`, msg);
            await saveState(db, c.name, "gsc", { last_error: msg.slice(0, 500) });
            results[c.name] = `error: ${msg}`;
        }
    }
    return { earliest_month: toISO(earliestMonth), results };
}

// Answers "is this wired up correctly?" at the moment an admin types the property
// string, rather than three days later when a chart is still empty and nobody knows
// whether that means no traffic, a typo, or a missing permission.
// `override` is the property currently typed into the modal, which is the whole point:
// the answer has to be about what the admin is about to save, not what was saved last
// time. Testing the stored value would pass on an old correct property while the new
// typo sat in the box waiting to be saved.
async function runCheck(db: any, clientName: string, override?: string) {
    const { data: c } = await db
        .from("clients")
        .select("name, gsc_property, ga4_property_id, gbp_location_id")
        .eq("name", clientName)
        .maybeSingle();

    const sa = serviceAccountEmail();
    if (!c) return { ok: false, service_account: sa, message: `No client named "${clientName}".` };

    const property = String(override ?? c.gsc_property ?? "").trim();
    if (!property) {
        return { ok: false, service_account: sa, message: "No Search Console property set for this client yet." };
    }

    const token = await getGoogleToken([SCOPES.gsc]);
    const res = await fetch("https://searchconsole.googleapis.com/webmasters/v3/sites", {
        headers: { "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, service_account: sa, message: `Google refused the site list (${res.status}): ${text.slice(0, 200)}` };
    }

    const entries: any[] = (await res.json()).siteEntry ?? [];
    const exact = entries.find((e) => String(e.siteUrl) === property);
    if (exact) {
        return {
            ok: true,
            service_account: sa,
            property,
            permission: exact.permissionLevel,
            message: `Connected — ${exact.permissionLevel} on ${property}.`,
        };
    }

    // The classic mistake is a property string that is nearly right: a missing
    // trailing slash, http for https, or a URL-prefix property typed where the
    // account actually holds a domain property. Naming the close match turns a
    // dead end into a one-click fix.
    const loose = (s: string) => s.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase();
    const near = entries.find((e) => loose(String(e.siteUrl)) === loose(property));
    if (near) {
        return {
            ok: false,
            service_account: sa,
            suggestion: near.siteUrl,
            message: `Not found as typed. This account can read "${near.siteUrl}" — use that exact string.`,
        };
    }

    return {
        ok: false,
        service_account: sa,
        available: entries.slice(0, 25).map((e) => e.siteUrl),
        message: entries.length
            ? `${sa} cannot see "${property}". Add it as a user on that property in Search Console.`
            : `${sa} has not been added to any Search Console property yet.`,
    };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// Same two origins as morning-audit: the GHL-hosted dashboard and the GitHub Pages
// copy. Not access control — curl ignores CORS — just no reason to let an arbitrary
// page drive this from a visitor's browser.
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

// The gateway only proves the caller holds *a* valid project JWT, and the anon key is
// public. For anything that costs Google quota on demand, or reveals which properties
// this account can read, require a real signed-in admin.
async function callerIsAdmin(db: any, req: Request): Promise<boolean> {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return false;
    const { data, error } = await db.auth.getUser(jwt);
    const email = data?.user?.email;
    if (error || !email) return false;   // the anon key parses as a JWT but carries no user
    const { data: profile } = await db
        .from("user_profiles").select("role").eq("email", email).maybeSingle();
    return profile?.role === "admin";
}

Deno.serve(async (req: Request) => {
    const startedAt = Date.now();
    const cors = corsHeaders(req);

    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

    try {
        const body = await req.json().catch(() => ({}));
        const mode = String(body?.mode ?? "daily");
        const force = body?.force === true;
        const only = body?.client ? String(body.client) : undefined;

        const db = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );

        if (mode === "check") {
            if (!await callerIsAdmin(db, req)) {
                return Response.json({ error: "admin sign-in required" }, { status: 403, headers: cors });
            }
            if (!only) return Response.json({ error: "check needs a client" }, { status: 400, headers: cors });
            const override = body?.property ? String(body.property) : undefined;
            return Response.json(await runCheck(db, only, override), { headers: cors });
        }

        // force re-fetches a window that has already run today — cheap, but it spends
        // Google quota on demand, so it is not something the public anon key can do.
        if (force && !await callerIsAdmin(db, req)) {
            return Response.json({ error: "admin sign-in required to force a re-sync" }, { status: 403, headers: cors });
        }

        const clients = await loadSeoClients(db, only);
        if (!clients.length) {
            return Response.json({ mode, results: {}, note: "no active clients have a Search Console property set" }, { headers: cors });
        }

        if (mode === "backfill") {
            return Response.json({ mode, ...await runBackfill(db, clients, startedAt) }, { headers: cors });
        }
        if (mode === "daily") {
            return Response.json({ mode, ...await runDaily(db, clients, force) }, { headers: cors });
        }
        return Response.json({ error: `unknown mode "${mode}"` }, { status: 400, headers: cors });
    } catch (err) {
        console.error("seo-sync failed:", err);
        return Response.json({ error: String((err as Error)?.message ?? err) }, { status: 500, headers: cors });
    }
});
