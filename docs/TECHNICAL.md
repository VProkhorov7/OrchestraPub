# Orchestra — technical reference (English)

> User guide: [README.md](../README.md) · [SETUP.en.md](SETUP.en.md) (Russian: [README.ru.md](../README.ru.md), [SETUP.md](SETUP.md)). This file is the detailed reference for developers.

Desktop app (Electron) and service where **Claude is the lead engineer** and cheaper models (**DeepSeek, GLM/z.ai, Qwen**) do the coding as headless **Claude Code** workers, each in its own git worktree.

```
you ── goal ──▶ Claude (Anthropic API, tool-use loop)
                  │  delegate(provider, title, spec)      ×N in parallel
                  ▼
        git worktree + branch orch/tNN-…  ──▶  claude -p "<spec>" with ANTHROPIC_BASE_URL=<deepseek|z.ai|qwen>
                  │  wait_for → worker summary + diff
                  ▼
        Claude reviews the diff → merge_task / discard_task / delegate a fix → run_command (tests) → finish(report)
```

Claude never writes app code itself; it plans, briefs, reviews and merges. You watch everything live and can merge or discard any branch by hand.

## Requirements

- Node.js 20+
- git
- Claude Code CLI installed (`claude --version` works) — it is the worker runtime; it is pointed at third-party endpoints via env vars, so no Anthropic subscription is needed for workers
- An Anthropic API key for the orchestrator
- API keys for the workers you enable (DeepSeek, z.ai, Alibaba Cloud…)

## Run

```bash
npm install
npm start          # builds TypeScript and launches the app
npm run smoke      # offline end-to-end tests with a fake claude and fake API (no keys needed):
                   #   main flow, resume after quit, budget stop, MCP server over stdio
npm run dist       # package with electron-builder (dmg / AppImage / nsis)
```

First launch: open **Settings**, paste the Anthropic key, enable providers and paste their tokens. Config, run history and worktrees live in the Electron userData folder (`~/Library/Application Support/Orchestra/` on macOS, `~/.config/Orchestra/` on Linux, `%APPDATA%\Orchestra\` on Windows); `config.json` is file mode 600.

Then pick a repository (must be a git repo with a clean working tree), describe the goal, press **Run**.

## How workers are launched

For each delegated task:

1. `git worktree add -b orch/<run>-t01-<slug> <userData>/worktrees/<run>/t01 HEAD` (the run id in the branch name keeps runs from colliding)
2. `claude -p "<brief>" --output-format stream-json --verbose --model <model> --dangerously-skip-permissions` in that worktree, with
   `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` set for the provider. The orchestrator's own key is stripped from the worker env.
3. Whatever the worker left uncommitted is committed; diff stat + diff go back to Claude.
4. Merge is `git merge --no-ff`; on conflict it aborts, keeps the branch and tells Claude, which can delegate a rebase/fix or discard.

Worker isolation is git-level only: workers run with `--dangerously-skip-permissions` **on your machine** and can run any shell command in the worktree. Turn that off in Settings (`skip permission prompts`) to use `--permission-mode acceptEdits` instead, or run the app in a VM/container for untrusted repos.

## Orchestrator: subscription or API

Settings → «Оркестратор» picks who plans and reviews:

- **Claude, подписка** (default): the app runs the official `claude -p` logged in with your Claude Pro/Max account, with the Orchestra tools attached over MCP (HTTP on 127.0.0.1, per run, bearer token). No API key; Edit/Write are disabled for it, it can only read, run commands and call the Orchestra tools. Planning («Распределить автоматически») also goes through `claude -p`.
- **ChatGPT, подписка** (experimental): the same through `codex exec --json`. Codex auto-rejects MCP tool calls unless approvals and sandbox are bypassed ([openai/codex#24135](https://github.com/openai/codex/issues/24135)), so it runs with `--dangerously-bypass-approvals-and-sandbox`, like the workers. Some ChatGPT plans (e.g. K-12 Teachers workspaces) are not recognised by the Codex CLI; the connection card will show that.
- **Claude API**: the app's own tool-use loop with an Anthropic key (prompt caching, resume with the full conversation).

Subscription orchestrators cost $0 per run; the sidebar shows what the same work would cost at API prices. If the subscription's limit runs out mid-run, the run stops as «остановлен» with the reason and can be continued later from History (the CLI session is resumed).

Anthropic does not allow third-party apps to use Claude subscription credentials directly; Orchestra never touches them, it only starts the official CLI you are logged into.

## Connections and traffic lights

Settings → «Подключения»: a drop-down lists everything not yet added (subscriptions, pay-per-token APIs, coding plans, or your own Anthropic-compatible endpoint); added ones are cards with a light:

- 🟢 **works**: the key/login is accepted and the endpoint answers (a 1-token request).
- 🟡 **connected, no money**: HTTP 402, "insufficient balance", "credit balance too low", DeepSeek balance 0, or a subscription window at 100% (via CodexBar).
- 🔴 **not connected**: no key, key rejected, not logged in (`claude auth status`, `codex login status`), CLI missing, wrong URL/model.

Yellow and red workers are refused by `delegate` and marked UNAVAILABLE to the orchestrator. Lights are checked on start, on save, and by «Проверить». If [CodexBar](https://github.com/steipete/CodexBar) is installed, subscription cards show its 5-hour and weekly bars (`codexbar usage --format json`).

| preset | endpoint | default model | billing |
|---|---|---|---|
| claude-sub | official `claude` CLI | subscription default | subscription |
| codex-sub | official `codex` CLI (orchestrator only) | plan default | subscription |
| anthropic | api.anthropic.com | claude-sonnet-5 | API |
| deepseek | api.deepseek.com/anthropic | deepseek-v4-pro | API ($0.435 / $0.87), balance shown |
| glm / glm-plan | api.z.ai/api/anthropic | glm-5.3 | API ($1.40 / $4.40) / GLM Coding Plan |
| kimi | api.moonshot.ai/anthropic | kimi-k3 | API |
| minimax / minimax-plan | api.minimax.io/anthropic | MiniMax-M3 | API / Token Plan |
| qwen | dashscope-intl…/apps/anthropic | qwen3-coder-plus | API (the Coding Plan forbids automation) |
| openrouter | openrouter.ai/api | any `vendor/model` | API |

Model ids change often; edit them on the card. Third-party workers get their own `CLAUDE_CONFIG_DIR` under `<userData>/worker-home/<id>`, so their sessions stay out of your `~/.claude` (and out of subscription stats).

## Roles and auto-assignment

Each worker has **role switches** in Settings (Новая функциональность, Исправление ошибок, Тесты, Рефакторинг, Документация, Ревью кода). A worker with no roles selected may take any task. The orchestrator must pass a `role` with every `delegate`; a role the worker doesn't allow is rejected and the orchestrator is told which workers do allow it.

**Распределить автоматически** makes one planning call to Claude: it reads the goal (plus anything attached with «Прикрепить задание») and the file tree, and returns a plan — tasks with role, worker, brief, dependencies and a one-line reason. The plan opens in the «План» tab where you can retitle tasks, change the role or worker, edit the brief or drop a task. «Запустить по плану» starts the orchestrator with that plan as a strong recommendation; it may still split, reassign after failures or add fix tasks, and says why when it does. «Запустить» without a plan works as before: Claude decides on the fly.

## Run history and resume

Every run is saved to `<userData>/runs/<runId>/run.json` as it goes: tasks, logs, diffs, spend and the orchestrator's whole conversation. The **История** tab lists runs; «Открыть» shows a saved run read-only, «Продолжить» resumes one that was interrupted, failed, cancelled or stopped by the budget.

Quitting the app mid-run kills the workers but keeps their worktrees. On resume, unfinished tasks are committed as they are and handed to the orchestrator as partial diffs to review, the tool calls that never got answers are answered with "interrupted", and Claude continues from the same point in the conversation. Resume needs the repo on the same branch and clean; the budget is taken from current Settings, so you can raise it before continuing.

## Spend and budgets

- **Run budget** (Settings → Оркестратор): cap for orchestrator + all workers. At 80% the orchestrator is told to prioritise; at 100% running workers are stopped (their diffs are kept), new delegations are refused and Claude is told to merge what's good and finish; at 125% the run is stopped outright.
- **Per-worker cap** (`лимит $ за запуск`): a worker over its cap is stopped and refused further tasks; the orchestrator is told which other workers take that role.
- **Prices** per worker ($ per 1M input / cached input / output tokens). Worker spend is computed from the token counts Claude Code streams, with these prices. Without prices the app falls back to Claude Code's own figure, which uses Anthropic prices and is marked «оценка». Defaults (Sept 2026): DeepSeek V4 Pro $0.435 / $0.0036 / $0.87 (DeepSeek bills peak and off-peak differently), GLM-5.3 $1.40 / $0.26 / $4.40, Qwen3-Coder-Plus $1 / – / $5. Check them against the providers' pages.
- The orchestrator's requests use **prompt caching** (system prompt + conversation), so long runs pay full price only for each new turn; the sidebar meter counts cache reads and writes at Anthropic's rates.

## `orchestra serve`: one always-on service, any AI client

The recommended setup for a home server (e.g. a Mac mini) is to run Orchestra as a service instead of the desktop app:

```bash
npm run build
node dist/server/serve.js --host 100.x.y.z --port 7777     # your Tailscale address; 127.0.0.1 = this machine only
node dist/server/serve.js --print-token                   # the access token (stored in <userData>/serve.json)
node dist/server/serve.js --install-launchd               # macOS: start at login, restart if it dies
```

One process owns every run, so the run budget, the worker limit, connection lights and merges into a repository are shared by all clients. It offers:

- **Web panel** at `http://<host>:7777/?token=<token>`: the same UI as the desktop app (settings, lights, plan, workers live, history, spend). Open it from the MacBook over Tailscale.
- **MCP over HTTP** at `http://<host>:7777/mcp`, header `Authorization: Bearer <token>`:
  - with `?repo=<absolute path>` the connected agent is the orchestrator: `list_workers`, `delegate`, `wait_for`, `task_status`, `get_diff`, `merge_task`, `discard_task`, `end_session`. The session shows up live in the panel and in History.
  - always: **autopilot** tools, where Orchestra plans and orchestrates itself: `autopilot_start(goal, repo)` → (`autopilot_approve`) → `run_status`, plus `list_runs`, `cancel_run`. Useful for weak clients or a phone.

```bash
claude mcp add --transport http orchestra "http://mac-mini:7777/mcp?repo=$(pwd)" --header "Authorization: Bearer <token>"
```

Never expose the port to the internet: the tools start coding agents on that machine. Keep it on localhost or Tailscale.

The stdio server (`dist/mcp/server.js`) still works for a single client without the service:

```bash
claude mcp add orchestra -- node /absolute/path/to/orchestra/dist/mcp/server.js
codex mcp add orchestra -- node /absolute/path/to/orchestra/dist/mcp/server.js
```

Merges into one repository are serialized across runs and processes (a lock file in the git dir), so the app, the service and stdio servers can share a repo safely.

## Which model plans: recommendation + approval

For every new task Orchestra first decides who should plan and orchestrate it:

1. The candidates are what you have connected: Claude Opus / Sonnet on the subscription, ChatGPT on the subscription, Claude Opus / Sonnet / Fable via API.
2. The cheapest green worker (a coding plan first, then the cheapest pay-per-token API) reads the task and recommends one, with the complexity and a one-line reason. Without such a worker a heuristic decides (architecture, migrations, security, auth, payments → strong model; typos, README, renames → cheap one).
3. If a subscription's 5-hour or weekly window is over 80% (CodexBar), the same model via API or another subscription is preferred, or you get a warning.
4. You approve or pick another in the panel («Кто будет планировать и вести задачу»). The choice is used for the plan **and** as the run's orchestrator.

Settings → «Выбор модели для каждой задачи»: ask me (default), take the recommendation silently, or always use the model set in Settings. Over MCP, `autopilot_start` returns the recommendation and a `pending_id` for `autopilot_approve` (or pass `approve: "auto"`).

## Tuning

- **Max parallel** — how many workers run at once (others queue).
- **Timeout** — per worker; on timeout the partial diff is still captured.
- **Project conventions for workers** — appended to every worker brief (test command, style rules).
- **Extra instructions for the orchestrator** — appended to Claude's system prompt (e.g. "always run `npm test` after each merge").
- **Orchestrator model** — default `claude-opus-5` (planning and diff review are judgement work; a weak brief costs a whole extra worker round). `claude-sonnet-5` is fine for small routine runs; `claude-fable-5-1` only for hard architectural work. The sidebar cost estimate uses list prices by model family (`priceFor` in `src/main/orchestrator.ts`).

## Layout

```
src/main/main.ts          Electron main, IPC
src/main/orchestrator.ts  Claude tool-use loop, resume, budget notes, prompt caching
src/main/engine.ts        task queue, worktrees, workers, diffs, merge/discard, spend caps (shared with MCP)
src/main/runs.ts          run history on disk
src/main/pricing.ts       Claude prices, worker cost from token usage
src/main/planner.ts       one-shot planning call
src/main/hub.ts           everything the app does, without Electron (runs registry, health, triage, MCP sessions)
src/main/triage.ts        which model plans: candidates, cheap-model recommendation, heuristic
src/server/serve.ts       orchestra serve: web panel, JSON API + SSE, MCP over HTTP, launchd
src/mcp/tools.ts          the MCP tools, shared by the stdio server and the service
src/mcp/server.ts         stdio MCP server
src/main/worker.ts        spawn claude -p, parse stream-json, env for providers
src/main/git.ts           worktrees, diffs, merges
src/main/prompts.ts       system prompt + worker brief templates
src/main/config.ts        defaults and config file
src/preload.ts            contextBridge API
renderer/                 UI (plain HTML/CSS/JS, no framework)
src/test/                 offline end-to-end tests
```

## Known limits

- The desktop app and `orchestra serve` can use the same data folder, but run one or the other on a machine to avoid two schedulers.
- Workers get no memory of previous tasks; every brief must be self-contained (the system prompt tells Claude this).
- Prices are list prices typed into Settings; DeepSeek's peak/off-peak billing is not modelled.

See [ROADMAP.md](../ROADMAP.md) for where this is going.
