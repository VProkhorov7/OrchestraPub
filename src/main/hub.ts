import * as fs from 'fs';
import * as path from 'path';
import { ConfigStore, anthropicKey } from './config';
import { Orchestrator } from './orchestrator';
import { CliOrchestrator } from './cliorch';
import { TaskEngine } from './engine';
import { RunStore, SavedRun } from './runs';
import { buildReport, loadStates } from './report';
import { addSnapshot, readLedger, reconcile } from './ledger';
import { checkAll, checkOne, deepseekBalanceUsd } from './health';
import { canWork, PRESETS } from './catalog';
import { makePlan } from './planner';
import { applyChoice, plannerChoices, settingsChoice, triage } from './triage';
import { run } from './git';
import { pidAlive } from './paths';
import { nextWindow, tariffStatus, now as tariffNow } from './tariff';
import { ProjectMemory } from '../memory/store';
import { setupRepo } from '../memory/setup';
import { freshDigest, stageChangelog } from '../memory/summarize';

const RUN_STATUS_RU: Record<string, string> = { done: 'завершён', failed: 'ошибка', cancelled: 'отменён', interrupted: 'прерван', stopped: 'остановлен' };
const RUN_STATUS_EN: Record<string, string> = { done: 'finished', failed: 'failed', cancelled: 'cancelled', interrupted: 'interrupted', stopped: 'stopped' };

/** Split the orchestrator's final report into the owner summary, "Сделано" and "Дальше" bullets. */
export function parseReport(report: string): { summary: string; done: string[]; next: string[] } {
  const lines = report.split('\n');
  const summary: string[] = [];
  const done: string[] = [];
  const next: string[] = [];
  let where: 'summary' | 'done' | 'next' | 'other' = 'summary';
  for (const raw of lines) {
    const l = raw.trim();
    if (/^\**\s*(сделано|done)\s*:?\**\s*:?$/i.test(l)) { where = 'done'; continue; }
    if (/^\**\s*(дальше|next|что дальше|осталось)\s*:?\**\s*:?$/i.test(l)) { where = 'next'; continue; }
    if (/^#+\s/.test(l)) { if (where === 'summary' && summary.length) where = 'other'; continue; }
    const bullet = l.match(/^[-*•]\s+(.*)$/)?.[1];
    if (where === 'done' && bullet) done.push(bullet);
    else if (where === 'next' && bullet) next.push(bullet);
    else if (where === 'summary' && l) summary.push(l);
    else if (where === 'summary' && !l && summary.length) where = 'other';
  }
  return { summary: summary.join(' ').slice(0, 800), done, next };
}
import * as git from './git';
import { pick } from '../memory/lang';
import { Alerts } from './alerts';
import { freeOnlyReason, refreshFreeModels } from './freetier';
import { listLocalModels, prepareOllamaContext } from './localmodels';
import { Watchdog } from './watchdog';
import { collectAttention, AttentionRun } from './attention';
import { pausedUntil } from './ratelimit';
import { AppConfig, Health, OrchEvent, Plan, PlannerChoice, ROLES, RunState, Triage } from './types';
import { ensureMemory } from '../memory/setup';
import { execFile, execFileSync } from 'child_process';

type Controller = Orchestrator | CliOrchestrator;
export interface Scheduled {
  id: string;
  repo: string;
  goal: string;
  plan?: Plan;
  choice?: string;
  /** When to start (ISO): the beginning of a cheap window. */
  at: string;
  windowEnd?: string;
  createdAt: string;
  /** Why the last start attempt failed (dirty repo, planner unavailable…): retried every minute. */
  lastError?: string;
}

export type HubEvent = OrchEvent & { runId?: string };

/** A run waiting for the human to approve the planner (autopilot through MCP). */
interface Pending {
  id: string;
  repo: string;
  goal: string;
  triage: Triage;
  createdAt: number;
}

/** Interactive MCP session bound to one repository: the external agent orchestrates, we run the workers. */
interface McpSession {
  engine: TaskEngine;
  lastUsed: number;
}

const MCP_IDLE_MS = 2 * 60 * 60_000;
/** «Требует вас» ignores saved runs whose run.json is older than this. */
const ATTENTION_MAX_RUN_AGE_MS = 30 * 24 * 60 * 60_000;
/** How long a git answer about a task branch is reused (the panel polls every 2 s). */
const ATTENTION_GIT_CACHE_MS = 60_000;
const ATTENTION_GIT_TIMEOUT_MS = 5_000;

/**
 * Everything the app does, without Electron: settings, connection health, the run registry
 * (several runs at once), planning, triage, history and MCP sessions.
 * Used by the desktop app (IPC) and by `orchestra serve` (HTTP + MCP + web panel).
 */
export class Hub {
  readonly store: ConfigStore;
  readonly runs: RunStore;
  health: Record<string, Health> = {};
  private healthJob: Promise<void> | null = null;
  private controllers = new Map<string, Controller>();
  private mcp = new Map<string, McpSession>();
  private pending = new Map<string, Pending>();
  /** Last run started or resumed from a UI: what the desktop app shows by default. */
  currentId: string | null = null;
  private idleTimer: NodeJS.Timeout;
  readonly alerts: Alerts;
  private watchdog: Watchdog;

  constructor(
    public home: string,
    private emitOut: (ev: HubEvent) => void,
  ) {
    this.store = new ConfigStore(path.join(home, 'config.json'));
    this.runs = new RunStore(path.join(home, 'runs'));
    this.idleTimer = setInterval(() => this.closeIdleMcp(), 60_000);
    this.idleTimer.unref();
    this.alerts = new Alerts(path.join(home, 'alerts.json'), () => this.config(), (alert) => this.emitOut({ type: 'alert', alert }));
    this.watchdog = new Watchdog(this, this.alerts, () => this.config());
  }

  /** Engines of runs that are going now (app runs and MCP sessions): what the watchdog looks at. */
  liveEngines() {
    const apps = [...this.controllers.values()].filter((c) => c.state.status === 'running').map((c) => c.engine);
    return [...apps, ...[...this.mcp.values()].map((m) => m.engine)];
  }

  private branchGoneCache = new Map<string, { at: number; gone: boolean }>();

  /**
   * True when the task branch no longer exists in the repo or is already merged into the run's base branch: the task is
   * closed even though run.json still says «done». Any doubt (no repo, no git, timeout, no base) = false: an extra item is better than a lost one.
   */
  private branchGone(repo: string, branch: string, base: string, now: number): boolean {
    if (!repo || !branch || !base) return false;
    const key = `${repo}\0${branch}\0${base}`;
    const hit = this.branchGoneCache.get(key);
    if (hit && now - hit.at < ATTENTION_GIT_CACHE_MS) return hit.gone;
    const status = (args: string[]) => {
      try {
        execFileSync('git', args, { cwd: repo, stdio: 'ignore', timeout: ATTENTION_GIT_TIMEOUT_MS });
        return 0;
      } catch (e: any) {
        return typeof e?.status === 'number' ? e.status : -1;
      }
    };
    const exists = status(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    const gone = exists === 1 || (exists === 0 && status(['merge-base', '--is-ancestor', `refs/heads/${branch}`, base]) === 0);
    this.branchGoneCache.set(key, { at: now, gone });
    return gone;
  }

  /** Saved runs whose run.json was touched within ATTENTION_MAX_RUN_AGE_MS; older ones are not even read. */
  private savedStates(now: number): RunState[] {
    const out: RunState[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.runs.dir);
    } catch {
      return out;
    }
    for (const n of names) {
      try {
        const f = path.join(this.runs.dir, n, 'run.json');
        if (now - fs.statSync(f).mtimeMs > ATTENTION_MAX_RUN_AGE_MS) continue;
        out.push(JSON.parse(fs.readFileSync(f, 'utf8')).state);
      } catch {
        /* unreadable run: skip */
      }
    }
    return out;
  }

  /** «Требует вас»: what waits for the owner, from the live runs and the runs saved on disk (see attention.ts). */
  attention() {
    const cfg = this.config();
    const engines = new Map<string, TaskEngine>();
    for (const c of this.controllers.values()) engines.set(c.state.runId, c.engine);
    for (const m of this.mcp.values()) engines.set(m.engine.state.runId, m.engine);
    const now = Date.now();
    const runs: AttentionRun[] = [...engines.values()].map((e) => {
      const s = e.spent();
      return { runId: e.state.runId, tasks: e.state.tasks, budgetUsd: e.budget(), spentTotal: s.total, spentByProvider: s.byProvider, live: true };
    });
    for (const s of this.savedStates(now)) {
      if (!s?.runId || !Array.isArray(s.tasks) || engines.has(s.runId)) continue;
      // A task that would give an item but whose branch is gone or merged is closed: shown to collectAttention as merged
      // (kept in the list, so `continuedFrom` links of other tasks still work).
      const tasks = s.tasks.map((t) => {
        const open = t.status !== 'merged' && t.status !== 'discarded' && t.status !== 'cancelled' && (t.status === 'done' || t.needsAnswer || t.capped || t.escalated);
        return open && this.branchGone(s.repo, t.branch, s.baseBranch, now) ? { ...t, status: 'merged' as const } : t;
      });
      runs.push({ runId: s.runId, tasks, budgetUsd: s.budgetUsd ?? 0, spentTotal: 0, spentByProvider: {}, live: false });
    }
    return collectAttention({
      runs,
      providers: cfg.providers,
      health: this.health,
      pausedUntil: Object.fromEntries(cfg.providers.map((p) => [p.id, pausedUntil(p.id, now)])),
      unmergedWarnMinutes: cfg.notify?.unmergedWarnMinutes ?? 60,
      now,
    });
  }

  get worktreeRoot() {
    return path.join(this.home, 'worktrees');
  }

  /** Startup: stale "running" runs become "interrupted"; check connections. */
  private scheduleTimer?: NodeJS.Timeout;

  init() {
    this.watchdog.start();
    this.scheduleTimer = setInterval(() => this.tickSchedule().catch(() => {}), 60_000);
    this.scheduleTimer.unref();
    setTimeout(() => this.tickSchedule().catch(() => {}), 3_000).unref();
    this.runs.markInterrupted((s) => s.pid !== process.pid && pidAlive(s.pid));
    this.refreshHealth().catch(() => {});
    this.recheckTimer = setInterval(() => this.recheckBad().catch(() => {}), 120_000);
    this.recheckTimer.unref();
    // Subscription limits re-check every 5 min, so a near-limit yellow light clears once the window resets.
    const pollMs = Number(process.env.ORCHESTRA_LIMIT_POLL_MS) || 300_000;
    this.limitTimer = setInterval(() => this.recheckSubLimits().catch(() => {}), pollMs);
    this.limitTimer.unref();
  }

  /** Red/yellow lights of enabled connections are re-checked, so a start-up network blip does not stick. */
  private recheckTimer?: NodeJS.Timeout;
  /** Subscription limits re-check timer (5 min). */
  private limitTimer?: NodeJS.Timeout;

  private async recheckBad() {
    for (const p of this.config().providers) {
      if (p.enabled && (p.local || ['red', 'yellow'].includes(this.health[p.id]?.light ?? ''))) await this.refreshHealth(p.id).catch(() => {});
    }
  }

  private async recheckSubLimits() {
    for (const p of this.config().providers) {
      if (p.enabled && (p.kind === 'claude-sub' || p.kind === 'codex-sub')) await this.refreshHealth(p.id).catch(() => {});
    }
  }

  emit(ev: HubEvent) {
    try {
      this.watchdog.onEvent(ev);
    } catch {
      /* a watchdog fault never blocks events */
    }
    this.emitOut(ev);
  }

  // ---------- settings & health ----------

  config(): AppConfig {
    return this.store.load();
  }

  saveConfig(cfg: AppConfig) {
    this.store.save(cfg);
    this.touchMcpHealth(); // settings (e.g. forceProvider) reach open MCP sessions without a restart
    this.refreshHealth().catch(() => {});
  }

  catalog() {
    return PRESETS;
  }

  roles() {
    return ROLES;
  }

  refreshHealth(id?: string): Promise<void> {
    const cfg = this.config();
    const job = (async () => {
      if (id) {
        const p = cfg.providers.find((x) => x.id === id);
        if (p) this.health = { ...this.health, [id]: await checkOne(p, cfg) };
      } else this.health = await checkAll(cfg);
      this.touchMcpHealth();
      this.emit({ type: 'health', health: this.health });
    })();
    if (!id) this.healthJob = job.finally(() => (this.healthJob = null));
    return job;
  }

  async envCheck() {
    const cfg = this.config();
    const claude = await run(cfg.claudePath, ['--version'], process.cwd(), { timeoutMs: 15_000 });
    const gitv = await run('git', ['--version'], process.cwd(), { timeoutMs: 15_000 });
    return {
      claude: claude.code === 0 ? claude.stdout.trim() : `не работает (${(claude.stderr.trim().split('\n')[0] || 'код ' + claude.code).slice(0, 120)})`,
      git: gitv.code === 0 ? gitv.stdout.trim() : 'не найден',
      hasApiKey: !!anthropicKey(cfg),
      mode: cfg.orchestrator.mode,
    };
  }

  /** Current settings + health, with one run's planner applied and checked. */
  async readyConfig(choiceId?: string): Promise<AppConfig> {
    if (this.healthJob) await this.healthJob;
    await this.recheckBad();
    let cfg = this.config();
    cfg.health = this.health;
    if (choiceId) {
      const c = plannerChoices(cfg).find((x) => x.id === choiceId);
      if (!c) throw new Error(`Неизвестный планировщик «${choiceId}»`);
      cfg = applyChoice(cfg, c);
    }
    const mode = cfg.orchestrator.mode;
    if (cfg.freeOnly && mode === 'api') throw new Error('Режим «только бесплатное»: оркестратор по API-ключу платный. Выберите оркестратором подписку (Claude или ChatGPT) или выключите режим.');
    if (mode === 'api' && !anthropicKey(cfg)) throw new Error('Оркестратор в режиме API: добавьте подключение «Claude API» с ключом');
    if (mode !== 'api') {
      if (!cfg.providers.some((p) => p.id === mode)) throw new Error('Добавьте в «Подключения» подписку, выбранную оркестратором');
      const h = this.health[mode];
      if (h?.light === 'red') throw new Error(`Оркестратор недоступен: ${h.text}`);
    }
    const workers = cfg.providers.filter((p) => p.enabled && canWork(p) && !['red', 'yellow'].includes(this.health[p.id]?.light ?? '') && !freeOnlyReason(cfg, p));
    if (!workers.length) throw new Error(cfg.freeOnly ? 'Режим «только бесплатное»: нет ни одного бесплатного исполнителя. Подключите локальную модель или OpenRouter с бесплатной моделью (openrouter/free) либо выключите режим.' : 'Нет ни одного работающего воркера: включите «брать задачи» у подключения с зелёным статусом');
    return cfg;
  }

  // ---------- planner choice & plan ----------

  async triage(goal: string): Promise<Triage> {
    if (this.healthJob) await this.healthJob;
    const cfg = this.config();
    cfg.health = this.health;
    const pick = cfg.plannerPick ?? 'ask';
    if (pick === 'settings') {
      const c = settingsChoice(cfg);
      const choices = plannerChoices(cfg);
      return { complexity: 'medium', recommended: c.id, reason: 'модель из настроек', by: 'настройки', choices: choices.some((x) => x.id === c.id) ? choices : [c, ...choices] };
    }
    return triage(cfg, goal);
  }

  async makePlan(repo: string, goal: string, choiceId?: string): Promise<Plan> {
    this.autoMemory(repo);
    const cfg = await this.readyConfig(choiceId);
    return makePlan(cfg, repo, goal);
  }

  // ---------- runs ----------

  private controllerFor(cfg: AppConfig, repo: string, goal: string, plan?: Plan): Controller {
    const emit = (ev: OrchEvent) => this.emit({ ...ev, runId: c.state.runId });
    const c: Controller =
      cfg.orchestrator.mode === 'api'
        ? new Orchestrator(cfg, this.worktreeRoot, repo, goal, emit, plan, this.runs)
        : new CliOrchestrator(cfg, this.worktreeRoot, repo, goal, emit, plan, this.runs);
    return c;
  }

  /** Fail fast, to the caller, on what would otherwise only show up as a toast. */
  private async checkRepo(repo: string) {
    if (!(await git.isRepo(repo))) throw new Error(`${repo} не git-репозиторий`);
    if (await git.isDirty(repo)) throw new Error('В репозитории есть незакоммиченные изменения. Закоммитьте или уберите их в stash.');
  }

  private busyOn(repo: string) {
    const key = path.resolve(repo);
    return [...this.controllers.values()].find((c) => c.state.status === 'running' && path.resolve(c.state.repo) === key);
  }

  private launch(c: Controller) {
    // Owner process: another Orchestra process on the same data folder (app + `orchestra serve`) must not mark it interrupted.
    c.state.pid = process.pid;
    this.controllers.set(c.state.runId, c);
    this.currentId = c.state.runId;
    const own = this.memoryRunStart(c);
    c.start()
      .catch((e) => this.emit({ type: 'toast', level: 'error', text: e?.message ?? String(e), runId: c.state.runId }))
      .finally(() => this.memoryRunEnd(c, own));
    return c.state.runId;
  }

  // ---------- project memory around runs ----------

  /** A run is a micro-session in the repo's memory. Returns true if the run opened the session itself. */
  private memoryRunStart(c: Controller): boolean {
    if (!ProjectMemory.exists(c.state.repo)) return false;
    try {
      const m = new ProjectMemory(c.state.repo);
      const had = !!m.session();
      m.sessionStart('orchestra', c.state.goal.split('\n')[0].slice(0, 200));
      m.log({ type: 'task', author: 'orchestra', description: `${pick(this.config().language, 'запуск', 'run')} ${c.state.runId}: ${c.state.goal.split('\n')[0].slice(0, 300)}`, details: { run: c.state.runId, orchestrator: c.state.orchestrator, plan: c.state.plan?.tasks.map((t) => t.title) } });
      return !had;
    } catch {
      return false;
    }
  }

  /** Journal entry + session end from the final report, then commit memory and wiki so they travel with the code. */
  private memoryRunEnd(c: Controller, own: boolean) {
    const s = c.state;
    if (!ProjectMemory.exists(s.repo) || s.status === 'running') return;
    try {
      const m = new ProjectMemory(s.repo);
      const r = parseReport(s.finalReport ?? '');
      const merged = s.tasks.filter((t) => t.status === 'merged');
      const summary =
        r.summary ||
        pick(
          this.config().language,
          `Запуск ${s.runId}: ${RUN_STATUS_RU[s.status] ?? s.status}. Слито задач: ${merged.length} из ${s.tasks.length}.${s.stopReason ? ' ' + s.stopReason : ''}`,
          `Run ${s.runId}: ${RUN_STATUS_EN[s.status] ?? s.status}. Tasks merged: ${merged.length} of ${s.tasks.length}.${s.stopReason ? ' ' + s.stopReason : ''}`,
        );
      const spent = (s.orchestratorCostUsd ?? 0) + s.tasks.reduce((a, t) => a + (t.costUsd ?? 0), 0);
      const details = {
        run: s.runId,
        status: s.status,
        orchestrator: s.orchestrator,
        spentUsd: Number(spent.toFixed(4)),
        tasks: s.tasks.map((t) => ({ id: t.id, title: t.title, role: t.role, provider: t.providerId, status: t.status, costUsd: t.costUsd })),
        finalReport: s.finalReport,
      };
      const done = r.done.length ? r.done : merged.map((t) => t.title);
      if (own && m.session()) m.sessionEnd({ author: 'orchestra', summary, done, next: r.next, details });
      else {
        m.log({ type: 'session_end', author: 'orchestra', description: summary, details: { ...details, done, next: r.next, withinSession: m.session()?.id } });
        m.appendJournal({ author: 'orchestra', minutes: s.startedAt ? Math.round(((s.finishedAt ?? Date.now()) - s.startedAt) / 60_000) : 0, summary, done, next: r.next, files: [], commits: [] });
      }
      const paths = m.memoryPaths();
      if (paths.length && (git.runSync(s.repo, ['status', '--porcelain', '--', ...paths]))) {
        git.runSync(s.repo, ['add', '--', ...paths]);
        git.runSync(s.repo, ['-c', 'user.name=orchestra', '-c', 'user.email=orchestra@localhost', 'commit', '--no-verify', '-q', '-m', `chore(memory): ${pick(this.config().language, 'запуск', 'run')} ${s.runId}`, '--', ...paths]);
      }
    } catch (e: any) {
      this.emit({ type: 'toast', level: 'error', text: `Память проекта: ${e?.message ?? e}`, runId: s.runId });
    }
  }

  // ---------- memory for the panel ----------

  /** OpenRouter's free models (for the model field of a free OpenRouter connection). */
  async freeModels() {
    return refreshFreeModels();
  }

  /** Local models: the models the server offers, and (Ollama on this machine) a copy of the model with a 32K context. */
  async localModels(id: string) {
    const p = this.config().providers.find((x) => x.id === id);
    if (!p) throw new Error(`нет подключения «${id}»`);
    return listLocalModels(p);
  }

  async localPrepare(id: string) {
    const p = this.config().providers.find((x) => x.id === id);
    if (!p) throw new Error(`нет подключения «${id}»`);
    const model = await prepareOllamaContext(p);
    return { model };
  }

  /** First use of a repository: memory is created by itself (never fails the caller; the panel is told once). */
  private autoMemory(repo: string) {
    try {
      const r = ensureMemory(repo);
      if (r.created) this.emit({ type: 'toast', level: 'info', text: pick(this.config().language, `Память проекта создана: ${path.basename(repo)}${r.adoptedFrom ? ` (взята с ветки ${r.adoptedFrom})` : ''}`, `Project memory created: ${path.basename(repo)}${r.adoptedFrom ? ` (taken over from ${r.adoptedFrom})` : ''}`) });
    } catch {
      /* memory is a help, not a condition for work */
    }
  }

  memoryStatus(repo: string) {
    this.autoMemory(repo);
    if (!ProjectMemory.exists(repo)) return { enabled: false };
    const m = new ProjectMemory(repo);
    const s = m.session();
    return {
      enabled: true,
      facts: m.facts().filter((f) => f.status === 'active').length,
      decisions: m.decisions().filter((d) => d.status === 'active').length,
      session: s ? { author: s.author, minutes: Math.round(m.minutesInSession()), limit: m.config().sessionMinutes } : null,
      lastJournal: m.readLog({ types: ['session_end'], limit: 1 })[0]?.description ?? null,
    };
  }

  memoryInit(repo: string, project?: string) {
    return setupRepo(repo, { project });
  }

  async memoryDigest(repo: string) {
    const cfg = this.config();
    cfg.health = this.health;
    return freshDigest(cfg, repo);
  }

  async memoryChangelog(repo: string, release?: string) {
    const cfg = this.config();
    cfg.health = this.health;
    return stageChangelog(cfg, repo, release);
  }

  async start(repo: string, goal: string, plan?: Plan, choiceId?: string, opts: { offPeakOnly?: boolean } = {}): Promise<string> {
    if (!repo || !goal) throw new Error('Укажите репозиторий и задание');
    const busy = this.busyOn(repo);
    if (busy) throw new Error(`На этом репозитории уже идёт запуск ${busy.state.runId}`);
    const cfg = await this.readyConfig(choiceId);
    await this.checkRepo(repo);
    this.autoMemory(repo);
    const c = this.controllerFor(cfg, repo, goal, plan);
    if (opts.offPeakOnly) c.state.offPeakOnly = true;
    return this.launch(c);
  }

  // ---------- off-peak scheduling («В льготное время») ----------

  private get scheduleFile() {
    return path.join(this.home, 'scheduled.json');
  }

  scheduled(): Scheduled[] {
    try {
      return JSON.parse(fs.readFileSync(this.scheduleFile, 'utf8'));
    } catch {
      return [];
    }
  }

  private saveScheduled(list: Scheduled[]) {
    fs.mkdirSync(this.home, { recursive: true });
    fs.writeFileSync(this.scheduleFile, JSON.stringify(list, null, 2));
    this.emit({ type: 'scheduled', scheduled: list } as any);
  }

  tariff() {
    return tariffStatus(this.config());
  }

  /**
   * Start at the next cheap window of at least 3 hours (now, if already in one). Checks now what would fail later
   * (repo, planner); the run itself is off-peak only: workers of time-of-day providers wait out peak hours.
   */
  async schedule(repo: string, goal: string, plan?: Plan, choiceId?: string): Promise<Scheduled> {
    if (!repo || !goal) throw new Error('Укажите репозиторий и задание');
    if (!(await git.isRepo(repo))) throw new Error(`${repo} не git-репозиторий`);
    const dup = this.scheduled().find((x) => path.resolve(x.repo) === path.resolve(repo) && x.goal.trim() === goal.trim());
    if (dup) throw new Error(`Эта задача уже запланирована на ${dup.at} — отмените её или запустите сейчас`);
    const cfg = this.config();
    const win = nextWindow(cfg);
    if (!win) throw new Error('Ни у одного подключённого исполнителя нет льготного тарифа: запускайте сразу');
    const item: Scheduled = { id: `s-${Date.now().toString(36)}`, repo, goal, plan, choice: choiceId, at: win.start.toISOString(), windowEnd: win.end.toISOString(), createdAt: new Date().toISOString() };
    this.saveScheduled([...this.scheduled(), item]);
    this.tickSchedule();
    return item;
  }

  unschedule(id: string) {
    const list = this.scheduled();
    if (!list.some((x) => x.id === id)) throw new Error(`нет отложенного запуска ${id}`);
    this.saveScheduled(list.filter((x) => x.id !== id));
  }

  /** Start a scheduled run right away (at the current price). */
  async startScheduledNow(id: string): Promise<string> {
    const it = this.scheduled().find((x) => x.id === id);
    if (!it) throw new Error(`нет отложенного запуска ${id}`);
    const runId = await this.start(it.repo, it.goal, it.plan, it.choice, { offPeakOnly: true });
    this.saveScheduled(this.scheduled().filter((x) => x.id !== id));
    return runId;
  }

  private scheduleBusy = false;

  /** Every minute: start what is due; a busy repository or a failure is reported and retried at the next tick. */
  async tickSchedule() {
    if (this.scheduleBusy) return;
    this.scheduleBusy = true;
    try {
      const nowT = tariffNow().getTime();
      for (const it of this.scheduled()) {
        if (Date.parse(it.at) > nowT) continue;
        if (this.busyOn(it.repo)) continue;
        try {
          const runId = await this.start(it.repo, it.goal, it.plan, it.choice, { offPeakOnly: true });
          this.saveScheduled(this.scheduled().filter((x) => x.id !== it.id));
          this.emit({ type: 'toast', level: 'info', text: `Отложенный запуск начат в льготное время (${runId}): ${it.goal.slice(0, 80)}` } as any);
        } catch (e: any) {
          const list = this.scheduled().map((x) => (x.id === it.id ? { ...x, lastError: String(e?.message ?? e) } : x));
          if (JSON.stringify(list) !== JSON.stringify(this.scheduled())) this.saveScheduled(list);
        }
      }
    } finally {
      this.scheduleBusy = false;
    }
  }

  async resume(runId: string): Promise<string> {
    const live = this.controllers.get(runId);
    if (live?.state.status === 'running') throw new Error('Этот запуск уже идёт');
    const saved = this.runs.load(runId);
    if (saved.state.source !== 'app') throw new Error('Сессии MCP продолжаются из внешнего агента');
    const busy = this.busyOn(saved.state.repo);
    if (busy) throw new Error(`На этом репозитории уже идёт запуск ${busy.state.runId}`);
    const cfg = await this.readyConfig();
    await this.checkRepo(saved.state.repo);
    const emit = (ev: OrchEvent) => this.emit({ ...ev, runId });
    const c =
      (saved.state.orchestrator ?? 'api') === 'api'
        ? Orchestrator.resume(cfg, this.worktreeRoot, saved, emit, this.runs)
        : CliOrchestrator.resume(cfg, this.worktreeRoot, saved, emit, this.runs);
    return this.launch(c);
  }

  cancel(runId?: string) {
    const c = this.controllers.get(runId ?? this.currentId ?? '');
    c?.cancel();
    return !!c;
  }

  /** Live state if the run is in memory, else the saved one. */
  state(runId?: string | null): RunState | null {
    const id = runId ?? this.currentId;
    if (!id) return null;
    const live = this.controllers.get(id) ?? [...this.mcp.values()].find((m) => m.engine.state.runId === id)?.engine;
    if (live) return live.state;
    try {
      return this.runs.load(id).state;
    } catch {
      return null;
    }
  }

  report(days: number) {
    return buildReport(loadStates(path.join(this.home, 'runs')), days);
  }

  ledger() {
    return reconcile(readLedger(path.join(this.home, 'ledger.json')), loadStates(path.join(this.home, 'runs')));
  }

  /** Record a balance. Without a number, DeepSeek's balance is read from its API. */
  async snapshot(id: string, balance?: number, unitUsd?: number) {
    const file = path.join(this.home, 'ledger.json');
    if (balance === undefined) {
      const p = this.config().providers.find((x) => x.id === id);
      if (!p || p.preset !== 'deepseek') throw new Error('Баланс этого подключения вводится вручную');
      const b = await deepseekBalanceUsd(p.token, p.baseUrl);
      if (b === null) throw new Error('DeepSeek не отдал баланс в долларах');
      balance = b;
    }
    addSnapshot(file, id, balance, unitUsd);
    return this.ledger();
  }

  listRuns() {
    const list = this.runs.list();
    // Files are written with a short delay: overlay what's live in memory.
    for (const r of list) {
      const s = this.controllers.get(r.runId)?.state;
      if (s) r.status = s.status;
    }
    return list;
  }

  deleteRun(runId: string) {
    const s = this.state(runId);
    if (s?.status === 'running') throw new Error('Этот запуск ещё идёт');
    this.runs.delete(runId);
    this.controllers.delete(runId);
    if (this.currentId === runId) this.currentId = null;
  }

  /** Engine for manual merge/discard: the live one, or one rebuilt from the saved run. */
  private engineFor(runId: string): TaskEngine {
    const live = this.controllers.get(runId)?.engine ?? [...this.mcp.values()].find((m) => m.engine.state.runId === runId)?.engine;
    if (live) return live;
    const saved: SavedRun = this.runs.load(runId);
    return new TaskEngine(this.config(), this.worktreeRoot, saved.state, (ev) => {
      this.emit({ ...ev, runId });
      this.runs.saveSoon(runId, () => ({ ...saved, savedAt: Date.now() }));
    });
  }

  merge(runId: string, taskId: string) {
    return this.engineFor(runId).merge({ task_id: taskId });
  }

  discard(runId: string, taskId: string) {
    return this.engineFor(runId).discard({ task_id: taskId, force: true }); // a click in the panel is the owner's own decision
  }

  /**
   * «Открыть worktree»: show the task's folder in Finder (or the system file manager). Says why when it cannot:
   * the task is unknown, or the folder is gone (the task was discarded, or someone removed it).
   */
  async openWorktree(runId: string, taskId: string, allowOpen = true): Promise<{ opened: boolean; path?: string; message: string }> {
    const L = this.config().language;
    const t = this.state(runId)?.tasks.find((x) => x.id === taskId);
    if (!t) return { opened: false, message: pick(L, `Задача ${taskId} не найдена`, `Task ${taskId} not found`) };
    const wt = t.worktree;
    if (!wt || !fs.existsSync(wt)) {
      return {
        opened: false,
        path: wt,
        message: pick(
          L,
          `Рабочей папки больше нет: ${wt}. Так бывает, если задачу отбросили или папку удалили; правки могли остаться только в ветке ${t.branch}${t.status === 'discarded' ? ' (она тоже удалена при отбрасывании)' : ''}.`,
          `The working folder is gone: ${wt}. This happens when the task was discarded or the folder was deleted; the changes may only be left in the branch ${t.branch}${t.status === 'discarded' ? ' (it was deleted too when the task was discarded)' : ''}.`,
        ),
      };
    }
    if (!allowOpen) return { opened: false, path: wt, message: pick(L, `Папка на сервере: ${wt}`, `Folder on the server: ${wt}`) };
    const cmd = process.env.ORCHESTRA_OPEN_CMD || (process.platform === 'darwin' ? 'open' : 'xdg-open');
    await new Promise<void>((resolve) => execFile(cmd, [wt], () => resolve()));
    return { opened: true, path: wt, message: pick(L, `Открыл папку: ${wt}`, `Opened the folder: ${wt}`) };
  }

  worktreeOf(runId: string, taskId: string) {
    return this.state(runId)?.tasks.find((t) => t.id === taskId)?.worktree;
  }

  /** App quitting: keep runs resumable. */
  freezeAll() {
    for (const c of this.controllers.values()) if (c.state.status === 'running') c.freeze();
    for (const m of this.mcp.values()) m.engine.freeze();
    this.runs.flush();
  }

  // ---------- autopilot (MCP: one call for the whole task) ----------

  /** Recommend a planner; start right away if allowed, else wait for approve(). */
  async autopilot(
    repo: string,
    goal: string,
    opts: { planner?: string; approve?: 'ask' | 'auto'; when?: 'now' | 'offpeak' } = {},
  ): Promise<{ triage: Triage; runId?: string; scheduled?: Scheduled; pendingId?: string }> {
    if (!(await git.isRepo(repo))) throw new Error(`${repo} не git-репозиторий`);
    const t = await this.triage(goal);
    const auto = opts.approve === 'auto' || (opts.approve == null && this.config().plannerPick !== 'ask');
    const id = this.addPending(repo, goal, t, opts.when);
    if (opts.planner || auto) {
      const r = await this.approveEx(id, opts.planner ?? t.recommended);
      return { ...r, triage: t };
    }
    return { pendingId: id, triage: t };
  }

  private addPending(repo: string, goal: string, t: Triage, when?: 'now' | 'offpeak') {
    const id = `p-${Date.now().toString(36)}`;
    this.pending.set(id, { id, repo, goal, triage: t, createdAt: Date.now(), when } as any);
    return id;
  }

  /** approve() that may schedule instead of starting (autopilot with when = offpeak). */
  async approveEx(pendingId: string, choiceId?: string): Promise<{ runId?: string; scheduled?: Scheduled }> {
    const p: any = this.pending.get(pendingId);
    if (!p) throw new Error(`нет ожидающей задачи ${pendingId}`);
    if (p.when !== 'offpeak') return { runId: await this.approve(pendingId, choiceId) };
    const choice = choiceId ?? p.triage.recommended;
    const plan = await this.makePlan(p.repo, p.goal, choice);
    const scheduled = await this.schedule(p.repo, p.goal, plan, choice);
    this.pending.delete(pendingId);
    return { scheduled };
  }

  pendingList() {
    return [...this.pending.values()];
  }

  /** Approve (or change) the planner, make the plan with it, and start the run with it as orchestrator. */
  async approve(pendingId: string, choiceId?: string): Promise<string> {
    const p = this.pending.get(pendingId);
    if (!p) throw new Error(`нет ожидающей задачи ${pendingId}`);
    const choice = choiceId ?? p.triage.recommended;
    const plan = await this.makePlan(p.repo, p.goal, choice);
    const runId = await this.start(p.repo, p.goal, plan, choice);
    this.pending.delete(pendingId);
    return runId;
  }

  runReport(runId: string): string {
    const s = this.state(runId);
    if (!s) throw new Error(`нет запуска ${runId}`);
    const spent = (s.orchestratorCostUsd ?? 0) + s.tasks.reduce((a, t) => a + (t.costUsd ?? 0), 0);
    const tasks = s.tasks.map((t) => `- ${t.id} [${t.role ?? '-'} · ${t.providerId}] ${t.title}: ${t.status}${t.error ? ' (' + t.error + ')' : ''}`).join('\n');
    return [
      `run ${s.runId}: ${s.status}${s.stopReason ? ' — ' + s.stopReason : ''}`,
      `repo ${s.repo} (branch ${s.baseBranch}), orchestrator ${s.orchestrator ?? 'api'}, spent $${spent.toFixed(2)}`,
      tasks || '(no tasks yet)',
      s.finalReport ? `\nFinal report:\n${s.finalReport}` : '',
    ].join('\n');
  }

  // ---------- interactive MCP sessions (the external agent is the orchestrator) ----------

  async mcpSession(repo: string): Promise<TaskEngine> {
    const key = path.resolve(repo);
    const hit = this.mcp.get(key);
    if (hit && hit.engine.state.status === 'running') {
      hit.lastUsed = Date.now();
      return hit.engine;
    }
    if (!(await git.isRepo(key))) throw new Error(`${key} не git-репозиторий. Укажите ?repo=<путь> в адресе MCP-сервера.`);
    this.autoMemory(key);
    const restored = await this.restoreMcpSession(key);
    if (restored) return restored;
    const cfg = this.config();
    cfg.health = this.health;
    const state: RunState = {
      runId: `mcp-${Date.now().toString(36)}`,
      source: 'mcp',
      repo: key,
      baseBranch: await git.currentBranch(key),
      goal: 'MCP-сессия: оркестратор — внешний агент',
      status: 'running',
      tasks: [],
      transcript: [],
      budgetUsd: cfg.runBudgetUsd || 0,
      startedAt: Date.now(),
      pid: process.pid,
    };
    const runId = state.runId;
    const engine = new TaskEngine(cfg, this.worktreeRoot, state, (ev) => {
      this.emit({ ...ev, runId });
      if (state.tasks.length || state.transcript.length) this.runs.saveSoon(runId, () => ({ version: 1, state, messages: [], savedAt: Date.now() }));
    });
    this.mcp.set(key, { engine, lastUsed: Date.now() });
    this.emit({ type: 'state', state, runId }); // panels can follow the session live
    return engine;
  }

  /** After a service restart, the newest interrupted MCP session for this repo (if any) is restored. */
  private async restoreMcpSession(key: string): Promise<TaskEngine | null> {
    const cutoff = Date.now() - 24 * 3600_000;
    for (const r of this.runs.list()) {
      if (r.source !== 'mcp' || path.resolve(r.repo) !== key || !r.startedAt || r.startedAt < cutoff) continue;
      let saved: SavedRun;
      try {
        saved = this.runs.load(r.runId);
      } catch {
        continue;
      }
      const s = saved.state;
      const dead = s.status === 'interrupted' || (s.status === 'running' && s.pid != null && !pidAlive(s.pid));
      if (!dead) continue;
      if (!s.tasks.some((t) => t.status !== 'merged' && t.status !== 'discarded')) continue;
      return this.resumeMcpSession(s, key);
    }
    return null;
  }

  /** Reuse the saved session's state: mark it running, reconcile mid-flight tasks, and open it. */
  private async resumeMcpSession(s: RunState, key: string): Promise<TaskEngine> {
    const cfg = this.config();
    cfg.health = this.health;
    s.status = 'running';
    s.pid = process.pid;
    s.stopReason = undefined;
    s.finishedAt = undefined;
    const engine = new TaskEngine(cfg, this.worktreeRoot, s, (ev) => {
      this.emit({ ...ev, runId: s.runId });
      if (s.tasks.length || s.transcript.length) this.runs.saveSoon(s.runId, () => ({ version: 1, state: s, messages: [], savedAt: Date.now() }));
    });
    await engine.reconcileMcpRestart();
    engine.log('system', `Сессия восстановлена после перезапуска: ${s.tasks.map((t) => `${t.id} ${t.status}`).join(', ')}`);
    this.mcp.set(key, { engine, lastUsed: Date.now() });
    this.emit({ type: 'state', state: s, runId: s.runId });
    return engine;
  }

  /** Health and settings changes reach running MCP sessions too (their engine.cfg is a snapshot). */
  touchMcpHealth() {
    const cfg = this.config();
    cfg.health = this.health;
    for (const m of this.mcp.values()) m.engine.cfg = cfg;
  }

  endMcpSession(repo: string): string {
    const key = path.resolve(repo);
    const m = this.mcp.get(key);
    if (!m) return 'no open session';
    this.closeMcp(key, m);
    return `session ${m.engine.state.runId} closed`;
  }

  private closeMcp(key: string, m: McpSession) {
    const s = m.engine.state;
    const open = s.tasks.some((t) => t.status === 'queued' || t.status === 'running');
    if (open) m.engine.cancelAll();
    s.status = open ? 'interrupted' : 'done';
    s.finishedAt = Date.now();
    if (s.tasks.length) {
      this.runs.saveSoon(s.runId, () => ({ version: 1, state: s, messages: [], savedAt: Date.now() }), 0);
      this.runs.flush(s.runId);
    }
    this.mcp.delete(key);
    this.emit({ type: 'state', state: s, runId: s.runId });
  }

  private closeIdleMcp() {
    for (const [key, m] of this.mcp) {
      const busy = m.engine.state.tasks.some((t) => t.status === 'queued' || t.status === 'running');
      if (!busy && Date.now() - m.lastUsed > MCP_IDLE_MS) this.closeMcp(key, m);
    }
  }

  stop() {
    this.watchdog.stop();
    clearInterval(this.idleTimer);
    this.freezeAll();
  }
}

export type { PlannerChoice };
