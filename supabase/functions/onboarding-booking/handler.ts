// onboarding-booking: ticks a client's "Book your setup call" step when the booking really happens (built 2026-11-12).
//
// Why: the step used to be ticked by the client clicking "I booked it", which proves nothing. Todd Woods ticked it a minute
// into onboarding and no appointment existed. Now the step has no client button (requires_confirm off, so the portal treats it
// like a form that ticks itself), and a workflow in our Midas GHL calls this when someone books the onboarding calendar:
// trigger Customer Booked Appointment (that calendar) -> Webhook POST here with the x-webhook-secret header, the same secret
// and header as Lead Relay. Admins can still tick or untick it by hand.
//
// What it does: finds the ONE client whose client_email lists the booker's email, finds the active client booking step (a form
// step whose embed is a GHL booking widget, the calendar id in the URL when GHL sends one), and marks it done. It never unticks,
// never touches another step, and does nothing unless exactly one client matches. completed_by is "booking", so the handoff
// trigger treats it like any completion. Nothing personal is logged: the email only as a match count.
//
// The logic is here with no Deno or npm imports, so plain node can test it (handler.test.mjs). index.ts supplies the database.

export interface Db {
    clients(): Promise<{ name: string; client_email: string | null; status: string | null }[]>;
    bookingSteps(): Promise<{ id: string; embed_url: string | null }[]>;
    progress(client: string, stepId: string): Promise<{ id: string; completed_at: string | null } | null>;
    insertProgress(row: { client_name: string; step_id: string; completed_at: string; completed_by: string }): Promise<void>;
    completeProgress(id: string, completedAt: string): Promise<void>;
}

export function normaliseSecret(s: string | null | undefined): string {
    let t = String(s ?? "").trim();
    if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) t = t.slice(1, -1).trim();
    return t;
}

export function safeEqual(a: string, b: string): boolean {
    if (!a || !b || a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
}

const pick = (o: any, ...paths: string[]): string => {
    for (const p of paths) {
        const v = p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
        if (v != null && String(v).trim()) return String(v).trim();
    }
    return "";
};

// GHL's workflow webhook puts the contact at the top level and the appointment under "calendar"
export function readBooking(body: any): { email: string; calendarId: string; status: string } {
    return {
        email: pick(body, "email", "contact.email", "customData.email").toLowerCase(),
        calendarId: pick(body, "calendar.id", "calendar.calendarId", "calendarId", "calendar_id", "customData.calendar_id"),
        status: pick(body, "calendar.appoinmentStatus", "calendar.appointmentStatus", "calendar.status", "appointmentStatus").toLowerCase(),
    };
}

export const isBookingWidget = (url: string | null) => /\/widget\/(booking|bookings|appointment)s?\//i.test(String(url || ""));

export async function handle(input: { secret: string | null; given: string | null; body: unknown }, db: Db, now = new Date()) {
    const expected = normaliseSecret(input.secret);
    if (!expected) return { status: 500, body: { error: "not configured" } };
    if (!safeEqual(normaliseSecret(input.given), expected)) return { status: 401, body: { error: "unauthorized" } };

    const b = readBooking(input.body ?? {});
    if (!b.email || !b.email.includes("@")) return { status: 200, body: { done: false, reason: "no email in the booking" } };
    if (/cancel|no.?show|invalid/.test(b.status)) return { status: 200, body: { done: false, reason: `appointment ${b.status}` } };

    const clients = (await db.clients()).filter((c) => (c.status || "active") !== "archived" &&
        String(c.client_email || "").toLowerCase().split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean).includes(b.email));
    if (clients.length !== 1) return { status: 200, body: { done: false, reason: clients.length ? "more than one client has that email" : "no client has that email" } };
    const client = clients[0].name;

    let steps = (await db.bookingSteps()).filter((s) => isBookingWidget(s.embed_url));
    if (b.calendarId) {
        const byCal = steps.filter((s) => String(s.embed_url).includes(b.calendarId));
        if (byCal.length) steps = byCal;
        else return { status: 200, body: { done: false, reason: "not the onboarding calendar" } };
    }
    if (steps.length !== 1) return { status: 200, body: { done: false, reason: steps.length ? "more than one booking step" : "no booking step" } };
    const step = steps[0];

    const at = now.toISOString();
    const existing = await db.progress(client, step.id);
    if (existing?.completed_at) return { status: 200, body: { done: true, already: true, client } };
    if (existing) await db.completeProgress(existing.id, at);
    else await db.insertProgress({ client_name: client, step_id: step.id, completed_at: at, completed_by: "booking" });
    return { status: 200, body: { done: true, client } };
}
