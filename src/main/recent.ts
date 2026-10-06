import type { WorkerTask } from './types';

/**
 * «Недавно завершено»: the last finished tasks (merged, discarded, done = ready but not merged), newest first: a plain
 * history strip at the bottom of the panel. A pure function over plain data: no I/O, no clock (now comes in).
 */

export interface RecentItem {
  taskId: string;
  runId: string;
  title: string;
  providerId: string;
  status: 'merged' | 'discarded' | 'done';
  costUsd?: number;
  finishedAt: number;
}

export interface RecentRun {
  runId: string;
  tasks: WorkerTask[];
  /** Used when a task has no finishedAt: when the run was last touched (run.json mtime; now for a live run). */
  touchedAt: number;
}

export interface RecentInput {
  runs: RecentRun[];
  now: number;
}

export const RECENT_LIMIT = 10;
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60_000;

export function collectRecent(input: RecentInput): RecentItem[] {
  const items: RecentItem[] = [];
  for (const run of input.runs) {
    for (const t of run.tasks) {
      if (t.status !== 'merged' && t.status !== 'discarded' && t.status !== 'done') continue;
      const finishedAt = t.finishedAt ?? run.touchedAt;
      if (input.now - finishedAt > RECENT_WINDOW_MS) continue;
      items.push({ taskId: t.id, runId: run.runId, title: t.title, providerId: t.providerId, status: t.status, ...(t.costUsd !== undefined ? { costUsd: t.costUsd } : {}), finishedAt });
    }
  }
  return items.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, RECENT_LIMIT);
}
