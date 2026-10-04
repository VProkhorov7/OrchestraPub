/**
 * Per-task spend cap by role: the task is stopped, its partial work is kept (not retried, not lost),
 * and a new task can continue from its branch. Run: as a step of `npm run smoke`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TaskEngine } from '../main/engine';
import { RunState } from '../main/types';
import { makeFakeClaude, makeRepo, testConfig, tmpdir, check } from './helpers';

(async () => {
  const tmp = tmpdir('orch-taskcap-');
  const claudePath = makeFakeClaude(tmp);
  fs.mkdirSync(path.join(tmp, 'r'), { recursive: true });
  const repo = makeRepo(path.join(tmp, 'r'));
  const state: RunState = { runId: 'mcp-cap', source: 'mcp', repo, baseBranch: 'main', goal: 'cap', status: 'running', tasks: [], transcript: [], budgetUsd: 0, startedAt: Date.now(), pid: process.pid };
  const e = new TaskEngine(testConfig(claudePath, { language: 'en', taskCapUsd: { refactor: 0.01 } }), path.join(tmp, 'wt'), state, () => {});
  const settle = async (want: () => boolean, ms = 60_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms && !want()) await new Promise((r) => setTimeout(r, 200));
  };

  // the fake worker reports ~$0.05 and then sits for 5 s: over the $0.01 cap for its role
  process.env.FAKE_SLOW_MS = '5000';
  e.delegate({ provider: 'deepseek', role: 'refactor', title: 'Edit hello', spec: 'Change hello.txt' });
  await settle(() => e.state.tasks.some((t) => t.status === 'failed'));
  const t1 = e.state.tasks[0];
  check(t1.status === 'failed' && t1.capped === true && /превышен лимит задачи/.test(t1.error ?? ''), `stopped at the role cap: ${t1.status} ${t1.error}`);
  await new Promise((r) => setTimeout(r, 800));
  check(e.state.tasks.length === 1, 'a capped task is not retried');
  check(/STOPPED AT A SPEND CAP/.test(e.briefStatus(t1)) && /continue_from="t01"/.test(e.briefStatus(t1)), 'the orchestrator is told to keep and continue it');

  // continue it with another role (no tight cap): starts from the first branch and finishes
  delete process.env.FAKE_SLOW_MS;
  let threw = '';
  try { e.delegate({ provider: 'deepseek', role: 'docs', title: 'x', spec: 'y', continueFrom: 'nope' }); } catch (x: any) { threw = x.message; }
  check(/nope/.test(threw), 'continuing an unknown task is refused');
  e.delegate({ provider: 'deepseek', role: 'docs', title: 'Edit hello (continued)', spec: 'Change hello.txt', continueFrom: 't01' });
  await settle(() => e.state.tasks.length === 2 && e.state.tasks[1].status === 'done');
  const t2 = e.state.tasks[1];
  check(t2.continuedFrom === 't01' && t2.status === 'done', `the continuation runs and finishes: ${t2.status}`);
  check(/CONTINUATION/.test(t2.spec) && /Change hello\.txt/.test(t2.spec), 'its brief says it is a continuation and keeps the task');
  console.log('SMOKE-TASKCAP OK');
})();
