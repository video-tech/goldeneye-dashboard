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
import {
    AUDIT_CONFIG,
    buildAuditContext,
    computeClientSignal,
    resolveAuditAnchor,
    todayDayNumber,
} from "./engine.js";

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

const PROMPT_INSTRUCTIONS = `
INSTRUCTIONS:
You are a senior media buyer briefing the team on the agency's Meta accounts.

The analysis is already done. Each client sits under a heading that states its verdict,
and that heading is authoritative. Your job is to explain what each one means and what to
do about it — not to reclassify anything, recompute anything, or infer a trend from the
raw numbers. Never move a client into a section its verdict does not put it in.

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

Use this exact structure:
<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
   <div class="bg-red-500/10 p-4 rounded-xl border border-red-500/20">
      <h4 class="text-red-400 font-bold mb-2 uppercase text-[10px] tracking-widest"><i class="fa-solid fa-fire mr-1"></i> Critical Alerts</h4>
      [Clients under CRITICAL and SPEND STOPPED. One sentence each: what happened, in real
      numbers, and the first thing to check. Lead with the biggest spender.]
   </div>
   <div class="bg-green-500/10 p-4 rounded-xl border border-green-500/20">
      <h4 class="text-green-400 font-bold mb-2 uppercase text-[10px] tracking-widest"><i class="fa-solid fa-arrow-trend-up mr-1"></i> Scale Opportunities</h4>
      [Clients under SCALE CANDIDATES, and those under IMPROVING only if you make clear
      their gain came with more budget rather than better efficiency.]
   </div>
   <div class="bg-purple-500/10 p-4 rounded-xl border border-purple-500/20">
      <h4 class="text-purple-400 font-bold mb-2 uppercase text-[10px] tracking-widest"><i class="fa-solid fa-eye mr-1"></i> Account Watchlist</h4>
      [Clients under WATCH. Where the note says CTR is falling, lead with that and say
      the creative needs looking at — those are early warnings worth acting on while CPL
      still looks fine. Then any under DATA STALE or DATA GAPS: say plainly that the pull
      looks broken and the numbers cannot be trusted yet, rather than describing them as
      a performance problem.]
   </div>
</div>

A quiet morning is a real and good result. If a section has no clients, write a single
short line saying so — "Nothing critical today." — and move on. Never pad a section by
promoting a client from a calmer verdict, and never manufacture a concern to fill space.

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
        return `${s.name}: ${cpl}${pct} on $${Math.round(s.recent.spend)} spend${driver}`;
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
        const res = await fetch(ADMIN_ALERT_WEBHOOK, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
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
// public — but there is no reason to let an arbitrary site's JavaScript spend our model
// budget on a visitor's behalf, so the allowed origins are named rather than starred.
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

        const signals = await loadSignals(db);
        const context = buildAuditContext(signals);

        // The dashboard's AI chat wants the matrix without spending a model call on it.
        if (contextOnly) {
            return Response.json({ context, signals }, { headers: cors });
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

        const html = (response.output_text ?? "").trim();
        if (!html) throw new Error("model returned no text");

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
