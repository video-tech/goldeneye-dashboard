// Tests for stripReportFiller in app.js: stock sentences ("Let's keep an eye on those changes moving forward") are
// deleted from the weekly report's email note and paragraphs. Runs the real code cut from app.js.
// Run: node tests/report-filler.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'app.js'), 'utf8');
const a = src.indexOf('const REPORT_FILLER = ['), b = src.indexOf('async function generateReport()', a);
if (a < 0 || b < 0) throw new Error('could not find the filler code in app.js');
const { stripFillerSentences, stripReportFiller } = new Function(src.slice(a, b) + '; return { stripFillerSentences, stripReportFiller };')();

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

// The one the user kept seeing
const note = "Hi team,\n\nWe got about double the leads this week. Cost per lead came down a bit. Let's keep an eye on those changes moving forward.";
ok(stripFillerSentences(note) === "Hi team,\n\nWe got about double the leads this week. Cost per lead came down a bit.", 'the closing "keep an eye" sentence goes, the rest stays');

for (const s of [
    "We'll keep a close eye on the numbers.", "We'll continue to monitor performance closely.", "We'll continue to optimize.",
    "We'll monitor the results.", "We'll adjust our strategy accordingly.", "We'll see how it plays out.", "Stay tuned!",
    "We'll keep you posted.", "More to come next week.", "Exciting things ahead!", "Let's see how things go.",
]) ok(stripFillerSentences(`14 leads this week. ${s}`) === '14 leads this week.', `filler removed: ${s}`);

for (const s of [
    "We'll check the new carousel's cost per lead on Thursday.", "We paused the video ad because it got clicks but no leads.",
    "Leads came in cheaper even though spend barely moved.", "We're testing a new offer next week.",
    "We adjusted the budget toward the before/after ad.", "Your eye-catching project photos did well.",
]) ok(stripFillerSentences(s) === s, `specific sentence kept: ${s}`);

const html = '<h2>Highlights</h2><div style="font-size: 17px; font-weight: 600; margin-bottom: 8px; color: #1d1d1f;">Keep an eye on this</div>' +
    '<div style="font-size: 15px; color: #515154; line-height: 1.6;">Cost per lead fell to $41. We will continue to monitor performance.</div>';
const r = stripReportFiller({ email_summary: note, html_report: html, working_on: [{ headline: 'New ads', details: 'Launching Monday. Stay tuned.' }] });
ok(r.html_report.includes('Cost per lead fell to $41.</div>') && !/continue to monitor/.test(r.html_report), 'report paragraphs are cleaned');
ok(r.html_report.includes('>Keep an eye on this</div>'), 'headings are never touched');
ok(r.working_on[0].details === 'Launching Monday.' && r.working_on[0].headline === 'New ads', 'working-on details are cleaned, headlines kept');
ok(!/keep an eye/i.test(r.email_summary), 'the email note is cleaned');
ok(stripReportFiller(null) === null && stripReportFiller({}).email_summary === undefined, 'odd input passes through');

// Wired in: the report's finalize step runs it before the notes and to-do checks
ok(/const finalizeReport = \(rawParsed\) => \{\s*const parsed = stripReportFiller\(rawParsed\);/.test(src), 'generateReport runs it on every answer');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
