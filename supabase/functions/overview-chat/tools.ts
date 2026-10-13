// The lookups the Overview chat may run. Read-only, by construction: every one is a select (or a
// read-only RPC) and there is no tool that writes. They run as the signed-in admin (the caller's own
// JWT), so row-level security applies exactly as it does in the dashboard, and anything not named
// here is simply out of the model's reach.
//
// Deliberately NOT exposed: task notes and check-in replies (staff or client free text), client
// emails and phone numbers, Stripe ids, ad account ids, and any credential. Free text a client typed
// can still reach the model through a task title, so the system prompt tells it to treat tool
// results as data, never instructions.
//
// No imports, so it can be tested against a fake database with no network.

export const MAX_ROWS = 60;
const MAX_SPAN_DAYS = 400;

export const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const lowerKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

export type Ctx = { db: any; today: string; cache: Record<string, unknown> };

// ---------------------------------------------------------------------------------------------
// Dates

const isYmd = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T12:00:00Z"));
export function addDays(ymd: string, n: number): string {
    const d = new Date(ymd + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
const spanDays = (a: string, b: string) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000) + 1;
const mondayOf = (ymd: string) => {
    const d = new Date(ymd + "T12:00:00Z");
    const back = (d.getUTCDay() + 6) % 7;
    return addDays(ymd, -back);
};

// Default window = the last 7 whole days (ending yesterday, since today is still in progress),
// the same convention the dashboard's "last 7 days" uses.
export function dateRange(args: any, today: string): { start: string; end: string } | { error: string } {
    const end = args?.end == null ? addDays(today, -1) : args.end;
    const start = args?.start == null ? addDays(end as string, -6) : args.start;
    if (!isYmd(start) || !isYmd(end)) return { error: "start and end must be dates written YYYY-MM-DD" };
    if (start > end) return { error: "start is after end" };
    if (spanDays(start, end) > MAX_SPAN_DAYS) return { error: `ask for at most ${MAX_SPAN_DAYS} days at a time` };
    return { start, end };
}

// ---------------------------------------------------------------------------------------------
// Database helpers

async function pageAll(build: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>, cap = 20000) {
    const rows: any[] = [];
    for (let at = 0; at < cap; at += 1000) {
        const { data, error } = await build(at, at + 999);
        if (error) throw new Error(error.message ?? String(error));
        rows.push(...(data ?? []));
        if (!data || data.length < 1000) break;
    }
    return rows;
}

async function clientsList(ctx: Ctx): Promise<any[]> {
    if (ctx.cache.clients) return ctx.cache.clients as any[];
    const { data, error } = await ctx.db.from("clients").select(
        "name, status, current_stage, industry, target_cpl, website_status, monthly_retainer, contract_type, payment_status, client_since, ad_account_id, seo_start_date, seo_monthly_fee, gsc_property",
    );
    if (error) throw new Error(error.message);
    ctx.cache.clients = data ?? [];
    return ctx.cache.clients as any[];
}

// An exact name (ignoring case and punctuation) wins; otherwise one unambiguous partial match.
async function findClient(ctx: Ctx, name: unknown): Promise<{ client: any } | { error: string }> {
    const want = norm(name);
    if (!want) return { error: "a client name is required (call list_clients to see them)" };
    const all = await clientsList(ctx);
    const exact = all.filter((c) => norm(c.name) === want);
    if (exact.length === 1) return { client: exact[0] };
    const part = all.filter((c) => norm(c.name).includes(want) || want.includes(norm(c.name)));
    if (part.length === 1) return { client: part[0] };
    if (!part.length) return { error: `no client matches "${name}". Clients: ${all.map((c) => c.name).join(", ")}` };
    return { error: `"${name}" matches several clients: ${part.map((c) => c.name).join(", ")}. Use the full name.` };
}

const cap = <T>(rows: T[], limit = MAX_ROWS) => ({ rows: rows.slice(0, limit), truncated: rows.length > limit ? rows.length - limit : 0 });

// ---------------------------------------------------------------------------------------------
// Tools

async function list_clients(ctx: Ctx, args: any) {
    const all = await clientsList(ctx);
    let svc: any[] = [];
    try {
        const { data } = await ctx.db.from("client_services").select("client_name, service_key, status").neq("status", "ended");
        svc = data ?? [];
    } catch (_) { /* services table missing: carry on without it */ }
    const rows = all
        .filter((c) => args?.include_inactive || String(c.status ?? "active") === "active")
        .map((c) => ({
            name: c.name, status: c.status, stage: c.current_stage, industry: c.industry,
            target_cpl: c.target_cpl, website_status: c.website_status,
            monthly_retainer: c.monthly_retainer, payment_status: c.payment_status, client_since: c.client_since,
            services: svc.filter((s) => s.client_name === c.name).map((s) => `${s.service_key} (${s.status})`),
            has_ad_account: !!digits(c.ad_account_id), has_seo: !!c.gsc_property,
        }));
    return { clients: rows };
}

// The shared Midas/Sunset ad account belongs to Sunset, as everywhere else in Golden Eye.
function accountOwners(clients: any[]) {
    const byId = new Map<string, any>();
    for (const c of clients) {
        const id = digits(c.ad_account_id);
        if (!id) continue;
        const cur = byId.get(id);
        if (!cur || (norm(cur.name).includes("midas") && !norm(c.name).includes("midas"))) byId.set(id, c);
    }
    return byId;
}

async function ad_performance(ctx: Ctx, args: any) {
    const r = dateRange(args, ctx.today);
    if ("error" in r) return r;
    const clients = await clientsList(ctx);
    let only: any = null;
    if (args?.client) {
        const f = await findClient(ctx, args.client);
        if ("error" in f) return f;
        only = f.client;
    }
    const by = args?.by ?? (only ? "week" : "client");
    if (!["client", "day", "week"].includes(by)) return { error: 'by must be "client", "day" or "week"' };

    const raw = await pageAll((a, b) => ctx.db.from("daily_reports").select("*").gte("date", r.start).lte("date", r.end).order("date").range(a, b));
    const owners = accountOwners(clients);
    const rows = raw.map(lowerKeys);
    const buckets = new Map<string, { label: string; spend: number; leads: number; impressions: number; clicks: number; days: Set<string> }>();
    for (const row of rows) {
        const id = digits(row.ad_account_id);
        let owner = id ? owners.get(id) : null;
        if (!owner) {
            const nm = norm(row.account_name);
            owner = nm ? clients.find((c) => nm.includes(norm(c.name)) || norm(c.name).includes(nm)) : null;
        }
        if (!owner || (only && owner.name !== only.name)) continue;
        const day = String(row.date).slice(0, 10);
        const key = by === "client" ? owner.name : by === "week" ? `${only ? "" : owner.name + " "}week of ${mondayOf(day)}` : `${only ? "" : owner.name + " "}${day}`;
        const b = buckets.get(key) ?? { label: key, spend: 0, leads: 0, impressions: 0, clicks: 0, days: new Set<string>() };
        b.spend += num(row.spend); b.leads += num(row.leads); b.impressions += num(row.impressions); b.clicks += num(row.unique_link_clicks);
        b.days.add(day);
        buckets.set(key, b);
    }
    const out = [...buckets.values()].map((b) => ({
        label: b.label, spend: round(b.spend), leads: b.leads, cpl: b.leads > 0 ? round(b.spend / b.leads) : null,
        impressions: b.impressions, link_clicks: b.clicks,
        ctr_pct: b.impressions > 0 ? round((b.clicks / b.impressions) * 100) : null,
        cpm: b.impressions > 0 ? round((b.spend / b.impressions) * 1000) : null,
        days_with_data: b.days.size,
    })).sort((x, y) => by === "client" ? y.spend - x.spend : x.label.localeCompare(y.label));
    const c = cap(out);
    return {
        range: r, grouped_by: by, client: only?.name ?? "all clients", target_cpl: only?.target_cpl ?? null,
        note: "Spend and leads come from the daily Meta pull (daily_reports). cpl is null when there were no leads, never zero. The newest day available is usually yesterday.",
        ...c,
    };
}

async function ad_breakdown(ctx: Ctx, args: any) {
    const r = dateRange(args, ctx.today);
    if ("error" in r) return r;
    const f = await findClient(ctx, args?.client);
    if ("error" in f) return f;
    const raw = await pageAll((a, b) => ctx.db.from("meta_ad_daily").select("date, ad_id, ad_name, adset_name, spend, leads").eq("client_name", f.client.name).gte("date", r.start).lte("date", r.end).order("date").range(a, b));
    const by = new Map<string, any>();
    for (const x of raw) {
        const t = by.get(x.ad_id) ?? { ad: x.ad_name, ad_set: x.adset_name, spend: 0, leads: 0, days: new Set<string>(), last: "" };
        t.spend += num(x.spend); t.leads += num(x.leads); t.ad = x.ad_name || t.ad; t.ad_set = x.adset_name || t.ad_set;
        if (num(x.spend) > 0) { t.days.add(x.date); if (x.date > t.last) t.last = x.date; }
        by.set(x.ad_id, t);
    }
    const ads = [...by.values()].filter((t) => t.spend > 0).sort((a, b) => b.spend - a.spend);
    const total = ads.reduce((n, t) => n + t.spend, 0);
    const target = f.client.target_cpl ? Number(f.client.target_cpl) : null;
    const limit = Math.min(Math.max(Number(args?.limit) || 25, 1), MAX_ROWS);
    return {
        range: r, client: f.client.name, target_cpl: target, total_spend: round(total), ads_with_spend: ads.length,
        note: "Per-ad figures are Meta's own lead counts, which can run higher than the daily pull's. GHL is the source of truth for leads.",
        ads: ads.slice(0, limit).map((t) => ({
            ad: t.ad, ad_set: t.ad_set, spend: round(t.spend), share_of_spend_pct: total > 0 ? round((t.spend / total) * 100, 1) : 0,
            leads: t.leads, cpl: t.leads > 0 ? round(t.spend / t.leads) : null, days_with_spend: t.days.size, last_day_with_spend: t.last,
            at_or_over_target: target ? (t.leads > 0 ? t.spend / t.leads >= target : t.spend >= target) : null,
        })),
        truncated: ads.length > limit ? ads.length - limit : 0,
    };
}

async function ad_changes(ctx: Ctx, args: any) {
    const r = dateRange(args, ctx.today);
    if ("error" in r) return r;
    const f = await findClient(ctx, args?.client);
    if ("error" in f) return f;
    const { data, error } = await ctx.db.from("meta_activity")
        .select("event_time, category, event_label, object_type, object_name, actor_name, actor_is_meta, extra")
        .eq("client_name", f.client.name).eq("significant", true)
        .gte("event_time", r.start + "T00:00:00Z").lt("event_time", addDays(r.end, 1) + "T23:59:59Z")
        .order("event_time", { ascending: false }).limit(MAX_ROWS);
    if (error) throw new Error(error.message);
    return {
        range: r, client: f.client.name,
        note: "Significant changes in Meta's change history, newest first. Times are UTC. object_type ADGROUP is an ad set.",
        changes: (data ?? []).map((a: any) => ({
            when: a.event_time, kind: a.category, what: a.event_label, object_type: a.object_type, object: a.object_name,
            who: a.actor_is_meta ? "Meta's system" : a.actor_name,
            from: typeof a.extra?.old_value === "string" ? a.extra.old_value : undefined,
            to: typeof a.extra?.new_value === "string" ? a.extra.new_value : undefined,
        })),
    };
}

async function tasks(ctx: Ctx, args: any) {
    const rows = await pageAll((a, b) => ctx.db.from("tasks").select("id, title, client, stage, due, status, assignee, type, client_visible, archived_at").is("archived_at", null).range(a, b));
    let list = rows;
    if (args?.client) {
        const f = await findClient(ctx, args.client);
        if ("error" in f) return f;
        list = list.filter((t) => norm(t.client) === norm(f.client.name));
    }
    if (args?.assignee) list = list.filter((t) => norm(t.assignee).includes(norm(args.assignee)));
    if (args?.status) list = list.filter((t) => norm(t.status) === norm(args.status));
    if (!args?.include_complete && !args?.status) list = list.filter((t) => t.status !== "Complete");
    const counts: Record<string, number> = {};
    for (const t of list) counts[t.status ?? "?"] = (counts[t.status ?? "?"] ?? 0) + 1;
    list.sort((a, b) => String(a.due ?? "9999").localeCompare(String(b.due ?? "9999")));
    const limit = Math.min(Math.max(Number(args?.limit) || 40, 1), MAX_ROWS);
    return {
        today: ctx.today, total_matching: list.length, counts_by_status: counts,
        note: "Notes are not shown. A task whose assignee is Client is waiting on the client. due earlier than today and not Complete is late.",
        tasks: list.slice(0, limit).map((t) => ({ title: t.title, client: t.client, stage: t.stage, due: t.due, status: t.status, assignee: t.assignee, type: t.type })),
        truncated: list.length > limit ? list.length - limit : 0,
    };
}

async function checkins(ctx: Ctx, args: any) {
    const f = await findClient(ctx, args?.client);
    if ("error" in f) return f;
    const weeks = Math.min(Math.max(Number(args?.weeks) || 8, 1), 26);
    const raw = await pageAll((a, b) => ctx.db.from("weekly_checkins").select("week_start, estimates_count, closes_count, revenue_total, closes_by_source, source").eq("client_name", f.client.name).order("week_start", { ascending: false }).range(a, b), 3000);
    const by = new Map<string, any>();
    for (const x of raw) {
        const w = by.get(x.week_start) ?? { week_start: x.week_start, reports: 0, estimates: null as number | null, closes: null as number | null, revenue: null as number | null, from_google: { closes: 0, revenue: 0 } };
        w.reports++;
        // null stays null when nobody reported, so "not reported" differs from a reported 0
        if (x.estimates_count != null) w.estimates = (w.estimates ?? 0) + num(x.estimates_count);
        if (x.closes_count != null) w.closes = (w.closes ?? 0) + num(x.closes_count);
        if (x.revenue_total != null) w.revenue = (w.revenue ?? 0) + num(x.revenue_total);
        const g = x.closes_by_source?.google;
        if (g) { w.from_google.closes += num(g.closes); w.from_google.revenue += num(g.revenue); }
        by.set(x.week_start, w);
    }
    return {
        client: f.client.name,
        note: "Reported by the client or logged by our VAs, one row per person summed per week. null means nothing was reported that week, which is not the same as zero. from_google is only filled for weeks with a source breakdown.",
        weeks: [...by.values()].slice(0, weeks),
    };
}

async function leads(ctx: Ctx, args: any) {
    const r = dateRange(args, ctx.today);
    if ("error" in r) return r;
    const f = await findClient(ctx, args?.client);
    if ("error" in f) return f;
    const raw = await pageAll((a, b) => ctx.db.from("lead_sources").select("source, lead_type, is_gbp, created_at").eq("client_name", f.client.name).gte("created_at", r.start + "T00:00:00Z").lt("created_at", addDays(r.end, 1) + "T23:59:59Z").range(a, b));
    const by: Record<string, number> = {}, type: Record<string, number> = {};
    for (const x of raw) { by[x.source] = (by[x.source] ?? 0) + 1; type[x.lead_type ?? "unknown"] = (type[x.lead_type ?? "unknown"] ?? 0) + 1; }
    return {
        range: r, client: f.client.name, website_leads: raw.length, by_source: by, by_type: type, from_google_business_profile: raw.filter((x) => x.is_gbp).length,
        note: "Only website leads that landed on the client's own site, tracked since 2026-09-11. Meta instant-form leads are not here, they are in ad_performance. Earlier dates are not measured, which is not zero.",
    };
}

async function seo_overview(ctx: Ctx, args: any) {
    const r = dateRange(args, ctx.today);
    if ("error" in r) return r;
    const f = await findClient(ctx, args?.client);
    if ("error" in f) return f;
    if (!f.client.gsc_property) return { client: f.client.name, error: "this client has no Search Console property connected, so there is no SEO data" };
    const days = spanDays(r.start, r.end);
    const priorEnd = addDays(r.start, -1), priorStart = addDays(priorEnd, -(days - 1));
    const get = (a: string, b: string) => pageAll((x, y) => ctx.db.from("seo_daily").select("date, clicks, impressions, position").eq("client_name", f.client.name).gte("date", a).lte("date", b).range(x, y), 2000);
    const sum = (rows: any[]) => {
        const clicks = rows.reduce((n, x) => n + num(x.clicks), 0), imps = rows.reduce((n, x) => n + num(x.impressions), 0);
        // impression-weighted, never a flat average of daily positions
        const pos = imps > 0 ? rows.reduce((n, x) => n + num(x.position) * num(x.impressions), 0) / imps : null;
        return { days_with_data: rows.length, clicks, impressions: imps, ctr_pct: imps > 0 ? round((clicks / imps) * 100) : null, avg_position: pos === null ? null : round(pos, 1) };
    };
    const [cur, prev] = await Promise.all([get(r.start, r.end), get(priorStart, priorEnd)]);
    return {
        client: f.client.name, range: r, prior_range: { start: priorStart, end: priorEnd }, this_period: sum(cur), prior_period: sum(prev),
        note: "Search Console, lagging 2 to 3 days, so the newest days may be missing. Under 50 clicks, treat changes as noise. Position is impression-weighted, lower is better.",
    };
}

async function onboarding(ctx: Ctx, args: any) {
    const f = await findClient(ctx, args?.client);
    if ("error" in f) return f;
    const out: any = { client: f.client.name, stage: f.client.current_stage, website_status: f.client.website_status };
    try {
        const { data } = await ctx.db.from("client_services").select("service_key, status, started_at, onboarded_at").eq("client_name", f.client.name);
        out.services = data ?? [];
    } catch (_) { /* optional */ }
    try {
        const { data, error } = await ctx.db.rpc("service_onboarding_status", { p_client: f.client.name });
        if (!error) out.onboarding_status = data;
    } catch (_) { /* optional */ }
    const open = await pageAll((a, b) => ctx.db.from("tasks").select("title, status, assignee, due").eq("client", f.client.name).eq("stage", "Onboarding").is("archived_at", null).range(a, b), 2000);
    out.open_onboarding_tasks = open.filter((t) => t.status !== "Complete").slice(0, MAX_ROWS);
    return out;
}

async function latest_audit(ctx: Ctx, _args: any) {
    const { data, error } = await ctx.db.from("morning_audits").select("created_at, html_body").order("created_at", { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    const row = (data ?? [])[0];
    if (!row) return { error: "no morning audit has been saved yet" };
    const text = String(row.html_body ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    return { saved_at: row.created_at, text: text.slice(0, 6000), truncated: text.length > 6000 };
}

// ---------------------------------------------------------------------------------------------
// What the model is shown

const date = { type: "string", description: "A date written YYYY-MM-DD" };
const client = { type: "string", description: "Client name, as listed by list_clients" };
const window = { start: { ...date, description: "First day, YYYY-MM-DD. Default: 7 days before end" }, end: { ...date, description: "Last day, YYYY-MM-DD. Default: yesterday" } };

export const TOOL_DEFS = [
    { name: "list_clients", description: "Every client with status, lifecycle stage, industry, target CPL, services, retainer and payment status. Start here to learn names and who is active.", parameters: { type: "object", properties: { include_inactive: { type: "boolean" } }, additionalProperties: false } },
    { name: "ad_performance", description: "Meta ad spend, leads, CPL, CTR and CPM from the daily pull, for one client or all, grouped by client, week or day.", parameters: { type: "object", properties: { client: { ...client, description: "Omit for all clients" }, ...window, by: { type: "string", enum: ["client", "week", "day"] } }, additionalProperties: false } },
    { name: "ad_breakdown", description: "Each individual ad for one client: spend, share of spend, leads, CPL and whether it is at or over the client's target CPL.", parameters: { type: "object", properties: { client, ...window, limit: { type: "integer" } }, required: ["client"], additionalProperties: false } },
    { name: "ad_changes", description: "What changed in a client's Meta ad account (turned on or off, budget, targeting, creative, new ads) and who did it.", parameters: { type: "object", properties: { client, ...window }, required: ["client"], additionalProperties: false } },
    { name: "tasks", description: "Open tasks (excluding archived), optionally for one client, assignee or status. Shows title, stage, due date, status, assignee. Never shows notes.", parameters: { type: "object", properties: { client, assignee: { type: "string" }, status: { type: "string", enum: ["Not Started", "In Progress", "Blocked", "Complete"] }, include_complete: { type: "boolean" }, limit: { type: "integer" } }, additionalProperties: false } },
    { name: "checkins", description: "A client's weekly check-ins: estimates sent, jobs closed and revenue per week, including what came from Google.", parameters: { type: "object", properties: { client, weeks: { type: "integer" } }, required: ["client"], additionalProperties: false } },
    { name: "leads", description: "Website leads tracked for a client, by source (organic, paid, social, referral, direct) and type.", parameters: { type: "object", properties: { client, ...window }, required: ["client"], additionalProperties: false } },
    { name: "seo_overview", description: "Organic search for a client: clicks, impressions and average position this period against the period before.", parameters: { type: "object", properties: { client, ...window }, required: ["client"], additionalProperties: false } },
    { name: "onboarding", description: "Where a client is in onboarding: stage, services, per-service status and open onboarding tasks.", parameters: { type: "object", properties: { client }, required: ["client"], additionalProperties: false } },
    { name: "latest_audit", description: "The text of the most recent morning audit card (verdicts per client and what to look at).", parameters: { type: "object", properties: {}, additionalProperties: false } },
] as const;

const RUNNERS: Record<string, (ctx: Ctx, args: any) => Promise<unknown>> = {
    list_clients, ad_performance, ad_breakdown, ad_changes, tasks, checkins, leads, seo_overview, onboarding, latest_audit,
};

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name) as string[];

// Never throws: a failed lookup comes back as { error } so the model can say so instead of the whole
// chat failing. An unknown tool name is refused.
export async function runTool(name: string, rawArgs: unknown, ctx: Ctx): Promise<unknown> {
    const run = RUNNERS[name];
    if (!run) return { error: `unknown tool "${name}"` };
    let args: any = {};
    try { args = typeof rawArgs === "string" && rawArgs ? JSON.parse(rawArgs) : (rawArgs ?? {}); } catch { return { error: "the arguments were not valid JSON" }; }
    if (args === null || typeof args !== "object" || Array.isArray(args)) return { error: "the arguments must be an object" };
    try { return await run(ctx, args); } catch (e) { return { error: String((e as Error)?.message ?? e) }; }
}
