// Shared types for main process, preload and renderer (renderer uses them informally).

/**
 * How a connection is reached:
 *  - api: Anthropic-compatible HTTP endpoint with a key (pay per token, or a coding-plan key)
 *  - claude-sub: the official `claude` CLI logged in with a Claude Pro/Max subscription
 *  - codex-sub: the official `codex` CLI logged in with a ChatGPT plan (orchestrator only)
 */
export type ProviderKind = 'api' | 'claude-sub' | 'codex-sub';
/** What a unit of work costs: dollars per token, credits of a flat coding plan, or % of a subscription limit. */
export type Billing = 'api' | 'plan' | 'subscription';

export interface ProviderConfig {
  /** Short id used by the orchestrator when delegating, e.g. "glm", "deepseek", "qwen", "anthropic". */
  id: string;
  kind?: ProviderKind;
  billing?: Billing;
  /** Catalog entry this connection was created from. */
  preset?: string;
  /** Human-readable name shown in UI and to the orchestrator. */
  label: string;
  /** Anthropic-compatible base URL. Empty for native Anthropic (uses the orchestrator API key). */
  baseUrl: string;
  /** API key / auth token for that provider. */
  token: string;
  /** Model name that will be set as ANTHROPIC_MODEL for the worker. */
  model: string;
  /** Optional cheaper model used for Claude Code's Haiku/subagent slots. Defaults to `model`. */
  smallModel?: string;
  /** Free-text hint for the orchestrator: what this worker is good at, cost, caveats. */
  notes: string;
  /** Whether the orchestrator may pick this provider. */
  enabled: boolean;
  /** Role ids this worker is allowed to take (see ROLES). Empty = any role. */
  roles: string[];
  /** Extra environment variables passed to the worker process. */
  extraEnv?: Record<string, string>;
  /** USD per 1M tokens, for spend tracking of third-party workers. Empty = use what Claude Code reports. */
  priceIn?: number;
  priceOut?: number;
  priceCacheRead?: number;
  /** Spend cap for this worker within one run, USD. 0/empty = no cap. */
  maxUsdPerRun?: number;
  /** Time-of-day tariff: prices above are peak prices, off-peak ones are cheaper (tariff.ts). */
  peak?: import('./tariff').PeakRule;
}

export type OrchestratorMode = 'api' | 'claude-sub' | 'codex-sub';

export interface AppConfig {
  /** How many times a failed task is restarted automatically (on another worker when there is one) before the owner is asked. 0 = never. */
  autoRetry?: number;
  /** Watchdogs and notifications: what is watched and where problems are reported (see alerts.ts, watchdog.ts). */
  notify?: {
    /** macOS notification centre. */
    macos?: boolean;
    /** Lowest level that raises a macOS notification. */
    macosLevel?: 'warn' | 'error';
    /** A worker that shows no activity for this many minutes is reported. */
    silentMinutes?: number;
    /** Optional URL that receives every alert as a plain-text POST (works with ntfy.sh and similar). */
    webhook?: string;
  };
  /** Interface and report language (the panel's RU/EN switch): models write plans and reports in it. Default ru. */
  language?: 'ru' | 'en';
  /** Who plans and reviews: Claude via API key, or Claude Code / Codex on a subscription (through MCP). */
  orchestrator: {
    mode: OrchestratorMode;
    /** Model for Claude Code when mode = claude-sub ('' = the CLI's default, or 'opus' / 'sonnet' / a full id). */
    claudeModel: string;
    /** Model for Codex when mode = codex-sub ('' = default). */
    codexModel: string;
    /** Path to the Codex CLI. */
    codexPath: string;
  };
  anthropic: {
    apiKey: string;
    /** Orchestrator model. */
    model: string;
    maxTokens: number;
  };
  providers: ProviderConfig[];
  /** Path to the Claude Code binary. */
  claudePath: string;
  /** Max simultaneously running workers. */
  maxParallel: number;
  /** Per-worker time limit in minutes. */
  workerTimeoutMin: number;
  /** Let workers edit/run without permission prompts (they run in isolated worktrees). */
  skipPermissions: boolean;
  /** Extra instructions appended to every worker prompt (project conventions etc). */
  workerPreamble: string;
  /** Extra instructions appended to the orchestrator system prompt. */
  orchestratorPreamble: string;
  /** Spend cap for a whole run (orchestrator + workers), USD. 0 = no cap. */
  runBudgetUsd: number;
  /** Who picks the planning/orchestrating model for a new task: ask me (recommend + approve), take the recommendation, or always use Settings. */
  plannerPick: 'ask' | 'auto' | 'settings';
  /** Route every delegated task to this provider id regardless of the orchestrator's choice (empty/undefined = off). */
  forceProvider?: string;
  /** `orchestra serve`: address and port of the web panel + MCP endpoint. */
  serve: { host: string; port: number };
  /** Projects shown in «Диагностика» (Orca + Orchestra modes). Empty = discovered under projectRoots. */
  projects?: string[];
  /** Folders to look for git repositories in (depth 3). Empty = the usual places (~/Developer, ~/Projects, ~/Code, ~/dev) that exist. */
  projectRoots?: string[];
  /** Runtime only (not saved): last health check per provider id, so unavailable workers are not picked. */
  health?: Record<string, Health>;
}

/** One model that can plan and orchestrate a run. */
export interface PlannerChoice {
  id: string;
  mode: OrchestratorMode;
  /** Model for that mode ('' = the CLI's default). */
  model: string;
  label: string;
  /** Russian one-liner: price/limits trade-off. */
  hint: string;
  light: Light;
}

export interface Triage {
  complexity: 'low' | 'medium' | 'high';
  recommended: string;
  reason: string;
  /** Who made the recommendation: a model id, or 'эвристика'. */
  by: string;
  choices: PlannerChoice[];
}

/** Traffic light: green = works, yellow = connected but out of money / quota, red = not connected, gray = not checked. */
export type Light = 'green' | 'yellow' | 'red' | 'gray';

export interface Health {
  light: Light;
  /** Short Russian status line for the card. */
  text: string;
  /** Extra facts: balance, plan, quota windows. */
  details?: string[];
  /** Quota bars from CodexBar, when it is installed. `scoped` = informational only, never trips the light. */
  quotas?: Array<{ label: string; usedPercent: number; resetsAt?: string; scoped?: boolean }>;
  /** True when a subscription limit window is near its end (light yellow); recovers at limitResetsAt. */
  nearLimit?: boolean;
  /** ISO time when all tripped limit windows have reset. */
  limitResetsAt?: string;
  checkedAt: number;
}

export interface RoleDef {
  id: string;
  label: string;
  /** What this role means, shown to the planner/orchestrator. */
  hint: string;
}

export const ROLES: RoleDef[] = [
  { id: 'feature', label: 'Новая функциональность', hint: 'implementing new features and endpoints across several files' },
  { id: 'bugfix', label: 'Исправление ошибок', hint: 'diagnosing and fixing bugs with a reproducing test' },
  { id: 'tests', label: 'Тесты', hint: 'writing unit/integration tests for existing code' },
  { id: 'refactor', label: 'Рефакторинг', hint: 'mechanical refactors, renames, migrations, pattern application' },
  { id: 'docs', label: 'Документация', hint: 'README, docstrings, comments, changelogs' },
  { id: 'review', label: 'Ревью кода', hint: 'reviewing a diff and reporting problems without changing code' },
];

export interface PlannedTask {
  id: string;
  title: string;
  role: string;
  providerId: string;
  spec: string;
  /** ids of tasks that must be merged before this one starts */
  dependsOn: string[];
  reason: string;
}

export interface Plan {
  summary: string;
  tasks: PlannedTask[];
}

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'merged'
  | 'discarded';

export interface WorkerTask {
  id: string;
  /** Automatic retries: the first task of a job is its jobId; every retry is a new task with attempt + 1. */
  jobId?: string;
  attempt?: number;
  retryOf?: string;
  retriedAs?: string;
  /** All automatic retries failed: the owner has to decide. `question` is what they are asked. */
  escalated?: boolean;
  question?: string;
  title: string;
  providerId: string;
  model: string;
  spec: string;
  role?: string;
  status: TaskStatus;
  branch: string;
  worktree: string;
  baseSha: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Worker's final message (Claude Code `result`). */
  result?: string;
  /** Short diff stat after the worker finished. */
  diffStat?: string;
  /** Full diff (may be truncated for the orchestrator). */
  diff?: string;
  /** Rolling log of what the worker did (tool calls, text). */
  log: string[];
  costUsd?: number;
  /** For subscription workers: what the run would have cost at API prices (costUsd is 0 for them). */
  apiEquivUsd?: number;
  /** true when the cost is Claude Code's own guess (no prices configured for this provider). */
  costEstimated?: boolean;
  tokensIn?: number;
  tokensOut?: number;
  error?: string;
}

export interface RunState {
  runId: string;
  repo: string;
  baseBranch: string;
  goal: string;
  status: RunStatus;
  /** Who drives the run: the app's own Claude loop, or an external agent through the MCP server. */
  source: 'app' | 'mcp';
  tasks: WorkerTask[];
  plan?: Plan;
  budgetUsd?: number;
  /** Why the run stopped, when it wasn't a normal finish. */
  stopReason?: string;
  /** Process id of the MCP server that owns an MCP run (to tell live runs from dead ones). */
  pid?: number;
  /** Orchestrator transcript lines shown in UI. */
  transcript: TranscriptEntry[];
  finalReport?: string;
  startedAt?: number;
  finishedAt?: number;
  orchestratorCostUsd?: number;
  /** Who orchestrated this run. Subscription orchestrators don't cost dollars; their API-price equivalent is kept apart. */
  orchestrator?: OrchestratorMode;
  /** What the subscription work would have cost at API prices (orchestrator and subscription workers). */
  apiEquivUsd?: number;
  /** Session id of the subscription orchestrator (claude --resume / codex exec resume). */
  cliSessionId?: string;
  /** «В льготное время»: workers of providers with a time-of-day tariff start only outside their peak hours. */
  offPeakOnly?: boolean;
}

export type RunStatus = 'idle' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted' | 'stopped';

export interface RunSummary {
  runId: string;
  source: 'app' | 'mcp';
  repo: string;
  goal: string;
  status: RunStatus;
  startedAt?: number;
  finishedAt?: number;
  tasks: number;
  merged: number;
  costUsd: number;
  resumable: boolean;
}

export interface TranscriptEntry {
  ts: number;
  kind: 'assistant' | 'tool_call' | 'tool_result' | 'system' | 'error';
  text: string;
}

export interface Alert {
  id: string;
  ts: number;
  level: 'info' | 'warn' | 'error';
  /** Same key = same problem: repeats inside the cool-down are not raised again. */
  key: string;
  title: string;
  text: string;
  runId?: string;
}

export type OrchEvent =
  | { type: 'state'; state: RunState }
  | { type: 'transcript'; entry: TranscriptEntry }
  | { type: 'task'; task: WorkerTask }
  | { type: 'task_log'; taskId: string; line: string }
  | { type: 'toast'; level: 'info' | 'error'; text: string }
  | { type: 'health'; health: Record<string, Health> }
  | { type: 'alert'; alert: Alert };
