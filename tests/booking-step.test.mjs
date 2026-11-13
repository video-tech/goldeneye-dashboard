// The booking step (app.js obIsBookingStep / obClientCanToggle): a client can't tick it, it ticks itself from a real booking.
// Run: node tests/booking-step.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('function obIsBookingStep'), b = src.indexOf('function obCanToggleHere', a);
const { obIsBookingStep, obClientCanToggle } = new Function(src.slice(a, b) + '; return { obIsBookingStep, obClientCanToggle };')();
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const booking = { step_type: 'form', requires_confirm: false, embed_url: 'https://link.midasmediafirm.com/widget/booking/n86mJ3snZYWS8KgxbPKe' };
ok(obIsBookingStep(booking), 'the setup call calendar is a booking step');
ok(!obClientCanToggle(booking), 'a client cannot tick it');
ok(!obClientCanToggle({ ...booking, requires_confirm: true }), 'not even before the SQL turns its confirm button off');
ok(!obIsBookingStep({ step_type: 'form', embed_url: 'https://link.midasmediafirm.com/widget/form/abc' }), 'an ordinary form is not');
ok(obClientCanToggle({ step_type: 'video', requires_confirm: true, embed_url: 'x.mp4' }), 'other confirm steps keep their button');
ok(/obIsBookingStep\(s\) \? 'Booked but it didn&rsquo;t tick\? Let us know'/.test(src), 'the help link says booked, not submitted');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
