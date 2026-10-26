// Morning audit — runs unattended from pg_cron each weekday, and on demand from the
// dashboard button. Everything the browser used to do now happens here: read the rows,
// compute the verdicts, ask the model to write them up, save the card.
//
// The verdicts are still decided in JavaScript, never by the model (see engine.js).
// The model explains and prioritises what the engine already concluded.
//
// Deploy:  supabase functions deploy morning-audit
// Secrets: OPENAI_API_KEY — likely already set project-wide for the ai-chat function,
//          in which case there is nothing to add. Check Dashboard -> Edge Functions ->
//          Secrets. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected for us.

import OpenAI from "npm:openai";
import { createClient } from "npm:@supabase/supabase-js@2";
import { adminCheck, cronCheck } from "../_shared/admin-auth.ts";
import {
    AUDIT_CONFIG,
    DRIVER_MEANING,
    buildAuditContext,
    computeClientSignal,
    resolveAuditAnchor,
    todayDayNumber,
} from "./engine.js";
import { adFlagsContext, applyAdsOff, computeAdFlags, renderAdFlagsHtml } from "./ads.js";
import { buildDayContext, computeDayRead, redAlertLine } from "./daily.js";
import { adDataMissing, decideRun, denverNow, steadyMissing } from "./readiness.js";
import { renderAuditEmail, sendViaResend } from "./email.js";

// Enough history for the 28-day baseline plus the 7-day window, with room to spare so
// a few missing days never shorten the baseline.
const HISTORY_DAYS = 45;

// Meta renames ad accounts freely, so daily_reports joins to clients on the account id
// and falls back to the name only for rows predating the backfill. Mirrors app.js.
const normalize = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const normalizeAccountId = (v: unknown) => String(v ?? "").replace(/\D/g, "");

// Same webhook and recipient shape as notify_admins_client_request() in Postgres
// (see CLAUDE.md, Database objects), so whatever Make scenario handles that trigger's
// SMS sending also handles this one — a Router on `event` is the only thing Make needs
// to add. Deliberately duplicated here rather than shared: this fires from Deno, that
// trigger fires from a Postgres function, and there is no code path connecting the two
// runtimes worth building for one constant and one query.
const ADMIN_ALERT_WEBHOOK = "https://hook.us2.make.com/c8l92w09rw5jrncifjxif0b8r1yf89ha";

function reportsForClient(client: any, rows: any[]) {
    const wantId = normalizeAccountId(client.ad_account_id);
    const wantName = normalize(client.name);
    if (!wantId && !wantName) return [];
    return rows.filter((r) => {
        const rowId = normalizeAccountId(r.ad_account_id);
        if (rowId && wantId) return rowId === wantId;
        const a = normalize(r.account_name);
        if (!a || !wantName) return false;
        return a === wantName || a.includes(wantName) || wantName.includes(a);
    });
}

// Per-ad rows from meta-sync (meta_ad_daily) for the clients that have a target CPL, over the same
// history the audit reads. Paged, because PostgREST caps one response at 1000 rows and a busy
// account has more than that in 45 days. Returns null instead of throwing: the ad section is an
// extra, and a missing table (meta-sync's schema.sql not run yet) or a database hiccup must never
// cost the day's audit card.
async function loadAdRows(db: any, names: string[]) {
    const cutoff = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().split("T")[0];
    const rows: any[] = [];
    try {
        for (const name of names) {
            for (let from = 0; ; from += 1000) {
                const { data, error } = await db
                    .from("meta_ad_daily")
                    .select("client_name, ad_account_id, date, ad_id, ad_name, adset_name, campaign_name, spend, leads")
                    .eq("client_name", name)
                    .gte("date", cutoff)
                    .order("date", { ascending: true })
                    .order("ad_id", { ascending: true })
                    .range(from, from + 999);
                if (error) throw error;
                rows.push(...(data ?? []));
                if (!data || data.length < 1000) break;
            }
        }
    } catch (err) {
        console.error("meta_ad_daily not read, skipping the ads section:", err);
        return null;
    }
    return { rows, cutoff };
}

// Everything meta-sync knows that the audit uses: per-ad rows (for the ads section, and to tell "ads
// are off" from "the pull is broken") and each client's sync state. Wanted for clients with a target
// CPL and for any whose daily-pull data looks missing. Null when meta-sync's tables cannot be read.
async function loadAdData(db: any, signals: any[], spentYesterday: string[] = []) {
    const spent = new Set(spentYesterday);
    const wanted = signals.filter((s) => spent.has(s.name) || parseFloat(s.targetCpl) > 0 || s.verdict === "DATA_STALE" || s.verdict === "DATA_GAPS");
    if (!wanted.length) return { rows: [] as any[], cutoff: undefined as string | undefined, syncState: [] as any[] };
    const loaded = await loadAdRows(db, wanted.map((s) => s.name));
    if (!loaded) return null;
    const { data: syncState, error } = await db.from("meta_sync_state").select("client_name, last_run_at, last_error, last_window");
    if (error) console.error("meta_sync_state not read:", error);
    return { rows: loaded.rows, cutoff: loaded.cutoff as string | undefined, syncState: error ? [] : (syncState ?? []) };
}

// The audit reports on YESTERDAY (2026-10-23): who is red alert, and why. The ads to turn off are
// listed by code under the card (ads.js), so the model never names an ad.
const PROMPT_INSTRUCTIONS = `
INSTRUCTIONS:
You are a senior media buyer writing the agency's morning audit. It is read once a day, and its job
is to say what happened YESTERDAY: which clients are red alert and why. The ads to turn off are listed
separately, below what you write, by the system. Do not list ads.

Two blocks of facts sit above. The first (AUDIT DAY) is the day read: each client's verdict for
yesterday, under a heading that is authoritative. The second (THE LAST 7 DAYS) is the trend: the
7-day verdict, the CPL driver and the creative flag. Use it only to say whether a red alert is a bad
day or a bad week, and where to look. Never reclassify a client, recompute a figure, or give a client
a marker its own day verdict does not match.

Only ever mention a client that appears above. You have account-level daily totals: no campaign, ad
set, ad or creative names reach you, so never name an ad or say which creative to pause.

Format your response entirely in ready-to-render HTML. Do NOT use markdown code blocks like
\`\`\`html. Just return the raw HTML string. No grid, no boxes, no columns.

1. RED ALERT clients first, biggest spend first. One paragraph each, opening with this marker:
<p><i class="fa-solid fa-fire" style="color:var(--neg);"></i> <strong style="color:var(--neg);">[Client name]</strong> — [sentences]</p>
Then one or two plain sentences: what yesterday cost (spend, leads, CPL against the target or usual
CPL, exactly as given), how that compares with their 7 and 30-day CPL, and whether the last 7 days
agree (their 7-day trend). If a driver is given, use it to say where to look: CPM means auction or
targeting, CTR means creative or a saturated audience, CVR means the landing page or form rather than
the ads. A red alert whose reason is "the last 7 days are still critical" had an acceptable day: say so,
and that the week is still the problem.

2. Then ONE line for the clients ON TARGET yesterday:
<p><i class="fa-solid fa-circle-check" style="color:var(--pos);"></i> <strong style="color:var(--pos);">On target</strong> — [Client $CPL, Client $CPL, ...]</p>
If one of them has a 7-day WATCH trend or a falling CTR, add a short clause for it in that same line.

3. Then ONE muted line for everyone else (too little to judge, no yardstick, no spend), with the reason
given for each, short:
<p><i class="fa-solid fa-circle-minus" style="color:var(--t3);"></i> <strong style="color:var(--t3);">Nothing to judge</strong> — [Client: reason; Client: reason]</p>
A client with no spend because the daily pull has no row, or the data is stale or gappy, is a data
problem: say the daily pull should be checked. A client whose ads are off (Meta confirms it) is not a
data problem: say the ads are off and the team should confirm it's intended.

Leave out any of the three parts that has nobody in it. If nobody is red alert, the first line is a plain
"Nothing red yesterday." with no icon and no color. Never promote a client to fill space, never invent a
concern. Keep it tight and cite the figures you were given.`;
async function loadSignals(db: any) {
    const cutoff = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().split("T")[0];

    const [clientsRes, adsRes, healthRes] = await Promise.all([
        db.from("clients").select("name, ad_account_id, business_id, status, target_cpl"),
        // Deliberately `*` rather than a column list. daily_reports carries Google
        // Sheets header casing — the lead count is `"Leads"`, a quoted and therefore
        // case-sensitive identifier, because Make built the table from a sheet. Naming
        // columns explicitly turns that into a hard 400; `*` plus the lowercasing below
        // mirrors what app.js already does to the same rows.
        db.from("daily_reports").select("*").gte("date", cutoff),
        db.from("client_health").select("client_name, current_score"),
    ]);

    for (const [label, res] of [["clients", clientsRes], ["daily_reports", adsRes], ["client_health", healthRes]] as const) {
        if (res.error) throw new Error(`${label}: ${res.error.message}`);
    }

    const health: Record<string, number> = {};
    (healthRes.data ?? []).forEach((h: any) => {
        if (h.client_name) health[normalize(h.client_name)] = h.current_score;
    });

    const clients = (clientsRes.data ?? [])
        .filter((c: any) => (c.status || "active") === "active" && normalize(c.name) !== normalize("Midas Media"))
        .map((c: any) => ({ ...c, current_score: health[normalize(c.name)] || 0 }));

    // Lowercase every key, exactly as app.js does when it fills globalAdsData. The
    // engine is shared by both callers, so it must see one row shape regardless of
    // which one loaded it — and this also absorbs any future column that arrives from
    // a sheet with capitals on it.
    const rows = (adsRes.data ?? []).map((r: Record<string, unknown>) => {
        const out: Record<string, unknown> = {};
        for (const k in r) out[k.toLowerCase().trim()] = r[k];
        return out;
    });

    const rowsPerClient = clients.map((c: any) => reportsForClient(c, rows));
    const anchor = resolveAuditAnchor(rowsPerClient, todayDayNumber(), AUDIT_CONFIG);

    const signals = clients.map((c: any, i: number) => computeClientSignal(c, rowsPerClient[i], anchor, AUDIT_CONFIG));
    // Every client row (not only active ones) and the lowercased rows go back too: the scheduled run's
    // readiness check (readiness.js) uses the Make pull's own client filter, not the audit's.
    // rowsPerClient lines up with signals, for the day read (daily.js).
    return { signals, rowsPerClient, allClients: clientsRes.data ?? [], rows };
}

// Names of the audit's clients with spend on `day` in the daily pull.
function spentOn(signals: any[], rowsPerClient: any[][], day: string) {
    return signals.filter((_s, i) => rowsPerClient[i].some((r: any) => String(r.date ?? "").slice(0, 10) === day && parseFloat(r.spend) > 0)).map((s) => s.name);
}

// For the wait: which clients have meta_ad_daily rows for `day`, and meta-sync's state. Null when either
// can't be read, and then the audit doesn't wait on ad data (the ads section says what's missing).
async function loadAdReadiness(db: any, day: string) {
    try {
        const names = new Set<string>();
        for (let from = 0; ; from += 1000) {
            const { data, error } = await db.from("meta_ad_daily").select("client_name").eq("date", day).range(from, from + 999);
            if (error) throw error;
            (data ?? []).forEach((r: any) => names.add(r.client_name));
            if (!data || data.length < 1000) break;
        }
        const { data: syncState, error } = await db.from("meta_sync_state").select("client_name, last_window");
        if (error) throw error;
        return { withAdRows: [...names], syncState: syncState ?? [] };
    } catch (err) {
        console.error("ad readiness not read, not waiting on ad data:", err);
        return null;
    }
}

// The audit email (email.js): the card plus every client's yesterday and context, to AUDIT_EMAIL_TO
// through Resend. Never throws; the result goes in the log and the response.
async function sendAuditEmail(html: string, dayReads: any[], signals: any[], adResult: any, missing: string[], deadline: boolean, adMissing: string[] = []) {
    const now = new Date();
    const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short", month: "short", day: "numeric" }).format(now);
    const mail = renderAuditEmail({ html, dayReads, signals, adResult, missing, adMissing, deadline, dateLabel });
    const res = await sendViaResend({
        apiKey: (Deno.env.get("RESEND_API_KEY") ?? "").trim(),
        to: Deno.env.get("AUDIT_EMAIL_TO") ?? "",
        ...mail,
    });
    if (res.sent) console.log(`morning-audit email sent to ${res.to.join(", ")}`);
    else console.warn(`morning-audit email not sent: ${res.reason}`);
    return res;
}

// Text the admins when a client is RED ALERT yesterday (2026-10-23; before that, a 7-day CRITICAL). Built
// entirely from the day reads, never from the model's HTML: a text must never carry a hallucinated number.
// One line per red-alert client, then how many ads to turn off. Silent when nobody is red. Sent with the
// scheduled card only, so it goes out once a morning; the dashboard's Run audit button never texts.
// (The payload keeps event "morning_audit_critical": Make scenario #6 routes on it.)
async function sendRedAlert(db: any, dayReads: any[], adResult: any) {
    const red = dayReads.filter((r) => r.verdict === "RED_ALERT").sort((a, b) => b.spend - a.spend);
    if (!red.length) return { sent: false, reason: "nobody red" };

    const { data: recipientRows, error: recErr } = await db
        .from("admin_alert_recipients")
        .select("name, phone")
        .eq("active", true);
    if (recErr) throw recErr;

    // Same normalization as notify_admins_client_request(): strip to digits, take the
    // last 10, prefix +1. Anything that still isn't 10 digits after that is dropped
    // rather than sent to GHL malformed.
    const recipients = (recipientRows ?? [])
        .map((r: any) => ({ name: r.name, phone: "+1" + String(r.phone ?? "").replace(/\D/g, "").slice(-10) }))
        .filter((r: any) => r.phone.length === 12);
    if (!recipients.length) return { sent: false, reason: "no recipients" };

    const turnOff = (adResult?.flags ?? []).filter((f: any) => f.action === "TURN_OFF").length;
    // No \n anywhere: Make's HTTPS module builds the GHL request from raw text with {{2.message}}
    // substituted straight in, so a newline would break the JSON (see CLAUDE.md, Gotchas).
    const message = `🚨 Morning audit, ${red[0].day}: ${red.length} red alert${red.length > 1 ? "s" : ""}: `
        + red.map(redAlertLine).join(" • ")
        + (turnOff ? ` • ${turnOff} ad${turnOff > 1 ? "s" : ""} to turn off` : "")
        + ` • Full audit: https://goldeneye.midasmediafirm.com`;

    // Never let a failed webhook lose the audit card already saved by the caller.
    try {
        // The hook URL is in this public repo, so Make's scenario filters on this secret.
        const res = await fetch(ADMIN_ALERT_WEBHOOK, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                secret: Deno.env.get("MAKE_WEBHOOK_SECRET") ?? "",
                event: "morning_audit_critical",
                kind: "morning_audit_critical",
                message,
                critical_count: red.length,
                ads_to_turn_off: turnOff,
                clients: red.map((r) => ({
                    name: r.name,
                    day: r.day,
                    spend: Math.round(r.spend),
                    leads: r.leads,
                    cpl: r.cpl,
                    yardstick: r.yardstick,
                    yardstick_kind: r.yardstickKind,
                    reason: r.reason,
                })),
                recipients,
            }),
        });
        if (!res.ok) { console.error(`red alert webhook returned ${res.status}`); return { sent: false, reason: `webhook ${res.status}` }; }
        return { sent: true, clients: red.length };
    } catch (err) {
        console.error("red alert webhook failed:", err);
        return { sent: false, reason: String((err as Error)?.message ?? err) };
    }
}

// The dashboard is served from GoHighLevel's domain and the PWA copy from GitHub
// Pages, so the browser sends a preflight before every POST and refuses the real
// request unless it comes back approved.
//
// This is not an access control — curl ignores CORS entirely, and the anon key is
// public. The access control is the caller check at the top of the handler
// (_shared/admin-auth.ts); CORS only stops an arbitrary site's JavaScript from reading
// the response in a visitor's browser.
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
        // The response varies by request origin, so caches must not serve one origin's
        // approval to another.
        "Vary": "Origin",
    };
}

Deno.serve(async (req: Request) => {
    const cors = corsHeaders(req);

    // Preflight carries no Authorization header and no body — answer it and stop.
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: cors });
    }

    try {
        const body = await req.json().catch(() => ({}));
        const force = body?.force === true;
        const contextOnly = body?.mode === "context";
        const emailTest = body?.mode === "email_test";

        const db = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );

        // Who's asking, decided before any client data is read. Until 2026-09-16 this checked
        // nothing: the public anon key was enough to get every client's spend, leads and verdict
        // (`mode: "context"`), or to force a gpt-5.6-sol run that can text the admins.
        //   - A signed-in admin can do everything: the dashboard button (force) and the chat (context).
        //   - pg_cron proves itself with x-cron-secret (MAKE_WEBHOOK_SECRET, the same value as the
        //     Vault secret the job reads), and only gets the normal idempotent daily run.
        //   - Anyone else is refused, with the reason in the log.
        const fromCron = cronCheck(req, Deno.env.get("MAKE_WEBHOOK_SECRET"));
        if (fromCron) {
            // email_test is allowed: it only re-sends today's saved card to AUDIT_EMAIL_TO, with no model call,
            // so the email can be checked from the SQL Editor.
            if (force || contextOnly) {
                console.warn("morning-audit REFUSED: cron secret used for", force ? "force" : "context");
                return Response.json({ error: "The schedule can only run the daily audit." }, { status: 403, headers: cors });
            }
        } else {
            const who = await adminCheck(db, req);
            if (!who.ok) {
                console.warn("morning-audit REFUSED:", who.reason);
                return Response.json({ error: who.reason }, { status: 403, headers: cors });
            }
        }

        // The scheduled run checks for today's card before reading anything else: from 9:00 Mountain it is
        // called every 15 minutes, and once the card exists the rest of the morning's calls are no-ops.
        if (fromCron && !force && !emailTest) {
            const since = new Date(); since.setHours(0, 0, 0, 0);
            const { data: done } = await db.from("morning_audits").select("id").gte("created_at", since.toISOString()).limit(1);
            if (done?.length) return Response.json({ skipped: "an audit already exists for today", id: done[0].id }, { headers: cors });
        }

        const { signals, rowsPerClient, allClients, rows: reportRows } = await loadSignals(db);
        // The day the audit reports on: the engine's anchor, which is yesterday once the pull is in
        const auditDay: string = signals[0]?.window?.recentTo ?? denverNow(new Date()).yesterday;

        // Wait for the data (2026-10-23). Facebook publishes some accounts' yesterday as late as 9:30
        // Mountain, so the schedule runs as soon as every steady spender has yesterday's row, and every
        // meta-sync client that spent yesterday has yesterday's ad rows, or at 10:00 Mountain regardless.
        // Only the schedule waits; the dashboard button and the chat never do.
        let gate: { missing: string[]; adMissing: string[]; deadline: boolean } | null = null;
        if (fromCron && !emailTest) {
            const now = denverNow(new Date());
            const missing = steadyMissing(allClients, reportRows, now.yesterday);
            const adReady = await loadAdReadiness(db, now.yesterday);
            const adMissing = adReady
                ? adDataMissing({ spentYesterday: spentOn(signals, rowsPerClient, now.yesterday), ...adReady })
                : [];
            const decision = decideRun({ minutes: now.minutes, ready: missing.length === 0 && adMissing.length === 0 });
            if (!decision.run) {
                return Response.json({ waiting: decision.reason, missing, ad_data_missing: adMissing, denver_time: now.label }, { headers: cors });
            }
            gate = { missing, adMissing, deadline: !!decision.deadline };
        }

        const spentYesterday = spentOn(signals, rowsPerClient, auditDay);
        const adData = await loadAdData(db, signals, spentYesterday).catch((err) => {
            console.error("loadAdData failed:", err);
            return null;
        });
        // Where the daily pull has no rows for a client, ask meta-sync whether their ads are simply
        // off. If Meta confirms it, the verdict becomes ADS OFF instead of "the pull looks broken".
        if (adData) applyAdsOff(signals, adData.rows, adData.syncState);
        // Yesterday, per client (daily.js): the headline. The 7-day signals are the trend under it.
        const dayReads = signals.map((s: any, i: number) => computeDayRead(s, rowsPerClient[i]));
        const readByName = new Map(dayReads.map((r: any) => [r.name, r]));
        const context = buildDayContext(dayReads, signals, DRIVER_MEANING)
            + "\n=== THE LAST 7 DAYS: the trend behind each client, for context ===\n"
            + buildAuditContext(signals);
        // The ads to turn off: any ad at or over the yardstick yesterday, decided in code (ads.js) and
        // appended to the saved card; the model never sees an ad name or an ad figure. Clients with no
        // target are judged against their own 30-day CPL, the same yardstick as their day read.
        const adResult = adData
            ? computeAdFlags(signals.filter((s: any) => spentYesterday.includes(s.name)), adData.rows, undefined, adData.cutoff, {
                day: auditDay,
                yardstick: (s: any) => ({ value: readByName.get(s.name)?.yardstick ?? null }),
            })
            : null;

        // A check of the email (an admin, or the SQL Editor with the cron secret): today's saved card, re-sent
        // with today's figures to AUDIT_EMAIL_TO. No model call, no text.
        if (emailTest) {
            const since = new Date(); since.setHours(0, 0, 0, 0);
            const { data: card } = await db.from("morning_audits").select("html_body, created_at")
                .gte("created_at", since.toISOString()).order("created_at", { ascending: false }).limit(1);
            if (!card?.length) return Response.json({ error: "No audit card yet today. Run the audit first." }, { status: 400, headers: cors });
            const missing = steadyMissing(allClients, reportRows, denverNow(new Date()).yesterday);
            const result = await sendAuditEmail(card[0].html_body, dayReads, signals, adResult, missing, false);
            return Response.json({ email: result }, { headers: cors });
        }

        // The dashboard's AI chat wants the matrix without spending a model call on it. It also
        // gets the ads to turn off, which the card's model deliberately does not.
        if (contextOnly) {
            return Response.json({ context: context + (adResult ? adFlagsContext(adResult) : ""), signals, dayReads }, { headers: cors });
        }

        // Idempotent by default: cron fires once, but a retry, a manual click, or a
        // second scheduled attempt after a failed pull must not stack up duplicate
        // cards for the same day.
        if (!force) {
            const since = new Date(); since.setHours(0, 0, 0, 0);
            const { data: existing } = await db
                .from("morning_audits")
                .select("id, created_at, html_body")
                .gte("created_at", since.toISOString())
                .order("created_at", { ascending: false })
                .limit(1);
            if (existing?.length) {
                // Hand back the card we already have rather than nothing, so a caller
                // that skipped still has something to render.
                return Response.json({
                    skipped: "an audit already exists for today",
                    id: existing[0].id,
                    created_at: existing[0].created_at,
                    html: existing[0].html_body,
                }, { headers: cors });
            }
        }

        const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY")! });

        // The Responses API rather than Chat Completions — it is what OpenAI documents
        // for the reasoning models, and Chat Completions cannot combine reasoning with
        // tools should this ever grow any.
        const response = await openai.responses.create({
            model: "gpt-5.6-sol",
            input: `${context}\n${PROMPT_INSTRUCTIONS}`,
            // The engine has already made every judgment call, so this is interpretation
            // and prose rather than reasoning. "medium" buys careful handling of a prompt
            // carrying a lot of simultaneous constraints — do not reclassify, lead with
            // the driver, leave a section empty when the morning is genuinely quiet —
            // without paying for deep thought it cannot use. "low" is the cheaper dial,
            // "high" the more thorough one. Reasoning tokens bill as output, which is
            // where raising it shows up.
            reasoning: { effort: "medium" },
            max_output_tokens: 8000,
        });

        // Reasoning burns output tokens, so a truncated response is the failure worth
        // naming precisely — it looks identical to a model that just stopped talking.
        if (response.status === "incomplete") {
            throw new Error(`model stopped early: ${response.incomplete_details?.reason ?? "unknown"}`);
        }

        const written = (response.output_text ?? "").trim();
        if (!written) throw new Error("model returned no text");
        // The per-ad section is built in code and appended, so its figures can never be reworded.
        const html = written + (adResult ? "\n" + renderAdFlagsHtml(adResult) : "");

        const { data, error } = await db
            .from("morning_audits")
            .insert([{ html_body: html }])
            .select();
        if (error) throw error;

        // The red-alert text and the morning email go out with the scheduled card only, which is made once
        // a morning (the skip above returns before this point). The dashboard's Run audit button (force)
        // makes a new card without texting or emailing anyone a second time.
        const text = gate ? await sendRedAlert(db, dayReads, adResult).catch((err) => {
            console.error("sendRedAlert failed:", err);
            return { sent: false, reason: String((err as Error)?.message ?? err) };
        }) : null;
        const email = gate ? await sendAuditEmail(html, dayReads, signals, adResult, gate.missing, gate.deadline, gate.adMissing) : null;

        const count = (list: any[]) => list.reduce((acc: Record<string, number>, x: any) => {
            acc[x.verdict] = (acc[x.verdict] || 0) + 1;
            return acc;
        }, {});
        return Response.json({
            id: data?.[0]?.id ?? null,
            created_at: data?.[0]?.created_at ?? null,
            day: auditDay,
            clients: signals.length,
            yesterday: count(dayReads),
            verdicts: count(signals),
            ads_to_turn_off: (adResult?.flags ?? []).filter((f: any) => f.action === "TURN_OFF").length,
            usage: response.usage,
            ...(gate ? { ran: gate.deadline ? "deadline" : "ready", missing: gate.missing, ad_data_missing: gate.adMissing, text, email } : {}),
            html,
        }, { headers: cors });
    } catch (err) {
        console.error("morning-audit failed:", err);
        return Response.json({ error: String((err as Error)?.message ?? err) }, { status: 500, headers: cors });
    }
});
