/** English versions of the text blocks `orchestra-memory init` writes (see templates.ts for the Russian originals). */
import { RULES_START, RULES_END, GLOBAL_START, GLOBAL_END, COMMAND_MARK } from './markers';

export const AGENT_RULES_EN = `${RULES_START}
## Project memory, wiki and logs (mandatory)

This repository has a project memory. Every agent keeps it up to date, in every session.

**New task.** If the owner writes \`/orchestra <task>\`, follow that command: memory → brief → approval → Orchestra or do it yourself. If a big task comes without it, offer to set it up through \`/orchestra\`.

**Before a task.** Run \`orchestra-memory context "<gist of the task>"\` (or the MCP tool \`memory_context\`). It returns facts (what is already known and done) and decisions (why things are the way they are). Do not redo finished work. Do not silently break a recorded decision: if one has to change, record a new one with the reason (\`--supersedes D-xxxx\`).

**While working.**
- A newly established fact: \`orchestra-memory add-fact "<fact>" --tags a,b --files path\`.
- A decision: \`orchestra-memory add-decision --title "…" --decision "…" --why "…" [--alt "rejected option"] [--files …] [--facts F-0001]\`.
- A notable action (feature, fix, tests, deploy, security): \`orchestra-memory log --type feature|fix|change|security|test|deploy|docs|note --files … "<what was done>"\`. File edits and commands are logged automatically.
- **wiki** (\`wiki/\`): update the pages the change touches (architecture, API, decisions, project status). Code without a wiki update is unfinished.

**Micro-session = 30–40 minutes.** When the hook says time is up, or the task is done, close the session:
\`\`\`
orchestra-memory session-end --summary "<2–3 plain sentences for the owner>" \\
  --done "<item>" --done "<item>" --why "<why it is this way>" \\
  --gate "<mandatory before the next task>" (at most three) --next "<exactly one next task>" \\
  --details '<JSON with details for AI: files, commands, test results, open questions>'
\`\`\`
This produces two records: a short human one in \`wiki/JOURNAL.md\` and a detailed JSON one in \`.memory/log/\`. At most three mandatory items and exactly one next task: what matters drowns in long lists; the rest goes as a link in \`wiki/status/current.md\`.

**Journal with the «why».** \`orchestra-memory log\` for feature, fix, change, security, deploy, refactor, removed requires \`--why\`. A manual data cleanup that leaves the cause in place is type \`cleanup\`, not \`fix\`: otherwise the next recurrence reads as «we already fixed this».

**Invariants.** \`wiki/INVARIANTS.md\` lists what must never become false. Check every change against it. A test that guards an invariant is ready only when it turns red if exactly that spot is deliberately broken.

**Production.** Deploys, commands with \`--remote\`, worker secrets, workflow runs, and a push that deploys to production are stopped by the prod guard (a hook). Do not bypass it: explain to the owner what the command will do and ask them to write «allow prod».

**Roles.** For code reconnaissance use the \`scout\` role (cheap model, read-only), for applying a ready plan \`applier\`, for checking a diff \`reviewer\`. Do not use an expensive model for mechanical work.

**CHANGELOG.** After a stage is finished or when the owner asks: \`orchestra-memory changelog --draft\` shows the significant events since last time. Write a short digest for people grouped by Added / Changed / Fixed / Security / Removed, without small technical details, and save it: \`orchestra-memory changelog --write <file.md>\` (or \`--release "<stage>"\`).

**«Give me a fresh digest».** Run \`orchestra-memory digest\` and retell the latest records briefly in English: what was done, what was decided, what is next.

**Commit and push.** Memory (\`.memory/\`), \`wiki/\` and \`CHANGELOG.md\` are added to every commit by a git hook. If \`git push\` stops with «memory was appended as a separate commit», just repeat the push. Or use \`orchestra-memory push\` right away.

**Command output (RTK).** If \`rtk\` is installed, shell output in this session is condensed automatically to save tokens; treat it as the complete result. Re-run a command as \`rtk proxy <cmd>\` only when its result is unusable: empty when output was clearly expected, contradicting its exit code, or garbled. Batch related commands into one call.

**How to work (these rules come last on purpose: in the middle of a long text a rule stops working).**
- **Think before coding.** Analyse any request, even a complaint, out loud first: the gist, your opinion with a number if you have one, a question if something is unclear. State your assumptions; if the task can be understood in several ways, show the options instead of silently picking one. Then do it. Agreement is also a position: say what you agree with and why.
- **Simplicity first.** Nothing beyond what was asked: no «for the future», no abstractions for a single use, no needless error handling. If 200 lines could be 50, rewrite.
- **Surgical changes.** Touch only what the task needs. Do not improve neighbouring code or formatting unasked; keep the file's style. Remove only what became unused because of your own changes.
- **Goal-driven.** Turn the task into verifiable success criteria and a short plan with checkpoints; work until the criteria are met and checked.
- **Cure the cause with the design, not with a promise.** Signs of a crutch: a fix in one of several places, «I will be more careful», «for now». Build it so the mistake is impossible.
- **«Done» only with a fact.** Existing is not working: green tests and a line in a config do not prove it ever ran. Quote a command's output, a site's response or a database record.
- **Honest report.** «Not run», «skipped», «failed»: say it plainly, with the output, no softening.
- **Irreversible: ask the owner.** Do reversible things yourself in small steps and check each before the next.
${RULES_END}
`;

export const GLOBAL_RULES_EN = `${GLOBAL_START}
## How to write code (Karpathy's principles, for all projects)

1. **Think before coding.** State your assumptions. If the task can be understood in different ways, show the options; do not choose silently. If there is a simpler way, say so. If something is unclear, stop and ask.
2. **Simplicity first.** Nothing beyond what was asked: no «for the future», no abstractions for a single use, no needless error handling. 200 lines that could be 50 get rewritten.
3. **Surgical changes.** Touch only what is needed. Do not improve neighbouring code or formatting unasked; keep the file's style. Remove only what became unused because of your own changes.
4. **Goal-driven.** Turn the task into verifiable success criteria and a short plan with checkpoints; work until the criteria are met and checked. «Done» only with a fact: command output, a response, a record.

Reports to the owner: in English, in plain words. Production, migrations and secrets only after their explicit «yes».
${GLOBAL_END}
`;

export const GIT_HOOK_COMMENT_EN = `# orchestra-memory: project memory and the wiki go to git with every commit.
# The previous hook from .git/hooks runs first, if there was one.`;
export const GIT_HOOK_PATH_COMMENT_EN = '# Apps started from the Dock (Orca, GUI git clients) get a trimmed PATH.';

export const ORCHESTRA_COMMAND_EN = `---
description: Set a task up in order: project memory, brief, approval, then Orchestra or yourself
argument-hint: <what needs to be done>
---
${COMMAND_MARK}
The owner's task: $ARGUMENTS

Work strictly step by step. The owner is not a programmer: write in English, in plain words.

## 1. What is already known
- Read the project memory on the task's topic: the \`memory_context\` tool (if Orchestra is connected) or \`orchestra-memory context "<gist of the task>"\` in a terminal.
- Read \`wiki/status/current.md\`, \`wiki/INVARIANTS.md\` and the wiki pages that touch the task.
- Look at the code just enough to see where the changes will be. Change nothing.
- If the task is already done or contradicts a recorded decision, say so and stop.

## 2. Brief
Write a brief, **save it as a file** \`.memory/briefs/<YYYY-MM-DD>-<short-latin-name>.md\` (a plan that lives only in the conversation disappears with \`/clear\`) and show it to the owner in full. The sections are exactly these headings:

**Goal**: one or two sentences: what should result for a person.
**What is already known**: facts and decisions from memory that matter (with their F-… and D-… numbers).
**Boundaries**: what we do not touch; production, migrations, live flags and secrets do not change without an explicit «yes».
**Subtasks**: a numbered list. For each: what to do, which files, the role (feature, bugfix, tests, refactor, docs), which subtasks it depends on. The last subtask is updating the wiki.
**Done when**: verifiable criteria.
**How to verify**: test commands and what to look at with your own eyes.
**Questions**: what the owner has to decide (if none, «none»).

The brief must not contain TODO, TBD, «clarify later». Check it: \`orchestra-memory brief check <file>\` says what is missing.

## 3. Approval
Ask: «Do you approve the brief? And how do we proceed: A: hand it to the workers through Orchestra, I review and merge; B: give it to Orchestra entirely (autopilot); C: I do it myself in this session».
If Orchestra's tools are not there (\`list_workers\`, \`autopilot_start\`), offer only C and say Orchestra is off (turn it on: Orchestra.command → item 1).
**Do not start until the owner has answered explicitly.** The approval is recorded by a hook when the owner writes «approve the brief» (or «I approve the brief»); it is bound to the version of the brief file. If you change the brief after approval, the approval is reset: show what changed and ask again. Before executing, \`orchestra-memory brief check <file>\` must say «approved».

## 4. Execution
- **A.** \`list_workers\` → for each subtask \`delegate\` (spec = the subtask + goal + boundaries + invariants + «done when» from the brief; a suitable role and worker) → \`wait_for\` → \`get_diff\` → check against the criteria → \`merge_task\` or \`discard_task\` with an explanation. Tests after the merges. Finally \`end_session\`.
- **B.** \`autopilot_start\` with the goal = the whole brief; then \`run_status\` until it finishes. If it asks to confirm the model, show the owner the recommendation.
- **C.** Do the subtasks in order, check after each. Give reconnaissance to the \`scout\` role and diff checks to \`reviewer\`.
- After each finished subtask tick it in the brief file (\`- [x]\`) so the work survives a broken session.

## 5. Result
- A report for the owner: 2–3 sentences of what was done, then «Done:» and «Next:» as lists.
- New facts: \`memory_add_fact\` / \`orchestra-memory add-fact\`; new decisions with the reason: \`memory_add_decision\` / \`orchestra-memory add-decision\`.
- Update \`wiki/status/current.md\`.
- Close the micro-session: \`memory_session_end\` / \`orchestra-memory session-end --summary "…" --done "…" --gate "…" --next "<one task>"\`.
`;

export const INVARIANTS_TEMPLATE_EN = (project: string) => `# Invariants: ${project}

What must **never** become false. Agents check every change against this list, Orchestra gives it to every worker and checks the diff against it before merging.

How to write: one line, one statement «never …» or «always …»; in brackets, what checks it (a test, a hook, CI). A test that guards an invariant is ready only when it turns red if exactly that spot is deliberately broken. Changing or removing an invariant is done only by a decision with a reason (\`orchestra-memory add-decision\`).

- Production changes only after the owner's explicit permission (the prod guard).
- Secrets never go into code, wiki or memory, only their names.
- Database migrations are only added; an applied migration is not edited (a new migration instead).
<!-- Add your own: for example, «no protected path returns data without sign-in and an accepted NDA» (test …). -->
`;
