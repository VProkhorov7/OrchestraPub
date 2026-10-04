/** Spend report and balance reconciliation: aggregates, waste, top-ups, unit conversion. */
import * as path from 'path';
import { tmpdir, check } from './helpers';
import { buildReport } from '../main/report';
import { addSnapshot, readLedger, reconcile } from '../main/ledger';
import type { RunState } from '../main/types';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const H = 3_600_000;
const task = (id: string, providerId: string, status: string, costUsd: number, at: number, extra: any = {}) =>
  ({ id, title: `task ${id}`, providerId, role: 'coder', status, costUsd, startedAt: at - 60_000, finishedAt: at, log: [], worktree: '/x', tokensIn: 1000, tokensCacheRead: 800, ...extra }) as any;

const run: RunState = {
  runId: 'run-1', repo: '/r', baseBranch: 'main', goal: 'g', status: 'done', source: 'app', startedAt: NOW - 5 * H, orchestratorCostUsd: 0.5, transcript: [],
  tasks: [
    task('t1', 'deepseek', 'merged', 1, NOW - 4 * H),
    task('t2', 'deepseek', 'discarded', 2, NOW - 3 * H),
    task('t3', 'glm', 'merged', 0.5, NOW - 2 * H),
    task('t4', 'glm', 'merged', 9, NOW - 10 * 24 * H), // outside the period
  ],
} as any;

const rep = buildReport([run], 3, NOW);
check(rep.tasks === 3 && rep.merged === 2, 'tasks outside the period are not counted');
check(Math.abs(rep.totalUsd - 4) < 1e-9, `total = tasks 3.5 + orchestrator 0.5 (got ${rep.totalUsd})`);
check(Math.abs(rep.wasteUsd - 2) < 1e-9 && Math.abs(rep.wasteShare - 0.5) < 1e-9, 'discarded money is waste');
check(Math.abs((rep.usdPerMerged ?? 0) - 2) < 1e-9, 'dollars per merged task');
check(rep.byProvider[0].id === 'deepseek' && Math.abs(rep.byProvider[0].cacheShare - 0.8) < 1e-9, 'providers sorted by spend, cache share');
check(rep.top[0].taskId === 't2', 'most expensive task first');

const dir = tmpdir('ledger');
const file = path.join(dir, 'ledger.json');
addSnapshot(file, 'deepseek', 10, undefined, NOW - 6 * H);
addSnapshot(file, 'deepseek', 7, undefined, NOW - H); // spent 3 real; estimate in the interval: t1 + t2 + t3? only deepseek: 3
addSnapshot(file, 'deepseek', 20, undefined, NOW); // top-up: skipped
let r = reconcile(readLedger(file), [run]).find((x) => x.id === 'deepseek')!;
check(r.intervals.length === 1 && r.topUps === 1, 'a balance that went up is a top-up, not an interval');
check(Math.abs(r.realUsd - 3) < 1e-9 && Math.abs(r.estimatedUsd - 3) < 1e-9 && Math.abs(r.factor! - 1) < 1e-9, 'real 3 vs estimated 3');

addSnapshot(file, 'bai', 10_000_000, 1e-6, NOW - 6 * H);
addSnapshot(file, 'bai', 9_000_000, undefined, NOW - H); // 1e6 tokens × 1e-6 = $1 real
r = reconcile(readLedger(file), [{ ...run, tasks: [task('b1', 'bai', 'merged', 0.5, NOW - 3 * H)] } as any]).find((x) => x.id === 'bai')!;
check(Math.abs(r.realUsd - 1) < 1e-9 && Math.abs(r.factor! - 2) < 1e-9, `balance units convert to dollars; real is twice the estimate (got ${r.realUsd}, ${r.factor})`);

let threw = false;
try { addSnapshot(file, 'x', -1); } catch { threw = true; }
check(threw, 'a negative balance is refused');
console.log('SMOKE-REPORT OK');
