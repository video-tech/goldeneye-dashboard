// What the master snapshot's custom values should be, and how to tell which already exist.
// No imports, so ghl-setup.test.mjs runs it under plain node.
//
// GHL turns a custom value's display name into its merge key: "Company Name" becomes
// {{ custom_values.company_name }}. Templates reference the key, so the key is what has to match.

export type Wanted = { name: string; key: string; aliases?: string[] };

// The plan doc's list (Golden Eye Onboarding Rebuild, "Custom values in the master snapshot").
// Aliases: Master already had these under its own names (checked 2026-10-14), and its templates may
// use them, so an alias counts as the value and nothing is created next to it.
export const MASTER_CUSTOM_VALUES: Wanted[] = [
    { name: "Company Name", key: "company_name", aliases: ["business_name"] },
    { name: "Owner Name", key: "owner_name" },
    { name: "Business Phone", key: "business_phone" },
    { name: "Business Email", key: "business_email" },
    { name: "Business Address", key: "business_address", aliases: ["physical_address"] },
    { name: "Business Website", key: "business_website" },
    { name: "Facebook URL", key: "facebook_url", aliases: ["facebook_page_url"] },
    { name: "Instagram URL", key: "instagram_url", aliases: ["instagram_handle"] },
    { name: "Awards", key: "awards" },
    { name: "Asset Link", key: "asset_link" },
    { name: "Business Hours", key: "business_hours", aliases: ["hours_of_operation"] },
    { name: "Call Routing", key: "call_routing" },
    { name: "Text Window", key: "text_window" },
    { name: "Service Area", key: "service_area" },
    { name: "Service Radius", key: "service_radius" },
    { name: "Excluded Areas", key: "excluded_areas" },
    { name: "Services List", key: "services_list" },
    { name: "Financing Offer", key: "financing_offer" },
    { name: "Design Offer", key: "design_offer" },
    { name: "Current Offer", key: "current_offer" },
    { name: "Review Link", key: "review_link", aliases: ["google_review_link"] },
    { name: "Booking Link", key: "booking_link", aliases: ["marketing__website_booking_page_url"] },
    // No pixel or CAPI values (decided 2026-10-15): CAPI is set up by hand per client as part of ads setup.
];

export type Existing = { id: string; name: string; fieldKey?: string; value?: string };

// "{{ custom_values.company_name }}" -> "company_name", and a contact field's "contact.project_timeline"
// -> "project_timeline". Falls back to the name, normalized the way GHL does it (lower case, runs of
// anything else become one underscore).
export function keyOf(v: { name?: string; fieldKey?: string }): string {
    const m = String(v.fieldKey ?? "").match(/(?:custom_values|contact)\.([a-z0-9_]+)/i);
    if (m) return m[1].toLowerCase();
    return String(v.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export type PlanRow =
    | { key: string; name: string; status: "exists"; id: string }
    | { key: string; name: string; status: "covered_by_alias"; id: string; alias: string }
    | { key: string; name: string; status: "missing" };

// Which wanted values exist, which are covered by an alias, and which need creating. Also lists the
// values Master has that the plan doesn't name, so nothing there goes unnoticed.
export function planValues(existing: Existing[], wanted: Wanted[] = MASTER_CUSTOM_VALUES) {
    const byKey = new Map<string, Existing>();
    for (const e of existing) {
        const k = keyOf(e);
        if (k && !byKey.has(k)) byKey.set(k, e);
    }
    const rows: PlanRow[] = [];
    const used = new Set<string>();
    for (const w of wanted) {
        const hit = byKey.get(w.key);
        if (hit) { rows.push({ key: w.key, name: w.name, status: "exists", id: hit.id }); used.add(w.key); continue; }
        const alias = (w.aliases ?? []).find((a) => byKey.has(a));
        if (alias) {
            rows.push({ key: w.key, name: w.name, status: "covered_by_alias", id: byKey.get(alias)!.id, alias });
            used.add(alias);
            continue;
        }
        rows.push({ key: w.key, name: w.name, status: "missing" });
    }
    const extra = [...byKey.entries()].filter(([k]) => !used.has(k)).map(([k, e]) => ({ key: k, name: e.name, id: e.id }));
    return { rows, extra };
}

// ---- contact custom fields (per lead, not from onboarding), in folders ----
// GHL shows a field's NAME as the question on forms and surveys, so every field's GHL name is its
// `question`. `name` is the short label this function reports with, and `key` is the field's key.
//
// Keys: GHL keeps a field's key when it is renamed, so the fields made on 2026-10-14 keep their short
// keys (contact.kitchen_size). A new field is created with its key asked for explicitly where GHL allows
// that; where it doesn't, GHL makes the key from the question, so slug(question) is also accepted as a
// match (an alias) and a re-run never creates it twice.
export type WantedField = Wanted & {
    question: string;
    dataType: "TEXT" | "SINGLE_OPTIONS";
    options?: string[];
    placeholder?: string;
};

// A folder of fields. `recreate` lists keys that may be deleted and made again inside the folder when
// found outside it: only fields we created, empty, before folders existed (see RECREATE_SINCE).
export type FieldFolder = { folder: string; fields: WantedField[]; recreate?: string[] };

export const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const field = (name: string, question: string, extra: Partial<WantedField>): WantedField => {
    const key = slugOf(name), fromQuestion = slugOf(question);
    return { name, key, question, ...(fromQuestion !== key ? { aliases: [fromQuestion] } : {}), ...extra } as WantedField;
};
const choice = (name: string, question: string, options: string[]) => field(name, question, { dataType: "SINGLE_OPTIONS", options });
const text = (name: string, question: string, placeholder?: string) =>
    field(name, question, { dataType: "TEXT", ...(placeholder ? { placeholder } : {}) });

// Adding a quiz for a new trade: one more entry here, then a create run. Nothing else changes.
// Short names start with the trade, so keys never collide between packs.
export const MASTER_FIELD_FOLDERS: FieldFolder[] = [
    {
        folder: "Lead Info",
        fields: [
            choice("Project Timeline", "When are you hoping to start?", ["As soon as possible", "Within 1 month", "1 to 3 months", "3 to 6 months", "Just researching"]),
            text("Estimated Budget", "What budget do you have in mind?", "Their budget, in their words"),
            choice("How Did You Hear About Us", "How did you hear about us?", ["Google search", "Facebook or Instagram", "Referral from a friend", "Saw our work or a sign", "Other"]),
            choice("Homeowner", "Do you own the home?", ["Own the home", "Renting", "Buying a home"]),
            choice("Interested In Financing", "Are you interested in financing?", ["Yes", "No", "Maybe"]),
        ],
        // Created 2026-10-14 before folders, unfiled and empty. "Service Requested" and "Quiz Estimate" were
        // dropped from Lead Info on 2026-10-15 (deleted in GHL on purpose), so nothing expects them.
        recreate: ["project_timeline", "estimated_budget", "how_did_you_hear_about_us"],
    },
    {
        folder: "Cost Quiz: Kitchen Remodel",
        fields: [
            choice("Kitchen Size", "How big is your kitchen?", ["Small (under 100 sq ft)", "Medium (100 to 200 sq ft)", "Large (over 200 sq ft)", "Not sure"]),
            choice("Kitchen Remodel Scope", "How much of your kitchen are you changing?", ["Refresh (paint, hardware, counters)", "New cabinets and counters, same layout", "Full remodel, new layout", "Not sure"]),
            choice("Kitchen Cabinets", "What would you like to do with your cabinets?", ["Keep", "Reface or paint", "New semi-custom", "Fully custom"]),
            choice("Kitchen Countertops", "Which countertops are you considering?", ["Laminate", "Quartz", "Granite", "Marble or natural stone", "Butcher block", "Not sure"]),
            choice("Kitchen Layout Changes", "Are you changing the kitchen layout?", ["Keep layout", "Add an island or small changes", "Move walls, plumbing or gas"]),
            choice("Kitchen Appliances", "Are you replacing your appliances?", ["Keep", "Replace some", "Replace all", "Premium built-in"]),
            choice("Kitchen Flooring", "Are you replacing the kitchen floor?", ["Keep", "Replace", "Not sure"]),
        ],
    },
    {
        folder: "Cost Quiz: Home Builder",
        fields: [
            choice("Build Lot", "Do you have a lot to build on?", ["Own one", "Under contract", "Still looking", "Want help finding one"]),
            text("Build Location", "Where do you want to build?", "City or area"),
            choice("Build Home Size", "About how big a home are you planning?", ["Under 2,000 sq ft", "2,000 to 3,000 sq ft", "3,000 to 4,000 sq ft", "4,000 to 5,000 sq ft", "Over 5,000 sq ft"]),
            choice("Build Stories", "How many stories?", ["One", "Two", "Three or more"]),
            choice("Build Bedrooms", "How many bedrooms?", ["2 or fewer", "3", "4", "5", "6 or more"]),
            choice("Build Bathrooms", "How many bathrooms?", ["2 or fewer", "3", "4", "5 or more"]),
            choice("Build Finish Level", "What level of finishes are you after?", ["Standard", "Upgraded", "Luxury", "Not sure"]),
            choice("Build Basement", "Do you want a basement?", ["None", "Unfinished", "Finished", "Walkout"]),
            choice("Build Garage", "What size garage do you want?", ["None", "2-car", "3-car", "4 or more"]),
            choice("Build House Plans", "Do you have house plans?", ["Have plans", "Need a designer", "Want a stock plan", "Not sure"]),
            choice("Build Paying For It", "How are you planning to pay for the build?", ["Cash", "Construction loan pre-approved", "Need a construction loan", "Not sure"]),
        ],
    },
];

export const MASTER_CONTACT_FIELDS: WantedField[] = MASTER_FIELD_FOLDERS.flatMap((f) => f.fields);

// A field may only be recreated if GHL says it was added on or after this date (the day we made them).
export const RECREATE_SINCE = "2026-10-14";

// The choices a choice field is missing as GHL saved it. Reported, never fixed by deleting: a form
// may already use the field.
export function choicesMissing(w: WantedField, saved: { picklistOptions?: unknown }): string[] {
    if (w.dataType !== "SINGLE_OPTIONS") return [];
    const have = new Set((Array.isArray(saved.picklistOptions) ? saved.picklistOptions : []).map((o) => String(o).trim().toLowerCase()));
    return (w.options ?? []).filter((o) => !have.has(o.toLowerCase()));
}

// ---- the default pipeline ----
// A starting point only: stages differ for every client, so nothing forces a client to keep it.
export const MASTER_PIPELINE = {
    name: "Lead Pipeline",
    stages: ["New lead", "Contacted", "Estimate scheduled", "Estimate sent", "Won", "Lost"],
};

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

// GHL makes pipeline names unique per location, case-insensitive, so the name is the match.
export function planPipeline(existing: { id: string; name: string; stages?: { name: string }[] }[], wanted = MASTER_PIPELINE) {
    const hit = existing.find((p) => norm(p.name) === norm(wanted.name));
    if (!hit) return { status: "missing" as const, name: wanted.name, stages: wanted.stages };
    const have = (hit.stages ?? []).map((s) => s.name);
    const missingStages = wanted.stages.filter((s) => !have.some((h) => norm(h) === norm(s)));
    return { status: "exists" as const, name: hit.name, id: hit.id, stages: have, missing_stages: missingStages };
}
