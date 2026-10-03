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
