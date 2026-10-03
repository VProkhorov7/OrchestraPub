import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { AppConfig, OrchEvent, Plan, RunState } from './types';
import { planToMessage, describeWorkers, describeRoles } from './planner';
import * as git from './git';
import { clip } from './worker';
import { TaskEngine, Emit } from './engine';
import { RunStore, SavedRun } from './runs';
import { startMcpHttp, McpHttpHost } from './mcphttp';
import { cliEnv } from './health';
import { memoryBriefing } from '../memory/prompt';
import { replyLang } from './lang';

const LIMIT = /usage limit|limit reached|hit your limit|rate limit|quota|exceeded/i;
/** Hard stop for workers' dollar budget: the subscription orchestrator gets 25% headroom to wrap up, as in API mode. */
const WRAP_UP_ALLOWANCE = 1.25;

/**
 * Orchestrator on a subscription: the app starts the official CLI (Claude Code `claude -p` or Codex `codex exec`)
 * with the Orchestra tools attached over MCP (HTTP on 127.0.0.1, bound to this run's TaskEngine).
 * The subscription pays for planning and review; no API key is involved. Workers, budgets, history, manual
 * merge/discard and the live UI are the same as with the API orchestrator.
 */
export class CliOrchestrator {
  state: RunState;
  engine: TaskEngine;
  private child?: ChildProcess;
  private host?: McpHttpHost;
  private resumed = false;
  private lastMessage = '';
  private budgetTimer?: NodeJS.Timeout;

  constructor(
    private cfg: AppConfig,
    worktreeRoot: string,
    repo: string,
    goal: string,
    private emitOut: Emit,
    plan?: Plan,
    private store?: RunStore,
    saved?: SavedRun,
  ) {
    const mode = cfg.orchestrator.mode === 'codex-sub' ? 'codex-sub' : 'claude-sub';
    if (saved) {
      this.state = saved.state;
      this.resumed = true;
    } else {
      this.state = {
        runId: `run-${Date.now().toString(36)}`,
        source: 'app',
        repo,
        baseBranch: '',
        goal,
        status: 'idle',
        tasks: [],
        transcript: [],
        plan,
        budgetUsd: cfg.runBudgetUsd || 0,
        orchestrator: mode,
      };
    }
    if (saved) this.state.budgetUsd = cfg.runBudgetUsd || 0;
    this.engine = new TaskEngine(cfg, worktreeRoot, this.state, (ev) => this.emit(ev));
  }

  static resume(cfg: AppConfig, worktreeRoot: string, saved: SavedRun, emit: Emit, store?: RunStore) {
    // Resume with the orchestrator the run was started with, whatever Settings say now.
    const mode = saved.state.orchestrator === 'codex-sub' ? 'codex-sub' : 'claude-sub';
    const c = { ...cfg, orchestrator: { ...cfg.orchestrator, mode } } as AppConfig;
    return new CliOrchestrator(c, worktreeRoot, saved.state.repo, saved.state.goal, emit, saved.state.plan, store, saved);
  }

  private get mode() {
    return this.state.orchestrator === 'codex-sub' ? 'codex-sub' : 'claude-sub';
  }

  private emit(ev: OrchEvent) {
    this.emitOut(ev);
    this.store?.saveSoon(this.state.runId, () => this.snapshot());
  }

  snapshot(): SavedRun {
    return { version: 1, state: this.state, messages: [], savedAt: Date.now() };
  }

  // ---------- public API (same as Orchestrator) ----------

  async start(): Promise<void> {
    const { repo } = this.state;
    if (!(await git.isRepo(repo))) throw new Error('Выбранная папка не является git-репозиторием');
    if (await git.isDirty(repo)) throw new Error('В репозитории есть незакоммиченные изменения. Закоммитьте или уберите их в stash.');
    const branch = await git.currentBranch(repo);
    if (this.resumed) {
      if (branch !== this.state.baseBranch)
        throw new Error(`Запуск шёл на ветке "${this.state.baseBranch}", а сейчас в репозитории "${branch}". Переключитесь обратно, чтобы продолжить.`);
    } else this.state.baseBranch = branch;

    this.state.status = 'running';
    this.state.stopReason = undefined;
    this.state.finishedAt = undefined;
    this.state.startedAt ??= Date.now();
    this.pushState();

    try {
      let note = '';
      if (this.resumed) {
        const notes = await this.engine.reconcileInterrupted();
        note = `The run was interrupted and has been resumed.\n${notes ? notes + '\n' : ''}Current tasks:\n${this.engine.status()}\nContinue from where you left off; do not redo merged work.`;
        this.engine.log('system', 'Запуск продолжен.' + (notes ? '\n' + notes : ''));
      }
      this.host = await startMcpHttp(this.engine, this.mode === 'codex-sub' ? 50 : 240);
      this.budgetTimer = setInterval(() => this.hardBudgetStop(), 2000);
      const code = await this.runCli(note);
      if (this.engine.cancelled) this.state.status = 'cancelled';
      else if ((this.state.status as string) === 'stopped') {
        /* set by hardBudgetStop */
      } else if (code !== 0) {
        const limit = LIMIT.test(this.lastMessage);
        this.state.status = limit ? 'stopped' : 'failed';
        this.state.stopReason = limit
          ? `лимит подписки исчерпан: ${clip(this.lastMessage, 200)}`
          : `${this.mode === 'codex-sub' ? 'codex' : 'claude'} завершился с кодом ${code}: ${clip(this.lastMessage, 300)}`;
        this.engine.log('error', this.state.stopReason);
      } else {
        this.state.status = 'done';
        this.state.finalReport = this.lastMessage;
        this.engine.log('system', 'FINAL REPORT\n' + this.lastMessage);
      }
    } catch (e: any) {
      this.state.status = this.engine.cancelled ? 'cancelled' : 'failed';
      this.state.stopReason = e?.message ?? String(e);
      this.engine.log('error', this.state.stopReason!);
    } finally {
      clearInterval(this.budgetTimer);
      // Tasks the orchestrator left running would have nobody to review them.
      if (this.state.tasks.some((t) => t.status === 'running' || t.status === 'queued')) this.engine.cancelAll();
      await this.host?.close().catch(() => {});
      this.state.finishedAt = Date.now();
      this.pushState();
      this.store?.flush(this.state.runId);
    }
  }

  cancel(): void {
    this.engine.cancelAll();
    this.child?.kill('SIGTERM');
    this.engine.log('system', 'Cancelled by user.');
  }

  /** App is quitting: keep the run resumable. */
  freeze(): void {
    this.engine.freeze();
    this.child?.kill('SIGTERM');
  }

  mergeTask(id: string) {
    return this.engine.merge({ task_id: id });
  }

  discardTask(id: string) {
    return this.engine.discard({ task_id: id });
  }

  // ---------- the CLI ----------

  private prompt(note: string): string {
    const plan = this.state.plan ? `\n\n${planToMessage(this.state.plan)}` : '';
    return `${note ? note + '\n\n' : ''}Goal:\n${this.state.goal}${plan}${memoryBriefing(this.state.repo, this.state.goal, 'orchestrator', this.cfg.language)}

You are the lead engineer of this run. Work ONLY through the "orchestra" MCP tools (list_workers, delegate, wait_for, get_diff, merge_task, discard_task, task_status):
- Do not edit, create or delete files yourself, and do not commit. Every code change is delegated to a worker.
- You may read files and run read-only commands and the project's tests (after merging) to decide what to delegate and whether a diff is good.
- Workers are weaker than you: write self-contained briefs (exact files, behaviour, acceptance criteria, test command, what not to touch). Prefer several small independent tasks and delegate them in the same turn so they run in parallel.
- Review every diff critically before merge_task. Discard junk or delegate a fix.
- Use the cheapest worker whose role fits; flat-price coding plans before pay-per-token; escalate only after a failure.
- wait_for returns early while workers are still running; call it again.
- When done, write the final report for the human in ${replyLang(this.cfg)} as your last message: what was merged, what was discarded and why, what is left.

Roles:
${describeRoles()}

Workers right now:
${describeWorkers(this.cfg)}
${this.cfg.orchestratorPreamble ? '\nProject-specific instructions:\n' + this.cfg.orchestratorPreamble : ''}`;
  }

  private runCli(note: string): Promise<number> {
    const env = cliEnv();
    let args: string[];
    let bin: string;
    let tmpCfg: string | undefined;
    const prompt = this.prompt(note);

    if (this.mode === 'claude-sub') {
      bin = this.cfg.claudePath;
      tmpCfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-mcp-')), 'mcp.json');
      fs.writeFileSync(
        tmpCfg,
        JSON.stringify({ mcpServers: { orchestra: { type: 'http', url: this.host!.url, headers: { Authorization: `Bearer ${this.host!.token}` } } } }),
        { mode: 0o600 },
      );
      args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--mcp-config', tmpCfg, '--strict-mcp-config'];
      args.push('--allowedTools', 'mcp__orchestra,Read,Grep,Glob,Bash', '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit');
      if (this.cfg.orchestrator.claudeModel) args.push('--model', this.cfg.orchestrator.claudeModel);
      if (this.resumed && this.state.cliSessionId) args.push('--resume', this.state.cliSessionId);
      env.MCP_TOOL_TIMEOUT = '900000';
    } else {
      bin = this.cfg.orchestrator.codexPath || 'codex';
      env.ORCHESTRA_MCP_TOKEN = this.host!.token;
      // codex exec auto-rejects MCP tool calls under any approval policy except the full bypass (openai/codex#24135),
      // so Codex runs unsandboxed here, like the workers do. The prompt forbids it to edit files itself.
      args = ['exec', '--json', '-C', this.state.repo, '--dangerously-bypass-approvals-and-sandbox'];
      args.push('-c', `mcp_servers.orchestra.url="${this.host!.url}"`);
      args.push('-c', 'mcp_servers.orchestra.bearer_token_env_var="ORCHESTRA_MCP_TOKEN"');
      args.push('-c', 'mcp_servers.orchestra.tool_timeout_sec=900');
      if (this.cfg.orchestrator.codexModel) args.push('-m', this.cfg.orchestrator.codexModel);
      if (this.resumed && this.state.cliSessionId) args.splice(1, 0, 'resume', this.state.cliSessionId);
      args.push(prompt);
    }

    this.engine.log('system', `Оркестратор: ${this.mode === 'codex-sub' ? 'Codex (подписка ChatGPT)' : 'Claude Code (подписка Claude)'}`);
    return new Promise((resolve) => {
      const child = spawn(bin, args, { cwd: this.state.repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let stderr = '';
      child.stderr!.on('data', (d) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });
      const rl = readline.createInterface({ input: child.stdout! });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        try {
          if (this.mode === 'claude-sub') this.onClaudeEvent(ev);
          else this.onCodexEvent(ev);
        } catch (e) {
          this.engine.log('system', `[parse] ${String(e)}`);
        }
      });
      child.on('error', (err) => {
        this.lastMessage = `не удалось запустить ${bin}: ${err.message}`;
        resolve(127);
      });
      child.on('close', (code) => {
        rl.close();
        if (tmpCfg) fs.rmSync(path.dirname(tmpCfg), { recursive: true, force: true });
        if (code !== 0 && !this.lastMessage) this.lastMessage = stderr.trim();
        resolve(code ?? 1);
      });
    });
  }

  private short(name: string) {
    return name.replace(/^mcp__orchestra__/, '');
  }

  private onClaudeEvent(ev: any) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      if (ev.session_id) this.state.cliSessionId = ev.session_id;
      const ok = (ev.mcp_servers ?? []).find((s: any) => s.name === 'orchestra');
      if (ok && ok.status !== 'connected') this.engine.log('error', `MCP-сервер Orchestra не подключился: ${ok.status}`);
      return;
    }
    if (ev.type === 'assistant') {
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) {
          this.lastMessage = b.text.trim();
          this.engine.log('assistant', this.lastMessage);
        } else if (b.type === 'tool_use') this.engine.log('tool_call', `${this.short(b.name)} ${clip(JSON.stringify(b.input ?? {}), 400)}`);
      }
      return;
    }
    if (ev.type === 'user') {
      for (const b of ev.message?.content ?? []) {
        if (b.type !== 'tool_result') continue;
        const c = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x: any) => x.text ?? '').join('\n');
        this.engine.log('tool_result', `→ ${clip(c, 600)}`);
      }
      return;
    }
    if (ev.type === 'result') {
      if (ev.result) this.lastMessage = String(ev.result);
      if (ev.total_cost_usd != null) this.state.apiEquivUsd = (this.state.apiEquivUsd ?? 0) + ev.total_cost_usd;
      if (ev.session_id) this.state.cliSessionId = ev.session_id;
      this.pushState();
    }
  }

  private onCodexEvent(ev: any) {
    if (ev.type === 'thread.started' && ev.thread_id) {
      this.state.cliSessionId = ev.thread_id;
      return;
    }
    if (ev.type === 'error' || ev.type === 'turn.failed') {
      this.lastMessage = String(ev.message ?? ev.error?.message ?? JSON.stringify(ev));
      this.engine.log('error', this.lastMessage);
      return;
    }
    const item = ev.item;
    if (!item) return;
    const kind = item.type ?? item.item_type;
    if (ev.type === 'item.started' && kind === 'mcp_tool_call') {
      this.engine.log('tool_call', `${item.tool ?? item.name} ${clip(JSON.stringify(item.arguments ?? {}), 400)}`);
      return;
    }
    if (ev.type !== 'item.completed') return;
    switch (kind) {
      case 'agent_message':
      case 'assistant_message':
        if (item.text?.trim()) {
          this.lastMessage = item.text.trim();
          this.engine.log('assistant', this.lastMessage);
        }
        break;
      case 'mcp_tool_call': {
        const res = item.result?.content?.map((c: any) => c.text ?? '').join('\n') ?? item.error?.message ?? item.status ?? '';
        this.engine.log('tool_result', `${item.tool ?? ''} → ${clip(String(res), 600)}`);
        break;
      }
      case 'command_execution':
        this.engine.log('tool_call', `$ ${clip(String(item.command ?? ''), 300)} (exit ${item.exit_code ?? '?'})`);
        break;
      case 'file_change':
        this.engine.log('error', 'Codex сам изменил файлы в репозитории, хотя должен был делегировать: проверьте git status.');
        break;
      default:
        break;
    }
  }

  private hardBudgetStop() {
    const b = this.engine.budget();
    if (!b || this.engine.budgetUsed() < WRAP_UP_ALLOWANCE || this.state.status !== 'running') return;
    this.state.status = 'stopped';
    this.state.stopReason = `бюджет $${b} превышен (${this.engine.spendReport()})`;
    this.engine.log('error', 'Остановлено: ' + this.state.stopReason);
    this.engine.cancelAll();
    this.child?.kill('SIGTERM');
  }

  private pushState() {
    this.emit({ type: 'state', state: this.state });
  }
}
