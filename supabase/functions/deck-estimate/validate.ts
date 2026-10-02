// Validates a "Create QuickBooks estimate" request from the portal. No imports, so it can be
// tested with plain node (see deck-estimate.test.ts).
//
// The browser builds this request, so nothing in it is trusted: every field is type-checked,
// length-capped and re-derived where it can be. The line items must add up to the total they
// claim, each line's qty x rate must equal its amount, and only the adjustment line may be
// negative. A rep could still type a different estimate straight into QuickBooks, so this isn't
// guarding the price; it guards the shape, so Make and QuickBooks only ever see well-formed data
// and a malformed request fails here with a readable reason instead of halfway through Make.

export const LINE_KINDS = [
    "decking", "footings", "railing", "steps", "waterproofing", "demo", "adjustment", "addon_tbd",
] as const;
const UNITS = ["sqft", "ea", "lf", "job"];

export type LineItem = {
    kind: string; description: string; qty: number; unit: string; rate: number; amount: number;
};
export type Customer = {
    first_name: string; last_name: string; email: string;
    phone: string | null; address: string | null; city: string | null; postal_code: string | null;
};
export type Summary = {
    total_sqft?: number; deck_levels?: number; material?: string; rail_type?: string;
    rail_lf?: number; steps?: number; addons?: string;
};
export type EstimateInput = {
    customer: Customer; line_items: LineItem[]; total: number; price_low: number | null;
    notes: string | null; summary: Summary;
};
export type Validated = { ok: true; value: EstimateInput } | { ok: false; errors: string[] };

const cents = (n: number) => Math.round(n * 100) / 100;

// Control characters out (they break QuickBooks fields and Make's raw-text modules, see CLAUDE.md
// "bad control character"), outer whitespace trimmed. Newlines kept only where asked.
function clean(v: unknown, keepNewlines = false): string {
    if (typeof v !== "string") return "";
    const stripped = keepNewlines
        ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
        : v.replace(/[\u0000-\u001F\u007F]/g, " ");
    return stripped.replace(/[ \t]+/g, " ").trim();
}

function num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function validateEstimate(input: unknown): Validated {
    const errors: string[] = [];
    const src = (input && typeof input === "object") ? input as Record<string, any> : {};

    // ---- customer ----
    const c = (src.customer && typeof src.customer === "object") ? src.customer : {};
    const first = clean(c.first_name), last = clean(c.last_name), email = clean(c.email).toLowerCase();
    if (!first) errors.push("Customer first name is required.");
    if (!last) errors.push("Customer last name is required.");
    if (first.length > 60 || last.length > 60) errors.push("Customer names must be 60 characters or fewer.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
        errors.push("A valid customer email is required.");
    }
    const phone = clean(c.phone);
    const digits = phone.replace(/\D/g, "");
    if (phone && (digits.length < 10 || digits.length > 15 || phone.length > 40)) {
        errors.push("Customer phone must have 10 to 15 digits, or be left blank.");
    }
    const address = clean(c.address), city = clean(c.city), zip = clean(c.postal_code);
    if (address.length > 200) errors.push("Street address must be 200 characters or fewer.");
    if (city.length > 100) errors.push("City must be 100 characters or fewer.");
    if (zip && !/^\d{5}(-\d{4})?$/.test(zip)) errors.push("ZIP must be 5 digits (or ZIP+4), or be left blank.");

    // ---- line items ----
    const raw = Array.isArray(src.line_items) ? src.line_items : null;
    const lines: LineItem[] = [];
    if (!raw || raw.length === 0) errors.push("The estimate has no line items.");
    else if (raw.length > 80) errors.push("The estimate has more than 80 line items.");
    else {
        let adjustments = 0;
        raw.forEach((l: any, i: number) => {
            const at = `Line ${i + 1}`;
            if (!l || typeof l !== "object") { errors.push(`${at} isn't a line item.`); return; }
            const kind = String(l.kind ?? "");
            if (!(LINE_KINDS as readonly string[]).includes(kind)) { errors.push(`${at} has an unknown kind "${kind.slice(0, 30)}".`); return; }
            const description = clean(l.description);
            if (!description || description.length > 200) errors.push(`${at} needs a description of 1 to 200 characters.`);
            const unit = String(l.unit ?? "");
            if (!UNITS.includes(unit)) errors.push(`${at} has an unknown unit.`);
            const qty = num(l.qty), rate = num(l.rate), amount = num(l.amount);
            if (qty === null || qty < 0 || qty > 1_000_000) errors.push(`${at} has an invalid quantity.`);
            if (rate === null || Math.abs(rate) > 10_000_000) errors.push(`${at} has an invalid rate.`);
            if (amount === null || Math.abs(amount) > 10_000_000) errors.push(`${at} has an invalid amount.`);
            if (qty === null || rate === null || amount === null) return;
            if (Math.abs(cents(qty * rate) - amount) > 0.011) errors.push(`${at}: quantity x rate doesn't equal its amount.`);
            if (kind === "adjustment") adjustments++;
            else if (amount < 0 || rate < 0) errors.push(`${at}: only the adjustment line may be negative.`);
            if (kind === "addon_tbd" && amount !== 0) errors.push(`${at}: an add-on quoted at consultation must be $0.`);
            lines.push({ kind, description, qty, unit, rate, amount: cents(amount) });
        });
        if (adjustments > 1) errors.push("The estimate has more than one adjustment line.");
    }

    // ---- totals ----
    const total = num(src.total);
    if (total === null || total <= 0 || total > 5_000_000) errors.push("The estimate total is invalid.");
    else if (lines.length && Math.abs(cents(lines.reduce((s, l) => s + l.amount, 0)) - total) > 0.011) {
        errors.push("The line items don't add up to the total.");
    }
    let priceLow: number | null = null;
    if (src.price_low !== undefined && src.price_low !== null) {
        priceLow = num(src.price_low);
        if (priceLow === null || priceLow < 0 || (total !== null && priceLow > total)) {
            errors.push("The low end of the range is invalid.");
        }
    }

    const notes = clean(src.notes, true);
    if (notes.length > 2000) errors.push("Notes must be 2000 characters or fewer.");

    // ---- summary: allow-listed keys only, everything else dropped ----
    const s = (src.summary && typeof src.summary === "object") ? src.summary : {};
    const summary: Summary = {};
    for (const k of ["total_sqft", "rail_lf", "steps"] as const) {
        const v = num(s[k]); if (v !== null && v >= 0 && v <= 1_000_000) summary[k] = v;
    }
    const lv = num(s.deck_levels); if (lv !== null && Number.isInteger(lv) && lv >= 1 && lv <= 10) summary.deck_levels = lv;
    for (const k of ["material", "rail_type", "addons"] as const) {
        const v = clean(s[k]); if (v) summary[k] = v.slice(0, 600);
    }

    if (errors.length) return { ok: false, errors };
    return {
        ok: true,
        value: {
            customer: {
                first_name: first, last_name: last, email,
                phone: phone || null, address: address || null, city: city || null, postal_code: zip || null,
            },
            line_items: lines, total: cents(total!), price_low: priceLow === null ? null : cents(priceLow),
            notes: notes || null, summary,
        },
    };
}

// DECK_ESTIMATE_HOOKS secret: {"<exact clients.name>": "https://hook.us2.make.com/..."}. A client
// is enabled only by being in this map, and each client goes to its OWN hook, because each hook's
// scenario is connected to that client's QuickBooks. Unparseable or non-https entries are ignored.
export function parseHooks(raw: string | undefined): Record<string, string> {
    if (!raw) return {};
    try {
        const obj = JSON.parse(raw);
        const out: Record<string, string> = {};
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            for (const [k, v] of Object.entries(obj)) {
                if (typeof v === "string" && /^https:\/\/hook\.[a-z0-9]+\.make\.com\//.test(v)) out[k] = v;
            }
        }
        return out;
    } catch {
        return {};
    }
}
