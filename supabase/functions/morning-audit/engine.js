// ==== BEGIN SHARED ENGINE ====
// A verbatim mirror of the signal engine in app.js. Kept identical on purpose:
// engine-parity.test.js slices both copies and asserts they agree on every
// fixture, so drift fails a test rather than quietly changing a verdict.
// Plain .js, not .ts, so it can stay byte-identical to the browser copy.

const AUDIT_CONFIG = {
    // Never read a day still in progress: full spend against a fraction of its
    // leads. Beyond that one day the window anchors to the freshest day the
    // pull actually delivered rather than a fixed offset from today (see
    // resolveAuditAnchor), so the audit stays as current as the data allows and
    // does not invent a gap on mornings it runs before the pull does.
    //
    // Why 1 and not more. Meta keeps revising a day for days after it ends —
    // conversions attribute back to the click that caused them, so a lead can
    // land in Tuesday's row on Saturday. The Make pull reads each day exactly
    // once, at 08:00 the next morning, and never revisits it, so every row is
    // frozen at the same age and both windows are under-counted by the same
    // factor. The comparison is unbiased *because* nothing is restated.
    //
    // If that pull is ever changed to re-fetch a rolling range, older days will
    // settle while fresh ones have not, fresh days will read worse than they
    // are, and this must go to 3. Absolute lead counts are understated either
    // way — see the note on target_cpl in CLAUDE.md.
    lagDays: 1,
    recentDays: 7,
    // Disjoint from the recent window, and a whole number of weeks so the two
    // windows contain the same mix of weekdays. The old baseline contained the
    // very week it was being compared against.
    baselineDays: 28,

    // Floors. Below these, no verdict is issued at all — the honest answer is
    // "not enough data", not a coin flip dressed up as an alert.
    // Gate on how many leads this spend *should* have bought, not on the spend itself.
    // What gives the z-test its power is the expected count — a raw dollar floor
    // silenced accounts with 48 and 51 baseline leads for being $23 short of it, while
    // saying nothing about whether their numbers were actually readable.
    minExpectedLeads: 8,
    minBaselineLeads: 8,
    minCoverage: 0.6,
    staleAfterDays: 3,

    // Thresholds. A move has to be both statistically unlikely (z) and
    // materially large (cplDelta) before it is worth waking anyone up.
    criticalZ: -2.0,
    watchZ: -1.25,
    improvingZ: 1.5,
    criticalCplDelta: 0.25,
    watchCplDelta: 0.15,
    improvingCplDelta: -0.15,
    spendStoppedFraction: 0.1,
    // A scale recommendation needs spend to have held roughly steady in BOTH
    // directions. Cutting budget usually improves CPL on its own — you stop buying the
    // expensive end of the inventory — so an improvement on 40% less spend is very
    // likely caused by the cut, and telling someone to scale it back up would undo the
    // thing that helped. Those become IMPROVING with the caveat spelled out.
    scaleSpendCeiling: 0.1,
    scaleSpendFloor: -0.15,

    // Below this the CPL did not really move, and decomposing a non-event yields a
    // confident-sounding cause for nothing at all.
    minCplDeltaForDriver: 0.10,

    // Creative signals. A falling click-through rate earns a flag on its own:
    // whether the audience has seen the ad too often or the ad was simply weak,
    // the answer is the same — go and look at it. Frequency only decides which
    // of those two stories we tell. CTR is a ratio over thousands of
    // impressions, so it is stable enough that a 15% move is real, but the
    // impression floor keeps a quiet account from tripping it.
    ctrFatigueDelta: -0.15,
    saturationFrequencyDelta: 0.15,
    saturationFrequency: 2.0,
    minFatigueImpressions: 2000
};

// Whole days since the epoch, UTC. Working in day numbers rather than Date
// objects removes the drift that silently made the old window 7 or 8 days long
// depending on what time of day it happened to run.
const toDayNumber = (value) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
    if (!m) return null;
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
};

const dayNumberToISO = (day) => new Date(day * 86400000).toISOString().split('T')[0];

const todayDayNumber = () => {
    const now = new Date();
    return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000);
};

// Totals for one inclusive day range, plus how much of that range actually has
// rows. Coverage is what separates "this client collapsed" from "the Make pull
// failed" — in the totals alone those two are indistinguishable.
function summarizeWindow(rows, startDay, endDay) {
    const span = (endDay - startDay) + 1;
    const daysSeen = new Set();
    let spend = 0, leads = 0, impressions = 0, clicks = 0, reach = 0;

    rows.forEach(r => {
        const day = toDayNumber(r.date);
        if (day === null || day < startDay || day > endDay) return;
        daysSeen.add(day);
        spend += parseFloat(r.spend) || 0;
        leads += parseInt(r.leads) || 0;
        impressions += parseInt(r.impressions) || 0;
        clicks += parseInt(r.unique_link_clicks) || 0;
        // Reach is unique people, so summing days does not give window reach.
        // impressions/summed-reach is average *daily* frequency, which is the
        // number that matters for saturation and is comparable between windows.
        reach += parseInt(r.reach) || 0;
    });

    return {
        spend, leads, impressions, clicks, reach, span,
        daysWithData: daysSeen.size,
        coverage: span > 0 ? daysSeen.size / span : 0,
        // A week with spend and no leads has no CPL. It does not have a CPL of
        // zero — that reading is what filed those accounts under "improving".
        cpl: leads > 0 ? spend / leads : null
    };
}

// The last day the whole audit reports on. The Make pull writes yesterday each
// morning, so the freshest day available is normally today-1 — but if the pull
// has not run yet, or failed, it is older. Anchoring to what actually arrived
// keeps the window as current as the data allows, and stops a late pull from
// reading as a missing day for every client at once.
//
// One anchor for the whole agency, not one per client: the pull runs for all
// clients together, so a client whose rows stop early is genuinely behind and
// needs to be flagged rather than quietly measured over its own older window.
function resolveAuditAnchor(rowsPerClient, todayNum, cfg) {
    const c = cfg || AUDIT_CONFIG;
    const ceiling = todayNum - c.lagDays; // never read a part-elapsed day
    let newest = null;

    rowsPerClient.forEach(rows => rows.forEach(r => {
        const d = toDayNumber(r.date);
        if (d !== null && (newest === null || d > newest)) newest = d;
    }));

    return newest === null ? ceiling : Math.min(newest, ceiling);
}

// CPL is an identity, not a mystery: CPL = CPM/1000 ÷ CTR ÷ CVR. In logs the
// three contributions add up exactly to the CPL change, so we can say which one
// moved the number rather than leaving the model to guess at a cause.
//
// This is what makes account-level data worth having without ad-level
// breakdowns. "CPL is up 40%" sends someone into Ads Manager blind. "CPL is up
// 40% and it is all click-to-lead" sends them to the landing page instead, and
// tells them not to touch the ads at all.
function decomposeCplChange(recent, baseline) {
    const rates = (w) => ({
        cpm: w.impressions > 0 ? (w.spend / w.impressions) * 1000 : null,
        ctr: w.impressions > 0 ? w.clicks / w.impressions : null,
        cvr: w.clicks > 0 ? w.leads / w.clicks : null,
        frequency: w.reach > 0 ? w.impressions / w.reach : null
    });

    const r = rates(recent), b = rates(baseline);
    const delta = (now, was) => (now === null || was === null || was === 0) ? null : (now - was) / was;

    const out = {
        cpm: delta(r.cpm, b.cpm),
        ctr: delta(r.ctr, b.ctr),
        cvr: delta(r.cvr, b.cvr),
        frequency: delta(r.frequency, b.frequency),
        recentFrequency: r.frequency,
        dominant: null,
        dominantWorsened: null
    };

    // Rank by log contribution — a rising CPM pushes CPL up, a rising CTR or CVR
    // pulls it down, so the latter two enter negated.
    const ln = (now, was) => (now === null || was === null || now <= 0 || was <= 0) ? null : Math.log(now / was);
    const parts = {
        cpm: ln(r.cpm, b.cpm),
        ctr: ln(r.ctr, b.ctr) === null ? null : -ln(r.ctr, b.ctr),
        cvr: ln(r.cvr, b.cvr) === null ? null : -ln(r.cvr, b.cvr)
    };

    let best = null;
    Object.keys(parts).forEach(k => {
        if (parts[k] === null) return;
        if (best === null || Math.abs(parts[k]) > Math.abs(parts[best])) best = k;
    });
    out.dominant = best;
    // A positive log contribution pushed CPL up. The same driver reads very
    // differently in each direction, so record which way it went.
    out.dominantWorsened = best === null ? null : parts[best] > 0;
    return out;
}

// What each driver means in practice, so the model routes the work to the right
// person instead of always saying "review the ads".
const DRIVER_MEANING = {
    cpm: {
        worse:  'auction cost rose — competition, an audience too narrow, or a budget jump',
        better: 'auction cost fell — impressions got cheaper'
    },
    ctr: {
        worse:  'people are scrolling past — creative fatigue or a saturated audience',
        better: 'more people are clicking — the creative is landing'
    },
    cvr: {
        worse:  'clicks are not becoming leads — landing page or form, not the ads',
        better: 'more clicks are becoming leads — the page or offer is converting better'
    }
};

// One client in, one verdict out. `rows` is that client's daily_reports.
// `anchor` is the shared last-reported day from resolveAuditAnchor.
function computeClientSignal(client, rows, anchor, cfg) {
    const c = cfg || AUDIT_CONFIG;
    const recentStart = anchor - c.recentDays + 1;
    const baseEnd = recentStart - 1;
    const baseStart = baseEnd - c.baselineDays + 1;

    const recent = summarizeWindow(rows, recentStart, anchor);
    const baseline = summarizeWindow(rows, baseStart, baseEnd);

    let newestDay = null;
    rows.forEach(r => {
        const d = toDayNumber(r.date);
        if (d !== null && (newestDay === null || d > newestDay)) newestDay = d;
    });

    const signal = {
        name: client.name,
        targetCpl: parseFloat(client.target_cpl) || null,
        healthScore: client.current_score > 0 ? client.current_score : null,
        window: {
            recentFrom: dayNumberToISO(recentStart), recentTo: dayNumberToISO(anchor),
            baselineFrom: dayNumberToISO(baseStart), baselineTo: dayNumberToISO(baseEnd)
        },
        recent, baseline,
        // Measured against the agency-wide anchor, not against today: the
        // question is whether this client is behind everyone else, which is what
        // a per-client pull failure looks like.
        daysBehind: newestDay === null ? null : anchor - newestDay,
        lastReported: newestDay === null ? null : dayNumberToISO(newestDay),
        expectedLeads: null, z: null, cplDelta: null, spendDelta: null,
        // Flags sit alongside the verdict rather than replacing it: an account
        // can be losing its creative and blowing its CPL at the same time, and
        // collapsing that into one label would lose half of it.
        drivers: null, flags: [], verdict: 'STABLE', notes: []
    };

    // --- Data-quality gates, before any performance verdict. A broken pull and
    // a dead account look identical in the numbers, and only one of the two is
    // the client's problem.
    if (newestDay === null || signal.daysBehind > c.staleAfterDays) {
        signal.verdict = 'DATA_STALE';
        signal.notes.push(newestDay === null
            ? 'no ad rows on file at all'
            : `last row is ${signal.lastReported}, ${signal.daysBehind} days behind the rest of the agency`);
        return signal;
    }

    if (recent.spend <= 0 && baseline.spend <= 0) {
        signal.verdict = 'NO_SPEND';
        signal.notes.push('nothing running in either window');
        return signal;
    }

    // Compare daily rates, not window totals, so a window with missing days
    // does not read as a budget cut.
    const baseDailySpend = baseline.daysWithData > 0 ? baseline.spend / baseline.daysWithData : 0;
    const recentDailySpend = recent.daysWithData > 0 ? recent.spend / recent.daysWithData : 0;
    signal.spendDelta = baseDailySpend > 0 ? (recentDailySpend - baseDailySpend) / baseDailySpend : null;

    if (baseDailySpend > 0 && recentDailySpend < baseDailySpend * c.spendStoppedFraction) {
        signal.verdict = 'SPEND_STOPPED';
        signal.notes.push(`daily spend fell from $${baseDailySpend.toFixed(0)} to $${recentDailySpend.toFixed(0)}`);
        return signal;
    }

    if (recent.coverage < c.minCoverage || baseline.coverage < c.minCoverage) {
        signal.verdict = 'DATA_GAPS';
        signal.notes.push(`only ${recent.daysWithData}/${recent.span} recent and ${baseline.daysWithData}/${baseline.span} baseline days have rows`);
        return signal;
    }

    // --- Significance. The question is not "did CPL move" but "did this spend
    // buy meaningfully fewer leads than the baseline rate predicts" — the same
    // question with the volume noise taken out. Leads are count data, so the
    // spread of a normal week scales with the square root of the expected
    // count. A client expecting 3 leads can never clear the bar on a one-lead
    // miss, which is exactly the false alarm the old flat 5% rule fired every
    // morning; a client expecting 40 and getting 22 clears it easily.
    const expected = baseline.cpl > 0 ? recent.spend / baseline.cpl : 0;
    signal.expectedLeads = expected;
    signal.z = expected > 0 ? (recent.leads - expected) / Math.sqrt(expected) : null;

    // Infinity, not null: spend with zero leads is the worst possible outcome
    // and has to sort as such.
    signal.cplDelta = (recent.cpl !== null && baseline.cpl > 0)
        ? (recent.cpl - baseline.cpl) / baseline.cpl
        : (recent.cpl === null && recent.spend > 0 ? Infinity : null);

    // Why the CPL moved, decomposed exactly. Available for every verdict, not
    // just the bad ones — knowing a win came from a CVR jump is what tells you
    // whether it will hold when you scale it.
    signal.drivers = decomposeCplChange(recent, baseline);

    // When CPL barely moved there is no movement to attribute, and naming a driver
    // anyway reads as a diagnosis of something that did not happen. Keep the component
    // deltas — the creative flag reads CTR out of them — but withhold the headline.
    if (signal.cplDelta !== null && signal.cplDelta !== Infinity
        && Math.abs(signal.cplDelta) < c.minCplDeltaForDriver) {
        signal.drivers.dominant = null;
        signal.drivers.dominantWorsened = null;
    }

    // Creative health, one of the few genuinely account-level calls available without
    // ad-level rows. Frequency decides the wording, not whether we flag it at all: a
    // tired creative and an exhausted audience both end with someone opening the
    // account and looking at the ads.
    //
    // This runs BEFORE the volume gate deliberately. CTR is measured over impressions,
    // not conversions, so it stays readable on accounts whose lead counts are far too
    // thin to judge CPL — and those are precisely the accounts most likely to be
    // quietly running one tired ad with nobody watching.
    const dr = signal.drivers;
    if (dr && dr.ctr !== null && dr.ctr <= c.ctrFatigueDelta && recent.impressions >= c.minFatigueImpressions) {
        const saturating = (dr.frequency !== null && dr.frequency >= c.saturationFrequencyDelta)
            || (dr.recentFrequency !== null && dr.recentFrequency >= c.saturationFrequency);
        const drop = Math.abs(dr.ctr * 100).toFixed(0);
        signal.flags.push('CREATIVE');
        const freqMove = dr.frequency === null ? ''
            : ` (${dr.frequency >= 0 ? '+' : ''}${(dr.frequency * 100).toFixed(0)}%)`;
        signal.notes.push(saturating
            ? `CTR down ${drop}% with daily frequency ${dr.recentFrequency === null ? 'rising' : dr.recentFrequency.toFixed(1)}`
              + `${freqMove} — the same people are seeing it too often`
            : `CTR down ${drop}% on flat frequency — the creative is losing people, not the audience running out`);
    }

    // The volume gate, now that we know what this spend was worth in leads. Baseline
    // leads still matter separately: they are what makes the baseline CPL — and so the
    // expectation itself — worth trusting.
    if (expected < c.minExpectedLeads || baseline.leads < c.minBaselineLeads) {
        signal.notes.push(`$${recent.spend.toFixed(0)} spend implies only ${expected.toFixed(1)} expected leads against ${baseline.leads} in the baseline — too thin to read anything into the CPL`);
        // Drop the CPL statistics rather than print figures we have just called
        // unreliable. A creative flag survives, because it never rested on them.
        signal.z = null;
        signal.drivers.dominant = null;
        signal.drivers.dominantWorsened = null;
        signal.verdict = signal.flags.length ? 'WATCH' : 'INSUFFICIENT_VOLUME';
        return signal;
    }

    const z = signal.z, d = signal.cplDelta;
    const bothWays = (zLimit, dLimit, worse) =>
        z !== null && d !== null && (worse ? (z <= zLimit && d >= dLimit) : (z >= zLimit && d <= dLimit));

    if (bothWays(c.criticalZ, c.criticalCplDelta, true)) {
        signal.verdict = 'CRITICAL';
    } else if (bothWays(c.watchZ, c.watchCplDelta, true)) {
        signal.verdict = 'WATCH';
    } else if (bothWays(c.improvingZ, c.improvingCplDelta, false)) {
        // Cheaper leads on *steady* budget is a real efficiency gain and the only
        // state that earns a scale recommendation. Cheaper leads because we tripled
        // the budget is just more budget — and cheaper leads because we halved it is
        // usually the cut itself, since a smaller budget stops buying the expensive
        // end of the inventory. Both fail the band; only the middle is a real win.
        const steadySpend = signal.spendDelta !== null
            && signal.spendDelta <= c.scaleSpendCeiling
            && signal.spendDelta >= c.scaleSpendFloor;
        signal.verdict = steadySpend ? 'SCALE_CANDIDATE' : 'IMPROVING';

        if (!steadySpend && signal.spendDelta !== null && signal.spendDelta < c.scaleSpendFloor) {
            signal.notes.push(`the gain came on ${Math.abs(signal.spendDelta * 100).toFixed(0)}% less daily spend, so it may be the cut rather than an improvement — scaling back up could undo it`);
        }
    }

    if (signal.targetCpl && recent.cpl !== null) {
        signal.notes.push(recent.cpl > signal.targetCpl
            ? `$${recent.cpl.toFixed(0)} CPL is above the $${signal.targetCpl.toFixed(0)} target`
            : `$${recent.cpl.toFixed(0)} CPL is inside the $${signal.targetCpl.toFixed(0)} target`);
    }
    if (signal.spendDelta !== null && Math.abs(signal.spendDelta) >= 0.25) {
        signal.notes.push(`daily spend ${signal.spendDelta > 0 ? 'up' : 'down'} ${Math.abs(signal.spendDelta * 100).toFixed(0)}% — expect CPL to move with it`);
    }

    // A creative going off the boil shows up in CTR days before it shows up in
    // CPL. Surfacing it while the verdict is still STABLE is the whole point —
    // by the time CPL moves, a week of budget has already gone through it.
    if (signal.flags.length && signal.verdict === 'STABLE') signal.verdict = 'WATCH';

    return signal;
}


const VERDICT_ORDER = ['CRITICAL', 'SPEND_STOPPED', 'WATCH', 'SCALE_CANDIDATE', 'IMPROVING',
                       'DATA_STALE', 'DATA_GAPS', 'STABLE', 'INSUFFICIENT_VOLUME', 'NO_SPEND'];

// Spelled out for the model, so it never has to infer what a label means.
const VERDICT_LABEL = {
    CRITICAL:            'CRITICAL — materially fewer leads than this spend should have bought, and CPL is up sharply',
    SPEND_STOPPED:       'SPEND STOPPED — delivery has all but halted against baseline. Operational problem, not a performance one',
    WATCH:               'WATCH — either drifting the wrong way while still inside normal variance, or CPL is holding but the creative signal underneath it is not. The second kind is an early warning: act before it reaches CPL',
    SCALE_CANDIDATE:     'SCALE CANDIDATES — cheaper leads without extra budget, so the efficiency gain is real',
    IMPROVING:           'IMPROVING — cheaper leads, but the budget moved too much to call it efficiency. Read the note: either spend rose (so this is volume, not a better account) or spend was cut (so the cut itself probably bought the cheaper leads)',
    DATA_STALE:          'DATA STALE — no recent rows. Check the Make daily pull before reading anything into these',
    DATA_GAPS:           'DATA GAPS — too many missing days to judge. Check the Make daily pull',
    STABLE:              'STABLE — inside normal variance, nothing to do',
    INSUFFICIENT_VOLUME: 'INSUFFICIENT VOLUME — this spend buys too few expected leads, or the baseline holds too few, for any verdict to mean anything',
    NO_SPEND:            'NO SPEND — nothing running in either window'
};

const NO_VERDICT = ['DATA_STALE', 'DATA_GAPS', 'STABLE', 'INSUFFICIENT_VOLUME', 'NO_SPEND'];

const fmtMoney = (v) => (v === null || v === undefined) ? 'n/a' : `$${Number(v).toFixed(0)}`;
const fmtNum   = (v, dp = 1) => (v === null || v === undefined) ? 'n/a' : Number(v).toFixed(dp);
const fmtPct   = (v) => (v === null || v === undefined) ? 'n/a'
    : (v === Infinity ? 'no leads at all' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`);


export function buildAuditContext(signals) {
    const rows = signals;
    const w = rows.length ? rows[0].window : null;

    let md = `[AUDIT DATE: ${new Date().toISOString().split('T')[0]}]\n`;
    if (w) {
        md += `[REPORTING WINDOW: ${w.recentFrom} to ${w.recentTo}, measured against ${w.baselineFrom} to ${w.baselineTo}]\n`;
        // Per-client staleness is caught by DATA_STALE, but that compares each
        // client to the others — if the pull fails for everyone at once the
        // anchor simply slides back and nobody looks behind. This is the only
        // place that catch shows up.
        const behind = todayDayNumber() - toDayNumber(w.recentTo);
        if (behind > AUDIT_CONFIG.lagDays + 1) {
            md += `[WARNING: the newest ad data is ${behind} days old, so the daily pull has probably not run. Say this first — everything below describes ${w.recentTo}, not today.]\n`;
        }
    }
    md += `[The window ends on the last day the daily pull delivered, so it is as current as the data gets. Days still in progress are excluded — they carry full spend against a fraction of their leads. Do not comment on this.]\n`;
    md += `[Every verdict below was computed in code and is authoritative. "signal" is how many standard deviations the lead count landed from what the baseline predicted for this spend; roughly -2 is a one-in-forty week. Do not recalculate anything, and do not second-guess a label.]\n`;
    md += `[Where a "driver" is given, CPL has been decomposed exactly into the three things that can move it — CPM (auction cost), CTR (people clicking), CVR (clicks becoming leads). The named driver is the one that moved it most. Use it to say what to go and look at: CPM means auction or targeting, CTR means creative or a saturated audience, CVR means the landing page or form rather than the ads.]\n\n`;

    const grouped = {};
    rows.forEach(s => { (grouped[s.verdict] = grouped[s.verdict] || []).push(s); });

    VERDICT_ORDER.forEach(verdict => {
        const group = grouped[verdict];
        if (!group || !group.length) return;

        md += `## ${VERDICT_LABEL[verdict]} (${group.length})\n`;

        if (NO_VERDICT.includes(verdict)) {
            // No action available, so no numbers are worth the tokens — a name
            // and a reason is the whole story.
            group.forEach(s => {
                md += `${s.name}${s.notes.length ? ` — ${s.notes.join('; ')}` : ''}\n`;
            });
        } else {
            // Fields that do not apply to a verdict are omitted rather than
            // printed as "n/a" — a column of n/a is tokens spent teaching the
            // model to skim.
            group.forEach(s => {
                const parts = [s.name, `spend ${fmtMoney(s.recent.spend)}`];
                parts.push(s.expectedLeads !== null
                    ? `${s.recent.leads} leads vs ${fmtNum(s.expectedLeads)} expected`
                    : `${s.recent.leads} leads`);
                if (s.baseline.cpl !== null) {
                    parts.push(`CPL ${s.recent.cpl === null ? 'none' : fmtMoney(s.recent.cpl)} vs ${fmtMoney(s.baseline.cpl)} baseline`
                        + (s.cplDelta !== null ? ` (${fmtPct(s.cplDelta)})` : ''));
                }
                if (s.z !== null) parts.push(`signal ${fmtNum(s.z)}`);
                if (s.spendDelta !== null) parts.push(`spend ${fmtPct(s.spendDelta)}`);
                if (s.drivers && s.drivers.dominant) {
                    const d = s.drivers;
                    const meaning = DRIVER_MEANING[d.dominant][d.dominantWorsened ? 'worse' : 'better'];
                    parts.push(`driver ${d.dominant.toUpperCase()} (${meaning})`);
                    parts.push(`CPM ${fmtPct(d.cpm)}, CTR ${fmtPct(d.ctr)}, CVR ${fmtPct(d.cvr)}`);
                }
                parts.push(s.targetCpl ? `target ${fmtMoney(s.targetCpl)}` : 'no CPL target set');
                parts.push(s.healthScore ? `health ${s.healthScore}/100` : 'health unknown');
                if (s.notes.length) parts.push(s.notes.join('; '));
                md += parts.join(' | ') + '\n';
            });
        }
        md += `\n`;
    });

    return md;
}

export { AUDIT_CONFIG, computeClientSignal, resolveAuditAnchor, toDayNumber, todayDayNumber, summarizeWindow, decomposeCplChange };
// ==== END SHARED ENGINE ====
