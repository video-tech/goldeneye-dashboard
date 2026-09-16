// Pure request checks for ai-chat — no imports, no I/O, so they can be tested with plain objects.
// index.ts is the only caller.

export const MAX_MESSAGES = 100;
// The weekly report prompt (HTML template + a client's figures) is the largest real payload, at
// tens of thousands of characters. This cap sits well above that and well below a request built
// to run up the OpenAI bill.
export const MAX_TOTAL_CHARS = 300_000;

const ROLES = new Set(["system", "user", "assistant"]);

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

// Returns the cleaned messages, or a plain-English reason they were refused. Only role and
// content are passed on: anything else a caller adds (tools, functions, a name) is dropped, so
// this can't be used to reach OpenAI features the dashboard doesn't use.
export function validateMessages(body: unknown): { ok: true; messages: ChatMessage[] } | { ok: false; error: string } {
    const messages = (body as any)?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return { ok: false, error: "messages must be a non-empty list" };
    if (messages.length > MAX_MESSAGES) return { ok: false, error: `too many messages (${messages.length}, limit ${MAX_MESSAGES})` };

    const out: ChatMessage[] = [];
    let chars = 0;
    for (const m of messages) {
        const role = String(m?.role ?? "");
        if (!ROLES.has(role)) return { ok: false, error: `unsupported role "${role.slice(0, 20)}"` };
        if (typeof m?.content !== "string") return { ok: false, error: "every message needs text content" };
        chars += m.content.length;
        if (chars > MAX_TOTAL_CHARS) return { ok: false, error: `request too large (over ${MAX_TOTAL_CHARS.toLocaleString("en-US")} characters)` };
        out.push({ role: role as ChatMessage["role"], content: m.content });
    }
    return { ok: true, messages: out };
}

export const ALLOWED_ORIGINS = [
    "https://goldeneye.midasmediafirm.com",
    "https://video-tech.github.io",
];

export function allowOrigin(origin: string | null): string {
    return ALLOWED_ORIGINS.includes(origin ?? "") ? origin! : ALLOWED_ORIGINS[0];
}
