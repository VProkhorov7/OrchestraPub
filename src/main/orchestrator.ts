import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, OrchEvent, Plan, RunState, ROLES } from './types';
import { planToMessage } from './planner';
import * as git from './git';
import { clip } from './worker';
import { orchestratorSystemPrompt } from './prompts';
import { TaskEngine, Emit } from './engine';
import { RunStore, SavedRun } from './runs';
import { addUsage, claudeCost, emptyUsage } from './pricing';
import { anthropicKey } from './config';
import { memoryBriefing } from '../memory/prompt';
import { ProjectMemory } from '../memory/store';

export { isTerminal } from './engine';
export { priceFor } from './pricing';

const MAX_TOOL_OUTPUT = 30_000;
const MAX_TURNS = 80;
/** The orchestrator may overshoot the budget by this much to wrap up (merge, finish) before a hard stop. */
const WRAP_UP_ALLOWANCE = 1.25;

/**
 * The app's own orchestrator: a Claude tool-use loop driving a TaskEngine.
 * The conversation is kept in `messages` and persisted with the run, so an interrupted run can continue.
 */
export class Orchestrator {
  state: RunState;
  engine: TaskEngine;
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  private resumed = false;
  private warned80 = false;
  private warned100 = false;

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
    this.client = new Anthropic({ apiKey: anthropicKey(cfg), maxRetries: 6 });
    if (saved) {
      this.state = saved.state;
      this.messages = saved.messages as Anthropic.MessageParam[];
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
        orchestrator: 'api',
      };
    }
    // Budget comes from current settings when resuming, so the user can raise it before continuing.
    if (saved) this.state.budgetUsd = cfg.runBudgetUsd || 0;
    this.engine = new TaskEngine(cfg, worktreeRoot, this.state, (ev) => this.emit(ev));
  }

  static resume(cfg: AppConfig, worktreeRoot: string, saved: SavedRun, emit: Emit, store?: RunStore) {
    return new Orchestrator(cfg, worktreeRoot, saved.state.repo, saved.state.goal, emit, saved.state.plan, store, saved);
  }

  private emit(ev: OrchEvent) {
    this.emitOut(ev);
    this.store?.saveSoon(this.state.runId, () => this.snapshot());
  }

  snapshot(): SavedRun {
    return { version: 1, state: this.state, messages: this.messages, savedAt: Date.now() };
  }

  // ---------- public API ----------

  async start(): Promise<void> {
    const { repo } = this.state;
    if (!(await git.isRepo(repo))) throw new Error('Selected folder is not a git repository');
    if (await git.isDirty(repo)) throw new Error('Repository has uncommitted changes. Commit or stash them first.');
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
      if (this.resumed) await this.prepareResume();
      await this.loop();
      if (this.state.status === 'running') this.state.status = 'done';
    } catch (e: any) {
      if (this.engine.cancelled) this.state.status = 'cancelled';
      else if ((this.state.status as string) !== 'stopped') {
        this.state.status = 'failed';
        this.state.stopReason = e?.message ?? String(e);
        this.engine.log('error', this.state.stopReason!);
      }
    } finally {
      this.state.finishedAt = Date.now();
      this.pushState();
      this.store?.flush(this.state.runId);
    }
  }

  cancel(): void {
    this.engine.cancelAll();
    this.engine.log('system', 'Cancelled by user.');
  }

  /** App is quitting: keep the run resumable. */
  freeze(): void {
    this.engine.freeze();
  }

  /** Manual merge from the UI. */
  mergeTask(id: string): Promise<string> {
    return this.engine.merge({ task_id: id });
  }

  discardTask(id: string): Promise<string> {
    return this.engine.discard({ task_id: id });
  }

  // ---------- resume ----------

  private async prepareResume() {
    const notes = await this.engine.reconcileInterrupted();
    const text =
      `The run was interrupted (the app was closed) and has now been resumed by the human.\n` +
      (notes ? `What happened to unfinished tasks:\n${notes}\n` : '') +
      `Current tasks:\n${this.engine.status()}\n` +
      `Continue from where you left off. Do not redo merged work.`;
    this.engine.log('system', 'Запуск продолжен.' + (notes ? '\n' + notes : ''));

    const last = this.messages[this.messages.length - 1];
    if (!last) return; // interrupted before the first call: loop() starts from scratch
    if (last.role === 'assistant') {
      // The tool calls of the last turn never got answers: answer them, then add the note.
      const uses = (Array.isArray(last.content) ? last.content : []).filter((b: any) => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
      const content: Anthropic.ContentBlockParam[] = uses.map((u) => ({
        type: 'tool_result' as const,
        tool_use_id: u.id,
        content: 'interrupted: the app was closed before this call completed',
        is_error: true,
      }));
      content.push({ type: 'text', text });
      this.messages.push({ role: 'user', content });
    } else {
      const content = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : [...last.content];
      content.push({ type: 'text', text });
      last.content = content;
    }
  }

  // ---------- orchestrator loop ----------

  private tools(): Anthropic.Tool[] {
    const memory: Anthropic.Tool[] = ProjectMemory.exists(this.state.repo)
      ? [
          { name: 'memory_search', description: 'Search project memory: facts, decisions (with reasons) and earlier work.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
          {
            name: 'memory_add_fact',
            description: 'Record an established fact about the project (what is known, found or done).',
            input_schema: { type: 'object', properties: { text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } }, supersedes: { type: 'string' } }, required: ['text'] },
          },
          {
            name: 'memory_add_decision',
            description: 'Record a decision and WHY it was made, with rejected alternatives.',
            input_schema: {
              type: 'object',
              properties: { title: { type: 'string' }, decision: { type: 'string' }, why: { type: 'string' }, alternatives: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } }, supersedes: { type: 'string' } },
              required: ['title', 'decision', 'why'],
            },
          },
        ]
      : [];
    return [
      ...memory,
      {
        name: 'list_files',
        description: 'List tracked files in the repository (optionally under a subdirectory).',
        input_schema: { type: 'object', properties: { subdir: { type: 'string' } } },
      },
      {
        name: 'read_file',
        description: 'Read a file from the repository (current branch, not a worker branch). Large files are truncated.',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      {
        name: 'run_command',
        description: 'Run a shell command in the repository root (e.g. tests, linters, grep). 5 minute limit. Output truncated.',
        input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
      {
        name: 'delegate',
        description:
          'Start a worker on a task in its own worktree/branch. Returns immediately with a task_id; use wait_for to get the result. Call several times in one turn to run tasks in parallel.',
        input_schema: {
          type: 'object',
          properties: {
            provider: { type: 'string', description: 'Worker provider id' },
            role: { type: 'string', enum: ROLES.map((r) => r.id), description: 'Task role; the worker must allow it' },
            title: { type: 'string', description: 'Short title (used as branch name and commit subject)' },
            spec: {
              type: 'string',
              description:
                'Full brief for the worker: context, exact files, required behavior, acceptance criteria, test command, what not to touch.',
            },
          },
          required: ['provider', 'role', 'title', 'spec'],
        },
      },
      {
        name: 'wait_for',
        description: "Block until the given tasks (or all running tasks if omitted) finish. Returns each task's summary, diff stat and diff.",
        input_schema: { type: 'object', properties: { task_ids: { type: 'array', items: { type: 'string' } } } },
      },
      {
        name: 'get_diff',
        description: 'Return the full diff of a finished task again (e.g. after truncation, or a specific file).',
        input_schema: {
          type: 'object',
          properties: { task_id: { type: 'string' }, path: { type: 'string', description: 'optional file filter' } },
          required: ['task_id'],
        },
      },
      {
        name: 'merge_task',
        description: 'Merge a finished task branch into the base branch. Reports conflicts instead of merging.',
        input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
      },
      {
        name: 'discard_task',
        description: 'Throw away a task branch and its worktree.',
        input_schema: { type: 'object', properties: { task_id: { type: 'string' }, reason: { type: 'string' }, force: { type: 'boolean', description: 'stop a task that is still showing activity' } }, required: ['task_id'] },
      },
      {
        name: 'finish',
        description: 'End the run with a final report for the human.',
        input_schema: { type: 'object', properties: { report: { type: 'string' } }, required: ['report'] },
      },
    ];
  }

  /**
   * Prompt caching: the system prompt and the whole conversation up to the latest message are cached,
   * so each turn pays full price only for what's new. Breakpoints are added to a copy, not stored.
   */
  private request(system: string): Anthropic.MessageCreateParamsNonStreaming {
    const msgs = this.messages.map((m, i) => {
      if (i !== this.messages.length - 1) return m;
      const content = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content.map((b) => ({ ...b }));
      const lastBlock = content[content.length - 1] as any;
      if (lastBlock) lastBlock.cache_control = { type: 'ephemeral' };
      return { ...m, content } as Anthropic.MessageParam;
    });
    return {
      model: this.cfg.anthropic.model,
      max_tokens: this.cfg.anthropic.maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: this.tools(),
      messages: msgs,
    };
  }

  private async loop(): Promise<void> {
    const tree = clip(await git.listFiles(this.state.repo), 6000);
    const system = orchestratorSystemPrompt(this.cfg, this.state.repo, this.state.baseBranch, tree);
    if (!this.messages.length) {
      const first =
        `Goal:\n${this.state.goal}` +
        (this.state.plan ? `\n\n${planToMessage(this.state.plan)}` : '') +
        memoryBriefing(this.state.repo, this.state.goal, 'orchestrator', this.cfg.language);
      this.messages.push({ role: 'user', content: first });
    }

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (this.engine.cancelled) throw new Error('cancelled');
      if (this.hardBudgetStop()) return;

      const res = await this.client.messages.create(this.request(system));
      this.trackCost(res.usage);
      this.messages.push({ role: 'assistant', content: res.content });
      this.snapshotNow();

      const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      for (const b of res.content) if (b.type === 'text' && b.text.trim()) this.engine.log('assistant', b.text.trim());

      if (res.stop_reason !== 'tool_use' || toolUses.length === 0) {
        this.engine.log('system', 'Orchestrator stopped without calling finish.');
        return;
      }

      let finished = false;
      const results = await Promise.all(
        toolUses.map(async (tu): Promise<Anthropic.ToolResultBlockParam> => {
          this.engine.log('tool_call', `${tu.name} ${clip(JSON.stringify(tu.input), 400)}`);
          let out: string;
          let isError = false;
          try {
            out = await this.dispatch(tu.name, tu.input as any);
            if (tu.name === 'finish') finished = true;
          } catch (e: any) {
            out = `ERROR: ${e?.message ?? String(e)}`;
            isError = true;
          }
          this.engine.log('tool_result', `${tu.name} → ${clip(out, 600)}`);
          return { type: 'tool_result', tool_use_id: tu.id, content: clip(out, MAX_TOOL_OUTPUT), ...(isError ? { is_error: true } : {}) };
        }),
      );
      const content: Anthropic.ContentBlockParam[] = [...results];
      const note = this.budgetNote();
      if (note) content.push({ type: 'text', text: note });
      this.messages.push({ role: 'user', content });
      this.snapshotNow();
      if (finished) return;
    }
    this.engine.log('system', `Stopped after ${MAX_TURNS} turns.`);
  }

  /** Budget warnings for the orchestrator, injected once each at 80% and 100%. */
  private budgetNote(): string | undefined {
    const b = this.engine.budget();
    if (!b) return;
    const used = this.engine.budgetUsed();
    if (used >= 1 && !this.warned100) {
      this.warned100 = this.warned80 = true;
      return `BUDGET EXHAUSTED: ${this.engine.spendReport()}. Running workers were stopped. Do not delegate anything else. Review what finished, merge what is good, discard the rest, then call finish and say in the report what is left undone.`;
    }
    if (used >= 0.8 && !this.warned80) {
      this.warned80 = true;
      return `Budget warning: ${this.engine.spendReport()} (${Math.round(used * 100)}%). Prioritise: only delegate what is essential for the goal, prefer cheaper workers, and plan to finish soon.`;
    }
  }

  private hardBudgetStop(): boolean {
    const b = this.engine.budget();
    if (!b || this.engine.budgetUsed() < WRAP_UP_ALLOWANCE) return false;
    this.engine.cancelAll();
    this.state.status = 'stopped';
    this.state.stopReason = `бюджет $${b} превышен (${this.engine.spendReport()}); оркестратор не успел завершить`;
    this.engine.log('error', 'Остановлено: ' + this.state.stopReason);
    return true;
  }

  private async dispatch(name: string, input: any): Promise<string> {
    switch (name) {
      case 'list_files':
        return git.listFiles(this.state.repo, input.subdir || '.');
      case 'read_file':
        return clip(fs.readFileSync(this.safePath(input.path), 'utf8'), MAX_TOOL_OUTPUT);
      case 'run_command': {
        const r = await git.run('bash', ['-lc', String(input.command)], this.state.repo, { timeoutMs: 300_000 });
        return `exit ${r.code}\n${r.stdout}${r.stderr ? '\n[stderr]\n' + r.stderr : ''}`;
      }
      case 'delegate':
        return this.engine.delegate(input);
      case 'wait_for':
        return this.engine.wait(input.task_ids);
      case 'get_diff':
        return this.engine.getDiff(input);
      case 'merge_task':
        return this.engine.merge(input);
      case 'discard_task':
        return this.engine.discard(input);
      case 'memory_search': {
        const hits = new ProjectMemory(this.state.repo).search(String(input.query ?? ''), 10);
        return hits.length ? hits.map((h) => `${h.kind} ${JSON.stringify(h.item)}`).join('\n') : 'nothing found';
      }
      case 'memory_add_fact':
        return new ProjectMemory(this.state.repo).addFact({ ...input, author: 'orchestra' }).id;
      case 'memory_add_decision':
        return new ProjectMemory(this.state.repo).addDecision({ ...input, author: 'orchestra' }).id;
      case 'finish':
        this.state.finalReport = String(input.report ?? '');
        this.engine.log('system', 'FINAL REPORT\n' + this.state.finalReport);
        return 'ok';
      default:
        return `unknown tool ${name}`;
    }
  }

  // ---------- helpers ----------

  private safePath(p: string): string {
    const root = path.resolve(this.state.repo);
    const abs = path.resolve(root, p);
    if (!abs.startsWith(root + path.sep) && abs !== root) throw new Error('path escapes repository');
    return abs;
  }

  private pushState() {
    this.emit({ type: 'state', state: this.state });
  }

  private snapshotNow() {
    this.store?.saveSoon(this.state.runId, () => this.snapshot());
  }

  private trackCost(usage: Anthropic.Usage | undefined) {
    if (!usage) return;
    this.state.orchestratorCostUsd = (this.state.orchestratorCostUsd ?? 0) + claudeCost(this.cfg.anthropic.model, addUsage(emptyUsage(), usage));
    this.engine.checkBudgets();
  }
}
