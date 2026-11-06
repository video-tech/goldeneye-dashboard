// The "onboarding complete" task is raised already archived and Complete (app.js, handoff_task_archived.sql): it never reaches
// a board, but it still counts as "already announced". Runs the REAL helpers, cut out of app.js, in jsdom.
//   JSDOM_DIR=/path/to/dir node tests/handoff-hidden.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
if (!process.env.JSDOM_DIR) { console.log('Set JSDOM_DIR to a folder with jsdom installed.'); process.exit(2); }
const { JSDOM } = createRequire(path.join(process.env.JSDOM_DIR, 'package.json'))('jsdom');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const cut = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a + 1); if (a < 0 || b < 0) throw new Error('marker ' + (a < 0 ? from : to)); return app.slice(a, b); };
const code = [
    cut('        const normalize = (str) => {', '        // Escapes for a JS string literal'),
    "const OB_COMPLETE_TASK_TITLE = 'Onboarding complete — ready for campaign build';",
    cut('function buildOnboardingHandoffTask(clientName) {', '// The agency\'s own onboarding work, raised when the client finishes'),
    cut('const tasksIncludingArchived = ', 'async function obNotifyOnboardingComplete'),
    cut('function clientFinishedOwnSteps(clientName) {', '// What to show for a client\'s stage'),
].join('\n');

function world({ tasks = [], archived = [], steps = [], progress = [] } = {}) {
    const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously' }).window;
    w.eval(`
        var globalTasksData = ${JSON.stringify(tasks)}, globalArchivedTasks = ${JSON.stringify(archived)};
        function activeOnboardingSteps() { return ${JSON.stringify(steps)}; }
        function onboardingProgressFor(c, id) { return ${JSON.stringify(progress)}.find(p => p.step_id === id) || null; }
        ${code}
    `);
    return w;
}

// The row that gets inserted
{
    const w = world();
    const row = w.buildOnboardingHandoffTask('Acme');
    ok(row.type === 'Client Request' && row.title === 'Onboarding complete — ready for campaign build' && row.stage === 'Onboarding', 'it is still the same Client Request');
    ok(!!row.archived_at && !isNaN(Date.parse(row.archived_at)) && row.archived_by === 'Golden Eye', 'but it is archived from the start');
    ok(row.status === 'Complete', 'and closed, so a Restore never leaves an open task behind');
}

// Where it is filed after it is read or written
{
    const w = world();
    w.rememberTaskRows([{ client: 'Acme', title: 'x', archived_at: '2026-11-06T00:00:00Z' }, { client: 'Acme', title: 'y' }]);
    ok(w.globalArchivedTasks.length === 1 && w.globalTasksData.length === 1 && w.globalTasksData[0].title === 'y', 'an archived row goes with the archived tasks, never onto a board');
}

// "Already announced" and the Set up label both find it where it is
{
    const archived = [{ client: 'Acme', title: 'Onboarding complete — ready for campaign build', archived_at: '2026-11-06T00:00:00Z' }];
    const w = world({ archived });
    ok(w.onboardingHandoffRaised('Acme') && !w.onboardingHandoffRaised('Other'), 'the archived marker counts as already announced, for that client only');
    ok(w.clientFinishedOwnSteps('Acme') === true, 'and the Set up label still sees a finished client even with no progress rows loaded');
    ok(w.clientFinishedOwnSteps('Other') === false, 'a client with neither the marker nor finished steps is still Onboarding');
}
{
    const w = world({ steps: [{ id: 's1' }], progress: [{ step_id: 's1', completed_at: '2026-11-01' }] });
    ok(w.clientFinishedOwnSteps('Acme') === true, 'every step done also reads as finished');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
