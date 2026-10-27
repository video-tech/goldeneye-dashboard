// Validates a "send the homeowner a link" request from the portal. No imports beyond the
// deck-estimate validator (itself import-free), so it runs under plain node in the tests.
//
// What is stored is what the homeowner will read, so everything is re-checked here and nothing is
// taken on trust from the browser: the line items must add up to the total and qty x rate must
// equal each amount (the same checks the QuickBooks path uses, by calling the same function),
// every string is stripped of control characters and length-capped, and the date is the
// server's, not the browser's.

import { validateEstimate, type LineItem } from "../deck-estimate/validate.ts";

export type Alternative = { label: string; name: string; low: number; high: number };

export type Snapshot = {
    v: 1;
    business: string;
    phone: string;
    date: string;            // YYYY-MM-DD, the day the link was made (Mountain time)
    prepared_for: string;
    total_sqft: number | null;
    deck_levels: number | null;
    line_items: LineItem[];
    total: number;           // the top of the range; the line items add up to it
    price_low: number | null;
    inclusions: string[];
    notes: string;
    alternatives: Alternative[];
};

export type Shared =
    | { ok: true; value: { prepared_for: string; total: number; snapshot: Snapshot } }
    | { ok: false; errors: string[] };

function clean(v: unknown, max: number): string {
    if (typeof v !== "string") return "";
    return v.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, max);
}

function money(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 5_000_000 ? Math.round(v * 100) / 100 : null;
}

// The day in Mountain time, so a link made at 8pm doesn't say tomorrow's date.
export function mountainDate(now: Date): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function validateShare(input: unknown, now: Date): Shared {
    const src = (input && typeof input === "object") ? input as Record<string, any> : {};
    const errors: string[] = [];

    // The line items, total and notes go through the very same checks as a QuickBooks estimate.
    // The customer is a stand-in: a homeowner link needs no email, only the estimate itself.
    const v = validateEstimate({
        customer: { first_name: "Homeowner", last_name: "Link", email: "homeowner@example.com" },
        line_items: src.line_items, total: src.total, price_low: src.price_low, notes: src.notes,
        summary: {},
    });
    if (!v.ok) errors.push(...v.errors);

    const inclusions: string[] = [];
    if (src.inclusions !== undefined && src.inclusions !== null) {
        if (!Array.isArray(src.inclusions) || src.inclusions.length > 20) errors.push("The included-items list is invalid.");
        else for (const x of src.inclusions) { const s = clean(x, 200); if (s) inclusions.push(s); }
    }

    const alternatives: Alternative[] = [];
    if (src.alternatives !== undefined && src.alternatives !== null) {
        if (!Array.isArray(src.alternatives) || src.alternatives.length > 5) errors.push("The material comparison is invalid.");
        else for (const a of src.alternatives) {
            const low = money(a?.low), high = money(a?.high), label = clean(a?.label, 30), name = clean(a?.name, 80);
            if (low === null || high === null || !label || !name || low > high) { errors.push("A material comparison row is invalid."); break; }
            alternatives.push({ label, name, low, high });
        }
    }

    if (errors.length || !v.ok) return { ok: false, errors };

    const sqft = typeof src.total_sqft === "number" && Number.isFinite(src.total_sqft) && src.total_sqft >= 0 && src.total_sqft <= 1_000_000 ? src.total_sqft : null;
    const lv = typeof src.deck_levels === "number" && Number.isInteger(src.deck_levels) && src.deck_levels >= 1 && src.deck_levels <= 10 ? src.deck_levels : null;
    const prepared = clean(src.prepared_for, 80);

    return {
        ok: true,
        value: {
            prepared_for: prepared,
            total: v.value.total,
            snapshot: {
                v: 1,
                business: clean(src.business, 80),
                phone: clean(src.phone, 40),
                date: mountainDate(now),
                prepared_for: prepared,
                total_sqft: sqft,
                deck_levels: lv,
                line_items: v.value.line_items,
                total: v.value.total,
                price_low: v.value.price_low,
                inclusions,
                notes: v.value.notes ?? "",
                alternatives,
            },
        },
    };
}

export function validToken(t: unknown): t is string {
    return typeof t === "string" && /^[0-9a-f]{64}$/.test(t);
}
