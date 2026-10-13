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
    buildAuditContext,
    computeClientSignal,
    resolveAuditAnchor,
    todayDayNumber,
} from "./engine.js";
import { adFlagsContext, applyAdsOff, computeAdFlags, renderAdFlagsHtml } from "./ads.js";

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
async function loadAdData(db: any, signals: any[]) {
    const wanted = signals.filter((s) => parseFloat(s.targetCpl) > 0 || s.verdict === "DATA_STALE" || s.verdict === "DATA_GAPS");
    if (!wanted.length) return { rows: [] as any[], cutoff: undefined as string | undefined, syncState: [] as any[] };
    const loaded = await loadAdRows(db, wanted.map((s) => s.name));
    if (!loaded) return null;
    const { data: syncState, error } = await db.from("meta_sync_state").select("client_name, last_run_at, last_error, last_window");
    if (error) console.error("meta_sync_state not read:", error);
    return { rows: loaded.rows, cutoff: loaded.cutoff as string | undefined, syncState: error ? [] : (syncState ?? []) };
}

const PROMPT_INSTRUCTIONS = `
INSTRUCTIONS:
You are a senior media buyer briefing the team on the agency's Meta accounts.

The analysis is already done. Each client sits under a heading that states its verdict,
and that heading is authoritative. Your job is to explain what each one means and what to
do about it — not to reclassify anything, recompute anything, or infer a trend from the
raw numbers. Never give a client a marker color or icon its own verdict does not match.

Only ever mention a client that appears above. You have account-level daily totals and
nothing else: no campaign, ad set, ad, or creative data reaches you. Never name an ad,
never say which creative to pause, and never comment on budget splits inside an account
— you cannot see any of that. What you can do is say where in the funnel the problem is
and therefore where someone should go and look. That is the point of the driver field:
lead with it. "CPL is up 40%, and it is all click-to-lead — check the landing page
before touching the ads" is the shape of a useful line. "CPL is up 40%, review the ads"
is not. Where no driver is given, say the number and say it needs looking into rather
than inventing a cause.

Format your response entirely in ready-to-render HTML. Do NOT use markdown code blocks
like \`\`\`html. Just return the raw HTML string.

Write one short paragraph per client worth mentioning — no grid, no boxes, no columns.
Order them by urgency: CRITICAL and SPEND STOPPED first, then WATCH, then SCALE
CANDIDATES and any IMPROVING client whose gain came with more budget rather than better
efficiency, then ADS OFF, then DATA STALE / DATA GAPS. Skip a client entirely if their verdict is STABLE or INSUFFICIENT_VOLUME with
nothing notable to say — a quiet client gets no paragraph, not a filler sentence.

Every paragraph opens with one marker line naming the client, colored and iconed for its
verdict — exactly one of these five, matched to the client's own heading, never invented
or mixed:

<p><i class="fa-solid fa-fire" style="color:var(--neg);"></i> <strong style="color:var(--neg);">[Client name]</strong> — [sentence]</p>       for CRITICAL / SPEND STOPPED
<p><i class="fa-solid fa-eye" style="color:var(--warn);"></i> <strong style="color:var(--warn);">[Client name]</strong> — [sentence]</p>       for WATCH
<p><i class="fa-solid fa-arrow-trend-up" style="color:var(--pos);"></i> <strong style="color:var(--pos);">[Client name]</strong> — [sentence]</p>   for SCALE CANDIDATE / IMPROVING-on-more-budget
<p><i class="fa-solid fa-plug-circle-exclamation" style="color:var(--t3);"></i> <strong style="color:var(--t3);">[Client name]</strong> — [sentence]</p>  for DATA STALE / DATA GAPS
<p><i class="fa-solid fa-circle-pause" style="color:var(--t3);"></i> <strong style="color:var(--t3);">[Client name]</strong> — [sentence]</p>  for ADS OFF

After the marker, write one to two plain sentences: what happened, in real numbers, and
the first thing to check. Lead with the biggest spender within each verdict group. For a
WATCH client whose note says CTR is falling, lead with that and say the creative needs
looking at — that is an early warning worth acting on while CPL still looks fine. For a
DATA STALE / DATA GAPS client, say plainly that the pull looks broken and the numbers
cannot be trusted yet, rather than describing it as a performance problem. For an ADS OFF
client the opposite is true: say in one sentence that their ads have not spent since the day
the note gives, that Meta confirms it, that nothing is wrong with the data, and that the team
should confirm it is intended. Never call it a broken pull.

A quiet morning is a real and good result. If nothing needs a paragraph, write a single
plain line saying so — "Nothing critical today." — with no icon and no color. Never
promote a client from a calmer verdict to fill space, and never manufacture a concern.

Keep the text tight and direct. Cite the actual figures you were given.`;

async function loadSignals(db: any) {
    const cutoff = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().split("T")[0];

    const [clientsRes, adsRes, healthRes] = await Promise.all([
        db.from("clients").select("name, ad_account_id, status, target_cpl"),
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

    return clients.map((c: any, i: number) => computeClientSignal(c, rowsPerClient[i], anchor, AUDIT_CONFIG));
}

// Text the two admins when the audit finds a CRITICAL account. Built entirely from
// `signals` — never from the model's HTML — for the same reason the dashboard cards
// are: the model is a writer here, not a source of truth, and an SMS is exactly the
// kind of thing that must never carry a hallucinated number. A parsing step over the
// model's prose to find "who's critical" would reintroduce the risk this whole rebuild
// was about removing.
//
// Only CRITICAL fires this, by design — SPEND_STOPPED is a real problem too, but it is
// an operational one (a paused campaign, an expired card) rather than a performance
// one, and folding it in was left for later so a text stays rare enough to open.
// Silent on a quiet morning: no CRITICAL clients means no POST at all.
async function sendCriticalAlert(db: any, signals: any[]) {
    const critical = signals.filter((s) => s.verdict === "CRITICAL");
    if (!critical.length) return;

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
    if (!recipients.length) return;

    const lines = critical.map((s) => {
        const cpl = s.recent.cpl === null ? "no leads" : `$${Math.round(s.recent.cpl)} CPL`;
        const pct = (s.cplDelta === Infinity || s.cplDelta === null)
            ? "" : ` (${s.cplDelta >= 0 ? "+" : ""}${Math.round(s.cplDelta * 100)}%)`;
        const driver = s.drivers?.dominant ? `, ${s.drivers.dominant.toUpperCase()} driven` : "";
        // The percentage is against the target when the client has one, otherwise their
        // own usual, so a text has to say which.
        const vs = s.yardstick ? ` vs $${Math.round(s.yardstick)} ${s.yardstickKind === "target" ? "target" : "usual"}` : "";
        return `${s.name}: ${cpl}${pct}${vs} on $${Math.round(s.recent.spend)} spend${driver}`;
    });

    // No \n here. Make's HTTPS module builds its GHL request body from raw text with
    // {{2.message}} substituted straight in — it does not escape variables dropped into
    // a raw-text field, so a literal newline lands as an unescaped control character
    // inside what has to be valid JSON and breaks the request downstream. A single
    // line sidesteps the whole class of problem rather than asking every future editor
    // of the Make scenario to remember an escapeJSON() wrapper.
    const message = `🚨 Morning Audit — ${critical.length} critical account${critical.length > 1 ? "s" : ""}: `
        + lines.join(" • ")
        + ` • Full audit: https://goldeneye.midasmediafirm.com`;

    // Never let a failed webhook lose the audit card already saved by the caller — log
    // and move on, exactly like the exception block in notify_admins_client_request().
    try {
        // The hook URL is in this public repo, so Make's scenario filters on this secret (see
        // CLAUDE.md, the 2026-09-11 onboarding-text incident). An unset secret still sends,
        // and Make drops it, which is the safe direction for an alert to ourselves.
        const res = await fetch(ADMIN_ALERT_WEBHOOK, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                secret: Deno.env.get("MAKE_WEBHOOK_SECRET") ?? "",
                event: "morning_audit_critical",
                kind: "morning_audit_critical",
                message,
                critical_count: critical.length,
                clients: critical.map((s) => ({
                    name: s.name,
                    spend: Math.round(s.recent.spend),
                    leads: s.recent.leads,
                    expected_leads: s.expectedLeads,
                    cpl: s.recent.cpl,
                    baseline_cpl: s.baseline.cpl,
                    cpl_delta: s.cplDelta === Infinity ? null : s.cplDelta,
                    driver: s.drivers?.dominant ?? null,
                })),
                recipients,
            }),
        });
        if (!res.ok) console.error(`critical alert webhook returned ${res.status}`);
    } catch (err) {
        console.error("critical alert webhook failed:", err);
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

        const signals = await loadSignals(db);
        const adData = await loadAdData(db, signals).catch((err) => {
            console.error("loadAdData failed:", err);
            return null;
        });
        // Where the daily pull has no rows for a client, ask meta-sync whether their ads are simply
        // off. If Meta confirms it, the verdict becomes ADS OFF instead of "the pull looks broken".
        if (adData) applyAdsOff(signals, adData.rows, adData.syncState);
        const context = buildAuditContext(signals);
        // Which individual ads are at or over their client's target CPL. Decided in code (ads.js), then
        // appended to the saved card; the model never sees an ad name or an ad figure.
        const adResult = adData ? computeAdFlags(signals, adData.rows, undefined, adData.cutoff) : null;

        // The dashboard's AI chat wants the matrix without spending a model call on it. It also
        // gets the flagged ads, which the card's model deliberately does not.
        if (contextOnly) {
            return Response.json({ context: context + (adResult ? adFlagsContext(adResult) : ""), signals }, { headers: cors });
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

        // Only for a card actually created just now — the skipped-because-it-already-
        // exists branch above returns before this point, so a retry or a second
        // scheduled attempt never sends a second text for the same morning.
        await sendCriticalAlert(db, signals).catch((err) =>
            console.error("sendCriticalAlert failed:", err));

        return Response.json({
            id: data?.[0]?.id ?? null,
            created_at: data?.[0]?.created_at ?? null,
            clients: signals.length,
            verdicts: signals.reduce((acc: Record<string, number>, s: any) => {
                acc[s.verdict] = (acc[s.verdict] || 0) + 1;
                return acc;
            }, {}),
            usage: response.usage,
            html,
        }, { headers: cors });
    } catch (err) {
        console.error("morning-audit failed:", err);
        return Response.json({ error: String((err as Error)?.message ?? err) }, { status: 500, headers: cors });
    }
});
