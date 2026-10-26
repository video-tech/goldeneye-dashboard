// Per-ad flags for the morning audit: which individual ads are at or over their client's
// target cost per lead. Plain, dependency-free JS (like engine.js) so it can be tested in node.
//
// Where the numbers come from, and why they are handled this way:
//   - Spend and leads per ad come from meta_ad_daily (the meta-sync function), Meta's own
//     per-ad figures. The account totals everything else relies on come from daily_reports
//     (the Make pull), and GHL is the real source of truth for leads. Meta's lead count can
//     run well above the daily pull's (Anxiety Solutions: 37 vs 15 for one week), so an ad's
//     Meta leads are SCALED so the ads add up to the account's daily-pull total. That keeps
//     one yardstick for the account and for its ads. The scaling is shown, never hidden.
//   - A flag asks someone to look at the ad. Nothing here pauses or changes anything.
//   - The verdict is decided here, in code. The model that writes the audit card never sees
//     ad names or ad figures, and never writes this section.

export const AD_ALERT_CONFIG = {
    // How far over the client's target an ad has to be before it is flagged. 1 means "at or
    // over target", the team's choice on 2026-10-12. A 90-day look back at the real ad data
    // (about 1 in 5 flagged ads came good the next week at 1x, 1 in 7 at 2x) is in CLAUDE.md;
    // raise this to 1.5 or 2 to flag fewer ads. It changes both tests below at once.
    targetMultiple: 1,
    // An ad younger than this is still in Meta's learning phase and is left alone.
    minAgeDays: 4,
    // The ad must have spent on one of the last this-many days: an ad that already stopped
    // needs nobody to turn it off.
    recentSpendDays: 2,
    // Most ads listed per client; the rest are counted.
    maxPerClient: 6,
    // Meta's lead count is scaled by (daily pull leads / Meta leads), within these limits,
    // and only when the daily pull covered most of the window.
    scaleMin: 0,
    scaleMax: 1.5,
    scaleMinCoverage: 0.8,
    // If the newest ad data is more than this many days behind the audit's window end,
    // meta-sync is behind and the client is skipped rather than judged on stale numbers.
    staleAfterDays: 2,
};

// "Ads are off" versus "the pull is broken". The daily pull (Make) writes no row for a day with no
// spend, so a client whose ads were switched off looks exactly like a broken pull: the audit used to
// say DATA STALE and send someone to check Make. meta-sync can tell them apart, because it asks Meta
// every day and records that it did: if it ran recently without error for this client and Meta shows
// no spend for several days, the ads are off and the data is fine.
export const ADS_OFF_CONFIG = {
    // No spend on this many of the window's last days
    offAfterDays: 3,
    // meta-sync must have run for the client within this long
    syncFreshMs: 48 * 3600 * 1000,
};

const isoOf = (day) => new Date(day * 86400000).toISOString().slice(0, 10);

// signals: the audit's per-client signals (changed in place). adRows: meta_ad_daily rows.
// syncState: meta_sync_state rows. Returns the names it changed.
export function applyAdsOff(signals, adRows, syncState, now = new Date(), cfg = ADS_OFF_CONFIG) {
    const changed = [];
    for (const s of signals || []) {
        if (s.verdict !== "DATA_STALE" && s.verdict !== "DATA_GAPS") continue;
        const st = (syncState || []).find((x) => x.client_name === s.name);
        // meta-sync has to have looked, recently, and without an error: otherwise we cannot say
        // anything about Meta, and the original verdict stands.
        if (!st || !st.last_run_at || st.last_error) continue;
        if (now.getTime() - Date.parse(st.last_run_at) > cfg.syncFreshMs) continue;
        const syncedTo = toDay(String(st.last_window || "").split("..")[1]);
        const to = toDay(s.window && s.window.recentTo);
        if (syncedTo === null || to === null || syncedTo < to - 1) continue;

        let last = null;
        for (const r of adRows || []) {
            if (r.client_name !== s.name || !(parseFloat(r.spend) > 0)) continue;
            const d = toDay(r.date);
            if (d !== null && (last === null || d > last)) last = d;
        }
        if (last !== null && to - last < cfg.offAfterDays) continue; // spent recently: ads are running

        s.verdict = "ADS_OFF";
        s.adsOffSince = last === null ? null : isoOf(last + 1);
        s.notes = [last === null ? "Meta shows no spend in the last 45 days" : `Meta shows no spend since ${isoOf(last)}`];
        changed.push(s.name);
    }
    return changed;
}

const toDay = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
    return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : null;
};

const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function adsManagerUrl(accountId, adId) {
    const act = String(accountId ?? "").replace(/\D/g, "");
    const ad = String(adId ?? "").replace(/\D/g, "");
    if (!act || !ad) return null;
    return `https://www.facebook.com/adsmanager/manage/ads?act=${act}&selected_ad_ids=${ad}`;
}

// signals: the audit's per-client signals. Each carries targetCpl, window.recentFrom/To (ISO),
//          recent.leads and recent.coverage from the daily pull.
// adRows:  meta_ad_daily rows, any clients, covering at least the window plus some history.
// Returns { flags, checked, noTarget, stale, noData } where `flags` is one entry per flagged ad.
//
// opts.day (2026-10-23, the daily audit): judge each ad on that one day ("YYYY-MM-DD", yesterday)
// instead of the 7-day window. Every flagged ad is TURN OFF, except one under minAgeDays old, which is
// listed as still learning rather than skipped. The 7-day window still sets the lead scaling (one
// day's ratio is too jumpy) and is carried on each flag as context. opts.yardstick(signal) gives
// { value } when a client has no target (their own 30-day CPL); without it, no target means
// not checked. In day mode a client whose ad data doesn't reach that day is listed as stale.
export function computeAdFlags(signals, adRows, cfg = AD_ALERT_CONFIG, historyStartISO, opts = {}) {
    const out = { flags: [], checked: [], noTarget: [], stale: [], noData: [], mode: opts.day ? "day" : "week" };

    const byClient = new Map();
    for (const r of adRows || []) {
        if (!byClient.has(r.client_name)) byClient.set(r.client_name, []);
        byClient.get(r.client_name).push(r);
    }
    const historyStart = historyStartISO ? toDay(historyStartISO) : null;

    for (const s of signals || []) {
        const ys = opts.yardstick ? opts.yardstick(s) : null;
        const target = parseFloat(s.targetCpl) > 0 ? parseFloat(s.targetCpl) : (ys && ys.value > 0 ? ys.value : NaN);
        const targetKind = parseFloat(s.targetCpl) > 0 ? "target" : "usual";
        if (!(target > 0)) { out.noTarget.push(s.name); continue; }

        const rows = byClient.get(s.name) || [];
        if (!rows.length) { out.noData.push(s.name); continue; }

        const from = toDay(s.window?.recentFrom), to = toDay(s.window?.recentTo);
        if (from === null || to === null) { out.noData.push(s.name); continue; }

        let newest = null;
        for (const r of rows) { const d = toDay(r.date); if (d !== null && (newest === null || d > newest)) newest = d; }
        const judgeDay = opts.day ? toDay(opts.day) : null;
        if (newest === null || (opts.day ? newest < judgeDay : to - newest > cfg.staleAfterDays)) { out.stale.push(s.name); continue; }
        const jFrom = opts.day ? judgeDay : from, jTo = opts.day ? judgeDay : to;

        // Group by ad: spend and leads inside the window, first day seen, spend on the last days.
        const ads = new Map();
        let metaLeadsAll = 0;
        for (const r of rows) {
            const d = toDay(r.date);
            if (d === null) continue;
            let a = ads.get(r.ad_id);
            if (!a) { a = { id: r.ad_id, firstSeen: d, spend: 0, leads: 0, recentSpend: 0, jSpend: 0, jLeads: 0, row: r }; ads.set(r.ad_id, a); }
            if (d < a.firstSeen) a.firstSeen = d;
            if (d >= jFrom && d <= jTo) {
                a.jSpend += parseFloat(r.spend) || 0;
                a.jLeads += parseInt(r.leads) || 0;
                if (opts.day) a.row = r;
            }
            if (d >= from && d <= to) {
                a.spend += parseFloat(r.spend) || 0;
                const l = parseInt(r.leads) || 0;
                a.leads += l;
                metaLeadsAll += l;
                if (d > to - cfg.recentSpendDays) a.recentSpend += parseFloat(r.spend) || 0;
                a.row = r; // latest row in the window carries the current names
            }
        }

        // Scale Meta's leads to the daily pull's account total
        const pullLeads = parseFloat(s.recent?.leads);
        const coverage = parseFloat(s.recent?.coverage);
        let scale = 1;
        if (metaLeadsAll > 0 && Number.isFinite(pullLeads) && coverage >= cfg.scaleMinCoverage) {
            scale = Math.min(cfg.scaleMax, Math.max(cfg.scaleMin, pullLeads / metaLeadsAll));
        }

        const bar = cfg.targetMultiple * target;
        const flagged = [];
        for (const a of ads.values()) {
            if (opts.day ? a.jSpend <= 0 : (a.spend <= 0 || a.recentSpend <= 0)) continue;
            // Age: days since first seen. An ad already present on the first day we hold data
            // for has an unknown, older start, so it counts as old enough.
            const oldEnough = historyStart !== null && a.firstSeen <= historyStart + 1
                ? true : (jTo - a.firstSeen) >= cfg.minAgeDays;
            if (!oldEnough && !opts.day) continue;
            if (a.jSpend < bar) continue;

            const est = a.jLeads * scale;
            const noLeads = a.jLeads === 0 || est === 0;
            const estCpl = noLeads ? null : a.jSpend / est;
            if (!noLeads && estCpl < bar) continue;

            flagged.push({
                client: s.name,
                adId: a.id,
                adName: a.row.ad_name || a.id,
                adsetName: a.row.adset_name || null,
                campaignName: a.row.campaign_name || null,
                kind: noLeads ? "NO_LEADS" : "OVER_TARGET",
                action: opts.day ? (oldEnough ? "TURN_OFF" : "LEARNING") : null,
                spend: a.jSpend,
                metaLeads: a.jLeads,
                estLeads: est,
                estCpl,
                target,
                targetKind,
                scale,
                week: { spend: a.spend, metaLeads: a.leads, estLeads: a.leads * scale, estCpl: a.leads * scale > 0 ? a.spend / (a.leads * scale) : null },
                ageDays: jTo - a.firstSeen,
                url: adsManagerUrl(a.row.ad_account_id, a.id),
                windowFrom: opts.day || s.window.recentFrom,
                windowTo: opts.day || s.window.recentTo,
            });
        }
        flagged.sort((x, y) => y.spend - x.spend);
        out.checked.push({ client: s.name, target, targetKind, adsInWindow: [...ads.values()].filter((a) => (opts.day ? a.jSpend : a.spend) > 0).length, flagged: flagged.length, scale });
        out.flags.push(...flagged);
    }
    return out;
}

function leadText(f) {
    if (f.kind === "NO_LEADS") return "no leads";
    const meta = f.metaLeads === 1 ? "1 lead" : `${f.metaLeads} leads`;
    return f.scale !== 1 ? `${meta} per Meta, about ${f.estLeads.toFixed(1)} on your pull` : meta;
}

// The block appended to the audit card. Ad and campaign names are text typed by whoever built
// the ad, so every one of them is escaped.
export function renderAdFlagsHtml(result, cfg = AD_ALERT_CONFIG) {
    if (result.mode === "day") return renderTurnOffHtml(result, cfg);
    const { flags, checked, noTarget, stale, noData = [] } = result;
    const mutedCss = 'color:var(--t3); font-size:12px;';
    const muted = `style="${mutedCss}"`;
    const parts = [`<div style="margin-top:22px; padding-top:16px; border-top:1px solid var(--line);">`];

    if (!checked.length && !noTarget.length && !stale.length && !noData.length) { return ""; }

    if (flags.length) {
        const clientsHit = new Set(flags.map((f) => f.client)).size;
        parts.push(`<p><i class="fa-solid fa-bullseye" style="color:var(--warn);"></i> <strong style="color:var(--warn);">Ads at or over target</strong> — ${flags.length} ad${flags.length === 1 ? "" : "s"} across ${clientsHit} client${clientsHit === 1 ? "" : "s"}. A flag is a prompt to look, not a verdict: an ad can have a bad week and come back.</p>`);
        const names = [...new Set(flags.map((f) => f.client))];
        for (const name of names) {
            const mine = flags.filter((f) => f.client === name);
            const c = checked.find((x) => x.client === name);
            const shown = mine.slice(0, cfg.maxPerClient);
            parts.push(`<p style="margin:12px 0 4px;"><strong>${esc(name)}</strong> <span ${muted}>target ${money(mine[0].target)} · ${esc(mine[0].windowFrom)} to ${esc(mine[0].windowTo)}</span></p><ul style="margin:0 0 4px 18px; padding:0; list-style:disc;">`);
            for (const f of shown) {
                const cpl = f.kind === "NO_LEADS" ? "" : ` · CPL about ${money(f.estCpl)}`;
                const link = f.url ? ` <a href="${esc(f.url)}" target="_blank" rel="noopener" style="color:var(--gold);">Open in Ads Manager</a>` : "";
                const where = f.adsetName ? ` <span ${muted}>(${esc(f.adsetName)})</span>` : "";
                parts.push(`<li style="margin:3px 0;">${esc(f.adName)}${where} — ${money(f.spend)} spent, ${esc(leadText(f))}${cpl}${link}</li>`);
            }
            if (mine.length > shown.length) parts.push(`<li ${muted}>and ${mine.length - shown.length} more</li>`);
            parts.push(`</ul>`);
            if (c && c.scale !== 1 && c.scale > 0) parts.push(`<p style="${mutedCss} margin:0 0 6px;">Meta counted ${Math.round(100 / c.scale)}% of the leads your daily pull did for this account, so each ad's leads are scaled to match.</p>`);
        }
    } else if (checked.length) {
        parts.push(`<p><i class="fa-solid fa-bullseye" style="color:var(--pos);"></i> <strong style="color:var(--pos);">Ads at or over target</strong> — none across ${checked.length} client${checked.length === 1 ? "" : "s"} checked.</p>`);
    }

    const notes = [];
    if (noTarget.length) notes.push(`No target CPL set, so ads weren't checked: ${noTarget.map(esc).join(", ")}.`);
    if (noData.length) notes.push(`No ad data synced yet for ${noData.map(esc).join(", ")}, so their ads weren't checked.`);
    if (stale.length) notes.push(`Ad data is out of date for ${stale.map(esc).join(", ")}, so they were skipped.`);
    if (notes.length) parts.push(`<p ${muted}>${notes.join(" ")}</p>`);

    parts.push(`</div>`);
    return parts.join("\n");
}

const ystick = (f) => `${f.targetKind === "usual" ? "usual CPL" : "target"} ${money(f.target)}`;
const leadsShort = (n, est, scale) => n === 0 ? "no leads" : (scale !== 1 ? `about ${est.toFixed(1)} leads` : `${n} lead${n === 1 ? "" : "s"}`);

// The daily audit's section: ads at or over target yesterday. Every one is TURN OFF, except an ad
// under minAgeDays old, listed apart as still learning (switching it off and on restarts Meta's learning).
function renderTurnOffHtml(result, cfg) {
    const { flags, checked, noTarget, stale, noData = [] } = result;
    if (!checked.length && !noTarget.length && !stale.length && !noData.length) return "";
    const mutedCss = 'color:var(--t3); font-size:12px;';
    const muted = `style="${mutedCss}"`;
    const parts = [`<div style="margin-top:22px; padding-top:16px; border-top:1px solid var(--line);">`];
    const off = flags.filter((f) => f.action === "TURN_OFF");
    const learning = flags.filter((f) => f.action === "LEARNING");
    const line = (f, prefix = "") => {
        const y = `${money(f.spend)} spent, ${leadsShort(f.metaLeads, f.estLeads, f.scale)}${f.kind === "NO_LEADS" ? "" : `, CPL about ${money(f.estCpl)}`}`;
        const w = f.week.spend > 0 ? ` <span ${muted}>· last 7 days ${money(f.week.spend)}, ${leadsShort(f.week.metaLeads, f.week.estLeads, f.scale)}${f.week.estCpl ? `, CPL about ${money(f.week.estCpl)}` : ""}</span>` : "";
        const where = f.adsetName ? ` <span ${muted}>(${esc(f.adsetName)})</span>` : "";
        const link = f.url ? ` <a href="${esc(f.url)}" target="_blank" rel="noopener" style="color:var(--gold);">Open in Ads Manager</a>` : "";
        return `<li style="margin:3px 0;"><strong>${prefix}${esc(f.adName)}</strong>${where} — yesterday ${y}${w}${link}</li>`;
    };
    if (off.length) {
        const clientsHit = new Set(off.map((f) => f.client)).size;
        parts.push(`<p><i class="fa-solid fa-power-off" style="color:var(--neg);"></i> <strong style="color:var(--neg);">Ads to turn off</strong> — ${off.length} ad${off.length === 1 ? "" : "s"} across ${clientsHit} client${clientsHit === 1 ? "" : "s"} were at or over target yesterday.</p>`);
        for (const name of [...new Set(off.map((f) => f.client))]) {
            const mine = off.filter((f) => f.client === name);
            const shown = mine.slice(0, cfg.maxPerClient);
            parts.push(`<p style="margin:12px 0 4px;"><strong>${esc(name)}</strong> <span ${muted}>${esc(ystick(mine[0]))} · ${esc(mine[0].windowTo)}</span></p><ul style="margin:0 0 4px 18px; padding:0; list-style:disc;">`);
            shown.forEach((f) => parts.push(line(f)));
            if (mine.length > shown.length) parts.push(`<li ${muted}>and ${mine.length - shown.length} more</li>`);
            parts.push(`</ul>`);
            const c = checked.find((x) => x.client === name);
            if (c && c.scale !== 1 && c.scale > 0) parts.push(`<p style="${mutedCss} margin:0 0 6px;">Meta counted ${Math.round(100 / c.scale)}% of the leads your daily pull did for this account over the last 7 days, so each ad's leads are scaled to match.</p>`);
        }
    } else if (checked.length) {
        parts.push(`<p><i class="fa-solid fa-power-off" style="color:var(--pos);"></i> <strong style="color:var(--pos);">Ads to turn off</strong> — none: no ad was at or over target yesterday across ${checked.length} client${checked.length === 1 ? "" : "s"} checked.</p>`);
    }
    if (learning.length) {
        parts.push(`<p style="margin:12px 0 4px;"><strong>Over target but still learning</strong> <span ${muted}>under ${cfg.minAgeDays} days old; turning them off and on restarts Meta's learning</span></p><ul style="margin:0 0 4px 18px; padding:0; list-style:disc;">`);
        learning.slice(0, cfg.maxPerClient * 2).forEach((f) => parts.push(line(f, `${esc(f.client)}: `)));
        parts.push(`</ul>`);
    }
    const notes = [];
    if (noTarget.length) notes.push(`No target CPL and no 30-day CPL, so ads weren't checked: ${noTarget.map(esc).join(", ")}.`);
    if (noData.length) notes.push(`No ad data synced for ${noData.map(esc).join(", ")}, so their ads weren't checked.`);
    if (stale.length) notes.push(`Yesterday's ad data wasn't in yet for ${stale.map(esc).join(", ")}, so their ads weren't checked.`);
    if (notes.length) parts.push(`<p ${muted}>${notes.join(" ")}</p>`);
    parts.push(`</div>`);
    return parts.join("\n");
}

// Plain text for the chat's briefing (the dashboard AI agent), never for the card's model.
export function adFlagsContext(result) {
    const { flags, checked, noTarget } = result;
    if (result.mode === "day") {
        const stale = result.stale || [];
        if (!checked.length && !noTarget.length && !stale.length) return "";
        let t = `\n\n=== ADS TO TURN OFF (computed in code, on yesterday alone; leads are Meta's, scaled to each account's daily-pull total) ===\n`;
        if (!flags.length && checked.length) t += `No ad was at or over target yesterday across ${checked.length} client(s) checked.\n`;
        for (const f of flags) {
            t += `- ${f.action === "LEARNING" ? "STILL LEARNING (under 4 days old)" : "TURN OFF"}: ${f.client}: "${f.adName}" yesterday ${money(f.spend)} spent, ${f.kind === "NO_LEADS" ? "no leads" : `CPL about ${money(f.estCpl)}`}, ${ystick(f)}; last 7 days ${money(f.week.spend)}${f.week.estCpl ? `, CPL about ${money(f.week.estCpl)}` : ", no leads"}\n`;
        }
        if (noTarget.length) t += `Not checked, no target or 30-day CPL: ${noTarget.join(", ")}.\n`;
        if (stale.length) t += `Not checked, yesterday's ad data not in yet: ${stale.join(", ")}.\n`;
        return t;
    }
    if (!checked.length && !noTarget.length) return "";
    let t = "\n\n=== INDIVIDUAL ADS AT OR OVER TARGET CPL (computed in code, last 7 days; leads are Meta's, scaled to each account's daily-pull total) ===\n";
    if (!flags.length) t += checked.length ? `No ads flagged across ${checked.length} client(s) checked.\n` : "";
    for (const f of flags) {
        t += `- ${f.client}: "${f.adName}" ${money(f.spend)} spent, ${f.kind === "NO_LEADS" ? "no leads" : `${f.metaLeads} Meta leads (about ${f.estLeads.toFixed(1)} scaled), CPL about ${money(f.estCpl)}`}, target ${money(f.target)}\n`;
    }
    if (noTarget.length) t += `Not checked, no target CPL set: ${noTarget.join(", ")}.\n`;
    return t;
}
