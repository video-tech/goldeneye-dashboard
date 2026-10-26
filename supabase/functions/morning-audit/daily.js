// The day read (2026-10-23): what each client's ads did YESTERDAY, judged against their target.
// The morning audit is read once a day, so its headline is the day before: who is red alert and
// which ads to turn off. The 7/28-day engine (engine.js) still runs and becomes the trend line
// beside each client ("a bad day, or a bad week?"). Plain, dependency-free JS so it runs in node.
//
// The rule, Tenny's choice on 2026-10-23:
//   RED ALERT   yesterday's CPL at or over the yardstick, or no leads on at least a yardstick's
//               worth of spend. A 7-day CRITICAL also stays red on a day that spent.
//   ON TARGET   leads yesterday, CPL under the yardstick.
//   TOO LITTLE  spent less than one yardstick with no leads: it couldn't have hit the target yet.
//   NO SPEND    nothing spent yesterday (the 7-day verdict says why when it can).
//   NO YARDSTICK spent, but there's no target and no 30-day CPL to judge against.
// The yardstick is clients.target_cpl, or the client's own CPL over the 30 days before yesterday.
// Leads are the daily pull's (Make), the same count everything else in the audit uses.

export const DAY_CONFIG = {
    contextDays: [7, 14, 30],
    // The yardstick when there's no target: own CPL over this many days before yesterday
    usualDays: 30,
};

export const DAY_ORDER = ["RED_ALERT", "ON_TARGET", "TOO_LITTLE", "NO_YARDSTICK", "NO_SPEND"];

const DAY_LABEL = {
    RED_ALERT: "RED ALERT — yesterday at or over target: CPL at or over the yardstick, or no leads on at least a yardstick's worth of spend (or the last 7 days are still critical)",
    ON_TARGET: "ON TARGET — leads yesterday, CPL under the yardstick",
    TOO_LITTLE: "TOO LITTLE TO JUDGE — spent less than one yardstick with no leads yet, so it can't have missed the target",
    NO_YARDSTICK: "NO YARDSTICK — spent yesterday, but there's no target CPL and no leads in the last 30 days to compare with",
    NO_SPEND: "NO SPEND YESTERDAY",
};

const toDay = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
    return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : null;
};
const isoOf = (d) => new Date(d * 86400000).toISOString().slice(0, 10);

function sumDays(rows, from, to) {
    let spend = 0, leads = 0;
    const seen = new Set();
    for (const r of rows || []) {
        const d = toDay(r.date);
        if (d === null || d < from || d > to) continue;
        seen.add(d);
        spend += parseFloat(r.spend) || 0;
        leads += parseInt(r.leads) || 0;
    }
    return { spend, leads, days: seen.size, cpl: leads > 0 ? spend / leads : null };
}

// signal: the engine's 7-day signal for the client (name, targetCpl, verdict, window.recentTo = the
// audit's day). rows: the client's daily_reports rows, keys lowercased. Returns the day read.
export function computeDayRead(signal, rows, cfg = DAY_CONFIG) {
    const day = toDay(signal?.window?.recentTo);
    if (day === null) throw new Error(`no audit day for ${signal?.name}`);
    const y = sumDays(rows, day, day);
    const context = {};
    for (const n of cfg.contextDays) {
        const s = sumDays(rows, day - n, day - 1);
        context[n] = { ...s, perDay: s.spend / n };
    }
    const usual = context[cfg.usualDays] ?? sumDays(rows, day - cfg.usualDays, day - 1);
    const target = parseFloat(signal.targetCpl) > 0 ? parseFloat(signal.targetCpl) : null;
    const yardstick = target ?? usual.cpl;
    const yardstickKind = target ? "target" : (usual.cpl !== null ? "usual" : null);

    const read = {
        name: signal.name,
        day: isoOf(day),
        spend: y.spend, leads: y.leads, cpl: y.cpl, hasRow: y.days > 0,
        target, yardstick, yardstickKind,
        context,
        trend: signal.verdict,
        verdict: null, reason: null, notes: [],
    };

    if (!(y.spend > 0)) {
        read.verdict = "NO_SPEND";
        const why = {
            ADS_OFF: (signal.notes || [])[0] || "Meta confirms the ads are off",
            SPEND_STOPPED: "delivery has all but stopped over the last 7 days",
            DATA_STALE: "no recent rows from the daily pull",
            DATA_GAPS: "the daily pull is missing days",
        }[signal.verdict];
        read.notes.push(why || (read.hasRow ? "a row with no spend" : `no row in the daily pull for ${read.day}`));
        return read;
    }
    if (yardstick === null) {
        read.verdict = "NO_YARDSTICK";
        read.notes.push("no target CPL set and no leads in the last 30 days");
        return read;
    }
    if (y.leads > 0) {
        read.verdict = y.cpl >= yardstick ? "RED_ALERT" : "ON_TARGET";
        if (read.verdict === "RED_ALERT") read.reason = "cpl";
    } else {
        read.verdict = y.spend >= yardstick ? "RED_ALERT" : "TOO_LITTLE";
        if (read.verdict === "RED_ALERT") read.reason = "no_leads";
    }
    // A bad week stays a red alert on a day that looks fine: one good day doesn't undo it.
    if (read.verdict !== "RED_ALERT" && signal.verdict === "CRITICAL") {
        read.verdict = "RED_ALERT";
        read.reason = "week";
        read.notes.push("the last 7 days are still critical");
    }
    return read;
}

const money = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))) ? "—" : `$${Math.round(Number(v)).toLocaleString("en-US")}`;
const ysText = (r) => r.yardstick === null ? "no yardstick" : `${money(r.yardstick)} ${r.yardstickKind === "target" ? "target" : "usual (own 30-day CPL, no target set)"}`;

// One line on what yesterday was, used by the text, the email and the context.
export function dayHeadline(r) {
    if (r.verdict === "NO_SPEND") return "no spend yesterday";
    const leads = `${r.leads} lead${r.leads === 1 ? "" : "s"}`;
    const cpl = r.cpl === null ? "no leads" : `${money(r.cpl)} CPL`;
    return `${money(r.spend)} spent, ${leads}, ${cpl} vs ${ysText(r)}`;
}

const ctxText = (c) => c.cpl === null ? (c.spend > 0 ? `no leads on ${money(c.spend)}` : "no spend") : `${money(c.cpl)} CPL (${money(c.perDay)}/day, ${c.leads} leads)`;

export function sortDayReads(reads) {
    return [...(reads || [])].sort((a, b) => {
        const d = DAY_ORDER.indexOf(a.verdict) - DAY_ORDER.indexOf(b.verdict);
        return d || (b.spend - a.spend) || String(a.name).localeCompare(String(b.name));
    });
}

// The markdown the model writes from (and the dashboard chat reads). Every figure computed here.
// The last field of each line is a short "why" (the dashboard's Intelligence card shows it).
export function buildDayContext(reads, signals, drivers = {}) {
    const sorted = sortDayReads(reads);
    const day = sorted[0]?.day;
    const bySignal = new Map((signals || []).map((s) => [s.name, s]));
    let md = `[AUDIT DAY: ${day ?? "unknown"} — this audit reports on that one day. The 7, 14 and 30-day figures are the days before it, for context only.]\n`;
    md += `[Every verdict below was computed in code and is authoritative. Leads are the daily pull's count. The yardstick is the client's target CPL, or their own CPL over the 30 days before, when they have no target. Do not recalculate anything.]\n\n`;
    for (const v of DAY_ORDER) {
        const group = sorted.filter((r) => r.verdict === v);
        if (!group.length) continue;
        md += `## ${DAY_LABEL[v]} (${group.length})\n`;
        for (const r of group) {
            if (v === "NO_SPEND") { md += `${r.name} — ${r.notes.join("; ")}\n`; continue; }
            const s = bySignal.get(r.name);
            const parts = [r.name, `yesterday ${dayHeadline(r)}`];
            for (const n of Object.keys(r.context)) parts.push(`${n}d ${ctxText(r.context[n])}`);
            if (r.target && r.context[30]?.cpl !== null && r.context[30]?.cpl !== undefined) parts.push(`own 30-day CPL ${money(r.context[30].cpl)}`);
            if (s) {
                let trend = `7-day trend ${String(s.verdict).replace(/_/g, " ")}`;
                const d = s.drivers;
                if (d && d.dominant) trend += `, driver ${String(d.dominant).toUpperCase()}${drivers[d.dominant] ? ` (${drivers[d.dominant][d.dominantWorsened ? "worse" : "better"]})` : ""}`;
                if ((s.flags || []).includes("CREATIVE")) trend += ", CTR falling (creative flag)";
                parts.push(trend);
            }
            const why = r.verdict === "RED_ALERT"
                ? (r.reason === "week" ? `the last 7 days are still critical (yesterday ${r.cpl === null ? "no leads" : money(r.cpl) + " CPL"})`
                    : r.reason === "no_leads" ? `no leads on ${money(r.spend)} yesterday, target ${money(r.yardstick)}`
                    : `${money(r.cpl)} CPL yesterday vs ${money(r.yardstick)} ${r.yardstickKind === "target" ? "target" : "usual"}`)
                : r.verdict === "ON_TARGET" ? `${money(r.cpl)} CPL yesterday, under ${money(r.yardstick)}`
                : r.notes.join("; ") || "under one target's worth of spend, no leads yet";
            parts.push(why);
            md += parts.join(" | ") + "\n";
        }
        md += "\n";
    }
    return md;
}

// One line for the text message: never a newline (Make's raw-text body can't take one).
export function redAlertLine(r) {
    if (r.reason === "week") return `${r.name}: last 7 days critical`;
    if (r.reason === "no_leads") return `${r.name}: no leads on ${money(r.spend)} (target ${money(r.yardstick)})`;
    return `${r.name}: ${money(r.cpl)} CPL vs ${money(r.yardstick)} ${r.yardstickKind === "target" ? "target" : "usual"} on ${money(r.spend)}`;
}
