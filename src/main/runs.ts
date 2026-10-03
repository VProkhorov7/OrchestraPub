import * as fs from 'fs';
import * as path from 'path';
import { RunState, RunSummary } from './types';

/** What we keep on disk per run: the visible state plus the orchestrator's conversation, so a run can be resumed. */
export interface SavedRun {
  version: 1;
  state: RunState;
  /** Anthropic Messages API history of the orchestrator (empty for MCP runs). */
  messages: unknown[];
  savedAt: number;
}

const RESUMABLE = new Set(['interrupted', 'failed', 'cancelled', 'stopped']);

/**
 * One folder per run under <userData>/runs/<runId>/run.json.
 * Writes are atomic (tmp + rename) and debounced, so a crash leaves the previous good copy.
 */
export class RunStore {
  private timers = new Map<string, NodeJS.Timeout>();
  private pending = new Map<string, () => SavedRun>();

  constructor(public dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(runId: string) {
    if (!/^[\w.-]+$/.test(runId)) throw new Error('bad run id');
    return path.join(this.dir, runId, 'run.json');
  }

  /** Save soon (coalesces bursts of events). `snapshot` is called at write time, so it sees the latest state. */
  saveSoon(runId: string, snapshot: () => SavedRun, delayMs = 400): void {
    this.pending.set(runId, snapshot);
    if (this.timers.has(runId)) return;
    this.timers.set(
      runId,
      setTimeout(() => this.flush(runId), delayMs),
    );
  }

  flush(runId?: string): void {
    const ids = runId ? [runId] : [...this.pending.keys()];
    for (const id of ids) {
      const t = this.timers.get(id);
      if (t) clearTimeout(t);
      this.timers.delete(id);
      const snap = this.pending.get(id);
      this.pending.delete(id);
      if (snap) this.write(snap());
    }
  }

  write(run: SavedRun): void {
    const f = this.file(run.state.runId);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...run, savedAt: Date.now() }));
    fs.renameSync(tmp, f);
  }

  load(runId: string): SavedRun {
    return JSON.parse(fs.readFileSync(this.file(runId), 'utf8'));
  }

  delete(runId: string): void {
    fs.rmSync(path.dirname(this.file(runId)), { recursive: true, force: true });
  }

  list(): RunSummary[] {
    const out: RunSummary[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      try {
        const { state: s } = this.load(name);
        const costUsd = (s.orchestratorCostUsd ?? 0) + s.tasks.reduce((a, t) => a + (t.costUsd ?? 0), 0);
        out.push({
          runId: s.runId,
          source: s.source ?? 'app',
          repo: s.repo,
          goal: s.goal,
          status: s.status,
          startedAt: s.startedAt,
          finishedAt: s.finishedAt,
          tasks: s.tasks.length,
          merged: s.tasks.filter((t) => t.status === 'merged').length,
          costUsd,
          resumable: (s.source ?? 'app') === 'app' && RESUMABLE.has(s.status),
        });
      } catch {
        /* skip unreadable folders */
      }
    }
    return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  /**
   * On startup: a run still marked "running" belongs to a process that is gone (app closed or crashed).
   * `isAlive` lets the MCP server's runs survive while their server process still exists.
   */
  markInterrupted(isAlive: (s: RunState) => boolean = () => false): string[] {
    const fixed: string[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      try {
        const run = this.load(name);
        if (run.state.status !== 'running' || isAlive(run.state)) continue;
        run.state.status = 'interrupted';
        run.state.stopReason = 'приложение было закрыто во время работы';
        this.write(run);
        fixed.push(name);
      } catch {
        /* ignore */
      }
    }
    return fixed;
  }
}
