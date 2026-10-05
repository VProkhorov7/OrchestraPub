/** Unit tests for loadStates and taskTime in report.ts */
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir, check } from './helpers';
import { loadStates, taskTime } from '../main/report';

// 1. loadStates on non-existent directory returns [] without throwing
const nonExistentDir = tmpdir('loadstates-' + Date.now());
const states1 = loadStates(nonExistentDir);
check(Array.isArray(states1), 'returns an array');
check(states1.length === 0, 'returns empty array for non-existent directory');

// 2. loadStates with various scenarios
const runsDir = tmpdir('loadstates-' + Date.now());

// Create valid run directories r1 and r2
fs.mkdirSync(path.join(runsDir, 'r1'));
fs.writeFileSync(
  path.join(runsDir, 'r1', 'run.json'),
  JSON.stringify({ state: { runId: 'r1', tasks: [] }})
);

fs.mkdirSync(path.join(runsDir, 'r2'));
fs.writeFileSync(
  path.join(runsDir, 'r2', 'run.json'),
  JSON.stringify({ state: { runId: 'r2', tasks: [] }})
);

// Create a directory with bad JSON
fs.mkdirSync(path.join(runsDir, 'bad'));
fs.writeFileSync(path.join(runsDir, 'bad', 'run.json'), '{oops');

// Create an empty directory (no run.json)
fs.mkdirSync(path.join(runsDir, 'empty'));

// Create a stray file (not a directory)
fs.writeFileSync(path.join(runsDir, 'stray.txt'), 'not a run');

const states2 = loadStates(runsDir);
check(states2.length === 2, `loadStates returns exactly 2 states (got ${states2.length})`);
const ids = states2.map((s) => s.runId).sort();
check(JSON.stringify(ids) === JSON.stringify(['r1', 'r2']), `runIds are r1 and r2 (got ${ids.join(', ')})`);

// 3. taskTime: returns finishedAt, startedAt, run.startedAt, or 0
const t1 = { finishedAt: 5, startedAt: 3 } as any;
const r1 = { startedAt: 1 } as any;
check(taskTime(t1, r1) === 5, 'taskTime returns finishedAt when present');

const t2 = { startedAt: 3 } as any;
check(taskTime(t2, r1) === 3, 'taskTime returns startedAt when no finishedAt');

const t3 = {} as any;
check(taskTime(t3, r1) === 1, 'taskTime returns run.startedAt when no task timestamps');

const t4 = {} as any;
const r4 = {} as any;
check(taskTime(t4, r4) === 0, 'taskTime returns 0 when nothing else available');

console.log('SMOKE-LOADSTATES OK');