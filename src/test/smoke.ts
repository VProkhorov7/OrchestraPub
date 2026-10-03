/**
 * End-to-end smoke test without Electron, network or real keys:
 *  - a fake `claude` binary that emits stream-json and edits a file
 *  - a fake Anthropic API server that plays a scripted orchestrator
 *  - a real temporary git repo
 * Covers: role check, plan, worker env, merge, spend from provider prices, prompt caching, run persistence.
 * Run: npm run smoke
 */
import * as fs from 'fs';
import * as path from 'path';
import { Orchestrator } from '../main/orchestrator';
import { RunStore } from '../main/runs';
import { AppConfig } from '../main/types';
import { tmpdir, sh, makeRepo, makeFakeClaude, fakeApi, toolUse, check, testConfig } from './helpers';
// Worker cost depends on the time of day (DeepSeek off-peak is half price): fix the clock at a peak hour.
process.env.ORCHESTRA_NOW = '2026-09-28T02:00:00Z';

(async () => {
  const tmp = tmpdir('orch-smoke-');
  const repo = makeRepo(tmp);
  const api = await fakeApi([
    // wrong role for deepseek (it only has tests/refactor/docs) -> must be rejected, then retry with allowed role
    toolUse('x0', 'delegate', { provider: 'deepseek', role: 'feature', title: 'Wrong', spec: 'x' }),
    toolUse('x1', 'delegate', { provider: 'deepseek', role: 'docs', title: 'Edit hello', spec: 'Change hello.txt' }, 'Delegating.'),
    toolUse('x2', 'wait_for', {}),
    toolUse('x3', 'merge_task', { task_id: 't01' }),
    toolUse('x4', 'run_command', { command: 'cat hello.txt' }),
    toolUse('x5', 'finish', { report: 'Merged t01.' }),
  ]);

  const cfg: AppConfig = testConfig(makeFakeClaude(tmp));
  const store = new RunStore(path.join(tmp, 'runs'));
  const events: string[] = [];
  const plan = { summary: 'план', tasks: [{ id: 'p1', title: 'Edit hello', role: 'docs', providerId: 'deepseek', spec: 'Change hello.txt', dependsOn: [], reason: 'дёшево' }] };
  const orch = new Orchestrator(cfg, path.join(tmp, 'wt'), repo, 'Change hello.txt', (ev) => {
    if (ev.type === 'transcript') events.push(`${ev.entry.kind}: ${ev.entry.text.split('\n')[0]}`);
    if (ev.type === 'task') events.push(`task ${ev.task.id} ${ev.task.status}`);
  }, plan, store);
  await orch.start();
  api.close();

  console.log(events.join('\n'));
  const final = fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8');
  const log = sh('git', ['log', '--oneline'], repo);
  const worktrees = sh('git', ['worktree', 'list'], repo);
  const t = orch.state.tasks[0];
  check(orch.state.status === 'done', 'run status done, got ' + orch.state.status);
  check(final.includes('hello from deepseek-v4-pro via https://api.deepseek.com/anthropic'), 'worker env + merge, got: ' + final);
  check(/Merge orch\/\w+-t01-edit-hello/.test(log), 'merge commit present, branch name includes run id: ' + log);
  check(!worktrees.includes('t01'), 'worktree cleaned up');
  check(t.status === 'merged', 'task merged');
  check(orch.state.finalReport === 'Merged t01.', 'final report');
  check(events.some((e) => e.includes('not allowed to take role "feature"')), 'role check rejects wrong role');
  check(orch.state.tasks.length === 1 && t.role === 'docs', 'only the allowed task was created, with role');
  check(Math.abs((t.costUsd ?? 0) - 0.1716) < 1e-6 && !t.costEstimated, `worker cost from DeepSeek prices, deduped by message id: ${t.costUsd}`);
  check(t.tokensIn === 100000 && t.tokensOut === 10000, 'token counts');

  const req = api.requests[1];
  check(req.system?.[0]?.cache_control?.type === 'ephemeral', 'system prompt is cached');
  const lastMsg = req.messages[req.messages.length - 1];
  check(lastMsg.content[lastMsg.content.length - 1].cache_control?.type === 'ephemeral', 'conversation tail is cached');
  const cachedBlocks = JSON.stringify(req.messages).split('cache_control').length - 1;
  check(cachedBlocks === 1, 'exactly one breakpoint in messages, got ' + cachedBlocks);
  check(JSON.stringify(api.requests[0].messages[0]).includes('The human approved this plan'), 'plan passed to orchestrator');

  store.flush();
  const saved = store.load(orch.state.runId);
  check(saved.state.status === 'done' && saved.messages.length === 13, `run saved with conversation (${saved.messages.length} messages)`);
  const list = store.list();
  check(list.length === 1 && list[0].merged === 1 && !list[0].resumable, 'history lists the run');

  console.log('\nSMOKE OK', tmp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
