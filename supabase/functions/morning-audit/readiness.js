// Is yesterday's ad data in, and should the scheduled audit run now? Plain, dependency-free JS (like
// engine.js and ads.js) so it can be tested in node.
//
// Why the audit waits (2026-10-23). Facebook publishes some accounts' "yesterday" late: 3Sixty and Alta
// Vista were still empty at 8:30 Mountain on Oct 21 and 22 and present by 9:30. A fixed time either runs
// before them (and reports healthy clients as stale) or carries an hour of slack. So pg_cron calls the
// audit every 15 minutes from 9:00 Mountain, and it runs as soon as every steady spender has yesterday's
// row, or at 10:00 Mountain regardless (naming who is still missing).

export const READINESS_CONFIG = {
    // A client counts as a steady spender with rows on at least this many of the 7 days before yesterday.
    // Same rule as daily_pull_check() in supabase/sql/daily_pull_check.sql: Make writes no row for a day
    // with no spend, so a client whose ads are off, or who spends on and off, must never hold the audit up.
    steadyDays: 5,
    lookbackDays: 7,
    openMinutes: 9 * 60,       // 9:00 Mountain: start looking
    deadlineMinutes: 10 * 60,  // 10:00 Mountain: run whether or not everyone is in
    closeMinutes: 12 * 60,     // after noon a missed morning is left alone; the dashboard button still works
    timeZone: "America/Denver",
};

const digits = (v) => String(v ?? "").replace(/\D/g, "");
const toDay = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
    return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : null;
};
const isoOf = (day) => new Date(day * 86400000).toISOString().slice(0, 10);

// Today's date, yesterday's and the minutes past midnight, in Mountain time (daylight saving included).
export function denverNow(date = new Date(), cfg = READINESS_CONFIG) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone: cfg.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((p) => [p.type, p.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const minutes = (+parts.hour % 24) * 60 + +parts.minute;
    return { today, yesterday: isoOf(toDay(today) - 1), minutes, label: `${parts.hour}:${parts.minute} Mountain` };
}

// Clients the Make pull is asked for (status not paused or archived, with an ad account and a business id,
// the same filter as the pull and as daily_pull_check) who spend steadily but have no row for yesterday.
// rows: daily_reports rows with lowercased keys (ad_account_id, date).
export function steadyMissing(clients, rows, yesterday, cfg = READINESS_CONFIG) {
    const y = toDay(yesterday);
    if (y === null) throw new Error("steadyMissing: yesterday must be YYYY-MM-DD");
    const daysByAcct = new Map();
    for (const r of rows || []) {
        const acct = digits(r.ad_account_id), d = toDay(r.date);
        if (!acct || d === null) continue;
        if (!daysByAcct.has(acct)) daysByAcct.set(acct, new Set());
        daysByAcct.get(acct).add(d);
    }
    const missing = [];
    for (const c of clients || []) {
        const status = c.status || "active";
        if (status === "paused" || status === "archived") continue;
        const acct = digits(c.ad_account_id);
        if (!acct || !String(c.business_id ?? "").trim()) continue;
        const days = daysByAcct.get(acct) || new Set();
        let prior = 0;
        for (let d = y - cfg.lookbackDays; d < y; d++) if (days.has(d)) prior++;
        if (prior >= cfg.steadyDays && !days.has(y)) missing.push(c.name);
    }
    return missing.sort();
}

// What the scheduled run should do at this minute of the Mountain day.
//   wait (too early, or not everyone is in yet), run (everyone is in), run at the deadline, or skip (too late).
export function decideRun({ minutes, ready }, cfg = READINESS_CONFIG) {
    if (minutes < cfg.openMinutes) return { run: false, reason: "before 9:00 Mountain" };
    if (minutes >= cfg.closeMinutes) return { run: false, reason: "after noon Mountain: the morning's audit was missed, use Run audit" };
    if (ready) return { run: true, reason: "ready", deadline: false };
    if (minutes < cfg.deadlineMinutes) return { run: false, reason: "waiting for yesterday's numbers" };
    return { run: true, reason: "deadline", deadline: true };
}

// Per-ad data (2026-10-23). The daily audit lists the ads to turn off from yesterday's meta_ad_daily rows,
// so it also waits for those: clients meta-sync is connected for (a sync state row with a window it has
// loaded before) who spent yesterday by the daily pull but have no ad rows for yesterday. A client whose
// meta-sync never worked (Astra, waiting on its owner) has no window and never holds the audit up.
// spentYesterday: client names with spend yesterday in daily_reports. syncState: meta_sync_state rows.
// withAdRows: client names with meta_ad_daily rows dated yesterday.
export function adDataMissing({ spentYesterday, syncState, withAdRows }) {
    const connected = new Set((syncState || []).filter((s) => String(s.last_window ?? "").includes("..")).map((s) => s.client_name));
    const have = new Set(withAdRows || []);
    return [...new Set(spentYesterday || [])].filter((n) => connected.has(n) && !have.has(n)).sort();
}
