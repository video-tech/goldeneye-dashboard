// What the Overview chat accepts from the browser. Roles are user and assistant only: a caller can
// never inject a system message, and tool traces are never sent (the function rebuilds them). No
// imports, so it runs under node for tests.

export const MAX_TURNS = 20;
export const MAX_TURN_CHARS = 4_000;
export const MAX_TOTAL_CHARS = 30_000;

export type Turn = { role: "user" | "assistant"; content: string };

export function validateTurns(body: any): { ok: true; turns: Turn[] } | { ok: false; error: string } {
    const raw = body?.messages;
    if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "messages must be a non-empty list" };
    if (raw.length > MAX_TURNS) return { ok: false, error: `too many messages (${raw.length}, limit ${MAX_TURNS}). Start a new chat.` };
    const turns: Turn[] = [];
    let chars = 0;
    for (const m of raw) {
        if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
            return { ok: false, error: "each message needs a role of user or assistant and text content" };
        }
        const content = m.content.trim();
        if (!content) return { ok: false, error: "a message was empty" };
        if (content.length > MAX_TURN_CHARS) return { ok: false, error: `a message is too long (limit ${MAX_TURN_CHARS} characters)` };
        chars += content.length;
        turns.push({ role: m.role, content });
    }
    if (chars > MAX_TOTAL_CHARS) return { ok: false, error: "the conversation is too long. Start a new chat." };
    if (turns[turns.length - 1].role !== "user") return { ok: false, error: "the last message must be from the user" };
    return { ok: true, turns };
}
