import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TaskEngine, isTerminal } from '../main/engine';
import { describeRoles, describeWorkers } from '../main/planner';
import { AppConfig, ROLES } from '../main/types';
import { ProjectMemory, checkManualLog } from '../memory/store';
import { freshDigest } from '../memory/summarize';
import { ensureMemory } from '../memory/setup';

export const ORCHESTRA_INSTRUCTIONS = (repo: string) =>
  `Orchestra runs cheap AI coding workers (headless Claude Code on DeepSeek / GLM / Kimi / Qwen endpoints, or on a subscription) in isolated git worktrees of ${repo}.
You are the lead engineer: plan, write self-contained briefs, delegate, review diffs, merge. Do not write the delegated code yourself.
Workflow: list_workers → delegate (several in one turn run in parallel) → wait_for → read the diff critically → merge_task or discard_task (or delegate a fix) → run the tests yourself after merging.
Workers see only the repository and your brief, and each other's work only after you merge. Tasks touching the same files conflict: serialize them.
Every delegate needs a role the worker allows. Workers marked UNAVAILABLE have no money or are not connected. Spend caps apply; tool results report what has been spent.
Failed or timed-out tasks are restarted by Orchestra itself, up to 3 times, on another suitable worker when there is one. A task shown as auto-retry→tNN has a successor: do not delegate it again, wait for tNN. A task marked NEEDS OWNER DECISION is out of retries: stop working on it and tell the owner, in the owner's language, what failed, what was tried and the options given, then wait for the answer.`;

export interface ToolContext {
  /** The run's engine, or a factory that opens one on first use (the daemon's per-repo sessions). */
  engine: TaskEngine | (() => Promise<TaskEngine>);
  repo: string;
  /** Called before every tool (e.g. to validate the repo lazily). */
  ready?: () => Promise<void>;
  /** Default wait_for timeout, seconds. */
  waitSec?: number;
}

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

/** The same seven tools for the stdio server (Claude Code / Codex as your own orchestrator) and the in-app HTTP server. */
export function registerOrchestraTools(server: McpServer, ctx: ToolContext): void {
  let engine!: TaskEngine;
  const getEngine = async () => (engine = typeof ctx.engine === 'function' ? await ctx.engine() : ctx.engine);
  const guard =
    <A>(fn: (a: A) => Promise<string> | string) =>
    async (a: A) => {
      try {
        await ctx.ready?.();
        await getEngine();
        return text(await fn(a));
      } catch (e: any) {
        return { ...text(`ERROR: ${e?.message ?? String(e)}`), isError: true };
      }
    };
  // registerTool's generic zod typing makes tsc crawl; register through a loosely typed helper instead.
  const tool = (name: string, config: { description: string; inputSchema: Record<string, unknown> }, handler: (a: any) => Promise<unknown>) =>
    (server.registerTool as any).call(server, name, config, handler);

  tool(
    'list_workers',
    { description: 'Workers you can delegate to (id, model, billing, allowed roles, notes, availability), roles, and spend so far.', inputSchema: {} },
    guard(() => `Roles:\n${describeRoles()}\n\nWorkers:\n${describeWorkers(engine.cfg)}\n\nRepository: ${ctx.repo} (branch ${engine.state.baseBranch})\n${engine.spendReport()}`),
  );

  tool(
    'delegate',
    {
      description:
        'Start a worker on a task in its own git worktree and branch. Returns a task id at once; the worker runs in the background. Call several times in one turn to run tasks in parallel.',
      inputSchema: {
        provider: z.string().describe('worker id from list_workers'),
        role: z.enum(ROLES.map((r) => r.id) as [string, ...string[]]).describe('task role; the worker must allow it'),
        title: z.string().describe('short title, used for the branch name and commit message'),
        spec: z
          .string()
          .describe('self-contained brief: context, exact files, required behaviour, acceptance criteria, the test command, what not to touch'),
        continue_from: z.string().optional().describe('task id of a stopped or failed task: the new worker starts from its branch and finishes the work instead of starting over'),
      },
    },
    guard((a: { provider: string; role: string; title: string; spec: string; continue_from?: string }) => {
      let r: string;
      try {
        r = engine.delegate({ ...a, continueFrom: a.continue_from });
      } catch (e: any) {
        engine.note('error', e?.message ?? String(e));
        throw e;
      }
      engine.note('tool_call', `Поручено ${a.provider} (${a.role}): «${a.title}»\n${a.spec.slice(0, 300)}`);
      return r;
    }),
  );

  const waitSec = ctx.waitSec ?? 540;
  tool(
    'wait_for',
    {
      description: `Wait for tasks to finish (all unfinished ones if task_ids is omitted) and return each task's worker summary, diff stat and diff. Returns early after timeout_sec (default ${waitSec}) with the status of tasks still running; call again to keep waiting.`,
      inputSchema: {
        task_ids: z.array(z.string()).optional(),
        timeout_sec: z.number().int().min(5).max(3600).optional(),
      },
    },
    guard(async (a: { task_ids?: string[]; timeout_sec?: number }) => {
      const r = await engine.wait(a.task_ids, (a.timeout_sec ?? waitSec) * 1000);
      for (const t of engine.state.tasks) {
        if (!isTerminal(t.status)) continue;
        engine.noteOnce(t.id, 'tool_result', `${t.id} «${t.title}» → ${t.status}, $${(t.costUsd ?? 0).toFixed(2)}\n${(t.result ?? '').slice(0, 200)}`);
      }
      return r;
    }),
  );

  tool(
    'task_status',
    { description: 'Status and cost of every task in this run, without waiting.', inputSchema: {} },
    guard(() => engine.status()),
  );

  tool(
    'get_diff',
    { description: 'Full diff of a task branch against its base (optionally for one file).', inputSchema: { task_id: z.string(), path: z.string().optional() } },
    guard((a: { task_id: string; path?: string }) => engine.getDiff(a)),
  );

  tool(
    'merge_task',
    {
      description: "Merge a finished task's branch into the repository's current branch (--no-ff). On conflict nothing is merged and the conflict is reported.",
      inputSchema: { task_id: z.string() },
    },
    guard(async (a: { task_id: string }) => {
      const t = engine.mustTask(a.task_id);
      const r = await engine.merge(a);
      engine.note('tool_call', `Слить ${t.id} «${t.title}»`);
      engine.note('tool_result', r.startsWith('merged') ? 'слито' : r);
      return r;
    }),
  );

  tool(
    'discard_task',
    { description: 'Stop a task if running and delete its branch and worktree.', inputSchema: { task_id: z.string(), reason: z.string().optional(), force: z.boolean().optional().describe('stop a task that is still showing activity') } },
    guard((a: { task_id: string; reason?: string; force?: boolean }) => {
      const t = engine.mustTask(a.task_id);
      const r = engine.discard(a);
      engine.note('tool_call', `Отбросить ${t.id} «${t.title}»${a.reason ? ': «' + a.reason + '»' : ''}`);
      return r;
    }),
  );
}

// ---------- project memory (facts, decisions, logs, wiki discipline) ----------

/**
 * Memory tools for any agent working in a repository with `.memory/` (created by `orchestra-memory init`).
 * The same data the CLI and the hooks use.
 */
export function registerMemoryTools(server: McpServer, repo: string, author = 'mcp-agent', summarizeCfg?: () => AppConfig): void {
  const mem = () => {
    ensureMemory(repo); // first use: the memory is created, no init needed
    if (!ProjectMemory.exists(repo)) throw new Error(`в ${repo} нет памяти проекта (автосоздание выключено: autoMemory, .orchestra-no-memory). Включить вручную: orchestra-memory init`);
    return new ProjectMemory(repo);
  };
  const guard = (fn: (a: any) => Promise<string> | string) => async (a: any) => {
    try {
      return text(await fn(a));
    } catch (e: any) {
      return { ...text(`ERROR: ${e?.message ?? String(e)}`), isError: true };
    }
  };
  const tool = (name: string, config: { description: string; inputSchema: Record<string, unknown> }, handler: (a: any) => Promise<unknown>) =>
    (server.registerTool as any).call(server, name, config, handler);

  tool(
    'memory_context',
    { description: 'BEFORE a task: known facts, decisions with their reasons, and earlier work related to the task, plus what the last session left to do.', inputSchema: { task: z.string() } },
    guard((a) => mem().context(a.task)),
  );
  tool('memory_search', { description: 'Search facts, decisions and the log.', inputSchema: { query: z.string(), limit: z.number().int().min(1).max(30).optional() } }, guard((a) => {
    const hits = mem().search(a.query, a.limit ?? 10);
    return hits.length ? hits.map((h) => `${h.kind} ${JSON.stringify(h.item)}`).join('\n') : 'nothing found';
  }));
  tool(
    'memory_add_fact',
    { description: 'Record an established fact (what is known / found / done). Use supersedes to replace an outdated fact.', inputSchema: { text: z.string(), tags: z.array(z.string()).optional(), files: z.array(z.string()).optional(), source: z.string().optional(), supersedes: z.string().optional() } },
    guard((a) => {
      const f = mem().addFact({ ...a, author });
      return `${f.id}: ${f.text}`;
    }),
  );
  tool(
    'memory_add_decision',
    {
      description: 'Record a decision and WHY it was made (alternatives rejected, consequences). Use supersedes to revise an earlier decision.',
      inputSchema: { title: z.string(), decision: z.string(), why: z.string(), alternatives: z.array(z.string()).optional(), consequences: z.string().optional(), facts: z.array(z.string()).optional(), files: z.array(z.string()).optional(), tags: z.array(z.string()).optional(), supersedes: z.string().optional() },
    },
    guard((a) => {
      const d = mem().addDecision({ ...a, author });
      return `${d.id}: ${d.title}`;
    }),
  );
  tool(
    'memory_log',
    { description: 'Add a detailed log event (feature, fix, change, security, test, deploy, docs, cleanup, note). `why` is required for feature, fix, change, security, deploy, cleanup, refactor, removed. A manual data cleanup that leaves the cause in place is `cleanup`, not `fix`.', inputSchema: { type: z.string(), description: z.string(), why: z.string().optional(), files: z.array(z.string()).optional(), details: z.any().optional() } },
    guard((a) => {
      checkManualLog(a.type, a.why);
      return mem().log({ type: a.type, description: a.description, why: a.why, files: a.files, details: a.details, author }).id;
    }),
  );
  tool(
    'memory_session_end',
    {
      description: 'Close the 30–40 minute micro-session: a short human summary (goes to the wiki journal) plus detailed JSON details for AI (goes to the log). Update the wiki before calling.',
      inputSchema: {
        summary: z.string().describe('2–3 plain sentences for the owner, in the language the owner uses (Russian by default)'),
        done: z.array(z.string()).optional(),
        why: z.string().optional(),
        gates: z.array(z.string()).max(3).optional().describe('at most 3 mandatory items before the next task, each closable by one command or one fact'),
        next: z.string().optional().describe('exactly one next task; everything else goes to wiki/status/current.md'),
        details: z.any().optional(),
      },
    },
    guard((a) => {
      const m = mem();
      if (!m.session()) m.sessionStart(author);
      const r = m.sessionEnd({ author, ...a, next: a.next ? [a.next] : [] });
      return `session closed ${r.event.id}${r.warnings.length ? '\nWARNING: ' + r.warnings.join('; ') : ''}`;
    }),
  );
  tool('memory_digest', { description: '«Дай свежую выжимку»: the latest log records to summarize for the owner.', inputSchema: { limit: z.number().int().min(5).max(300).optional(), since: z.string().optional() } }, guard((a) => mem().digest({ limit: a.limit ?? 60, since: a.since })));
  tool('changelog_draft', { description: 'Significant events since the last CHANGELOG update, grouped by Keep a Changelog section. Summarize them for people, then call changelog_write.', inputSchema: {} }, guard(() => {
    const c = mem().changelogCandidates();
    return Object.entries(c).map(([s, evs]) => `### ${s}\n` + evs.map((e) => `- ${e.description}`).join('\n')).join('\n\n') || 'nothing new';
  }));
  tool(
    'changelog_write',
    { description: 'Write the owner-facing summary into CHANGELOG.md under [Unreleased] (or a named stage). Main changes only, no small technical details.', inputSchema: { sections: z.record(z.array(z.string())).describe('{"Added": [...], "Fixed": [...], "Security": [...], ...}'), release: z.string().optional() } },
    guard((a) => {
      mem().writeChangelog(a.sections, a.release);
      return 'CHANGELOG.md updated';
    }),
  );
  if (summarizeCfg)
    tool('memory_fresh_digest', { description: 'A ready short Russian summary of recent work, made by the cheapest working model.', inputSchema: {} }, guard(async () => {
      const r = await freshDigest(summarizeCfg(), repo);
      return `${r.text}\n\n(${r.by})`;
    }));
}
