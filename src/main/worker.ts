import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import { AppConfig, ProviderConfig } from './types';
import { Usage, emptyUsage, addUsage } from './pricing';
import { syncWorkerHome } from './globalkit';
import { orchestraHome } from './paths';
import * as path from 'path';
import * as fs from 'fs';

export interface WorkerRunResult {
  ok: boolean;
  result: string;
  /** Cost as reported by Claude Code (computed with Anthropic prices). */
  reportedCostUsd?: number;
  usage: Usage;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

export interface WorkerHandle {
  child: ChildProcess;
  promise: Promise<WorkerRunResult>;
  kill: () => void;
}

/** Build the environment that points Claude Code at a third-party Anthropic-compatible endpoint. */
export function workerEnv(provider: ProviderConfig, cfg: AppConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Never leak the orchestrator's key or user session into a third-party worker.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CLAUDECODE; // allow nesting if launched from within Claude Code
  // Workers run in worktrees: the repo's memory hooks must not write there (the engine logs for them).
  env.ORCHESTRA_MEMORY_OFF = '1';
  // No keys to production: a worker must not be able to deploy, touch live data or push .
  // The prod guard hook refuses such commands for workers even when the owner allowed them in his own session.
  env.ORCHESTRA_WORKER = '1';
  for (const k of Object.keys(env)) {
    if (/^(CLOUDFLARE_|CF_API|WRANGLER_API|GH_TOKEN$|GITHUB_TOKEN$|NPM_TOKEN$|RESEND_|STRIPE_|AWS_|OPENAI_API_KEY$)/.test(k) || /(^|_)(SECRET|PASSWORD|PRIVATE_KEY)(_|$)/.test(k)) delete env[k];
  }
  // wrangler keeps its OAuth login in the user's config dir: point it to an empty one.
  const sandbox = path.join(orchestraHome(), 'worker-sandbox');
  fs.mkdirSync(sandbox, { recursive: true });
  env.XDG_CONFIG_HOME = sandbox;
  env.WRANGLER_SEND_METRICS = 'false';

  const small = provider.smallModel || provider.model;
  if (provider.kind === 'claude-sub') {
    // The official CLI with the user's own Claude login: no key, no base URL, the subscription pays.
    if (provider.model) env.ANTHROPIC_MODEL = provider.model;
  } else if (provider.baseUrl) {
    // A separate Claude Code home per third-party provider: its sessions stay out of ~/.claude,
    // so they don't show up in `claude --resume` and don't pollute subscription stats (CodexBar etc.).
    const home = path.join(orchestraHome(), 'worker-home', provider.id.replace(/[^\w.-]/g, '_'));
    fs.mkdirSync(home, { recursive: true });
    // The owner's RTK hook lives in ~/.claude, which this separate config dir would skip.
    try {
      syncWorkerHome(home);
    } catch {
      /* rtk is an optimisation, never a reason to fail a worker */
    }
    env.CLAUDE_CONFIG_DIR = home;
    env.ANTHROPIC_BASE_URL = provider.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = provider.token || (provider.local ? 'local' : '');
    env.ANTHROPIC_MODEL = provider.model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = provider.model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = provider.model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = small;
    env.CLAUDE_CODE_SUBAGENT_MODEL = small;
    // Third-party endpoints don't have Anthropic's telemetry/attribution features.
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  } else {
    env.ANTHROPIC_API_KEY = provider.token || cfg.anthropic.apiKey;
    env.ANTHROPIC_MODEL = provider.model;
  }
  Object.assign(env, provider.extraEnv ?? {});
  return env;
}

/**
 * Run Claude Code headlessly in `cwd` with `prompt`, streaming a human-readable log through `onLog`.
 * Uses `--output-format stream-json` so we can watch tool calls as they happen.
 */
export function runWorker(opts: {
  cfg: AppConfig;
  provider: ProviderConfig;
  cwd: string;
  prompt: string;
  onLog: (line: string) => void;
  /** Called with cumulative token usage whenever it changes. */
  onUsage?: (u: Usage, estimated?: boolean) => void;
}): WorkerHandle {
  const { cfg, provider, cwd, prompt, onLog, onUsage } = opts;
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (provider.model) args.push('--model', provider.model);
  if (cfg.skipPermissions) args.push('--dangerously-skip-permissions');
  else args.push('--permission-mode', 'acceptEdits');

  const child = spawn(cfg.claudePath, args, {
    cwd,
    env: workerEnv(provider, cfg),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let timedOut = false;
  let finalResult = '';
  let costUsd: number | undefined;
  let usage = emptyUsage();
  // stream-json repeats the same API message (with the same usage) once per content block.
  const seenMessages = new Set<string>();
  let stderrBuf = '';
  // Some providers (z.ai GLM) send token usage only in the final result. Until then the usage is estimated from what
  // streams by, so a working task does not look idle and spend caps still see it. The final usage replaces the estimate.
  const est = { turns: 0, ctxChars: 0, inTok: 0, outTok: 0 };
  const BASE_CTX_TOKENS = 12_000; // Claude Code's own system prompt and tools, sent with every turn
  const reported = () => usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
  const estimateTurn = (chars: number) => {
    est.turns++;
    est.ctxChars += chars;
    est.outTok += Math.max(20, chars / 3.5);
    est.inTok += BASE_CTX_TOKENS + est.ctxChars / 3.5;
    onUsage?.({ input: Math.round(est.inTok), output: Math.round(est.outTok), cacheRead: 0, cacheWrite: 0 }, true);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }, (provider.timeoutMin || cfg.workerTimeoutMin) * 60_000);

  child.stderr!.on('data', (d) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 20_000) stderrBuf = stderrBuf.slice(-20_000);
  });

  const rl = readline.createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      onLog(line);
      return;
    }
    try {
      switch (ev.type) {
        case 'system':
          if (ev.subtype === 'init') onLog(`[init] model=${ev.model ?? provider.model} cwd=${cwd}`);
          break;
        case 'assistant': {
          const mid = ev.message?.id;
          const u = ev.message?.usage;
          const hasUsage = !!u && (u.input_tokens || u.output_tokens || u.cache_read_input_tokens || u.cache_creation_input_tokens);
          if (!hasUsage && !reported() && (!mid || !seenMessages.has(mid))) {
            if (mid) seenMessages.add(mid);
            const chars = (ev.message?.content ?? []).reduce((n: number, b: any) => n + (b.text?.length ?? 0) + (b.type === 'tool_use' ? JSON.stringify(b.input ?? {}).length : 0), 0);
            estimateTurn(chars);
          }
          if (hasUsage && (!mid || !seenMessages.has(mid))) {
            if (mid) seenMessages.add(mid);
            addUsage(usage, ev.message.usage);
            onUsage?.(usage);
          }
          const blocks = ev.message?.content ?? [];
          for (const b of blocks) {
            if (b.type === 'text' && b.text?.trim()) onLog(b.text.trim());
            else if (b.type === 'tool_use') onLog(`> ${b.name} ${summarizeInput(b.input)}`);
          }
          break;
        }
        case 'user': {
          const blocks = ev.message?.content ?? [];
          if (!reported()) for (const b of blocks) if (b.type === 'tool_result') est.ctxChars += String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')).length;
          for (const b of blocks) {
            if (b.type === 'tool_result' && b.is_error) {
              onLog(`  ! ${clip(String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)), 300)}`);
            }
          }
          break;
        }
        case 'result':
          finalResult = ev.result ?? finalResult;
          costUsd = ev.total_cost_usd ?? ev.cost_usd;
          // The final usage is authoritative (covers messages we may have missed).
          if (ev.usage) {
            const fin = addUsage(emptyUsage(), ev.usage);
            const tot = (x: Usage) => x.input + x.output + x.cacheRead + x.cacheWrite;
            if (tot(fin) >= tot(usage)) usage = fin;
            onUsage?.(usage);
          }
          if (ev.is_error) onLog(`[result:error] ${clip(finalResult, 500)}`);
          else onLog(`[result] ${clip(finalResult, 500)}`);
          break;
        default:
          break;
      }
    } catch (e) {
      onLog(`[parse] ${String(e)}`);
    }
  });

  const promise = new Promise<WorkerRunResult>((resolve) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, result: '', usage, exitCode: null, timedOut, error: `spawn failed: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      rl.close();
      const ok = code === 0 && !timedOut;
      resolve({
        ok,
        result: finalResult || (ok ? '' : stderrBuf.trim()),
        reportedCostUsd: costUsd,
        usage,
        exitCode: code,
        timedOut,
        error: ok ? undefined : timedOut ? 'worker timed out' : `exit ${code}: ${clip(stderrBuf.trim(), 800)}`,
      });
    });
  });

  return {
    child,
    promise,
    kill: () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    },
  };
}

function summarizeInput(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const keys = ['file_path', 'path', 'command', 'pattern', 'description', 'prompt'];
  for (const k of keys) if (typeof input[k] === 'string') return clip(input[k].replace(/\s+/g, ' '), 120);
  return clip(JSON.stringify(input), 120);
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
