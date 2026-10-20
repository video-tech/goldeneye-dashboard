// ghl-account (built 2026-10-16): Golden Eye creates a client's GHL sub-account from the Master snapshot by itself,
// and fills it from their onboarding answers once the Golden Eye app is installed on it. Only shared helpers are
// imported, so ghl-account.test.mjs runs this under plain node with a fake GHL and a fake database.
//
// Who qualifies (all of these, checked every time):
//   - status active, current stage Onboarding, no ghl_location_id yet;
//   - their onboarding is finished (the "Onboarding complete" handoff task exists);
//   - they answered the new questionnaire ("About your business", with a business name). Clients on the old GHL forms,
//     and every existing client, never qualify;
//   - no ghl_accounts row: Golden Eye never makes a second account for the same client;
//   - not SEO only (clients.base_package = 'no', seo_only_package.sql): those clients have no GHL account at all.
// Writes only through _shared/ghl-write.ts (allow-list + log), and only into accounts it created itself, until they are
// filled. GHL_AUTO_CREATE=on is the switch: off, the sweep only reports what it would do. At most MAX_PER_SWEEP new
// accounts per run.

import { adminCheck, cronCheck } from "../_shared/admin-auth.ts";
import { oauthConfigured, companyAccessToken, locationAccessToken, appId } from "../_shared/ghl-oauth.ts";
import { ghlRead, ghlWrite } from "../_shared/ghl-write.ts";
import { MASTER_CUSTOM_VALUES, keyOf } from "../ghl-setup/plan.ts";

export type Env = {
    GHL_APP_CLIENT_ID?: string;
    GHL_APP_CLIENT_SECRET?: string;
    GHL_TOKEN_KEY?: string;
    GHL_COMPANY_ID?: string;
    GHL_APP_ID?: string;
    GHL_MASTER_LOCATION_ID?: string;
    GHL_SNAPSHOT_ID?: string;
    GHL_AUTO_CREATE?: string;
    GHL_APP_INSTALL_URL?: string;
    MAKE_WEBHOOK_SECRET?: string;
};

export type Deps = { env: Env; db: any; fetch: typeof fetch; now?: () => Date };

export const HANDOFF_TITLE = "Onboarding complete — ready for campaign build";
export const ABOUT_STEP_TITLE = "About your business";
export const MAX_PER_SWEEP = 2;

const errText = (e: unknown) => String((e as Error)?.message ?? e);
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// ---- answers -> what goes into GHL ----

// "(801) 555-0100" -> "+18015550100". Anything that isn't a phone number comes back empty.
export function e164(raw: unknown): string {
    const d = String(raw ?? "").replace(/\D/g, "");
    if (d.length === 10) return "+1" + d;
    if (d.length === 11 && d.startsWith("1")) return "+" + d;
    if (d.length >= 11 && d.length <= 15) return "+" + d;
    return "";
}

const TZ: Record<string, string> = {};
const zone = (tz: string, states: string[]) => states.forEach((s) => { TZ[s] = tz; });
zone("America/Los_Angeles", ["CA", "WA", "OR", "NV", "CALIFORNIA", "WASHINGTON", "OREGON", "NEVADA"]);
zone("America/Denver", ["UT", "CO", "NM", "WY", "MT", "ID", "UTAH", "COLORADO", "NEW MEXICO", "WYOMING", "MONTANA", "IDAHO"]);
zone("America/Phoenix", ["AZ", "ARIZONA"]);
zone("America/Chicago", ["TX", "IL", "MN", "MO", "WI", "IA", "OK", "KS", "NE", "LA", "AR", "MS", "AL", "TN", "SD", "ND",
    "TEXAS", "ILLINOIS", "MINNESOTA", "MISSOURI", "WISCONSIN", "IOWA", "OKLAHOMA", "KANSAS", "NEBRASKA", "LOUISIANA", "ARKANSAS",
    "MISSISSIPPI", "ALABAMA", "TENNESSEE", "SOUTH DAKOTA", "NORTH DAKOTA"]);
zone("America/Anchorage", ["AK", "ALASKA"]);
zone("Pacific/Honolulu", ["HI", "HAWAII"]);
// Everything else in the US is Eastern; an unknown or empty state falls back to Mountain, where Midas is.
const EASTERN = ["NY", "NJ", "PA", "OH", "MI", "IN", "KY", "GA", "FL", "NC", "SC", "VA", "WV", "MD", "DE", "DC", "CT", "RI", "MA", "VT", "NH", "ME"];
export function timezoneFor(state: unknown): string {
    const s = String(state ?? "").trim().toUpperCase();
    if (TZ[s]) return TZ[s];
    if (EASTERN.includes(s)) return "America/New_York";
    return "America/Denver";
}

const show = (v: unknown) => Array.isArray(v) ? v.filter(Boolean).join(", ") : String(v ?? "").trim();

// Every answer whose question has a dest of ghl:<field> or custom_value:<key>, from the client's public answers
// (private answers never go to GHL). A question can have several dests, separated by ";".
export function mapAnswers(steps: { id: string; questions: any }[], answerRows: { step_id: string; answers: any }[]) {
    const ghl: Record<string, string> = {};
    const cv: Record<string, string> = {};
    const byStep = new Map(steps.map((s) => [String(s.id), Array.isArray(s.questions) ? s.questions : []]));
    for (const row of answerRows) {
        for (const q of byStep.get(String(row.step_id)) ?? []) {
            if (!q?.dest || q.private || q.secret) continue;
            let value = show(row.answers?.[q.id]?.value);
            // "We text new leads between 8am and 8pm, weekends included. Is that OK?" "Yes" means the standard window;
            // anything else is answered by the next question (the hours they want), which has the same dest.
            if (q.id === "c_text_ok") value = value === "Yes" ? "8am to 8pm, every day" : "";
            if (!value) continue;
            for (const part of String(q.dest).split(";").map((x: string) => x.trim())) {
                const [kind, key] = part.split(":");
                if (!key) continue;
                if (kind === "ghl") ghl[key] = value;
                else if (kind === "custom_value") cv[key] = value;
            }
        }
    }
    return { ghl, cv };
}

// The body for POST /locations/: the business as the client described it.
export function accountBody(clientName: string, ghl: Record<string, string>, cv: Record<string, string>, companyId: string, snapshotId: string) {
    const owner = String(cv.owner_name ?? "").trim().split(/\s+/);
    const body: Record<string, unknown> = {
        name: ghl.name || clientName,
        companyId, snapshotId,
        country: "US",
        timezone: timezoneFor(ghl.state),
    };
    const phone = e164(ghl.phone);
    if (phone) body.phone = phone;
    for (const k of ["address", "city", "state", "postalCode", "website", "email"]) if (ghl[k]) body[k] = ghl[k];
    if (owner[0] && ghl.email) body.prospectInfo = { firstName: owner[0], lastName: owner.slice(1).join(" ") || "-", email: ghl.email };
    return body;
}

// For each answer's custom value key, the account's value to write: by the key itself or any alias of it
// (Master names some values its own way: business_name for company_name, physical_address for business_address...).
export function planFill(existing: any[], cv: Record<string, string>) {
    const byKey = new Map<string, any>();
    for (const e of existing) { const k = keyOf(e); if (k && !byKey.has(k)) byKey.set(k, e); }
    const writes: { key: string; id: string; name: string; value: string }[] = [];
    const missing: string[] = [];
    const unchanged: string[] = [];
    for (const [key, value] of Object.entries(cv)) {
        const wanted = MASTER_CUSTOM_VALUES.find((w) => w.key === key || (w.aliases ?? []).includes(key));
        const candidates = wanted ? [key, wanted.key, ...(wanted.aliases ?? [])] : [key];
        const hit = candidates.map((c) => byKey.get(c)).find(Boolean);
        if (!hit) { missing.push(key); continue; }
        if (String(hit.value ?? "") === value) { unchanged.push(key); continue; }
        writes.push({ key, id: String(hit.id), name: String(hit.name), value });
    }
    return { writes, missing, unchanged };
}

// ---- the client's team as GHL users ----

// What a person from the client's team may do in their GHL account: work their leads, conversations, calendar and pipeline,
// never workflows (they hold the Golden Eye webhook secret), triggers or settings.
export const TEAM_PERMISSIONS = {
    contactsEnabled: true, conversationsEnabled: true, opportunitiesEnabled: true, appointmentsEnabled: true,
    phoneCallEnabled: true, reviewsEnabled: true, dashboardStatsEnabled: true, tagsEnabled: true, leadValueEnabled: true,
    workflowsEnabled: false, workflowsReadOnly: false, triggersEnabled: false, settingsEnabled: false, campaignsEnabled: false,
    funnelsEnabled: false, websitesEnabled: false, marketingEnabled: false, bulkRequestsEnabled: false, paymentsEnabled: false,
    invoiceEnabled: false, refundsEnabled: false, recordPaymentEnabled: false, cancelSubscriptionEnabled: false, exportPaymentsEnabled: false,
};

// A random password GHL accepts (12+ characters with upper, lower, digit and symbol). Nobody ever sees it: it is never
// stored, logged or returned. Each person sets their own with "Forgot password".
export function randomPassword(): string {
    const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnpqrstuvwxyz", "23456789", "!@#$%^&*-_=+"];
    const all = sets.join("");
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const chars = Array.from(bytes, (b, i) => (i < 4 ? sets[i] : all)[b % (i < 4 ? sets[i] : all).length]);
    // the four required kinds first, then shuffle so they aren't always at the front
    const order = crypto.getRandomValues(new Uint8Array(24));
    return chars.map((c, i) => [order[i], c] as [number, string]).sort((x, y) => x[0] - y[0]).map(([, c]) => c).join("");
}

// The team people who asked for a login and don't have one yet, added as GHL users on this account.
async function addTeamUsers(deps: Deps, companyToken: string, companyId: string, client: string, loc: string, by: string) {
    const { data: people, error } = await deps.db.from("client_contacts").select("id, contact_name, email, phone, ghl_login, ghl_user_id, active")
        .eq("client_name", client).eq("ghl_login", true);
    // team_ghl_logins.sql not run yet: nobody has asked for a login
    if (error) return { users_added: [], users_failed: [], users_note: /ghl_login/.test(error.message ?? "") ? "team_ghl_logins.sql not run yet" : error.message };
    const added: string[] = [];
    const failed: { name: string; error: string }[] = [];
    for (const p of people ?? []) {
        if (p.ghl_user_id || p.active === false) continue;
        const email = String(p.email ?? "").trim().toLowerCase();
        const [first, ...rest] = String(p.contact_name ?? "").trim().split(/\s+/);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !first) { failed.push({ name: String(p.contact_name ?? "?"), error: "no usable email or name" }); continue; }
        const body: Record<string, unknown> = {
            companyId, firstName: first, lastName: rest.join(" ") || "-", email, password: randomPassword(),
            type: "account", role: "user", locationIds: [loc], permissions: TEAM_PERMISSIONS,
        };
        const phone = e164(p.phone);
        if (phone) body.phone = phone;
        try {
            const j = await ghlWrite(deps, "POST", "/users/", companyToken, body, { by, client, location: loc, summary: `add team member ${first} as a GHL user` });
            const id = String(j?.id ?? j?.user?.id ?? j?._id ?? "");
            if (id) await deps.db.from("client_contacts").update({ ghl_user_id: id }).eq("id", p.id);
            added.push(String(p.contact_name));
        } catch (e) { failed.push({ name: String(p.contact_name), error: errText(e) }); }
    }
    return { users_added: added, users_failed: failed };
}

// ---- the database ----

async function answersFor(deps: Deps, client: string) {
    const { data: steps, error: sErr } = await deps.db.from("onboarding_steps").select("id, title, questions").eq("step_type", "questions");
    if (sErr) throw new Error(`Couldn't read the onboarding steps: ${sErr.message}`);
    const { data: rows, error: aErr } = await deps.db.from("onboarding_answers").select("step_id, answers").eq("client_name", client);
    if (aErr) throw new Error(`Couldn't read ${client}'s answers: ${aErr.message}`);
    return { steps: steps ?? [], rows: rows ?? [] };
}

// Who gets an account now, with the reason each other onboarding client doesn't (so a report explains itself).
export async function candidates(deps: Deps) {
    // "*" rather than a column list, so this keeps working before supabase/sql/seo_only_package.sql adds base_package
    const { data: clients, error } = await deps.db.from("clients").select("*").eq("current_stage", "Onboarding");
    if (error) throw new Error(`Couldn't read clients: ${error.message}`);
    const { data: handoffs } = await deps.db.from("tasks").select("client").eq("title", HANDOFF_TITLE);
    const finished = new Set((handoffs ?? []).map((t: any) => norm(t.client)));
    const { data: accounts, error: accErr } = await deps.db.from("ghl_accounts").select("client_name");
    if (accErr) throw new Error(`Couldn't read ghl_accounts: ${accErr.message}. Has supabase/sql/ghl_accounts.sql been run?`);
    const made = new Set((accounts ?? []).map((a: any) => a.client_name));
    const { data: steps } = await deps.db.from("onboarding_steps").select("id").eq("title", ABOUT_STEP_TITLE).eq("step_type", "questions");
    const aboutIds = (steps ?? []).map((s: any) => String(s.id));
    const { data: about } = aboutIds.length ? await deps.db.from("onboarding_answers").select("client_name, step_id, answers").in("step_id", aboutIds) : { data: [] };
    const answered = new Set((about ?? []).filter((r: any) => show(r.answers?.a_name?.value)).map((r: any) => r.client_name));

    const ready: string[] = [];
    const waiting: { client: string; why: string }[] = [];
    for (const c of clients ?? []) {
        const why = c.status !== "active" ? "not active"
            : c.base_package === "no" ? "SEO only: no GHL account"
            : String(c.ghl_location_id ?? "").trim() ? "already has a GHL location ID"
            : made.has(c.name) ? "Golden Eye already made their account"
            : !finished.has(norm(c.name)) ? "onboarding not finished"
            : !answered.has(c.name) ? "didn't answer the new questionnaire (About your business)"
            : null;
        if (why) waiting.push({ client: c.name, why }); else ready.push(c.name);
    }
    return { ready, waiting };
}

// ---- creating and filling ----

async function createFor(deps: Deps, token: string, companyId: string, snapshotId: string, client: string, by: string) {
    const nowIso = (deps.now ?? (() => new Date()))().toISOString();
    // The row first: its primary key is what stops two runs creating two accounts
    const { error: lockErr } = await deps.db.from("ghl_accounts").insert({ client_name: client, status: "creating", snapshot_id: snapshotId, created_by: by, created_at: nowIso, updated_at: nowIso });
    if (lockErr) return { client, created: false, error: /duplicate|23505|unique/i.test(lockErr.message ?? "") ? "already being created" : `couldn't record it: ${lockErr.message}` };
    try {
        const { steps, rows } = await answersFor(deps, client);
        const { ghl, cv } = mapAnswers(steps, rows);
        const body = accountBody(client, ghl, cv, companyId, snapshotId);
        const j = await ghlWrite(deps, "POST", "/locations/", token, body, { by, client, location: null, summary: `create "${String(body.name).slice(0, 80)}" from snapshot ${snapshotId}` });
        const id = String(j?.id ?? j?.location?.id ?? j?._id ?? "");
        if (!/^[A-Za-z0-9]{10,40}$/.test(id)) throw new Error("GHL created the account but didn't return its id. Find it in GHL and put it in Edit Client.");
        await deps.db.from("ghl_accounts").update({ location_id: id, status: "awaiting_install", last_error: null, updated_at: nowIso }).eq("client_name", client);
        // Only fills an empty field: never overwrites a location id someone typed in the meantime
        await deps.db.from("clients").update({ ghl_location_id: id }).eq("name", client).is("ghl_location_id", null);
        await deps.db.from("clients").update({ ghl_location_id: id }).eq("name", client).eq("ghl_location_id", "");
        console.log(`ghl-account: created ${id} for ${client} (by ${by})`);
        return { client, created: true, location_id: id, name: body.name };
    } catch (e) {
        await deps.db.from("ghl_accounts").update({ status: "failed", last_error: errText(e).slice(0, 500), updated_at: nowIso }).eq("client_name", client);
        return { client, created: false, error: errText(e) };
    }
}

async function fillFor(deps: Deps, account: any, by: string, companyToken: string, companyId: string) {
    const client = account.client_name, loc = String(account.location_id ?? "");
    const nowIso = (deps.now ?? (() => new Date()))().toISOString();
    if (!/^[A-Za-z0-9]{10,40}$/.test(loc)) return { client, filled: false, error: "no location id recorded" };
    if (loc === deps.env.GHL_MASTER_LOCATION_ID?.trim()) return { client, filled: false, error: "that's Master; Golden Eye never fills Master" };
    const token = await locationAccessToken(deps, loc);
    const list = await ghlRead(deps, `/locations/${encodeURIComponent(loc)}/customValues`, token);
    const existing = Array.isArray(list?.customValues) ? list.customValues : [];
    const { steps, rows } = await answersFor(deps, client);
    const { cv } = mapAnswers(steps, rows);
    const plan = planFill(existing, cv);
    const failed: { key: string; error: string }[] = [];
    const written: string[] = [];
    for (const w of plan.writes) {
        try {
            await ghlWrite(deps, "PUT", `/locations/${encodeURIComponent(loc)}/customValues/${encodeURIComponent(w.id)}`, token,
                { name: w.name, value: w.value }, { by, client, location: loc, summary: `fill custom value ${w.key}` });
            written.push(w.key);
        } catch (e) { failed.push({ key: w.key, error: errText(e) }); }
    }
    // Their team's logins, once the values are in. A person who can't be added is reported, never retried by the
    // schedule (an admin runs "add_users"), so a refused email doesn't hold the account back.
    const users = failed.length ? { users_added: [], users_failed: [] } : await addTeamUsers(deps, companyToken, companyId, client, loc, by);
    const report = { written, unchanged: plan.unchanged, not_in_account: plan.missing, failed, ...users };
    await deps.db.from("ghl_accounts").update({
        status: failed.length ? "awaiting_install" : "filled",
        installed_at: account.installed_at ?? nowIso,
        filled_at: failed.length ? null : nowIso,
        fill_report: report,
        last_error: failed.length ? `${failed.length} value(s) failed: ${failed[0].error}`.slice(0, 500) : null,
        updated_at: nowIso,
    }).eq("client_name", client).eq("location_id", loc);
    console.log(`ghl-account: filled ${loc} for ${client}: ${written.length} written, ${failed.length} failed`);
    return { client, location_id: loc, filled: !failed.length, ...report };
}

async function installedIds(deps: Deps, companyToken: string, companyId: string) {
    const j = await ghlRead(deps, `/oauth/installedLocations?companyId=${encodeURIComponent(companyId)}&appId=${encodeURIComponent(appId(deps.env))}&isInstalled=true&limit=500`, companyToken);
    return new Set((Array.isArray(j?.locations) ? j.locations : []).map((l: any) => String(l._id ?? l.id)));
}

// ---- the request ----

export async function handle(req: Request, deps: Deps): Promise<Response> {
    const reply = (body: unknown, status = 200) => Response.json(body, { status });
    if (req.method !== "POST") return reply({ error: "POST only" }, 405);

    let who = "schedule";
    const isCron = cronCheck(req, deps.env.MAKE_WEBHOOK_SECRET);
    if (!isCron) {
        const caller = await adminCheck(deps.db, req);
        if (!caller.ok) { console.warn("ghl-account REFUSED:", caller.reason); return reply({ error: caller.reason }, 403); }
        who = caller.kind === "admin" ? caller.email : "schedule";
    }
    const body = await req.json().catch(() => ({}));
    const mode = String(body?.mode ?? "status");

    const companyId = deps.env.GHL_COMPANY_ID?.trim() ?? "";
    const snapshotId = deps.env.GHL_SNAPSHOT_ID?.trim() ?? "";
    const auto = deps.env.GHL_AUTO_CREATE?.trim().toLowerCase() === "on";
    if (!oauthConfigured(deps.env)) return reply({ error: "The Golden Eye GHL app isn't set up (GHL_APP_CLIENT_ID, GHL_APP_CLIENT_SECRET, GHL_TOKEN_KEY, GHL_COMPANY_ID)." }, 500);
    if (!/^[A-Za-z0-9]{10,40}$/.test(snapshotId)) return reply({ error: "Set GHL_SNAPSHOT_ID to the MasterV.1 snapshot's id." }, 500);

    try {
        if (mode === "status") {
            const { data: rows } = await deps.db.from("ghl_accounts").select("*");
            return reply({ mode, auto_create: auto, install_url: deps.env.GHL_APP_INSTALL_URL?.trim() || null, accounts: rows ?? [], ...(await candidates(deps)) });
        }

        if (mode === "sweep" || mode === "create" || mode === "fill") {
            if ((mode === "create" || mode === "fill") && isCron) return reply({ error: `"${mode}" is for an admin; the schedule only sweeps.` }, 403);
            const companyToken = await companyAccessToken(deps);
            const report: any = { mode, auto_create: auto, created: [], filled: [], waiting_for_install: [] };

            // 1. New accounts
            const { ready, waiting } = await candidates(deps);
            report.waiting = waiting;
            let toCreate: string[] = [];
            if (mode === "sweep") toCreate = auto ? ready.slice(0, MAX_PER_SWEEP) : [];
            if (mode === "create") {
                const one = String(body?.client ?? "");
                if (!ready.includes(one)) return reply({ error: `${one || "That client"} doesn't qualify: ${waiting.find((w) => w.client === one)?.why ?? "not in the Onboarding stage"}.` }, 409);
                if (body?.confirm !== true) return reply({ mode, dry_run: true, would_create_for: one, note: 'Send "confirm": true to create it.' });
                toCreate = [one];
            }
            if (mode === "sweep" && !auto) report.would_create = ready;
            for (const c of toCreate) report.created.push(await createFor(deps, companyToken, companyId, snapshotId, c, who));

            // 2. Fill the accounts the app has been installed on
            if (mode !== "create") {
                const { data: rows } = await deps.db.from("ghl_accounts").select("*").eq("status", "awaiting_install");
                let pending = rows ?? [];
                if (mode === "fill") pending = pending.filter((r: any) => r.client_name === String(body?.client ?? ""));
                if (pending.length) {
                    const installed = await installedIds(deps, companyToken, companyId);
                    for (const r of pending) {
                        if (!installed.has(String(r.location_id))) { report.waiting_for_install.push(r.client_name); continue; }
                        try { report.filled.push(await fillFor(deps, r, who, companyToken, companyId)); }
                        catch (e) { report.filled.push({ client: r.client_name, filled: false, error: errText(e) }); }
                    }
                }
            }
            if (report.waiting_for_install.length) report.install_url = deps.env.GHL_APP_INSTALL_URL?.trim() || null;
            return reply(report);
        }

        if (mode === "add_users") {
            // People added to a client's team after their account was filled. Admin only, and only for an account
            // Golden Eye created and filled.
            if (isCron) return reply({ error: '"add_users" is for an admin.' }, 403);
            const one = String(body?.client ?? "");
            const { data: row } = await deps.db.from("ghl_accounts").select("*").eq("client_name", one).maybeSingle();
            if (!row?.location_id || row.status !== "filled") return reply({ error: `${one || "That client"} has no filled account Golden Eye made (${row ? row.status : "no record"}).` }, 409);
            if (row.location_id === deps.env.GHL_MASTER_LOCATION_ID?.trim()) return reply({ error: "That's Master." }, 409);
            return reply({ mode, client: one, ...(await addTeamUsers(deps, await companyAccessToken(deps), companyId, one, row.location_id, who)) });
        }

        if (mode === "retry") {
            // A creation that failed before GHL returned an account. Only then: if a location id was recorded, the
            // account exists and a retry would make a second one.
            if (isCron) return reply({ error: '"retry" is for an admin.' }, 403);
            const one = String(body?.client ?? "");
            const { data: row } = await deps.db.from("ghl_accounts").select("*").eq("client_name", one).maybeSingle();
            if (!row || row.status !== "failed" || row.location_id) return reply({ error: `Only a failed creation with no account made can be retried (${one}: ${row ? row.status : "no record"}).` }, 409);
            if (body?.confirm !== true) return reply({ mode, dry_run: true, would_retry: one, last_error: row.last_error, note: 'Send "confirm": true to try again.' });
            await deps.db.from("ghl_accounts").delete().eq("client_name", one).eq("status", "failed").is("location_id", null);
            const { ready, waiting } = await candidates(deps);
            if (!ready.includes(one)) return reply({ error: `${one} doesn't qualify: ${waiting.find((w) => w.client === one)?.why ?? "not in Onboarding"}.` }, 409);
            return reply({ mode, created: [await createFor(deps, await companyAccessToken(deps), companyId, snapshotId, one, who)] });
        }

        return reply({ error: 'Unknown mode. Use "status", "sweep", "create", "fill", "add_users" or "retry".' }, 400);
    } catch (e) {
        console.error("ghl-account failed:", errText(e));
        return reply({ error: errText(e) }, 502);
    }
}
