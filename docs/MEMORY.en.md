# Project memory: wiki, facts, decisions, journal

**English** · [Русский](MEMORY.md)

Since version 0.6, every repository can have its own memory. It lives in the repository and goes into git with the code, so it is equally available on the Mac mini, on the MacBook through Orca, in any AI agent and in Orchestra.

## What it consists of

| Where | For whom | Contents |
|---|---|---|
| `wiki/` | people | Project description: how it is built, how to run it, how to deploy it. Updated together with the code. |
| `wiki/JOURNAL.md` | you | Micro-session journal: a short note, in Russian, on what was done, why, and what comes next. Newest entries first. |
| `CHANGELOG.md` | people | Summary by stage in Keep a Changelog format: Added, Changed, Fixed, Security, Removed. |
| `.memory/facts.json` | AI | Fact base: what has already been established (`F-0001` onwards), with tags and files. |
| `.memory/logic.json` | AI | Logic base: decisions (`D-0001`…), the reason for each, what was rejected and the consequences. A new decision can supersede an old one. |
| `.memory/log/YYYY-MM.jsonl` | AI | Detailed log of all actions: date, type, author, files, description, details. |
| `.memory/config.json` | settings | Wiki folder, micro-session length (35 minutes), strict mode. |

If the project already has a `wiki`, `Wiki`, `docs/wiki` or `docs` folder, memory uses it instead of creating a new one.

## How it works

**Before a task.** The agent checks memory: what has already been found and done on the topic (facts, log), and then why it was done that way (decisions). In Claude Code this happens automatically: a hook on every message adds the relevant facts and decisions. Orchestra adds memory to the task for the orchestrator, the planner and each worker.

**During work.** Every file change and every significant command goes into the JSON log. The agent records new facts and decisions itself (`add-fact`, `add-decision`).

**Micro-session (30–40 minutes).** When time is nearly up, the agent gets a reminder and closes the session. One command writes two entries: a readable one in `wiki/JOURNAL.md` and a detailed one in `.memory/log/`. If the session is left open, the Claude Code end-of-session hook or the next commit closes it, and the entry is marked as automatic. A run of Orchestra also counts as a micro-session: the orchestrator's final report becomes a journal entry.

**Commit and push.** The `pre-commit` git hook adds `.memory/`, `wiki/` and `CHANGELOG.md` to every commit and writes a "commit" event to the log. If unsaved memory is left before `git push`, the `pre-push` hook commits it separately and asks you to push again. The `orchestra-memory push` command does all of this in one step. It works from the terminal, from Orca and from any GUI git client, because the hooks live in the repository (`.githooks/`).

**Wiki.** If the code has changed but the wiki has not, a warning appears when the session is closed and on commit. In strict mode (`"requireWiki": true` in `.memory/config.json`), such a commit is rejected.

**Digests.** Ask the agent in Claude Code for a fresh digest, or press "Fresh digest" in Orchestra, to get a short summary of the latest log entries. At the end of a stage, the "Stage CHANGELOG" button (or `orchestra-memory changelog --draft`, then `--write`) builds entries for `CHANGELOG.md` from the log, leaving out minor technical details. Orchestra does this with the cheapest working model. Without a model, it builds the digest from the log as it is, with no processing.

## The /orchestra command

`init` installs the Claude Code command `/orchestra` in the project (`.claude/commands/orchestra.md`). It sets the order for taking on a task: project memory, then the brief (goal, boundaries, subtasks, acceptance criteria, verification), then your approval, then execution through Orchestra (hand out to workers, or autopilot) or by Claude itself, and finally a report and a memory entry. If the project already has its own file with this name, it is left alone.

## Protection and order (since version 0.7.1)

These techniques come from colleagues' practice and from Skaro. They are built into the mechanism rather than left as a written rule:

| What | How it works | What the owner does |
|---|---|---|
| **Prod guard** | A hook before every agent command stops `wrangler deploy`, commands with `--remote`, `wrangler secret put`, writes to production KV/R2, `npm run deploy`, `gh workflow run`, a forced push and, where a push to `main` publishes the site (site-b), a push to `main`. The agent explains what the command will do and asks for permission. Orchestra workers never have access to prod: they have no Cloudflare or GitHub keys, and the guard blocks them even if permission is given | Writes "allow prod", which opens a 20-minute window for this project. "Deny prod" closes it sooner. Settings: `.memory/config.json` → `prodGuard` |
| **Brief with approval** | `/orchestra` saves the brief to `.memory/briefs/`. `orchestra-memory brief check` verifies that all seven sections are present and that no TODOs remain. Approval is tied to the file version: if you change the brief, the approval is reset. Ticking off completed subtasks (`- [x]`) does not count as a change | Writes "approve". The agent cannot approve its own brief: the guard protects the approvals file |
| **Invariants** | `wiki/INVARIANTS.md` lists what must never become untrue. Every worker receives it, and the orchestrator and the `reviewer` role check the diff against it | Adds their own "never …" lines |
| **Roles** | `.claude/agents/`: `scout` (reconnaissance, cheap model, read-only), `applier` (applies a ready plan), `reviewer` (diff review). Mechanical work does not use up the expensive model's limit | After installing the roles, restart `claude` |
| **"Why" in the journal** | `orchestra-memory log` requires `--why` for feature, fix, change, security, deploy, refactor and removed. Manual data cleanup that does not remove the cause has the type `cleanup` and does not go into CHANGELOG | — |
| **Shift handoff** | `session-end` takes at most three mandatory items (`--gate`) and exactly one next task (`--next`). The journal gets a checklist and a "Next task" | — |
| **Worker report** | Four parts: DONE, WHY, RISKS, VERIFY. "Tests exist" is not verification: the report must say what was actually run | — |
| **Karpathy's principles** | Think before coding (state assumptions aloud, offer options instead of choosing silently), keep it simple, make surgical edits, work from a verifiable goal. They appear in the project rules, in the workers' task and, through diagnostics, in `~/.claude/CLAUDE.md` for all projects | Nothing. To undo the global block, use "Undo last" in diagnostics |
| **RTK** | If [RTK](https://www.rtk-ai.app/) is installed, diagnostics shows the savings and Orchestra workers get its hook | `brew install rtk-ai/tap/rtk && rtk init --global` |
| **Time** | With every message the agent receives the machine's real time and how long the micro-session has been running | — |

## Installation

On every computer where you work with code (Mac mini, MacBook), once:

```bash
cd ~/path/to/orchestra
npm install && npm run build
npm link          # the commands orchestra-mcp, orchestra-serve and orchestra-memory become available everywhere
```

**Memory sets itself up.** The first time Orchestra touches a repository or a branch without `.memory/` (a run from the panel, an MCP session, a memory tool, the `orchestra-memory` command, a Claude Code hook, choosing the repository in the panel), it creates the memory with no `init`: `.memory/`, the wiki, the rules in `CLAUDE.md` and `AGENTS.md`, the hooks and the `/orchestra` command. Nothing is overwritten. The files go into one small commit at once (a run refuses to start in a repository with uncommitted changes); if your own uncommitted edits are in those files, no commit is made. If a branch has no memory but `main` or `master` does, the files are taken from there, so two branches do not create different copies and conflict when merged. To switch it off: `autoMemory: false` in the service settings, the `ORCHESTRA_NO_AUTOMEMORY` variable, or an empty file `.orchestra-no-memory` in the repository.

By hand (if automatic creation is off, or to set the project name and language), once in the project:

```bash
cd ~/Developer/data-c
orchestra-memory init --project "data-c"
git add -A && git commit -m "Project memory"
```

`init` can be run again safely: it overwrites nothing. It creates `.memory/`, the journal and CHANGELOG, appends rules to `CLAUDE.md` and `AGENTS.md` (between the `orchestra-memory` markers), adds hooks to `.claude/settings.json` and enables `.githooks/`. The "Enable memory" button in Orchestra does the same.

Claude Code, Codex and agents in Orca terminals all read the rules in `CLAUDE.md` and `AGENTS.md`, so they maintain memory even without Orchestra.

After cloning the repository on another computer, run `git config core.hooksPath .githooks` once (or run `orchestra-memory init` again), because git does not carry this setting over.

## Commands

```text
orchestra-memory context "task"        what is known and decided on the topic
orchestra-memory search "words"         search facts, decisions and the log
orchestra-memory add-fact "text" --tags a,b --files f
orchestra-memory add-decision --title "…" --decision "…" --why "…" --alt "…"
orchestra-memory log --type fix "description" --files f
orchestra-memory session-end --summary "…" --done "…" --why "…" --next "…"
orchestra-memory digest                  a fresh digest of the log
orchestra-memory changelog --draft       what will go into the CHANGELOG
orchestra-memory changelog --write draft.md [--release "0.2"]
orchestra-memory status
orchestra-memory push                    memory + git push
```

All commands accept `--repo <path>`. The author is detected automatically (claude-code, codex, or the name from git). You can override it with `--author` or the `ORCHESTRA_AUTHOR` variable.

## Working in Orchestra

In the panel below the repository selector there is a "Memory" block. It shows how many facts and decisions there are and whether a session is open, and it has the buttons "Enable memory", "Fresh digest" and "Stage CHANGELOG". Every run keeps a log automatically: worker tasks, merges with their type (feature, fix, docs…), rejections and errors. The orchestrator receives the tools `memory_search`, `memory_add_fact` and `memory_add_decision`, and a rule: before finishing, tell a worker to update the wiki. After a run, Orchestra commits memory in a separate commit, `chore(memory): …`.

Workers do not write to memory and do not run hooks. Orchestra writes on their behalf, and the worktree does not need memory changes.

The Orchestra MCP server (`orchestra-mcp --repo …`, and `orchestra-serve` with `?repo=` in the address) gives any agent the tools `memory_context`, `memory_search`, `memory_add_fact`, `memory_add_decision`, `memory_log`, `memory_session_end`, `memory_digest`, `memory_fresh_digest`, `changelog_draft` and `changelog_write`.
