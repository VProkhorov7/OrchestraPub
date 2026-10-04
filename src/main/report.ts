import * as fs from 'fs';
import * as path from 'path';
import { RunState, WorkerTask } from './types';

/**
 * Spend report: where the money went and what it bought. Read from the saved runs (<home>/runs/*\/run.json),
 * so it covers app runs and MCP sessions alike. Costs are Orchestra's own estimates; ledger.ts checks them against
 * the balances shown by the providers.
 */

const DAY = 86_400_000;

export interface ProviderRow {
  id: string;
  usd: number;
  tasks: number;
  merged: number;
  /** Spent on tasks that were discarded, failed or timed out: money with no result. */
  wasteUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheShare: number;
}

export interface Report {
  days: number;
  since: number;
  totalUsd: number;
  orchestratorUsd: number;
  tasks: number;
  merged: number;
  wasteUsd: number;
  wasteShare: number;
  usdPerMerged: number | null;
  mergedRate: number;
  byProvider: ProviderRow[];
  byRole: { role: string; provider: string; usd: number; tasks: number }[];
  byDay: { day: string; usd: number }[];
  top: { runId: string; taskId: string; title: string; provider: string; usd: number; status: string }[];
}

const WASTE = new Set(['discarded', 'failed', 'timeout']);
const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function loadStates(runsDir: string): RunState[] {
  const out: RunState[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(runsDir);
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(runsDir, n, 'run.json'), 'utf8')).state);
    } catch {
      /* unreadable run: skip */
    }
  }
  return out;
}

/** When the money for a task was spent: the end of its work, else its start. */
export const taskTime = (t: WorkerTask, run: RunState) => t.finishedAt ?? t.startedAt ?? run.startedAt ?? 0;

export function buildReport(states: RunState[], days = 3, now = Date.now()): Report {
  const since = now - days * DAY;
  const prov = new Map<string, ProviderRow>();
  const roles = new Map<string, { role: string; provider: string; usd: number; tasks: number }>();
  const perDay = new Map<string, number>();
  const top: Report['top'] = [];
  let orchestratorUsd = 0;
  let tasks = 0;
  let merged = 0;
  let totalTasksUsd = 0;
  let waste = 0;
  const cache = new Map<string, { read: number; all: number }>();
  for (const run of states) {
    if ((run.startedAt ?? 0) >= since) {
      orchestratorUsd += run.orchestratorCostUsd ?? 0;
      perDay.set(dayKey(run.startedAt ?? now), (perDay.get(dayKey(run.startedAt ?? now)) ?? 0) + (run.orchestratorCostUsd ?? 0));
    }
    for (const t of run.tasks) {
      if (taskTime(t, run) < since) continue;
      const usd = t.costUsd ?? 0;
      const row = prov.get(t.providerId) ?? { id: t.providerId, usd: 0, tasks: 0, merged: 0, wasteUsd: 0, tokensIn: 0, tokensOut: 0, cacheShare: 0 };
      row.usd += usd;
      row.tasks++;
      row.tokensIn += t.tokensIn ?? 0;
      row.tokensOut += t.tokensOut ?? 0;
      const c = cache.get(t.providerId) ?? { read: 0, all: 0 };
      c.read += t.tokensCacheRead ?? 0;
      c.all += t.tokensIn ?? 0;
      cache.set(t.providerId, c);
      if (t.status === 'merged') {
        row.merged++;
        merged++;
      }
      if (WASTE.has(t.status)) {
        row.wasteUsd += usd;
        waste += usd;
      }
      prov.set(t.providerId, row);
      const role = t.role ?? '—';
      const rk = `${role}|${t.providerId}`;
      const r = roles.get(rk) ?? { role, provider: t.providerId, usd: 0, tasks: 0 };
      r.usd += usd;
      r.tasks++;
      roles.set(rk, r);
      const dk = dayKey(taskTime(t, run));
      perDay.set(dk, (perDay.get(dk) ?? 0) + usd);
      top.push({ runId: run.runId, taskId: t.id, title: t.title, provider: t.providerId, usd, status: t.status });
      tasks++;
      totalTasksUsd += usd;
    }
  }
  const byProvider = [...prov.values()].map((r) => ({ ...r, cacheShare: cache.get(r.id)!.all ? cache.get(r.id)!.read / cache.get(r.id)!.all : 0 })).sort((a, b) => b.usd - a.usd);
  const totalUsd = totalTasksUsd + orchestratorUsd;
  return {
    days,
    since,
    totalUsd,
    orchestratorUsd,
    tasks,
    merged,
    wasteUsd: waste,
    wasteShare: totalUsd > 0 ? waste / totalUsd : 0,
    usdPerMerged: merged ? totalUsd / merged : null,
    mergedRate: tasks ? merged / tasks : 0,
    byProvider,
    byRole: [...roles.values()].sort((a, b) => b.usd - a.usd),
    byDay: [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, usd]) => ({ day, usd })),
    top: top.sort((a, b) => b.usd - a.usd).slice(0, 8),
  };
}
