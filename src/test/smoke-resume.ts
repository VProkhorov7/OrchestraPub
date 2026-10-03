/**
 * Two scenarios:
 *  1. Resume: a run saved as "running" with a worker mid-task (worktree has uncommitted edits) and the
 *     orchestrator waiting on wait_for. After markInterrupted + resume, the partial work is committed and
 *     reviewable, the dangling tool call is answered, and the orchestrator can merge and finish.
 *  2. Budget: a worker costs more than the run budget → workers stop, further delegate is refused,
 *     the orchestrator is told BUDGET EXHAUSTED and finishes.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Orchestrator } from '../main/orchestrator';
import { RunStore } from '../main/runs';
import { AppConfig, RunState } from '../main/types';
import * as git from '../main/git';
import { tmpdir, sh, makeRepo, makeFakeClaude, fakeApi, toolUse, check, testConfig } from './helpers';

async function resumeScenario() {
  const tmp = tmpdir('orch-resume-');
  const repo = makeRepo(tmp);
  const wtRoot = path.join(tmp, 'wt');
  const runId = 'run-old1';
  const branch = 'orch/old1-t01-edit-hello';
  const worktree = path.join(wtRoot, runId, 't01');
  const baseSha = await git.createWorktree(repo, worktree, branch);
  fs.writeFileSync(path.join(worktree, 'hello.txt'), 'half-done work\n'); // uncommitted, as a killed worker leaves it

  const state: RunState = {
    runId, source: 'app', repo, baseBranch: 'main', goal: 'Change hello.txt', status: 'running',
    startedAt: Date.now() - 60_000, transcript: [], orchestratorCostUsd: 0.1,
    tasks: [{
      id: 't01', title: 'Edit hello', providerId: 'deepseek', model: 'deepseek-v4-pro', spec: 'Change hello.txt', role: 'docs',
      status: 'running', branch, worktree, baseSha, createdAt: Date.now() - 50_000, startedAt: Date.now() - 50_000, log: [],
    }],
  };
  const messages = [
    { role: 'user', content: 'Goal:\nChange hello.txt' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'old1', name: 'delegate', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old1', content: 'started t01' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'old2', name: 'wait_for', input: {} }] },
  ];
  const store = new RunStore(path.join(tmp, 'runs'));
  store.write({ version: 1, state, messages, savedAt: Date.now() });

  const fixed = store.markInterrupted();
  check(fixed.length === 1 && store.load(runId).state.status === 'interrupted', 'stale running run marked interrupted');
  check(store.list()[0].resumable, 'interrupted run is resumable');

  const api = await fakeApi([
    toolUse('n1', 'get_diff', { task_id: 't01' }),
    toolUse('n2', 'merge_task', { task_id: 't01' }),
    toolUse('n3', 'finish', { report: 'Resumed and merged.' }),
  ]);
  const cfg: AppConfig = testConfig(makeFakeClaude(tmp));
  const orch = Orchestrator.resume(cfg, wtRoot, store.load(runId), () => {}, store);
  await orch.start();
  api.close();

  const first = api.requests[0];
  const tail = first.messages[first.messages.length - 1];
  check(tail.role === 'user' && tail.content[0].type === 'tool_result' && tail.content[0].tool_use_id === 'old2', 'dangling wait_for answered');
  check(JSON.stringify(tail).includes('resumed by the human'), 'resume note sent');
  check(JSON.stringify(tail).includes('partial diff is available'), 'orchestrator told about the partial diff');
  check(first.messages.length === 5, 'history kept');
  check(orch.state.status === 'done' && orch.state.tasks[0].status === 'merged', 'resumed run merged the salvaged task: ' + orch.state.status);
  check(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8') === 'half-done work\n', 'partial work merged');
  check((orch.state.orchestratorCostUsd ?? 0) > 0.1, 'cost continues from the saved value');
  store.flush();
  check(store.load(runId).state.status === 'done', 'saved as done');
  console.log('resume OK');
}

async function budgetScenario() {
  const tmp = tmpdir('orch-budget-');
  const repo = makeRepo(tmp);
  const api = await fakeApi([
    toolUse('b1', 'delegate', { provider: 'glm', role: 'feature', title: 'Edit hello', spec: 'Change hello.txt' }),
    toolUse('b2', 'wait_for', {}),
    toolUse('b3', 'delegate', { provider: 'glm', role: 'feature', title: 'More', spec: 'More' }),
    toolUse('b4', 'finish', { report: 'Out of budget.' }),
  ]);
  // GLM run of the fake worker: 100k in * $1.4 + 10k out * $4.4 = $0.184 > $0.15 budget
  const cfg: AppConfig = testConfig(makeFakeClaude(tmp), { runBudgetUsd: 0.15 });
  const log: string[] = [];
  const orch = new Orchestrator(cfg, path.join(tmp, 'wt'), repo, 'x', (ev) => {
    if (ev.type === 'transcript') log.push(ev.entry.text);
  });
  await orch.start();
  api.close();

  check(Math.abs((orch.state.tasks[0].costUsd ?? 0) - 0.184) < 1e-6, 'glm cost ' + orch.state.tasks[0].costUsd);
  check(orch.engine.budgetExhausted, 'budget flagged exhausted');
  check(log.some((l) => l.includes('run budget exhausted')), 'second delegate refused');
  check(orch.state.tasks.length === 1, 'no second task created');
  check(JSON.stringify(api.requests[2].messages).includes('BUDGET EXHAUSTED'), 'orchestrator told to wrap up');
  check(orch.state.status === 'done' && orch.state.finalReport === 'Out of budget.', 'finished cleanly');
  check(sh('git', ['branch'], repo).includes('t01'), 'unmerged branch kept for the human');
  console.log('budget OK');
}

(async () => {
  await resumeScenario();
  await budgetScenario();
  console.log('\nSMOKE-RESUME OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
