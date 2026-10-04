import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, OrchEvent, ProviderConfig, RunState, TranscriptEntry, WorkerTask } from './types';
import * as git from './git';
import { runWorker, WorkerHandle, clip } from './worker';
import { workerPrompt } from './prompts';
import { workerCost, emptyUsage, Usage } from './pricing';
import { offPeakNow, stretchEnd, priceFactor, now as tariffNow } from './tariff';
import { canWork } from './catalog';
import { freeOnlyReason } from './freetier';
import { ProjectMemory } from '../memory/store';
import { pick } from '../memory/lang';
import { replyLang } from './lang';
import { memoryBriefing } from '../memory/prompt';

export const MAX_DIFF_CHARS_FOR_LLM = 60_000;

export type Emit = (ev: OrchEvent) => void;

export function isTerminal(s: WorkerTask['status']): boolean {
  return !['queued', 'running'].includes(s);
}

/**
 * Everything about workers that doesn't depend on who is orchestrating:
 * the task queue, worktrees, worker processes, diffs, merges, spend tracking and budgets.
 * Used by the app's own Claude loop (Orchestrator) and by the MCP server.
 */
export class TaskEngine {
  private handles = new Map<string, WorkerHandle>();
  private queue: WorkerTask[] = [];
  private running = 0;
  private taskWaiters = new Map<string, Array<() => void>>();
  cancelled = false;
  /** Set once the run budget is used up: no new delegations, running workers are stopped. */
  budgetExhausted = false;
  private frozen = false;
  /** Keys already recorded through noteOnce, so repeated polls don't duplicate a journal entry. */
  private noted = new Set<string>();

  constructor(
    public cfg: AppConfig,
    public worktreeRoot: string,
    public state: RunState,
    private emit: Emit,
  ) {}

  // ---------- project memory ----------

  /** The repository's memory, if it has one (`orchestra-memory init`). Workers' work is logged here, by the engine. */
  memory(): ProjectMemory | undefined {
    return ProjectMemory.exists(this.state.repo) ? new ProjectMemory(this.state.repo) : undefined;
  }

  private remember(type: string, description: string, files?: string[], details?: unknown, author = 'orchestra') {
    try {
      this.memory()?.log({ type, author, description, files, details: { run: this.state.runId, ...(details as object) } });
    } catch {
      /* memory must never break a run */
    }
  }

  // ---------- spend ----------

  spent(): { total: number; orchestrator: number; workers: number; byProvider: Record<string, number> } {
    const byProvider: Record<string, number> = {};
    let workers = 0;
    for (const t of this.state.tasks) {
      const c = t.costUsd ?? 0;
      workers += c;
      byProvider[t.providerId] = (byProvider[t.providerId] ?? 0) + c;
    }
    const orchestrator = this.state.orchestratorCostUsd ?? 0;
    return { total: orchestrator + workers, orchestrator, workers, byProvider };
  }

  budget(): number {
    return this.state.budgetUsd ?? this.cfg.runBudgetUsd ?? 0;
  }

  /** Fraction of the run budget used, or 0 when there is no budget. */
  budgetUsed(): number {
    const b = this.budget();
    return b > 0 ? this.spent().total / b : 0;
  }

  spendReport(): string {
    const s = this.spent();
    const b = this.budget();
    const per = Object.entries(s.byProvider)
      .map(([id, usd]) => {
        const cap = this.cfg.providers.find((p) => p.id === id)?.maxUsdPerRun;
        return `${id} $${usd.toFixed(2)}${cap ? ` / cap $${cap}` : ''}`;
      })
      .join(', ');
    return `spent $${s.total.toFixed(2)}${b ? ` of $${b} budget` : ''} (orchestrator $${s.orchestrator.toFixed(2)}${per ? ', ' + per : ''})`;
  }

  /** Called after any cost change. Stops workers that went over a cap. */
  checkBudgets(): void {
    const s = this.spent();
    for (const p of this.cfg.providers) {
      if (!p.maxUsdPerRun || (s.byProvider[p.id] ?? 0) < p.maxUsdPerRun) continue;
      for (const t of this.state.tasks) {
        if (t.providerId === p.id && t.status === 'running' && this.handles.has(t.id)) {
          t.error = `превышен лимит воркера ${p.id}: $${p.maxUsdPerRun}`;
          this.log('system', `Stopping ${t.id}: worker ${p.id} reached its cap of $${p.maxUsdPerRun}.`);
          this.handles.get(t.id)!.kill();
        }
      }
    }
    const b = this.budget();
    if (b > 0 && s.total >= b && !this.budgetExhausted) {
      this.budgetExhausted = true;
      this.log('system', `Budget of $${b} reached (${this.spendReport()}). Stopping workers; no new tasks.`);
      for (const [id, h] of this.handles) {
        const t = this.task(id);
        if (t) t.error = `исчерпан бюджет запуска $${b}`;
        h.kill();
      }
      for (const t of this.queue) {
        t.error = `исчерпан бюджет запуска $${b}`;
        this.setStatus(t, 'cancelled');
      }
      this.queue = [];
      this.pushState();
    }
  }

  // ---------- tasks ----------

  /** Enabled, working workers that may take `role`. */
  providersFor(role: string): ProviderConfig[] {
    return this.cfg.providers.filter((p) => {
      const light = this.cfg.health?.[p.id]?.light;
      return p.enabled && canWork(p) && light !== 'red' && light !== 'yellow' && !freeOnlyReason(this.cfg, p) && (!p.roles?.length || p.roles.includes(role));
    });
  }

  delegate(input: { provider: string; role?: string; title: string; spec: string; retry?: { of: string; jobId: string; attempt: number } }): string {
    if (this.cancelled) throw new Error('run is cancelled');
    if (this.budgetExhausted || (this.budget() > 0 && this.budgetUsed() >= 1))
      throw new Error(`run budget exhausted (${this.spendReport()}). Do not delegate; merge or discard finished tasks and finish.`);
    const forcedId = this.cfg.forceProvider || '';
    let provider: ProviderConfig = (() => {
      if (forcedId) {
        const forced = this.cfg.providers.find((p) => p.id === forcedId && p.enabled && canWork(p));
        if (!forced) throw new Error(`Принудительный маршрут → ${forcedId}: unknown or disabled provider "${forcedId}"`);
        const h = this.cfg.health?.[forced.id];
        if (h && (h.light === 'red' || h.light === 'yellow'))
          throw new Error(`Принудительный маршрут → ${forcedId}: worker "${forced.id}" is unavailable (${h.text})`);
        return forced;
      }
      const p = this.cfg.providers.find((x) => x.id === input.provider && x.enabled && canWork(x));
      if (!p) throw new Error(`unknown or disabled provider "${input.provider}"`);
      const h = this.cfg.health?.[p.id];
      if (h && (h.light === 'red' || h.light === 'yellow')) {
        const ok = (input.role ? this.providersFor(input.role) : this.cfg.providers.filter((x) => x.enabled && canWork(x)))
          .filter((x) => x.id !== p.id)
          .map((x) => x.id);
        throw new Error(`worker "${p.id}" is unavailable (${h.text}). Available instead: ${ok.join(', ') || 'none'}`);
      }
      if (input.role && p.roles?.length && !p.roles.includes(input.role)) {
        const ok = this.providersFor(input.role).map((x) => x.id);
        throw new Error(`worker "${p.id}" is not allowed to take role "${input.role}". Workers allowed for it: ${ok.join(', ') || 'none'}`);
      }
      return p;
    })();
    // Free-only mode: a paid worker is never used, even when the orchestrator asks for it by name.
    const paidReason = freeOnlyReason(this.cfg, provider);
    if (paidReason) {
      const free = (input.role ? this.providersFor(input.role) : this.cfg.providers.filter((x) => x.enabled && canWork(x) && !freeOnlyReason(this.cfg, x))).map((x) => x.id);
      throw new Error(`${paidReason}. Free workers available: ${free.join(', ') || 'none'}`);
    }
    // «Off-peak only»: in peak hours a time-of-day worker is swapped for a worker without a tariff, if one can take the task.
    if (!forcedId && this.heldUntil(provider)) {
      const alt = this.offPeakAlternative(provider, input.role);
      if (alt) {
        this.log('system', `Часы пик: вместо ${provider.id} задачу берёт ${alt.id} (без почасового тарифа)`);
        provider = alt;
      }
    }
    const cap = provider.maxUsdPerRun ?? 0;
    const used = this.spent().byProvider[provider.id] ?? 0;
    if (cap > 0 && used >= cap) {
      if (forcedId) throw new Error(`Принудительный маршрут → ${forcedId}: worker "${provider.id}" reached its spend cap ($${used.toFixed(2)} of $${cap})`);
      const others = (input.role ? this.providersFor(input.role) : this.cfg.providers.filter((x) => x.enabled))
        .filter((x) => x.id !== provider.id)
        .map((x) => x.id);
      throw new Error(`worker "${provider.id}" reached its spend cap ($${used.toFixed(2)} of $${cap}). Other workers: ${others.join(', ') || 'none'}`);
    }

    if (forcedId && forcedId !== input.provider) this.log('system', `Принудительный маршрут: запрошен ${input.provider}, выполняет ${forcedId}`);

    const id = `t${(this.state.tasks.length + 1).toString().padStart(2, '0')}`;
    const slug = String(input.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const task: WorkerTask = {
      id,
      title: input.title,
      providerId: provider.id,
      model: provider.model,
      spec: input.spec,
      role: input.role,
      status: 'queued',
      branch: `orch/${this.state.runId.replace(/^(run|mcp)-/, '')}-${id}-${slug || 'task'}`,
      worktree: path.join(this.worktreeRoot, this.state.runId, id),
      baseSha: '',
      createdAt: Date.now(),
      jobId: input.retry?.jobId ?? id,
      attempt: input.retry?.attempt ?? 1,
      retryOf: input.retry?.of,
      log: [],
    };
    this.state.tasks.push(task);
    this.remember('task', `поручено ${provider.id} (${input.role ?? '-'}): ${input.title}`, [], { task: id, spec: input.spec.slice(0, 2000) });
    this.emit({ type: 'task', task });
    this.queue.push(task);
    this.pump();
    const held = this.heldUntil(provider);
    return `started ${id} [${input.role ?? '-'}] on ${provider.id} (${provider.model}), branch ${task.branch}${held ? ` — waits for ${provider.id}'s off-peak price until ${held.toISOString().slice(11, 16)} UTC (the owner chose «off-peak only»); other workers are not affected` : ''}`;
  }

  private holdTimer: NodeJS.Timeout | null = null;

  /**
   * «Off-peak only» runs: workers with a time-of-day tariff work together, only while ALL of them are cheap.
   * Returns the moment that window opens, or null when this provider may start now.
   */
  private heldUntil(provider: ProviderConfig): Date | null {
    if (!this.state.offPeakOnly || !provider.peak || offPeakNow(this.cfg)) return null;
    return stretchEnd(this.cfg, tariffNow(), false);
  }

  /** A pay-per-token worker without a tariff that can take the role and has not hit its cap; the cheapest output price first. */
  private offPeakAlternative(from: ProviderConfig, role?: string): ProviderConfig | null {
    const spent = this.spent().byProvider;
    const pool = role ? this.providersFor(role) : this.cfg.providers.filter((x) => x.enabled && canWork(x) && !freeOnlyReason(this.cfg, x));
    const ok = pool.filter((x) => x.id !== from.id && !x.peak && x.billing === 'api' && !(x.maxUsdPerRun && (spent[x.id] ?? 0) >= x.maxUsdPerRun));
    ok.sort((a, b) => (a.local ? 1 : 0) - (b.local ? 1 : 0) || (a.priceOut ?? Infinity) - (b.priceOut ?? Infinity)); // a local model only when nothing else can
    return ok[0] ?? null;
  }

  /** Tasks taken from the queue and not finished yet, per worker (a task is not «running» yet while its worktree is being made). */
  private inflight = new Map<string, number>();

  /** A worker with `maxConcurrent` (a local model serves one task at a time) does not start another task while it is full. */
  private providerSaturated(p: ProviderConfig): boolean {
    const max = p.maxConcurrent ?? 0;
    return max > 0 && (this.inflight.get(p.id) ?? 0) >= max;
  }

  private pump(): void {
    while (this.running < this.cfg.maxParallel && this.queue.length && !this.cancelled && !this.budgetExhausted && !this.frozen) {
      // First task whose worker may start now; tasks of a provider in its peak hours wait (off-peak only runs).
      const idx = this.queue.findIndex((q) => {
        const pr = this.cfg.providers.find((p) => p.id === q.providerId)!;
        return !this.heldUntil(pr) && !this.providerSaturated(pr);
      });
      if (idx < 0) {
        const nowT = tariffNow().getTime();
        const wake = Math.min(...this.queue.map((q) => this.heldUntil(this.cfg.providers.find((p) => p.id === q.providerId)!)?.getTime() ?? nowT));
        for (const q of this.queue) {
          const note = `ждёт льготного тарифа до ${new Date(wake).toISOString().slice(11, 16)} UTC`;
          if (q.log[q.log.length - 1] !== note) {
            q.log.push(note);
            this.emit({ type: 'task', task: q });
          }
        }
        if (this.holdTimer) clearTimeout(this.holdTimer);
        this.holdTimer = setTimeout(() => ((this.holdTimer = null), this.pump()), Math.max(10_000, wake - nowT + 5_000));
        this.holdTimer.unref?.();
        return;
      }
      const t = this.queue.splice(idx, 1)[0];
      this.running++;
      this.inflight.set(t.providerId, (this.inflight.get(t.providerId) ?? 0) + 1);
      this.execute(t).finally(() => {
        this.running--;
        this.inflight.set(t.providerId, Math.max(0, (this.inflight.get(t.providerId) ?? 1) - 1));
        this.pump();
      });
    }
  }

  private async execute(task: WorkerTask): Promise<void> {
    const provider = this.cfg.providers.find((p) => p.id === task.providerId)!;
    try {
      task.baseSha = await git.createWorktree(this.state.repo, task.worktree, task.branch);
      task.startedAt = Date.now();
      this.setStatus(task, 'running');

      const prompt = workerPrompt({
        cfg: this.cfg,
        provider,
        title: task.title,
        spec: task.spec,
        baseBranch: this.state.baseBranch,
        memory: memoryBriefing(this.state.repo, `${task.title}\n${task.spec}`, 'worker'),
      });
      let lastEmit = 0;
      // Cost by the tariff at the moment each piece of work happened (off-peak is cheaper for some providers).
      const acc = { prev: emptyUsage(), usd: 0 };
      const charge = (u: Usage, reported?: number) => {
        const d: Usage = {
          input: Math.max(0, u.input - acc.prev.input),
          output: Math.max(0, u.output - acc.prev.output),
          cacheWrite: Math.max(0, u.cacheWrite - acc.prev.cacheWrite),
          cacheRead: Math.max(0, u.cacheRead - acc.prev.cacheRead),
        };
        acc.usd += workerCost(provider, d).usd * priceFactor(provider);
        acc.prev = { ...u };
        const full = workerCost(provider, u, reported);
        task.costUsd = full.estimated ? full.usd : acc.usd;
        task.costEstimated = full.estimated;
        task.apiEquivUsd = full.apiEquiv;
        task.tokensIn = u.input + u.cacheRead + u.cacheWrite;
        task.tokensOut = u.output;
      };
      const handle = runWorker({
        cfg: this.cfg,
        provider,
        cwd: task.worktree,
        prompt,
        onLog: (line) => {
          task.lastActivityAt = Date.now();
          task.log.push(line);
          if (task.log.length > 500) task.log.shift();
          this.emit({ type: 'task_log', taskId: task.id, line });
        },
        onUsage: (u, estimated) => {
          task.lastActivityAt = Date.now();
          if (estimated) {
            // The provider reports usage only at the end: show an estimate meanwhile; the final usage replaces it.
            task.tokensIn = u.input;
            task.tokensOut = u.output;
            task.costUsd = workerCost(provider, u).usd * priceFactor(provider);
            task.costEstimated = true;
          } else charge(u);
          this.checkBudgets();
          if (Date.now() - lastEmit > 2000) {
            lastEmit = Date.now();
            this.emit({ type: 'task', task });
          }
        },
      });
      this.handles.set(task.id, handle);
      const r = await handle.promise;
      this.handles.delete(task.id);
      if (this.frozen) return; // quitting: leave the task "running" for reconcileInterrupted()
      if (task.status === 'discarded') return; // thrown away while it was still working: its folder and branch are gone

      task.result = r.result;
      charge(r.usage, r.reportedCostUsd);
      await this.captureDiff(task);
      task.finishedAt = Date.now();

      if (this.cancelled) this.setStatus(task, 'cancelled');
      else if (task.error) this.setStatus(task, 'failed'); // stopped by a budget cap; diff is kept
      else if (r.timedOut) { task.error = r.error; this.setStatus(task, 'timeout'); }
      else if (!r.ok) { task.error = r.error; this.setStatus(task, 'failed'); }
      else this.setStatus(task, 'done');
      this.remember(task.status === 'done' ? 'note' : 'error', `${task.id} ${task.title}: воркер ${task.status}${task.error ? ' (' + task.error + ')' : ''}`, [], {
        task: task.id,
        diffStat: task.diffStat,
        summary: task.result?.slice(0, 1500),
        costUsd: task.costUsd,
      }, `orchestra:${task.providerId}`);
      this.checkBudgets();
      this.afterFailure(task);
    } catch (e: any) {
      if (task.status === 'discarded') return;
      task.error = e?.message ?? String(e);
      task.finishedAt = Date.now();
      this.setStatus(task, 'failed');
      this.afterFailure(task);
    } finally {
      this.release(task);
    }
  }

  private release(task: WorkerTask) {
    const waiters = this.taskWaiters.get(task.id) ?? [];
    this.taskWaiters.delete(task.id);
    waiters.forEach((w) => w());
  }

  // ---------- automatic retry and escalation ----------

  private capReached(p: ProviderConfig): boolean {
    const cap = p.maxUsdPerRun ?? 0;
    return cap > 0 && (this.spent().byProvider[p.id] ?? 0) >= cap;
  }

  /** The worker for a retry: one this job has not tried yet, the cheapest first; when all were tried, the cheapest again. */
  private retryProvider(task: WorkerTask): ProviderConfig | null {
    const forced = this.cfg.forceProvider;
    if (forced) return this.cfg.providers.find((p) => p.id === forced && p.enabled && canWork(p)) ?? null;
    const tried = new Set(this.state.tasks.filter((x) => x.jobId === task.jobId).map((x) => x.providerId));
    const pool = (task.role ? this.providersFor(task.role) : this.cfg.providers.filter((x) => x.enabled && canWork(x) && !freeOnlyReason(this.cfg, x))).filter((p) => !this.capReached(p));
    const fresh = pool.filter((p) => !tried.has(p.id));
    const list = fresh.length ? fresh : pool;
    const price = (p: ProviderConfig) => (p.billing !== 'api' ? 0 : p.priceOut ?? Infinity);
    return [...list].sort((a, b) => (a.local ? 1 : 0) - (b.local ? 1 : 0) || price(a) - price(b))[0] ?? null; // a local model is the last resort: it is free, but slow
  }

  /** What the owner is asked when automatic retries are used up: the history of the job and the options. */
  private ownerQuestion(task: WorkerTask): string {
    const L = this.cfg.language;
    const chain = this.state.tasks.filter((x) => x.jobId === task.jobId);
    const lines = chain.map((x) => `- ${x.id} (${x.providerId}): ${x.status === 'timeout' ? pick(L, 'таймаут', 'timeout') : pick(L, 'ошибка', 'error')}${x.error ? ` — ${x.error.slice(0, 160)}` : ''}`);
    return pick(
      L,
      `Задача «${task.title}» не выполнена после ${chain.length} попыток (первая и ${chain.length - 1} автоповтора).\nЧто произошло:\n${lines.join('\n')}\nЧто делаем? 1) попробовать ещё раз на конкретном исполнителе (скажите, на каком); 2) переписать или упростить бриф; 3) выполнить самому в основной сессии; 4) отложить задачу.`,
      `The task «${task.title}» failed after ${chain.length} attempts (the first one and ${chain.length - 1} automatic retries).\nWhat happened:\n${lines.join('\n')}\nWhat do we do? 1) try again on a worker you name; 2) rewrite or simplify the brief; 3) do it myself in the main session; 4) put it off.`,
    );
  }

  /** A failed or timed-out task is restarted on another suitable worker, up to `autoRetry` times; then the owner is asked. */
  private afterFailure(task: WorkerTask) {
    if (!['failed', 'timeout'].includes(task.status) || this.cancelled || this.budgetExhausted || this.frozen) return;
    if (/превышен лимит|исчерпан бюджет/.test(task.error ?? '')) return; // stopped on purpose by a cap
    const max = this.cfg.autoRetry ?? 3;
    const attempt = task.attempt ?? 1;
    const L = this.cfg.language;
    if (attempt <= max) {
      const p = this.retryProvider(task);
      if (p) {
        try {
          this.delegate({ provider: p.id, role: task.role, title: task.title, spec: task.spec, retry: { of: task.id, jobId: task.jobId ?? task.id, attempt: attempt + 1 } });
          const next = this.state.tasks[this.state.tasks.length - 1];
          task.retriedAs = next.id;
          this.note('system', pick(L, `Автоповтор ${attempt}/${max}: ${task.id} (${task.providerId}) не выполнена (${(task.error ?? task.status).slice(0, 120)}); запускаю ${next.id} на ${next.providerId}`, `Auto-retry ${attempt}/${max}: ${task.id} (${task.providerId}) failed (${(task.error ?? task.status).slice(0, 120)}); starting ${next.id} on ${next.providerId}`));
          this.emit({ type: 'task', task });
          return;
        } catch {
          /* the chosen worker cannot take it now: ask the owner */
        }
      }
    }
    task.escalated = true;
    task.question = this.ownerQuestion(task);
    this.note('error', task.question);
    this.emit({ type: 'task', task });
    this.pushState();
  }

  private async captureDiff(task: WorkerTask) {
    await git.commitAll(task.worktree, `orch(${task.id}): ${task.title}`);
    task.diffStat = await git.diffStat(task.worktree, task.baseSha);
    task.diff = await git.fullDiff(task.worktree, task.baseSha);
  }

  private waitTask(task: WorkerTask): Promise<void> {
    if (isTerminal(task.status)) return Promise.resolve();
    return new Promise((resolve) => {
      const arr = this.taskWaiters.get(task.id) ?? [];
      arr.push(resolve);
      this.taskWaiters.set(task.id, arr);
    });
  }

  /**
   * Wait for tasks (all unfinished ones if none given). With timeoutMs, returns early
   * with the current status of anything still running, so an MCP client can poll.
   */
  async wait(ids?: string[], timeoutMs?: number): Promise<string> {
    const list = ids?.length ? ids : this.state.tasks.filter((t) => !isTerminal(t.status)).map((t) => t.id);
    if (!list.length) return 'no running tasks';
    const tasks = list.map((id) => this.mustTask(id));
    const all = Promise.all(tasks.map((t) => this.waitTask(t)));
    if (timeoutMs) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([all, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
      clearTimeout(timer);
    } else await all;
    const out = tasks.map((t) => (isTerminal(t.status) ? this.describeTask(t) : this.briefStatus(t) + ' (still running, call wait_for again)'));
    return out.join('\n\n==========\n\n') + `\n\n[${this.spendReport()}]`;
  }

  briefStatus(t: WorkerTask): string {
    const cost = t.costUsd != null ? ` cost=$${t.costUsd.toFixed(3)}${t.costEstimated ? '(est.)' : ''}` : '';
    const retry = t.retriedAs ? ` auto-retry→${t.retriedAs}` : '';
    const attempt = (t.attempt ?? 1) > 1 ? ` attempt=${t.attempt}` : '';
    const ask = t.escalated
      ? `\nNEEDS OWNER DECISION: automatic retries are used up. Do not delegate this task again. Tell the owner this, in ${replyLang(this.cfg)}, and ask what to do:\n${t.question ?? ''}`
      : '';
    const alive = t.status === 'running' && t.lastActivityAt ? ` (last activity ${Math.round((Date.now() - t.lastActivityAt) / 1000)}s ago: ${(t.log[t.log.length - 1] ?? '').slice(0, 80)}; the cost shown is a live estimate, the provider may report real usage only at the end)` : '';
    return `task ${t.id} "${t.title}" [${t.role ?? '-'} · ${t.providerId}/${t.model}] status=${t.status}${attempt}${retry}${t.error ? ' error=' + t.error : ''}${cost}${alive}${ask}`;
  }

  describeTask(t: WorkerTask): string {
    const summary = `Worker summary:\n${t.result || '(none)'}`;
    const stat = `Diff stat:\n${t.diffStat || '(no changes)'}`;
    const diff = t.diff ? `Diff:\n${clip(t.diff, MAX_DIFF_CHARS_FOR_LLM)}` : '';
    return [this.briefStatus(t), summary, stat, diff].filter(Boolean).join('\n\n');
  }

  status(): string {
    if (!this.state.tasks.length) return `no tasks yet. [${this.spendReport()}]`;
    return this.state.tasks.map((t) => this.briefStatus(t)).join('\n') + `\n[${this.spendReport()}]`;
  }

  async getDiff(input: { task_id: string; path?: string }): Promise<string> {
    const t = this.mustTask(input.task_id);
    if (!t.baseSha) return 'task has no diff yet';
    if (input.path) {
      const r = await git.run('git', ['diff', `${t.baseSha}..${t.branch}`, '--', input.path], this.state.repo);
      return r.stdout || '(no changes in that path)';
    }
    return t.diff || '(no changes)';
  }

  async merge(input: { task_id: string }): Promise<string> {
    const t = this.mustTask(input.task_id);
    if (!['done', 'failed', 'timeout'].includes(t.status)) throw new Error(`task ${t.id} is ${t.status}, cannot merge`);
    if (!t.diffStat) return `task ${t.id} has no changes; nothing to merge`;
    // Another run (or another app/MCP process) may be merging into the same repository right now.
    const r = await git.withRepoLock(this.state.repo, () => git.mergeBranch(this.state.repo, t.branch, `Merge ${t.branch}: ${t.title}`));
    if (!r.ok) return `MERGE FAILED for ${t.id}:\n${r.output}\nThe branch is intact; you can delegate a rebase/fix task or discard it.`;
    const files = (await git.run('git', ['diff', '--name-only', t.baseSha, t.branch], this.state.repo)).stdout.split('\n').filter(Boolean);
    await git.removeWorktree(this.state.repo, t.worktree, t.branch, true);
    this.setStatus(t, 'merged');
    const type = t.role === 'bugfix' ? 'fix' : t.role === 'feature' ? 'feature' : t.role === 'tests' ? 'test' : t.role === 'docs' ? 'docs' : t.role === 'refactor' ? 'refactor' : 'merge';
    this.remember(type, `${t.title} (слито ${t.id}, исполнитель ${t.providerId})`, files, { task: t.id, branch: t.branch }, `orchestra:${t.providerId}`);
    return `merged ${t.id} into ${this.state.baseBranch}\n${r.output}`;
  }

  async discard(input: { task_id: string; reason?: string; force?: boolean }): Promise<string> {
    const t = this.mustTask(input.task_id);
    // A task that shows signs of life is not stuck, even when its cost counter says $0: do not throw it away by mistake.
    if (t.status === 'running' && !input.force) {
      const idle = Math.round((Date.now() - (t.lastActivityAt ?? t.startedAt ?? Date.now())) / 1000);
      if (idle < 180) {
        return `REFUSED: ${t.id} is running and was active ${idle}s ago (last line: ${(t.log[t.log.length - 1] ?? '').slice(0, 100)}). A low or zero cost counter is not a sign of a hang: some providers report usage only when the task ends. Keep waiting with wait_for, or call discard_task with force=true if you really want to stop it.`;
      }
    }
    const h = this.handles.get(t.id);
    if (h) h.kill();
    if (t.baseSha) await git.removeWorktree(this.state.repo, t.worktree, t.branch, true);
    this.queue = this.queue.filter((x) => x !== t);
    this.setStatus(t, 'discarded');
    this.remember('note', `${t.id} ${t.title}: отброшено${input.reason ? ' — ' + input.reason : ''}`, [], { task: t.id });
    this.release(t);
    return `discarded ${t.id}${input.reason ? ': ' + input.reason : ''}`;
  }

  /**
   * App is quitting: kill worker processes but keep task statuses as they are,
   * so the next launch sees them as interrupted and can salvage their worktrees.
   */
  freeze(): void {
    this.frozen = true;
    for (const h of this.handles.values()) h.kill();
  }

  cancelAll(): void {
    this.cancelled = true;
    for (const [id, h] of this.handles) {
      h.kill();
      const t = this.task(id);
      if (t && t.status === 'running') this.setStatus(t, 'cancelled');
    }
    for (const t of this.queue) this.setStatus(t, 'cancelled');
    this.queue = [];
  }

  /**
   * After a restart: tasks that were queued or running have no process any more.
   * Keep whatever a worker managed to do (its worktree survives) so it can still be reviewed and merged.
   * Returns a note for the orchestrator.
   */
  async reconcileInterrupted(): Promise<string> {
    const notes: string[] = [];
    for (const t of this.state.tasks) {
      if (t.status === 'queued') {
        t.error = 'не запускалась: приложение было закрыто';
        t.status = 'cancelled';
        notes.push(`${t.id} was queued and never started (now cancelled); delegate it again if still needed`);
      } else if (t.status === 'running') {
        t.error = 'прервана: приложение было закрыто';
        t.finishedAt = Date.now();
        if (t.baseSha && fs.existsSync(t.worktree)) {
          try {
            await this.captureDiff(t);
          } catch (e: any) {
            t.error += `; diff: ${e?.message ?? e}`;
          }
        }
        t.status = 'failed';
        notes.push(`${t.id} was interrupted mid-work; partial diff ${t.diffStat ? 'is available (get_diff)' : 'is empty'}`);
      } else if (['done', 'failed', 'timeout'].includes(t.status) && t.baseSha && !fs.existsSync(t.worktree)) {
        const exists = await git.run('git', ['rev-parse', '--verify', t.branch], this.state.repo);
        if (exists.code !== 0) {
          t.status = 'discarded';
          notes.push(`${t.id}'s branch no longer exists (someone removed it); treated as discarded`);
        }
      }
    }
    return notes.join('\n');
  }

  /**
   * After a service restart: tasks that were queued or running have no process any more.
   * A task whose branch already has commits ahead of its base is treated as finished (the work is
   * committed); the rest fail with the worktree kept for the owner to inspect uncommitted work.
   */
  async reconcileMcpRestart(): Promise<void> {
    for (const t of this.state.tasks) {
      if (t.status !== 'queued' && t.status !== 'running') continue;
      if (t.status === 'running') t.finishedAt = Date.now();
      if (t.status === 'running' && t.baseSha && (await this.branchAhead(t))) {
        t.status = 'done';
        t.result = 'восстановлено после перезапуска службы';
        t.diffStat = await git.diffStat(t.worktree, t.baseSha);
        t.diff = await git.fullDiff(t.worktree, t.baseSha);
      } else {
        t.error = 'прервано перезапуском службы: воркер остановлен; правки, если были, лежат в worktree';
        t.status = 'failed';
      }
    }
  }

  /** True when the task's branch has commits on top of its base (the worker committed before the restart). */
  private async branchAhead(t: WorkerTask): Promise<boolean> {
    const r = await git.run('git', ['rev-list', '--count', `${t.baseSha}..HEAD`], t.worktree);
    return r.code === 0 && Number(r.stdout.trim()) > 0;
  }

  // ---------- helpers ----------

  task(id: string): WorkerTask | undefined {
    return this.state.tasks.find((t) => t.id === id);
  }

  mustTask(id: string): WorkerTask {
    const t = this.task(id);
    if (!t) throw new Error(`no task ${id}`);
    return t;
  }

  setStatus(t: WorkerTask, s: WorkerTask['status']) {
    t.status = s;
    this.emit({ type: 'task', task: t });
  }

  log(kind: TranscriptEntry['kind'], text: string) {
    const entry = { ts: Date.now(), kind, text };
    this.state.transcript.push(entry);
    this.emit({ type: 'transcript', entry });
  }

  /** Public journal entry for external orchestrators (the MCP tools); the app's own loop uses `log`. */
  note(kind: TranscriptEntry['kind'], text: string) {
    this.log(kind, text);
  }

  /** Like `note`, but only once per key: a task's result is recorded the first time wait_for sees it terminal. */
  noteOnce(key: string, kind: TranscriptEntry['kind'], text: string) {
    if (this.noted.has(key)) return;
    this.noted.add(key);
    this.note(kind, text);
  }

  pushState() {
    this.emit({ type: 'state', state: this.state });
  }
}
