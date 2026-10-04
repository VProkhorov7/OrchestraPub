# Orchestra

**English** · [Русский](README.ru.md)

**A strong model leads, cheap models write the code.** Orchestra puts Claude (or ChatGPT) in the role of lead engineer. It splits a task into parts, writes a detailed brief for each, hands them to cheap worker models (DeepSeek, GLM, Kimi, MiniMax, Qwen), reviews every diff and merges only what passed review into your repository.

```
you ── task ──▶ orchestrator (Claude / ChatGPT, on a subscription or an API key)
                  │ chooses who plans · makes the plan · hands out tasks
                  ▼
   ┌──────────────┬──────────────┬──────────────┐
   │ DeepSeek     │ GLM plan     │ Kimi …       │   each in its own git worktree and branch
   │ tests        │ feature      │ bugfix       │   (headless Claude Code)
   └──────┬───────┴──────┬───────┴──────┬───────┘
          ▼              ▼              ▼
   the orchestrator reads the diff → merges / discards / asks for a fix → runs the tests → report
```

## Why

- **Cheap.** The strong model plans and reviews, usually on a subscription, so you do not pay per token. The code is written by models that cost 10–50× less.
- **Safe for your repository.** Every task runs in its own worktree on its own branch. Only what the orchestrator has checked reaches the main branch, and on a conflict the branch is left intact.
- **Under control.** Each run has a budget and each worker a spend cap, enforced while a task is running rather than after it. Every connection has a traffic light, and the history of all runs lets you resume an interrupted one.

## Features

| | |
|---|---|
| **Overview** | The home tab shows one live pane per running project: status, workers, spend, the last line of work. You can follow several projects at once, and watching costs no tokens. |
| **Choice of planner** | For each task a cheap model rates the complexity and recommends who should plan: Claude Opus or Sonnet, ChatGPT, or an API. You approve or choose. |
| **Orchestrator on a subscription** | Claude Pro/Max through Claude Code, or ChatGPT through the Codex CLI, with no API key. The Claude API also works. |
| **Connections with a traffic light** | Added from a drop-down list. 🟢 working, 🟡 connected but out of money or over its limit, 🔴 not connected. The DeepSeek balance and subscription limits (through CodexBar) are shown. |
| **Worker roles** | Features, bugfixes, tests, refactoring, docs, review. Each worker is allowed its own roles. |
| **Budgets and caps** | A limit per run and per worker, with spend counted from real tokens and the provider's prices. Providers without published prices get a live estimate, so the cap still works. On subscriptions you see what the work would have cost at API prices. |
| **Off-peak scheduling** | Workers with time-of-day pricing (DeepSeek: half price outside peak hours, Chinese public holidays included) run together in the cheap window. In peak hours a task goes to a worker without such a tariff, or waits. A run can also be scheduled into the next cheap window. |
| **Free-only mode** | One button at the top: paid workers and the API-key orchestrator are switched off; local models, free tiers, OpenRouter's free models and already paid subscriptions stay. |
| **Local models** | Ollama, LM Studio, llama.cpp or vLLM as free workers on your own machine. Orchestra checks the server, the model and the context length (Claude Code needs 32K; Ollama defaults to 4K on a 16 GB Mac) and fixes it with one button. |
| **Watchdogs and alerts** | The service reports a silent worker, a lost worktree, a run near its budget, a failed task and a connection that went down: a bell in the panel, a macOS notification, an optional webhook. An external watchdog restarts the service if it stops answering. |
| **Automatic retry** | A failed task is restarted on another suitable worker up to three times; if that does not help, the orchestrator asks you what to do, with the history and the options. |
| **History** | Every run is saved. You can resume an interrupted run where it stopped, and merge or discard the branches of a saved run later. |
| **Service `orchestra serve`** | Web panel, MCP over HTTP for any AI client, and a JSON API. One service on a home server can be reached from a laptop over Tailscale. |
| **MCP** | Claude Code, Codex, Cursor and agents in Orca can direct Orchestra's workers themselves, or hand a whole task to the autopilot. |
| **Diagnostics and modes** | Checks the whole environment and switches between «Orca and Orchestra together», «Orca only» and «Orchestra only». It shows the changes first and allows an undo. |
| **Project memory** | Kept in every repository: a wiki for people, a journal of micro-sessions, a database of facts, a database of decisions with their reasons, a detailed JSON log and a CHANGELOG by stage. Before a task, agents see what was done and why. It sets itself up on first use of a repository or branch, with no `init`, and goes into git with every commit. See [docs/MEMORY.en.md](docs/MEMORY.en.md). |
| **English or Russian** | One button switches the interface (machine-translated) and the whole workflow: agent rules, the `/orchestra` command, wiki pages, journal, hook messages, and the models' plans and reports. It includes Karpathy's coding principles and RTK for shorter command output. |
| **Light and dark theme** | Follows the system, changes by time of day, or stays fixed. |

## Quick start

You need: macOS or Linux, Node.js 20+, git and [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`, signed in).

```bash
git clone https://github.com/VProkhorov7/OrchestraPub.git
cd Orchestra
npm install
npm start            # desktop app
# or
npm run serve        # service: web panel + MCP, the address and the token are printed to the console
```

Then open **Settings → Connections**. Add a Claude subscription for the orchestrator and at least one worker with a key, for example DeepSeek, and wait until both turn green. Then choose a repository, describe the task and press **Distribute automatically**.

Full guide (home-server install, connections, MCP, Orca, troubleshooting): **[docs/SETUP.en.md](docs/SETUP.en.md)**. Technical reference: **[docs/TECHNICAL.md](docs/TECHNICAL.md)**. All documents: **[docs/README.md](docs/README.md)**.

## Who can orchestrate, and with which models

The orchestrator can be **Claude Code** (a Claude Pro or Max subscription), the **Codex CLI** (a ChatGPT subscription, experimental), the **Claude API**, or any MCP client such as Cursor or an agent in Orca. The workers are headless Claude Code pointed at a cheap provider: DeepSeek (`deepseek-v4-pro`), GLM (`glm-5.3`), Kimi (`kimi-k3`), MiniMax (`MiniMax-M3`), Qwen (`qwen3-coder-plus`), OpenRouter, or any other Anthropic-compatible API. The full table with roles and prices is in [docs/SETUP.en.md](docs/SETUP.en.md#6-connecting-ai-agents-via-mcp).

## Connect an AI agent through MCP

```bash
# Claude Code in the project folder, the service on a Mac mini:
claude mcp add --transport http orchestra "http://mac-mini:7777/mcp?repo=$(pwd)" \
  --header "Authorization: Bearer <token>"
```

After that, you can tell the agent: *«Hand this task to Orchestra's workers, review their diffs and merge»* or *«Give the task to the Orchestra autopilot»*.

## If the orchestrator does not start

Check these in order:

1. The connection is on and its light is green (web panel, the connections section).
2. Claude is signed in: run `claude` and, if needed, `/login`.
3. At least one worker is available for delegation.

## Status

Version 0.7.5, a personal tool under active development. Every scenario is covered by automated tests (`npm run smoke`), in which subscriptions and models are replaced by stand-ins. Checks on real accounts are described in [HANDOFF.md](HANDOFF.md). Plans are in [ROADMAP.md](ROADMAP.md).

**Security:** workers run on your machine without permission prompts (in separate worktrees, but with shell access). Do not expose the service port to the internet; use localhost or Tailscale. Orchestra does not store or use subscription tokens; it launches the official `claude` and `codex` that you signed in to yourself.

## Licence

MIT
