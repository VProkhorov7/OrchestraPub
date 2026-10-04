import * as fs from 'fs';
import * as path from 'path';
import { RunState } from './types';
import { taskTime } from './report';

/**
 * Reconciliation of Orchestra's cost estimate with the real balance at the provider.
 * The owner (or, for DeepSeek, the balance API) records the balance at a moment; between two records the fall of the
 * balance is the real spend, and the cost of the tasks finished in that interval is the estimate. Their ratio shows
 * how far the prices in Settings are from the truth. A balance that went up is a top-up: that interval is skipped.
 * `unitUsd` converts the provider's balance unit to dollars (B.AI counts tokens: 1e-6 dollars per token).
 */

export interface Snap {
  ts: number;
  balance: number;
}
export interface LedgerEntry {
  unitUsd: number;
  snaps: Snap[];
}
export type Ledger = Record<string, LedgerEntry>;

export interface Interval {
  from: number;
  to: number;
  realUsd: number;
  estimatedUsd: number;
  /** real / estimated; null when nothing was estimated */
  factor: number | null;
}
export interface Reconciled {
  id: string;
  unitUsd: number;
  last?: Snap;
  intervals: Interval[];
  realUsd: number;
  estimatedUsd: number;
  factor: number | null;
  topUps: number;
}

const KEEP = 200;

export function readLedger(file: string): Ledger {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

export function writeLedger(file: string, l: Ledger) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(l, null, 1));
  fs.renameSync(tmp, file);
}

/** Record a balance. `unitUsd` is kept for the provider once given. Returns the updated ledger. */
export function addSnapshot(file: string, id: string, balance: number, unitUsd?: number, ts = Date.now()): Ledger {
  if (!Number.isFinite(balance) || balance < 0) throw new Error('Баланс должен быть числом, не меньше нуля');
  if (unitUsd !== undefined && !(unitUsd > 0)) throw new Error('Цена единицы баланса должна быть больше нуля');
  const l = readLedger(file);
  const e = l[id] ?? { unitUsd: unitUsd ?? 1, snaps: [] };
  if (unitUsd !== undefined) e.unitUsd = unitUsd;
  e.snaps = [...e.snaps, { ts, balance }].sort((a, b) => a.ts - b.ts).slice(-KEEP);
  l[id] = e;
  writeLedger(file, l);
  return l;
}

export function reconcile(ledger: Ledger, states: RunState[]): Reconciled[] {
  const out: Reconciled[] = [];
  for (const [id, e] of Object.entries(ledger)) {
    const intervals: Interval[] = [];
    let topUps = 0;
    for (let i = 1; i < e.snaps.length; i++) {
      const a = e.snaps[i - 1];
      const b = e.snaps[i];
      if (b.balance > a.balance) {
        topUps++;
        continue;
      }
      let est = 0;
      for (const run of states)
        for (const t of run.tasks) {
          const at = taskTime(t, run);
          if (t.providerId === id && at > a.ts && at <= b.ts) est += t.costUsd ?? 0;
        }
      const real = (a.balance - b.balance) * e.unitUsd;
      intervals.push({ from: a.ts, to: b.ts, realUsd: real, estimatedUsd: est, factor: est > 0 ? real / est : null });
    }
    const realUsd = intervals.reduce((s, x) => s + x.realUsd, 0);
    const estimatedUsd = intervals.reduce((s, x) => s + x.estimatedUsd, 0);
    out.push({ id, unitUsd: e.unitUsd, last: e.snaps[e.snaps.length - 1], intervals: intervals.slice(-10), realUsd, estimatedUsd, factor: estimatedUsd > 0 ? realUsd / estimatedUsd : null, topUps });
  }
  return out;
}
