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
    })).filter((k) => k.keyword && Number.isFinite(k.seranking_keyword_id));
}

export interface RankCheckRow {
    keyword: string;
    date: string;
    organic_rank: number | null;
    map_rank: number | null;
    ranking_url: string | null;
}

// UNCONFIRMED against a live call — SE Ranking's own docs describe (not show in full) an
// array of {site_engine_id, keywords: [{id, positions: [{date, pos, is_map, map_position,
// landing_pages, ...}]}]}. Position 0 or absent means "not ranking that day", which SE
// Ranking's UI shows as a dash, not a 100 — kept as null here rather than guessing a
// sentinel number. landing_pages may be a string or an array depending on how many pages
// ranked; the first one is what's stored, matching what the admin tab needs (one
// cross-check page per keyword, not a list). If this shape is wrong, this throws with the
// raw body attached, which the caller writes to last_error — visible from the SQL Editor
// rather than a silent zero rows.
export function parsePositions(raw: unknown, keywordById: Map<number, string>): RankCheckRow[] {
    const engines = asArray(raw);
    const out: RankCheckRow[] = [];
    for (const engine of engines) {
        const keywords = Array.isArray(engine?.keywords) ? engine.keywords : [];
        for (const kw of keywords) {
            const keywordText = keywordById.get(Number(kw?.id));
            if (!keywordText) continue; // a keyword id we don't have on file — skip, don't guess a name
            const points = Array.isArray(kw?.positions) ? kw.positions : [];
            for (const p of points) {
                const date = String(p?.date ?? "").slice(0, 10);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
                const organic = Number(p?.pos);
                const map = Number(p?.map_position);
                const landing = Array.isArray(p?.landing_pages) ? p.landing_pages[0] : p?.landing_pages;
                out.push({
                    keyword: keywordText,
                    date,
                    organic_rank: Number.isFinite(organic) && organic > 0 ? organic : null,
                    map_rank: (p?.is_map && Number.isFinite(map) && map > 0) ? map : null,
                    ranking_url: landing ? String(landing) : null,
                });
            }
        }
    }
    return out;
}
