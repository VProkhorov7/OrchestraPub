# Guide: Installation and Operation

**English** · [Русский](SETUP.md)

Contents: [1. What you'll need](#1-what-youll-need) · [2. Installation](#2-installation) · [3. Connections](#3-connections) · [4. First task](#4-first-task) · [5. Service on a home server](#5-service-on-a-home-server-mac-mini) · [6. MCP](#6-connecting-ai-agents-via-mcp) · [7. Orca](#7-together-with-orca) · [8. Budgets and costs](#8-budgets-and-costs) · [9. If something's wrong](#9-if-somethings-wrong) · [10. English mode](#10-english-mode-preparing-the-environment) · [Project memory](MEMORY.en.md)

---

## 1. What you'll need

| What | Why | How to check |
|---|---|---|
| Node.js 20+ | runs Orchestra | `node -v` |
| git | worktrees and merges | `git --version` |
| Claude Code | all workers run on it; with a subscription it also runs the orchestrator | `claude --version`, log in: `claude`, then `/login` |
| Codex CLI (optional) | orchestrator on a ChatGPT subscription | `codex --version`, log in: `codex login` |
| A key from at least one cheap provider | workers | DeepSeek, z.ai (GLM), Moonshot (Kimi), MiniMax, Alibaba (Qwen), OpenRouter |
| [CodexBar](https://github.com/steipete/CodexBar) (optional) | subscription limit percentages on cards | `codexbar usage` |
| [Tailscale](https://tailscale.com) (for the server) | access to the service from other machines | `tailscale ip -4` |

## 2. Installation

```bash
git clone https://github.com/VProkhorov7/OrchestraPub.git
cd Orchestra
npm install
npm run smoke        # optional: self-tests without keys or network, about a minute
npm run build && npm link   # commands orchestra-memory, orchestra-mcp, orchestra-serve in PATH
```

Run `npm link` on every computer where you edit code (Mac mini and MacBook). Git hooks and Claude Code use the `orchestra-memory` command to maintain the project memory. To enable it in a repository, see [MEMORY.en.md](MEMORY.en.md).

Then choose one of two modes:

- **Desktop app**: `npm start`. Best when everything runs on one computer.
- **Service**: `npm run serve`. Best for a home server (section 5).

Run only one of them on a machine at a time. They share their data (settings, history), stored in `~/Library/Application Support/Orchestra/` on macOS and `~/.config/Orchestra/` on Linux.

> Node 26 and newer: if `npm install` did not download Electron, run `npm install-scripts approve electron && node node_modules/electron/install.js`. The service does not need Electron.

## 3. Connections

Open **Settings → Connections**. The dropdown lists everything you have not added yet. Click "Add", then "Configure" on the card, enter the key and click "Check".

| Group | What's there | How you pay |
|---|---|---|
| Subscriptions | Claude (Pro/Max, via Claude Code), ChatGPT (via Codex CLI) | fixed price, limits in 5-hour and weekly windows |
| API | Claude API, DeepSeek, GLM, Kimi, MiniMax, Qwen, OpenRouter, "custom" (any Anthropic-compatible endpoint) | per token, prices entered on the card |
| Coding plans | GLM Coding Plan, MiniMax Token Plan | fixed price, plan credits |

Card colour:

- 🟢 **working**: the key or login is accepted and the service responds.
- 🟡 **connected, no funds**: the service reports "insufficient balance", the balance is zero, or the subscription limit is at 100%.
- 🔴 **not connected**: no key, key rejected, not logged in, or program not installed.

Each card has these settings:

- **"take tasks"**: whether the connection can act as a worker. A Claude subscription can, but it then spends the same limit as the orchestrator.
- **Roles**: which tasks the worker may be given. With no roles set, it accepts any task.
- **Prices per 1M tokens and "limit $ per run".**
- **Notes for the orchestrator**: what this worker is good at. The orchestrator reads them when it chooses a worker.

Gemini cannot be connected directly because it has no Anthropic-compatible endpoint. For a local bridge, follow [GEMINI-BRIDGE.md](GEMINI-BRIDGE.md).

Providers change their model IDs often. If a card is red with a "model not found" error, correct the model ID on the card.

**Coding plan terms.** Some plans prohibit automated use (the Qwen Coding Plan says so explicitly). For Qwen, use a pay-per-token key. Check the terms of other plans yourself.

## 4. First task

1. **Repository**: enter the path to a git repository with no uncommitted changes. The orchestrator works on the current branch.
2. **Task**: describe what you need, or attach a `.md` or `.txt` file.
3. **"Distribute automatically"**:
   - A "Who will plan and lead the task" block appears, with a complexity estimate, a recommendation and the reason for it.
   - Click "Approve", or choose another model from the list.
   - The chosen model drafts a plan and opens it on the "Plan" tab. You can edit the name, role, worker and brief of each task.
4. **"Start by plan"**: the "Orchestrator" tab shows its reasoning and calls. The "Workers" tab shows each worker live, with its log, diff and cost.
5. A report appears at the end. Merged tasks land in your branch as separate merge commits. Unmerged branches remain, and you can merge or discard them manually on the task card, later too, from "History".

Whether Orchestra asks you to confirm the model is set under **Settings → Orchestrator → "Model selection for each task"**:

- ask me (default);
- take the recommendation silently;
- always use the model from settings.

## 5. Service on a home server (Mac mini)

Everything runs on the server (repositories, workers, logins, keys). The laptop only opens the panel.

```bash
# on the server
tailscale ip -4                                   # e.g. 100.101.102.103
npm run build
node dist/server/serve.js --host 100.101.102.103  # test manually
node dist/server/serve.js --print-token           # access token
node dist/server/serve.js --host 100.101.102.103 --install-launchd
launchctl load -w ~/Library/LaunchAgents/dev.orchestra.serve.plist   # autostart on login
```

Service log: `~/Library/Application Support/Orchestra/logs/serve.log`.

On the laptop, open `http://100.101.102.103:7777/?token=<token>`. The browser remembers the token, so afterwards the address alone is enough.

To stop the server sleeping, run `sudo pmset -a sleep 0 disksleep 0`. In "System Settings", enable "Restart after power failure" and automatic user login. Without them the launchd agent does not start after a reboot.

Install everything the workers need **on the server**: Claude Code (logged in), Codex, provider keys (in Orchestra settings), SSH keys for git, and CodexBar. Do not expose port 7777 to the internet.

Keep repositories on the server's local disk or on an external APFS disk connected to it. exFAT and network folders (SMB) are unsuitable for working repositories, because file locking, permissions and speed all cause problems there.

## 6. Connecting AI agents via MCP

### Who can orchestrate

Any AI agent that speaks MCP can be the orchestrator, the one that plans, hands out tasks and reviews the diffs. The workers do not depend on it: they are always the same.

| Orchestrator | How it connects | What you need |
|---|---|---|
| **Claude Code** (Claude Pro or Max subscription) | Orchestra starts `claude` itself and gives it the MCP tools. Or you do it from a terminal or Orca with `claude mcp add` (option A below) | Be signed in to `claude`. The default model, Opus (stronger, uses the limit faster) or Sonnet (cheaper) is chosen in Settings |
| **Codex CLI** (ChatGPT subscription) | The same through `codex exec` and `codex mcp add`. Experimental | `codex login`. The model is set in Settings |
| **Claude API** | The orchestrator loop inside Orchestra itself, with a key | The «Claude API» connection. The default model is `claude-opus-5` |
| **Cursor, agents in Orca, any client with MCP over HTTP** | The address `http://<server>:7777/mcp?repo=…` and the header `Authorization: Bearer <token>` (below) | A running `orchestra serve` |

**Which models are used.** A worker is headless Claude Code that Orchestra points at the provider's address (`ANTHROPIC_BASE_URL`), so any provider with an Anthropic-compatible API will do. The connection list has these ready to add:

| Connection | Default model | Default roles | Price per 1M tokens (input / output) |
|---|---|---|---|
| DeepSeek | `deepseek-v4-pro` (small: `deepseek-flash`) | tests, refactoring, docs | $1.32 / $3.96; half price outside peak hours |
| GLM (z.ai) | `glm-5.3` (small: `glm-5.3-flash`) | features, bugfixes, refactoring | $1.4 / $4.4 |
| Kimi (Moonshot) | `kimi-k3` | features, bugfixes, tests | the provider's rate |
| MiniMax | `MiniMax-M3` | tests, refactoring, docs | $0.3 / $1.2 |
| Qwen (Alibaba) | `qwen3-coder-plus` | features, bugfixes, tests | $1 / $5 |
| OpenRouter | any, for example `deepseek/deepseek-v4-pro` | your choice | the price of the chosen model |
| GLM and MiniMax on a coding plan | as above | as above | a flat fee, usage counted in plan credits |
| Claude through an API key or an aggregator | `claude-sonnet-5` | features, bugfixes, review | the provider's rate |

The prices are for orientation and providers change them; the exact values are in the connection card, where you can edit them. Any other Anthropic-compatible address can be added as «Custom connection». Roles can be changed in the card.

The service exposes MCP at `http://<server>:7777/mcp`. Send the header `Authorization: Bearer <token>`.

**Option A: the agent is the orchestrator.** Add `?repo=` to the address, and the agent gets the tools `list_workers`, `delegate`, `wait_for`, `task_status`, `get_diff`, `merge_task`, `discard_task`, `end_session`.

```bash
cd /path/to/project
claude mcp add --transport http orchestra "http://100.101.102.103:7777/mcp?repo=$(pwd)" \
  --header "Authorization: Bearer <token>"
```

The path in `repo` must be a path **on the server**. You can watch the session live in the web panel, and find it later in "History".

**Option B: autopilot.** Call `autopilot_start(goal, repo)`, and Orchestra picks the model, plans and leads the task itself. If "ask me" is set in settings, the response contains a recommendation and a `pending_id`. Then call `autopilot_approve(pending_id)`, and then `run_status(run_id)`. This suits weak clients and a phone.

**Without the service** (one client on one machine):

```bash
claude mcp add orchestra -- node /path/to/Orchestra/dist/mcp/server.js
codex mcp add orchestra -- node /path/to/Orchestra/dist/mcp/server.js
```

## 7. Together with Orca

[Orca](https://github.com/stablyai/orca) shows terminals and worktrees. Orchestra distributes tasks and tracks costs. They fit together like this:

- The Orca server and the Orchestra service run on the same Mac mini. The laptop connects to both via Tailscale.
- In an Orca terminal, start Claude Code connected to the Orchestra MCP with `?repo=<worktree of this terminal>`. It becomes the coordinator, and the workers run through Orchestra.
- **One coordinator per worktree.** Two agents merging into the same folder get in each other's way. Orchestra runs merges one at a time, but edits the coordinator makes in the same folder break a merge.
- Do not keep one Orca terminal open on two computers at once (a known Orca bug with two desktop clients).
- Orca agents on a Claude subscription and the Orchestra orchestrator spend the same limit. Watch the subscription card.
- **Memory and wiki travel with the commit.** After `orchestra-memory init`, the rules live in the repository in `CLAUDE.md` and `AGENTS.md`. Agents in Orca terminals then check memory before a task, close micro-sessions and update the wiki on their own. The commit and push buttons in Orca trigger the repository's git hooks, so `.memory/`, `wiki/` and `CHANGELOG.md` land in the same commit. If the push stops with "memory was committed separately", push again. Details: [MEMORY.en.md](MEMORY.en.md).

## 8. Budgets and costs

- **Run budget** (Settings → Orchestrator) is counted in API dollars: pay-per-token workers plus the orchestrator in API mode.
  - At 80% the orchestrator gets a warning.
  - At 100% the workers stop (their diffs are saved), no new tasks are issued, and the orchestrator must wrap up.
  - At 125% the run stops.
- **Per-worker limit**: a worker that exceeds it stops and receives no more tasks.
- **Per-task cap** by role (`taskCapUsd` in `config.json`; defaults: review and docs $0.5, feature and refactor $3, everything else $1.5; 0 turns it off). A task that reaches it is stopped, but its partial result is kept and is not retried automatically. The orchestrator is told not to discard it: merge it as it is, or delegate with `continue_from=<task id>`, and the new worker starts from the previous branch and finishes the rest.
- **Subscriptions and coding plans** cost $0 in dollars. The panel shows what the work would have cost through the API (the "subscriptions and plans at API prices" line).
- Prompt caching reduces the orchestrator's API spend: each later turn is charged only for the new part.

## 9. If something's wrong

| Symptom | Cause and what to do |
|---|---|
| Claude subscription 🔴 "not logged in" | On this machine run `claude`, then `/login`. |
| Codex 🔴 "not logged in" | `codex login`. Some ChatGPT plans (e.g. K-12 Teachers) are not recognized by Codex CLI. |
| 🔴 "not installed" although the program exists | The app or launchd cannot see PATH. Enter the full path in "Claude Code path" or "Codex CLI path" (`which claude`). |
| 🔴 "address or model not found" | The model ID or address on the card is wrong. |
| 🟡 for DeepSeek, GLM and others | Top up the balance, then click "Check". |
| "No working worker" | None of the connections with "take tasks" is green. |
| "The repository has uncommitted changes" | Commit or run `git stash`. Workers branch off the last commit. |
| Run "stopped": subscription limit reached | Wait for the window to reset, or pick another model, then click "Continue" in "History". |
| Merge failed, conflict | The branch is intact. The orchestrator usually files a fix task itself. To resolve it manually, merge the branch yourself or click "Discard". |
| The web panel asks for a token | Run `node dist/server/serve.js --print-token` and open `/?token=…`. |
| After a server reboot the service is not running | Check automatic user login and `launchctl list \| grep orchestra`, then read `serve.log`. |

### Free-only mode

The **«Free only»** button in the panel header turns on a mode in which Orchestra spends no money: paid workers and the orchestrator by API key are switched off (the connection list greys them out), and the orchestrator is told «unavailable: free-only mode». The setting is stored in the service (`freeOnly`), so it is respected by runs from the panel, MCP sessions, the autopilot, automatic retry and the peak-hour stand-in.

**What counts as free:**
- local models (Ollama, LM Studio and others);
- connections you marked «free tier», or with an explicit price of 0 (their cost is counted as zero);
- OpenRouter models that are free at OpenRouter itself: Orchestra takes them from the public list `openrouter.ai/api/v1/models` (price 0), not only by the `:free` suffix;
- subscriptions (Claude, ChatGPT) and flat-price coding plans: they cost nothing beyond what is already paid, so they stay available.

**Free models through OpenRouter.** Add the connection «OpenRouter · free models» (the «Free tiers» group) and a key from openrouter.ai/keys (a free account). The default model is `openrouter/free`, a router that picks a free model with tool support by itself; you can choose a specific one from the list in the «model» field (free models with tools come first). OpenRouter's limits for free models are 20 requests per minute and 50 per day (1,000 per day if you have ever bought $10 or more of credits). That is why the connection has one task at a time and the roles «tests», «docs» and «refactor», and why you should expect less from these models than from paid ones. If an OpenRouter connection names a paid model, the mode switches it off and says why.

If the mode has no free worker at all, a run does not start, and the panel suggests what to connect.

### Local models (Ollama, LM Studio and others)

A worker can be a model that runs on your computer or on a neighbouring one: free, with no code sent to the cloud. **Ollama**, **LM Studio** and any server with an Anthropic-compatible `/v1/messages` address (llama.cpp `llama-server`, vLLM) all work. A local model cannot be the orchestrator: that needs a strong model.

**How to connect.** Settings → Connections → «Add» → the «Local models» group: Ollama, LM Studio or «Local server». For Ollama, first pull a model that can call tools (for example `ollama pull qwen3-coder`) and enter its name. For LM Studio, start the local server (Developer → Start Server) and enter a model name from its list. No key is needed. The card turns green when the server answers, the model is there and the context is large enough; the model field suggests the installed models.

**Context: the main thing that breaks.** Claude Code sends about 16,000 tokens with every turn, so the model needs a context of at least 32,768. Ollama on a Mac with up to 24 GB of memory defaults to 4,096, and a worker on such a model does not work. Orchestra checks this (on this Mac's live Ollama the card showed a yellow «context 4,096»). The one-click fix is the **«32K context»** button on the card: it creates a copy of the model with `num_ctx 32768` (the weights are not copied), or set `OLLAMA_CONTEXT_LENGTH=32768` on the server. The button works only for Ollama on the same computer. In LM Studio, load the model with a context of at least 32,768.

**Speed and honest expectations.** We tried a Mac mini with an M4 chip and 16 GB of memory and the `qwen2.5:7b` model: the worker created the file correctly, but a one-line task did not finish within six minutes, because every turn processes about 16,000 tokens again. For regular work you need a machine with more memory and a stronger model; on weak hardware, use a local model for small mechanical tasks and give it a long timeout.

**Defaults for local workers.** A zero price, one task at a time (`maxConcurrent`: a local model serves one request), a task timeout of 60 minutes (`timeoutMin`), the roles «tests», «docs» and «refactor». All of it can be changed on the card. A local worker is used **last**: automatic retry and the peak-hour stand-in choose cloud workers first and take the local one only when nothing else is left; it also does not rate the complexity of tasks.

### Watchdogs, alerts and automatic retry

**Watchdogs.** The service watches the work itself and tells you when something is wrong:
- a worker has been silent for more than 8 minutes (the provider is stuck);
- a running task has lost its working folder;
- a run is close to its budget (80%) or has used it up, a worker is close to its spend cap (90%) or has reached it;
- a task failed or timed out;
- a connection turned red or yellow (and when it works again);
- a run failed, was stopped by the budget or was interrupted.

A separate watchdog, `orchestra-ctl watch`, is run by launchd once a minute, independently of the service. If the service fails to answer twice in a row, it restarts the service and tells you. It does not bring the service back after `Orchestra-stop.command`. It also warns when statistics collection has stopped. `orchestra-ctl restart` does not restart the service while worker tasks are running; `--force` restarts at once, while `--when-idle` waits until the service is free (up to 120 minutes by default, set with `--timeout-min=N`) and then restarts; if the wait runs out it does not restart and exits with code 3.

**Where alerts show up.** A bell in the panel header with a counter of unread alerts and a list; a pop-up message; a macOS notification (errors only by default); optionally a request to a `webhook` address (works with ntfy.sh). The list is kept in `alerts.json` next to the settings, so a problem that happened while you were away is not lost.

**Automatic retry.** A task that failed or timed out is restarted on another suitable worker (the cheapest one not tried yet), up to three times. The run journal shows «Auto-retry 1/3», and the orchestrator does not delegate such a task again but waits for the new one. If three retries do not help, Orchestra stops the task and the orchestrator asks you a question: what happened, what was tried and what to do next (retry on a worker you name, rewrite the brief, do it yourself, put it off). Stops caused by a cap or a budget are not retried.

Settings in `config.json`: `autoRetry` (the number of retries, 3 by default, 0 turns it off) and `notify`: `macos` (true/false), `macosLevel` (`warn` or `error`), `silentMinutes` (8 by default), `taskCostWarnUsd` (1 by default, 0 turns it off), `unmergedWarnMinutes` (60 by default, 0 turns it off), `webhook` (an address or empty).

## 10. English mode: preparing the environment

Orchestra's interface and the whole workflow can run in English. This section is in English on purpose: it is what you follow after switching.

**1. Switch the language.** Press the `RU` button in the panel header (it becomes `EN`). The interface is translated automatically. The choice is also saved in the service settings (`language`), so the models write plans, briefs and reports in English, and project memory (journal, digests, hook messages) follows. Anything already written (run goals, logs, old journal entries) stays as it was.

**2. Update the projects.** The rules Orchestra puts into a project's `CLAUDE.md` / `AGENTS.md`, the `/orchestra` command and the wiki starter pages exist in both languages. After switching, open **Diagnostics**. Projects whose rules are in the other language show as outdated. Apply the update, or run `orchestra-memory init` inside the project. To pin a project to one language regardless of the switch, run `orchestra-memory init --lang en` (or `ru`). The setting is saved as `language` in `.memory/config.json`.

**3. Karpathy's principles (global).** Diagnostics also shows «Karpathy's principles» for `~/.claude/CLAUDE.md`. Apply it once. It writes the four principles (think before coding, simplicity first, surgical changes, goal-driven) in the current language, between markers, and leaves the rest of the file untouched. The same principles are in every project's rules block.

**4. RTK (shorter command output, fewer tokens).** RTK condenses shell output before the model reads it. In our use it saved about 90% of the tokens spent on command output.
```
brew install rtk       # or see https://www.rtk-ai.app/
rtk init -g            # adds the hook and RTK.md to ~/.claude (Claude Code)
rtk --version && rtk gain
```
Diagnostics shows «RTK» as green when the hook is enabled. Orchestra copies the hook to its workers automatically, so their output is condensed too. The project rules tell agents what to do when RTK output looks wrong (`rtk proxy <cmd>` for the raw result).

**5. Owner phrases.** Hooks recognise two phrases in any project, in English or Russian: **«approve the brief»** (approves the latest complete brief of `/orchestra`) and **«allow prod»** (opens a short production window; «revoke prod» closes it). Agents cannot create these approvals themselves.
