/**
 * `BigField.pickLiveTask` / `tailLines` (renderer/bigfield.js): the pure logic behind the big
 * central field. The DOM part cannot run in Node, so only the module's exports are asserted here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { check } from './helpers';

const mod = path.join(__dirname, '..', '..', 'renderer', 'bigfield.js');
check(fs.existsSync(mod), `bigfield.js not found at ${mod}`);
const BigField = require(mod) as { pickLiveTask: (run: any) => any; tailLines: (log: any, n?: number) => string[] };

const task = (id: string, status: string) => ({ id, status });

check(BigField.pickLiveTask(undefined) === null, '(a) run undefined → null');
check(BigField.pickLiveTask({}) === null, '(a) run without tasks → null');
check(BigField.pickLiveTask({ tasks: [] }) === null, '(a) no tasks → null');

const runB = { tasks: [task('t1', 'running'), task('t2', 'done'), task('t3', 'done')] };
check(BigField.pickLiveTask(runB)?.id === 't1', '(b) one running + two done → the running one');

check(BigField.pickLiveTask({ tasks: [task('t1', 'running'), task('t2', 'running')] }) === null, '(c) two running → null');

check(BigField.pickLiveTask({ tasks: [task('t1', 'running'), task('t2', 'queued')] })?.id === 't1', '(d) one running + one queued → the running one');

check(BigField.pickLiveTask({ tasks: [task('t1', 'queued'), task('t2', 'done'), task('t3', 'failed'), task('t4', 'merged'), task('t5', 'discarded')] }) === null, '(e) only queued/done/failed/merged/discarded → null');

check(BigField.pickLiveTask({ tasks: undefined }) === null, '(f) tasks undefined → null');

check(JSON.stringify(BigField.tailLines(['a', 'b', 'c'], 2)) === JSON.stringify(['b', 'c']), "(g) tailLines(['a','b','c'], 2) → ['b','c']");
const hundred = Array.from({ length: 100 }, (_, i) => String(i + 1));
const tail = BigField.tailLines(hundred);
check(tail.length === 40 && tail[39] === '100', `(g) tailLines default → 40 lines, last '100' (got ${tail.length}, last '${tail[39]}')`);
check(JSON.stringify(BigField.tailLines(undefined)) === '[]', '(g) tailLines(undefined) → []');

console.log('SMOKE-BIGFIELD OK');
