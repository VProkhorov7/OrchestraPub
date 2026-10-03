/**
 * A provider that reports token usage only in the final result (z.ai GLM): the task must not look idle at $0 while it
 * works (a live estimate), the final usage replaces the estimate, and a task that is still active is not discarded by
 * mistake. Run: as a step of `npm run smoke`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TaskEngine } from '../main/engine';
import { AppConfig, RunState } from '../main/types';
import { makeFakeClaude, makeRepo, testConfig, tmpdir, check } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = tmpdir('orch-usage-');
  const claudePath = makeFakeClaude(tmp);
  const engineFor = (cfg: AppConfig, label: string): TaskEngine => {
    fs.mkdirSync(path.join(tmp, label), { recursive: true });
    const repo = makeRepo(path.join(tmp, label));
    const state: RunState = { runId: `mcp-${label}`, source: 'mcp', repo, baseBranch: 'main', goal: label, status: 'running', tasks: [], transcript: [], budgetUsd: 0, startedAt: Date.now(), pid: process.pid };
    return new TaskEngine(cfg, path.join(tmp, 'wt'), state, () => {});
  };

  process.env.FAKE_NO_USAGE = '1';
  process.env.FAKE_SLOW_MS = '2500';
  const e = engineFor(testConfig(claudePath, { language: 'en', autoRetry: 0 }), 'a');
  e.delegate({ provider: 'glm', role: 'feature', title: 'Edit hello', spec: 'Change hello.txt' });
  const t = e.state.tasks[0];
  let live: { in: number; cost: number; est: boolean } | null = null;
  for (let i = 0; i < 60 && t.status !== 'done' && !live; i++) {
    await sleep(100);
    if (t.status === 'running' && (t.tokensIn ?? 0) > 0) live = { in: t.tokensIn!, cost: t.costUsd ?? 0, est: !!t.costEstimated };
  }
  check(!!live && live.in > 10_000 && live.cost > 0 && live.est, `while running, usage is a live estimate, not 0: ${JSON.stringify(live)}`);
  check(/live estimate/.test(e.briefStatus(t)) && /last activity/.test(e.briefStatus(t)), 'the status line says the cost is an estimate and shows the last activity');

  // an active task is not discarded by mistake; force does it
  const refused = await e.discard({ task_id: t.id });
  check(/^REFUSED/.test(refused) && t.status === 'running', `discarding an active task is refused: ${refused.slice(0, 60)}`);

  // let it finish: the final usage replaces the estimate (fake final: 100000 in / 10000 out)
  const e2 = engineFor(testConfig(claudePath, { language: 'en', autoRetry: 0 }), 'b');
  e2.delegate({ provider: 'glm', role: 'feature', title: 'Edit hello', spec: 'Change hello.txt' });
  await e2.wait(['t01'], 60_000);
  const t2 = e2.state.tasks[0];
  check(t2.status === 'done' && t2.tokensIn === 100000 && t2.tokensOut === 10000 && !t2.costEstimated, `the final usage replaces the estimate: ${t2.status} in=${t2.tokensIn} out=${t2.tokensOut} est=${t2.costEstimated}`);

  const forced = await e.discard({ task_id: t.id, force: true });
  check(t.status === 'discarded' && !/REFUSED/.test(forced), 'force=true discards it');
  await sleep(4000);
  check(t.status === 'discarded', `and the worker finishing later does not bring it back as «failed»: ${t.status}`);

  delete process.env.FAKE_NO_USAGE;
  delete process.env.FAKE_SLOW_MS;
  console.log('SMOKE-USAGE OK');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
