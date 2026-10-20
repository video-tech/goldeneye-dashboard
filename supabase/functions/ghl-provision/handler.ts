// ghl-provision: phase 0's second half (built 2026-10-15). Can Golden Eye create a GHL sub-account from the Master
// snapshot, and then read and write that new account's custom values? Only admin-auth is imported, so
// ghl-provision.test.mjs runs this under plain node with a fake GHL. index.ts supplies the real ones.
//
// TEST ONLY, by construction:
//   - every account it creates is named "GE TEST <date time>", with made-up details;
//   - it only ever reads or writes an account whose name starts with "GE TEST", that isn't Master, and that no
//     Golden Eye client has as its ghl_location_id;
//   - it refuses to create a fourth GE TEST account while three exist (delete old ones in GHL);
//   - it never deletes anything, and never returns a token.
// Phase 2's real account function is built from what this proves.

import { adminCheck, cronCheck } from "../_shared/admin-auth.ts";
import { oauthConfigured, companyAccessToken, locationAccessToken, appId } from "../_shared/ghl-oauth.ts";

export type Env = {
    GHL_AGENCY_TOKEN?: string;
    // Golden Eye's Marketplace app (_shared/ghl-oauth.ts). When all four are set the app is used instead of
    // GHL_AGENCY_TOKEN, because only the app can get inside a sub-account it didn't make by hand.
    GHL_APP_CLIENT_ID?: string;
    GHL_APP_CLIENT_SECRET?: string;
    GHL_TOKEN_KEY?: string;
    GHL_COMPANY_ID?: string;
    GHL_MASTER_LOCATION_ID?: string;
    MAKE_WEBHOOK_SECRET?: string;
};

export type Deps = {
    env: Env;
    db: any;
    fetch: typeof fetch;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
};

const GHL = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
export const TEST_PREFIX = "GE TEST";
export const MAX_TEST_ACCOUNTS = 3;

class GhlError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
}

type Call = { method: string; path: string; body?: unknown; form?: Record<string, string>; token: string };

// GHL's error text, never a token (every token in play is scrubbed).
async function ghl(deps: Deps, c: Call, scrub: string[]) {
    const headers: Record<string, string> = { "Authorization": `Bearer ${c.token}`, "Version": VERSION, "Accept": "application/json" };
    let body: string | undefined;
    if (c.form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(c.form).toString(); }
    else if (c.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(c.body); }
    const res = await deps.fetch(GHL + c.path, { method: c.method, headers, body });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
        const raw = json?.message ?? json?.error ?? text ?? "";
        let msg = (Array.isArray(raw) ? raw.join("; ") : String(raw)).slice(0, 300);
        for (const s of scrub) if (s) msg = msg.split(s).join("[token]");
        throw new GhlError(`GHL ${c.method} ${c.path.split("?")[0]} answered ${res.status}: ${msg}`, res.status);
    }
    return json;
}

const errText = (e: unknown) => (e as Error).message;

export function testName(now: Date): string {
    // "GE TEST 2026-10-15 16:42" in UTC: unique enough, and sorts by date.
    return `${TEST_PREFIX} ${now.toISOString().slice(0, 16).replace("T", " ")}`;
}

// The accounts in the agency named GE TEST, via the agency search.
async function listTestAccounts(deps: Deps, token: string, companyId: string) {
    const json = await ghl(deps, { method: "GET", path: `/locations/search?companyId=${encodeURIComponent(companyId)}&limit=100&skip=0`, token }, [token]);
    const list = Array.isArray(json?.locations) ? json.locations : [];
    return list.filter((l: any) => String(l?.name ?? "").startsWith(TEST_PREFIX)).map((l: any) => ({ id: String(l.id ?? l._id), name: String(l.name) }));
}

// The guard every read or write of a test account goes through.
async function guardTestAccount(deps: Deps, token: string, locationId: string) {
    if (!/^[A-Za-z0-9]{10,40}$/.test(locationId)) throw new Error("location_id doesn't look like a GHL location id.");
    if (locationId === deps.env.GHL_MASTER_LOCATION_ID?.trim()) throw new Error("That's Master. This test never touches Master.");
    const { data: clientRows, error } = await deps.db.from("clients").select("name").eq("ghl_location_id", locationId).limit(1);
    if (error) throw new Error(`Couldn't check the clients table: ${error.message}`);
    if (clientRows?.length) throw new Error("That location belongs to a Golden Eye client. This test never touches a client's account.");
    const json = await ghl(deps, { method: "GET", path: `/locations/${encodeURIComponent(locationId)}`, token }, [token]);
    const name = String(json?.location?.name ?? json?.name ?? "");
    if (!name.startsWith(TEST_PREFIX)) throw new Error(`That account is named "${name.slice(0, 60)}", not "${TEST_PREFIX} …". This test only touches its own test accounts.`);
    return name;
}

// Phase 0's open question: does the agency token work on a sub-account's own endpoints, or does it have to be
// exchanged for a location token first? Try the agency token; on 401/403 exchange it and try again. Report which.
async function locationAccess(deps: Deps, agencyToken: string, companyId: string, locationId: string) {
    if (oauthConfigured(deps.env)) {
        return { token: await locationAccessToken(deps, locationId), via: "app location token" as const, note: null as string | null };
    }
    const probe = `/locations/${encodeURIComponent(locationId)}/customValues`;
    try {
        await ghl(deps, { method: "GET", path: probe, token: agencyToken }, [agencyToken]);
        return { token: agencyToken, via: "agency token" as const, note: null as string | null };
    } catch (e) {
        if (![401, 403].includes((e as GhlError).status)) throw e;
        const agencyRefusal = errText(e);
        const json = await ghl(deps, { method: "POST", path: "/oauth/locationToken", form: { companyId, locationId }, token: agencyToken }, [agencyToken]);
        const lt = String(json?.access_token ?? "");
        if (!lt) throw new Error("GHL's location token answer had no access_token.");
        return { token: lt, via: "location token" as const, note: `The agency token alone was refused (${agencyRefusal}), so it was exchanged for a location token.` };
    }
}

const keyOf = (v: { name?: string; fieldKey?: string }) => {
    const m = String(v.fieldKey ?? "").match(/(?:custom_values|contact)\.([a-z0-9_]+)/i);
    return m ? m[1].toLowerCase() : String(v.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
};

// What arrived from the snapshot. Each part is read on its own, so one missing scope doesn't hide the rest.
async function inspect(deps: Deps, token: string, scrub: string[], locationId: string) {
    const loc = encodeURIComponent(locationId);
    const part = async (fn: () => Promise<any>) => { try { return await fn(); } catch (e) { return { error: errText(e) }; } };
    const values = await part(async () => {
        const j = await ghl(deps, { method: "GET", path: `/locations/${loc}/customValues`, token }, scrub);
        const list = Array.isArray(j?.customValues) ? j.customValues : [];
        return {
            count: list.length,
            empty: list.filter((v: any) => !String(v.value ?? "").trim()).length,
            items: list.map((v: any) => ({ key: keyOf(v), name: v.name, value: String(v.value ?? "").slice(0, 80) })),
        };
    });
    const fields = await part(async () => {
        const j = await ghl(deps, { method: "GET", path: `/locations/${loc}/customFields?model=contact`, token }, scrub);
        const list = Array.isArray(j?.customFields) ? j.customFields : [];
        return { count: list.length, names: list.map((f: any) => f.name) };
    });
    const pipelines = await part(async () => {
        const j = await ghl(deps, { method: "GET", path: `/opportunities/pipelines?locationId=${loc}`, token }, scrub);
        return { names: (Array.isArray(j?.pipelines) ? j.pipelines : []).map((p: any) => p.name) };
    });
    const workflows = await part(async () => {
        const j = await ghl(deps, { method: "GET", path: `/workflows/?locationId=${loc}`, token }, scrub);
        return { list: (Array.isArray(j?.workflows) ? j.workflows : []).map((w: any) => ({ name: w.name, status: w.status })) };
    });
    return { values, fields, pipelines, workflows };
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
    const reply = (body: unknown, status = 200) => Response.json(body, { status });
    if (req.method !== "POST") return reply({ error: "POST only" }, 405);

    let who = "cron";
    if (!cronCheck(req, deps.env.MAKE_WEBHOOK_SECRET)) {
        const caller = await adminCheck(deps.db, req);
        if (!caller.ok) { console.warn("ghl-provision REFUSED:", caller.reason); return reply({ error: caller.reason }, 403); }
        who = caller.kind === "admin" ? caller.email : "cron";
    }

    const companyId = deps.env.GHL_COMPANY_ID?.trim();
    const useApp = oauthConfigured(deps.env);
    if (!companyId || (!useApp && !deps.env.GHL_AGENCY_TOKEN?.trim())) {
        return reply({ error: "Install the Golden Eye app (or set GHL_AGENCY_TOKEN) and set GHL_COMPANY_ID first." }, 500);
    }
    let token: string;
    try { token = useApp ? await companyAccessToken(deps) : deps.env.GHL_AGENCY_TOKEN!.trim(); }
    catch (e) { return reply({ error: errText(e) }, 502); }

    const body = await req.json().catch(() => ({}));
    const mode = String(body?.mode ?? "");
    const now = (deps.now ?? (() => new Date()))();

    try {
        if (mode === "app_locations") {
            // Where GHL says the Golden Eye app is installed (read-only). Needs the app installed.
            if (!useApp) return reply({ error: "The Golden Eye app is not set up (GHL_APP_CLIENT_ID etc.)." }, 400);
            const j = await ghl(deps, { method: "GET", path: `/oauth/installedLocations?companyId=${encodeURIComponent(companyId)}&appId=${encodeURIComponent(appId(deps.env))}&isInstalled=true&limit=100`, token }, [token]);
            const list = Array.isArray(j?.locations) ? j.locations : [];
            return reply({ mode, app_id: appId(deps.env), install_to_future: j?.installToFutureLocations ?? null,
                installed: list.map((l: any) => ({ id: String(l._id ?? l.id), name: String(l.name ?? "") })), total_in_agency: j?.count ?? null });
        }

        if (mode === "snapshots") {
            // Find Master v1.0's id. Read-only.
            const j = await ghl(deps, { method: "GET", path: `/snapshots/?companyId=${encodeURIComponent(companyId)}`, token }, [token]);
            const tests = await listTestAccounts(deps, token, companyId).catch((e) => ({ error: errText(e) }));
            return reply({ mode, snapshots: (Array.isArray(j?.snapshots) ? j.snapshots : []).map((s: any) => ({ id: s.id, name: s.name, type: s.type })), test_accounts: tests });
        }

        if (mode === "create_test") {
            const snapshotId = String(body?.snapshot_id ?? "").trim();
            if (!/^[A-Za-z0-9]{10,40}$/.test(snapshotId)) return reply({ error: 'Send "snapshot_id" (from mode "snapshots").' }, 400);
            const existing = await listTestAccounts(deps, token, companyId);
            if (body?.confirm !== true) {
                return reply({ mode, dry_run: true, would_create: testName(now), snapshot_id: snapshotId, test_accounts: existing,
                    note: 'Nothing was created. Send {"mode":"create_test","snapshot_id":"…","confirm":true} to create it.' });
            }
            if (existing.length >= MAX_TEST_ACCOUNTS) {
                return reply({ error: `${existing.length} GE TEST accounts already exist. Delete old ones in GHL first.`, test_accounts: existing }, 409);
            }
            const name = testName(now);
            const j = await ghl(deps, { method: "POST", path: "/locations/", token, body: {
                name, companyId, snapshotId,
                // Made-up details: a test account must never look like, text or email a real business.
                phone: "+15555550123", address: "1 Test Way", city: "Lehi", state: "UT", country: "US", postalCode: "84043",
                website: "https://example.com", timezone: "America/Denver",
            } }, [token]);
            const id = String(j?.id ?? j?.location?.id ?? j?._id ?? "");
            console.log(`ghl-provision create_test by ${who}: ${name} ${id || "(no id returned)"}`);
            return reply({ mode, created: !!id, location_id: id || null, name,
                next: 'The snapshot loads in the background. Wait a minute, then send {"mode":"inspect","location_id":"…"}.' });
        }

        if (mode === "inspect" || mode === "fill_test") {
            const locationId = String(body?.location_id ?? "").trim();
            const name = await guardTestAccount(deps, token, locationId);
            const access = await locationAccess(deps, token, companyId, locationId);
            const scrub = [token, access.token];

            if (mode === "inspect") {
                return reply({ mode, location_id: locationId, name, access: access.via, access_note: access.note, ...(await inspect(deps, access.token, scrub, locationId)) });
            }

            // fill_test: write test answers into two custom values, then read them back. The same steps phase 3 will
            // take with real answers: list, match by key, PUT by id.
            if (body?.confirm !== true) return reply({ mode, dry_run: true, note: 'Send "confirm": true to write two test values.' });
            const fills: Record<string, string> = { business_name: "GE Test Co", owner_name: "Test Owner" };
            const loc = encodeURIComponent(locationId);
            const j = await ghl(deps, { method: "GET", path: `/locations/${loc}/customValues`, token: access.token }, scrub);
            const list = Array.isArray(j?.customValues) ? j.customValues : [];
            const results: Record<string, string> = {};
            for (const [key, value] of Object.entries(fills)) {
                const hit = list.find((v: any) => keyOf(v) === key);
                if (!hit) { results[key] = "not in the account (the snapshot didn't bring it)"; continue; }
                try {
                    await ghl(deps, { method: "PUT", path: `/locations/${loc}/customValues/${encodeURIComponent(hit.id)}`, token: access.token, body: { name: hit.name, value } }, scrub);
                    results[key] = "written";
                } catch (e) { results[key] = errText(e); }
            }
            await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(2000);
            const after = await inspect(deps, access.token, scrub, locationId);
            const readBack = Object.fromEntries(Object.keys(fills).map((k) => [k, (after.values as any)?.items?.find((v: any) => v.key === k)?.value ?? null]));
            console.log(`ghl-provision fill_test by ${who}: ${locationId} ${JSON.stringify(results)}`);
            return reply({ mode, location_id: locationId, access: access.via, access_note: access.note, results, read_back: readBack });
        }

        return reply({ error: 'Unknown mode. Use "snapshots", "create_test", "inspect" or "fill_test".' }, 400);
    } catch (e) {
        console.error("ghl-provision failed:", errText(e));
        return reply({ error: errText(e) }, 502);
    }
}
