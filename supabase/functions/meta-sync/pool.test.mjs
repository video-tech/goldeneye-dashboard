// runPool (parse.ts): clients synced a few at a time, so one slow account can't use the whole time budget. Run (node 22.6+):
//   node --experimental-strip-types supabase/functions/meta-sync/pool.test.mjs
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { runPool } = await import(pathToFileURL(path.join(here, 'parse.ts')).href);

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The shape of today's problem: one slow account first, then several quick ones, and a budget
{
    const items = ['slow', 'a', 'b', 'c', 'd', 'e'];
    let running = 0, most = 0;
    const started = Date.now();
    const out = await runPool(items, 3, async (x) => {
        running++; most = Math.max(most, running);
        await sleep(x === 'slow' ? 300 : 20);
        running--;
        return { client: x, done: Date.now() - started };
    }, () => Date.now() - started <= 200, (x) => ({ client: x, skipped: true }));
    ok(most === 3, 'never more than 3 at once (' + most + ')');
    ok(out.map((r) => r.client).join() === items.join(), 'results keep the clients\' order');
    ok(out.every((r) => !r.skipped), 'the quick clients all ran while the slow one was still going');
    ok(out.slice(1).every((r) => r.done < 300), 'and finished before it');
}

// One at a time, the old way, the same budget skips the clients after the slow one
{
    const started = Date.now();
    const out = await runPool(['slow', 'a', 'b'], 1, async (x) => { await sleep(x === 'slow' ? 250 : 10); return { client: x }; },
        () => Date.now() - started <= 200, (x) => ({ client: x, skipped: true }));
    ok(out[1].skipped && out[2].skipped, 'one at a time, the slow client uses the budget (the bug this fixes)');
}

// A stop (rate limit) means nothing more starts
{
    let stop = false;
    const ran = [];
    const out = await runPool(['a', 'b', 'c', 'd', 'e'], 2, async (x) => { ran.push(x); await sleep(5); if (x === 'a') stop = true; return { client: x }; },
        () => !stop, (x) => ({ client: x, skipped: true }));
    ok(ran.length <= 3 && out.slice(3).every((r) => r.skipped), 'after a stop, no new client starts (' + ran.join() + ')');
}

ok((await runPool([], 3, async () => 1, () => true, () => 0)).length === 0, 'no clients, no work');
const one = await runPool([1], 5, async (x) => x * 2, () => true, () => 0);
ok(one.length === 1 && one[0] === 2, 'a limit above the count is fine');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
