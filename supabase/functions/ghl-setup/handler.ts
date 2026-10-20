// The ghl-setup request flow. Only imports admin-auth (itself import-free), so ghl-setup.test.mjs
// runs it under plain node with a fake GHL and a fake database. index.ts supplies the real ones.
//
// Three independent sections, each checked, created only on confirm, then read back from GHL:
// custom values, contact custom fields, and the default pipeline. One section failing never stops
// the others; each reports its own error.

import { adminCheck, cronCheck } from "../_shared/admin-auth.ts";
import {
    planValues, planPipeline, choicesMissing,
    MASTER_CONTACT_FIELDS, MASTER_FIELD_FOLDERS, MASTER_PIPELINE, RECREATE_SINCE,
    type Existing, type WantedField,
} from "./plan.ts";

export type Env = {
    GHL_MASTER_TOKEN?: string;
    GHL_MASTER_LOCATION_ID?: string;
    MAKE_WEBHOOK_SECRET?: string;
};

export type Deps = { env: Env; db: any; fetch: typeof fetch; sleep?: (ms: number) => Promise<void> };

// GHL lists a new item a moment after creating it: the first real run read back too soon and
// reported the last field and the new pipeline as missing although both existed (2026-10-14).
const SETTLE_MS = 2500;
const settle = (deps: Deps) => (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(SETTLE_MS);

const GHL = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
// GHL's Create Pipeline page documents "v3" as its only Version; everything else here is 2021-07-28.
const PIPELINE_VERSION = "v3";

class GhlError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
}

// GHL's error text, never the token or the location id (both scrubbed in case an error echoes them).
async function ghl(deps: Deps, method: string, path: string, body?: unknown, version = VERSION) {
    const token = deps.env.GHL_MASTER_TOKEN!.trim();
    const loc = deps.env.GHL_MASTER_LOCATION_ID!.trim();
    const res = await deps.fetch(GHL + path, {
        method,
        headers: {
            "Authorization": `Bearer ${token}`,
            "Version": version,
            "Accept": "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
        const raw = json?.message ?? text ?? "";
        const msg = (Array.isArray(raw) ? raw.join("; ") : String(raw)).split(token).join("[token]").split(loc).join("<master>").slice(0, 300);
        // GHL says "Invalid JWT" when the value isn't a token at all (a typo, a placeholder, quotes),
        // and "not authorized for this scope" when it is one but lacks the scope.
        const hint = res.status !== 401 ? ""
            : /invalid jwt/i.test(msg)
                ? " GHL doesn't recognise GHL_MASTER_TOKEN as a token: set it again with the full Private Integration token."
                : " The token is missing a scope for this call (custom values, custom fields or opportunities), or belongs to another location.";
        throw new GhlError(`GHL ${method} ${path.split(loc).join("<master>")} answered ${res.status}: ${msg}.${hint}`, res.status);
    }
    return json;
}

const errText = (e: unknown) => (e as Error).message;
const stop = (e: unknown) => [401, 429].includes((e as GhlError).status); // no point trying the rest

// ---- custom values ----
async function listValues(deps: Deps, loc: string): Promise<Existing[]> {
    const json = await ghl(deps, "GET", `/locations/${encodeURIComponent(loc)}/customValues`);
    const list = Array.isArray(json?.customValues) ? json.customValues : null;
    if (!list) throw new Error("GHL's custom values answer had no customValues list.");
    return list.map((v: any) => ({ id: String(v.id), name: String(v.name ?? ""), fieldKey: v.fieldKey, value: v.value }));
}

async function valuesSection(deps: Deps, loc: string, write: boolean) {
    const before = planValues(await listValues(deps, loc));
    const missing = before.rows.filter((r) => r.status === "missing");
    if (!write) return { missing: missing.map((r) => r.name), ...before };

    // Empty values: each client's answers fill them later (phase 3).
    const created: string[] = [];
    const failed: { name: string; error: string }[] = [];
    for (const r of missing) {
        try {
            await ghl(deps, "POST", `/locations/${encodeURIComponent(loc)}/customValues`, { name: r.name, value: "" });
            created.push(r.name);
        } catch (e) {
            failed.push({ name: r.name, error: errText(e) });
            if (stop(e)) break;
        }
    }
    if (created.length) await settle(deps);
    const after = planValues(await listValues(deps, loc));
    return { created, failed, ...after, still_missing: after.rows.filter((r) => r.status === "missing").map((r) => r.name) };
}

// ---- contact custom fields, in folders ----
type Field = { id: string; name: string; fieldKey?: string; dataType?: string; picklistOptions?: unknown; parentId?: string; dateAdded?: string };
type Folder = { id: string; name: string };

const same = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

async function listFields(deps: Deps, loc: string): Promise<Field[]> {
    const json = await ghl(deps, "GET", `/locations/${encodeURIComponent(loc)}/customFields?model=contact`);
    const list = Array.isArray(json?.customFields) ? json.customFields : null;
    if (!list) throw new Error("GHL's custom fields answer had no customFields list.");
    return list
        .filter((f: any) => !f.model || f.model === "contact")
        .map((f: any) => ({
            id: String(f.id), name: String(f.name ?? ""), fieldKey: f.fieldKey, dataType: f.dataType,
            picklistOptions: f.picklistOptions, parentId: f.parentId, dateAdded: f.dateAdded,
        }));
}

// Contact-field folders. GHL documents its folder API for custom objects and companies only, so this
// is tried rather than assumed. When GHL won't list them the answer is null, and then no folder is
// created: one we can't see could be created twice on the next run.
async function listFolders(deps: Deps, loc: string): Promise<{ list: Folder[] | null; error?: string }> {
    try {
        const json = await ghl(deps, "GET", `/custom-fields/object-key/contact?locationId=${encodeURIComponent(loc)}`);
        const raw = Array.isArray(json?.folders) ? json.folders : null;
        if (!raw) return { list: null, error: "GHL's answer had no folders list." };
        return { list: raw.map((f: any) => ({ id: String(f.id ?? f._id ?? ""), name: String(f.name ?? "") })).filter((f: Folder) => f.id) };
    } catch (e) {
        return { list: null, error: errText(e) };
    }
}

function fieldsReport(list: Field[], folders: Folder[] | null) {
    const plan = planValues(list, MASTER_CONTACT_FIELDS);
    const rowOf = (key: string) => plan.rows.find((r) => r.key === key)!;
    const report = MASTER_FIELD_FOLDERS.map((ff) => {
        const folder = folders?.find((f) => same(f.name, ff.folder)) ?? null;
        const fields = ff.fields.map((w) => {
            const r = rowOf(w.key);
            if (r.status === "missing") return { name: w.name, key: w.key, status: "missing" as const };
            const saved = list.find((f) => f.id === (r as any).id)!;
            const filed = !!folder && saved.parentId === folder.id;
            return { name: w.name, key: w.key, id: saved.id, status: filed ? "filed" as const : "outside_folder" as const, dateAdded: saved.dateAdded, savedName: saved.name };
        });
        return { folder: ff.folder, folder_id: folder?.id ?? null, fields };
    });
    // A choice field that exists without all its choices (how choices are sent isn't in GHL's spec,
    // so this is read back rather than assumed).
    const choices_missing = MASTER_CONTACT_FIELDS.flatMap((w) => {
        const r = rowOf(w.key);
        if (r.status === "missing") return [];
        const miss = choicesMissing(w, list.find((f) => f.id === (r as any).id) ?? {});
        return miss.length ? [{ name: w.name, missing: miss }] : [];
    });
    const all = report.flatMap((f) => f.fields);
    return {
        folders_listed: folders !== null,
        folders: report.map((f) => ({ folder: f.folder, folder_id: f.folder_id, fields: f.fields.map((x) => `${x.name}: ${x.status}`) })),
        missing: all.filter((x) => x.status === "missing").map((x) => x.name),
        outside_folder: all.filter((x) => x.status === "outside_folder").map((x) => x.name),
        // Fields whose GHL name isn't yet their question.
        to_rename: all.flatMap((x) => {
            if (x.status === "missing") return [];
            const w = MASTER_CONTACT_FIELDS.find((f) => f.key === x.key)!;
            return (x as any).savedName === w.question ? [] : [{ name: x.name, id: (x as any).id, from: (x as any).savedName, to: w.question }];
        }),
        choices_missing,
        extra: plan.extra,
        _report: report,
    };
}

// Creates one field, inside the folder when there is one. GHL's newer custom fields endpoint takes a
// folder (parentId) but is documented for custom objects only; the older one is the endpoint that has
// worked for contact fields, and parentId isn't in its spec. So: the newer one first, the older one if
// it refuses, and the read-back says where the field actually landed.
async function createField(deps: Deps, loc: string, w: WantedField, folderId: string | null) {
    if (folderId) {
        try {
            return await ghl(deps, "POST", "/custom-fields/", {
                locationId: loc, objectKey: "contact", name: w.question, fieldKey: `contact.${w.key}`,
                dataType: w.dataType, parentId: folderId, showInForms: true,
                ...(w.placeholder ? { placeholder: w.placeholder } : {}),
                ...(w.options ? { options: w.options.map((label) => ({ key: slug(label), label })) } : {}),
            });
        } catch (e) {
            if (![400, 404, 422].includes((e as GhlError).status)) throw e;
        }
    }
    return await ghl(deps, "POST", `/locations/${encodeURIComponent(loc)}/customFields`, {
        // The name is what GHL shows as the question on forms and surveys.
        name: w.question, dataType: w.dataType, model: "contact",
        ...(w.placeholder ? { placeholder: w.placeholder } : {}),
        ...(w.options ? { options: w.options } : {}),
        ...(folderId ? { parentId: folderId } : {}),
    });
}

async function fieldsSection(deps: Deps, loc: string, write: boolean) {
    const f0 = await listFolders(deps, loc);
    const before = fieldsReport(await listFields(deps, loc), f0.list);
    const { _report, ...shown } = before;
    if (!write) return { ...shown, folders_error: f0.error };

    const created: string[] = [], recreated: string[] = [], renamed: string[] = [], folders_created: string[] = [];
    const failed: { name: string; error: string }[] = [];
    let stopped = false;
    for (const fr of _report) {
        if (stopped) break;
        const ff = MASTER_FIELD_FOLDERS.find((x) => x.folder === fr.folder)!;
        let folderId = fr.folder_id;
        if (!folderId && f0.list !== null) {
            try {
                const j = await ghl(deps, "POST", "/custom-fields/folder", { objectKey: "contact", name: ff.folder, locationId: loc });
                folderId = j?.id ?? j?._id ?? j?.folder?.id ?? j?.data?.id ?? null;
                if (!folderId) {
                    await settle(deps);
                    folderId = (await listFolders(deps, loc)).list?.find((f) => same(f.name, ff.folder))?.id ?? null;
                }
                if (folderId) folders_created.push(ff.folder);
                else failed.push({ name: `folder ${ff.folder}`, error: "GHL accepted the folder but it can't be found; its fields go in unfiled." });
            } catch (e) {
                failed.push({ name: `folder ${ff.folder}`, error: errText(e) });
                if (stop(e)) { stopped = true; break; }
            }
        }
        for (const f of fr.fields) {
            if (f.status === "filed") continue;
            const w = ff.fields.find((x) => x.key === f.key)!;
            try {
                if (f.status === "outside_folder") {
                    // Only ours, made empty today before folders existed, and only when there's a folder to put it in.
                    const may = !!folderId && (ff.recreate ?? []).includes(w.key) && String(f.dateAdded ?? "") >= RECREATE_SINCE;
                    if (!may) continue;
                    await ghl(deps, "DELETE", `/locations/${encodeURIComponent(loc)}/customFields/${encodeURIComponent(f.id!)}`);
                    try { await createField(deps, loc, w, folderId); recreated.push(w.name); }
                    catch (e) {
                        failed.push({ name: w.name, error: `deleted to move it, then not recreated (the next create run makes it again): ${errText(e)}` });
                        if (stop(e)) { stopped = true; break; }
                    }
                    continue;
                }
                await createField(deps, loc, w, folderId);
                created.push(w.name);
            } catch (e) {
                failed.push({ name: w.name, error: errText(e) });
                if (stop(e)) { stopped = true; break; }
            }
        }
    }
    // Rename existing fields to their question. Placeholder and choices are sent again with the name,
    // because an update that leaves them out may clear them; the read-back checks the choices survived.
    for (const r of stopped ? [] : before.to_rename) {
        if (recreated.includes(r.name)) continue;
        const w = MASTER_CONTACT_FIELDS.find((f) => f.name === r.name)!;
        try {
            await ghl(deps, "PUT", `/locations/${encodeURIComponent(loc)}/customFields/${encodeURIComponent(r.id)}`, {
                name: w.question,
                ...(w.placeholder ? { placeholder: w.placeholder } : {}),
                ...(w.options ? { options: w.options } : {}),
            });
            renamed.push(r.name);
        } catch (e) {
            failed.push({ name: r.name, error: `rename: ${errText(e)}` });
            if (stop(e)) break;
        }
    }
    if (created.length || recreated.length || renamed.length || folders_created.length) await settle(deps);
    const f1 = await listFolders(deps, loc);
    const { _report: _r, ...after } = fieldsReport(await listFields(deps, loc), f1.list);
    return { created, recreated, renamed, folders_created, failed, ...after, still_missing: after.missing, folders_error: f1.error };
}

// ---- the default pipeline ----
async function listPipelines(deps: Deps, loc: string) {
    const json = await ghl(deps, "GET", `/opportunities/pipelines?locationId=${encodeURIComponent(loc)}`);
    const list = Array.isArray(json?.pipelines) ? json.pipelines : null;
    if (!list) throw new Error("GHL's pipelines answer had no pipelines list.");
    return list.map((p: any) => ({
        id: String(p.id), name: String(p.name ?? ""),
        stages: (Array.isArray(p.stages) ? p.stages : []).map((s: any) => ({ name: String(s?.name ?? "") })),
    }));
}

async function pipelineSection(deps: Deps, loc: string, write: boolean) {
    const existing = await listPipelines(deps, loc);
    const before = planPipeline(existing);
    const others = existing.filter((p) => p.name !== before.name).map((p) => p.name);
    if (!write || before.status === "exists") return { ...before, other_pipelines: others };

    const body = {
        locationId: loc,
        name: MASTER_PIPELINE.name,
        stages: MASTER_PIPELINE.stages.map((name, position) => ({ name, position, showInFunnel: true })),
        showInFunnel: true,
        showInPieChart: true,
    };
    let error: string | null = null;
    try {
        await ghl(deps, "POST", "/opportunities/pipelines", body, PIPELINE_VERSION);
    } catch (e) {
        // A Version GHL won't take answers 400/404; try the version every other call uses, once. Names
        // are unique per location, so a retry can't make a second pipeline.
        if ([400, 404].includes((e as GhlError).status)) {
            try { await ghl(deps, "POST", "/opportunities/pipelines", body, VERSION); }
            catch (e2) { error = `${errText(e)} | then with Version ${VERSION}: ${errText(e2)}`; }
        } else {
            error = errText(e);
        }
    }
    if (!error) await settle(deps);
    const after = planPipeline(await listPipelines(deps, loc));
    // created reports the write; status reports what GHL lists after waiting.
    return { created: !error, error, ...after, other_pipelines: others };
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
    const reply = (body: unknown, status = 200) => Response.json(body, { status });
    if (req.method !== "POST") return reply({ error: "POST only" }, 405);

    // Admin, or the SQL Editor with the cron secret (same as meta-sync's one-off calls).
    let who = "cron";
    if (!cronCheck(req, deps.env.MAKE_WEBHOOK_SECRET)) {
        const caller = await adminCheck(deps.db, req);
        if (!caller.ok) {
            console.warn("ghl-setup REFUSED:", caller.reason);
            return reply({ error: caller.reason }, 403);
        }
        who = caller.kind === "admin" ? caller.email : "cron";
    }

    // The location comes from a secret, never the request: this function can only ever reach Master.
    const token = deps.env.GHL_MASTER_TOKEN?.trim();
    const loc = deps.env.GHL_MASTER_LOCATION_ID?.trim();
    if (!token || !loc) {
        return reply({ error: "Set the GHL_MASTER_TOKEN and GHL_MASTER_LOCATION_ID secrets first." }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const mode = String(body?.mode ?? "check");
    if (mode !== "check" && mode !== "create") return reply({ error: `Unknown mode "${mode}". Use "check" or "create".` }, 400);
    const write = mode === "create" && body?.confirm === true;

    const run = async (fn: () => Promise<any>) => { try { return await fn(); } catch (e) { return { error: errText(e) }; } };
    const values = await run(() => valuesSection(deps, loc, write));
    const fields = await run(() => fieldsSection(deps, loc, write));
    const pipeline = await run(() => pipelineSection(deps, loc, write));

    const sections = [values, fields, pipeline];
    const allFailed = sections.every((s) => s.error && !s.rows && !s.status);
    if (write) {
        console.log(`ghl-setup create by ${who}: values +${values.created?.length ?? 0}, fields +${fields.created?.length ?? 0}, pipeline ${pipeline.created ? "created" : pipeline.status ?? "error"}`);
    }
    if (allFailed) {
        console.error("ghl-setup failed:", values.error);
        return reply({ error: values.error, values, fields, pipeline }, 502);
    }
    return reply({
        mode, dry_run: !write,
        note: mode === "create" && !write ? 'Nothing was created. Send {"mode":"create","confirm":true} to create what is missing.' : undefined,
        values, fields, pipeline,
    });
}
