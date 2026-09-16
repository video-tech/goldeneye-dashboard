// Google Business Profile data from SE Ranking's Local Marketing API, shaped for the gbp_* tables.
// No imports, so it's testable against fixed JSON (real Midas responses in the tests).
//
// Local Marketing endpoints cost no API credits; each client's profile has to be added as a
// location in SE Ranking → Local Marketing, which uses the plan's location allowance.

export const LOCAL_BASE = "https://api.seranking.com/v1/local-marketing";

const int = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return isFinite(n) ? Math.round(n) : null;
};
const isoDate = (v: unknown): string | null => {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ""));
    return m ? m[1] : null;
};

// /locations/{id}/gbp-metrics → one row per day. A day SE Ranking lists with no metrics object is
// skipped rather than stored as zeros.
export function parseGbpMetrics(client: string, body: any) {
    if (!body || !Array.isArray(body.items)) throw new Error("gbp-metrics: no items list in the response");
    return body.items.flatMap((it: any) => {
        const date = isoDate(it?.date);
        const m = it?.metrics;
        if (!date || !m || typeof m !== "object") return [];
        return [{
            client_name: client,
            date,
            impressions_search_mobile: int(m.business_impressions_mobile_search) ?? 0,
            impressions_search_desktop: int(m.business_impressions_desktop_search) ?? 0,
            impressions_maps_mobile: int(m.business_impressions_mobile_maps) ?? 0,
            impressions_maps_desktop: int(m.business_impressions_desktop_maps) ?? 0,
            calls: int(m.call_clicks) ?? 0,
            website_clicks: int(m.website_clicks) ?? 0,
            direction_requests: int(m.business_direction_requests) ?? 0,
            conversations: int(m.business_conversations) ?? 0,
        }];
    });
}

// /gbp-searches → one row per month. Google withholds small numbers, so null stays null.
export function parseGbpSearches(client: string, body: any) {
    if (!body || !Array.isArray(body.items)) throw new Error("gbp-searches: no items list in the response");
    return body.items.flatMap((it: any) => {
        const month = isoDate(it?.month);
        if (!month) return [];
        return [{ client_name: client, month, direct: int(it.direct), discovery: int(it.discovery), branded: int(it.branded) }];
    });
}

// /gbp-keywords for one calendar month → one row per search term. Google reports these monthly and
// hides impressions under its threshold (null, not 0).
export function parseGbpKeywords(client: string, month: string, body: any) {
    if (!body || !Array.isArray(body.items)) throw new Error("gbp-keywords: no items list in the response");
    const byKeyword = new Map<string, any>();
    for (const it of body.items) {
        const keyword = String(it?.keyword ?? "").trim().toLowerCase();
        if (!keyword) continue;
        const prev = byKeyword.get(keyword);
        const impressions = int(it.impressions), clicks = int(it.clicks);
        if (!prev) { byKeyword.set(keyword, { client_name: client, month, keyword, impressions, clicks }); continue; }
        prev.impressions = prev.impressions === null && impressions === null ? null : (prev.impressions ?? 0) + (impressions ?? 0);
        prev.clicks = prev.clicks === null && clicks === null ? null : (prev.clicks ?? 0) + (clicks ?? 0);
    }
    return { rows: [...byKeyword.values()], next: body.next_page_token ? String(body.next_page_token) : null };
}

// /reviews/overview (no dates = the whole history) → today's snapshot.
export function parseReviewsOverview(client: string, date: string, body: any) {
    if (!body || typeof body !== "object" || body.total_reviews === undefined) throw new Error("reviews/overview: unexpected response");
    // rating_distribution under-counts in SE Ranking's API; items_by_source sums correctly
    const bySource = Array.isArray(body.items_by_source) ? body.items_by_source : [];
    const sourceTotal = bySource.reduce((a: number, s: any) => a + (int(s?.reviews_count) ?? 0), 0);
    return {
        client_name: client,
        date,
        total_reviews: Math.max(int(body.total_reviews) ?? 0, sourceTotal),
        average_rating: body.average_rating === null || body.average_rating === undefined ? null : Math.round(Number(body.average_rating) * 100) / 100,
        answered_reviews: int(body.answered_reviews) ?? 0,
        unanswered_reviews: int(body.unanswered_reviews) ?? 0,
    };
}

// /reviews → one row per review, Google Business Profile reviews only for now (source gmb).
export function parseReviews(client: string, body: any) {
    if (!body || !Array.isArray(body.items)) throw new Error("reviews: no items list in the response");
    return body.items.flatMap((r: any) => {
        const id = int(r?.id);
        if (id === null || !r.created_at) return [];
        return [{
            client_name: client,
            review_id: id,
            source: String(r.source ?? ""),
            rating: int(r.rating),
            review_text: r.review ? String(r.review).slice(0, 4000) : null,
            reviewer_name: r.reviewer_name ? String(r.reviewer_name).slice(0, 200) : null,
            created_at: String(r.created_at),
            is_answered: r.is_answered === true,
            replied_at: r.replied_at ? String(r.replied_at) : null,
            review_url: /^https?:\/\//i.test(String(r.review_url ?? "")) ? String(r.review_url) : null,
        }];
    });
}

// Calendar months (YYYY-MM-01) from `months` back through the month before `today`, oldest first.
// The current month is left out: Google's keyword report only covers finished months.
export function monthsBack(today: Date, months: number): { month: string; from: string; to: string }[] {
    const out = [];
    for (let i = months; i >= 1; i--) {
        const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
        const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i + 1, 0));
        out.push({ month: start.toISOString().slice(0, 10), from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) });
    }
    return out;
}
