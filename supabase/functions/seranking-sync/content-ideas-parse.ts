// Parsing + seed selection for the Content Ideas pull, dependency-free so it's testable against
// fixed JSON. Two SE Ranking Data API endpoints:
//   /v1/keywords/questions  -> { total, keywords: [{keyword, volume, cpc, difficulty, competition,
//                                 intents, serp_features}] }   -- 10 credits per RETURNED keyword
//   /v1/keywords/longtail   -> { total, keywords: ["...", "..."] }  -- 1 credit per RETURNED keyword,
//                                 strings only, no metrics
// (seranking.com/api/data/keyword-research). Cost is driven by rows actually returned, not the
// `limit` requested, so a niche seed with few real questions costs less than the cap suggests.

const int = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return isFinite(n) ? Math.round(n) : null;
};
const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
};

export function parseQuestionKeywords(client: string, seed: string, body: any) {
    if (!body || !Array.isArray(body.keywords)) throw new Error("keywords/questions: no keywords list in the response");
    return body.keywords.flatMap((k: any) => {
        const keyword = String(k?.keyword ?? "").trim().toLowerCase();
        if (!keyword) return [];
        return [{
            client_name: client, keyword, kind: "question", seed_keyword: seed,
            volume: int(k.volume), cpc: num(k.cpc), difficulty: int(k.difficulty), competition: num(k.competition),
            intents: Array.isArray(k.intents) ? k.intents.map(String) : null,
        }];
    });
}

export function parseLongtailKeywords(client: string, seed: string, body: any) {
    if (!body || !Array.isArray(body.keywords)) throw new Error("keywords/longtail: no keywords list in the response");
    return body.keywords.flatMap((raw: any) => {
        const keyword = String(raw ?? "").trim().toLowerCase();
        if (!keyword) return [];
        return [{ client_name: client, keyword, kind: "longtail", seed_keyword: seed, volume: null, cpc: null, difficulty: null, competition: null, intents: null }];
    });
}

// A question and a long-tail call can surface the same phrase for the same client. The question
// version carries real metrics, so it wins — losing the richer row to whichever call happened to
// run second would be a silent downgrade. Keyword text is the unique key regardless of kind.
export function mergeIdeaRows(rows: any[]): any[] {
    const byKeyword = new Map<string, any>();
    for (const r of rows) {
        const prev = byKeyword.get(r.keyword);
        if (!prev || (prev.kind === "longtail" && r.kind === "question")) byKeyword.set(r.keyword, r);
    }
    return [...byKeyword.values()];
}

// The client's own tracked keywords are the seeds — real searches they already care about, not a
// guess. Brand/company-name searches make poor seeds (their "related" and "question" results are
// about the business, not the service), so anything containing a token of the client's own name is
// skipped. Ties in volume break alphabetically, so the choice is stable run to run.
export function pickSeedKeywords(clientName: string, activeKeywords: { keyword: string; search_volume: number | null }[], count: number): string[] {
    const brandTokens = new Set(
        String(clientName ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter((t) => t.length > 2)
    );
    const isBrand = (kw: string) => {
        const tokens = kw.toLowerCase().split(/\s+/);
        return tokens.some((t) => brandTokens.has(t));
    };
    return activeKeywords
        .filter((k) => k.keyword && !isBrand(k.keyword))
        .sort((a, b) => (b.search_volume ?? -1) - (a.search_volume ?? -1) || a.keyword.localeCompare(b.keyword))
        .slice(0, count)
        .map((k) => k.keyword);
}

// The subscription endpoint's exact wrapper shape isn't guaranteed by the docs, so this reads
// either a bare object or one nested under subscription_info, and returns null (never 0, which
// would read as "out of units" and block every client) when it can't tell.
export function unitsLeft(body: any): number | null {
    const info = body?.subscription_info ?? body;
    const n = Number(info?.units_left);
    return isFinite(n) ? n : null;
}
