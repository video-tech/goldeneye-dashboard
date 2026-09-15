// Pure parsing for SE Ranking's responses — no imports, no I/O, so it can be tested with
// fixed JSON and no network. index.ts is the only caller; kept separate the same way
// morning-audit/engine.js is kept separate from that function's index.ts, and for the
// same reason: a shape SE Ranking changes should be provable with a JSON fixture, not by
// standing up the whole edge function.
//
// Every function here is defensive: a field SE Ranking omits or renames should produce a
// null/empty result, never a thrown exception, because one unexpected field must not take
// down every other client's sync. The one exception is a completely wrong top-level shape
// (not an array, no `data` array) — that throws on purpose, so the caller's per-client
// try/catch writes the real response into seo_sync_state.last_error instead of silently
// storing zero rows.

// SE Ranking sometimes wraps a list in {data: [...]}, sometimes returns the array bare —
// seen both shapes across their own docs examples for different endpoints.
function asArray(body: unknown): any[] {
    if (Array.isArray(body)) return body;
    if (body && typeof body === "object" && Array.isArray((body as any).data)) return (body as any).data;
    throw new Error(`expected an array, got: ${JSON.stringify(body).slice(0, 300)}`);
}

export interface SearchEngineRow {
    site_engine_id: number;
    label: string | null;
    device: string | null;
}

// A real response, captured this session via the MCP (same underlying data, a different
// auth path): {"site_engine_id":386614,"search_engine_id":200,"region_id":0,
// "region_name":null,"lang_code":"en","merge_map":0,"business_name":null,"phone":null,
// "paid_results":0,"keyword_count":19}. region_name is the human label when set (a null
// region_id/region_name pair means "no specific city" — a national project like Midas's
// own). There is no separate device field in that shape; SE Ranking encodes desktop vs
// mobile inside which search_engine_id was chosen, not as an attribute alongside it — so
// `device` stays null until that mapping is worth building out.
export function parseSearchEngines(raw: unknown): SearchEngineRow[] {
    return asArray(raw).map((e: any) => ({
        site_engine_id: Number(e?.site_engine_id),
        label: e?.region_name ? String(e.region_name) : null,
        device: null,
    })).filter((e) => Number.isFinite(e.site_engine_id));
}

export interface KeywordRow {
    seranking_keyword_id: number;
    keyword: string;
    site_engine_ids: number[];
    // The page we want ranking for this keyword ("Target URL" in SE Ranking, `link` in the API).
    // Null when none is set. Compared with ranking_url to flag the wrong page ranking.
    target_page: string | null;
}

// A real response, captured the same way: {"id":"17705872","name":"midas media",
// "group_id":"374584","link":null,"first_check_date":null,"tags":[],
// "site_engine_ids":[386614]}. id and group_id arrive as STRINGS despite being numeric —
// Number() them rather than storing the string. site_engine_ids is explicit per keyword:
// a keyword is NOT automatically checked against every engine on the project the way an
// earlier version of this schema's comments assumed. That's corrected here; it changes
// nothing about how seo_rank_checks stores results, since that table is keyed by
// whichever (keyword, site_engine_id) pairs actually come back with position data.
export function parseKeywords(raw: unknown): KeywordRow[] {
    return asArray(raw).map((k: any) => ({
        seranking_keyword_id: Number(k?.id),
        keyword: String(k?.name ?? "").trim().toLowerCase(),
        site_engine_ids: Array.isArray(k?.site_engine_ids) ? k.site_engine_ids.map(Number) : [],
        target_page: typeof k?.link === "string" && k.link.trim() ? k.link.trim() : null,
    })).filter((k) => k.keyword && Number.isFinite(k.seranking_keyword_id));
}

// Keywords Golden Eye still has as active that SE Ranking no longer tracks — removed there, so
// retired here. Returns the keyword texts to mark inactive. Never retires anything when SE Ranking
// returned no keywords at all: an empty list is far more likely a hiccup than a deleted project,
// and wiping a client's whole keyword table on a bad response would be hard to notice.
export function keywordsToRetire(activeInGoldenEye: string[], fromSeRanking: KeywordRow[]): string[] {
    if (!fromSeRanking.length) return [];
    const still = new Set(fromSeRanking.map((k) => k.keyword));
    return activeInGoldenEye.filter((k) => !still.has(String(k).trim().toLowerCase()));
}

// Same page, however it was typed: protocol, "www.", trailing slash, query string and case don't
// make it a different page. Used for the wrong-page check so a target of
// "3sixty-industries.com/services/pergola-builds/" matches a ranking URL of
// "https://www.3sixty-industries.com/services/pergola-builds".
export function samePage(a: string | null | undefined, b: string | null | undefined): boolean {
    const norm = (u: string | null | undefined) => {
        if (!u) return "";
        let s = String(u).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
        s = s.split("#")[0].split("?")[0];
        return s.replace(/\/+$/, "");
    };
    const x = norm(a), y = norm(b);
    return !!x && x === y;
}

export interface RankCheckRow {
    keyword: string;
    date: string;
    organic_rank: number | null;
    map_rank: number | null;
    ranking_url: string | null;
}

// Confirmed against a real 3Sixty response on 2026-09-14:
//   [{site_engine_id, keywords: [{id, name, positions: [{date, pos, is_map, map_position, ...}],
//     landing_pages: [{url, ascii_url, date}] }]}]
// Position 0 means "not ranking that day" (SE Ranking's UI shows a dash), so it's stored as
// null, never 0.
//
// landing_pages sits on the KEYWORD, not on each position, and holds objects, not strings.
// The first version read p.landing_pages, which is always undefined, so every ranking_url was
// null. Each entry's `date` is when SE Ranking first saw that page ranking, and a keyword can
// switch pages ("pergola builder logan ut" moved from custom-outdoor-living-projects to
// pergola-builds the next day). So each day gets the latest page seen on or before it.
//
// A completely wrong top-level shape still throws with the raw body, which the caller writes
// to last_error rather than silently storing zero rows.
function landingPageFor(pages: any[], date: string): string | null {
    let best: { url: string; date: string } | null = null;
    for (const lp of pages) {
        const url = typeof lp === "string" ? lp : lp?.url;
        if (!url) continue;
        const seen = typeof lp === "string" ? "" : String(lp?.date ?? "").slice(0, 10);
        if (seen && seen > date) continue;
        if (!best || seen >= best.date) best = { url: String(url), date: seen };
    }
    return best?.url ?? null;
}

export function parsePositions(raw: unknown, keywordById: Map<number, string>): RankCheckRow[] {
    const engines = asArray(raw);
    const out: RankCheckRow[] = [];
    for (const engine of engines) {
        const keywords = Array.isArray(engine?.keywords) ? engine.keywords : [];
        for (const kw of keywords) {
            const keywordText = keywordById.get(Number(kw?.id));
            if (!keywordText) continue; // a keyword id we don't have on file — skip, don't guess a name
            const points = Array.isArray(kw?.positions) ? kw.positions : [];
            const pages = Array.isArray(kw?.landing_pages) ? kw.landing_pages : [];
            for (const p of points) {
                const date = String(p?.date ?? "").slice(0, 10);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
                const organic = Number(p?.pos);
                const map = Number(p?.map_position);
                const organicRank = Number.isFinite(organic) && organic > 0 ? organic : null;
                const mapRank = (p?.is_map && Number.isFinite(map) && map > 0) ? map : null;
                out.push({
                    keyword: keywordText,
                    date,
                    organic_rank: organicRank,
                    map_rank: mapRank,
                    // A page only means something on a day the keyword actually ranked.
                    ranking_url: (organicRank != null || mapRank != null) ? landingPageFor(pages, date) : null,
                });
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Keyword metrics: search volume and cost per click
// ---------------------------------------------------------------------------
// The positions response already carries these per keyword, and the first version threw them
// away. Real 3Sixty response (2026-09-14): {"volume":170,"competition":0.95,"suggested_bid":13.5,
// "cpc":13.5,...}. SE Ranking's docs show only suggested_bid, so cpc falls back to it. Volume 0
// is how SE Ranking reports a search too small to measure, so it's stored as null (unknown), not
// as "nobody searches this". A keyword tracked in several locations keeps its highest figures.
export interface KeywordMetricRow {
    keyword: string;
    search_volume: number | null;
    cpc: number | null;
    competition: number | null;
}

export function parseKeywordMetrics(raw: unknown, keywordById: Map<number, string>): KeywordMetricRow[] {
    const byKeyword = new Map<string, KeywordMetricRow>();
    const pos = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
    const max = (a: number | null, b: number | null) => a == null ? b : b == null ? a : Math.max(a, b);
    for (const engine of asArray(raw)) {
        for (const kw of Array.isArray(engine?.keywords) ? engine.keywords : []) {
            const keyword = keywordById.get(Number(kw?.id));
            if (!keyword) continue;
            const row = {
                keyword,
                search_volume: pos(kw?.volume),
                cpc: pos(kw?.cpc) ?? pos(kw?.suggested_bid),
                competition: pos(kw?.competition),
            };
            const prev = byKeyword.get(keyword);
            byKeyword.set(keyword, prev ? {
                keyword,
                search_volume: max(prev.search_volume, row.search_volume),
                cpc: max(prev.cpc, row.cpc),
                competition: max(prev.competition, row.competition),
            } : row);
        }
    }
    return [...byKeyword.values()];
}

// ---------------------------------------------------------------------------
// Project summary: one daily snapshot of visibility and authority
// ---------------------------------------------------------------------------
// GET /sites/summary?site_id=. Real 3Sixty response (2026-09-14): {"site_id":12904139,"process":40,
// "today_avg":71,"yesterday_avg":63,"top5":0,"top10":0,"top30":1,"visibility":0,
// "visibility_percent":0,"index_google":"102","domain_trust":7}. SE Ranking's docs name the
// authority field "da" instead, so both are read. index_google arrives as a string.
export interface ProjectSnapshot {
    visibility_percent: number | null;
    visibility: number | null;
    top5: number | null;
    top10: number | null;
    top30: number | null;
    avg_position: number | null;
    domain_trust: number | null;
    pages_indexed: number | null;
}

export function parseSummary(raw: unknown): ProjectSnapshot {
    const body: any = Array.isArray(raw) ? raw[0] : (raw && typeof raw === "object" && (raw as any).data && !Array.isArray((raw as any).data) ? (raw as any).data : raw);
    if (!body || typeof body !== "object") throw new Error(`expected a project summary, got: ${JSON.stringify(raw).slice(0, 300)}`);
    const n = (v: unknown) => { if (v === null || v === undefined || v === "") return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
    return {
        visibility_percent: n(body.visibility_percent),
        visibility: n(body.visibility),
        top5: n(body.top5),
        top10: n(body.top10),
        top30: n(body.top30),
        // 0 means no ranked keywords to average, not position 0
        avg_position: n(body.today_avg) || null,
        domain_trust: n(body.domain_trust) ?? n(body.da),
        pages_indexed: n(body.index_google),
    };
}

// ---------------------------------------------------------------------------
// Competitors
// ---------------------------------------------------------------------------
// Three endpoints, all Project API (no units), documented at seranking.com/api/project/competitors:
//   GET /competitors?site_id=                                    -> parseCompetitors
//   GET /competitors/positions?competitor_id=&date_from=&date_to= -> parseCompetitorPositions
//   GET /competitors/metrics?site_id=&date=&site_engine_id=       -> parseTop10Domains

export interface CompetitorRow {
    seranking_competitor_id: number;
    name: string | null;
    url: string | null;
    domain: string | null;
    domain_trust: number | null;
}

// Documented shape: [{"id":1,"name":"competitor1.com","url":"competitor1.com","domain_trust":2}].
// `url` may or may not carry a protocol, so the comparable host is derived rather than trusted.
export function competitorDomain(url: unknown): string | null {
    const s = String(url ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
    const host = s.split("/")[0].split("?")[0].split("#")[0];
    return host.includes(".") ? host : null;
}

export function parseCompetitors(raw: unknown): CompetitorRow[] {
    const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
    return asArray(raw).map((c: any) => ({
        seranking_competitor_id: Number(c?.id),
        name: c?.name ? String(c.name) : null,
        url: c?.url ? String(c.url) : null,
        domain: competitorDomain(c?.url ?? c?.name),
        domain_trust: n(c?.domain_trust),
    })).filter((c) => Number.isFinite(c.seranking_competitor_id));
}

export interface CompetitorRankRow {
    keyword: string;
    site_engine_id: number;
    date: string;
    rank: number | null;
}

// Documented shape: [{"site_engine_id":123,"keywords":[{"id":"123","positions":[{"date":"2018-07-25",
// "pos":7,"change":1}],"name":null,"volume":null}]}] — the same nesting as our own positions call,
// so the keyword name is resolved through the project's keyword ids rather than the `name` field,
// which the docs show as null.
//
// There is NO is_map / map_position here, unlike our own positions response: SE Ranking reports a
// competitor's organic rank only. A competitor holding a map-pack spot is therefore invisible, and
// nothing downstream may present this as "they don't rank".
export function parseCompetitorPositions(raw: unknown, keywordById: Map<number, string>): CompetitorRankRow[] {
    const out: CompetitorRankRow[] = [];
    for (const engine of asArray(raw)) {
        const siteEngineId = Number(engine?.site_engine_id);
        if (!Number.isFinite(siteEngineId)) continue;
        for (const kw of Array.isArray(engine?.keywords) ? engine.keywords : []) {
            const keyword = keywordById.get(Number(kw?.id));
            if (!keyword) continue;
            for (const p of Array.isArray(kw?.positions) ? kw.positions : []) {
                const date = String(p?.date ?? "").slice(0, 10);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
                const pos = Number(p?.pos);
                // 0 is SE Ranking's "not ranking", the same sentinel as our own positions
                out.push({ keyword, site_engine_id: siteEngineId, date, rank: Number.isFinite(pos) && pos > 0 ? pos : null });
            }
        }
    }
    return out;
}

export interface Top10DomainRow {
    domain: string;
    visibility: number | null;
    backlinks: number | null;
    ref_domains: number | null;
}

// Documented shape: [{"domain":"www.tests.com","domain_id":10,"visibility":0,"backlinks":"328",
// "domains":"32"}]. backlinks and domains arrive as strings. This snapshot is only kept about 14
// days by SE Ranking, so storing it daily is the entire point — it can't be fetched back later.
export function parseTop10Domains(raw: unknown): Top10DomainRow[] {
    const n = (v: unknown) => { if (v === null || v === undefined || v === "") return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
    const seen = new Set<string>();
    const out: Top10DomainRow[] = [];
    for (const d of asArray(raw)) {
        const domain = String(d?.domain ?? "").trim().toLowerCase();
        // The primary key is (client, date, engine, domain), so a repeated domain would make the
        // whole upsert fail with "cannot affect row a second time". First one wins.
        if (!domain || seen.has(domain)) continue;
        seen.add(domain);
        out.push({ domain, visibility: n(d?.visibility), backlinks: n(d?.backlinks), ref_domains: n(d?.domains) });
    }
    return out;
}

// ---------------------------------------------------------------------------
// SEO potential: extra traffic and its ad value if every tracked keyword reached the top N
// ---------------------------------------------------------------------------
// GET /analytics/seo-potential?site_id=&top_n=3. Real 3Sixty response (2026-09-14):
// {"data":[{"site_engine_id":389452,"traffic":42,"traffic_value":403.92,"leads_qty":0,"leads_price":0}]}.
// One row per tracked location, summed for the client.
export function parsePotential(raw: unknown): { traffic: number; value: number } {
    let traffic = 0, value = 0;
    for (const r of asArray(raw)) {
        traffic += Number(r?.traffic) || 0;
        value += Number(r?.traffic_value) || 0;
    }
    return { traffic: Math.round(traffic), value: Math.round(value * 100) / 100 };
}
