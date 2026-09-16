// Client work summary — runs unattended from pg_cron each weekday. For every active
// client it looks at what got done in the trailing 7 days and what's still open, and
// asks the model for a short plain-text recap. That recap is what the portal shows in
// place of the old ad-performance blurb, and by default at the top of the Tasks tab.
//
// No browser ever calls this function directly — the portal reads the table it writes
// to (client_work_summaries) straight through Supabase, the same way it already reads
// daily_reports, with RLS deciding what each signed-in client can see. So unlike
// morning-audit this needs no CORS handling: it is invoked only by cron, or by hand
// with curl for testing. The caller check at the top of the handler is what stops anyone
// else (the gateway accepts the public anon key): cron sends x-cron-secret, an admin JWT
// may force. See supabase/sql/client_summary_cron_secret.sql.
//
// Deploy:  supabase functions deploy client-summary
// Secrets: OPENAI_API_KEY — same project-wide secret morning-audit already uses.
//          SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected for us.
// Schema:  run schema.sql once first.

import OpenAI from "npm:openai";
import { createClient } from "npm:@supabase/supabase-js@2";
import { adminCheck, cronCheck } from "../_shared/admin-auth.ts";

const RECENT_DAYS = 7;

const normalize = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function dayNumber(iso: string | null | undefined): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
    if (!m) return null;
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

const PROMPT_INSTRUCTIONS = `
You are writing a short weekly update for this client to read in their own portal — a
status note, not a performance report. Ad spend, leads, and CPL live elsewhere in their
dashboard; do not mention money or any performance number here, even in passing.

Every open item below is already labeled OVERDUE, DUE SOON, or DUE (with its date) —
that label is authoritative. Never restate a due date without repeating its label
exactly, and never describe an OVERDUE item as "scheduled" or "on track" or imply its
date is still ahead of us. If nothing is overdue, do not mention overdue items at all.

Write 2-4 sentences, plain text only — no markdown, no HTML, no bullet points, no
greeting, no sign-off. Warm and confident, but never invent activity that is not in the
lists you were given. If something was completed, name it plainly. If nothing was
completed and nothing is open, say it was a quiet week and that this is normal — not
something to apologize for or explain away.`;

async function loadClients(db: any) {
    const { data, error } = await db.from("clients").select("name, status");
    if (error) throw new Error(`clients: ${error.message}`);
    return (data ?? []).filter((c: any) =>
        (c.status || "active") === "active" && normalize(c.name) !== normalize("Midas Media"));
}

async function loadTasks(db: any) {
    // Client Request rows are the client's own submissions, not work done for
    // them — cpTasksForClient() in app.js excludes them from the same two lists
    // this mirrors, so this does too.
    // Tasks hidden from the client (tasks.client_visible = false, supabase/sql/task_client_visibility.sql)
    // are left out too: this summary is shown in the client's own portal.
    const { data, error } = await db
        .from("tasks")
        .select("client, title, status, type, due, updated_at, client_visible")
        .neq("type", "Client Request");
    if (error) throw new Error(`tasks: ${error.message}`);
    return (data ?? []).filter((t: any) => t.client_visible !== false);
}

function buildLists(tasks: any[], clientName: string, cutoffDay: number) {
    const want = normalize(clientName);
    const mine = tasks.filter((t) => normalize(t.client || "") === want);

    const completed = mine.filter((t) => {
        if (t.status !== "Complete") return false;
        const d = dayNumber(t.updated_at);
        return d !== null && d >= cutoffDay;
    });

    const open = mine.filter((t) => t.status !== "Complete");

    return { completed, open };
}

// The model is never told what "today" is and must never be asked to work out whether
// a date has passed — that is exactly the kind of arithmetic this project keeps out of
// the model's hands. Label each due date here instead, in code, and hand the model an
// already-correct fact rather than a raw date for it to misjudge. This is what caught
// the very first live run describing tasks that were two weeks overdue as though their
// due date still lay ahead.
function dueLabel(due: string | null | undefined, todayNum: number): string {
    if (!due) return "";
    const d = dayNumber(due);
    if (d === null) return "";
    if (d < todayNum) return ` (OVERDUE — was due ${due})`;
    if (d <= todayNum + 3) return ` (DUE SOON — ${due})`;
    return ` (DUE ${due})`;
}

Deno.serve(async (req: Request) => {
    try {
        const body = await req.json().catch(() => ({}));
        const force = body?.force === true;

        const db = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );

        // Who's asking, decided before any task is read or any model call is made. Until
        // 2026-09-16 this checked nothing: the public anon key could send force:true and make it
        // rewrite every client's portal summary on our OpenAI account. Same rule as morning-audit:
        //   - pg_cron sends x-cron-secret (Vault make_onboarding_hook_secret = MAKE_WEBHOOK_SECRET),
        //     which unlocks only the normal idempotent daily run.
        //   - A signed-in admin can also force a regeneration.
        //   - Anyone else is refused, with the reason in the log.
        if (cronCheck(req, Deno.env.get("MAKE_WEBHOOK_SECRET"))) {
            if (force) {
                console.warn("client-summary REFUSED: cron secret used for force");
                return Response.json({ error: "The schedule can only run the daily summaries." }, { status: 403 });
            }
        } else {
            const who = await adminCheck(db, req);
            if (!who.ok) {
                console.warn("client-summary REFUSED:", who.reason);
                return Response.json({ error: who.reason }, { status: 403 });
            }
        }

        const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY")! });

        const todayNum = Math.floor(Date.now() / 86400000);
        const rangeEnd = new Date(todayNum * 86400000).toISOString().split("T")[0];
        const rangeStart = new Date((todayNum - RECENT_DAYS + 1) * 86400000).toISOString().split("T")[0];
        const cutoffDay = todayNum - RECENT_DAYS + 1;

        const [clients, tasks] = await Promise.all([loadClients(db), loadTasks(db)]);

        const results: Record<string, string> = {};

        for (const client of clients) {
            try {
                if (!force) {
                    const { data: existing } = await db
                        .from("client_work_summaries")
                        .select("id")
                        .eq("client_name", client.name)
                        .eq("range_end", rangeEnd)
                        .limit(1);
                    if (existing?.length) { results[client.name] = "skipped"; continue; }
                }

                const { completed, open } = buildLists(tasks, client.name, cutoffDay);

                // Deliberately only the fields already shown raw in the portal today —
                // title, status, type, due date. Never `notes`: that field is written by
                // staff for internal use and can carry commentary never meant for the
                // client reading it back in their own dashboard.
                const completedList = completed.length
                    ? completed.map((t) => `- ${t.title} (${t.type || "task"})`).join("\n")
                    : "Nothing completed this week.";
                const openList = open.length
                    ? open.map((t) => `- ${t.title}${dueLabel(t.due, todayNum)}`).join("\n")
                    : "Nothing currently open.";

                const input = `CLIENT: ${client.name}\n\n`
                    + `COMPLETED (last ${RECENT_DAYS} days):\n${completedList}\n\n`
                    + `CURRENTLY OPEN:\n${openList}\n`
                    + PROMPT_INSTRUCTIONS;

                const response = await openai.responses.create({
                    model: "gpt-5.6-sol",
                    input,
                    // A friendly recap of an already-short, already-deterministic list —
                    // there is no judgment call here for effort to help with, unlike the
                    // morning audit's multi-constraint prompt. Low keeps ~10 daily calls
                    // to pennies.
                    reasoning: { effort: "low" },
                    max_output_tokens: 600,
                });

                if (response.status === "incomplete") {
                    throw new Error(`model stopped early: ${response.incomplete_details?.reason ?? "unknown"}`);
                }
                const summary = (response.output_text ?? "").trim();
                if (!summary) throw new Error("model returned no text");

                // Upsert, not insert: force:true is meant to regenerate today's card, and
                // a plain insert would collide with the unique(client_name, range_end)
                // constraint against the row this same client already has for today.
                const { error: insErr } = await db.from("client_work_summaries").upsert([{
                    client_name: client.name,
                    range_start: rangeStart,
                    range_end: rangeEnd,
                    summary,
                    tasks_completed: completed.length,
                    tasks_open: open.length,
                }], { onConflict: "client_name,range_end" });
                if (insErr) throw insErr;

                results[client.name] = "generated";
            } catch (err) {
                // One client's bad data or a single flaky model call must never take
                // down the other nine — log it and keep going.
                console.error(`client-summary failed for ${client.name}:`, err);
                results[client.name] = `error: ${String((err as Error)?.message ?? err)}`;
            }
        }

        return Response.json({ range: { rangeStart, rangeEnd }, results });
    } catch (err) {
        console.error("client-summary failed:", err);
        return Response.json({ error: String((err as Error)?.message ?? err) }, { status: 500 });
    }
});
