// onboarding-booking: a real booking ticks the client's booking step, and nothing else does. Run (node 22.6+):
//   node --experimental-strip-types supabase/functions/onboarding-booking/handler.test.mjs
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { handle, readBooking, isBookingWidget } = await import(pathToFileURL(path.join(here, 'handler.ts')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const SECRET = 'a'.repeat(64);
const CAL = 'n86mJ3snZYWS8KgxbPKe';

function fakeDb({ clients, steps, progress = [] } = {}) {
    const db = {
        rows: progress.map((p) => ({ ...p })), inserts: [], updates: [],
        clients: async () => clients ?? [{ name: 'Todd Woods Franchise Coaching', client_email: 'todd@toddwoodscoach.com', status: 'active' }, { name: 'Other', client_email: 'a@b.com, c@d.com', status: 'active' }],
        bookingSteps: async () => steps ?? [{ id: 'book', embed_url: `https://link.midasmediafirm.com/widget/booking/${CAL}` }, { id: 'form1', embed_url: 'https://link.midasmediafirm.com/widget/form/xyz' }],
        progress: async (client, step) => db.rows.find((r) => r.client_name === client && r.step_id === step) ?? null,
        insertProgress: async (row) => { db.inserts.push(row); db.rows.push({ id: 'new', ...row }); },
        completeProgress: async (id, at) => { db.updates.push(id); const r = db.rows.find((x) => x.id === id); if (r && !r.completed_at) r.completed_at = at; },
    };
    return db;
}
const booking = (email, extra = {}) => ({ email, first_name: 'Todd', calendar: { id: CAL, appoinmentStatus: 'confirmed', ...extra } });
const run = (db, body, given = SECRET, secret = SECRET) => handle({ secret, given, body }, db, new Date('2026-11-13T18:00:00Z'));

// Gate
ok((await run(fakeDb(), booking('todd@toddwoodscoach.com'), 'wrong')).status === 401, 'a wrong secret is refused');
ok((await run(fakeDb(), booking('todd@toddwoodscoach.com'), SECRET, '')).status === 500, 'no secret configured refuses everything');
ok((await run(fakeDb(), booking('todd@toddwoodscoach.com'), `"${SECRET}"\n`)).status === 200, 'a pasted secret with quotes or a newline still works');

// The real booking
let db = fakeDb();
let r = await run(db, booking('Todd@ToddWoodsCoach.com'));
ok(r.body.done && db.inserts.length === 1 && db.inserts[0].step_id === 'book' && db.inserts[0].completed_by === 'booking' && db.inserts[0].client_name === 'Todd Woods Franchise Coaching', 'a booking ticks the booking step for the matching client');
ok(db.inserts[0].completed_at === '2026-11-13T18:00:00.000Z', 'with the time it arrived');
r = await run(db, booking('todd@toddwoodscoach.com'));
ok(r.body.already && db.inserts.length === 1, 'a second booking changes nothing');

db = fakeDb({ progress: [{ id: 'p1', client_name: 'Todd Woods Franchise Coaching', step_id: 'book', completed_at: null }] });
await run(db, booking('todd@toddwoodscoach.com'));
ok(db.updates[0] === 'p1' && db.inserts.length === 0, 'an existing unfinished row is completed, not duplicated');

db = fakeDb();
await run(db, booking('c@d.com'));
ok(db.inserts[0]?.client_name === 'Other', 'any address on the client\'s email field counts');

// Things that must not tick anything
for (const [name, body, extra] of [
    ['an email no client has', booking('stranger@x.com')],
    ['no email at all', { calendar: { id: CAL } }],
    ['another calendar', booking('todd@toddwoodscoach.com', { id: 'someOtherCalendar' })],
    ['a cancelled appointment', booking('todd@toddwoodscoach.com', { appoinmentStatus: 'cancelled' })],
]) {
    db = fakeDb();
    r = await run(db, body);
    ok(r.status === 200 && !r.body.done && db.inserts.length === 0, `nothing ticked for ${name}`);
}
db = fakeDb({ clients: [{ name: 'A', client_email: 'same@x.com', status: 'active' }, { name: 'B', client_email: 'same@x.com', status: 'active' }] });
ok(!(await run(db, booking('same@x.com'))).body.done && db.inserts.length === 0, 'two clients sharing an email: nothing ticked');
db = fakeDb({ clients: [{ name: 'Old', client_email: 'todd@toddwoodscoach.com', status: 'archived' }, { name: 'Todd Woods Franchise Coaching', client_email: 'todd@toddwoodscoach.com', status: 'active' }] });
await run(db, booking('todd@toddwoodscoach.com'));
ok(db.inserts[0]?.client_name === 'Todd Woods Franchise Coaching', 'archived clients are ignored');

// Reading GHL's payload, and spotting a booking widget
ok(readBooking({ contact: { email: 'X@Y.com' }, calendarId: 'c1' }).email === 'x@y.com' && readBooking({ calendarId: 'c1' }).calendarId === 'c1', 'reads email and calendar from either shape');
ok(isBookingWidget(`https://link.midasmediafirm.com/widget/booking/${CAL}`) && !isBookingWidget('https://link.midasmediafirm.com/widget/form/abc'), 'booking widgets told apart from forms');
db = fakeDb();
await run(db, { email: 'todd@toddwoodscoach.com' });
ok(db.inserts[0]?.step_id === 'book', 'no calendar id sent: the one booking step is used');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
