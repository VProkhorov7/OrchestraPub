/**
 * «Недавно завершено»: collectRecent takes merged / discarded / done tasks only, newest first, within 7 days, at most 10;
 * a task without finishedAt falls back to the run's touchedAt; empty input gives an empty list.
 * Run: as a step of `npm run smoke`.
 */
import { collectRecent, RecentRun } from '../main/recent';
import { check } from './helpers';

const NOW = 10_000_000_000;
const H = 3_600_000;
const D = 24 * H;
const task = (id: string, extra: any = {}) => ({ id, title: `Task ${id}`, providerId: 'glm', status: 'merged', log: [], ...extra });
const run = (tasks: any[], touchedAt = NOW, runId = 'r1'): RecentRun => ({ runId, tasks, touchedAt });
const ids = (runs: RecentRun[]) => collectRecent({ runs, now: NOW }).map((i) => i.taskId).join();

check(collectRecent({ runs: [], now: NOW }).length === 0, 'empty input: empty list');
check(collectRecent({ runs: [run([])], now: NOW }).length === 0, 'a run without tasks: empty list');

// order across runs, newest first
check(ids([run([task('t01', { finishedAt: NOW - 3 * H }), task('t02', { finishedAt: NOW - H })]), run([task('t03', { finishedAt: NOW - 2 * H })], NOW, 'r2')]) === 't02,t03,t01', 'newest first across runs');

// statuses
const st = collectRecent({ runs: [run(['merged', 'discarded', 'done', 'running', 'failed', 'cancelled', 'queued'].map((s, i) => task(`t0${i}`, { status: s, finishedAt: NOW - i * H })))], now: NOW });
check(st.map((i) => i.status).join() === 'merged,discarded,done', `only merged, discarded, done: ${JSON.stringify(st)}`);

// fields
const f = collectRecent({ runs: [run([task('t01', { finishedAt: NOW - H, costUsd: 0.42, providerId: 'kimi' }), task('t02', { finishedAt: NOW - 2 * H })])], now: NOW });
check(f[0].costUsd === 0.42 && f[0].providerId === 'kimi' && f[0].runId === 'r1' && f[0].title === 'Task t01' && f[0].finishedAt === NOW - H && !('costUsd' in f[1]), `fields: ${JSON.stringify(f)}`);

// window: 7 days
check(ids([run([task('t01', { finishedAt: NOW - 7 * D }), task('t02', { finishedAt: NOW - 8 * D })])]) === 't01', 'exactly 7 days is in, 8 days is out');

// fallback to the run's mtime
check(ids([run([task('t01')], NOW - 2 * H), run([task('t02')], NOW - 9 * D, 'r2')]) === 't01', 'no finishedAt: the run touchedAt decides (in the window / out of it)');

// limit
const many = Array.from({ length: 11 }, (_, i) => task(`t${String(i).padStart(2, '0')}`, { finishedAt: NOW - i * H }));
const lim = ids([run(many)]).split(',');
check(lim.length === 10 && lim[0] === 't00' && !lim.includes('t10'), `limit 10, the 11th (oldest) is dropped: ${lim}`);

console.log('smoke-recent OK');
