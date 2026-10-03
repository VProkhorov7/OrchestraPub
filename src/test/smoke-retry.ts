/**
 * Automatic retry: a failed task is restarted on another worker (up to 3 times), and when that does not help
 * the owner is asked a question with the history and options. Run: as a step of `npm run smoke`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TaskEngine } from '../main/engine';
import { AppConfig, RunState } from '../main/types';
import { makeFakeClaude, makeRepo, testConfig, tmpdir, check } from './helpers';

(async () => {
  const tmp = tmpdir('orch-retry-');
  const claudePath = makeFakeClaude(tmp);
  const wtRoot = path.join(tmp, 'wt');
  const engineFor = (cfg: AppConfig, label: string): TaskEngine => {
    fs.mkdirSync(path.join(tmp, label), { recursive: true });
    const repo = makeRepo(path.join(tmp, label));
    const state: RunState = { runId: `mcp-${label}`, source: 'mcp', repo, baseBranch: 'main', goal: label, status: 'running', tasks: [], transcript: [], budgetUsd: 0, startedAt: Date.now(), pid: process.pid };
    return new TaskEngine(cfg, wtRoot, state, () => {});
  };
  const settle = async (e: TaskEngine, want: (e: TaskEngine) => boolean, ms = 60_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms && !want(e)) await new Promise((r) => setTimeout(r, 200));
  };

  // (a) the first worker fails, the retry goes to the other one and succeeds
  process.env.FAKE_FAIL_URL = 'deepseek';
  {
    const e = engineFor(testConfig(claudePath, { language: 'en' }), 'a');
    e.delegate({ provider: 'deepseek', role: 'refactor', title: 'Edit hello', spec: 'Change hello.txt' });
    await settle(e, () => e.state.tasks.length >= 2 && e.state.tasks.every((t) => ['done', 'failed', 'merged'].includes(t.status)));
    const [t1, t2] = e.state.tasks;
    check(t1.status === 'failed' && t1.retriedAs === t2.id, `the failed task points to its retry: ${t1.status} → ${t1.retriedAs}`);
    check(t2.providerId !== 'deepseek' && t2.attempt === 2 && t2.retryOf === t1.id && t2.jobId === t1.id, `the retry runs on another worker (${t2.providerId}), attempt 2`);
    check(t2.status === 'done', `and it succeeds: ${t2.status}`);
    check(!t1.escalated && !t2.escalated, 'no question to the owner when the retry worked');
    check(e.state.transcript.some((x) => /Auto-retry 1\/3/.test(x.text)), 'the retry is written to the run journal');
    check(/auto-retry→t02/.test(e.briefStatus(t1)) && /attempt=2/.test(e.briefStatus(t2)), 'the status line tells the orchestrator not to re-delegate');
  }
  delete process.env.FAKE_FAIL_URL;

  // (b) everything fails: 3 retries, then the owner is asked
  process.env.FAKE_FAIL_ALL = '1';
  {
    const e = engineFor(testConfig(claudePath, { language: 'en' }), 'b');
    e.delegate({ provider: 'deepseek', role: 'refactor', title: 'Edit hello', spec: 'Change hello.txt' });
    await settle(e, (x) => x.state.tasks.some((t) => t.escalated));
    const tasks = e.state.tasks;
    check(tasks.length === 4, `one attempt and exactly three retries: ${tasks.length} tasks`);
    check(tasks.map((t) => t.attempt).join() === '1,2,3,4' && tasks.every((t) => t.jobId === tasks[0].id), 'attempts are numbered 1..4 in one job');
    const last = tasks[3];
    check(last.escalated === true && /failed after 4 attempts/.test(last.question ?? '') && /What do we do\?/.test(last.question ?? ''), `the owner gets a question: ${last.question?.slice(0, 80)}`);
    check((last.question ?? '').split('\n').filter((l) => l.startsWith('- t0')).length === 4, 'the question lists every attempt');
    check(/NEEDS OWNER DECISION/.test(e.briefStatus(last)) && /in English/.test(e.briefStatus(last)), 'the orchestrator is told to ask the owner, in the owner\'s language');
    await new Promise((r) => setTimeout(r, 800));
    check(e.state.tasks.length === 4, 'no fifth attempt after the question');
  }
  // (c) retries can be switched off
  {
    const e = engineFor(testConfig(claudePath, { language: 'en', autoRetry: 0 }), 'c');
    e.delegate({ provider: 'deepseek', role: 'refactor', title: 'Edit hello', spec: 'Change hello.txt' });
    await settle(e, (x) => x.state.tasks.some((t) => t.escalated));
    check(e.state.tasks.length === 1 && e.state.tasks[0].escalated === true, 'autoRetry 0: no retries, the owner is asked at once');
  }
  delete process.env.FAKE_FAIL_ALL;
  console.log('SMOKE-RETRY OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
