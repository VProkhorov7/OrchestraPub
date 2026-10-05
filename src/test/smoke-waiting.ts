/**
 * A worker that stops on a question is marked: explicit NEEDS_ANSWER marker, or the old guess from its last log line.
 * Run: as a step of `npm run smoke`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TaskEngine } from '../main/engine';
import { findQuestion } from '../main/waiting';
import { RunState } from '../main/types';
import { makeFakeClaude, makeRepo, testConfig, tmpdir, check } from './helpers';

(async () => {
  const a = findQuestion('DONE: x\nNEEDS_ANSWER: which port?');
  check(a?.explicit === true && a.question === 'which port?', 'a marker on the last line is explicit');
  const b = findQuestion('I stopped.\nNEEDS_ANSWER: which db?\nmore text');
  check(b?.explicit === true && b.question === 'which db?', 'a marker in the middle is found too');
  const c = findQuestion('DONE: x', 'нужен ваш ответ?');
  check(c?.explicit === false && c.question === 'нужен ваш ответ?', 'a question-like log line is a soft guess');
  check(findQuestion('DONE: a\nWHY: b\nRISKS: none\nVERIFY: ran tests', 'All done, tests pass.') === null, 'a normal report is not a question');

  const tmp = tmpdir('orch-waiting-');
  const claudePath = makeFakeClaude(tmp);
  const repo = makeRepo(tmp);
  const state: RunState = { runId: 'mcp-w', source: 'mcp', repo, baseBranch: 'main', goal: 'w', status: 'running', tasks: [], transcript: [], budgetUsd: 0, startedAt: Date.now(), pid: process.pid };
  const e = new TaskEngine(testConfig(claudePath, { language: 'en' }), path.join(tmp, 'wt'), state, () => {});
  process.env.FAKE_NEEDS_ANSWER = '1';
  e.delegate({ provider: 'deepseek', role: 'refactor', title: 'Edit hello', spec: 'Change hello.txt' });
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000 && !(e.state.tasks[0] && e.state.tasks[0].status === 'done')) await new Promise((r) => setTimeout(r, 200));
  delete process.env.FAKE_NEEDS_ANSWER;
  const t = e.state.tasks[0];
  check(t.status === 'done' && t.needsAnswer === 'which port?' && t.needsAnswerExplicit === true, `done with a question: ${t.status} / ${t.needsAnswer}`);
  check(e.briefStatus(t).includes('WAITING FOR AN ANSWER'), 'the orchestrator is told the worker is waiting');
  console.log('SMOKE-WAITING OK');
})().catch((err) => { console.error(err); process.exit(1); });
