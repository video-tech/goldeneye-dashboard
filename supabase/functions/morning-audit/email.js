// The morning audit as an email (2026-10-23): the written card plus every client's yesterday, sent to the
// people in AUDIT_EMAIL_TO after the scheduled audit saves its card. Plain, dependency-free JS so it can be
// tested in node. Every figure here comes from the day reads (daily.js) and the engine's signals; nothing is recomputed, and the model's
// text appears only as the card it already wrote.

// The card is written for the dashboard and colours itself with CSS variables, which email clients don't
// support. These are the light-theme equivalents.
export const EMAIL_COLORS = {
    "--neg": "#b42318", "--warn": "#b54708", "--pos": "#067647", "--gold": "#a37a1d",
    "--t1": "#101828", "--t2": "#475467", "--t3": "#667085", "--line": "#e4e7ec",
};

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))) ? "—" : `$${Math.round(Number(v)).toLocaleString("en-US")}`;
const pct = (v) => (v === null || v === undefined) ? "—" : (v === Infinity ? "no leads" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`);

// The model's card, made safe and readable in an inbox. It is admin-only HTML the model wrote, so it is
// treated as untrusted: anything that can run or load is removed, and the dashboard's icon font (which an
// inbox doesn't have) becomes a coloured dot.
export function emailSafeCard(html) {
    let s = String(html ?? "");
    s = s.replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, "")
        .replace(/<(script|style|iframe|object|embed|link|meta|base)\b[^>]*\/?>/gi, "")
        .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
        .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
    s = s.replace(/<i\b[^>]*class="[^"]*\bfa-[^"]*"[^>]*?(?:style="([^"]*)")?[^>]*>\s*<\/i>/gi,
        (_, style) => `<span style="${style || ""}">&#9679;</span>`);
    s = s.replace(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g, (_, name) => EMAIL_COLORS[name] || EMAIL_COLORS["--t2"]);
    return s;
}

// The 7-day verdict, shortened, for the trend column.
const TREND_SHORT = {
    CRITICAL: ["Critical", "--neg"], SPEND_STOPPED: ["Spend stopped", "--neg"], WATCH: ["Watch", "--warn"],
    SCALE_CANDIDATE: ["Scale", "--pos"], IMPROVING: ["Improving", "--pos"], ADS_OFF: ["Ads off", "--t3"],
    DATA_STALE: ["Data stale", "--t3"], DATA_GAPS: ["Data gaps", "--t3"], STABLE: ["Stable", "--t2"],
    INSUFFICIENT_VOLUME: ["Too little data", "--t3"], NO_SPEND: ["No spend", "--t3"],
};
// Yesterday's verdict (daily.js)
const DAY_SHORT = {
    RED_ALERT: ["Red alert", "--neg"], ON_TARGET: ["On target", "--pos"], TOO_LITTLE: ["Too little to judge", "--t2"],
    NO_YARDSTICK: ["No target", "--t3"], NO_SPEND: ["No spend", "--t3"],
};
const DAY_ORDER = ["RED_ALERT", "ON_TARGET", "TOO_LITTLE", "NO_YARDSTICK", "NO_SPEND"];

const ctxCpl = (c) => !c ? "—" : (c.cpl === null ? (c.spend > 0 ? "no leads" : "—") : money(c.cpl));

function clientCells(r, s) {
    const spent = r.spend > 0;
    const vs = r.yardstick ? `${money(r.yardstick)} ${r.yardstickKind === "target" ? "target" : "usual"}` : "—";
    const d = s?.drivers;
    const trend = s ? `${(TREND_SHORT[s.verdict] || [s.verdict])[0]}${d && d.dominant ? ` · ${String(d.dominant).toUpperCase()} (CPM ${pct(d.cpm)}, CTR ${pct(d.ctr)}, CVR ${pct(d.cvr)})` : ""}` : "—";
    return {
        spend: spent ? money(r.spend) : "—",
        leads: spent ? String(r.leads) : "—",
        cpl: !spent ? "—" : (r.cpl === null ? "none" : money(r.cpl)),
        vs,
        d7: ctxCpl(r.context?.[7]), d14: ctxCpl(r.context?.[14]), d30: ctxCpl(r.context?.[30]),
        trend,
        notes: [...(r.notes || []), ...((s?.flags || []).map((f) => `${f} flag`))].join("; "),
    };
}

// dayReads: daily.js's per-client reads of yesterday. signals: the engine's 7-day signals (the trend).
// adResult: ads.js in day mode (the ads to turn off). html: the saved card. missing: steady spenders without
// yesterday's row; adMissing: meta-sync clients without yesterday's ad rows. deadline: the audit ran at 10:00
// Mountain without them. dateLabel: "Mon, Oct 26".
export function renderAuditEmail({ html, dayReads = [], signals = [], adResult = null, missing = [], adMissing = [], deadline = false, dateLabel, dashboardUrl = "https://goldeneye.midasmediafirm.com" }) {
    const sorted = [...dayReads].sort((a, b) => (DAY_ORDER.indexOf(a.verdict) - DAY_ORDER.indexOf(b.verdict)) || (b.spend - a.spend));
    const bySignal = new Map(signals.map((s) => [s.name, s]));
    const red = sorted.filter((r) => r.verdict === "RED_ALERT").length;
    const off = (adResult?.flags || []).filter((f) => f.action === "TURN_OFF").length;
    const headline = [red ? `${red} red alert` : null, off ? `${off} ad${off === 1 ? "" : "s"} to turn off` : null].filter(Boolean).join(", ") || "nothing red";
    const subject = `Morning audit for ${dateLabel}: ${headline}`;
    const day = sorted[0]?.day;
    const windowText = day ? `Yesterday (${day}), judged against each client's target CPL, or their own 30-day CPL when they have none. The 7, 14 and 30-day CPLs are the days before it.` : "";
    const C = EMAIL_COLORS;
    const late = [];
    if (deadline && missing.length) late.push(`yesterday's numbers for ${missing.map(esc).join(", ")} (they read as no spend today; check the Make pull)`);
    if (deadline && adMissing.length) late.push(`yesterday's ad data for ${adMissing.map(esc).join(", ")} (their ads weren't checked)`);
    const missingNote = late.length ? `Ran at 10:00 Mountain without ${late.join(", and without ")}.` : "";

    const th = (t, align = "left") => `<th align="${align}" style="padding:8px 10px;border-bottom:2px solid ${C["--line"]};font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:${C["--t3"]};font-weight:600;white-space:nowrap;">${t}</th>`;
    const td = (t, align = "left", extra = "") => `<td align="${align}" valign="top" style="padding:8px 10px;border-bottom:1px solid ${C["--line"]};font-size:13px;color:${C["--t1"]};${extra}">${t}</td>`;
    const rows = sorted.map((r) => {
        const [label, color] = DAY_SHORT[r.verdict] || [r.verdict, "--t2"];
        const c = clientCells(r, bySignal.get(r.name));
        return `<tr>${td(`<strong>${esc(r.name)}</strong>`)}${td(`<span style="color:${C[color]};font-weight:600;white-space:nowrap;">${esc(label)}</span>`)}${td(c.spend, "right")}${td(esc(c.leads), "right")}${td(esc(c.cpl), "right", "font-weight:600;")}${td(esc(c.vs))}${td(esc(c.d7), "right")}${td(esc(c.d14), "right")}${td(esc(c.d30), "right")}${td(esc(c.trend), "left", `color:${C["--t2"]};font-size:12px;`)}${td(esc(c.notes), "left", `color:${C["--t2"]};font-size:12px;`)}</tr>`;
    }).join("");

    const body = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:860px;background:#ffffff;border:1px solid ${C["--line"]};border-radius:6px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
<tr><td style="padding:24px 28px 8px;">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${C["--gold"]};font-weight:700;">Golden Eye · Morning audit</div>
  <h1 style="margin:6px 0 4px;font-size:22px;color:${C["--t1"]};">${esc(dateLabel)}: ${esc(headline)}</h1>
  <p style="margin:0;font-size:13px;color:${C["--t2"]};">${esc(windowText)}</p>
  ${missingNote ? `<p style="margin:12px 0 0;padding:10px 12px;background:#fffaeb;border:1px solid #fedf89;border-radius:4px;font-size:13px;color:${C["--warn"]};">${missingNote}</p>` : ""}
</td></tr>
<tr><td style="padding:12px 28px;font-size:14px;line-height:1.6;color:${C["--t1"]};">${emailSafeCard(html)}</td></tr>
<tr><td style="padding:8px 28px 4px;"><h2 style="margin:12px 0 6px;font-size:15px;color:${C["--t1"]};">Every client, yesterday</h2>
  <p style="margin:0 0 8px;font-size:12px;color:${C["--t3"]};">Computed in code from the daily pull; leads are the pull's count. "7-day trend" is the last week against the 28 days before, and its driver is what moved CPL most: CPM (cost to reach people), CTR (people clicking) or CVR (clicks becoming leads).</p>
</td></tr>
<tr><td style="padding:0 16px 8px;"><div style="overflow-x:auto;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
<tr>${th("Client")}${th("Yesterday")}${th("Spend", "right")}${th("Leads", "right")}${th("CPL", "right")}${th("Against")}${th("7d CPL", "right")}${th("14d CPL", "right")}${th("30d CPL", "right")}${th("7-day trend")}${th("Notes")}</tr>
${rows || `<tr>${td("No clients in today's audit.")}</tr>`}
</table></div></td></tr>
<tr><td style="padding:16px 28px 24px;font-size:12px;color:${C["--t3"]};">Open <a href="${esc(dashboardUrl)}" style="color:${C["--gold"]};">Golden Eye</a> for the charts and each client's ads. This email goes out once each weekday morning, after the ad numbers are in.</td></tr>
</table></td></tr></table></body></html>`;

    const text = [
        `Morning audit for ${dateLabel}: ${headline}`, windowText, missingNote, "",
        ...sorted.map((r) => {
            const c = clientCells(r, bySignal.get(r.name));
            return `${r.name} [${(DAY_SHORT[r.verdict] || [r.verdict])[0]}] yesterday spend ${c.spend}, leads ${c.leads}, CPL ${c.cpl} vs ${c.vs} | 7d ${c.d7}, 14d ${c.d14}, 30d ${c.d30} | trend ${c.trend}${c.notes ? ` | ${c.notes}` : ""}`;
        }),
        "", `Golden Eye: ${dashboardUrl}`,
    ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");

    return { subject, html: body, text };
}

// Sends through Resend (the same account and verified domain as the welcome email). Never throws: the
// audit is already saved, and an email problem must not turn into a failed run.
export async function sendViaResend({ apiKey, to, subject, html, text, from = "Midas Media <hello@mail.midasmediafirm.com>", replyTo = "video@midasmediafirm.com" }, fetchFn = fetch) {
    const recipients = String(to ?? "").split(",").map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
    if (!apiKey) return { sent: false, reason: "RESEND_API_KEY isn't set" };
    if (!recipients.length) return { sent: false, reason: "AUDIT_EMAIL_TO isn't set" };
    try {
        const res = await fetchFn("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from, to: recipients, reply_to: replyTo, subject, html, text }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) return { sent: false, reason: `Resend ${res.status}: ${String(out?.message ?? "").slice(0, 200)}` };
        return { sent: true, id: out?.id ?? null, to: recipients };
    } catch (e) {
        return { sent: false, reason: String(e?.message ?? e).slice(0, 200) };
    }
}
