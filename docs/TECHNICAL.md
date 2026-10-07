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

1. `git worktree add -b orch/<run>-t01-<slug> <userData>/worktrees/<run>/t01 HEAD` (the run id in the branch name keeps runs from colliding). If the repo has a real `node_modules`, the worktree gets a symlink to it (so workers can build and run tests); `node_modules` is added to the shared `info/exclude` and `commitAll` runs `git rm --cached --ignore-unmatch node_modules`, so the link never lands in a commit.
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

## Worker questions

A worker cannot wait for an answer, so it ends its final message with `NEEDS_ANSWER: <question>` (worker prompt rule). `src/main/waiting.ts` `findQuestion` reads that marker (fallback: the old guess from the last log line); the task stays `done` but gets `needsAnswer` / `needsAnswerExplicit`.
`briefStatus` then shows WORKER IS WAITING FOR AN ANSWER to the orchestrator, and the watchdog raises one alert (`error` for the marker, `warn` for the guess).

## What needs the owner

The block «Требует вас» at the top of the panel lists everything that waits for the owner, so they do not have to read the alerts one by one. `collectAttention` (`src/main/attention.ts`) is a pure function over plain data (runs with tasks and spend, connections, health lights, 429 pauses, `notify.unmergedWarnMinutes`, `now`): no I/O, no clock. `Hub.attention()` gathers the data; `GET /api/attention` (web) and the `attention:get` IPC (desktop) return the list; `renderer/attention.js` only draws it and hides the block when it is empty. Items, most urgent first: a worker's question (`needsAnswer`), a task out of automatic retries (`escalated`), a done task not merged for longer than `unmergedWarnMinutes` (0 = this item is off), a task stopped by the per-task cap and not continued, a connection paused by a 429 or with a red/yellow light (enabled ones only), a run budget or a worker spend cap at 90% or more. A task that was continued (`continuedFrom`) or retried (`retriedAs`) is not listed. `Hub.attention()` looks at the live runs (engines in memory) and at the runs saved on disk (`runs/*/run.json` via `Hub.savedStates`, unreadable files skipped, a run already live is not repeated): task items (question, decision, unmerged, capped) come from both, while the spend items (run budget, worker cap) only from live runs (`AttentionRun.live`), because a finished run cannot be given more budget. A saved run is skipped without being read when its `run.json` is older than 30 days. For the rest, a task that would give an item (done, needsAnswer, capped, escalated) is passed to `collectAttention` as merged when its branch (`WorkerTask.branch`) no longer exists in the run's `repo` or is already an ancestor of the run's `baseBranch` (`git rev-parse --verify`, `git merge-base --is-ancestor`, `execFileSync` with a 5 s timeout), because run.json keeps «done» after a manual merge or discard. Any doubt (repo missing, git fails, no base) keeps the item. For a saved run whose `repo` folder does not exist `Hub.attention()` sets `AttentionRun.missingRepo`, and the `unmerged` item then says «репозиторий не найден: <путь>» with a hint to fix `repo` in run.json instead of offering merge. Answers are cached in the Hub per repo+branch+base for 60 s so the 2 s panel poll does not spawn git. `collectAttention` stays pure. Alerts are untouched. Items of kind `unmerged` also carry `branch` and `diffStat` (copied from the `WorkerTask`, no I/O) and get three buttons in `renderer/attention.js` (only these items): «Показать diff» (toggles a scrollable `<pre>` under the item), «Слить» and «Отбросить». Merge and discard always go through `window.confirm` (task, branch, diff stat; for discard a warning that the branch and folder are deleted) and then call the existing `orch.mergeTask` / `orch.discardTask` (`Hub.merge` / `Hub.discard`, `POST /api/runs/:id/tasks/:tid/merge|discard`, IPC `task:merge|discard`): no new merge path. `Hub.merge` / `Hub.discard` first check that the run's `repo` folder exists (`fs.existsSync`) and otherwise return «Репозиторий не найден: …» without calling the engine, so run.json is not marked merged/discarded without a real cleanup. The server's answer is shown as a toast, level error only when it starts with «MERGE FAILED», «REFUSED» or «Репозиторий не найден» (anchored, no regex over the text), otherwise info; the confirm text says «в текущую ветку основного репозитория»; the block is always refreshed: per-item state (`attState`, key `runId/taskId`: open diff with its text and scroll position, busy flag) is restored after each redraw by `attRestoreState`, and the DOM is rebuilt only when `attSignature(items)` (the JSON of the list) changed, so the 2 s poll does not reset a text selection inside an open diff; a successful merge/discard drops that item's state and forces a redraw; the item's buttons are disabled during the request, and on success the attention list and the recent strip are reloaded. The diff comes from `Hub.taskDiff(runId, taskId)` (`git diff --end-of-options <baseSha>..<branch>` in the run's repo, after checking `baseSha` against `/^[0-9a-f]{7,40}$/` and that the branch does not start with `-`, saved runs via `engineFor`, cut to 200 000 chars with «…обрезано»; any problem comes back as a Russian sentence, never an exception): `GET /api/runs/:id/tasks/:tid/diff` (JSON string), IPC `task:diff`, `orch.taskDiff`. Tests: `src/test/smoke-attention.ts`, `src/test/smoke-attention-git.ts`, `src/test/smoke-serve.ts` (diff route).

Continuing a task from the panel (server side, and the buttons in «Требует вас»). `Hub.continueTask(runId, taskId, {provider, text?, title?})` answers a worker's question (`needsAnswer` on a `done` task, `text` required, at most 4000 chars), goes on after a cap stop (`capped`), or retries a task out of automatic retries (`escalated`, failed/timeout) on another worker; anything else is refused. The task is found in the live engine or in the saved `run.json` (`Hub.state`). The new task is NOT created in the old run: it goes into the repository's MCP session (`Hub.mcpSession(state.repo)`: its run budget, worker limits, freeze), with the old task's role and the title `<old> (продолжение)`; the brief is the owner's answer plus the original spec (cut to 6000) for a question, the original spec plus the owner's note for the other kinds. If the old run is that same session, it is a plain `delegate({continueFrom: tNN})`. Otherwise `delegate({continueFromExternal: {ref: 'runId/taskId', branch, baseSha, error, result, lastLog}})`: the CONTINUATION brief is built from those fields, `WorkerTask.continuedFrom = 'runId/taskId'` (the slash tells it from a task of the same run) and `continuedFromBranch` carries the branch the worktree starts from (`TaskEngine.execute`). If the old branch no longer exists (`git rev-parse --verify refs/heads/<branch>`), the task starts from a clean sheet (`delegate({linkFrom: 'runId/taskId'})`: no continuation header and no inherited branch, but with the link `continuedFrom`, so a repeated click is refused and the panel item closes) and the answer says so. Refusals and engine errors (budget, worker unavailable/paused, no role, worker cap, free-only) come back as a Russian sentence, never an exception («Задача не найдена», «Эту задачу продолжить нельзя: …», «Репозиторий не найден: … Ничего не сделано.», «Не запущено: …»). The old run is never changed: `collectAttention` closes the old item when ANY run has a task with `continuedFrom === 'runId/taskId'` (a Set built before the loop, still pure). Wiring: `POST /api/runs/:id/tasks/:tid/continue` (`{provider, text, title?}`), IPC `task:continue`, `orch.continueTask`; for the future dialog `GET /api/runs/:id/tasks/:tid/continue-options` (IPC `task:continueOptions`, `orch.continueOptions`) returns `{role, providers: [{id, label, model, billing, capUsd, free}], taskCapUsd, runBudgetUsd, defaultProvider}` from the shared `providersForRole` / `taskCapFor` (`src/main/engine.ts`, the same rules the engine uses). Double-continue guard (money): before `mcpSession`, `Hub.continuedBy` walks all live and saved runs (`liveAndSaved`) and refuses with «Эту задачу продолжить нельзя: уже продолжена (<ref>).» when a task has `continuedFrom === 'runId/taskId'` (or `=== taskId` inside the same run), or the old task's `retriedAs` points to an existing task of its run; the old run.json is never changed, so this is the only memory of a continuation. Two parallel calls are separated by an in-memory Set of `runId/taskId` keys («continuing now»), checked and filled synchronously before the first await and cleared in `finally`. `continue-options` also returns `forced` (`forceProvider` when it is enabled and not red/yellow, otherwise null); with it set, `providers` is that one worker only, as `engine.delegate` routes every task there. If the continued branch vanishes between the check and `execute` (`createWorktree` fails, no `startedAt`), `afterFailure` does not start an automatic retry (it would run from a clean sheet and spend money without asking) and escalates the task to the owner at once. What the owner should know about cost: (a) `mcpSession(repo)` may RESTORE another interrupted MCP session of this repository (younger than 24 h, with unmerged tasks) and rewrite its run.json (status running, pid, reconciliation of tasks in flight); it spends nothing by itself. (b) Budget and worker limits are per run: every new MCP session gets its own `runBudgetUsd`, there is no ceiling over all continuations; a continuation gets a new `jobId`, so it again has up to 3 automatic retries, i.e. one click can lead to several paid attempts; if an external agent's session is alive, the continuation spends its budget. (c) A «decision» task (`escalated`) is repeated as a CONTINUATION from the failed attempt's branch, not as a clean retry. Test: `src/test/smoke-continue.ts`. Buttons: `question` → «Ответить» (text required), `decision` → «Продолжить с ветки на другом исполнителе» (no text), `capped` → «Продолжить» (text optional); each opens an inline form in the item (worker select from `continueOptions`, locked when `forced`; task cap, run budget, a money / subscription-limit / free note), «Запустить» always asks `window.confirm` first and only then calls `orch.continueTask`. No options (null, error, no providers) → a Russian phrase and no start. The result string is shown as a toast, error when it starts with «Не запущено», «Эту задачу продолжить нельзя», «Задача не найдена» or «Репозиторий не найден»; then the list and the recent strip are reloaded. The DOM-free logic (buttons by kind, text check, confirm text, result classification, the form → check → confirm → call order with the `busy` guard) lives in `renderer/attention-logic.js` (UMD, `window.AttentionLogic`; loaded before `attention.js`); `renderer/attention.js` only draws it and keeps the form in `attState` (`cont`: open, text, chosen worker, loaded options), so it survives the 2 s redraw. Test: `src/test/smoke-attention-ui.ts` (the DOM itself is still checked by hand).

The strip «Недавно завершено» at the bottom of the panel is a plain history: the last 10 tasks with status `merged`, `discarded` or `done` (done = ready, not merged, marked separately) from all runs, live and saved, finished within 7 days, newest first by `finishedAt` (no `finishedAt` → the run's `run.json` mtime; now for a live run). `collectRecent` (`src/main/recent.ts`) is a pure function (no I/O, `now` is a parameter). `Hub.recent()` takes the runs from the same private `Hub.liveAndSaved()` as `Hub.attention()`, and for saved runs a `done` task whose branch is gone or already merged is shown as `merged` («слито»): the same `branchGone` check and cache as in «Требует вас» (via the private `closeByGit`); live runs are not checked. A deleted branch is indistinguishable from one discarded by hand: both show as «слито». `GET /api/recent` (web) and the `recent:get` IPC (desktop) return the list; `renderer/recent.js` draws a horizontal scrolling row of fixed-width cards (title, provider, status, `$` cost if any, «N ч/дн назад»), no buttons, hidden when empty; it reloads on `task`/`state` events (at most once per 2 s) and every 60 s. Tests: `src/test/smoke-recent.ts`, `GET /api/recent` in `src/test/smoke-serve.ts`.

## Provider rate limits

A 429 / quota / «free-models-per-day» answer is a pause of that connection, not a task failure (`src/main/ratelimit.ts`). The connection is paused in memory (until midnight UTC for a daily limit, otherwise 10 minutes; a service restart forgets it). The task restarts on another worker without spending an automatic-retry attempt, continuing from its branch if it already has commits. With no other worker it stays failed with the reason «paused until HH:MM UTC» and the owner gets one warn alert (`ratelimit:<id>`). Paused connections are skipped by retries and refused by `delegate`; `list_workers` marks them PAUSED.

## Run history and resume

Every run is saved to `<userData>/runs/<runId>/run.json` as it goes: tasks, logs, diffs, spend and the orchestrator's whole conversation. The **История** tab lists runs; «Открыть» shows a saved run read-only, «Продолжить» resumes one that was interrupted, failed, cancelled or stopped by the budget.

Quitting the app mid-run kills the workers but keeps their worktrees. On resume, unfinished tasks are committed as they are and handed to the orchestrator as partial diffs to review, the tool calls that never got answers are answered with "interrupted", and Claude continues from the same point in the conversation. Resume needs the repo on the same branch and clean; the budget is taken from current Settings, so you can raise it before continuing. At service start `Hub.init()` also restores the interrupted MCP sessions (`restoreMcpSessionsOnStart`, one per repo, same rules as the lazy `restoreMcpSession`: younger than 24 h, dead pid, unmerged tasks; repo folder must exist and be a git repo), so the panel shows them before the agent's first call; it starts no worker and spends nothing, and only the idle close (`MCP_IDLE_MS`) ends such a session. Test: `smoke-restore`.

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
  - with `?repo=<absolute path>` the connected agent is the orchestrator: `list_workers` (with a 7-day track record per worker: tasks, merged, spend, waste, $ per merged task), `delegate`, `wait_for`, `task_status`, `get_diff`, `merge_task`, `discard_task`, `end_session`. The session shows up live in the panel and in History.
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
