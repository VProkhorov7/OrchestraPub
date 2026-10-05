/**
 * A provider's rate limit (429) pauses that connection, it is not a task failure: the task moves to another worker
 * without spending an attempt; with no other worker it waits with a clear reason. Run: as a step of `npm run smoke`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TaskEngine } from '../main/engine';
import { describeWorkers } from '../main/planner';
import { clearPauses, isRateLimitError, pausedUntil } from '../main/ratelimit';
import { AppConfig, RunState } from '../main/types';
import { makeFakeClaude, makeRepo, testConfig, tmpdir, check } from './helpers';

(async () => {
  const tmp = tmpdir('orch-ratelimit-');
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
  const finished = (e: TaskEngine) => e.state.tasks.length > 0 && e.state.tasks.every((t) => ['done', 'failed', 'merged'].includes(t.status));

  check(isRateLimitError('API Error: 429 Too Many Requests') && isRateLimitError('free-models-per-day exceeded') && isRateLimitError('Rate limit reached'), 'provider limit texts are recognised');
  check(!isRateLimitError('превышен лимит воркера bai: $2') && !isRateLimitError('simulated worker failure'), 'our own cap and ordinary errors are not a rate limit');

  // (a) 429: the connection is paused, the task goes to the other worker, the attempt does not grow
  process.env.FAKE_RATE_LIMIT_URL = 'deepseek';
  {
    const e = engineFor(testConfig(claudePath, { language: 'en' }), 'a');
    e.delegate({ provider: 'deepseek', role: 'refactor', title: 'Edit hello', spec: 'Change hello.txt' });
    await settle(e, (x) => x.state.tasks.length >= 2 && finished(x));
    const [t1, t2] = e.state.tasks;
    check(t1.status === 'failed' && t1.rateLimited === true && t1.retriedAs === t2?.id, `the limited task points to its restart: ${t1.status} → ${t1.retriedAs}`);
    check(t2?.providerId !== 'deepseek' && t2?.attempt === 1 && t2?.status === 'done', `restart on ${t2?.providerId}, attempt ${t2?.attempt}, ${t2?.status}`);
    check(!t1.escalated && !t2?.escalated, 'the owner is not asked');
    const until = pausedUntil('deepseek');
    check(until > Date.now() && until - Date.now() <= 10 * 60_000, 'a non-daily limit pauses for 10 minutes');
    check(/PAUSED until \d\d:\d\d UTC \(rate limit\)/.test(describeWorkers(e.cfg)), 'list_workers shows the pause');
    let threw = '';
    try { e.delegate({ provider: 'deepseek', role: 'refactor', title: 'x', spec: 'y' }); } catch (x: any) { threw = x.message; }
    check(/provider deepseek is rate-limited until \d\d:\d\d UTC, pick another worker/.test(threw), `delegate to a paused worker is refused: ${threw}`);
  }

  // (b) no other worker: the task waits with a clear reason, no question to the owner; a daily limit lasts until midnight UTC
  clearPauses();
  process.env.FAKE_RATE_LIMIT_TEXT = '429: free-models-per-day limit reached';
  {
    const cfg = testConfig(claudePath, { language: 'en' });
    cfg.providers.find((p) => p.id === 'glm')!.enabled = false;
    const e = engineFor(cfg, 'b');
    e.delegate({ provider: 'deepseek', role: 'refactor', title: 'Edit hello', spec: 'Change hello.txt' });
    await settle(e, finished);
    await new Promise((r) => setTimeout(r, 800));
    const t1 = e.state.tasks[0];
    check(e.state.tasks.length === 1 && t1.rateLimited === true && !t1.escalated, 'no restart and no question to the owner');
    check(/paused until \d\d:\d\d UTC \(rate limit\)/.test(t1.error ?? ''), `the reason is clear: ${t1.error}`);
    const midnight = new Date(); midnight.setUTCHours(24, 0, 0, 0);
    check(pausedUntil('deepseek') === midnight.getTime(), 'a daily limit pauses until midnight UTC');
  }
  delete process.env.FAKE_RATE_LIMIT_URL;
  delete process.env.FAKE_RATE_LIMIT_TEXT;

  // (c) an ordinary failure is retried as before: the attempt grows
  clearPauses();
  process.env.FAKE_FAIL_URL = 'deepseek';
  {
    const e = engineFor(testConfig(claudePath, { language: 'en' }), 'c');
    e.delegate({ provider: 'deepseek', role: 'refactor', title: 'Edit hello', spec: 'Change hello.txt' });
    await settle(e, (x) => x.state.tasks.length >= 2 && finished(x));
    const [t1, t2] = e.state.tasks;
    check(!t1.rateLimited && t2?.attempt === 2 && pausedUntil('deepseek') === 0, 'ordinary failure: attempt 2, no pause');
  }
  delete process.env.FAKE_FAIL_URL;
  console.log('SMOKE-RATELIMIT OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
