#!/usr/bin/env node
/**
 * Orchestra as an MCP server.
 *
 * Lets an external agent — Claude Code or Codex running on your subscription — be the orchestrator,
 * while the cheap workers (DeepSeek / GLM / Qwen as headless Claude Code) run exactly as in the app:
 * each task in its own git worktree, with the same roles, prices and spend caps from the app's Settings.
 *
 *   claude mcp add orchestra -- node /path/to/orchestra/dist/mcp/server.js
 *   codex mcp add orchestra -- node /path/to/orchestra/dist/mcp/server.js
 *
 * Options: --repo <dir> (default: current directory), --budget <usd> (default: from Settings).
 * Env: ORCHESTRA_HOME to point at a different config folder.
 */
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigStore } from '../main/config';
import { TaskEngine } from '../main/engine';
import { RunStore } from '../main/runs';
import { orchestraHome } from '../main/paths';
import { RunState } from '../main/types';
import { registerOrchestraTools, registerMemoryTools, ORCHESTRA_INSTRUCTIONS } from './tools';
import * as git from '../main/git';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const home = orchestraHome();
const cfg = new ConfigStore(path.join(home, 'config.json')).load();
// Health lights are checked by the app; the stdio server trusts the config and lets delegate report errors.
const runs = new RunStore(path.join(home, 'runs'));
const repo = path.resolve(arg('repo') ?? process.env.ORCHESTRA_REPO ?? process.cwd());
const budget = arg('budget') != null ? Number(arg('budget')) : cfg.runBudgetUsd || 0;

// stdout belongs to the MCP protocol; everything human-readable goes to stderr.
const say = (s: string) => process.stderr.write(`[orchestra] ${s}\n`);

const state: RunState = {
  runId: `mcp-${Date.now().toString(36)}`,
  source: 'mcp',
  repo,
  baseBranch: '',
  goal: 'MCP-сессия (оркестратор — внешний агент)',
  status: 'running',
  tasks: [],
  transcript: [],
  budgetUsd: budget,
  startedAt: Date.now(),
  pid: process.pid,
};
// Sessions that never delegated anything are not worth a history entry.
const save = () => {
  if (state.tasks.length) runs.saveSoon(state.runId, () => ({ version: 1, state, messages: [], savedAt: Date.now() }));
};
const engine = new TaskEngine(cfg, path.join(home, 'worktrees'), state, (ev) => {
  if (ev.type === 'transcript') say(ev.entry.text.split('\n')[0]);
  save();
});

let ready: Promise<void> | null = null;
/** Validate the repo lazily, on the first call that needs it, so a bad cwd gives a readable tool error. */
function ensureRepo(): Promise<void> {
  ready ??= (async () => {
    if (!(await git.isRepo(repo))) throw new Error(`${repo} is not a git repository. Start the MCP server with --repo <dir>.`);
    state.baseBranch = await git.currentBranch(repo);
    save();
  })();
  return ready.catch((e) => {
    ready = null;
    throw e;
  });
}

const server = new McpServer({ name: 'orchestra', version: '0.7.5' }, { instructions: ORCHESTRA_INSTRUCTIONS(repo) });
registerOrchestraTools(server, { engine, repo, home, ready: ensureRepo });
registerMemoryTools(server, repo, process.env.ORCHESTRA_AUTHOR || 'mcp-agent', () => cfg);

function shutdown(code = 0) {
  if (state.status === 'running') {
    const open = state.tasks.filter((t) => t.status === 'queued' || t.status === 'running').length;
    engine.cancelAll();
    state.status = open ? 'interrupted' : 'done';
    state.finishedAt = Date.now();
  }
  save();
  runs.flush();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.stdin.on('close', () => shutdown(0));

(async () => {
  await server.connect(new StdioServerTransport());
  say(`ready: repo ${repo}, budget ${budget ? '$' + budget : 'none'}, config ${home}`);
})().catch((e) => {
  say(String(e?.stack ?? e));
  process.exit(1);
});
